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
// The report compares each creek's surface with the ground under it (the
// highest collider straight down: the course meshes): a creek far above or
// below it means the heightmap in the scene is not the one the export was
// measured against.
using System;
using System.Collections.Generic;
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

        [MenuItem("GolfMap/Creeks/Import creeks (R.A.M.)")]
        static void Menu() { Debug.Log("[GolfMap Creeks] " + GolfMapJson.Serialize(Import(null, false), false)); }

        [BridgeCommand("golfmap.creeks.import", "Import the course's unity-creeks-v1 export (<prefix>-inner-creeks.json) as NatureManufacture R.A.M. splines under 'GolfMap Creeks': one RamSpline per creek at its water surface with its profile, re-import refills them in place and removes creeks no longer exported. Reports each creek's surface against the ground under it. Marks the scene dirty, does not save it.",
            args = "file (default: the active course's export), dryRun=false")]
        static object Command(BridgeArgs a) { return Import(a.String("file"), a.Bool("dryRun", false)); }

        public static Dictionary<string, object> Import(string file, bool dryRun)
        {
            var course = GolfMapCourses.Require();
            file = string.IsNullOrEmpty(file) ? GolfMapCourses.ExportFile(course, "inner", "creeks") : file;
            if (string.IsNullOrEmpty(file) || !File.Exists(file))
                throw new InvalidOperationException("No creeks export at " + (file ?? "(the course has no export folder)") + ": run \"Export creeks\" in golf-map's GSPro panel.");
            var creeks = Load(file);

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
                var ground = GroundOffsets(c.points);
                rows.Add(new Dictionary<string, object>
                {
                    { "id", c.id }, { "points", c.points.Count }, { "lengthM", c.lengthM }, { "fallM", c.fallM }, { "source", c.source },
                    { "profile", profile != null ? c.profile : c.profile + " (missing)" },
                    { "groundAboveSurfaceM", ground },
                    { "status", existing.ContainsKey(name) ? "update" : "create" },
                });
                if (dryRun) continue;

                GameObject go;
                Component spline;
                if (existing.TryGetValue(name, out go) && (spline = go.GetComponent(splineType)) != null)
                {
                    Undo.RecordObject(spline, "Import creeks");
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
            }

            // Creeks no longer in the export.
            var removed = existing.Keys.OrderBy(k => k, StringComparer.Ordinal).ToList();
            if (!dryRun)
            {
                foreach (var go in existing.Values) Undo.DestroyObjectImmediate(go);
                Undo.CollapseUndoOperations(undoGroup);
                EditorSceneManager.MarkSceneDirty(scene);
                SceneView.RepaintAll();
            }

            var result = new Dictionary<string, object>
            {
                { "file", file }, { "dryRun", dryRun }, { "creeks", creeks.Count },
                { "created", created }, { "updated", updated }, { "removed", removed },
                { "missingProfiles", missingProfiles.ToList() },
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

        static Type FindType(string name)
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => { try { return a.GetType(name, false); } catch { return null; } })
                .FirstOrDefault(t => t != null);
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
                    + r["profile"] + ", ground above surface " + GolfMapJson.Serialize(r["groundAboveSurfaceM"], false));
            File.WriteAllText(GolfMapCourses.ReportPath(course, "creeks.txt"), sb.ToString());
        }
    }
}
