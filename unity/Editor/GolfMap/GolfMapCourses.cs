// Resolves the active GolfMapCourse and the paths that hang off it.
//
// A course is active when its sceneName matches the open scene, or when it is
// the only course in the project. A project that predates course assets is
// adopted on first use: a single Assets/GolfMap/<Course>/ folder holding a
// palette gets a Course.asset filled in from the pipeline's naming conventions.
using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    public static class GolfMapCourses
    {
        public const string Root = "Assets/GolfMap/";

        public static GolfMapCourse[] All()
        {
            return AssetDatabase.FindAssets("t:GolfMapCourse")
                .Select(g => AssetDatabase.LoadAssetAtPath<GolfMapCourse>(AssetDatabase.GUIDToAssetPath(g)))
                .Where(c => c).OrderBy(c => AssetDatabase.GetAssetPath(c), StringComparer.Ordinal).ToArray();
        }

        // Null when nothing resolves; Require() explains why.
        public static GolfMapCourse Active()
        {
            var all = All();
            if (all.Length == 0) return Adopt();
            string scene = SceneManager.GetActiveScene().name;
            var here = all.Where(c => !string.IsNullOrEmpty(c.sceneName) && c.sceneName == scene).ToArray();
            if (here.Length == 1) return here[0];
            if (here.Length == 0 && all.Length == 1 && string.IsNullOrEmpty(all[0].sceneName)) return all[0];
            return null;
        }

        public static GolfMapCourse Require()
        {
            var course = Active();
            if (course) return course;
            var all = All();
            string scene = SceneManager.GetActiveScene().name;
            if (all.Length == 0) throw new InvalidOperationException("No GolfMap course in this project. Use GolfMap > Course > New course for this scene.");
            throw new InvalidOperationException("No single GolfMap course claims the scene '" + scene + "' (" +
                string.Join(", ", all.Select(c => Name(c) + " -> " + (string.IsNullOrEmpty(c.sceneName) ? "any scene" : c.sceneName)).ToArray()) +
                "). Set Scene Name on the course asset.");
        }

        // The component's own course wins, so two courses can share a scene or a project.
        public static GolfMapCourse For(GolfMapTrees trees)
        {
            return trees && trees.course ? trees.course : Require();
        }

        public static string Name(GolfMapCourse course)
        {
            return string.IsNullOrEmpty(course.courseName) ? Path.GetFileName(Folder(course).TrimEnd('/')) : course.courseName;
        }

        // "Assets/GolfMap/Vreta/" - always with the trailing slash.
        public static string Folder(GolfMapCourse course)
        {
            var path = AssetDatabase.GetAssetPath(course);
            if (string.IsNullOrEmpty(path)) throw new InvalidOperationException("The course is not a saved asset.");
            return Path.GetDirectoryName(path).Replace('\\', '/') + "/";
        }

        public static string PalettePath(GolfMapCourse course) { return Folder(course) + course.paletteFile; }

        // Is this asset stored inside any course folder? Identifies the storage and
        // catalogues the planter created, whichever course they belong to.
        public static bool Owns(string assetPath)
        {
            return !string.IsNullOrEmpty(assetPath) && assetPath.StartsWith(Root, StringComparison.OrdinalIgnoreCase);
        }

        // "<exportFolder>/<prefix>-inner-trees.json"; null when the course names no export folder.
        public static string ExportFile(GolfMapCourse course, string terrain, string kind)
        {
            if (string.IsNullOrEmpty(course.exportFolder) || string.IsNullOrEmpty(course.exportPrefix)) return null;
            var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            return Path.GetFullPath(Path.Combine(folder, course.exportPrefix + "-" + terrain + "-" + kind + ".json"));
        }

        // The current export when it exists, else the fallback survey in the course folder.
        public static string TreesFile(GolfMapCourse course, string terrain)
        {
            var export = ExportFile(course, terrain, "trees");
            if (export != null && File.Exists(export)) return export;
            return string.IsNullOrEmpty(course.fallbackTreesFile) ? "" : Folder(course) + course.fallbackTreesFile;
        }

        // "GolfMapSpelunk/Vreta_tree_import.txt"
        public static string ReportPath(GolfMapCourse course, string suffix)
        {
            Directory.CreateDirectory("GolfMapSpelunk");
            return "GolfMapSpelunk/" + Name(course) + "_" + suffix;
        }

        [MenuItem("GolfMap/Course/Select active course")]
        static void SelectActive()
        {
            var course = Require();
            Selection.activeObject = course;
            EditorGUIUtility.PingObject(course);
        }

        [MenuItem("GolfMap/Course/New course for this scene")]
        static void NewForScene()
        {
            var scene = SceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(scene.name)) throw new InvalidOperationException("Save the scene first.");
            var path = EditorUtility.SaveFolderPanel("Course folder (under Assets/GolfMap)", Root, "");
            if (string.IsNullOrEmpty(path)) return;
            path = path.Replace('\\', '/');
            var data = Application.dataPath.Replace('\\', '/');
            if (!path.StartsWith(data + "/GolfMap/", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Choose a folder under Assets/GolfMap/.");
            var folder = "Assets" + path.Substring(data.Length) + "/";
            if (AssetDatabase.LoadAssetAtPath<GolfMapCourse>(folder + GolfMapCourse.AssetFileName)) throw new InvalidOperationException("That folder already holds a course.");
            var course = Create(folder, scene.name);
            Selection.activeObject = course;
            EditorGUIUtility.PingObject(course);
        }

        static GolfMapCourse Adopt()
        {
            if (!AssetDatabase.IsValidFolder(Root.TrimEnd('/'))) return null;
            var folders = AssetDatabase.GetSubFolders(Root.TrimEnd('/')).Where(f => File.Exists(f + "/palette.json")).ToArray();
            if (folders.Length != 1) return null;
            string name = Path.GetFileName(folders[0]);
            string scene = SceneManager.GetActiveScene().name;
            var course = Create(folders[0] + "/", scene.StartsWith(name, StringComparison.OrdinalIgnoreCase) ? scene : "");
            Debug.Log("[GolfMap] Adopted " + folders[0] + " as a course: " + AssetDatabase.GetAssetPath(course) + ". Review its settings.");
            return course;
        }

        // Defaults follow the pipeline's export naming: <name>-opcd beside the Unity
        // project, <name>-inner-trees.json, <Name>_lidar_inner terrain data.
        static GolfMapCourse Create(string folder, string sceneName)
        {
            string name = Path.GetFileName(folder.TrimEnd('/'));
            string lower = name.ToLowerInvariant();
            var course = ScriptableObject.CreateInstance<GolfMapCourse>();
            course.courseName = name;
            course.sceneName = sceneName;
            course.exportFolder = "../../" + lower + "-opcd";
            course.exportPrefix = lower;
            course.innerTerrainData = name + "_lidar_inner";
            if (File.Exists(folder + name + "_trees.json")) course.fallbackTreesFile = name + "_trees.json";
            AssetDatabase.CreateAsset(course, folder + GolfMapCourse.AssetFileName);
            AssetDatabase.SaveAssets();
            return course;
        }
    }
}
