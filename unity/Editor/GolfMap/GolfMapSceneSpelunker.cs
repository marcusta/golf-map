// Dumps everything in the open scene and the surrounding project that a
// golf-map exporter needs to know to fit into an OPCD/GSPro base project:
// terrains, meshes, colliders, tags, layers, materials, shaders, physics
// materials, custom scripts and their serialized fields, packages.
// Menu: GolfMap > Spelunk Scene. Writes <name>.json (full) and <name>.md (summary).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    public class GolfMapSceneSpelunker : EditorWindow
    {
        [SerializeField] string outputDir = "";
        [SerializeField] int maxChildrenPerObject = 200;
        [SerializeField] bool includeInactive = true;
        [SerializeField] bool dumpScriptFields = true;
        [SerializeField] bool listProjectScripts = true;
        [SerializeField] bool listProjectPrefabs = true;

        string status = "";

        // aggregate counters
        readonly Dictionary<string, int> tagCounts = new Dictionary<string, int>();
        readonly Dictionary<string, int> layerCounts = new Dictionary<string, int>();
        readonly Dictionary<string, int> componentCounts = new Dictionary<string, int>();
        readonly Dictionary<string, int> shaderCounts = new Dictionary<string, int>();
        readonly Dictionary<string, int> materialCounts = new Dictionary<string, int>();
        readonly Dictionary<string, int> physicsMaterialCounts = new Dictionary<string, int>();
        readonly Dictionary<string, int> prefabSourceCounts = new Dictionary<string, int>();
        readonly Dictionary<string, int> customScriptCounts = new Dictionary<string, int>();
        readonly List<Dictionary<string, object>> terrains = new List<Dictionary<string, object>>();
        readonly List<Dictionary<string, object>> meshes = new List<Dictionary<string, object>>();
        Bounds sceneBounds;
        bool sceneBoundsSet;
        int objectCount;

        [MenuItem("GolfMap/Spelunk Scene")]
        public static void Open() => GetWindow<GolfMapSceneSpelunker>("GolfMap Spelunk");

        void OnGUI()
        {
            EditorGUILayout.LabelField("Scene: " + SceneManager.GetActiveScene().name, EditorStyles.boldLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                outputDir = EditorGUILayout.TextField("Output folder", outputDir);
                if (GUILayout.Button("...", GUILayout.Width(30)))
                {
                    var picked = EditorUtility.OpenFolderPanel("Report folder", outputDir, "");
                    if (!string.IsNullOrEmpty(picked)) outputDir = picked;
                }
            }
            maxChildrenPerObject = EditorGUILayout.IntField("Max children listed per object", maxChildrenPerObject);
            includeInactive = EditorGUILayout.Toggle("Include inactive objects", includeInactive);
            dumpScriptFields = EditorGUILayout.Toggle("Dump script fields", dumpScriptFields);
            listProjectScripts = EditorGUILayout.Toggle("List project scripts", listProjectScripts);
            listProjectPrefabs = EditorGUILayout.Toggle("List project prefabs", listProjectPrefabs);
            EditorGUILayout.Space();
            if (GUILayout.Button("Spelunk")) Run();
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.Info);
        }

        void Run()
        {
            try
            {
                var dir = string.IsNullOrEmpty(outputDir) ? Path.Combine(Directory.GetParent(Application.dataPath).FullName, "GolfMapSpelunk") : outputDir;
                Directory.CreateDirectory(dir);
                var scene = SceneManager.GetActiveScene();
                var name = string.IsNullOrEmpty(scene.name) ? "untitled" : scene.name;
                var report = Build(scene);
                var jsonPath = Path.Combine(dir, name + ".json");
                var mdPath = Path.Combine(dir, name + ".md");
                File.WriteAllText(jsonPath, GolfMapJson.Serialize(report));
                File.WriteAllText(mdPath, Summary(report));
                status = $"Wrote {jsonPath} and {mdPath}. {objectCount} objects, {terrains.Count} terrains, {meshes.Count} meshes.";
                Debug.Log("[GolfMap] " + status);
                EditorUtility.RevealInFinder(mdPath);
            }
            catch (Exception e)
            {
                status = "Failed: " + e.Message;
                Debug.LogException(e);
            }
        }

        // ---- collection ----------------------------------------------------

        Dictionary<string, object> Build(Scene scene)
        {
            tagCounts.Clear(); layerCounts.Clear(); componentCounts.Clear(); shaderCounts.Clear();
            materialCounts.Clear(); physicsMaterialCounts.Clear(); prefabSourceCounts.Clear(); customScriptCounts.Clear();
            terrains.Clear(); meshes.Clear();
            sceneBoundsSet = false; objectCount = 0;

            var roots = scene.GetRootGameObjects();
            var hierarchy = new List<object>();
            foreach (var root in roots) { var rd = Describe(root, ""); if (rd != null) hierarchy.Add(rd); }

            return new Dictionary<string, object>
            {
                { "generatedAt", DateTime.UtcNow.ToString("o") },
                { "unityVersion", Application.unityVersion },
                { "projectPath", Directory.GetParent(Application.dataPath).FullName },
                { "scene", new Dictionary<string, object> { { "name", scene.name }, { "path", scene.path }, { "rootCount", roots.Length }, { "objectCount", objectCount },
                    { "bounds", sceneBoundsSet ? (object)sceneBounds : null } } },
                { "project", Project() },
                { "summary", new Dictionary<string, object>
                    {
                        { "tags", Sorted(tagCounts) }, { "layers", Sorted(layerCounts) }, { "components", Sorted(componentCounts) },
                        { "customScripts", Sorted(customScriptCounts) }, { "shaders", Sorted(shaderCounts) }, { "materials", Sorted(materialCounts) },
                        { "physicsMaterials", Sorted(physicsMaterialCounts) }, { "prefabSources", Sorted(prefabSourceCounts) },
                    } },
                { "terrains", terrains },
                { "meshes", meshes },
                { "hierarchy", hierarchy },
            };
        }

        Dictionary<string, object> Describe(GameObject go, string parentPath)
        {
            if (!includeInactive && !go.activeInHierarchy) return null;
            objectCount++;
            var path = parentPath + "/" + go.name;
            var layerName = LayerMask.LayerToName(go.layer);
            if (string.IsNullOrEmpty(layerName)) layerName = "layer" + go.layer;
            Bump(tagCounts, go.tag);
            Bump(layerCounts, layerName);

            var d = new Dictionary<string, object>
            {
                { "name", go.name }, { "path", path }, { "active", go.activeSelf }, { "tag", go.tag }, { "layer", layerName },
                { "static", GameObjectUtility.GetStaticEditorFlags(go).ToString() },
                { "position", go.transform.position }, { "rotation", go.transform.rotation.eulerAngles }, { "scale", go.transform.lossyScale },
            };
            var source = PrefabUtility.GetCorrespondingObjectFromSource(go);
            if (source != null)
            {
                var assetPath = AssetDatabase.GetAssetPath(source);
                d["prefab"] = assetPath;
                if (PrefabUtility.IsAnyPrefabInstanceRoot(go)) Bump(prefabSourceCounts, assetPath);
            }

            var comps = new List<object>();
            foreach (var c in go.GetComponents<Component>())
            {
                if (c == null) { comps.Add(new Dictionary<string, object> { { "type", "MissingScript" } }); Bump(componentCounts, "MissingScript"); continue; }
                if (c is Transform) continue;
                var typeName = c.GetType().Name;
                Bump(componentCounts, typeName);
                comps.Add(DescribeComponent(c, path));
            }
            d["components"] = comps;

            var children = new List<object>();
            int n = go.transform.childCount;
            for (int i = 0; i < n && i < maxChildrenPerObject; i++)
            {
                var cd = Describe(go.transform.GetChild(i).gameObject, path);
                if (cd != null) children.Add(cd);
            }
            if (n > maxChildrenPerObject)
            {
                // still count the rest for the aggregates, but only summarize them
                var sig = new Dictionary<string, int>();
                for (int i = maxChildrenPerObject; i < n; i++)
                {
                    var child = go.transform.GetChild(i).gameObject;
                    CountOnly(child);
                    Bump(sig, ComponentSignature(child));
                }
                d["childrenTruncated"] = new Dictionary<string, object> { { "listed", maxChildrenPerObject }, { "total", n }, { "restBySignature", Sorted(sig) } };
            }
            if (children.Count > 0) d["children"] = children;
            return d;
        }

        void CountOnly(GameObject go)
        {
            if (!includeInactive && !go.activeInHierarchy) return;
            objectCount++;
            Bump(tagCounts, go.tag);
            Bump(layerCounts, LayerMask.LayerToName(go.layer));
            foreach (var c in go.GetComponents<Component>())
            {
                if (c == null || c is Transform) continue;
                Bump(componentCounts, c.GetType().Name);
                if (c is Renderer r) foreach (var m in r.sharedMaterials) CountMaterial(m);
                if (c is Collider col) { if (col.sharedMaterial != null) Bump(physicsMaterialCounts, col.sharedMaterial.name); }
                if (IsCustomScript(c)) Bump(customScriptCounts, c.GetType().FullName);
            }
            for (int i = 0; i < go.transform.childCount; i++) CountOnly(go.transform.GetChild(i).gameObject);
        }

        static string ComponentSignature(GameObject go)
        {
            var names = go.GetComponents<Component>().Where(c => c != null && !(c is Transform)).Select(c => c.GetType().Name).OrderBy(s => s);
            var src = PrefabUtility.GetCorrespondingObjectFromSource(go);
            return (src != null ? Path.GetFileName(AssetDatabase.GetAssetPath(src)) + " " : "") + "[" + string.Join(",", names) + "]";
        }

        Dictionary<string, object> DescribeComponent(Component c, string path)
        {
            var d = new Dictionary<string, object> { { "type", c.GetType().Name } };
            switch (c)
            {
                case Terrain t: DescribeTerrain(t, path, d); break;
                case MeshFilter mf: DescribeMesh(mf.sharedMesh, mf.transform, path, d); break;
                case SkinnedMeshRenderer smr: DescribeMesh(smr.sharedMesh, smr.transform, path, d); DescribeRenderer(smr, d); break;
                case Renderer r: DescribeRenderer(r, d); break;
                case TerrainCollider tc: d["terrainData"] = tc.terrainData != null ? tc.terrainData.name : null; break;
                case Collider col: DescribeCollider(col, d); break;
                case Light l: d["lightType"] = l.type; d["intensity"] = l.intensity; d["color"] = l.color; d["shadows"] = l.shadows; break;
                case Camera cam: d["fov"] = cam.fieldOfView; d["near"] = cam.nearClipPlane; d["far"] = cam.farClipPlane; d["cullingMask"] = cam.cullingMask; break;
            }
            if (c is Behaviour b) d["enabled"] = b.enabled;
            if (IsCustomScript(c))
            {
                var full = c.GetType().FullName;
                Bump(customScriptCounts, full);
                d["script"] = full;
                d["assembly"] = c.GetType().Assembly.GetName().Name;
                var ms = MonoScript.FromMonoBehaviour((MonoBehaviour)c);
                if (ms != null) d["scriptPath"] = AssetDatabase.GetAssetPath(ms);
                if (dumpScriptFields) d["fields"] = SerializedFields(c);
            }
            return d;
        }

        static bool IsCustomScript(Component c)
        {
            if (!(c is MonoBehaviour)) return false;
            var asm = c.GetType().Assembly.GetName().Name;
            return !asm.StartsWith("UnityEngine") && !asm.StartsWith("UnityEditor") && !asm.StartsWith("Unity.");
        }

        void DescribeTerrain(Terrain t, string path, Dictionary<string, object> d)
        {
            var data = t.terrainData;
            if (data == null) { d["terrainData"] = null; return; }
            var td = new Dictionary<string, object>
            {
                { "path", path }, { "terrainData", AssetDatabase.GetAssetPath(data) }, { "position", t.transform.position },
                { "size", data.size }, { "heightmapResolution", data.heightmapResolution },
                { "alphamapResolution", data.alphamapResolution }, { "detailResolution", data.detailResolution },
                { "baseMapResolution", data.baseMapResolution },
                { "terrainLayers", data.terrainLayers.Select(l => l == null ? null : new Dictionary<string, object> {
                    { "name", l.name }, { "diffuse", l.diffuseTexture != null ? AssetDatabase.GetAssetPath(l.diffuseTexture) : null }, { "tileSize", l.tileSize } }).ToList() },
                { "treePrototypes", data.treePrototypes.Select(p => p.prefab != null ? AssetDatabase.GetAssetPath(p.prefab) : "(null)").ToList() },
                { "treeInstanceCount", data.treeInstanceCount },
                { "treeInstancesByPrototype", TreeCounts(data) },
                { "detailPrototypes", data.detailPrototypes.Select(p => p.prototype != null ? AssetDatabase.GetAssetPath(p.prototype) : (p.prototypeTexture != null ? AssetDatabase.GetAssetPath(p.prototypeTexture) : "(null)")).ToList() },
                { "materialTemplate", t.materialTemplate != null ? t.materialTemplate.name : null },
                { "materialShader", t.materialTemplate != null && t.materialTemplate.shader != null ? t.materialTemplate.shader.name : null },
                { "drawInstanced", t.drawInstanced }, { "treeDistance", t.treeDistance }, { "detailObjectDistance", t.detailObjectDistance },
                { "heightRange", HeightRange(data) },
            };
            terrains.Add(td);
            d["terrain"] = td["terrainData"];
            d["size"] = data.size;
            Encapsulate(new Bounds(t.transform.position + data.size / 2f, data.size));
        }

        static List<object> TreeCounts(TerrainData data)
        {
            var counts = new int[Mathf.Max(1, data.treePrototypes.Length)];
            foreach (var ti in data.treeInstances) if (ti.prototypeIndex >= 0 && ti.prototypeIndex < counts.Length) counts[ti.prototypeIndex]++;
            return counts.Cast<object>().ToList();
        }

        static Dictionary<string, object> HeightRange(TerrainData data)
        {
            int res = data.heightmapResolution;
            int step = Mathf.Max(1, res / 257);
            float min = float.MaxValue, max = float.MinValue;
            var heights = data.GetHeights(0, 0, res, res);
            for (int y = 0; y < res; y += step)
                for (int x = 0; x < res; x += step)
                {
                    float h = heights[y, x] * data.size.y;
                    if (h < min) min = h;
                    if (h > max) max = h;
                }
            return new Dictionary<string, object> { { "minM", min }, { "maxM", max }, { "sampledEvery", step } };
        }

        void DescribeMesh(Mesh mesh, Transform tr, string path, Dictionary<string, object> d)
        {
            if (mesh == null) { d["mesh"] = null; return; }
            var world = TransformBounds(mesh.bounds, tr);
            var md = new Dictionary<string, object>
            {
                { "path", path }, { "mesh", mesh.name }, { "asset", AssetDatabase.GetAssetPath(mesh) },
                { "vertices", mesh.vertexCount }, { "triangles", mesh.triangles.Length / 3 }, { "subMeshes", mesh.subMeshCount },
                { "hasUV", mesh.uv != null && mesh.uv.Length > 0 }, { "hasNormals", mesh.normals != null && mesh.normals.Length > 0 },
                { "readable", mesh.isReadable }, { "worldBounds", world },
                { "tag", tr.tag }, { "layer", LayerMask.LayerToName(tr.gameObject.layer) },
            };
            var r = tr.GetComponent<Renderer>();
            if (r != null) md["materials"] = r.sharedMaterials.Select(m => m != null ? m.name : "(null)").ToList();
            var col = tr.GetComponent<Collider>();
            if (col != null) { md["collider"] = col.GetType().Name; md["physicsMaterial"] = col.sharedMaterial != null ? col.sharedMaterial.name : null; }
            meshes.Add(md);
            d["mesh"] = mesh.name; d["vertices"] = mesh.vertexCount; d["triangles"] = mesh.triangles.Length / 3;
            Encapsulate(world);
        }

        void DescribeRenderer(Renderer r, Dictionary<string, object> d)
        {
            var mats = new List<object>();
            foreach (var m in r.sharedMaterials)
            {
                CountMaterial(m);
                if (m == null) { mats.Add(null); continue; }
                mats.Add(new Dictionary<string, object> { { "name", m.name }, { "shader", m.shader != null ? m.shader.name : null }, { "asset", AssetDatabase.GetAssetPath(m) },
                    { "mainTexture", m.HasProperty("_MainTex") && m.mainTexture != null ? AssetDatabase.GetAssetPath(m.mainTexture) : null } });
            }
            d["materials"] = mats;
            d["castShadows"] = r.shadowCastingMode; d["receiveShadows"] = r.receiveShadows;
            d["lightmapIndex"] = r.lightmapIndex;
        }

        void CountMaterial(Material m)
        {
            if (m == null) { Bump(materialCounts, "(null)"); return; }
            Bump(materialCounts, m.name);
            Bump(shaderCounts, m.shader != null ? m.shader.name : "(null)");
        }

        void DescribeCollider(Collider col, Dictionary<string, object> d)
        {
            d["isTrigger"] = col.isTrigger;
            d["physicsMaterial"] = col.sharedMaterial != null ? col.sharedMaterial.name : null;
            if (col.sharedMaterial != null)
            {
                Bump(physicsMaterialCounts, col.sharedMaterial.name);
                d["physicsMaterialAsset"] = AssetDatabase.GetAssetPath(col.sharedMaterial);
            }
            if (col is MeshCollider mc) { d["convex"] = mc.convex; d["colliderMesh"] = mc.sharedMesh != null ? mc.sharedMesh.name : null; }
            d["worldBounds"] = col.bounds;
        }

        static List<object> SerializedFields(Component c)
        {
            var fields = new List<object>();
            var so = new SerializedObject(c);
            var it = so.GetIterator();
            bool enter = true;
            while (it.NextVisible(enter))
            {
                enter = false;
                if (it.name == "m_Script") continue;
                fields.Add(new Dictionary<string, object> { { "name", it.name }, { "type", it.propertyType.ToString() }, { "value", PropValue(it) } });
            }
            return fields;
        }

        static object PropValue(SerializedProperty p)
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer: return p.longValue;
                case SerializedPropertyType.Boolean: return p.boolValue;
                case SerializedPropertyType.Float: return p.doubleValue;
                case SerializedPropertyType.String: return p.stringValue;
                case SerializedPropertyType.Enum: return p.enumValueIndex >= 0 && p.enumValueIndex < p.enumDisplayNames.Length ? p.enumDisplayNames[p.enumValueIndex] : p.enumValueIndex.ToString();
                case SerializedPropertyType.Vector2: return p.vector2Value;
                case SerializedPropertyType.Vector3: return p.vector3Value;
                case SerializedPropertyType.Color: return p.colorValue;
                case SerializedPropertyType.LayerMask: return p.intValue;
                case SerializedPropertyType.ObjectReference:
                    if (p.objectReferenceValue == null) return null;
                    var path = AssetDatabase.GetAssetPath(p.objectReferenceValue);
                    return p.objectReferenceValue.GetType().Name + ":" + (string.IsNullOrEmpty(path) ? p.objectReferenceValue.name : path);
                case SerializedPropertyType.Generic: return p.isArray ? "array[" + p.arraySize + "]" : "struct";
                default: return p.propertyType.ToString();
            }
        }

        // ---- project -------------------------------------------------------

        Dictionary<string, object> Project()
        {
            var layers = new Dictionary<string, object>();
            for (int i = 0; i < 32; i++) { var n = LayerMask.LayerToName(i); if (!string.IsNullOrEmpty(n)) layers[i.ToString()] = n; }
            var p = new Dictionary<string, object>
            {
                { "tags", UnityEditorInternal.InternalEditorUtility.tags.ToList() },
                { "layers", layers },
                { "sortingLayers", SortingLayer.layers.Select(l => l.name).ToList() },
                { "renderPipeline", UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline != null ? UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline.GetType().Name : "Built-in" },
                { "colorSpace", PlayerSettings.colorSpace.ToString() },
                { "physicsMaterialAssets", FindAssets("t:PhysicMaterial") },
                { "terrainDataAssets", FindAssets("t:TerrainData") },
                { "terrainLayerAssets", FindAssets("t:TerrainLayer") },
                { "scenes", FindAssets("t:Scene") },
                { "packages", Packages() },
            };
            if (listProjectScripts) p["scripts"] = ScriptsByFolder();
            if (listProjectPrefabs)
            {
                var prefabs = FindAssets("t:Prefab");
                p["prefabCount"] = prefabs.Count;
                p["prefabsByFolder"] = prefabs.GroupBy(x => Path.GetDirectoryName(x)).OrderByDescending(g => g.Count())
                    .ToDictionary(g => g.Key, g => (object)g.Count());
            }
            return p;
        }

        static List<string> FindAssets(string filter) =>
            AssetDatabase.FindAssets(filter).Select(AssetDatabase.GUIDToAssetPath).Where(x => x.StartsWith("Assets/")).OrderBy(x => x).ToList();

        static Dictionary<string, object> ScriptsByFolder()
        {
            var byFolder = new Dictionary<string, object>();
            foreach (var g in FindAssets("t:MonoScript").GroupBy(x => Path.GetDirectoryName(x)).OrderBy(g => g.Key))
                byFolder[g.Key] = g.Select(x => Path.GetFileName(x)).ToList();
            return byFolder;
        }

        static List<object> Packages()
        {
            var list = new List<object>();
#if UNITY_2021_1_OR_NEWER
            foreach (var info in UnityEditor.PackageManager.PackageInfo.GetAllRegisteredPackages())
                if (info.source != UnityEditor.PackageManager.PackageSource.BuiltIn)
                    list.Add(info.name + "@" + info.version);
#else
            var manifest = Path.Combine(Directory.GetParent(Application.dataPath).FullName, "Packages", "manifest.json");
            if (File.Exists(manifest)) list.Add(File.ReadAllText(manifest));
#endif
            return list;
        }

        // ---- helpers -------------------------------------------------------

        static void Bump(Dictionary<string, int> d, string key) { d.TryGetValue(key, out var n); d[key] = n + 1; }

        static Dictionary<string, object> Sorted(Dictionary<string, int> d) =>
            d.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key).ToDictionary(kv => kv.Key, kv => (object)kv.Value);

        void Encapsulate(Bounds b)
        {
            if (!sceneBoundsSet) { sceneBounds = b; sceneBoundsSet = true; } else sceneBounds.Encapsulate(b);
        }

        static Bounds TransformBounds(Bounds local, Transform tr)
        {
            var c = local.center; var e = local.extents;
            var corners = new[]
            {
                new Vector3(c.x - e.x, c.y - e.y, c.z - e.z), new Vector3(c.x + e.x, c.y - e.y, c.z - e.z),
                new Vector3(c.x - e.x, c.y + e.y, c.z - e.z), new Vector3(c.x + e.x, c.y + e.y, c.z - e.z),
                new Vector3(c.x - e.x, c.y - e.y, c.z + e.z), new Vector3(c.x + e.x, c.y - e.y, c.z + e.z),
                new Vector3(c.x - e.x, c.y + e.y, c.z + e.z), new Vector3(c.x + e.x, c.y + e.y, c.z + e.z),
            };
            var b = new Bounds(tr.TransformPoint(corners[0]), Vector3.zero);
            for (int i = 1; i < corners.Length; i++) b.Encapsulate(tr.TransformPoint(corners[i]));
            return b;
        }

        // ---- markdown summary ----------------------------------------------

        string Summary(Dictionary<string, object> report)
        {
            var sb = new StringBuilder();
            var scene = (Dictionary<string, object>)report["scene"];
            var project = (Dictionary<string, object>)report["project"];
            var summary = (Dictionary<string, object>)report["summary"];
            sb.AppendLine($"# Scene spelunk: {scene["name"]}");
            sb.AppendLine();
            sb.AppendLine($"Unity {report["unityVersion"]}, {project["renderPipeline"]} pipeline, {project["colorSpace"]} color space.");
            sb.AppendLine($"{scene["objectCount"]} objects, {terrains.Count} terrains, {meshes.Count} meshes.");
            if (scene["bounds"] is Bounds b) sb.AppendLine($"Scene bounds min {Fmt(b.min)} max {Fmt(b.max)} size {Fmt(b.size)}.");
            sb.AppendLine();

            sb.AppendLine("## Terrains");
            sb.AppendLine();
            if (terrains.Count == 0) sb.AppendLine("None.");
            foreach (var t in terrains)
            {
                var hr = (Dictionary<string, object>)t["heightRange"];
                sb.AppendLine($"- `{t["path"]}` size {Fmt((Vector3)t["size"])} at {Fmt((Vector3)t["position"])}, heightmap {t["heightmapResolution"]}, alphamap {t["alphamapResolution"]}, sampled height {hr["minM"]:0.0}..{hr["maxM"]:0.0} m, {t["treeInstanceCount"]} tree instances, shader {t["materialShader"]}");
                var protos = (List<string>)t["treePrototypes"];
                var counts = (List<object>)t["treeInstancesByPrototype"];
                for (int i = 0; i < protos.Count; i++) sb.AppendLine($"  - tree prototype {i}: {protos[i]} ({counts[i]})");
                foreach (var l in (List<Dictionary<string, object>>)t["terrainLayers"]) if (l != null) sb.AppendLine($"  - terrain layer {l["name"]}: {l["diffuse"]}");
            }
            sb.AppendLine();

            Table(sb, "Tags in scene", summary["tags"], "tag", "objects");
            Table(sb, "Layers in scene", summary["layers"], "layer", "objects");
            Table(sb, "Components", summary["components"], "component", "count");
            Table(sb, "Custom scripts", summary["customScripts"], "script", "count");
            Table(sb, "Shaders", summary["shaders"], "shader", "materials");
            Table(sb, "Physics materials", summary["physicsMaterials"], "material", "colliders");
            Table(sb, "Prefab sources", summary["prefabSources"], "prefab", "instances");

            sb.AppendLine("## Meshes by tag");
            sb.AppendLine();
            sb.AppendLine("| tag | layer | meshes | triangles | colliders | physics materials | materials |");
            sb.AppendLine("|---|---|---|---|---|---|---|");
            foreach (var g in meshes.GroupBy(m => (string)m["tag"] + "|" + (string)m["layer"]).OrderBy(g => g.Key))
            {
                var parts = g.Key.Split('|');
                var tris = g.Sum(m => (int)m["triangles"]);
                var cols = g.Count(m => m.ContainsKey("collider"));
                var pms = string.Join(", ", g.Where(m => m.ContainsKey("physicsMaterial") && m["physicsMaterial"] != null).Select(m => (string)m["physicsMaterial"]).Distinct());
                var mats = string.Join(", ", g.Where(m => m.ContainsKey("materials")).SelectMany(m => (List<string>)m["materials"]).Distinct().Take(6));
                sb.AppendLine($"| {parts[0]} | {parts[1]} | {g.Count()} | {tris} | {cols} | {pms} | {mats} |");
            }
            sb.AppendLine();

            sb.AppendLine("## Project");
            sb.AppendLine();
            sb.AppendLine("Tags: " + string.Join(", ", (List<string>)project["tags"]));
            sb.AppendLine();
            sb.AppendLine("Layers: " + string.Join(", ", ((Dictionary<string, object>)project["layers"]).Select(kv => kv.Key + "=" + kv.Value)));
            sb.AppendLine();
            sb.AppendLine("Physics material assets: " + string.Join(", ", (List<string>)project["physicsMaterialAssets"]));
            sb.AppendLine();
            sb.AppendLine("Packages: " + string.Join(", ", ((List<object>)project["packages"]).Select(x => x.ToString())));
            sb.AppendLine();
            if (project.ContainsKey("scripts"))
            {
                sb.AppendLine("Script folders:");
                foreach (var kv in (Dictionary<string, object>)project["scripts"])
                    sb.AppendLine($"- {kv.Key}: {string.Join(", ", (List<string>)kv.Value)}");
                sb.AppendLine();
            }
            sb.AppendLine("Top-level hierarchy:");
            foreach (var root in (List<object>)report["hierarchy"])
            {
                if (!(root is Dictionary<string, object> r)) continue;
                int kids = r.ContainsKey("children") ? ((List<object>)r["children"]).Count : 0;
                if (r.ContainsKey("childrenTruncated")) kids = (int)((Dictionary<string, object>)r["childrenTruncated"])["total"];
                var comps = string.Join(", ", ((List<object>)r["components"]).Select(c => (string)((Dictionary<string, object>)c)["type"]));
                sb.AppendLine($"- {r["name"]} [{r["tag"]}/{r["layer"]}] {kids} children; {comps}");
            }
            return sb.ToString();
        }

        static void Table(StringBuilder sb, string title, object dict, string keyHeader, string valueHeader)
        {
            sb.AppendLine("## " + title);
            sb.AppendLine();
            var d = (Dictionary<string, object>)dict;
            if (d.Count == 0) { sb.AppendLine("None."); sb.AppendLine(); return; }
            sb.AppendLine($"| {keyHeader} | {valueHeader} |");
            sb.AppendLine("|---|---|");
            foreach (var kv in d) sb.AppendLine($"| {kv.Key} | {kv.Value} |");
            sb.AppendLine();
        }

        static string Fmt(Vector3 v) => $"({v.x:0.0}, {v.y:0.0}, {v.z:0.0})";
    }
}
