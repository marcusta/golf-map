// The `save` arg every golf-map command that writes into the scene takes (Unity 2018.2 / C# 6).
//
// The commands mark the scene dirty and leave saving to the user ("Save the scene in Unity to keep
// it", six places on the web/server side). That cost 13 meshes on 2026-10-09, when the editor
// crashed with the work only in memory. `save: true` makes the command save what it just changed:
// every open scene that is dirty, plus AssetDatabase.SaveAssets() for the assets it wrote (terrain
// data, palettes, materials, meshes), and puts `saved: { scenes: [...], seconds }` in the result.
//
// Rules, the same for every command:
//   - default false: a caller that does not pass `save` sees exactly the old behaviour;
//   - a dry run never saves (nothing changed);
//   - a command that failed never saves - one that throws never reaches here, and one that reports
//     its own failure (course.refresh's `failed`) is left dirty so the user can look at it;
//   - the save happens once, at the end: course.refresh's chained steps do not get `save`, the
//     refresh saves after the last step.
using System;
using System.Collections;
using System.Collections.Generic;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    public static class GolfMapSceneSave
    {
        // The one line to put in a command's `args =` text.
        public const string Arg = "save=false (when it succeeded: save the open dirty scenes and the assets it changed, and report saved.scenes/seconds; a dry run never saves)";

        // Save the dirty open scenes and the changed assets. Returns the `saved` value for a result.
        public static Dictionary<string, object> Save()
        {
            var started = DateTime.Now;
            var scenes = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isDirty) continue;
                if (string.IsNullOrEmpty(scene.path))
                    throw new BridgeError("Scene '" + scene.name + "' has never been saved: save it once in Unity to give it a file, then run with save again.");
                if (!EditorSceneManager.SaveScene(scene)) throw new BridgeError("Could not save " + scene.path + ".");
                scenes.Add(scene.path);
            }
            AssetDatabase.SaveAssets();
            return new Dictionary<string, object>
            {
                { "scenes", scenes },
                { "seconds", Math.Round((DateTime.Now - started).TotalSeconds, 2) },
            };
        }

        // End of a command that returns its result directly: `return GolfMapSceneSave.After(a, result);`
        public static object After(BridgeArgs a, object result)
        {
            if (!a.Bool("save", false)) return result;
            var d = result as Dictionary<string, object>;
            string skipped = Skipped(a, d);
            if (skipped != null)
            {
                if (d != null) d["saved"] = new Dictionary<string, object> { { "skipped", skipped } };
                return result;
            }
            var saved = Save();
            if (d == null) return new Dictionary<string, object> { { "result", result }, { "saved", saved } };
            d["saved"] = saved;
            return result;
        }

        // Why this run must not save, or null when it may.
        static string Skipped(BridgeArgs a, Dictionary<string, object> d)
        {
            if (a.Bool("dryRun", false) || Flag(d, "dryRun")) return "dryRun: nothing was changed, so nothing was saved";
            if (Flag(d, "failed")) return "a step failed: the scene is left dirty and unsaved";
            return null;
        }

        static bool Flag(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        // End of a command that returns an IEnumerator (the bridge pumps one step per editor frame,
        // the first non-null Current is the result): `return GolfMapSceneSave.Then(a, Inner(a));`
        public static IEnumerator Then(BridgeArgs a, IEnumerator inner)
        {
            object result = null;
            while (inner.MoveNext())
            {
                if (inner.Current != null) { result = inner.Current; break; }
                yield return null;
            }
            if (result == null) yield break;   // a command with no result of its own: nothing to carry `saved`
            yield return After(a, result);
        }
    }
}
