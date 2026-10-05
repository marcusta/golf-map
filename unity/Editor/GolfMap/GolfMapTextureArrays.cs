// Unity 2018.2 / C# 6. OPCD MAHS texture arrays with slices of our own appended. The `OPCD 4 color Vert Paint MAHS`
// shader draws every channel from three shared arrays (_DetailArray: albedo at DetailIndex and its MAHS map - metallic,
// AO, height, smoothness - at DetailIndex + 1; _NormalArray at DetailIndex / 2; _BaseArray), so a texture OPCD does not
// ship reaches a channel only as a new slice of a copy of the array. Every original slice is copied unchanged (the
// other channels keep drawing OPCD's grass) and the new ones go after them; the copy is saved under a path that
// carries a content key, so a run with the same inputs loads it instead of building it again (2048 x 2048 DXT5 slices:
// a copy of OPCD's detail array is ~220 MB).
//   GolfMapWallGround   the exposed rock of a wall's face (one albedo + flat MAHS pair, one normal)
//   GolfMapPathMaterials the path surfaces (one pair + normal per surface; MAHS green/blue from the AO/height maps)
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    internal static class GolfMapTextureArrays
    {
        // One slice to append. texture: drawn in (scaled to the array's size). No texture: `flat` everywhere - cleared on
        // the GPU, or with `green`/`blue` set composed on the CPU from flat's bytes with those textures' red written into
        // G / B as stored in their files (a MAHS map: AO in G, height in B). linear: the render target's read/write -
        // sRGB for colour (the bytes come out as the file has them), linear for normals and data.
        internal sealed class Layer
        {
            public Texture2D texture, green, blue;
            public Color flat;
            public bool linear;
        }

        // `source` with `layers` appended (layer i at slice source.depth + i), saved at `path`; when an array is already
        // saved there it comes back as it is. linearArray: the copy samples its bytes without sRGB decoding (OPCD's own
        // arrays do, colour slices included; keep it equal to the source's when other channels still draw its slices).
        public static Texture2DArray Extend(Texture2DArray source, IList<Layer> layers, bool linearArray, string path, string name)
        {
            var saved = AssetDatabase.LoadAssetAtPath<Texture2DArray>(path);
            if (saved != null) return saved;
            // CopyTexture updates CPU backing storage too when both arrays are readable. Apply uploads it;
            // without that upload editor appearance and the asset saved for GSPro can disagree.
            var result = new Texture2DArray(source.width, source.height, source.depth + layers.Count, source.format, true, linearArray);
            result.name = name;
            result.wrapMode = TextureWrapMode.Repeat; result.filterMode = FilterMode.Trilinear; result.anisoLevel = 8;
            try
            {
                for (int i = 0; i < source.depth; i++)
                    Graphics.CopyTexture(source, i, result, i);
                for (int i = 0; i < layers.Count; i++) CopySlice(layers[i], result, source.depth + i);
                result.Apply(false, false);
                AssetDatabase.CreateAsset(result, path);
                return result;
            }
            catch { UnityEngine.Object.DestroyImmediate(result); throw; }
        }

        static void CopySlice(Layer layer, Texture2DArray target, int slice)
        {
            var rt = RenderTexture.GetTemporary(target.width, target.height, 0, RenderTextureFormat.ARGB32,
                layer.linear ? RenderTextureReadWrite.Linear : RenderTextureReadWrite.sRGB);
            var old = RenderTexture.active;
            var tex = new Texture2D(target.width, target.height, TextureFormat.RGBA32, true, layer.linear);
            try
            {
                if (layer.texture == null && (layer.green != null || layer.blue != null))
                {
                    // Bytes, not colours: a GL clear of a linear target in a linear project would not write flat's bytes.
                    var px = Enumerable.Repeat((Color32)layer.flat, target.width * target.height).ToArray();
                    if (layer.green != null) { var g = Bytes(layer.green, target.width, target.height); for (int i = 0; i < px.Length; i++) px[i].g = g[i].r; }
                    if (layer.blue != null) { var b = Bytes(layer.blue, target.width, target.height); for (int i = 0; i < px.Length; i++) px[i].b = b[i].r; }
                    tex.SetPixels32(px);
                }
                else
                {
                    RenderTexture.active = rt;
                    if (layer.texture == null) GL.Clear(false, true, layer.flat);
                    else Graphics.Blit(layer.texture, rt);
                    tex.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0);
                }
                tex.Apply(true, false);
                EditorUtility.CompressTexture(tex, target.format, TextureCompressionQuality.Normal);
                tex.Apply(false, false);
                for (int mip = 0; mip < tex.mipmapCount; mip++) Graphics.CopyTexture(tex, 0, mip, target, slice, mip);
            }
            finally { RenderTexture.active = old; RenderTexture.ReleaseTemporary(rt); UnityEngine.Object.DestroyImmediate(tex); }
        }

        // A texture's pixels as its file stores them, scaled to w x h: drawn through a target with the read/write its
        // import samples with (an sRGB import is decoded on read and encoded again on write).
        public static Color32[] Bytes(Texture2D t, int w, int h)
        {
            var imp = AssetImporter.GetAtPath(AssetDatabase.GetAssetPath(t)) as TextureImporter;
            bool srgb = imp == null || imp.sRGBTexture;
            var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, srgb ? RenderTextureReadWrite.sRGB : RenderTextureReadWrite.Linear);
            var old = RenderTexture.active;
            var tex = new Texture2D(w, h, TextureFormat.RGBA32, false, !srgb);
            try
            {
                Graphics.Blit(t, rt);
                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply(false, false);
                return tex.GetPixels32();
            }
            finally { RenderTexture.active = old; RenderTexture.ReleaseTemporary(rt); UnityEngine.Object.DestroyImmediate(tex); }
        }

        // The mean of a texture's stored bytes (0-1 per channel): what a linear MAHS array samples on average.
        public static Color MeanBytes(Texture2D t)
        {
            if (t == null) return Color.white;
            var px = Bytes(t, 64, 64);
            double r = 0, g = 0, b = 0, a = 0;
            foreach (var p in px) { r += p.r; g += p.g; b += p.b; a += p.a; }
            double n = px.Length * 255.0;
            return new Color((float)(r / n), (float)(g / n), (float)(b / n), (float)(a / n));
        }

        // The mean of one slice of a readable array (its smallest mip); null when the array is not readable.
        public static Color? MeanSlice(Texture2DArray array, int slice)
        {
            try
            {
                int mips = Mathf.Max(1, (int)Math.Log(Math.Max(array.width, array.height), 2) + 1);
                var px = array.GetPixels(slice, Math.Max(0, mips - 3));
                if (px.Length == 0) return null;
                float r = 0, g = 0, b = 0;
                foreach (var p in px) { r += p.r; g += p.g; b += p.b; }
                return new Color(r / px.Length, g / px.Length, b / px.Length, 1);
            }
            catch (Exception) { return null; }
        }

        // A short stable key for a set of assets' contents (their import dependency hashes) and settings.
        public static string Key(IEnumerable<string> parts)
        {
            var text = string.Join("|", parts.ToArray());
            using (var md5 = System.Security.Cryptography.MD5.Create())
                return string.Concat(md5.ComputeHash(System.Text.Encoding.UTF8.GetBytes(text)).Select(b => b.ToString("x2")).ToArray());
        }

        public static string Hash(string assetPath)
        {
            return string.IsNullOrEmpty(assetPath) ? "-" : AssetDatabase.GetAssetDependencyHash(assetPath).ToString();
        }
    }
}
