// What a course build is made of: every asset the scene depends on with the size
// of its imported form (Library/metadata), which is what lands in the bundle's
// sharedAssets file. Unity 2018 refuses serialized files over 4 GB; GreenKeeper
// then fails with "Failed to decompress data for the AssetBundle".
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    static class GolfMapBuildSize
    {
        const double Mb = 1024.0 * 1024.0;

        class Entry
        {
            public string path;
            public string type;
            public long bytes;
            public long sourceBytes;
        }

        [BridgeCommand("golfmap.build.size", "Read-only: what the course build is made of. Every asset the scene depends on with the size of its imported form (Library/metadata, about what the bundle holds uncompressed), summed per asset type and per folder, largest first. Textures list their import settings (max size, compression, mip maps, readable), models whether they are readable. Unity 2018 cannot build a scene whose shared assets pass 4 GB.",
            args = "scene (asset path; default the active scene), top=40 (assets listed), folderDepth=3 (path segments of the per-folder sum), under (only assets whose path starts with this), type (only this asset type, e.g. Texture2D)")]
        static object Size(BridgeArgs a)
        {
            var scene = a.String("scene", SceneManager.GetActiveScene().path);
            if (string.IsNullOrEmpty(scene)) throw new InvalidOperationException("The active scene is not saved; pass scene.");
            int top = a.Int("top", 40);
            int depth = Math.Max(1, a.Int("folderDepth", 3));
            var under = a.String("under", null);
            var onlyType = a.String("type", null);

            var project = Path.GetDirectoryName(Application.dataPath);
            var entries = new List<Entry>();
            foreach (var path in AssetDatabase.GetDependencies(scene, true))
            {
                if (path == scene || path.EndsWith(".cs") || path.EndsWith(".dll") || path.EndsWith(".js")) continue;
                if (under != null && !path.StartsWith(under, StringComparison.OrdinalIgnoreCase)) continue;
                var type = AssetDatabase.GetMainAssetTypeAtPath(path);
                var typeName = type == null ? "?" : type.Name;
                if (onlyType != null && !string.Equals(typeName, onlyType, StringComparison.OrdinalIgnoreCase)) continue;
                var guid = AssetDatabase.AssetPathToGUID(path);
                var imported = Path.Combine(project, "Library/metadata/" + guid.Substring(0, 2) + "/" + guid);
                long source = Length(Path.Combine(project, path));
                long bytes = Length(imported) + Length(imported + ".resource");
                // Unity's own formats (.asset: terrain data, texture arrays, painted meshes) are not
                // imported; the file itself is what gets built.
                // A text-serialized one writes its binary data as hex: about twice what the build holds.
                if (bytes == 0 || path.EndsWith(".asset", StringComparison.OrdinalIgnoreCase))
                    bytes = Math.Max(bytes, IsYaml(Path.Combine(project, path)) ? source / 2 : source);
                entries.Add(new Entry { path = path, type = typeName, bytes = bytes, sourceBytes = source });
            }
            entries.Sort((x, y) => y.bytes.CompareTo(x.bytes));

            return new Dictionary<string, object>
            {
                { "scene", scene },
                { "assets", entries.Count },
                { "totalMb", Round(entries.Sum(e => e.bytes)) },
                { "limitMb", 4096 },
                { "byType", Sum(entries, e => e.type) },
                { "byFolder", Sum(entries, e => Folder(e.path, depth)).Take(30).ToList() },
                { "largest", entries.Take(top).Select(e => (object)Describe(e)).ToList() },
            };
        }

        [BridgeCommand("golfmap.build.usedby", "Read-only: what pulls an asset into the build. The scene's renderers whose materials depend on the asset (directly or through another asset), grouped per material.",
            args = "asset (asset path, or a part of it when only one dependency of the scene matches), limit=20 (objects listed per material)")]
        static object UsedBy(BridgeArgs a)
        {
            var want = a.Require("asset");
            int limit = a.Int("limit", 20);
            var scene = SceneManager.GetActiveScene();
            var matches = AssetDatabase.GetDependencies(scene.path, true).Where(p => p.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
            if (matches.Count != 1) throw new InvalidOperationException(matches.Count == 0 ? "The saved scene does not depend on an asset matching " + want + " (unsaved changes are checked below only by path)." : "Several assets match: " + string.Join(", ", matches.Take(8).ToArray()));
            var asset = matches[0];
            var depends = new Dictionary<Material, bool>();
            var users = new Dictionary<string, List<string>>();
            foreach (var r in UnityEngine.Object.FindObjectsOfType<Renderer>())
                foreach (var m in r.sharedMaterials.Where(m => m))
                {
                    bool yes;
                    if (!depends.TryGetValue(m, out yes))
                    {
                        var path = AssetDatabase.GetAssetPath(m);
                        yes = depends[m] = !string.IsNullOrEmpty(path) && AssetDatabase.GetDependencies(path, true).Contains(asset);
                    }
                    if (!yes) continue;
                    var key = AssetDatabase.GetAssetPath(m);
                    List<string> list;
                    if (!users.TryGetValue(key, out list)) users[key] = list = new List<string>();
                    list.Add(r.name);
                }
            // components that only remember a material (OPCD's material stores) pull it into the build just the same
            var holds = new Dictionary<UnityEngine.Object, bool>();
            var components = new List<object>();
            foreach (var c in Resources.FindObjectsOfTypeAll<MonoBehaviour>())
            {
                if (c == null || EditorUtility.IsPersistent(c) || c.gameObject.scene != scene) continue;
                var it = new SerializedObject(c).GetIterator();
                while (it.NextVisible(true))
                {
                    if (it.propertyType != SerializedPropertyType.ObjectReference || it.objectReferenceValue == null || it.propertyPath == "m_Script") continue;
                    var o = it.objectReferenceValue;
                    bool yes;
                    if (!holds.TryGetValue(o, out yes))
                    {
                        var path = AssetDatabase.GetAssetPath(o);
                        yes = holds[o] = !string.IsNullOrEmpty(path) && (path == asset || AssetDatabase.GetDependencies(path, true).Contains(asset));
                    }
                    if (yes) components.Add(new Dictionary<string, object> { { "object", c.name }, { "component", c.GetType().Name }, { "property", it.propertyPath }, { "holds", AssetDatabase.GetAssetPath(o) } });
                }
            }
            return new Dictionary<string, object>
            {
                { "asset", asset },
                { "components", components.Take(limit * 3).ToList() },
                { "materials", users.OrderByDescending(kv => kv.Value.Count).Select(kv => (object)new Dictionary<string, object>
                    { { "material", kv.Key }, { "renderers", kv.Value.Count }, { "first", kv.Value.Take(limit).Cast<object>().ToList() } }).ToList() },
            };
        }

        static List<object> Sum(List<Entry> entries, Func<Entry, string> key)
        {
            return entries.GroupBy(key)
                .Select(g => new { key = g.Key, count = g.Count(), bytes = g.Sum(e => e.bytes) })
                .OrderByDescending(g => g.bytes)
                .Select(g => (object)new Dictionary<string, object> { { "name", g.key }, { "assets", g.count }, { "mb", Round(g.bytes) } })
                .ToList();
        }

        static Dictionary<string, object> Describe(Entry e)
        {
            var d = new Dictionary<string, object> { { "path", e.path }, { "type", e.type }, { "mb", Round(e.bytes) }, { "sourceMb", Round(e.sourceBytes) } };
            var importer = AssetImporter.GetAtPath(e.path);
            var texture = importer as TextureImporter;
            if (texture != null)
            {
                d["maxSize"] = texture.maxTextureSize;
                d["compression"] = texture.textureCompression.ToString();
                d["mipMaps"] = texture.mipmapEnabled;
                d["readable"] = texture.isReadable;
                var platform = texture.GetPlatformTextureSettings("Standalone");
                if (platform != null && platform.overridden)
                    d["standalone"] = platform.maxTextureSize + " " + platform.format;
            }
            var model = importer as ModelImporter;
            if (model != null)
            {
                d["readable"] = model.isReadable;
                d["meshCompression"] = model.meshCompression.ToString();
            }
            return d;
        }

        static string Folder(string path, int depth)
        {
            var parts = path.Split('/');
            return string.Join("/", parts.Take(Math.Min(depth, parts.Length - 1)).ToArray());
        }

        static bool IsYaml(string file)
        {
            if (!File.Exists(file)) return false;
            var head = new byte[5];
            using (var s = File.OpenRead(file))
                return s.Read(head, 0, 5) == 5 && System.Text.Encoding.ASCII.GetString(head) == "%YAML";
        }

        // ---- the diet ---------------------------------------------------------------------------

        const string DietRoot = "GolfMapSpelunk/texture-diet";

        [BridgeCommand("golfmap.build.diet", "Slim the build's textures the way OPCD's 'Putting your Course on a Diet' does: every compressed texture the scene depends on gets a max size (maxSize; bigSize for paths matching big) and crunch compression. Left alone: readable textures (zone masks and other CPU-sampled data), uncompressed ones, cubemaps, textures with a hand-set Standalone override, paths matching exclude, and textures already within the limits. The settings it replaces are written to GolfMapSpelunk/texture-diet/<stamp>.tsv first; golfmap.build.diet.restore puts them back. Reimports the changed textures (crunch takes a while).",
            args = "dryRun=false (the plan, nothing changed), maxSize=2048, bigSize=4096, big (path parts, comma-separated, case-insensitive: textures of huge objects), exclude (path parts, comma-separated: e.g. the orthophotos), crunch=50 (quality; 0 = leave compression as it is), scene (asset path; default the active scene)")]
        static object Diet(BridgeArgs a)
        {
            var scene = a.String("scene", SceneManager.GetActiveScene().path);
            if (string.IsNullOrEmpty(scene)) throw new InvalidOperationException("The active scene is not saved; pass scene.");
            bool dryRun = a.Bool("dryRun", false);
            int maxSize = a.Int("maxSize", 2048), bigSize = a.Int("bigSize", 4096), crunch = a.Int("crunch", 50);
            var big = Parts(a.String("big", null));
            var exclude = Parts(a.String("exclude", null));

            var skipped = new Dictionary<string, int>();
            var changes = new List<Dictionary<string, object>>();
            var backup = new List<string>();
            var importers = new List<TextureImporter>();
            foreach (var path in AssetDatabase.GetDependencies(scene, true))
            {
                var imp = AssetImporter.GetAtPath(path) as TextureImporter;
                if (imp == null) continue;
                string why = null;
                if (Matches(path, exclude)) why = "excluded";
                else if (imp.isReadable) why = "readable";
                else if (imp.textureCompression == TextureImporterCompression.Uncompressed) why = "uncompressed";
                else if (imp.textureShape != TextureImporterShape.Texture2D) why = "not 2D";
                else
                {
                    var platform = imp.GetPlatformTextureSettings("Standalone");
                    if (platform != null && platform.overridden) why = "Standalone override";
                }
                int limit = Matches(path, big) ? bigSize : maxSize;
                int size = Math.Min(imp.maxTextureSize, limit);
                bool crunched = crunch > 0 ? true : imp.crunchedCompression;
                int quality = crunch > 0 ? crunch : imp.compressionQuality;
                if (why == null && size == imp.maxTextureSize && crunched == imp.crunchedCompression && (!crunched || quality == imp.compressionQuality)) why = "already within";
                if (why != null) { int n; skipped.TryGetValue(why, out n); skipped[why] = n + 1; continue; }
                changes.Add(new Dictionary<string, object> { { "path", path }, { "maxSize", imp.maxTextureSize + " -> " + size }, { "crunch", (imp.crunchedCompression ? imp.compressionQuality.ToString() : "off") + " -> " + quality } });
                backup.Add(path + "\t" + imp.maxTextureSize + "\t" + (imp.crunchedCompression ? 1 : 0) + "\t" + imp.compressionQuality);
                if (dryRun) continue;
                imp.maxTextureSize = size;
                imp.crunchedCompression = crunched;
                imp.compressionQuality = quality;
                importers.Add(imp);
            }

            string file = null;
            if (!dryRun && importers.Count > 0)
            {
                Directory.CreateDirectory(DietRoot);
                file = DietRoot + "/" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".tsv";
                File.WriteAllLines(file, backup.ToArray());
                Reimport(importers);
            }
            return new Dictionary<string, object>
            {
                { "scene", scene }, { "dryRun", dryRun }, { "changed", changes.Count }, { "skipped", skipped }, { "backup", file },
                { "textures", changes.Take(a.Int("list", 30)).Cast<object>().ToList() },
            };
        }

        [BridgeCommand("golfmap.build.diet.restore", "Put back the texture import settings (max size, crunch) golfmap.build.diet replaced, from its backup, and reimport those textures.",
            args = "backup (file name under GolfMapSpelunk/texture-diet; default the latest)")]
        static object DietRestore(BridgeArgs a)
        {
            var name = a.String("backup", null);
            var file = name != null ? DietRoot + "/" + name
                : (Directory.Exists(DietRoot) ? Directory.GetFiles(DietRoot, "*.tsv").OrderBy(f => f, StringComparer.Ordinal).LastOrDefault() : null);
            if (file == null || !File.Exists(file)) throw new InvalidOperationException("No texture diet backup" + (name != null ? " " + file : " in " + DietRoot) + ".");
            var importers = new List<TextureImporter>();
            var missing = new List<object>();
            foreach (var line in File.ReadAllLines(file))
            {
                var f = line.Split('\t');
                if (f.Length != 4) continue;
                var imp = AssetImporter.GetAtPath(f[0]) as TextureImporter;
                if (imp == null) { missing.Add(f[0]); continue; }
                imp.maxTextureSize = int.Parse(f[1]);
                imp.crunchedCompression = f[2] == "1";
                imp.compressionQuality = int.Parse(f[3]);
                importers.Add(imp);
            }
            Reimport(importers);
            return new Dictionary<string, object> { { "backup", file }, { "restored", importers.Count }, { "missing", missing } };
        }

        static void Reimport(List<TextureImporter> importers)
        {
            AssetDatabase.StartAssetEditing();
            try { foreach (var imp in importers) { EditorUtility.SetDirty(imp); imp.SaveAndReimport(); } }
            finally { AssetDatabase.StopAssetEditing(); }
        }

        static string[] Parts(string list)
        {
            return string.IsNullOrEmpty(list) ? new string[0] : list.Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).ToArray();
        }

        static bool Matches(string path, string[] parts)
        {
            return parts.Any(p => path.IndexOf(p, StringComparison.OrdinalIgnoreCase) >= 0);
        }

        static long Length(string file)
        {
            return File.Exists(file) ? new FileInfo(file).Length : 0;
        }

        static double Round(long bytes)
        {
            return Math.Round(bytes / Mb, 1);
        }
    }
}
