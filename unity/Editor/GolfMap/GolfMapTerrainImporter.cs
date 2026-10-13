// Builds the two GSPro terrains from a golf-map export folder in one go.
// Menu: GolfMap > Terrain Importer. See unity/README.md.
//
// Point it at the folder the app's "Export to GSPro" panel writes into. It
// reads the `.tif.json` sidecars `gspro.py dem` leaves next to each heightmap
// (course, terrain kind, square, height range, Unity settings) and does what
// the OPCD "LIDAR to TERRAIN" manual has you do by hand in Unity:
//
//   - copies the .raw heightmaps and the overlay JPEGs into
//     Assets/<backup folder>/<course>/ and sets each overlay's Max Size to 8192
//   - creates Terrain (Inner) and Plot (Outer): Terrain Width/Length = the
//     square's side, Terrain Height = max - min, heightmap 4097, the RAW read
//     as 16-bit little-endian ("Windows") and flipped vertically
//   - paints the picked overlay as the terrain's texture, tiled to the
//     terrain's size
//   - places the outer plot from the sidecar's Unity position (x/z half the
//     side difference to the south-west, y the difference in minima), lowered
//     by a small sink so no outer ground pokes through the inner
//
// Nothing here is course-specific: file names come from the sidecars, so any
// course exported by the app imports the same way.
//
// Coordinates: the inner terrain sits at the origin with x = east and
// z = north, the convention the Tree Planter and the app's unity-trees files
// assume.
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
    // ---- sidecar (gspro.py dem writes it; JsonUtility reads it) -------------

    [Serializable]
    public class GolfMapDemSidecar
    {
        public string crs;
        public string terrain;          // "inner" | "outer" | null
        public double[] square3006;     // x0, y0, x1, y1
        public double[] centre3006;
        public double sideM;
        public double resolution;
        public int size;
        public double minM;
        public double maxM;
        public double heightRangeM;
        public string source;
        public GolfMapRawInfo raw;
        public GolfMapUnityInfo unity;
        public GolfMapSculptIn sculptIn;  // the Unity sculpt layer this heightmap contains (GolfMapTerrainSculpt)
    }

    [Serializable]
    public class GolfMapRawInfo
    {
        public string file;
        public int size;
        public string dtype;
        public string byteOrder;
        public string rowOrder;
    }

    [Serializable]
    public class GolfMapUnityInfo
    {
        public double terrainWidthM;
        public double terrainLengthM;
        public double terrainHeightM;
        public int heightmapResolution;
        public int depth;
        public string byteOrder;
        public bool flipVertically;
        public GolfMapUnityPosition position;
    }

    [Serializable]
    public class GolfMapUnityPosition
    {
        public double x;
        public double y;
        public double z;
        public string innerSidecar;
    }

    public class GolfMapTerrainImporter : EditorWindow
    {
        const string kInnerName = "Terrain (Inner)";
        const string kOuterName = "Plot (Outer)";
        const int kOverlayMaxSize = 8192;

        [SerializeField] string folder = "";
        [SerializeField] string backupFolder = "Terrain Backup";
        [SerializeField] bool importOuter = true;
        [SerializeField] float outerSinkM = 0.5f;
        [SerializeField] bool replaceExisting = true;
        [SerializeField] int innerOverlayIndex;
        [SerializeField] int outerOverlayIndex;

        // What Scan found.
        class Found
        {
            public string sidecarPath;
            public GolfMapDemSidecar sidecar;
            public string rawPath;
            public List<string> overlays = new List<string>();
        }

        Found inner, outer;
        string courseSlug = "";
        string status = "";
        Vector2 scroll;

        [MenuItem("GolfMap/Terrain Importer")]
        public static void Open() => GetWindow<GolfMapTerrainImporter>("GolfMap Terrains");

        void OnGUI()
        {
            scroll = EditorGUILayout.BeginScrollView(scroll);

            EditorGUILayout.LabelField("Export folder", EditorStyles.boldLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                folder = EditorGUILayout.TextField("Folder", folder);
                if (GUILayout.Button("...", GUILayout.Width(30)))
                {
                    var picked = EditorUtility.OpenFolderPanel("golf-map GSPro export folder", folder, "");
                    if (!string.IsNullOrEmpty(picked)) { folder = picked; Scan(); }
                }
            }
            if (GUILayout.Button("Scan folder")) Scan();
            EditorGUILayout.HelpBox("The folder the golf-map app's Export to GSPro panel writes into. It needs the inner heightmap export (<course>-inner-dem-<side>m.raw + .tif.json) and, for the outer plot, the outer one; overlays are the <course>-...-8192.jpg files.", MessageType.None);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Found", EditorStyles.boldLabel);
            DrawFound("Inner", inner, ref innerOverlayIndex);
            DrawFound("Outer", outer, ref outerOverlayIndex);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Import", EditorStyles.boldLabel);
            backupFolder = EditorGUILayout.TextField("Assets subfolder", backupFolder);
            importOuter = EditorGUILayout.Toggle("Import outer plot", importOuter);
            outerSinkM = EditorGUILayout.FloatField("Outer sink (m)", outerSinkM);
            replaceExisting = EditorGUILayout.Toggle("Replace existing terrains", replaceExisting);
            EditorGUILayout.HelpBox("The outer plot is placed from the sidecar and then lowered by the sink so its ground never shows through the inner terrain (the manual's 'lower the Y value until no blue shows').", MessageType.None);

            EditorGUILayout.Space();
            using (new EditorGUI.DisabledScope(inner == null))
                if (GUILayout.Button("Import terrains")) Import();
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.Info);

            EditorGUILayout.EndScrollView();
        }

        void DrawFound(string label, Found f, ref int overlayIndex)
        {
            if (f == null)
            {
                EditorGUILayout.LabelField(label, "not found");
                return;
            }
            var sc = f.sidecar;
            EditorGUILayout.LabelField(label, $"{sc.sideM:0} m square, {sc.minM:0.00}..{sc.maxM:0.00} m, raw {Path.GetFileName(f.rawPath)}");
            if (f.overlays.Count == 0)
            {
                EditorGUILayout.LabelField("  overlay", "none (terrain will have no texture)");
            }
            else
            {
                var names = f.overlays.Select(Path.GetFileName).ToArray();
                overlayIndex = Mathf.Clamp(overlayIndex, 0, names.Length - 1);
                overlayIndex = EditorGUILayout.Popup("  overlay", overlayIndex, names);
            }
        }

        // ---- scanning ------------------------------------------------------

        void Scan()
        {
            inner = outer = null;
            courseSlug = "";
            status = "";
            try
            {
                if (!Directory.Exists(folder)) throw new Exception("folder does not exist");
                foreach (var sidecarPath in Directory.GetFiles(folder, "*.tif.json"))
                {
                    var sc = JsonUtility.FromJson<GolfMapDemSidecar>(File.ReadAllText(sidecarPath));
                    if (sc == null || sc.sideM <= 0 || sc.raw == null || string.IsNullOrEmpty(sc.raw.file)) continue;
                    var name = Path.GetFileName(sidecarPath);
                    var kind = sc.terrain;
                    if (string.IsNullOrEmpty(kind)) kind = name.Contains("-outer-") ? "outer" : name.Contains("-inner-") ? "inner" : null;
                    if (kind == null) continue;
                    var rawPath = Path.Combine(folder, sc.raw.file);
                    if (!File.Exists(rawPath)) { Debug.LogWarning($"[GolfMap] {name}: raw file {sc.raw.file} missing, skipped"); continue; }
                    var f = new Found { sidecarPath = sidecarPath, sidecar = sc, rawPath = rawPath };
                    if (kind == "inner") inner = f; else outer = f;
                    var marker = $"-{kind}-dem-";
                    var at = name.IndexOf(marker, StringComparison.Ordinal);
                    if (at > 0 && string.IsNullOrEmpty(courseSlug)) courseSlug = name.Substring(0, at);
                }
                if (inner == null && outer == null) throw new Exception("no heightmap sidecar (*.tif.json with a raw entry) in the folder — export the inner heightmap from the app first");

                // Overlays: the exported JPEGs. Outer ones carry "-outer-". The
                // "-terrain" twins (darkened for the terrain shader) come first,
                // patched photos before pristine, then the "-meshes" variants
                // and hillshades last, so the default pick is the one meant for
                // the terrain. For the OUTER that is its "-meshes" variant: the
                // export makes it as dark as the twin with the green colouring
                // on top and softened, so it goes first there; the inner's is
                // lifted by its tint for the course meshes and stays a comparison.
                var jpgs = Directory.GetFiles(folder, "*.jpg")
                    .OrderBy(p => p.Contains("-hillshade-"))
                    .ThenBy(p => p.EndsWith("-meshes.jpg", StringComparison.OrdinalIgnoreCase) != Path.GetFileName(p).Contains("-outer-"))
                    .ThenBy(p => !p.EndsWith("-terrain.jpg", StringComparison.OrdinalIgnoreCase))
                    .ThenBy(p => !p.Contains("-patched-"))
                    .ThenBy(p => p).ToList();
                foreach (var jpg in jpgs)
                {
                    var name = Path.GetFileName(jpg);
                    if (!string.IsNullOrEmpty(courseSlug) && !name.StartsWith(courseSlug + "-", StringComparison.Ordinal)) continue;
                    if (name.Contains("-outer-")) { if (outer != null) outer.overlays.Add(jpg); }
                    else if (inner != null) inner.overlays.Add(jpg);
                }
                innerOverlayIndex = 0;
                outerOverlayIndex = 0;
                status = $"Course '{courseSlug}': inner {(inner != null ? "found" : "missing")}, outer {(outer != null ? "found" : "missing")}.";
                if (outer != null && (outer.sidecar.unity == null || outer.sidecar.unity.position == null || string.IsNullOrEmpty(outer.sidecar.unity.position.innerSidecar)))
                    status += " The outer sidecar has no Unity position (inner exported after it?); it will be computed from both sidecars.";
            }
            catch (Exception e)
            {
                status = $"Scan failed: {e.Message}";
                Debug.LogError($"[GolfMap] {status}");
            }
        }

        // ---- importing -----------------------------------------------------

        void Import()
        {
            try
            {
                if (inner == null) throw new Exception("no inner heightmap found — scan a folder first");
                var assetsFolder = EnsureFolder("Assets", backupFolder, string.IsNullOrEmpty(courseSlug) ? "course" : courseSlug);

                var innerTerrain = BuildTerrain(inner, kInnerName, "Inner", assetsFolder, innerOverlayIndex);
                innerTerrain.transform.position = Vector3.zero;
                var report = $"{kInnerName}: {inner.sidecar.sideM:0} m, height {inner.sidecar.heightRangeM:0.00} m.";

                if (importOuter && outer != null)
                {
                    var outerTerrain = BuildTerrain(outer, kOuterName, "Outer", assetsFolder, outerOverlayIndex);
                    var pos = OuterPosition(inner.sidecar, outer.sidecar);
                    pos.y -= outerSinkM;
                    outerTerrain.transform.position = pos;
#if !UNITY_2019_2_OR_NEWER
                    // The outer overlay is graded for this material: the Standard one adds a pale sky sheen at low angles.
                    outerTerrain.GetComponent<Terrain>().materialType = Terrain.MaterialType.BuiltInLegacyDiffuse;
#endif
                    report += $"\n{kOuterName}: {outer.sidecar.sideM:0} m, height {outer.sidecar.heightRangeM:0.00} m, at ({pos.x:0.###}, {pos.y:0.###}, {pos.z:0.###}) incl. {outerSinkM} m sink.";
                }
                else if (importOuter)
                {
                    report += "\nNo outer heightmap in the folder; only the inner terrain was created.";
                }

                AssetDatabase.SaveAssets();
                status = report + $"\nAssets in {assetsFolder}.";
                Debug.Log($"[GolfMap] {status}");
            }
            catch (Exception e)
            {
                status = $"Import failed: {e.Message}";
                Debug.LogException(e);
            }
        }

        GameObject BuildTerrain(Found f, string objectName, string kindLabel, string assetsFolder, int overlayIndex)
        {
            var sc = f.sidecar;
            var slug = string.IsNullOrEmpty(courseSlug) ? "course" : courseSlug;

            // Files into the project, like the manual's drag into Terrain Backup.
            var rawAsset = CopyIn(f.rawPath, assetsFolder);
            CopyIn(f.sidecarPath, assetsFolder);
            Texture2D overlay = null;
            if (overlayIndex >= 0 && overlayIndex < f.overlays.Count)
            {
                var jpgAsset = CopyIn(f.overlays[overlayIndex], assetsFolder);
                overlay = ImportOverlay(jpgAsset);
            }

            // The existing object, if any.
            var existing = GameObject.Find(objectName);
            if (existing != null)
            {
                if (!replaceExisting) throw new Exception($"'{objectName}' already exists in the scene (tick Replace existing terrains)");
                Undo.DestroyObjectImmediate(existing);
            }

            // TerrainData from the RAW: 16-bit little-endian, north-up rows,
            // flipped so row 0 of the file lands at the terrain's far (north) edge.
            int res = sc.raw.size > 0 ? sc.raw.size : sc.unity.heightmapResolution;
            var heights = ReadRaw(rawAsset, res);
            var data = new TerrainData();
            data.heightmapResolution = res;
            data.size = new Vector3((float)sc.sideM, (float)sc.heightRangeM, (float)sc.sideM);
            data.SetHeights(0, 0, heights);

            var dataPath = $"{assetsFolder}/{slug}_Lidar_{kindLabel}.asset";
            if (AssetDatabase.LoadAssetAtPath<TerrainData>(dataPath) != null) AssetDatabase.DeleteAsset(dataPath);
            AssetDatabase.CreateAsset(data, dataPath);

            if (overlay != null) PaintOverlay(data, overlay, (float)sc.sideM, $"{assetsFolder}/{slug}_{kindLabel}_overlay.terrainlayer");

            var go = Terrain.CreateTerrainGameObject(data);
            go.name = objectName;
            Undo.RegisterCreatedObjectUndo(go, "Import GSPro terrain");
            return go;
        }

        static float[,] ReadRaw(string assetPath, int res)
        {
            var bytes = File.ReadAllBytes(assetPath);
            long expected = (long)res * res * 2;
            if (bytes.Length != expected) throw new Exception($"{Path.GetFileName(assetPath)} is {bytes.Length} bytes, expected {expected} for a {res}x{res} 16-bit heightmap");
            var heights = new float[res, res];
            const float scale = 1f / 65535f;
            int i = 0;
            for (int row = 0; row < res; row++)
            {
                int y = res - 1 - row;  // Flip Vertically: file row 0 is north = terrain z max
                for (int x = 0; x < res; x++, i += 2)
                    heights[y, x] = (bytes[i] | (bytes[i + 1] << 8)) * scale;
            }
            return heights;
        }

        static Texture2D ImportOverlay(string assetPath)
        {
            var importer = AssetImporter.GetAtPath(assetPath) as TextureImporter;
            if (importer == null) throw new Exception($"{assetPath} did not import as a texture");
            // Max Size 8192 as the manual says; high-quality compression because
            // the darkened terrain twin has little tonal range and default DXT
            // quality bands on it.
            if (importer.maxTextureSize != kOverlayMaxSize || importer.textureCompression != TextureImporterCompression.CompressedHQ)
            {
                importer.maxTextureSize = kOverlayMaxSize;
                importer.textureCompression = TextureImporterCompression.CompressedHQ;
                importer.SaveAndReimport();
            }
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(assetPath);
            if (tex == null) throw new Exception($"could not load {assetPath}");
            return tex;
        }

        static void PaintOverlay(TerrainData data, Texture2D overlay, float sideM, string layerPath)
        {
#if UNITY_2018_3_OR_NEWER
            var layer = new TerrainLayer { diffuseTexture = overlay, tileSize = new Vector2(sideM, sideM), tileOffset = Vector2.zero };
            if (AssetDatabase.LoadAssetAtPath<TerrainLayer>(layerPath) != null) AssetDatabase.DeleteAsset(layerPath);
            AssetDatabase.CreateAsset(layer, layerPath);
            data.terrainLayers = new[] { layer };
#else
            // Unity 2018.2 (the OPCD base project): splat prototypes, texture tiled to the terrain size.
            var proto = new SplatPrototype { texture = overlay, tileSize = new Vector2(sideM, sideM), tileOffset = Vector2.zero };
            data.splatPrototypes = new[] { proto };
#endif
        }

        /// The outer plot's position with the inner at the origin: the
        /// sidecar's value when gspro.py computed it, else the same formula
        /// from the two sidecars (shared centre, own minima).
        static Vector3 OuterPosition(GolfMapDemSidecar innerSc, GolfMapDemSidecar outerSc)
        {
            var p = outerSc.unity != null ? outerSc.unity.position : null;
            if (p != null && !string.IsNullOrEmpty(p.innerSidecar))
                return new Vector3((float)p.x, (float)p.y, (float)p.z);
            double offset = -(outerSc.sideM - innerSc.sideM) / 2.0;
            double dx = 0, dz = 0;
            if (innerSc.square3006 != null && outerSc.square3006 != null && innerSc.square3006.Length == 4 && outerSc.square3006.Length == 4)
            {
                dx = (innerSc.square3006[0] + innerSc.square3006[2]) / 2.0 - (outerSc.square3006[0] + outerSc.square3006[2]) / 2.0;
                dz = (innerSc.square3006[1] + innerSc.square3006[3]) / 2.0 - (outerSc.square3006[1] + outerSc.square3006[3]) / 2.0;
            }
            return new Vector3((float)(offset - dx), (float)(outerSc.minM - innerSc.minM), (float)(offset - dz));
        }

        // ---- updating the heights in place (golf-map's "Heightmap -> Unity") ----

        // Import above builds the terrains; this refreshes them after a new
        // heightmap export (terrain edits, digs) without replacing anything:
        // the same Terrain objects and TerrainData assets, so the VSP systems,
        // tree storage and scene references to them stay intact. Each terrain's
        // TerrainData is backed up to <course>/Backups/ first
        // (golfmap.terrain.restore puts the heights back). The overlay texture
        // is left alone. A previous golfmap.terrain.conform is undone by this:
        // re-run it once the course meshes are rebuilt from the new terrain.

        [MenuItem("GolfMap/Terrain/Update heights from export")]
        static void UpdateMenu() { Debug.Log("[GolfMap] " + GolfMapJson.Serialize(UpdateHeights("both", null, float.NaN, false), false)); }

        [BridgeCommand("golfmap.terrain.update", "Put the course export folder's heightmaps (<prefix>-<terrain>-dem-<side>m.raw + .tif.json, what golf-map's heightmap export writes) onto the scene's existing terrains in place: heights, size and resolution from the sidecar, the outer plot re-placed from the two sidecars, lowered by the sink it has now (or outerSink). Backs up each TerrainData to <course>/Backups/ first, refreshes VSP. Keeps the objects, their data assets and the overlay. Undoes a terrain conform.",
            args = "terrain=inner|outer|both (default both; both skips an outer the folder lacks), folder (default: the active course's export folder), outerSink (m below its sidecar position; default: keep the plot's current sink), dryRun=false, " + GolfMapSceneSave.Arg)]
        static object UpdateCommand(BridgeArgs a)
        {
            return GolfMapSceneSave.After(a, UpdateHeights(a.String("terrain", "both"), a.String("folder"), (float)a.Number("outerSink", double.NaN), a.Bool("dryRun", false)));
        }

        // The course meshes' satellite (OPCD MAHS _Satellite) and the Stix grass colour map (_ColorMap) are a copy of the
        // export's -meshes JPEG somewhere in the project, imported once by hand or by the Terrain Importer. A re-export
        // (e.g. with the pipeline's bunker edge fill) reaches the course only when that copy is overwritten in place:
        // same file, same GUID, so every material keeps pointing at it.
        [BridgeCommand("golfmap.orthos.update", "Copy the course export folder's orthophoto JPEGs (<prefix>-*<match>, default the -meshes textures the course meshes and the Stix grass sample) over the project's copies of the same file name, in place (same GUID: materials keep their reference), each old file backed up to GolfMapSpelunk/ortho-backups/ first, then reimported. Files with no copy in the project are listed, not added.",
            args = "match=-meshes.jpg (file name ending), folder (default: the active course's export folder), dryRun=false, " + GolfMapSceneSave.Arg)]
        static object OrthosUpdateCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var folder = a.String("folder");
            if (string.IsNullOrEmpty(folder))
            {
                if (string.IsNullOrEmpty(course.exportFolder)) throw new BridgeError("The course asset names no export folder; pass folder.");
                folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            }
            folder = Path.GetFullPath(folder);
            if (!Directory.Exists(folder)) throw new BridgeError("No export folder " + folder + ".");
            var match = a.String("match", "-meshes.jpg");
            bool dryRun = a.Bool("dryRun", false);
            var root = Directory.GetParent(Application.dataPath).FullName;
            var backupDir = Path.Combine(root, "GolfMapSpelunk", "ortho-backups");
            var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
            var rows = new List<object>();
            foreach (var src in Directory.GetFiles(folder, course.exportPrefix + "-*.jpg").Where(p => p.EndsWith(match, StringComparison.OrdinalIgnoreCase)).OrderBy(p => p))
            {
                var name = Path.GetFileName(src);
                var copies = AssetDatabase.FindAssets(Path.GetFileNameWithoutExtension(name) + " t:Texture2D")
                    .Select(AssetDatabase.GUIDToAssetPath).Distinct()
                    .Where(p => string.Equals(Path.GetFileName(p), name, StringComparison.OrdinalIgnoreCase)).ToList();
                var row = new Dictionary<string, object> { { "file", name }, { "export", File.GetLastWriteTime(src).ToString("yyyy-MM-dd HH:mm") } };
                if (copies.Count == 0) { row["status"] = "no copy in the project (import it with the Terrain Importer or by hand)"; rows.Add(row); continue; }
                var updated = new List<object>();
                foreach (var assetPath in copies)
                {
                    updated.Add(assetPath + " (" + ReplaceOrthoInPlace(src, assetPath, root, backupDir, stamp, dryRun) + ")");
                }
                row["copies"] = updated;
                rows.Add(row);
            }
            if (!dryRun) SceneView.RepaintAll();
            return GolfMapSceneSave.After(a, new Dictionary<string, object> { { "folder", folder }, { "match", match }, { "dryRun", dryRun }, { "files", rows } });
        }

        // Overwrites the project texture at assetPath with the file src, keeping the asset (same GUID); the old file
        // goes to backupDir under its own name first. Returns what happened, for the report.
        static string ReplaceOrthoInPlace(string src, string assetPath, string root, string backupDir, string stamp, bool dryRun)
        {
            var full = Path.Combine(root, assetPath.Replace('/', Path.DirectorySeparatorChar));
            bool same = new FileInfo(full).Length == new FileInfo(src).Length && File.ReadAllBytes(full).SequenceEqual(File.ReadAllBytes(src));
            if (same) return "already the export";
            if (dryRun) return "would be replaced";
            Directory.CreateDirectory(backupDir);
            var backup = Path.Combine(backupDir, Path.GetFileNameWithoutExtension(assetPath) + "-" + stamp + ".jpg");
            File.Copy(full, backup, true);
            File.Copy(src, full, true);
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport | ImportAssetOptions.ForceUpdate);
            return "backup " + backup.Substring(root.Length + 1).Replace('\\', '/');
        }

        // orthos.update only reaches a project copy of the SAME file name. An export from another source (the patched
        // photo, the cleaned one) has its own name, so this one takes the export file by name and puts it onto the
        // texture the scene's course meshes sample, whatever that asset is called.
        [BridgeCommand("golfmap.orthos.apply", "Put one orthophoto JPEG of the course export folder (file) onto the texture the scene's course meshes sample as _Satellite, in place (same GUID: the MAHS materials and the Stix colour map on the same asset keep their reference), the old file backed up to GolfMapSpelunk/ortho-backups/ first, then reimported. The project asset keeps its own file name. With several satellite textures in the scene, pass target.",
            args = "file (a .jpg in the export folder, e.g. <prefix>-<collection>-patched-clean-8192-meshes.jpg), target (project asset path; default: the one _Satellite texture the scene's renderers use), folder (default: the active course's export folder), dryRun=false, " + GolfMapSceneSave.Arg)]
        static object OrthosApplyCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var folder = a.String("folder");
            if (string.IsNullOrEmpty(folder))
            {
                if (string.IsNullOrEmpty(course.exportFolder)) throw new BridgeError("The course asset names no export folder; pass folder.");
                folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            }
            folder = Path.GetFullPath(folder);
            var file = a.String("file");
            if (string.IsNullOrEmpty(file) || file != Path.GetFileName(file) || !file.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase))
                throw new BridgeError("file must be the name of a .jpg in the export folder.");
            var src = Path.Combine(folder, file);
            if (!File.Exists(src)) throw new BridgeError("No " + file + " in " + folder + ".");
            bool dryRun = a.Bool("dryRun", false);

            // The satellite textures in use, by how many renderers sample each.
            var users = new Dictionary<string, int>();
            foreach (var r in UnityEngine.Object.FindObjectsOfType<Renderer>())
                foreach (var m in r.sharedMaterials)
                {
                    if (m == null || !m.HasProperty("_Satellite")) continue;
                    var p = AssetDatabase.GetAssetPath(m.GetTexture("_Satellite"));
                    if (string.IsNullOrEmpty(p)) continue;
                    int n; users.TryGetValue(p, out n); users[p] = n + 1;
                }
            var listed = string.Join("; ", users.OrderByDescending(u => u.Value).Select(u => u.Key + " (" + u.Value + " renderers)").ToArray());
            var target = a.String("target");
            if (string.IsNullOrEmpty(target))
            {
                if (users.Count == 0) throw new BridgeError("No renderer in the scene has a material with a _Satellite texture; pass target.");
                if (users.Count > 1) throw new BridgeError("The scene's meshes sample " + users.Count + " satellite textures; pass target: " + listed + ".");
                target = users.Keys.First();
            }
            else if (AssetDatabase.LoadAssetAtPath<Texture2D>(target) == null) throw new BridgeError("No texture at " + target + ".");

            var root = Directory.GetParent(Application.dataPath).FullName;
            var status = ReplaceOrthoInPlace(src, target, root, Path.Combine(root, "GolfMapSpelunk", "ortho-backups"), DateTime.Now.ToString("yyyyMMdd-HHmmss"), dryRun);
            if (!dryRun) SceneView.RepaintAll();
            int renderers; users.TryGetValue(target, out renderers);
            return GolfMapSceneSave.After(a, new Dictionary<string, object>
            {
                { "file", file }, { "export", File.GetLastWriteTime(src).ToString("yyyy-MM-dd HH:mm") }, { "target", target },
                { "renderers", renderers }, { "status", status }, { "dryRun", dryRun },
            });
        }

        public static Dictionary<string, object> UpdateHeights(string which, string folder, float outerSinkM, bool dryRun)
        {
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);   // before any asset work (see GolfMapTerrainSculpt)
            if (string.IsNullOrEmpty(folder))
            {
                if (string.IsNullOrEmpty(course.exportFolder)) throw new BridgeError("The course asset names no export folder; pass folder.");
                folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            }
            folder = Path.GetFullPath(folder);
            if (!Directory.Exists(folder)) throw new BridgeError("No export folder " + folder + ".");
            if (which != "both" && which != "inner" && which != "outer") throw new BridgeError("terrain must be inner, outer or both.");

            var innerFound = FindExport(folder, "inner", course.exportPrefix);
            var scene = EditorSceneManager.GetActiveScene();
            var rows = new List<object>();
            var backups = new List<string>();
            foreach (var kind in which == "both" ? new[] { "inner", "outer" } : new[] { which })
            {
                var f = kind == "inner" ? innerFound : FindExport(folder, "outer", course.exportPrefix);
                if (f == null)
                {
                    if (which == "both" && kind == "outer") { rows.Add(new Dictionary<string, object> { { "terrain", "outer" }, { "skipped", "no outer heightmap in the export folder" } }); continue; }
                    throw new BridgeError("No " + kind + " heightmap export (*-" + kind + "-dem-*.tif.json with its .raw) in " + folder + ".");
                }
                if (kind == "outer" && innerFound == null) throw new BridgeError("The outer plot is placed from the inner sidecar, and the folder has none.");
                var terrain = kind == "outer"
                    ? GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer")
                    : GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
                var td = terrain.terrainData;
                var sc = f.sidecar;
                int res = sc.raw.size > 0 ? sc.raw.size : sc.unity.heightmapResolution;
                var heights = ReadRaw(f.rawPath, res);
                var newSize = new Vector3((float)sc.sideM, (float)sc.heightRangeM, (float)sc.sideM);
                var newPos = terrain.transform.position;
                float sink = 0;
                if (kind == "outer")
                {
                    // The sink keeps outer ground from showing through the inner; keep
                    // whatever it is now (set by the importer or lowered by hand)
                    // unless one is given.
                    var placed = OuterPosition(innerFound.sidecar, sc);
                    sink = float.IsNaN(outerSinkM) ? Mathf.Max(0f, placed.y - terrain.transform.position.y) : outerSinkM;
                    newPos = placed - new Vector3(0, sink, 0);
                }

                // How much the ground moves, in world metres, on every 4th cell.
                double maxMove = 0, sumMove = 0; int moved = 0, compared = 0;
                if (td.heightmapResolution == res)
                {
                    var old = td.GetHeights(0, 0, res, res);
                    float oldY = terrain.transform.position.y, oldH = td.size.y;
                    for (int z = 0; z < res; z += 4)
                        for (int x = 0; x < res; x += 4)
                        {
                            double dz = (heights[z, x] * newSize.y + newPos.y) - (old[z, x] * oldH + oldY);
                            compared++;
                            if (Math.Abs(dz) > 0.02) { moved++; sumMove += Math.Abs(dz); }
                            if (Math.Abs(dz) > Math.Abs(maxMove)) maxMove = dz;
                        }
                }
                float cellM = (float)sc.sideM / (res - 1) * 4;
                var row = new Dictionary<string, object>
                {
                    { "terrain", terrain.name }, { "sidecar", Path.GetFileName(f.sidecarPath) }, { "source", sc.source },
                    { "heightRangeM", new object[] { Math.Round(td.size.y, 3), Math.Round(sc.heightRangeM, 3) } },
                    { "resolution", new object[] { td.heightmapResolution, res } },
                    { "maxMoveM", compared > 0 ? (object)Math.Round(maxMove, 2) : null },
                    { "movedM2", compared > 0 ? (object)Math.Round(moved * cellM * cellM) : null },
                    { "meanMoveM", moved > 0 ? (object)Math.Round(sumMove / moved, 2) : null },
                };
                if (kind == "outer") { row["position"] = new object[] { Math.Round(newPos.x, 3), Math.Round(newPos.y, 3), Math.Round(newPos.z, 3) }; row["sinkM"] = Math.Round(sink, 3); }
                else if (terrain.transform.position != Vector3.zero) row["warning"] = "the inner terrain is not at the origin; golf-map's exports assume it is";
                rows.Add(row);
                if (dryRun) continue;

                var dataPath = AssetDatabase.GetAssetPath(td);
                if (!string.IsNullOrEmpty(dataPath))
                {
                    var backupFolder = courseFolder + "Backups";
                    if (!AssetDatabase.IsValidFolder(backupFolder)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Backups");
                    var backup = backupFolder + "/" + td.name + "-before-update-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".asset";
                    if (!AssetDatabase.CopyAsset(dataPath, backup)) throw new BridgeError("Could not back up " + dataPath + " to " + backup + "; nothing changed.");
                    backups.Add(backup);
                    row["backup"] = backup;
                }
                if (td.heightmapResolution != res) td.heightmapResolution = res;
                td.size = newSize;
                td.SetHeights(0, 0, heights);
                terrain.Flush();
                EditorUtility.SetDirty(td);
                if (kind == "outer" && terrain.transform.position != newPos)
                {
                    Undo.RecordObject(terrain.transform, "Update terrain heights");
                    terrain.transform.position = newPos;
                }
                GolfMapTerrainConform.RefreshVsp(terrain);
                // What golf-map sent, so a later sculpt can be told apart from it.
                GolfMapTerrainSculpt.SaveReference(courseFolder, kind, terrain, sc, f.sidecarPath);
            }
            if (!dryRun)
            {
                AssetDatabase.SaveAssets();
                EditorSceneManager.MarkSceneDirty(scene);
            }
            return new Dictionary<string, object>
            {
                { "folder", folder }, { "dryRun", dryRun }, { "terrains", rows }, { "backups", backups },
                { "outerShowsThrough", OuterShowsThrough(GolfMapCourses.Require(), scene) },  // a dry run measures the scene as it is; re-read: asset saves can reload the course
                { "next", "Export the terrain OBJ (Terrain > Export To OBJ...) for Blender. Re-run golfmap.terrain.conform once the course meshes are rebuilt." },
            };
        }

        // Where the outer plot's ground is at or above the inner terrain's (within
        // 5 cm), sampled every 2 m over the inner square: the outer shows through
        // there once the course meshes follow the inner. A deep cut (a pad on a
        // slope, a dug pond) under an outer not updated with the same edits does
        // it. Null when the scene lacks either terrain.
        static object OuterShowsThrough(GolfMapCourse course, UnityEngine.SceneManagement.Scene scene)
        {
            Terrain inner, outer;
            try
            {
                inner = GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
                outer = GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer");
            }
            catch (Exception) { return null; }
            var size = inner.terrainData.size;
            var o = inner.transform.position;
            const float step = 2f;
            int hits = 0; float worst = float.NegativeInfinity; Vector3 at = Vector3.zero;
            for (float z = 0; z <= size.z; z += step)
                for (float x = 0; x <= size.x; x += step)
                {
                    var p = new Vector3(o.x + x, 0, o.z + z);
                    float above = (outer.SampleHeight(p) + outer.transform.position.y) - (inner.SampleHeight(p) + o.y);
                    if (above > -0.05f) hits++;
                    if (above > worst) { worst = above; at = p; }
                }
            return new Dictionary<string, object>
            {
                { "areaM2", Math.Round(hits * step * step) },
                { "worstM", Math.Round(worst, 2) },
                { "worstAt", new object[] { Math.Round(at.x, 1), Math.Round(at.z, 1) } },
            };
        }

        // The folder's heightmap export for one terrain kind: its sidecar (the
        // `terrain` field, else -inner-/-outer- in the name, preferring files
        // that start with the course's export prefix) and the .raw next to it.
        static Found FindExport(string folder, string kind, string prefix)
        {
            return Directory.GetFiles(folder, "*.tif.json")
                .OrderBy(p => string.IsNullOrEmpty(prefix) || !Path.GetFileName(p).StartsWith(prefix + "-", StringComparison.Ordinal))
                .ThenBy(p => p, StringComparer.Ordinal)
                .Select(p =>
                {
                    GolfMapDemSidecar sc;
                    try { sc = JsonUtility.FromJson<GolfMapDemSidecar>(File.ReadAllText(p)); } catch { return null; }
                    if (sc == null || sc.sideM <= 0 || sc.raw == null || string.IsNullOrEmpty(sc.raw.file)) return null;
                    var name = Path.GetFileName(p);
                    var k = !string.IsNullOrEmpty(sc.terrain) ? sc.terrain : name.Contains("-outer-") ? "outer" : name.Contains("-inner-") ? "inner" : null;
                    var raw = Path.Combine(folder, sc.raw.file);
                    return k == kind && File.Exists(raw) ? new Found { sidecarPath = p, sidecar = sc, rawPath = raw } : null;
                })
                .FirstOrDefault(found => found != null);
        }

        // ---- files ---------------------------------------------------------

        static string EnsureFolder(params string[] parts)
        {
            var path = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                var next = $"{path}/{parts[i]}";
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(path, parts[i]);
                path = next;
            }
            return path;
        }

        /// Copy a file into the project folder (overwriting) and import it; returns the asset path.
        static string CopyIn(string sourcePath, string assetsFolder)
        {
            var assetPath = $"{assetsFolder}/{Path.GetFileName(sourcePath)}";
            var full = Path.Combine(Directory.GetParent(Application.dataPath).FullName, assetPath.Replace('/', Path.DirectorySeparatorChar));
            File.Copy(sourcePath, full, true);
            AssetDatabase.ImportAsset(assetPath, ImportAssetOptions.ForceSynchronousImport);
            return assetPath;
        }
    }
}
