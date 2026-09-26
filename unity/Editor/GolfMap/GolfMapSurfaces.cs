// Surface map of the built course: which OPCD surface is on top at every point
// of a terrain, read from the course meshes themselves.
//
// The app's drawn features are not the whole truth in game: OPCD's Blender step
// fills everything outside the holes with its own Outer_Deep_Sat meshes and adds
// blend strips between surfaces. Rules that depend on "what is the ground here"
// (tall grass on deep rough only, never on tees, fairways, blends ...) therefore
// read this map. Every Spline_* / Gap_Issue_* mesh is classified by its name and
// its triangles are rasterized top-down; where meshes overlap the highest one
// wins, and on a near tie the class that keeps vegetation out wins.
//
// Output next to the course's other exports: <prefix>-<terrain>-surfaces.bin
// (uint8 class per cell, rows north to south) + .json (golfmap-surfaces-v1:
// cell size, terrain origin and size in world metres, class names, counts) and
// a small colour preview PNG. pipeline/grass_zones.py --surfaces reads it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapSurfaces
    {
        public const string Format = "golfmap-surfaces-v1";

        // Codes are the file format; append, never renumber.
        public enum Surface : byte { None = 0, Deep = 1, Rough = 2, Semi = 3, Fairway = 4, Green = 5, Tee = 6, Bunker = 7, Water = 8, Blend = 9, Other = 10 }

        // Tie-break rank: higher keeps vegetation out and wins a near tie.
        static int Rank(Surface s)
        {
            switch (s)
            {
                case Surface.None: return 0;
                case Surface.Deep: return 1;
                case Surface.Rough: return 2;
                default: return 3;
            }
        }

        // Name -> surface, OPCD naming: Spline_<hole_N|others|Outer>_<n>[_pieceK]_<Surface>_-_Mesh,
        // blends "B_<A>_<B>_-_Blend" or "<A>_B_<B>_-_Blend", gap fillers "Gap_Issue_*".
        public static Surface Classify(string name)
        {
            if (name.StartsWith("Gap_Issue", StringComparison.Ordinal)) return Surface.Blend;
            if (name.Contains("_-_Blend") || name.Contains("_B_")) return Surface.Blend;
            if (name.Contains("Water") || name.Contains("Creek") || name.Contains("Lake")) return Surface.Water;
            if (name.Contains("Deep")) return Surface.Deep;
            if (name.Contains("Semi")) return Surface.Semi;
            if (name.Contains("Rough")) return Surface.Rough;
            if (name.Contains("Fairway")) return Surface.Fairway;
            if (name.Contains("Green")) return Surface.Green;
            if (name.Contains("Tee")) return Surface.Tee;
            if (name.Contains("Bunker")) return Surface.Bunker;
            return Surface.Other;
        }

        static bool IsCourseMesh(string name)
        {
            return name.StartsWith("Spline_", StringComparison.Ordinal) || name.StartsWith("Gap_Issue", StringComparison.Ordinal);
        }

        [BridgeCommand("golfmap.surfaces.export", "Rasterize the course meshes (Spline_*, Gap_Issue_*) over a terrain into a surface map: <prefix>-<terrain>-surfaces.bin/.json/-preview.png in the course's export folder. Input of pipeline/grass_zones.py --surfaces.",
            args = "terrain=inner|outer (default inner), cell=0.5 (metres)")]
        static IEnumerator Export(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var role = a.String("terrain", "inner");
            var scene = EditorSceneManager.GetActiveScene();
            var terrain = role == "outer"
                ? GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer")
                : GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
            float cell = Mathf.Clamp((float)a.Number("cell", 0.5), 0.1f, 5f);
            var origin = terrain.transform.position;
            var size = terrain.terrainData.size;
            int w = Mathf.CeilToInt(size.x / cell), h = Mathf.CeilToInt(size.z / cell);
            var height = new float[w * h];
            for (int i = 0; i < height.Length; i++) height[i] = float.NegativeInfinity;
            var cls = new byte[w * h];

            var meshes = UnityEngine.Object.FindObjectsOfType<MeshFilter>()
                .Where(f => f.sharedMesh && f.gameObject.activeInHierarchy && f.gameObject.scene == scene && IsCourseMesh(f.name))
                .ToList();
            var perClassMeshes = new Dictionary<string, int>();
            var others = new List<string>();
            long triangles = 0;
            int done = 0;
            const float tie = 0.02f;
            foreach (var mf in meshes)
            {
                var surface = Classify(mf.name);
                perClassMeshes[surface.ToString()] = (perClassMeshes.ContainsKey(surface.ToString()) ? perClassMeshes[surface.ToString()] : 0) + 1;
                if (surface == Surface.Other && others.Count < 20) others.Add(mf.name);
                var mesh = mf.sharedMesh;
                var local = mesh.vertices;
                var world = new Vector3[local.Length];
                var m = mf.transform.localToWorldMatrix;
                for (int i = 0; i < local.Length; i++) world[i] = m.MultiplyPoint3x4(local[i]);
                var tris = mesh.triangles;
                triangles += tris.Length / 3;
                byte code = (byte)surface;
                int rank = Rank(surface);
                for (int t = 0; t < tris.Length; t += 3)
                {
                    Vector3 p0 = world[tris[t]], p1 = world[tris[t + 1]], p2 = world[tris[t + 2]];
                    // cell space: x east from the terrain's west edge, row 0 at the north edge
                    float x0 = (p0.x - origin.x) / cell, y0 = (origin.z + size.z - p0.z) / cell;
                    float x1 = (p1.x - origin.x) / cell, y1 = (origin.z + size.z - p1.z) / cell;
                    float x2 = (p2.x - origin.x) / cell, y2 = (origin.z + size.z - p2.z) / cell;
                    int cx0 = Mathf.Max(0, Mathf.FloorToInt(Mathf.Min(x0, Mathf.Min(x1, x2)))), cx1 = Mathf.Min(w - 1, Mathf.CeilToInt(Mathf.Max(x0, Mathf.Max(x1, x2))));
                    int cy0 = Mathf.Max(0, Mathf.FloorToInt(Mathf.Min(y0, Mathf.Min(y1, y2)))), cy1 = Mathf.Min(h - 1, Mathf.CeilToInt(Mathf.Max(y0, Mathf.Max(y1, y2))));
                    if (cx0 > cx1 || cy0 > cy1) continue;
                    float det = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
                    if (Mathf.Abs(det) < 1e-9f) continue;
                    for (int cy = cy0; cy <= cy1; cy++)
                    {
                        float py = cy + 0.5f;
                        for (int cx = cx0; cx <= cx1; cx++)
                        {
                            float px = cx + 0.5f;
                            float l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / det;
                            float l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / det;
                            float l2 = 1 - l0 - l1;
                            if (l0 < -1e-5f || l1 < -1e-5f || l2 < -1e-5f) continue;
                            float z = l0 * p0.y + l1 * p1.y + l2 * p2.y;
                            int idx = cy * w + cx;
                            float cur = height[idx];
                            if (z > cur + tie || (z >= cur - tie && rank > Rank((Surface)cls[idx])))
                            {
                                height[idx] = Mathf.Max(z, cur);
                                cls[idx] = code;
                            }
                        }
                    }
                }
                if (++done % 25 == 0) yield return null;   // keep the editor breathing
            }

            var counts = new long[Enum.GetValues(typeof(Surface)).Length];
            foreach (var c in cls) counts[c]++;
            var file = GolfMapCourses.ExportFile(course, role, "surfaces");
            if (file == null) throw new BridgeError("The active course names no export folder/prefix.");
            var bin = Path.ChangeExtension(file, ".bin");
            File.WriteAllBytes(bin, cls);
            // Top mesh height minus terrain height per cell, int16 centimetres (0 where no mesh):
            // where it is positive, anything planted on the terrain (VSP grass) is buried by it.
            var lift = new byte[w * h * 2];
            var td = terrain.terrainData;
            for (int cy = 0; cy < h; cy++)
            {
                for (int cx = 0; cx < w; cx++)
                {
                    int idx = cy * w + cx;
                    if (float.IsNegativeInfinity(height[idx])) continue;
                    float nx = (cx + 0.5f) * cell / size.x, nz = 1f - (cy + 0.5f) * cell / size.z;
                    float ground = td.GetInterpolatedHeight(nx, nz) + origin.y;
                    short cm = (short)Mathf.Clamp(Mathf.RoundToInt((height[idx] - ground) * 100f), short.MinValue, short.MaxValue);
                    lift[idx * 2] = (byte)(cm & 0xff);
                    lift[idx * 2 + 1] = (byte)((cm >> 8) & 0xff);
                }
                if (cy % 512 == 0) yield return null;
            }
            var liftFile = Path.Combine(Path.GetDirectoryName(file), Path.GetFileNameWithoutExtension(file) + "-lift.bin");
            File.WriteAllBytes(liftFile, lift);
            WritePreview(cls, w, h, Path.Combine(Path.GetDirectoryName(file), Path.GetFileNameWithoutExtension(file) + "-preview.png"));
            var classes = Enum.GetValues(typeof(Surface)).Cast<Surface>().ToDictionary(s => ((int)s).ToString(), s => (object)s.ToString().ToLowerInvariant());
            var doc = new Dictionary<string, object>
            {
                { "format", Format },
                { "course", GolfMapCourses.Name(course) },
                { "terrain", role },
                { "terrainObject", terrain.name },
                { "data", Path.GetFileName(bin) },
                { "lift", Path.GetFileName(liftFile) },
                { "liftUnits", "int16 cm, top mesh minus terrain, 0 = no mesh" },
                { "width", w }, { "height", h }, { "cellM", cell },
                { "rowOrder", "north-up" },
                { "worldOrigin", new object[] { origin.x, origin.z } },
                { "sizeM", new object[] { size.x, size.z } },
                { "classes", classes },
                { "counts", Enum.GetValues(typeof(Surface)).Cast<Surface>().ToDictionary(s => s.ToString().ToLowerInvariant(), s => (object)(counts[(int)s] * (double)cell * cell)) },
                { "meshes", perClassMeshes },
                { "triangles", triangles },
                { "unclassified", others },
                { "created", DateTime.Now.ToString("s") },
            };
            File.WriteAllText(file, BridgeJson.Write(doc));
            yield return new Dictionary<string, object>
            {
                { "file", file }, { "size", new object[] { w, h } }, { "meshes", meshes.Count }, { "triangles", triangles },
                { "areaM2", doc["counts"] }, { "unclassified", others },
            };
        }

        static readonly Color32[] Palette =
        {
            new Color32(0, 0, 0, 255),          // none
            new Color32(22, 75, 32, 255),       // deep
            new Color32(39, 132, 56, 255),      // rough
            new Color32(54, 183, 77, 255),      // semi
            new Color32(67, 229, 97, 255),      // fairway
            new Color32(188, 229, 164, 255),    // green
            new Color32(160, 229, 184, 255),    // tee
            new Color32(229, 229, 170, 255),    // bunker
            new Color32(0, 0, 192, 255),        // water
            new Color32(200, 0, 200, 255),      // blend
            new Color32(255, 120, 0, 255),      // other
        };

        static void WritePreview(byte[] cls, int w, int h, string path)
        {
            int step = Mathf.Max(1, Mathf.CeilToInt(Mathf.Max(w, h) / 2048f));
            int pw = w / step, ph = h / step;
            var px = new Color32[pw * ph];
            for (int y = 0; y < ph; y++)
                for (int x = 0; x < pw; x++)
                {
                    // Texture rows go bottom-up; the map's rows go north-down.
                    var c = cls[(y * step) * w + x * step];
                    px[(ph - 1 - y) * pw + x] = c < Palette.Length ? Palette[c] : Palette[10];
                }
            var tex = new Texture2D(pw, ph, TextureFormat.RGB24, false);
            tex.SetPixels32(px);
            tex.Apply();
            File.WriteAllBytes(path, tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
        }
    }
}
