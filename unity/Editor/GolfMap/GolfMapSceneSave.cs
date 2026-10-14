// The `save` arg every golf-map command that writes into the scene takes (Unity 2018.2 / C# 6).
//
// The commands mark the scene dirty and leave saving to the user ("Save the scene in Unity to keep
// it", six places on the web/server side). That cost 13 meshes on 2026-10-09, when the editor
// crashed with the work only in memory. `save: true` makes the command save what it just changed:
// every open scene that is dirty, plus AssetDatabase.SaveAssets() for the assets it wrote (terrain
// data, palettes, materials, meshes), and puts `saved: { scenes: [...], seconds }` in the result.
//
// `save` is not handled here any more, and no command threads it through its own return sites: the
// bridge dispatcher does it, once per top-level job, by calling `golfmap.scene.save` below
// (BridgeServer.cs, "save hook"). That is why EVERY command takes `save` now, including the ones
// that never got a wrapper of their own (roughgrass.plant, look.apply, paint.apply, walls.colors,
// vsp.merge ...), and why the rules below hold for all of them without a line of their own:
//   - default false: a caller that does not pass `save` sees exactly the old behaviour;
//   - a dry run never saves (nothing changed): `dryRun: true` in the args or in the result;
//   - a command that failed never saves - one that throws never reaches the hook, and one that
//     reports its own failure (`failed: true`, course.refresh) is left dirty so the user can look;
//   - the save happens once, at the end of the job: course.refresh's chained steps are not jobs, so
//     the refresh saves after its last step, not per step.
using System;
using System.Collections.Generic;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    public static class GolfMapSceneSave
    {
        // The one line to put in a command's `args =` text.
        public const string Arg = "save=false (when it succeeded: save the open dirty scenes and the assets it changed, and report saved.scenes/seconds; a dry run never saves)";

        [BridgeCommand("golfmap.scene.save", "Save what the commands changed: every open scene that is dirty, then AssetDatabase.SaveAssets() for the assets they wrote (terrain data, palettes, materials, meshes). Returns { scenes: [<paths saved>], seconds }, plus skippedScenes for a dirty scene that has no file of its own yet. This is what `save: true` on any command runs for itself once the command has succeeded (unity/README.md, \"Saving what a command changed\"), so it is rarely called by hand.")]
        static object SaveCommand() { return Save(); }

        // Save the dirty open scenes and the changed assets. Returns the `saved` value for a result.
        public static Dictionary<string, object> Save()
        {
            var started = DateTime.Now;
            var scenes = new List<object>();
            // A scene with no path has never been saved - an untitled additive scene someone opened
            // next to the course's. Throwing here would have turned a `save: true` command that did
            // its work (and whose course scene is already on disk) into an error, so it is listed
            // instead: nothing of ours is in it, and only the user can give it a file.
            var untitled = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isDirty) continue;
                if (string.IsNullOrEmpty(scene.path)) { untitled.Add(scene.name); continue; }
                if (!EditorSceneManager.SaveScene(scene)) throw new BridgeError("Could not save " + scene.path + ".");
                scenes.Add(scene.path);
            }
            AssetDatabase.SaveAssets();
            var saved = new Dictionary<string, object>
            {
                { "scenes", scenes },
                { "seconds", Math.Round((DateTime.Now - started).TotalSeconds, 2) },
            };
            if (untitled.Count > 0)
            {
                saved["skippedScenes"] = untitled;
                Debug.LogWarning("[GolfMap] Saved " + scenes.Count + " scene(s); left dirty because it has never been saved and has no file: "
                    + string.Join(", ", untitled.ConvertAll(o => (string)o).ToArray()) + ". Save it once in Unity to give it a file.");
            }
            return saved;
        }
    }
}
