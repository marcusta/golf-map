// Looks: several material settings for one species, sharing its shapes.
//
// A species' shapes (prefabs: sizes and LOD sets) all draw with the same few materials, so
// a look is a set of copies of those materials, tuned once, plus a copy of each shape that
// points at them. VSP draws a prefab with that prefab's materials, which is why a look needs
// prefab copies at all - each becomes its own VSP item. Meshes and textures stay shared.
//
//   <course>/Looks/<species>/<look>/<Material>.mat      tuned in the Palette panel
//   <course>/Looks/<species>/<look>/<Shape>.prefab      generated; never edited by hand
//
// The "original" look is the source prefabs as they are. palette.json records every other
// look's material values (shader, floats, colours, textures by guid, keywords), captured
// from the copies on Save and applied to them by Apply - so a palette carried to another
// project can rebuild its looks there.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapLooks
    {
        public static string Folder(GolfMapCourse course, string species, string look)
        {
            return GolfMapCourses.Folder(course) + "Looks/" + FileName(species) + "/" + FileName(look) + "/";
        }

        static string FileName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name;
        }

        public static List<GolfMapBiomeAsset> Shapes(GolfMapBiome biome, string species, GolfMapBiomeLook look)
        {
            return biome.assets.Where(a => a.Label == species && (look == null || look.shapes == null || look.shapes.Contains(a.guid))).ToList();
        }

        static GameObject Source(GolfMapBiomeAsset shape)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(shape.guid));
            if (!prefab) throw new Exception("Cannot load " + shape.name + " (" + shape.path + ").");
            return prefab;
        }

        // VSP draws the mesh LODs and bakes its own billboards, so a BillboardRenderer's materials are not part of a look.
        static IEnumerable<Renderer> Drawn(GameObject prefab)
        {
            return prefab.GetComponentsInChildren<Renderer>(true).Where(r => !(r is BillboardRenderer));
        }

        // What these prefabs really draw with (a trial may have re-pointed a look's prefab copies
        // at materials outside its folder), in a stable order.
        public static List<Material> DrawnMaterials(IEnumerable<GameObject> prefabs)
        {
            return prefabs.Where(p => p).SelectMany(Drawn).SelectMany(r => r.sharedMaterials).Where(m => m && m.shader).Distinct()
                .OrderBy(m => m.name, StringComparer.Ordinal).ThenBy(m => Guid(m), StringComparer.Ordinal).ToList();
        }

        // The materials a species draws with, across all its shapes, in a stable order.
        public static List<Material> SourceMaterials(GolfMapBiome biome, string species)
        {
            return Shapes(biome, species, null).SelectMany(s => Drawn(Source(s))).SelectMany(r => r.sharedMaterials).Where(m => m).Distinct()
                .OrderBy(m => m.name, StringComparer.Ordinal).ThenBy(m => Guid(m), StringComparer.Ordinal).ToList();
        }

        static string Guid(UnityEngine.Object asset) { return AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(asset)); }

        // Source material -> where its copy lives in the look's folder. Two sources sharing a name get their guid appended.
        static Dictionary<Material, string> CopyPaths(List<Material> sources, string folder)
        {
            var paths = new Dictionary<Material, string>();
            foreach (var m in sources)
            {
                bool clash = sources.Any(o => o != m && o.name == m.name);
                paths[m] = folder + FileName(m.name) + (clash ? "-" + Guid(m).Substring(0, 8) : "") + ".mat";
            }
            return paths;
        }

        public static List<Material> Materials(GolfMapCourse course, GolfMapBiome biome, string species, GolfMapBiomeLook look)
        {
            if (look.original) return SourceMaterials(biome, species);
            var paths = CopyPaths(SourceMaterials(biome, species), Folder(course, species, look.id));
            return paths.Values.Select(p => AssetDatabase.LoadAssetAtPath<Material>(p)).Where(m => m).ToList();
        }

        public static GameObject Prefab(GolfMapCourse course, string species, GolfMapBiomeLook look, GolfMapBiomeAsset shape)
        {
            return AssetDatabase.LoadAssetAtPath<GameObject>(Folder(course, species, look.id) + FileName(shape.name) + ".prefab");
        }

        // Create whatever the look is missing: material copies (from `from`'s materials, or the
        // sources), then a copy of each shape pointing at them. Existing copies keep their tuning.
        public static string Generate(GolfMapCourse course, GolfMapBiome biome, string species, GolfMapBiomeLook look, GolfMapBiomeLook from)
        {
            if (look.original) return "";
            string folder = Folder(course, species, look.id);
            Directory.CreateDirectory(folder);
            AssetDatabase.Refresh();
            var sources = SourceMaterials(biome, species);
            var paths = CopyPaths(sources, folder);
            var fromPaths = from == null || from.original ? null : CopyPaths(sources, Folder(course, species, from.id));
            int materials = 0, prefabs = 0;
            foreach (var m in sources)
            {
                if (AssetDatabase.LoadAssetAtPath<Material>(paths[m])) continue;
                string origin = fromPaths != null && AssetDatabase.LoadAssetAtPath<Material>(fromPaths[m]) ? fromPaths[m] : AssetDatabase.GetAssetPath(m);
                if (!AssetDatabase.CopyAsset(origin, paths[m])) throw new Exception("Cannot copy " + origin + " to " + paths[m]);
                materials++;
            }
            foreach (var shape in Shapes(biome, species, look))
            {
                var source = Source(shape);
                string path = folder + FileName(shape.name) + ".prefab";
                if (!AssetDatabase.LoadAssetAtPath<GameObject>(path))
                {
                    if (!AssetDatabase.CopyAsset(AssetDatabase.GetAssetPath(source), path)) throw new Exception("Cannot copy " + shape.path + " to " + path);
                    prefabs++;
                }
                // A copy has the source's hierarchy, so renderers pair up by order. Remapping from the
                // source's slots (not the copy's) keeps this correct on every rerun.
                var copy = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                var from_ = Drawn(source).ToArray(); var to = Drawn(copy).ToArray();
                if (from_.Length != to.Length) throw new Exception(path + " no longer matches " + shape.path + ". Delete it and generate again.");
                for (int i = 0; i < to.Length; i++)
                {
                    var slots = from_[i].sharedMaterials;
                    for (int s = 0; s < slots.Length; s++)
                        if (slots[s] && paths.ContainsKey(slots[s])) slots[s] = AssetDatabase.LoadAssetAtPath<Material>(paths[slots[s]]);
                    to[i].sharedMaterials = slots;
                    EditorUtility.SetDirty(to[i]);
                }
                EditorUtility.SetDirty(copy);
            }
            AssetDatabase.SaveAssets();
            return materials + " material(s) and " + prefabs + " prefab(s) created in " + folder;
        }

        // ---- palette.json <-> material copies ---------------------------------

        // Record the look's materials in its node: materials.<source guid> = {name, shader, floats, colors, vectors, textures, keywords}.
        public static void Capture(GolfMapCourse course, GolfMapBiome biome, string species, GolfMapBiomeLook look)
        {
            if (look.original) return;
            var sources = SourceMaterials(biome, species);
            var paths = CopyPaths(sources, Folder(course, species, look.id));
            var node = look.node ?? (look.node = new GolfMapJsonObject());
            // A material with no copy in this project keeps what the file already records for it.
            var all = node.Object("materials") ?? new GolfMapJsonObject();
            foreach (var source in sources)
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(paths[source]);
                if (!m) continue;
                var o = new GolfMapJsonObject();
                o["name"] = source.name; o["shader"] = m.shader.name;
                var floats = new GolfMapJsonObject(); var colors = new GolfMapJsonObject(); var vectors = new GolfMapJsonObject(); var textures = new GolfMapJsonObject();
                for (int i = 0; i < ShaderUtil.GetPropertyCount(m.shader); i++)
                {
                    string p = ShaderUtil.GetPropertyName(m.shader, i);
                    switch (ShaderUtil.GetPropertyType(m.shader, i))
                    {
                        case ShaderUtil.ShaderPropertyType.Float:
                        case ShaderUtil.ShaderPropertyType.Range: floats[p] = Number(m.GetFloat(p)); break;
                        case ShaderUtil.ShaderPropertyType.Color: var c = m.GetColor(p); colors[p] = Numbers(c.r, c.g, c.b, c.a); break;
                        case ShaderUtil.ShaderPropertyType.Vector: var v = m.GetVector(p); vectors[p] = Numbers(v.x, v.y, v.z, v.w); break;
                        case ShaderUtil.ShaderPropertyType.TexEnv: var t = m.GetTexture(p); textures[p] = t ? Guid(t) : ""; break;
                    }
                }
                o["floats"] = floats; o["colors"] = colors; o["vectors"] = vectors; o["textures"] = textures;
                o["keywords"] = m.shaderKeywords.OrderBy(k => k, StringComparer.Ordinal).Cast<object>().ToList();
                all[Guid(source)] = o;
            }
            node["materials"] = all;
        }

        // Floats round to what a slider can set, so a capture does not churn the file with float noise.
        static GolfMapJsonNumber Number(float value) { return new GolfMapJsonNumber(GolfMapJsonDoc.Format(Math.Round(value, 5))); }
        static List<object> Numbers(params float[] values) { return values.Select(v => (object)Number(v)).ToList(); }

        // Write the recorded values onto the look's material copies. Returns what could not be applied.
        public static List<string> Apply(GolfMapCourse course, GolfMapBiome biome, string species, GolfMapBiomeLook look)
        {
            var problems = new List<string>();
            var all = look.node == null ? null : look.node.Object("materials");
            if (look.original || all == null) return problems;
            var sources = SourceMaterials(biome, species);
            var paths = CopyPaths(sources, Folder(course, species, look.id));
            foreach (var source in sources)
            {
                var o = all.Object(Guid(source));
                var m = AssetDatabase.LoadAssetAtPath<Material>(paths[source]);
                if (o == null || !m) continue;
                var shader = Shader.Find(o.String("shader"));
                if (!shader) { problems.Add(source.name + ": shader '" + o.String("shader") + "' is not in this project."); continue; }
                Undo.RecordObject(m, "Apply look from palette");
                if (m.shader != shader) m.shader = shader;
                var floats = o.Object("floats"); var colors = o.Object("colors"); var vectors = o.Object("vectors"); var textures = o.Object("textures");
                if (floats != null) foreach (var p in floats.keys) if (m.HasProperty(p)) m.SetFloat(p, (float)floats.Number(p));
                if (colors != null) foreach (var p in colors.keys) if (m.HasProperty(p)) { var c = Four(colors.Array(p)); m.SetColor(p, new Color(c[0], c[1], c[2], c[3])); }
                if (vectors != null) foreach (var p in vectors.keys) if (m.HasProperty(p)) { var v = Four(vectors.Array(p)); m.SetVector(p, new Vector4(v[0], v[1], v[2], v[3])); }
                if (textures != null) foreach (var p in textures.keys)
                {
                    if (!m.HasProperty(p)) continue;
                    string guid = textures.String(p);
                    var texture = string.IsNullOrEmpty(guid) ? null : AssetDatabase.LoadAssetAtPath<Texture>(AssetDatabase.GUIDToAssetPath(guid));
                    if (!string.IsNullOrEmpty(guid) && !texture) { problems.Add(source.name + "." + p + ": texture " + guid + " is not in this project."); continue; }
                    m.SetTexture(p, texture);
                }
                var keywords = o.Array("keywords");
                if (keywords != null) m.shaderKeywords = keywords.Select(k => k as string).ToArray();
                EditorUtility.SetDirty(m);
            }
            AssetDatabase.SaveAssets();
            return problems;
        }

        static float[] Four(List<object> values)
        {
            var result = new float[4];
            for (int i = 0; i < 4 && values != null && i < values.Count; i++) { var n = values[i] as GolfMapJsonNumber; if (n != null) result[i] = (float)n.Value; }
            return result;
        }
    }

    // ---- Palette panel: the Looks section -------------------------------------

    // Tuning a look (colours, material settings, the Lab) lives in GolfMap > Vegetation Palettes,
    // with the lower vegetation: live in the scene, several species at once. Here: what each
    // species plants with, and the way there.
    public partial class GolfMapTreePlanter
    {
        [SerializeField] bool showLooks = true;
        readonly Dictionary<string, int> previewLooks = new Dictionary<string, int>();   // "<species>:<look>" -> stems

        void DrawLooks()
        {
            EditorGUILayout.LabelField("Colours and material settings per species are tuned in GolfMap > Vegetation Palettes (with the lower vegetation): live in the scene, several species at once, with the Lab.", EditorStyles.wordWrappedMiniLabel);
            if (GUILayout.Button("Open Vegetation Palettes")) GolfMapVegPaletteWindow.Open();
            foreach (var label in draft.assets.Select(a => a.Label).Distinct().OrderBy(l => l, StringComparer.Ordinal).ToList())
            {
                var group = draft.Species(label);
                var looks = group == null ? new List<GolfMapBiomeLook>() : group.looks;
                double sum = looks.Sum(l => l.weight);
                int pool = looks.Sum(l => Count(previewLooks, label + ":" + l.id));
                string summary = looks.Count == 0 ? "source materials" : string.Join("  ·  ", looks.Select(l =>
                {
                    int n = Count(previewLooks, label + ":" + l.id);
                    return l.id + " " + (sum > 0 ? Percent(l.weight / sum) : "-") + (previewStale || !AnyLoaded || pool == 0 ? "" : " (" + n + ")");
                }).ToArray());
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Label(label, GUILayout.Width(70));
                    GUILayout.Label(new GUIContent(summary, "Look weights (share of the species' stems) and, after Load and check, stems in the preview."), EditorStyles.miniLabel);
                    if (GUILayout.Button(new GUIContent("Tune", "Open this species' looks in Vegetation Palettes."), EditorStyles.miniButton, GUILayout.Width(44)))
                        GolfMapVegPaletteWindow.OpenWith(looks.Count == 0 ? new List<string> { "t:" + label + "/original" } : looks.Select(l => "t:" + label + "/" + l.id).ToList());
                }
            }
        }

        static int Count(Dictionary<string, int> counts, string key) { int n; counts.TryGetValue(key, out n); return n; }
    }
}
