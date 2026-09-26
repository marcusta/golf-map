// Bridge commands for the Vegetation Zones importer: the window's Load and
// check / Preview import / Import buttons without the window, so an agent can
// export zones (scripts/gspro-export.ts) and import them in one go. Same code
// path: a hidden importer instance runs the window's own load, terrain match,
// validation, plan and VSP import, so the result and the report are identical.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEngine;

namespace GolfMap.Editor
{
    public partial class GolfMapZoneImporter
    {
        [BridgeCommand("golfmap.zones.check", "Load a unity-zones-v2 export and check it against the scene: target terrain, VSP system, package, and the import plan (groups to create/delete, rules to add/remove, missing and unbound items). Changes nothing.",
            args = "terrain=inner|outer (the active course's export) or file, package (name; default: the lower-vegetation package)")]
        static object BridgeCheck(BridgeArgs a)
        {
            return WithImporter(a, w => Result(w, false));
        }

        [BridgeCommand("golfmap.zones.import", "Import a zones export into VSP (mask textures, one mask group per item, the items' density/include rules; deletes stale golfmap-zone groups and their rules), like the window's Import button. Writes the package asset and marks the scene dirty; does not save the scene. dryRun=true validates the target and returns the plan without writing anything.",
            args = "terrain=inner|outer or file, package (name), dryRun=false")]
        static object BridgeImport(BridgeArgs a)
        {
            return WithImporter(a, w =>
            {
                w.ValidateTarget();
                bool dryRun = a.Bool("dryRun", false);
                if (dryRun) w.PreviewVsp(); else w.ImportVsp();
                var result = Result(w, !dryRun);
                result["dryRun"] = dryRun;
                return result;
            });
        }

        static object WithImporter(BridgeArgs a, Func<GolfMapZoneImporter, object> action)
        {
            var w = CreateInstance<GolfMapZoneImporter>();
            try
            {
                w.filePath = ZonesFile(a);
                w.loaded = GolfMapZones.Load(w.filePath);
                w.loadedPath = w.filePath;
                w.MatchTerrain(false);
                w.OnFileLoaded();
                var package = a.String("package");
                if (package != null)
                {
                    var names = w.Packages.Select(p => p.PackageName).ToList();
                    w.packageIndex = names.IndexOf(package);
                    if (w.packageIndex < 0) throw new BridgeError("No package '" + package + "' in the system. Packages: " + string.Join(", ", names.ToArray()));
                }
                w.status = w.Summary();
                return action(w);
            }
            finally
            {
                DestroyImmediate(w);
            }
        }

        static string ZonesFile(BridgeArgs a)
        {
            if (a.Has("file")) return Path.GetFullPath(a.String("file"));
            var terrain = a.String("terrain");
            if (terrain != "inner" && terrain != "outer") throw new BridgeError("Give terrain=inner|outer or file=<path to a -zones.json>.");
            var file = GolfMapCourses.ExportFile(GolfMapCourses.Require(), terrain, "zones");
            if (file == null) throw new BridgeError("The active course names no export folder/prefix.");
            if (!File.Exists(file)) throw new BridgeError(file + " does not exist. Export it first: bun run gspro:export -- <course> zones:" + terrain);
            return file;
        }

        static Dictionary<string, object> Result(GolfMapZoneImporter w, bool imported)
        {
            return new Dictionary<string, object>
            {
                { "file", w.filePath },
                { "format", w.loaded != null ? w.loaded.format : null },
                { "terrain", w.terrain ? w.terrain.name : null },
                { "system", w.VspSystem ? w.VspSystem.name : null },
                { "package", w.Package ? w.Package.PackageName : null },
                { "packages", w.Packages.Select(p => (object)p.PackageName).ToList() },
                { "imported", imported },
                { "warnings", w.loaded != null ? w.loaded.warnings.Select(s => (object)s).ToList() : new List<object>() },
                { "plan", w.lastPlan != null ? PlanJson(w.lastPlan) : null },
                { "status", w.status },
            };
        }
    }
}
