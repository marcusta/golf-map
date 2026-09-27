// Unity 2018.2 / C# 6. Keeps the scene's course meshes in step with the FBX folder
// the Blender export writes into (course.meshFolder, one FBX per OPCD mesh), the way
// the manual step does it: an FBX whose content changed gets its scene object
// deleted and added again, like GSP > Add OPCD Meshes (instantiate under
// course.meshParent, MeshCollider, then OPCD's own GameObject > Set Default
// Materials), and only those objects; unchanged meshes are left alone.
//   - Changed = the FBX file's size or time differs from the last sync
//     (<course>/meshes-sync.json). The Blender FBX sync only rewrites meshes that
//     changed; after OPCD's Batch Export every mesh is replaced. The first sync has nothing to compare
//     with: it records the scene as it is (replaceAll=true rebuilds everything).
//   - FBX whose name starts with a course.meshExclude prefix (default: OPCD's Gap_Issue
//     markers) are never added; objects showing one are stale.
//   - An FBX with no scene object is added; an object under the parent that shows no
//     current FBX (deleted FBX, or a painted copy left of one) is stale (prune deletes).
//   - An FBX the Blender FBX sync's record (<folder>/.golfmap-fbx-sync.json) does not
//     list is a leftover of an older .blend (OPCD renumbers meshes when it regenerates
//     the file): never added, reported with its objects; the Blender export deletes it.
//     A record older than any FBX is ignored (OPCD's Batch Export bypasses it).
// Vertex paint renders from mesh copies (GolfMapVertexPaint): after any add or
// replace the paint is applied again, so the copies follow the new geometry.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapCourseMeshes
    {
        const string StateFormat = "golfmap-meshes-sync-v2";
        const string StateFile = "meshes-sync.json";
        const string BlenderManifest = ".golfmap-fbx-sync.json";
        const string PaintFile = "paint.json";
        const string SetDefaultMaterialsMenu = "GameObject/Set Default Materials";  // OPCD, SetMeshEditorDLL: acts on Selection.gameObjects
        const string GrassRendererType = "StixGames.GrassShader.GrassRenderer";

        [MenuItem("GolfMap/Meshes/Preview sync from FBX folder")]
        static void PreviewMenu() { Log(Sync(true, false, true)); }

        [MenuItem("GolfMap/Meshes/Sync from FBX folder")]
        static void SyncMenu()
        {
            var plan = Sync(true, false, true);
            int stale = ((List<object>)plan["stale"]).Count;
            bool prune = stale > 0 && EditorUtility.DisplayDialog("Sync course meshes",
                stale + " object(s) under '" + plan["parent"] + "' no longer have an FBX (see the Console). Delete them?", "Delete", "Keep");
            if (plan.ContainsKey("leftoversHint")) Debug.LogWarning("[GolfMap Meshes] " + plan["leftoversHint"]);
            if (plan.ContainsKey("warnings")) foreach (var w in (List<object>)plan["warnings"]) Debug.LogWarning("[GolfMap Meshes] " + w);
            Log(Sync(false, prune, true));
        }

        [MenuItem("GolfMap/Meshes/Rebuild all from FBX folder")]
        static void RebuildMenu()
        {
            if (!EditorUtility.DisplayDialog("Rebuild course meshes", "Delete every course mesh object and add it again from the FBX folder (collider, OPCD Set Default Materials, vertex paint)?", "Rebuild", "Cancel")) return;
            Log(Sync(false, true, true, null, null, true));
        }

        [BridgeCommand("golfmap.meshes.sync", "Bring the scene's course meshes in step with the course's FBX folder (Blender export) the way deleting and re-adding them by hand does, but only where something changed: an FBX whose content changed since the last sync (file size+time) has its object deleted and added again, new FBX are added (under the course's mesh parent, MeshCollider, OPCD's Set Default Materials), objects that show no current FBX are stale (deleted with prune), then vertex paint is applied again. The first sync only records the scene (replaceAll rebuilds everything). FBX the Blender manifest does not list (leftovers of an older .blend) are never added. Marks the scene dirty, does not save it.",
            args = "dryRun=false (plan only), prune=false (delete stale objects), paint=true, replaceAll=false, folder (under Assets; default: the course's meshFolder), parent (default: the course's meshParent), exclude (comma-separated FBX name prefixes; default: the course's meshExclude)")]
        static object Command(BridgeArgs a)
        {
            return Sync(a.Bool("dryRun", false), a.Bool("prune", false), a.Bool("paint", true), a.String("folder"), a.String("parent"), a.Bool("replaceAll", false), a.String("exclude"));
        }

        public static Dictionary<string, object> Sync(bool dryRun, bool prune, bool paint, string folderName = null, string parentName = null, bool replaceAll = false, string excludePrefixes = null)
        {
            var course = GolfMapCourses.Require();
            var folder = "Assets/" + (folderName ?? course.meshFolder).Trim('/', '\\').Replace('\\', '/');
            var parentObject = parentName ?? course.meshParent;
            // Read everything from the course now: OPCD's Set Default Materials saves assets and unloads
            // unused ones, and the course asset (referenced by nothing in the scene) goes with them.
            var courseFolder = GolfMapCourses.Folder(course);
            var exclude = (excludePrefixes ?? course.meshExclude ?? "").Split(',').Select(x => x.Trim()).Where(x => x.Length > 0).ToArray();
            course = null;
            if (!AssetDatabase.IsValidFolder(folder)) throw new InvalidOperationException("Course mesh folder " + folder + " does not exist (course.meshFolder).");
            AssetDatabase.Refresh();  // imports what the export rewrote, like focusing Unity would

            var scene = EditorSceneManager.GetActiveScene();
            var files = Directory.GetFiles(folder, "*.fbx", SearchOption.AllDirectories)
                .Select(f => f.Replace('\\', '/')).OrderBy(f => f, StringComparer.Ordinal).ToList();
            var all = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject).ToList();
            var parent = all.FirstOrDefault(g => g.transform.parent == null && g.name == parentObject)
                      ?? all.FirstOrDefault(g => g.name == parentObject);
            var underParent = parent == null ? new List<GameObject>()
                : parent.GetComponentsInChildren<Transform>(true).Select(t => t.gameObject).Where(g => g != parent).ToList();

            // Which scene objects show which FBX. Course mesh objects are leaves: the parent, or anything
            // with children, is never one (replacing it would delete everything under it), even when it
            // carries a mesh of its own - e.g. a parent made by dragging an FBX in and renaming it.
            var byFile = new Dictionary<string, List<GameObject>>(StringComparer.OrdinalIgnoreCase);
            var holders = new List<object>();
            foreach (var go in all)
            {
                var src = SourceFbx(go, folder);
                if (src != null && (go == parent || go.transform.childCount > 0))
                {
                    holders.Add(PathOf(go) + " renders " + Path.GetFileNameWithoutExtension(src) + " itself: it draws twice where that mesh's own object is. Remove its MeshFilter/MeshRenderer/MeshCollider.");
                    continue;
                }
                if (src == null) continue;
                List<GameObject> list;
                if (!byFile.TryGetValue(src, out list)) byFile[src] = list = new List<GameObject>();
                list.Add(go);
            }
            // The Blender record is only current while no FBX is newer than it (OPCD's own Batch Export
            // rewrites the files without it); a stale one would hide new meshes as leftovers.
            var manifest = BlenderExport(folder);
            bool manifestStale = manifest != null && files.Any(f => File.GetLastWriteTimeUtc(f) > File.GetLastWriteTimeUtc(folder + "/" + BlenderManifest).AddSeconds(2));
            if (manifestStale) manifest = null;
            var leftovers = manifest == null ? new List<string>() : files.Where(f => !manifest.ContainsKey(Path.GetFileNameWithoutExtension(f))).ToList();
            Func<string, bool> excluded = f => f != null && exclude.Any(x => Path.GetFileNameWithoutExtension(f).StartsWith(x, StringComparison.Ordinal));
            var skipped = files.Where(excluded).ToList();
            leftovers = leftovers.Where(f => !excluded(f)).ToList();
            var current = files.Where(f => !leftovers.Contains(f) && !excluded(f)).ToList();
            var versions = current.ToDictionary(f => f, Version, StringComparer.OrdinalIgnoreCase);

            var statePath = courseFolder + StateFile;
            var previous = LoadState(statePath, folder);
            var missing = current.Where(f => !byFile.ContainsKey(f)).ToList();
            var changed = current.Where(f => byFile.ContainsKey(f) &&
                (replaceAll || (previous != null && (!previous.ContainsKey(f) || previous[f] != versions[f])))).ToList();
            // Stale: a course mesh object under the parent that shows no current FBX. Its mesh reads
            // null once the FBX is deleted, but a painted copy keeps rendering, so that alone is not enough.
            // Objects showing an excluded FBX (course.meshExclude, e.g. OPCD's Gap_Issue markers) go the same way.
            var stale = underParent.Where(g => g.transform.childCount == 0 && g.GetComponent<MeshFilter>() != null &&
                (SourceFbx(g, folder) == null || excluded(SourceFbx(g, folder)))).ToList();
            var duplicates = byFile.Where(kv => kv.Value.Count > 1)
                .Select(kv => (object)new Dictionary<string, object> { { "fbx", kv.Key }, { "objects", kv.Value.Select(g => (object)PathOf(g)).ToList() } }).ToList();

            var result = new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "folder", folder },
                { "parent", parentObject },
                { "dryRun", dryRun },
                { "fbx", current.Count },
                { "excluded", skipped.Count },
                { "firstSync", previous == null && !replaceAll },
                { "added", missing.Select(f => (object)Path.GetFileNameWithoutExtension(f)).ToList() },
                { "replaced", changed.Select(f => (object)Path.GetFileNameWithoutExtension(f)).ToList() },
                { "stale", stale.Select(g => (object)PathOf(g)).ToList() },
                { "duplicates", duplicates },
                { "leftovers", manifest == null ? (object)(manifestStale
                        ? "not checked: FBX were written after " + BlenderManifest + " (e.g. by OPCD's Batch Export)"
                        : "not checked: no " + BlenderManifest + " (Blender FBX sync not used on this folder)")
                    : leftovers.Select(f => (object)new Dictionary<string, object> {
                        { "fbx", Path.GetFileNameWithoutExtension(f) },
                        { "objects", byFile.ContainsKey(f) ? byFile[f].Select(g => (object)PathOf(g)).ToList() : new List<object>() } }).ToList() },
            };
            if (holders.Count > 0) result["warnings"] = holders;
            if (leftovers.Count > 0)
                result["leftoversHint"] = leftovers.Count + " FBX are not exported by the current .blend: run Export changed FBX in Blender with 'Delete FBX of removed meshes' ticked, then sync again.";
            if (previous == null && !replaceAll)
                result["firstSyncNote"] = "No record of a previous sync: the scene's existing objects are taken as current and recorded. Use Rebuild all (replaceAll=true) if they may be out of date.";
            if (dryRun) return result;

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Sync course meshes");
            var errors = new List<object>();
            var created = new List<GameObject>();
            if (missing.Count + changed.Count > 0 && parent == null)
            {
                parent = new GameObject(parentObject);
                Undo.RegisterCreatedObjectUndo(parent, "Sync course meshes");
            }
            foreach (var file in missing.Concat(changed))
            {
                var model = AssetDatabase.LoadAssetAtPath<GameObject>(file);
                if (model == null) { errors.Add(file + ": Unity did not import it as a model."); continue; }
                // A replaced object keeps its place under its parent.
                List<GameObject> old;
                byFile.TryGetValue(file, out old);
                var place = old != null ? old[0].transform : null;
                var at = place != null && place.parent != null ? place.parent : parent.transform;
                int index = place != null ? place.GetSiblingIndex() : -1;
                if (old != null) foreach (var g in old) Undo.DestroyObjectImmediate(g);
                var go = (GameObject)PrefabUtility.InstantiatePrefab(model, scene);
                Undo.RegisterCreatedObjectUndo(go, "Sync course meshes");
                go.transform.SetParent(at, false);
                if (index >= 0) go.transform.SetSiblingIndex(index);
                go.transform.localPosition = Vector3.zero;
                go.transform.localRotation = Quaternion.identity;
                var filter = go.GetComponent<MeshFilter>();
                if (filter != null && go.GetComponent<MeshCollider>() == null)
                    Undo.AddComponent<MeshCollider>(go).sharedMesh = filter.sharedMesh;
                created.Add(go);
            }
            if (created.Count > 0)
            {
                var selection = Selection.objects;
                Selection.objects = created.Cast<UnityEngine.Object>().ToArray();
                if (!EditorApplication.ExecuteMenuItem(SetDefaultMaterialsMenu))
                    errors.Add("OPCD's '" + SetDefaultMaterialsMenu + "' is not in this project; the new meshes have no materials.");
                Selection.objects = selection;
            }
            if (prune)
                foreach (var g in stale) if (g != null) Undo.DestroyObjectImmediate(g);
            Undo.CollapseUndoOperations(undoGroup);

            // Painting reads the FBX colours, so it runs after the new objects exist.
            if (paint && created.Count > 0 && File.Exists(courseFolder + PaintFile)) result["paint"] = Summary(GolfMapVertexPaint.Apply(false));

            if (created.Count > 0 || (prune && stale.Count > 0)) EditorSceneManager.MarkSceneDirty(scene);
            SaveState(statePath, folder, versions);

            result["prunedStale"] = prune && stale.Count > 0;
            result["errors"] = errors;
            result["followUps"] = FollowUps(created, created.Count > 0 || (prune && stale.Count > 0));
            return result;
        }

        // What the scene object was built from: the file's size and time. The Blender FBX sync only
        // rewrites changed meshes; OPCD's Batch Export rewrites all, which then all get replaced.
        static string Version(string file)
        {
            var info = new FileInfo(file);
            return info.Length + "@" + info.LastWriteTimeUtc.Ticks;
        }

        static Dictionary<string, object> Summary(Dictionary<string, object> paint)
        {
            return paint.Where(kv => kv.Key != "meshes").ToDictionary(kv => kv.Key, kv => kv.Value);
        }

        // Name -> fingerprint of what the current .blend exports (the Blender FBX sync's manifest); null without one.
        static Dictionary<string, string> BlenderExport(string folder)
        {
            var path = folder + "/" + BlenderManifest;
            if (!File.Exists(path)) return null;
            var files = GolfMapJsonDoc.ParseObject(File.ReadAllText(path)).Object("files");
            if (files == null) return null;
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var key in files.keys) map[key] = files.String(key) ?? "";
            return map;
        }

        // The FBX (under folder) an object's mesh comes from: the collider keeps the
        // FBX mesh when vertex paint has swapped the MeshFilter to a copy.
        static string SourceFbx(GameObject go, string folder)
        {
            var collider = go.GetComponent<MeshCollider>();
            var filter = go.GetComponent<MeshFilter>();
            foreach (var mesh in new[] { collider != null ? collider.sharedMesh : null, filter != null ? filter.sharedMesh : null })
            {
                if (mesh == null) continue;
                var p = AssetDatabase.GetAssetPath(mesh);
                if (p.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase) && p.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) return p;
            }
            return null;
        }

        // A course mesh object whose mesh asset was deleted: the references read null.
        static bool LostMesh(GameObject go)
        {
            var filter = go.GetComponent<MeshFilter>();
            if (filter == null || filter.sharedMesh != null) return false;
            var collider = go.GetComponent<MeshCollider>();
            return collider == null || collider.sharedMesh == null;
        }

        static List<object> FollowUps(List<GameObject> created, bool meshesChanged)
        {
            var list = new List<object>();
            var grass = AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(GrassRendererType, false)).FirstOrDefault(t => t != null);
            // Only where the course already grows it on its rough meshes.
            if (grass != null && created.Any(g => IsRough(g.name)) &&
                UnityEngine.Object.FindObjectsOfType(grass).Cast<Component>().Any(c => IsRough(c.name) && !created.Contains(c.gameObject)))
                list.Add("New rough meshes have no Stix 3D grass: golfmap.roughgrass.plant (GolfMap > Plant 3D grass to roughs).");
            if (meshesChanged)
                list.Add("Meshes changed: if the terrain was conformed to them, re-run golfmap.terrain.conform; re-export surfaces (golfmap.surfaces.export) before regenerating grass zones.");
            return list;
        }

        static bool IsRough(string name)
        {
            return name.StartsWith("Spline_", StringComparison.Ordinal) && GolfMapSurfaces.Classify(name) == GolfMapSurfaces.Surface.Rough;
        }

        static Dictionary<string, string> LoadState(string path, string folder)
        {
            if (!File.Exists(path)) return null;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var files = root.Object("files");
            var state = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (root.String("format") != StateFormat || root.String("folder") != folder || files == null) return null;
            foreach (var key in files.keys) state[key] = files.String(key);
            return state;
        }

        static void SaveState(string path, string folder, Dictionary<string, string> stamps)
        {
            var files = new Dictionary<string, object>();
            foreach (var kv in stamps.OrderBy(k => k.Key, StringComparer.Ordinal)) files[kv.Key] = kv.Value;
            File.WriteAllText(path, GolfMapJson.Serialize(new Dictionary<string, object> { { "format", StateFormat }, { "folder", folder }, { "files", files } }));
        }

        static string PathOf(GameObject go)
        {
            var path = go.name;
            for (var t = go.transform.parent; t != null; t = t.parent) path = t.name + "/" + path;
            return "/" + path;
        }

        static void Log(Dictionary<string, object> result)
        {
            Debug.Log("[GolfMap Meshes] " + GolfMapJson.Serialize(result));
        }
    }
}
