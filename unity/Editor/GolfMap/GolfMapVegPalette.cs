// Vegetation palette editor, model: the course's two palette files as one list of tunable
// entries with the same kinds of settings.
//
//   grass-palette.json (golfmap-grass-v1)  lower vegetation: texture grass and mesh bushes,
//                                          grouped in palettes (one per zone type slot)
//   palette.json (tree palette)            trees: each species' looks (material copies)
//
// An entry is one thing VSP draws with its own settings: a grass/bush item - one VSP item
// per name, so an item listed in several palettes is ONE entry (the file repeats it; the
// editor keeps the copies equal, only the per-palette binding weight differs) - a tree look,
// or a grass palette itself (its palette-wide values). Its settings are values keyed by a
// role that means the same everywhere ("healthy" is a grass item's healthy tint, a bush's
// leaf colour and a tree look's _HealthyColor on each of its leaf materials), so a selection
// that spans palettes, bushes and trees can be edited and graded together.
//
// The files stay the source of truth and keep their exact text: grass values go through the
// lossless document (untouched numbers keep their tokens), tree looks through GolfMapPalette
// and GolfMapLooks.Capture. Tree look values live in the look's material copies, edited in
// place (that is what the Lab and VSP draw); Save records them in palette.json.
// Pushing values into the scene is GolfMapVegLive's job; the window is GolfMapVegPaletteWindow.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public enum GolfMapVegKind { Grass, Bush, Tree, Palette }

    // How a changed value reaches the scene. Material: VSP re-applies its shader controller
    // (instant). Respawn: VSP clears the item's cells and spawns them again (fast, per item).
    // Render: read at draw time. Rebuild: needs golfmap.grass.apply (a texture or prefab copy).
    // File: only in the file (binding weights are baked into the zone masks by golf-map; look
    // weights are used by the next Plant).
    public enum GolfMapVegRefresh { Material, Respawn, Render, Rebuild, File }

    [Serializable]
    public class GolfMapVegValue
    {
        public string role;     // "healthy", "height", "mat:_SmoothnessPower" ...
        public string slot;     // grass: "" (binding weight: the palette key); tree: material guid
        public string prop;     // JSON key (grass) or material property (trees, material roles)
        public string part;     // "leaves" / "bark" for tree materials, "" otherwise
        public bool colour, toggle;
        public Color c;
        public float f;

        public GolfMapVegValue Copy() { return (GolfMapVegValue)MemberwiseClone(); }
        public bool Same(GolfMapVegValue o) { return colour ? Hex(c) == Hex(o.c) && Mathf.Abs(c.a - o.c.a) < 0.002f : Mathf.Abs(f - o.f) < 1e-5f; }
        public bool Matches(GolfMapVegValue o) { return role == o.role && slot == o.slot && prop == o.prop; }
        static string Hex(Color x) { return ColorUtility.ToHtmlStringRGB(x); }
    }

    [Serializable]
    public class GolfMapVegEntry
    {
        public string key;          // "g:<item name>", "t:<species>/<look>", "p:<palette key>"
        public string name;
        public GolfMapVegKind kind;
        public string species, look;         // trees
        public string source;                // texture or prefab asset path (grass/bush), first shape's prefab (trees)
        public bool readOnly;                // a tree species' source materials: tune a look copy instead
        public string readOnlyWhy;
        public string note;                  // worth knowing before editing (materials outside the look, ...)
        public List<string> palettes = new List<string>();    // grass: the palettes listing it; palette: its own key
        public List<string> members = new List<string>();     // palette: item keys in file order
        public List<GolfMapVegValue> values = new List<GolfMapVegValue>();

        public GolfMapVegEntry Copy()
        {
            var e = (GolfMapVegEntry)MemberwiseClone();
            e.palettes = new List<string>(palettes); e.members = new List<string>(members);
            e.values = values.Select(v => v.Copy()).ToList();
            return e;
        }
        public GolfMapVegValue Find(GolfMapVegValue like) { return values.FirstOrDefault(v => v.Matches(like)); }
        public IEnumerable<GolfMapVegValue> Role(string role) { return values.Where(v => v.role == role); }
        public float Get(string role, float fallback) { var v = values.FirstOrDefault(x => x.role == role && !x.colour); return v != null ? v.f : fallback; }
        public bool Has(string role) { return values.Any(v => v.role == role); }
        public bool IsTreeLook { get { return kind == GolfMapVegKind.Tree; } }
    }

    // What the relative "adjust together" sliders hold. Colours grade in linear light (the way
    // the palettes have been tuned by measurement), sizes scale, density scales instances per
    // square metre (spacing by 1/sqrt), spread widens or narrows the min..max scale range
    // around its geometric middle.
    [Serializable]
    public class GolfMapVegAdjust
    {
        public float brightness, saturation, hue, warmth;   // -0.75..1, -1..1, degrees, -1..1
        public float height, width, density, spread;        // fractions: +0.1 = 10% more
        public bool healthy = true, dry = true, bark;

        public bool IsZero { get { return brightness == 0 && saturation == 0 && hue == 0 && warmth == 0 && height == 0 && width == 0 && density == 0 && spread == 0; } }
        public void Clear() { brightness = saturation = hue = warmth = height = width = density = spread = 0; }
    }

    public sealed class GolfMapVegRole
    {
        public string id, label, tip, section;
        public bool colour, toggle;
        public float min, max;
        public GolfMapVegRefresh live;
        public int decimals = 3;
    }

    // The editor's working copy (undoable) and the values as last loaded/saved (not undoable:
    // undoing past a Save must not move the baseline). Both survive script reloads.
    public class GolfMapVegState : ScriptableObject
    {
        public List<GolfMapVegEntry> entries = new List<GolfMapVegEntry>();
        // Saved copy only: where it came from and when (a file changed on disk since).
        public string coursePath, grassPath, treePath;
        public long grassStamp, treeStamp;
        public List<string> notes = new List<string>();
        [NonSerialized] Dictionary<string, GolfMapVegEntry> index;
        public GolfMapVegEntry Get(string key)
        {
            if (index == null || index.Count != entries.Count) index = entries.ToDictionary(x => x.key);
            GolfMapVegEntry e; return key != null && index.TryGetValue(key, out e) ? e : null;
        }
        public void Reindex() { index = null; }
    }

    public static class GolfMapVegPalette
    {
        // ---- roles --------------------------------------------------------------

        static GolfMapVegRole R(string id, string label, string section, float min, float max, GolfMapVegRefresh live, string tip, int decimals = 3)
        {
            return new GolfMapVegRole { id = id, label = label, section = section, min = min, max = max, live = live, tip = tip, decimals = decimals };
        }
        static GolfMapVegRole C(string id, string label, string tip) { return new GolfMapVegRole { id = id, label = label, section = "Colours", colour = true, live = GolfMapVegRefresh.Material, tip = tip }; }

        public static readonly GolfMapVegRole[] Roles =
        {
            C("healthy", "Healthy tint", "Grass: VSP blends the healthy and dry tints over the ground with a noise (tint area scale). Bushes and trees: the leaf shader's healthy colour."),
            C("dry", "Dry tint", "The other end of the tint noise."),
            C("bark", "Bark", "Bark material colour (trees)."),
            C("hue", "Hue variation", "SpeedTree: each tree shifts towards this colour by an amount that depends on where it stands (alpha = strength)."),
            R("width", "Width", "Size", 0.05f, 6, GolfMapVegRefresh.Respawn, "Scale multiplier across (grass cards: metres of card width at scale 1)."),
            R("height", "Height", "Size", 0.05f, 6, GolfMapVegRefresh.Respawn, "Scale multiplier up (grass cards: metres of card height at scale 1)."),
            R("minScale", "Min scale", "Size", 0.05f, 4, GolfMapVegRefresh.Respawn, "Each instance draws a random scale between min and max."),
            R("maxScale", "Max scale", "Size", 0.05f, 4, GolfMapVegRefresh.Respawn, "Each instance draws a random scale between min and max."),
            R("noiseScaleMin", "Height waves: low", "Size", 0.1f, 3, GolfMapVegRefresh.Respawn, "Perlin 'height waves' scale the instances between low and high over the ground (uneven top). Needs a wave size above 0."),
            R("noiseScaleMax", "Height waves: high", "Size", 0.1f, 3, GolfMapVegRefresh.Respawn, "Upper end of the height waves."),
            R("noiseScaleScale", "Height waves: size", "Size", 0, 60, GolfMapVegRefresh.Respawn, "Size of the height waves (VSP noise scale). 0 = off."),
            R("sampleDistance", "Spacing (m)", "Placement", 0.1f, 12, GolfMapVegRefresh.Respawn, "Distance between spawn samples: smaller = thicker. Halving it gives four times as many."),
            R("density", "Density", "Placement", 0, 1, GolfMapVegRefresh.Respawn, "Share of samples that spawn."),
            R("noiseDensityScale", "Patchiness", "Placement", 0, 60, GolfMapVegRefresh.Respawn, "Density noise scale: patches instead of an even carpet. 0 = even."),
            R("noiseCutoff", "Clump cutoff", "Placement", 0, 1, GolfMapVegRefresh.Respawn, "Leaves open stretches between clumps. Higher values leave more open ground; 0 = off."),
            R("noiseCutoffScale", "Clump size", "Placement", 1, 60, GolfMapVegRefresh.Respawn, "Noise scale for the clump openings. Matching values align openings across species."),
            R("verticalOffset", "Vertical offset", "Placement", -15, 5, GolfMapVegRefresh.Respawn, "Local metres, multiplied by instance scale. Negative values bury the base of a canopy."),
            R("maxSteepness", "Max slope (deg)", "Placement", 0, 90, GolfMapVegRefresh.Respawn, "Steepest ground it grows on.", 1),
            R("maxDensity", "Binding weight", "Placement", 0, 1, GolfMapVegRefresh.File, "Share of the zone this palette gives the item. Baked into the zone masks by golf-map: re-bind + export zones + import to see it."),
            R("randomDarkening", "Random darkening", "Shading", 0, 1, GolfMapVegRefresh.Material, "Darkens random blades: depth in the sward."),
            R("rootAmbient", "Root ambient", "Shading", 0, 1, GolfMapVegRefresh.Material, "Darkens the blades towards the root."),
            R("alphaCutoff", "Alpha cutoff", "Shading", 0, 1, GolfMapVegRefresh.Material, "Cut-out threshold of the blade texture: higher = thinner blades."),
            R("whitePoint", "Texture white point", "Shading", 0.3f, 1, GolfMapVegRefresh.Rebuild, "Level the greyscale copy's bright blades are lifted to. A new texture: Rebuild VSP to see it."),
            R("lodFactor", "LOD distance factor", "Rendering", 0.15f, 60, GolfMapVegRefresh.Render, "Multiplies the grass patch LOD distances. 40 = no visible density ring inside the draw distance.", 2),
            new GolfMapVegRole { id = "shadows", label = "Casts shadows", section = "Rendering", toggle = true, live = GolfMapVegRefresh.Render, tip = "Mesh bushes only." },
            R("weight", "Share of the species", "Look", 0, 10, GolfMapVegRefresh.File, "Look weight: its share of the species' stems, relative to the species' other looks. Used by the next Plant."),
            R("tintAreaScale", "Tint area scale", "Palette", 10, 150, GolfMapVegRefresh.Material, "Size of the healthy/dry noise over the ground, for every item of the palette.", 1),
            R("distanceFalloff", "Distance falloff", "Palette", 0, 1, GolfMapVegRefresh.Respawn, "Instances drop out between this fraction and all of the draw distance (0.75 = full to 75%, gone at 100%). 0 = off."),
            R("plantDistance", "Draw distance (m)", "Palette", 0, 1000, GolfMapVegRefresh.Respawn, "VSP's grass/plant draw distance - system wide: the largest of the palettes wins. 0 = leave as is.", 0),
        };

        static readonly Dictionary<string, GolfMapVegRole> RoleIndex = Roles.ToDictionary(r => r.id);
        // Material floats shown first, with plain names; the rest go under "More material settings".
        public static readonly string[] CuratedMaterial =
        {
            "_SmoothnessPower", "_SpecularPower", "_Smooothness", "_MetallicPower", "_AmbientOcclusionPower", "_BackFaceMirrorNormal", "_Cutoff", "_BumpScale", "_ColorNoiseSpread",
            "_TranslucencyStrength", "_ViewDependency", "_AmbientTranslucency", "_BackFaceSmoothness", "_OcclusionStrength",
        };
        static readonly Dictionary<string, string> MaterialLabels = new Dictionary<string, string>
        {
            { "_SmoothnessPower", "Smoothness" }, { "_SpecularPower", "Specular" }, { "_Smooothness", "Smoothness (far LOD)" }, { "_MetallicPower", "Metallic" },
            { "_AmbientOcclusionPower", "Ambient occlusion" }, { "_BackFaceMirrorNormal", "Back faces: mirrored normal" }, { "_Cutoff", "Alpha cutoff" },
            { "_BumpScale", "Normal map strength" }, { "_ColorNoiseSpread", "Healthy/dry noise size" }, { "_TranslucencyStrength", "Translucency" },
            { "_ViewDependency", "Translucency view dependency" }, { "_AmbientTranslucency", "Ambient translucency" }, { "_BackFaceSmoothness", "Back face smoothness" },
            { "_OcclusionStrength", "Occlusion" },
        };
        public static readonly string[] Sections = { "Colours", "Size", "Placement", "Shading", "Rendering", "Material", "Look", "Palette" };

        public static bool IsMaterial(string role) { return role.StartsWith("mat:", StringComparison.Ordinal); }

        // Material roles are made up as they are met: label, range and tip from the shader.
        static readonly Dictionary<string, GolfMapVegRole> MaterialRoles = new Dictionary<string, GolfMapVegRole>();
        public static GolfMapVegRole Role(string id)
        {
            GolfMapVegRole r;
            if (RoleIndex.TryGetValue(id, out r) || MaterialRoles.TryGetValue(id, out r)) return r;
            return MaterialRoles[id] = new GolfMapVegRole { id = id, label = id.Substring(4), section = "Material", min = 0, max = 2, live = GolfMapVegRefresh.Material, tip = "" };
        }
        static void DescribeMaterialRole(Material m, int i, string id)
        {
            if (MaterialRoles.ContainsKey(id)) return;
            var shader = m.shader;
            string prop = ShaderUtil.GetPropertyName(shader, i), label;
            if (!MaterialLabels.TryGetValue(prop, out label)) label = ShaderUtil.GetPropertyDescription(shader, i);
            // Some shaders describe a property by its own name: "_TumbleStrength" -> "Tumble Strength".
            if (string.IsNullOrEmpty(label) || label.StartsWith("_", StringComparison.Ordinal))
                label = System.Text.RegularExpressions.Regex.Replace(prop.TrimStart('_'), "(?<=[a-z])(?=[A-Z])", " ");
            var r = new GolfMapVegRole { id = id, label = label, section = "Material", live = GolfMapVegRefresh.Material, min = 0, max = 2 };
            if (ShaderUtil.GetPropertyType(shader, i) == ShaderUtil.ShaderPropertyType.Range) { r.min = ShaderUtil.GetRangeLimits(shader, i, 1); r.max = ShaderUtil.GetRangeLimits(shader, i, 2); }
            else { float v = m.GetFloat(ShaderUtil.GetPropertyName(shader, i)); r.min = Mathf.Min(0, v); r.max = Mathf.Max(2, v * 2); }
            r.toggle = r.label.IndexOf("Mirror", StringComparison.OrdinalIgnoreCase) >= 0 || id.EndsWith("Active", StringComparison.Ordinal);
            r.tip = ShaderUtil.GetPropertyName(shader, i) + " on " + shader.name;
            MaterialRoles[id] = r;
        }

        // Material roles are described from the shaders as entries load; entries that outlived a
        // script reload are described again from their materials.
        public static void DescribeRoles(IEnumerable<GolfMapVegEntry> entries)
        {
            foreach (var e in entries)
            {
                IEnumerable<Material> materials;
                if (e.kind == GolfMapVegKind.Bush) materials = BushMaterials(e.source);
                else if (e.kind == GolfMapVegKind.Tree) materials = e.values.Select(v => v.slot).Where(s => !string.IsNullOrEmpty(s)).Distinct().Select(g => AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g))).Where(m => m);
                else continue;
                foreach (var m in materials)
                    for (int i = 0; i < ShaderUtil.GetPropertyCount(m.shader); i++)
                        if (IsTunableFloat(m.shader, i)) DescribeMaterialRole(m, i, "mat:" + ShaderUtil.GetPropertyName(m.shader, i));
            }
        }

        // ---- loading --------------------------------------------------------------

        public sealed class Loaded
        {
            public List<GolfMapVegEntry> entries = new List<GolfMapVegEntry>();
            public List<string> notes = new List<string>();
            public string grassPath, treePath, grassText, treeText;
        }

        public static string GrassPath(GolfMapCourse course) { return GolfMapGrass.PalettePath(course); }

        public static Loaded Load(GolfMapCourse course)
        {
            var result = new Loaded { grassPath = GrassPath(course), treePath = GolfMapCourses.PalettePath(course) };
            if (File.Exists(result.grassPath))
            {
                try { LoadGrass(course, result); }
                catch (Exception e) { result.notes.Add("Lower vegetation not loaded: " + e.Message); }
            }
            else result.notes.Add("No lower vegetation palette at " + result.grassPath + ".");
            if (File.Exists(result.treePath))
            {
                try { LoadTrees(course, result); }
                catch (Exception e) { result.notes.Add("Tree palette not loaded: " + e.Message); }
            }
            else result.notes.Add("No tree palette at " + result.treePath + ".");
            return result;
        }

        static GolfMapVegValue F(string role, string prop, float value) { return new GolfMapVegValue { role = role, slot = "", prop = prop, part = "", f = value, toggle = Role(role).toggle }; }
        static GolfMapVegValue Col(string role, string prop, Color value) { return new GolfMapVegValue { role = role, slot = "", prop = prop, part = "", colour = true, c = value }; }

        static void LoadGrass(GolfMapCourse course, Loaded result)
        {
            result.grassText = File.ReadAllText(result.grassPath);
            var doc = GolfMapJsonDoc.ParseObject(result.grassText);
            var resolved = GolfMapGrass.Load(course);      // the values apply uses: defaults and palette-level fallbacks filled in
            var nodes = (doc.Array("palettes") ?? new List<object>()).Cast<GolfMapJsonObject>().ToList();
            var byKey = new Dictionary<string, GolfMapVegEntry>();
            for (int p = 0; p < resolved.Count && p < nodes.Count; p++)
            {
                var palette = resolved[p];
                var pe = new GolfMapVegEntry { key = "p:" + palette.key, name = palette.key, kind = GolfMapVegKind.Palette };
                pe.palettes.Add(palette.key);
                pe.values.Add(F("tintAreaScale", "tintAreaScale", palette.tintAreaScale));
                pe.values.Add(F("distanceFalloff", "distanceFalloff", palette.distanceFalloff));
                pe.values.Add(F("plantDistance", "plantDistance", palette.plantDistance));
                result.entries.Add(pe);
                var itemNodes = (nodes[p].Array("items") ?? new List<object>()).Cast<GolfMapJsonObject>().ToList();
                for (int i = 0; i < palette.items.Count && i < itemNodes.Count; i++)
                {
                    var spec = palette.items[i];
                    string key = "g:" + spec.name;
                    GolfMapVegEntry e;
                    if (!byKey.TryGetValue(key, out e))
                    {
                        e = GrassEntry(course, spec);
                        byKey[key] = e;
                        result.entries.Add(e);
                    }
                    else
                    {
                        var other = GrassEntry(course, spec);
                        if (other.values.Any(v => { var mine = e.Find(v); return mine == null || !mine.Same(v); }))
                            result.notes.Add("'" + spec.name + "' differs between palettes " + string.Join(", ", e.palettes) + " and " + palette.key + "; VSP has one item, so the editor keeps the first and Save writes it to every palette.");
                    }
                    e.palettes.Add(palette.key);
                    e.values.Add(new GolfMapVegValue { role = "maxDensity", slot = palette.key, prop = "maxDensity", part = "", f = (float)itemNodes[i].Number("maxDensity", 1) });
                    pe.members.Add(key);
                }
            }
        }

        static GolfMapVegEntry GrassEntry(GolfMapCourse course, GolfMapGrass.Item spec)
        {
            bool bush = spec.prefab != null;
            var e = new GolfMapVegEntry { key = "g:" + spec.name, name = spec.name, kind = bush ? GolfMapVegKind.Bush : GolfMapVegKind.Grass, source = bush ? spec.prefab : spec.source };
            Color healthy = spec.healthy, dry = spec.dry;
            var materials = bush ? BushMaterials(spec.prefab) : new List<Material>();
            if (bush && !spec.tinted)
            {
                // Untinted bush: what VSP draws (its controller took the colours from the prefab's
                // leaf material when the item was made), else the leaf material itself.
                var leaf = materials.FirstOrDefault(m => m.HasProperty("_HealthyColor"));
                if (leaf) { healthy = leaf.GetColor("_HealthyColor"); dry = leaf.HasProperty("_DryColor") ? leaf.GetColor("_DryColor") : healthy; }
                var drawn = GolfMapVegLive.ControllerColour(spec.name, "HealtyColor");
                if (drawn.HasValue) { healthy = drawn.Value; dry = GolfMapVegLive.ControllerColour(spec.name, "DryColor") ?? dry; }
            }
            e.values.Add(Col("healthy", "healthy", healthy));
            e.values.Add(Col("dry", "dry", dry));
            e.values.Add(F("width", "width", spec.width));
            e.values.Add(F("height", "height", spec.height));
            e.values.Add(F("minScale", "minScale", spec.minScale));
            e.values.Add(F("maxScale", "maxScale", spec.maxScale));
            e.values.Add(F("noiseScaleMin", "noiseScaleMin", spec.noiseScaleMin));
            e.values.Add(F("noiseScaleMax", "noiseScaleMax", spec.noiseScaleMax));
            e.values.Add(F("noiseScaleScale", "noiseScaleScale", spec.noiseScaleScale));
            e.values.Add(F("sampleDistance", "sampleDistance", spec.sampleDistance));
            e.values.Add(F("density", "density", spec.density));
            e.values.Add(F("noiseDensityScale", "noiseDensityScale", spec.noiseDensityScale));
            e.values.Add(F("noiseCutoff", "noiseCutoff", spec.noiseCutoff));
            e.values.Add(F("noiseCutoffScale", "noiseCutoffScale", spec.noiseCutoffScale));
            e.values.Add(F("verticalOffset", "verticalOffset", spec.verticalOffset));
            e.values.Add(F("maxSteepness", "maxSteepness", spec.maxSteepness));
            e.values.Add(F("lodFactor", "lodFactor", spec.lodFactor));
            if (!bush)
            {
                e.values.Add(F("randomDarkening", "randomDarkening", spec.randomDarkening));
                e.values.Add(F("rootAmbient", "rootAmbient", spec.rootAmbient));
                e.values.Add(F("alphaCutoff", "alphaCutoff", spec.alphaCutoff));
                e.values.Add(F("whitePoint", "whitePoint", spec.whitePoint));
                return e;
            }
            e.values.Add(F("shadows", "shadows", spec.shadows ? 1 : 0));
            // Every float the bush's shaders have; the file's "material" overrides win over the prefab's values.
            foreach (var m in materials)
                for (int i = 0; i < ShaderUtil.GetPropertyCount(m.shader); i++)
                {
                    if (!IsTunableFloat(m.shader, i)) continue;
                    string prop = ShaderUtil.GetPropertyName(m.shader, i), role = "mat:" + prop;
                    if (e.Has(role)) continue;
                    DescribeMaterialRole(m, i, role);
                    float value; if (!spec.material.TryGetValue(prop, out value)) value = m.GetFloat(prop);
                    e.values.Add(F(role, prop, value));
                }
            return e;
        }

        public static List<Material> BushMaterials(string prefabPath)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            if (!prefab) return new List<Material>();
            return prefab.GetComponentsInChildren<Renderer>(true).Where(r => !(r is BillboardRenderer)).SelectMany(r => r.sharedMaterials).Where(m => m && m.shader).Distinct().ToList();
        }

        // Floats worth a control: not hidden, not VSP/Amplify bookkeeping.
        static bool IsTunableFloat(Shader shader, int i)
        {
            var type = ShaderUtil.GetPropertyType(shader, i);
            if (type != ShaderUtil.ShaderPropertyType.Float && type != ShaderUtil.ShaderPropertyType.Range) return false;
            if (ShaderUtil.IsShaderPropertyHidden(shader, i)) return false;
            string name = ShaderUtil.GetPropertyName(shader, i);
            return !name.StartsWith("__", StringComparison.Ordinal) && name != "_texcoord" && name != "_Mode" && name != "_SrcBlend" && name != "_DstBlend" && name != "_ZWrite";
        }

        static void LoadTrees(GolfMapCourse course, Loaded result)
        {
            result.treeText = File.ReadAllText(result.treePath);
            var biome = GolfMapPalette.Load(result.treePath);
            foreach (var label in biome.assets.Select(a => a.Label).Distinct().OrderBy(l => l, StringComparer.Ordinal))
            {
                var group = biome.Species(label);
                var looks = group == null || group.looks.Count == 0 ? new List<GolfMapBiomeLook> { new GolfMapBiomeLook { id = "original", weight = 1, original = true } } : group.looks;
                bool implicitOriginal = group == null || group.looks.Count == 0;
                foreach (var look in looks)
                {
                    try { result.entries.Add(TreeEntry(course, biome, label, look, implicitOriginal)); }
                    catch (Exception e) { result.notes.Add("Trees '" + label + "/" + look.id + "': " + e.Message); }
                }
            }
        }

        public static GolfMapVegEntry TreeEntry(GolfMapCourse course, GolfMapBiome biome, string species, GolfMapBiomeLook look, bool implicitOriginal)
        {
            var e = new GolfMapVegEntry { key = "t:" + species + "/" + look.id, name = look.id, kind = GolfMapVegKind.Tree, species = species, look = look.id };
            e.palettes.Add("trees/" + species);
            var shapes = GolfMapLooks.Shapes(biome, species, look).Where(a => a.enabled).OrderBy(a => a.heightM).ToList();
            if (shapes.Count == 0) shapes = GolfMapLooks.Shapes(biome, species, look);
            var first = shapes.FirstOrDefault();
            if (first != null)
            {
                var prefab = look.original ? null : GolfMapLooks.Prefab(course, species, look, first);
                e.source = prefab ? AssetDatabase.GetAssetPath(prefab) : AssetDatabase.GUIDToAssetPath(first.guid);
            }
            if (look.original)
            {
                e.readOnly = true;
                e.readOnlyWhy = "The source prefabs' own materials (a pack's assets, shared by anything else using them). Create a tunable look to change " + species + ".";
            }
            if (!implicitOriginal) e.values.Add(F("weight", "weight", (float)look.weight));
            // What the look's prefabs draw with - the thing to tune, even when a trial (the CTI
            // swap) re-pointed them away from the look's own copies.
            var prefabs = shapes.Select(s => look.original ? AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(s.guid)) : GolfMapLooks.Prefab(course, species, look, s)).Where(p => p).ToList();
            var materials = prefabs.Count > 0 ? GolfMapLooks.DrawnMaterials(prefabs) : GolfMapLooks.Materials(course, biome, species, look);
            if (!look.original && materials.Count == 0) { e.readOnly = true; e.readOnlyWhy = "Recorded in palette.json but has no material copies in this project yet: Regenerate the look."; }
            if (!look.original)
            {
                string folder = GolfMapLooks.Folder(course, species, look.id);
                var outside = materials.Where(m => !AssetDatabase.GetAssetPath(m).StartsWith(folder, StringComparison.Ordinal)).ToList();
                if (outside.Count > 0)
                    e.note = "Draws with " + string.Join(", ", outside.Select(m => AssetDatabase.GetAssetPath(m)).ToArray()) + " - outside the look's folder (a trial such as the CTI swap). Edits change those materials in place and Save does not record them in palette.json.";
            }
            foreach (var m in materials) AddMaterialValues(e, m);
            return e;
        }

        public static string Part(Material m)
        {
            if (m.HasProperty("_HealthyColor") || m.HasProperty("_GolfMapLeafTint")) return "leaves";
            if (m.shader.name.IndexOf("Bark", StringComparison.OrdinalIgnoreCase) >= 0 || m.IsKeywordEnabled("GEOM_TYPE_BRANCH")) return "bark";
            if (m.shader.name.IndexOf("Lea", StringComparison.OrdinalIgnoreCase) >= 0 || m.shader.name.Contains("SpeedTree")) return "leaves";
            return "other";
        }

        // The colours a tree material tints with, under the shared roles; then its floats.
        static void AddMaterialValues(GolfMapVegEntry e, Material m)
        {
            string guid = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(m)), part = Part(m);
            Action<string, string> colour = (role, prop) => e.values.Add(new GolfMapVegValue { role = role, slot = guid, prop = prop, part = part, colour = true, c = m.GetColor(prop) });
            if (m.HasProperty("_HealthyColor")) colour("healthy", "_HealthyColor");
            if (m.HasProperty("_DryColor")) colour("dry", "_DryColor");
            if (m.HasProperty("_GolfMapLeafTint")) colour("healthy", "_GolfMapLeafTint");
            // NM leaves carry a white _Color the shader does not tint with.
            if (!m.HasProperty("_HealthyColor") && m.HasProperty("_Color")) colour(part == "bark" ? "bark" : "healthy", "_Color");
            if (m.IsKeywordEnabled("EFFECT_HUE_VARIATION") && m.HasProperty("_HueVariation")) colour("hue", "_HueVariation");
            for (int i = 0; i < ShaderUtil.GetPropertyCount(m.shader); i++)
            {
                if (!IsTunableFloat(m.shader, i)) continue;
                string prop = ShaderUtil.GetPropertyName(m.shader, i), role = "mat:" + prop;
                DescribeMaterialRole(m, i, role);
                e.values.Add(new GolfMapVegValue { role = role, slot = guid, prop = prop, part = part, f = m.GetFloat(prop), toggle = Role(role).toggle });
            }
        }

        // ---- grading and adjusting -------------------------------------------------

        static float Luma(Color lin) { return 0.2126f * lin.r + 0.7152f * lin.g + 0.0722f * lin.b; }

        public static Color Grade(Color c, GolfMapVegAdjust a)
        {
            float ceiling = Mathf.Max(1, Mathf.Max(c.r, Mathf.Max(c.g, c.b)));   // never clip an HDR tint down to 1
            float alpha = c.a;
            if (a.hue != 0)
            {
                float h, s, v;
                Color.RGBToHSV(c, out h, out s, out v);
                c = Color.HSVToRGB(Mathf.Repeat(h + a.hue / 360f, 1), s, v, true);
            }
            var lin = c.linear;
            float y = Luma(lin);
            if (a.saturation != 0)
            {
                float k = 1 + a.saturation;
                lin = new Color(y + (lin.r - y) * k, y + (lin.g - y) * k, y + (lin.b - y) * k);
            }
            if (a.warmth != 0)
            {
                lin = new Color(lin.r * (1 + 0.25f * a.warmth), lin.g, lin.b * (1 - 0.25f * a.warmth));
                float y2 = Luma(lin);
                if (y2 > 1e-5f) { float k = y / y2; lin = new Color(lin.r * k, lin.g * k, lin.b * k); }
            }
            if (a.brightness != 0) { float k = 1 + a.brightness; lin = new Color(lin.r * k, lin.g * k, lin.b * k); }
            float max = Mathf.Pow(ceiling, 2.2f);
            lin = new Color(Mathf.Clamp(lin.r, 0, max), Mathf.Clamp(lin.g, 0, max), Mathf.Clamp(lin.b, 0, max));
            var g = lin.gamma;
            g.a = alpha;
            return g;
        }

        // target <- baseline graded by the sliders. Values the sliders do not touch keep the target's.
        public static void Adjust(GolfMapVegEntry baseline, GolfMapVegEntry target, GolfMapVegAdjust a)
        {
            if (target.readOnly) return;
            float minB = baseline.Get("minScale", 0), maxB = baseline.Get("maxScale", 0);
            float mid = minB > 0 && maxB > 0 ? Mathf.Sqrt(minB * maxB) : 0;
            foreach (var v in target.values)
            {
                var b = baseline.Find(v);
                if (b == null) continue;
                if (v.colour)
                {
                    bool on = v.role == "healthy" ? a.healthy : v.role == "dry" ? a.dry : v.role == "bark" && a.bark;
                    if (on) v.c = Quantise(target, Grade(b.c, a));
                    continue;
                }
                switch (v.role)
                {
                    case "width": v.f = Round(b.f * (1 + a.width), 3); break;
                    case "height": v.f = Round(b.f * (1 + a.height), 3); break;
                    case "sampleDistance": v.f = Round(b.f / Mathf.Sqrt(Mathf.Max(0.05f, 1 + a.density)), 3); break;
                    case "minScale":
                    case "maxScale":
                        if (mid > 0 && a.spread != 0) v.f = Round(mid * Mathf.Pow(b.f / mid, Mathf.Max(0, 1 + a.spread)), 3);
                        else v.f = b.f;
                        break;
                }
            }
        }

        // Grass tints are stored as 8-bit hex: keep what is shown equal to what Save writes.
        public static Color Quantise(GolfMapVegEntry e, Color c)
        {
            if (e.kind == GolfMapVegKind.Tree) return new Color(Round(c.r, 4), Round(c.g, 4), Round(c.b, 4), Round(c.a, 4));
            Color32 q = new Color(Mathf.Clamp01(c.r), Mathf.Clamp01(c.g), Mathf.Clamp01(c.b), 1);
            return q;
        }

        public static float Round(float v, int decimals) { return (float)Math.Round(v, decimals); }

        public static string Hex(Color c) { return "#" + ColorUtility.ToHtmlStringRGB(c).ToLowerInvariant(); }

        // ---- saving -----------------------------------------------------------------

        // Writes the grass values that differ from `saved` into the file's text (every palette
        // listing the item). Returns the new text; unchanged values keep their exact tokens.
        public static string GrassText(string text, GolfMapVegState current, GolfMapVegState saved)
        {
            var doc = GolfMapJsonDoc.ParseObject(text);
            foreach (GolfMapJsonObject p in doc.Array("palettes") ?? new List<object>())
            {
                string key = p.String("key");
                var pe = current.Get("p:" + key); var ps = saved.Get("p:" + key);
                if (pe != null && ps != null) WriteChanged(p, pe, ps, null);
                foreach (GolfMapJsonObject i in p.Array("items") ?? new List<object>())
                {
                    var e = current.Get("g:" + i.String("name")); var s = saved.Get("g:" + i.String("name"));
                    if (e != null && s != null) WriteChanged(i, e, s, key);
                }
            }
            return GolfMapJsonDoc.Write(doc);
        }

        static void WriteChanged(GolfMapJsonObject node, GolfMapVegEntry e, GolfMapVegEntry s, string palette)
        {
            foreach (var v in e.values)
            {
                if (v.role == "maxDensity" && v.slot != palette) continue;
                var was = s.Find(v);
                if (was != null && was.Same(v)) continue;
                if (v.colour) node.SetString(v.prop, Hex(v.c));
                else if (v.role == "shadows") node.SetBool("shadows", v.f > 0.5f);
                else if (IsMaterial(v.role))
                {
                    var m = node.Object("material");
                    if (m == null) { m = new GolfMapJsonObject(); node["material"] = m; }
                    m.SetNumber(v.prop, Round(v.f, 4));
                }
                else node.SetNumber(v.prop, Round(v.f, Role(v.role).decimals + 1));
            }
        }

        public static bool Dirty(GolfMapVegEntry e, GolfMapVegEntry s)
        {
            if (s == null) return false;
            foreach (var v in e.values) { var w = s.Find(v); if (w == null || !w.Same(v)) return true; }
            return false;
        }
    }
}
