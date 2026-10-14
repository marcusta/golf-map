// The GSPro course build without the GSP > Build Course window, so an agent can run the whole
// loop (Unity build, Arborist file, look in GSPro). It does what the window's Build button does,
// through OPCD's own builder (BuildCourseDLL.Encryption, reached by name: this file compiles
// without the DLL), and nothing more: same colliders switched off for the bundle, same
// encryption, same output <courses dir>/<scene>/<scene>.gspcrse.
// The bundle is built from the scene file on disk, so the open scene is saved first.
//
// The build holds the editor's main thread for minutes, so the bridge answers no
// command while it runs (and a build that takes the editor down answers nothing ever
// after). Progress therefore goes to a file the build writes at every milestone it
// can observe - GolfMapSpelunk/<Course>_build-status.json - which a second process
// polls through golfmap.course.build.status or reads straight off disk
// (unity/mcp/build-status.ts). Callers no longer have to guess from the .gspcrse mtime.
using System;
using System.Collections.Generic;
using System.Globalization;
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
            args = "dir (courses folder; default the one saved in the build window), saveBefore=true (save the open scene before building - the bundle is built from the file on disk; false refuses to build a dirty scene rather than saving it. NOT the other commands' save=..., which saves AFTER a command succeeded), terrainCollider=false, outerCollider=false, foliageCollider=false, grassesCollider=false (true keeps that terrain's collider in the bundle; the window's default switches all four off)")]
        static object Build(BridgeArgs a)
        {
            var file = StatusFile();
            var begun = DateTime.Now;
            var previous = PreviousResult(file);
            try { return Run(a, file, begun, previous); }
            catch (Exception e)
            {
                WriteStatus(file, false, begun, "failed", new Dictionary<string, object> { { "error", e.Message }, { "seconds", Elapsed(begun) } });
                throw;
            }
        }

        static object Run(BridgeArgs a, string statusFile, DateTime begun, object previous)
        {
            WriteStatus(statusFile, true, begun, "starting", previous);
            var builder = Named("BuildCourseDLL.Encryption");
            if (builder == null) throw new BridgeError("OPCD's course builder (BuildCourseDLL) is not in this project.");
            var scene = SceneManager.GetActiveScene();
            if (string.IsNullOrEmpty(scene.path)) throw new BridgeError("The open scene has never been saved.");
            if (scene.isDirty)
            {
                // `saveBefore`, not `save`: this one saves BEFORE the work (the bundle comes from the
                // file on disk) and defaults to true, the opposite of every other command's `save`,
                // which saves after a command succeeded and defaults to false (GolfMapSceneSave.cs).
                if (!a.Bool("saveBefore", true)) throw new BridgeError("The scene has unsaved changes, which a build would leave out. Save it or pass saveBefore=true.");
                WriteStatus(statusFile, true, begun, "saving-scene", previous);
                if (!EditorSceneManager.SaveScene(scene)) throw new BridgeError("Could not save " + scene.path + ".");
            }
            var asset = AssetDatabase.LoadAssetAtPath<SceneAsset>(scene.path);
            string dir = (a.String("dir") ?? CoursesDir()).Replace('\\', '/').TrimEnd('/');
            if (!Directory.Exists(dir)) throw new BridgeError("No courses folder at " + dir + ".");

            WriteStatus(statusFile, true, begun, "preparing", previous);
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
            // The long phase: nothing else runs on the main thread until it returns, so
            // this is the last word a poller sees for about 12 minutes.
            WriteStatus(statusFile, true, begun, "building-bundle", previous);
            try { builder.GetMethod("BuildBundle", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).Invoke(null, null); }
            catch (Exception e)
            {
                failure = (e.InnerException ?? e).Message;
                RestoreWind();
            }
            WriteStatus(statusFile, true, begun, failure == null ? "refreshing-vegetation" : "failed-restoring-wind", previous);
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
            var result = new Dictionary<string, object>
            {
                { "file", file }, { "megabytes", Math.Round(info.Length / 1048576.0, 1) }, { "written", info.LastWriteTime.ToString("s") },
                { "seconds", Math.Round((DateTime.Now - started).TotalSeconds) }, { "scene", scene.path }, { "sceneDirtyAfter", SceneManager.GetActiveScene().isDirty },
            };
            if (statusFile != null) result["statusFile"] = statusFile;
            WriteStatus(statusFile, false, begun, "done", result);
            return result;
        }

        // ---- Progress file ----

        const string StatusSuffix = "build-status.json";

        // Null when no single course claims the scene: the build still runs, without
        // progress reporting (the course only names the file; GolfMapCourses.Require()
        // keeps the name out of the code).
        static string StatusFile()
        {
            try { return GolfMapCourses.ReportPath(GolfMapCourses.Require(), StatusSuffix); }
            catch (Exception e)
            {
                Debug.LogWarning("[GolfMap] No course for the build status file (" + e.Message + "): this build reports no progress.");
                return null;
            }
        }

        static int Elapsed(DateTime since) { return (int)(DateTime.Now - since).TotalSeconds; }

        static void WriteStatus(string file, bool running, DateTime begun, string phase, object lastResult)
        {
            if (file == null) return;
            try
            {
                File.WriteAllText(file, BridgeJson.Write(new Dictionary<string, object>
                {
                    { "running", running },
                    // Whose editor it is: a build that took the editor down leaves running=true for
                    // ever, and only the pid tells a reader that nobody is building any more
                    // (unity/mcp/build-status.ts turns that into phase "interrupted").
                    { "pid", System.Diagnostics.Process.GetCurrentProcess().Id },
                    { "startedAt", begun.ToString("s") },
                    { "seconds", Elapsed(begun) },
                    { "phase", phase },
                    { "written", DateTime.Now.ToString("s") },
                    { "scene", SceneManager.GetActiveScene().path },
                    { "lastResult", lastResult },
                }));
            }
            catch (Exception e) { Debug.LogWarning("[GolfMap] Could not write " + file + ": " + e.Message); }
        }

        // What the last finished build left, carried along while a new one runs.
        static object PreviousResult(string file)
        {
            try
            {
                if (file == null || !File.Exists(file)) return null;
                var stored = BridgeJson.Parse(File.ReadAllText(file)) as Dictionary<string, object>;
                object value;
                return stored != null && stored.TryGetValue("lastResult", out value) ? value : null;
            }
            catch (Exception) { return null; }
        }

        [BridgeCommand("golfmap.course.build.status", "How far golfmap.course.build has got, read from the file that build writes (GolfMapSpelunk/<Course>_build-status.json): { running, pid (the editor that was building), startedAt, seconds (a running build: how long it has been going; a finished one: how long it took), phase (starting, saving-scene, preparing, building-bundle, refreshing-vegetation or failed-restoring-wind, done, failed, and interrupted for a build whose editor went down: running from a process that is not this editor), lastResult (the last finished build's result or its error) }. The editor answers no command while the build holds the main thread, so poll this from a second process, or read the file itself with 'bun unity/mcp/build-status.ts'.")]
        static object BuildStatus()
        {
            var file = GolfMapCourses.ReportPath(GolfMapCourses.Require(), StatusSuffix);
            var status = new Dictionary<string, object> { { "file", Path.GetFullPath(file).Replace('\\', '/') } };
            var stored = File.Exists(file) ? BridgeJson.Parse(File.ReadAllText(file)) as Dictionary<string, object> : null;
            if (stored == null)
            {
                status["running"] = false;
                status["phase"] = "never-run";
                status["pid"] = null;
                status["startedAt"] = null;
                status["seconds"] = 0;
                status["lastResult"] = null;
                return status;
            }
            foreach (var key in new[] { "running", "pid", "startedAt", "seconds", "phase", "written", "scene", "lastResult" })
            {
                object value;
                status[key] = stored.TryGetValue(key, out value) ? value : null;
            }
            // A running build cannot update its own file (the main thread is inside OPCD's
            // builder), so how long ago it started is the only live number there is.
            var startedAt = status["startedAt"] as string;
            DateTime started;
            bool running = status["running"] is bool && (bool)status["running"];
            if (running && startedAt != null &&
                DateTime.TryParse(startedAt, CultureInfo.InvariantCulture, DateTimeStyles.None, out started))
                status["seconds"] = Elapsed(started);
            // A build that is really running holds THIS editor's main thread, so a file that says
            // running from another process is one whose editor went down with the build in it.
            var pid = status["pid"] is double ? (int)(double)status["pid"] : 0;
            if (running && pid != 0 && pid != System.Diagnostics.Process.GetCurrentProcess().Id)
            {
                status["running"] = false;
                status["phase"] = "interrupted";
                status["note"] = "the file says a build was running in process " + pid + ", which is not this editor: that build's editor went down";
            }
            return status;
        }
    }
}
