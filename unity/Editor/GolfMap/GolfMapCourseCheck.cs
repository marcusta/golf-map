// Unity 2018.2 / C# 6. golfmap.course.check: is the built course whole, as the ball meets it? Read-only. Checks the
// course meshes (GolfMapSurfaces.IsCourseMesh: Spline_*, Gap_Issue_*, not water planes) in the open scene, through
// their colliders, since that is what GSPro's ball physics hits; the renderers only where they must agree with them.
//
//   1. Objects: every course mesh has an enabled, non-convex MeshCollider whose shape is what is drawn (bounds within
//      5 cm), no NaN vertices, a surface name GSPro knows (GolfMapSurfaces.Classify != Other), no second object with
//      the same mesh in the same place, no OPCD Gap_Issue marker left in the scene. Faces turned upside down (world
//      normal pointing down) that are the top surface where they lie: a ray from above (Unity's queries skip back
//      faces, and so does the ball) sees through them.
//   2. Seams: every open edge of every mesh (positions welded within 0.5 mm, so FBX normal/UV splits are not edges)
//      is probed 2 cm outside it, every 0.5 m along it. Ground there at the same height (within 1 cm beyond what the
//      slope gives): fine. Ground a step higher or lower: a step. No ground: a crack, measured outward (5 cm ... 1 m)
//      until ground is found again - narrower than the ball (4.27 cm) it shows, wider the ball can drop into it -
//      unless the probe lies outside the course (the grid below), which is the course's outer edge.
//   3. Ray grid: straight down every `cell` metres over the course meshes' bounds. Cells with no course mesh that
//      are not connected to the grid's edge are gaps (what lies under them is named: the terrain, another collider or
//      nothing). Cells where two course meshes lie within 2 cm of each other are overlaps (they z-fight, and which
//      surface the ball reads is chance).
// Findings are clustered (1.5 m apart joins), ranked error > warn > info, and written to
// <course export folder>/course-check.json, which GolfMap > Review opens (golfmap.review.load) to fly to each one.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapCourseCheck
    {
        public const string Format = "golfmap-course-check-v1";
        public const string ReportFile = "course-check.json";
        const float BallM = 0.0427f;
        const float ProbeOutM = 0.02f;     // seam probe distance outside an open edge
        const float SeamTolM = 0.01f;      // height difference across a seam that still counts as joined
        const float StepErrorM = 0.05f;    // an open step this high is an error (a ledge the ball meets, a slit seen from the side), below it a warning
        const float BunkerLipM = 0.06f;    // sand this much under its blend ring is the bunker's lip
        const float ProbeSpacingM = 0.5f;  // seam probes along an edge
        const float OverlapM = 0.02f;      // two meshes this close at one point overlap
        const float ClusterM = 1.5f;
        const float SliverM2 = 0.01f;
        static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;      // upside-down faces under this much area in one place are a warning
        static readonly float[] CrackSteps = { 0.05f, 0.1f, 0.2f, 0.5f, 1f };
        static readonly Regex HoleRe = new Regex("^Spline_hole_(\\d+)_", RegexOptions.Compiled);

        sealed class Mesh3
        {
            public GameObject go;
            public string name, hole;
            public Vector3[] v;
            public int[] t;
        }

        // one point a check found wrong; clustered into findings
        struct Hit
        {
            public string type;
            public Vector3 p;
            public int a, b;        // object indices (b = -1: none)
            public float metric;    // step dz, crack width, gap/overlap cell count ...
        }

        sealed class Finding
        {
            public string type, severity, note, hole, unit;
            public HashSet<string> objects = new HashSet<string>();
            public Vector3 min = Vector3.positiveInfinity, max = Vector3.negativeInfinity;
            public int count;
            public double metric;
            // a point with no height (a gap cell no mesh borders) widens only the plan
            public void Add(Vector3 p)
            {
                count++;
                if (float.IsNaN(p.y)) { min.x = Mathf.Min(min.x, p.x); min.z = Mathf.Min(min.z, p.z); max.x = Mathf.Max(max.x, p.x); max.z = Mathf.Max(max.z, p.z); return; }
                min = Vector3.Min(min, p); max = Vector3.Max(max, p);
            }
            public Vector3 Centre { get { var c = (min + max) * 0.5f; if (float.IsNaN(c.y) || float.IsInfinity(c.y)) c.y = 0f; return c; } }
        }

        [MenuItem("GolfMap/Check course (gaps, seams, colliders)")]
        static void Menu()
        {
            var steps = Run(0.5f, null, true, true, true, 50f, DefaultBoundary());
            object last = null;
            while (steps.MoveNext()) if (steps.Current != null) last = steps.Current;
            Debug.Log("[GolfMap Check] " + GolfMapJson.Serialize(last));
            GolfMapReview.Open();
        }

        [BridgeCommand("golfmap.course.check", "Read-only: is the built course whole as the ball meets it? Course meshes through their colliders: missing/convex colliders, collider not what is drawn, NaN, unknown surface names, duplicates, OPCD Gap_Issue markers, upside-down top faces (rays and the ball see through them); every open mesh edge probed 2 cm outside for steps and cracks (crack width measured, wider than the ball = error); a ray grid over the course for gaps (no course mesh, what is under) and overlaps (two meshes within 2 cm). Clustered findings ranked error/warn/info, written to <export folder>/course-check.json (GolfMap > Review opens it: golfmap.review.load).",
            args = "cell=0.5 (grid metres), boundary (golfmap-oob-v1 file: EPSG:3006 rings, the largest is the course boundary; default <export folder>/<prefix>-oob.json, written by bun run course:check), marginM=50 (checked beyond the boundary), all=false (ignore the boundary), hole (only that hole's meshes and 40 m round them), without (comma-separated mesh names checked as if gone: proves the check finds a hole), seams=true, grid=true, write=true, limit=60 (findings returned)")]
        static IEnumerator Command(BridgeArgs a)
        {
            var boundary = a.Bool("all", false) ? null : a.String("boundary") ?? DefaultBoundary();
            var steps = Run(Mathf.Clamp((float)a.Number("cell", 0.5), 0.1f, 5f), a.String("hole"), a.Bool("seams", true), a.Bool("grid", true), a.Bool("write", true),
                (float)a.Number("marginM", 50), boundary, (int)a.Number("limit", 60), a.Strings("without").SelectMany(x => x.Split(',')).Select(x => x.Trim()).Where(x => x.Length > 0).ToList());
            while (steps.MoveNext()) yield return steps.Current;
        }

        // <export folder>/<prefix>-oob.json when it exists
        static string DefaultBoundary()
        {
            var course = GolfMapCourses.Require();
            if (string.IsNullOrEmpty(course.exportFolder) || string.IsNullOrEmpty(course.exportPrefix)) return null;
            var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            var p = Path.Combine(folder, course.exportPrefix + "-oob.json");
            return File.Exists(p) ? p : null;
        }

        // golfmap-oob-v1 {rings: [[[e, n], ...], ...]} -> the largest ring in Unity x/z (the GKD's pOOB is the largest oob ring too)
        static List<Vector2> LargestRing(string file, double e0, double n0, Vector3 origin)
        {
            if (!File.Exists(file)) throw new BridgeError("No course boundary at " + file + ".");
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            List<Vector2> best = null; double bestArea = 0;
            foreach (var r in (root.Array("rings") ?? new List<object>()).OfType<List<object>>())
            {
                var ring = r.OfType<List<object>>().Where(pt => pt.Count >= 2)
                    .Select(pt => new Vector2((float)(((GolfMapJsonNumber)pt[0]).Value - e0) + origin.x, (float)(((GolfMapJsonNumber)pt[1]).Value - n0) + origin.z)).ToList();
                if (ring.Count < 3) continue;
                double s = 0;
                for (int i = 0; i < ring.Count; i++) { var p = ring[i]; var q = ring[(i + 1) % ring.Count]; s += (double)p.x * q.y - (double)q.x * p.y; }
                if (Math.Abs(s) / 2 > bestArea) { bestArea = Math.Abs(s) / 2; best = ring; }
            }
            return best;
        }

        // A polygon grown by `margin`, as a 1 m mask: scanline fill, then a chamfer distance (8 neighbours, within ~4%).
        sealed class AreaMask
        {
            const float Cell = 1f;
            readonly float x0, z0;
            readonly int w, h;
            readonly bool[] inside;
            public Rect Bounds { get { return new Rect(x0, z0, w * Cell, h * Cell); } }
            public double AreaM2 { get { return inside.Count(b => b) * Cell * Cell; } }

            public AreaMask(List<Vector2> ring, float margin)
            {
                float minX = ring.Min(p => p.x) - margin - 2, minZ = ring.Min(p => p.y) - margin - 2;
                float maxX = ring.Max(p => p.x) + margin + 2, maxZ = ring.Max(p => p.y) + margin + 2;
                x0 = minX; z0 = minZ;
                w = Mathf.CeilToInt((maxX - minX) / Cell); h = Mathf.CeilToInt((maxZ - minZ) / Cell);
                var dist = new float[w * h];
                for (int i = 0; i < dist.Length; i++) dist[i] = float.MaxValue;
                var xs = new List<float>();
                for (int iz = 0; iz < h; iz++)
                {
                    float z = z0 + (iz + 0.5f) * Cell;
                    xs.Clear();
                    for (int i = 0; i < ring.Count; i++)
                    {
                        var p = ring[i]; var q = ring[(i + 1) % ring.Count];
                        if ((p.y <= z) == (q.y <= z)) continue;
                        xs.Add(p.x + (z - p.y) / (q.y - p.y) * (q.x - p.x));
                    }
                    xs.Sort();
                    for (int k = 0; k + 1 < xs.Count; k += 2)
                    {
                        int a = Mathf.Max(0, Mathf.CeilToInt((xs[k] - x0) / Cell - 0.5f)), b = Mathf.Min(w - 1, Mathf.FloorToInt((xs[k + 1] - x0) / Cell - 0.5f));
                        for (int ix = a; ix <= b; ix++) dist[iz * w + ix] = 0f;
                    }
                }
                float d1 = Cell, d2 = Cell * 1.41421356f;
                for (int iz = 0; iz < h; iz++)
                    for (int ix = 0; ix < w; ix++)
                    {
                        int i = iz * w + ix; float d = dist[i];
                        if (ix > 0) d = Mathf.Min(d, dist[i - 1] + d1);
                        if (iz > 0) { d = Mathf.Min(d, dist[i - w] + d1); if (ix > 0) d = Mathf.Min(d, dist[i - w - 1] + d2); if (ix < w - 1) d = Mathf.Min(d, dist[i - w + 1] + d2); }
                        dist[i] = d;
                    }
                for (int iz = h - 1; iz >= 0; iz--)
                    for (int ix = w - 1; ix >= 0; ix--)
                    {
                        int i = iz * w + ix; float d = dist[i];
                        if (ix < w - 1) d = Mathf.Min(d, dist[i + 1] + d1);
                        if (iz < h - 1) { d = Mathf.Min(d, dist[i + w] + d1); if (ix < w - 1) d = Mathf.Min(d, dist[i + w + 1] + d2); if (ix > 0) d = Mathf.Min(d, dist[i + w - 1] + d2); }
                        dist[i] = d;
                    }
                inside = dist.Select(d => d <= margin).ToArray();
            }

            public bool Inside(float x, float z)
            {
                int ix = Mathf.FloorToInt((x - x0) / Cell), iz = Mathf.FloorToInt((z - z0) / Cell);
                return ix >= 0 && iz >= 0 && ix < w && iz < h && inside[iz * w + ix];
            }
        }

        static IEnumerator Run(float cell, string onlyHole, bool doSeams, bool doGrid, bool write, float marginM, string boundaryFile, int limit = 60, List<string> without = null)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var times = new Dictionary<string, object>();
            Action<string> lap = k => { times[k] = Math.Round(clock.Elapsed.TotalSeconds, 1); };
            var course = GolfMapCourses.Require();
            string reportPath = null;
            if (!string.IsNullOrEmpty(course.exportFolder))
            {
                var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
                reportPath = Path.GetFullPath(Path.Combine(folder, ReportFile)).Replace('\\', '/');
            }
            double e0 = 0, n0 = 0; Vector3 origin = Vector3.zero; bool epsg = false;
            try { GolfMapProps.Frame(course, out e0, out n0, out origin); epsg = true; } catch (Exception) { }
            var scene = EditorSceneManager.GetActiveScene();

            var hits = new List<Hit>();
            var findings = new List<Finding>();
            var meshes = new List<Mesh3>();
            var colliderIndex = new Dictionary<int, int>();
            var all = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => GolfMapSurfaces.IsCourseMesh(f.name)).ToList();
            int inactive = all.Count(f => !f.gameObject.activeInHierarchy);
            Func<string, string> holeOf = n => { var m = HoleRe.Match(n); return m.Success ? m.Groups[1].Value : null; };

            // ---------------------------------------------------------------- 1. objects
            var placeOf = new Dictionary<string, string>();   // mesh asset + rounded position -> first object (duplicates)
            var gone = new HashSet<string>(without ?? new List<string>(), StringComparer.Ordinal);
            foreach (var f in all.Where(x => x.gameObject.activeInHierarchy && !gone.Contains(x.name)))
            {
                var go = f.gameObject;
                var mc = go.GetComponent<MeshCollider>();
                var mr = go.GetComponent<MeshRenderer>();
                Bounds drawn = mr != null ? mr.bounds : new Bounds(go.transform.position, Vector3.zero);
                Action<string, string, string> single = (type, sev, note) =>
                {
                    var fi = new Finding { type = type, severity = sev, note = note, hole = holeOf(go.name) };
                    fi.objects.Add(go.name); fi.Add(drawn.min); fi.Add(drawn.max); fi.count = 1;
                    findings.Add(fi);
                };
                if (GolfMapSurfaces.Classify(go.name) == GolfMapSurfaces.Surface.Other && !go.name.Contains("Concrete") && !go.name.Contains("Cart")) single("unknown-surface", "warn", go.name + ": a name GSPro's surfaces do not know");
                if (go.name.StartsWith("Gap_Issue", StringComparison.Ordinal)) single("gap-marker", "warn", go.name + ": OPCD marked a gap here");
                if (mr == null || !mr.enabled) single("not-drawn", "warn", go.name + ": a collider nobody sees");
                if (mc == null || !mc.enabled || mc.sharedMesh == null) { single("no-collider", "error", go.name + ": drawn but the ball falls through it"); continue; }
                if (mc.convex) single("convex-collider", "error", go.name + ": a convex collider is a hull, not the ground");
                if (mr != null && mr.enabled && f.sharedMesh != null)
                {
                    var cb = mc.bounds;
                    float d = Mathf.Max((cb.min - drawn.min).magnitude, (cb.max - drawn.max).magnitude);
                    if (d > 0.05f) single("collider-differs", "error", go.name + ": the collider is " + d.ToString("0.00", Inv) + " m off what is drawn");
                }
                var key = AssetDatabase.GetAssetPath(mc.sharedMesh) + "#" + mc.sharedMesh.name + "@" + Vector3Int.RoundToInt(go.transform.position * 100f);
                string first;
                if (placeOf.TryGetValue(key, out first)) single("duplicate", "error", go.name + " and " + first + ": the same mesh twice in one place");
                else placeOf[key] = go.name;

                var mesh = mc.sharedMesh;
                var m = go.transform.localToWorldMatrix;
                var local = mesh.vertices;
                var w = new Vector3[local.Length];
                bool nan = false;
                for (int i = 0; i < local.Length; i++)
                {
                    w[i] = m.MultiplyPoint3x4(local[i]);
                    if (float.IsNaN(w[i].x) || float.IsNaN(w[i].y) || float.IsNaN(w[i].z) || float.IsInfinity(w[i].y)) nan = true;
                }
                if (nan) { single("nan", "error", go.name + ": vertices without a position"); continue; }
                colliderIndex[mc.GetInstanceID()] = meshes.Count;
                meshes.Add(new Mesh3 { go = go, name = go.name, hole = holeOf(go.name), v = w, t = mesh.triangles });
            }
            lap("objects");
            yield return null;

            // the area: everything, or one hole's meshes and 20 m round them
            var area = new Bounds();
            bool any = false;
            foreach (var mm in meshes)
            {
                if (onlyHole != null && mm.hole != onlyHole) continue;
                var b = mm.go.GetComponent<MeshCollider>().bounds;
                if (!any) { area = b; any = true; } else area.Encapsulate(b);
            }
            if (!any) throw new BridgeError(onlyHole == null ? "No course meshes with colliders in " + scene.name + "." : "No course meshes of hole " + onlyHole + ".");
            if (onlyHole != null) area.Expand(new Vector3(40f, 0f, 40f));
            // only what can be played: inside the course boundary (the largest oob ring) and marginM round it
            AreaMask mask = null;
            string boundaryNote = "no boundary: the whole mesh area";
            if (boundaryFile != null && epsg)
            {
                var ring = LargestRing(boundaryFile, e0, n0, origin);
                if (ring != null)
                {
                    mask = new AreaMask(ring, marginM);
                    var mb = mask.Bounds;
                    float x0 = Mathf.Max(area.min.x, mb.xMin), x1 = Mathf.Min(area.max.x, mb.xMax);
                    float z0 = Mathf.Max(area.min.z, mb.yMin), z1 = Mathf.Min(area.max.z, mb.yMax);
                    if (x1 <= x0 || z1 <= z0) throw new BridgeError("The course boundary in " + boundaryFile + " does not overlap the course meshes.");
                    area.SetMinMax(new Vector3(x0, area.min.y, z0), new Vector3(x1, area.max.y, z1));
                    boundaryNote = Path.GetFileName(boundaryFile) + " + " + marginM + " m";
                }
            }
            Func<Vector3, bool> inArea = p => p.x >= area.min.x && p.x <= area.max.x && p.z >= area.min.z && p.z <= area.max.z && (mask == null || mask.Inside(p.x, p.z));
            Func<Vector3, Vector3, bool> touchesArea = (lo, hi) => hi.x >= area.min.x && lo.x <= area.max.x && hi.z >= area.min.z && lo.z <= area.max.z;
            findings.RemoveAll(f => !touchesArea(f.min, f.max));
            var reach = meshes.Select(mm => { var b = mm.go.GetComponent<MeshCollider>().bounds; return touchesArea(b.min, b.max); }).ToList();
            float top = area.max.y + 5f, depth = area.size.y + 10f;
            var buf = new RaycastHit[64];

            // course ground straight down at (x, z) from `from` over `len`, nearest in height to `y` (or the highest);
            // -1 when none. Back faces are skipped, as the ball skips them.
            Func<float, float, float, float, float, RaycastHit?> ground = (x, z, y, from, len) =>
            {
                int n = Physics.RaycastNonAlloc(new Vector3(x, from, z), Vector3.down, buf, len, ~0, QueryTriggerInteraction.Ignore);
                RaycastHit? best = null;
                for (int i = 0; i < n; i++)
                {
                    if (!colliderIndex.ContainsKey(buf[i].collider.GetInstanceID())) continue;
                    if (best == null || (float.IsNaN(y) ? buf[i].point.y > best.Value.point.y : Mathf.Abs(buf[i].point.y - y) < Mathf.Abs(best.Value.point.y - y))) best = buf[i];
                }
                return best;
            };

            // does course mesh `o` lie at (x, z) within 0.5 m of y?
            Func<float, float, float, int, bool> reaches = (x, z, y, o) =>
            {
                int n = Physics.RaycastNonAlloc(new Vector3(x, y + 0.5f, z), Vector3.down, buf, 1f, ~0, QueryTriggerInteraction.Ignore);
                for (int i = 0; i < n; i++) { int j; if (colliderIndex.TryGetValue(buf[i].collider.GetInstanceID(), out j) && j == o) return true; }
                return false;
            };
            // a collider that is not ground (a wall's stones, a prop) standing on the edge, just inside or just outside it
            Func<Vector3, Vector2, bool> hiddenBy = (p, outward) =>
            {
                foreach (float off in new[] { -0.05f, 0.05f })
                {
                    int n = Physics.RaycastNonAlloc(new Vector3(p.x + outward.x * off, p.y + 3f, p.z + outward.y * off), Vector3.down, buf, 3.3f, ~0, QueryTriggerInteraction.Ignore);
                    for (int i = 0; i < n; i++)
                        if (!colliderIndex.ContainsKey(buf[i].collider.GetInstanceID()) && !GolfMapSurfaces.IsCourseMesh(buf[i].collider.name)
                            && !(buf[i].collider is TerrainCollider) && buf[i].point.y > p.y - 0.05f) return true;
                }
                return false;
            };

            // upside-down faces that are the top surface where they lie
            for (int k = 0; k < meshes.Count; k++)
            {
                if (!reach[k]) continue;
                var mm = meshes[k];
                var v = mm.v; var t = mm.t;
                for (int i = 0; i < t.Length; i += 3)
                {
                    Vector3 p0 = v[t[i]], p1 = v[t[i + 1]], p2 = v[t[i + 2]];
                    var nrm = Vector3.Cross(p1 - p0, p2 - p0);
                    float len = nrm.magnitude;
                    if (len < 2e-6f || nrm.y / len > -0.05f) continue;
                    var c = (p0 + p1 + p2) / 3f;
                    if (!inArea(c)) continue;
                    var g = ground(c.x, c.z, float.NaN, top, depth);
                    if (g == null || g.Value.point.y < c.y - 0.01f) hits.Add(new Hit { type = "flipped", p = c, a = k, b = -1, metric = len * 0.5f });
                }
                if (k % 50 == 0) yield return null;
            }
            lap("flipped");

            // ---------------------------------------------------------------- 3. ray grid (first: seams need its outside)
            int nx = Mathf.CeilToInt(area.size.x / cell), nz = Mathf.CeilToInt(area.size.z / cell);
            float gx0 = area.min.x, gz0 = area.min.z;
            var cellObj = new int[0];
            var outside = new bool[0];
            long rays = 0;
            if (doGrid)
            {
                if ((long)nx * nz > 40000000L) throw new BridgeError("The grid would be " + nx + " x " + nz + " cells: raise cell or pass hole.");
                cellObj = new int[nx * nz];
                var overlapWith = new Dictionary<int, int>();
                const float jitter = 0.0137f;   // keeps the rays off whole-metre seams and vertices
                for (int iz = 0; iz < nz; iz++)
                {
                    float z = gz0 + (iz + 0.5f) * cell + jitter;
                    for (int ix = 0; ix < nx; ix++)
                    {
                        float x = gx0 + (ix + 0.5f) * cell + jitter;
                        // outside the area: no ray, and it counts as outside the course (seeds the fill below)
                        if (mask != null && !mask.Inside(x, z)) { cellObj[iz * nx + ix] = -1; continue; }
                        int n = Physics.RaycastNonAlloc(new Vector3(x, top, z), Vector3.down, buf, depth, ~0, QueryTriggerInteraction.Ignore);
                        rays++;
                        int bestObj = -1; float bestY = float.NegativeInfinity;
                        for (int i = 0; i < n; i++)
                        {
                            int o;
                            if (!colliderIndex.TryGetValue(buf[i].collider.GetInstanceID(), out o)) continue;
                            if (buf[i].point.y > bestY) { bestY = buf[i].point.y; bestObj = o; }
                        }
                        cellObj[iz * nx + ix] = bestObj;
                        if (bestObj < 0) continue;
                        for (int i = 0; i < n; i++)
                        {
                            int o;
                            if (!colliderIndex.TryGetValue(buf[i].collider.GetInstanceID(), out o) || o == bestObj) continue;
                            if (bestY - buf[i].point.y < OverlapM) { overlapWith[iz * nx + ix] = o; break; }
                        }
                    }
                    if (iz % 64 == 0) yield return null;
                }
                lap("grid");
                // misses joined to the grid's edge are outside the course
                outside = new bool[nx * nz];
                var queue = new Queue<int>();
                Action<int> seed = i => { if (cellObj[i] < 0 && !outside[i]) { outside[i] = true; queue.Enqueue(i); } };
                for (int ix = 0; ix < nx; ix++) { seed(ix); seed((nz - 1) * nx + ix); }
                for (int iz = 0; iz < nz; iz++) { seed(iz * nx); seed(iz * nx + nx - 1); }
                if (mask != null)
                    for (int i = 0; i < cellObj.Length; i++)
                        if (!mask.Inside(gx0 + (i % nx + 0.5f) * cell, gz0 + (i / nx + 0.5f) * cell)) seed(i);
                while (queue.Count > 0)
                {
                    int i = queue.Dequeue(), ix = i % nx, iz = i / nx;
                    if (ix > 0) seed(i - 1);
                    if (ix < nx - 1) seed(i + 1);
                    if (iz > 0) seed(i - nx);
                    if (iz < nz - 1) seed(i + nx);
                }
                Func<int, Vector3> cellPoint = i => new Vector3(gx0 + (i % nx + 0.5f) * cell, 0f, gz0 + (i / nx + 0.5f) * cell);
                for (int i = 0; i < cellObj.Length; i++)
                {
                    if (cellObj[i] >= 0 || outside[i]) continue;
                    int ix = i % nx, iz = i / nx, nb = -1;
                    foreach (int j in new[] { ix > 0 ? i - 1 : -1, ix < nx - 1 ? i + 1 : -1, iz > 0 ? i - nx : -1, iz < nz - 1 ? i + nx : -1 })
                        if (j >= 0 && cellObj[j] >= 0) { nb = cellObj[j]; break; }
                    var p = cellPoint(i);
                    p.y = float.NaN;
                    if (nb >= 0)
                    {
                        // the bordering mesh's height just beside the cell
                        int j = new[] { ix > 0 ? i - 1 : -1, ix < nx - 1 ? i + 1 : -1, iz > 0 ? i - nx : -1, iz < nz - 1 ? i + nx : -1 }.First(x => x >= 0 && cellObj[x] == nb);
                        var q = cellPoint(j);
                        var g = ground(q.x + jitter, q.z + jitter, float.NaN, top, depth);
                        if (g != null) p.y = g.Value.point.y;
                    }
                    hits.Add(new Hit { type = "gap", p = p, a = nb, b = -1, metric = cell * cell });
                }
                foreach (var kv in overlapWith)
                {
                    var p = cellPoint(kv.Key);
                    var g = ground(p.x, p.z, float.NaN, top, depth);
                    if (g != null) p.y = g.Value.point.y;
                    hits.Add(new Hit { type = "overlap", p = p, a = cellObj[kv.Key], b = kv.Value, metric = cell * cell });
                }
                lap("gridFindings");
                yield return null;
            }
            Func<Vector3, bool> isOutside = p =>
            {
                if (!doGrid) return false;
                int ix = Mathf.FloorToInt((p.x - gx0) / cell), iz = Mathf.FloorToInt((p.z - gz0) / cell);
                if (ix < 0 || iz < 0 || ix >= nx || iz >= nz) return true;
                return outside[iz * nx + ix];
            };

            Func<Vector3, bool> isGap = p =>
            {
                if (!doGrid) return false;
                int ix = Mathf.FloorToInt((p.x - gx0) / cell), iz = Mathf.FloorToInt((p.z - gz0) / cell);
                return ix >= 0 && iz >= 0 && ix < nx && iz < nz && cellObj[iz * nx + ix] < 0 && !outside[iz * nx + ix];
            };

            // ---------------------------------------------------------------- 2. seams
            long openEdges = 0, probes = 0, nonManifold = 0;
            if (doSeams)
            {
                for (int k = 0; k < meshes.Count; k++)
                {
                    if (!reach[k]) continue;
                    var mm = meshes[k];
                    var v = mm.v; var t = mm.t;
                    // weld by position (0.5 mm): Unity splits vertices at normal/UV seams
                    // keys: 21 bits a coordinate in 1 mm from the mesh's corner (2 km); Mix, since long's own hash is
                    // hi ^ lo and an edge key (a << 32 | b) of near indices would all collide
                    var weld = new Dictionary<long, int>(v.Length, Mix.Instance);
                    var id = new int[v.Length];
                    var lo = mm.go.GetComponent<MeshCollider>().bounds.min;
                    for (int i = 0; i < v.Length; i++)
                    {
                        long q = ((long)Mathf.RoundToInt((v[i].x - lo.x) * 1000f) << 42) | ((long)Mathf.RoundToInt((v[i].y - lo.y) * 1000f) << 21) | (long)Mathf.RoundToInt((v[i].z - lo.z) * 1000f);
                        int w;
                        if (!weld.TryGetValue(q, out w)) weld[q] = w = i;
                        id[i] = w;
                    }
                    var edges = new Dictionary<long, int>(t.Length, Mix.Instance);   // edge -> uses
                    var third = new Dictionary<long, int>(t.Length, Mix.Instance);   // edge -> the opposite vertex of its first triangle
                    for (int i = 0; i < t.Length; i += 3)
                        for (int e = 0; e < 3; e++)
                        {
                            int a = id[t[i + e]], b = id[t[i + (e + 1) % 3]], c = id[t[i + (e + 2) % 3]];
                            if (a == b) continue;
                            long key = a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
                            int uses;
                            edges.TryGetValue(key, out uses);
                            edges[key] = uses + 1;
                            if (uses == 0) third[key] = c;
                        }
                    foreach (var kv in edges)
                    {
                        if (kv.Value > 2) { nonManifold++; continue; }
                        if (kv.Value != 1) continue;
                        openEdges++;
                        Vector3 p0 = v[(int)(kv.Key >> 32)], p1 = v[(int)(kv.Key & 0xffffffff)], pc = v[third[kv.Key]];
                        var d = new Vector2(p1.x - p0.x, p1.z - p0.z);
                        float len = d.magnitude;
                        if (len < 1e-4f) continue;
                        var outward = new Vector2(-d.y, d.x) / len;
                        var mid = (p0 + p1) * 0.5f;
                        if (Vector2.Dot(outward, new Vector2(pc.x - mid.x, pc.z - mid.z)) > 0) outward = -outward;
                        int ns = Mathf.Max(1, Mathf.CeilToInt(len / ProbeSpacingM));
                        for (int s = 0; s < ns; s++)
                        {
                            var sp = Vector3.Lerp(p0, p1, (s + 0.5f) / ns);
                            if (!inArea(sp)) continue;
                            probes++;
                            float qx = sp.x + outward.x * ProbeOutM, qz = sp.z + outward.y * ProbeOutM;
                            var g = ground(qx, qz, sp.y, sp.y + 1.5f, 3f);
                            if (g != null)
                            {
                                var n = g.Value.normal;
                                float slope = n.y > 0.05f ? ProbeOutM * Mathf.Sqrt(n.x * n.x + n.z * n.z) / n.y : 1f;
                                float dz = g.Value.point.y - sp.y;
                                if (Mathf.Abs(dz) - slope > SeamTolM)
                                {
                                    int o;
                                    colliderIndex.TryGetValue(g.Value.collider.GetInstanceID(), out o);
                                    // a lip: the other mesh reaches in over or under this edge (a bunker's sand under its
                                    // blend), so nothing opens; or a wall's / prop's stones stand on it and hide it
                                    // a bunker's sand meets its blend ring a few cm lower all round (Bunker Studio / OPCD): a lip
                                    bool bunkerLip = o != k && Mathf.Abs(dz) <= BunkerLipM && IsBunkerPair(mm.name, meshes[o].name);
                                    string type = bunkerLip ? "step-lip" : hiddenBy(sp, outward) ? "step-hidden"
                                        : o != k && reaches(sp.x - outward.x * ProbeOutM, sp.z - outward.y * ProbeOutM, sp.y, o) ? "step-lip" : "step";
                                    hits.Add(new Hit { type = type, p = sp, a = k, b = o, metric = Mathf.Abs(dz) });
                                }
                                continue;
                            }
                            if (isOutside(new Vector3(qx, 0f, qz)) || isGap(new Vector3(sp.x + outward.x * 0.3f, 0f, sp.z + outward.y * 0.3f))) continue;
                            if (hiddenBy(sp, outward)) { hits.Add(new Hit { type = "crack-hidden", p = sp, a = k, b = -1, metric = 0f }); continue; }
                            // no ground just outside: how wide is the crack?
                            float width = -1f; int other = -1;
                            foreach (var step in CrackSteps)
                            {
                                var g2 = ground(sp.x + outward.x * step, sp.z + outward.y * step, sp.y, sp.y + 1.5f, 3f);
                                if (g2 != null) { width = step; colliderIndex.TryGetValue(g2.Value.collider.GetInstanceID(), out other); break; }
                            }
                            if (width < 0 && isOutside(new Vector3(sp.x + outward.x * 1.5f, 0f, sp.z + outward.y * 1.5f))) continue;
                            hits.Add(new Hit { type = "crack", p = sp, a = k, b = other, metric = width < 0 ? 9f : width });
                        }
                    }
                    if (k % 20 == 0) yield return null;
                }
                lap("seams");
            }

            // ---------------------------------------------------------------- cluster, rank, write
            foreach (var group in hits.GroupBy(h => h.type))
                findings.AddRange(Cluster(group.ToList(), meshes));
            Func<string, int> rank = s => s == "error" ? 0 : s == "warn" ? 1 : 2;
            findings = findings.OrderBy(f => rank(f.severity)).ThenByDescending(f => f.metric).ThenBy(f => f.type, StringComparer.Ordinal).ToList();
            Func<Vector3, List<object>> epsgOf = p => epsg ? new List<object> { Math.Round(p.x - origin.x + e0, 2), Math.Round(p.z - origin.z + n0, 2) } : null;
            Func<Finding, Dictionary<string, object>> describe = f =>
            {
                var c = f.Centre;
                var d = new Dictionary<string, object>
                {
                    { "type", f.type }, { "severity", f.severity }, { "hole", f.hole }, { "note", f.note },
                    { "objects", f.objects.OrderBy(x => x, StringComparer.Ordinal).Take(6).Cast<object>().ToList() }, { "points", f.count },
                    { "unity", new List<object> { Math.Round(c.x, 2), Math.Round(c.y, 2), Math.Round(c.z, 2) } },
                };
                var e = epsgOf(c);
                if (e != null) d["epsg3006"] = e;
                return d;
            };
            var counts = findings.GroupBy(f => f.type).OrderBy(g => g.Key, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => (object)new Dictionary<string, object> { { "findings", g.Count() }, { "severity", g.First().severity }, { "points", g.Sum(f => f.count) } });
            int errors = findings.Count(f => f.severity == "error"), warnings = findings.Count(f => f.severity == "warn");
            var result = new Dictionary<string, object>
            {
                { "format", Format }, { "scene", scene.name }, { "generated", DateTime.UtcNow.ToString("o") },
                { "ok", errors == 0 }, { "errors", errors }, { "warnings", warnings },
                { "hole", onlyHole }, { "without", gone.Count > 0 ? gone.Cast<object>().ToList() : null }, { "area", boundaryNote }, { "areaM2", Math.Round(mask != null ? mask.AreaM2 : area.size.x * area.size.z) }, { "cellM", cell }, { "meshes", meshes.Count }, { "inactiveMeshes", inactive },
                { "openEdges", openEdges }, { "nonManifoldEdges", nonManifold }, { "seamProbes", probes }, { "rays", rays },
                { "counts", counts }, { "seconds", times },
            };
            if (write && reportPath != null)
            {
                var file = new Dictionary<string, object>(result);
                file["findings"] = findings.Select(f => (object)describe(f)).ToList();
                // GolfMap > Review reads these (format golfmap-shaping-report-v1's changedPlaces)
                file["changedPlaces"] = findings.Where(f => f.severity != "info").Select(f =>
                {
                    var c = f.Centre;
                    var place = new Dictionary<string, object>
                    {
                        { "type", f.severity + " " + f.type }, { "hole", f.hole }, { "note", f.note },
                        { "objects", f.objects.OrderBy(x => x, StringComparer.Ordinal).Cast<object>().ToList() },
                        { "centre", new Dictionary<string, object> { { "unity", new List<object> { c.x, c.y, c.z } }, { "epsg3006", epsgOf(c) } } },
                        { "bounds", new Dictionary<string, object> { { "unity", new List<object> { f.min.x - 1f, (float.IsInfinity(f.min.y) ? c.y : f.min.y) - 1f, f.min.z - 1f, f.max.x + 1f, (float.IsInfinity(f.max.y) ? c.y : f.max.y) + 1f, f.max.z + 1f } } } },
                    };
                    return (object)place;
                }).ToList();
                File.WriteAllText(reportPath, GolfMapJson.Serialize(file));
                result["report"] = reportPath;
            }
            result["findings"] = findings.Take(limit).Select(f => (object)describe(f)).ToList();
            lap("total");
            yield return result;
        }

        // Points of one type joined when within ClusterM of each other (and, for seams, on the same pair of objects).
        static List<Finding> Cluster(List<Hit> hits, List<Mesh3> meshes)
        {
            var parent = Enumerable.Range(0, hits.Count).ToArray();
            bool flat = hits.Count > 0 && (hits[0].type == "gap" || hits[0].type == "overlap");   // grid cells: joined in plan only
            Func<int, int> find = null;
            find = i => { while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
            var grid = new Dictionary<Vector2Int, List<int>>();
            Func<Vector3, Vector2Int> cellOf = p => new Vector2Int(Mathf.FloorToInt(p.x / ClusterM), Mathf.FloorToInt(p.z / ClusterM));
            for (int i = 0; i < hits.Count; i++)
            {
                var c = cellOf(hits[i].p);
                for (int dx = -1; dx <= 1; dx++)
                    for (int dz = -1; dz <= 1; dz++)
                    {
                        List<int> list;
                        if (!grid.TryGetValue(new Vector2Int(c.x + dx, c.y + dz), out list)) continue;
                        foreach (int j in list)
                        {
                            if (!flat && (hits[j].p - hits[i].p).sqrMagnitude > ClusterM * ClusterM * 4f) continue;
                            if (new Vector2(hits[j].p.x - hits[i].p.x, hits[j].p.z - hits[i].p.z).sqrMagnitude > ClusterM * ClusterM) continue;
                            parent[find(i)] = find(j);
                        }
                    }
                List<int> own;
                if (!grid.TryGetValue(c, out own)) grid[c] = own = new List<int>();
                own.Add(i);
            }
            var result = new List<Finding>();
            foreach (var g in Enumerable.Range(0, hits.Count).GroupBy(find))
            {
                var list = g.Select(i => hits[i]).ToList();
                string type = list[0].type;
                var f = new Finding { type = type };
                foreach (var h in list)
                {
                    f.Add(h.p);
                    if (h.a >= 0) f.objects.Add(meshes[h.a].name);
                    if (h.b >= 0) f.objects.Add(meshes[h.b].name);
                }
                f.hole = list.Where(h => h.a >= 0).Select(h => meshes[h.a].hole).FirstOrDefault(x => x != null);
                float max = list.Max(h => h.metric), sum = list.Sum(h => h.metric);
                switch (type)
                {
                    case "flipped":
                        // slivers (a cut's leftovers) under SliverM2 show at most as a speck; the ball cannot pass through them
                        f.metric = sum; f.severity = sum >= SliverM2 ? "error" : "warn";
                        f.note = list.Count + " upside-down faces (" + sum.ToString("0.000", Inv) + " m2) on top: rays and the ball see through them";
                        break;
                    case "gap":
                        f.metric = sum; f.severity = "error";
                        f.note = "no course mesh over " + sum.ToString("0.0", Inv) + " m2 (" + (f.max.x - f.min.x).ToString("0.0", Inv) + " x " + (f.max.z - f.min.z).ToString("0.0", Inv) + " m)" + Under(f.Centre, meshes);
                        break;
                    case "overlap":
                        // a lone ray is mostly a blend's edge lying a few cm over its neighbour: only an area counts
                        f.metric = sum; f.severity = list.Count >= 4 ? "warn" : "info";
                        f.note = "two meshes within " + (OverlapM * 100).ToString("0", Inv) + " cm over " + sum.ToString("0.0", Inv) + " m2: they z-fight, the surface the ball reads is chance";
                        break;
                    case "step":
                        f.metric = max; f.severity = max >= StepErrorM ? "error" : "warn";
                        f.note = "step up to " + (max * 100).ToString("0", Inv) + " cm at the seam, " + list.Count + " probes";
                        break;
                    case "crack":
                        f.metric = max; f.severity = max > BallM ? "error" : "warn";
                        f.note = (max > 1.5f ? "open edge with no ground beyond 1 m" : "crack up to " + (max * 100).ToString("0", Inv) + " cm wide") + ", " + list.Count + " probes"
                            + (max > BallM ? ": the ball can drop into it" : ": it shows, the ball rolls over it");
                        break;
                    case "step-lip":
                        f.metric = max; f.severity = "info";
                        f.note = "lip up to " + (max * 100).ToString("0", Inv) + " cm (a bunker's sand under its ring, or a mesh running on under the other), " + list.Count + " probes";
                        break;
                    case "step-hidden":
                    case "crack-hidden":
                        f.metric = max; f.severity = "info";
                        f.note = (type == "crack-hidden" ? "open edge" : "step up to " + (max * 100).ToString("0", Inv) + " cm") + " under a wall or prop, " + list.Count + " probes";
                        break;
                    default:
                        f.metric = max; f.severity = "warn"; f.note = list.Count + " points";
                        break;
                }
                result.Add(f);
            }
            return result;
        }

        static bool IsBunkerPair(string a, string b)
        {
            Func<string, bool> sand = n => n.EndsWith("_Bunker_-_Mesh", StringComparison.Ordinal);
            Func<string, bool> ring = n => n.EndsWith("_Bunker_-_Blend", StringComparison.Ordinal);
            return (sand(a) && ring(b)) || (ring(a) && sand(b));
        }

        sealed class Mix : IEqualityComparer<long>
        {
            public static readonly Mix Instance = new Mix();
            public bool Equals(long a, long b) { return a == b; }
            public int GetHashCode(long x) { ulong h = (ulong)x * 0x9E3779B97F4A7C15UL; return (int)(h >> 32) ^ (int)h; }
        }

        // what a ball would meet under a gap: the first collider straight down that is not a course mesh
        static string Under(Vector3 p, List<Mesh3> meshes)
        {
            var hits = Physics.RaycastAll(new Vector3(p.x, 10000f, p.z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore);
            var first = hits.Where(h => !GolfMapSurfaces.IsCourseMesh(h.collider.name)).OrderByDescending(h => h.point.y).FirstOrDefault();
            if (first.collider == null) return "; nothing under it (the ball falls out of the world)";
            return "; under it: " + first.collider.name + (first.collider is TerrainCollider ? " (the terrain)" : "");
        }
    }
}
