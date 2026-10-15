// Vegetation Studio Pro half of GolfMap > Vegetation Zones (GolfMapZoneImporter.cs).
//
// What it writes into the terrain's vegetation package (unity-zones-v2):
//   - one TextureMaskGroup per exported item, named "golfmap-zone:item:<item>", of
//     type RGBAChannel, holding the item's mask PNG over the terrain's world
//     rectangle with the group's ChannelSelector default set to the item's channel;
//   - on that package item exactly one Density rule (min 0, max 1, multiplier 1: the
//     pipeline bakes the density into the pixels) and one Include rule (spawn only
//     where the channel is above a low threshold) against its own group, updated in
//     place on re-import;
//   - every other "golfmap-zone:*" group (v1 per-type groups, items no longer
//     exported, duplicates) is deleted, and every rule on any item that points at a
//     golfmap group other than that item's own is removed. Hand-authored rules
//     (non-golfmap groups) and everything else about an item are left alone (D-VZ9).
//   - when a zone sets a bush height: the "golfmap-zone:height" group, the height-driven
//     twin items and their rules (GolfMapZoneImporterHeight.cs, D-VZ17).
// No VegetationSystemPro is ever created here: the tree planter builds systems
// through GolfMapVspRig.
//
// The work is split into a plan (BuildPlan: what would change, touching nothing) and
// its application (ApplyPlan), so Preview import / the bridge's dryRun show exactly
// what Import does.
//
// VSP semantics this relies on (VSP Runtime/VegetationSystemPro source):
//   - density rules multiply (TextureMask.cs SampleRgbaChannelDensityMaskJob:
//     SpawnChance *= value/256 * DensityMultiplier), hence one rule per item;
//   - include rules OR into TextureMaskData, which UnityTerrainSampleJob resets to 0
//     per spawn location (Terrains/UnityTerrain.cs), and FilterIncludeMaskJob
//     (Jobs/CellSpawnJob.cs) excludes every location still at 0. It runs whenever
//     UseTextureMaskIncludeRules is on (VegetationCellSpawner.cs), even with no rules
//     or only rules whose group is gone: such an item spawns nowhere.
//   - VegetationPackagePro.DeleteTextureMaskGroup switches UseTextureMaskIncludeRules
//     off when an item's include list empties, which would make that item carpet the
//     terrain. Groups are therefore removed from the list directly, never through it.
//
// VSP reads mask textures on the CPU with GetRawTextureData, so the PNG is imported
// readable, RGBA32, uncompressed, no mipmaps, clamped. The selector convention is the
// one VSP's own inspector uses: 0 R, 1 G, 2 B, 3 A (TextureMask.cs re-maps it for the
// RGBA32 byte order internally).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using AwesomeTechnologies.VegetationSystem;
using AwesomeTechnologies.Vegetation.Masks;

namespace GolfMap.Editor
{
    public partial class GolfMapZoneImporter
    {
        // Include threshold: pixels at or above round(0.02 * 256) = 5 pass, so feather ramps
        // fade in over their first few percent instead of popping at the polygon edge.
        const float kIncludeThreshold = 0.02f;
        const string kChannelProperty = "ChannelSelector";
        const string kInverseProperty = "Inverse";

        List<VegetationSystemPro> systems = new List<VegetationSystemPro>();
        [SerializeField] int systemIndex;
        [SerializeField] int packageIndex;
        ImportPlan lastPlan;   // the plan the last summary, preview or import worked out

        VegetationSystemPro VspSystem { get { return systemIndex >= 0 && systemIndex < systems.Count ? systems[systemIndex] : null; } }

        List<VegetationPackagePro> Packages
        {
            get { var s = VspSystem; return s ? s.VegetationPackageProList.Where(p => p).ToList() : new List<VegetationPackagePro>(); }
        }

        VegetationPackagePro Package
        {
            get { var list = Packages; return packageIndex >= 0 && packageIndex < list.Count ? list[packageIndex] : null; }
        }

        // Same test the tree planter applies to its storage: the system lists the terrain and its
        // bounds cover the terrain square. The course's one system holds the inner and the outer
        // terrain (GolfMapVspRig), so it matches both.
        internal static bool SystemMatchesTerrain(VegetationSystemPro system, Terrain target)
        {
            if (!system || !target || !target.terrainData || system.gameObject.scene != target.gameObject.scene) return false;
            if (!system.VegetationStudioTerrainObjectList.Contains(target.gameObject)) return false;
            var bounds = system.VegetationSystemBounds; var size = target.terrainData.size;
            var min = target.transform.position; var max = min + size;
            return bounds.min.x <= min.x + 1 && bounds.min.z <= min.z + 1 && bounds.max.x >= max.x - 1 && bounds.max.z >= max.z - 1;
        }

        // True when VSP will actually let the item through its include filter somewhere: include
        // rules are on and at least one points at a group that exists in the package. With the
        // flag on and no such rule VSP excludes every spawn location (see the header).
        internal static bool HasLiveIncludeRule(VegetationPackagePro package, VegetationItemInfoPro item)
        {
            return item.UseTextureMaskIncludeRules && item.TextureMaskIncludeRuleList.Any(r => r != null && package.GetTextureMaskGroup(r.TextureMaskGroupID) != null);
        }

        partial void OnFileLoaded()
        {
            var previous = VspSystem;
            systems = terrain ? FindObjectsOfType<VegetationSystemPro>().Where(s => SystemMatchesTerrain(s, terrain)).OrderBy(s => s.name).ToList() : new List<VegetationSystemPro>();
            systemIndex = Mathf.Max(0, systems.IndexOf(previous));
            packageIndex = DefaultPackageIndex();
        }

        // The default biome package that is not one of the planter's tree catalogues: that is
        // the one holding the lower vegetation (D-VZ2). Falls back to the first non-catalogue.
        int DefaultPackageIndex()
        {
            var list = Packages;
            var current = packageIndex >= 0 && packageIndex < list.Count ? list[packageIndex] : null;
            if (current && !GolfMapTreePlanter.IsImportedCatalogue(current)) return packageIndex;
            int i = list.FindIndex(p => p.BiomeType == BiomeType.Default && !GolfMapTreePlanter.IsImportedCatalogue(p));
            if (i < 0) i = list.FindIndex(p => !GolfMapTreePlanter.IsImportedCatalogue(p));
            return Mathf.Max(0, i);
        }

        partial void DrawVspOptions()
        {
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Vegetation Studio Pro", EditorStyles.boldLabel);
            if (systems.Count == 0)
            {
                EditorGUILayout.HelpBox(terrain ? "No VegetationSystemPro covers '" + terrain.name + "'. Plant the trees first (the tree planter creates the system through GolfMapVspRig); this tool never creates one." : "Assign the terrain to find its vegetation system.", MessageType.Warning);
                return;
            }
            systemIndex = EditorGUILayout.Popup("Vegetation system", Mathf.Clamp(systemIndex, 0, systems.Count - 1), systems.Select(s => s.name).ToArray());
            var packages = Packages;
            if (packages.Count == 0) { EditorGUILayout.HelpBox("The system has no vegetation package. Add the lower-vegetation biome package to it first.", MessageType.Warning); return; }
            var labels = packages.Select(p => p.PackageName + " [" + p.BiomeType + (GolfMapTreePlanter.IsImportedCatalogue(p) ? ", tree catalogue" : "") + ", " + p.VegetationInfoList.Count + " items]").ToArray();
            packageIndex = EditorGUILayout.Popup("Vegetation package", Mathf.Clamp(packageIndex, 0, packages.Count - 1), labels);
            var package = packages[packageIndex];
            if (GolfMapTreePlanter.IsImportedCatalogue(package)) EditorGUILayout.HelpBox("This is the planter's tree catalogue (runtime spawn off). Pick the lower-vegetation package.", MessageType.Warning);
            else if (package.BiomeType != BiomeType.Default) EditorGUILayout.HelpBox("Package biome is " + package.BiomeType + ", not Default: it only spawns inside matching biome mask areas (D-VZ2 expects the default biome).", MessageType.Info);
            EditorGUILayout.LabelField("Package asset", AssetDatabase.GetAssetPath(package));
        }

        partial void VspSummary(ref string text)
        {
            lastPlan = null;
            if (!terrain) return;
            if (systems.Count == 0) { text += "\nNo VSP system covers the terrain."; return; }
            var package = Package;
            text += "\nVSP system: " + VspSystem.name + (package ? ", package '" + package.PackageName + "' (" + package.VegetationInfoList.Count + " items)" : ", no package");
            if (package == null || loaded == null || GolfMapTreePlanter.IsImportedCatalogue(package)) return;
            lastPlan = BuildPlan(package);
            if (lastPlan.missing.Count > 0) text += "\nWARNING " + lastPlan.missing.Count + " exported item(s) not in the package: " + string.Join(", ", lastPlan.missing.ToArray());
            text += "\nImport would: " + PlanCounts(lastPlan) + " Preview import lists the details.";
        }

        // ---- plan ----------------------------------------------------------

        // One exported item: its group (existing, or null = create) and, when the package has
        // the item, the density/include rules on its own group that are kept (null = add).
        class ItemPlan
        {
            public GolfMapZoneItem entry;
            public string groupName;
            public TextureMaskGroup group;
            public VegetationItemInfoPro item;
            public TextureMaskRule density, include;
        }

        class RuleRemoval
        {
            public List<TextureMaskRule> list;
            public TextureMaskRule rule;
            public string line;
        }

        class ImportPlan
        {
            public string course, folder;
            public List<ItemPlan> items = new List<ItemPlan>();
            public List<TextureMaskGroup> deleteGroups = new List<TextureMaskGroup>();
            public List<RuleRemoval> removals = new List<RuleRemoval>();
            public List<string> textures = new List<string>(), groupsCreate = new List<string>(), groupsUpdate = new List<string>(), groupsDelete = new List<string>();
            public List<string> rulesAdd = new List<string>(), rulesUpdate = new List<string>();
            public List<string> bound = new List<string>(), missing = new List<string>(), unbound = new List<string>(), dangling = new List<string>();
            // Bush height (GolfMapZoneImporterHeight.cs): the height mask's group (null = create or none),
            // the twin per bush item, twins nobody needs any more, and what to say about it.
            public TextureMaskGroup heightGroup;
            public Dictionary<VegetationItemInfoPro, TwinPlan> twins = new Dictionary<VegetationItemInfoPro, TwinPlan>();
            public List<VegetationItemInfoPro> staleTwins = new List<VegetationItemInfoPro>();
            public List<string> height = new List<string>(), heightNotes = new List<string>();
        }

        // The active course's folder; a project without a course asset falls back to the export's name.
        void ZonesFolder(out string course, out string folder)
        {
            var active = GolfMapCourses.Active();
            course = active ? GolfMapCourses.Name(active) : GolfMapZones.CourseName(loadedPath, loaded.plot);
            folder = (active ? GolfMapCourses.Folder(active) : GolfMapCourses.Root + course + "/") + "Zones/";
        }

        static string Sources(GolfMapZoneItem entry)
        {
            return entry.sources.Count > 0 ? string.Join(", ", entry.sources.ToArray()) : "(no source)";
        }

        // Works out everything an import changes, from the loaded file and the package as it is
        // now. Reads only; ApplyPlan carries it out.
        ImportPlan BuildPlan(VegetationPackagePro package)
        {
            var plan = new ImportPlan();
            ZonesFolder(out plan.course, out plan.folder);
            foreach (var mask in loaded.masks)
                plan.textures.Add(mask.file + " -> " + plan.folder + Path.GetFileName(mask.file));

            // Groups: keep the first per-item group of every exported item, delete every other golfmap one.
            var exported = new HashSet<string>(loaded.items.Select(i => i.item));
            var kept = new Dictionary<string, TextureMaskGroup>();
            var names = new Dictionary<string, string>();   // group id -> name, for the report
            var golfIds = new HashSet<string>();
            var deletedIds = new HashSet<string>();
            foreach (var g in package.TextureMaskGroupList)
            {
                if (g == null) continue;
                if (g.TextureMaskGroupID != null) names[g.TextureMaskGroupID] = g.TextureMaskName;
                if (!GolfMapZones.IsGroupName(g.TextureMaskName)) continue;
                if (g.TextureMaskGroupID != null) golfIds.Add(g.TextureMaskGroupID);
                if (g.TextureMaskName == GolfMapZones.HeightGroupName)
                {
                    if (GolfMapZones.HasHeight(loaded) && plan.heightGroup == null) { plan.heightGroup = g; continue; }
                    plan.deleteGroups.Add(g);
                    if (g.TextureMaskGroupID != null) deletedIds.Add(g.TextureMaskGroupID);
                    plan.groupsDelete.Add(g.TextureMaskName + (GolfMapZones.HasHeight(loaded) ? " (duplicate)" : " (no zone sets a bush height)"));
                    continue;
                }
                var itemName = GolfMapZones.ItemFromGroupName(g.TextureMaskName);
                if (itemName != null && exported.Contains(itemName) && !kept.ContainsKey(g.TextureMaskName)) { kept[g.TextureMaskName] = g; continue; }
                plan.deleteGroups.Add(g);
                if (g.TextureMaskGroupID != null) deletedIds.Add(g.TextureMaskGroupID);
                plan.groupsDelete.Add(g.TextureMaskName + (itemName == null ? " (per-zone-type group from v1)" : !exported.Contains(itemName) ? " (item no longer exported)" : " (duplicate)"));
            }

            // Exported items against the package.
            var owner = new Dictionary<VegetationItemInfoPro, ItemPlan>();
            foreach (var entry in loaded.items)
            {
                var ip = new ItemPlan { entry = entry, groupName = GolfMapZones.GroupName(entry.item) };
                kept.TryGetValue(ip.groupName, out ip.group);
                (ip.group == null ? plan.groupsCreate : plan.groupsUpdate).Add(ip.groupName + " (texture " + entry.texture + " channel " + "RGBA"[entry.channel] + ")");
                var item = FindItem(package, entry.item);
                ItemPlan other;
                if (item == null) plan.missing.Add(entry.item + " <- " + Sources(entry));
                else if (owner.TryGetValue(item, out other)) plan.missing.Add(entry.item + " <- " + Sources(entry) + " (matches the same package item as '" + other.entry.item + "'; only that one is bound)");
                else { ip.item = item; owner[item] = ip; }
                plan.items.Add(ip);
            }

            PlanHeight(plan, package);
            var heightId = plan.heightGroup != null ? plan.heightGroup.TextureMaskGroupID : null;
            if (GolfMapZones.HasHeight(loaded))
                (plan.heightGroup == null ? plan.groupsCreate : plan.groupsUpdate).Add(GolfMapZones.HeightGroupName + " (" + loaded.height.file + ")");

            // Rules on every package item.
            foreach (var item in package.VegetationInfoList)
            {
                if (item == null) continue;
                var label = "'" + item.Name + "'";
                if (GolfMapZones.IsTwinName(item.Name))
                {
                    // A height twin: the item's own mask group for density and include, the height mask for the rest.
                    var tp = plan.twins.Values.FirstOrDefault(t => t.twin == item);
                    if (tp == null)
                    {
                        plan.staleTwins.Add(item);
                        plan.height.Add(item.Name + ": removed (no zone with a bush height plants '" + GolfMapZones.TwinBase(item.Name) + "' any more)");
                        continue;
                    }
                    var baseId = tp.owner.group != null ? tp.owner.group.TextureMaskGroupID : null;
                    tp.density = ScanRules(plan, label, "density", item.TextureMaskDensityRuleList, baseId, true, golfIds, deletedIds, names);
                    tp.include = ScanRules(plan, label, "include", item.TextureMaskIncludeRuleList, baseId, true, golfIds, deletedIds, names);
                    tp.exclude = ScanRules(plan, label, "exclude", item.TextureMaskExcludeRuleList, heightId, true, golfIds, deletedIds, names);
                    tp.scale = ScanRules(plan, label, "scale", item.TextureMaskScaleRuleList, heightId, true, golfIds, deletedIds, names);
                    continue;
                }
                if (GolfMapZones.IsDistanceCopyName(item.Name))
                {
                    // A distance copy (grass-palette.json "copies"): its base item's mask, given by
                    // golfmap.grass.apply; kept here on the base's group, never bound on its own.
                    var baseItem = FindItem(package, GolfMapZones.DistanceCopyBase(item.Name));
                    ItemPlan basePlan = null;
                    if (baseItem != null) owner.TryGetValue(baseItem, out basePlan);
                    var baseGroupId = basePlan != null && basePlan.group != null ? basePlan.group.TextureMaskGroupID : null;
                    ScanRules(plan, label, "density", item.TextureMaskDensityRuleList, baseGroupId, true, golfIds, deletedIds, names);
                    ScanRules(plan, label, "include", item.TextureMaskIncludeRuleList, baseGroupId, true, golfIds, deletedIds, names);
                    ScanRules(plan, label, "scale", item.TextureMaskScaleRuleList, baseGroupId, false, golfIds, deletedIds, names);
                    plan.bound.Add(item.Name + " <- copy of '" + GolfMapZones.DistanceCopyBase(item.Name) + "'" + (baseGroupId == null ? " (its base has no zone mask: nothing kept)" : "")
                        + " (golfmap.grass.apply refreshes its rules)");
                    continue;
                }
                ItemPlan own;
                owner.TryGetValue(item, out own);
                var ownId = own != null && own.group != null ? own.group.TextureMaskGroupID : null;
                TwinPlan twinned;
                plan.twins.TryGetValue(item, out twinned);
                var density = ScanRules(plan, label, "density", item.TextureMaskDensityRuleList, ownId, true, golfIds, deletedIds, names);
                var include = ScanRules(plan, label, "include", item.TextureMaskIncludeRuleList, ownId, true, golfIds, deletedIds, names);
                var exclude = ScanRules(plan, label, "exclude", item.TextureMaskExcludeRuleList, twinned != null ? heightId : null, twinned != null, golfIds, deletedIds, names);
                if (twinned != null)
                {
                    twinned.baseExclude = exclude;
                    plan.height.Add(item.Name + ": " + (twinned.twin == null ? "new twin" : "twin kept") + ", " + GolfMapZones.F(twinned.naturalHeight) + " m at scale 1");
                }
                ScanRules(plan, label, "scale", item.TextureMaskScaleRuleList, ownId, false, golfIds, deletedIds, names);
                var spawnOff = item.EnableRuntimeSpawn ? "" : " [runtime spawn off]";
                if (own != null)
                {
                    own.density = density; own.include = include;
                    (density == null ? plan.rulesAdd : plan.rulesUpdate).Add(label + " density -> " + own.groupName);
                    (include == null ? plan.rulesAdd : plan.rulesUpdate).Add(label + " include -> " + own.groupName);
                    int handDensity = item.TextureMaskDensityRuleList.Count(r => r != null && !golfIds.Contains(r.TextureMaskGroupID ?? "") && names.ContainsKey(r.TextureMaskGroupID ?? ""));
                    plan.bound.Add(item.Name + " <- " + Sources(own.entry) + (handDensity > 0 ? " (+" + handDensity + " hand-authored density rule(s) multiply in)" : "") + spawnOff);
                    continue;
                }
                // Unbound: what VSP will do once the golfmap rules are gone.
                var removed = new HashSet<TextureMaskRule>(plan.removals.Where(r => r.list == item.TextureMaskIncludeRuleList).Select(r => r.rule));
                int live = item.TextureMaskIncludeRuleList.Count(r => r != null && !removed.Contains(r) && names.ContainsKey(r.TextureMaskGroupID ?? "") && !deletedIds.Contains(r.TextureMaskGroupID));
                string state;
                if (!item.UseTextureMaskIncludeRules) state = "spawns everywhere its other rules allow (include rules off)";
                else if (live == 0) state = "spawns nowhere (include rules on, none left)";
                else state = "spawns only inside " + live + " hand-authored include mask(s)";
                plan.unbound.Add(item.Name + ": unbound, " + state + spawnOff);
            }
            return plan;
        }

        // Plans removal of every rule in `list` that points at a golfmap group, except the first
        // one on the item's own group when `keepOwn` (density/include); returns that kept rule.
        // Rules on groups the package does not have are reported, not touched.
        static TextureMaskRule ScanRules(ImportPlan plan, string label, string kind, List<TextureMaskRule> list, string ownId, bool keepOwn,
            HashSet<string> golfIds, HashSet<string> deletedIds, Dictionary<string, string> names)
        {
            TextureMaskRule kept = null;
            if (list == null) return null;
            foreach (var rule in list)
            {
                if (rule == null) continue;
                var id = rule.TextureMaskGroupID ?? "";
                if (!golfIds.Contains(id))
                {
                    if (!names.ContainsKey(id)) plan.dangling.Add(label + " " + kind + " rule -> group id '" + id + "' not in the package (VSP skips it)");
                    continue;
                }
                if (keepOwn && ownId != null && id == ownId && kept == null) { kept = rule; continue; }
                string reason;
                if (deletedIds.Contains(id)) reason = "group deleted";
                else if (id == ownId) reason = keepOwn ? "duplicate" : "golfmap rule in the " + kind + " list";
                else if (names[id] == GolfMapZones.HeightGroupName) reason = "no bush height for this item";
                else reason = "another item's mask";
                plan.removals.Add(new RuleRemoval { list = list, rule = rule, line = label + " " + kind + " rule -> " + names[id] + " (" + reason + ")" });
            }
            return kept;
        }

        static string PlanCounts(ImportPlan p)
        {
            return p.items.Count + " item mask group(s) (" + p.groupsCreate.Count + " new, " + p.groupsUpdate.Count + " updated), delete " + p.deleteGroups.Count + " group(s), remove "
                + p.removals.Count + " rule(s), add " + p.rulesAdd.Count + " and update " + p.rulesUpdate.Count + " rule(s); " + p.bound.Count + " item(s) bound, "
                + p.missing.Count + " missing from the package, " + p.unbound.Count + " package item(s) unbound."
                + (p.twins.Count + p.staleTwins.Count > 0 ? " Bush height: " + p.twins.Count + " twin item(s), " + p.staleTwins.Count + " removed." : "");
        }

        void CheckPackage(out VegetationSystemPro system, out VegetationPackagePro package)
        {
            system = VspSystem;
            package = Package;
            if (!system) throw new Exception("No VegetationSystemPro covers '" + terrain.name + "'. Plant trees first so the planter builds the system (GolfMapVspRig).");
            if (!package) throw new Exception("Choose the vegetation package that holds the lower vegetation.");
            if (GolfMapTreePlanter.IsImportedCatalogue(package)) throw new Exception("Refusing to write zone masks into the planter's tree catalogue. Pick the lower-vegetation package.");
            if (!EditorUtility.IsPersistent(package)) throw new Exception("The vegetation package is not a saved asset.");
        }

        // ---- preview and import --------------------------------------------

        partial void PreviewVsp()
        {
            VegetationSystemPro system; VegetationPackagePro package;
            CheckPackage(out system, out package);
            lastPlan = BuildPlan(package);
            status = "Preview (nothing written): " + PlanText(lastPlan, package, false);
        }

        partial void ImportVsp()
        {
            VegetationSystemPro system; VegetationPackagePro package;
            CheckPackage(out system, out package);
            var plan = lastPlan = BuildPlan(package);

            // 1. Textures: copy into the course's Zones folder and import readable RGBA32.
            var textures = new List<Texture2D>();
            plan.textures.Clear();
            foreach (var mask in loaded.masks)
            {
                var source = Path.Combine(Path.GetDirectoryName(loadedPath) ?? "", mask.file);
                var texture = ImportMaskTexture(source, plan.folder + Path.GetFileName(mask.file), mask.resolution);
                textures.Add(texture);
                plan.textures.Add(AssetDatabase.GetAssetPath(texture) + " " + texture.width + "x" + texture.height + " " + texture.format);
            }

            // 2. Groups and rules that go. Not DeleteTextureMaskGroup: see the header.
            foreach (var g in plan.deleteGroups) package.TextureMaskGroupList.Remove(g);
            foreach (var r in plan.removals) r.list.Remove(r.rule);

            // 3. One group per exported item over the terrain square (world x east, z north).
            var size = terrain.terrainData.size;
            var rect = new Rect(terrain.transform.position.x, terrain.transform.position.z, size.x, size.z);
            foreach (var ip in plan.items)
            {
                var group = ip.group;
                if (group == null)
                {
                    group = ip.group = new TextureMaskGroup(TextureMaskType.RGBAChannel) { TextureMaskName = ip.groupName };
                    package.TextureMaskGroupList.Add(group);
                }
                group.TextureMaskType = TextureMaskType.RGBAChannel;
                SetChannel(group.Settings.ControlerPropertyList, ip.entry.channel);
                // One texture per group; a stale second entry from a hand edit is dropped.
                while (group.TextureMaskList.Count > 1) group.TextureMaskList.RemoveAt(group.TextureMaskList.Count - 1);
                if (group.TextureMaskList.Count == 0) group.TextureMaskList.Add(new TextureMask());
                var tm = group.TextureMaskList[0];
                tm.MaskTexture = textures[ip.entry.texture];
                tm.TextureRect = rect;
                tm.Repeat = Vector2.one;

                // 4. The item's own density and include rule.
                var item = ip.item;
                if (item == null) continue;
                var density = ip.density ?? AddRule(item.TextureMaskDensityRuleList, group);
                StampChannel(density, ip.entry.channel);
                density.MinDensity = 0;
                density.MaxDensity = 1;
                density.DensityMultiplier = 1;
                item.UseTextureMaskDensityRules = true;
                var include = ip.include ?? AddRule(item.TextureMaskIncludeRuleList, group);
                StampChannel(include, ip.entry.channel);
                include.MinDensity = kIncludeThreshold;
                include.MaxDensity = 1f;
                item.UseTextureMaskIncludeRules = true;
            }

            ApplyHeight(plan, package, rect);

            // 5. Save and make VSP respawn from the new masks.
            EditorUtility.SetDirty(package);
            system.RefreshVegetationSystem();
            system.ClearCache();
            EditorUtility.SetDirty(system);
            EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
            AssetDatabase.SaveAssets();
            SceneView.RepaintAll();

            // 6. Report next to the tree import report.
            status = WriteReport(plan, package);
            Debug.Log("[GolfMap] " + status.Split('\n')[0] + " Report: GolfMapSpelunk/" + plan.course + "_zone_import.txt");
        }

        // Copies the PNG into the project and imports it the way VSP's CPU sampler needs it:
        // readable, RGBA32, no compression, no mipmaps, clamped, linear. Idempotent.
        static Texture2D ImportMaskTexture(string source, string assetPath, int resolution)
        {
            if (!File.Exists(source)) throw new Exception("Mask PNG missing: " + source);
            Directory.CreateDirectory(Path.GetDirectoryName(assetPath));
            bool changed = !File.Exists(assetPath) || !FilesEqual(source, assetPath);
            if (changed) File.Copy(source, assetPath, true);
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null) throw new Exception("Not imported as a texture: " + assetPath);
            int maxSize = 32; while (maxSize < resolution) maxSize *= 2;
            bool dirty = false;
            if (importer.textureType != TextureImporterType.Default) { importer.textureType = TextureImporterType.Default; dirty = true; }
            if (importer.sRGBTexture) { importer.sRGBTexture = false; dirty = true; }
            if (importer.alphaSource != TextureImporterAlphaSource.FromInput) { importer.alphaSource = TextureImporterAlphaSource.FromInput; dirty = true; }
            if (importer.alphaIsTransparency) { importer.alphaIsTransparency = false; dirty = true; }
            if (!importer.isReadable) { importer.isReadable = true; dirty = true; }
            if (importer.mipmapEnabled) { importer.mipmapEnabled = false; dirty = true; }
            if (importer.wrapMode != TextureWrapMode.Clamp) { importer.wrapMode = TextureWrapMode.Clamp; dirty = true; }
            if (importer.filterMode != FilterMode.Bilinear) { importer.filterMode = FilterMode.Bilinear; dirty = true; }
            if (importer.npotScale != TextureImporterNPOTScale.None) { importer.npotScale = TextureImporterNPOTScale.None; dirty = true; }
            if (importer.textureCompression != TextureImporterCompression.Uncompressed) { importer.textureCompression = TextureImporterCompression.Uncompressed; dirty = true; }
            if (importer.crunchedCompression) { importer.crunchedCompression = false; dirty = true; }
            if (importer.maxTextureSize < maxSize) { importer.maxTextureSize = maxSize; dirty = true; }
            var platform = importer.GetDefaultPlatformTextureSettings();
            if (platform.format != TextureImporterFormat.RGBA32 || platform.maxTextureSize < maxSize || platform.textureCompression != TextureImporterCompression.Uncompressed)
            {
                platform.format = TextureImporterFormat.RGBA32;
                platform.maxTextureSize = Math.Max(platform.maxTextureSize, maxSize);
                platform.textureCompression = TextureImporterCompression.Uncompressed;
                importer.SetPlatformTextureSettings(platform);
                dirty = true;
            }
            // A per-platform override (Standalone is what the course bundle builds) would win over
            // the default; the sampler needs RGBA32 on every target so overrides are removed.
            foreach (var name in new[] { "Standalone", "Windows" })
            {
                var over = importer.GetPlatformTextureSettings(name);
                if (over != null && over.overridden) { over.overridden = false; importer.SetPlatformTextureSettings(over); dirty = true; }
            }
            if (dirty) importer.SaveAndReimport();
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
            if (!texture) throw new Exception("Cannot load " + assetPath);
            if (texture.format != TextureFormat.RGBA32) throw new Exception(assetPath + " imported as " + texture.format + ", VSP needs RGBA32.");
            if (texture.width != resolution || texture.height != resolution) throw new Exception(assetPath + " imported at " + texture.width + "x" + texture.height + ", expected " + resolution + " (check Max Size).");
            return texture;
        }

        static bool FilesEqual(string a, string b)
        {
            var fa = new FileInfo(a); var fb = new FileInfo(b);
            if (fa.Length != fb.Length) return false;
            return File.ReadAllBytes(a).SequenceEqual(File.ReadAllBytes(b));
        }

        static void SetChannel(List<SerializedControllerProperty> properties, int channel)
        {
            foreach (var p in properties)
            {
                if (p.PropertyName == kChannelProperty) p.IntValue = channel;
                else if (p.PropertyName == kInverseProperty) p.BoolValue = false;
            }
        }

        // Exact name first; Arborist biomes carry names with a trailing space, so a trimmed
        // match is accepted second. Ambiguous trimmed matches are reported as missing.
        static VegetationItemInfoPro FindItem(VegetationPackagePro package, string name)
        {
            var exact = package.VegetationInfoList.FirstOrDefault(i => i != null && i.Name == name);
            if (exact != null) return exact;
            var trimmed = name.Trim();
            var loose = package.VegetationInfoList.Where(i => i != null && (i.Name ?? "").Trim() == trimmed).ToList();
            return loose.Count == 1 ? loose[0] : null;
        }

        static TextureMaskRule AddRule(List<TextureMaskRule> list, TextureMaskGroup group)
        {
            var rule = new TextureMaskRule(group.Settings) { TextureMaskGroupID = group.TextureMaskGroupID };
            list.Add(rule);
            return rule;
        }

        // The channel is stamped on the rule itself: VSP samples the rule's own property copy.
        static void StampChannel(TextureMaskRule rule, int channel)
        {
            SetChannel(rule.TextureMaskPropertiesList, channel);
        }

        // Human-readable plan (preview) or result (import).
        string PlanText(ImportPlan p, VegetationPackagePro package, bool imported)
        {
            var text = (imported ? "Imported: " : "Import would do: ") + PlanCounts(p) + (imported ? " Save the scene." : "");
            if (p.missing.Count > 0) text += "\nMissing items: " + string.Join(", ", p.missing.ToArray());
            if (p.groupsDelete.Count > 0) text += "\nGroups deleted: " + string.Join(", ", p.groupsDelete.ToArray());
            if (p.removals.Count > 0) text += "\nRules removed:\n  " + string.Join("\n  ", p.removals.Select(r => r.line).ToArray());
            if (p.bound.Count > 0) text += "\nBound:\n  " + string.Join("\n  ", p.bound.ToArray());
            if (p.unbound.Count > 0) text += "\nUnbound:\n  " + string.Join("\n  ", p.unbound.ToArray());
            if (p.height.Count > 0) text += "\nBush height twins:\n  " + string.Join("\n  ", p.height.ToArray());
            if (p.heightNotes.Count > 0) text += "\nBush height notes:\n  " + string.Join("\n  ", p.heightNotes.ToArray());
            if (p.dangling.Count > 0) text += "\nDangling rules (left alone):\n  " + string.Join("\n  ", p.dangling.ToArray());
            return text;
        }

        // Plain lists for the bridge's JSON.
        static Dictionary<string, object> PlanJson(ImportPlan p)
        {
            Func<List<string>, List<object>> o = l => l.Select(s => (object)s).ToList();
            return new Dictionary<string, object>
            {
                { "summary", PlanCounts(p) },
                { "textures", o(p.textures) },
                { "groupsCreate", o(p.groupsCreate) },
                { "groupsUpdate", o(p.groupsUpdate) },
                { "groupsDelete", o(p.groupsDelete) },
                { "rulesRemove", p.removals.Select(r => (object)r.line).ToList() },
                { "rulesAdd", o(p.rulesAdd) },
                { "rulesUpdate", o(p.rulesUpdate) },
                { "bound", o(p.bound) },
                { "missing", o(p.missing) },
                { "unbound", o(p.unbound) },
                { "dangling", o(p.dangling) },
                { "height", o(p.height) },
                { "heightNotes", o(p.heightNotes) },
            };
        }

        string WriteReport(ImportPlan p, VegetationPackagePro package)
        {
            var sb = new System.Text.StringBuilder();
            sb.AppendLine(DateTime.UtcNow.ToString("o"));
            sb.AppendLine("Imported " + loaded.items.Count + " item mask(s) for " + loaded.zoneTypes.Count + " zone type(s): " + PlanCounts(p));
            sb.AppendLine("Zones file: " + loadedPath + " (" + loaded.format + ")");
            sb.AppendLine("Terrain: " + terrain.name + " at " + terrain.transform.position + " size " + terrain.terrainData.size);
            sb.AppendLine("System: " + VspSystem.name + "  Package: " + package.PackageName + " (" + AssetDatabase.GetAssetPath(package) + ")");
            Section(sb, "File warnings", loaded.warnings);
            Section(sb, "Mask textures", p.textures);
            Section(sb, "Items bound (item <- sources; density baked into the mask, include above " + GolfMapZones.F(kIncludeThreshold) + ")", p.bound);
            Section(sb, "Exported items missing from the package", p.missing);
            Section(sb, "Package items with no export entry", p.unbound);
            Section(sb, "Bush height twins (item: twin, its height at scale 1)", p.height);
            Section(sb, "Bush height notes", p.heightNotes);
            Section(sb, "Mask groups created", p.groupsCreate);
            Section(sb, "Mask groups updated", p.groupsUpdate);
            Section(sb, "Mask groups deleted", p.groupsDelete);
            Section(sb, "Rules removed", p.removals.Select(r => r.line).ToList());
            Section(sb, "Rules added", p.rulesAdd);
            Section(sb, "Rules updated", p.rulesUpdate);
            Section(sb, "Rules on groups not in the package (left alone; VSP skips them)", p.dangling);
            Directory.CreateDirectory("GolfMapSpelunk");
            File.WriteAllText("GolfMapSpelunk/" + p.course + "_zone_import.txt", sb.ToString());
            return PlanText(p, package, true);
        }

        static void Section(System.Text.StringBuilder sb, string title, List<string> lines)
        {
            sb.AppendLine();
            sb.AppendLine(title + " (" + lines.Count + ")");
            foreach (var line in lines) sb.AppendLine("  " + line);
        }
    }
}
