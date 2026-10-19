// The course's own tee markers for GSPro: GSPro sets out two markers per tee (TeeMarkerWidth apart) from the
// prefabs in the scene's CourseOverrides object (TeeMarkerWhite / Yellow / Blue / Red / Junior / Par3 ...), and
// falls back to its default marker for an empty slot. This makes those prefabs from a props build installed in
// <course>/TeeMarkers/ (build_props.py: Models/, Textures/, props.json; e.g. Omberg's painted granite setts,
// docs/gspro/ombergs-golfklubb/tee-markers/tee-markers.json) and fills the slots.
using System;
using System.Collections.Generic;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    static class GolfMapTeeMarkers
    {
        // asset id suffix in the build -> CourseOverrides slot
        static readonly Dictionary<string, string> DefaultSlots = new Dictionary<string, string>
        {
            { "white", "TeeMarkerWhite" }, { "yellow", "TeeMarkerYellow" }, { "blue", "TeeMarkerBlue" }, { "red", "TeeMarkerRed" },
            { "orange", "TeeMarkerJunior" }, { "grey", "TeeMarkerPar3" }, { "black", "TeeMarkerBlack" }, { "green", "TeeMarkerGreen" },
        };

        [BridgeCommand("golfmap.teemarkers.install", "Make the course's tee marker prefabs from the props build in <course>/TeeMarkers/ (one model per asset, named <anything>_<colour>) and put them in the scene's CourseOverrides slots (made from GSPro's Resources/CourseOverrides when the scene has none): white, yellow, blue, red, orange -> Junior, grey -> Par3, black, green. Each prefab stands on its pivot: the model centred on it and sunk sinkM into the ground. width sets TeeMarkerWidth (the distance GSPro sets the two markers apart; omit to keep it). dryRun lists what would be made. Undo-able for the scene object; save=true saves the scene. previewAt=[x, z] (stepM=0.6) instead stands the slotted markers in a row there under an object that is never saved, to look at them in the editor (GSPro only sets them out in play); clearPreview=true removes it.",
            args = "sinkM=0.01, width, dryRun=false, previewAt [x, z], stepM=0.6, clearPreview=false, " + GolfMapSceneSave.Arg)]
        static object Install(BridgeArgs a)
        {
            if (a.Has("previewAt") || a.Bool("clearPreview", false)) return Preview(a);
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course) + "TeeMarkers/";
            if (!System.IO.File.Exists(folder + "props.json")) throw new BridgeError("No tee marker build at " + folder + "props.json (install the build_props.py output there first).");
            bool dryRun = a.Bool("dryRun", false);
            float sink = (float)a.Number("sinkM", 0.01);

            var type = AppDomain.CurrentDomain.GetAssemblies().Select(x => x.GetType("CourseOverrides")).FirstOrDefault(t => t != null);
            if (type == null) throw new BridgeError("This project has no CourseOverrides script (GSPro's Assets/CourseOverrides).");

            var models = GolfMapProps.ImportModels(folder);
            var plan = new List<Dictionary<string, object>>();
            var prefabs = new Dictionary<string, GameObject>();
            if (!dryRun && !AssetDatabase.IsValidFolder(folder + "Prefabs")) AssetDatabase.CreateFolder(folder.TrimEnd('/'), "Prefabs");
            foreach (var kv in models)
            {
                var colour = kv.Key.Substring(kv.Key.LastIndexOf('_') + 1);
                string slot;
                if (!DefaultSlots.TryGetValue(colour, out slot)) continue;
                var path = folder + "Prefabs/TeeMarker " + colour + ".prefab";
                plan.Add(new Dictionary<string, object> { { "asset", kv.Key }, { "slot", slot }, { "prefab", path } });
                if (dryRun) continue;

                var root = new GameObject("TeeMarker " + colour);
                var model = (GameObject)PrefabUtility.InstantiatePrefab(kv.Value);
                model.transform.SetParent(root.transform, false);
                var renderers = model.GetComponentsInChildren<Renderer>();
                if (renderers.Length == 0) { UnityEngine.Object.DestroyImmediate(root); throw new BridgeError(kv.Key + " has no renderer."); }
                var b = renderers[0].bounds;
                foreach (var r in renderers) b.Encapsulate(r.bounds);
                model.transform.localPosition -= new Vector3(b.center.x, b.min.y + sink, b.center.z);
                var existing = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                var prefab = existing != null
                    ? PrefabUtility.ReplacePrefab(root, existing, ReplacePrefabOptions.ReplaceNameBased)
                    : PrefabUtility.CreatePrefab(path, root);
                UnityEngine.Object.DestroyImmediate(root);
                prefabs[slot] = prefab;
            }
            var result = new Dictionary<string, object> { { "folder", folder }, { "markers", plan }, { "dryRun", dryRun } };
            if (dryRun) return result;

            var go = GameObject.Find("CourseOverrides");
            bool created = go == null;
            if (created)
            {
                var template = Resources.Load<GameObject>("CourseOverrides");
                if (template == null) throw new BridgeError("No Resources/CourseOverrides prefab in this project.");
                go = UnityEngine.Object.Instantiate(template);
                go.name = "CourseOverrides";
                go.transform.position = Vector3.zero;
                Undo.RegisterCreatedObjectUndo(go, "Create CourseOverrides");
            }
            var component = go.GetComponent(type);
            if (component == null) throw new BridgeError("The CourseOverrides object has no CourseOverrides component.");
            var so = new SerializedObject(component);
            foreach (var kv in prefabs)
            {
                var p = so.FindProperty(kv.Key);
                if (p == null) throw new BridgeError("CourseOverrides has no field " + kv.Key + ".");
                p.objectReferenceValue = kv.Value;
            }
            if (a.Has("width")) so.FindProperty("TeeMarkerWidth").floatValue = (float)a.Number("width", 4);
            so.ApplyModifiedProperties();
            EditorUtility.SetDirty(component);
            EditorSceneManager.MarkSceneDirty(go.scene);
            result["courseOverrides"] = created ? "created" : "updated";
            result["teeMarkerWidth"] = so.FindProperty("TeeMarkerWidth").floatValue;
            return result;
        }

        const string PreviewName = "TeeMarker preview (not saved)";

        // previewAt=[x, z]: the CourseOverrides markers in a row (stepM apart along +x) on the course meshes there, as
        // GSPro would stand them, under one object that is never saved; clearPreview=true removes it.
        static object Preview(BridgeArgs a)
        {
            var old = GameObject.Find(PreviewName);
            if (old != null) UnityEngine.Object.DestroyImmediate(old);
            if (a.Bool("clearPreview", false)) return new Dictionary<string, object> { { "cleared", old != null } };
            var at = a.List("previewAt");
            float x0 = Convert.ToSingle(at[0]), z0 = Convert.ToSingle(at[1]), step = (float)a.Number("stepM", 0.6);
            var go = GameObject.Find("CourseOverrides");
            if (go == null) throw new BridgeError("No CourseOverrides object in the scene: run golfmap.teemarkers.install first.");
            var type = AppDomain.CurrentDomain.GetAssemblies().Select(asm => asm.GetType("CourseOverrides")).FirstOrDefault(t => t != null);
            var so = new SerializedObject(go.GetComponent(type));
            var root = new GameObject(PreviewName) { hideFlags = HideFlags.DontSave };
            var placed = new List<string>();
            float x = x0;
            foreach (var slot in DefaultSlots.Values)
            {
                var pf = so.FindProperty(slot).objectReferenceValue as GameObject;
                if (pf == null) continue;
                RaycastHit hit;
                float y = Physics.Raycast(new Vector3(x, 500f, z0), Vector3.down, out hit, 1000f) ? hit.point.y : 0f;
                var m = (GameObject)PrefabUtility.InstantiatePrefab(pf);
                m.hideFlags = HideFlags.DontSave;
                m.transform.SetParent(root.transform, false);
                m.transform.position = new Vector3(x, y, z0);
                placed.Add(slot + " at " + x.ToString("0.0") + ", " + y.ToString("0.00") + ", " + z0.ToString("0.0"));
                x += step;
            }
            return new Dictionary<string, object> { { "preview", PreviewName }, { "placed", placed } };
        }
    }
}
