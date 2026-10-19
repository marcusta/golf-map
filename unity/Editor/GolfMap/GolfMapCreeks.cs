// Unity 2018.2 / C# 6. Creeks as NatureManufacture R.A.M. splines.
//
// golf-map exports each creek as a unity-creeks-v1 spline (gspro.py creeks,
// the GSPro panel's "Export creeks"): control points in inner-plot metres at
// the creek's water surface, which only falls downstream, plus the width and
// the R.A.M. profile asset to use. The creek's bed is dug below that same
// surface in the heightmap ("Dig creeks"), so the water sits in its bed once
// the terrain and the Blender meshes are rebuilt.
//
// Import makes one RamSpline per creek under a "GolfMap Creeks" object, named
// "Creek <id>" and keyed by that name, so a re-import refills the same spline
// (its points are replaced; hand edits to them are not kept) and removes
// creeks no longer exported. The profile is applied the way R.A.M.'s own
// profile picker does (RamSplineEditor.ResetToProfile). R.A.M. lives in
// Assembly-CSharp, which the offline compile check cannot see, so its types
// are found by name.
//
// The export gives each creek its line; the scene gives its shape. Unless
// fit=false, every spline is fitted to the course meshes under it (Spline_*,
// the terrain where there are none), so a re-import after the creeks, the
// heightmap or the Blender meshes changed puts the water back in its bed:
// - height: aboveBedM over the lowest ground across the creek, the highest
//   such bed along the stretch each control point stands for. Not forced to
//   fall: held up behind a bump, the water would stand above its banks.
//   A creek cut at its waterfalls (gspro.py creeks: one spline per stretch
//   between falls, `stretches`) is a chain of dug ponds: each keeps the
//   export's water and only rises where the bed stands above it;
// - crossings: a path over a culvert or an undug hump (see BumpM) is bridged
//   at the bed level either side, so the water runs hidden under it;
// - width: across each station (every metre) the water runs out to where the
//   ground rises buryM above it, then bankM further (short of where the ground
//   dips back under the water), so its edges sit inside the banks with no gap
//   under them. The two sides are measured apart and the point moved across
//   to centre the water between them, by little more from point to point
//   than their spacing allows (ShiftSlope). At a fall the export's points
//   over the sill and down the face are the neck: on the export's line, no
//   wider than the lip, the water opening out from them gradually
//   (NeckFlareM). A point at a corner too sharp for the water's width (two
//   sections crossing: R.A.M. folds the mesh there) is dropped;
// - ends: both ends run on along the line until the ground rises the same
//   way, then bankM into the bank. An end at a lake (a water plane within
//   LakeGapM of it) instead runs on pondFadeM past the lake's shore, and the
//   water fades out over the lake there (R.A.M.'s vertex colour alpha: 1 at
//   the shore, 0 pondFadeM into the lake), so the creek's colour does not
//   stop in a hard edge on the lake's. The points within ShoreM of the lake
//   stand on its bank, not the creek's bed: the water runs on flat and as
//   wide from the last point before them (no lip, no neck, no cascade foam).
// A side or end that never meets a bank (a creek into another creek, flat
// ground) keeps the export's width or end and is counted "open".
//
// The report compares each creek's exported surface with the ground under it
// (the highest collider straight down: the course meshes) and gives the fit.
//
// Look (water=lake, the default): the creeks wear the lakes' water, a copy of
// OPCD's AQUAS water plane material (<course>/Creeks/, made once and then kept,
// so hand tuning stays), and reflect the nearest lake's probe, so a creek
// running into a pond is the same water. water=profile keeps R.A.M.'s own
// material (the profile's, with its flow and foam).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapCreeks
    {
        public const string Format = "unity-creeks-v1";
        const string RootName = "GolfMap Creeks";
        const string NamePrefix = "Creek ";
        const string LakeMaterial = "OPCD-WaterPlane_AquasLite";  // OPCD's Set Default Materials puts it on water planes
        const string MaterialFolder = "Creeks";
        const string CreekMaterial = "Creek water (lake)";
        // RamSplineEditor.ResetToProfile's list: profile field -> spline field (same names).
        static readonly string[] ProfileFields =
        {
            "meshCurve", "minVal", "maxVal", "traingleDensity", "vertsInShape", "uvScale", "uvRotation",
            "flowFlat", "flowWaterfall", "terrainCarve", "distSmooth", "distSmoothStart", "terrainPaintCarve",
            "receiveShadows", "shadowCastingMode",
        };

        sealed class Creek
        {
            public string id, profile, source;
            public float widthM, lengthM, fallM;
            // A creek with waterfalls (the export's `falls`): a chain of dug ponds, each holding its water, the spline
            // dropping over each lip (fallsAt, plot x/z) where R.A.M. draws the cascade.
            public bool held;
            public List<Vector2> fallsAt = new List<Vector2>();
            // The points gspro.py put over each sill and down its face (`fallPoints`, indices into points): the neck.
            public HashSet<int> fallPoints = new HashSet<int>();
            // The look for this creek alone (the feature's ramWater: lake|profile), else the import's.
            public string water;
            // An asset path of a material this creek alone wears (the feature's ramWaterMaterial), over `water`: Omberg's hole 17
            // brook, a course copy of R.A.M.'s water tuned to blend with the ponds beside it.
            public string waterMaterial;
            // The water's height over this creek's lowest ground, instead of the import's aboveBedM (the feature's ramAboveBedM).
            public float aboveBedM = float.NaN;
            // Where a vertex paint rule that names this creek stops painting, metres under the grass level, on each side looking
            // downstream (the feature's grassBelowLeftM / grassBelowRightM); NaN = the rule's own.
            public float grassBelowLeftM = float.NaN, grassBelowRightM = float.NaN;
            public List<Vector4> points = new List<Vector4>();
        }

        public sealed class FitOptions
        {
            public bool fit = true;
            public float aboveBedM = 0.15f, buryM = 0.05f, bankM = 2f, searchM = 8f;
            public string trace;  // a creek id (or part of one): its stations go into the result
            public string water = "lake";  // lake: the lakes' AQUAS water; profile: R.A.M.'s material
            public float pondFadeM = 2f;  // how far into a lake a creek's water runs and fades out; 0 = no fade, every vertex opaque
            // golfmap.course.refresh only=: refit just the creeks with a point inside one of these (world XZ); the others
            // are left as they are and none is removed. Null = every creek of the export.
            public List<Rect> within;
        }

        [MenuItem("GolfMap/Creeks/Import creeks (R.A.M.)")]
        static void Menu() { Debug.Log("[GolfMap Creeks] " + GolfMapJson.Serialize(Import(null, false, new FitOptions()), false)); }

        [MenuItem("GolfMap/Creeks/Water like the lakes")]
        static void MenuLake() { Debug.Log("[GolfMap Creeks] " + GolfMapJson.Serialize(Style("lake"), false)); }

        [MenuItem("GolfMap/Creeks/Water from the R.A.M. profile")]
        static void MenuProfile() { Debug.Log("[GolfMap Creeks] " + GolfMapJson.Serialize(Style("profile"), false)); }

        [BridgeCommand("golfmap.creeks.import", "Import the course's unity-creeks-v1 export (<prefix>-inner-creeks.json) as NatureManufacture R.A.M. splines under 'GolfMap Creeks': one RamSpline per creek with its profile, fitted to the course meshes under it (water aboveBedM over the bed; each side out to where the bank rises above the water plus bankM; both ends run on into the bank the same way, or at a lake pondFadeM past its shore, the water fading out over the lake by vertex alpha), wearing the lakes' water (water=lake) or the profile's material (water=profile). Re-import after changing creeks, heightmap or meshes refits them in place (points and transform reset) and removes creeks no longer exported. Marks the scene dirty; save=true saves it (and the assets it changed) once the import has succeeded.",
            args = "file (default: the active course's export), dryRun=false, fit=true (false: the export's surface and width as they are), aboveBedM=0.15, bankM=2, buryM=0.05, searchM=8 (how far past the export's half width to look for a bank), trace (a creek id or part of one: its fit station by station), water=lake|profile, pondFadeM=2 (0: no fade at lakes), " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            var o = new FitOptions();
            o.fit = a.Bool("fit", o.fit);
            o.aboveBedM = (float)a.Number("aboveBedM", o.aboveBedM);
            o.bankM = (float)a.Number("bankM", o.bankM);
            o.buryM = (float)a.Number("buryM", o.buryM);
            o.searchM = (float)a.Number("searchM", o.searchM);
            o.trace = a.String("trace");
            o.water = a.String("water") ?? o.water;
            o.pondFadeM = (float)a.Number("pondFadeM", o.pondFadeM);
            return Import(a.String("file"), a.Bool("dryRun", false), o);
        }

        [BridgeCommand("golfmap.creeks.water", "Set the look of the imported creeks without refitting them: water=lake gives every creek under 'GolfMap Creeks' the lakes' water (a copy of OPCD's AQUAS water plane material in <course>/Creeks/, made once and then kept, so hand tuning stays) and the nearest lake's reflection probe; water=profile puts back each spline's R.A.M. profile material. Marks the scene dirty; save=true saves it (and the assets it changed) once it has succeeded.",
            args = "water=lake|profile, " + GolfMapSceneSave.Arg)]
        static object WaterCommand(BridgeArgs a) { return Style(a.String("water") ?? "lake"); }

        public static Dictionary<string, object> Import(string file, bool dryRun, FitOptions fit)
        {
            CheckWater(fit.water);
            var course = GolfMapCourses.Require();
            file = string.IsNullOrEmpty(file) ? GolfMapCourses.ExportFile(course, "inner", "creeks") : file;
            if (string.IsNullOrEmpty(file) || !File.Exists(file))
                throw new InvalidOperationException("No creeks export at " + (file ?? "(the course has no export folder)") + ": run \"Export creeks\" on the Creeks row of golf-map's GSPro board.");
            var creeks = Load(file);
            int exported = creeks.Count;
            if (fit.within != null)
                creeks = creeks.Where(c => c.points.Any(p => fit.within.Any(r => r.Contains(new Vector2(p.x, p.z))))).ToList();

            var splineType = FindType("RamSpline");
            var profileType = FindType("SplineProfile");
            if (splineType == null || profileType == null)
                throw new InvalidOperationException("NatureManufacture R.A.M. (RamSpline, SplineProfile) is not in this project.");

            var scene = EditorSceneManager.GetActiveScene();
            var root = scene.GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
            var existing = root == null ? new Dictionary<string, GameObject>()
                : root.transform.Cast<Transform>().Where(t => t.name.StartsWith(NamePrefix, StringComparison.Ordinal))
                    .GroupBy(t => t.name).ToDictionary(g => g.Key, g => g.First().gameObject);
            var profiles = new Dictionary<string, UnityEngine.Object>();
            var missingProfiles = new SortedSet<string>();
            var rows = new List<object>();
            var imported = new List<GameObject>();
            var perCreek = new Dictionary<GameObject, string>();
            var ownMaterial = new Dictionary<GameObject, string>();
            int created = 0, updated = 0;

            if (!dryRun)
            {
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Import creeks");
                if (root == null)
                {
                    root = new GameObject(RootName);
                    Undo.RegisterCreatedObjectUndo(root, "Import creeks");
                }
            }
            int undoGroup = Undo.GetCurrentGroup();

            foreach (var c in creeks)
            {
                var name = NamePrefix + c.id;
                UnityEngine.Object profile;
                if (!profiles.TryGetValue(c.profile, out profile)) profiles[c.profile] = profile = FindProfile(c.profile, profileType);
                if (profile == null) missingProfiles.Add(c.profile);
                var row = new Dictionary<string, object>
                {
                    { "id", c.id }, { "points", c.points.Count }, { "lengthM", c.lengthM }, { "fallM", c.fallM }, { "source", c.source },
                    { "profile", profile != null ? c.profile : c.profile + " (missing)" },
                    { "groundAboveExportSurfaceM", GroundOffsets(c.points) },
                    { "status", existing.ContainsKey(name) ? "update" : "create" },
                };
                if (fit.fit) row["fit"] = Fit(c, fit);
                rows.Add(row);
                GameObject go;
                if (dryRun) { existing.Remove(name); continue; }

                Component spline;
                if (existing.TryGetValue(name, out go) && (spline = go.GetComponent(splineType)) != null)
                {
                    Undo.RecordObject(spline, "Import creeks");
                    Undo.RecordObject(go.transform, "Import creeks");
                    // The points are plot coordinates: a hand-moved spline object would offset them.
                    go.transform.localPosition = Vector3.zero;
                    go.transform.localRotation = Quaternion.identity;
                    go.transform.localScale = Vector3.one;
                    splineType.GetMethod("RemovePoints").Invoke(spline, new object[] { -1 });
                    updated++;
                }
                else
                {
                    var material = profile != null ? profileType.GetField("splineMaterial").GetValue(profile) as Material : null;
                    spline = (Component)splineType.GetMethod("CreateSpline", BindingFlags.Public | BindingFlags.Static)
                        .Invoke(null, new object[] { material, null });
                    go = spline.gameObject;
                    go.name = name;
                    go.transform.SetParent(root.transform, false);
                    go.transform.localPosition = Vector3.zero;
                    Undo.RegisterCreatedObjectUndo(go, "Import creeks");
                    created++;
                }
                existing.Remove(name);
                var addPoint = splineType.GetMethod("AddPoint", new[] { typeof(Vector4) });
                foreach (var p in c.points) addPoint.Invoke(spline, new object[] { p });
                splineType.GetField("width").SetValue(spline, c.widthM);
                splineType.GetField("snapToTerrain").SetValue(spline, false);
                if (profile != null) ApplyProfile(spline, splineType, profile, profileType);
                splineType.GetMethod("GenerateSpline").Invoke(spline, new object[] { null });
                int faded = FadeIntoLakes(spline, splineType, fit.pondFadeM);
                if (faded > 0) row["lakeFadeVertices"] = faded;
                EditorUtility.SetDirty(spline);
                imported.Add(go);
                if (c.water == "lake" || c.water == "profile") perCreek[go] = c.water;
                if (!string.IsNullOrEmpty(c.waterMaterial)) ownMaterial[go] = c.waterMaterial;
            }

            // Creeks no longer in the export (not when only some were refitted).
            if (fit.within != null) existing.Clear();
            var removed = existing.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            Dictionary<string, object> water = null;
            if (!dryRun)
            {
                water = Wear(imported, fit.water, course, splineType, profileType, perCreek, ownMaterial);
                foreach (var go in existing.Values) Undo.DestroyObjectImmediate(go);
                Undo.CollapseUndoOperations(undoGroup);
                EditorSceneManager.MarkSceneDirty(scene);
                SceneView.RepaintAll();
            }

            var result = new Dictionary<string, object>
            {
                { "file", file }, { "dryRun", dryRun }, { "creeks", creeks.Count }, { "exported", exported },
                { "fit", fit.fit ? (object)new Dictionary<string, object> { { "aboveBedM", fit.aboveBedM }, { "bankM", fit.bankM }, { "buryM", fit.buryM }, { "searchM", fit.searchM } } : false },
                { "created", created }, { "updated", updated }, { "removed", removed },
                { "missingProfiles", missingProfiles.ToList() },
                { "water", water ?? (object)fit.water },
                { "rows", rows },
            };
            WriteReport(course, result);
            return result;
        }

        // The line (plot x, z, downstream) and the per-side paint depths of one exported creek, for GolfMapVertexPaint's object rules;
        // null when the course has no creeks export or the creek is not in it.
        internal static List<Vector2> SideLine(string creekId, out float left, out float right)
        {
            left = right = float.NaN;
            var course = GolfMapCourses.Require();
            var file = GolfMapCourses.ExportFile(course, "inner", "creeks");
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) return null;
            var c = Load(file).FirstOrDefault(x => x.id == creekId);
            if (c == null) return null;
            left = c.grassBelowLeftM; right = c.grassBelowRightM;
            return c.points.Select(p => new Vector2(p.x, p.z)).ToList();
        }

        static List<Creek> Load(string file)
        {
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            if (root.String("format") != Format) throw new InvalidOperationException(file + ": format must be " + Format + ".");
            var plot = root.Object("plot");
            if (plot == null || plot.String("terrain") != "inner") throw new InvalidOperationException(file + ": creeks are for the inner terrain.");
            var list = new List<Creek>();
            foreach (var o in (root.Array("creeks") ?? new List<object>()).OfType<GolfMapJsonObject>())
            {
                var c = new Creek
                {
                    id = o.String("id"), profile = o.String("profile") ?? "Small Stream Profile", source = o.String("source") ?? "",
                    widthM = (float)o.Number("widthM", 2), lengthM = (float)o.Number("lengthM"), fallM = (float)o.Number("fallM"),
                    held = o.Number("stretches", 0) > 1 || o.Number("falls", 0) > 0,
                    water = o.String("water"), waterMaterial = o.String("waterMaterial"),
                    aboveBedM = (float)o.Number("aboveBedM", float.NaN),
                    grassBelowLeftM = (float)o.Number("grassBelowLeftM", float.NaN),
                    grassBelowRightM = (float)o.Number("grassBelowRightM", float.NaN),
                };
                foreach (var q in (o.Array("fallsAt") ?? new List<object>()).OfType<List<object>>())
                {
                    var v = q.OfType<GolfMapJsonNumber>().Select(n => (float)n.Value).ToArray();
                    if (v.Length >= 2) c.fallsAt.Add(new Vector2(v[0], v[1]));
                }
                foreach (var q in (o.Array("fallPoints") ?? new List<object>()).OfType<GolfMapJsonNumber>()) c.fallPoints.Add((int)q.Value);
                foreach (var p in (o.Array("points") ?? new List<object>()).OfType<List<object>>())
                {
                    var v = p.OfType<GolfMapJsonNumber>().Select(n => (float)n.Value).ToArray();
                    if (v.Length >= 4) c.points.Add(new Vector4(v[0], v[1], v[2], v[3]));
                }
                if (!string.IsNullOrEmpty(c.id) && c.points.Count >= 2) list.Add(c);
            }
            return list;
        }

        // RamSplineEditor.ResetToProfile, by reflection.
        static void ApplyProfile(Component spline, Type splineType, UnityEngine.Object profile, Type profileType)
        {
            splineType.GetField("currentProfile").SetValue(spline, profile);
            foreach (var f in ProfileFields)
            {
                var from = profileType.GetField(f);
                var to = splineType.GetField(f);
                if (from != null && to != null) to.SetValue(spline, from.GetValue(profile));
            }
            var curve = (AnimationCurve)splineType.GetField("meshCurve").GetValue(spline);
            var curves = (List<AnimationCurve>)splineType.GetField("controlPointsMeshCurves").GetValue(spline);
            for (int i = 0; i < curves.Count; i++) curves[i] = new AnimationCurve(curve.keys);
            var renderer = spline.GetComponent<MeshRenderer>();
            var material = profileType.GetField("splineMaterial").GetValue(profile) as Material;
            if (renderer != null && material != null) renderer.sharedMaterial = material;
            splineType.GetField("oldProfile").SetValue(spline, profile);
        }

        static UnityEngine.Object FindProfile(string name, Type profileType)
        {
            return AssetDatabase.FindAssets(name + " t:" + profileType.Name)
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(p => Path.GetFileNameWithoutExtension(p) == name)
                .Select(p => AssetDatabase.LoadAssetAtPath(p, profileType))
                .FirstOrDefault(o => o != null);
        }

        static void CheckWater(string water)
        {
            if (water != "lake" && water != "profile") throw new ArgumentException("water must be lake or profile, not " + water + ".");
        }

        // golfmap.creeks.water: the look alone, on the creeks already imported.
        static Dictionary<string, object> Style(string water)
        {
            CheckWater(water);
            var course = GolfMapCourses.Require();
            var splineType = FindType("RamSpline");
            var profileType = FindType("SplineProfile");
            if (splineType == null || profileType == null)
                throw new InvalidOperationException("NatureManufacture R.A.M. (RamSpline, SplineProfile) is not in this project.");
            var scene = EditorSceneManager.GetActiveScene();
            var root = scene.GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
            if (root == null) throw new InvalidOperationException("No '" + RootName + "' in the scene: import the creeks first.");
            var creeks = root.transform.Cast<Transform>().Select(t => t.gameObject).Where(g => g.GetComponent(splineType) != null).ToList();
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Creek water");
            var result = Wear(creeks, water, course, splineType, profileType);
            EditorSceneManager.MarkSceneDirty(scene);
            SceneView.RepaintAll();
            return result;
        }

        // Give the creeks their water: the lakes' (a course copy of OPCD's AQUAS
        // material, reflecting the nearest lake's probe) or each spline's profile
        // material. The parts R.A.M. splits a long spline into follow the parent.
        static Dictionary<string, object> Wear(List<GameObject> creeks, string water, GolfMapCourse course, Type splineType, Type profileType,
            Dictionary<GameObject, string> perCreek = null, Dictionary<GameObject, string> ownMaterial = null)
        {
            perCreek = perCreek ?? new Dictionary<GameObject, string>();
            ownMaterial = ownMaterial ?? new Dictionary<GameObject, string>();
            Func<GameObject, string> waterOf = go => { string w; return perCreek.TryGetValue(go, out w) ? w : water; };
            var result = new Dictionary<string, object> { { "water", water }, { "creeks", creeks.Count } };
            if (perCreek.Count > 0) result["ownWater"] = perCreek.ToDictionary(kv => kv.Key.name, kv => (object)kv.Value);
            Material lake = null;
            var probes = new List<ReflectionProbe>();
            if (creeks.Any(go => waterOf(go) == "lake"))
            {
                string made;
                lake = LakeLook(course, out made);
                if (lake == null)
                {
                    result["error"] = "No '" + LakeMaterial + "' material in the project (OPCD's water plane material): the creeks keep their material.";
                    return result;
                }
                result["material"] = AssetDatabase.GetAssetPath(lake);
                if (made != null) result["madeFrom"] = made;
                probes = UnityEngine.Object.FindObjectsOfType<ReflectionProbe>()
                    .Where(p => p.transform.parent != null && GolfMapWaterplanes.IsWaterPlane(p.transform.parent.name) && p.gameObject.activeInHierarchy)
                    .ToList();
                result["lakeProbes"] = probes.Count;
            }
            var anchors = new SortedDictionary<string, int>(StringComparer.Ordinal);
            foreach (var go in creeks)
            {
                Material material = waterOf(go) == "lake" ? lake : null;
                if (material == null)
                {
                    var profile = splineType.GetField("currentProfile").GetValue(go.GetComponent(splineType)) as UnityEngine.Object;
                    material = profile != null ? profileType.GetField("splineMaterial").GetValue(profile) as Material : null;
                    // A creek with its own R.A.M. look wears the course's copy of the profile's material (made once,
                    // then kept: its cascade and foam are tuned there, the package's material is left alone).
                    if (perCreek.ContainsKey(go) && material != null) material = ProfileLook(course, material);
                }
                string ownPath;
                if (ownMaterial.TryGetValue(go, out ownPath))
                {
                    var own = AssetDatabase.LoadAssetAtPath<Material>(ownPath);
                    if (own != null) material = own;
                    else result["missingWaterMaterial"] = ownPath;
                }
                var centre = go.GetComponent<Renderer>() != null ? go.GetComponent<Renderer>().bounds.center : go.transform.position;
                var probe = probes.OrderBy(p => (p.transform.position - centre).sqrMagnitude).FirstOrDefault();
                if (probe != null)
                {
                    var key = probe.transform.parent.name;
                    int n;
                    anchors.TryGetValue(key, out n);
                    anchors[key] = n + 1;
                }
                foreach (var r in go.GetComponentsInChildren<MeshRenderer>(true))
                {
                    Undo.RecordObject(r, "Creek water");
                    if (material != null) r.sharedMaterial = material;
                    r.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.BlendProbes;
                    // A lake's probe only reaches inside its box; the anchor makes the creek reflect it anywhere.
                    r.probeAnchor = probe != null ? probe.transform : null;
                }
            }
            if (lake != null) result["probeFrom"] = anchors.ToDictionary(kv => kv.Key, kv => (object)kv.Value);
            return result;
        }

        // "<course>/Creeks/Creek water (<R.A.M. material>).mat": made once from the profile's material, then left as it is.
        static Material ProfileLook(GolfMapCourse course, Material from)
        {
            var folder = GolfMapCourses.Folder(course) + MaterialFolder;
            var path = folder + "/Creek water (" + from.name + ").mat";
            var have = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (have != null) return have;
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(folder.Substring(0, folder.LastIndexOf('/')), MaterialFolder);
            var made = new Material(from);
            AssetDatabase.CreateAsset(made, path);
            return made;
        }

        // The course's creek water: made once from OPCD's water plane material, then left as it is.
        static Material LakeLook(GolfMapCourse course, out string madeFrom)
        {
            madeFrom = null;
            var folder = GolfMapCourses.Folder(course) + MaterialFolder;
            var path = folder + "/" + CreekMaterial + ".mat";
            var have = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (have != null) return have;
            var source = AssetDatabase.FindAssets(LakeMaterial + " t:Material")
                .Select(AssetDatabase.GUIDToAssetPath)
                .FirstOrDefault(p => Path.GetFileNameWithoutExtension(p) == LakeMaterial);
            if (source == null) return null;
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(folder.Substring(0, folder.LastIndexOf('/')), MaterialFolder);
            if (!AssetDatabase.CopyAsset(source, path)) return null;
            madeFrom = source;
            return AssetDatabase.LoadAssetAtPath<Material>(path);
        }

        static Type FindType(string name)
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => { try { return a.GetType(name, false); } catch { return null; } })
                .FirstOrDefault(t => t != null);
        }

        const float StationM = 1f, StepM = 0.25f;
        // A station whose bed stands BumpM above lower bed within CrossingM both
        // upstream and downstream is on a road or path across the creek (a
        // culvert), with its ramps down to within RampM of that lower bed: the
        // water runs under it at the bed level either side, hidden.
        const float BumpM = 0.3f, CrossingM = 20f, RampM = 0.1f;
        // No crossing within this of a waterfall's lip (its sill is no culvert).
        const float FallClearM = 4f;
        // A fall's neck: the export's fallPoints (over the sill, the lip, down the face), else its points within NeckM of it.
        // The water opens out from it at NeckFlareM a side per metre; the line moves across at most ShiftSlope per metre.
        const float NeckM = 2.5f, NeckFlareM = 0.75f, ShiftSlope = 0.25f;

        sealed class Station
        {
            public Vector2 pos, right;
            public float s, half, bed = float.NaN;
            public int owner, lowest;
            public bool crossing;
            public float[] ground;
        }

        // Fits c.points to the course meshes in place (see the header).
        static Dictionary<string, object> Fit(Creek c, FitOptions o)
        {
            var pts = c.points;
            int n = pts.Count;
            var cum = new float[n];
            for (int i = 1; i < n; i++) cum[i] = cum[i - 1] + Vector2.Distance(XZ(pts[i - 1]), XZ(pts[i]));
            float total = cum[n - 1];
            if (total <= 0) return new Dictionary<string, object> { { "skipped", "zero length" } };

            // Stations every metre, each owned by the control point nearest along the line.
            int ns = Mathf.Max(2, Mathf.CeilToInt(total / StationM) + 1);
            var stations = new Station[ns];
            for (int k = 0, j = 0; k < ns; k++)
            {
                float s = total * k / (ns - 1);
                while (j < n - 2 && cum[j + 1] < s) j++;
                float seg = Mathf.Max(cum[j + 1] - cum[j], 1e-4f), t = Mathf.Clamp01((s - cum[j]) / seg);
                Vector2 a = XZ(pts[j]), b = XZ(pts[j + 1]), dir = (b - a).normalized;
                var st = new Station
                {
                    s = s, pos = Vector2.Lerp(a, b, t), right = new Vector2(dir.y, -dir.x),
                    half = Mathf.Lerp(pts[j].w, pts[j + 1].w, t) / 2f, owner = t < 0.5f ? j : j + 1,
                };
                int m = Mathf.CeilToInt((st.half + o.searchM) / StepM);
                st.ground = new float[2 * m + 1];
                for (int i = 0; i < st.ground.Length; i++) st.ground[i] = GroundAt(st.pos + st.right * ((i - m) * StepM));
                // The bed: the lowest ground within the export's half width of the line.
                int inner = Mathf.Max(2, Mathf.CeilToInt(st.half / StepM));
                for (int i = m - inner; i <= m + inner; i++)
                    if (!float.IsNaN(st.ground[i]) && (float.IsNaN(st.bed) || st.ground[i] < st.bed)) { st.bed = st.ground[i]; st.lowest = i; }
                stations[k] = st;
            }

            // Places to look at in the scene (plot x, z): what the fit could not settle.
            var check = new List<object>();
            Action<Vector2, string> flag = (p, what) =>
            {
                if (check.Count < 12) check.Add(new Dictionary<string, object> { { "x", Math.Round(p.x, 1) }, { "z", Math.Round(p.y, 1) }, { "what", what } });
            };

            // Crossings, then each station's bed with the crossings bridged.
            int window = Mathf.CeilToInt(CrossingM * (ns - 1) / total);
            for (int k = 0; k < ns; k++)
            {
                float b = stations[k].bed;
                if (float.IsNaN(b)) continue;
                float up = SideLow(stations, k - window, k - 1), down = SideLow(stations, k + 1, k + window);
                stations[k].crossing = !float.IsNaN(up) && !float.IsNaN(down) && b > Mathf.Max(up, down) + BumpM
                    // A waterfall's sill stands above the ponds either side: the water goes over it, not under.
                    && !c.fallsAt.Any(fp => Vector2.Distance(fp, stations[k].pos) < FallClearM);
            }
            // A crossing takes in its ramps, down to the low bed either side.
            for (int k = 0; k < ns; k++)
            {
                if (!stations[k].crossing) continue;
                int e = k;
                while (e < ns && stations[e].crossing) e++;
                float upLow = SideLow(stations, k - window, k - 1), downLow = SideLow(stations, e, e + window);
                for (int q = k - 1; q >= Math.Max(0, k - window) && stations[q].bed > upLow + RampM; q--) stations[q].crossing = true;
                for (int q = e; q <= Math.Min(ns - 1, e + window) && stations[q].bed > downLow + RampM; q++) { stations[q].crossing = true; e = q + 1; }
                k = e;
            }
            var bed = new float[ns];
            int crossings = 0;
            for (int k = 0; k < ns; k++)
            {
                bed[k] = stations[k].bed;
                if (!stations[k].crossing && !float.IsNaN(bed[k])) continue;
                int a = k - 1, e = k;
                while (e < ns && (stations[e].crossing || float.IsNaN(stations[e].bed))) e++;
                float from = a >= 0 ? stations[a].bed : e < ns ? stations[e].bed : float.NaN;
                float to = e < ns ? stations[e].bed : from;
                for (int q = k; q < e; q++) bed[q] = float.IsNaN(from) ? float.NaN : Mathf.Lerp(from, to, (q - a) / (float)(e - a));
                float high = 0;
                for (int q = k; q < e; q++) if (stations[q].crossing) high = Mathf.Max(high, stations[q].bed - bed[q]);
                if (stations.Skip(k).Take(e - k).Any(st => st.crossing))
                {
                    crossings++;
                    flag(stations[(k + e - 1) / 2].pos, "crossing: " + (e - k) + " m of bed up to " + M(high) + " m above the bed either side, water run under it");
                }
                k = e - 1;
            }

            // Heights: over the highest bed each point stands for.
            var y = new float[n];
            float above = float.IsNaN(c.aboveBedM) ? o.aboveBedM : c.aboveBedM;
            for (int i = 0; i < n; i++)
            {
                float highest = float.NegativeInfinity;
                for (int k = 0; k < ns; k++)
                    if (stations[k].owner == i && !float.IsNaN(bed[k])) highest = Mathf.Max(highest, bed[k]);
                y[i] = float.IsNegativeInfinity(highest) ? pts[i].y
                    : c.held ? Mathf.Max(pts[i].y, highest + above) : highest + above;
            }
            // At a lake end the bed is the lake's bank (a lip where the creek's and the lake's digs meet), not the creek's:
            // from the last point before it the water runs on flat, and as wide (below), into the lake.
            var atLake = o.pondFadeM > 0 ? LakeEnds(pts) : new bool[n];
            for (int i = 0; i < n; i++)
            {
                int k = NotAtLake(atLake, i);
                if (k != i) y[i] = y[k];
            }
            // Not forced to fall: held up to the next bump downstream, the water
            // would stand above its banks behind it. Climbs are reported.
            float climb = 0;
            int climbAt = 0;
            for (int i = 1; i < n; i++) if (y[i] - y[i - 1] > climb) { climb = y[i] - y[i - 1]; climbAt = i; }
            if (climb > 0.2f) flag(XZ(pts[climbAt]), "water climbs " + M(climb) + " m from the point upstream");

            // Sides: each station's reach into its banks at the water height there.
            var extent = new float[n, 2];
            var found = new bool[n, 2];
            foreach (var st in stations)
            {
                if (float.IsNaN(st.bed) || st.crossing) continue;
                float h = WaterAt(st.s, cum, y);
                int m = (st.ground.Length - 1) / 2;
                for (int side = 0; side < 2; side++)
                {
                    float reach;
                    if (!Reach(st.ground, st.lowest, side == 0 ? -1 : 1, h, o, out reach)) continue;
                    reach += (st.lowest - m) * StepM * (side == 0 ? -1 : 1);
                    found[st.owner, side] = true;
                    extent[st.owner, side] = Mathf.Max(extent[st.owner, side], reach);
                }
            }
            // Points standing only on a crossing take the width either side of it.
            var half = new float[n, 2];
            var crossed = new bool[n];
            int openSides = 0;
            for (int i = 0; i < n; i++)
            {
                crossed[i] = stations.Any(st => st.owner == i && st.crossing) && !stations.Any(st => st.owner == i && !st.crossing && !float.IsNaN(st.bed));
                for (int side = 0; side < 2; side++) half[i, side] = found[i, side] ? extent[i, side] : pts[i].w / 2f;
                if (crossed[i] || atLake[i]) continue;
                if (!found[i, 0]) openSides++;
                if (!found[i, 1]) openSides++;
                if (!found[i, 0] || !found[i, 1]) flag(XZ(pts[i]), "no bank on the " + (!found[i, 0] && !found[i, 1] ? "either side" : !found[i, 0] ? "left" : "right") + ": export width kept");
            }
            for (int i = 0; i < n; i++)
            {
                if (!crossed[i]) continue;
                int a = i, b = i;
                while (a >= 0 && crossed[a]) a--;
                while (b < n && crossed[b]) b++;
                for (int side = 0; side < 2; side++)
                    half[i, side] = a >= 0 && b < n ? (half[a, side] + half[b, side]) / 2f : a >= 0 ? half[a, side] : b < n ? half[b, side] : half[i, side];
            }
            for (int i = 0; i < n; i++)
            {
                int k = NotAtLake(atLake, i);
                if (k != i) for (int side = 0; side < 2; side++) half[i, side] = half[k, side];
            }
            // Necks: the points over a sill and down its face (the export's fall points) stay on the export's line,
            // no wider than its lip; the water opens out from them at NeckFlareM a side per metre.
            var neck = new bool[n];
            foreach (int i in c.fallPoints) if (i >= 0 && i < n) neck[i] = true;
            // An export from before `fallPoints`: the points within NeckM of each fall along the line.
            foreach (var f in c.fallPoints.Count > 0 ? new List<Vector2>() : c.fallsAt)
            {
                int k = 0;
                for (int i = 1; i < n; i++) if (Vector2.Distance(XZ(pts[i]), f) < Vector2.Distance(XZ(pts[k]), f)) k = i;
                for (int i = 0; i < n; i++) if (Mathf.Abs(cum[i] - cum[k]) <= NeckM) neck[i] = true;
            }
            var shift = new float[n];
            var full = new float[n];
            for (int i = 0; i < n; i++)
            {
                float left = Mathf.Max(half[i, 0], StepM), right = Mathf.Max(half[i, 1], StepM);
                full[i] = neck[i] ? Mathf.Min(left + right, pts[i].w) : left + right;
                shift[i] = neck[i] ? 0 : (right - left) / 2f;
            }
            // The centre moves across at most ShiftSlope per metre along the line: a jump between two close
            // points turns their sections across the flow, and R.A.M. folds the mesh there.
            Limit(shift, cum, neck, ShiftSlope, false);
            var sides = new[] { new float[n], new float[n] };
            for (int i = 0; i < n; i++) { sides[0][i] = full[i] / 2f - shift[i]; sides[1][i] = full[i] / 2f + shift[i]; }
            Limit(sides[0], cum, neck, NeckFlareM, true);
            Limit(sides[1], cum, neck, NeckFlareM, true);
            var line = new List<int>();
            var at = new Vector2[n];
            for (int i = 0; i < n; i++)
            {
                line.Add(i);
                at[i] = XZ(pts[i]) + Right(pts, i) * ((sides[1][i] - sides[0][i]) / 2f);
            }
            // Corners: where two neighbours' sections cross inside the water (a short leg at a sharp turn), the
            // free point of the two at the sharper turn goes; the line then cuts the corner.
            int corners = 0;
            for (int guard = 0; guard < n; guard++)
            {
                int hit = -1;
                for (int a = 0; a + 1 < line.Count && hit < 0; a++)
                    if (SectionsCross(at, sides, line, a)) hit = a;
                if (hit < 0) break;
                var free = new[] { hit, hit + 1 }.Where(a => a > 0 && a < line.Count - 1 && !neck[line[a]]).ToList();
                if (free.Count == 0) break;
                int drop = free.OrderByDescending(a => Turn(at, line, a)).First();
                flag(at[line[drop]], "corner too sharp for the water's width: point dropped");
                line.RemoveAt(drop);
                corners++;
            }
            float maxShift = 0;
            var widths = new List<float>();
            var fitted = new List<Vector4>();
            foreach (int i in line)
            {
                float left = sides[0][i], right = sides[1][i];
                maxShift = Mathf.Max(maxShift, Mathf.Abs(right - left) / 2f);
                widths.Add(left + right);
                fitted.Add(new Vector4(at[i].x, y[i], at[i].y, left + right));
            }

            // Ends: on along the line into the bank.
            var ends = new List<object>();
            for (int e = 0; e < 2; e++)
            {
                int i = e == 0 ? 0 : fitted.Count - 1, inward = e == 0 ? 1 : fitted.Count - 2;
                Vector2 end = XZ(fitted[i]), outward = (end - XZ(fitted[inward])).normalized;
                float into = o.pondFadeM > 0 ? IntoLake(end, outward, o.pondFadeM) : float.NaN;
                if (!float.IsNaN(into))
                {
                    // At a lake: on past its shore, where FadeIntoLakes fades the water out.
                    ends.Add("lake " + M(into));
                    if (into < 0.1f) continue;
                    var p = end + outward * into;
                    var on = new Vector4(p.x, fitted[i].y, p.y, fitted[i].w);
                    if (e == 0) fitted.Insert(0, on); else fitted.Add(on);
                    continue;
                }
                int steps = Mathf.CeilToInt((fitted[i].w / 2f + o.searchM) / StepM);
                var ground = new float[steps + 1];
                for (int k = 0; k <= steps; k++) ground[k] = GroundAt(end + outward * (k * StepM));
                float reach;
                if (!Reach(ground, 0, 1, fitted[i].y, o, out reach) || reach < 0.1f) { ends.Add("open"); continue; }
                ends.Add((float)Math.Round(reach, 2));
                var q = end + outward * reach;
                var extra = new Vector4(q.x, fitted[i].y, q.y, fitted[i].w);
                if (e == 0) fitted.Insert(0, extra); else fitted.Add(extra);
            }

            var traced = new List<object>();
            if (!string.IsNullOrEmpty(o.trace) && c.id.Contains(o.trace))
                foreach (var st in stations)
                {
                    float h = WaterAt(st.s, cum, y);
                    int m = (st.ground.Length - 1) / 2;
                    float l, r;
                    bool lf = !float.IsNaN(st.bed) && Reach(st.ground, st.lowest, -1, h, o, out l), rf = !float.IsNaN(st.bed) && Reach(st.ground, st.lowest, 1, h, o, out r);
                    traced.Add(string.Format(CultureInfo.InvariantCulture, "s {0:0} x {1:0.0} z {2:0.0} pt {3} bed {4:0.00} centre {5:0.00} water {6:0.00} left {7} right {8}{9}",
                        st.s, st.pos.x, st.pos.y, st.owner, st.bed, st.ground[m], h, lf ? "bank" : "open", rf ? "bank" : "open", st.crossing ? " crossing" : ""));
                }
            var diff = Enumerable.Range(0, n).Select(i => y[i] - pts[i].y).OrderBy(v => v).ToList();
            c.points = fitted;
            widths.Sort();
            var result = new Dictionary<string, object>
            {
                { "points", fitted.Count },
                { "widthM", new Dictionary<string, object> { { "export", Math.Round(c.widthM, 2) }, { "min", Math.Round(widths[0], 2) }, { "median", Math.Round(widths[widths.Count / 2], 2) }, { "max", Math.Round(widths[widths.Count - 1], 2) } } },
                { "surfaceMinusExportM", Math.Round(diff[diff.Count / 2], 2) },
                { "fallM", Math.Round(fitted[0].y - fitted[fitted.Count - 1].y, 2) },
                { "endsM", ends }, { "openSides", openSides }, { "maxShiftM", Math.Round(maxShift, 2) },
                { "maxClimbM", Math.Round(climb, 2) }, { "crossings", crossings }, { "cornersDropped", corners },
                { "lakeEndPoints", atLake.Count(v => v) },
                { "check", check },
            };
            if (traced.Count > 0) result["trace"] = traced;
            return result;
        }

        // From `from` in `ground` (StepM apart) walking `dir`: how far the water
        // at height h reaches into the bank - to where the ground rises buryM
        // above it, then bankM on, short of where the ground drops back under
        // the water. False when no bank is met.
        static bool Reach(float[] ground, int from, int dir, float h, FitOptions o, out float reach)
        {
            reach = -1;
            int bank = -1;
            for (int i = from; i >= 0 && i < ground.Length; i += dir)
                if (!float.IsNaN(ground[i]) && ground[i] >= h + o.buryM) { bank = i; break; }
            if (bank < 0) return false;
            int last = bank, stop = bank + dir * Mathf.RoundToInt(o.bankM / StepM);
            for (int i = bank + dir; i >= 0 && i < ground.Length && i != stop + dir; i += dir)
            {
                if (float.IsNaN(ground[i]) || ground[i] < h) break;
                last = i;
            }
            reach = Math.Abs(last - from) * StepM;
            return true;
        }

        // Clamps v along the line (cum: its distance along it) so it changes at most `slope` per metre, the
        // `fixedAt` values left as they are; down=true only lowers values (each is at most its neighbours' + slope).
        static void Limit(float[] v, float[] cum, bool[] fixedAt, float slope, bool down)
        {
            int n = v.Length;
            for (int pass = 0; pass < 4; pass++)
                for (int k = 1; k < 2 * n - 1; k++)
                {
                    bool forward = k < n;
                    int i = forward ? k : 2 * n - 2 - k, j = forward ? i - 1 : i + 1;
                    if (fixedAt[i]) continue;
                    float d = Mathf.Abs(cum[i] - cum[j]) * slope;
                    v[i] = down ? Mathf.Min(v[i], v[j] + d) : Mathf.Clamp(v[i], v[j] - d, v[j] + d);
                }
        }

        // The horizontal right of the line at point i, the way R.A.M. turns a control point's section (its
        // Catmull-Rom tangent runs from the point before to the point after).
        static Vector2 Right(List<Vector4> pts, int i)
        {
            Vector2 dir = (XZ(pts[Math.Min(i + 1, pts.Count - 1)]) - XZ(pts[Math.Max(i - 1, 0)])).normalized;
            return new Vector2(dir.y, -dir.x);
        }

        static Vector2 Right(Vector2[] at, List<int> line, int a)
        {
            Vector2 dir = (at[line[Math.Min(a + 1, line.Count - 1)]] - at[line[Math.Max(a - 1, 0)]]).normalized;
            return new Vector2(dir.y, -dir.x);
        }

        // Do the sections of line[a] and line[a + 1] (left sides[0], right sides[1] across the line) cross?
        static bool SectionsCross(Vector2[] at, float[][] sides, List<int> line, int a)
        {
            int i = line[a], j = line[a + 1];
            Vector2 na = Right(at, line, a), nb = Right(at, line, a + 1), r = at[j] - at[i];
            float den = na.x * -nb.y + na.y * nb.x;
            if (Mathf.Abs(den) < 1e-6f) return false;
            float t = (r.x * -nb.y + r.y * nb.x) / den, u = (na.x * r.y - na.y * r.x) / den;
            return -sides[0][i] < t && t < sides[1][i] && -sides[0][j] < u && u < sides[1][j];
        }

        // How sharply the line turns at line[a] (radians).
        static float Turn(Vector2[] at, List<int> line, int a)
        {
            Vector2 u1 = at[line[a]] - at[line[a - 1]], u2 = at[line[a + 1]] - at[line[a]];
            return Mathf.Abs(Mathf.Atan2(u1.x * u2.y - u1.y * u2.x, Vector2.Dot(u1, u2)));
        }

        // The bed three stations deep into the lowest of stations[from..to]: a
        // lone low reading (a drop into the next water) is not lower bed. NaN
        // with fewer than three.
        static float SideLow(Station[] stations, int from, int to)
        {
            var beds = new List<float>();
            for (int q = Math.Max(0, from); q <= Math.Min(stations.Length - 1, to); q++) if (!float.IsNaN(stations[q].bed)) beds.Add(stations[q].bed);
            if (beds.Count < 3) return float.NaN;
            beds.Sort();
            return beds[2];
        }

        static float WaterAt(float s, float[] cum, float[] y)
        {
            int j = 0;
            while (j < cum.Length - 2 && cum[j + 1] < s) j++;
            float seg = cum[j + 1] - cum[j];
            return seg <= 0 ? y[j] : Mathf.Lerp(y[j], y[j + 1], Mathf.Clamp01((s - cum[j]) / seg));
        }

        static Vector2 XZ(Vector4 p) { return new Vector2(p.x, p.z); }

        static string M(float v) { return v.ToString("0.00", CultureInfo.InvariantCulture); }

        // The top of the course meshes (Spline_*, Gap_Issue*) at (x, z), else the
        // terrain; NaN over neither. Buildings, trees, water planes and the splines
        // themselves are not ground.
        static float GroundAt(Vector2 p)
        {
            float mesh = float.NegativeInfinity, terrain = float.NegativeInfinity;
            foreach (var h in Physics.RaycastAll(new Vector3(p.x, 10000f, p.y), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore))
            {
                var name = h.collider.name;
                if (GolfMapWaterplanes.IsWaterPlane(name)) continue;
                if (name.StartsWith("Spline_", StringComparison.Ordinal) || name.StartsWith("Gap_Issue", StringComparison.Ordinal)) mesh = Mathf.Max(mesh, h.point.y);
                else if (h.collider is TerrainCollider) terrain = Mathf.Max(terrain, h.point.y);
            }
            return !float.IsNegativeInfinity(mesh) ? mesh : !float.IsNegativeInfinity(terrain) ? terrain : float.NaN;
        }

        // A creek end at a lake: a water plane within LakeGapM past the end (or under it, LakeBackM back along the line).
        const float LakeGapM = 1f, LakeBackM = 4f;

        // How far past `end` along `outward` the water runs to stand fadeM over the lake there (negative: it already
        // does); NaN when no lake is at this end.
        static float IntoLake(Vector2 end, Vector2 outward, float fadeM)
        {
            for (float s = -LakeBackM; s <= LakeGapM; s += StepM)
                if (OverLake(end + outward * s)) return s + fadeM;
            return float.NaN;
        }

        // A lake end's run of points: from each end inwards, the points over a lake or within ShoreM of one. None when every
        // point is (a creek between two lakes, too short to have a bed of its own).
        const float ShoreM = 1.5f;
        static bool[] LakeEnds(List<Vector4> pts)
        {
            int n = pts.Count;
            var at = new bool[n];
            for (int i = 0; i < n && NearLake(XZ(pts[i]), ShoreM); i++) at[i] = true;
            for (int i = n - 1; i >= 0 && !at[i] && NearLake(XZ(pts[i]), ShoreM); i--) at[i] = true;
            return at.All(v => v) ? new bool[n] : at;
        }

        // The point nearest i along the line that is not in a lake end's run (i itself when it is not).
        static int NotAtLake(bool[] atLake, int i)
        {
            if (!atLake[i]) return i;
            int a = i, b = i;
            while (a >= 0 && atLake[a]) a--;
            while (b < atLake.Length && atLake[b]) b++;
            return a < 0 ? b : b >= atLake.Length ? a : i - a <= b - i ? a : b;
        }

        static bool NearLake(Vector2 p, float r)
        {
            if (OverLake(p)) return true;
            for (float d = r / 2; d <= r + 1e-3f; d += r / 2)
                for (int k = 0; k < 16; k++)
                {
                    float t = k * Mathf.PI / 8;
                    if (OverLake(p + new Vector2(Mathf.Cos(t), Mathf.Sin(t)) * d)) return true;
                }
            return false;
        }

        // Is (x, z) over a water plane (their MeshColliders)?
        static bool OverLake(Vector2 p)
        {
            foreach (var h in Physics.RaycastAll(new Vector3(p.x, 10000f, p.y), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore))
                if (GolfMapWaterplanes.IsWaterPlane(h.collider.name)) return true;
            return false;
        }

        // How far (x, z) lies inside a lake: the nearest point off the water planes, looked for in rings StepM apart; maxM
        // when none is nearer, 0 off the lakes.
        static float LakeDepth(Vector2 p, float maxM)
        {
            if (!OverLake(p)) return 0;
            for (float r = StepM; r < maxM; r += StepM)
                for (int k = 0; k < 16; k++)
                {
                    float t = k * Mathf.PI / 8;
                    if (!OverLake(p + new Vector2(Mathf.Cos(t), Mathf.Sin(t)) * r)) return r;
                }
            return maxM;
        }

        // The water's opacity, R.A.M.'s vertex colour alpha (its vertex colour water shaders multiply their alpha by it): 1 off
        // the lakes, easing to 0 fadeM inside a lake's shore, so a creek running into a pond melts into the pond's own water.
        // Every vertex is set (R.A.M. keeps the colours of a spline whose vertex count is unchanged), the spline regenerated
        // with them. The number of vertices made see-through at all.
        static int FadeIntoLakes(Component spline, Type splineType, float fadeM)
        {
            var filter = spline.GetComponent<MeshFilter>();
            var mesh = filter != null ? filter.sharedMesh : null;
            var field = splineType.GetField("colors");
            var colors = field.GetValue(spline) as Color[];
            if (mesh == null || colors == null || colors.Length != mesh.vertexCount) return 0;
            var vertices = mesh.vertices;
            // R.A.M.'s vertices are edge loops across the water, vertsInShape each. How far each loop's centre lies along the
            // line past where an end's run over a lake begins: the end loop then fades out whatever shore lies beside it.
            int per = (int)splineType.GetField("vertsInShape").GetValue(spline);
            int loops = per > 0 && vertices.Length % per == 0 ? vertices.Length / per : 0;
            var along = new float[loops];
            if (fadeM > 0 && loops > 1)
            {
                var centre = new Vector2[loops];
                var cum = new float[loops];
                for (int l = 0; l < loops; l++)
                {
                    Vector3 sum = Vector3.zero;
                    for (int j = 0; j < per; j++) sum += spline.transform.TransformPoint(vertices[l * per + j]);
                    centre[l] = new Vector2(sum.x / per, sum.z / per);
                    if (l > 0) cum[l] = cum[l - 1] + Vector2.Distance(centre[l - 1], centre[l]);
                }
                var over = centre.Select(OverLake).ToArray();
                int first = Array.IndexOf(over, false), last = Array.LastIndexOf(over, false);
                if (first >= 0)
                    for (int l = 0; l < loops; l++)
                        along[l] = l < first ? cum[first] - cum[l] : l > last ? cum[l] - cum[last] : 0;
            }
            int faded = 0;
            bool changed = false;
            for (int i = 0; i < vertices.Length; i++)
            {
                var w = spline.transform.TransformPoint(vertices[i]);
                float depth = LakeDepth(new Vector2(w.x, w.z), fadeM);
                if (loops > 0) depth = Mathf.Max(depth, along[i / per]);
                float a = fadeM > 0 ? 1f - Mathf.SmoothStep(0f, 1f, Mathf.Min(depth, fadeM) / fadeM) : 1f;
                if (a < 1f) faded++;
                if (colors[i].a != a) { colors[i].a = a; changed = true; }
            }
            if (!changed) return faded;
            field.SetValue(spline, colors);
            splineType.GetMethod("GenerateSpline").Invoke(spline, new object[] { null });
            return faded;
        }

        // Ground (the highest collider straight down, course meshes first) minus
        // the surface at each point: median and range, null when nothing is hit.
        static object GroundOffsets(List<Vector4> points)
        {
            var d = new List<float>();
            foreach (var p in points)
            {
                RaycastHit hit;
                if (Physics.Raycast(new Vector3(p.x, p.y + 200f, p.z), Vector3.down, out hit, 400f)) d.Add(hit.point.y - p.y);
            }
            if (d.Count == 0) return null;
            d.Sort();
            return new Dictionary<string, object> { { "median", (float)Math.Round(d[d.Count / 2], 2) }, { "min", (float)Math.Round(d[0], 2) }, { "max", (float)Math.Round(d[d.Count - 1], 2) } };
        }

        static void WriteReport(GolfMapCourse course, Dictionary<string, object> result)
        {
            var sb = new StringBuilder();
            sb.AppendLine("GolfMap creeks " + DateTime.Now.ToString("yyyy-MM-dd HH:mm") + ((bool)result["dryRun"] ? " (dry run)" : ""));
            foreach (var kv in result.Where(kv => kv.Key != "rows")) sb.AppendLine(kv.Key + ": " + GolfMapJson.Serialize(kv.Value, false));
            foreach (Dictionary<string, object> r in (List<object>)result["rows"])
                sb.AppendLine("  " + r["id"] + ": " + r["status"] + ", " + r["points"] + " points, " + r["lengthM"] + " m, fall " + r["fallM"] + " m, "
                    + r["profile"] + ", ground above export surface " + GolfMapJson.Serialize(r["groundAboveExportSurfaceM"], false)
                    + (r.ContainsKey("fit") ? ", fit " + GolfMapJson.Serialize(r["fit"], false) : ""));
            File.WriteAllText(GolfMapCourses.ReportPath(course, "creeks.txt"), sb.ToString());
        }
    }
}
