// Unity 2018.2 / C# 6. Keeps the scene's course meshes in step with the FBX folder
// the Blender export writes into (course.meshFolder, one FBX per OPCD mesh).
//
// An FBX overwritten in place needs nothing here: the scene object references
// the mesh sub-asset by the FBX's GUID and the mesh name, so Unity's reimport
// swaps the geometry under the existing object and its collider, materials and
// MeshChannelMaterialsStore stay. Only the set of files changes the scene:
//   - an FBX with no scene object is instantiated under course.meshParent the way
//     OPCD's GSP > Add OPCD Meshes does, given a MeshCollider (pipeline step 18),
//     then OPCD's own GameObject > Set Default Materials runs on the new objects;
//   - a scene object under the parent whose FBX is gone (mesh reference missing)
//     is reported, and deleted with prune.
// Vertex paint renders from mesh copies (GolfMapVertexPaint), so a painted object
// whose FBX is newer than its copy would keep showing the old geometry: the sync
// re-runs the paint then. <course>/meshes-sync.json remembers each FBX's size and
// time at the last sync of that folder, only to report which ones were updated in place.
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
        const string StateFormat = "golfmap-meshes-sync-v1";
        const string StateFile = "meshes-sync.json";
        const string PaintFile = "paint.json";
        const string PaintedFolder = "PaintedMeshes/";
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
                stale + " object(s) under '" + plan["parent"] + "' have lost their FBX (see the Console). Delete them?", "Delete", "Keep");
            Log(Sync(false, prune, true));
        }

        [BridgeCommand("golfmap.meshes.sync", "Bring the scene's course meshes in step with the course's FBX folder (Blender export): refresh the asset database (FBX overwritten in place update their scene objects by themselves), add every FBX without a scene object under the course's mesh parent with a MeshCollider and OPCD's Set Default Materials, report objects whose FBX is gone (delete with prune), re-run vertex paint where a painted mesh's FBX is newer than its copy. Marks the scene dirty, does not save it.",
            args = "dryRun=false (plan only), prune=false (delete objects whose FBX is gone), paint=true, folder (under Assets; default: the course's meshFolder), parent (default: the course's meshParent)")]
        static object Command(BridgeArgs a)
        {
            return Sync(a.Bool("dryRun", false), a.Bool("prune", false), a.Bool("paint", true), a.String("folder"), a.String("parent"));
        }

        public static Dictionary<string, object> Sync(bool dryRun, bool prune, bool paint, string folderName = null, string parentName = null)
        {
            var course = GolfMapCourses.Require();
            var folder = "Assets/" + (folderName ?? course.meshFolder).Trim('/', '\\').Replace('\\', '/');
            var parentObject = parentName ?? course.meshParent;
            if (!AssetDatabase.IsValidFolder(folder)) throw new InvalidOperationException("Course mesh folder " + folder + " does not exist (course.meshFolder).");
            AssetDatabase.Refresh();  // imports what the export rewrote, like focusing Unity would

            var scene = EditorSceneManager.GetActiveScene();
            var files = Directory.GetFiles(folder, "*.fbx", SearchOption.AllDirectories)
                .Select(f => f.Replace('\\', '/')).OrderBy(f => f, StringComparer.Ordinal).ToList();
            var all = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject).ToList();
            var parent = all.FirstOrDefault(g => g.transform.parent == null && g.name == parentObject)
                      ?? all.FirstOrDefault(g => g.name == parentObject);

            // Which scene objects show which FBX.
            var byFile = new Dictionary<string, List<GameObject>>(StringComparer.OrdinalIgnoreCase);
            foreach (var go in all)
            {
                var src = SourceFbx(go, folder);
                if (src == null) continue;
                List<GameObject> list;
                if (!byFile.TryGetValue(src, out list)) byFile[src] = list = new List<GameObject>();
                list.Add(go);
            }
            var missing = files.Where(f => !byFile.ContainsKey(f)).ToList();
            var duplicates = byFile.Where(kv => kv.Value.Count > 1)
                .Select(kv => (object)new Dictionary<string, object> { { "fbx", kv.Key }, { "objects", kv.Value.Select(g => (object)PathOf(g)).ToList() } }).ToList();
            var stale = parent == null ? new List<GameObject>() : parent.GetComponentsInChildren<Transform>(true)
                .Select(t => t.gameObject).Where(g => g != parent && LostMesh(g)).ToList();

            // Updated in place since the last sync (report only; Unity already reimported them).
            var statePath = GolfMapCourses.Folder(course) + StateFile;
            var previous = LoadState(statePath, folder);
            var now = files.ToDictionary(f => f, Stamp, StringComparer.OrdinalIgnoreCase);
            var updated = previous == null ? new List<string>()
                : files.Where(f => previous.ContainsKey(f) && previous[f] != now[f]).ToList();

            // Painted copies older than their FBX.
            var paintedFolder = GolfMapCourses.Folder(course) + PaintedFolder;
            var stalePaint = all.Where(g => PaintIsStale(g, folder, paintedFolder)).Select(g => (object)PathOf(g)).ToList();

            var result = new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "folder", folder },
                { "parent", parentObject },
                { "dryRun", dryRun },
                { "fbx", files.Count },
                { "inScene", files.Count - missing.Count },
                { "updatedSinceLastSync", previous == null ? (object)"no record yet (first sync)" : updated.Select(f => (object)Path.GetFileNameWithoutExtension(f)).ToList() },
                { "added", missing.Select(f => (object)Path.GetFileNameWithoutExtension(f)).ToList() },
                { "stale", stale.Select(g => (object)PathOf(g)).ToList() },
                { "duplicates", duplicates },
                { "stalePaint", stalePaint },
            };
            if (parent == null && missing.Count > 0) result["parentCreated"] = true;
            if (dryRun) return result;

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Sync course meshes");
            var errors = new List<object>();
            var created = new List<GameObject>();
            if (missing.Count > 0 && parent == null)
            {
                parent = new GameObject(parentObject);
                Undo.RegisterCreatedObjectUndo(parent, "Sync course meshes");
            }
            foreach (var file in missing)
            {
                var model = AssetDatabase.LoadAssetAtPath<GameObject>(file);
                if (model == null) { errors.Add(file + ": Unity did not import it as a model."); continue; }
                var go = (GameObject)PrefabUtility.InstantiatePrefab(model, scene);
                Undo.RegisterCreatedObjectUndo(go, "Sync course meshes");
                go.transform.SetParent(parent.transform, false);
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
            bool paintNeeded = stalePaint.Count > 0 || (created.Count > 0 && File.Exists(GolfMapCourses.Folder(course) + PaintFile));
            if (paint && paintNeeded) result["paint"] = GolfMapVertexPaint.Apply(false);

            if (created.Count > 0 || (prune && stale.Count > 0)) EditorSceneManager.MarkSceneDirty(scene);
            SaveState(statePath, folder, now);

            result["prunedStale"] = prune && stale.Count > 0;
            result["errors"] = errors;
            result["followUps"] = FollowUps(created, missing.Count > 0 || updated.Count > 0 || (prune && stale.Count > 0));
            return result;
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

        static bool PaintIsStale(GameObject go, string folder, string paintedFolder)
        {
            var filter = go.GetComponent<MeshFilter>();
            if (filter == null || filter.sharedMesh == null) return false;
            var copy = AssetDatabase.GetAssetPath(filter.sharedMesh);
            if (!copy.StartsWith(paintedFolder, StringComparison.OrdinalIgnoreCase)) return false;
            var src = SourceFbx(go, folder);
            return src != null && File.GetLastWriteTimeUtc(src) > File.GetLastWriteTimeUtc(copy);
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

        static string Stamp(string file)
        {
            var info = new FileInfo(file);
            return info.Length + "@" + info.LastWriteTimeUtc.Ticks;
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
