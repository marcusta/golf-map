// Course props: buildings, shelters, flags, benches, cars ... built in Blender by
// blender/tools/build_props.py from a spec (docs/gspro/<course>/*-props.json) into
// <course>/Props/: Models/*.fbx, Textures/*.png and a golfmap-props-v1 manifest (props.json).
// This places them: builds a Standard material per manifest material (albedo, normal map,
// smoothness, metallic) and remaps every FBX onto them, then instantiates each instance under
// 'GolfMap Props' at its EPSG:3006 position (inner DEM sidecar frame), on the surface the player
// sees (highest collider under it: course meshes, else terrain), turned so the asset's Blender +x
// axis points along the instance's compass yawDeg. Buildings/structures get MeshColliders, small
// props box colliders or none, per the manifest. Placing always replaces what the last place
// made. Unity 2018.2 / C# 6.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapProps
    {
        public const string RootName = "GolfMap Props";
        const string Format = "golfmap-props-v1";

        [MenuItem("GolfMap/Props/Place props from manifest")]
        static void Menu() { Debug.Log("[GolfMap Props] " + GolfMapJson.Serialize(Place(null, false, null, true), false)); }

        [BridgeCommand("golfmap.props.place", "Place the course's Blender-built props (<course>/Props/props.json, golfmap-props-v1 from blender/tools/build_props.py): Standard materials from the manifest (textures set up as albedo/normal maps), FBX materials remapped onto them, then every instance under 'GolfMap Props' at its EPSG:3006 position on the highest collider below (course meshes, else terrain), rotated to its yawDeg, with MeshColliders on buildings/structures. Replaces what the last place made. Marks the scene dirty, does not save it.",
            args = "folder (default <course>/Props/), dryRun=false (ground heights and the plan, nothing written), only (asset ids, comma-separated: place just these, keep the rest), materials=true (rebuild materials and FBX import settings)")]
        static object Command(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return Place(a.String("folder"), a.Bool("dryRun", false), only.Count == 0 ? null : new HashSet<string>(only), a.Bool("materials", true));
        }

        [BridgeCommand("golfmap.props.clear", "Delete 'GolfMap Props' (everything golfmap.props.place made). Marks the scene dirty.", args = "")]
        static object Clear(BridgeArgs a)
        {
            var root = FindRoot();
            if (root == null) return new Dictionary<string, object> { { "removed", 0 } };
            int n = root.GetComponentsInChildren<Transform>(true).Length - 1;
            Undo.DestroyObjectImmediate(root);
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return new Dictionary<string, object> { { "removed", n } };
        }

        static GameObject FindRoot()
        {
            return EditorSceneManager.GetActiveScene().GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
        }

        // ---- manifest -----------------------------------------------------------------------

        class Mat { public string name, albedo, normal, mask; public Color color; public float smoothness, metallic; public bool cutout, fade; }
        // prefab: a Unity prefab (e.g. a vegetation pack's hedge) placed instead of a Blender FBX; its bounds are
        // measured here and it keeps its own colliders/LODs. Blender assets carry bounds in Blender local x/y.
        // axis: the prefab's forward axis ("x" default, "z" for most vehicle packs) - yawDeg is its compass bearing.
        // recolor: copies of named materials with another _Color, swapped in on this asset's instances.
        class Recolor { public string material, name; public Color color; }
        class Asset { public string id, fbx, prefab, category, collider, axis; public Vector3 bmin, bmax; public List<string> materials = new List<string>(); public List<Recolor> recolor = new List<Recolor>(); }
        class Inst { public string asset, ground; public double e, n; public float yaw, dz; public Vector3 scale = Vector3.one; }

        static float F(object o, float fallback = 0f)
        {
            var n = o as GolfMapJsonNumber;
            return n == null ? fallback : (float)n.Value;
        }

        static Vector3 V3(object o)
        {
            var l = o as List<object>;
            return l == null || l.Count < 3 ? Vector3.zero : new Vector3(F(l[0]), F(l[1]), F(l[2]));
        }

        static void Load(string path, out List<Mat> mats, out List<Asset> assets, out List<Inst> insts)
        {
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            if (root.String("format") != Format) throw new InvalidOperationException(path + " is not " + Format + ".");
            mats = new List<Mat>();
            var mo = root.Object("materials");
            foreach (var k in mo.keys)
            {
                var m = mo.Object(k);
                var c = m.Array("color");
                mats.Add(new Mat
                {
                    name = k, albedo = m.String("albedo"), normal = m.String("normal"), mask = m.String("mask"),
                    cutout = m["cutout"] is bool && (bool)m["cutout"],
                    fade = m["fade"] is bool && (bool)m["fade"],
                    color = c == null ? Color.white : new Color(F(c[0]), F(c[1]), F(c[2]), 1f),
                    smoothness = F(m["smoothness"], 0.2f), metallic = F(m["metallic"]),
                });
            }
            assets = new List<Asset>();
            var ao = root.Object("assets");
            foreach (var k in ao.keys)
            {
                var o = ao.Object(k);
                var b = o.Object("bounds");
                var a = new Asset { id = k, fbx = o.String("fbx"), prefab = o.String("prefab"), category = o.String("category") ?? "prop", collider = o.String("collider") ?? "none" };
                if (b != null) { a.bmin = V3(b["min"]); a.bmax = V3(b["max"]); }
                var ml = o.Array("materials");
                if (ml != null) a.materials.AddRange(ml.Select(x => x as string).Where(x => x != null));
                a.axis = o.String("axis") ?? "x";
                var rl = o.Array("recolor");
                if (rl != null)
                    foreach (var r in rl.Cast<GolfMapJsonObject>())
                    {
                        var c = r.Array("color");
                        a.recolor.Add(new Recolor { material = r.String("material"), name = r.String("as"), color = new Color(F(c[0]), F(c[1]), F(c[2]), 1f) });
                    }
                assets.Add(a);
            }
            insts = new List<Inst>();
            foreach (var io in root.Array("instances").Cast<GolfMapJsonObject>())
            {
                insts.Add(new Inst
                {
                    asset = io.String("asset"), ground = io.String("ground") ?? "median",
                    e = ((GolfMapJsonNumber)io["e"]).Value, n = ((GolfMapJsonNumber)io["n"]).Value,
                    yaw = F(io["yawDeg"], 90f), dz = F(io["dz"]),
                    scale = io["scale"] is List<object> ? V3(io["scale"]) : Vector3.one,
                });
            }
        }

        // ---- materials and import settings --------------------------------------------------

        // kind: 0 albedo (sRGB), 1 normal map, 2 linear data (mask: R metallic, G occlusion, A smoothness)
        static Texture2D Texture(string folder, string file, bool normal) { return Texture(folder, file, normal ? 1 : 0); }

        static Texture2D Texture(string folder, string file, int kind)
        {
            bool normal = kind == 1;
            if (string.IsNullOrEmpty(file)) return null;
            var path = folder + "Textures/" + file;
            var ti = AssetImporter.GetAtPath(path) as TextureImporter;
            if (ti == null) { AssetDatabase.ImportAsset(path); ti = AssetImporter.GetAtPath(path) as TextureImporter; }
            if (ti == null) throw new InvalidOperationException("Missing texture " + path);
            var type = normal ? TextureImporterType.NormalMap : TextureImporterType.Default;
            bool srgb = kind == 0;
            if (ti.textureType != type || ti.wrapMode != TextureWrapMode.Repeat || ti.maxTextureSize != 2048 || ti.anisoLevel != 4 || ti.sRGBTexture != srgb)
            {
                ti.textureType = type;
                ti.sRGBTexture = srgb;
                ti.alphaIsTransparency = false;
                ti.wrapMode = TextureWrapMode.Repeat;
                ti.maxTextureSize = 2048;
                ti.anisoLevel = 4;
                ti.mipmapEnabled = true;
                ti.SaveAndReimport();
            }
            return AssetDatabase.LoadAssetAtPath<Texture2D>(path);
        }

        static Dictionary<string, Material> BuildMaterials(string folder, List<Mat> mats)
        {
            var dir = folder + "Materials";
            if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder(folder.TrimEnd('/'), "Materials");
            var shader = Shader.Find("Standard");
            var outp = new Dictionary<string, Material>();
            foreach (var m in mats)
            {
                var path = dir + "/" + m.name + ".mat";
                var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (mat == null) { mat = new Material(shader) { name = m.name }; AssetDatabase.CreateAsset(mat, path); }
                mat.shader = shader;
                mat.SetColor("_Color", m.color);
                mat.SetTexture("_MainTex", Texture(folder, m.albedo, false));
                var nrm = Texture(folder, m.normal, true);
                mat.SetTexture("_BumpMap", nrm);
                mat.SetFloat("_BumpScale", 1f);
                if (nrm != null) mat.EnableKeyword("_NORMALMAP"); else mat.DisableKeyword("_NORMALMAP");
                mat.SetFloat("_Glossiness", m.smoothness);
                mat.SetFloat("_Metallic", m.metallic);
                var mask = Texture(folder, m.mask, 2);
                mat.SetTexture("_MetallicGlossMap", mask);
                mat.SetTexture("_OcclusionMap", mask);
                mat.SetFloat("_GlossMapScale", m.smoothness);
                mat.SetFloat("_OcclusionStrength", 1f);
                if (mask != null) mat.EnableKeyword("_METALLICGLOSSMAP"); else mat.DisableKeyword("_METALLICGLOSSMAP");
                // Standard shader render mode: opaque, alpha-tested cutout, or fade (translucent netting)
                mat.SetFloat("_Mode", m.fade ? 2f : m.cutout ? 1f : 0f);
                mat.SetFloat("_Cutoff", 0.5f);
                mat.SetOverrideTag("RenderType", m.fade ? "Transparent" : m.cutout ? "TransparentCutout" : "");
                mat.SetInt("_SrcBlend", (int)(m.fade ? UnityEngine.Rendering.BlendMode.SrcAlpha : UnityEngine.Rendering.BlendMode.One));
                mat.SetInt("_DstBlend", (int)(m.fade ? UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha : UnityEngine.Rendering.BlendMode.Zero));
                mat.SetInt("_ZWrite", m.fade ? 0 : 1);
                if (m.fade) mat.EnableKeyword("_ALPHABLEND_ON"); else mat.DisableKeyword("_ALPHABLEND_ON");
                mat.DisableKeyword("_ALPHAPREMULTIPLY_ON");
                if (m.cutout) mat.EnableKeyword("_ALPHATEST_ON"); else mat.DisableKeyword("_ALPHATEST_ON");
                mat.renderQueue = m.fade ? (int)UnityEngine.Rendering.RenderQueue.Transparent : m.cutout ? (int)UnityEngine.Rendering.RenderQueue.AlphaTest : -1;
                mat.enableInstancing = true;
                EditorUtility.SetDirty(mat);
                outp[m.name] = mat;
            }
            AssetDatabase.SaveAssets();
            return outp;
        }

        // Renderer bounds of a prefab in its own root space (instantiated for a moment: prefab assets have no bounds).
        static Bounds Measure(GameObject prefab, out bool lods, out int colliders)
        {
            Vector3 face; float steep, up;
            return Measure(prefab, out lods, out colliders, out face, out steep, out up);
        }

        // face: the area-weighted outward normal of the first LOD's steep triangles (normal within 45 deg of level), in the
        // prefab's own frame, horizontal; its length = how one-sided they are (0 = all round, 1 = one flat face). steep/up:
        // shares of the surface area that is steep and that faces up. For turning a cliff piece's face outward.
        static Bounds Measure(GameObject prefab, out bool lods, out int colliders, out Vector3 face, out float steep, out float up)
        {
            var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                go.transform.position = Vector3.zero;
                go.transform.rotation = Quaternion.identity;  // root scale stays: some packs scale the root (cm models)
                var rs = go.GetComponentsInChildren<Renderer>();
                var b = rs.Length > 0 ? rs[0].bounds : new Bounds();
                foreach (var r in rs) b.Encapsulate(r.bounds);
                var lodGroup = go.GetComponentInChildren<LODGroup>();
                lods = lodGroup != null;
                colliders = go.GetComponentsInChildren<Collider>().Length;
                var lod0 = lods && lodGroup.GetLODs().Length > 0 ? lodGroup.GetLODs()[0].renderers.Where(r => r != null).ToArray() : rs;
                Vector3 sum = Vector3.zero; float steepArea = 0, upArea = 0, total = 0;
                foreach (var r in lod0)
                {
                    var mf = r.GetComponent<MeshFilter>();
                    if (mf == null || mf.sharedMesh == null) continue;
                    var v = mf.sharedMesh.vertices; var t = mf.sharedMesh.triangles; var m = r.transform.localToWorldMatrix;
                    for (int i = 0; i < t.Length; i += 3)
                    {
                        var n = Vector3.Cross(m.MultiplyPoint3x4(v[t[i + 1]]) - m.MultiplyPoint3x4(v[t[i]]), m.MultiplyPoint3x4(v[t[i + 2]]) - m.MultiplyPoint3x4(v[t[i]]));
                        float area = n.magnitude / 2; if (area <= 0) continue;
                        var nn = n.normalized; total += area;
                        if (nn.y > 0.7f) upArea += area;
                        else if (Mathf.Abs(nn.y) < 0.7f) { steepArea += area; sum += new Vector3(nn.x, 0, nn.z) * area; }
                    }
                }
                face = steepArea > 0 ? sum / steepArea : Vector3.zero;
                steep = total > 0 ? steepArea / total : 0; up = total > 0 ? upArea / total : 0;
                return b;
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }

        [BridgeCommand("golfmap.props.measure", "Size of prefabs (renderer bounds in the prefab's own space, metres), whether they have LODs and colliders: what a props spec needs to tile a hedge row or scale a bush. face = which way the first LOD's steep surfaces look (angleDeg from the prefab's +z toward +x; oneSided 0 = all round, 1 = one flat face): which side of a cliff piece is its rock face.",
            args = "paths (asset paths of prefabs) or folder (every prefab under it)")]
        static object MeasureCommand(BridgeArgs a)
        {
            var paths = a.Strings("paths").ToList();
            var folder = a.String("folder");
            if (!string.IsNullOrEmpty(folder))
                paths.AddRange(AssetDatabase.FindAssets("t:Prefab", new[] { folder.TrimEnd('/') }).Select(AssetDatabase.GUIDToAssetPath));
            var rows = new List<object>();
            foreach (var p in paths)
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(p);
                if (prefab == null) { rows.Add(new Dictionary<string, object> { { "path", p }, { "error", "not a prefab" } }); continue; }
                bool lods; int cols; Vector3 face; float steep, up; Bounds b;
                try { b = Measure(prefab, out lods, out cols, out face, out steep, out up); }
                catch (Exception e) { rows.Add(new Dictionary<string, object> { { "path", p }, { "error", e.GetType().Name + ": " + e.Message } }); continue; }
                rows.Add(new Dictionary<string, object> {
                    { "path", p }, { "size", new[] { b.size.x, b.size.y, b.size.z } }, { "center", new[] { b.center.x, b.center.y, b.center.z } },
                    { "lods", lods }, { "colliders", cols },
                    { "face", new Dictionary<string, object> { { "angleDeg", Math.Round(Mathf.Atan2(face.x, face.z) * Mathf.Rad2Deg, 1) }, { "oneSided", Math.Round(face.magnitude, 2) } } },
                    { "steepShare", Math.Round(steep, 2) }, { "upShare", Math.Round(up, 2) } });
            }
            return rows;
        }

        static readonly Dictionary<string, Material> recolorCache = new Dictionary<string, Material>();

        // Copies of the named source materials (found in the prefab's renderers) with a new _Color, kept under
        // <props>/Materials/Recolor/. Source material name -> copy.
        static Dictionary<string, Material> RecolorMaterials(string folder, Asset a)
        {
            var outp = new Dictionary<string, Material>();
            var pf = AssetDatabase.LoadAssetAtPath<GameObject>(a.prefab);
            var sources = pf.GetComponentsInChildren<Renderer>(true).SelectMany(r => r.sharedMaterials).Where(m => m != null).GroupBy(m => m.name).ToDictionary(g => g.Key, g => g.First());
            var dir = folder + "Materials/Recolor";
            if (!AssetDatabase.IsValidFolder(folder + "Materials")) AssetDatabase.CreateFolder(folder.TrimEnd('/'), "Materials");
            if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder(folder + "Materials", "Recolor");
            foreach (var rc in a.recolor)
            {
                Material src;
                if (!sources.TryGetValue(rc.material, out src)) throw new InvalidOperationException("Asset " + a.id + ": prefab has no material '" + rc.material + "' to recolor");
                var path = dir + "/" + rc.name + ".mat";
                Material m;
                if (!recolorCache.TryGetValue(path, out m) || m == null)
                {
                    m = AssetDatabase.LoadAssetAtPath<Material>(path);
                    if (m == null) { m = new Material(src) { name = rc.name }; AssetDatabase.CreateAsset(m, path); }
                    else m.CopyPropertiesFromMaterial(src);
                    m.SetColor("_Color", rc.color);
                    EditorUtility.SetDirty(m);
                    recolorCache[path] = m;
                }
                outp[rc.material] = m;
            }
            return outp;
        }

        static GameObject Model(string folder, Asset a, Dictionary<string, Material> mats, bool settings)
        {
            if (!string.IsNullOrEmpty(a.prefab))
            {
                var pf = AssetDatabase.LoadAssetAtPath<GameObject>(a.prefab);
                if (pf == null) throw new InvalidOperationException("Missing prefab " + a.prefab + " (asset " + a.id + ")");
                bool lods; int cols;
                var b = Measure(pf, out lods, out cols);
                // store as "Blender-style" local x/y bounds of a Unity-native model (x -> x, y -> z)
                a.bmin = new Vector3(b.min.x, b.min.z, b.min.y);
                a.bmax = new Vector3(b.max.x, b.max.z, b.max.y);
                return pf;
            }
            var path = folder + a.fbx;
            var mi = AssetImporter.GetAtPath(path) as ModelImporter;
            if (mi == null) { AssetDatabase.ImportAsset(path); mi = AssetImporter.GetAtPath(path) as ModelImporter; }
            if (mi == null) throw new InvalidOperationException("Missing model " + path);
            if (settings)
            {
                mi.globalScale = 1f;
                mi.useFileScale = true;
                mi.importAnimation = false;
                mi.importCameras = false;
                mi.importLights = false;
                mi.animationType = ModelImporterAnimationType.None;
                mi.addCollider = false;
                mi.importNormals = ModelImporterNormals.Import;
                mi.importMaterials = true;
                mi.materialLocation = ModelImporterMaterialLocation.InPrefab;
                mi.meshCompression = ModelImporterMeshCompression.Off;
                mi.generateSecondaryUV = false;
                foreach (var name in a.materials)
                {
                    Material m;
                    if (mats != null && mats.TryGetValue(name, out m)) mi.AddRemap(new AssetImporter.SourceAssetIdentifier(typeof(Material), name), m);
                }
                mi.SaveAndReimport();
            }
            return AssetDatabase.LoadAssetAtPath<GameObject>(path);
        }

        // A manifest folder's materials and FBX import settings, nothing placed: asset id -> model, and each asset's
        // collider kind. GolfMapWalls builds walls from Blender-built boulders this way.
        internal static Dictionary<string, GameObject> PrepareModels(string folder, out Dictionary<string, string> colliders)
        {
            folder = folder.Replace('\\', '/').TrimEnd('/') + "/";
            var manifest = folder + "props.json";
            if (!File.Exists(manifest)) throw new InvalidOperationException("No props manifest at " + manifest + ": run blender/tools/build_props.py with --out " + folder);
            List<Mat> mats; List<Asset> assets; List<Inst> insts;
            Load(manifest, out mats, out assets, out insts);
            AssetDatabase.Refresh();
            var matAssets = BuildMaterials(folder, mats);
            var models = new Dictionary<string, GameObject>();
            colliders = new Dictionary<string, string>();
            foreach (var a in assets)
            {
                models[a.id] = Model(folder, a, matAssets, true);
                colliders[a.id] = a.collider;
            }
            return models;
        }

        // ---- frame and ground ---------------------------------------------------------------

        // EPSG:3006 (e, n) -> scene: x = e - e0 + origin.x, z = n - n0 + origin.z. Also used by GolfMapWalls.
        internal static void Frame(GolfMapCourse course, out double e0, out double n0, out Vector3 origin)
        {
            if (string.IsNullOrEmpty(course.exportFolder)) throw new InvalidOperationException("The course has no export folder (needs the inner DEM sidecar).");
            var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            var pattern = (string.IsNullOrEmpty(course.exportPrefix) ? "*" : course.exportPrefix) + "-inner-dem-*.tif.json";
            foreach (var p in Directory.GetFiles(folder, pattern).OrderBy(x => x, StringComparer.Ordinal))
            {
                var sc = JsonUtility.FromJson<GolfMapDemSidecar>(File.ReadAllText(p));
                if (sc == null || sc.square3006 == null || sc.square3006.Length != 4) continue;
                e0 = sc.square3006[0];
                n0 = sc.square3006[1];
                var terrain = UnityEngine.Object.FindObjectsOfType<Terrain>().FirstOrDefault(t => t.name == course.innerTerrainName);
                origin = terrain != null ? terrain.transform.position : Vector3.zero;
                return;
            }
            throw new InvalidOperationException("No inner DEM sidecar (" + pattern + ") in " + folder);
        }

        // The highest collider under (x, z) that is not a prop: what the player stands on.
        static float? Ground(float x, float z, Transform ignore)
        {
            var hits = Physics.RaycastAll(new Ray(new Vector3(x, 5000f, z), Vector3.down), 10000f, ~0, QueryTriggerInteraction.Ignore);
            float? best = null;
            foreach (var h in hits)
            {
                if (ignore != null && h.collider.transform.IsChildOf(ignore)) continue;
                if (best == null || h.point.y > best.Value) best = h.point.y;
            }
            return best;
        }

        // ---- place ----------------------------------------------------------------------------

        public static Dictionary<string, object> Place(string folder, bool dryRun, HashSet<string> only, bool materials)
        {
            var course = GolfMapCourses.Require();
            folder = string.IsNullOrEmpty(folder) ? GolfMapCourses.Folder(course) + "Props/" : folder.Replace('\\', '/').TrimEnd('/') + "/";
            var manifest = folder + "props.json";
            if (!File.Exists(manifest)) throw new InvalidOperationException("No props manifest at " + manifest + ": run blender/tools/build_props.py with --out " + folder);
            List<Mat> mats; List<Asset> assets; List<Inst> insts;
            Load(manifest, out mats, out assets, out insts);
            var byId = assets.ToDictionary(a => a.id);
            double e0, n0; Vector3 origin;
            Frame(course, out e0, out n0, out origin);

            AssetDatabase.Refresh();
            recolorCache.Clear();
            var matAssets = dryRun ? null : (materials ? BuildMaterials(folder, mats) : null);
            var models = new Dictionary<string, GameObject>();
            var axis = new Dictionary<string, object>();
            int sx = 1, sz = 1;
            foreach (var a in assets)
            {
                // Assets left out by `only` still decide the axis: a place of symmetric assets alone (bins, bollards)
                // would otherwise fall back to sx = sz = 1 and turn them 180 deg from a full place.
                bool wanted = only == null || only.Contains(a.id);
                if (!wanted && (axis.Count > 0 || !string.IsNullOrEmpty(a.prefab) || Mathf.Abs(a.bmin.y + a.bmax.y) <= 1f)) continue;
                var go = Model(folder, a, matAssets, wanted && materials && !dryRun);
                if (wanted) models[a.id] = go;
                // Blender local x/y -> Unity local: find the signs from the mesh bounds (asymmetric assets decide).
                var mf = go.GetComponentInChildren<MeshFilter>();
                if (string.IsNullOrEmpty(a.prefab) && mf != null && mf.sharedMesh != null && axis.Count == 0 && Mathf.Abs(a.bmin.y + a.bmax.y) > 1f)
                {
                    var b = mf.sharedMesh.bounds;
                    float bcx = (a.bmin.x + a.bmax.x) / 2, bcy = (a.bmin.y + a.bmax.y) / 2;
                    sz = Mathf.Sign(b.center.z) == Mathf.Sign(bcy) ? 1 : -1;
                    sx = Mathf.Abs(bcx) < 0.2f ? sz : (Mathf.Sign(b.center.x) == Mathf.Sign(bcx) ? 1 : -1);
                    axis["asset"] = a.id;
                    axis["blenderCentre"] = new[] { bcx, bcy, (a.bmin.z + a.bmax.z) / 2 };
                    axis["unityCentre"] = new[] { b.center.x, b.center.y, b.center.z };
                    axis["unityExtents"] = new[] { b.extents.x, b.extents.y, b.extents.z };
                    axis["sx"] = sx;
                    axis["sz"] = sz;
                    axis["mirrored"] = sx != sz;
                }
            }
            // Unity yaw that puts Blender +x on compass bearing `yaw` (non-mirrored import: sx == sz).
            Func<float, float> unityYaw = yaw => sx > 0 ? yaw - 90f : yaw + 90f;

            var root = FindRoot();
            var rows = new List<object>();
            var warnings = new List<string>();
            var counts = new SortedDictionary<string, int>();
            int placed = 0;
            if (!dryRun)
            {
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Place props");
                if (root == null) { root = new GameObject(RootName); Undo.RegisterCreatedObjectUndo(root, "Place props"); }
                // replace: everything (or the selected assets) the last place made
                // placed objects are named "<asset>#<index>" (no custom component: GSPro would load it as a missing script)
                foreach (var t in root.GetComponentsInChildren<Transform>(true).Where(t => t.name.Contains("#")).ToList())
                    if (only == null || only.Contains(t.name.Substring(0, t.name.IndexOf('#')))) Undo.DestroyObjectImmediate(t.gameObject);
            }
            Physics.SyncTransforms();
            var groups = new Dictionary<string, Transform>();
            var sb = new StringBuilder();
            sb.AppendLine("GolfMap props: " + manifest + "  " + DateTime.Now.ToString("s"));
            for (int i = 0; i < insts.Count; i++)
            {
                var inst = insts[i];
                if (only != null && !only.Contains(inst.asset)) continue;
                Asset a;
                if (!byId.TryGetValue(inst.asset, out a)) { warnings.Add("instance " + i + ": unknown asset " + inst.asset); continue; }
                var pos = new Vector3((float)(inst.e - e0) + origin.x, 0f, (float)(inst.n - n0) + origin.z);
                bool native = !string.IsNullOrEmpty(a.prefab);  // Unity prefab: local +x is its own +x, no Blender axis swap
                var rot = Quaternion.Euler(0f, native ? (a.axis == "z" ? inst.yaw : inst.yaw - 90f) : unityYaw(inst.yaw), 0f);
                int ax = native ? 1 : sx, az = native ? 1 : sz;
                // sample the footprint (Blender bounds, local x/y) on a 3x3 grid, or just the centre
                var samples = new List<float>();
                bool small = (a.bmax.x - a.bmin.x) < 1.5f && (a.bmax.y - a.bmin.y) < 1.5f;
                var fx = small || inst.ground == "centre" ? new[] { 0.5f } : new[] { 0.05f, 0.5f, 0.95f };
                foreach (var u in fx) foreach (var v in fx)
                {
                    var lx = Mathf.Lerp(a.bmin.x, a.bmax.x, u); var ly = Mathf.Lerp(a.bmin.y, a.bmax.y, v);
                    if (small || inst.ground == "centre") { lx = 0; ly = 0; }
                    var w = pos + rot * Vector3.Scale(inst.scale, new Vector3(lx * ax, 0f, ly * az));
                    var g = Ground(w.x, w.z, root != null ? root.transform : null);
                    if (g != null) samples.Add(g.Value);
                }
                if (samples.Count == 0) { warnings.Add(inst.asset + " #" + i + ": nothing to stand on"); continue; }
                samples.Sort();
                float y;
                switch (inst.ground)
                {
                    case "max": y = samples[samples.Count - 1]; break;
                    case "min": y = samples[0]; break;
                    case "centre": y = samples[samples.Count / 2]; break;
                    default: y = samples[samples.Count / 2]; break;
                }
                float spread = samples[samples.Count - 1] - samples[0];
                pos.y = y + inst.dz;
                if (a.category == "building" && spread > 1.0f) warnings.Add(string.Format("{0} #{1}: ground spread {2:F2} m under the footprint", inst.asset, i, spread));
                sb.AppendLine(string.Format("{0,-22} #{1,-3} E {2:F2} N {3:F2} yaw {4,6:F1}  y {5,7:F2}  spread {6:F2}", inst.asset, i, inst.e, inst.n, inst.yaw, pos.y, spread));
                int c; counts.TryGetValue(inst.asset, out c); counts[inst.asset] = c + 1;
                placed++;
                if (dryRun) { if (rows.Count < 400) rows.Add(new Dictionary<string, object> { { "asset", inst.asset }, { "x", pos.x }, { "y", pos.y }, { "z", pos.z }, { "spread", spread } }); continue; }

                Transform parent;
                var gname = char.ToUpper(a.category[0]) + a.category.Substring(1) + "s";
                if (!groups.TryGetValue(gname, out parent))
                {
                    var t = root.transform.Find(gname);
                    if (t == null) { var gg = new GameObject(gname); Undo.RegisterCreatedObjectUndo(gg, "Place props"); gg.transform.SetParent(root.transform, false); t = gg.transform; }
                    groups[gname] = parent = t;
                }
                var go = (GameObject)PrefabUtility.InstantiatePrefab(models[a.id]);
                Undo.RegisterCreatedObjectUndo(go, "Place props");
                go.name = a.id + "#" + i;
                go.transform.SetParent(parent, false);
                go.transform.position = pos;
                go.transform.rotation = rot;
                go.transform.localScale = Vector3.Scale(go.transform.localScale, inst.scale);
                if (a.recolor.Count > 0)
                {
                    var swap = RecolorMaterials(folder, a);
                    foreach (var r in go.GetComponentsInChildren<Renderer>(true))
                    {
                        var ms = r.sharedMaterials;
                        bool changed = false;
                        for (int k = 0; k < ms.Length; k++)
                        {
                            Material to;
                            if (ms[k] != null && swap.TryGetValue(ms[k].name, out to)) { ms[k] = to; changed = true; }
                        }
                        if (changed) r.sharedMaterials = ms;
                    }
                }
                if (a.collider == "mesh")
                    foreach (var mf in go.GetComponentsInChildren<MeshFilter>()) { var mc = mf.gameObject.AddComponent<MeshCollider>(); mc.sharedMesh = mf.sharedMesh; }
                else if (a.collider == "box" && native)
                {
                    if (go.GetComponentInChildren<Collider>() == null)
                    {
                        var rs = go.GetComponentsInChildren<Renderer>();
                        if (rs.Length > 0)
                        {
                            var wb = rs[0].bounds;
                            foreach (var r in rs) wb.Encapsulate(r.bounds);
                            var bc = go.AddComponent<BoxCollider>();
                            var lossy = go.transform.lossyScale;
                            var lc = go.transform.InverseTransformPoint(wb.center);
                            var ls = Quaternion.Inverse(go.transform.rotation) * wb.size;
                            bc.center = lc;
                            bc.size = new Vector3(Mathf.Abs(ls.x) / lossy.x, Mathf.Abs(ls.y) / lossy.y, Mathf.Abs(ls.z) / lossy.z) * 0.95f;
                        }
                    }
                }
                else if (a.collider == "box")
                    foreach (var mf in go.GetComponentsInChildren<MeshFilter>()) mf.gameObject.AddComponent<BoxCollider>();
                foreach (var t in go.GetComponentsInChildren<Transform>(true))
                    GameObjectUtility.SetStaticEditorFlags(t.gameObject, StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccludeeStatic | StaticEditorFlags.OccluderStatic | StaticEditorFlags.ReflectionProbeStatic);
            }
            // One realtime reflection probe over the placed area, rendered once on load: glass, metal
            // roofs and cars reflect the course around them instead of only the skybox.
            if (!dryRun && placed > 0)
            {
                var probeT = root.transform.Find("Reflection probe");
                if (probeT == null)
                {
                    var pg = new GameObject("Reflection probe");
                    Undo.RegisterCreatedObjectUndo(pg, "Place props");
                    pg.transform.SetParent(root.transform, false);
                    probeT = pg.transform;
                }
                var probe = probeT.GetComponent<ReflectionProbe>();
                if (probe == null) probe = probeT.gameObject.AddComponent<ReflectionProbe>();
                var placedTs = root.GetComponentsInChildren<MeshRenderer>().Select(r => r.bounds).ToList();
                var bb = placedTs[0];
                foreach (var b in placedTs) bb.Encapsulate(b);
                probeT.position = new Vector3(bb.center.x, bb.min.y + 12f, bb.center.z);
                probe.mode = UnityEngine.Rendering.ReflectionProbeMode.Realtime;
                probe.refreshMode = UnityEngine.Rendering.ReflectionProbeRefreshMode.OnAwake;
                probe.timeSlicingMode = UnityEngine.Rendering.ReflectionProbeTimeSlicingMode.AllFacesAtOnce;
                probe.resolution = 256;
                probe.hdr = true;
                probe.size = new Vector3(bb.size.x + 40f, bb.size.y + 60f, bb.size.z + 40f);
                probe.farClipPlane = 2000f;
                probe.RenderProbe();
            }
            foreach (var w in warnings) sb.AppendLine("!! " + w);
            File.WriteAllText(GolfMapCourses.ReportPath(course, "props.txt"), sb.ToString());
            if (!dryRun) EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            var result = new Dictionary<string, object>
            {
                { "manifest", manifest }, { "dryRun", dryRun }, { "placed", placed }, { "assets", counts },
                { "axis", axis }, { "warnings", warnings }, { "report", GolfMapCourses.ReportPath(course, "props.txt") },
            };
            if (dryRun) result["rows"] = rows;
            return result;
        }
    }
}
