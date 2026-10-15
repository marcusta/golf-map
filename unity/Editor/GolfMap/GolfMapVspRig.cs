using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using AwesomeTechnologies.ColliderSystem;
using AwesomeTechnologies.Vegetation.PersistentStorage;
using AwesomeTechnologies.TerrainSystem;
using AwesomeTechnologies.VegetationStudio;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;

namespace GolfMap.Editor
{
    // GSPro is written against the rig VSP's own "Add Vegetation Studio Pro to scene" wizard builds:
    // a VegetationStudioPro manager object with the VegetationSystemPro as its child, carrying
    // TerrainSystemPro and ColliderSystemPro next to the storage. A system created from code starts
    // bare at the scene root, and that is the one structural difference between our planted trees and
    // a hand-built course - a lookup written as GetComponentInChildren on the manager finds nothing.
    // The camera list matters as much: VSP's Reset() seeds it with Camera.main the moment the
    // component is added, GSPro destroys the course camera on load, and SetupSceneviewCamera only
    // falls back to the game camera when the list is empty, so a serialised camera leaves the system
    // bound to a dead one. The OPCD documentation tells designers to delete it by hand; we do it here.
    //
    // A course has ONE system. GSPro's course loader (parseDesc.OnLevelWasLoaded, read from its
    // Assembly-CSharp) takes a single FindObjectOfType<VegetationSystemPro>(), gives that one the
    // game camera and refreshes it; GreenKeeper loops over every system, so a second system looks
    // fine there and draws nothing in GSPro. The inner and the outer terrain, both tree catalogues
    // and the lower-vegetation package therefore share one system and one storage. What used to
    // differ per system is now set per item: the outer trees are billboards from the first metre
    // (BillboardsOnly), and runtime-spawned items stay off the outer terrain (KeepOffOuter).
    public static class GolfMapVspRig
    {
        // GSPro's shader-controller remap looks the system up by this exact name (OPCD's John
        // Meyer, from the GreenKeeper logs: a renamed system null-refs there and never renders).
        // Nothing of ours identifies a system by name: the planter goes by its storage asset and
        // the terrains it covers.
        public const string SystemObjectName = "VegetationSystemPro";

        // Mesh trees out to here past the plant distance: the inner square's diagonal, since the
        // inner trees have no billboards (independent crown width and height).
        public const float TreeMeshDistance = 3000;

        // The outer terrain lies under the inner one. Runtime-spawned items would otherwise be
        // sampled onto both surfaces.
        public const TerrainSourceID InnerSource = TerrainSourceID.TerrainSourceID1, OuterSource = TerrainSourceID.TerrainSourceID2;

        // The course's inner and outer terrain as far as the scene has them, plus the one asked for.
        public static List<Terrain> CourseTerrains(GolfMapCourse course, Terrain atLeast)
        {
            var list = new List<Terrain>();
            var scene = atLeast ? atLeast.gameObject.scene : SceneManager.GetActiveScene();
            try { list.Add(GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner")); } catch (Exception) { }
            try { list.Add(GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer")); } catch (Exception) { }
            if (atLeast && !list.Contains(atLeast)) list.Add(atLeast);
            return list.Distinct().ToList();
        }

        // The terrain squares plus VSP's 1 m margin, 50 m of height either way.
        public static Bounds BoundsOver(IList<Terrain> terrains)
        {
            var bounds = new Bounds(terrains[0].transform.position + terrains[0].terrainData.size / 2, terrains[0].terrainData.size);
            foreach (var t in terrains) { bounds.Encapsulate(t.transform.position); bounds.Encapsulate(t.transform.position + t.terrainData.size); }
            bounds.Expand(new Vector3(2, 100, 2));
            return bounds;
        }

        public static void TagTerrainSources(GolfMapCourse course, IEnumerable<Terrain> terrains)
        {
            foreach (var t in terrains)
            {
                var vsp = t.GetComponent<UnityTerrain>();
                if (!vsp) continue;
                bool outer = (!string.IsNullOrEmpty(course.outerTerrainName) && t.name == course.outerTerrainName) ||
                    (!string.IsNullOrEmpty(course.outerTerrainData) && t.terrainData && t.terrainData.name == course.outerTerrainData);
                var id = outer ? OuterSource : InnerSource;
                if (vsp.TerrainSourceID == id) continue;
                Undo.RecordObject(vsp, "Tag VSP terrain source");
                vsp.TerrainSourceID = id;
                EditorUtility.SetDirty(vsp);
            }
        }

        // An outer tree: no mesh at any distance (the mesh range is the system's tree distance times
        // this factor, and the billboards start where the meshes end) and no shadow. GSPro's VSP
        // build reads RenderDistanceFactor the same way (Update, DrawCellsIndirectComputeShader,
        // RenderBillboardCells).
        // VSP's predictive loader spawns every cell inside the tree distance with ALL its items, the
        // runtime-spawned grass included, and keeps them: each grass item allocates its whole sample
        // grid per cell before any rule is looked at. Over the inner square alone that was 441
        // cells; over the course's 2601 it ran Unity out of memory (68 GB) within a minute of the
        // first merge. Without it a cell is spawned when it comes into view, at its own distance
        // band: trees only beyond the plant distance.
        public static void NoPreload(VegetationSystemPro system)
        {
            system.LoadPotentialVegetationCells = false;
        }

        public static void BillboardsOnly(VegetationItemInfoPro item)
        {
            item.RenderDistanceFactor = 0;
            item.DisableShadows = true;
        }

        // Billboards out to `reach` metres from the camera, whatever the mesh distances are.
        public static void SetBillboardReach(VegetationSystemPro system, float reach)
        {
            var settings = system.VegetationSettings;
            settings.AdditionalBillboardDistance = Mathf.Max(0, reach - settings.GetTreeDistance());
        }

        // A runtime-spawned item (grass, bushes): never on the outer terrain.
        public static void KeepOffOuter(VegetationItemInfoPro item)
        {
            item.UseTerrainSourceExcludeRule = true;
            var rule = item.TerrainSourceExcludeRule;
            rule.UseTerrainSourceID2 = true;
            item.TerrainSourceExcludeRule = rule;
        }

        public static VegetationStudioManager EnsureManager(Scene scene)
        {
            var manager = UnityEngine.Object.FindObjectsOfType<VegetationStudioManager>()
                .FirstOrDefault(m => m.gameObject.scene == scene);
            if (manager) return manager;
            var go = new GameObject("VegetationStudioPro");
            Undo.RegisterCreatedObjectUndo(go, "Create VSP manager");
            SceneManager.MoveGameObjectToScene(go, scene);
            return go.AddComponent<VegetationStudioManager>();
        }

        // Brings one system up to the wizard's shape. Returns what it changed, empty when it already
        // matched, so both the planter and the menu command can report honestly.
        public static List<string> Standardise(VegetationSystemPro system, VegetationStudioManager manager)
        {
            var changes = new List<string>();
            var go = system.gameObject;
            if (go.name != SystemObjectName)
            {
                Undo.RecordObject(go, "Rename GolfMap VSP system");
                changes.Add("renamed from '" + go.name + "'");
                go.name = SystemObjectName;
            }
            // SetTransformParent keeps the world position; stored instances are relative to
            // VegetationSystemBounds anyway, so nothing moves either way.
            if (manager && manager.gameObject.scene == go.scene && go.transform.parent != manager.transform)
            {
                Undo.SetTransformParent(go.transform, manager.transform, "Parent GolfMap VSP system");
                changes.Add("parented under " + manager.name);
            }
            if (!go.GetComponent<TerrainSystemPro>())
            {
                Undo.AddComponent<TerrainSystemPro>(go).VegetationSystemPro = system;
                changes.Add("added TerrainSystemPro");
            }
            // BuildCourse enables the collider system before it builds the bundle, guarded by a
            // singular FindObjectOfType - with none in the scene that call silently does nothing.
            // Inert until vegetation items carry collider rules, which is a separate job.
            if (!go.GetComponent<ColliderSystemPro>())
            {
                Undo.AddComponent<ColliderSystemPro>(go).VegetationSystemPro = system;
                changes.Add("added ColliderSystemPro");
            }
            int cleared = ClearBoundCameras(system);
            if (cleared > 0) changes.Add("cleared " + cleared + " bound camera(s)");
            if (changes.Count > 0) EditorUtility.SetDirty(system);
            return changes;
        }

        // VSP validates and builds models for every item in a package when the system loads,
        // whether or not anything is planted from it. A prefab retired from the palette therefore
        // keeps logging its problems for good - "too many renderers" for the pre-VS_ poplars - and
        // takes GSPro's shader-controller remap down with it. The planter only ever adds items, so
        // drop the ones no instance in this storage still references. Never touches an item that is
        // planted, and never touches a package that is not ours. The pruned items' baked billboard
        // textures are left on disk; they are small and may be shared.
        public static int PruneCatalogues(VegetationSystemPro system)
        {
            var storage = system.PersistentVegetationStorage;
            if (!storage || !storage.PersistentVegetationStoragePackage) return 0;
            var planted = new HashSet<string>(storage.PersistentVegetationStoragePackage.PersistentVegetationCellList
                .SelectMany(c => c.PersistentVegetationInfoList)
                .Where(i => i.VegetationItemList.Count > 0)
                .Select(i => i.VegetationItemID));
            int removed = 0;
            foreach (var catalog in system.VegetationPackageProList.Where(GolfMapTreePlanter.IsImportedCatalogue).ToArray())
            {
                var stale = catalog.VegetationInfoList.Where(i => !planted.Contains(i.VegetationItemID)).ToArray();
                if (stale.Length == 0) continue;
                Undo.RegisterCompleteObjectUndo(catalog, "Prune GolfMap catalogue");
                foreach (var item in stale) catalog.VegetationInfoList.Remove(item);
                EditorUtility.SetDirty(catalog);
                removed += stale.Length;
            }
            if (removed > 0) system.RefreshVegetationSystem();
            return removed;
        }

        static int ClearBoundCameras(VegetationSystemPro system)
        {
            var cameras = system.VegetationStudioCameraList
                .Where(c => c != null && c.VegetationStudioCameraType == VegetationStudioCameraType.Normal && c.SelectedCamera)
                .Select(c => c.SelectedCamera).Distinct().ToArray();
            // RemoveCamera disposes the camera's culling groups; dropping the entry by hand leaks them.
            foreach (var camera in cameras) system.RemoveCamera(camera);
            return cameras.Length;
        }

        // ---- merge ----------------------------------------------------------------------------

        [MenuItem("GolfMap/Merge vegetation systems for GSPro")]
        public static void MergeMenu()
        {
            var result = Merge(false);
            Debug.Log("[GolfMap] " + result["status"]);
        }

        [BridgeCommand("golfmap.vsp.merge", "Merge the scene's GolfMap vegetation systems into one (GSPro gives its camera to a single VegetationSystemPro): the system that covers every course terrain takes the other systems' terrains, packages and stored instances (same positions, scales, rotations, sources), the inner system's vegetation settings, and the per-item rules that replace the per-system ones (outer trees billboards only, runtime-spawned items off the outer terrain). The emptied systems' scene objects are deleted (Undo restores them; their storage assets stay on disk, and every storage is backed up to GolfMapSpelunk/PlantingBackups first). Safe to re-run: with one system it only re-applies the rules. Does not save the scene.",
            args = "dryRun=false, clean=false (no merge: only remove, from each system's storage, the instances of items none of its packages has - what a merge that never reached a saved scene leaves behind)")]
        static object MergeCommand(BridgeArgs a) { return a.Bool("clean", false) ? Clean(a.Bool("dryRun", false)) : Merge(a.Bool("dryRun", false)); }

        static Dictionary<string, object> Clean(bool dryRun)
        {
            var scene = SceneManager.GetActiveScene();
            var report = new List<object>();
            foreach (var system in UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>()
                .Where(s => s.gameObject.scene == scene && GolfMapTreePlanter.IsGolfMapStorage(s.PersistentVegetationStorage)))
            {
                var package = system.PersistentVegetationStorage.PersistentVegetationStoragePackage;
                var known = new HashSet<string>(system.VegetationPackageProList.Where(p => p).SelectMany(p => p.VegetationInfoList).Select(i => i.VegetationItemID));
                var stray = package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList)
                    .Where(i => !known.Contains(i.VegetationItemID) && i.VegetationItemList.Count > 0).ToList();
                long count = stray.Sum(i => (long)i.VegetationItemList.Count), before = Instances(package);
                string backup = null;
                if (!dryRun && count > 0)
                {
                    Directory.CreateDirectory("GolfMapSpelunk/PlantingBackups");
                    backup = "GolfMapSpelunk/PlantingBackups/" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-clean-" + Path.GetFileNameWithoutExtension(AssetDatabase.GetAssetPath(package)) + ".json";
                    File.WriteAllText(backup, EditorJsonUtility.ToJson(package));
                    File.WriteAllText(backup + ".target", AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(package)));
                    Undo.RegisterCompleteObjectUndo(package, "Clean GolfMap vegetation storage");
                    foreach (var id in stray.Select(i => i.VegetationItemID).Distinct().ToArray()) package.RemoveVegetationItemInstances(id);
                    EditorUtility.SetDirty(package);
                    system.ClearCache();
                }
                report.Add(new Dictionary<string, object>
                {
                    { "storage", AssetDatabase.GetAssetPath(package) }, { "before", before }, { "strayInstances", count },
                    { "strayItems", stray.Select(i => i.VegetationItemID).Distinct().Count() }, { "after", Instances(package) }, { "backup", backup },
                });
            }
            if (!dryRun) AssetDatabase.SaveAssets();
            return new Dictionary<string, object> { { "dryRun", dryRun }, { "storages", report } };
        }

        static long Instances(PersistentVegetationStoragePackage package)
        {
            return package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList).Sum(i => (long)i.VegetationItemList.Count);
        }

        public static Dictionary<string, object> Merge(bool dryRun)
        {
            var scene = SceneManager.GetActiveScene();
            var course = GolfMapCourses.Require();
            var systems = UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>()
                .Where(s => s.gameObject.scene == scene && GolfMapTreePlanter.IsGolfMapStorage(s.PersistentVegetationStorage)).ToList();
            if (systems.Count == 0) throw new InvalidOperationException("No GolfMap vegetation system in " + scene.name + ".");
            var terrains = CourseTerrains(course, null);
            if (terrains.Count == 0) throw new InvalidOperationException("The course's terrains are not in " + scene.name + ".");
            var cover = BoundsOver(terrains);
            var target = systems.OrderByDescending(s => s.VegetationSystemBounds.size.x * s.VegetationSystemBounds.size.z).First();
            var tb = target.VegetationSystemBounds;
            if (tb.min.x > cover.min.x + 2 || tb.min.z > cover.min.z + 2 || tb.max.x < cover.max.x - 2 || tb.max.z < cover.max.z - 2)
                throw new InvalidOperationException("No system covers every course terrain (largest: " + tb + ", needed: " + cover + "). Plant the outer area first, then merge.");
            var sources = systems.Where(s => s != target).ToList();
            foreach (var s in sources)
            {
                var extra = s.GetComponents<Component>().Where(c => !(c is Transform || c is VegetationSystemPro || c is PersistentVegetationStorage || c is TerrainSystemPro || c is ColliderSystemPro)).ToArray();
                if (extra.Length > 0) throw new InvalidOperationException("A system to merge carries " + string.Join(", ", extra.Select(c => c.GetType().Name).ToArray()) + ". Move those off it first.");
                if (Mathf.Abs(s.VegetationCellSize - target.VegetationCellSize) > 0.01f) throw new InvalidOperationException("The systems use different cell sizes.");
            }
            var targetStorage = target.PersistentVegetationStorage;
            var targetPackage = targetStorage.PersistentVegetationStoragePackage;
            var plan = sources.Select(s => (object)new Dictionary<string, object>
            {
                { "storage", AssetDatabase.GetAssetPath(s.PersistentVegetationStorage.PersistentVegetationStoragePackage) },
                { "terrains", s.VegetationStudioTerrainObjectList.Where(t => t).Select(t => (object)t.name).ToList() },
                { "packages", s.VegetationPackageProList.Where(p => p).Select(p => (object)p.PackageName).ToList() },
                { "instances", Instances(s.PersistentVegetationStorage.PersistentVegetationStoragePackage) },
            }).ToList();
            var result = new Dictionary<string, object>
            {
                { "into", AssetDatabase.GetAssetPath(targetPackage) }, { "intoInstances", Instances(targetPackage) }, { "merge", plan }, { "dryRun", dryRun },
            };
            if (dryRun) { result["status"] = sources.Count + " system(s) would be merged into " + AssetDatabase.GetAssetPath(targetPackage) + "."; return result; }

            var manager = EnsureManager(scene);
            Directory.CreateDirectory("GolfMapSpelunk/PlantingBackups");
            string stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");
            var backups = new List<object>();
            foreach (var s in systems)
            {
                var package = s.PersistentVegetationStorage.PersistentVegetationStoragePackage;
                string file = "GolfMapSpelunk/PlantingBackups/" + stamp + "-merge-" + Path.GetFileNameWithoutExtension(AssetDatabase.GetAssetPath(package)) + ".json";
                File.WriteAllText(file, EditorJsonUtility.ToJson(package));
                File.WriteAllText(file + ".target", AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(package)));
                backups.Add(file);
            }
            result["backups"] = backups;

            Undo.RegisterCompleteObjectUndo(targetPackage, "Merge GolfMap vegetation systems");
            Undo.RecordObject(target, "Merge GolfMap vegetation systems");
            NoPreload(target);   // before the terrains and packages go in: the loader starts at once
            long before = Instances(targetPackage), moved = 0; int nudged = 0;
            // The settings that matter are the inner system's: plant distance, densities, shadows.
            var settingsFrom = sources.FirstOrDefault(s => s.VegetationPackageProList.Any(p => p && !GolfMapTreePlanter.IsImportedCatalogue(p))) ?? sources.FirstOrDefault();
            if (settingsFrom)
            {
                float reach = target.VegetationSettings.GetBillboardDistance();
                JsonUtility.FromJsonOverwrite(JsonUtility.ToJson(settingsFrom.VegetationSettings), target.VegetationSettings);
                target.VegetationSettings.AdditionalTreeMeshDistance = TreeMeshDistance;
                SetBillboardReach(target, reach);
                target.SeaLevel = settingsFrom.SeaLevel;
                target.ExcludeSeaLevelCells = settingsFrom.ExcludeSeaLevelCells;
                if (!target.SunDirectionalLight) target.SunDirectionalLight = settingsFrom.SunDirectionalLight;
                if (!target.SelectedWindZone) target.SelectedWindZone = settingsFrom.SelectedWindZone;
            }
            foreach (var s in sources)
            {
                foreach (var go in s.VegetationStudioTerrainObjectList.Where(t => t).ToArray())
                    if (!target.VegetationStudioTerrainObjectList.Contains(go)) target.AddTerrain(go);
                foreach (var p in s.VegetationPackageProList.Where(p => p).ToArray()) target.AddVegetationPackage(p);
            }
            TagTerrainSources(course, terrains);
            NoPreload(target);
            target.RefreshVegetationSystem();
            if (!targetStorage.HasValidPersistentStorage(target.VegetationCellList.Count))
                throw new InvalidOperationException("The storage layout no longer matches the system after adding the terrains. Nothing was copied; Undo restores the scene.");
            foreach (var s in sources)
            {
                var package = s.PersistentVegetationStorage.PersistentVegetationStoragePackage;
                var origin = s.VegetationSystemPosition;
                // A merge that did not get as far as a saved scene (the assets are saved, the scene is
                // not) leaves this system's instances in the target already: copy them once only.
                foreach (var id in package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList).Select(i => i.VegetationItemID).Distinct().ToArray())
                    targetPackage.RemoveVegetationItemInstances(id);
                before = Instances(targetPackage) - moved;
                foreach (var cell in package.PersistentVegetationCellList)
                    foreach (var info in cell.PersistentVegetationInfoList)
                        foreach (var item in info.VegetationItemList)
                        {
                            var world = item.Position + origin;
                            if (GolfMapTreePlanter.ResolveCell(target, ref world)) nudged++;
                            targetStorage.AddVegetationItemInstance(info.VegetationItemID, world, item.Scale, item.Rotation, false, item.VegetationSourceID, item.DistanceFalloff, false);
                            moved++;
                        }
            }
            if (Instances(targetPackage) != before + moved)
                throw new InvalidOperationException("Copied " + moved + " instances but the storage grew by " + (Instances(targetPackage) - before) + ". Restore " + AssetDatabase.GetAssetPath(targetPackage) + " from its backup.");

            int billboardItems = 0, spawnItems = 0;
            foreach (var package in target.VegetationPackageProList.Where(p => p))
            {
                Undo.RegisterCompleteObjectUndo(package, "Merge GolfMap vegetation systems");
                foreach (var item in package.VegetationInfoList)
                {
                    if (package.PackageName == "GolfMap imported trees (billboards)") { BillboardsOnly(item); billboardItems++; }
                    else if (!GolfMapTreePlanter.IsImportedCatalogue(package)) { KeepOffOuter(item); spawnItems++; }
                }
                EditorUtility.SetDirty(package);
            }
            foreach (var trees in UnityEngine.Object.FindObjectsOfType<GolfMapTrees>().Where(t => t.gameObject.scene == scene))
                if (trees.storage != targetStorage) { Undo.RecordObject(trees, "Merge GolfMap vegetation systems"); trees.storage = targetStorage; EditorUtility.SetDirty(trees); }
            foreach (var s in sources) Undo.DestroyObjectImmediate(s.gameObject);
            GolfMapVegPerf.labels.Clear();
            Standardise(target, manager);
            target.RefreshVegetationSystem();
            target.ClearCache();
            EditorUtility.SetDirty(targetPackage); EditorUtility.SetDirty(target); EditorUtility.SetDirty(targetStorage);
            EditorSceneManager.MarkSceneDirty(scene);
            AssetDatabase.SaveAssets();
            result["moved"] = moved; result["nudged"] = nudged; result["instances"] = Instances(targetPackage);
            result["billboardOnlyItems"] = billboardItems; result["offOuterItems"] = spawnItems;
            result["settings"] = "plant " + target.VegetationSettings.PlantDistance + " m, tree meshes +" + target.VegetationSettings.AdditionalTreeMeshDistance + " m, billboards +" + target.VegetationSettings.AdditionalBillboardDistance + " m";
            result["status"] = sources.Count == 0
                ? "One vegetation system already; re-applied the per-item rules (" + billboardItems + " billboard-only, " + spawnItems + " off the outer terrain)."
                : "Merged " + sources.Count + " system(s), " + moved + " instances, into " + AssetDatabase.GetAssetPath(targetPackage) + ". Save the scene, then rebuild the course.";
            return result;
        }

        // ---- trees on/off ---------------------------------------------------------------------

        [BridgeCommand("golfmap.vsp.trees", "Switch the planted trees of the scene's GolfMap vegetation systems off or on, saved with the scene and so built into the course (for a course whose trees come from Arborist instead): a system that holds nothing but tree catalogues has its scene object deactivated, a system that also holds other packages (the lower vegetation) keeps running with its persistent storage disabled. Nothing is deleted; on=true puts both back. on=true with keep=[parts of prefab names] is the hybrid: in the catalogue beside the lower vegetation only the matching trees are drawn, the others are hidden item by item (no mesh, billboard, shadow or collider; their settings are kept in <catalogue asset>.hidden.json), and a trees-only system (the background) stays off; on=true without keep shows everything again. preload=false also stops VSP preloading every cell inside the tree distance (the runtime-spawned grass of all of them is kept in memory; see GolfMapVspRig.NoPreload), preload=true restores VSP's default. Without arguments: reports the state. Does not save the scene.",
            args = "on (true|false; omit to only report), keep (list of prefab name parts: with on=true, the only trees drawn), preload (true|false; omit to leave as is)")]
        static object TreesCommand(BridgeArgs a)
        {
            var scene = SceneManager.GetActiveScene();
            var report = new List<object>();
            // Inactive systems included: a switched-off one must be found to switch it back on.
            foreach (var system in Resources.FindObjectsOfTypeAll<VegetationSystemPro>()
                .Where(s => s && s.gameObject.scene == scene && !EditorUtility.IsPersistent(s) && GolfMapTreePlanter.IsGolfMapStorage(s.PersistentVegetationStorage)))
            {
                var storage = system.PersistentVegetationStorage;
                var packages = system.VegetationPackageProList.Where(p => p).ToList();
                bool treesOnly = packages.Count > 0 && packages.All(GolfMapTreePlanter.IsImportedCatalogue);
                var treeIds = new HashSet<string>(packages.Where(GolfMapTreePlanter.IsImportedCatalogue).SelectMany(p => p.VegetationInfoList).Select(i => i.VegetationItemID));
                long otherStored = storage.PersistentVegetationStoragePackage.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList)
                    .Where(i => !treeIds.Contains(i.VegetationItemID)).Sum(i => (long)i.VegetationItemList.Count);
                var hidden = new List<object>();
                if (a.Has("on"))
                {
                    bool on = a.Bool("on", true);
                    string[] keep = a.Has("keep") ? a.Strings("keep") : null;
                    if (treesOnly)
                    {
                        // With keep, the background trees stay Arborist's (billboard-only copies).
                        bool active = on && keep == null;
                        if (system.gameObject.activeSelf != active) { Undo.RecordObject(system.gameObject, "Switch GolfMap trees"); system.gameObject.SetActive(active); }
                    }
                    else
                    {
                        bool changed = storage.DisablePersistentStorage == on;
                        if (changed)
                        {
                            Undo.RecordObject(storage, "Switch GolfMap trees");
                            storage.DisablePersistentStorage = !on;
                            EditorUtility.SetDirty(storage);
                        }
                        if (on) foreach (var catalog in packages.Where(GolfMapTreePlanter.IsImportedCatalogue)) changed |= ShowOnly(catalog, keep);
                        if (changed && system.isActiveAndEnabled) { system.RefreshVegetationSystem(); system.ClearCache(); }
                    }
                }
                foreach (var catalog in packages.Where(GolfMapTreePlanter.IsImportedCatalogue))
                {
                    var saved = HiddenItems(catalog);
                    hidden.AddRange(catalog.VegetationInfoList.Where(i => saved.ContainsKey(i.VegetationItemID)).Select(i => (object)ItemName(i)));
                }
                if (a.Has("preload"))
                {
                    bool preload = a.Bool("preload", true);
                    if (system.LoadPotentialVegetationCells != preload)
                    {
                        Undo.RecordObject(system, "Set GolfMap VSP preloading");
                        system.LoadPotentialVegetationCells = preload;
                        EditorUtility.SetDirty(system);
                        if (system.isActiveAndEnabled) system.ClearCache();
                    }
                }
                report.Add(new Dictionary<string, object>
                {
                    { "storage", AssetDatabase.GetAssetPath(storage.PersistentVegetationStoragePackage) },
                    { "terrains", system.VegetationStudioTerrainObjectList.Where(t => t).Select(t => (object)t.name).ToList() },
                    { "packages", packages.Select(p => (object)p.PackageName).ToList() },
                    { "treesOnly", treesOnly }, { "systemActive", system.gameObject.activeInHierarchy }, { "storageOn", !storage.DisablePersistentStorage },
                    { "treesDrawn", system.gameObject.activeInHierarchy && !storage.DisablePersistentStorage },
                    { "storedNonTreeInstances", otherStored }, { "preload", system.LoadPotentialVegetationCells }, { "hiddenItems", hidden },
                });
            }
            if (a.Has("on") || a.Has("preload")) { EditorSceneManager.MarkSceneDirty(scene); GolfMapVegPerf.labels.Clear(); }
            return report;
        }

        // ---- trim: trees Arborist draws leave the course's storage ------------------------------

        static string TrimFile(PersistentVegetationStoragePackage package) { return AssetDatabase.GetAssetPath(package) + ".trimmed.json"; }

        [BridgeCommand("golfmap.vsp.trees.trim", "Hybrid course: take out of the course's own tree storage (the system that also holds the lower vegetation) the trees Arborist draws instead, so VSP neither draws nor culls them: every instance of an item golfmap.vsp.trees keep= has hidden, and of the kept items the trees at the positions in `file` (pipeline/arborist.py trees --surfaces writes it: the scenery trees that became Arborist billboards). What is removed is written beside the storage asset (<asset>.trimmed.json), each tree once, and restore=true puts every one of them back where its item does not already stand (to the centimetre) and drops a catalogue tree stored twice, so restore can be run any number of times (compare storedNow with the full count). Without arguments: reports. Saves the storage asset; mark: the scene must be saved and built for GSPro to see it.",
            args = "file (golfmap-vsp-far-v1 JSON, absolute path), hidden=true (also the hidden items' trees), restore=true, dryRun=false")]
        static object TrimCommand(BridgeArgs a)
        {
            var scene = SceneManager.GetActiveScene();
            var report = new List<object>();
            foreach (var system in Resources.FindObjectsOfTypeAll<VegetationSystemPro>()
                .Where(s => s && s.gameObject.scene == scene && !EditorUtility.IsPersistent(s) && GolfMapTreePlanter.IsGolfMapStorage(s.PersistentVegetationStorage)))
            {
                var packages = system.VegetationPackageProList.Where(p => p).ToList();
                if (packages.All(GolfMapTreePlanter.IsImportedCatalogue)) continue;   // a trees-only (background) system is switched off whole
                var storagePackage = system.PersistentVegetationStorage.PersistentVegetationStoragePackage;
                string file = TrimFile(storagePackage);
                int fileDoubles;
                var saved = TrimRows(file, out fileDoubles);
                var origin = system.VegetationSystemPosition;
                var cells = storagePackage.PersistentVegetationCellList;
                long storedBefore = cells.SelectMany(c => c.PersistentVegetationInfoList).Sum(i => (long)i.VegetationItemList.Count);
                int removed = 0, restored = 0, alreadyStored = 0, duplicatesRemoved = 0, farGiven = 0;
                var byItem = new Dictionary<string, int>();
                var names = new Dictionary<string, string>();   // the catalogues' tree items, id to prefab name
                var hiddenIds = new HashSet<string>();
                foreach (var catalog in packages.Where(GolfMapTreePlanter.IsImportedCatalogue))
                {
                    var hiddenNow = HiddenItems(catalog);
                    foreach (var item in catalog.VegetationInfoList)
                    {
                        names[item.VegetationItemID] = ItemName(item);
                        if (a.Bool("hidden", true) && hiddenNow.ContainsKey(item.VegetationItemID)) hiddenIds.Add(item.VegetationItemID);
                    }
                }
                bool dry = a.Bool("dryRun", false), restoring = a.Bool("restore", false);
                if (restoring)
                {
                    // Idempotent: a tree goes back only where its item does not already stand (to the centimetre,
                    // as Listed), and a tree stored twice loses its second copy. Rows that outlived a restore (the
                    // delete below could fail silently), or a full storage put back under a trimmed one, were all
                    // added again: 47 789 stored instead of 25 154 on 2026-10-13.
                    if (!dry) Undo.RegisterCompleteObjectUndo(storagePackage, "Restore trimmed GolfMap trees");
                    var standing = new Dictionary<string, HashSet<long>>();
                    foreach (var cell in cells)
                        foreach (var info in cell.PersistentVegetationInfoList)
                        {
                            if (!names.ContainsKey(info.VegetationItemID)) continue;   // not a tree of the catalogue
                            var list = info.VegetationItemList;
                            for (int i = 0; i < list.Count; i++)
                            {
                                if (!Stands(standing, info.VegetationItemID, list[i].Position)) { Mark(standing, info.VegetationItemID, list[i].Position); continue; }
                                duplicatesRemoved++;
                                if (!dry) list.RemoveAt(i--);
                            }
                        }
                    foreach (Dictionary<string, object> row in saved)
                    {
                        string id = (string)row["item"];
                        var t = TrimmedItem(row);
                        if (Stands(standing, id, t.Position)) { alreadyStored++; continue; }
                        Mark(standing, id, t.Position);
                        restored++;
                        if (dry) continue;
                        var cell = cells[Convert.ToInt32(row["cell"])];
                        var info = cell.PersistentVegetationInfoList.FirstOrDefault(i => i.VegetationItemID == id);
                        if (info == null) { info = new PersistentVegetationInfo { VegetationItemID = id }; cell.PersistentVegetationInfoList.Add(info); }
                        info.VegetationItemList.Add(t);
                    }
                    if (!dry) saved.Clear();
                }
                else if (a.Has("file") || a.Has("hidden"))
                {
                    var far = new HashSet<long>();
                    if (a.Has("file"))
                    {
                        var doc = BridgeJson.Parse(File.ReadAllText(a.String("file"))) as Dictionary<string, object>;
                        if (doc == null || (doc["format"] as string) != "golfmap-vsp-far-v1") throw new BridgeError(a.String("file") + " is not golfmap-vsp-far-v1.");
                        foreach (List<object> xz in (List<object>)doc["positions"]) far.Add(Key(Convert.ToDouble(xz[0], System.Globalization.CultureInfo.InvariantCulture), Convert.ToDouble(xz[1], System.Globalization.CultureInfo.InvariantCulture)));
                        farGiven = far.Count;
                    }
                    // A tree already on file (trimmed before, then back in the storage by a replant or a storage
                    // backup) is taken out again but written once.
                    var onFile = new Dictionary<string, HashSet<long>>();
                    foreach (Dictionary<string, object> row in saved) Mark(onFile, (string)row["item"], TrimmedItem(row).Position);
                    if (!dry) Undo.RegisterCompleteObjectUndo(storagePackage, "Trim GolfMap trees");
                    for (int c = 0; c < cells.Count; c++)
                        foreach (var info in cells[c].PersistentVegetationInfoList)
                        {
                            if (!names.ContainsKey(info.VegetationItemID)) continue;   // not a tree of the catalogue
                            bool all = hiddenIds.Contains(info.VegetationItemID);
                            var list = info.VegetationItemList;
                            for (int i = list.Count - 1; i >= 0; i--)
                            {
                                var t = list[i];
                                if (!all && !Listed(far, t.Position.x + origin.x, t.Position.z + origin.z)) continue;
                                removed++;
                                int n; byItem.TryGetValue(names[info.VegetationItemID], out n); byItem[names[info.VegetationItemID]] = n + 1;
                                if (dry) continue;
                                if (!Stands(onFile, info.VegetationItemID, t.Position))
                                {
                                    Mark(onFile, info.VegetationItemID, t.Position);
                                    saved.Add(new Dictionary<string, object>
                                    {
                                        { "cell", c }, { "item", info.VegetationItemID }, { "source", (int)t.VegetationSourceID },
                                        { "v", new List<object> { t.Position.x, t.Position.y, t.Position.z, t.Scale.x, t.Scale.y, t.Scale.z, t.Rotation.x, t.Rotation.y, t.Rotation.z, t.Rotation.w, t.DistanceFalloff } },
                                    });
                                }
                                list.RemoveAt(i);
                            }
                        }
                }
                if (!dry && (removed > 0 || restoring))
                {
                    // AssetDatabase.DeleteAsset does nothing (returns false) for a file the editor has not imported
                    // yet, and a file written by a trim is not imported until the next refresh.
                    if (saved.Count > 0) File.WriteAllText(file, BridgeJson.Write(saved));
                    else if (File.Exists(file) && !AssetDatabase.DeleteAsset(file)) { File.Delete(file); if (File.Exists(file + ".meta")) File.Delete(file + ".meta"); }
                }
                if (!dry && removed + restored + duplicatesRemoved > 0)
                {
                    EditorUtility.SetDirty(storagePackage);
                    AssetDatabase.SaveAssets();
                    if (system.isActiveAndEnabled) system.ClearCache();
                    EditorSceneManager.MarkSceneDirty(scene);
                }
                report.Add(new Dictionary<string, object>
                {
                    { "storage", AssetDatabase.GetAssetPath(storagePackage) }, { "removed", removed }, { "restored", restored }, { "farPositionsGiven", farGiven },
                    { "alreadyStored", alreadyStored }, { "duplicatesRemoved", duplicatesRemoved }, { "fileDoubles", fileDoubles },
                    { "removedByItem", byItem.ToDictionary(k => k.Key, k => (object)k.Value) }, { "trimmedOnFile", saved.Count },
                    { "storedBefore", storedBefore }, { "storedNow", cells.SelectMany(c => c.PersistentVegetationInfoList).Sum(i => (long)i.VegetationItemList.Count) },
                });
            }
            return report;
        }

        static PersistentVegetationItem TrimmedItem(Dictionary<string, object> row)
        {
            var v = ((List<object>)row["v"]).Select(n => Convert.ToSingle(n, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            return new PersistentVegetationItem
            {
                Position = new Vector3(v[0], v[1], v[2]), Scale = new Vector3(v[3], v[4], v[5]), Rotation = new Quaternion(v[6], v[7], v[8], v[9]),
                VegetationSourceID = (byte)Convert.ToInt32(row["source"]), DistanceFalloff = v[10],
            };
        }

        // The trees golfmap.vsp.trees.trim took out of a storage, by item id: still planted trees of
        // the course (Arborist draws them), so golfmap.trees.dump writes them with the stored ones.
        // Each once, and none that stands in the storage again.
        internal static Dictionary<string, List<PersistentVegetationItem>> Trimmed(PersistentVegetationStoragePackage package)
        {
            var byItem = new Dictionary<string, List<PersistentVegetationItem>>();
            int doubles;
            var rows = TrimRows(TrimFile(package), out doubles);
            if (rows.Count == 0) return byItem;
            var ids = new HashSet<string>(rows.Select(r => (string)((Dictionary<string, object>)r)["item"]));
            var standing = new Dictionary<string, HashSet<long>>();
            foreach (var info in package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList).Where(i => ids.Contains(i.VegetationItemID)))
                foreach (var t in info.VegetationItemList) Mark(standing, info.VegetationItemID, t.Position);
            foreach (Dictionary<string, object> row in rows)
            {
                string id = (string)row["item"];
                var t = TrimmedItem(row);
                if (Stands(standing, id, t.Position)) continue;
                List<PersistentVegetationItem> list;
                if (!byItem.TryGetValue(id, out list)) byItem[id] = list = new List<PersistentVegetationItem>();
                list.Add(t);
            }
            return byItem;
        }

        // The trim file's rows, a tree written twice (same item, same centimetre) once: `doubles` counts the rest.
        static List<object> TrimRows(string file, out int doubles)
        {
            doubles = 0;
            var rows = File.Exists(file) ? (BridgeJson.Parse(File.ReadAllText(file)) as List<object> ?? new List<object>()) : new List<object>();
            var seen = new Dictionary<string, HashSet<long>>();
            var once = new List<object>(rows.Count);
            foreach (Dictionary<string, object> row in rows)
            {
                string id = (string)row["item"];
                var p = TrimmedItem(row).Position;
                if (Stands(seen, id, p)) { doubles++; continue; }
                Mark(seen, id, p);
                once.Add(row);
            }
            return once;
        }

        // Where the trees of each item stand, by item id: storage positions (x, z) to the centimetre.
        static bool Stands(Dictionary<string, HashSet<long>> at, string id, Vector3 p)
        {
            HashSet<long> keys;
            return at.TryGetValue(id, out keys) && Listed(keys, p.x, p.z);
        }

        static void Mark(Dictionary<string, HashSet<long>> at, string id, Vector3 p)
        {
            HashSet<long> keys;
            if (!at.TryGetValue(id, out keys)) at[id] = keys = new HashSet<long>();
            keys.Add(Key(p.x, p.z));
        }

        // Positions are matched to the centimetre (the file rounds to the millimetre).
        static long Key(double x, double z) { return (long)Math.Round(x * 100) * 10000000L + (long)Math.Round(z * 100); }

        // A stored position is a float and the file's a decimal: a coordinate on a half centimetre rounds either
        // way (seen 2026-10-13: 2 of 6 451 trees stayed), so the neighbouring centimetres count too. Trees never stand
        // that close to each other.
        static bool Listed(HashSet<long> far, double x, double z)
        {
            if (far.Count == 0) return false;
            for (int dx = -1; dx <= 1; dx++)
                for (int dz = -1; dz <= 1; dz++)
                    if (far.Contains(Key(x + dx * 0.01, z + dz * 0.01))) return true;
            return false;
        }

        static string ItemName(VegetationItemInfoPro item) { return item.VegetationPrefab ? item.VegetationPrefab.name : item.Name; }

        // What a hidden item's settings were, by item id, in a file beside the catalogue asset.
        static string HiddenFile(VegetationPackagePro catalog) { return AssetDatabase.GetAssetPath(catalog) + ".hidden.json"; }

        static Dictionary<string, object> HiddenItems(VegetationPackagePro catalog)
        {
            string file = HiddenFile(catalog);
            return File.Exists(file) ? BridgeJson.Parse(File.ReadAllText(file)) as Dictionary<string, object> ?? new Dictionary<string, object>() : new Dictionary<string, object>();
        }

        // Hybrid course: only the catalogue's items whose prefab name contains one of `keep` are
        // drawn (the species Arborist has no good model for); the others come from Arborist and are
        // hidden here: no mesh (render distance factor 0), no billboard, no shadow, no collider.
        // Their stored instances are untouched and their settings kept in HiddenFile, so keep = null
        // (or a longer list) brings them back as they were.
        static bool ShowOnly(VegetationPackagePro catalog, string[] keep)
        {
            var saved = HiddenItems(catalog);
            bool changed = false;
            foreach (var item in catalog.VegetationInfoList)
            {
                string name = ItemName(item), id = item.VegetationItemID;
                bool hide = keep != null && !keep.Any(k => name.IndexOf(k, StringComparison.OrdinalIgnoreCase) >= 0);
                if (hide && !saved.ContainsKey(id))
                {
                    if (!changed) Undo.RegisterCompleteObjectUndo(catalog, "Show only some GolfMap trees");
                    saved[id] = new Dictionary<string, object>
                    {
                        { "name", name }, { "renderDistanceFactor", item.RenderDistanceFactor }, { "useBillboards", item.UseBillboards },
                        { "disableShadows", item.DisableShadows }, { "colliderType", item.ColliderType.ToString() },
                    };
                    item.RenderDistanceFactor = 0; item.UseBillboards = false; item.DisableShadows = true; item.ColliderType = ColliderType.Disabled;
                    changed = true;
                }
                else if (!hide && saved.ContainsKey(id))
                {
                    if (!changed) Undo.RegisterCompleteObjectUndo(catalog, "Show only some GolfMap trees");
                    var was = (Dictionary<string, object>)saved[id];
                    item.RenderDistanceFactor = Convert.ToSingle(was["renderDistanceFactor"], System.Globalization.CultureInfo.InvariantCulture);
                    item.UseBillboards = Convert.ToBoolean(was["useBillboards"]);
                    item.DisableShadows = Convert.ToBoolean(was["disableShadows"]);
                    item.ColliderType = (ColliderType)Enum.Parse(typeof(ColliderType), (string)was["colliderType"]);
                    saved.Remove(id);
                    changed = true;
                }
            }
            if (!changed) return false;
            EditorUtility.SetDirty(catalog);
            string file = HiddenFile(catalog);
            if (saved.Count > 0) File.WriteAllText(file, BridgeJson.Write(saved));
            else AssetDatabase.DeleteAsset(file);
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            return true;
        }

        [BridgeCommand("golfmap.vsp.plants", "Stop (on=false) the runtime spawning of the prefab items - bushes, woodland floor: every Plant-type item - in the scene's non-tree packages, for a course whose bushes come from Arborist (pipeline/arborist.py lower) while the texture grass stays in VSP. The items and their mask rules are kept. There is no on=true: golfmap.grass.apply sets every item's spawning from the palette again. Without arguments: reports. Saves the package assets.",
            args = "on (false; omit to only report)")]
        static object PlantsCommand(BridgeArgs a)
        {
            var scene = SceneManager.GetActiveScene();
            var report = new List<object>();
            foreach (var system in Resources.FindObjectsOfTypeAll<VegetationSystemPro>().Where(s => s && s.gameObject.scene == scene && !EditorUtility.IsPersistent(s)))
                foreach (var package in system.VegetationPackageProList.Where(p => p && !GolfMapTreePlanter.IsImportedCatalogue(p)))
                {
                    var plants = package.VegetationInfoList.Where(i => i.VegetationType == VegetationType.Plant).ToList();
                    int spawning = plants.Count(i => i.EnableRuntimeSpawn), stopped = 0;
                    if (a.Has("on"))
                    {
                        if (a.Bool("on", true)) throw new BridgeError("Run golfmap.grass.apply to put the palette's spawning back.");
                        Undo.RegisterCompleteObjectUndo(package, "Stop GolfMap plant spawning");
                        foreach (var item in plants.Where(i => i.EnableRuntimeSpawn)) { item.EnableRuntimeSpawn = false; stopped++; }
                        EditorUtility.SetDirty(package);
                        if (stopped > 0 && system.isActiveAndEnabled) { system.RefreshVegetationSystem(); system.ClearCache(); }
                    }
                    report.Add(new Dictionary<string, object>
                    {
                        { "package", package.PackageName }, { "asset", AssetDatabase.GetAssetPath(package) }, { "plantItems", plants.Count },
                        { "spawningBefore", spawning }, { "stopped", stopped }, { "grassItemsSpawning", package.VegetationInfoList.Count(i => i.VegetationType == VegetationType.Grass && i.EnableRuntimeSpawn) },
                    });
                }
            if (a.Has("on")) AssetDatabase.SaveAssets();
            return report;
        }

        // For scenes planted before the planter built the rig itself. Safe to re-run.
        [MenuItem("GolfMap/Fix vegetation systems for GSPro")]
        public static void FixScene()
        {
            var scene = SceneManager.GetActiveScene();
            var systems = UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>()
                .Where(s => s.gameObject.scene == scene).ToArray();
            if (systems.Length == 0) throw new InvalidOperationException("No vegetation system in " + scene.name + ".");
            var manager = EnsureManager(scene);
            var report = new List<string>();
            foreach (var system in systems)
            {
                string was = system.name;
                var changes = Standardise(system, manager);
                int pruned = PruneCatalogues(system);
                if (pruned > 0) changes.Add("pruned " + pruned + " unplanted catalogue item(s)");
                if (changes.Count > 0) report.Add(was + ": " + string.Join(", ", changes.ToArray()));
            }
            if (report.Count == 0)
            {
                Debug.Log("[GolfMap] All " + systems.Length + " vegetation system(s) in " + scene.name
                    + " already match the GSPro rig. Nothing changed.");
                return;
            }
            EditorSceneManager.MarkSceneDirty(scene);
            AssetDatabase.SaveAssets();
            Debug.Log("[GolfMap] " + string.Join("; ", report.ToArray())
                + ". Save the scene, then rebuild the course with GSP > Build Course.");
        }
    }
}
