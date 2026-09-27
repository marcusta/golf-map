// Unity 2018.2 / C# 6. The ground under dry-stone walls (GolfMapWalls): the course meshes on a wall's bank
// reshaped into what the lidar and the ~1.2 m OPCD mesh grid smooth away, the way ce.simgolf does rockwork in
// Blender (subdivide the area, pull it steep, paint the stone in) but in Unity, on the meshes as they are.
//
// For each wall with `ground` (stone-walls.json), on every course mesh its bank crosses:
// - subdivide: triangles within reach of the bank are split in four until their edges are under subdivideM;
// - terrace: raised, never lowered, to the profile across the bank: the ground at the foot up to baseInM in,
//   then a face at faceDeg up to the plateau's height (measured just beyond the lip), then flat out to beyondM
//   past the lip; tapered over taperM at the wall's ends;
// - paint: on rough meshes the face (feathered paintFeatherM) takes groundChannel, the channel the walls'
//   rough material draws as stone (and no Stix 3D grass: blade chance = red);
// - normals recomputed where the shape changed.
// The profile's heights are measured on the original FBX meshes, so a re-run gives the same ground.
//
// It runs inside GolfMapVertexPaint.Apply (golfmap.paint.apply, and after every golfmap.meshes.sync): the
// reshaped mesh is the copy the paint rules paint on, under <course>/PaintedMeshes/, and the MeshCollider takes
// it too so the ball meets the new ground. golfmap.walls.build runs the paint first when a wall has ground.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace GolfMap.Editor
{
    internal sealed class GolfMapWallGround
    {
        const float StationStepM = 0.25f;
        const float ReachM = 1.3f;  // subdivide this far past the band the terrace changes (one original triangle)

        sealed class Station
        {
            public Vector2 toe, inward;
            public float along, depth, hToe, hTop;
        }

        sealed class Bank
        {
            public string id;
            public GolfMapWalls.Settings s;
            public Station[] st;
            public float length, tanFace;
            public Rect rect;  // x/z with the reach
            public Color channel;
        }

        // Where a point is across a bank: s along its foot, t in from the foot, and the station's heights there.
        struct Across
        {
            public float s, t, depth, hToe, hTop;
        }

        readonly List<Bank> banks = new List<Bank>();
        public readonly List<object> report = new List<object>();
        string folder;  // the course folder

        // The course's walls with ground, their profiles measured on each course mesh's original mesh; null when none.
        public static GolfMapWallGround Load(GolfMapCourse course, IList<MeshFilter> filters, Func<MeshFilter, Mesh> original)
        {
            var walls = GolfMapWalls.LoadWalls(course);
            if (walls == null) return null;
            walls = walls.Where(w => w.s.ground).ToList();
            if (walls.Count == 0) return null;
            var g = new GolfMapWallGround { folder = GolfMapCourses.Folder(course) };
            var rects = walls.Select(w => Bounds(w.toe.Concat(w.lip), ReachM + 3f)).ToList();
            var surface = new Surface();
            foreach (var f in filters)
            {
                var r = f.GetComponent<Renderer>();
                if (r == null || !rects.Any(rc => Overlaps(rc, r.bounds))) continue;
                var mesh = original(f);
                if (mesh != null) surface.Add(f.transform, mesh, rects);
            }
            for (int i = 0; i < walls.Count; i++) g.banks.Add(Profile(walls[i], surface, rects[i]));
            return g;
        }

        static Rect Bounds(IEnumerable<Vector2> pts, float margin)
        {
            float x0 = float.MaxValue, z0 = float.MaxValue, x1 = float.MinValue, z1 = float.MinValue;
            foreach (var p in pts) { x0 = Mathf.Min(x0, p.x); z0 = Mathf.Min(z0, p.y); x1 = Mathf.Max(x1, p.x); z1 = Mathf.Max(z1, p.y); }
            return Rect.MinMaxRect(x0 - margin, z0 - margin, x1 + margin, z1 + margin);
        }

        static bool Overlaps(Rect r, Bounds b)
        {
            return b.max.x >= r.xMin && b.min.x <= r.xMax && b.max.z >= r.yMin && b.min.z <= r.yMax;
        }

        // Stations every StationStepM along the foot, with the ground at the foot and the plateau's height (the highest
        // of the lip and beyondM past it) from the original meshes, smoothed along the wall (median, then mean).
        static Bank Profile(GolfMapWalls.Wall w, Surface surface, Rect rect)
        {
            var s = w.s;
            float length = w.along[w.along.Length - 1];
            int n = Mathf.Max(2, Mathf.CeilToInt(length / StationStepM) + 1);
            var st = new Station[n];
            int seg = 0;
            for (int i = 0; i < n; i++)
            {
                float a = length * i / (n - 1);
                while (seg < w.along.Length - 2 && w.along[seg + 1] < a) seg++;
                float span = w.along[seg + 1] - w.along[seg];
                float f = span > 1e-4f ? Mathf.Clamp01((a - w.along[seg]) / span) : 0f;
                var toe = Vector2.Lerp(w.toe[seg], w.toe[seg + 1], f);
                var lip = Vector2.Lerp(w.lip[seg], w.lip[seg + 1], f);
                var into = lip - toe;
                float depth = into.magnitude;
                var inward = depth > 1e-3f ? into / depth : Vector2.zero;
                st[i] = new Station { toe = toe, inward = inward, along = a, depth = depth, hToe = surface.At(toe), hTop = Mathf.Max(surface.At(lip), surface.At(lip + inward * s.beyondM)) };
            }
            Smooth(st, x => x.hToe, (x, v) => x.hToe = v);
            Smooth(st, x => x.hTop, (x, v) => x.hTop = v);
            return new Bank
            {
                id = w.id, s = s, st = st, length = length, tanFace = Mathf.Tan(Mathf.Clamp(s.faceDeg, 20f, 85f) * Mathf.Deg2Rad),
                rect = rect, channel = PaintChannel(s.groundChannel, w.id),
            };
        }

        static void Smooth(Station[] st, Func<Station, float> get, Action<Station, float> set)
        {
            var v = st.Select(get).ToArray();
            var med = new float[v.Length];
            for (int i = 0; i < v.Length; i++)
            {
                var win = new List<float>();
                for (int k = Math.Max(0, i - 4); k <= Math.Min(v.Length - 1, i + 4); k++) if (!float.IsNaN(v[k])) win.Add(v[k]);
                win.Sort();
                med[i] = win.Count > 0 ? win[win.Count / 2] : float.NaN;
            }
            for (int i = 0; i < v.Length; i++)
            {
                float sum = 0; int c = 0;
                for (int k = Math.Max(0, i - 2); k <= Math.Min(v.Length - 1, i + 2); k++) if (!float.IsNaN(med[k])) { sum += med[k]; c++; }
                set(st[i], c > 0 ? sum / c : float.NaN);
            }
        }

        static Color PaintChannel(string channel, string wall)
        {
            switch ((channel ?? "").ToLowerInvariant())
            {
                case "red": return new Color(1, 0, 0);
                case "green": return new Color(0, 1, 0);
                case "blue": return new Color(0, 0, 1);
                case "black": return new Color(0, 0, 0);
            }
            throw new InvalidOperationException("Wall " + wall + ": groundChannel must be red, green, blue or black.");
        }

        public bool Touches(MeshFilter f)
        {
            var r = f.GetComponent<Renderer>();
            return r != null && banks.Any(b => Overlaps(b.rect, r.bounds));
        }

        // ---- the stone the face is painted with ----------------------------------------------------

        // A copy of a rough mesh's OPCD MAHS material (<course>/Walls/<name> (stone).mat) whose groundChannel draws the
        // spec's stoneMaterial channel (every _<Channel>* property and _<CHANNEL>*_ON toggle of it), rebuilt from the
        // original on every run so the spec wins; null when the spec names none. A material that already is such a
        // copy comes back as it is. OPCD's theme window (SetMeshMaterialv4) puts the original back: run the paint again.
        public Material StoneMaterial(Material rough)
        {
            var s = banks[0].s;
            if (rough == null || string.IsNullOrEmpty(s.stoneMaterial)) return null;
            var dir = folder + "Walls";
            if (AssetDatabase.GetAssetPath(rough).StartsWith(dir + "/", StringComparison.OrdinalIgnoreCase)) return rough;
            var src = AssetDatabase.LoadAssetAtPath<Material>(s.stoneMaterial);
            if (src == null) throw new InvalidOperationException("stoneMaterial " + s.stoneMaterial + " is not a material.");
            if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder(folder.TrimEnd('/'), "Walls");
            var path = dir + "/" + rough.name + " (stone).mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null) { m = new Material(rough) { name = rough.name + " (stone)" }; AssetDatabase.CreateAsset(m, path); }
            else { m.shader = rough.shader; m.CopyPropertiesFromMaterial(rough); }
            string to = Cap(s.groundChannel), from = Cap(s.stoneMaterialChannel);
            var shader = m.shader;
            for (int i = 0; i < ShaderUtil.GetPropertyCount(shader); i++)
            {
                var name = ShaderUtil.GetPropertyName(shader, i);
                if (!name.StartsWith("_" + to, StringComparison.Ordinal)) continue;
                var other = "_" + from + name.Substring(1 + to.Length);
                if (!src.HasProperty(other)) continue;
                switch (ShaderUtil.GetPropertyType(shader, i))
                {
                    case ShaderUtil.ShaderPropertyType.Color: m.SetColor(name, src.GetColor(other)); break;
                    case ShaderUtil.ShaderPropertyType.Vector: m.SetVector(name, src.GetVector(other)); break;
                    case ShaderUtil.ShaderPropertyType.Float:
                    case ShaderUtil.ShaderPropertyType.Range: m.SetFloat(name, src.GetFloat(other)); break;
                    case ShaderUtil.ShaderPropertyType.TexEnv:
                        m.SetTexture(name, src.GetTexture(other));
                        m.SetTextureScale(name, src.GetTextureScale(other));
                        m.SetTextureOffset(name, src.GetTextureOffset(other));
                        break;
                }
            }
            string TO = "_" + to.ToUpperInvariant(), FROM = "_" + from.ToUpperInvariant();
            var kw = new HashSet<string>(rough.shaderKeywords.Where(k => !k.StartsWith(TO, StringComparison.Ordinal)));
            foreach (var k in src.shaderKeywords) if (k.StartsWith(FROM, StringComparison.Ordinal)) kw.Add(TO + k.Substring(FROM.Length));
            m.shaderKeywords = kw.ToArray();
            EditorUtility.SetDirty(m);
            return m;
        }

        static string Cap(string channel)
        {
            var c = (channel ?? "").ToLowerInvariant();
            if (c != "red" && c != "green" && c != "blue" && c != "black") throw new InvalidOperationException("channel must be red, green, blue or black, not " + channel + ".");
            return char.ToUpperInvariant(c[0]) + c.Substring(1);
        }

        // ---- where a point is ------------------------------------------------------------------

        // The nearest point of the foot line; false beyond its ends.
        static bool Locate(Bank b, Vector2 p, out Across a)
        {
            a = new Across();
            if (!b.rect.Contains(p)) return false;
            var st = b.st;
            int best = 0; float bestD = float.MaxValue;
            for (int i = 0; i < st.Length; i++)
            {
                float d = (st[i].toe - p).sqrMagnitude;
                if (d < bestD) { bestD = d; best = i; }
            }
            // refine on the segment either side
            float bestS = st[best].along; Vector2 bestToe = st[best].toe; float bestSeg = float.MaxValue; int i0 = best, i1 = best; float bestF = 0;
            for (int k = Math.Max(0, best - 1); k < Math.Min(st.Length - 1, best + 1); k++)
            {
                var ab = st[k + 1].toe - st[k].toe;
                float len2 = ab.sqrMagnitude;
                float f = len2 > 1e-8f ? Vector2.Dot(p - st[k].toe, ab) / len2 : 0f;
                bool beyond = (k == 0 && f < 0f) || (k == st.Length - 2 && f > 1f);
                float fc = Mathf.Clamp01(f);
                var q = st[k].toe + ab * fc;
                float d = (q - p).sqrMagnitude;
                if (d < bestSeg) { bestSeg = d; bestToe = q; i0 = k; i1 = k + 1; bestF = fc; bestS = Mathf.Lerp(st[k].along, st[k + 1].along, fc); if (beyond) bestS = f < 0 ? -1f : b.length + 1f; }
            }
            if (bestS < 0f || bestS > b.length) return false;
            var inward = Vector2.Lerp(st[i0].inward, st[i1].inward, bestF);
            if (inward.sqrMagnitude < 1e-6f) return false;
            inward.Normalize();
            a.s = bestS;
            a.t = Vector2.Dot(p - bestToe, inward);
            a.depth = Mathf.Lerp(st[i0].depth, st[i1].depth, bestF);
            a.hToe = Mathf.Lerp(st[i0].hToe, st[i1].hToe, bestF);
            a.hTop = Mathf.Lerp(st[i0].hTop, st[i1].hTop, bestF);
            return !float.IsNaN(a.hToe) && !float.IsNaN(a.hTop);
        }

        static bool Near(Bank b, Across a)
        {
            return a.t >= b.s.baseInM - ReachM && a.t <= a.depth + b.s.beyondM + ReachM;
        }

        // The terrace's height at a point, or NaN where the terrace does not reach.
        static float Target(Bank b, Across a, out float faceTop)
        {
            var s = b.s;
            float h = a.hTop - a.hToe;
            faceTop = s.baseInM + Mathf.Max(0f, h) / b.tanFace;
            if (h < s.minFaceM || a.t < s.baseInM || a.t > a.depth + s.beyondM) return float.NaN;
            return a.t <= faceTop ? a.hToe + (a.t - s.baseInM) * b.tanFace : a.hTop;
        }

        float Taper(Bank b, Across a)
        {
            float t = b.s.taperM;
            return t <= 0 ? 1f : Mathf.Clamp01(Mathf.Min(a.s, b.length - a.s) / t);
        }

        // ---- shape a mesh -----------------------------------------------------------------------

        sealed class Work
        {
            public List<Vector3> pos = new List<Vector3>(), nrm = new List<Vector3>();
            public List<Vector4> tan = new List<Vector4>();
            public List<Color> col = new List<Color>();
            public List<Vector4>[] uv = new List<Vector4>[4];
            public List<bool> near = new List<bool>();
            public bool hasNrm, hasTan;
            public Dictionary<long, int> mid = new Dictionary<long, int>();

            public int Mid(int a, int b, Func<Vector3, bool> nearAt)
            {
                long key = a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
                int m;
                if (mid.TryGetValue(key, out m)) return m;
                m = pos.Count;
                pos.Add((pos[a] + pos[b]) * 0.5f);
                if (hasNrm) nrm.Add((nrm[a] + nrm[b]).normalized);
                if (hasTan) { var t = (tan[a] + tan[b]) * 0.5f; var v = new Vector3(t.x, t.y, t.z).normalized; tan.Add(new Vector4(v.x, v.y, v.z, tan[a].w)); }
                col.Add(Color.Lerp(col[a], col[b], 0.5f));
                for (int c = 0; c < 4; c++) if (uv[c] != null) uv[c].Add((uv[c][a] + uv[c][b]) * 0.5f);
                near.Add(nearAt(pos[m]));
                mid[key] = m;
                return m;
            }
        }

        // The mesh reshaped (a new Mesh, not saved), or null when no bank reaches it.
        public Mesh Shape(MeshFilter f, Mesh source, GolfMapSurfaces.Surface surface)
        {
            var tr = f.transform;
            var w = new Work();
            source.GetVertices(w.pos);
            int n0 = w.pos.Count;
            source.GetNormals(w.nrm); w.hasNrm = w.nrm.Count == n0;
            source.GetTangents(w.tan); w.hasTan = w.tan.Count == n0;
            source.GetColors(w.col);
            if (w.col.Count != n0) w.col = Enumerable.Repeat(new Color(1, 0, 0, 1), n0).ToList();
            for (int c = 0; c < 4; c++) { var l = new List<Vector4>(); source.GetUVs(c, l); if (l.Count == n0) w.uv[c] = l; }

            Func<Vector3, bool> nearAt = local =>
            {
                var p = tr.TransformPoint(local);
                var q = new Vector2(p.x, p.z);
                foreach (var b in banks) { Across a; if (Locate(b, q, out a) && Near(b, a)) return true; }
                return false;
            };
            bool any = false;
            for (int i = 0; i < n0; i++) { bool nr = nearAt(w.pos[i]); w.near.Add(nr); any |= nr; }
            if (!any) return null;

            // subdivide the triangles within reach until their edges are under subdivideM (in x/z)
            float maxEdge = banks.Min(b => b.s.subdivideM);
            var subs = new List<List<int>>();
            int split = 0;
            for (int sm = 0; sm < source.subMeshCount; sm++)
            {
                var tris = new List<int>(source.GetTriangles(sm));
                for (int level = 0; level < 6; level++)
                {
                    var next = new List<int>(tris.Count);
                    bool changed = false;
                    for (int k = 0; k < tris.Count; k += 3)
                    {
                        int a = tris[k], b = tris[k + 1], c = tris[k + 2];
                        if (!(w.near[a] || w.near[b] || w.near[c]) || LongestXZ(tr, w.pos[a], w.pos[b], w.pos[c]) <= maxEdge) { next.Add(a); next.Add(b); next.Add(c); continue; }
                        int ab = w.Mid(a, b, nearAt), bc = w.Mid(b, c, nearAt), ca = w.Mid(c, a, nearAt);
                        next.AddRange(new[] { a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca });
                        split++;
                        changed = true;
                    }
                    tris = next;
                    if (!changed) break;
                }
                subs.Add(tris);
            }

            // terrace and paint
            var changedPos = new HashSet<int>();
            int raised = 0, painted = 0; float maxRaise = 0;
            bool paint = surface == GolfMapSurfaces.Surface.Rough;
            for (int i = 0; i < w.pos.Count; i++)
            {
                if (!w.near[i]) continue;
                var p = tr.TransformPoint(w.pos[i]);
                var q = new Vector2(p.x, p.z);
                float lift = 0, stone = 0; Color channel = Color.red;
                foreach (var b in banks)
                {
                    Across a;
                    if (!Locate(b, q, out a)) continue;
                    float faceTop;
                    float target = Target(b, a, out faceTop);
                    float taper = Taper(b, a);
                    if (!float.IsNaN(target)) lift = Mathf.Max(lift, (target - p.y) * taper);
                    if (paint && a.hTop - a.hToe >= b.s.minFaceM)
                    {
                        float fe = Mathf.Max(0.01f, b.s.paintFeatherM);
                        float wgt = Mathf.Min(Mathf.Clamp01((a.t - (b.s.baseInM - fe)) / fe), Mathf.Clamp01((faceTop + fe - a.t) / fe)) * taper;
                        if (wgt > stone) { stone = wgt; channel = b.channel; }
                    }
                }
                if (lift > 0.005f)
                {
                    p.y += lift;
                    w.pos[i] = tr.InverseTransformPoint(p);
                    changedPos.Add(i);
                    raised++;
                    maxRaise = Mathf.Max(maxRaise, lift);
                }
                if (stone > 0.01f)
                {
                    var c = w.col[i];
                    var t = channel; t.a = c.a;
                    w.col[i] = Color.Lerp(c, t, stone);
                    painted++;
                }
            }
            if (raised == 0 && painted == 0) return null;  // within reach but outside the terrace: keep the FBX mesh
            if (w.hasNrm) RecomputeNormals(w, subs, n0);

            var mesh = new Mesh { name = source.name + " (walls)" };
            if (w.pos.Count > 65000) mesh.indexFormat = IndexFormat.UInt32;
            mesh.SetVertices(w.pos);
            if (w.hasNrm) mesh.SetNormals(w.nrm);
            if (w.hasTan) mesh.SetTangents(w.tan);
            mesh.SetColors(w.col);
            for (int c = 0; c < 4; c++) if (w.uv[c] != null) mesh.SetUVs(c, w.uv[c]);
            mesh.subMeshCount = subs.Count;
            for (int sm = 0; sm < subs.Count; sm++) mesh.SetTriangles(subs[sm], sm);
            mesh.RecalculateBounds();
            report.Add(new Dictionary<string, object> {
                { "object", f.name }, { "trianglesSplit", split }, { "vertices", new[] { n0, w.pos.Count } }, { "raised", raised },
                { "maxRaiseM", Math.Round(maxRaise, 2) }, { "painted", painted } });
            return mesh;
        }

        static float LongestXZ(Transform tr, Vector3 a, Vector3 b, Vector3 c)
        {
            var pa = tr.TransformPoint(a); var pb = tr.TransformPoint(b); var pc = tr.TransformPoint(c);
            Func<Vector3, Vector3, float> d = (u, v) => new Vector2(u.x - v.x, u.z - v.z).magnitude;
            return Mathf.Max(d(pa, pb), Mathf.Max(d(pb, pc), d(pc, pa)));
        }

        // Area-weighted normals, welded by position, for every vertex of a triangle within reach (the rest keep the FBX's).
        static void RecomputeNormals(Work w, List<List<int>> subs, int n0)
        {
            Func<Vector3, long> key = v => ((long)Mathf.RoundToInt(v.x * 1000) * 73856093L) ^ ((long)Mathf.RoundToInt(v.y * 1000) * 19349663L) ^ ((long)Mathf.RoundToInt(v.z * 1000) * 83492791L);
            var sum = new Dictionary<long, Vector3>();
            var mine = new HashSet<int>();
            foreach (var tris in subs)
                for (int k = 0; k < tris.Count; k += 3)
                {
                    int a = tris[k], b = tris[k + 1], c = tris[k + 2];
                    if (!(w.near[a] || w.near[b] || w.near[c])) continue;
                    var n = Vector3.Cross(w.pos[b] - w.pos[a], w.pos[c] - w.pos[a]);  // length = 2 x area
                    foreach (var v in new[] { a, b, c })
                    {
                        long kv = key(w.pos[v]);
                        Vector3 s; sum.TryGetValue(kv, out s); sum[kv] = s + n;
                        mine.Add(v);
                    }
                }
            foreach (var v in mine)
            {
                var s = sum[key(w.pos[v])];
                if (s.sqrMagnitude < 1e-12f) continue;
                var n = s.normalized;
                if (Vector3.Dot(n, w.nrm[v]) < 0) n = -n;  // keep the FBX's winding side
                w.nrm[v] = n;
            }
        }

        // ---- the original surface ----------------------------------------------------------------

        // The highest original-mesh triangle straight under a point (world x/z), on a 1 m grid.
        sealed class Surface
        {
            readonly List<Vector3> tri = new List<Vector3>();
            readonly Dictionary<long, List<int>> grid = new Dictionary<long, List<int>>();

            static long Cell(int x, int z) { return ((long)x << 32) | (uint)z; }

            public void Add(Transform tr, Mesh mesh, List<Rect> rects)
            {
                var verts = mesh.vertices;
                var world = new Vector3[verts.Length];
                for (int i = 0; i < verts.Length; i++) world[i] = tr.TransformPoint(verts[i]);
                for (int sm = 0; sm < mesh.subMeshCount; sm++)
                {
                    var t = mesh.GetTriangles(sm);
                    for (int k = 0; k < t.Length; k += 3)
                    {
                        var a = world[t[k]]; var b = world[t[k + 1]]; var c = world[t[k + 2]];
                        float x0 = Mathf.Min(a.x, Mathf.Min(b.x, c.x)), x1 = Mathf.Max(a.x, Mathf.Max(b.x, c.x));
                        float z0 = Mathf.Min(a.z, Mathf.Min(b.z, c.z)), z1 = Mathf.Max(a.z, Mathf.Max(b.z, c.z));
                        if (!rects.Any(r => x1 >= r.xMin && x0 <= r.xMax && z1 >= r.yMin && z0 <= r.yMax)) continue;
                        int id = tri.Count / 3;
                        tri.Add(a); tri.Add(b); tri.Add(c);
                        for (int gx = Mathf.FloorToInt(x0); gx <= Mathf.FloorToInt(x1); gx++)
                            for (int gz = Mathf.FloorToInt(z0); gz <= Mathf.FloorToInt(z1); gz++)
                            {
                                List<int> l;
                                if (!grid.TryGetValue(Cell(gx, gz), out l)) grid[Cell(gx, gz)] = l = new List<int>();
                                l.Add(id);
                            }
                    }
                }
            }

            public float At(Vector2 p)
            {
                List<int> l;
                if (!grid.TryGetValue(Cell(Mathf.FloorToInt(p.x), Mathf.FloorToInt(p.y)), out l)) return float.NaN;
                float best = float.NaN;
                foreach (var id in l)
                {
                    var a = tri[id * 3]; var b = tri[id * 3 + 1]; var c = tri[id * 3 + 2];
                    float d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
                    if (Mathf.Abs(d) < 1e-9f) continue;
                    float u = ((b.z - c.z) * (p.x - c.x) + (c.x - b.x) * (p.y - c.z)) / d;
                    float v = ((c.z - a.z) * (p.x - c.x) + (a.x - c.x) * (p.y - c.z)) / d;
                    if (u < -1e-4f || v < -1e-4f || u + v > 1 + 1e-4f) continue;
                    float y = u * a.y + v * b.y + (1 - u - v) * c.y;
                    if (float.IsNaN(best) || y > best) best = y;
                }
                return best;
            }
        }
    }
}
