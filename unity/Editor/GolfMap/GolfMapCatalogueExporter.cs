// Unity 2018.2 / C# 6. No VSP assembly dependency and no scene instantiation.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public class GolfMapCatalogueExporter : EditorWindow
    {
        [Serializable] public class Catalogue
        {
            public string format = "golfmap-asset-catalogue-v1";
            public string unityVersion, capturedUtc, scope;
            public bool complete;
            public List<Entry> assets = new List<Entry>();
            public List<string> warnings = new List<string>();
            public List<Package> vspPackages = new List<Package>();
        }
        [Serializable] public class Package { public string guid, path, settingsJson; }
        [Serializable] public class Property { public string name, type, value, textureGuid; }
        [Serializable] public class MaterialInfo
        {
            public string guid, path, name, shader;
            public string[] keywords;
            public int renderQueue;
            public List<Property> properties = new List<Property>();
        }
        [Serializable] public class LodInfo { public string group; public int level, triangles; public float transition; }
        [Serializable] public class Entry
        {
            public string guid, path, name, preview, error;
            public Vector3 size, center;
            public float heightM, crownWidthM;
            public string dimensionMethod = "Combined static mesh bounds in root-local space; all LODs. Width is max X/Z, not a botanical crown measurement.";
            public List<MaterialInfo> materials = new List<MaterialInfo>();
            public List<LodInfo> lods = new List<LodInfo>();
            public List<string> vspItems = new List<string>();
            public List<string> warnings = new List<string>();
        }

        string folders = "Assets/Trees;Assets/2018.2 Prefabs;Assets/TreeShare;Assets/NatureManufacture Assets;Assets/Birch Trees Package;Assets/Oak Trees Package;Assets/CESimgolf 3D Assets;Assets/Grasses;Assets/Grasses_Flowers;Assets/RUSTIC Grass";
        string status = "Choose folders separated by semicolons. Exports prefabs and model assets; includes demos within those folders.";
        bool previews = true;
        [MenuItem("GolfMap/Export Asset Catalogue")]
        public static void Open() { GetWindow<GolfMapCatalogueExporter>("Asset Catalogue"); }
        void OnGUI()
        {
            EditorGUILayout.LabelField("Asset folders (semicolon separated)");
            folders = EditorGUILayout.TextArea(folders, GUILayout.Height(90));
            previews = EditorGUILayout.Toggle("Render previews", previews);
            EditorGUILayout.HelpBox("Writes a new timestamped report outside Assets. Reads assets without instantiating scripts or saving the scene. Preview lighting is standardized, not the course lighting. Start with Assets/Trees for a small trial.", MessageType.Info);
            if (GUILayout.Button("Export catalogue and gallery"))
            {
                var parent = EditorUtility.OpenFolderPanel("Catalogue output parent", Path.GetFullPath("."), "");
                if (!string.IsNullOrEmpty(parent))
                {
                    try { status = Export(parent, folders, previews); }
                    catch (Exception ex) { status = ex.ToString(); Debug.LogException(ex); }
                }
            }
            EditorGUILayout.HelpBox(status, MessageType.None);
        }

        static string GuidFor(UnityEngine.Object obj) { return obj ? AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(obj)) : ""; }
        static string Export(string parent, string scope, bool render)
        {
            var output = Path.Combine(parent, "GolfMapCatalogue-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6));
            var assetsDir = Path.GetFullPath(Application.dataPath).TrimEnd(Path.DirectorySeparatorChar);
            var fullOutput = Path.GetFullPath(output);
            if (fullOutput.StartsWith(assetsDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Choose an output folder outside Assets.");
            var roots = scope.Split(';').Select(s => s.Trim()).Where(s => s.Length > 0).Distinct().ToArray();
            if (roots.Length == 0 || roots.Any(r => !AssetDatabase.IsValidFolder(r)))
                throw new InvalidOperationException("Every scope entry must be an existing Assets folder.");
            Directory.CreateDirectory(Path.Combine(output, "previews"));
            var report = new Catalogue { unityVersion = Application.unityVersion, capturedUtc = DateTime.UtcNow.ToString("o"), scope = scope };
            var paths = AssetDatabase.FindAssets("t:GameObject", roots).Select(AssetDatabase.GUIDToAssetPath).Distinct().OrderBy(s => s, StringComparer.Ordinal).ToArray();
            var links = ReadVsp(report);
            try
            {
                for (int i = 0; i < paths.Length; i++)
                {
                    if (EditorUtility.DisplayCancelableProgressBar("Export asset catalogue", paths[i], (float)i / Math.Max(1, paths.Length)))
                    { report.warnings.Add("Cancelled by user; this is a partial catalogue."); break; }
                    var entry = new Entry { guid = AssetDatabase.AssetPathToGUID(paths[i]), path = paths[i], name = Path.GetFileNameWithoutExtension(paths[i]) };
                    report.assets.Add(entry);
                    try
                    {
                        var asset = AssetDatabase.LoadAssetAtPath<GameObject>(paths[i]);
                        if (!asset) throw new InvalidOperationException("Cannot load GameObject asset.");
                        Inspect(asset, entry, output, render);
                        List<string> items;
                        if (links.TryGetValue(entry.guid, out items)) entry.vspItems.AddRange(items);
                    }
                    catch (Exception ex) { entry.error = ex.Message; }
                }
                report.complete = report.assets.Count == paths.Length && report.assets.All(e => string.IsNullOrEmpty(e.error) && e.warnings.Count == 0) && report.warnings.Count == 0;
            }
            finally
            {
                EditorUtility.ClearProgressBar();
                File.WriteAllText(Path.Combine(output, "catalogue.json"), JsonUtility.ToJson(report, true), Encoding.UTF8);
                WriteGallery(output, report);
            }
            return (report.complete ? "Complete: " : "Partial / warnings: ") + report.assets.Count + " assets. " + output;
        }

        static Dictionary<string, List<string>> ReadVsp(Catalogue report)
        {
            var links = new Dictionary<string, List<string>>();
            foreach (var guid in AssetDatabase.FindAssets("t:VegetationPackagePro"))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                try
                {
                    var asset = AssetDatabase.LoadMainAssetAtPath(path);
                    report.vspPackages.Add(new Package { guid = guid, path = path, settingsJson = EditorJsonUtility.ToJson(asset, true) });
                    var items = new SerializedObject(asset).FindProperty("VegetationInfoList");
                    if (items == null || !items.isArray) { report.warnings.Add("Unrecognized VSP package layout: " + path); continue; }
                    for (int i = 0; i < items.arraySize; i++)
                    {
                        var item = items.GetArrayElementAtIndex(i);
                        var prefab = item.FindPropertyRelative("VegetationPrefab");
                        var id = item.FindPropertyRelative("VegetationItemID");
                        if (prefab == null || !prefab.objectReferenceValue) continue;
                        var key = GuidFor(prefab.objectReferenceValue);
                        if (!links.ContainsKey(key)) links[key] = new List<string>();
                        links[key].Add(guid + ":" + (id == null ? "index-" + i : id.stringValue));
                    }
                }
                catch (Exception ex) { report.warnings.Add(path + ": " + ex.Message); }
            }
            return links;
        }

        static MaterialInfo ReadMaterial(Material m)
        {
            var result = new MaterialInfo { guid = GuidFor(m), path = AssetDatabase.GetAssetPath(m), name = m.name, shader = m.shader ? m.shader.name : "", keywords = m.shaderKeywords, renderQueue = m.renderQueue };
            if (!m.shader) return result;
            for (int i = 0; i < ShaderUtil.GetPropertyCount(m.shader); i++)
            {
                var name = ShaderUtil.GetPropertyName(m.shader, i);
                var type = ShaderUtil.GetPropertyType(m.shader, i);
                var p = new Property { name = name, type = type.ToString() };
                switch (type)
                {
                    case ShaderUtil.ShaderPropertyType.Color: p.value = JsonUtility.ToJson(m.GetColor(name)); break;
                    case ShaderUtil.ShaderPropertyType.Vector: p.value = JsonUtility.ToJson(m.GetVector(name)); break;
                    case ShaderUtil.ShaderPropertyType.TexEnv:
                        p.textureGuid = GuidFor(m.GetTexture(name));
                        p.value = "path=" + AssetDatabase.GetAssetPath(m.GetTexture(name)) + "; scale=" + m.GetTextureScale(name).ToString("R") + "; offset=" + m.GetTextureOffset(name).ToString("R"); break;
                    default: p.value = m.GetFloat(name).ToString("R", System.Globalization.CultureInfo.InvariantCulture); break;
                }
                result.properties.Add(p);
            }
            return result;
        }

        static void Inspect(GameObject asset, Entry entry, string output, bool render)
        {
            var filters = asset.GetComponentsInChildren<MeshFilter>(true).Where(f => f.sharedMesh).ToArray();
            var renderers = asset.GetComponentsInChildren<Renderer>(true);
            foreach (var material in renderers.SelectMany(r => r.sharedMaterials).Where(m => m).Distinct()) entry.materials.Add(ReadMaterial(material));
            if (asset.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length > 0) entry.warnings.Add("Skinned meshes are not included in dimensions or preview.");
            var excluded = new HashSet<Renderer>();
            foreach (var group in asset.GetComponentsInChildren<LODGroup>(true))
            {
                var lods = group.GetLODs();
                var first = new HashSet<Renderer>(lods.Length == 0 ? new Renderer[0] : lods[0].renderers);
                for (int i = 0; i < lods.Length; i++)
                {
                    int triangles = 0;
                    foreach (var r in lods[i].renderers.Where(r => r))
                    {
                        var filter = r.GetComponent<MeshFilter>();
                        if (filter && filter.sharedMesh) for (int s = 0; s < filter.sharedMesh.subMeshCount; s++) triangles += (int)filter.sharedMesh.GetIndexCount(s) / 3;
                        if (i > 0 && !first.Contains(r)) excluded.Add(r);
                    }
                    entry.lods.Add(new LodInfo { group = group.name, level = i, transition = lods[i].screenRelativeTransitionHeight, triangles = triangles });
                }
            }
            bool hasBounds = false;
            var bounds = new Bounds();
            foreach (var filter in filters)
            {
                var matrix = asset.transform.worldToLocalMatrix * filter.transform.localToWorldMatrix;
                var b = filter.sharedMesh.bounds;
                for (int c = 0; c < 8; c++)
                {
                    var point = matrix.MultiplyPoint3x4(b.center + Vector3.Scale(b.extents, new Vector3((c & 1) == 0 ? -1 : 1, (c & 2) == 0 ? -1 : 1, (c & 4) == 0 ? -1 : 1)));
                    if (!hasBounds) { bounds = new Bounds(point, Vector3.zero); hasBounds = true; } else bounds.Encapsulate(point);
                }
            }
            if (!hasBounds) { entry.warnings.Add("No static mesh geometry; preview unavailable."); return; }
            entry.center = bounds.center; entry.size = bounds.size; entry.heightM = bounds.size.y; entry.crownWidthM = Mathf.Max(bounds.size.x, bounds.size.z);
            if (!render) return;
            var preview = new PreviewRenderUtility();
            Texture2D image = null;
            try
            {
                preview.BeginStaticPreview(new Rect(0, 0, 512, 512));
                preview.camera.clearFlags = CameraClearFlags.Color;
                preview.camera.backgroundColor = new Color(0.23f, 0.25f, 0.27f, 1);
                preview.camera.orthographic = true;
                float radius = Mathf.Max(bounds.extents.magnitude, 0.1f);
                preview.camera.orthographicSize = radius * 1.12f;
                preview.camera.transform.position = bounds.center + new Vector3(1, 0.35f, -1).normalized * radius * 4;
                preview.camera.transform.LookAt(bounds.center);
                preview.camera.nearClipPlane = radius * 0.01f; preview.camera.farClipPlane = radius * 10;
                preview.lights[0].intensity = 1.1f;
                preview.lights[0].transform.rotation = Quaternion.Euler(40, 35, 0);
                preview.lights[1].intensity = 0.6f;
                preview.lights[1].transform.rotation = Quaternion.Euler(340, 210, 0);
                foreach (var filter in filters)
                {
                    var renderer = filter.GetComponent<MeshRenderer>();
                    if (!renderer || !renderer.enabled || excluded.Contains(renderer)) continue;
                    var materials = renderer.sharedMaterials;
                    for (int s = 0; s < filter.sharedMesh.subMeshCount; s++)
                        if (materials.Length > 0 && materials[Math.Min(s, materials.Length - 1)])
                            preview.DrawMesh(filter.sharedMesh, asset.transform.worldToLocalMatrix * filter.transform.localToWorldMatrix, materials[Math.Min(s, materials.Length - 1)], s);
                }
                preview.camera.Render();
                image = preview.EndStaticPreview();
                entry.preview = "previews/" + entry.guid + ".png";
                File.WriteAllBytes(Path.Combine(output, entry.preview), image.EncodeToPNG());
            }
            finally { if (image) DestroyImmediate(image); preview.Cleanup(); }
        }

        static string Html(string value) { return (value ?? "").Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;").Replace("'", "&#39;"); }
        [Serializable] public class GalleryData
        {
            public string unityVersion;
            public bool complete;
            public List<GalleryEntry> assets = new List<GalleryEntry>();
        }
        [Serializable] public class GalleryEntry
        {
            public string guid, name, path, preview;
            public float heightM, crownWidthM;
        }
        static void WriteGallery(string output, Catalogue report)
        {
            var scriptPath = AssetDatabase.FindAssets("GolfMapCatalogueExporter t:MonoScript")
                .Select(AssetDatabase.GUIDToAssetPath)
                .First(p => Path.GetFileName(p) == "GolfMapCatalogueExporter.cs");
            var templatePath = Path.Combine(Path.GetDirectoryName(scriptPath), "GolfMapCatalogueGallery.html");
            var template = File.ReadAllText(templatePath);
            var gallery = new GalleryData { unityVersion = report.unityVersion, complete = report.complete };
            Directory.CreateDirectory(Path.Combine(output, "details"));
            foreach (var entry in report.assets)
            {
                gallery.assets.Add(new GalleryEntry { guid = entry.guid, name = entry.name, path = entry.path, preview = entry.preview, heightM = entry.heightM, crownWidthM = entry.crownWidthM });
                var detail = "<!doctype html><meta charset='utf-8'><title>" + Html(entry.name) + "</title><style>body{font:16px system-ui;background:#202427;color:#eee;margin:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#b9daf7}</style><a href='../index.html'>Catalogue</a><h1>" + Html(entry.name) + "</h1><pre>" + Html(JsonUtility.ToJson(entry, true)) + "</pre>";
                File.WriteAllText(Path.Combine(output, "details/" + entry.guid + ".html"), detail, Encoding.UTF8);
            }
            // Escape HTML-significant JSON characters so asset names cannot close the data script.
            var json = JsonUtility.ToJson(gallery).Replace("&", "\\u0026").Replace("<", "\\u003c").Replace(">", "\\u003e");
            File.WriteAllText(Path.Combine(output, "index.html"), template.Replace("__GOLFMAP_DATA__", json), Encoding.UTF8);
        }
    }
}