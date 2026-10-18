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
// A wall with style "cliff" (a klippa: a natural rock face) is sharpened instead of terraced: across the bank the
// ground follows a gentle apron from the foot, rises at faceDeg (+- jitterDeg along the face, seeded) through the
// bank's mid-height point (where the original surface crosses halfway between foot and top), then stays at the top;
// below the mid-height point it may be lowered, above it only raised. Its `outline` (the rock seen from above) is
// painted as rock inside, feathered at the edge, besides the face.
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

        const float StationStepM = 0.25f;
        const float ReachM = 1.3f;  // subdivide this far past the band the terrace changes (one original triangle)

        sealed class Station
        {
            public Vector2 toe, inward;
            public float along, depth, hToe, hTop, tMid;
        }

        sealed class Bank
        {
            public string id;
            public GolfMapWalls.Settings s;
            public Station[] st;
            public float length, tanFace;
            public Rect rect;  // x/z with the reach
            public Color channel;
            public bool cliff;
            public Vector2[] outline;  // cliff: the rock seen from above, scene x/z (may be null)
            public Vector4[] grassPatches;
            public float[] phase;      // cliff: seeded phases of the face-angle noise
        }

        // Where a point is across a bank: s along its foot, t in from the foot, and the station's heights there.
        struct Across
        {
            public float s, t, depth, hToe, hTop, tMid, faceTan;
        }

        readonly List<Bank> banks = new List<Bank>();
        public readonly List<object> report = new List<object>();
        public readonly List<Vector3> loweredPoints = new List<Vector3>();  // world points of vertices lowered (for the terrain)
        string folder;  // the course folder

        // The course's walls with ground, their profiles measured on each course mesh's original mesh; null when none.
        public static GolfMapWallGround Load(GolfMapCourse course, IList<MeshFilter> filters, Func<MeshFilter, Mesh> original)
        {
            var walls = GolfMapWalls.LoadWalls(course);
            if (walls == null) return null;
            walls = walls.Where(w => w.s.ground).ToList();
            if (walls.Count == 0) return null;
            var g = new GolfMapWallGround { folder = GolfMapCourses.Folder(course) };
            var rects = walls.Select(w => Bounds(w.toe.Concat(w.lip).Concat(w.outline ?? new List<Vector2>()), ReachM + 3f)).ToList();
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
                // a cliff turns about its mid-height point: the first point in from the foot at half the rise
                st[i].tMid = depth / 2;
                float mid = (st[i].hToe + st[i].hTop) / 2;
                for (float t = 0; t <= depth; t += 0.25f)
                {
                    float z = surface.At(toe + inward * t);
                    if (!float.IsNaN(z) && z >= mid) { st[i].tMid = t; break; }
                }
            }
            Smooth(st, x => x.hToe, (x, v) => x.hToe = v);
            Smooth(st, x => x.hTop, (x, v) => x.hTop = v);
            Smooth(st, x => x.tMid, (x, v) => x.tMid = v);
            var rnd = new System.Random(w.seed);
            return new Bank
            {
                id = w.id, s = s, st = st, length = length, tanFace = Mathf.Tan(Mathf.Clamp(s.faceDeg, 20f, 85f) * Mathf.Deg2Rad),
                rect = rect, channel = PaintChannel(s.groundChannel, w.id), cliff = s.style == "cliff",
                outline = w.outline == null || w.outline.Count < 3 ? null : w.outline.ToArray(),
                grassPatches = w.grassPatches.ToArray(),
                phase = new[] { (float)rnd.NextDouble() * 6.283f, (float)rnd.NextDouble() * 6.283f, (float)rnd.NextDouble() * 6.283f },
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
            a.tMid = Mathf.Lerp(st[i0].tMid, st[i1].tMid, bestF);
            a.faceTan = b.cliff ? Mathf.Tan(Mathf.Clamp(b.s.faceDeg + b.s.jitterDeg * Noise(b, a.s), 30f, 88f) * Mathf.Deg2Rad) : b.tanFace;
            return !float.IsNaN(a.hToe) && !float.IsNaN(a.hTop);
        }

        // -1..1, smooth along the face (wavelengths 3-13 m), seeded per wall: a natural face is not one angle.
        static float Noise(Bank b, float s)
        {
            const float Tau = 6.2831853f;
            float v = Mathf.Sin(Tau * s / 7.3f + b.phase[0]) + 0.6f * Mathf.Sin(Tau * s / 3.1f + b.phase[1]) + 0.4f * Mathf.Sin(Tau * s / 12.7f + b.phase[2]);
            return Mathf.Clamp(v / 1.6f, -1f, 1f);
        }

        static bool Near(Bank b, Across a)
        {
            return a.t >= (b.cliff ? 0f : b.s.baseInM) - ReachM && a.t <= a.depth + b.s.beyondM + ReachM;
        }

        static bool InOutline(Bank b, Vector2 p)
        {
            if (b.outline == null) return false;
            bool c = false; var o = b.outline;
            for (int i = 0, j = o.Length - 1; i < o.Length; j = i++)
                if ((o[i].y > p.y) != (o[j].y > p.y) && p.x < (o[j].x - o[i].x) * (p.y - o[i].y) / (o[j].y - o[i].y) + o[i].x) c = !c;
            return c;
        }

        static float OutlineEdge(Bank b, Vector2 p)
        {
            float d = float.MaxValue; var o = b.outline;
            for (int i = 0, j = o.Length - 1; i < o.Length; j = i++)
            {
                var ab = o[i] - o[j]; float l2 = ab.sqrMagnitude;
                float f = l2 > 1e-8f ? Mathf.Clamp01(Vector2.Dot(p - o[j], ab) / l2) : 0f;
                d = Mathf.Min(d, (o[j] + ab * f - p).magnitude);
            }
            return d;
        }

        // A cliff's ground across the bank: a 12 deg apron up from the foot, the face at the point's angle through the
        // mid-height point, the top; f0/f1: where the face starts and ends (for the paint). NaN outside the bank.
        static float TargetCliff(Bank b, Across a, out float f0, out float f1)
        {
            var s = b.s;
            float h = a.hTop - a.hToe, mid = (a.hTop + a.hToe) / 2;
            f0 = a.tMid - (mid - a.hToe) / a.faceTan; f1 = a.tMid + (a.hTop - mid) / a.faceTan;
            if (h < s.minFaceM || a.t < 0f || a.t > a.depth + s.beyondM) return float.NaN;
            float apron = a.hToe + a.t * 0.2126f, face = mid + (a.t - a.tMid) * a.faceTan;
            if (s.roundTopM > 0)
            {
                // A circular fillet tangent to both the inclined face and the level crest.
                // Its radius is metres, so the weathered shoulder stays broad at any mesh resolution.
                float angle = Mathf.Atan(a.faceTan);
                float radius = Mathf.Min(s.roundTopM, h * 0.8f / Mathf.Max(0.01f, 1f - Mathf.Cos(angle)));
                float cx = f1 + radius * Mathf.Tan(angle * 0.5f);
                float start = cx - radius * Mathf.Sin(angle);
                if (a.t > start && a.t < cx)
                    face = a.hTop - radius + Mathf.Sqrt(Mathf.Max(0, radius * radius - (a.t - cx) * (a.t - cx)));
                else if (a.t >= cx) face = a.hTop;
            }
            return Mathf.Min(Mathf.Max(apron, face), a.hTop);
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
                foreach (var b in banks)
                {
                    Across a;
                    if (Locate(b, q, out a) && Near(b, a)) return true;
                    if (b.outline != null && (InOutline(b, q) || OutlineEdge(b, q) < ReachM)) return true;
                }
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
            var rockPaint = new bool[w.pos.Count];
            int raised = 0, lowered = 0, painted = 0; float maxRaise = 0, maxLower = 0;
            bool paint = surface == GolfMapSurfaces.Surface.Rough || surface == GolfMapSurfaces.Surface.Deep;
            for (int i = 0; i < w.pos.Count; i++)
            {
                if (!w.near[i]) continue;
                var p = tr.TransformPoint(w.pos[i]);
                var q = new Vector2(p.x, p.z);
                float lift = 0, drop = 0, stone = 0; Color channel = Color.red;
                foreach (var b in banks)
                {
                    float fe = Mathf.Max(0.01f, b.s.paintFeatherM);
                    if (paint && b.outline != null && InOutline(b, q))
                    {
                        float wgt = Mathf.Clamp01((OutlineEdge(b, q) - b.s.paintInsetM) / fe);
                        foreach (var patch in b.grassPatches)
                        {
                            float dx = (q.x - patch.x) / patch.z, dz = (q.y - patch.y) / patch.w;
                            // Warp the whole pocket, not just its feather: small edge noise still reads
                            // as a circular lawn. Lobes and narrow fingers follow an irregular soil seam.
                            float phase = Mathf.PerlinNoise(patch.x * 0.17f, patch.y * 0.17f) * 6.283f;
                            dx += (Mathf.PerlinNoise(q.x * 0.38f, q.y * 0.38f) - 0.5f) * 0.9f;
                            dz += (Mathf.PerlinNoise(q.x * 0.38f + 73, q.y * 0.38f + 19) - 0.5f) * 0.9f;
                            float angle = Mathf.Atan2(dz, dx);
                            float edge = 0.75f + 0.3f * Mathf.Sin(angle * 3 + phase)
                                + 0.18f * Mathf.Sin(angle * 5 - phase);
                            float d = Mathf.Sqrt(dx * dx + dz * dz);
                            float ragged = (Mathf.PerlinNoise(q.x * 1.1f, q.y * 1.1f) - 0.5f) * 0.22f;
                            wgt *= Mathf.SmoothStep(0f, 1f, Mathf.Clamp01((d + ragged - edge) / 0.32f));
                        }
                        if (wgt > stone) { stone = wgt; channel = b.channel; }
                    }
                    if (b.s.paintOnly) continue; // retain original FBX heights; only subdivide for the paint edge
                    Across a;
                    if (!Locate(b, q, out a)) continue;
                    float taper = Taper(b, a);
                    if (b.cliff)
                    {
                        float f0, f1;
                        float target = TargetCliff(b, a, out f0, out f1);
                        if (!float.IsNaN(target))
                        {
                            // Fade displacement back to the original ground at both ends of the
                            // cross-section. An abrupt cutoff made a second small cliff at the toe.
                            float join = b.s.roundTopM > 0
                                ? Mathf.SmoothStep(0, 1, Mathf.Clamp01(a.t / 2f))
                                  * Mathf.SmoothStep(0, 1, Mathf.Clamp01((a.depth + b.s.beyondM - a.t) / 2f))
                                : 1f;
                            float d = (target - p.y) * taper * join;
                            if (d > 0) lift = Mathf.Max(lift, d);
                            else if (a.t < a.tMid || b.s.roundTopM > 0) drop = Mathf.Min(drop, d); // a rounded shoulder must also be allowed to cut the original crest
                        }
                        if (paint && b.outline == null && a.hTop - a.hToe >= b.s.minFaceM && a.t >= -fe && a.t <= a.depth + b.s.beyondM)
                        {
                            float wgt = Mathf.Min(Mathf.Clamp01((a.t - (f0 - fe)) / fe), Mathf.Clamp01((f1 + fe - a.t) / fe)) * taper;
                            if (wgt > stone) { stone = wgt; channel = b.channel; }
                        }
                        continue;
                    }
                    float faceTop;
                    float target2 = Target(b, a, out faceTop);
                    if (!float.IsNaN(target2)) lift = Mathf.Max(lift, (target2 - p.y) * taper);
                    if (paint && a.hTop - a.hToe >= b.s.minFaceM)
                    {
                        float wgt = Mathf.Min(Mathf.Clamp01((a.t - (b.s.baseInM - fe)) / fe), Mathf.Clamp01((faceTop + fe - a.t) / fe)) * taper;
                        if (wgt > stone) { stone = wgt; channel = b.channel; }
                    }
                }
                float move = lift > 0.005f ? lift : (drop < -0.005f ? drop : 0f);
                if (move != 0f)
                {
                    p.y += move;
                    w.pos[i] = tr.InverseTransformPoint(p);
                    changedPos.Add(i);
                    if (move > 0) { raised++; maxRaise = Mathf.Max(maxRaise, move); }
                    else { lowered++; maxLower = Mathf.Max(maxLower, -move); loweredPoints.Add(p); }
                }
                if (stone > 0.01f)
                {
                    rockPaint[i] = true;
                    var c = w.col[i];
                    var t = channel; t.a = c.a;
                    w.col[i] = Color.Lerp(c, t, stone);
                    painted++;
                }
            }
            if (raised == 0 && lowered == 0 && painted == 0) return null;  // within reach but outside the terrace: keep the FBX mesh
            RoundShoulders(w, tr);
            if (w.hasNrm) RecomputeNormals(w, subs, n0);
            if (w.hasNrm && !string.IsNullOrEmpty(banks[0].s.stoneAlbedo))
                for (int i = 0; i < w.pos.Count; i++)
                {
                    if (!rockPaint[i]) continue;
                    float slope = Vector3.Angle(tr.TransformDirection(w.nrm[i]), Vector3.up);
                    float face = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(35, 60, slope));
                    var c = w.col[i]; float amount = c.b * face;
                    c.b -= amount; c.g += amount; w.col[i] = c;
                }

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
                { "maxRaiseM", Math.Round(maxRaise, 2) }, { "lowered", lowered }, { "maxLowerM", Math.Round(maxLower, 2) }, { "painted", painted } });
            return mesh;
        }

        // Smooth across neighbouring bank stations too: rounding each cross-section alone still leaves
        // corners where the traced lip changes direction. Relax the shoulder and the foot join.
        void RoundShoulders(Work w, Transform tr)
        {
            var rounded = banks.Where(b => b.cliff && !b.s.paintOnly && b.s.roundTopM > 0).ToArray();
            if (rounded.Length == 0) return;
            var world = w.pos.Select(p => tr.TransformPoint(p)).ToArray();
            var grid = new Dictionary<long, List<int>>();
            Func<int, int, long> key = (x, z) => ((long)x << 32) | (uint)z;
            for (int i = 0; i < world.Length; i++)
            {
                long k = key(Mathf.FloorToInt(world[i].x), Mathf.FloorToInt(world[i].z));
                List<int> list; if (!grid.TryGetValue(k, out list)) grid[k] = list = new List<int>(); list.Add(i);
            }
            var weights = new float[world.Length];
            for (int i = 0; i < world.Length; i++)
            {
                if (!w.near[i]) continue;
                var q = new Vector2(world[i].x, world[i].z);
                foreach (var b in rounded)
                {
                    Across a; if (!Locate(b, q, out a)) continue;
                    float f0, f1; TargetCliff(b, a, out f0, out f1);
                    if (a.hTop - a.hToe < b.s.minFaceM) continue;
                    float rise = a.hTop - a.hToe;
                    float upper = Mathf.SmoothStep(0, 1, Mathf.InverseLerp(a.hTop - rise * 0.55f, a.hTop - rise * 0.25f, world[i].y));
                    float nearCrest = Mathf.Exp(-Mathf.Pow((a.t - f1) / 2f, 2)) * upper;
                    float foot = Mathf.Exp(-Mathf.Pow(a.t / 1.5f, 2));
                    weights[i] = Mathf.Max(weights[i], Mathf.Max(nearCrest, foot) * Taper(b, a));
                }
            }
            for (int pass = 0; pass < 3; pass++)
            {
                var next = (Vector3[])world.Clone();
                for (int i = 0; i < world.Length; i++)
                {
                    if (weights[i] < 0.01f) continue;
                    var p = world[i]; int gx = Mathf.FloorToInt(p.x), gz = Mathf.FloorToInt(p.z);
                    float total = 0, height = 0;
                    for (int x = gx - 2; x <= gx + 2; x++) for (int z = gz - 2; z <= gz + 2; z++)
                    {
                        List<int> list; if (!grid.TryGetValue(key(x, z), out list)) continue;
                        foreach (int j in list)
                        {
                            float dx = world[j].x - p.x, dz = world[j].z - p.z, d2 = dx * dx + dz * dz;
                            if (d2 > 2.25f) continue;
                            float weight = Mathf.Exp(-d2 / 0.8f); total += weight; height += world[j].y * weight;
                        }
                    }
                    if (total > 0) next[i].y = Mathf.Lerp(p.y, height / total, weights[i] * 0.8f);
                }
                world = next;
            }
            for (int i = 0; i < world.Length; i++)
            {
                if (weights[i] < 0.01f) continue;
                if (world[i].y < tr.TransformPoint(w.pos[i]).y - 0.005f) loweredPoints.Add(world[i]);
                w.pos[i] = tr.InverseTransformPoint(world[i]);
            }
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
