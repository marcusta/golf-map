// Where the Scene view camera is, in the course's real-world frame: a box in the
// top right of every Scene view (left of the axis gizmo) with the eye position
// (SWEREF 99 TM, elevation, height above ground, WGS84), the view direction
// (compass heading, tilt) and the point under the view centre (first collider
// hit, its distance and object). A screenshot of the editor then says exactly
// where it was taken; golfmap.view reads the same pose or moves the view to one.
//
// Frame: golf-map's convention (gspro.py, GolfMapTerrainImporter) - the inner
// terrain at the origin, x = east - square3006[0], z = north - square3006[1],
// y = elevation - minM, all from the course's inner DEM sidecar
// (<prefix>-inner-dem-<side>m.tif.json in the export folder). Without a sidecar
// the box shows Unity coordinates only.
//
// Toggle: GolfMap > Scene View > Position overlay. The bridge's screenshot
// (mode=view) captures the box too; golfmap.view returns the same numbers as data.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    [InitializeOnLoad]
    static class GolfMapViewInfo
    {
        const string PrefKey = "GolfMap.ViewOverlay";
        const string MenuPath = "GolfMap/Scene View/Position overlay";
        const float GizmoWidth = 100f;   // the Scene view's axis gizmo in the top right corner
        static readonly CultureInfo Inv = CultureInfo.InvariantCulture;   // "529859.2", never the editor locale's "529859,2"

        static GolfMapViewInfo()
        {
            SceneView.onSceneGUIDelegate -= OnSceneGUI;
            SceneView.onSceneGUIDelegate += OnSceneGUI;
            EditorApplication.update -= Settle;
            EditorApplication.update += Settle;
        }

        static bool Enabled { get { return EditorPrefs.GetBool(PrefKey, true); } }

        [MenuItem(MenuPath)]
        static void Toggle()
        {
            EditorPrefs.SetBool(PrefKey, !Enabled);
            SceneView.RepaintAll();
        }

        [MenuItem(MenuPath, true)]
        static bool ToggleValidate()
        {
            Menu.SetChecked(MenuPath, Enabled);
            return true;
        }

        [MenuItem("GolfMap/Scene View/Copy view position")]
        static void CopyMenu()
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null || sv.camera == null) { Debug.LogWarning("[GolfMap] No Scene view is open."); return; }
            EditorGUIUtility.systemCopyBuffer = string.Join("\n", Measure(sv.camera.transform.position, sv.camera.transform.forward, sv.camera.fieldOfView).Lines());
        }

        // ---- the course frame ----------------------------------------------------

        class Frame
        {
            public string course;
            public string sidecar;       // file name, null without one
            public double e0, n0, minM;
            public string problem;       // why there is no frame
        }

        static Frame frame;
        static double frameCheckedAt = -1;

        // Re-resolved every few seconds: the active course and its export can change
        // under the editor (scene switch, new DEM export), and FindAssets is too slow per repaint.
        static Frame CourseFrame()
        {
            double now = EditorApplication.timeSinceStartup;
            if (frame != null && now - frameCheckedAt < 5) return frame;
            frameCheckedAt = now;
            frame = LoadFrame();
            return frame;
        }

        static Frame LoadFrame()
        {
            GolfMapCourse course;
            // All() first: Active() adopts a course folder when there is none, not a repaint's job.
            try { course = GolfMapCourses.All().Length == 0 ? null : GolfMapCourses.Active(); }
            catch (Exception e) { return new Frame { problem = e.Message }; }
            if (course == null) return new Frame { problem = "no active GolfMap course" };
            var f = new Frame { course = GolfMapCourses.Name(course) };
            if (string.IsNullOrEmpty(course.exportFolder)) { f.problem = "course has no export folder"; return f; }
            var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            if (!Directory.Exists(folder)) { f.problem = "export folder missing"; return f; }
            var pattern = (string.IsNullOrEmpty(course.exportPrefix) ? "*" : course.exportPrefix) + "-inner-dem-*.tif.json";
            foreach (var path in Directory.GetFiles(folder, pattern).OrderBy(p => p, StringComparer.Ordinal))
            {
                GolfMapDemSidecar sc;
                try { sc = JsonUtility.FromJson<GolfMapDemSidecar>(File.ReadAllText(path)); } catch { continue; }
                if (sc == null || sc.square3006 == null || sc.square3006.Length != 4) continue;
                f.sidecar = Path.GetFileName(path);
                f.e0 = sc.square3006[0];
                f.n0 = sc.square3006[1];
                f.minM = sc.minM;
                return f;
            }
            f.problem = "no inner DEM sidecar (" + pattern + ")";
            return f;
        }

        // ---- the pose ------------------------------------------------------------

        class Point
        {
            public Vector3 unity;
            public double e, n, h, lat, lon;
        }

        class Pose
        {
            public Frame frame;
            public Point eye;
            public float? aboveGround;
            public float heading, tilt, fov;
            public Point at;             // null: the view centre hits no collider
            public float distance;
            public string atObject;

            public bool Georeferenced { get { return frame.sidecar != null; } }

            public IEnumerable<string> Lines()
            {
                if (Georeferenced)
                {
                    yield return frame.course + "  SWEREF 99 TM, elevation from lidar DEM";
                    yield return string.Format(Inv, "Eye   E {0:0.0}  N {1:0.0}  H {2:0.0} m{3}", eye.e, eye.n, eye.h,
                        aboveGround.HasValue ? string.Format(Inv, "  ({0:0.0} m above ground)", aboveGround.Value) : "");
                    yield return string.Format(Inv, "      {0:0.000000} N  {1:0.000000} E   unity {2:0.0}, {3:0.0}, {4:0.0}", eye.lat, eye.lon, eye.unity.x, eye.unity.y, eye.unity.z);
                }
                else
                {
                    yield return (frame.course ?? "GolfMap") + "  no georeference: " + frame.problem;
                    yield return string.Format(Inv, "Eye   unity {0:0.0}, {1:0.0}, {2:0.0}{3}", eye.unity.x, eye.unity.y, eye.unity.z,
                        aboveGround.HasValue ? string.Format(Inv, "  ({0:0.0} m above ground)", aboveGround.Value) : "");
                }
                yield return string.Format(Inv, "Look  heading {0:0}° {1}   tilt {2:+0.0;-0.0;0.0}°   fov {3:0}°", heading, Cardinal(heading), tilt, fov);
                if (at == null) { yield return "At    (no surface under the view centre)"; yield break; }
                yield return Georeferenced
                    ? string.Format(Inv, "At    E {0:0.0}  N {1:0.0}  H {2:0.0} m   {3:0} m away", at.e, at.n, at.h, distance)
                    : string.Format(Inv, "At    unity {0:0.0}, {1:0.0}, {2:0.0}   {3:0} m away", at.unity.x, at.unity.y, at.unity.z, distance);
                yield return "      " + Shorten(atObject, 60);
            }

            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "course", frame.course }, { "sidecar", frame.sidecar }, { "problem", frame.problem },
                    { "crs", Georeferenced ? "EPSG:3006" : null },
                    { "eye", PointJson(eye) }, { "aboveGroundM", aboveGround.HasValue ? (object)Math.Round(aboveGround.Value, 2) : null },
                    { "heading", Math.Round(heading, 1) }, { "cardinal", Cardinal(heading) }, { "tilt", Math.Round(tilt, 1) }, { "fov", Math.Round(fov, 1) },
                    { "at", at == null ? null : PointJson(at) }, { "distanceM", at == null ? null : (object)Math.Round(distance, 1) }, { "atObject", atObject },
                    { "text", string.Join("\n", Lines().ToArray()) },
                };
            }

            Dictionary<string, object> PointJson(Point p)
            {
                var d = new Dictionary<string, object> { { "unity", new object[] { Math.Round(p.unity.x, 2), Math.Round(p.unity.y, 2), Math.Round(p.unity.z, 2) } } };
                if (!Georeferenced) return d;
                d["e"] = Math.Round(p.e, 2); d["n"] = Math.Round(p.n, 2); d["h"] = Math.Round(p.h, 2);
                d["lat"] = Math.Round(p.lat, 7); d["lon"] = Math.Round(p.lon, 7);
                return d;
            }
        }

        static Pose Measure(Vector3 position, Vector3 forward, float fov)
        {
            var f = CourseFrame();
            forward.Normalize();
            var ground = Ground(position);
            var pose = new Pose
            {
                frame = f,
                eye = ToPoint(f, position),
                aboveGround = ground.HasValue ? position.y - ground.Value : (float?)null,
                heading = (Mathf.Atan2(forward.x, forward.z) * Mathf.Rad2Deg + 360f) % 360f,
                tilt = Mathf.Asin(Mathf.Clamp(forward.y, -1f, 1f)) * Mathf.Rad2Deg,
                fov = fov,
            };
            RaycastHit hit;
            if (Physics.Raycast(position, forward, out hit, 50000f, ~0, QueryTriggerInteraction.Ignore))
            {
                pose.at = ToPoint(f, hit.point);
                pose.distance = hit.distance;
                pose.atObject = PathOf(hit.collider.transform);
            }
            return pose;
        }

        static Point ToPoint(Frame f, Vector3 u)
        {
            var p = new Point { unity = u };
            if (f.sidecar == null) return p;
            p.e = f.e0 + u.x;
            p.n = f.n0 + u.z;
            p.h = f.minM + u.y;
            Sweref99TmToWgs84(p.e, p.n, out p.lat, out p.lon);
            return p;
        }

        // The visible surface under a point: the highest collider hit straight down, else the
        // highest terrain covering it (same rule as the bridge's terrain.height).
        internal static float? Ground(Vector3 p)
        {
            var hits = Physics.RaycastAll(new Vector3(p.x, 10000f, p.z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore);
            if (hits.Length > 0) return hits.Max(h => h.point.y);
            float? best = null;
            foreach (var t in Terrain.activeTerrains)
            {
                var o = t.transform.position;
                var size = t.terrainData.size;
                if (p.x >= o.x && p.x <= o.x + size.x && p.z >= o.z && p.z <= o.z + size.z)
                    best = Mathf.Max(best ?? float.NegativeInfinity, t.SampleHeight(p) + o.y);
            }
            return best;
        }

        static readonly string[] Points16 = { "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW" };

        static string Cardinal(float heading) { return Points16[(int)Mathf.Round(heading / 22.5f) % 16]; }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t != null; t = t.parent) parts.Insert(0, t.name);
            return string.Join("/", parts.ToArray());
        }

        static string Shorten(string s, int max) { return s == null || s.Length <= max ? s : "..." + s.Substring(s.Length - max + 3); }

        // SWEREF 99 TM (EPSG:3006) -> WGS84, Lantmäteriet's Gauss-Krüger formulas
        // (GRS 80, central meridian 15°, scale 0.9996, false easting 500 000 m).
        static void Sweref99TmToWgs84(double e, double n, out double lat, out double lon)
        {
            const double a = 6378137.0, fl = 1.0 / 298.257222101, lon0 = 15.0, k0 = 0.9996, fn = 0.0, fe = 500000.0;
            double e2 = fl * (2.0 - fl), m = fl / (2.0 - fl);
            double aRoof = a / (1.0 + m) * (1.0 + m * m / 4.0 + m * m * m * m / 64.0);
            double d1 = m / 2.0 - 2.0 * m * m / 3.0 + 37.0 * m * m * m / 96.0 - m * m * m * m / 360.0;
            double d2 = m * m / 48.0 + m * m * m / 15.0 - 437.0 * m * m * m * m / 1440.0;
            double d3 = 17.0 * m * m * m / 480.0 - 37.0 * m * m * m * m / 840.0;
            double d4 = 4397.0 * m * m * m * m / 161280.0;
            double aStar = e2 + e2 * e2 + e2 * e2 * e2 + e2 * e2 * e2 * e2;
            double bStar = -(7.0 * e2 * e2 + 17.0 * e2 * e2 * e2 + 30.0 * e2 * e2 * e2 * e2) / 6.0;
            double cStar = (224.0 * e2 * e2 * e2 + 889.0 * e2 * e2 * e2 * e2) / 120.0;
            double dStar = -(4279.0 * e2 * e2 * e2 * e2) / 1260.0;
            double xi = (n - fn) / (k0 * aRoof), eta = (e - fe) / (k0 * aRoof);
            double xiP = xi - d1 * Math.Sin(2 * xi) * Math.Cosh(2 * eta) - d2 * Math.Sin(4 * xi) * Math.Cosh(4 * eta)
                            - d3 * Math.Sin(6 * xi) * Math.Cosh(6 * eta) - d4 * Math.Sin(8 * xi) * Math.Cosh(8 * eta);
            double etaP = eta - d1 * Math.Cos(2 * xi) * Math.Sinh(2 * eta) - d2 * Math.Cos(4 * xi) * Math.Sinh(4 * eta)
                              - d3 * Math.Cos(6 * xi) * Math.Sinh(6 * eta) - d4 * Math.Cos(8 * xi) * Math.Sinh(8 * eta);
            double phiStar = Math.Asin(Math.Sin(xiP) / Math.Cosh(etaP));
            double dLambda = Math.Atan(Math.Sinh(etaP) / Math.Cos(xiP));
            double s = Math.Sin(phiStar), s2 = s * s;
            double phi = phiStar + s * Math.Cos(phiStar) * (aStar + bStar * s2 + cStar * s2 * s2 + dStar * s2 * s2 * s2);
            lat = phi * 180.0 / Math.PI;
            lon = lon0 + dLambda * 180.0 / Math.PI;
        }

        // ---- the overlay ---------------------------------------------------------

        static GUIStyle style;

        static GUIStyle Style()
        {
            if (style != null && style.font != null) return style;
            style = new GUIStyle(EditorStyles.label) { fontSize = 14, richText = false, wordWrap = false };
            style.font = Font.CreateDynamicFontFromOSFont(new[] { "Consolas", "Menlo", "Courier New" }, 14);
            style.normal.textColor = new Color(0.95f, 0.95f, 0.95f);
            return style;
        }

        // Measuring costs two raycasts through every course collider, so nothing is measured
        // while the camera moves: the box keeps the last numbers, dimmed, and measures once
        // the camera has been still for StillFor. Settle repaints the view at that moment
        // (a still Scene view does not repaint by itself).
        const double StillFor = 0.3;

        class Shown
        {
            public string[] lines;
            public Vector2 size;
            public float lineH;
            public Vector3 position, forward;   // camera pose at the last repaint
            public double movedAt;
            public bool stale;
        }

        static readonly Dictionary<SceneView, Shown> shown = new Dictionary<SceneView, Shown>();

        static bool Moved(Shown s, Transform cam)
        {
            return (cam.position - s.position).sqrMagnitude > 1e-4f || Vector3.Dot(cam.forward, s.forward) < 0.9999995f;
        }

        static void Remeasure(SceneView sv, Shown s)
        {
            var cam = sv.camera.transform;
            var st = Style();
            s.lines = Measure(cam.position, cam.forward, sv.camera.fieldOfView).Lines().ToArray();
            s.lineH = st.CalcSize(new GUIContent("Ag")).y;
            s.size = new Vector2(s.lines.Max(l => st.CalcSize(new GUIContent(l)).x) + 12f, s.lines.Length * s.lineH + 8f);
            s.position = cam.position;
            s.forward = cam.forward;
            s.stale = false;
        }

        static void Settle()
        {
            if (!Enabled || shown.Count == 0) return;
            double now = EditorApplication.timeSinceStartup;
            foreach (var kv in shown)
                if (kv.Key != null && kv.Value.stale && now - kv.Value.movedAt >= StillFor) kv.Key.Repaint();
        }

        static void OnSceneGUI(SceneView sv)
        {
            if (!Enabled || sv.camera == null) return;
            var e = Event.current.type;
            if (e != EventType.Repaint && e != EventType.MouseDown && e != EventType.MouseUp) return;

            Shown s;
            if (!shown.TryGetValue(sv, out s))
            {
                foreach (var gone in shown.Keys.Where(k => k == null).ToList()) shown.Remove(gone);
                shown[sv] = s = new Shown();
                Remeasure(sv, s);
            }
            else if (e == EventType.Repaint)
            {
                var cam = sv.camera.transform;
                double now = EditorApplication.timeSinceStartup;
                if (Moved(s, cam))
                {
                    s.position = cam.position;
                    s.forward = cam.forward;
                    s.movedAt = now;
                    s.stale = true;
                }
                else if (s.stale && now - s.movedAt >= StillFor) Remeasure(sv, s);
            }

            var st = Style();
            var box = new Rect(Mathf.Max(4f, sv.position.width - GizmoWidth - s.size.x), 4f, s.size.x, s.size.y);
            Handles.BeginGUI();
            EditorGUI.DrawRect(box, new Color(0f, 0f, 0f, 0.62f));
            var colour = GUI.contentColor;
            if (s.stale) GUI.contentColor = new Color(1f, 1f, 1f, 0.45f);
            for (int i = 0; i < s.lines.Length; i++)
                GUI.Label(new Rect(box.x + 6f, box.y + 4f + i * s.lineH, s.size.x, s.lineH), s.lines[i], st);
            GUI.contentColor = colour;
            if (GUI.Button(new Rect(box.xMax - 46f, box.yMax - s.lineH - 3f, 42f, s.lineH), "Copy", EditorStyles.miniButton))
                EditorGUIUtility.systemCopyBuffer = string.Join("\n", s.lines);
            Handles.EndGUI();
        }

        // Puts a Scene view's eye at `from` looking along `dir`, the pivot on the surface it looks at.
        internal static void LookFrom(SceneView sv, Vector3 from, Vector3 dir)
        {
            dir.Normalize();
            RaycastHit hit;
            float size = Physics.Raycast(from, dir, out hit, 50000f, ~0, QueryTriggerInteraction.Ignore) ? Mathf.Clamp(hit.distance, 5f, 500f) : 50f;
            // In 2018.2 the Scene view camera sits exactly `size` behind the pivot (see the bridge's screenshot).
            sv.LookAtDirect(from + dir * size, Quaternion.LookRotation(dir), size);
            sv.Repaint();
        }

        // ---- bridge --------------------------------------------------------------

        [BridgeCommand("golfmap.view", "Where the Scene view camera is in the course's real-world frame (SWEREF 99 TM from the inner DEM sidecar, elevation, WGS84), its heading/tilt and the point under the view centre - the Scene view's position overlay as data. With e/n (and heading/tilt or atE/atN) moves the view there first: the way back to a place seen in a screenshot of the overlay.",
            args = "e, n (SWEREF 99 TM eye), h (elevation m) or eye (m above ground; default: keep current eye height above ground), heading (deg from north), tilt (deg, negative = down), atE, atN, atH (look at this point instead; default 0.5 m above its ground)")]
        static object View(BridgeArgs a)
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null || sv.camera == null) throw new BridgeError("No Scene view is open.");
            var cam = sv.camera.transform;
            if (!a.Has("e") && !a.Has("n") && !a.Has("atE") && !a.Has("heading") && !a.Has("tilt"))
                return Measure(cam.position, cam.forward, sv.camera.fieldOfView).ToJson();

            var f = CourseFrame();
            if (f.sidecar == null) throw new BridgeError("No georeference: " + f.problem + ".");
            var current = Measure(cam.position, cam.forward, sv.camera.fieldOfView);
            var from = new Vector3((float)(a.Number("e", current.eye.e) - f.e0), 0f, (float)(a.Number("n", current.eye.n) - f.n0));
            if (a.Has("h")) from.y = (float)(a.Number("h", 0) - f.minM);
            else
            {
                var g = Ground(from);
                if (!g.HasValue) throw new BridgeError("No ground under E " + (from.x + f.e0) + " N " + (from.z + f.n0) + "; give h.");
                from.y = g.Value + (float)a.Number("eye", current.aboveGround ?? 1.7);
            }

            Vector3 dir;
            float size;
            if (a.Has("atE") || a.Has("atN"))
            {
                var at = new Vector3((float)(a.Number("atE", current.eye.e) - f.e0), 0f, (float)(a.Number("atN", current.eye.n) - f.n0));
                if (a.Has("atH")) at.y = (float)(a.Number("atH", 0) - f.minM);
                else
                {
                    var g = Ground(at);
                    if (!g.HasValue) throw new BridgeError("No ground under the look-at point; give atH.");
                    at.y = g.Value + 0.5f;
                }
                dir = at - from;
                if (dir.sqrMagnitude < 1e-6f) throw new BridgeError("The eye and the look-at point are the same.");
                size = dir.magnitude;
            }
            else
            {
                float heading = (float)a.Number("heading", current.heading) * Mathf.Deg2Rad;
                float tilt = (float)a.Number("tilt", current.tilt) * Mathf.Deg2Rad;
                dir = new Vector3(Mathf.Sin(heading) * Mathf.Cos(tilt), Mathf.Sin(tilt), Mathf.Cos(heading) * Mathf.Cos(tilt));
                RaycastHit hit;
                size = Physics.Raycast(from, dir, out hit, 50000f, ~0, QueryTriggerInteraction.Ignore) ? Mathf.Clamp(hit.distance, 5f, 500f) : 50f;
            }
            dir.Normalize();
            // In 2018.2 the Scene view camera sits exactly `size` behind the pivot (see the bridge's screenshot).
            sv.LookAtDirect(from + dir * size, Quaternion.LookRotation(dir), size);
            sv.Repaint();
            return Measure(from, dir, sv.camera.fieldOfView).ToJson();
        }
    }
}
