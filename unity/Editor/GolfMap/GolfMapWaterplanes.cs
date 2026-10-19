// Unity 2018.2 / C# 6. Water planes over the course's lakes, the way OPCD's Blender
// "Add Water Plane" (opcd_blender_tools operators/water.py, opcd.addwaterplane) makes
// them, but built from the lake meshes already in the scene, so no Blender round trip:
//   - the lake's Water Base mesh (Spline_*_Water_Base_Lake_-_Mesh) is flattened to one
//     level: the lowest vertex on its edge (all edges, islands included) minus belowM;
//   - every edge is pushed outwards by outsetM (a flat ring, like OPCD's offset_edges
//     extrude), so the plane runs in under the banks and the blends;
//     near another pond the ring stops half way to its water, so two ponds a weir or a dam
//     apart (a waterfall between them, GolfMapWaterfalls) don't overlap at two levels;
//   - the mesh is all red vertex colour, normals up, no UVs (AQUAS-Lite samples its
//     waves in world XZ), saved to <course>/WaterPlanes/<name>.asset;
//   - the object, <lake key>_WaterPlane under 'Waterplanes', stands liftM above that
//     level (its transform, the way the hand-made plane was raised), with a MeshCollider;
//   - OPCD's GameObject > Set Default Materials (SetMeshEditorDLL, keyed on '_WaterPlane'
//     in the name) gives it OPCD-WaterPlane_AquasLite, the GSPwater physic material and a
//     child 'Default Reflection Probe' (realtime, on awake, box projection) that the
//     renderer anchors on, at the plane's centre;
//   - that probe is then moved over open water and above the banks (PlaceProbe): the whole
//     plane reflects its one cubemap, and at the bare bounds centre a curved creek's probe
//     sits inside its inner bank, captures the ground from underneath and the water goes black.
// A rebuild refills the same mesh asset and keeps the object, its materials, its probe
// (placed again) and its height above the level: a hand lift survives.
// golfmap.waterplanes.probes places the probes of existing planes, OPCD's FBX planes included.
// Lakes a plane not made here already covers (e.g. an OPCD FBX plane) are skipped unless
// replaceExisting, which switches the other plane off (not deleted).
// One level per plane: right for lakes, wrong for a creek that falls (the R.A.M. creeks,
// GolfMapCreeks, are for those); a creek base is only built when named in `only`.
// 'Build for selected mesh' does one mesh at a time, any mesh, by the same rules: its plane is
// <name without _-_Mesh>_WaterPlane.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapWaterplanes
    {
        const string LakeSuffix = "_Water_Base_Lake_-_Mesh";
        const string CreekSuffix = "_Water_Base_Creek_-_Mesh";
        const string MeshSuffix = "_-_Mesh";
        const string PlaneSuffix = "_WaterPlane";
        const string ProbeName = "Default Reflection Probe";    // what OPCD's Set Default Materials adds
        const string AssetFolder = "WaterPlanes";
        const string SetDefaultMaterialsMenu = "GameObject/Set Default Materials";  // OPCD, SetMeshEditorDLL: acts on Selection.gameObjects

        // Water planes (OPCD's and these) carry a Spline_ name but are not ground: tools that
        // read the course meshes as the surface (terrain conform, surfaces, creek fit, planting)
        // leave them out.
        public static bool IsWaterPlane(string name)
        {
            return name.IndexOf("WaterPlane", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // One at a time: click a mesh (a lake's Water_Base, or any other), then this. A selected plane rebuilds from
        // its mesh. The new plane ends up selected, its Y (the lift) at hand in the Inspector.
        [MenuItem("GolfMap/Waterplanes/Build for selected mesh", false, 0)]
        static void BuildSelectedMenu()
        {
            if (Selection.gameObjects.Length == 0) { Tell("Select a mesh first (a lake's Water_Base mesh, or any mesh to put water on).", true); return; }
            var built = new List<GameObject>();
            var result = Build(new BridgeArgs(new Dictionary<string, object> { { "selected", true } }), built);
            Log(result);
            if (built.Count > 0)
            {
                Selection.objects = built.Cast<UnityEngine.Object>().ToArray();
                EditorGUIUtility.PingObject(built[0]);
            }
            Tell(Summary(result), built.Count == 0);
        }

        [MenuItem("GolfMap/Waterplanes/Preview build for all lakes", false, 20)]
        static void PreviewMenu() { Log(Build(new BridgeArgs(new Dictionary<string, object> { { "dryRun", true } }))); }

        [MenuItem("GolfMap/Waterplanes/Build for all lakes", false, 21)]
        static void BuildMenu() { Log(Build(new BridgeArgs(null))); }

        [BridgeCommand("golfmap.waterplanes.build", "Build a flat AQUAS water plane over every lake of the course (or only the selected meshes) the way OPCD's Blender 'Add Water Plane' does, from the meshes in the scene (Spline_*_Water_Base_Lake_-_Mesh): flattened to the lowest point of the mesh's edge minus belowM, edges pushed out by outsetM, object <key>_WaterPlane under 'Waterplanes' raised liftM, mesh saved to <course>/WaterPlanes/, then OPCD's Set Default Materials (AQUAS material, GSPwater physics, child 'Default Reflection Probe'). A rebuild refills the same objects and keeps their current lift. Meshes another water plane already covers are skipped unless replaceExisting (switches that plane off). dryRun lists the lakes, levels and existing planes. Marks the scene dirty; save=true saves it (and the plane meshes it wrote) once the build has succeeded.",
            args = "dryRun=false, selected=false (the editor's selected meshes, any name, instead of the lakes; a selected plane rebuilds from its mesh), only (comma-separated lake keys or name parts; may name a Water_Base_Creek), outsetM=2, belowM=0.05, liftM=0.3 (new planes; existing ones keep theirs unless given), slabs=true (rock slabs in a lake join its plane and the rim beside them does not set the level), parent=Waterplanes, replaceExisting=false, prune=false (delete planes made here whose lake is gone, and any water plane whose mesh is gone, e.g. OPCD's after a new .blend), " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a) { return Build(a); }

        // <course>/water-extra.json (golfmap-water-extra-v1): water the course's lake meshes do not reach yet, e.g. a pond
        // whose outline the app changed after the last OPCD build (hole 9: the bay and the channel under the bridge):
        //   {"planes": [{"name": "Spline_hole_9_240b_WaterPlane", "like": "Spline_hole_9_240_WaterPlane",
        //                "vertices": [[x, z], ...], "triangles": [i, j, k, ...]}]}   (scene XZ; the repo's generator writes it)
        // Each is a copy of its `like` plane (material, physics, reflection probe) at that plane's surface, with this mesh.
        public const string ExtraFile = "water-extra.json";
        const string ExtraFormat = "golfmap-water-extra-v1";

        [BridgeCommand("golfmap.waterplanes.extra", "Build the extra water planes of <course>/water-extra.json (golfmap-water-extra-v1): water the lake meshes do not reach yet (a pond outline changed after the last OPCD build). Each is a copy of its 'like' plane (AQUAS material, GSPwater physics, reflection probe) at that plane's surface with its own mesh (vertices in scene XZ, triangles), saved to <course>/WaterPlanes/. A rerun refills the same objects. Marks the scene dirty; save=true saves it.",
            args = "file (default <course>/water-extra.json), dryRun=false, " + GolfMapSceneSave.Arg)]
        static object ExtraCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var path = a.String("file") ?? GolfMapCourses.Folder(course) + ExtraFile;
            var assetFolder = GolfMapCourses.Folder(course) + AssetFolder;
            if (!File.Exists(path)) throw new InvalidOperationException(path + " not found.");
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            if (root.String("format") != ExtraFormat) throw new InvalidOperationException(path + ": format must be " + ExtraFormat + ".");
            bool dryRun = a.Bool("dryRun", false);
            var scene = EditorSceneManager.GetActiveScene();
            var all = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject).ToList();
            var report = new List<object>();
            EnsureFolder(assetFolder);
            foreach (var o in (root.Array("planes") ?? new List<object>()).Cast<GolfMapJsonObject>())
            {
                string name = o.String("name"), likeName = o.String("like");
                var like = all.FirstOrDefault(g => g.name == likeName && g.activeInHierarchy && g.GetComponent<MeshFilter>() != null);
                if (like == null) throw new InvalidOperationException(path + ": plane " + name + ": no active plane '" + likeName + "' to copy.");
                float surface = like.GetComponent<Renderer>().bounds.max.y;
                Func<object, double> num = v => { var n = v as GolfMapJsonNumber; if (n == null) throw new InvalidOperationException(path + ": plane " + name + ": a number was expected."); return n.Value; };
                var xz = o.Array("vertices").Cast<List<object>>().Select(q => new Vector2((float)num(q[0]), (float)num(q[1]))).ToList();
                var tris = o.Array("triangles").Select(v => (int)Math.Round(num(v))).ToList();
                if (tris.Count % 3 != 0 || tris.Any(i => i < 0 || i >= xz.Count)) throw new InvalidOperationException(path + ": plane " + name + ": bad triangles.");
                report.Add(new Dictionary<string, object> { { "name", name }, { "like", likeName }, { "surfaceY", Round(surface) }, { "vertices", xz.Count }, { "triangles", tris.Count / 3 } });
                if (dryRun) continue;
                var go = all.FirstOrDefault(g => g.name == name);
                if (go != null) Undo.DestroyObjectImmediate(go);
                go = UnityEngine.Object.Instantiate(like, like.transform.parent);
                go.name = name;
                go.SetActive(true);
                Undo.RegisterCreatedObjectUndo(go, "Extra water planes");
                var geo = new Geometry();
                foreach (var p in xz) geo.vertices.Add(go.transform.InverseTransformPoint(new Vector3(p.x, surface, p.y)));
                // wound to face up in the plane's space
                for (int i = 0; i < tris.Count; i += 3)
                {
                    Vector3 v0 = geo.vertices[tris[i]], v1 = geo.vertices[tris[i + 1]], v2 = geo.vertices[tris[i + 2]];
                    bool up = Vector3.Cross(v1 - v0, v2 - v0).y > 0f;
                    geo.triangles.AddRange(up ? new[] { tris[i], tris[i + 1], tris[i + 2] } : new[] { tris[i], tris[i + 2], tris[i + 1] });
                }
                var mesh = SaveMesh(geo.ToMesh(name), assetFolder + "/" + name + ".asset");
                go.GetComponent<MeshFilter>().sharedMesh = mesh;
                var collider = go.GetComponent<MeshCollider>();
                if (collider != null) { collider.sharedMesh = null; collider.sharedMesh = mesh; }
                Physics.SyncTransforms();
                var probe = Probes(go).FirstOrDefault();
                if (probe != null) PlaceProbe(go, probe, ProbeAboveM, "Extra water planes");
                EditorSceneManager.MarkSceneDirty(scene);
            }
            AssetDatabase.SaveAssets();
            return new Dictionary<string, object> { { "file", path }, { "dryRun", dryRun }, { "planes", report } };
        }

        sealed class Lake
        {
            public GameObject go;
            public Mesh mesh;
            public string key, planeName;
            public bool creek;
            public Bounds bounds;       // world
        }

        public static Dictionary<string, object> Build(BridgeArgs a) { return Build(a, null); }

        // builtOut, when given, gets the planes made or refilled.
        static Dictionary<string, object> Build(BridgeArgs a, List<GameObject> builtOut)
        {
            bool dryRun = a.Bool("dryRun", false), replaceExisting = a.Bool("replaceExisting", false), prune = a.Bool("prune", false);
            bool selected = a.Bool("selected", false);
            float outset = Mathf.Clamp((float)a.Number("outsetM", 2), 0f, 10f);
            float below = (float)a.Number("belowM", 0.05);
            float? liftArg = a.Has("liftM") ? (float?)(float)a.Number("liftM", 0.3) : null;
            var only = (a.String("only") ?? "").Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
            var parentName = a.String("parent", "Waterplanes");

            // Read the course now: OPCD's Set Default Materials unloads unused assets, the course with them.
            var course = GolfMapCourses.Require();
            var assetFolder = GolfMapCourses.Folder(course) + AssetFolder;
            var levels = FixedLevels(course);
            course = null;

            var scene = EditorSceneManager.GetActiveScene();
            var all = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject).ToList();
            var ignored = new List<object>();
            var lakes = selected ? FromSelection(all, ignored) : FindLakes(all, only);
            var planes = all.Where(g => IsWaterPlane(g.name) && g.GetComponent<MeshFilter>() != null && g.GetComponent<MeshFilter>().sharedMesh != null).ToList();
            Func<GameObject, bool> ours = g => AssetDatabase.GetAssetPath(g.GetComponent<MeshFilter>().sharedMesh).StartsWith(assetFolder + "/", StringComparison.OrdinalIgnoreCase);
            var parent = all.FirstOrDefault(g => g.transform.parent == null && g.name == parentName);

            var report = new List<object>();
            var jobs = new List<KeyValuePair<Lake, Geometry>>();
            var switchOff = new List<GameObject>();
            // Rock slabs (golfmap.cut_out, Spline_*_Rock_-_Mesh): one standing in a lake joins its plane, and the
            // shore beside it does not set the level (see Flatten).
            var slabs = a.Bool("slabs", true)
                ? all.Where(g => g.activeInHierarchy && GolfMapRockSlabs.IsSlab(g.name) && MeshOf(g) != null).ToList()
                : new List<GameObject>();
            // Every lake's footprint (XZ), so a plane's outset ring stops short of the next pond's water: ponds a
            // weir or a dam apart (a waterfall between them) would otherwise overlap at two levels.
            var footprints = FindLakes(all, new string[0]).ToDictionary(l => l.planeName, l =>
            {
                var m = l.go.transform.localToWorldMatrix;
                return l.mesh.vertices.Select(v => { var w = m.MultiplyPoint3x4(v); return new Vector2(w.x, w.z); }).ToList();
            });
            foreach (var lake in lakes)
            {
                var grownBox = lake.bounds; grownBox.Expand(4f * outset + 1f);
                var neighbours = new Dictionary<Vector2Int, List<Vector2>>();
                float cellM = Mathf.Max(2f * outset, 1f);
                foreach (var kv in footprints)
                {
                    if (kv.Key == lake.planeName) continue;
                    foreach (var p in kv.Value)
                    {
                        if (p.x < grownBox.min.x || p.x > grownBox.max.x || p.y < grownBox.min.z || p.y > grownBox.max.z) continue;
                        var c = new Vector2Int(Mathf.FloorToInt(p.x / cellM), Mathf.FloorToInt(p.y / cellM));
                        List<Vector2> l;
                        if (!neighbours.TryGetValue(c, out l)) neighbours[c] = l = new List<Vector2>();
                        l.Add(p);
                    }
                }
                var geo = Flatten(lake, outset, below, parent != null ? parent.transform : null, slabs, neighbours);
                var mine = planes.FirstOrDefault(p => p.name == lake.planeName && ours(p));
                var others = planes.Where(p => p.activeInHierarchy && !ours(p) && Covers(p, lake.bounds, geo.rimMin)).ToList();
                float lift = liftArg ?? (mine != null ? mine.transform.localPosition.y : 0.3f);
                float fixedSurface = 0f;
                bool isFixed = liftArg == null && levels.TryGetValue(lake.planeName, out fixedSurface);
                if (isFixed)
                {
                    // The mesh is flattened just under the set surface and lifted the usual FixedLiftM, never lifted
                    // far off its mesh: AQUAS draws a plane lifted a metre over the banks and stones it should
                    // meet (Omberg's hole 14 pond, whose lake mesh rim lies on its dug bank 0.7 m under the water).
                    float shift = fixedSurface - FixedLiftM - geo.level;
                    for (int v = 0; v < geo.vertices.Count; v++) geo.vertices[v] += new Vector3(0f, shift, 0f);
                    geo.level += shift;
                    lift = FixedLiftM;
                }
                var entry = new Dictionary<string, object>
                {
                    { "lake", lake.go.name },
                    { "plane", lake.planeName },
                    { "levelM", Round(geo.level) },
                    { "surfaceM", Round(geo.level + lift) },
                    { "liftM", Round(lift) },
                    { "fixedLevel", isFixed },
                    { "rimM", new List<object> { Round(geo.rimMin), Round(geo.rimMax) } },
                    // How much of the lake's edge lies below the water surface: there the plane shows over the bank
                    // unless the outset ring runs in under higher ground (blends, rough).
                    { "rimBelowSurface", Math.Round(geo.rimHeights.Count(h => h < geo.level + lift) / (double)Math.Max(1, geo.rimHeights.Count), 3) },
                    { "verts", geo.vertices.Count },
                    { "boundaryEdges", geo.boundaryEdges },
                    { "slabs", geo.slabs.Select(s => (object)s).ToList() },
                    { "rimLeftOutNearSlabs", geo.rimLeftOut },
                    { "outsetClippedNearPonds", geo.outsetClipped },
                    { "action", mine != null ? "rebuild" : "create" },
                };
                if (lake.creek) entry["warning"] = "A creek base: one flat level over a creek that falls leaves the upper end dry. R.A.M. creeks (golfmap.creeks.import) follow the fall.";
                if (others.Count > 0)
                {
                    entry["coveredBy"] = others.Select(p => (object)PathOf(p)).ToList();
                    if (!replaceExisting) { entry["action"] = "skip (covered; replaceExisting=true builds it and switches those off)"; report.Add(entry); continue; }
                    switchOff.AddRange(others);
                }
                report.Add(entry);
                jobs.Add(new KeyValuePair<Lake, Geometry>(lake, geo));
            }
            // Stale: made here, and no mesh in the scene (a lake or any other) would give its name any more.
            var sourceNames = new HashSet<string>(all.Where(g => !IsWaterPlane(g.name) && MeshOf(g) != null).Select(g => KeyOf(g.name) + PlaneSuffix));
            var stale = planes.Where(p => ours(p) && !sourceNames.Contains(p.name) && only.Length == 0 && !selected).ToList();
            // Lost: a water plane object (ours or OPCD's) whose mesh is gone - e.g. OPCD's plane after a new .blend
            // (a fresh OPCD .blend has no water plane, so its FBX disappears). It draws nothing and has no collider.
            var lost = all.Where(g => IsWaterPlane(g.name) && g.GetComponent<MeshFilter>() != null && g.GetComponent<MeshFilter>().sharedMesh == null &&
                (g.GetComponent<MeshCollider>() == null || g.GetComponent<MeshCollider>().sharedMesh == null) && only.Length == 0 && !selected).ToList();

            var result = new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "dryRun", dryRun },
                { "parent", parentName },
                { "outsetM", outset },
                { "belowM", below },
                { "lakes", report },
                { "existingPlanes", planes.Select(p => (object)Describe(p, ours(p), lakes)).ToList() },
                { "stale", stale.Select(p => (object)PathOf(p)).ToList() },
                { "lostMesh", lost.Select(p => (object)PathOf(p)).ToList() },
            };
            if (selected) result["ignored"] = ignored;
            if (lakes.Count == 0 && !selected) result["note"] = "No lake meshes (*" + LakeSuffix + ") in the scene" + (only.Length > 0 ? " matching 'only'." : ".");
            if (dryRun) return result;

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Build water planes");
            var errors = new List<object>();
            if (jobs.Count > 0 && parent == null)
            {
                parent = new GameObject(parentName);
                Undo.RegisterCreatedObjectUndo(parent, "Build water planes");
            }
            EnsureFolder(assetFolder);
            var needOpcd = new List<GameObject>();
            var built = new List<GameObject>();
            foreach (var job in jobs)
            {
                var lake = job.Key;
                var geo = job.Value;
                var go = planes.FirstOrDefault(p => p.name == lake.planeName && ours(p)) ?? Unfinished(all, lake.planeName);
                float lift = liftArg ?? (go != null ? go.transform.localPosition.y : 0.3f);
                float fixedSurface;
                if (liftArg == null && levels.TryGetValue(lake.planeName, out fixedSurface)) lift = fixedSurface - geo.level;
                bool fresh = go == null;
                if (fresh)
                {
                    go = new GameObject(lake.planeName);
                    Undo.RegisterCreatedObjectUndo(go, "Build water planes");
                    go.transform.SetParent(parent.transform, false);
                }
                else Undo.RecordObject(go.transform, "Build water planes");
                go.transform.localPosition = new Vector3(0f, lift, 0f);
                go.transform.localRotation = Quaternion.identity;
                go.transform.localScale = Vector3.one;

                var mesh = SaveMesh(geo.ToMesh(lake.planeName), assetFolder + "/" + lake.planeName + ".asset");
                // Not ??: GetComponent returns Unity's fake null in the editor.
                var filter = go.GetComponent<MeshFilter>();
                if (filter == null) filter = Undo.AddComponent<MeshFilter>(go);
                filter.sharedMesh = mesh;
                if (go.GetComponent<MeshRenderer>() == null) Undo.AddComponent<MeshRenderer>(go);
                var collider = go.GetComponent<MeshCollider>();
                if (collider == null) collider = Undo.AddComponent<MeshCollider>(go);
                collider.sharedMesh = null;     // re-cook from the refilled mesh
                collider.sharedMesh = mesh;

                var probe = Probes(go).FirstOrDefault();
                var renderer = go.GetComponent<MeshRenderer>();
                if (fresh || probe == null || renderer.sharedMaterial == null) needOpcd.Add(go);
                built.Add(go);
            }
            if (needOpcd.Count > 0)
            {
                var selection = Selection.objects;
                GolfMapRockSlabs.StripChannelStores(needOpcd[0].scene);
                Selection.objects = needOpcd.Cast<UnityEngine.Object>().ToArray();
                if (!EditorApplication.ExecuteMenuItem(SetDefaultMaterialsMenu))
                    errors.Add("OPCD's '" + SetDefaultMaterialsMenu + "' is not in this project: the planes have no water material, physics or reflection probe.");
                Selection.objects = selection;
            }
            // After OPCD: it adds the probe of a new plane at the plane's centre.
            Physics.SyncTransforms();
            foreach (var go in built)
            {
                var probe = Probes(go).FirstOrDefault();
                if (probe != null) PlaceProbe(go, probe, ProbeAboveM, "Build water planes");
            }
            foreach (var g in switchOff) { Undo.RecordObject(g, "Build water planes"); g.SetActive(false); }
            if (prune)
                foreach (var g in stale)
                {
                    var path = AssetDatabase.GetAssetPath(g.GetComponent<MeshFilter>().sharedMesh);
                    Undo.DestroyObjectImmediate(g);
                    AssetDatabase.DeleteAsset(path);
                }
            if (prune)
                foreach (var g in lost) Undo.DestroyObjectImmediate(g);
            Undo.CollapseUndoOperations(undoGroup);
            AssetDatabase.SaveAssets();
            if (built.Count > 0 || switchOff.Count > 0 || (prune && (stale.Count > 0 || lost.Count > 0))) EditorSceneManager.MarkSceneDirty(scene);

            if (builtOut != null) builtOut.AddRange(built);
            result["built"] = built.Select(g => (object)Check(g)).ToList();
            result["switchedOff"] = switchOff.Select(g => (object)PathOf(g)).ToList();
            result["prunedStale"] = prune && stale.Count > 0;
            result["prunedLost"] = prune ? lost.Count : 0;
            result["errors"] = errors;
            return result;
        }

        static List<Lake> FindLakes(List<GameObject> all, string[] only)
        {
            var lakes = new List<Lake>();
            foreach (var go in all)
            {
                if (!go.activeInHierarchy) continue;
                bool lake = go.name.EndsWith(LakeSuffix, StringComparison.Ordinal), creek = go.name.EndsWith(CreekSuffix, StringComparison.Ordinal);
                if (!lake && !creek) continue;
                var key = KeyOf(go.name);
                bool named = only.Any(o => go.name.IndexOf(o, StringComparison.OrdinalIgnoreCase) >= 0 || string.Equals(key, o, StringComparison.OrdinalIgnoreCase));
                if (only.Length > 0 ? !named : !lake) continue;
                var found = ToLake(go);
                if (found != null) lakes.Add(found);
            }
            return lakes.OrderBy(l => l.planeName, StringComparer.Ordinal).ToList();
        }

        // The selected meshes, whatever their names. A selected plane (or its probe) stands for the mesh it was
        // built from, so selecting what the Scene view shows on top rebuilds it.
        static List<Lake> FromSelection(List<GameObject> all, List<object> ignored)
        {
            var inScene = new HashSet<GameObject>(all);
            var lakes = new List<Lake>();
            foreach (var picked in Selection.gameObjects)
            {
                var go = picked;
                if (!inScene.Contains(go)) { ignored.Add(go.name + ": not in the open scene"); continue; }
                if (MeshOf(go) == null && go.transform.parent != null && IsWaterPlane(go.transform.parent.name)) go = go.transform.parent.gameObject;
                if (IsWaterPlane(go.name))
                {
                    var plane = go;
                    go = all.FirstOrDefault(g => !IsWaterPlane(g.name) && MeshOf(g) != null && KeyOf(g.name) + PlaneSuffix == plane.name);
                    if (go == null) { ignored.Add(PathOf(picked) + ": a water plane not built here from a mesh"); continue; }
                }
                var lake = ToLake(go);
                if (lake == null) { ignored.Add(PathOf(picked) + ": no mesh"); continue; }
                if (!lakes.Any(l => l.planeName == lake.planeName)) lakes.Add(lake);
            }
            return lakes.OrderBy(l => l.planeName, StringComparer.Ordinal).ToList();
        }

        static Lake ToLake(GameObject go)
        {
            var mesh = MeshOf(go);
            if (mesh == null) return null;
            var key = KeyOf(go.name);
            var r = go.GetComponent<Renderer>();
            return new Lake { go = go, mesh = mesh, key = key, planeName = key + PlaneSuffix, creek = go.name.EndsWith(CreekSuffix, StringComparison.Ordinal), bounds = r != null ? r.bounds : new Bounds(go.transform.position, Vector3.zero) };
        }

        // The collider keeps the FBX mesh when vertex paint swapped the MeshFilter to a copy; same geometry.
        static Mesh MeshOf(GameObject go)
        {
            var collider = go.GetComponent<MeshCollider>();
            if (collider != null && collider.sharedMesh != null) return collider.sharedMesh;
            var filter = go.GetComponent<MeshFilter>();
            return filter != null ? filter.sharedMesh : null;
        }

        // "Spline_hole_15_7_Water_Base_Lake_-_Mesh" -> "Spline_hole_15_7"; any other "X_-_Mesh" -> "X".
        static string KeyOf(string name)
        {
            foreach (var suffix in new[] { LakeSuffix, CreekSuffix, MeshSuffix })
                if (name.EndsWith(suffix, StringComparison.Ordinal) && name.Length > suffix.Length) return name.Substring(0, name.Length - suffix.Length);
            return name;
        }

        sealed class Geometry
        {
            public List<Vector3> vertices = new List<Vector3>();
            public List<int> triangles = new List<int>();
            public float level, rimMin, rimMax;
            public List<float> rimHeights = new List<float>();
            public int boundaryEdges, rimLeftOut, outsetClipped;
            public List<string> slabs = new List<string>();

            public Mesh ToMesh(string name)
            {
                var m = new Mesh { name = name };
                if (vertices.Count > 65000) m.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
                m.SetVertices(vertices);
                m.SetTriangles(triangles, 0);
                m.SetNormals(Enumerable.Repeat(Vector3.up, vertices.Count).ToList());
                m.SetTangents(Enumerable.Repeat(new Vector4(1f, 0f, 0f, -1f), vertices.Count).ToList());
                m.colors32 = Enumerable.Repeat(new Color32(255, 0, 0, 255), vertices.Count).ToArray();
                m.RecalculateBounds();
                return m;
            }
        }

        // <course>/water-levels.json (golfmap-water-levels-v1): {"planes": {"<plane name>": {"surfaceM": 9.553}}} - a
        // water surface set by hand (world Y): the build flattens that plane's mesh FixedLiftM under it and lifts it
        // FixedLiftM, whatever the lake mesh's rim comes to, so a hand-tuned lake keeps its water through a rebuild
        // and a fresh plane (a new .blend).
        // An explicit liftM still wins. The repo keeps a hand-set copy at docs/gspro/<course>/water-levels.json.
        public const string LevelsFile = "water-levels.json";
        const float FixedLiftM = 0.3f;  // a set surface: the plane this far over its flattened mesh
        const string LevelsFormat = "golfmap-water-levels-v1";

        // The export folder's <prefix>-inner-water-levels.json first (golf-map writes it on every terrain update: the
        // ponds dug with their outline at the water's edge, at their dig's level), then the course folder's own file,
        // whose hand-set surfaces win.
        static Dictionary<string, float> FixedLevels(GolfMapCourse course)
        {
            var result = new Dictionary<string, float>();
            foreach (var path in new[] { GolfMapCourses.ExportFile(course, "inner", "water-levels"), GolfMapCourses.Folder(course) + LevelsFile })
            {
                if (string.IsNullOrEmpty(path) || !File.Exists(path)) continue;
                var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
                if (root.String("format") != LevelsFormat) throw new InvalidOperationException(path + ": format must be " + LevelsFormat + ".");
                var planes = root.Object("planes");
                if (planes == null) continue;
                foreach (var key in planes.keys)
                {
                    var o = planes.Object(key);
                    if (o == null || !o.Has("surfaceM")) throw new InvalidOperationException(path + " planes." + key + ": needs surfaceM.");
                    result[key] = (float)o.Number("surfaceM");
                }
            }
            return result;
        }

        const float SlabShoreM = 2.5f;   // a lake rim vertex this close (XZ) to a rock slab does not set the level

        // The lake mesh welded (the FBX splits vertices at normal seams), flattened to the level,
        // plus a ring outset wide around every boundary edge, in the parent's space.
        // A rock slab standing in the lake (golfmap.cut_out with `rise`: a hole in the lake mesh, its foot under the
        // water; or one drawn into a notch of the shore) joins the plane, so the water runs on round it, and the lake's
        // rim near it does not set the level: a notch's rim lies down on the lake bed (Vreta hole 15, 2026-10-15:
        // the water stood 1.5 m low).
        static Geometry Flatten(Lake lake, float outset, float below, Transform parent, List<GameObject> slabs = null, Dictionary<Vector2Int, List<Vector2>> neighbours = null)
        {
            var index = new Dictionary<Vector3Int, int>();   // millimetres
            var world = new List<Vector3>();
            var uses = new Dictionary<long, int>();
            var third = new Dictionary<long, int>();
            var faces = new List<int>();
            Action<Mesh, Matrix4x4> addMesh = (mesh, toWorld) =>
            {
                var src = mesh.vertices;
                var tris = mesh.triangles;
                var map = new int[src.Length];
                for (int i = 0; i < src.Length; i++)
                {
                    var w = toWorld.MultiplyPoint3x4(src[i]);
                    var k = new Vector3Int(Mathf.RoundToInt(w.x * 1000f), Mathf.RoundToInt(w.y * 1000f), Mathf.RoundToInt(w.z * 1000f));
                    int at;
                    if (!index.TryGetValue(k, out at)) { at = world.Count; index[k] = at; world.Add(w); }
                    map[i] = at;
                }
                // Boundary edges: used by one triangle; the triangle's third vertex says which side is inside.
                for (int t = 0; t + 2 < tris.Length; t += 3)
                {
                    int a = map[tris[t]], b = map[tris[t + 1]], c = map[tris[t + 2]];
                    if (a == b || b == c || a == c) continue;
                    faces.Add(a); faces.Add(b); faces.Add(c);
                    AddEdge(uses, third, a, b, c); AddEdge(uses, third, b, c, a); AddEdge(uses, third, c, a, b);
                }
            };
            addMesh(lake.mesh, lake.go.transform.localToWorldMatrix);
            var lakeRim = new HashSet<int>();
            foreach (var kv in uses) if (kv.Value == 1) { lakeRim.Add((int)(kv.Key >> 32)); lakeRim.Add((int)(kv.Key & 0xffffffffL)); }
            // The slabs in or at the lake: their box within SlabShoreM of the lake's.
            var near = new List<Vector2>();
            var joined = new List<string>();
            var grown = lake.bounds; grown.Expand(2f * SlabShoreM);
            foreach (var s in slabs ?? new List<GameObject>())
            {
                var r = s.GetComponent<Renderer>();
                if (r == null || !r.bounds.Intersects(grown)) continue;
                var mesh = MeshOf(s);
                var m = s.transform.localToWorldMatrix;
                var vs = mesh.vertices.Select(v => m.MultiplyPoint3x4(v)).ToList();
                // In the lake when one of its vertices is a vertex of the lake's (it shares the seam).
                bool shares = vs.Any(w => index.ContainsKey(new Vector3Int(Mathf.RoundToInt(w.x * 1000f), Mathf.RoundToInt(w.y * 1000f), Mathf.RoundToInt(w.z * 1000f))));
                bool close = vs.Any(w => lakeRim.Any(i => Mathf.Abs(world[i].x - w.x) < SlabShoreM && Mathf.Abs(world[i].z - w.z) < SlabShoreM));
                if (!shares && !close) continue;
                foreach (var w in vs) near.Add(new Vector2(w.x, w.z));
                if (shares) { addMesh(mesh, m); joined.Add(s.name); }
            }
            var boundary = uses.Where(kv => kv.Value == 1).Select(kv => kv.Key).ToList();
            var geo = new Geometry { boundaryEdges = boundary.Count, slabs = joined };
            // The level: the lake's own rim, but for the part beside a slab.
            var cell = SlabShoreM;
            var grid = new HashSet<Vector2Int>(near.Select(p => new Vector2Int(Mathf.FloorToInt(p.x / cell), Mathf.FloorToInt(p.y / cell))));
            Func<Vector3, bool> besideSlab = w =>
            {
                int cx = Mathf.FloorToInt(w.x / cell), cz = Mathf.FloorToInt(w.z / cell);
                for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++)
                    if (grid.Contains(new Vector2Int(cx + dx, cz + dz)) && near.Any(p => (p - new Vector2(w.x, w.z)).sqrMagnitude < cell * cell)) return true;
                return false;
            };
            foreach (var v in lakeRim)
            {
                if (grid.Count > 0 && besideSlab(world[v])) { geo.rimLeftOut++; continue; }
                geo.rimHeights.Add(world[v].y);
            }
            geo.rimMin = geo.rimHeights.Count > 0 ? geo.rimHeights.Min() : world.Min(p => p.y);
            geo.rimMax = geo.rimHeights.Count > 0 ? geo.rimHeights.Max() : world.Max(p => p.y);
            geo.level = geo.rimMin - below;

            // Outward normal (XZ) per boundary edge; per rim vertex the mitred sum of its edges'.
            var normals = new Dictionary<int, List<Vector2>>();
            var edgeNormal = new Dictionary<long, Vector2>();
            foreach (var e in boundary)
            {
                int a = (int)(e >> 32), b = (int)(e & 0xffffffffL);
                var d = new Vector2(world[b].x - world[a].x, world[b].z - world[a].z);
                if (d.sqrMagnitude < 1e-10f) continue;
                var n = new Vector2(d.y, -d.x).normalized;
                var mid = new Vector2(world[a].x + world[b].x, world[a].z + world[b].z) * 0.5f;
                var inside = new Vector2(world[third[e]].x, world[third[e]].z);
                if (Vector2.Dot(n, inside - mid) > 0) n = -n;
                edgeNormal[e] = n;
                List<Vector2> l;
                if (!normals.TryGetValue(a, out l)) normals[a] = l = new List<Vector2>(); l.Add(n);
                if (!normals.TryGetValue(b, out l)) normals[b] = l = new List<Vector2>(); l.Add(n);
            }

            Func<Vector3, Vector3> place = w =>
            {
                var p = new Vector3(w.x, geo.level, w.z);
                return parent != null ? parent.InverseTransformPoint(p) : p;
            };
            foreach (var w in world) geo.vertices.Add(place(w));
            for (int i = 0; i < faces.Count; i += 3) AddUp(geo, faces[i], faces[i + 1], faces[i + 2]);
            if (outset <= 0f) return geo;

            var outer = new Dictionary<int, int>();
            foreach (var kv in normals)
            {
                var sum = Vector2.zero;
                foreach (var n in kv.Value) sum += n;
                var dir = sum.sqrMagnitude < 1e-6f ? kv.Value[0] : sum.normalized;
                // Mitre: keep the ring outset wide along both edges, capped at sharp corners.
                float cos = kv.Value.Min(n => Vector2.Dot(dir, n));
                float len = outset / Mathf.Max(cos, 0.35f);
                var w = world[kv.Key];
                // Another pond nearby: the ring reaches at most half way to its water.
                if (neighbours != null && neighbours.Count > 0)
                {
                    var here = new Vector2(w.x, w.z);
                    float cellM = Mathf.Max(2f * outset, 1f), nearest = float.MaxValue;
                    int cx = Mathf.FloorToInt(here.x / cellM), cz = Mathf.FloorToInt(here.y / cellM);
                    List<Vector2> l;
                    for (int dx = -1; dx <= 1; dx++)
                        for (int dz = -1; dz <= 1; dz++)
                            if (neighbours.TryGetValue(new Vector2Int(cx + dx, cz + dz), out l))
                                foreach (var q in l) { float d = (q - here).sqrMagnitude; if (d < nearest) nearest = d; }
                    nearest = Mathf.Sqrt(nearest);
                    if (nearest < 2f * len) { len = Mathf.Max(nearest * 0.5f - 0.05f, 0f); geo.outsetClipped++; }
                }
                outer[kv.Key] = geo.vertices.Count;
                geo.vertices.Add(place(new Vector3(w.x + dir.x * len, 0f, w.z + dir.y * len)));
            }
            foreach (var e in edgeNormal.Keys)
            {
                int a = (int)(e >> 32), b = (int)(e & 0xffffffffL);
                AddUp(geo, a, b, outer[b]);
                AddUp(geo, a, outer[b], outer[a]);
            }
            return geo;
        }

        static void AddEdge(Dictionary<long, int> uses, Dictionary<long, int> third, int a, int b, int c)
        {
            long k = a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
            int n;
            uses[k] = uses.TryGetValue(k, out n) ? n + 1 : 1;
            third[k] = c;
        }

        // A triangle facing up (Unity: cross(b - a, c - a) points at the viewer); flat ones dropped.
        static void AddUp(Geometry geo, int a, int b, int c)
        {
            var va = geo.vertices[a]; var vb = geo.vertices[b]; var vc = geo.vertices[c];
            float y = (vb.z - va.z) * (vc.x - va.x) - (vb.x - va.x) * (vc.z - va.z);
            if (Mathf.Abs(y) < 1e-8f) return;
            if (y > 0) { geo.triangles.Add(a); geo.triangles.Add(b); geo.triangles.Add(c); }
            else { geo.triangles.Add(a); geo.triangles.Add(c); geo.triangles.Add(b); }
        }

        // Refill the existing asset so the scene's references keep pointing at it.
        static Mesh SaveMesh(Mesh mesh, string path)
        {
            var existing = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (existing == null) { AssetDatabase.CreateAsset(mesh, path); return mesh; }
            EditorUtility.CopySerialized(mesh, existing);
            UnityEngine.Object.DestroyImmediate(mesh);
            EditorUtility.SetDirty(existing);
            return existing;
        }

        // Another plane covers a lake when their XZ bounds share most of the lake's and it is not below the lake's
        // edge (its lowest rim point, give or take CoverLevelM; over the whole rim, the lake is under its water): a
        // big lake's plane (Omberg's Vattern, 4 km) also spans the ponds on the land above it, 15 m higher. Without
        // the rim: the lake mesh's lowest point.
        const float CoverLevelM = 1f;
        static bool Covers(GameObject plane, Bounds lake, float rimLow = float.NaN)
        {
            var r = plane.GetComponent<Renderer>();
            if (r == null) return false;
            var b = r.bounds;
            if (b.max.y < (float.IsNaN(rimLow) ? lake.min.y : rimLow) - CoverLevelM) return false;
            float w = Mathf.Min(b.max.x, lake.max.x) - Mathf.Max(b.min.x, lake.min.x);
            float d = Mathf.Min(b.max.z, lake.max.z) - Mathf.Max(b.min.z, lake.min.z);
            return w > 0 && d > 0 && w * d >= 0.5f * Mathf.Max(1e-3f, lake.size.x * lake.size.z);
        }

        // An object of that name left without a mesh by an interrupted build: filled in, not duplicated.
        static GameObject Unfinished(List<GameObject> all, string name)
        {
            return all.FirstOrDefault(g => g != null && g.name == name && g.GetComponent<MeshFilter>() == null && g.transform.childCount == 0);
        }

        static IEnumerable<ReflectionProbe> Probes(GameObject go)
        {
            return go.GetComponentsInChildren<ReflectionProbe>(true).Where(p => p.gameObject != go);
        }

        const float ProbeAboveM = 1f;       // over the highest ground within the probe's box around it
        const float ProbeMinDepthM = 0.3f;  // open water: at least this much over the bed

        [MenuItem("GolfMap/Waterplanes/Place reflection probes", false, 40)]
        static void ProbesMenu()
        {
            var result = PlaceProbes(new BridgeArgs(null));
            Log(result);
            var lines = ((List<object>)result["planes"]).Cast<Dictionary<string, object>>()
                .Select(p => p["plane"] + ": " + (p.ContainsKey("problem") ? p["problem"] : "probe at " + string.Join(", ", ((List<object>)p["to"]).Select(o => o.ToString()).ToArray()))).ToArray();
            Tell(lines.Length > 0 ? string.Join("\n", lines) : "No water planes with a reflection probe.", lines.Length == 0);
        }

        [BridgeCommand("golfmap.waterplanes.probes", "Place the reflection probe of every active water plane (OPCD's FBX planes included; or only some) where it sees the sky: over open water (the plane is the top surface there and at least 0.3 m over the bed: not a bank its outset runs under, not a flooded margin) at the point nearest the plane's centre, aboveM over the highest ground within the probe's box around it, then render it so the Scene view shows it at once (GSPro renders it on load). The whole plane reflects that one cubemap; a probe left inside a bank captures the ground from underneath and the water goes black. golfmap.waterplanes.build does the same for the planes it builds. Marks the scene dirty, does not save it.",
            args = "only (comma-separated plane name parts), aboveM=1, dryRun=false")]
        static object ProbesCommand(BridgeArgs a) { return PlaceProbes(a); }

        static Dictionary<string, object> PlaceProbes(BridgeArgs a)
        {
            bool dryRun = a.Bool("dryRun", false);
            float above = Mathf.Max(0f, (float)a.Number("aboveM", ProbeAboveM));
            var only = (a.String("only") ?? "").Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
            var scene = EditorSceneManager.GetActiveScene();
            var planes = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject)
                .Where(g => g.activeInHierarchy && IsWaterPlane(g.name) && g.GetComponent<MeshRenderer>() != null && Probes(g).Any())
                .Where(g => only.Length == 0 || only.Any(o => g.name.IndexOf(o, StringComparison.OrdinalIgnoreCase) >= 0))
                .OrderBy(g => g.name, StringComparer.Ordinal).ToList();
            if (!dryRun)
            {
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Place water plane probes");
            }
            Physics.SyncTransforms();
            var report = new List<object>();
            foreach (var go in planes)
            {
                var probe = Probes(go).First();
                var from = probe.transform.position;
                float groundAtProbe = GroundAt(from.x, from.z);
                var entry = new Dictionary<string, object>
                {
                    { "plane", PathOf(go) },
                    { "from", Vec(from) },
                    { "fromUnderGround", groundAtProbe > from.y },
                };
                var spot = dryRun ? ProbeSpot(go, probe, above) : PlaceProbe(go, probe, above, "Place water plane probes");
                if (spot == null) entry["problem"] = "no open water found (no collider on the plane, or ground above all of it)";
                else entry["to"] = Vec(spot.Value);
                report.Add(entry);
            }
            if (!dryRun && planes.Count > 0) EditorSceneManager.MarkSceneDirty(scene);
            return new Dictionary<string, object> { { "scene", scene.name }, { "dryRun", dryRun }, { "aboveM", above }, { "planes", report } };
        }

        // Move the probe to ProbeSpot and render it (realtime probes refresh on awake: in the editor a moved
        // probe keeps its old cubemap until rendered). Null, probe left alone, when the plane has no open water.
        static Vector3? PlaceProbe(GameObject plane, ReflectionProbe probe, float above, string undoName)
        {
            var spot = ProbeSpot(plane, probe, above);
            if (spot == null) return null;
            Undo.RecordObject(probe.transform, undoName);
            probe.transform.position = spot.Value;
            if (probe.mode == UnityEngine.Rendering.ReflectionProbeMode.Realtime) probe.RenderProbe();
            return spot;
        }

        // Over open water, nearest the plane's centre: on a grid over the plane's bounds, the points where the
        // plane is the top surface (the outset ring runs in under the banks, so ground lies above it there).
        // Height: `above` over the highest of the water and the ground within the probe's box around the point,
        // so the cubemap's horizon is sky and trees, not the walls of the channel.
        static Vector3? ProbeSpot(GameObject plane, ReflectionProbe probe, float above)
        {
            var collider = plane.GetComponent<MeshCollider>();
            if (collider == null || collider.sharedMesh == null) return null;
            var b = plane.GetComponent<MeshRenderer>().bounds;
            float step = Mathf.Max(0.5f, Mathf.Max(b.size.x, b.size.z) / 150f);
            var centre = new Vector2(b.center.x, b.center.z);
            // Deep enough to be the pond, not a bank margin the plane just floods; any water when none is.
            Vector3? best = null, shallow = null;
            float bestDist = float.MaxValue, shallowDist = float.MaxValue;
            for (float x = b.min.x + step * 0.5f; x < b.max.x; x += step)
                for (float z = b.min.z + step * 0.5f; z < b.max.z; z += step)
                {
                    float d = (new Vector2(x, z) - centre).sqrMagnitude;
                    if (d >= bestDist) continue;
                    RaycastHit hit;
                    if (!collider.Raycast(new Ray(new Vector3(x, b.max.y + 100f, z), Vector3.down), out hit, b.size.y + 200f)) continue;
                    float depth = hit.point.y - GroundAt(x, z);
                    if (depth <= 0f) continue;
                    if (depth >= ProbeMinDepthM) { if (d < bestDist) { best = hit.point; bestDist = d; } }
                    else if (d < shallowDist) { shallow = hit.point; shallowDist = d; }
                }
            if (best == null) best = shallow;
            if (best == null) return null;
            var p = best.Value;
            float top = p.y;
            float r = Mathf.Min(probe.size.x, probe.size.z) * 0.5f;
            for (int i = 0; i < 16; i++)
            {
                float angle = i * Mathf.PI / 8f;
                foreach (var radius in new[] { r * 0.5f, r })
                    top = Mathf.Max(top, GroundAt(p.x + Mathf.Cos(angle) * radius, p.z + Mathf.Sin(angle) * radius));
            }
            return new Vector3(p.x, top + above, p.z);
        }

        // The highest ground at x,z: terrains and course meshes, not water planes (or anything else: props, walls).
        static float GroundAt(float x, float z)
        {
            float top = float.NegativeInfinity;
            foreach (var h in Physics.RaycastAll(new Vector3(x, 10000f, z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore))
            {
                var n = h.collider.gameObject.name;
                bool ground = h.collider is TerrainCollider
                    || (!IsWaterPlane(n) && (n.StartsWith("Spline_", StringComparison.Ordinal) || n.StartsWith("Gap_Issue_", StringComparison.Ordinal)));
                if (ground && h.point.y > top) top = h.point.y;
            }
            return top;
        }

        static Dictionary<string, object> Describe(GameObject p, bool ours, List<Lake> lakes)
        {
            var mesh = p.GetComponent<MeshFilter>().sharedMesh;
            var r = p.GetComponent<Renderer>();
            var d = new Dictionary<string, object>
            {
                { "path", PathOf(p) },
                { "active", p.activeInHierarchy },
                { "madeHere", ours },
                { "mesh", AssetDatabase.GetAssetPath(mesh) },
                { "verts", mesh.vertexCount },
                { "surfaceM", r != null ? Round(r.bounds.max.y) : (object)null },
                { "liftM", Round(p.transform.localPosition.y) },
                { "covers", lakes.Where(l => Covers(p, l.bounds)).Select(l => (object)l.go.name).ToList() },
            };
            return d;
        }

        // What the plane ended up with: OPCD's material, physics and probe.
        static Dictionary<string, object> Check(GameObject go)
        {
            var r = go.GetComponent<MeshRenderer>();
            var c = go.GetComponent<MeshCollider>();
            var probes = Probes(go).ToList();
            var d = new Dictionary<string, object>
            {
                { "path", PathOf(go) },
                { "mesh", AssetDatabase.GetAssetPath(go.GetComponent<MeshFilter>().sharedMesh) },
                { "surfaceM", Round(r.bounds.max.y) },
                { "material", r.sharedMaterial != null ? r.sharedMaterial.name : null },
                { "physics", c != null && c.sharedMaterial != null ? c.sharedMaterial.name : null },
                { "probes", probes.Select(p => (object)new Dictionary<string, object> { { "name", p.name }, { "position", Vec(p.transform.position) }, { "mode", p.mode.ToString() }, { "refresh", p.refreshMode.ToString() } }).ToList() },
                { "probeAnchor", r.probeAnchor != null ? r.probeAnchor.name : null },
            };
            var problems = new List<object>();
            if (r.sharedMaterial == null || r.sharedMaterial.name.IndexOf("WaterPlane", StringComparison.OrdinalIgnoreCase) < 0) problems.Add("no water plane material");
            if (c == null || c.sharedMaterial == null || c.sharedMaterial.name != "GSPwater") problems.Add("collider has no GSPwater physic material (GSPro would not call it water)");
            if (probes.Count != 1) problems.Add(probes.Count + " reflection probes (expected 1: " + ProbeName + ")");
            if (probes.Count > 0 && r.probeAnchor != probes[0].transform) problems.Add("renderer's anchor override is not its probe");
            if (probes.Count > 0 && GroundAt(probes[0].transform.position.x, probes[0].transform.position.z) > probes[0].transform.position.y)
                problems.Add("reflection probe is under the ground: the water reflects it black");
            if (problems.Count > 0) d["problems"] = problems;
            return d;
        }

        static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parts = folder.Split('/');
            var path = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                var next = path + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(path, parts[i]);
                path = next;
            }
        }

        static object Round(float v) { return Math.Round(v, 3); }

        static List<object> Vec(Vector3 v) { return new List<object> { Round(v.x), Round(v.y), Round(v.z) }; }

        static string PathOf(GameObject go)
        {
            var path = go.name;
            for (var t = go.transform.parent; t != null; t = t.parent) path = t.name + "/" + path;
            return "/" + path;
        }

        static void Log(Dictionary<string, object> result)
        {
            Debug.Log("[GolfMap Waterplanes] " + GolfMapJson.Serialize(result));
        }

        // The build in a few lines, for the Scene view and the Console.
        static string Summary(Dictionary<string, object> result)
        {
            Func<object, string> num = o => Convert.ToString(o, System.Globalization.CultureInfo.InvariantCulture);
            Func<object, string> join = list => string.Join(", ", ((List<object>)list).Select(o => o.ToString()).ToArray());
            var lines = new List<string>();
            foreach (Dictionary<string, object> e in (List<object>)result["lakes"])
            {
                if (e.ContainsKey("coveredBy") && ((string)e["action"]).StartsWith("skip", StringComparison.Ordinal))
                    lines.Add(e["lake"] + ": not built, " + join(e["coveredBy"]) + " already covers it (switch that off to build one here)");
                else
                    lines.Add((e["action"].Equals("rebuild") ? "Rebuilt " : "Built ") + e["plane"] + ": water at " + num(e["surfaceM"]) + " m, " + num(e["liftM"]) + " m over the level (its Y)");
                if (e.ContainsKey("warning")) lines.Add(e["warning"].ToString());
            }
            foreach (Dictionary<string, object> b in (List<object>)result["built"])
                if (b.ContainsKey("problems")) lines.Add(b["path"] + ": " + join(b["problems"]));
            foreach (var s in (List<object>)result["errors"]) lines.Add(s.ToString());
            if (result.ContainsKey("ignored")) foreach (var s in (List<object>)result["ignored"]) lines.Add("Skipped " + s);
            return lines.Count > 0 ? string.Join("\n", lines.ToArray()) : "Nothing built.";
        }

        static void Tell(string message, bool warn)
        {
            if (warn) Debug.LogWarning("[GolfMap Waterplanes] " + message);
            else Debug.Log("[GolfMap Waterplanes] " + message);
            var view = SceneView.lastActiveSceneView;
            if (view != null) view.ShowNotification(new GUIContent(message));
        }
    }
}
