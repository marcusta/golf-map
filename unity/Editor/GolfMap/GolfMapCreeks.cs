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
//   fall: held up behind a bump, the water would stand above its banks;
// - crossings: a path over a culvert or an undug hump (see BumpM) is bridged
//   at the bed level either side, so the water runs hidden under it;
// - width: across each station (every metre) the water runs out to where the
//   ground rises buryM above it, then bankM further (short of where the ground
//   dips back under the water), so its edges sit inside the banks with no gap
//   under them. The two sides are measured apart and the point moved across
//   to centre the water between them;
// - ends: both ends run on along the line until the ground rises the same
//   way, then bankM into the bank.
// A side or end that never meets a bank (a creek into a pond or another
// creek, flat ground) keeps the export's width or end and is counted "open".
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
            public List<Vector4> points = new List<Vector4>();
        }

        public sealed class FitOptions
        {
            public bool fit = true;
            public float aboveBedM = 0.15f, buryM = 0.05f, bankM = 2f, searchM = 8f;
            public string trace;  // a creek id (or part of one): its stations go into the result
            public string water = "lake";  // lake: the lakes' AQUAS water; profile: R.A.M.'s material
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

        [BridgeCommand("golfmap.creeks.import", "Import the course's unity-creeks-v1 export (<prefix>-inner-creeks.json) as NatureManufacture R.A.M. splines under 'GolfMap Creeks': one RamSpline per creek with its profile, fitted to the course meshes under it (water aboveBedM over the bed; each side out to where the bank rises above the water plus bankM; both ends run on into the bank the same way), wearing the lakes' water (water=lake) or the profile's material (water=profile). Re-import after changing creeks, heightmap or meshes refits them in place (points and transform reset) and removes creeks no longer exported. Marks the scene dirty; save=true saves it (and the assets it changed) once the import has succeeded.",
            args = "file (default: the active course's export), dryRun=false, fit=true (false: the export's surface and width as they are), aboveBedM=0.15, bankM=2, buryM=0.05, searchM=8 (how far past the export's half width to look for a bank), trace (a creek id or part of one: its fit station by station), water=lake|profile, " + GolfMapSceneSave.Arg)]
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
            return GolfMapSceneSave.After(a, Import(a.String("file"), a.Bool("dryRun", false), o));
        }

        [BridgeCommand("golfmap.creeks.water", "Set the look of the imported creeks without refitting them: water=lake gives every creek under 'GolfMap Creeks' the lakes' water (a copy of OPCD's AQUAS water plane material in <course>/Creeks/, made once and then kept, so hand tuning stays) and the nearest lake's reflection probe; water=profile puts back each spline's R.A.M. profile material. Marks the scene dirty; save=true saves it (and the assets it changed) once it has succeeded.",
            args = "water=lake|profile, " + GolfMapSceneSave.Arg)]
        static object WaterCommand(BridgeArgs a) { return GolfMapSceneSave.After(a, Style(a.String("water") ?? "lake")); }

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
                EditorUtility.SetDirty(spline);
                imported.Add(go);
            }

            // Creeks no longer in the export (not when only some were refitted).
            if (fit.within != null) existing.Clear();
            var removed = existing.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            Dictionary<string, object> water = null;
            if (!dryRun)
            {
                water = Wear(imported, fit.water, course, splineType, profileType);
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
                };
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
        static Dictionary<string, object> Wear(List<GameObject> creeks, string water, GolfMapCourse course, Type splineType, Type profileType)
        {
            var result = new Dictionary<string, object> { { "water", water }, { "creeks", creeks.Count } };
            Material lake = null;
            var probes = new List<ReflectionProbe>();
            if (water == "lake")
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
                Material material = lake;
                if (material == null)
                {
                    var profile = splineType.GetField("currentProfile").GetValue(go.GetComponent(splineType)) as UnityEngine.Object;
                    material = profile != null ? profileType.GetField("splineMaterial").GetValue(profile) as Material : null;
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
            if (water == "lake") result["probeFrom"] = anchors.ToDictionary(kv => kv.Key, kv => (object)kv.Value);
            return result;
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
                stations[k].crossing = !float.IsNaN(up) && !float.IsNaN(down) && b > Mathf.Max(up, down) + BumpM;
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
            for (int i = 0; i < n; i++)
            {
                float highest = float.NegativeInfinity;
                for (int k = 0; k < ns; k++)
                    if (stations[k].owner == i && !float.IsNaN(bed[k])) highest = Mathf.Max(highest, bed[k]);
                y[i] = float.IsNegativeInfinity(highest) ? pts[i].y : highest + o.aboveBedM;
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
                if (crossed[i]) continue;
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
            float maxShift = 0;
            var widths = new List<float>();
            var fitted = new List<Vector4>();
            for (int i = 0; i < n; i++)
            {
                float left = Mathf.Max(half[i, 0], StepM), right = Mathf.Max(half[i, 1], StepM);
                Vector2 dir = (XZ(pts[Math.Min(i + 1, n - 1)]) - XZ(pts[Math.Max(i - 1, 0)])).normalized;
                Vector2 p = XZ(pts[i]) + new Vector2(dir.y, -dir.x) * ((right - left) / 2f);
                maxShift = Mathf.Max(maxShift, Mathf.Abs(right - left) / 2f);
                widths.Add(left + right);
                fitted.Add(new Vector4(p.x, y[i], p.y, left + right));
            }

            // Ends: on along the line into the bank.
            var ends = new List<object>();
            for (int e = 0; e < 2; e++)
            {
                int i = e == 0 ? 0 : fitted.Count - 1, inward = e == 0 ? 1 : fitted.Count - 2;
                Vector2 end = XZ(fitted[i]), outward = (end - XZ(fitted[inward])).normalized;
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
            var diff = fitted.Skip(ends[0] is float ? 1 : 0).Take(n).Select((p, i) => p.y - pts[i].y).OrderBy(v => v).ToList();
            c.points = fitted;
            widths.Sort();
            var result = new Dictionary<string, object>
            {
                { "points", fitted.Count },
                { "widthM", new Dictionary<string, object> { { "export", Math.Round(c.widthM, 2) }, { "min", Math.Round(widths[0], 2) }, { "median", Math.Round(widths[widths.Count / 2], 2) }, { "max", Math.Round(widths[widths.Count - 1], 2) } } },
                { "surfaceMinusExportM", Math.Round(diff[diff.Count / 2], 2) },
                { "fallM", Math.Round(fitted[0].y - fitted[fitted.Count - 1].y, 2) },
                { "endsM", ends }, { "openSides", openSides }, { "maxShiftM", Math.Round(maxShift, 2) },
                { "maxClimbM", Math.Round(climb, 2) }, { "crossings", crossings },
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
