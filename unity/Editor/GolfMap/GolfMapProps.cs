// Course props: buildings, shelters, flags, benches, cars ... built in Blender by
// blender/tools/build_props.py from a spec (docs/gspro/<course>/*-props.json) into
// <course>/Props/: Models/*.fbx, Textures/*.png and a golfmap-props-v1 manifest (props.json).
// This places them: builds a Standard material per manifest material (albedo, normal map,
// smoothness, metallic) and remaps every FBX onto them, then instantiates each instance under
// 'GolfMap Props' at its EPSG:3006 position (inner DEM sidecar frame), on the surface the player
// sees (highest collider under it: course meshes, else terrain), turned so the asset's Blender +x
// axis points along the instance's compass yawDeg. Buildings/structures get MeshColliders, small
// props box colliders or none, per the manifest. Placing replaces what the last place made, but
// keeps every instance the user moved or rotated in Unity: each place records what it placed in
// <props folder>/placed.json and the next one compares against it (GolfMapPropsPlaced.cs).
// Unity 2018.2 / C# 6.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Placed = GolfMap.Editor.GolfMapPropsPlaced;

namespace GolfMap.Editor
{
    public static class GolfMapProps
    {
        public const string RootName = "GolfMap Props";
        const string Format = "golfmap-props-v1";

        [MenuItem("GolfMap/Props/Place props from manifest")]
        static void Menu() { Debug.Log("[GolfMap Props] " + GolfMapJson.Serialize(Place(null, false, null, true, true), false)); }

        [BridgeCommand("golfmap.props.place", "Place the course's Blender-built props (<course>/Props/props.json, golfmap-props-v1 from blender/tools/build_props.py): Standard materials from the manifest (textures set up as albedo/normal maps), FBX materials remapped onto them, then every instance under 'GolfMap Props' at its EPSG:3006 position on the highest collider below (course meshes, else terrain), rotated to its yawDeg, with MeshColliders on buildings/structures. Replaces what the last place made, except the instances the user moved or rotated in Unity: those keep their transform (kept=true in the report, with both transforms), until the spec moves that instance itself. Marks the scene dirty unless save.",
            args = "folder (default <course>/Props/), dryRun=false (ground heights and the plan, kept instances included, nothing written), only (asset ids, comma-separated: place just these, keep the rest), materials=true (rebuild materials and FBX import settings), keepHandEdits=true (false: every instance from the spec, hand moves dropped - the old behaviour), " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return GolfMapSceneSave.After(a, Place(a.String("folder"), a.Bool("dryRun", false), only.Count == 0 ? null : new HashSet<string>(only), a.Bool("materials", true), a.Bool("keepHandEdits", true)));
        }

        [BridgeCommand("golfmap.props.clear", "Delete 'GolfMap Props' (everything golfmap.props.place made). The placed.json record stays, so the next place still keeps what was moved by hand. Marks the scene dirty unless save.", args = GolfMapSceneSave.Arg)]
        static object Clear(BridgeArgs a)
        {
            var root = FindRoot();
            if (root == null) return new Dictionary<string, object> { { "removed", 0 } };
            int n = root.GetComponentsInChildren<Transform>(true).Length - 1;
            Undo.DestroyObjectImmediate(root);
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return GolfMapSceneSave.After(a, new Dictionary<string, object> { { "removed", n } });
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
        internal static float? Ground(float x, float z, Transform ignore)
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

        // ---- hand edits: what the spec says, what stands in the scene -------------------------

        // The manifest's instances grouped by asset, each keeping its manifest index (the object name's #i).
        static Dictionary<string, List<Placed.SpecEntry>> SpecsByAsset(List<Inst> insts)
        {
            var byAsset = new Dictionary<string, List<Placed.SpecEntry>>();
            for (int i = 0; i < insts.Count; i++)
            {
                var inst = insts[i];
                if (string.IsNullOrEmpty(inst.asset)) continue;
                List<Placed.SpecEntry> l;
                if (!byAsset.TryGetValue(inst.asset, out l)) byAsset[inst.asset] = l = new List<Placed.SpecEntry>();
                l.Add(new Placed.SpecEntry { index = i, spec = SpecOf(inst) });
            }
            return byAsset;
        }

        static Placed.SpecPose SpecOf(Inst inst)
        {
            return new Placed.SpecPose { e = inst.e, n = inst.n, yaw = inst.yaw, dz = inst.dz, scale = inst.scale };
        }

        // The placed instances standing in the scene now, by asset: the direct children of the category
        // groups ('GolfMap Props/<Category>s/<asset>#<i>'), with their world transform.
        static Dictionary<string, List<Placed.SceneInstance>> SceneInstances(GameObject root)
        {
            var byAsset = new Dictionary<string, List<Placed.SceneInstance>>();
            if (root == null) return byAsset;
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                int hash = t.name.IndexOf('#');
                if (hash <= 0 || t.parent == null || t.parent.parent != root.transform) continue;
                var id = t.name.Substring(0, hash);
                List<Placed.SceneInstance> l;
                if (!byAsset.TryGetValue(id, out l)) byAsset[id] = l = new List<Placed.SceneInstance>();
                l.Add(new Placed.SceneInstance
                {
                    name = t.name,
                    pose = new Placed.Pose { pos = t.position, euler = t.eulerAngles, scale = t.localScale },
                });
            }
            return byAsset;
        }

        [BridgeCommand("golfmap.props.record", "Write <props folder>/placed.json from the props standing in the scene now, without touching one of them: for the first golfmap.props.place after the hand-edit keeping existed (an older scene has no record, so a place would replace every prop from the spec and drop the hand moves again). Each instance is tied to its spec entry by object name and recorded with the transform it has; mark=moved (default) calls an instance hand-placed when it stands more than 1 cm from where the spec puts it in x/z, mark=all calls every one hand-placed (the scene as it stands is what is wanted - no prop is re-grounded after a terrain change until its spec entry moves). A prop only ROTATED by hand is not found by mark=moved: use mark=all, or capture it into the spec (workflow 4).",
            args = "folder (default <course>/Props/), only (asset ids, comma-separated), mark=moved|all")]
        static object RecordCommand(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            var mark = a.String("mark", "moved");
            if (mark != "moved" && mark != "all") throw new BridgeError("mark must be moved or all.");
            return Record(a.String("folder"), only.Count == 0 ? null : new HashSet<string>(only), mark == "all");
        }

        // Seeds the sidecar golfmap.props.place reads. Only x/z is compared against the spec: those are a
        // pure function of the spec and the frame, while the height comes from a raycast that moves with
        // the terrain and the meshes (which is why the sidecar exists at all).
        public static Dictionary<string, object> Record(string folder, HashSet<string> only, bool markAll)
        {
            var course = GolfMapCourses.Require();
            folder = string.IsNullOrEmpty(folder) ? GolfMapCourses.Folder(course) + "Props/" : folder.Replace('\\', '/').TrimEnd('/') + "/";
            var manifest = folder + "props.json";
            if (!File.Exists(manifest)) throw new InvalidOperationException("No props manifest at " + manifest + ": run blender/tools/build_props.py with --out " + folder);
            List<Mat> mats; List<Asset> assets; List<Inst> insts;
            Load(manifest, out mats, out assets, out insts);
            double e0, n0; Vector3 origin;
            Frame(course, out e0, out n0, out origin);
            var specByAsset = SpecsByAsset(insts);
            var sceneByAsset = SceneInstances(FindRoot());
            var tolerance = new Placed.Tolerance();

            var sidecar = Placed.SidecarPath(folder);
            string note;
            var written = Placed.Load(sidecar, out note);
            foreach (var asset in specByAsset.Keys.ToList())
                if (only == null || only.Contains(asset)) written.Remove(asset);
            var rows = new List<object>();
            var missing = new List<object>();
            int hand = 0;
            for (int i = 0; i < insts.Count; i++)
            {
                var inst = insts[i];
                if (only != null && !only.Contains(inst.asset)) continue;
                var name = inst.asset + "#" + i;
                List<Placed.SceneInstance> standing;
                var found = sceneByAsset.TryGetValue(inst.asset, out standing) ? standing.FirstOrDefault(s => s.name == name) : null;
                if (found == null) { missing.Add(name); continue; }
                float dx = found.pose.pos.x - ((float)(inst.e - e0) + origin.x), dz = found.pose.pos.z - ((float)(inst.n - n0) + origin.z);
                float off = Mathf.Sqrt(dx * dx + dz * dz);
                bool isHand = markAll || off > tolerance.positionM;
                if (isHand) hand++;
                List<Placed.Record> list;
                if (!written.TryGetValue(inst.asset, out list)) written[inst.asset] = list = new List<Placed.Record>();
                list.Add(new Placed.Record { asset = inst.asset, index = i, name = name, hand = isHand, spec = SpecOf(inst), placed = found.pose });
                if (isHand && rows.Count < 400)
                    rows.Add(new Dictionary<string, object> {
                        { "asset", inst.asset }, { "index", i }, { "name", name }, { "offSpecM", Math.Round(off, 3) },
                        { "pos", new object[] { found.pose.pos.x, found.pose.pos.y, found.pose.pos.z } },
                        { "yaw", Math.Round(found.pose.euler.y, 2) } });
            }
            Placed.Save(sidecar, manifest, written, specByAsset.ToDictionary(kv => kv.Key, kv => Placed.SpecHash(kv.Value)));
            if (sidecar.StartsWith("Assets/", StringComparison.Ordinal)) AssetDatabase.ImportAsset(sidecar);
            return new Dictionary<string, object>
            {
                { "manifest", manifest }, { "placedRecord", sidecar }, { "mark", markAll ? "all" : "moved" },
                { "recorded", written.Where(kv => only == null || only.Contains(kv.Key)).Sum(kv => kv.Value.Count) },
                { "handPlaced", hand }, { "rows", rows },
                { "notInScene", missing },
                { "note", "Nothing in the scene was touched. Run golfmap.props.place {dryRun: true} next: the hand-placed instances must come back as kept." },
            };
        }

        // ---- place ----------------------------------------------------------------------------

        public static Dictionary<string, object> Place(string folder, bool dryRun, HashSet<string> only, bool materials, bool keepHandEdits)
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

            // What the last place made, what stands in the scene now, and so which instances the user
            // moved by hand (GolfMapPropsPlaced.cs). Read before anything is destroyed.
            var sidecar = Placed.SidecarPath(folder);
            string sidecarNote;
            var records = Placed.Load(sidecar, out sidecarNote);
            var specByAsset = SpecsByAsset(insts);
            var sceneByAsset = SceneInstances(FindRoot());
            var decisions = new Dictionary<int, Placed.Decision>();
            var droppedHand = new List<string>();
            var tolerance = new Placed.Tolerance();
            if (keepHandEdits)
                foreach (var kv in specByAsset)
                {
                    if (only != null && !only.Contains(kv.Key)) continue;
                    List<Placed.Record> known;
                    if (!records.TryGetValue(kv.Key, out known)) known = new List<Placed.Record>();
                    List<Placed.SceneInstance> standing;
                    if (!sceneByAsset.TryGetValue(kv.Key, out standing)) standing = new List<Placed.SceneInstance>();
                    List<Placed.Record> gone;
                    foreach (var d in Placed.Decide(kv.Value, known, standing, tolerance, out gone)) decisions[d.index] = d;
                    foreach (var g in gone)
                        if (g.hand) droppedHand.Add(kv.Key + " " + g.name + ": hand-placed, but the spec no longer has this instance");
                }

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
            var handPlaced = new List<object>();   // instances placed at the transform the user gave them
            var specWon = new List<object>();      // hand-placed instances the spec moved since: back to the spec
            int placed = 0, keptCount = 0;
            // The records this run writes: assets it does not place keep theirs.
            var written = new Dictionary<string, List<Placed.Record>>();
            foreach (var kv in records)
                if (only != null && !only.Contains(kv.Key)) written[kv.Key] = kv.Value;
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
                // An instance the user moved or rotated in Unity keeps its transform (the spec takes it
                // back only once the spec itself moved that instance); the ground is still sampled under
                // where it really stands, for the report's spread.
                Placed.Decision dec;
                bool kept = decisions.TryGetValue(i, out dec) && dec.kept;
                if (kept) { pos.x = dec.keep.pos.x; pos.z = dec.keep.pos.z; rot = Quaternion.Euler(dec.keep.euler); }
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
                // A kept instance carries its own height, so it is placed even where nothing answers the
                // raycast (the samples are then only for the report).
                if (samples.Count == 0 && !kept) { warnings.Add(inst.asset + " #" + i + ": nothing to stand on"); continue; }
                samples.Sort();
                float y = samples.Count == 0 ? 0f : samples[samples.Count / 2];
                if (samples.Count > 0)
                    switch (inst.ground)
                    {
                        case "max": y = samples[samples.Count - 1]; break;
                        case "min": y = samples[0]; break;
                        case "centre": y = samples[samples.Count / 2]; break;
                        default: y = samples[samples.Count / 2]; break;
                    }
                float spread = samples.Count == 0 ? 0f : samples[samples.Count - 1] - samples[0];
                pos.y = kept ? dec.keep.pos.y : y + inst.dz;
                if (samples.Count == 0) warnings.Add(inst.asset + " #" + i + ": nothing to stand on, but it is hand-placed: kept at its own height");
                if (a.category == "building" && spread > 1.0f) warnings.Add(string.Format("{0} #{1}: ground spread {2:F2} m under the footprint", inst.asset, i, spread));
                sb.AppendLine(string.Format("{0,-22} #{1,-3} E {2:F2} N {3:F2} yaw {4,6:F1}  y {5,7:F2}  spread {6:F2}{7}", inst.asset, i, inst.e, inst.n, inst.yaw, pos.y, spread, kept ? "  KEPT (hand-placed)" : ""));
                if (dec != null && (kept || dec.record != null && dec.record.hand))
                {
                    sb.AppendLine("     " + dec.reason);
                    if (dec.was != null)
                        sb.AppendLine(string.Format("     tool placed it at x {0:F2} y {1:F2} z {2:F2} yaw {3:F1}; now x {4:F2} y {5:F2} z {6:F2} yaw {7:F1}",
                            dec.was.pos.x, dec.was.pos.y, dec.was.pos.z, dec.was.euler.y, pos.x, pos.y, pos.z, rot.eulerAngles.y));
                    if (kept) handPlaced.Add(HandRow(inst, i, a.id, dec, pos, rot));
                    else specWon.Add(HandRow(inst, i, a.id, dec, pos, rot));
                }
                int c; counts.TryGetValue(inst.asset, out c); counts[inst.asset] = c + 1;
                placed++;
                if (kept) keptCount++;
                if (dryRun)
                {
                    if (rows.Count < 400) rows.Add(new Dictionary<string, object> {
                        { "asset", inst.asset }, { "index", i }, { "x", pos.x }, { "y", pos.y }, { "z", pos.z },
                        { "yaw", Math.Round(rot.eulerAngles.y, 2) }, { "spread", spread }, { "kept", kept },
                        { "rule", dec != null ? dec.rule : null }, { "note", dec != null ? dec.reason : null } });
                    continue;
                }

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
                go.transform.localScale = kept ? dec.keep.scale : Vector3.Scale(go.transform.localScale, inst.scale);
                // Record what this place put there, and whether that transform is the user's: the next
                // place reads this back (<props folder>/placed.json).
                List<Placed.Record> recorded;
                if (!written.TryGetValue(inst.asset, out recorded)) written[inst.asset] = recorded = new List<Placed.Record>();
                recorded.Add(new Placed.Record
                {
                    asset = inst.asset, index = i, name = go.name, hand = kept, spec = SpecOf(inst),
                    placed = new Placed.Pose { pos = go.transform.position, euler = go.transform.eulerAngles, scale = go.transform.localScale },
                });
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
            warnings.AddRange(droppedHand);
            foreach (var w in warnings) sb.AppendLine("!! " + w);
            if (keptCount > 0)
                sb.AppendLine("-- " + keptCount + " instance(s) kept their hand transform. To make a hand move permanent (and survive on another machine),"
                    + " carry it into docs/gspro/<course>/*-props.gen.py: workflow 4 in docs/workflows.md.");
            File.WriteAllText(GolfMapCourses.ReportPath(course, "props.txt"), sb.ToString());
            var specHashes = specByAsset.ToDictionary(kv => kv.Key, kv => Placed.SpecHash(kv.Value));
            if (!dryRun)
            {
                Placed.Save(sidecar, manifest, written, specHashes);
                if (sidecar.StartsWith("Assets/", StringComparison.Ordinal)) AssetDatabase.ImportAsset(sidecar);
                EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            }
            var result = new Dictionary<string, object>
            {
                { "manifest", manifest }, { "dryRun", dryRun }, { "placed", placed }, { "assets", counts },
                { "axis", axis }, { "warnings", warnings }, { "report", GolfMapCourses.ReportPath(course, "props.txt") },
                { "placedRecord", sidecar }, { "keepHandEdits", keepHandEdits }, { "kept", keptCount },
                { "handPlaced", handPlaced }, { "specWon", specWon },
            };
            if (sidecarNote != null) result["placedRecordNote"] = sidecarNote;
            if (dryRun) result["rows"] = rows;
            return result;
        }

        // One row of the place report's hand-edit lists: the spec entry, where the instance now stands,
        // and where the tool itself had put it.
        static Dictionary<string, object> HandRow(Inst inst, int index, string assetId, Placed.Decision dec, Vector3 pos, Quaternion rot)
        {
            var row = new Dictionary<string, object>
            {
                { "asset", assetId }, { "index", index }, { "name", assetId + "#" + index }, { "rule", dec.rule }, { "reason", dec.reason },
                { "spec", new Dictionary<string, object> { { "e", inst.e }, { "n", inst.n }, { "yawDeg", inst.yaw }, { "dz", inst.dz } } },
                { "unity", new Dictionary<string, object> { { "pos", new object[] { pos.x, pos.y, pos.z } }, { "yaw", Math.Round(rot.eulerAngles.y, 2) } } },
            };
            if (dec.was != null)
                row["toolPlaced"] = new Dictionary<string, object>
                {
                    { "pos", new object[] { dec.was.pos.x, dec.was.pos.y, dec.was.pos.z } },
                    { "yaw", Math.Round(dec.was.euler.y, 2) },
                };
            row["movedByHand"] = new Dictionary<string, object> { { "m", Math.Round(dec.movedM, 3) }, { "deg", Math.Round(dec.movedDeg, 2) } };
            row["specMoved"] = new Dictionary<string, object> { { "m", Math.Round(dec.specMovedM, 3) }, { "deg", Math.Round(dec.specMovedDeg, 2) } };
            return row;
        }
    }
}
