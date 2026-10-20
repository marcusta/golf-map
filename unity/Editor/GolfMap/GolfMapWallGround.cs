// Unity 2018.2 / C# 6. The stone of the ground under dry-stone walls (GolfMapWalls) with `ground` (stone-walls.json).
//
// The ground itself is Blender's now: `golfmap.wall_ground` (blender/tools/shape_wallground.py, shaping layer
// 80-walls, written by gspro.py shaping-walls) raises the bank into a terrace or sharpens it into a cliff, seam-safe
// over every mesh it meets, and paints the face (groundChannel, blue -> green on steep faces when the wall has a
// stoneAlbedo) into the exported FBX. Unity never reshapes or paints those meshes any more; what is left here is
// the MATERIAL that draws that paint as stone, which is not paint and stays a Unity job:
// - StoneMaterial: a copy of a rough mesh's OPCD MAHS material, <course>/Walls/<rough> (stone).mat, whose
//   groundChannel (and green, with a stoneAlbedo) draws the stone. golfmap.paint.materials (GolfMapVertexPaint)
//   gives it to the Rough / Deep meshes on a bank whose FBX colours carry the ground channel (OnStone), and
//   GolfMapSurfaces' Rock class keys on that material path;
// - the wall's bank band (InBand: from the foot, baseInM in, to beyondM past the lip, feathered; a cliff's outline),
//   which decides where that paint counts;
// - ApplyChannelTexture (also the creek beds' pebbles), golfmap.walls.texture-survey and golfmap.walls.material-check.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    internal sealed class GolfMapWallGround
    {
        [GolfMap.Bridge.BridgeCommand("golfmap.walls.texture-survey", "Export the stone source material's detail-array colour slices for visual inspection.")]
        static object TextureSurvey()
        {
            var course = GolfMapCourses.Require();
            var walls = GolfMapWalls.LoadWalls(course);
            var src = AssetDatabase.LoadAssetAtPath<Material>(walls[0].s.stoneMaterial);
            var array = src.GetTexture("_DetailArray") as Texture2DArray;
            if (array == null) throw new InvalidOperationException("Stone material has no detail array.");
            var dir = System.IO.Path.GetFullPath("Temp/GolfMapBridge/stone-textures");
            System.IO.Directory.CreateDirectory(dir);
            var files = new List<string>();
            var old = RenderTexture.active;
            var rt = RenderTexture.GetTemporary(256, 256, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var copy = new Texture2D(array.width, array.height, array.format, false);
            var thumb = new Texture2D(256, 256, TextureFormat.RGB24, false);
            try
            {
                for (int i = 0; i < array.depth; i += 2)
                {
                    Graphics.CopyTexture(array, i, 0, copy, 0, 0);
                    Graphics.Blit(copy, rt);
                    RenderTexture.active = rt;
                    thumb.ReadPixels(new Rect(0, 0, 256, 256), 0, 0); thumb.Apply();
                    var path = System.IO.Path.Combine(dir, "detail-" + i + ".png");
                    System.IO.File.WriteAllBytes(path, thumb.EncodeToPNG()); files.Add(path);
                }
            }
            finally { RenderTexture.active = old; RenderTexture.ReleaseTemporary(rt); UnityEngine.Object.DestroyImmediate(copy); UnityEngine.Object.DestroyImmediate(thumb); }
            return files;
        }

        [GolfMap.Bridge.BridgeCommand("golfmap.walls.material-check", "Verify saved rock arrays preserve OPCD's original slices and contain nonempty rock textures. rebuild=true also builds the arrays again (into a scratch folder, deleted after) and compares them texel for texel with the saved ones: the array code is shared with the path materials (GolfMapTextureArrays).",
            args = "rebuild=false")]
        static object CheckRockMaterials(GolfMap.Bridge.BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            var settings = GolfMapWalls.LoadWalls(course)[0].s;
            var source = AssetDatabase.LoadAssetAtPath<Material>(settings.stoneMaterial);
            var report = new List<object>();
            if (a.Bool("rebuild", false)) report.Add(RebuildCompare(course, folder, settings));
            foreach (var guid in AssetDatabase.FindAssets("t:Material", new[] { folder + "Walls" }))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (!mat.name.EndsWith("(stone)", StringComparison.Ordinal)) continue;
                foreach (var prop in new[] { "_DetailArray", "_NormalArray" })
                {
                    var original = source.GetTexture(prop) as Texture2DArray;
                    var actual = mat.GetTexture(prop) as Texture2DArray;
                    if (actual == null || actual.depth <= original.depth) throw new InvalidOperationException(path + " has no appended rock " + prop);
                    for (int i = 0; i < original.depth; i++)
                        if (!original.GetPixels(i, 5).SequenceEqual(actual.GetPixels(i, 5)))
                            throw new InvalidOperationException(path + " changed original " + prop + " slice " + i);
                    var pixels = actual.GetPixels(original.depth, 5);
                    float mean = pixels.Average(c => (c.r + c.g + c.b) / 3f);
                    if (mean <= 0.001f) throw new InvalidOperationException(path + " has an empty rock slice.");
                    report.Add(new { material = path, array = prop, preservedSlices = original.depth, appended = actual.depth - original.depth, rockMean = mean });
                }
            }
            return report;
        }

        // The saved rock arrays against a fresh build from the same inputs: same key (path), same size and format, every
        // slice's texels equal (mip 0 of the appended slices, mip 3 of OPCD's).
        static object RebuildCompare(GolfMapCourse course, string folder, GolfMapWalls.Settings s)
        {
            var src = AssetDatabase.LoadAssetAtPath<Material>(s.stoneMaterial);
            var rock = AssetDatabase.LoadAssetAtPath<Texture2D>(s.stoneAlbedo);
            var normal = AssetDatabase.LoadAssetAtPath<Texture2D>(s.stoneNormal);
            var dir = folder + "Walls";
            var scratch = dir + "/_rebuild-check";
            if (!AssetDatabase.IsValidFolder(scratch)) AssetDatabase.CreateFolder(dir, "_rebuild-check");
            var result = new List<object>();
            try
            {
                foreach (var pair in new[] { new { prop = "_DetailArray", tex = rock, normal = false }, new { prop = "_NormalArray", tex = normal, normal = true } })
                {
                    var original = src.GetTexture(pair.prop) as Texture2DArray;
                    var key = AssetDatabase.GetAssetDependencyHash(AssetDatabase.GetAssetPath(original)).ToString() + AssetDatabase.GetAssetDependencyHash(AssetDatabase.GetAssetPath(pair.tex)).ToString();
                    if (AssetDatabase.LoadAssetAtPath<Texture2DArray>(dir + "/Rock " + (pair.normal ? "normals " : "detail ") + key + ".asset") == null)
                    { result.Add(pair.prop + ": no saved rock array for the current inputs (nothing to compare)"); continue; }
                    var expected = AppendRockSlices(original, pair.tex, pair.normal, dir);   // the saved one (key from the inputs)
                    var savedPath = AssetDatabase.GetAssetPath(expected);
                    var copyPath = scratch + "/" + System.IO.Path.GetFileName(savedPath);
                    var layers = new List<GolfMapTextureArrays.Layer> { new GolfMapTextureArrays.Layer { texture = pair.tex, linear = pair.normal } };
                    if (!pair.normal) layers.Add(new GolfMapTextureArrays.Layer { flat = new Color(0, 1, 1, 0.2f), linear = false });
                    var fresh = GolfMapTextureArrays.Extend(original, layers, pair.normal, copyPath, expected.name);
                    int differing = 0;
                    for (int i = 0; i < expected.depth; i++)
                    {
                        int mip = i < original.depth ? 3 : 0;
                        if (!expected.GetPixels(i, mip).SequenceEqual(fresh.GetPixels(i, mip))) differing++;
                    }
                    result.Add(new Dictionary<string, object> { { "array", savedPath }, { "slices", expected.depth }, { "sameShape", expected.depth == fresh.depth && expected.format == fresh.format && expected.width == fresh.width },
                        { "slicesDiffering", differing }, { "identical", differing == 0 && expected.depth == fresh.depth && expected.format == fresh.format } });
                }
            }
            finally { AssetDatabase.DeleteAsset(scratch); }
            return new Dictionary<string, object> { { "rebuild", result } };
        }

        const float ReachM = 1.3f;   // Blender's REACH_M: the shape and paint reach this far past the band
        const float GroundWeight = 0.5f;   // a vertex counts as stone over this much of the ground channel
        // a mesh wears the stone material when at least this many of its vertices in a bank band are stone: one stray
        // vertex (a rule's blue near the bank) is not a face
        public const int MinStoneVertices = 3;

        sealed class Bank
        {
            public string id;
            public GolfMapWalls.Settings s;
            public Vector2[] toe, lip;
            public Rect rect;          // x/z with the reach (Blender's wall box: toe, lip, outline + REACH_M + 3 m)
            public bool cliff;
            public Vector2[] outline;  // cliff: the rock seen from above, scene x/z (may be null)
        }

        readonly List<Bank> banks = new List<Bank>();
        string folder;  // the course folder

        // The course's walls with ground; null when it has none (or no walls spec).
        public static GolfMapWallGround Load(GolfMapCourse course)
        {
            var walls = GolfMapWalls.LoadWalls(course);
            if (walls == null) return null;
            walls = walls.Where(w => w.s.ground).ToList();
            if (walls.Count == 0) return null;
            var g = new GolfMapWallGround { folder = GolfMapCourses.Folder(course) };
            foreach (var w in walls)
                g.banks.Add(new Bank
                {
                    id = w.id, s = w.s, toe = w.toe.ToArray(), lip = w.lip.ToArray(), cliff = w.s.style == "cliff",
                    rect = Bounds(w.toe.Concat(w.lip).Concat(w.outline ?? new List<Vector2>()), ReachM + 3f),
                    outline = w.outline == null || w.outline.Count < 3 ? null : w.outline.ToArray(),
                });
            return g;
        }

        public IEnumerable<string> Ids { get { return banks.Select(b => b.id); } }

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

        // Does a wall's bank reach these (renderer) bounds?
        public bool Meets(Bounds b) { return banks.Any(k => Overlaps(k.rect, b)); }

        // How many of the mesh's vertices (`mesh`: the FBX mesh the object shows, world through f's transform) lie in a
        // bank band and carry the wall's ground channel (> 0.5; with a stoneAlbedo and groundChannel blue also green,
        // which Blender's op turns blue into on steep faces): the bank paint golfmap.wall_ground baked in.
        public int StoneVertices(MeshFilter f, Mesh mesh)
        {
            var r = f.GetComponent<Renderer>();
            var mine = r == null ? banks : banks.Where(k => Overlaps(k.rect, r.bounds)).ToList();
            if (mine.Count == 0 || mesh == null) return 0;
            var local = mesh.vertices;
            var colors = mesh.colors;
            if (colors == null || colors.Length != local.Length) return 0;
            int n = 0;
            for (int i = 0; i < local.Length; i++)
            {
                var p = f.transform.TransformPoint(local[i]);
                var q = new Vector2(p.x, p.z);
                foreach (var b in mine)
                {
                    if (!b.rect.Contains(q) || Weight(b.s, colors[i]) <= GroundWeight || !InBand(b, q)) continue;
                    n++;
                    break;
                }
            }
            return n;
        }

        // The wall's ground paint in a colour: the groundChannel's share (black: what red, green and blue leave), plus green
        // where the face turns blue into green (a stoneAlbedo wall).
        static float Weight(GolfMapWalls.Settings s, Color c)
        {
            float w;
            switch ((s.groundChannel ?? "").ToLowerInvariant())
            {
                case "red": w = c.r; break;
                case "green": w = c.g; break;
                case "black": w = Mathf.Max(0f, 1f - c.r - c.g - c.b); break;
                default: w = c.b; break;
            }
            if (!string.IsNullOrEmpty(s.stoneAlbedo) && (s.groundChannel ?? "blue").ToLowerInvariant() == "blue") w += c.g;
            return w;
        }

        // Within the band the bank's paint reaches: across the bank from the foot (a terrace: baseInM in) to beyondM past
        // the lip, feathered by paintFeatherM, between the wall's ends; or a cliff's outline (and paintFeatherM round it).
        static bool InBand(Bank b, Vector2 q)
        {
            float fe = Mathf.Max(0.01f, b.s.paintFeatherM);
            if (b.outline != null && (InOutline(b.outline, q) || OutlineEdge(b.outline, q) < fe)) return true;
            int best = -1; float bestD = float.MaxValue, bestF = 0f; bool beyond = false;
            for (int k = 0; k + 1 < b.toe.Length; k++)
            {
                var ab = b.toe[k + 1] - b.toe[k];
                float len2 = ab.sqrMagnitude;
                float f = len2 > 1e-8f ? Vector2.Dot(q - b.toe[k], ab) / len2 : 0f;
                float fc = Mathf.Clamp01(f);
                float d = (b.toe[k] + ab * fc - q).sqrMagnitude;
                if (d < bestD) { bestD = d; best = k; bestF = fc; beyond = (k == 0 && f < 0f) || (k == b.toe.Length - 2 && f > 1f); }
            }
            if (best < 0 || beyond) return false;
            var in0 = b.lip[best] - b.toe[best];
            var in1 = b.lip[best + 1] - b.toe[best + 1];
            float depth = Mathf.Lerp(in0.magnitude, in1.magnitude, bestF);
            var inward = Vector2.Lerp(in0.sqrMagnitude > 1e-8f ? in0.normalized : Vector2.zero, in1.sqrMagnitude > 1e-8f ? in1.normalized : Vector2.zero, bestF);
            if (inward.sqrMagnitude < 1e-6f) return false;
            inward.Normalize();
            var foot = Vector2.Lerp(b.toe[best], b.toe[best + 1], bestF);
            float t = Vector2.Dot(q - foot, inward);
            float lo = (b.cliff ? 0f : b.s.baseInM) - fe;
            return t >= lo && t <= depth + b.s.beyondM + fe;
        }

        static bool InOutline(Vector2[] o, Vector2 p)
        {
            bool c = false;
            for (int i = 0, j = o.Length - 1; i < o.Length; j = i++)
                if ((o[i].y > p.y) != (o[j].y > p.y) && p.x < (o[j].x - o[i].x) * (p.y - o[i].y) / (o[j].y - o[i].y) + o[i].x) c = !c;
            return c;
        }

        static float OutlineEdge(Vector2[] o, Vector2 p)
        {
            float d = float.MaxValue;
            for (int i = 0, j = o.Length - 1; i < o.Length; j = i++)
            {
                var ab = o[i] - o[j]; float l2 = ab.sqrMagnitude;
                float f = l2 > 1e-8f ? Mathf.Clamp01(Vector2.Dot(p - o[j], ab) / l2) : 0f;
                d = Mathf.Min(d, (o[j] + ab * f - p).magnitude);
            }
            return d;
        }

        // ---- the stone the face is painted with ----------------------------------------------------

        // A copy of a rough mesh's OPCD MAHS material (<course>/Walls/<name> (stone).mat) whose groundChannel draws the
        // spec's stoneMaterial channel (every _<Channel>* property and _<CHANNEL>*_ON toggle of it), rebuilt from the
        // original on every run so the spec wins; null when the spec names none. A material that already is such a
        // copy comes back as it is. OPCD's theme window (SetMeshMaterialv4) puts the original back: run golfmap.paint.materials again.
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
            if (s.stoneColor.HasValue && m.HasProperty("_" + to + "OverallColor")) m.SetColor("_" + to + "OverallColor", s.stoneColor.Value);
            string TO = "_" + to.ToUpperInvariant(), FROM = "_" + from.ToUpperInvariant();
            var kw = new HashSet<string>(rough.shaderKeywords.Where(k => !k.StartsWith(TO, StringComparison.Ordinal)));
            foreach (var k in src.shaderKeywords) if (k.StartsWith(FROM, StringComparison.Ordinal)) kw.Add(TO + k.Substring(FROM.Length));
            m.shaderKeywords = kw.ToArray();
            if (!string.IsNullOrEmpty(s.stoneAlbedo))
            {
                ApplyRockTexture(m, s, to, dir);
                // Green is a brighter version of the same rock for steep faces. OPCD's final
                // slope tint otherwise removes about 70% of its albedo at 65 degrees.
                for (int i = 0; i < ShaderUtil.GetPropertyCount(m.shader); i++)
                {
                    var dest = ShaderUtil.GetPropertyName(m.shader, i);
                    if (!dest.StartsWith("_Green", StringComparison.Ordinal)) continue;
                    var fromRock = "_" + to + dest.Substring(6);
                    if (!m.HasProperty(fromRock)) continue;
                    switch (ShaderUtil.GetPropertyType(m.shader, i))
                    {
                        case ShaderUtil.ShaderPropertyType.Color: m.SetColor(dest, m.GetColor(fromRock)); break;
                        case ShaderUtil.ShaderPropertyType.Vector: m.SetVector(dest, m.GetVector(fromRock)); break;
                        case ShaderUtil.ShaderPropertyType.TexEnv: m.SetTexture(dest, m.GetTexture(fromRock)); break;
                        default: m.SetFloat(dest, m.GetFloat(fromRock)); break;
                    }
                }
                m.SetFloat("_GreenAOBrightness", 1.6f);
                m.SetFloat("_GreenNearNRMStrength", 0f);
                m.SetFloat("_GreenFarNRMStrength", 0f);
                m.DisableKeyword("_GREENBASEBLEND_ON");
            }
            EditorUtility.SetDirty(m);
            return m;
        }

        // Keep every existing OPCD slice: other vertex colours still draw the original grass.
        // The rock gets a new albedo/MAHS pair and corresponding packed normal, on the stock shader.
        static void ApplyRockTexture(Material m, GolfMapWalls.Settings s, string channel, string dir)
        {
            ApplyChannelTexture(m, channel, s.stoneAlbedo, s.stoneNormal, s.stoneTileM, s.stoneColor ?? Color.white, dir);
        }

        // Any ground texture as a channel of an OPCD MAHS material copy: albedo + normal appended to its detail and
        // normal arrays (the stone walls' rock, the creek beds' pebbles). `channel` is red, green, blue or black.
        internal static void ApplyChannelTexture(Material m, string channel, string albedoPath, string normalPath, float tileM, Color overall, string dir)
        {
            var albedo = AssetDatabase.LoadAssetAtPath<Texture2D>(albedoPath);
            var normal = AssetDatabase.LoadAssetAtPath<Texture2D>(normalPath);
            var detail = m.GetTexture("_DetailArray") as Texture2DArray;
            var normals = m.GetTexture("_NormalArray") as Texture2DArray;
            if (albedo == null || normal == null || detail == null || normals == null)
                throw new InvalidOperationException("Rock paint needs albedo, an imported normal map, and OPCD detail/normal arrays.");
            if (detail.depth != normals.depth * 2 || tileM <= 0)
                throw new InvalidOperationException("Rock paint needs paired OPCD detail slices and positive stoneTileM.");
            var importer = AssetImporter.GetAtPath(normalPath) as TextureImporter;
            if (importer == null || importer.textureType != TextureImporterType.NormalMap)
                throw new InvalidOperationException(normalPath + " must be imported as a normal map.");
            int index = detail.depth;
            m.SetTexture("_DetailArray", AppendRockSlices(detail, albedo, false, dir));
            m.SetTexture("_NormalArray", AppendRockSlices(normals, normal, true, dir));
            string p = "_" + char.ToUpperInvariant(channel[0]) + channel.Substring(1);
            m.SetFloat(p + "DetailIndex", index);
            m.SetFloat(p + "BaseBlend", 0); // no distant grass/base texture under exposed rock
            m.DisableKeyword((p + "BaseBlend").ToUpperInvariant() + "_ON");
            m.SetTexture(p + "HeightTexture", Texture2D.whiteTexture); // full vertex paint = full stone
            m.SetFloat(p + "BlendStrength", 1);
            m.SetFloat(p + "DetailTiling", tileM);
            m.SetFloat(p + "FarNRMTiling", tileM);
            m.SetFloat(p + "NearNRMStrength", 0.7f);
            m.SetFloat(p + "FarNRMStrength", 0.7f);
            m.SetFloat(p + "AOBrightness", 1);
            m.SetFloat(p + "MowlineTiling", 1); // avoid division by zero even with opacity zero
            m.SetFloat(p + "MowlineOpacity", 0);
            m.SetFloat(p + "SurfaceOpacity", 0);
            m.SetFloat(p + "Smoothness", 0.1f);
            m.SetColor(p + "DetailColorTint", Color.white);
            m.SetColor(p + "OverallColor", overall);
        }

        // The rock as a new slice (GolfMapTextureArrays): albedo + a flat MAHS slice in the detail array, the normal in
        // the normal array. The detail copy is an sRGB array (as it has always been: keys and saved arrays unchanged).
        static Texture2DArray AppendRockSlices(Texture2DArray source, Texture2D rock, bool normal, string dir)
        {
            var key = AssetDatabase.GetAssetDependencyHash(AssetDatabase.GetAssetPath(source)).ToString()
                + AssetDatabase.GetAssetDependencyHash(AssetDatabase.GetAssetPath(rock)).ToString();
            var path = dir + "/Rock " + (normal ? "normals " : "detail ") + key + ".asset";
            var layers = new List<GolfMapTextureArrays.Layer> { new GolfMapTextureArrays.Layer { texture = rock, linear = normal } };
            if (!normal) layers.Add(new GolfMapTextureArrays.Layer { flat = new Color(0, 1, 1, 0.2f), linear = false }); // metallic, AO, height, smoothness
            return GolfMapTextureArrays.Extend(source, layers, normal, path, "OPCD with exposed rock " + (normal ? "normals" : "detail"));
        }

        static string Cap(string channel)
        {
            var c = (channel ?? "").ToLowerInvariant();
            if (c != "red" && c != "green" && c != "blue" && c != "black") throw new InvalidOperationException("channel must be red, green, blue or black, not " + channel + ".");
            return char.ToUpperInvariant(c[0]) + c.Substring(1);
        }
    }
}
