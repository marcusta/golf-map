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

    public partial class GolfMapTreePlanter
    {
        [SerializeField] bool showLooks = true;
        string openSpecies = "", editLook = "", newLookName = "";
        readonly Dictionary<Material, UnityEditor.Editor> materialEditors = new Dictionary<Material, UnityEditor.Editor>();
        readonly Dictionary<string, int> previewLooks = new Dictionary<string, int>();   // "<species>:<look>" -> stems

        void CloseMaterialEditors()
        {
            foreach (var e in materialEditors.Values) if (e) DestroyImmediate(e);
            materialEditors.Clear();
        }

        void DrawLooks()
        {
            var course = GolfMapCourses.For(component);
            foreach (var label in draft.assets.Select(a => a.Label).Distinct().OrderBy(l => l, StringComparer.Ordinal).ToList())
            {
                var group = draft.Species(label);
                int looks = group == null ? 0 : group.looks.Count;
                int shapes = draft.assets.Count(a => a.Label == label && a.enabled);
                bool open = openSpecies == label;
                bool now = EditorGUILayout.Foldout(open, label + "   " + (looks == 0 ? "original materials" : looks + " look(s)") + ", " + shapes + " shape(s)" +
                    (looks > 1 ? "  =  up to " + looks * shapes + " VSP items" : ""), true);
                if (now != open) { openSpecies = now ? label : ""; editLook = ""; CloseMaterialEditors(); }
                if (!now) continue;
                EditorGUI.indentLevel++;
                try { DrawSpeciesLooks(course, label, group); }
                catch (ExitGUIException) { throw; }
                catch (Exception e) { paletteNote = label + ": " + e.Message; Debug.LogException(e); }
                EditorGUI.indentLevel--;
            }
        }

        void DrawSpeciesLooks(GolfMapCourse course, string label, GolfMapBiomeSpecies group)
        {
            if (group == null || group.looks.Count == 0)
            {
                EditorGUILayout.LabelField("Every " + label + " plants with the source prefabs' own materials.", EditorStyles.wordWrappedMiniLabel);
                DrawLab(course, label, group);
                if (GUILayout.Button("Start looks for " + label + " (keeps the original as the first one)"))
                {
                    if (group == null) { group = new GolfMapBiomeSpecies { name = label }; draft.species.Add(group); }
                    group.looks.Add(new GolfMapBiomeLook { id = "original", weight = 1, original = true });
                    GUI.changed = true;
                }
                return;
            }
            double sum = group.looks.Sum(l => l.weight);
            int pool = group.looks.Sum(l => Count(previewLooks, label + ":" + l.id));
            foreach (var look in group.looks.ToArray())
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    bool editing = editLook == look.id;
                    if (GUILayout.Toggle(editing, new GUIContent(look.id + (look.original ? "  (source materials)" : ""), "Open this look's materials"), EditorStyles.foldout, GUILayout.MinWidth(120)) != editing)
                    { editLook = editing ? "" : look.id; CloseMaterialEditors(); }
                    look.weight = Math.Round(Math.Max(0, EditorGUILayout.DoubleField(look.weight, GUILayout.Width(56))), 3);
                    GUILayout.Label(new GUIContent(sum > 0 ? Percent(look.weight / sum) : "-", "Target share of this species"), GUILayout.Width(48));
                    int count = Count(previewLooks, label + ":" + look.id);
                    GUILayout.Label(new GUIContent(previewStale || !AnyLoaded ? "" : Percent(pool > 0 ? (double)count / pool : 0) + "  " + count, "Share and stems in the preview"), EditorStyles.miniLabel, GUILayout.Width(92));
                    using (new EditorGUI.DisabledScope(group.looks.Count == 1))
                        if (GUILayout.Button(new GUIContent("x", "Remove from the palette. Its folder stays on disk: planted trees may still use it until the next Plant."), EditorStyles.miniButton, GUILayout.Width(22)))
                        { group.looks.Remove(look); if (editLook == look.id) { editLook = ""; CloseMaterialEditors(); } GUI.changed = true; }
                }
                if (editLook == look.id) DrawLookEditor(course, label, group, look);
            }
            DrawLab(course, label, group);
            if (group.looks.Count == 1 && group.looks[0].original)
                EditorGUILayout.LabelField("One look = no change yet. Open it and duplicate it to tune a second setting.", EditorStyles.wordWrappedMiniLabel);
        }

        static int Count(Dictionary<string, int> counts, string key) { int n; counts.TryGetValue(key, out n); return n; }

        void DrawLookEditor(GolfMapCourse course, string label, GolfMapBiomeSpecies group, GolfMapBiomeLook look)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Space(EditorGUI.indentLevel * 15);
                newLookName = GUILayout.TextField(newLookName, GUILayout.MinWidth(80)).Trim();
                bool valid = newLookName.Length > 0 && newLookName.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && newLookName.IndexOf(':') < 0 && group.looks.All(l => l.id != newLookName);
                using (new EditorGUI.DisabledScope(!valid))
                    if (GUILayout.Button(new GUIContent("Duplicate as", "A new look starting from this one's material settings. Type its name first."), GUILayout.Width(90)))
                    {
                        var copy = new GolfMapBiomeLook { id = newLookName, weight = look.weight, shapes = look.shapes == null ? null : new List<string>(look.shapes) };
                        paletteNote = "Look '" + copy.id + "': " + GolfMapLooks.Generate(course, draft, label, copy, look);
                        GolfMapLooks.Capture(course, draft, label, copy);
                        group.looks.Insert(group.looks.IndexOf(look) + 1, copy);
                        editLook = copy.id; newLookName = ""; CloseMaterialEditors();
                        GUI.changed = true; GUI.FocusControl(null);
                        return;
                    }
                if (!look.original && GUILayout.Button(new GUIContent("Regenerate", "Create missing material and prefab copies and re-point the prefab copies. Tuned materials are kept."), GUILayout.Width(84)))
                    paletteNote = "Look '" + look.id + "': " + GolfMapLooks.Generate(course, draft, label, look, null);
                if (!look.original && GUILayout.Button(new GUIContent("Apply JSON", "Set the material copies to the values palette.json records (after a hand edit of the file, or in a new project)."), GUILayout.Width(84)))
                {
                    var problems = GolfMapLooks.Apply(course, draft, label, look);
                    paletteNote = problems.Count == 0 ? "Applied the recorded values to '" + look.id + "'." : string.Join("\n", problems.ToArray());
                }
            }
            if (look.original)
            {
                EditorGUILayout.LabelField("These are the source prefabs' own materials: editing them changes every tree that uses them, in any look that has not been given its own copy. Duplicate first to tune a separate look.", EditorStyles.wordWrappedMiniLabel);
            }
            var materials = GolfMapLooks.Materials(course, draft, label, look);
            if (!look.original && materials.Count == 0)
            {
                EditorGUILayout.HelpBox("This look has no material copies in this project yet. Regenerate creates them; Apply JSON then sets the recorded values.", MessageType.Info);
                return;
            }
            EditorGUI.BeginChangeCheck();
            foreach (var material in materials)
            {
                UnityEditor.Editor editor;
                if (!materialEditors.TryGetValue(material, out editor) || !editor) materialEditors[material] = editor = UnityEditor.Editor.CreateEditor(material);
                editor.DrawHeader();
                var materialEditor = editor as MaterialEditor;
                if (materialEditor == null || materialEditor.isVisible) editor.OnInspectorGUI();
            }
            // The materials are assets, edited live; the palette only needs to notice so Save records them.
            if (EditorGUI.EndChangeCheck() && !look.original) { GolfMapLooks.Capture(course, draft, label, look); GUI.changed = true; }
        }
            // ---- Lab: a few real trees in the scene, for tuning looks -----------------

        // Plain instances of the look prefabs, so they draw with the very material assets being
        // tuned and change as a slider moves - no VSP colour cache, no billboard bake in between.
        // The root is never saved with the scene or built into the course.
        const string LabName = "GolfMap Lab (not saved)";
        static GameObject LabRoot() { return GameObject.Find(LabName); }

        void DrawLab(GolfMapCourse course, string label, GolfMapBiomeSpecies group)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Space(EditorGUI.indentLevel * 15);
                if (GUILayout.Button(new GUIContent("Show in Lab", "Stand one tree per look and shape at the Scene view's pivot: a row per look, a column per shape. Material edits show on them at once.")))
                    BuildLab(course, label, group);
                using (new EditorGUI.DisabledScope(!LabRoot()))
                {
                    if (GUILayout.Button("Look at Lab", GUILayout.Width(90))) FrameLab();
                    if (GUILayout.Button("Clear Lab", GUILayout.Width(80))) { DestroyImmediate(LabRoot()); SceneView.RepaintAll(); }
                }
                if (GUILayout.Button(new GUIContent("Apply to course", "Planted trees read NM leaf and bark colours from VSP's cache, not the material: re-sync it now. Billboards still need a rebake (Plant with Regenerate billboards)."), GUILayout.Width(110)))
                    GolfMapVegetationRefresh.Refresh();
            }
        }

        void BuildLab(GolfMapCourse course, string label, GolfMapBiomeSpecies group)
        {
            var view = SceneView.lastActiveSceneView;
            if (!view) { paletteNote = "Open a Scene view first."; return; }
            if (LabRoot()) DestroyImmediate(LabRoot());
            var root = new GameObject(LabName) { hideFlags = HideFlags.DontSave };
            var shapes = draft.assets.Where(a => a.Label == label && a.enabled).OrderBy(a => a.heightM).ToList();
            var looks = group == null || group.looks.Count == 0 ? new List<GolfMapBiomeLook> { new GolfMapBiomeLook { id = "original", original = true } } : group.looks;
            float step = (float)shapes.Select(a => a.crownWidthM).DefaultIfEmpty(5).Max() * 1.15f;
            var origin = view.pivot;
            int row = 0, missing = 0;
            foreach (var look in looks)
            {
                int column = 0;
                foreach (var shape in shapes)
                {
                    if (look.shapes != null && !look.shapes.Contains(shape.guid)) { column++; continue; }
                    var prefab = look.original ? AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(shape.guid)) : GolfMapLooks.Prefab(course, label, look, shape);
                    if (!prefab) { missing++; column++; continue; }
                    var tree = Instantiate(prefab, root.transform);
                    tree.name = look.id + " / " + shape.name;
                    var position = origin + new Vector3(column * step, 0, row * step);
                    if (terrain) position.y = terrain.SampleHeight(position) + terrain.transform.position.y;
                    tree.transform.position = position;
                    column++;
                }
                row++;
            }
            paletteNote = "Lab: " + root.transform.childCount + " tree(s), one row per look (" + string.Join(", ", looks.Select(l => l.id).ToArray()) + "), shapes left to right by height." +
                (missing > 0 ? " " + missing + " prefab(s) missing: Regenerate the look." : "");
            FrameLab();
        }

        static void FrameLab()
        {
            var root = LabRoot(); var view = SceneView.lastActiveSceneView;
            if (!root || !view) return;
            var renderers = root.GetComponentsInChildren<Renderer>();
            if (renderers.Length == 0) return;
            var bounds = renderers[0].bounds;
            foreach (var r in renderers) bounds.Encapsulate(r.bounds);
            // Not FrameSelected: selecting the Lab would close this Inspector.
            view.LookAt(bounds.center, view.rotation, bounds.extents.magnitude * 1.2f);
        }
    }
}
