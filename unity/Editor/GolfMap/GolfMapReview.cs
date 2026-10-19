// Unity 2018.2 / C# 6. GolfMap > Review: step 6 of the Blender shaping loop (blender/SHAPING-PLAN.md). Lists the
// places a shaping run changed (shaping-report.json `changedPlaces`, written by blender/tools/shape_apply.py) grouped
// by hole, frames the Scene view on each (Go / Next / Prev) and keeps a "done" tick per place in EditorPrefs, per
// report. Also shows the pending manual steps of the last golfmap.course.refresh.
//
// A place (format golfmap-shaping-report-v1, shape_apply.py): {object, featureId, type, hole, kind, ops,
// centre: {blend:[x,y,z], epsg3006:[e,n,h], unity:[x,y,z]}, bounds: {blend:[x0,y0,z0,x1,y1,z1], epsg3006:[e0,n0,e1,n1],
// unity:[x0,y0,z0,x1,y1,z1]}}. The first reports had centreBlend:[x,y,z], centre3006:[e,n] and bounds:{min, max} in
// Blender coordinates; both are read. Where it is in the scene, first found wins:
//   1. a GameObject named `object` in the open scene: its renderers' bounds (the mesh as Unity has it now);
//   2. the report's Unity bounds/centre (the height then taken from the ground under the centre, as below);
//   3. centreBlend/bounds through the FBX mapping: Unity (x, y, z) = Blender (-x, z, -y) (Blender's default FBX
//      export, -Z forward / Y up with bake_space_transform, then Unity's right- to left-handed flip; checked on
//      Spline_hole_18_9_Bunker_-_Mesh and three more: bounds equal to the millimetre), the height then taken
//      from the ground under the centre (the .blend's heights may be unconformed);
//   4. centre3006 through the inner DEM sidecar (x = E - square3006[0], z = N - square3006[1]), on the ground.
// The view looks at the place from its current heading, 35 degrees down, far enough back to see all of it.
// The default report: <course export folder>/shaping-staging/shaping-report.json (where shape_apply stages its FBX
// until the loop is trusted), else <course export folder>/shaping-report.json.
// Bridge: golfmap.review.list (read-only), golfmap.review.goto index=|object= and golfmap.review.load path=.
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
    public class GolfMapReview : EditorWindow
    {
        const string PathPref = "GolfMap.Review.Report";
        const string DonePref = "GolfMap.Review.Done.";
        const string DefaultFile = "shaping-report.json";
        const string StagingFolder = "shaping-staging";
        const float TiltDeg = 35f;

        internal sealed class Place
        {
            public int index;
            public string obj, featureId, type, note, hole;
            public Vector3? centreBlend, minBlend, maxBlend;
            public Vector3? centreUnity, minUnity, maxUnity;   // the report's own Unity coordinates (v1 format)
            public double[] centre3006;
            public string Key { get { return (obj ?? "") + "|" + (featureId ?? "") + "|" + (type ?? "") + "|" + index; } }
            public string Label
            {
                get
                {
                    var name = !string.IsNullOrEmpty(obj) ? obj : !string.IsNullOrEmpty(featureId) ? "feature " + featureId : null;
                    // a course check's place is a spot, not an object: its note says what is wrong there
                    if (name == null && !string.IsNullOrEmpty(note)) return (string.IsNullOrEmpty(type) ? "" : "[" + type + "] ") + note;
                    return (string.IsNullOrEmpty(type) ? "" : "[" + type + "] ") + (name ?? "place " + index) + (string.IsNullOrEmpty(note) ? "" : " - " + note);
                }
            }
        }

        sealed class Report
        {
            public string path, stamp;
            public DateTime written;
            public List<Place> places = new List<Place>();
        }

        // Where a place is in the scene.
        internal struct Located
        {
            public Bounds bounds;
            public string by;
            public GameObject go;
            public float? blendOffsetM;   // object bounds centre vs centreBlend mapped (both known): checks the mapping
        }

        static Report cached;
        static int current = -1;

        [SerializeField] string reportPath = "";
        [SerializeField] bool hideDone;
        [SerializeField] bool skipDone = true;
        [SerializeField] Vector2 scroll;
        readonly HashSet<string> collapsed = new HashSet<string>();
        string status = "";

        [MenuItem("GolfMap/Review")]
        public static void Open() { GetWindow<GolfMapReview>("Review"); }

        void OnEnable()
        {
            if (string.IsNullOrEmpty(reportPath)) reportPath = DefaultPath();
        }

        // ------------------------------------------------------------ report

        // EditorPrefs' path when it exists, else the course's default report (CourseDefaultPath).
        internal static string DefaultPath()
        {
            var saved = EditorPrefs.GetString(PathPref, "");
            if (!string.IsNullOrEmpty(saved) && File.Exists(saved)) return saved;
            return CourseDefaultPath() ?? saved;
        }

        // <course export folder>/shaping-staging/shaping-report.json when it exists, else <export folder>/shaping-report.json
        // when that exists, else the staging path; null without an active course with an export folder.
        internal static string CourseDefaultPath()
        {
            var course = GolfMapCourses.Active();
            if (course == null || string.IsNullOrEmpty(course.exportFolder)) return null;
            var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            var staged = Path.GetFullPath(Path.Combine(Path.Combine(folder, StagingFolder), DefaultFile)).Replace('\\', '/');
            var plain = Path.GetFullPath(Path.Combine(folder, DefaultFile)).Replace('\\', '/');
            return File.Exists(staged) || !File.Exists(plain) ? staged : plain;
        }

        static Report Load(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new BridgeError("No shaping report at " + (string.IsNullOrEmpty(path) ? "(no path)" : path) + ".");
            var full = Path.GetFullPath(path).Replace('\\', '/');
            var written = File.GetLastWriteTimeUtc(full);
            if (cached != null && cached.path == full && cached.written == written) return cached;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(full));
            var report = new Report { path = full, written = written };
            report.stamp = root.String("generated") ?? root.String("created") ?? root.String("runId") ?? "";
            var list = root.Array("changedPlaces") ?? new List<object>();
            foreach (var o in list.OfType<GolfMapJsonObject>())
            {
                var p = new Place
                {
                    index = report.places.Count,
                    obj = Text(o["object"]), featureId = Text(o["featureId"]), type = Text(o["type"]), note = Text(o["note"]), hole = Text(o["hole"]),
                    centreBlend = Vec(o.Array("centreBlend")),
                };
                if (p.note == null && o.Array("ops") != null && o.Array("ops").Count > 0) p.note = string.Join(", ", o.Array("ops").Select(Text).Where(t => t != null).ToArray());
                var centre = o.Object("centre");
                if (centre != null)
                {
                    p.centreBlend = p.centreBlend ?? Vec(centre.Array("blend"));
                    p.centreUnity = Vec(centre.Array("unity"));
                }
                var b = o.Object("bounds");
                if (b != null)
                {
                    p.minBlend = Vec(b.Array("min")); p.maxBlend = Vec(b.Array("max"));
                    Box(b.Array("blend"), ref p.minBlend, ref p.maxBlend);
                    Box(b.Array("unity"), ref p.minUnity, ref p.maxUnity);
                }
                var c = o.Array("centre3006") ?? (centre != null ? centre.Array("epsg3006") : null);
                if (c != null && c.Count >= 2 && Num(c[0]).HasValue && Num(c[1]).HasValue) p.centre3006 = new[] { Num(c[0]).Value, Num(c[1]).Value };
                report.places.Add(p);
            }
            cached = report;
            if (current >= report.places.Count) current = -1;
            return report;
        }

        static string Text(object v)
        {
            if (v == null) return null;
            var n = v as GolfMapJsonNumber;
            return n != null ? n.raw : v as string;
        }

        static double? Num(object v) { var n = v as GolfMapJsonNumber; return n != null ? n.Value : (double?)null; }

        // [x0, y0, z0, x1, y1, z1] -> min, max; left as they are when it is missing or short.
        static void Box(List<object> a, ref Vector3? min, ref Vector3? max)
        {
            if (a == null || a.Count < 6 || a.Take(6).Any(v => !Num(v).HasValue)) return;
            min = new Vector3((float)Num(a[0]).Value, (float)Num(a[1]).Value, (float)Num(a[2]).Value);
            max = new Vector3((float)Num(a[3]).Value, (float)Num(a[4]).Value, (float)Num(a[5]).Value);
        }

        static Vector3? Vec(List<object> a)
        {
            if (a == null || a.Count < 3 || a.Take(3).Any(v => !Num(v).HasValue)) return null;
            return new Vector3((float)Num(a[0]).Value, (float)Num(a[1]).Value, (float)Num(a[2]).Value);
        }

        // Blender (x, y, z) -> Unity (-x, z, -y); see the header.
        internal static Vector3 BlendToUnity(Vector3 b) { return new Vector3(-b.x, b.z, -b.y); }

        // ------------------------------------------------------------ done ticks (EditorPrefs, per report)

        static string DoneKey(Report r) { return DonePref + Hash(r.path.ToLowerInvariant() + "|" + r.stamp); }

        static string Hash(string s)
        {
            uint h = 2166136261;
            foreach (var ch in s) { h ^= ch; h *= 16777619; }
            return h.ToString("x8");
        }

        static HashSet<string> Done(Report r)
        {
            return new HashSet<string>(EditorPrefs.GetString(DoneKey(r), "").Split('\n').Where(s => s.Length > 0));
        }

        static void SetDone(Report r, Place p, bool done)
        {
            var set = Done(r);
            if (done) set.Add(p.Key); else set.Remove(p.Key);
            EditorPrefs.SetString(DoneKey(r), string.Join("\n", set.ToArray()));
        }

        // ------------------------------------------------------------ scene

        internal static Located? Locate(Place p)
        {
            if (!string.IsNullOrEmpty(p.obj))
            {
                var scene = EditorSceneManager.GetActiveScene();
                var gos = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true))
                    .Where(t => t.name == p.obj).Select(t => t.gameObject).OrderByDescending(g => g.activeInHierarchy).ToList();
                foreach (var go in gos)
                {
                    var renderers = go.GetComponentsInChildren<Renderer>(true);
                    if (renderers.Length == 0) continue;
                    var b = renderers[0].bounds;
                    foreach (var r in renderers.Skip(1)) b.Encapsulate(r.bounds);
                    var found = new Located { bounds = b, by = "object", go = go };
                    if (p.centreBlend.HasValue)
                    {
                        var m = BlendToUnity(p.centreBlend.Value);
                        found.blendOffsetM = new Vector2(m.x - b.center.x, m.z - b.center.z).magnitude;
                    }
                    return found;
                }
            }
            if (p.centreUnity.HasValue || (p.minUnity.HasValue && p.maxUnity.HasValue))
            {
                var b = p.minUnity.HasValue && p.maxUnity.HasValue ? MinMax(p.minUnity.Value, p.maxUnity.Value) : new Bounds(p.centreUnity.Value, new Vector3(10, 2, 10));
                // on the ground as the scene has it (the report's heights are the .blend's)
                var g = Ground(b.center);
                if (g.HasValue) b.center = new Vector3(b.center.x, g.Value, b.center.z);
                return new Located { bounds = b, by = "unity" };
            }
            if (p.centreBlend.HasValue)
            {
                var c = BlendToUnity(p.centreBlend.Value);
                var b = new Bounds(c, new Vector3(10, 2, 10));
                if (p.minBlend.HasValue && p.maxBlend.HasValue)
                {
                    b = new Bounds(BlendToUnity(p.minBlend.Value), Vector3.zero);
                    b.Encapsulate(BlendToUnity(p.maxBlend.Value));
                }
                // on the ground as the scene has it: the .blend's heights may be unconformed or out of date
                var g = Ground(b.center);
                if (g.HasValue) b.center = new Vector3(b.center.x, g.Value, b.center.z);
                return new Located { bounds = b, by = "centreBlend" };
            }
            if (p.centre3006 != null)
            {
                var course = GolfMapCourses.Require();
                double e0, n0; Vector3 origin;
                GolfMapProps.Frame(course, out e0, out n0, out origin);
                var c = new Vector3((float)(p.centre3006[0] - e0) + origin.x, 0f, (float)(p.centre3006[1] - n0) + origin.z);
                c.y = Ground(c) ?? origin.y;
                return new Located { bounds = new Bounds(c, new Vector3(10, 2, 10)), by = "centre3006" };
            }
            return null;
        }

        static Bounds MinMax(Vector3 a, Vector3 b)
        {
            var box = new Bounds(a, Vector3.zero);
            box.Encapsulate(b);
            return box;
        }

        // A scene object by name (active first) with its renderers' bounds; null when none has a renderer.
        internal static GameObject FindObject(string name, out Bounds bounds)
        {
            bounds = new Bounds();
            var scene = EditorSceneManager.GetActiveScene();
            var gos = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true))
                .Where(t => t.name == name).Select(t => t.gameObject).OrderByDescending(g => g.activeInHierarchy).ToList();
            foreach (var go in gos)
            {
                var renderers = go.GetComponentsInChildren<Renderer>(true);
                if (renderers.Length == 0) continue;
                bounds = renderers[0].bounds;
                foreach (var r in renderers.Skip(1)) bounds.Encapsulate(r.bounds);
                return go;
            }
            return null;
        }

        // Where a named object is in the course's default shaping report (its Unity bounds, else its Blender bounds
        // mapped); null without a report or a place for it. golfmap.course.refresh only= plans meshes not in the scene yet with it.
        internal static Bounds? ReportBounds(string obj)
        {
            Report r;
            try { r = Load(DefaultPath()); }
            catch (Exception) { return null; }
            var p = r.places.FirstOrDefault(x => x.obj == obj);
            if (p == null) return null;
            if (p.minUnity.HasValue && p.maxUnity.HasValue) return MinMax(p.minUnity.Value, p.maxUnity.Value);
            if (p.minBlend.HasValue && p.maxBlend.HasValue) return MinMax(BlendToUnity(p.minBlend.Value), BlendToUnity(p.maxBlend.Value));
            return null;
        }

        // The highest collider straight down at (x, z); null when there is none.
        static float? Ground(Vector3 p)
        {
            var hits = Physics.RaycastAll(new Vector3(p.x, 10000f, p.z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore);
            return hits.Length > 0 ? hits.Max(h => h.point.y) : (float?)null;
        }

        // Frames the Scene view on the bounds: from the view's current heading, TiltDeg down, back far enough to see it all.
        internal static Dictionary<string, object> Frame(Bounds b)
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null && SceneView.sceneViews.Count > 0) sv = (SceneView)SceneView.sceneViews[0];
            if (sv == null || sv.camera == null) throw new BridgeError("No Scene view is open.");
            var flat = sv.rotation * Vector3.forward;
            flat.y = 0;
            if (flat.sqrMagnitude < 1e-4f) flat = Vector3.forward;
            flat.Normalize();
            float radius = Mathf.Max(b.extents.x, b.extents.z, 4f);
            float dist = Mathf.Clamp(radius * 2.6f, 18f, 600f);
            var at = b.center;
            float tilt = TiltDeg * Mathf.Deg2Rad;
            var dir = new Vector3(flat.x * Mathf.Cos(tilt), -Mathf.Sin(tilt), flat.z * Mathf.Cos(tilt));
            var eye = at - dir * dist;
            var g = Ground(eye);
            if (g.HasValue && eye.y < g.Value + 3f) eye.y = g.Value + 3f;   // never inside a hill
            var look = at - eye;
            sv.LookAtDirect(at, Quaternion.LookRotation(look), look.magnitude);   // 2018.2: the camera sits `size` behind the pivot
            sv.Repaint();
            return new Dictionary<string, object> { { "at", at }, { "eye", eye }, { "distanceM", Math.Round(look.magnitude, 1) } };
        }

        static Dictionary<string, object> Goto(Report r, int index, bool select)
        {
            if (index < 0 || index >= r.places.Count) throw new BridgeError("index " + index + " is out of range: the report has " + r.places.Count + " places.");
            var p = r.places[index];
            var where = Locate(p);
            if (!where.HasValue) throw new BridgeError("Place " + index + " (" + p.Label + ") has no object in the scene, no centreBlend and no centre3006.");
            current = index;
            var framed = Frame(where.Value.bounds);
            if (select && where.Value.go != null) { Selection.activeGameObject = where.Value.go; EditorGUIUtility.PingObject(where.Value.go); }
            foreach (var w in Resources.FindObjectsOfTypeAll<GolfMapReview>()) w.Repaint();
            var result = Describe(r, p, where);
            foreach (var kv in framed) result[kv.Key] = kv.Value;
            return result;
        }

        static Dictionary<string, object> Describe(Report r, Place p, Located? where)
        {
            var d = new Dictionary<string, object>
            {
                { "index", p.index }, { "object", p.obj }, { "featureId", p.featureId }, { "type", p.type }, { "hole", p.hole }, { "note", p.note },
                { "done", Done(r).Contains(p.Key) },
            };
            if (where.HasValue)
            {
                d["resolvedBy"] = where.Value.by;
                d["centre"] = where.Value.bounds.center;
                d["size"] = where.Value.bounds.size;
                if (where.Value.blendOffsetM.HasValue) d["blendOffsetM"] = Math.Round(where.Value.blendOffsetM.Value, 2);
            }
            else d["resolvedBy"] = null;
            return d;
        }

        // ------------------------------------------------------------ bridge

        [BridgeCommand("golfmap.review.list", "Read-only: the changed places of a shaping report (shaping-report.json changedPlaces) with where each is in the scene (object renderer bounds, else centreBlend via Unity = (-x, z, -y), else centre3006) and its done tick. blendOffsetM = distance between an object's bounds centre and its centreBlend mapped (checks the Blender->Unity mapping).",
            args = "report (path; default EditorPrefs' or <course export folder>/shaping-report.json)")]
        static object ListCommand(BridgeArgs a)
        {
            var r = Load(a.String("report") ?? DefaultPath());
            return new Dictionary<string, object>
            {
                { "report", r.path }, { "places", r.places.Count }, { "done", r.places.Count(p => Done(r).Contains(p.Key)) }, { "current", current },
                { "items", r.places.Select(p => (object)Describe(r, p, Locate(p))).ToList() },
            };
        }

        [BridgeCommand("golfmap.review.goto", "Frame the Scene view on one changed place of a shaping report (the Review window's Go), or on a course object by name (golf-map's 'Show in Unity'): looks at it from the view's current heading, 35 deg down, far enough back to see its bounds. object= frames the scene object of that name; when the scene has none (e.g. a renamed mesh before the refresh), the report's place for it (its coordinates). Moves only the Scene view camera.",
            args = "index (0-based) or object (name), report (path; default as golfmap.review.list), select=false (also select the object)")]
        static object GotoCommand(BridgeArgs a)
        {
            var obj = a.String("object");
            if (!a.Has("index") && string.IsNullOrEmpty(obj)) throw new BridgeError("Give index or object.");
            Report r = null;
            try { r = Load(a.String("report") ?? DefaultPath()); }
            catch (BridgeError) { if (a.Has("index") || a.Has("report")) throw; }   // object= works without a report
            if (r != null && a.Has("report")) Follow(r.path);
            bool select = a.Bool("select", false);
            if (a.Has("index")) return Goto(r, a.Int("index", 0), select);

            var place = r == null ? null : r.places.FirstOrDefault(p => p.obj == obj);
            if (place != null) return Goto(r, place.index, select);   // the scene object first, else the place's coordinates
            Bounds b;
            var go = FindObject(obj, out b);
            if (go == null) throw new BridgeError("No object '" + obj + "' in the scene" + (r == null ? " and no shaping report" : " and no place for it in " + r.path) + ".");
            var framed = Frame(b);
            if (select) { Selection.activeGameObject = go; EditorGUIUtility.PingObject(go); }
            var result = new Dictionary<string, object> { { "object", obj }, { "resolvedBy", "object" }, { "inReport", false }, { "centre", b.center }, { "size", b.size } };
            foreach (var kv in framed) result[kv.Key] = kv.Value;
            return result;
        }

        [BridgeCommand("golfmap.review.load", "Load a shaping report into the Review window (opens it; the path is remembered as the window's report) and summarise its places (per hole, how each resolves in the scene). Read-only apart from the window and its remembered path.",
            args = "path (default: <course export folder>/shaping-staging/shaping-report.json, else <export folder>/shaping-report.json), open=true (open the window), items=false (every place as golfmap.review.list gives it; default counts and the first 10)")]
        static object LoadCommand(BridgeArgs a)
        {
            var path = a.String("path") ?? CourseDefaultPath();
            var r = Load(path);
            current = -1;
            Follow(r.path);
            if (a.Bool("open", true)) { var w = GetWindow<GolfMapReview>("Review"); w.reportPath = r.path; w.status = ""; w.Repaint(); }
            var done = Done(r);
            var result = new Dictionary<string, object>
            {
                { "report", r.path }, { "places", r.places.Count }, { "done", r.places.Count(p => done.Contains(p.Key)) },
                { "holes", r.places.GroupBy(p => p.hole ?? "").OrderBy(g => HoleOrder(g.Key)).ToDictionary(g => g.Key == "" ? "course-wide" : g.Key, g => (object)g.Count()) },
            };
            if (a.Bool("items", false)) result["items"] = r.places.Select(p => (object)Describe(r, p, Locate(p))).ToList();
            else
            {
                var located = r.places.Select(p => Locate(p)).ToList();
                result["resolvedBy"] = located.GroupBy(l => l.HasValue ? l.Value.by : "nowhere").ToDictionary(g => g.Key, g => (object)g.Count());
                result["first"] = r.places.Take(10).Select(p => (object)(p.index + ". " + (p.hole != null ? "hole " + p.hole + " " : "") + p.Label)).ToList();
            }
            return result;
        }

        // The window shows the report automation works with.
        static void Follow(string path)
        {
            EditorPrefs.SetString(PathPref, path);
            foreach (var w in Resources.FindObjectsOfTypeAll<GolfMapReview>()) { w.reportPath = path; w.Repaint(); }
        }

        // ------------------------------------------------------------ window

        void OnGUI()
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                var picked = EditorGUILayout.TextField("Shaping report", reportPath);
                if (GUILayout.Button("...", GUILayout.Width(30)))
                {
                    var dir = string.IsNullOrEmpty(reportPath) ? "" : Path.GetDirectoryName(reportPath);
                    var p = EditorUtility.OpenFilePanel("Shaping report", dir, "json");
                    if (!string.IsNullOrEmpty(p)) picked = p;
                }
                if (GUILayout.Button("Default", GUILayout.Width(60))) { EditorPrefs.DeleteKey(PathPref); picked = DefaultPath(); }
                if (picked != reportPath) { reportPath = picked; EditorPrefs.SetString(PathPref, reportPath); current = -1; }
            }
            Report r = null;
            try { r = Load(reportPath); }
            catch (Exception e) { EditorGUILayout.HelpBox(e.Message + " Run blender/tools/shape_apply.py, or pick a report.", MessageType.Warning); }
            RefreshPending();
            if (r == null) return;

            var done = Done(r);
            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.LabelField(r.places.Count + " places, " + r.places.Count(p => done.Contains(p.Key)) + " done", GUILayout.Width(170));
                if (GUILayout.Button("< Prev", GUILayout.Width(60))) Step(r, -1);
                if (GUILayout.Button("Next >", GUILayout.Width(60))) Step(r, +1);
                skipDone = GUILayout.Toggle(skipDone, "Skip done", GUILayout.Width(80));
                hideDone = GUILayout.Toggle(hideDone, "Hide done", GUILayout.Width(80));
            }
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.None);

            scroll = EditorGUILayout.BeginScrollView(scroll);
            foreach (var group in r.places.GroupBy(p => p.hole ?? "").OrderBy(g => HoleOrder(g.Key)))
            {
                var title = group.Key == "" ? "Course-wide" : "Hole " + group.Key;
                bool open = !collapsed.Contains(group.Key);
                bool now = EditorGUILayout.Foldout(open, title + "  (" + group.Count(p => done.Contains(p.Key)) + "/" + group.Count() + " done)", true);
                if (now != open) { if (now) collapsed.Remove(group.Key); else collapsed.Add(group.Key); }
                if (!now) continue;
                foreach (var p in group)
                {
                    bool isDone = done.Contains(p.Key);
                    if (hideDone && isDone && p.index != current) continue;
                    using (new EditorGUILayout.HorizontalScope(p.index == current ? EditorStyles.helpBox : GUIStyle.none))
                    {
                        bool tick = EditorGUILayout.Toggle(isDone, GUILayout.Width(16));
                        if (tick != isDone) SetDone(r, p, tick);
                        if (GUILayout.Button("Go", EditorStyles.miniButton, GUILayout.Width(32))) Go(r, p.index);
                        EditorGUILayout.LabelField(p.index + ". " + p.Label);
                    }
                }
            }
            EditorGUILayout.EndScrollView();
        }

        static int HoleOrder(string hole)
        {
            int n;
            return hole == "" ? int.MaxValue : int.TryParse(hole, out n) ? n : int.MaxValue - 1;
        }

        void Step(Report r, int by)
        {
            if (r.places.Count == 0) return;
            var done = Done(r);
            // walk in the list's order (grouped by hole)
            var order = r.places.OrderBy(p => HoleOrder(p.hole ?? "")).ThenBy(p => p.index).Select(p => p.index).ToList();
            int at = order.IndexOf(current);
            for (int i = 0; i < order.Count; i++)
            {
                at = at < 0 ? (by > 0 ? 0 : order.Count - 1) : (at + by + order.Count) % order.Count;
                if (!skipDone || !done.Contains(r.places[order[at]].Key) || i == order.Count - 1) { Go(r, order[at]); return; }
            }
        }

        void Go(Report r, int index)
        {
            try
            {
                var result = Goto(r, index, true);
                status = r.places[index].Label + "  (" + result["resolvedBy"] + ")";
            }
            catch (Exception e) { status = e.Message; }
            Repaint();
        }

        // ------------------------------------------------------------ refresh report

        string pendingFrom;
        DateTime pendingTime;
        List<string> pending;

        void RefreshPending()
        {
            var course = GolfMapCourses.Active();
            if (course == null) return;
            var path = GolfMapCourses.Folder(course) + GolfMapCourseRefresh.ReportFile;
            if (!File.Exists(path)) path = GolfMapCourses.ReportPath(course, GolfMapCourseRefresh.DryRunSuffix);
            if (!File.Exists(path)) return;
            var t = File.GetLastWriteTimeUtc(path);
            if (path != pendingFrom || t != pendingTime)
            {
                pendingFrom = path; pendingTime = t;
                try
                {
                    var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
                    pending = (root.Array("pending") ?? new List<object>()).OfType<string>().ToList();
                }
                catch (Exception) { pending = null; }
            }
            if (pending != null && pending.Count > 0)
                EditorGUILayout.HelpBox("Last course refresh (" + Path.GetFileName(path) + ", " + t.ToLocalTime().ToString("yyyy-MM-dd HH:mm") + "):\n- " + string.Join("\n- ", pending.ToArray()), MessageType.Info);
        }
    }
}
