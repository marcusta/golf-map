// Unity 2018.2 / C# 6. Terrain sculpting in Unity, carried back to golf-map.
//
// golf-map owns the heights (the raw lidar plus its vector terrain edits); a
// sculpt in Unity is raw height changes on top. golf-map's "Unity sculpt →
// golf-map" (export kind unity-sculpt) runs golfmap.terrain.capture here and
// stores the result as ONE additive `delta` edit per terrain, replayed after
// every other edit, so it reaches the map, the analysis and every later export.
//
// What a capture measures, per heightmap vertex, in world metres:
//
//   sculpt = current − reference + sculptIn − conform
//
//   reference  the heights golf-map last put onto this terrain
//              (golfmap.terrain.update saves a copy: <course>/Reference/)
//   sculptIn   the sculpt layer that export already contained (gspro.py dem
//              writes it next to the heightmap as <stem>-sculpt-in.raw), so a
//              capture is always the WHOLE layer and replacing the stored one
//              never loses earlier strokes
//   conform    what golfmap.terrain.conform raised under the course meshes
//              (derived, not a sculpt; recorded here by the conform, cleared
//              by the next update, which undoes it)
//
// Differences under `threshold` (default 1 cm) are heightmap quantisation, not
// sculpting. The outer plot's capture leaves out the inner square: the inner
// terrain covers it, and golf-map would carry it into the inner heights.
//
// File grid: the .raw heightmap's — `size`² pixels over the terrain square,
// rows north to south — with vertex (x, z) at column x, row size−1−z; the
// capture is cropped to the changed cells.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    [Serializable]
    public class GolfMapRasterCrop
    {
        public int col0, row0, cols, rows;
    }

    [Serializable]
    public class GolfMapSculptIn
    {
        public string file;
        public int size;
        public GolfMapRasterCrop crop;
        public double maxAbsM;
    }

    [Serializable]
    class GolfMapTerrainReference
    {
        public string terrain;
        public double[] square3006;
        public int size;
        public double sideM;
        public double heightRangeM;
        public float positionY;
        public string sidecar;
        public GolfMapSculptIn sculptIn;   // file = the copy in the Reference folder
        public string saved;
    }

    public static class GolfMapTerrainSculpt
    {
        public const string Format = "golfmap-sculpt-v1";

        // Takes the course folder as a string ("Assets/GolfMap/Vreta/"), worked out
        // before any asset work: saving assets can reload the course asset and
        // leave a held GolfMapCourse reference without a path.
        static string Folder(string courseFolder)
        {
            var folder = courseFolder + "Reference";
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Reference");
            return folder;
        }

        static string Full(string assetPath)
        {
            return Path.Combine(Directory.GetParent(Application.dataPath).FullName, assetPath.Replace('/', Path.DirectorySeparatorChar));
        }

        // ---- the reference (golfmap.terrain.update) ------------------------------

        /// After an update put `sidecar`'s heights onto `terrain`: keep a copy of
        /// those heights, the sidecar facts a capture needs, and the sculpt layer
        /// the export contained; drop the conform record (the update undid it).
        public static void SaveReference(string courseFolder, string kind, Terrain terrain, GolfMapDemSidecar sidecar, string sidecarPath)
        {
            var folder = Folder(courseFolder);
            var heights = folder + "/" + kind + "-heights.asset";
            if (AssetDatabase.LoadAssetAtPath<TerrainData>(heights) != null) AssetDatabase.DeleteAsset(heights);
            if (!AssetDatabase.CopyAsset(AssetDatabase.GetAssetPath(terrain.terrainData), heights))
                throw new BridgeError("Could not keep the reference heights at " + heights + ".");

            var sculptCopy = folder + "/" + kind + "-sculpt-in.bytes";
            GolfMapSculptIn sculptIn = null;
            if (sidecar.sculptIn != null && !string.IsNullOrEmpty(sidecar.sculptIn.file) && sidecar.sculptIn.crop != null && sidecar.sculptIn.crop.cols > 0)
            {
                var src = Path.Combine(Path.GetDirectoryName(sidecarPath), sidecar.sculptIn.file);
                if (!File.Exists(src)) throw new BridgeError("The sidecar names a sculpt layer " + sidecar.sculptIn.file + " that is not in the export folder.");
                File.Copy(src, Full(sculptCopy), true);
                AssetDatabase.ImportAsset(sculptCopy);
                sculptIn = new GolfMapSculptIn { file = Path.GetFileName(sculptCopy), size = sidecar.sculptIn.size, crop = sidecar.sculptIn.crop, maxAbsM = sidecar.sculptIn.maxAbsM };
            }
            else if (File.Exists(Full(sculptCopy))) AssetDatabase.DeleteAsset(sculptCopy);

            var reference = new GolfMapTerrainReference
            {
                terrain = kind, square3006 = sidecar.square3006, size = terrain.terrainData.heightmapResolution,
                sideM = sidecar.sideM, heightRangeM = sidecar.heightRangeM, positionY = terrain.transform.position.y,
                sidecar = Path.GetFileName(sidecarPath), sculptIn = sculptIn, saved = DateTime.Now.ToString("s"),
            };
            File.WriteAllText(Full(folder + "/" + kind + "-reference.json"), JsonUtility.ToJson(reference, true));
            var conform = Full(folder + "/" + kind + "-conform.bytes");
            if (File.Exists(conform)) AssetDatabase.DeleteAsset(folder + "/" + kind + "-conform.bytes");
        }

        // ---- the conform record (golfmap.terrain.conform) ------------------------

        /// Add what a conform raised (heightmap index z·res+x → metres) to the record.
        public static void RecordConform(string courseFolder, string kind, Dictionary<int, float> raised)
        {
            if (raised.Count == 0) return;
            var path = Full(Folder(courseFolder) + "/" + kind + "-conform.bytes");
            var all = ReadConform(path);
            foreach (var kv in raised) { float v; all.TryGetValue(kv.Key, out v); all[kv.Key] = v + kv.Value; }
            using (var w = new BinaryWriter(File.Create(path)))
                foreach (var kv in all) { w.Write(kv.Key); w.Write(kv.Value); }
        }

        static Dictionary<int, float> ReadConform(string path)
        {
            var all = new Dictionary<int, float>();
            if (!File.Exists(path)) return all;
            using (var r = new BinaryReader(File.OpenRead(path)))
                while (r.BaseStream.Position + 8 <= r.BaseStream.Length) { int k = r.ReadInt32(); float v = r.ReadSingle(); all[k] = v; }
            return all;
        }

        // ---- capture ------------------------------------------------------------

        [BridgeCommand("golfmap.terrain.capture", "Measure what was sculpted on a terrain since golf-map last put its heights there (current − the reference golfmap.terrain.update kept + the sculpt layer that export already had − what the terrain conform raised) and write it to the course export folder as <prefix>-<terrain>-sculpt.raw (float32 metres, the heightmap's grid, north-up, cropped) + .json (golfmap-sculpt-v1) for golf-map's 'Unity sculpt → golf-map'. The outer leaves out the inner square. Changes nothing in the scene.",
            args = "terrain=inner|outer, threshold=0.01 (m), dryRun=false (measure, write nothing)")]
        static object CaptureCommand(BridgeArgs a)
        {
            return Capture(a.String("terrain", "inner"), (float)a.Number("threshold", 0.01), a.Bool("dryRun", false));
        }

        public static Dictionary<string, object> Capture(string kind, float threshold, bool dryRun)
        {
            if (kind != "inner" && kind != "outer") throw new BridgeError("terrain must be inner or outer.");
            var course = GolfMapCourses.Require();
            var folder = Folder(GolfMapCourses.Folder(course));
            var refJson = Full(folder + "/" + kind + "-reference.json");
            var refData = AssetDatabase.LoadAssetAtPath<TerrainData>(folder + "/" + kind + "-heights.asset");
            if (!File.Exists(refJson) || refData == null)
                throw new BridgeError("No reference for the " + kind + " terrain: put its heightmap into Unity with golf-map's 'Heightmap → Unity' (golfmap.terrain.update) first, then sculpt.");
            var reference = JsonUtility.FromJson<GolfMapTerrainReference>(File.ReadAllText(refJson));

            var scene = EditorSceneManager.GetActiveScene();
            var terrain = kind == "outer"
                ? GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer")
                : GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
            var td = terrain.terrainData;
            int res = td.heightmapResolution;
            if (res != refData.heightmapResolution || res != reference.size)
                throw new BridgeError("The " + kind + " terrain is " + res + "² but its reference is " + refData.heightmapResolution + "²: put the heightmap into Unity again.");

            var cur = td.GetHeights(0, 0, res, res);
            var refH = refData.GetHeights(0, 0, res, res);
            float curScale = td.size.y, curY = terrain.transform.position.y, refScale = refData.size.y, refY = reference.positionY;
            var conform = ReadConform(Full(folder + "/" + kind + "-conform.bytes"));
            float[] sculptIn = null;
            // JsonUtility never leaves a nested object null: "no layer" reads back as an empty one.
            bool hasIn = reference.sculptIn != null && !string.IsNullOrEmpty(reference.sculptIn.file) && reference.sculptIn.crop != null && reference.sculptIn.crop.cols > 0;
            GolfMapRasterCrop inCrop = hasIn ? reference.sculptIn.crop : null;
            if (inCrop != null)
            {
                var bytes = File.ReadAllBytes(Full(folder + "/" + reference.sculptIn.file));
                if (bytes.Length != inCrop.cols * inCrop.rows * 4) throw new BridgeError("The kept sculpt layer is " + bytes.Length + " bytes, not " + inCrop.cols + "×" + inCrop.rows + " floats.");
                sculptIn = new float[inCrop.cols * inCrop.rows];
                Buffer.BlockCopy(bytes, 0, sculptIn, 0, bytes.Length);
            }

            // The outer's vertices under the inner terrain stay out.
            Rect innerRect = Rect.zero;
            float stepX = td.size.x / (res - 1), stepZ = td.size.z / (res - 1);
            var pos = terrain.transform.position;
            if (kind == "outer")
            {
                var inner = GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
                innerRect = new Rect(inner.transform.position.x, inner.transform.position.z, inner.terrainData.size.x, inner.terrainData.size.z);
            }

            // Layer in raw (north-up) order.
            var layer = new float[res * res];
            int cells = 0, minCol = res, maxCol = -1, minRow = res, maxRow = -1;
            float maxUp = 0, maxDown = 0;
            for (int z = 0; z < res; z++)
            {
                int row = res - 1 - z;
                for (int x = 0; x < res; x++)
                {
                    float d = (cur[z, x] * curScale + curY) - (refH[z, x] * refScale + refY);
                    float c; if (conform.TryGetValue(z * res + x, out c)) d -= c;
                    if (sculptIn != null && x >= inCrop.col0 && x < inCrop.col0 + inCrop.cols && row >= inCrop.row0 && row < inCrop.row0 + inCrop.rows)
                        d += sculptIn[(row - inCrop.row0) * inCrop.cols + (x - inCrop.col0)];
                    if (Mathf.Abs(d) < threshold) continue;
                    if (kind == "outer" && innerRect.Contains(new Vector2(pos.x + x * stepX, pos.z + z * stepZ))) continue;
                    layer[row * res + x] = d;
                    cells++;
                    if (x < minCol) minCol = x; if (x > maxCol) maxCol = x;
                    if (row < minRow) minRow = row; if (row > maxRow) maxRow = row;
                    if (d > maxUp) maxUp = d; if (d < maxDown) maxDown = d;
                }
            }

            float cellArea = (float)(reference.sideM / res) * (float)(reference.sideM / res);
            var crop = cells > 0 ? new GolfMapRasterCrop { col0 = minCol, row0 = minRow, cols = maxCol - minCol + 1, rows = maxRow - minRow + 1 } : null;
            var json = GolfMapCourses.ExportFile(course, kind, "sculpt");
            if (json == null) throw new BridgeError("The course asset names no export folder.");
            var raw = Path.ChangeExtension(json, ".raw");
            if (!dryRun)
            {
                if (crop != null)
                {
                    var data = new float[crop.cols * crop.rows];
                    for (int r = 0; r < crop.rows; r++) Array.Copy(layer, (crop.row0 + r) * res + crop.col0, data, r * crop.cols, crop.cols);
                    var bytes = new byte[data.Length * 4];
                    Buffer.BlockCopy(data, 0, bytes, 0, bytes.Length);
                    File.WriteAllBytes(raw, bytes);
                }
                else if (File.Exists(raw)) File.Delete(raw);
                var doc = new Dictionary<string, object>
                {
                    { "format", Format }, { "terrain", kind }, { "square3006", reference.square3006 }, { "size", res },
                    { "file", crop != null ? Path.GetFileName(raw) : null },
                    { "crop", crop != null ? (object)new Dictionary<string, object> { { "col0", crop.col0 }, { "row0", crop.row0 }, { "cols", crop.cols }, { "rows", crop.rows } } : null },
                    { "dtype", "float32" }, { "byteOrder", "little-endian" }, { "rowOrder", "north-up" },
                    { "cells", cells }, { "areaM2", Math.Round(cells * cellArea) },
                    { "maxRaiseM", Math.Round(maxUp, 3) }, { "maxLowerM", Math.Round(maxDown, 3) },
                    { "thresholdM", threshold }, { "reference", reference.sidecar }, { "captured", DateTime.Now.ToString("s") },
                };
                File.WriteAllText(json, GolfMapJson.Serialize(doc));
            }
            return new Dictionary<string, object>
            {
                { "terrain", terrain.name }, { "dryRun", dryRun }, { "file", dryRun ? null : json },
                { "cells", cells }, { "areaM2", Math.Round(cells * cellArea) },
                { "maxRaiseM", Math.Round(maxUp, 3) }, { "maxLowerM", Math.Round(maxDown, 3) },
                { "conformCellsLeftOut", conform.Count }, { "sculptInKept", sculptIn != null },
                { "referenceFrom", reference.sidecar + " (" + reference.saved + ")" },
            };
        }
    }
}
