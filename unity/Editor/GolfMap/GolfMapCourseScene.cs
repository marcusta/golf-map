// A new course's scene in one step: OPCD's prepared ImportTerrain scene copied to
// Assets/Terrain Backup/<prefix>/<Name>_lidar_scene.unity, named on the course's Course.asset,
// opened, given the course's look.json (sun, sky, ambient, fog, post-processing) and saved.
// OPCD's template carries its own sun (1.3), sky (BlueSky_Bright) and a brighter profile
// (v4_Sunny_Pop); Omberg's scene kept them on 2026-10-15 and rendered far paler than Vreta.
// Not in unity/check-planter.ps1's list: it calls GolfMapLook, which needs the post-processing assembly.
using System.Collections.Generic;
using System.IO;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    static class GolfMapCourseScene
    {
        const string Template = "Assets/Scenes/ImportTerrain.unity";

        [BridgeCommand("golfmap.course.scene", "Make the active course's scene from OPCD's ImportTerrain template: copy it to Assets/Terrain Backup/<exportPrefix>/<name>.unity, set the name as Scene Name on Course.asset, open it, apply the course's look.json (golfmap.look.apply: sun, sky, ambient, fog, post-processing) and save it. When that scene is already there it is only opened (the look is left as it is). Refuses while the open scene has unsaved changes.",
            args = "name (default <courseName>_lidar_scene), template=Assets/Scenes/ImportTerrain.unity, look=true, dryRun=false")]
        static object Make(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            string name = a.String("name", GolfMapCourses.Name(course) + "_lidar_scene");
            string template = a.String("template", Template);
            string prefix = string.IsNullOrEmpty(course.exportPrefix) ? GolfMapCourses.Name(course).ToLowerInvariant() : course.exportPrefix;
            string dir = "Assets/Terrain Backup/" + prefix, path = dir + "/" + name + ".unity";
            bool exists = File.Exists(path);
            var plan = new Dictionary<string, object> { { "course", GolfMapCourses.Name(course) }, { "scene", path }, { "template", template }, { "exists", exists } };
            if (a.Bool("dryRun", false)) { plan["dryRun"] = true; return plan; }

            var open = SceneManager.GetActiveScene();
            if (open.isDirty && open.path != path) throw new BridgeError("The open scene " + open.path + " has unsaved changes: save or discard them first.");
            if (!exists)
            {
                if (!File.Exists(template)) throw new BridgeError("No template scene at " + template + ".");
                if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder("Assets/Terrain Backup", prefix);
                if (!AssetDatabase.CopyAsset(template, path)) throw new BridgeError("Could not copy " + template + " to " + path + ".");
            }
            if (course.sceneName != name)
            {
                course.sceneName = name;
                EditorUtility.SetDirty(course);
                AssetDatabase.SaveAssets();
            }
            var scene = open.path == path ? open : EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
            if (!exists && a.Bool("look", true)) plan["look"] = GolfMapLook.Apply(new BridgeArgs(null));
            if (scene.isDirty) EditorSceneManager.SaveScene(scene);
            plan["created"] = !exists;
            return plan;
        }
    }
}
