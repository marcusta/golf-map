using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using AwesomeTechnologies.ColliderSystem;
using AwesomeTechnologies.TerrainSystem;
using AwesomeTechnologies.VegetationStudio;
using AwesomeTechnologies.VegetationSystem;

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
    public static class GolfMapVspRig
    {
        // GSPro's shader-controller remap looks the system up by this exact name (OPCD's John
        // Meyer, from the GreenKeeper logs: a renamed system null-refs there and never renders).
        // Both our systems carry it - duplicate sibling names are legal, and nothing of ours
        // identifies a system by name: the planter goes by its storage asset and terrain bounds.
        public const string SystemObjectName = "VegetationSystemPro";

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
