// Unity 2018.2 / C# 6. golfmap.course.refresh: step 5 of the Blender shaping loop (blender/SHAPING-PLAN.md) - after
// shape_apply exported changed FBX, bring the course in Unity in step with them by chaining the existing tools in
// the order they depend on each other:
//   1. meshes.sync (GolfMapCourseMeshes)      replace changed FBX objects, add new, prune stale
//   2. OPCD default materials                 part of 1: OPCD's Set Default Materials on the objects it (re)made
//   3. bunker materials (GolfMapBunkerMaterials) re-apply the paint convention (OPCD's defaults undo it)
//   3b. path materials (GolfMapPathMaterials)  each path its surface on OPCD MAHS + fringe fades, pathLook=surface|photo (OPCD's defaults undo surface)
//   4. paint.apply (GolfMapVertexPaint)       vertex paint + stone-wall ground on the new geometry
//   4b. roughgrass.plant (GolfMapRoughGrass)  Stix 3D grass on the roughs and bunker lips (re-added meshes lack it)
//   5. terrain.conform mode=match             terrain both ways to just under the meshes, feathered out
//   6. waterplanes.build                      lake planes refilled from the new lake meshes
//   7. creeks.import                          R.A.M. creeks refitted to the new banks
//   8. walls.build                            stone walls rebuilt on the reshaped ground
//   9. surfaces.export                        surface map for pipeline grass_zones
// Not automatic, reported as pending: grass zones (pipeline grass:zones, then zones.import + grass.apply) and
// props.place (it would drop props moved by hand; capture them into the spec first).
// dryRun=true runs each step's own dry run where it has one that changes nothing, and lists the others as
// "would run"; every plan is measured on the scene as it is now, without the earlier steps' changes.
// The report goes to <course>/refresh-report.json (dry run: GolfMapSpelunk/<Course>_refresh-report.dryrun.json,
// outside Assets, so a plan writes no project asset).
//
// only=<object names> (the per-feature loop: the shaping worker's changedObjects; object = FBX name without extension)
// does the same for those objects and the ground around them only (RefreshOnly): meshes.sync imports just their FBX
// (ImportAsset each) and swaps their objects, prunes only named objects whose FBX is gone; OPCD default materials on
// them; the bunker convention on the bunker sets they belong to; paint on them and the meshes within their bounds +
// featherM; terrain match inside the union of their bounds + featherM; a lake's plane only when a named lake has one
// of ours; creeks only when a creek mesh is named (the creeks crossing it); walls only when a wall's bank meets them;
// surfaces.export is re-run when a rock slab is among them (else left for later, pending). Where each object is: the scene object (before and after the swap,
// both), else its imported FBX, else the shaping report's place for it (a dry run of meshes not imported yet).
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    static class GolfMapCourseRefresh
    {
        public const string ReportFile = "refresh-report.json";
        public const string DryRunSuffix = "refresh-report.dryrun.json";
        const string Format = "golfmap-refresh-report-v1";
        const string WallsSpec = "stone-walls.json";

        [MenuItem("GolfMap/Course/Refresh after Blender export (dry run)")]
        static void DryRunMenu() { RunFromMenu(new BridgeArgs(new Dictionary<string, object> { { "dryRun", true } })); }

        [MenuItem("GolfMap/Course/Refresh after Blender export")]
        static void Menu()
        {
            if (!EditorUtility.DisplayDialog("Refresh course", "Sync the course meshes from the FBX folder (pruning stale ones), re-apply bunker materials and vertex paint, match the terrain to the meshes, rebuild water planes, creeks and stone walls, and export the surface map? Props are not re-placed. The scene is marked dirty, not saved.", "Refresh", "Cancel")) return;
            RunFromMenu(new BridgeArgs(null));
        }

        static void RunFromMenu(BridgeArgs a)
        {
            var steps = Refresh(a);
            EditorApplication.CallbackFunction tick = null;
            tick = () =>
            {
                try
                {
                    if (!steps.MoveNext()) { EditorApplication.update -= tick; return; }
                    if (steps.Current == null) return;
                    EditorApplication.update -= tick;
                    Debug.Log("[GolfMap Refresh] " + GolfMapJson.Serialize(steps.Current));
                }
                catch (Exception e) { EditorApplication.update -= tick; Debug.LogException(e); }
            };
            EditorApplication.update += tick;
        }

        [BridgeCommand("golfmap.course.refresh", "After a Blender shaping run: bring the course in step with the exported FBX by chaining meshes.sync (prune; OPCD Set Default Materials on what it re-adds), Bunker Materials (paint convention), paths.materials (cart path look), paint.apply, roughgrass.plant (Stix grass on roughs + bunker lips), terrain.conform mode=match, waterplanes.build, creeks.import (refit), walls.build and surfaces.export. Grass zones (pipeline grass:zones -> zones.import -> grass.apply) and props.place (hand-moved props) are reported as pending manual steps. dryRun runs each step's own dry run where it has a side-effect-free one and lists the rest as 'would run'. Writes <course>/refresh-report.json (dry run: GolfMapSpelunk/<Course>_refresh-report.dryrun.json). Marks the scene dirty; save=true saves it once, after the last step, when no step failed.",
            args = "only (comma-separated object names = FBX names without extension: the fast per-feature path - just those FBX re-imported and swapped, bunker convention on their sets, paint and terrain match only within their bounds + featherM, water/creeks/walls only where they are concerned, surfaces.export only when a rock slab is among them, else pending), dryRun=false, prune=true, folder (FBX folder under Assets; default the course's meshFolder), parent, convention (bunker paint convention id; default the Bunker Materials window's), conventionFile, margin=0.01, featherM=2 (terrain match; with only also the paint scope), grassMaterial=NewRough, lipGrass=true (Stix grass on the bunker blends too), pathLook=surface|photo (cart path material: surface = golfmap.paths.materials' per-surface OPCD MAHS material (satellite off) and fringe strips fading into their neighbour, photo = OPCD's satellite concrete), skip (step ids, comma-separated: meshes.sync, bunkers.materials, paths.materials, paint.apply, roughgrass.plant, terrain.conform, waterplanes.build, creeks.import, walls.build, surfaces.export), continueOnError=false, " + GolfMapSceneSave.Arg + " - once, after the last step; the chained steps never save of their own, and a run with a failed step does not save")]
        static IEnumerator Command(BridgeArgs a) { return Refresh(a); }

        sealed class Step
        {
            public string id, label, status, note, error;
            public object result;
            public double seconds;

            public Dictionary<string, object> ToJson()
            {
                var d = new Dictionary<string, object> { { "id", id }, { "label", label }, { "status", status } };
                if (note != null) d["note"] = note;
                if (error != null) d["error"] = error;
                if (result != null) d["result"] = Trim(result);
                d["seconds"] = Math.Round(seconds, 2);
                return d;
            }
        }

        static object RoughGrass(BridgeArgs a, bool dryRun)
        {
            var lip = new GolfMapRoughGrass.LipOptions { enabled = a.Bool("lipGrass", true) };
            return GolfMapRoughGrass.Plant(a.String("grassMaterial", GolfMapRoughGrass.DefaultMaterial), lip, dryRun);
        }

        static IEnumerator Refresh(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().ToList();
            if (only.Count > 0) return RefreshOnly(a, only);
            if (a.Has("only")) throw new BridgeError("only= names no object.");
            return RefreshAll(a);
        }

        static IEnumerator RefreshAll(BridgeArgs a)
        {
            bool dryRun = a.Bool("dryRun", false);
            bool continueOnError = a.Bool("continueOnError", false);
            var skip = new HashSet<string>(a.Strings("skip").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0));
            var course = GolfMapCourses.Require();
            // read everything from the course now: OPCD's Set Default Materials unloads unused assets, the course with them
            var courseFolder = GolfMapCourses.Folder(course);
            var courseName = GolfMapCourses.Name(course);
            var reportPath = dryRun ? GolfMapCourses.ReportPath(course, DryRunSuffix) : courseFolder + ReportFile;
            var creeksExport = GolfMapCourses.ExportFile(course, "inner", "creeks");
            var exportPrefix = course.exportPrefix;
            course = null;
            var started = DateTime.Now;
            var steps = new List<Step>();
            bool failed = false;

            Func<string, string, bool> begin = (id, label) =>
            {
                if (skip.Contains(id)) { steps.Add(new Step { id = id, label = label, status = "skipped", note = "skip=" + id }); return false; }
                if (failed && !dryRun) { steps.Add(new Step { id = id, label = label, status = "not run", note = "an earlier step failed" }); return false; }
                return true;
            };
            Action<string, string, Func<object>, string> run = (id, label, f, doneStatus) =>
            {
                if (!begin(id, label)) return;
                var s = new Step { id = id, label = label };
                var t = DateTime.Now;
                try { s.result = f(); s.status = doneStatus; }
                catch (Exception e) { s.status = "failed"; s.error = e.Message; failed |= !continueOnError; Debug.LogException(e); }
                s.seconds = (DateTime.Now - t).TotalSeconds;
                steps.Add(s);
            };
            string planned = dryRun ? "planned" : "done";

            // 1 + 2. meshes.sync, with OPCD's Set Default Materials on every object it adds or replaces
            Dictionary<string, object> sync = null;
            run("meshes.sync", "Course meshes from the FBX folder (prune stale)", () =>
                sync = GolfMapCourseMeshes.Sync(dryRun, a.Bool("prune", true), false, a.String("folder"), a.String("parent"), false, null, !dryRun), planned);
            if (sync != null)
            {
                int n = ((List<object>)sync["added"]).Count + ((List<object>)sync["replaced"]).Count;
                steps.Add(new Step
                {
                    id = "opcd.materials", label = "OPCD default materials", status = dryRun ? "would run" : "done",
                    note = (dryRun ? "would run" : "ran") + " inside meshes.sync (GameObject/Set Default Materials) on the " + n + " added/replaced object(s)"
                        + (dryRun && sync.ContainsKey("firstSync") && (bool)sync["firstSync"] ? "; first sync: nothing is replaced, the scene is recorded" : ""),
                });
            }
            else steps.Add(new Step { id = "opcd.materials", label = "OPCD default materials", status = skip.Contains("meshes.sync") ? "skipped" : "not run", note = "part of meshes.sync" });

            // 3. the bunker paint convention (Set Default Materials puts OPCD's own bunker materials back)
            run("bunkers.materials", "Bunker Materials convention", () => GolfMapBunkerMaterials.ApplyConvention(a.String("conventionFile"), a.String("convention"), dryRun), planned);

            // 3b. the cart path look (Set Default Materials puts OPCD's satellite concrete back on a re-added path)
            run("paths.materials", "Cart path look (" + a.String("pathLook", GolfMapPathMaterials.DefaultLook) + ")", () =>
                GolfMapPathMaterials.Apply(a.String("pathLook", GolfMapPathMaterials.DefaultLook), dryRun), planned);

            // 3c. rock slabs: their rock material and stone physics (Set Default Materials knows no such surface)
            run("slabs.materials", "Rock slab material and physics", () => GolfMapRockSlabs.Apply(dryRun), planned);

            // 4. vertex paint (+ the stone-wall ground reshape)
            run("paint.apply", "Vertex paint (and stone-wall ground)", () => WithoutKey(GolfMapVertexPaint.Apply(dryRun), "meshes"), planned);

            // 4b. Stix 3D grass on the roughs and the bunker lips (re-added meshes come without it)
            run("roughgrass.plant", "3D grass on the roughs and bunker lips", () => RoughGrass(a, dryRun), planned);

            // 5. terrain to the meshes, both ways
            if (begin("terrain.conform", "Terrain matched to the meshes"))
            {
                var s = new Step { id = "terrain.conform", label = "Terrain matched to the meshes" };
                var args = new Dictionary<string, object> { { "mode", "match" }, { "dryRun", dryRun }, { "margin", a.Number("margin", 0.01) }, { "featherM", a.Number("featherM", 2) } };
                var drive = Drive(() => GolfMapTerrainConform.Conform(new BridgeArgs(args)), s);
                while (drive.MoveNext()) yield return null;
                if (s.status == null) s.status = planned;
                if (s.error != null) failed |= !continueOnError;
                if (dryRun) s.note = "measured on the meshes in the scene now (before the sync)";
                steps.Add(s);
            }

            // 6. lake water planes: only those that already have a plane of ours are rebuilt (a rebuild keeps each plane's
            // lift); lakes without one are listed, not given a plane
            run("waterplanes.build", "Lake water planes (every lake; ours rebuilt keeping their lift)", () => Waterplanes(dryRun), planned);

            // 7. creeks refitted to the new banks
            if (string.IsNullOrEmpty(creeksExport) || !File.Exists(creeksExport))
                steps.Add(new Step { id = "creeks.import", label = "Creeks refit (R.A.M.)", status = "skipped", note = "no creeks export at " + (creeksExport ?? "(no export folder)") });
            else
                run("creeks.import", "Creeks refit (R.A.M.)", () => Creeks(dryRun), planned);

            // 8. stone walls on the reshaped ground (its own dry run prepares the stone models: import settings and
            // material assets, so a plan only reads the spec)
            if (!File.Exists(courseFolder + WallsSpec))
                steps.Add(new Step { id = "walls.build", label = "Stone walls", status = "skipped", note = "no " + courseFolder + WallsSpec });
            else if (dryRun)
            {
                if (begin("walls.build", "Stone walls"))
                    steps.Add(new Step { id = "walls.build", label = "Stone walls", status = "would run", result = WallsPlan(courseFolder + WallsSpec),
                        note = "walls.build's own dryRun is not used: it prepares the stone models (FBX import settings, materials). Stones moved by hand and not captured as a pose in the generator are replaced." });
            }
            else run("walls.build", "Stone walls", () => GolfMapWalls.Build(null, null, false, 0, null, false), "done");

            // 9. the surface map grass_zones reads
            if (dryRun)
            {
                if (begin("surfaces.export", "Surface map for grass zones"))
                    steps.Add(new Step { id = "surfaces.export", label = "Surface map for grass zones", status = "would run", note = "writes " + exportPrefix + "-inner-surfaces.bin/.json/-preview.png to the export folder (no dry run)" });
            }
            else if (begin("surfaces.export", "Surface map for grass zones"))
            {
                var s = new Step { id = "surfaces.export", label = "Surface map for grass zones" };
                var drive = Drive(() => GolfMapSurfaces.Export(new BridgeArgs(new Dictionary<string, object> { { "terrain", "inner" } })), s);
                while (drive.MoveNext()) yield return null;
                if (s.status == null) s.status = "done";
                if (s.error != null) failed |= !continueOnError;
                steps.Add(s);
            }

            var pending = new List<object>
            {
                "Grass zones: bun run grass:zones -- <course> (pipeline grass_zones.py reads the new surface map), then golfmap.zones.import terrain=inner and golfmap.grass.apply.",
                "Props: golfmap.props.place is not re-run automatically (it replaces every prop, hand moves included). Capture moved/rotated props into the props spec first, then golfmap.props.place.",
            };
            if (dryRun) pending.Insert(0, "This was a dry run: nothing changed. Run golfmap.course.refresh without dryRun to apply.");

            var report = new Dictionary<string, object>
            {
                { "format", Format }, { "course", courseName }, { "scene", EditorSceneManager.GetActiveScene().name },
                { "dryRun", dryRun }, { "started", started.ToString("yyyy-MM-ddTHH:mm:ss") }, { "seconds", Math.Round((DateTime.Now - started).TotalSeconds, 1) },
                { "failed", steps.Any(s => s.status == "failed") },
                { "steps", steps.Select(s => (object)s.ToJson()).ToList() },
                { "pending", pending },
                { "report", reportPath },
            };
            File.WriteAllText(reportPath, GolfMapJson.Serialize(report) + "\n");
            yield return report;
        }

        // ------------------------------------------------------------ only=: the per-feature path (see the header)

        const string LakeSuffix = "_Water_Base_Lake_-_Mesh";

        static IEnumerator RefreshOnly(BridgeArgs a, List<string> only)
        {
            bool dryRun = a.Bool("dryRun", false);
            bool continueOnError = a.Bool("continueOnError", false);
            var skip = new HashSet<string>(a.Strings("skip").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0));
            float featherM = Mathf.Clamp((float)a.Number("featherM", 2), 0f, 50f);
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);
            var courseName = GolfMapCourses.Name(course);
            var reportPath = dryRun ? GolfMapCourses.ReportPath(course, DryRunSuffix) : courseFolder + ReportFile;
            var creeksExport = GolfMapCourses.ExportFile(course, "inner", "creeks");
            var exportPrefix = course.exportPrefix;
            var meshFolder = "Assets/" + (a.String("folder") ?? course.meshFolder).Trim('/', '\\').Replace('\\', '/');
            course = null;   // OPCD's Set Default Materials unloads it (see RefreshAll)
            var started = DateTime.Now;
            var steps = new List<Step>();
            bool failed = false;
            string planned = dryRun ? "planned" : "done";

            Func<string, string, bool> begin = (id, label) =>
            {
                if (skip.Contains(id)) { steps.Add(new Step { id = id, label = label, status = "skipped", note = "skip=" + id }); return false; }
                if (failed && !dryRun) { steps.Add(new Step { id = id, label = label, status = "not run", note = "an earlier step failed" }); return false; }
                return true;
            };
            Action<string, string, Func<object>, string> run = (id, label, f, doneStatus) =>
            {
                if (!begin(id, label)) return;
                var s = new Step { id = id, label = label };
                var t = DateTime.Now;
                try { s.result = f(); s.status = doneStatus; }
                catch (Exception e) { s.status = "failed"; s.error = e.Message; failed |= !continueOnError; Debug.LogException(e); }
                s.seconds = (DateTime.Now - t).TotalSeconds;
                steps.Add(s);
            };
            Action<string, string, string> notNeeded = (id, label, why) => steps.Add(new Step { id = id, label = label, status = "skipped", note = why });

            // Where the named objects are, before the sync (the old shapes: a bunker that shrank leaves ground to match).
            var t0 = DateTime.Now;
            var where = Locate(only, meshFolder);
            var locateSeconds = (DateTime.Now - t0).TotalSeconds;

            // 1 + 2. just their FBX, OPCD's Set Default Materials on what it (re)adds
            Dictionary<string, object> sync = null;
            run("meshes.sync", "Named meshes from the FBX folder (ImportAsset each, swap, prune gone)", () =>
                sync = GolfMapCourseMeshes.Sync(dryRun, a.Bool("prune", true), false, a.String("folder"), a.String("parent"), false, null, !dryRun, only), planned);
            if (sync != null)
            {
                int n = ((List<object>)sync["added"]).Count + ((List<object>)sync["replaced"]).Count;
                steps.Add(new Step
                {
                    id = "opcd.materials", label = "OPCD default materials", status = dryRun ? "would run" : "done",
                    note = (dryRun ? "would run" : "ran") + " inside meshes.sync (GameObject/Set Default Materials) on the " + n + " added/replaced object(s)",
                });
            }
            else steps.Add(new Step { id = "opcd.materials", label = "OPCD default materials", status = skip.Contains("meshes.sync") ? "skipped" : "not run", note = "part of meshes.sync" });

            // after the swap: the new shapes too (a dry run keeps the plan's)
            if (!dryRun)
                foreach (var kv in Locate(only, meshFolder))
                {
                    Located old;
                    if (where.TryGetValue(kv.Key, out old) && old.from == "scene")
                    {
                        var b = old.bounds; b.Encapsulate(kv.Value.bounds);
                        where[kv.Key] = new Located { bounds = b, from = "scene (before + after)" };
                    }
                    else where[kv.Key] = kv.Value;
                }
            var boxes = where.Values.Select(l => l.bounds).ToList();
            var grown = boxes.Select(b => Rect.MinMaxRect(b.min.x - featherM, b.min.z - featherM, b.max.x + featherM, b.max.z + featherM)).ToList();
            var paintBoxes = boxes.Select(b => { var g = b; g.Expand(new Vector3(2 * featherM, 0, 2 * featherM)); return g; }).ToList();

            // 3. the bunker convention on the sets they belong to
            if (!only.Any(n => GolfMapBunkerMaterials.SetKey(n) != null))
                notNeeded("bunkers.materials", "Bunker Materials convention", "no bunker or bunker blend among them");
            else
                run("bunkers.materials", "Bunker Materials convention (their bunker sets)", () =>
                    GolfMapBunkerMaterials.ApplyConvention(a.String("conventionFile"), a.String("convention"), dryRun, only), planned);

            // 3b. the cart path look on the named path meshes
            if (!only.Any(GolfMapPathMaterials.IsPathMesh))
                notNeeded("paths.materials", "Cart path look", "no path mesh (*Concrete*) among them");
            else
                run("paths.materials", "Cart path look (" + a.String("pathLook", GolfMapPathMaterials.DefaultLook) + ", named path meshes)", () =>
                    GolfMapPathMaterials.Apply(a.String("pathLook", GolfMapPathMaterials.DefaultLook), dryRun, only), planned);

            // 3c. rock slabs among them: rock material and stone physics
            if (!only.Any(GolfMapRockSlabs.IsSlab))
                notNeeded("slabs.materials", "Rock slab material and physics", "no rock slab (*_Rock_-_Mesh) among them");
            else
                run("slabs.materials", "Rock slab material and physics (named slabs)", () => GolfMapRockSlabs.Apply(dryRun, only), planned);

            // 4. paint on them and the meshes around them
            if (boxes.Count == 0)
                notNeeded("paint.apply", "Vertex paint (and stone-wall ground)", "none of them is in the scene, the FBX folder or the shaping report");
            else
                run("paint.apply", "Vertex paint (and stone-wall ground) within their bounds + featherM", () => WithoutKey(GolfMapVertexPaint.Apply(dryRun, only, paintBoxes), "meshes"), planned);

            // 4b. Stix 3D grass: a replaced rough or bunker blend comes back without its GrassRenderer (cheap: whole course)
            run("roughgrass.plant", "3D grass on the roughs and bunker lips", () => RoughGrass(a, dryRun), planned);

            // 5. terrain match inside the union of their bounds + featherM
            if (boxes.Count == 0) notNeeded("terrain.conform", "Terrain matched to the meshes", "no bounds for any of them");
            else if (begin("terrain.conform", "Terrain matched to the meshes (their bounds + featherM)"))
            {
                var s = new Step { id = "terrain.conform", label = "Terrain matched to the meshes (their bounds + featherM)" };
                var args = new Dictionary<string, object> { { "mode", "match" }, { "dryRun", dryRun }, { "margin", a.Number("margin", 0.01) }, { "featherM", featherM } };
                var drive = Drive(() => GolfMapTerrainConform.Conform(new BridgeArgs(args), grown), s);
                while (drive.MoveNext()) yield return null;
                if (s.status == null) s.status = planned;
                if (s.error != null) failed |= !continueOnError;
                if (dryRun) s.note = "measured on the meshes in the scene now (before the sync)";
                steps.Add(s);
            }

            // 6. a named lake's plane, when it has one of ours
            var lakes = only.Where(n => n.EndsWith(LakeSuffix, StringComparison.Ordinal)).ToList();
            if (lakes.Count == 0) notNeeded("waterplanes.build", "Lake water planes", "no lake among them");
            else run("waterplanes.build", "Lake water planes (named lakes)", () => Waterplanes(dryRun, lakes), planned);

            // 7. creeks: those crossing a named creek mesh
            var creekMeshes = only.Where(IsCreekMesh).ToList();
            if (creekMeshes.Count == 0) notNeeded("creeks.import", "Creeks refit (R.A.M.)", "no creek mesh among them");
            else if (string.IsNullOrEmpty(creeksExport) || !File.Exists(creeksExport))
                notNeeded("creeks.import", "Creeks refit (R.A.M.)", "no creeks export at " + (creeksExport ?? "(no export folder)"));
            else
            {
                var within = creekMeshes.Where(where.ContainsKey).Select(n => { var b = where[n].bounds; return Rect.MinMaxRect(b.min.x - 1, b.min.z - 1, b.max.x + 1, b.max.z + 1); }).ToList();
                if (within.Count == 0) notNeeded("creeks.import", "Creeks refit (R.A.M.)", "the named creek meshes have no bounds (not in the scene, FBX folder or shaping report)");
                else run("creeks.import", "Creeks refit (R.A.M.): the creeks crossing them", () => Creeks(dryRun, within), planned);
            }

            // 8. walls whose bank meets them
            if (!File.Exists(courseFolder + WallsSpec)) notNeeded("walls.build", "Stone walls", "no " + courseFolder + WallsSpec);
            else
            {
                var inScene = only.Select(n => { Bounds b; return GolfMapReview.FindObject(n, out b); }).Where(g => g != null).ToList();
                var ids = new SortedSet<string>(StringComparer.Ordinal);
                var over = GolfMapWalls.WallsOver(inScene);
                if (over != null) ids.UnionWith(over);
                var inScene2 = new HashSet<string>(inScene.Select(g => g.name));
                var notInScene = where.Where(kv => !inScene2.Contains(kv.Key)).Select(kv => kv.Value.bounds)
                    .Select(b => Rect.MinMaxRect(b.min.x, b.min.z, b.max.x, b.max.z)).ToList();
                var byBox = notInScene.Count > 0 ? GolfMapWalls.WallsIn(notInScene) : null;
                if (byBox != null) ids.UnionWith(byBox);
                if (ids.Count == 0) notNeeded("walls.build", "Stone walls", "no wall's bank or boulder meets them");
                else if (dryRun)
                {
                    if (begin("walls.build", "Stone walls on them"))
                        steps.Add(new Step { id = "walls.build", label = "Stone walls on them", status = "would run", result = new Dictionary<string, object> { { "walls", ids.Cast<object>().ToList() } },
                            note = "walls.build only=<these> (its own dryRun prepares the stone models, so it is not used). Stones moved by hand and not captured as a pose are replaced." });
                }
                else run("walls.build", "Stone walls on them", () => GolfMapWalls.Build(null, new HashSet<string>(ids), false, 0, null, false), "done");
            }

            // 9. the surface map: re-exported when a rock slab is among them (the meshes rasterize as rock, so the grass zones
            // would otherwise still read the old surface), else left for a full run
            bool surfaceExported = false;
            if (only.Any(GolfMapRockSlabs.IsSlab))
            {
                if (dryRun)
                {
                    if (begin("surfaces.export", "Surface map for grass zones"))
                    {
                        steps.Add(new Step { id = "surfaces.export", label = "Surface map for grass zones", status = "would run",
                            note = "a rock slab is among them: writes " + exportPrefix + "-inner-surfaces.bin/.json/-preview.png to the export folder (no dry run)" });
                        surfaceExported = true;
                    }
                }
                else if (begin("surfaces.export", "Surface map for grass zones"))
                {
                    var s = new Step { id = "surfaces.export", label = "Surface map for grass zones" };
                    var drive = Drive(() => GolfMapSurfaces.Export(new BridgeArgs(new Dictionary<string, object> { { "terrain", "inner" } })), s);
                    while (drive.MoveNext()) yield return null;
                    if (s.status == null) s.status = "done";
                    if (s.error != null) failed |= !continueOnError;
                    else surfaceExported = true;
                    steps.Add(s);
                }
            }
            else
                steps.Add(new Step { id = "surfaces.export", label = "Surface map for grass zones", status = "pending",
                    note = "not run on the per-feature path (whole-course export); run golfmap.surfaces.export terrain=inner (or a full golfmap.course.refresh) before regenerating grass zones" });

            var pending = new List<object>
            {
                surfaceExported
                    ? "Grass zones: bun run grass:zones -- <course> (reads the surface map this run exported), golfmap.zones.import terrain=inner, golfmap.grass.apply."
                    : "Surface map: golfmap.surfaces.export terrain=inner (skipped on the per-feature path), then grass zones: bun run grass:zones -- <course>, golfmap.zones.import terrain=inner, golfmap.grass.apply.",
                "Props: golfmap.props.place is not re-run automatically (it replaces every prop, hand moves included).",
            };
            if (dryRun) pending.Insert(0, "This was a dry run: nothing changed. Run golfmap.course.refresh only=... without dryRun to apply.");

            var report = new Dictionary<string, object>
            {
                { "format", Format }, { "course", courseName }, { "scene", EditorSceneManager.GetActiveScene().name },
                { "dryRun", dryRun }, { "only", only.Cast<object>().ToList() }, { "featherM", featherM },
                { "started", started.ToString("yyyy-MM-ddTHH:mm:ss") }, { "seconds", Math.Round((DateTime.Now - started).TotalSeconds, 2) },
                { "locateSeconds", Math.Round(locateSeconds, 2) },
                { "where", only.ToDictionary(n => n, n => where.ContainsKey(n)
                    ? (object)new Dictionary<string, object> { { "from", where[n].from }, { "min", Round(where[n].bounds.min) }, { "max", Round(where[n].bounds.max) } }
                    : "not found (no scene object, imported FBX or shaping report place)") },
                { "failed", steps.Any(s => s.status == "failed") },
                { "steps", steps.Select(s => (object)s.ToJson()).ToList() },
                { "pending", pending },
                { "report", reportPath },
            };
            File.WriteAllText(reportPath, GolfMapJson.Serialize(report) + "\n");
            yield return report;
        }

        struct Located { public Bounds bounds; public string from; }

        // Each named object's bounds: the scene object, else its imported FBX (as meshes.sync places it: under the mesh
        // parent at the origin), else the shaping report's place for it. Names found nowhere are left out.
        static Dictionary<string, Located> Locate(List<string> names, string meshFolder)
        {
            var found = new Dictionary<string, Located>();
            foreach (var n in names)
            {
                Bounds b;
                if (GolfMapReview.FindObject(n, out b) != null) { found[n] = new Located { bounds = b, from = "scene" }; continue; }
                var fbx = FbxBounds(meshFolder + "/" + n + ".fbx");
                if (fbx.HasValue) { found[n] = new Located { bounds = fbx.Value, from = "fbx" }; continue; }
                var rep = GolfMapReview.ReportBounds(n);
                if (rep.HasValue) found[n] = new Located { bounds = rep.Value, from = "shaping report" };
            }
            return found;
        }

        // An imported FBX model's mesh bounds with its root at the origin, unrotated (meshes.sync resets the root's local
        // position and rotation; the course's mesh parent sits at the origin). Null when Unity has not imported it.
        static Bounds? FbxBounds(string path)
        {
            if (!File.Exists(path)) return null;
            var model = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (model == null) return null;
            Bounds? box = null;
            var root = Matrix4x4.TRS(Vector3.zero, Quaternion.identity, model.transform.localScale) * model.transform.worldToLocalMatrix;
            foreach (var f in model.GetComponentsInChildren<MeshFilter>(true))
            {
                if (f.sharedMesh == null) continue;
                var m = root * f.transform.localToWorldMatrix;
                var mb = f.sharedMesh.bounds;
                for (int i = 0; i < 8; i++)
                {
                    var c = m.MultiplyPoint3x4(mb.center + Vector3.Scale(mb.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1)));
                    if (box.HasValue) { var b = box.Value; b.Encapsulate(c); box = b; } else box = new Bounds(c, Vector3.zero);
                }
            }
            return box;
        }

        static bool IsCreekMesh(string name)
        {
            return name.IndexOf("Creek", StringComparison.OrdinalIgnoreCase) >= 0 && !GolfMapWaterplanes.IsWaterPlane(name);
        }

        static List<object> Round(Vector3 v) { return new List<object> { Math.Round(v.x, 2), Math.Round(v.y, 2), Math.Round(v.z, 2) }; }

        // Runs a bridge-style coroutine step to its end, catching its exceptions into the step (an iterator cannot
        // yield inside try/catch, so the caller pumps this and yields a frame per null).
        static IEnumerator Drive(Func<IEnumerator> start, Step s)
        {
            var t = DateTime.Now;
            IEnumerator inner = null;
            try { inner = start(); }
            catch (Exception e) { s.status = "failed"; s.error = e.Message; Debug.LogException(e); }
            while (inner != null)
            {
                bool more;
                try { more = inner.MoveNext(); }
                catch (Exception e) { s.status = "failed"; s.error = e.Message; Debug.LogException(e); break; }
                if (!more) break;
                if (inner.Current != null) { s.result = inner.Current; break; }
                s.seconds = (DateTime.Now - t).TotalSeconds;
                yield return null;
            }
            s.seconds = (DateTime.Now - t).TotalSeconds;
        }

        // lakes: only these lake meshes (only=), null = every lake
        // Every lake gets a plane: a fresh OPCD .blend never has one (OPCD's "Add Water Plane" is a manual
        // Blender step), so planes are this step's job. New lakes get one, ours are rebuilt keeping their lift
        // (hand-tuned lifts survive, names are stable), lakes another plane still covers are left alone, and with
        // the whole course our stale planes and any plane that lost its mesh (OPCD's after a new .blend) go.
        static Dictionary<string, object> Waterplanes(bool dryRun, List<string> lakesOnly = null)
        {
            var planArgs = new Dictionary<string, object> { { "dryRun", true } };
            if (lakesOnly != null) planArgs["only"] = string.Join(",", lakesOnly.ToArray());
            var plan = GolfMapWaterplanes.Build(new BridgeArgs(planArgs));
            var lakes = ((List<object>)plan["lakes"]).OfType<Dictionary<string, object>>().ToList();
            Func<string, bool> builds = act => act == "create" || act == "rebuild";
            var result = new Dictionary<string, object>
            {
                { "create", lakes.Where(l => (string)l["action"] == "create").Select(l => (object)(string)l["lake"]).ToList() },
                { "rebuild", lakes.Where(l => (string)l["action"] == "rebuild").Select(l => (object)(string)l["lake"]).ToList() },
                { "leftAlone", lakes.Where(l => !builds((string)l["action"])).Select(l => (object)((string)l["lake"] + ": " + l["action"])).ToList() },
                { "stale", plan.ContainsKey("stale") ? plan["stale"] : null },
                { "lostMesh", plan.ContainsKey("lostMesh") ? plan["lostMesh"] : null },
            };
            if (lakesOnly != null)
                result["notInScene"] = lakesOnly.Where(n => !lakes.Any(l => (string)l["lake"] == n)).Cast<object>().ToList();
            var todo = lakes.Where(l => builds((string)l["action"])).Select(l => (string)l["lake"]).ToList();
            if (dryRun) return result;
            var buildArgs = new Dictionary<string, object>();
            if (lakesOnly != null)
            {
                if (todo.Count == 0) return result;
                buildArgs["only"] = string.Join(",", todo.ToArray());
            }
            else buildArgs["prune"] = true;   // whole course: stale and lost planes go too
            var built = GolfMapWaterplanes.Build(new BridgeArgs(buildArgs));
            result["built"] = built.ContainsKey("built") ? built["built"] : null;
            result["prunedLost"] = built.ContainsKey("prunedLost") ? built["prunedLost"] : 0;
            return result;
        }

        // within: refit only the creeks with a point in one of these (only=), null = every creek
        static Dictionary<string, object> Creeks(bool dryRun, List<Rect> within = null)
        {
            var r = GolfMapCreeks.Import(null, dryRun, new GolfMapCreeks.FitOptions { within = within });
            var rows = r.ContainsKey("rows") ? (r["rows"] as List<object> ?? new List<object>()) : new List<object>();
            var result = WithoutKey(r, "rows");
            if (dryRun)
            {
                var statuses = rows.OfType<Dictionary<string, object>>().Select(x => x.ContainsKey("status") ? x["status"] as string : null).ToList();
                result["wouldUpdate"] = statuses.Count(x => x == "update");
                result["wouldCreate"] = statuses.Count(x => x == "create");
            }
            return result;
        }

        static Dictionary<string, object> WallsPlan(string spec)
        {
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(spec));
            var walls = root.Array("walls");
            var boulders = root.Array("boulders");
            var existing = EditorSceneManager.GetActiveScene().GetRootGameObjects().FirstOrDefault(g => g.name == GolfMapWalls.RootName);
            return new Dictionary<string, object>
            {
                { "spec", spec }, { "walls", walls != null ? walls.Count : 0 }, { "boulders", boulders != null ? boulders.Count : 0 },
                { "groupsInScene", existing != null ? existing.transform.childCount : 0 },
            };
        }

        static Dictionary<string, object> WithoutKey(Dictionary<string, object> d, string key)
        {
            return d.Where(kv => kv.Key != key).ToDictionary(kv => kv.Key, kv => kv.Value);
        }

        // Long lists (mesh names, per-creek rows) are cut to their count and the first few, to keep the report readable.
        static object Trim(object value)
        {
            var d = value as Dictionary<string, object>;
            if (d != null) return d.ToDictionary(kv => kv.Key, kv => Trim(kv.Value));
            var list = value as List<object>;
            if (list != null && list.Count > 12)
                return new Dictionary<string, object> { { "count", list.Count }, { "first", list.Take(12).Select(Trim).ToList() } };
            if (list != null) return list.Select(Trim).ToList();
            var strings = value as List<string>;
            if (strings != null) return Trim(strings.Cast<object>().ToList());
            return value;
        }
    }
}
