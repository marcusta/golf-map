// Bunker vertex-paint conventions and the two operations built on them: copying
// one paint channel of an OPCD material into another, and reading which
// convention a bunker or blend mesh is painted with.
//
// The convention file is blender/conventions/bunker-channels.json, shared with the
// Blender bunker tools, copied into the course folder. The Bunker Materials window
// (GolfMapBunkerMaterials.cs) is the UI.
//
// OPCD model this follows (SetMeshRuntimeDLL): every course mesh has a
// MeshChannelMaterialsStore pointing at a ChannelMaterials asset, which names the
// render material and, per paint channel, a source material and the source channel
// whose settings fill it. The "OPCD 4 color Vert Paint MAHS" shader keeps each
// channel's settings in properties prefixed _Red/_Green/_Blue/_Black, so filling a
// channel is copying every property (and shader keyword) with the source prefix to
// the target prefix. Verified on the Vreta base project: an OPCD bunker blend's Red
// block equals the bunker material's Red block and its Black block the rough's Red.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public enum BunkerPaintChannel { Red, Green, Blue, Black }

    public sealed class BunkerChannelSource
    {
        public string from = "$bunker";     // $bunker, $blend, $outer or a material asset name
        public BunkerPaintChannel channel;
        public Color tint = Color.white;    // multiplies the channel's Overall Color (json: a number, or [r, g, b])
        public bool Tinted { get { return !(Mathf.Approximately(tint.r, 1f) && Mathf.Approximately(tint.g, 1f) && Mathf.Approximately(tint.b, 1f)); } }
        // Material-name suffix: "0.8" for a grey tint, "1.1-1.06-1" for a coloured one.
        public string TintLabel
        {
            get
            {
                var ci = System.Globalization.CultureInfo.InvariantCulture;
                if (Mathf.Approximately(tint.r, tint.g) && Mathf.Approximately(tint.g, tint.b)) return tint.r.ToString("0.###", ci);
                return tint.r.ToString("0.###", ci) + "-" + tint.g.ToString("0.###", ci) + "-" + tint.b.ToString("0.###", ci);
            }
        }
        public float blendStrength = -1f;   // < 0: keep the source's
    }

    public sealed class BunkerMeshRule
    {
        // Bunkers: colour per ring counted in from the seam (ring 0 is shared with the
        // blend), then the colours expected further in.
        public BunkerPaintChannel[] rings = new BunkerPaintChannel[0];
        public BunkerPaintChannel[] interior = new BunkerPaintChannel[0];
        // Blends: edge shared with the bunker, edge shared with the surround.
        public BunkerPaintChannel inner;
        public BunkerPaintChannel outer;
        public readonly Dictionary<BunkerPaintChannel, BunkerChannelSource> channels = new Dictionary<BunkerPaintChannel, BunkerChannelSource>();
        // The material the render material starts as, before its channels are filled: its settings outside the four
        // channel blocks (slope shading, satellite offsets, arrays) are what the mesh gets. Default $mesh: the mesh's
        // own original. "$outer" on a blend makes the strip shade exactly like the surface it fades to.
        public string baseFrom = "$mesh";
        public bool verified = true;
    }

    public sealed class BunkerConvention
    {
        public string id;
        public string label;
        public string description;
        public BunkerMeshRule bunker;
        public BunkerMeshRule blend;
    }

    public static class GolfMapBunkerChannels
    {
        public const string Schema = "golfmap.bunker-channels";
        public const string FileName = "bunker-channels.json";
        public static readonly BunkerPaintChannel[] All = { BunkerPaintChannel.Red, BunkerPaintChannel.Green, BunkerPaintChannel.Blue, BunkerPaintChannel.Black };

        // ---------------------------------------------------------------- file

        public static List<BunkerConvention> Load(string path)
        {
            var root = GolfMapJsonDoc.ParseObject(System.IO.File.ReadAllText(path));
            if (root.String("schema") != Schema) throw new FormatException(path + " is not a " + Schema + " file.");
            var conventions = root.Object("conventions");
            if (conventions == null) throw new FormatException(path + " has no conventions.");
            var result = new List<BunkerConvention>();
            foreach (var id in conventions.keys)
            {
                var c = conventions.Object(id);
                var verified = c.Object("verified");
                result.Add(new BunkerConvention
                {
                    id = id,
                    label = c.String("label") ?? id,
                    description = c.String("description") ?? "",
                    bunker = ReadRule(c.Object("bunker"), id + ".bunker", verified == null || verified.Bool("bunker", true)),
                    blend = ReadRule(c.Object("blend"), id + ".blend", verified == null || verified.Bool("blend", true)),
                });
            }
            return result;
        }

        static BunkerMeshRule ReadRule(GolfMapJsonObject o, string where, bool verified)
        {
            if (o == null) throw new FormatException(where + " is missing.");
            var rule = new BunkerMeshRule { verified = verified, baseFrom = o.String("base") ?? "$mesh" };
            var rings = o.Array("rings");
            if (rings != null) rule.rings = rings.Select(v => Channel(v as string, where + ".rings")).ToArray();
            if (o.Has("inner")) rule.inner = Channel(o.String("inner"), where + ".inner");
            if (o.Has("outer")) rule.outer = Channel(o.String("outer"), where + ".outer");
            var interior = o.Array("interior");
            if (interior != null) rule.interior = interior.Select(v => Channel(v as string, where + ".interior")).ToArray();
            var channels = o.Object("channels");
            if (channels == null) throw new FormatException(where + ".channels is missing.");
            foreach (var key in channels.keys)
            {
                var s = channels.Object(key);
                rule.channels[Channel(key, where + ".channels")] = new BunkerChannelSource
                {
                    from = s.String("from") ?? "$bunker",
                    channel = Channel(s.String("channel"), where + ".channels." + key + ".channel"),
                    tint = TintOf(s, where + ".channels." + key + ".tint"),
                    blendStrength = (float)s.Number("blendStrength", -1),
                };
            }
            foreach (var ch in All)
                if (!rule.channels.ContainsKey(ch)) throw new FormatException(where + ".channels has no " + ch.ToString().ToLowerInvariant() + ".");
            return rule;
        }

        static BunkerPaintChannel Channel(string name, string where)
        {
            switch ((name ?? "").ToLowerInvariant())
            {
                case "red": return BunkerPaintChannel.Red;
                case "green": return BunkerPaintChannel.Green;
                case "blue": return BunkerPaintChannel.Blue;
                case "black": return BunkerPaintChannel.Black;
            }
            throw new FormatException(where + ": '" + name + "' is not red, green, blue or black.");
        }

        // ------------------------------------------------------- channel copy

        public static string Prefix(BunkerPaintChannel ch) { return "_" + ch; }

        // Copies every property and shader keyword of `source`'s channel `from` into
        // `target`'s channel `to`. Properties outside the four channel blocks (arrays,
        // satellite, terrain size) are left alone. Returns the number of properties copied.
        public static int CopyChannel(Material source, BunkerPaintChannel from, Material target, BunkerPaintChannel to)
        {
            if (source.shader != target.shader)
                throw new InvalidOperationException("Channel copy needs one shader: " + source.name + " uses " + source.shader.name + ", " + target.name + " uses " + target.shader.name + ".");
            var shader = target.shader;
            string src = Prefix(from), dst = Prefix(to);
            int copied = 0;
            for (int i = 0; i < ShaderUtil.GetPropertyCount(shader); i++)
            {
                var name = ShaderUtil.GetPropertyName(shader, i);
                if (!IsChannelProperty(name, from)) continue;
                var targetName = dst + name.Substring(src.Length);
                if (!target.HasProperty(targetName)) continue;
                switch (ShaderUtil.GetPropertyType(shader, i))
                {
                    case ShaderUtil.ShaderPropertyType.Color: target.SetColor(targetName, source.GetColor(name)); break;
                    case ShaderUtil.ShaderPropertyType.Vector: target.SetVector(targetName, source.GetVector(name)); break;
                    case ShaderUtil.ShaderPropertyType.Float:
                    case ShaderUtil.ShaderPropertyType.Range: target.SetFloat(targetName, source.GetFloat(name)); break;
                    case ShaderUtil.ShaderPropertyType.TexEnv:
                        target.SetTexture(targetName, source.GetTexture(name));
                        target.SetTextureScale(targetName, source.GetTextureScale(name));
                        target.SetTextureOffset(targetName, source.GetTextureOffset(name));
                        break;
                }
                copied++;
            }
            // Toggles compile to keywords (_REDBASEBLEND_ON): drop the target channel's,
            // then carry the source channel's over under the target prefix.
            string srcKey = src.ToUpperInvariant(), dstKey = dst.ToUpperInvariant();
            var keywords = target.shaderKeywords.Where(k => !IsChannelKeyword(k, to)).ToList();
            keywords.AddRange(source.shaderKeywords.Where(k => IsChannelKeyword(k, from)).Select(k => dstKey + k.Substring(srcKey.Length)));
            target.shaderKeywords = keywords.Distinct().ToArray();
            return copied;
        }

        // "_BlueX" belongs to Blue, but "_Black..." must not match a "_Bl" prefix and no
        // channel name is a prefix of another, so a plain prefix test is exact.
        static bool IsChannelProperty(string name, BunkerPaintChannel ch) { return name.StartsWith(Prefix(ch), StringComparison.Ordinal); }
        static bool IsChannelKeyword(string keyword, BunkerPaintChannel ch) { return keyword.StartsWith(Prefix(ch).ToUpperInvariant(), StringComparison.Ordinal); }

        public static void Tint(Material m, BunkerPaintChannel ch, Color tint)
        {
            var name = Prefix(ch) + "OverallColor";
            if (!m.HasProperty(name)) return;
            var c = m.GetColor(name);
            m.SetColor(name, new Color(c.r * tint.r, c.g * tint.g, c.b * tint.b, c.a));
        }

        // A channel's "tint": a number (every component) or [r, g, b]; default white.
        static Color TintOf(GolfMapJsonObject s, string where)
        {
            if (!s.Has("tint")) return Color.white;
            var list = s.Array("tint");
            if (list == null) { var t = (float)s.Number("tint", 1); return new Color(t, t, t, 1); }
            var n = list.OfType<GolfMapJsonNumber>().Select(v => (float)v.Value).ToArray();
            if (n.Length != 3 || list.Count != 3) throw new FormatException(where + " must be a number or [r, g, b].");
            return new Color(n[0], n[1], n[2], 1);
        }

        public static void SetBlendStrength(Material m, BunkerPaintChannel ch, float strength)
        {
            if (strength < 0) return;
            var name = Prefix(ch) + "BlendStrength";
            if (m.HasProperty(name)) m.SetFloat(name, strength);
        }

        // ------------------------------------------------------ paint reading

        public static BunkerPaintChannel Dominant(Color c)
        {
            float m = Mathf.Max(c.r, Mathf.Max(c.g, c.b));
            if (m < 0.25f) return BunkerPaintChannel.Black;
            if (c.r >= c.g && c.r >= c.b) return BunkerPaintChannel.Red;
            return c.g >= c.b ? BunkerPaintChannel.Green : BunkerPaintChannel.Blue;
        }

        // Share of each dominant channel over a vertex set.
        public sealed class Tally
        {
            public readonly int[] counts = new int[4];
            public int total;
            public void Add(BunkerPaintChannel ch) { counts[(int)ch]++; total++; }
            public float Share(BunkerPaintChannel ch) { return total == 0 ? 0 : counts[(int)ch] / (float)total; }
            public float Share(IEnumerable<BunkerPaintChannel> chs) { return total == 0 ? 0 : chs.Distinct().Sum(c => counts[(int)c]) / (float)total; }
            public BunkerPaintChannel Top { get { int best = 0; for (int i = 1; i < 4; i++) if (counts[i] > counts[best]) best = i; return (BunkerPaintChannel)best; } }
            public override string ToString()
            {
                if (total == 0) return "-";
                return string.Join(" ", All.Where(c => counts[(int)c] > 0).Select(c => c.ToString().Substring(0, c == BunkerPaintChannel.Black ? 2 : 1).ToUpperInvariant() + Mathf.RoundToInt(100f * Share(c)) + "%").ToArray());
            }
        }

        // Welded world-space topology of a mesh: FBX import splits vertices on normal and
        // UV seams, so boundary edges are found on positions rounded to a millimetre.
        public sealed class MeshPaint
        {
            public Vector3[] world;
            public Color[] colors;
            public int[] weld;                          // vertex -> welded id
            public HashSet<int> boundary = new HashSet<int>();  // welded ids on an open edge
            public Dictionary<int, HashSet<int>> links = new Dictionary<int, HashSet<int>>();  // welded adjacency
            public bool HasColors { get { return colors != null && colors.Length == world.Length; } }
        }

        public static MeshPaint Read(MeshFilter mf)
        {
            var mesh = mf.sharedMesh;
            var mp = new MeshPaint();
            var local = mesh.vertices;
            mp.world = local.Select(v => mf.transform.TransformPoint(v)).ToArray();
            mp.colors = mesh.colors;
            mp.weld = new int[local.Length];
            var ids = new Dictionary<long, int>();
            for (int i = 0; i < local.Length; i++)
            {
                var p = mp.world[i];
                long key = ((long)Mathf.RoundToInt(p.x * 1000f) * 73856093L) ^ ((long)Mathf.RoundToInt(p.y * 1000f) * 19349663L) ^ ((long)Mathf.RoundToInt(p.z * 1000f) * 83492791L);
                int id;
                if (!ids.TryGetValue(key, out id)) { id = ids.Count; ids[key] = id; }
                mp.weld[i] = id;
            }
            var edges = new Dictionary<long, int>();
            var tris = mesh.triangles;
            for (int t = 0; t < tris.Length; t += 3)
                for (int e = 0; e < 3; e++)
                {
                    int a = mp.weld[tris[t + e]], b = mp.weld[tris[t + (e + 1) % 3]];
                    if (a == b) continue;
                    long k = a < b ? ((long)a << 32) | (uint)b : ((long)b << 32) | (uint)a;
                    int n; edges.TryGetValue(k, out n); edges[k] = n + 1;
                    Link(mp, a, b); Link(mp, b, a);
                }
            foreach (var kv in edges)
                if (kv.Value == 1) { mp.boundary.Add((int)(kv.Key >> 32)); mp.boundary.Add((int)(kv.Key & 0xffffffff)); }
            return mp;
        }

        static void Link(MeshPaint mp, int a, int b)
        {
            HashSet<int> s; if (!mp.links.TryGetValue(a, out s)) mp.links[a] = s = new HashSet<int>();
            s.Add(b);
        }

        // Bunker: rings[0] = the open boundary, rings[k] = vertices k edges in from it;
        // everything deeper goes to interior.
        public static void TallyBunker(MeshPaint mp, Tally[] rings, Tally interior)
        {
            if (!mp.HasColors) return;
            var depth = new Dictionary<int, int>();
            var frontier = new List<int>(mp.boundary);
            foreach (var w in frontier) depth[w] = 0;
            for (int d = 1; d < rings.Length && frontier.Count > 0; d++)
            {
                var next = new List<int>();
                foreach (var w in frontier)
                {
                    HashSet<int> ns; if (!mp.links.TryGetValue(w, out ns)) continue;
                    foreach (var n in ns) if (!depth.ContainsKey(n)) { depth[n] = d; next.Add(n); }
                }
                frontier = next;
            }
            var seen = new HashSet<int>();
            for (int i = 0; i < mp.world.Length; i++)
            {
                int w = mp.weld[i];
                if (!seen.Add(w)) continue;
                int d;
                (depth.TryGetValue(w, out d) ? rings[d] : interior).Add(Dominant(mp.colors[i]));
            }
        }

        // Blend: a boundary vertex within `tolerance` of the bunker's seam is on the inner
        // edge, any other boundary vertex on the outer edge. Split blends (arcs) work the
        // same way; their end edges count as outer.
        public static void TallyBlend(MeshPaint blend, MeshPaint bunker, float tolerance, Tally inner, Tally outer)
        {
            if (!blend.HasColors) return;
            var seamPoints = new List<Vector3>();
            var seenBunker = new HashSet<int>();
            for (int i = 0; i < bunker.world.Length; i++)
                if (bunker.boundary.Contains(bunker.weld[i]) && seenBunker.Add(bunker.weld[i])) seamPoints.Add(bunker.world[i]);
            var grid = new Dictionary<long, List<Vector3>>();
            float cell = Mathf.Max(tolerance * 4f, 0.5f);
            foreach (var p in seamPoints)
            {
                var k = Cell(p, cell);
                List<Vector3> l; if (!grid.TryGetValue(k, out l)) grid[k] = l = new List<Vector3>();
                l.Add(p);
            }
            float tol2 = tolerance * tolerance;
            var seen = new HashSet<int>();
            for (int i = 0; i < blend.world.Length; i++)
            {
                int w = blend.weld[i];
                if (!blend.boundary.Contains(w) || !seen.Add(w)) continue;
                var p = blend.world[i];
                bool near = false;
                int cx = Mathf.FloorToInt(p.x / cell), cz = Mathf.FloorToInt(p.z / cell);
                for (int dx = -1; dx <= 1 && !near; dx++)
                    for (int dz = -1; dz <= 1 && !near; dz++)
                    {
                        List<Vector3> l;
                        if (!grid.TryGetValue(Key(cx + dx, cz + dz), out l)) continue;
                        foreach (var q in l) if ((q - p).sqrMagnitude <= tol2) { near = true; break; }
                    }
                (near ? inner : outer).Add(Dominant(blend.colors[i]));
            }
        }

        static long Cell(Vector3 p, float cell) { return Key(Mathf.FloorToInt(p.x / cell), Mathf.FloorToInt(p.z / cell)); }
        static long Key(int x, int z) { return ((long)x << 32) | (uint)z; }

        // How well a tally matches a rule, 0..1: the product of each ring's share of its
        // expected colour and the interior's share of the interior colours. Blend: inner
        // times outer share. `rings` must have rule.rings.Length entries.
        public static float ScoreBunker(BunkerMeshRule rule, Tally[] rings, Tally interior)
        {
            if (rings.Length == 0 || rings[0].total == 0) return 0;
            float s = 1;
            for (int i = 0; i < rule.rings.Length && i < rings.Length; i++)
                if (rings[i].total > 0) s *= rings[i].Share(rule.rings[i]);
            return interior.total == 0 ? s : s * interior.Share(rule.interior);
        }

        public static float ScoreBlend(BunkerMeshRule rule, Tally inner, Tally outer)
        {
            if (inner.total == 0 || outer.total == 0) return 0;
            return inner.Share(rule.inner) * outer.Share(rule.outer);
        }
    }
}
