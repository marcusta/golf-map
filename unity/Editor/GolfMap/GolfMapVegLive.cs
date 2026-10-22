// Vegetation palette editor, scene side: puts palette values into what the Scene view
// draws, as they change, without golfmap.grass.apply or a replant.
//
//   grass / bush items  VSP item fields and shader-controller values on the lower-vegetation
//                       packages (found by item name). Colours and shading: VSP re-applies its
//                       controllers to its own material copies (RefreshMaterials, instant).
//                       Size, spacing and noise: the item's cells are cleared and spawn again
//                       (ClearCache per item, fast). LOD factor and shadows are read at draw time.
//   tree looks          the look's material copies (what the Lab trees draw), then the planted
//                       trees: VSP draws NM/SpeedTree colours from the catalogue's controller
//                       settings, not the material, so those are re-synced from the prefab
//                       (SyncPrefabColours) and other floats set on VSP's material copies.
//                       Outer billboards keep their baked colours until a Plant with rebake.
//
// A bush's material floats are live on VSP's copies only; they stick once Save + Rebuild VSP
// gives the item its course-local prefab copy (GolfMapGrass "material" overrides). A texture
// white point needs a new greyscale texture: Rebuild VSP too.
//
// Also here: solo (hide every other lower-vegetation item while judging a few), spots (where a
// selection grows: zone masks for grass, planted instances for trees) and the Lab.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AwesomeTechnologies.Vegetation.PersistentStorage;
using AwesomeTechnologies.VegetationSystem;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapVegLive
    {
        // ---- VSP lookup ---------------------------------------------------------------

        sealed class Slot
        {
            public VegetationSystemPro system;
            public VegetationPackagePro package;
            public VegetationItemInfoPro item;
            public int packageIndex, itemIndex;
            public bool Valid { get { return system && package && packageIndex < system.VegetationPackageProList.Count && system.VegetationPackageProList[packageIndex] == package && itemIndex < package.VegetationInfoList.Count && package.VegetationInfoList[itemIndex] == item; } }
        }

        static Dictionary<string, List<Slot>> grassSlots;      // item name -> its VSP items (lower-vegetation packages)
        static Dictionary<GameObject, List<Slot>> treeSlots;    // prefab -> catalogue items drawing it
        static double lookupTime;

        public static void Invalidate() { grassSlots = null; treeSlots = null; }

        static void Lookup()
        {
            if (grassSlots != null && EditorApplication.timeSinceStartup - lookupTime < 3 && grassSlots.Values.All(l => l.All(s => s.Valid))) return;
            grassSlots = new Dictionary<string, List<Slot>>();
            treeSlots = new Dictionary<GameObject, List<Slot>>();
            lookupTime = EditorApplication.timeSinceStartup;
            var scene = EditorSceneManager.GetActiveScene();
            foreach (var system in UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>())
            {
                if (!system || system.gameObject.scene != scene) continue;
                for (int p = 0; p < system.VegetationPackageProList.Count; p++)
                {
                    var package = system.VegetationPackageProList[p];
                    if (!package) continue;
                    bool catalogue = GolfMapTreePlanter.IsImportedCatalogue(package);
                    for (int i = 0; i < package.VegetationInfoList.Count; i++)
                    {
                        var item = package.VegetationInfoList[i];
                        var slot = new Slot { system = system, package = package, item = item, packageIndex = p, itemIndex = i };
                        if (catalogue)
                        {
                            if (!item.VegetationPrefab) continue;
                            List<Slot> list;
                            if (!treeSlots.TryGetValue(item.VegetationPrefab, out list)) treeSlots[item.VegetationPrefab] = list = new List<Slot>();
                            list.Add(slot);
                        }
                        else
                        {
                            // A distance copy ("<item> @15m") is its item with a shorter render distance
                            // (GolfMapGrass.Item.AtDistance): every live value goes to it too, or the
                            // grass near the camera keeps the old tints until the next apply.
                            string name = GolfMapZones.DistanceCopyBase(item.Name) ?? item.Name ?? "";
                            List<Slot> list;
                            if (!grassSlots.TryGetValue(name, out list)) grassSlots[name] = list = new List<Slot>();
                            list.Add(slot);
                        }
                    }
                }
            }
        }

        static List<Slot> GrassSlots(string name) { Lookup(); List<Slot> l; return grassSlots.TryGetValue(name, out l) ? l : new List<Slot>(); }

        public static bool InScene(GolfMapVegEntry e)
        {
            if (e.kind == GolfMapVegKind.Grass || e.kind == GolfMapVegKind.Bush) return GrassSlots(e.name).Count > 0;
            return true;
        }

        public static Color? ControllerColour(string itemName, string property)
        {
            foreach (var s in GrassSlots(itemName))
            {
                var p = s.item.ShaderControllerSettings == null ? null : s.item.ShaderControllerSettings.ControlerPropertyList.FirstOrDefault(x => x.PropertyName == property);
                if (p != null) return p.ColorValue;
            }
            return null;
        }

        // Where the VSP item disagrees with the entry (hand edits in VSP's inspector, an apply
        // that never ran): "role file -> vsp".
        public static List<string> SceneDiffers(GolfMapVegEntry e)
        {
            var differs = new List<string>();
            if (e.kind != GolfMapVegKind.Grass && e.kind != GolfMapVegKind.Bush) return differs;
            bool bush = e.kind == GolfMapVegKind.Bush;
            foreach (var s in GrassSlots(e.name))
            {
                var item = s.item;
                Action<string, float, float> f = (role, file, vsp) => { if (Mathf.Abs(file - vsp) > 1e-3f) differs.Add(role + " " + file + " -> " + vsp); };
                Func<string, Color?> controller = name =>
                {
                    var p = item.ShaderControllerSettings == null ? null : item.ShaderControllerSettings.ControlerPropertyList.FirstOrDefault(x => x.PropertyName == name);
                    return p == null ? (Color?)null : p.ColorValue;
                };
                var healthy = controller(TintProperty(item, bush, true));
                var h = e.Role("healthy").FirstOrDefault();
                if (healthy.HasValue && h != null && GolfMapVegPalette.Hex(healthy.Value) != GolfMapVegPalette.Hex(h.c)) differs.Add("healthy " + GolfMapVegPalette.Hex(h.c) + " -> " + GolfMapVegPalette.Hex(healthy.Value));
                f("width", e.Get("width", 1), item.ScaleMultiplier.x);
                f("height", e.Get("height", 1), item.ScaleMultiplier.y);
                f("minScale", e.Get("minScale", 1), item.MinScale);
                f("maxScale", e.Get("maxScale", 1), item.MaxScale);
                f("sampleDistance", e.Get("sampleDistance", 1), item.SampleDistance);
                f("density", e.Get("density", 1), item.Density);
                f("verticalOffset", e.Get("verticalOffset", 0), item.Offset.y);
                f("noiseCutoff", e.Get("noiseCutoff", 0), item.UseNoiseCutoff ? item.NoiseCutoffValue : 0);
                if (e.Get("noiseCutoff", 0) > 0) f("noiseCutoffScale", e.Get("noiseCutoffScale", 14), item.NoiseCutoffScale);
                f("maxSteepness", e.Get("maxSteepness", 1), item.MaxSteepness);
                f("lodFactor", e.Get("lodFactor", 1), item.LODFactor);
            }
            return differs;
        }

        // ---- push -------------------------------------------------------------------------

        public sealed class Result
        {
            public int pushed, respawned, materialRefreshes, notInScene, baking;
            public readonly List<string> needsRebuild = new List<string>();   // item names whose change only a Rebuild VSP shows
            public readonly List<string> fileOnly = new List<string>();
            public bool trees;
            public string Summary()
            {
                var parts = new List<string>();
                if (pushed > 0) parts.Add(pushed + " live");
                if (respawned > 0) parts.Add(respawned + " respawned");
                if (baking > 0) parts.Add("tint bakes when you let go");
                if (notInScene > 0) parts.Add(notInScene + " not in the scene (Rebuild VSP)");
                if (needsRebuild.Count > 0) parts.Add("Rebuild VSP to see: " + string.Join(", ", needsRebuild.Distinct().Take(4).ToArray()) + (needsRebuild.Distinct().Count() > 4 ? " ..." : ""));
                if (fileOnly.Count > 0) parts.Add("file only: " + string.Join(", ", fileOnly.Distinct().ToArray()));
                if (trees) parts.Add("outer tree billboards update at the next Plant (rebake)");
                return string.Join(" · ", parts.ToArray());
            }
        }

        // What each entry last looked like in the scene, to push only what changed.
        static readonly Dictionary<string, GolfMapVegEntry> shown = new Dictionary<string, GolfMapVegEntry>();
        static readonly HashSet<Slot> pendingRespawn = new HashSet<Slot>();
        static double lastRespawn;

        public static void Forget() { shown.Clear(); }
        public static bool ShowsAnything { get { return shown.Count > 0; } }
        public static void Assume(IEnumerable<GolfMapVegEntry> entries) { foreach (var e in entries) shown[e.key] = e.Copy(); }

        // Push the entries' values that differ from what the scene shows. `throttle`: a slider is
        // being dragged - respawns wait (FlushRespawns) so the drag stays smooth.
        public static Result Push(GolfMapCourse course, GolfMapVegState state, IEnumerable<GolfMapVegEntry> entries, bool throttle)
        {
            var result = new Result();
            var refresh = new HashSet<VegetationSystemPro>();
            var dirty = new HashSet<UnityEngine.Object>();
            foreach (var e in entries)
            {
                if (e.readOnly) continue;
                GolfMapVegEntry was;
                shown.TryGetValue(e.key, out was);
                // An entry or value the scene has never shown is taken as it is: a reload that brings
                // new values (a new kind of setting, a new look) must not bake or write anything.
                var changed = was == null ? new List<GolfMapVegValue>() : e.values.Where(v => { var w = was.Find(v); return w != null && !w.Same(v); }).ToList();
                if (changed.Count == 0) { if (was == null || was.values.Count != e.values.Count) shown[e.key] = e.Copy(); continue; }
                try
                {
                    if (e.kind == GolfMapVegKind.Tree) PushTree(course, e, changed, refresh, dirty, result);
                    else if (e.kind == GolfMapVegKind.Palette) PushPalette(state, e, changed, refresh, dirty, result);
                    else PushGrass(e, changed, refresh, dirty, result);
                }
                catch (Exception ex) { Debug.LogException(ex); }
                shown[e.key] = e.Copy();
            }
            foreach (var system in refresh) { system.RefreshMaterials(); result.materialRefreshes++; }
            foreach (var o in dirty) EditorUtility.SetDirty(o);
            if (!throttle || EditorApplication.timeSinceStartup - lastRespawn > 0.25) result.respawned += FlushRespawns();
            SceneView.RepaintAll();
            EditorApplication.QueuePlayerLoopUpdate();
            return result;
        }

        public static int FlushRespawns()
        {
            int n = 0;
            foreach (var s in pendingRespawn.ToList())
            {
                if (!s.Valid) continue;
                s.system.ClearCache(s.packageIndex, s.itemIndex);
                n++;
            }
            pendingRespawn.Clear();
            lastRespawn = EditorApplication.timeSinceStartup;
            if (n > 0) { SceneView.RepaintAll(); EditorApplication.QueuePlayerLoopUpdate(); }
            return n;
        }
        public static bool RespawnPending { get { return pendingRespawn.Count > 0; } }

        static bool HasController(VegetationItemInfoPro item, string name)
        {
            return item.ShaderControllerSettings != null && item.ShaderControllerSettings.ControlerPropertyList.Any(x => x.PropertyName == name);
        }

        // The controller property a grass/bush tint goes to: VSP's grass shader (TintColor2/1), its NM tree
        // controller (HealtyColor, sic) or its NM Advanced Grass one (ferns, bilberry, heather) - the twin of
        // GolfMapGrass.Configure. Writing HealtyColor on an Advanced Grass item did nothing (Vreta ferns 2026-10-22).
        public static string TintProperty(VegetationItemInfoPro item, bool bush, bool healthy)
        {
            if (!bush) return healthy ? "TintColor2" : "TintColor1";
            if (!HasController(item, "HealtyColor") && HasController(item, "HealthyColorTint")) return healthy ? "HealthyColorTint" : "DryColorTint";
            return healthy ? "HealtyColor" : "DryColor";
        }

        static void SetController(VegetationItemInfoPro item, string name, Color? colour, float? value)
        {
            var settings = item.ShaderControllerSettings;
            var p = settings == null ? null : settings.ControlerPropertyList.FirstOrDefault(x => x.PropertyName == name);
            if (p == null) return;
            if (colour.HasValue) p.ColorValue = colour.Value;
            if (value.HasValue) p.FloatValue = value.Value;
        }

        // VSP's shader controllers overwrite some material properties on its own material copies
        // with values cached in the package (per controller: NMTreeShaderControler,
        // CTIShaderController, SpeedtreeShaderController). A change to one of those must go into
        // the controller, or RefreshMaterials puts the old value straight back.
        static string ControllerProperty(VegetationItemInfoPro item, string prop, string part)
        {
            var heading = item.ShaderControllerSettings == null ? null : item.ShaderControllerSettings.Heading;
            bool bark = part == "bark";
            switch (heading)
            {
                case "Nature Manufacture tree":
                    switch (prop)
                    {
                        case "_HealthyColor": return "HealtyColor";   // sic
                        case "_DryColor": return "DryColor";
                        case "_Color": return bark ? "BarkColor" : null;
                        case "_InitialBend": return "InitialBend";
                        case "_Stiffness": return "Stiffness";
                        case "_Drag": return "Drag";
                        case "_ShiverDrag": return "ShiverDrag";
                        case "_ShiverDirectionality": return "ShiverDirectionality";
                    }
                    return null;
                case "CTI Tree shader":
                    switch (prop)
                    {
                        case "_HueVariation": return bark ? "BarkColorVariation" : "ColorVariation";
                        case "_TranslucencyStrength": return bark ? "BarkTranslucencyStrength" : "TranslucencyStrength";
                        case "_Cutoff": return bark ? "BarkAlphaCutoff" : "AlphaCutoff";
                        case "_TumbleStrength": return "TumbleStrength";
                        case "_TumbleFrequency": return "TumbleFrequency";
                        case "_TimeOffset": return "TimeOffset";
                        case "_LeafTurbulence": return "LeafTurbulence";
                        case "_EdgeFlutterInfluence": return "EdgeFlutterInfluence";
                    }
                    return null;
                case "Nature Manufacture Advanced Grass":
                    if (prop == "_HealthyColor") return "HealthyColorTint";
                    if (prop == "_DryColor") return "DryColorTint";
                    return null;
                case "SpeedTree settings":
                    if (prop == "_Color") return bark ? "BarkTintColor" : "FoliageTintColor";
                    if (prop == "_HueVariation") return bark ? "BarkHue" : "FoliageHue";
                    return null;
            }
            return null;
        }

        static void SetMaterialValue(Slot s, GolfMapVegValue v, string materialName)
        {
            // VSP's own material copies (named as their sources) ...
            foreach (var m in ModelMaterials(s))
                if ((materialName == null || m.name == materialName) && m.HasProperty(v.prop)) { if (v.colour) m.SetColor(v.prop, v.c); else m.SetFloat(v.prop, v.f); }
            // ... and the controller value that overrides them.
            string controller = ControllerProperty(s.item, v.prop, v.part);
            if (controller != null) SetController(s.item, controller, v.colour ? v.c : (Color?)null, v.colour ? (float?)null : v.f);
        }

        static IEnumerable<Material> ModelMaterials(Slot s)
        {
            var info = s.system.GetVegetationItemModelInfo(s.packageIndex, s.itemIndex);
            if (info == null) return new Material[0];
            return new[] { info.VegetationMaterialsLOD0, info.VegetationMaterialsLOD1, info.VegetationMaterialsLOD2, info.VegetationMaterialsLOD3 }
                .Where(a => a != null).SelectMany(a => a).Where(m => m);
        }

        static void PushGrass(GolfMapVegEntry e, List<GolfMapVegValue> changed, HashSet<VegetationSystemPro> refresh, HashSet<UnityEngine.Object> dirty, Result result)
        {
            var slots = GrassSlots(e.name);
            if (slots.Count == 0) { result.notInScene++; return; }
            bool bush = e.kind == GolfMapVegKind.Bush;
            foreach (var s in slots)
            {
                var item = s.item;
                bool respawn = false, materials = false;
                foreach (var v in changed)
                {
                    switch (v.role)
                    {
                        case "healthy": SetController(item, TintProperty(item, bush, true), v.c, null); materials = true; break;
                        case "dry": SetController(item, TintProperty(item, bush, false), v.c, null); materials = true; break;
                        case "randomDarkening": SetController(item, "RandomDarkening", null, v.f); materials = true; break;
                        case "rootAmbient": SetController(item, "RootAmbient", null, v.f); materials = true; break;
                        case "alphaCutoff": SetController(item, "AlphaCutoff", null, v.f); materials = true; break;
                        case "width": case "height":
                            item.ScaleMultiplier = new Vector3(e.Get("width", 1), e.Get("height", 1), e.Get("width", 1)); respawn = true; break;
                        case "minScale": item.MinScale = v.f; respawn = true; break;
                        case "maxScale": item.MaxScale = v.f; respawn = true; break;
                        case "noiseScaleMin": item.NoiseScaleMinScale = v.f; respawn = true; break;
                        case "noiseScaleMax": item.NoiseScaleMaxScale = v.f; respawn = true; break;
                        case "noiseScaleScale": item.UseNoiseScaleRule = v.f > 0; item.NoiseScaleScale = v.f; respawn = true; break;
                        case "sampleDistance": item.SampleDistance = Mathf.Max(0.05f, v.f); respawn = true; break;
                        case "density": item.Density = v.f; respawn = true; break;
                        case "noiseDensityScale": item.UseNoiseDensity = v.f > 0; item.NoiseDensityScale = v.f; respawn = true; break;
                        case "noiseCutoff": item.UseNoiseCutoff = v.f > 0; item.NoiseCutoffValue = Mathf.Clamp01(v.f); item.NoiseCutoffInverse = false; item.NoiseCutoffOffset = Vector2.zero; respawn = true; break;
                        case "noiseCutoffScale": item.NoiseCutoffScale = Mathf.Max(1f, v.f); respawn = true; break;
                        case "verticalOffset": item.Offset = new Vector3(0, v.f, 0); respawn = true; break;
                        case "maxSteepness": item.MaxSteepness = v.f; respawn = true; break;
                        case "lodFactor": item.LODFactor = v.f; break;
                        case "shadows": item.DisableShadows = v.f < 0.5f; break;
                        case "whitePoint": result.needsRebuild.Add(e.name); break;
                        case "maxDensity": result.fileOnly.Add("binding weights (re-bind + export zones)"); break;
                        default:
                            if (GolfMapVegPalette.IsMaterial(v.role))
                            {
                                // VSP's copies now; the course-local prefab copy too when the item draws one.
                                SetMaterialValue(s, v, null);
                                bool local = item.VegetationPrefab && AssetDatabase.GetAssetPath(item.VegetationPrefab).StartsWith(GolfMapCourses.Root, StringComparison.OrdinalIgnoreCase);
                                if (local)
                                    foreach (var m in GolfMapVegPalette.BushMaterials(AssetDatabase.GetAssetPath(item.VegetationPrefab)))
                                        if (m.HasProperty(v.prop)) { m.SetFloat(v.prop, v.f); dirty.Add(m); }
                                if (!local) result.needsRebuild.Add(e.name + " (material)");
                                materials = true;
                            }
                            break;
                    }
                }
                if (materials) refresh.Add(s.system);
                if (respawn) pendingRespawn.Add(s);
                dirty.Add(s.package);
            }
            result.pushed++;
        }

        // Palette-wide values go to the items whose last palette (in file order) it is - the
        // palette golfmap.grass.apply configures them from last.
        static void PushPalette(GolfMapVegState state, GolfMapVegEntry pe, List<GolfMapVegValue> changed, HashSet<VegetationSystemPro> refresh, HashSet<UnityEngine.Object> dirty, Result result)
        {
            string key = pe.palettes[0];
            foreach (var member in pe.members)
            {
                var e = state.Get(member);
                if (e == null || e.palettes.LastOrDefault() != key) continue;
                foreach (var s in GrassSlots(e.name))
                {
                    foreach (var v in changed)
                    {
                        if (v.role == "tintAreaScale") { SetController(s.item, "TintAreaScale", null, v.f); refresh.Add(s.system); }
                        else if (v.role == "distanceFalloff" && e.ownFalloff < 0) { s.item.UseDistanceFalloff = v.f > 0; s.item.DistanceFalloffStartDistance = Mathf.Clamp01(v.f); pendingRespawn.Add(s); }
                    }
                    dirty.Add(s.package);
                }
            }
            if (changed.Any(v => v.role == "plantDistance"))
            {
                float distance = state.entries.Where(x => x.kind == GolfMapVegKind.Palette).Max(x => x.Get("plantDistance", 0));
                Lookup();
                foreach (var system in grassSlots.Values.SelectMany(l => l).Select(s => s.system).Distinct())
                    if (distance > 0 && !Mathf.Approximately(system.VegetationSettings.PlantDistance, distance))
                    {
                        system.VegetationSettings.PlantDistance = distance;
                        system.ClearCache();
                        dirty.Add(system);
                    }
            }
            result.pushed++;
        }

        static void PushTree(GolfMapCourse course, GolfMapVegEntry e, List<GolfMapVegValue> changed, HashSet<VegetationSystemPro> refresh, HashSet<UnityEngine.Object> dirty, Result result)
        {
            // The look's materials are the record: write them first (the Lab draws them as they are).
            var materials = new Dictionary<string, Material>();
            foreach (var v in changed)
            {
                if (string.IsNullOrEmpty(v.slot)) { if (v.role == "weight") result.fileOnly.Add("look weights (next Plant)"); continue; }
                if (GolfMapVegPalette.IsBaked(v))
                {
                    // Baked into the albedo copy once the slider is let go (FlushBakes).
                    QueueBake(v.slot.Substring(GolfMapVegPalette.BakeSlot.Length), GolfMapVegBake.ToTint(v.c));
                    result.baking++;
                    continue;
                }
                Material m;
                if (!materials.TryGetValue(v.slot, out m)) materials[v.slot] = m = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(v.slot));
                if (!m || !m.HasProperty(v.prop)) continue;
                if (v.colour) m.SetColor(v.prop, v.c); else m.SetFloat(v.prop, v.f);
                dirty.Add(m);
            }
            // Then every planted item drawing one of the look's shapes.
            Lookup();
            foreach (var prefab in LookPrefabs(course, e))
            {
                List<Slot> slots;
                if (!treeSlots.TryGetValue(prefab, out slots)) continue;
                foreach (var s in slots)
                {
                    foreach (var v in changed.Where(x => !string.IsNullOrEmpty(x.slot)))
                    {
                        Material source; materials.TryGetValue(v.slot, out source);
                        if (source) SetMaterialValue(s, v, source.name);
                    }
                    // NM/SpeedTree colours as the planter caches them (SpeedTree billboards get the outer grade).
                    GolfMapTreePlanter.SyncPrefabColours(s.item);
                    refresh.Add(s.system);
                    dirty.Add(s.package);
                    if (s.item.UseBillboards) result.trees = true;
                }
            }
            result.pushed++;
        }

        // ---- baked tints (GolfMapVegBake) ------------------------------------------------------

        static readonly Dictionary<string, Vector3> pendingBakes = new Dictionary<string, Vector3>();   // target texture -> tint
        static double lastBakeQueued;
        public static bool BakePending { get { return pendingBakes.Count > 0; } }
        // A bake takes a second or two: wait until the value has settled (a colour picker streams changes).
        public static bool BakeDue { get { return pendingBakes.Count > 0 && EditorApplication.timeSinceStartup - lastBakeQueued > 0.35; } }

        public static void QueueBake(string texture, Vector3 tint) { pendingBakes[texture] = tint; lastBakeQueued = EditorApplication.timeSinceStartup; }

        public static string FlushBakes(GolfMapCourse course)
        {
            if (pendingBakes.Count == 0) return "";
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var work = pendingBakes.ToList();
            pendingBakes.Clear();
            var log = new List<string>();
            try
            {
                int i = 0;
                foreach (var kv in work)
                {
                    var target = GolfMapVegBake.Targets(course).Values.FirstOrDefault(t => t.texture == kv.Key);
                    if (target == null) { log.Add("no bake target " + kv.Key); continue; }
                    EditorUtility.DisplayProgressBar("Vegetation palettes", "Baking the tint into " + System.IO.Path.GetFileName(kv.Key), (float)i++ / work.Count);
                    GolfMapVegBake.Bake(course, target, kv.Value, log);
                }
            }
            catch (Exception e) { Debug.LogException(e); log.Add("bake failed: " + e.Message); }
            finally { EditorUtility.ClearProgressBar(); }
            SceneView.RepaintAll();
            EditorApplication.QueuePlayerLoopUpdate();
            return "Baked " + string.Join(", ", work.Select(kv => System.IO.Path.GetFileNameWithoutExtension(kv.Key)).ToArray()) + " in " + (clock.ElapsedMilliseconds / 1000.0).ToString("0.0") + " s" +
                (log.Count > 0 ? " (" + string.Join("; ", log.ToArray()) + ")" : "") + ". Save writes it.";
        }

        // A texture swapped under the planted trees: VSP's own material copies still hold the old one.
        public static void Retexture(Texture from, Texture to, string prop)
        {
            if (!from || !to) return;
            Lookup();
            foreach (var s in treeSlots.Values.SelectMany(l => l).Distinct())
                foreach (var m in ModelMaterials(s))
                    if (m.HasProperty(prop) && m.GetTexture(prop) == from) m.SetTexture(prop, to);
        }

        public static List<GameObject> LookPrefabs(GolfMapCourse course, GolfMapVegEntry e)
        {
            var biome = GolfMapVegSession.Biome();
            if (biome == null) return new List<GameObject>();
            var group = biome.Species(e.species);
            var look = group == null ? null : group.looks.FirstOrDefault(l => l.id == e.look);
            var shapes = GolfMapLooks.Shapes(biome, e.species, look);
            if (look == null || look.original) return shapes.Select(s => AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(s.guid))).Where(p => p).ToList();
            return shapes.Select(s => GolfMapLooks.Prefab(course, e.species, look, s)).Where(p => p).ToList();
        }

        // ---- solo ---------------------------------------------------------------------------

        // Solo switches spawning off on every other lower-vegetation item. EnableRuntimeSpawn is
        // saved in the package asset, so what it changed is kept in SessionState (survives script
        // reloads) and put back on unsolo, window close, scene save and before a script reload.
        // golfmap.grass.apply sets spawning from the mask rules anyway.
        const string SoloKey = "GolfMapVegSolo";

        public static bool Soloed { get { return !string.IsNullOrEmpty(SessionState.GetString(SoloKey, "")); } }

        public static int Solo(IEnumerable<string> keepNames)
        {
            Unsolo();
            var keep = new HashSet<string>(keepNames);
            Lookup();
            var backup = new List<string>();
            var systems = new HashSet<VegetationSystemPro>();
            foreach (var pair in grassSlots)
                foreach (var s in pair.Value)
                {
                    if (keep.Contains(pair.Key) || !s.item.EnableRuntimeSpawn) continue;
                    backup.Add(AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(s.package)) + "\t" + s.item.VegetationItemID);
                    s.item.EnableRuntimeSpawn = false;
                    s.system.ClearCache(s.packageIndex, s.itemIndex);
                    systems.Add(s.system);
                }
            SessionState.SetString(SoloKey, string.Join("\n", backup.ToArray()));
            SceneView.RepaintAll(); EditorApplication.QueuePlayerLoopUpdate();
            return backup.Count;
        }

        public static void Unsolo()
        {
            var text = SessionState.GetString(SoloKey, "");
            if (string.IsNullOrEmpty(text)) return;
            SessionState.EraseString(SoloKey);
            foreach (var line in text.Split('\n'))
            {
                var parts = line.Split('\t');
                if (parts.Length != 2) continue;
                var package = AssetDatabase.LoadAssetAtPath<VegetationPackagePro>(AssetDatabase.GUIDToAssetPath(parts[0]));
                var item = package ? package.VegetationInfoList.FirstOrDefault(i => i.VegetationItemID == parts[1]) : null;
                if (item == null) continue;
                item.EnableRuntimeSpawn = true;
            }
            foreach (var system in UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>()) system.ClearCache();
            SceneView.RepaintAll(); EditorApplication.QueuePlayerLoopUpdate();
        }

        [InitializeOnLoadMethod]
        static void Hooks()
        {
            EditorSceneManager.sceneSaving += (scene, path) => Unsolo();
            AssemblyReloadEvents.beforeAssemblyReload += Unsolo;
            EditorApplication.quitting += Unsolo;
        }

        // ---- spots: where a selection grows -------------------------------------------------

        // Cells of a zone mask channel, averaged on a coarse grid (cached per texture).
        const int Grid = 128;
        static readonly Dictionary<string, float[][]> maskGrids = new Dictionary<string, float[][]>();

        static float[][] MaskGrid(string assetPath)
        {
            float[][] grid;
            if (maskGrids.TryGetValue(assetPath, out grid)) return grid;
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
            if (!texture) return null;
            Color32[] px;
            try { px = texture.GetPixels32(); }
            catch (Exception) { return null; }   // not readable: an older import
            int res = texture.width, step = Mathf.Max(1, res / Grid);
            grid = new float[4][];
            for (int c = 0; c < 4; c++) grid[c] = new float[Grid * Grid];
            for (int y = 0; y < res; y++)
            {
                int gy = Mathf.Min(Grid - 1, y / step), row = y * res;
                for (int x = 0; x < res; x++)
                {
                    var p = px[row + x];
                    int g = gy * Grid + Mathf.Min(Grid - 1, x / step);
                    grid[0][g] += p.r; grid[1][g] += p.g; grid[2][g] += p.b; grid[3][g] += p.a;
                }
            }
            return maskGrids[assetPath] = grid;
        }

        // Spread-out places where the named items grow most, densest first (world positions on the ground).
        public static List<Vector3> GrassSpots(GolfMapCourse course, IEnumerable<string> itemNames, out string problem)
        {
            problem = null;
            var names = new HashSet<string>(itemNames);
            var spots = new List<Vector3>();
            var file = GolfMapCourses.ExportFile(course, "inner", "zones");
            if (file == null || !File.Exists(file)) { problem = "No inner zones export to find them by (" + file + ")."; return spots; }
            var zones = GolfMapZones.Load(file);
            var terrain = GolfMapTreePlanter.RoleTerrain(EditorSceneManager.GetActiveScene(), course.innerTerrainName, course.innerTerrainData, "inner");
            if (!terrain) { problem = "No inner terrain in the scene."; return spots; }
            var sum = new float[Grid * Grid];
            int found = 0;
            foreach (var item in zones.items.Where(i => names.Contains(i.item)))
            {
                var grid = MaskGrid(GolfMapCourses.Folder(course) + "Zones/" + Path.GetFileName(zones.masks[item.texture].file));
                if (grid == null) continue;
                found++;
                for (int g = 0; g < sum.Length; g++) sum[g] += grid[item.channel][g];
            }
            if (found == 0) { problem = "None of these items has an imported zone mask yet."; return spots; }
            float size = terrain.terrainData.size.x, cell = size / Grid;
            var origin = terrain.transform.position;
            float top = sum.Max();
            if (top <= 0) { problem = "Their zone masks are empty."; return spots; }
            var picked = new List<int>();
            int separation = Mathf.Max(3, Mathf.RoundToInt(90 / cell));
            foreach (int g in Enumerable.Range(0, sum.Length).Where(i => sum[i] > top * 0.15f).OrderByDescending(i => sum[i]))
            {
                int gx = g % Grid, gy = g / Grid;
                if (picked.Any(o => Mathf.Abs(o % Grid - gx) < separation && Mathf.Abs(o / Grid - gy) < separation)) continue;
                picked.Add(g);
                var flat = origin + new Vector3((gx + 0.5f) * cell, 0, (gy + 0.5f) * cell);
                spots.Add(new Vector3(flat.x, Ground(flat, terrain), flat.z));
                if (spots.Count >= 12) break;
            }
            return spots;
        }

        // Spread-out planted trees of these looks.
        public static List<Vector3> TreeSpots(GolfMapCourse course, IEnumerable<GolfMapVegEntry> looks, out string problem)
        {
            problem = null;
            Lookup();
            var ids = new HashSet<string>();
            foreach (var e in looks)
                foreach (var prefab in LookPrefabs(course, e))
                {
                    List<Slot> slots;
                    if (treeSlots.TryGetValue(prefab, out slots)) foreach (var s in slots) if (s.package.PackageName != "GolfMap imported trees (billboards)") ids.Add(s.item.VegetationItemID);
                }
            var spots = new List<Vector3>();
            if (ids.Count == 0) { problem = "None planted in the inner area yet (a new look needs a Plant)."; return spots; }
            var candidates = new List<Vector3>();
            foreach (var storage in UnityEngine.Object.FindObjectsOfType<PersistentVegetationStorage>())
            {
                if (!storage.VegetationSystemPro || !storage.PersistentVegetationStoragePackage) continue;
                var offset = storage.VegetationSystemPro.VegetationSystemPosition;
                foreach (var cellData in storage.PersistentVegetationStoragePackage.PersistentVegetationCellList)
                    foreach (var info in cellData.PersistentVegetationInfoList)
                        if (ids.Contains(info.VegetationItemID))
                            foreach (var t in info.VegetationItemList) if (candidates.Count < 20000) candidates.Add(t.Position + offset);
            }
            // Deterministic spread: take them in order of a coarse hash so repeated clicks walk the course.
            foreach (var p in candidates.OrderBy(p => Mathf.Repeat(p.x * 12.9898f + p.z * 78.233f, 1)))
            {
                if (spots.Any(o => (o - p).sqrMagnitude < 80 * 80)) continue;
                spots.Add(p);
                if (spots.Count >= 12) break;
            }
            return spots;
        }

        static float Ground(Vector3 flat, Terrain terrain)
        {
            RaycastHit hit;
            if (Physics.Raycast(new Vector3(flat.x, 5000, flat.z), Vector3.down, out hit, 10000)) return hit.point.y;
            return terrain.SampleHeight(flat) + terrain.transform.position.y;
        }

        // Frame a spot from the side, keeping the view's heading: close enough to judge blades.
        public static void Frame(Vector3 spot, float distance)
        {
            var view = SceneView.lastActiveSceneView;
            if (!view) return;
            var forward = view.rotation * Vector3.forward;
            forward.y = 0;
            if (forward.sqrMagnitude < 1e-4f) forward = Vector3.forward;
            var rotation = Quaternion.LookRotation(forward.normalized) * Quaternion.Euler(22, 0, 0);
            view.LookAt(spot + Vector3.up * 0.8f, rotation, distance);
            view.Repaint();
        }

        // ---- Lab: plain instances of tree looks in the scene --------------------------------

        // One tree per look (rows) and shape (columns, by height) at the Scene view's pivot, drawn
        // with the very material assets being tuned: they change as a slider moves, with no VSP
        // colour cache or billboard bake in between. Never saved with the scene or built.
        public const string LabName = "GolfMap Lab (not saved)";
        public static GameObject LabRoot() { return GameObject.Find(LabName); }

        public static string BuildLab(GolfMapCourse course, List<GolfMapVegEntry> looks)
        {
            var view = SceneView.lastActiveSceneView;
            if (!view) return "Open a Scene view first.";
            var biome = GolfMapVegSession.Biome();
            if (biome == null) return "No tree palette.";
            if (LabRoot()) UnityEngine.Object.DestroyImmediate(LabRoot());
            var root = new GameObject(LabName) { hideFlags = HideFlags.DontSave };
            var terrain = GolfMapTreePlanter.RoleTerrain(EditorSceneManager.GetActiveScene(), course.innerTerrainName, course.innerTerrainData, "inner");
            var origin = view.pivot;
            float z = 0;
            int missing = 0;
            foreach (var species in looks.GroupBy(e => e.species))
            {
                var shapes = biome.assets.Where(a => a.Label == species.Key && a.enabled).OrderBy(a => a.heightM).ToList();
                float step = (float)shapes.Select(a => a.crownWidthM).DefaultIfEmpty(5).Max() * 1.15f;
                var group = biome.Species(species.Key);
                foreach (var e in species)
                {
                    var look = group == null ? new GolfMapBiomeLook { id = "original", original = true } : group.looks.FirstOrDefault(l => l.id == e.look) ?? new GolfMapBiomeLook { id = "original", original = true };
                    int column = 0;
                    foreach (var shape in shapes)
                    {
                        if (look.shapes != null && !look.shapes.Contains(shape.guid)) { column++; continue; }
                        var prefab = look.original ? AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(shape.guid)) : GolfMapLooks.Prefab(course, species.Key, look, shape);
                        if (!prefab) { missing++; column++; continue; }
                        var tree = UnityEngine.Object.Instantiate(prefab, root.transform);
                        tree.name = species.Key + " · " + look.id + " · " + shape.name;   // no "/": it would read as an object path
                        var flat = origin + new Vector3(column * step, 0, z);
                        tree.transform.position = new Vector3(flat.x, terrain ? Ground(flat, terrain) : origin.y, flat.z);
                        column++;
                    }
                    z += step;
                }
            }
            FrameLab();
            return "Lab: " + root.transform.childCount + " tree(s), a row per look, shapes left to right by height." + (missing > 0 ? " " + missing + " prefab(s) missing: Regenerate the look." : "");
        }

        public static void FrameLab()
        {
            var root = LabRoot(); var view = SceneView.lastActiveSceneView;
            if (!root || !view) return;
            var renderers = root.GetComponentsInChildren<Renderer>();
            if (renderers.Length == 0) return;
            var bounds = renderers[0].bounds;
            foreach (var r in renderers) bounds.Encapsulate(r.bounds);
            // Not FrameSelected: selecting the Lab would change the Inspector.
            view.LookAt(bounds.center, view.rotation, bounds.extents.magnitude * 1.2f);
        }

        public static void ClearLab() { if (LabRoot()) UnityEngine.Object.DestroyImmediate(LabRoot()); SceneView.RepaintAll(); }
    }
}
