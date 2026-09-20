// Building planter: plants prefabs from a golfmap-building-assignments-v1
// report (unity/match-building-palette.mjs) over a unity-buildings-v1
// survey (gspro.py buildings) as plain GameObjects under the terrain — not
// VSP: a building needs its colliders, and there are hundreds, not tens of
// thousands. The ground must already carry the flat pads (the pipeline's
// building-pads terrain edits, baked into the heightmap): each building is
// dropped onto the terrain at its rectangle centre, and the four rectangle
// corners are probed so a missing pad shows up as a warning, not a house
// on a slope. Unity 2018.2 / C# 6, JsonUtility only.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public class GolfMapBuildingPlanter : EditorWindow
    {
        [Serializable] public class Plot { public string crs, terrain; public double originX, originY; public float sizeM, minM, maxM; }
        [Serializable] public class Building
        {
            public string id, kind, name, heightSource;
            public float x, z, lengthM, widthM, yawDeg, eaveM, ridgeM, heightM, areaM2;
            public float[] footprint;  // flat x0, z0, x1, z1, … in plot metres
        }
        [Serializable] public class Survey { public string format; public Plot plot; public List<Building> buildings; }
        [Serializable] public class Point { public float x, z; }
        [Serializable] public class Scale { public float x, y, z; }
        [Serializable] public class Assignment { public string buildingId, status, source, guid, name; public Point position; public float rotationY; public Scale scale; }
        [Serializable] public class Report { public string format, sourceHash; public Plot plot; public List<Assignment> assignments; }

        const string kSurveyFormat = "unity-buildings-v1";
        const string kReportFormat = "golfmap-building-assignments-v1";
        const string kParentName = "GolfMap Buildings";
        // A pad flatter than this across the rectangle is a pad; more is a slope the pipeline never flattened.
        const float kPadSpreadWarnM = 0.3f;

        const string kReportPref = "GolfMap.Buildings.ReportPath";
        [SerializeField] string surveyPath = "";
        [SerializeField] string reportPath = "";
        [SerializeField] Terrain terrain;
        [SerializeField] bool clearExisting = true;
        [SerializeField] bool plantReview = false;
        string status = "Validate first, then plant. Review-flagged buildings are skipped unless ticked.";

        [MenuItem("GolfMap/Buildings/Plant from assignments")]
        public static void Open() { GetWindow<GolfMapBuildingPlanter>("Building planter"); }

        // The survey comes from the course's export folder; the matcher writes its report outside
        // the Unity project, so the last one picked is remembered per machine.
        void OnEnable()
        {
            var course = GolfMapCourses.Active();
            if (string.IsNullOrEmpty(surveyPath) && course) surveyPath = GolfMapCourses.ExportFile(course, "outer", "buildings") ?? "";
            if (string.IsNullOrEmpty(reportPath)) reportPath = EditorPrefs.GetString(kReportPref, "");
        }

        void OnGUI()
        {
            surveyPath = EditorGUILayout.TextField("Buildings JSON", surveyPath);
            if (GUILayout.Button("Choose survey")) { var p = EditorUtility.OpenFilePanel("unity-buildings-v1", "", "json"); if (p.Length > 0) surveyPath = p; }
            reportPath = EditorGUILayout.TextField("Assignment JSON", reportPath);
            if (GUILayout.Button("Choose report")) { var p = EditorUtility.OpenFilePanel("Assignments", "", "json"); if (p.Length > 0) reportPath = p; }
            if (GUI.changed) EditorPrefs.SetString(kReportPref, reportPath);
            terrain = (Terrain)EditorGUILayout.ObjectField("Terrain", terrain, typeof(Terrain), true);
            if (terrain == null && Terrain.activeTerrain != null && GUILayout.Button("Use active terrain")) terrain = Terrain.activeTerrain;
            clearExisting = EditorGUILayout.Toggle("Clear existing buildings", clearExisting);
            plantReview = EditorGUILayout.Toggle("Plant review-flagged too", plantReview);
            EditorGUILayout.HelpBox("Plants prefabs as GameObjects under '" + kParentName + "' on the terrain, one per proposed/authored assignment, "
                + "at the survey position, on the terrain height, rotated and scaled per the report. Import the heightmap WITH the building pads first.", MessageType.Info);
            if (GUILayout.Button("Validate")) Execute(false);
            if (GUILayout.Button("Plant buildings")) Execute(true);
            EditorGUILayout.HelpBox(status, MessageType.None);
        }

        static bool Valid(float v) { return !float.IsNaN(v) && !float.IsInfinity(v); }

        static string Sha256(string text)
        {
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
        }

        Vector3 WorldPos(float x, float z) { return terrain.transform.position + new Vector3(x, 0f, z); }

        float GroundY(Vector3 world) { return terrain.SampleHeight(world) + terrain.transform.position.y; }

        void Execute(bool apply)
        {
            try
            {
                if (terrain == null) throw new InvalidOperationException("Pick the terrain (inner or outer) the survey was exported for.");
                var source = File.ReadAllText(surveyPath).TrimStart('\uFEFF');
                var survey = JsonUtility.FromJson<Survey>(source);
                if (survey == null || survey.format != kSurveyFormat || survey.plot == null || survey.buildings == null)
                    throw new InvalidOperationException("Not a " + kSurveyFormat + " file: " + surveyPath);
                var report = JsonUtility.FromJson<Report>(File.ReadAllText(reportPath).TrimStart('\uFEFF'));
                if (report == null || report.format != kReportFormat || report.assignments == null || report.assignments.Count == 0)
                    throw new InvalidOperationException("Invalid or empty assignment report.");
                if (Sha256(source) != report.sourceHash) throw new InvalidOperationException("Survey changed since the report was generated; regenerate the assignments.");
                var size = terrain.terrainData.size;
                if (terrain.transform.rotation != Quaternion.identity || terrain.transform.lossyScale != Vector3.one
                    || Mathf.Abs(size.x - survey.plot.sizeM) > .5f || Mathf.Abs(size.z - survey.plot.sizeM) > .5f)
                    throw new InvalidOperationException("Terrain transform or plot size mismatch: terrain " + size.x + " m, plot " + survey.plot.sizeM + " m.");
                var heightRange = survey.plot.maxM - survey.plot.minM;
                if (Mathf.Abs(size.y - heightRange) > .05f)
                    Debug.LogWarning("[GolfMap buildings] Terrain height " + size.y + " m differs from the plot's " + heightRange + " m: heightmap and survey may be from different exports.");

                var buildings = survey.buildings.ToDictionary(b => b.id);
                var prefabs = new Dictionary<string, GameObject>();
                var ids = new HashSet<string>();
                var toPlant = new List<Assignment>();
                int excluded = 0, review = 0, skipped = 0, unmatched = 0;
                var padWarnings = new List<string>();
                foreach (var a in report.assignments)
                {
                    if (string.IsNullOrEmpty(a.buildingId) || !ids.Add(a.buildingId) || !buildings.ContainsKey(a.buildingId))
                        throw new InvalidOperationException("Duplicate or unknown building: " + a.buildingId);
                    if (a.status == "excluded") { excluded++; continue; }
                    if (a.status == "unmatched") { unmatched++; continue; }
                    if (a.status != "proposed" && a.status != "review" && a.status != "authored")
                        throw new InvalidOperationException("Unresolved assignment: " + a.buildingId + " (" + a.status + ")");
                    if (a.status == "review") { review++; if (!plantReview) { skipped++; continue; } }
                    if (a.position == null || !Valid(a.position.x) || !Valid(a.position.z) || !Valid(a.rotationY)
                        || a.scale == null || !Valid(a.scale.x) || !Valid(a.scale.y) || !Valid(a.scale.z) || a.scale.x <= 0 || a.scale.y <= 0 || a.scale.z <= 0)
                        throw new InvalidOperationException("Invalid transform for " + a.buildingId);
                    if (a.position.x < 0 || a.position.z < 0 || a.position.x > survey.plot.sizeM || a.position.z > survey.plot.sizeM)
                        throw new InvalidOperationException("Position outside the plot: " + a.buildingId);
                    if (string.IsNullOrEmpty(a.guid)) throw new InvalidOperationException("No prefab for " + a.buildingId);
                    if (!prefabs.ContainsKey(a.guid))
                    {
                        var path = AssetDatabase.GUIDToAssetPath(a.guid);
                        var prefab = string.IsNullOrEmpty(path) ? null : AssetDatabase.LoadAssetAtPath<GameObject>(path);
                        if (prefab == null || prefab.GetComponentsInChildren<MeshFilter>(true).All(m => m.sharedMesh == null))
                            throw new InvalidOperationException("Missing mesh prefab: " + a.guid + " (" + a.name + ")");
                        prefabs.Add(a.guid, prefab);
                    }
                    // Pad check: the four rectangle corners should sit at one height.
                    var b = buildings[a.buildingId];
                    var yaw = a.rotationY * Mathf.Deg2Rad;
                    var ax = new Vector2(Mathf.Cos(yaw), -Mathf.Sin(yaw)) * (b.lengthM / 2f);  // Unity yaw is clockwise seen from above
                    var az = new Vector2(Mathf.Sin(yaw), Mathf.Cos(yaw)) * (b.widthM / 2f);
                    float lo = float.MaxValue, hi = float.MinValue;
                    foreach (var s in new[] { new Vector2(1, 1), new Vector2(1, -1), new Vector2(-1, 1), new Vector2(-1, -1) })
                    {
                        var c = new Vector2(a.position.x, a.position.z) + ax * s.x + az * s.y;
                        var y = GroundY(WorldPos(c.x, c.y));
                        lo = Mathf.Min(lo, y); hi = Mathf.Max(hi, y);
                    }
                    if (hi - lo > kPadSpreadWarnM) padWarnings.Add(a.buildingId + " (" + (hi - lo).ToString("0.00") + " m)");
                    toPlant.Add(a);
                }
                status = "Validated " + report.assignments.Count + " assignments: plant " + toPlant.Count + " with " + prefabs.Count + " prefabs; "
                    + review + " review-flagged" + (plantReview ? " (planting them)" : " (skipped)") + ", " + excluded + " excluded, " + unmatched + " unmatched.";
                if (padWarnings.Count > 0)
                    status += "\nWARNING " + padWarnings.Count + " building(s) stand on ground more than " + kPadSpreadWarnM + " m out of level — import the heightmap with the building pads: "
                        + string.Join(", ", padWarnings.Take(5).ToArray()) + (padWarnings.Count > 5 ? ", …" : "");
                Debug.Log("[GolfMap buildings] " + status);
                if (!apply) return;

                var existing = terrain.transform.Find(kParentName);
                var parent = existing ? existing.gameObject : null;
                if (parent != null && clearExisting) { Undo.DestroyObjectImmediate(parent); parent = null; }
                if (parent == null)
                {
                    parent = new GameObject(kParentName);
                    parent.transform.SetParent(terrain.transform, false);
                    Undo.RegisterCreatedObjectUndo(parent, "GolfMap plant buildings");
                }
                var lines = new List<string>();
                foreach (var a in toPlant)
                {
                    var prefab = prefabs[a.guid];
                    var pos = WorldPos(a.position.x, a.position.z);
                    pos.y = GroundY(pos);
                    var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
                    go.transform.SetParent(parent.transform, false);
                    go.transform.position = pos;
                    go.transform.rotation = Quaternion.Euler(0f, a.rotationY, 0f);
                    go.transform.localScale = new Vector3(a.scale.x, a.scale.y, a.scale.z);
                    go.name = prefab.name + "__" + a.buildingId.Replace('/', '_').Replace(':', '_');
                    Undo.RegisterCreatedObjectUndo(go, "GolfMap plant buildings");
                    lines.Add(a.buildingId + "\t" + a.status + "\t" + prefab.name + "\t" + a.position.x.ToString("0.00") + "\t" + a.position.z.ToString("0.00")
                        + "\t" + pos.y.ToString("0.00") + "\t" + a.rotationY.ToString("0.0") + "\t" + a.scale.x.ToString("0.000") + "\t" + a.scale.y.ToString("0.000"));
                }
                Directory.CreateDirectory("GolfMapSpelunk");
                var reportFile = "GolfMapSpelunk/" + terrain.name.Replace(' ', '_') + "_building_import.txt";
                File.WriteAllText(reportFile, "id\tstatus\tprefab\tx\tz\ty\tyaw\tscaleXZ\tscaleY\n" + string.Join("\n", lines.ToArray()) + "\n"
                    + (padWarnings.Count > 0 ? "\npad warnings: " + string.Join(", ", padWarnings.ToArray()) + "\n" : ""));
                status = "Planted " + toPlant.Count + " buildings under '" + kParentName + "'. " + status + " Report: " + reportFile;
                Debug.Log("[GolfMap buildings] " + status);
                SceneView.RepaintAll();
            }
            catch (Exception e)
            {
                status = e.Message;
                Debug.LogException(e);
            }
        }
    }
}
