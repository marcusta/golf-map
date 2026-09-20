// Vegetation Studio Pro half of GolfMap > Vegetation Zones (GolfMapZoneImporter.cs).
//
// What it writes into the terrain's vegetation package:
//   - one TextureMaskGroup per zone type, named "golfmap-zone:<key>", of type
//     RGBAChannel, holding the zone PNG over the terrain's world rectangle with the
//     group's ChannelSelector default set to the zone type's channel;
//   - per item binding, a texture mask Density rule (spawn chance times the sampled
//     channel times maxDensity) and an Include rule (spawn only where the channel is
//     above a low threshold) against that group, updated in place on re-import.
// Nothing else about an item is touched (D-VZ9), and no VegetationSystemPro is ever
// created here: the tree planter builds systems through GolfMapVspRig.
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
        // bounds are the terrain square plus VSP's 1 m margin.
        static bool SystemMatchesTerrain(VegetationSystemPro system, Terrain target)
        {
            if (!system || !target || !target.terrainData || system.gameObject.scene != target.gameObject.scene) return false;
            if (!system.VegetationStudioTerrainObjectList.Contains(target.gameObject)) return false;
            var bounds = system.VegetationSystemBounds; var size = target.terrainData.size;
            var center = target.transform.position + size / 2;
            return Mathf.Abs(bounds.size.x - (size.x + 2)) <= 2 && Mathf.Abs(bounds.size.z - (size.z + 2)) <= 2 &&
                Mathf.Abs(bounds.center.x - center.x) <= 1 && Mathf.Abs(bounds.center.z - center.z) <= 1;
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
            if (!terrain) return;
            if (systems.Count == 0) { text += "\nNo VSP system covers the terrain."; return; }
            var package = Package;
            text += "\nVSP system: " + VspSystem.name + (package ? ", package '" + package.PackageName + "' (" + package.VegetationInfoList.Count + " items)" : ", no package");
            if (package == null || loaded == null) return;
            var names = new HashSet<string>(package.VegetationInfoList.Select(i => (i.Name ?? "").Trim()));
            var missing = loaded.zoneTypes.SelectMany(t => t.items).Select(b => b.item.Trim()).Distinct().Where(n => !names.Contains(n)).ToList();
            if (missing.Count > 0) text += "\nWARNING " + missing.Count + " bound item(s) not in the package: " + string.Join(", ", missing.ToArray());
            var groups = package.TextureMaskGroupList.Count(g => GolfMapZones.IsGroupName(g.TextureMaskName));
            text += "\nExisting golfmap-zone mask groups in the package: " + groups + ".";
        }

        // ---- import --------------------------------------------------------

        class ImportReport
        {
            public List<string> groupsCreated = new List<string>(), groupsUpdated = new List<string>(), staleGroups = new List<string>();
            public List<string> bound = new List<string>(), missingItems = new List<string>(), unboundItems = new List<string>(), unusedChannels = new List<string>();
            public List<string> textures = new List<string>();
            public int rulesCreated, rulesUpdated;
        }

        partial void ImportVsp()
        {
            var system = VspSystem;
            var package = Package;
            if (!system) throw new Exception("No VegetationSystemPro covers '" + terrain.name + "'. Plant trees first so the planter builds the system (GolfMapVspRig).");
            if (!package) throw new Exception("Choose the vegetation package that holds the lower vegetation.");
            if (GolfMapTreePlanter.IsImportedCatalogue(package)) throw new Exception("Refusing to write zone masks into the planter's tree catalogue. Pick the lower-vegetation package.");
            if (!EditorUtility.IsPersistent(package)) throw new Exception("The vegetation package is not a saved asset.");

            // The active course's folder; a project without a course asset falls back to the export's name.
            var active = GolfMapCourses.Active();
            var course = active ? GolfMapCourses.Name(active) : GolfMapZones.CourseName(loadedPath, loaded.plot);
            var folder = (active ? GolfMapCourses.Folder(active) : GolfMapCourses.Root + course + "/") + "Zones/";
            var report = new ImportReport();

            // 1. Textures: copy next to the trees file and import readable RGBA32.
            var textures = new List<Texture2D>();
            foreach (var mask in loaded.masks)
            {
                var source = Path.Combine(Path.GetDirectoryName(loadedPath) ?? "", mask.file);
                var texture = ImportMaskTexture(source, folder + Path.GetFileName(mask.file), mask.resolution);
                textures.Add(texture);
                report.textures.Add(AssetDatabase.GetAssetPath(texture) + " " + texture.width + "x" + texture.height + " " + texture.format);
            }

            // 2. Mask groups, one per zone type, over the terrain square (world x east, z north).
            var size = terrain.terrainData.size;
            var rect = new Rect(terrain.transform.position.x, terrain.transform.position.z, size.x, size.z);
            var groupsByKey = new Dictionary<string, TextureMaskGroup>();
            foreach (var type in loaded.zoneTypes)
            {
                var name = GolfMapZones.GroupName(type.key);
                var group = package.TextureMaskGroupList.FirstOrDefault(g => g.TextureMaskName == name);
                if (group == null)
                {
                    group = new TextureMaskGroup(TextureMaskType.RGBAChannel) { TextureMaskName = name };
                    package.TextureMaskGroupList.Add(group);
                    report.groupsCreated.Add(name);
                }
                else report.groupsUpdated.Add(name);
                group.TextureMaskType = TextureMaskType.RGBAChannel;
                SetChannel(group.Settings.ControlerPropertyList, type.channel);
                // One texture per group; a stale second entry from a hand edit is dropped.
                while (group.TextureMaskList.Count > 1) group.TextureMaskList.RemoveAt(group.TextureMaskList.Count - 1);
                if (group.TextureMaskList.Count == 0) group.TextureMaskList.Add(new TextureMask());
                var tm = group.TextureMaskList[0];
                tm.MaskTexture = textures[type.texture];
                tm.TextureRect = rect;
                tm.Repeat = Vector2.one;
                groupsByKey[type.key] = group;
            }
            foreach (var g in package.TextureMaskGroupList)
                if (GolfMapZones.IsGroupName(g.TextureMaskName) && !groupsByKey.ContainsKey(GolfMapZones.KeyFromGroupName(g.TextureMaskName)))
                    report.staleGroups.Add(g.TextureMaskName);

            // 3. Item rules from the binding table.
            var boundItems = new HashSet<VegetationItemInfoPro>();
            foreach (var type in loaded.zoneTypes)
            {
                var group = groupsByKey[type.key];
                int used = 0;
                foreach (var binding in type.items)
                {
                    var item = FindItem(package, binding.item);
                    if (item == null) { report.missingItems.Add(binding.item + " (" + type.key + ")"); continue; }
                    used++;
                    boundItems.Add(item);
                    bool created;
                    var density = EnsureRule(item.TextureMaskDensityRuleList, group, out created);
                    if (created) report.rulesCreated++; else report.rulesUpdated++;
                    density.MinDensity = binding.minDensity;
                    density.MaxDensity = binding.maxDensity;
                    density.DensityMultiplier = Mathf.Clamp01(binding.maxDensity);
                    item.UseTextureMaskDensityRules = true;
                    var include = EnsureRule(item.TextureMaskIncludeRuleList, group, out created);
                    if (created) report.rulesCreated++; else report.rulesUpdated++;
                    include.MinDensity = kIncludeThreshold;
                    include.MaxDensity = 1f;
                    item.UseTextureMaskIncludeRules = true;
                    report.bound.Add(item.Name + " <- " + type.key + " (density x" + GolfMapZones.F(binding.maxDensity) + (binding.minDensity > 0 ? ", min " + GolfMapZones.F(binding.minDensity) + " recorded only" : "") + ")");
                }
                if (used == 0) report.unusedChannels.Add(type.key + " (texture " + type.texture + " channel " + "RGBA"[type.channel] + ")");
            }
            foreach (var item in package.VegetationInfoList)
                if (!boundItems.Contains(item)) report.unboundItems.Add(item.Name + (item.EnableRuntimeSpawn ? "" : " [runtime spawn off]"));

            // 4. Save and make VSP respawn from the new masks.
            EditorUtility.SetDirty(package);
            system.RefreshVegetationSystem();
            system.ClearCache();
            EditorUtility.SetDirty(system);
            EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
            AssetDatabase.SaveAssets();
            SceneView.RepaintAll();

            // 5. Report next to the tree import report.
            status = WriteReport(course, package, report);
            Debug.Log("[GolfMap] " + status.Split('\n')[0] + " Report: GolfMapSpelunk/" + course + "_zone_import.txt");
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
            var exact = package.VegetationInfoList.FirstOrDefault(i => i.Name == name);
            if (exact != null) return exact;
            var trimmed = name.Trim();
            var loose = package.VegetationInfoList.Where(i => (i.Name ?? "").Trim() == trimmed).ToList();
            return loose.Count == 1 ? loose[0] : null;
        }

        // The rule against `group` in `list`, created from the group's settings when absent.
        // The channel is stamped on the rule either way: VSP samples the rule's own copy.
        static TextureMaskRule EnsureRule(List<TextureMaskRule> list, TextureMaskGroup group, out bool created)
        {
            var rule = list.FirstOrDefault(r => r.TextureMaskGroupID == group.TextureMaskGroupID);
            created = rule == null;
            if (created) { rule = new TextureMaskRule(group.Settings) { TextureMaskGroupID = group.TextureMaskGroupID }; list.Add(rule); }
            SetChannel(rule.TextureMaskPropertiesList, group.Settings.GetIntPropertyValue(kChannelProperty));
            return rule;
        }

        string WriteReport(string course, VegetationPackagePro package, ImportReport r)
        {
            var summary = "Imported " + loaded.zoneTypes.Count + " zone type(s): " + r.groupsCreated.Count + " mask group(s) created, " + r.groupsUpdated.Count + " updated; "
                + r.bound.Count + " item binding(s) applied (" + r.rulesCreated + " rules created, " + r.rulesUpdated + " updated); "
                + r.missingItems.Count + " bound item(s) missing from the package, " + r.unboundItems.Count + " package item(s) without a binding, "
                + r.unusedChannels.Count + " channel(s) no item uses" + (r.staleGroups.Count > 0 ? ", " + r.staleGroups.Count + " stale golfmap-zone group(s) left in place" : "") + ". Save the scene.";
            var sb = new System.Text.StringBuilder();
            sb.AppendLine(DateTime.UtcNow.ToString("o"));
            sb.AppendLine(summary);
            sb.AppendLine("Zones file: " + loadedPath);
            sb.AppendLine("Terrain: " + terrain.name + " at " + terrain.transform.position + " size " + terrain.terrainData.size);
            sb.AppendLine("System: " + VspSystem.name + "  Package: " + package.PackageName + " (" + AssetDatabase.GetAssetPath(package) + ")");
            Section(sb, "Mask textures", r.textures);
            Section(sb, "Mask groups created", r.groupsCreated);
            Section(sb, "Mask groups updated", r.groupsUpdated);
            Section(sb, "Stale golfmap-zone groups (zone type no longer exported; delete by hand if unwanted)", r.staleGroups);
            Section(sb, "Items bound (density x maxDensity, include above " + GolfMapZones.F(kIncludeThreshold) + ")", r.bound);
            Section(sb, "Items named in bindings but missing from the package", r.missingItems);
            Section(sb, "Package items with no binding (untouched)", r.unboundItems);
            Section(sb, "Channels no item uses", r.unusedChannels);
            Directory.CreateDirectory("GolfMapSpelunk");
            File.WriteAllText("GolfMapSpelunk/" + course + "_zone_import.txt", sb.ToString());
            var shown = summary;
            if (r.missingItems.Count > 0) shown += "\nMissing items: " + string.Join(", ", r.missingItems.ToArray());
            if (r.unusedChannels.Count > 0) shown += "\nUnused channels: " + string.Join(", ", r.unusedChannels.ToArray());
            if (r.unboundItems.Count > 0) shown += "\nUnbound package items: " + string.Join(", ", r.unboundItems.ToArray());
            return shown;
        }

        static void Section(System.Text.StringBuilder sb, string title, List<string> lines)
        {
            sb.AppendLine();
            sb.AppendLine(title + " (" + lines.Count + ")");
            foreach (var line in lines) sb.AppendLine("  " + line);
        }
    }
}
