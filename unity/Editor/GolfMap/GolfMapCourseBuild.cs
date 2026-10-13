// The GSPro course build without the GSP > Build Course window, so an agent can run the whole
// loop (Unity build, Arborist file, look in GSPro). It does what the window's Build button does,
// through OPCD's own builder (BuildCourseDLL.Encryption, reached by name: this file compiles
// without the DLL), and nothing more: same colliders switched off for the bundle, same
// encryption, same output <courses dir>/<scene>/<scene>.gspcrse.
// The bundle is built from the scene file on disk, so the open scene is saved first.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    static class GolfMapCourseBuild
    {
        static Type Named(string fullName)
        {
            return AppDomain.CurrentDomain.GetAssemblies().Select(a => a.GetType(fullName, false)).FirstOrDefault(t => t != null);
        }

        static void Set(Type type, string field, object value)
        {
            var f = type.GetField(field, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            if (f == null) throw new BridgeError("OPCD's builder has no field '" + field + "' (another version of BuildCourseDLL?).");
            f.SetValue(null, value);
        }

        static string CoursesDir()
        {
            var saved = Resources.Load("OPCDThemes/Store/BuildCourseSaveLocation");
            var field = saved ? saved.GetType().GetField("GSPCoursesDirectory") : null;
            var dir = field != null ? field.GetValue(saved) as string : null;
            return string.IsNullOrEmpty(dir) ? "C:/GSProV1/Core/GSP/Courses" : dir;
        }

        // The window's own recovery when the build throws: its builder has destroyed the scene's
        // wind zone by then.
        static void RestoreWind()
        {
            var activator = GameObject.Find("ArboreumWindActivator");
            var prefab = Resources.Load<GameObject>("SceneWindZone");
            if (prefab) UnityEngine.Object.Instantiate(prefab, Vector3.zero, Quaternion.identity).name = "SceneWindZone";
            var wind = activator ? activator.GetComponent("ArboreumWind") : null;
            if (wind) wind.GetType().GetMethod("FindWindZone").Invoke(wind, null);
        }

        [BridgeCommand("golfmap.course.build", "Build the open scene into the GSPro course file, as GSP > Build Course's Build button does (OPCD's builder; takes minutes and the editor does not answer meanwhile, so call with a long timeout and expect the call to return late). The open scene is saved first: the bundle is built from the file on disk. Returns the course file with its size and time.",
            args = "dir (courses folder; default the one saved in the build window), save=true, terrainCollider=false, outerCollider=false, foliageCollider=false, grassesCollider=false (true keeps that terrain's collider in the bundle; the window's default switches all four off)")]
        static object Build(BridgeArgs a)
        {
            var builder = Named("BuildCourseDLL.Encryption");
            if (builder == null) throw new BridgeError("OPCD's course builder (BuildCourseDLL) is not in this project.");
            var scene = SceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(scene.path)) throw new BridgeError("The open scene has never been saved.");
            if (scene.isDirty)
            {
                if (!a.Bool("save", true)) throw new BridgeError("The scene has unsaved changes, which a build would leave out. Save it or pass save=true.");
                if (!EditorSceneManager.SaveScene(scene)) throw new BridgeError("Could not save " + scene.path + ".");
            }
            var asset = AssetDatabase.LoadAssetAtPath<SceneAsset>(scene.path);
            string dir = (a.String("dir") ?? CoursesDir()).Replace('\\', '/').TrimEnd('/');
            if (!Directory.Exists(dir)) throw new BridgeError("No courses folder at " + dir + ".");

            Set(builder, "TerrainColDisable", !a.Bool("terrainCollider", false));
            Set(builder, "GrassesColDisable", !a.Bool("grassesCollider", false));
            Set(builder, "FoliageColDisable", !a.Bool("foliageCollider", false));
            Set(builder, "OuterColDisable", !a.Bool("outerCollider", false));
            Set(builder, "MyScene", asset);
            Set(builder, "gspdir", dir);
            var started = DateTime.Now;
            builder.GetMethod("DisableTerrains", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Invoke(null, null);
            var colliders = UnityEngine.Object.FindObjectOfType<AwesomeTechnologies.ColliderSystem.ColliderSystemPro>();
            if (colliders) colliders.enabled = true;
            string failure = null;
            try { builder.GetMethod("BuildBundle", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Invoke(null, null); }
            catch (Exception e)
            {
                failure = (e.InnerException ?? e).Message;
                RestoreWind();
            }
            foreach (var system in UnityEngine.Object.FindObjectsOfType<AwesomeTechnologies.VegetationSystem.VegetationSystemPro>())
            {
                system.SelectedWindZone = UnityEngine.Object.FindObjectOfType<WindZone>();
                system.UpdateWindSettings();
                system.RefreshVegetationSystem();
            }
            if (failure != null) throw new BridgeError("The course build failed: " + failure + " (the wind zone was put back, as the build window does).");

            string file = dir + "/" + asset.name + "/" + asset.name + ".gspcrse";
            var info = new FileInfo(file);
            if (!info.Exists || info.LastWriteTime < started) throw new BridgeError("The build ran but left no new " + file + ".");
            return new Dictionary<string, object>
            {
                { "file", file }, { "megabytes", Math.Round(info.Length / 1048576.0, 1) }, { "written", info.LastWriteTime.ToString("s") },
                { "seconds", Math.Round((DateTime.Now - started).TotalSeconds) }, { "scene", scene.path }, { "sceneDirtyAfter", SceneManager.GetActiveScene().isDirty },
            };
        }
    }
}
