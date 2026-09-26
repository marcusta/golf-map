// GolfMap > Bunker Materials: matches the course's bunker and bunker-blend materials
// to the vertex paint made in Blender.
//
// - Check paint reads every bunker and blend mesh's vertex colours and reports which
//   convention in bunker-channels.json (GolfMapBunkerChannels.cs) each one is painted
//   with, so a ce.simgolf-painted bunker on an OPCD-default material (green = dirt)
//   shows up before anyone looks at it in GSPro.
// - Build and apply creates, per original OPCD material, a render material whose four
//   channels are filled from the convention's sources, plus a ChannelMaterials asset
//   describing it the way OPCD's own channel editor does, and points the mesh's
//   renderer and MeshChannelMaterialsStore at them. Originals are never edited; tinted
//   sources are baked into their own source materials so an OPCD rebuild from the
//   ChannelMaterials asset gives the same result.
// - Restore puts back the material and ChannelMaterials asset each mesh had before
//   its first apply (recorded in <course>/Bunkers/restore.json).
//
// OPCD's SetMeshMaterialv4 theme window reassigns bunker materials when run; apply
// again after it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public class GolfMapBunkerMaterials : EditorWindow
    {
        const string kFilePref = "GolfMap.Bunkers.ConventionFile";
        const string kConventionPref = "GolfMap.Bunkers.Convention";
        const float kSeamTolerance = 0.05f;   // metres between a blend's inner edge and the bunker seam
        const float kPassScore = 0.6f;

        [SerializeField] string filePath = "";
        [SerializeField] string conventionId = "";
        [SerializeField] bool selectedOnly;
        [SerializeField] Vector2 scroll;

        List<BunkerConvention> conventions;
        readonly Dictionary<string, UnityEngine.Object> channelAssets = new Dictionary<string, UnityEngine.Object>();
        string loadedPath;
        string report = "";
        string status = "";

        [MenuItem("GolfMap/Bunker Materials")]
        public static void Open() { GetWindow<GolfMapBunkerMaterials>("Bunker Materials"); }

        void OnEnable()
        {
            filePath = EditorPrefs.GetString(kFilePref, "");
            conventionId = EditorPrefs.GetString(kConventionPref, "ce-simgolf");
            if (string.IsNullOrEmpty(filePath))
            {
                var course = GolfMapCourses.Active();
                if (course != null) filePath = GolfMapCourses.Folder(course) + GolfMapBunkerChannels.FileName;
            }
        }

        void OnGUI()
        {
            scroll = EditorGUILayout.BeginScrollView(scroll);
            EditorGUILayout.LabelField("Paint convention", EditorStyles.boldLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                var picked = EditorGUILayout.TextField("Convention file", filePath);
                if (GUILayout.Button("...", GUILayout.Width(30)))
                {
                    var p = EditorUtility.OpenFilePanel("bunker-channels.json", string.IsNullOrEmpty(filePath) ? "Assets" : Path.GetDirectoryName(filePath), "json");
                    if (!string.IsNullOrEmpty(p)) picked = ToProjectPath(p);
                }
                if (picked != filePath) { filePath = picked; conventions = null; EditorPrefs.SetString(kFilePref, filePath); }
            }
            EnsureLoaded();
            if (conventions != null && conventions.Count > 0)
            {
                var ids = conventions.Select(c => c.id).ToArray();
                int index = Math.Max(0, Array.IndexOf(ids, conventionId));
                int chosen = EditorGUILayout.Popup("Convention", index, conventions.Select(c => c.label).ToArray());
                if (ids[chosen] != conventionId) { conventionId = ids[chosen]; EditorPrefs.SetString(kConventionPref, conventionId); }
                var conv = conventions[chosen];
                EditorGUILayout.HelpBox(conv.description + (conv.blend.verified ? "" : "\nBlend channels are not verified against a real course yet."), MessageType.None);
            }
            selectedOnly = EditorGUILayout.Toggle("Selected objects only", selectedOnly);

            EditorGUILayout.Space();
            using (new EditorGUI.DisabledScope(conventions == null))
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Check paint")) Run(Check);
                if (GUILayout.Button("Build and apply")) Run(BuildAndApply);
                if (GUILayout.Button("Restore OPCD materials")) Run(Restore);
            }
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.Info);
            if (!string.IsNullOrEmpty(report))
            {
                EditorGUILayout.Space();
                EditorGUILayout.LabelField("Report", EditorStyles.boldLabel);
                EditorGUILayout.TextArea(report, GUILayout.ExpandHeight(true));
            }
            EditorGUILayout.EndScrollView();
        }

        void EnsureLoaded()
        {
            if (conventions != null && loadedPath == filePath) return;
            conventions = null;
            loadedPath = filePath;
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath))
            {
                EditorGUILayout.HelpBox("Copy blender/conventions/" + GolfMapBunkerChannels.FileName + " from the golf-map repo into the course folder, or pick it.", MessageType.Warning);
                return;
            }
            try { conventions = GolfMapBunkerChannels.Load(filePath); }
            catch (Exception e) { status = "Could not read " + filePath + ": " + e.Message; }
        }

        BunkerConvention Selected { get { return conventions.FirstOrDefault(c => c.id == conventionId) ?? conventions[0]; } }

        void Run(Action action)
        {
            try { action(); }
            catch (Exception e) { status = e.Message; Debug.LogException(e); }
            finally { EditorUtility.ClearProgressBar(); }
        }

        static string ToProjectPath(string absolute)
        {
            var root = Path.GetFullPath(Application.dataPath + "/..").Replace('\\', '/') + "/";
            absolute = absolute.Replace('\\', '/');
            return absolute.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? absolute.Substring(root.Length) : absolute;
        }

        // ------------------------------------------------------------ scene

        sealed class BunkerSet
        {
            public string key;              // "Spline_hole_11_6"
            public MeshFilter bunker;
            public readonly List<MeshFilter> blends = new List<MeshFilter>();
        }

        const string kBunkerSuffix = "_Bunker_-_Mesh";
        const string kBlendMarker = "_Bunker_-_Blend";

        List<BunkerSet> FindSets()
        {
            var scene = EditorSceneManager.GetActiveScene();
            var filters = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true)).Where(f => f.sharedMesh != null).ToList();
            if (selectedOnly)
            {
                var chosen = new HashSet<GameObject>(Selection.gameObjects);
                filters = filters.Where(f => chosen.Contains(f.gameObject) || chosen.Any(c => f.transform.IsChildOf(c.transform))).ToList();
            }
            var sets = new Dictionary<string, BunkerSet>();
            foreach (var f in filters)
            {
                var name = f.gameObject.name;
                if (name.Contains("Potwall")) continue;
                int i = name.IndexOf(kBunkerSuffix, StringComparison.Ordinal);
                if (i > 0) Set(sets, name.Substring(0, i)).bunker = f;
            }
            foreach (var f in filters)
            {
                var name = f.gameObject.name;
                if (!name.Contains(kBlendMarker)) continue;
                // "Spline_hole_11_6_B_Rough_Bunker_-_Blend" and the split
                // "Spline_others_40_piece1_Rough_B_Bunker_-_Blend" belong to the longest
                // bunker key they start with.
                var owner = sets.Keys.Where(k => name.StartsWith(k + "_", StringComparison.Ordinal)).OrderByDescending(k => k.Length).FirstOrDefault();
                if (owner == null) { int b = name.IndexOf("_B_", StringComparison.Ordinal); owner = b > 0 ? name.Substring(0, b) : name; }
                Set(sets, owner).blends.Add(f);
            }
            return sets.Values.OrderBy(s => s.key, StringComparer.Ordinal).ToList();
        }

        static BunkerSet Set(Dictionary<string, BunkerSet> sets, string key)
        {
            BunkerSet s; if (!sets.TryGetValue(key, out s)) sets[key] = s = new BunkerSet { key = key };
            return s;
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t != null; t = t.parent) parts.Insert(0, t.name);
            return "/" + string.Join("/", parts.ToArray());
        }

        // OPCD components are in SetMeshRuntimeDLL; found by type name so this compiles
        // (and reports) in a project without them.
        static MonoBehaviour Opcd(Component c, string typeName)
        {
            return c.GetComponents<MonoBehaviour>().FirstOrDefault(m => m != null && m.GetType().Name == typeName);
        }

        static UnityEngine.Object Field(UnityEngine.Object o, string field)
        {
            if (o == null) return null;
            var p = new SerializedObject(o).FindProperty(field);
            return p != null ? p.objectReferenceValue : null;
        }

        // ------------------------------------------------------------ check

        void Check()
        {
            var sets = FindSets();
            var chosen = Selected;
            int ringCount = conventions.Max(c => c.bunker.rings.Length);
            var sb = new StringBuilder();
            sb.AppendLine("Bunker paint check - convention file " + filePath + ", selected: " + chosen.label);
            sb.AppendLine("Rings are counted in from the seam; shares are of welded vertices. R/G/B/BL = dominant red/green/blue/black.");
            sb.AppendLine();
            int bunkers = 0, bunkersOk = 0, blends = 0, blendsOk = 0, noColor = 0, drift = 0;
            var best = conventions.ToDictionary(c => c.id, c => 0);
            for (int s = 0; s < sets.Count; s++)
            {
                var set = sets[s];
                EditorUtility.DisplayProgressBar("Bunker paint", set.key, s / (float)sets.Count);
                GolfMapBunkerChannels.MeshPaint bunkerPaint = null;
                if (set.bunker != null)
                {
                    bunkers++;
                    bunkerPaint = GolfMapBunkerChannels.Read(set.bunker);
                    if (!bunkerPaint.HasColors) { noColor++; sb.AppendLine(set.bunker.name + ": no vertex colours"); }
                    else
                    {
                        var rings = Enumerable.Range(0, ringCount).Select(_ => new GolfMapBunkerChannels.Tally()).ToArray();
                        var interior = new GolfMapBunkerChannels.Tally();
                        GolfMapBunkerChannels.TallyBunker(bunkerPaint, rings, interior);
                        var scores = conventions.ToDictionary(c => c.id, c => GolfMapBunkerChannels.ScoreBunker(c.bunker, rings, interior));
                        var top = scores.OrderByDescending(kv => kv.Value).First();
                        if (top.Value >= kPassScore) best[top.Key]++;
                        bool ok = scores[chosen.id] >= kPassScore;
                        if (ok) bunkersOk++;
                        sb.AppendLine((ok ? "  ok  " : "  !!  ") + set.bunker.name + "  rings " + string.Join(" | ", rings.Select(r => r.ToString()).ToArray()) + "  interior " + interior
                            + "  -> " + Label(top.Key) + " " + top.Value.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + (ok ? "" : ", " + chosen.label + " " + scores[chosen.id].ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)));
                    }
                    drift += Drift(set.bunker, sb);
                }
                foreach (var blend in set.blends)
                {
                    blends++;
                    var paint = GolfMapBunkerChannels.Read(blend);
                    if (!paint.HasColors) { noColor++; sb.AppendLine(blend.name + ": no vertex colours"); continue; }
                    if (bunkerPaint == null) { sb.AppendLine("  ??  " + blend.name + ": no bunker mesh named " + set.key + kBunkerSuffix + " in scope"); continue; }
                    var inner = new GolfMapBunkerChannels.Tally();
                    var outer = new GolfMapBunkerChannels.Tally();
                    GolfMapBunkerChannels.TallyBlend(paint, bunkerPaint, kSeamTolerance, inner, outer);
                    var scores = conventions.ToDictionary(c => c.id, c => GolfMapBunkerChannels.ScoreBlend(c.blend, inner, outer));
                    var top = scores.OrderByDescending(kv => kv.Value).First();
                    bool ok = scores[chosen.id] >= kPassScore;
                    if (ok) blendsOk++;
                    sb.AppendLine((ok ? "  ok  " : "  !!  ") + blend.name + "  inner " + inner + "  outer " + outer
                        + "  -> " + Label(top.Key) + " " + top.Value.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + (ok ? "" : ", " + chosen.label + " " + scores[chosen.id].ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)));
                    drift += Drift(blend, sb);
                }
            }
            var summary = string.Format("{0}/{1} bunkers and {2}/{3} blends match {4}. Best match per bunker: {5}.{6}{7}",
                bunkersOk, bunkers, blendsOk, blends, chosen.label,
                string.Join(", ", best.Where(kv => kv.Value > 0).Select(kv => Label(kv.Key) + " " + kv.Value).ToArray()),
                noColor > 0 ? " " + noColor + " meshes have no vertex colours." : "",
                drift > 0 ? " " + drift + " meshes render a different material than their ChannelMaterials asset names." : "");
            report = summary + "\n\n" + sb;
            status = summary + WriteReport("bunker_paint.txt", report);
        }

        string Label(string id) { var c = conventions.FirstOrDefault(x => x.id == id); return c != null ? c.label : id; }

        // A renderer whose material is not the render material of its ChannelMaterials
        // asset was changed behind OPCD's back (or OPCD reverted ours).
        static int Drift(MeshFilter f, StringBuilder sb)
        {
            var store = Opcd(f, "MeshChannelMaterialsStore");
            var renderer = f.GetComponent<MeshRenderer>();
            if (store == null || renderer == null) return 0;
            var render = Field(Field(store, "MeshChannelMaterials"), "RenderMaterial") as Material;
            if (render == null || render == renderer.sharedMaterial) return 0;
            sb.AppendLine("        material " + (renderer.sharedMaterial != null ? renderer.sharedMaterial.name : "none") + " but ChannelMaterials names " + render.name);
            return 1;
        }

        static string WriteReport(string suffix, string text)
        {
            var course = GolfMapCourses.Active();
            if (course == null) return "";
            var path = GolfMapCourses.ReportPath(course, suffix);
            File.WriteAllText(path, text);
            return " Report: " + path;
        }

        // ------------------------------------------------------------ build

        sealed class RestoreRecord { public string material; public string channels; }

        string OutputFolder(BunkerConvention conv)
        {
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course) + "Bunkers/" + conv.id;
            EnsureFolder(folder);
            return folder + "/";
        }

        static void EnsureFolder(string folder)
        {
            var parts = folder.Split('/');
            var path = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                var next = path + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(path, parts[i]);
                path = next;
            }
        }

        string RestorePath { get { return GolfMapCourses.Folder(GolfMapCourses.Require()) + "Bunkers/restore.json"; } }

        Dictionary<string, RestoreRecord> ReadRestore()
        {
            var result = new Dictionary<string, RestoreRecord>();
            if (!File.Exists(RestorePath)) return result;
            var meshes = GolfMapJsonDoc.ParseObject(File.ReadAllText(RestorePath)).Object("meshes");
            if (meshes == null) return result;
            foreach (var key in meshes.keys)
            {
                var o = meshes.Object(key);
                result[key] = new RestoreRecord { material = o.String("material"), channels = o.String("channelMaterials") };
            }
            return result;
        }

        void WriteRestore(Dictionary<string, RestoreRecord> records)
        {
            EnsureFolder(Path.GetDirectoryName(RestorePath).Replace('\\', '/'));
            var meshes = new SortedDictionary<string, object>(StringComparer.Ordinal);
            foreach (var kv in records)
                meshes[kv.Key] = new Dictionary<string, object> { { "material", kv.Value.material }, { "channelMaterials", kv.Value.channels } };
            File.WriteAllText(RestorePath, GolfMapJson.Serialize(new Dictionary<string, object>
            {
                { "note", "Material and OPCD ChannelMaterials asset each mesh had before GolfMap > Bunker Materials first applied. Used by Restore." },
                { "meshes", meshes },
            }) + "\n");
        }

        // The material a mesh had before any apply: the recorded one, else its current one.
        static Material Original(MeshFilter f, Dictionary<string, RestoreRecord> records)
        {
            RestoreRecord r;
            if (records.TryGetValue(PathOf(f.transform), out r) && !string.IsNullOrEmpty(r.material))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(r.material);
                if (m != null) return m;
            }
            var renderer = f.GetComponent<MeshRenderer>();
            return renderer != null ? renderer.sharedMaterial : null;
        }

        // The ChannelMaterials asset a mesh had before any apply.
        static UnityEngine.Object OriginalChannels(MeshFilter f, Dictionary<string, RestoreRecord> records)
        {
            RestoreRecord r;
            if (records.TryGetValue(PathOf(f.transform), out r) && !string.IsNullOrEmpty(r.channels))
            {
                var asset = AssetDatabase.LoadMainAssetAtPath(r.channels);
                if (asset != null) return asset;
            }
            return Field(Opcd(f, "MeshChannelMaterialsStore"), "MeshChannelMaterials");
        }

        // What a blend fades to: the source of its original Black channel, which is what
        // OPCD renders. BlendTarget.BlendToMaterialBlack is only the fallback - on Vreta it
        // names the Satellite-theme rough for every bunker blend while the Default-theme
        // rough is what the blends show.
        static Material Outer(MeshFilter blend, Dictionary<string, RestoreRecord> records)
        {
            var black = Field(OriginalChannels(blend, records), "BlackChannelMaterial") as Material;
            return black ?? Field(Opcd(blend, "BlendTarget"), "BlendToMaterialBlack") as Material;
        }

        static void Record(MeshFilter f, Dictionary<string, RestoreRecord> records)
        {
            var key = PathOf(f.transform);
            if (records.ContainsKey(key)) return;
            var renderer = f.GetComponent<MeshRenderer>();
            var store = Opcd(f, "MeshChannelMaterialsStore");
            records[key] = new RestoreRecord
            {
                material = renderer != null && renderer.sharedMaterial != null ? AssetDatabase.GetAssetPath(renderer.sharedMaterial) : "",
                channels = AssetDatabase.GetAssetPath(Field(store, "MeshChannelMaterials")),
            };
        }

        void BuildAndApply()
        {
            var conv = Selected;
            var sets = FindSets();
            var records = ReadRestore();
            var folder = OutputFolder(conv);
            var built = new Dictionary<string, Material>();          // render material cache
            var sources = new Dictionary<string, Material>();        // baked tinted sources
            var log = new StringBuilder();
            int applied = 0, failed = 0;
            Undo.SetCurrentGroupName("GolfMap bunker materials");
            channelAssets.Clear();
            try
            {
                for (int s = 0; s < sets.Count; s++)
                {
                    var set = sets[s];
                    EditorUtility.DisplayProgressBar("Bunker materials", set.key, s / (float)sets.Count);
                    var bunkerOriginal = set.bunker != null ? Original(set.bunker, records) : null;
                    if (set.bunker != null)
                    {
                        try
                        {
                            var roles = new Dictionary<string, Material> { { "$bunker", bunkerOriginal } };
                            var mat = Build(conv.bunker, bunkerOriginal, roles, "Bunker - " + bunkerOriginal.name, folder, built, sources);
                            Apply(set.bunker, mat, conv.bunker, roles, folder, sources, records);
                            applied++;
                        }
                        catch (Exception e) { failed++; log.AppendLine(set.bunker.name + ": " + e.Message); }
                    }
                    foreach (var blend in set.blends)
                    {
                        try
                        {
                            var blendOriginal = Original(blend, records);
                            var outer = Outer(blend, records);
                            if (bunkerOriginal == null) throw new InvalidOperationException("no bunker mesh " + set.key + kBunkerSuffix + " to take $bunker from");
                            var roles = new Dictionary<string, Material> { { "$bunker", bunkerOriginal }, { "$blend", blendOriginal }, { "$outer", outer } };
                            var mat = Build(conv.blend, blendOriginal, roles, "Blend - " + bunkerOriginal.name + " to " + (outer != null ? outer.name : "none"), folder, built, sources);
                            Apply(blend, mat, conv.blend, roles, folder, sources, records);
                            applied++;
                        }
                        catch (Exception e) { failed++; log.AppendLine(blend.name + ": " + e.Message); }
                    }
                }
            }
            finally
            {
                WriteRestore(records);
                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
            }
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            var summary = string.Format("{0}: applied to {1} meshes with {2} materials in {3}{4}.", conv.label, applied, built.Count, folder, failed > 0 ? ", " + failed + " failed" : "");
            report = summary + "\n\n" + log;
            status = summary + WriteReport("bunker_materials.txt", report);
        }

        Material Resolve(string from, Dictionary<string, Material> roles)
        {
            Material m;
            if (from.StartsWith("$", StringComparison.Ordinal))
            {
                if (!roles.TryGetValue(from, out m) || m == null) throw new InvalidOperationException(from + " is not available for this mesh");
                return m;
            }
            var guid = AssetDatabase.FindAssets(from + " t:Material").FirstOrDefault(g => Path.GetFileNameWithoutExtension(AssetDatabase.GUIDToAssetPath(g)) == from);
            if (guid == null) throw new InvalidOperationException("no material named '" + from + "'");
            return AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(guid));
        }

        // The material a channel is copied from, with the convention's tint and blend
        // strength baked in (a separate asset only when they change anything).
        Material Source(BunkerChannelSource src, Dictionary<string, Material> roles, string folder, Dictionary<string, Material> sources)
        {
            var mat = Resolve(src.from, roles);
            bool tinted = !Mathf.Approximately(src.tint, 1f), strength = src.blendStrength >= 0;
            if (!tinted && !strength) return mat;
            var name = "Source - " + mat.name + " " + src.channel + (tinted ? " x" + src.tint.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) : "")
                + (strength ? " bs" + src.blendStrength.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture) : "");
            Material cached;
            if (sources.TryGetValue(name, out cached)) return cached;
            var baked = new Material(mat) { name = name };
            GolfMapBunkerChannels.Tint(baked, src.channel, src.tint);
            GolfMapBunkerChannels.SetBlendStrength(baked, src.channel, src.blendStrength);
            return sources[name] = Save(baked, folder + Safe(name) + ".mat");
        }

        Material Build(BunkerMeshRule rule, Material original, Dictionary<string, Material> roles, string name, string folder,
            Dictionary<string, Material> built, Dictionary<string, Material> sources)
        {
            if (original == null) throw new InvalidOperationException("mesh has no material");
            Material cached;
            if (built.TryGetValue(name, out cached)) return cached;
            var render = new Material(original) { name = name };
            foreach (var ch in GolfMapBunkerChannels.All)
            {
                var src = rule.channels[ch];
                GolfMapBunkerChannels.CopyChannel(Source(src, roles, folder, sources), src.channel, render, ch);
            }
            return built[name] = Save(render, folder + Safe(name) + ".mat");
        }

        // Overwrites in place so meshes already pointing at the asset keep their reference.
        static Material Save(Material m, string path)
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing == null) { AssetDatabase.CreateAsset(m, path); return m; }
            EditorUtility.CopySerialized(m, existing);
            existing.name = Path.GetFileNameWithoutExtension(path);
            EditorUtility.SetDirty(existing);
            return existing;
        }

        static string Safe(string name) { return string.Join("_", name.Split(Path.GetInvalidFileNameChars())); }

        void Apply(MeshFilter f, Material render, BunkerMeshRule rule, Dictionary<string, Material> roles, string folder,
            Dictionary<string, Material> sources, Dictionary<string, RestoreRecord> records)
        {
            Record(f, records);
            var renderer = f.GetComponent<MeshRenderer>();
            Undo.RecordObject(renderer, "GolfMap bunker materials");
            renderer.sharedMaterial = render;
            var store = Opcd(f, "MeshChannelMaterialsStore");
            if (store == null) return;
            var channels = ChannelMaterials(store, render, rule, roles, folder, sources);
            if (channels == null) return;
            var so = new SerializedObject(store);
            Undo.RecordObject(store, "GolfMap bunker materials");
            so.FindProperty("MeshChannelMaterials").objectReferenceValue = channels;
            so.ApplyModifiedProperties();
        }

        // OPCD ChannelMaterials asset for a render material, created with the type the
        // store already references so no compile-time dependency on the DLL is needed.
        UnityEngine.Object ChannelMaterials(MonoBehaviour store, Material render, BunkerMeshRule rule, Dictionary<string, Material> roles,
            string folder, Dictionary<string, Material> sources)
        {
            var current = Field(store, "MeshChannelMaterials") as ScriptableObject;
            Type type = current != null ? current.GetType() : AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => a.GetType("SetMeshRuntimeDLL.ChannelMaterials")).FirstOrDefault(t => t != null);
            if (type == null) return null;
            var path = folder + Safe("Channels - " + render.name) + ".asset";
            UnityEngine.Object asset;
            if (channelAssets.TryGetValue(path, out asset)) return asset;
            asset = AssetDatabase.LoadAssetAtPath(path, type);
            if (asset == null)
            {
                asset = ScriptableObject.CreateInstance(type);
                AssetDatabase.CreateAsset(asset, path);
            }
            channelAssets[path] = asset;
            var so = new SerializedObject(asset);
            so.FindProperty("RenderMaterial").objectReferenceValue = render;
            foreach (var ch in GolfMapBunkerChannels.All)
            {
                var src = rule.channels[ch];
                so.FindProperty(ch + "ChannelMaterial").objectReferenceValue = Source(src, roles, folder, sources);
                so.FindProperty(ch + "ChannelMaterialChannel").stringValue = src.channel.ToString();
            }
            so.ApplyModifiedPropertiesWithoutUndo();
            return asset;
        }

        // ---------------------------------------------------------- restore

        void Restore()
        {
            var records = ReadRestore();
            int restored = 0, missing = 0;
            foreach (var set in FindSets())
                foreach (var f in new[] { set.bunker }.Concat(set.blends).Where(x => x != null))
                {
                    RestoreRecord r;
                    var key = PathOf(f.transform);
                    if (!records.TryGetValue(key, out r)) continue;
                    var mat = AssetDatabase.LoadAssetAtPath<Material>(r.material);
                    if (mat == null) { missing++; continue; }
                    var renderer = f.GetComponent<MeshRenderer>();
                    Undo.RecordObject(renderer, "GolfMap restore bunker materials");
                    renderer.sharedMaterial = mat;
                    var store = Opcd(f, "MeshChannelMaterialsStore");
                    var channels = string.IsNullOrEmpty(r.channels) ? null : AssetDatabase.LoadMainAssetAtPath(r.channels);
                    if (store != null && channels != null)
                    {
                        var so = new SerializedObject(store);
                        Undo.RecordObject(store, "GolfMap restore bunker materials");
                        so.FindProperty("MeshChannelMaterials").objectReferenceValue = channels;
                        so.ApplyModifiedProperties();
                    }
                    records.Remove(key);
                    restored++;
                }
            WriteRestore(records);
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            status = "Restored " + restored + " meshes to their OPCD materials" + (missing > 0 ? "; " + missing + " recorded materials no longer exist" : "") + ".";
            report = "";
        }
    }
}
