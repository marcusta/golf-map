// What golfmap.props.place itself placed, and the rule that lets a re-place keep what the user moved
// by hand in Unity (Unity 2018.2 / C# 6).
//
// Why: props.place rebuilt 'GolfMap Props/<Category>s/<asset>#<i>' from the spec every time and dropped
// every prop Marcus had moved or rotated in the editor (three sessions lost to it, workflow 4 in
// docs/workflows.md exists only for that). So every place now records, next to the manifest in
// <props folder>/placed.json, the transform it gave each instance together with the spec entry it came
// from. The next place compares: an instance standing somewhere else than the tool left it was moved by
// hand and keeps the user's transform; one whose spec entry moved since takes the spec again.
//
// Nothing is written back into docs/gspro/<course>/*-props.gen.py: that is still the way to make a hand
// move permanent across machines. The place report lists the hand-placed instances with both transforms
// so the user or an agent can carry them into the spec.
//
// Matching is by asset and nearest position, never by the instance index alone. `<asset>#<i>` is the
// index in the manifest at the moment of placing, and it goes stale as soon as the spec gains or loses a
// place() call: on Vreta a record run that trusted the names reported 88 "hand moves" that were really
// one index shift per asset (11 range_mat all off by exactly 5.745-5.805 m, a row of hedge_boxwood all
// off by 11.18 m, bench_stone by 187-522 m).
//   scene object -> record   by object name - and only there is the name trusted, because the record was
//                            written by the place that made that object; a renamed object is found by the
//                            nearest unclaimed record within matchM;
//   record -> spec entry     by the nearest recorded spec position (e, n), ONE-TO-ONE, closest pair
//                            first, with no radius: PairNearest. Within one asset the instances stand far
//                            further apart than any hand nudge, so the unmoved ones pair at distance 0
//                            and are consumed first, and a moved one can only pair with what is left.
//   scene object -> spec     the same PairNearest on x/z, for golfmap.props.record (which has no records
//                            to go by: GolfMapProps.Record).
//
// Two lists come out beside the per-spec-entry decisions: `dropped`, the records no spec entry claimed
// (the spec lost that place(...) call), and `handAdded`, the instances in the scene no record claimed -
// the tool never made them, so they were duplicated by hand ("<asset>#3 (1)") and are left standing.
// GolfMapProps keeps those out of placed.json on purpose: "no record claims it" is what finds them, and
// a record with spec null would be claimed by nothing and dropped by the next place.
//
// The same rule mirrored in JS and tested with bun: unity/props-matching.mjs + props-matching.test.mjs.
// Change both together.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapPropsPlaced
    {
        public const string Format = "golfmap-props-placed-v1";
        public const string FileName = "placed.json";

        // Where the tool put an instance: the world transform it set.
        public sealed class Pose
        {
            public Vector3 pos, euler, scale;
            public Pose Copy() { return new Pose { pos = pos, euler = euler, scale = scale }; }
        }

        // The spec entry an instance came from (EPSG:3006 e/n, compass yaw, lift over the ground, scale).
        public sealed class SpecPose
        {
            public double e, n;
            public float yaw, dz;
            public Vector3 scale = Vector3.one;
        }

        public sealed class SpecEntry
        {
            public int index;         // the instance's index in the manifest (the object name's #i)
            public SpecPose spec;
        }

        public sealed class Record
        {
            public string asset, name;
            public int index;         // the spec entry it belongs to, -1 when the spec has none for it
            public SpecPose spec;     // null: no spec entry left for this instance (the next place deletes it)
            public Pose placed = new Pose();
            public bool hand;         // placed at a transform the user gave it, not at the spec's
        }

        public sealed class SceneInstance
        {
            public string name;
            public Pose pose = new Pose();
        }

        public sealed class Tolerance
        {
            public float positionM = 0.01f;   // 1 cm
            public float rotDeg = 0.5f;       // half a degree, on any axis (a tilt counts too)
            public float scale = 0.001f;      // a thousandth, relative
            public float matchM = 2f;         // only for finding a RENAMED scene object by its recorded position
        }

        // One spec entry's outcome.
        public sealed class Decision
        {
            public int index;
            public bool kept;
            public string rule;              // which branch of the rule decided: the JS mirror's codes
            public string reason;
            public Record record;             // the record it paired with, null when there is none
            public Pose keep;                 // the transform to place at when kept
            public Pose was;                  // what the tool had placed there (for the report)
            public float movedM, movedDeg, movedScale;        // scene against the record
            public float specMovedM, specMovedDeg, specMovedScale;   // the spec against the recorded spec
        }

        // ---- the rule ------------------------------------------------------------------------

        // specs/records/scene are one asset's. dropped gets the records no spec entry claimed (the spec
        // lost that place() call); handAdded the scene instances no record claimed (duplicated by hand
        // in Unity: the place leaves them standing).
        public static List<Decision> Decide(List<SpecEntry> specs, List<Record> records, List<SceneInstance> scene, Tolerance tol,
            out List<Record> dropped, out List<SceneInstance> handAdded)
        {
            if (tol == null) tol = new Tolerance();
            var inScene = PairScene(records, scene, tol, out handAdded);
            var paired = PairSpecs(specs, records);

            var decisions = new List<Decision>();
            for (int i = 0; i < specs.Count; i++)
            {
                var spec = specs[i];
                var d = new Decision { index = spec.index };
                var record = paired[i] < 0 ? null : records[paired[i]];
                d.record = record;
                if (record == null)
                {
                    d.rule = "no-record";
                    d.reason = "no record left for this instance (a new place(...) call, or the spec has more instances of this asset than the record): the spec decides";
                    decisions.Add(d);
                    continue;
                }
                d.was = record.placed.Copy();
                var now = inScene.ContainsKey(record) ? inScene[record] : null;
                bool moved = false;
                if (now != null)
                {
                    d.movedM = Distance(now.pos, record.placed.pos);
                    d.movedDeg = RotDelta(now.euler, record.placed.euler);
                    d.movedScale = ScaleDelta(now.scale, record.placed.scale);
                    moved = d.movedM > tol.positionM || d.movedDeg > tol.rotDeg || d.movedScale > tol.scale;
                }
                bool hand = record.hand || moved;
                if (!hand)
                {
                    d.rule = now == null ? "no-instance" : "unmoved";
                    d.reason = now == null
                        ? "no instance in the scene and none was hand-placed: the spec decides"
                        : "standing where the tool put it: the spec decides";
                    decisions.Add(d);
                    continue;
                }
                d.specMovedM = Mathf.Max(
                    (float)Math.Sqrt((spec.spec.e - record.spec.e) * (spec.spec.e - record.spec.e) + (spec.spec.n - record.spec.n) * (spec.spec.n - record.spec.n)),
                    Mathf.Abs(spec.spec.dz - record.spec.dz));
                d.specMovedDeg = Mathf.Abs(Mathf.DeltaAngle(record.spec.yaw, spec.spec.yaw));
                d.specMovedScale = ScaleDelta(spec.spec.scale, record.spec.scale);
                if (d.specMovedM > tol.positionM || d.specMovedDeg > tol.rotDeg || d.specMovedScale > tol.scale)
                {
                    d.rule = "spec-moved";
                    d.reason = "hand-placed, but the spec moved it since (" + Num(d.specMovedM) + " m, " + Num(d.specMovedDeg) + " deg): the spec wins";
                    decisions.Add(d);
                    continue;
                }
                d.kept = true;
                d.keep = (now ?? record.placed).Copy();
                d.rule = now == null ? "hand-recorded" : (moved ? "hand-moved" : "hand-kept");
                d.reason = now != null
                    ? (moved ? "moved by hand in Unity (" + Num(d.movedM) + " m, " + Num(d.movedDeg) + " deg): kept" : "hand-placed earlier and still there: kept")
                    : "hand-placed earlier; no instance in the scene now: placed at the recorded hand transform";
                decisions.Add(d);
            }

            var claimed = new HashSet<int>(paired.Where(k => k >= 0));
            dropped = Enumerable.Range(0, records.Count).Where(k => !claimed.Contains(k)).Select(k => records[k]).ToList();
            return decisions;
        }

        // record -> the instance standing in the scene for it: by name, else the nearest unclaimed
        // instance within matchM of where the tool left it (a renamed object). handAdded gets what no
        // record claimed: the tool never made it, so somebody duplicated it in Unity ("<asset>#3 (1)").
        static Dictionary<Record, Pose> PairScene(List<Record> records, List<SceneInstance> scene, Tolerance tol, out List<SceneInstance> handAdded)
        {
            var found = new Dictionary<Record, Pose>();
            var taken = new HashSet<string>();
            foreach (var r in records)
            {
                var byName = scene.FirstOrDefault(s => s.name == r.name);
                if (byName == null) continue;
                found[r] = byName.pose;
                taken.Add(byName.name);
            }
            foreach (var r in records)
            {
                if (found.ContainsKey(r)) continue;
                SceneInstance best = null;
                float bestD = tol.matchM;
                foreach (var s in scene)
                {
                    if (taken.Contains(s.name)) continue;
                    float d = Distance(s.pose.pos, r.placed.pos);
                    if (d <= bestD) { bestD = d; best = s; }
                }
                if (best != null) { found[r] = best.pose; taken.Add(best.name); }
            }
            handAdded = scene.Where(s => !taken.Contains(s.name)).ToList();
            return found;
        }

        // spec entry index -> record index (-1 for none): the nearest recorded spec position, one-to-one,
        // closest pair first, no radius. Never by the instance index: those go stale with the spec.
        // Records without a spec (an instance the spec had no entry for) take part in nothing.
        static int[] PairSpecs(List<SpecEntry> specs, List<Record> records)
        {
            var usable = Enumerable.Range(0, records.Count).Where(k => records[k].spec != null).ToList();
            var paired = PairNearest(
                specs.Select(s => s.spec.e).ToList(), specs.Select(s => s.spec.n).ToList(),
                usable.Select(k => records[k].spec.e).ToList(), usable.Select(k => records[k].spec.n).ToList());
            for (int i = 0; i < paired.Length; i++) paired[i] = paired[i] < 0 ? -1 : usable[paired[i]];
            return paired;
        }

        // One-to-one nearest pairing of two sets of points, closest pair first and no radius: the returned
        // array holds, per point of a, the index of the point of b it paired with, or -1 when b ran out.
        // Coordinates stay double (EPSG:3006 northings lose half a metre as float), and distances are
        // rounded to the millimetre so this and the JS mirror break ties the same way.
        //
        // MidpointRounding.AwayFromZero, not Math.Round's default: that one is banker's rounding
        // (half to even, 2.5 -> 2) while JS Math.round is half up for a positive number, so an exact
        // half-millimetre tie - two candidates at x.5 mm - used to pair differently in C# and in JS.
        public static int[] PairNearest(IList<double> ax, IList<double> ay, IList<double> bx, IList<double> by)
        {
            var paired = new int[ax.Count];
            for (int i = 0; i < paired.Length; i++) paired[i] = -1;
            var pairs = new List<long[]>();           // { distance in mm, a index, b index }
            for (int i = 0; i < ax.Count; i++)
                for (int k = 0; k < bx.Count; k++)
                {
                    double dx = ax[i] - bx[k], dy = ay[i] - by[k];
                    pairs.Add(new[] { (long)Math.Round(Math.Sqrt(dx * dx + dy * dy) * 1000, MidpointRounding.AwayFromZero), (long)i, (long)k });
                }
            pairs.Sort((p, q) => p[0] != q[0] ? p[0].CompareTo(q[0]) : (p[1] != q[1] ? p[1].CompareTo(q[1]) : p[2].CompareTo(q[2])));
            var used = new HashSet<int>();
            foreach (var p in pairs)
            {
                int i = (int)p[1], k = (int)p[2];
                if (paired[i] >= 0 || used.Contains(k)) continue;
                paired[i] = k;
                used.Add(k);
            }
            return paired;
        }

        public static float Distance(Vector3 a, Vector3 b) { return (a - b).magnitude; }

        public static float RotDelta(Vector3 a, Vector3 b)
        {
            return Mathf.Max(Mathf.Abs(Mathf.DeltaAngle(a.x, b.x)), Mathf.Max(Mathf.Abs(Mathf.DeltaAngle(a.y, b.y)), Mathf.Abs(Mathf.DeltaAngle(a.z, b.z))));
        }

        public static float ScaleDelta(Vector3 a, Vector3 b)
        {
            return Mathf.Max(Rel(a.x, b.x), Mathf.Max(Rel(a.y, b.y), Rel(a.z, b.z)));
        }

        static float Rel(float a, float b) { return Mathf.Abs(a - b) / Mathf.Max(1e-6f, Mathf.Abs(b)); }

        static string Num(double v) { return Math.Round(v, 3).ToString(CultureInfo.InvariantCulture); }

        // ---- the sidecar ---------------------------------------------------------------------

        public static string SidecarPath(string folder) { return folder + FileName; }

        // Every record of the sidecar, by asset id. A missing or unreadable file gives an empty set and
        // a note (never an error: the first place after this existed has none).
        public static Dictionary<string, List<Record>> Load(string path, out string note)
        {
            note = null;
            var byAsset = new Dictionary<string, List<Record>>();
            if (!File.Exists(path)) { note = "no " + path + " yet: nothing recorded, every instance takes the spec"; return byAsset; }
            GolfMapJsonObject root;
            try { root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path)); }
            catch (Exception e) { note = path + " could not be read (" + e.Message + "): every instance takes the spec"; return byAsset; }
            if (root.String("format") != Format) { note = path + " is not " + Format + ": ignored"; return byAsset; }
            var list = root.Array("instances");
            if (list == null) return byAsset;
            foreach (var o in list.OfType<GolfMapJsonObject>())
            {
                var asset = o.String("asset");
                if (string.IsNullOrEmpty(asset)) continue;
                var spec = o.Object("spec");
                var placed = o.Object("placed");
                var r = new Record
                {
                    asset = asset, name = o.String("name"), index = (int)o.Number("index", -1),
                    hand = o.Bool("hand", false),
                };
                if (spec != null)                     // absent or null: the spec had no entry for it
                    r.spec = new SpecPose
                    {
                        e = spec.Number("e"), n = spec.Number("n"),
                        yaw = (float)spec.Number("yawDeg"), dz = (float)spec.Number("dz"),
                        scale = Vec(spec.Array("scale"), Vector3.one),
                    };
                if (placed != null)
                    r.placed = new Pose
                    {
                        pos = Vec(placed.Array("pos"), Vector3.zero),
                        euler = Vec(placed.Array("euler"), Vector3.zero),
                        scale = Vec(placed.Array("scale"), Vector3.one),
                    };
                List<Record> rs;
                if (!byAsset.TryGetValue(asset, out rs)) byAsset[asset] = rs = new List<Record>();
                rs.Add(r);
            }
            return byAsset;
        }

        static Vector3 Vec(List<object> l, Vector3 fallback)
        {
            if (l == null || l.Count < 3) return fallback;
            return new Vector3(N(l[0]), N(l[1]), N(l[2]));
        }

        static float N(object o) { var n = o as GolfMapJsonNumber; return n == null ? 0f : (float)n.Value; }

        // assetHashes: asset id -> a hash of that asset's spec entries, so a report can say which asset's
        // spec changed without comparing every instance.
        public static void Save(string path, string manifest, Dictionary<string, List<Record>> byAsset, Dictionary<string, string> assetHashes)
        {
            var rows = new List<object>();
            foreach (var asset in byAsset.Keys.OrderBy(k => k, StringComparer.Ordinal))
                foreach (var r in byAsset[asset])
                    rows.Add(new Dictionary<string, object>
                    {
                        { "asset", r.asset }, { "index", r.index }, { "name", r.name }, { "hand", r.hand },
                        { "spec", r.spec == null ? null : (object)new Dictionary<string, object> {
                            { "e", r.spec.e }, { "n", r.spec.n }, { "yawDeg", r.spec.yaw }, { "dz", r.spec.dz },
                            { "scale", new object[] { r.spec.scale.x, r.spec.scale.y, r.spec.scale.z } } } },
                        { "placed", new Dictionary<string, object> {
                            { "pos", new object[] { r.placed.pos.x, r.placed.pos.y, r.placed.pos.z } },
                            { "euler", new object[] { r.placed.euler.x, r.placed.euler.y, r.placed.euler.z } },
                            { "scale", new object[] { r.placed.scale.x, r.placed.scale.y, r.placed.scale.z } } } },
                    });
            var doc = new Dictionary<string, object>
            {
                { "format", Format },
                { "note", "Written by golfmap.props.place: what the tool placed, so the next place can tell a hand move from the spec. Not a spec: hand moves become permanent only in docs/gspro/<course>/*-props.gen.py." },
                { "manifest", manifest },
                { "written", DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss") },
                { "specHashes", assetHashes },
                { "instances", rows },
            };
            File.WriteAllText(path, GolfMapJson.Serialize(doc) + "\n");
        }

        // A short stable hash of one asset's spec entries (order included), for the report.
        public static string SpecHash(List<SpecEntry> specs)
        {
            uint h = 2166136261u;
            unchecked
            {
                foreach (var s in specs)
                {
                    var text = string.Format(CultureInfo.InvariantCulture, "{0:F3}|{1:F3}|{2:F2}|{3:F3}|{4:F3},{5:F3},{6:F3};",
                        s.spec.e, s.spec.n, s.spec.yaw, s.spec.dz, s.spec.scale.x, s.spec.scale.y, s.spec.scale.z);
                    foreach (var c in text) h = (h ^ (uint)c) * 16777619u;
                }
            }
            return h.ToString("x8", CultureInfo.InvariantCulture);
        }
    }
}
