// GolfMap commands for the editor bridge (Editor/GolfMapBridge). The bridge is
// course-agnostic; this is where GolfMap tooling exposes itself to it. Add a
// command here when an agent keeps needing a planter step the menus don't reach.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;

namespace GolfMap.Editor
{
    static class GolfMapBridgeCommands
    {
        [BridgeCommand("golfmap.trees.plant", "The Tree Planter's 'Plant' for one area without its window: re-reads the area's trees file (<prefix>-<terrain>-trees.json, the panel's own setting), replaces that area's imported trees with it (never appends; manual tree edits are applied as in the window; a planting backup is written first) and returns the planter's status text. check=true is the panel's 'Load and check': nothing is planted. ignoreAlignment=true/false sets the panel's 'Plant even if misaligned' (kept on the component) before the run. Marks the scene dirty; save=true saves it (and the assets it changed) once the plant has succeeded.",
            args = "terrain=inner|outer, check=false, ignoreAlignment (omit to keep the panel's), " + GolfMapSceneSave.Arg)]
        static object PlantTrees(BridgeArgs a)
        {
            var terrain = a.String("terrain", "inner");
            if (terrain != "inner" && terrain != "outer") throw new System.InvalidOperationException("terrain must be inner or outer.");
            var host = GolfMapTreePlanter.Host();
            var component = terrain == "outer" ? GolfMapTreePlanter.Outer(host) : host;
            bool check = a.Bool("check", false);
            if (a.Has("ignoreAlignment")) { component.ignoreAlignment = a.Bool("ignoreAlignment", false); EditorUtility.SetDirty(component); }
            var status = GolfMapTreePlanter.For(component).RunFromBridge(!check);
            // check=true plants nothing, so the bridge's save hook must treat it as the dry run it is.
            return new System.Collections.Generic.Dictionary<string, object>
                { { "terrain", terrain }, { "planted", !check }, { "dryRun", check }, { "file", component.filePath }, { "status", status } };
        }

        [BridgeCommand("golfmap.course", "The active GolfMap course and every course in the project: folder, scene, palette, export files (present, size, modified) and reports.")]
        static object Course()
        {
            GolfMapCourse active = null;
            string problem = null;
            try { active = GolfMapCourses.Require(); }
            catch (InvalidOperationException e) { problem = e.Message; }
            return new Dictionary<string, object>
            {
                { "active", active == null ? null : Describe(active, true) },
                { "problem", problem },
                { "courses", GolfMapCourses.All().Select(c => (object)Describe(c, false)).ToList() },
            };
        }

        static Dictionary<string, object> Describe(GolfMapCourse course, bool files)
        {
            var d = new Dictionary<string, object>
            {
                { "name", GolfMapCourses.Name(course) },
                { "asset", AssetDatabase.GetAssetPath(course) },
                { "folder", GolfMapCourses.Folder(course) },
                { "scene", course.sceneName },
                { "exportFolder", course.exportFolder },
                { "exportPrefix", course.exportPrefix },
                { "innerTerrain", course.innerTerrainName },
                { "outerTerrain", course.outerTerrainName },
            };
            if (!files) return d;
            d["palette"] = FileInfo(GolfMapCourses.PalettePath(course));
            var exports = new Dictionary<string, object>();
            foreach (var terrain in new[] { "inner", "outer" })
                foreach (var kind in new[] { "trees", "zones" })
                {
                    var path = GolfMapCourses.ExportFile(course, terrain, kind);
                    if (path != null) exports[terrain + "-" + kind] = FileInfo(path);
                }
            d["exports"] = exports;
            d["treesFile"] = new Dictionary<string, object> { { "inner", GolfMapCourses.TreesFile(course, "inner") }, { "outer", GolfMapCourses.TreesFile(course, "outer") } };
            var prefix = GolfMapCourses.Name(course) + "_";
            d["reports"] = Directory.Exists("GolfMapSpelunk")
                ? Directory.GetFiles("GolfMapSpelunk", prefix + "*").Select(f => (object)FileInfo(f)).ToList()
                : new List<object>();
            return d;
        }

        static Dictionary<string, object> FileInfo(string path)
        {
            var full = Path.GetFullPath(path).Replace('\\', '/');
            var info = new System.IO.FileInfo(full);
            return new Dictionary<string, object>
            {
                { "path", full },
                { "exists", info.Exists },
                { "bytes", info.Exists ? info.Length : 0 },
                { "modified", info.Exists ? info.LastWriteTime.ToString("s") : null },
            };
        }
    }
}
