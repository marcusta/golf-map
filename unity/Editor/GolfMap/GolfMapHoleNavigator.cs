// Hole navigator: fast travel in the Scene view. A window (GolfMap > Scene View > Hole navigator) with a row per
// hole and a button per stop - the tee, every aim point, the green centre. A click puts the Scene view's eye over
// that point, heightM (5) above the ground the scene has there, looking along the hole's direction of play:
// from the tee to the first aim point ahead of it (else the green), from an aim point to the next stop. The green
// is seen from 15 m behind its centre, looking back down the hole. < and > step through the whole course in playing order.
//
// Read from the course export folder's <prefix>-holes.json (`pipeline/gspro.py holes`):
//
//   { "format": "golfmap-holes-v1", "crs": "EPSG:3006",
//     "holes": [ { "number": 1, "par": 4, "tees": [ { "name": "Yellow", "color": "yellow", "e": .., "n": .. } ],
//                  "aims": [ { "label": "", "e": .., "n": .. } ], "green": { "e": .., "n": .. } | null } ] }
//
// "Tee" is the hole's back tee (the one furthest from the green) unless the toolbar picks a tee by name.
// golfmap.holes does the same from the bridge.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public class GolfMapHoleNavigator : EditorWindow
    {
        public const string Format = "golfmap-holes-v1";
        const string BackTee = "Back tee";
        const string HeightPref = "GolfMap.HoleNavigator.HeightM", TeePref = "GolfMap.HoleNavigator.Tee";
        const float DefaultHeightM = 5f;
        const float TiltDeg = -10f;   // a little down, so the ground ahead fills the view
        const float GreenBackM = 15f;

        class Tee { public string name; public Vector3 at; }

        class Hole
        {
            public int number, par;
            public List<Tee> tees = new List<Tee>();
            public List<Vector3> aims = new List<Vector3>();
            public Vector3? green;
        }

        class Stop
        {
            public int hole;
            public string key, label, tip;   // key: tee | aim1.. | green
            public Vector3 at;               // on the y = 0 plane
            public Vector3? towards;         // null: a hole with this one point
            public float backM;              // the eye stands this far behind the point, along the view
            public string Id { get { return hole + ":" + key; } }
        }

        class Course
        {
            public string problem;
            public List<Hole> holes = new List<Hole>();
            public string[] teeNames = new string[0];
        }

        // ---- the file ------------------------------------------------------------

        static Course Load()
        {
            var c = new Course();
            try
            {
                var course = GolfMapCourses.Require();
                if (string.IsNullOrEmpty(course.exportFolder)) throw new InvalidOperationException("The course has no export folder.");
                var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
                var file = Path.GetFullPath(Path.Combine(folder, course.exportPrefix + "-holes.json"));
                if (!File.Exists(file)) throw new InvalidOperationException("No holes file: " + file + "\nWrite it from the golf-map repo:\nbun run py gspro.py holes --course <course> --out \"" + file + "\"");
                var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
                if (doc.String("format") != Format) throw new InvalidOperationException(file + " is not " + Format + ".");
                double e0, n0; Vector3 origin;
                GolfMapProps.Frame(course, out e0, out n0, out origin);
                Func<GolfMapJsonObject, Vector3> at = o => new Vector3((float)(o.Number("e") - e0) + origin.x, 0f, (float)(o.Number("n") - n0) + origin.z);
                foreach (var ho in (doc.Array("holes") ?? new List<object>()).Cast<GolfMapJsonObject>())
                {
                    var h = new Hole { number = (int)ho.Number("number"), par = (int)ho.Number("par") };
                    foreach (var t in (ho.Array("tees") ?? new List<object>()).Cast<GolfMapJsonObject>())
                        h.tees.Add(new Tee { name = t.String("name") ?? "", at = at(t) });
                    foreach (var a in (ho.Array("aims") ?? new List<object>()).Cast<GolfMapJsonObject>()) h.aims.Add(at(a));
                    var green = ho.Object("green");
                    if (green != null) h.green = at(green);
                    c.holes.Add(h);
                }
                c.holes.Sort((x, y) => x.number.CompareTo(y.number));
                c.teeNames = c.holes.SelectMany(h => h.tees).Select(t => t.name).Where(n => n != "").Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            }
            catch (Exception e) { c.problem = e.Message; }
            return c;
        }

        // ---- stops and the direction of play --------------------------------------

        static Tee PickTee(Hole h, string teeSet)
        {
            if (h.tees.Count == 0) return null;
            var named = h.tees.FirstOrDefault(t => string.Equals(t.name, teeSet, StringComparison.OrdinalIgnoreCase));
            if (named != null) return named;
            return h.green.HasValue ? h.tees.OrderByDescending(t => (t.at - h.green.Value).sqrMagnitude).First() : h.tees[0];
        }

        static List<Stop> Stops(Hole h, string teeSet)
        {
            var stops = new List<Stop>();
            var tee = PickTee(h, teeSet);
            if (tee != null) stops.Add(new Stop { hole = h.number, key = "tee", label = "Tee", tip = tee.name + " tee", at = tee.at });
            for (int i = 0; i < h.aims.Count; i++)
                stops.Add(new Stop { hole = h.number, key = "aim" + (i + 1), label = "Aim " + (i + 1), tip = "Aim point " + (i + 1), at = h.aims[i] });
            if (h.green.HasValue) stops.Add(new Stop { hole = h.number, key = "green", label = "Green", tip = "Green centre", at = h.green.Value });

            for (int i = 0; i < stops.Count; i++)
            {
                if (i + 1 < stops.Count) stops[i].towards = stops[i + 1].at;
                else if (i > 0 && stops[i].key != "green") stops[i].towards = stops[i].at + (stops[i].at - stops[i - 1].at);   // the way the last shot came in
                else if (i > 0) { stops[i].towards = stops[i - 1].at; stops[i].backM = GreenBackM; }   // from behind the green, back down the hole
            }
            // A forward tee does not look back at an aim point it is already past (gspro.py's _gkd_tee_distance rule).
            if (tee != null && h.green.HasValue)
            {
                var green = h.green.Value;
                float toGreen = (tee.at - green).sqrMagnitude;
                var ahead = h.aims.Where(a => (a - green).sqrMagnitude < toGreen).ToList();
                stops[0].towards = ahead.Count > 0 ? ahead[0] : green;
            }
            return stops;
        }

        static Dictionary<string, object> Go(Stop s, float heightM)
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null || sv.camera == null) throw new InvalidOperationException("No Scene view is open.");
            var flat = s.towards.HasValue ? s.towards.Value - s.at : sv.camera.transform.forward;
            flat.y = 0f;
            if (flat.sqrMagnitude < 1e-6f) flat = Vector3.forward;
            flat.Normalize();
            var eye = s.at - flat * s.backM;
            var ground = GolfMapViewInfo.Ground(eye);
            if (!ground.HasValue) throw new InvalidOperationException("No ground under hole " + s.hole + " " + s.label.ToLowerInvariant() + " (outside the terrains).");
            eye.y = ground.Value + heightM;
            float tilt = TiltDeg * Mathf.Deg2Rad;
            GolfMapViewInfo.LookFrom(sv, eye, flat * Mathf.Cos(tilt) + Vector3.up * Mathf.Sin(tilt));
            return new Dictionary<string, object>
            {
                { "hole", s.hole }, { "point", s.key }, { "tee", s.key == "tee" ? s.tip : null },
                { "eye", new object[] { Math.Round(eye.x, 2), Math.Round(eye.y, 2), Math.Round(eye.z, 2) } },
                { "heading", Math.Round((Mathf.Atan2(flat.x, flat.z) * Mathf.Rad2Deg + 360f) % 360f, 1) },
            };
        }

        // ---- the window -----------------------------------------------------------

        Course data;
        [SerializeField] string current = "";   // the stop the view was last sent to
        [SerializeField] Vector2 scroll;

        [MenuItem("GolfMap/Scene View/Hole navigator")]
        static void Open() { GetWindow<GolfMapHoleNavigator>("Holes"); }

        void OnEnable() { data = Load(); }
        void OnFocus() { data = Load(); }   // a new export, another scene's course

        void Travel(Stop s)
        {
            try
            {
                Go(s, EditorPrefs.GetFloat(HeightPref, DefaultHeightM));
                current = s.Id;
            }
            catch (Exception e) { ShowNotification(new GUIContent(e.Message)); }
        }

        void Step(int by, string teeSet)
        {
            var all = data.holes.SelectMany(h => Stops(h, teeSet)).ToList();
            if (all.Count == 0) return;
            int i = all.FindIndex(s => s.Id == current);
            Travel(all[i < 0 ? (by > 0 ? 0 : all.Count - 1) : (i + by + all.Count) % all.Count]);
        }

        void OnGUI()
        {
            if (data == null) data = Load();
            string teeSet = EditorPrefs.GetString(TeePref, BackTee);
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                using (new EditorGUI.DisabledScope(data.problem != null))
                {
                    if (GUILayout.Button(new GUIContent("<", "The stop before this one, in playing order"), EditorStyles.toolbarButton, GUILayout.Width(24))) Step(-1, teeSet);
                    if (GUILayout.Button(new GUIContent(">", "The next stop, in playing order"), EditorStyles.toolbarButton, GUILayout.Width(24))) Step(1, teeSet);
                    var sets = new[] { BackTee }.Concat(data.teeNames).ToArray();
                    int was = Mathf.Max(0, Array.FindIndex(sets, n => string.Equals(n, teeSet, StringComparison.OrdinalIgnoreCase)));
                    int now = EditorGUILayout.Popup(was, sets, EditorStyles.toolbarPopup, GUILayout.Width(80));
                    if (now != was) { teeSet = sets[now]; EditorPrefs.SetString(TeePref, teeSet); }
                }
                GUILayout.FlexibleSpace();
                GUILayout.Label(new GUIContent("m up", "The eye's height over the ground at the stop"), EditorStyles.miniLabel);
                float heightM = EditorPrefs.GetFloat(HeightPref, DefaultHeightM);
                float set = EditorGUILayout.FloatField(heightM, EditorStyles.toolbarTextField, GUILayout.Width(32));
                if (set != heightM) EditorPrefs.SetFloat(HeightPref, Mathf.Clamp(set, 0.2f, 500f));
                if (GUILayout.Button("Reload", EditorStyles.toolbarButton)) data = Load();
            }
            if (data.problem != null)
            {
                EditorGUILayout.HelpBox(data.problem, MessageType.Info);
                return;
            }

            scroll = EditorGUILayout.BeginScrollView(scroll);
            var colour = GUI.backgroundColor;
            foreach (var h in data.holes)
            {
                var stops = Stops(h, teeSet);
                if (stops.Count == 0) continue;   // a hole with nothing placed yet
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Label(h.number.ToString(), EditorStyles.boldLabel, GUILayout.Width(22));
                    GUILayout.Label(h.par > 0 ? "par " + h.par : "", EditorStyles.miniLabel, GUILayout.Width(34));
                    foreach (var s in stops)
                    {
                        GUI.backgroundColor = s.Id == current ? new Color(0.55f, 0.85f, 1f) : colour;
                        if (GUILayout.Button(new GUIContent(s.label, s.tip), EditorStyles.miniButton, GUILayout.Width(48))) Travel(s);
                    }
                    GUI.backgroundColor = colour;
                    GUILayout.FlexibleSpace();
                }
            }
            EditorGUILayout.EndScrollView();
        }

        // ---- bridge ---------------------------------------------------------------

        [BridgeCommand("golfmap.holes", "The hole navigator from the bridge. With hole: puts the Scene view's eye over that hole's tee, aim point or green centre (<export folder>/<prefix>-holes.json from `gspro.py holes`), heightM above the ground, looking along the direction of play. Without: the holes and their stops.",
            args = "hole (number), point (tee | aim1, aim2 ... | green; default tee), tee (a tee name; default the back tee), heightM=5")]
        static object Command(BridgeArgs a)
        {
            var c = Load();
            if (c.problem != null) throw new BridgeError(c.problem);
            string teeSet = a.String("tee", BackTee);
            if (!a.Has("hole"))
                return new Dictionary<string, object>
                {
                    { "tees", c.teeNames },
                    { "holes", c.holes.Select(h => (object)new Dictionary<string, object>
                        { { "hole", h.number }, { "par", h.par }, { "points", Stops(h, teeSet).Select(s => s.key).ToArray() } }).ToList() },
                };
            int number = a.Int("hole", 0);
            var hole = c.holes.FirstOrDefault(h => h.number == number);
            if (hole == null) throw new BridgeError("No hole " + number + " (holes: " + string.Join(", ", c.holes.Select(h => h.number.ToString()).ToArray()) + ").");
            var stops = Stops(hole, teeSet);
            string key = a.String("point", "tee").ToLowerInvariant();
            var stop = stops.FirstOrDefault(s => s.key == key);
            if (stop == null) throw new BridgeError("Hole " + number + " has no '" + key + "' (has: " + string.Join(", ", stops.Select(s => s.key).ToArray()) + ").");
            return Go(stop, (float)a.Number("heightM", DefaultHeightM));
        }
    }
}
