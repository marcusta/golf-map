// Tints baked into albedo copies, for the tree materials whose shader has no tint: the CTI
// trial's (CTI/LOD Leaves, Bark and Bark Array draw what their textures hold). The same bake as
// prepare-cti-maps.py - every texel's linear RGB times a linear tint, alpha untouched - from the
// pristine source texture, into the course copy the trial material samples:
//
//   <course>/CTITrial/Textures/<source> tinted.png     2D albedo (leaves, oak bark)
//   <course>/CTITrial/Textures/<source> tinted.asset   Texture2DArray (birch bark: CTI Bark Array)
//
// trial.json records it on the override (`source`, `tint`), and both writers honour a recorded
// tint. In the editor the tint is a colour whose linear value is the multiplier (the leaves'
// "healthy" tint, the bark's "bark" colour), so the palette editor grades it like any tint.
//
// A bake runs when the slider is let go (GolfMapVegLive queues it): the result is compressed to
// the live texture's format and copied into it on the GPU (Graphics.CopyTexture), so the Lab and
// the planted trees change within a second or two without a reimport. Save writes the file. A
// target that does not exist yet (the birch bark array) is created on the first bake, the trial
// materials are pointed at it and trial.json gets its override at once (tint 1 = the source).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapVegBake
    {
        public sealed class Target
        {
            public string texture, source, prop;   // target asset path, source asset path, material slot
            public bool array, exists;
            public Vector3 tint = Vector3.one;      // linear multiplier
            public readonly List<string> materials = new List<string>();   // trial materials sampling it
        }

        // The albedo slot of each CTI shader the trial uses.
        static string AlbedoSlot(string shader)
        {
            if (shader == "CTI/LOD Leaves" || shader == "CTI/LOD Bark") return "_MainTex";
            if (shader == "CTI/LOD Bark Array") return "_MainTexArray";
            return null;
        }

        static string TrialPath(GolfMapCourse course) { return GolfMapCourses.Folder(course) + "CTITrial/trial.json"; }

        static Dictionary<string, Target> byMaterial;    // trial material path -> its albedo target
        static string cachedFor; static long cachedStamp;

        // Every trial material's albedo target, from trial.json (cached until the file changes).
        public static Dictionary<string, Target> Targets(GolfMapCourse course)
        {
            string path = TrialPath(course);
            long stamp = File.Exists(path) ? File.GetLastWriteTimeUtc(path).Ticks : 0;
            if (byMaterial != null && cachedFor == path && cachedStamp == stamp) return byMaterial;
            byMaterial = new Dictionary<string, Target>(); cachedFor = path; cachedStamp = stamp;
            if (stamp == 0) return byMaterial;
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var targets = new Dictionary<string, Target>();
            foreach (GolfMapJsonObject swap in doc.Array("swaps") ?? new List<object>())
            {
                string to = swap.String("to"), slot = AlbedoSlot(swap.String("shader"));
                var material = AssetDatabase.LoadAssetAtPath<Material>(to);
                if (slot == null || !material || !material.HasProperty(slot)) continue;
                var over = (swap.Array("textures") ?? new List<object>()).Cast<GolfMapJsonObject>().FirstOrDefault(t => t.String("name") == slot);
                Target target;
                if (over != null)
                {
                    // An override that records no tint is not ours to bake (an older prepare-cti-maps.py run).
                    var tint = over.Array("tint");
                    if (tint == null || over.String("source") == null) continue;
                    if (!targets.TryGetValue(over.String("path"), out target))
                        targets[over.String("path")] = target = new Target
                        {
                            texture = over.String("path"), source = over.String("source"), prop = slot, exists = File.Exists(over.String("path")),
                            tint = new Vector3(F(tint, 0), F(tint, 1), F(tint, 2)),
                        };
                }
                else
                {
                    // Still on the pack's texture: its tinted copy is made on the first bake.
                    var current = material.GetTexture(slot);
                    if (!current) continue;
                    string source = AssetDatabase.GetAssetPath(current);
                    bool array = current is Texture2DArray;
                    string copy = GolfMapCourses.Folder(course) + "CTITrial/Textures/" + Path.GetFileNameWithoutExtension(source) + " tinted" + (array ? ".asset" : ".png");
                    if (!targets.TryGetValue(copy, out target))
                        targets[copy] = target = new Target { texture = copy, source = source, prop = slot, array = array, exists = false };
                }
                target.array = target.array || target.texture.EndsWith(".asset", StringComparison.OrdinalIgnoreCase);
                target.materials.Add(to);
                byMaterial[to] = target;
            }
            return byMaterial;
        }

        static float F(List<object> list, int i) { var n = i < list.Count ? list[i] as GolfMapJsonNumber : null; return n != null ? (float)n.Value : 1; }

        public static Target For(GolfMapCourse course, Material m)
        {
            Target t;
            return m && Targets(course).TryGetValue(AssetDatabase.GetAssetPath(m), out t) ? t : null;
        }

        public static Color ToColour(Vector3 tint) { return new Color(ToGamma(tint.x), ToGamma(tint.y), ToGamma(tint.z), 1); }
        public static Vector3 ToTint(Color c) { return new Vector3(ToLinear(c.r), ToLinear(c.g), ToLinear(c.b)); }

        // prepare-cti-maps.py's curves (the exact sRGB pair, in double like numpy), so both bakes agree texel for texel.
        static double ToLinear(double c) { return c <= 0.04045 ? c / 12.92 : Math.Pow((c + 0.055) / 1.055, 2.4); }
        static double ToGamma(double c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.Pow(Math.Max(c, 0), 1 / 2.4) - 0.055; }
        static float ToLinear(float c) { return (float)ToLinear((double)c); }
        static float ToGamma(float c) { return (float)ToGamma((double)c); }

        // ---- source texels ----------------------------------------------------------------

        sealed class Source { public int width, height; public Color32[][] slices; public TextureFormat format; public FilterMode filter; public TextureWrapMode wrap; public int aniso; }
        static readonly Dictionary<string, Source> sources = new Dictionary<string, Source>();

        static Source LoadSource(string path)
        {
            Source s;
            if (sources.TryGetValue(path, out s)) return s;
            var texture = AssetDatabase.LoadAssetAtPath<Texture>(path);
            if (!texture) throw new Exception("No source texture at " + path + ".");
            s = new Source { width = texture.width, height = texture.height, filter = texture.filterMode, wrap = texture.wrapMode, aniso = texture.anisoLevel };
            var array = texture as Texture2DArray;
            if (array)
            {
                s.format = array.format;
                s.slices = Enumerable.Range(0, array.depth).Select(i => array.GetPixels32(i, 0)).ToArray();
            }
            else if (File.Exists(Lossless(path)) && File.GetLastWriteTimeUtc(Lossless(path)) >= File.GetLastWriteTimeUtc(path))
            {
                // prepare-cti-maps.py's untinted copy of the source file: the same texels its bake used.
                s.format = ((Texture2D)texture).format;
                var read = new Texture2D(2, 2, TextureFormat.RGBA32, false, false);
                read.LoadImage(File.ReadAllBytes(Lossless(path)));
                s.width = read.width; s.height = read.height;
                s.slices = new[] { read.GetPixels32() };
                UnityEngine.Object.DestroyImmediate(read);
            }
            else
            {
                // Imported textures are not readable: draw it into an sRGB target and read that back
                // (a linear project samples the sRGB texture as linear and the target encodes it again).
                // That is the DXT-compressed import: prepare-cti-maps.py's lossless copy is better.
                s.format = ((Texture2D)texture).format;
                var rt = RenderTexture.GetTemporary(s.width, s.height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
                var previous = RenderTexture.active;
                Graphics.Blit(texture, rt);
                RenderTexture.active = rt;
                var read = new Texture2D(s.width, s.height, TextureFormat.RGBA32, false, false);
                read.ReadPixels(new Rect(0, 0, s.width, s.height), 0, 0);
                read.Apply();
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
                s.slices = new[] { read.GetPixels32() };
                UnityEngine.Object.DestroyImmediate(read);
            }
            if (sources.Count > 3) sources.Clear();   // a 4K source is 64 MB of texels
            return sources[path] = s;
        }

        static string Lossless(string source)
        {
            return Path.Combine(Path.GetDirectoryName(Application.dataPath), "GolfMapSpelunk/cti-trial/sources/" + Path.GetFileNameWithoutExtension(source) + ".png");
        }

        // ---- baking -------------------------------------------------------------------------

        static readonly Dictionary<string, Color32[][]> baked = new Dictionary<string, Color32[][]>();   // target -> last bake, for Save

        // Bake `tint` into the target and show it: the live texture's GPU copy is replaced, or the
        // target is created (then the trial materials are pointed at it). Returns the live texture.
        public static Texture Bake(GolfMapCourse course, Target target, Vector3 tint, List<string> log)
        {
            var source = LoadSource(target.source);
            var lut = new byte[3][];
            float[] k = { tint.x, tint.y, tint.z };
            for (int c = 0; c < 3; c++)
            {
                lut[c] = new byte[256];
                for (int v = 0; v < 256; v++) lut[c][v] = (byte)Math.Round(Math.Min(1, Math.Max(0, ToGamma(ToLinear(v / 255.0) * k[c]))) * 255);
            }
            var slices = new Color32[source.slices.Length][];
            for (int s = 0; s < slices.Length; s++)
            {
                var from = source.slices[s];
                var to = new Color32[from.Length];
                byte[] r = lut[0], g = lut[1], b = lut[2];
                for (int i = 0; i < from.Length; i++) { var p = from[i]; to[i] = new Color32(r[p.r], g[p.g], b[p.b], p.a); }
                slices[s] = to;
            }
            baked[target.texture] = slices;
            target.tint = tint;
            var live = AssetDatabase.LoadAssetAtPath<Texture>(target.texture);
            if (!live) live = Create(course, target, source, slices, log);
            else if (!Upload(live, slices)) { WriteFile(target); live = AssetDatabase.LoadAssetAtPath<Texture>(target.texture); log.Add("reimported " + target.texture); }
            return live;
        }

        // Each slice, mip-mapped and compressed to the live texture's format, copied into it.
        // False when the formats or sizes do not line up (then the file is written and imported).
        static bool Upload(Texture live, Color32[][] slices)
        {
            var array = live as Texture2DArray;
            var single = live as Texture2D;
            TextureFormat format = array ? array.format : single ? single.format : TextureFormat.RGBA32;
            int depth = array ? array.depth : 1;
            if (depth != slices.Length || !CanCopyInto(format)) return false;
            for (int s = 0; s < depth; s++)
            {
                var slice = Slice(slices[s], live.width, live.height, format);
                if (slice == null) return false;
                int mips = Math.Min(slice.mipmapCount, array ? MipCount(array) : single.mipmapCount);
                for (int m = 0; m < mips; m++) Graphics.CopyTexture(slice, 0, m, live, s, m);
                UnityEngine.Object.DestroyImmediate(slice);
            }
            // Unity 2018.2 copies into a readable array's CPU data but not to the GPU: upload it.
            if (array) { array.Apply(false); EditorUtility.SetDirty(array); }
            return true;
        }

        static bool CanCopyInto(TextureFormat f)
        {
            return f == TextureFormat.DXT5 || f == TextureFormat.DXT1 || f == TextureFormat.RGBA32 || f == TextureFormat.ARGB32 || f == TextureFormat.RGB24 || f == TextureFormat.BC7;
        }

        static int MipCount(Texture2DArray a) { return 1 + (int)Math.Floor(Math.Log(Math.Max(a.width, a.height), 2)); }

        static Texture2D Slice(Color32[] pixels, int width, int height, TextureFormat format)
        {
            if (pixels.Length != width * height) return null;
            var t = new Texture2D(width, height, TextureFormat.RGBA32, true, false);
            t.SetPixels32(pixels);
            t.Apply(true);
            // CompressTexture rewrites the CPU data only: upload it, or a GPU copy from this texture copies stale texels.
            if (format != TextureFormat.RGBA32) { EditorUtility.CompressTexture(t, format, TextureCompressionQuality.Fast); t.Apply(false); }
            return t;
        }

        // First bake of a texture still on the pack's source: a course copy, the trial materials
        // pointed at it, and its override in trial.json (with the tint it now holds).
        static Texture Create(GolfMapCourse course, Target target, Source source, Color32[][] slices, List<string> log)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target.texture));
            Texture live;
            if (target.array)
            {
                var array = new Texture2DArray(source.width, source.height, slices.Length, source.format, true, false)
                { filterMode = source.filter, wrapMode = source.wrap, anisoLevel = source.aniso };
                for (int s = 0; s < slices.Length; s++)
                {
                    var slice = Slice(slices[s], source.width, source.height, source.format);
                    for (int m = 0; m < slice.mipmapCount; m++) Graphics.CopyTexture(slice, 0, m, array, s, m);
                    UnityEngine.Object.DestroyImmediate(slice);
                }
                array.Apply(false);   // see Upload
                AssetDatabase.CreateAsset(array, target.texture);
                live = array;
            }
            else
            {
                WriteFile(target);
                // Import it as the source is imported (sRGB, compression, size, mips).
                var from = (TextureImporter)AssetImporter.GetAtPath(target.source);
                var to = (TextureImporter)AssetImporter.GetAtPath(target.texture);
                if (from && to)
                {
                    var settings = new TextureImporterSettings();
                    from.ReadTextureSettings(settings); to.SetTextureSettings(settings);
                    to.SetPlatformTextureSettings(from.GetDefaultPlatformTextureSettings());
                    foreach (var platform in new[] { "Standalone" }) { var p = from.GetPlatformTextureSettings(platform); if (p.overridden) to.SetPlatformTextureSettings(p); }
                    to.SaveAndReimport();
                }
                live = AssetDatabase.LoadAssetAtPath<Texture>(target.texture);
            }
            var sourceTexture = AssetDatabase.LoadAssetAtPath<Texture>(target.source);
            foreach (var path in target.materials)
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (!m) continue;
                m.SetTexture(target.prop, live);
                EditorUtility.SetDirty(m);
            }
            GolfMapVegLive.Retexture(sourceTexture, live, target.prop);
            target.exists = true;
            Record(course, target);
            AssetDatabase.SaveAssets();
            log.Add("made " + target.texture + " for " + string.Join(", ", target.materials.Select(Path.GetFileNameWithoutExtension).ToArray()));
            return live;
        }

        static void WriteFile(Target target)
        {
            Color32[][] slices;
            if (target.array || !baked.TryGetValue(target.texture, out slices)) return;
            var source = LoadSource(target.source);
            var t = new Texture2D(source.width, source.height, TextureFormat.RGBA32, false, false);
            t.SetPixels32(slices[0]);
            t.Apply();
            File.WriteAllBytes(target.texture, t.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(t);
            AssetDatabase.ImportAsset(target.texture, ImportAssetOptions.ForceUpdate);
        }

        // Save: the texture file (arrays are assets, saved with the project) and the tint in trial.json.
        public static void Save(GolfMapCourse course, Target target, Vector3 tint, List<string> log)
        {
            if (!baked.ContainsKey(target.texture) || target.tint != tint) Bake(course, target, tint, log);
            if (target.array) { var a = AssetDatabase.LoadAssetAtPath<Texture2DArray>(target.texture); if (a) EditorUtility.SetDirty(a); }
            else WriteFile(target);
            Record(course, target);
            log.Add(Path.GetFileName(target.texture));
        }

        // The override on every swap whose trial material samples the target.
        static void Record(GolfMapCourse course, Target target)
        {
            string path = TrialPath(course);
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            foreach (GolfMapJsonObject swap in doc.Array("swaps") ?? new List<object>())
            {
                if (!target.materials.Contains(swap.String("to"))) continue;
                var textures = swap.Array("textures");
                if (textures == null) { textures = new List<object>(); swap["textures"] = textures; }
                var over = textures.Cast<GolfMapJsonObject>().FirstOrDefault(t => t.String("name") == target.prop);
                if (over == null) { over = new GolfMapJsonObject(); textures.Add(over); }
                over.SetString("name", target.prop); over.SetString("path", target.texture); over.SetString("source", target.source);
                over["tint"] = new List<object> { N(target.tint.x), N(target.tint.y), N(target.tint.z) };
            }
            File.WriteAllText(path, GolfMapJsonDoc.Write(doc));
            byMaterial = null;   // re-read on next use
            GolfMapVegSession.TrialWritten();
        }

        static GolfMapJsonNumber N(float v) { return new GolfMapJsonNumber(GolfMapJsonDoc.Format(Math.Round(v, 6))); }
    }
}
