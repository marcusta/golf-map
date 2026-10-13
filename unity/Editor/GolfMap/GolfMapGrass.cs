// Grass palettes: lower-vegetation items for Vegetation Studio Pro built from
// texture packs (RUSTIC Grass), coloured by VSP rather than by the texture.
//
// A palette lives in the course folder as grass-palette.json (golfmap-grass-v1):
// one entry per zone type key (the app's vegetation zone legend), each a list of
// texture grass items. For every item the tool
//
//   1. makes a greyscale copy of the source texture (PSD/PNG) under
//      <course>/Grass/Textures/, levelled so its bright blades sit near white:
//      VSP's grass shader multiplies the texture by a noise blend of the item's
//      dry and healthy tints, so a grey texture takes the palette's colours
//      exactly instead of fighting the pack's own green or straw;
//   2. adds or updates a VSP texture item (VegetationType.Grass, stock
//      "AwesomeTechnologies/Grass/Grass" shader, so GSPro's VSP knows it) in the
//      palette's package on the terrain's VSP system, creating that package
//      (Default biome) next to the course when missing;
//   3. sets size, scale range, spacing, density noise and the tints.
//
// Where the grass grows is the zone import's job (GolfMapZoneImporter): it gives
// each bound item one density and one include rule against its own mask channel
// ("golfmap-zone:item:<item>", unity-zones-v2).
// Until an item has an include rule it is kept from spawning, so a fresh item
// never carpets the whole terrain. Order: apply, bind + export + import zones,
// apply again (switches spawning on).
//
// An item with a "prefab" (asset path) instead of a "source" texture is a mesh
// plant - a bush in a shrub palette. It keeps the prefab's own materials (no
// greyscale copy); every material must be on a shader name GSPro's VSP resolves
// (GolfMapTreePlanter.VspKnowsShader), and "healthy"/"dry", when given, go to the
// shader controller's leaf colours (NM tree controller: HealtyColor/DryColor; NM Advanced
// Grass controller, e.g. bilberry, heather, ferns: HealthyColorTint/DryColorTint).
//
// "material": {"<shader float>": value, ...} on a prefab item draws a course-local
// copy of the prefab (<course>/Grass/Prefabs/<item>.prefab) whose materials are
// copies with those floats set, so a pack's material can be fixed for one use
// without touching the asset (other items share it). NM's foliage shaders draw
// both faces with the front face's normal by default: looking towards the sun you
// see back faces lit as if they faced it, with a grazing-angle sheen on a glossy
// leaf - willows read almost white from one side. {"_BackFaceMirrorNormal": 1,
// "_SmoothnessPower": 0.25, "_SpecularPower": 0.1} fixes that (Vreta's creek
// thicket). The copy's path depends only on the item name, so changing the
// overrides rewrites its materials in place (from the source's each time) and VSP
// keeps drawing the same prefab. An item whose prefab changes (first overrides,
// or a new "prefab") is replaced: re-run golfmap.zones.import so it gets its mask
// rules again, then apply.
//
// "prefabItems": "arborist" at the top of the file: the course's bushes and ground
// plants come from Arborist (pipeline/arborist.py lower reads the same prefab items
// and their zone masks), so apply leaves every prefab item out of VSP and removes
// the ones a package still has, with their height twins. The texture grass is not
// affected. Without the key the prefab items are VSP's, as above.
// "prefabItemsInVsp": ["bilberry", "fern", ...] beside it names the exceptions (parts of item
// names): prefab items the course's own VSP still draws, because Arborist cannot give them the
// "material" overrides they need (NatureManufacture's grass-shader plants light their back faces
// as fronts and go white from the sun's side unless _BackFaceMirrorNormal is set; Arborist stores
// no such value). pipeline/arborist.py lower leaves the same items out.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapGrass
    {
        public const string PaletteFile = "grass-palette.json";
        const string Format = "golfmap-grass-v1";

        public sealed class Item
        {
            public string name, source, prefab;
            public Color healthy, dry;
            public bool tinted = true;             // prefab items: only when the palette gives colours
            public bool shadows;                   // prefab items cast shadows unless "shadows": false
            public float width = 1, height = 1, minScale = 0.8f, maxScale = 1.2f;
            public float sampleDistance = 0.6f, density = 1f;
            public float noiseDensityScale = 8f;   // 0 = no density noise
            public float noiseCutoff = 0f, noiseCutoffScale = 14f; // 0 = off; shared noise leaves openings between clumps
            public float verticalOffset = 0f; // local metres, scaled with the instance; negative buries a canopy
            public float noiseScaleMin = 0.8f, noiseScaleMax = 1.2f, noiseScaleScale = 12f;   // height waves
            public float maxSteepness = 75f;
            // Multiplies the grass patch mesh's LOD distances. VSP draws texture grass with
            // DefaultGrassPatch, whose lower LODs drop blade cards (135 -> 63 -> 36 vertices) at
            // a few metres and ~18 m: a visible density line, worst on tall sparse items.
            public float lodFactor = 5f;       // grass grows on near-vertical banks; VSP's 30-40 default leaves them bare
            public float randomDarkening = 0.2f, rootAmbient = 0.4f, alphaCutoff = 0.3f;
            public float whitePoint = 0.92f;       // greyscale level the bright blades are lifted to
            public Dictionary<string, float> material = new Dictionary<string, float>();   // prefab items: shader floats on local copies
        }

        public sealed class Palette
        {
            public string key, package;
            public bool prefabsInArborist;         // the file's "prefabItems": "arborist"
            public string[] prefabsInVsp = new string[0];   // the file's "prefabItemsInVsp": the exceptions
            public bool ArboristDraws(Item item)
            {
                return prefabsInArborist && item.prefab != null && !prefabsInVsp.Any(part => item.name.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0);
            }
            public float tintAreaScale = 40f;
            // Each instance drops out at a random fraction in [distanceFalloff, 1] of the grass
            // draw distance, so the patch thins out towards it instead of ending in a line.
            // 0 = off (everything draws to the full distance, then pops).
            public float distanceFalloff = 0.35f;
            // VSP's grass/plant draw distance for the terrain's system (metres; 0 = leave as is).
            // System-wide: it applies to every grass and plant item on that system.
            public float plantDistance = 0f;
            public List<Item> items = new List<Item>();
        }

        public static string PalettePath(GolfMapCourse course) { return GolfMapCourses.Folder(course) + PaletteFile; }

        public static List<Palette> Load(GolfMapCourse course)
        {
            var path = PalettePath(course);
            if (!File.Exists(path)) throw new BridgeError("No grass palette at " + path + ".");
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            if (doc.String("format") != Format) throw new BridgeError(path + " is not " + Format + ".");
            var palettes = new List<Palette>();
            foreach (GolfMapJsonObject p in doc.Array("palettes") ?? new List<object>())
            {
                var palette = new Palette
                {
                    key = p.String("key"),
                    package = p.String("package") ?? "GolfMap lower vegetation",
                    tintAreaScale = (float)p.Number("tintAreaScale", 40),
                    distanceFalloff = (float)p.Number("distanceFalloff", 0.35),
                    plantDistance = (float)p.Number("plantDistance", 0),
                    prefabsInArborist = doc.String("prefabItems") == "arborist",
                    prefabsInVsp = (doc.Array("prefabItemsInVsp") ?? new List<object>()).Select(o => Convert.ToString(o)).ToArray(),
                };
                foreach (GolfMapJsonObject i in p.Array("items") ?? new List<object>())
                {
                    var d = new Item();
                    var prefab = i.String("prefab");
                    var item = new Item
                    {
                        name = i.String("name"),
                        source = i.String("source"),
                        prefab = prefab,
                        tinted = prefab == null || i.String("healthy") != null,
                        shadows = prefab != null && i.Bool("shadows", true),
                        healthy = GolfMapZones.ParseColor(i.String("healthy"), Color.green),
                        dry = GolfMapZones.ParseColor(i.String("dry"), Color.yellow),
                        width = F(i, "width", d.width), height = F(i, "height", d.height),
                        minScale = F(i, "minScale", d.minScale), maxScale = F(i, "maxScale", d.maxScale),
                        sampleDistance = F(i, "sampleDistance", d.sampleDistance), density = F(i, "density", d.density),
                        noiseDensityScale = F(i, "noiseDensityScale", d.noiseDensityScale),
                        noiseCutoff = Mathf.Clamp01(F(i, "noiseCutoff", d.noiseCutoff)),
                        noiseCutoffScale = Mathf.Max(1f, F(i, "noiseCutoffScale", d.noiseCutoffScale)),
                        verticalOffset = F(i, "verticalOffset", d.verticalOffset),
                        noiseScaleMin = F(i, "noiseScaleMin", d.noiseScaleMin), noiseScaleMax = F(i, "noiseScaleMax", d.noiseScaleMax),
                        noiseScaleScale = F(i, "noiseScaleScale", d.noiseScaleScale),
                        maxSteepness = F(i, "maxSteepness", d.maxSteepness),
                        randomDarkening = F(i, "randomDarkening", d.randomDarkening), rootAmbient = F(i, "rootAmbient", d.rootAmbient),
                        alphaCutoff = F(i, "alphaCutoff", d.alphaCutoff), whitePoint = F(i, "whitePoint", d.whitePoint),
                        lodFactor = F(i, "lodFactor", F(p, "lodFactor", d.lodFactor)),
                    };
                    var overrides = i.Object("material");
                    if (overrides != null)
                    {
                        if (prefab == null) throw new BridgeError("Palette '" + palette.key + "', item '" + item.name + "': \"material\" is for prefab items.");
                        foreach (var k in overrides.keys) item.material[k] = (float)overrides.Number(k);
                    }
                    palette.items.Add(item);
                }
                if (string.IsNullOrEmpty(palette.key)) throw new BridgeError("A palette in " + path + " has no key.");
                if (palette.items.Any(i => string.IsNullOrEmpty(i.name) || string.IsNullOrEmpty(i.source) == string.IsNullOrEmpty(i.prefab)))
                    throw new BridgeError("Palette '" + palette.key + "': every item needs a name and either a source texture or a prefab.");
                palettes.Add(palette);
            }
            return palettes;
        }

        static float F(GolfMapJsonObject o, string key, float fallback) { return (float)o.Number(key, fallback); }

        // ---- greyscale textures --------------------------------------------

        // "<course>/Grass/Textures/<source name>_grey.png", rebuilt when missing, older than the source, or forced.
        public static Texture2D GreyTexture(string courseFolder, Item item, bool force, List<string> log)
        {
            var source = AssetDatabase.LoadAssetAtPath<Texture2D>(item.source);
            if (!source) throw new BridgeError("No texture at " + item.source + " (item '" + item.name + "').");
            Directory.CreateDirectory(courseFolder + "Grass/Textures/");
            var path = GreyTexturePath(courseFolder, item.source, item.whitePoint);
            bool stale = !File.Exists(path) || File.GetLastWriteTimeUtc(item.source) > File.GetLastWriteTimeUtc(path);
            if (force || stale)
            {
                File.WriteAllBytes(path, Greyscale(source, item.whitePoint).EncodeToPNG());
                AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
                log.Add("greyscale " + path + " from " + item.source);
            }
            if (ImportSettings((TextureImporter)AssetImporter.GetAtPath(path), item.alphaCutoff))
                log.Add("import settings " + path);
            return AssetDatabase.LoadAssetAtPath<Texture2D>(path);
        }

        public static string GreyTexturePath(string courseFolder, string source, float whitePoint)
        {
            return courseFolder + "Grass/Textures/" + Path.GetFileNameWithoutExtension(source) + "_grey" + Mathf.RoundToInt(whitePoint * 100) + ".png";
        }

        // Cut-out grass loses thin blades with distance: a smaller mip level averages a stem with
        // the transparency around it, its alpha falls under the shader's cutoff and it vanishes -
        // at the distance where the GPU switches mip level, which shows as a line ~15 m out where
        // the thin, bright grasses (straw, seed heads) suddenly thin. "Preserve coverage" rescales
        // each mip level's alpha so the same share of pixels passes the cutoff; trilinear blends
        // mip levels instead of switching at a line. Returns whether anything changed.
        static bool ImportSettings(TextureImporter importer, float alphaCutoff)
        {
            bool changed = false;
            Action<bool, Action> set = (differs, apply) => { if (differs) { apply(); changed = true; } };
            set(importer.textureType != TextureImporterType.Default, () => importer.textureType = TextureImporterType.Default);
            set(importer.alphaSource != TextureImporterAlphaSource.FromInput, () => importer.alphaSource = TextureImporterAlphaSource.FromInput);
            set(!importer.alphaIsTransparency, () => importer.alphaIsTransparency = true);   // dilates colour into the cut-out, no white fringes
            set(!importer.mipmapEnabled, () => importer.mipmapEnabled = true);
            set(!importer.mipMapsPreserveCoverage, () => importer.mipMapsPreserveCoverage = true);
            set(!Mathf.Approximately(importer.alphaTestReferenceValue, alphaCutoff), () => importer.alphaTestReferenceValue = alphaCutoff);
            set(importer.filterMode != FilterMode.Trilinear, () => importer.filterMode = FilterMode.Trilinear);
            set(importer.anisoLevel != 4, () => importer.anisoLevel = 4);
            set(importer.wrapMode != TextureWrapMode.Clamp, () => importer.wrapMode = TextureWrapMode.Clamp);
            set(!importer.sRGBTexture, () => importer.sRGBTexture = true);
            set(importer.maxTextureSize != 2048, () => importer.maxTextureSize = 2048);
            if (changed) importer.SaveAndReimport();
            return changed;
        }

        // Luma of the source, levelled so the 95th percentile of its opaque pixels lands on
        // `whitePoint`; transparent pixels get the mean opaque grey so mip levels don't fringe.
        static Texture2D Greyscale(Texture2D source, float whitePoint)
        {
            int w = source.width, h = source.height;
            var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var previous = RenderTexture.active;
            Graphics.Blit(source, rt);
            RenderTexture.active = rt;
            var read = new Texture2D(w, h, TextureFormat.RGBA32, false);
            read.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            read.Apply();
            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(rt);

            var px = read.GetPixels32();
            UnityEngine.Object.DestroyImmediate(read);
            var luma = new float[px.Length];
            var opaque = new List<float>();
            for (int i = 0; i < px.Length; i++)
            {
                luma[i] = (0.299f * px[i].r + 0.587f * px[i].g + 0.114f * px[i].b) / 255f;
                if (px[i].a > 127) opaque.Add(luma[i]);
            }
            if (opaque.Count == 0) throw new BridgeError(source.name + " has no opaque pixels.");
            opaque.Sort();
            float p95 = Mathf.Max(0.05f, opaque[(int)(opaque.Count * 0.95f)]);
            float gain = whitePoint / p95;
            float mean = Mathf.Clamp01(opaque.Average() * gain);
            byte fill = (byte)Mathf.RoundToInt(mean * 255);
            var outPx = new Color32[px.Length];
            for (int i = 0; i < px.Length; i++)
            {
                byte g = px[i].a > 0 ? (byte)Mathf.RoundToInt(Mathf.Clamp01(luma[i] * gain) * 255) : fill;
                outPx[i] = new Color32(g, g, g, px[i].a);
            }
            var tex = new Texture2D(w, h, TextureFormat.RGBA32, false);
            tex.SetPixels32(outPx);
            tex.Apply();
            return tex;
        }

        // ---- VSP ------------------------------------------------------------

        static VegetationSystemPro SystemFor(Terrain terrain)
        {
            var systems = UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>().Where(s => GolfMapZoneImporter.SystemMatchesTerrain(s, terrain)).ToList();
            if (systems.Count != 1) throw new BridgeError(systems.Count + " VSP systems cover '" + terrain.name + "'; expected one. Plant the trees first (GolfMapVspRig builds the system).");
            return systems[0];
        }

        static Terrain TerrainFor(GolfMapCourse course, string role)
        {
            var scene = EditorSceneManager.GetActiveScene();
            return role == "outer"
                ? GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer")
                : GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
        }

        static VegetationPackagePro EnsurePackage(string courseFolder, VegetationSystemPro system, string name, string role, List<string> log)
        {
            var package = system.VegetationPackageProList.FirstOrDefault(p => p && p.PackageName == name);
            if (package) return package;
            package = ScriptableObject.CreateInstance<VegetationPackagePro>();
            package.PackageName = name;
            package.BiomeType = BiomeType.Default;
            var folder = courseFolder + "Grass/";
            Directory.CreateDirectory(folder);
            AssetDatabase.CreateAsset(package, AssetDatabase.GenerateUniqueAssetPath(folder + "LowerVegetation-" + role + ".asset"));
            system.AddVegetationPackage(package);
            log.Add("created package '" + name + "' " + AssetDatabase.GetAssetPath(package) + " on " + system.name + " (" + role + ")");
            return package;
        }

        static bool HasControllerProperty(VegetationItemInfoPro item, string name)
        {
            var settings = item.ShaderControllerSettings;
            return settings != null && settings.ControlerPropertyList.Any(x => x.PropertyName == name);
        }

        static void SetProperty(VegetationItemInfoPro item, string name, Action<SerializedControllerProperty> set)
        {
            var settings = item.ShaderControllerSettings;
            var p = settings == null ? null : settings.ControlerPropertyList.FirstOrDefault(x => x.PropertyName == name);
            if (p == null) throw new BridgeError("Item '" + item.Name + "' has no shader property " + name + " (shader " + item.ShaderName + ").");
            set(p);
        }

        // A bush prefab VSP can draw in GSPro: loads, has mesh renderers, and every material is on a
        // shader name GSPro's VSP fork resolves (an unknown one silently drops the whole package).
        static GameObject LoadPrefab(Item spec)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(spec.prefab);
            if (!prefab) throw new BridgeError("No prefab at " + spec.prefab + " (item '" + spec.name + "').");
            var renderers = prefab.GetComponentsInChildren<Renderer>(true).Where(r => !(r is BillboardRenderer)).ToList();
            if (renderers.Count == 0) throw new BridgeError(spec.prefab + " has no mesh renderers (item '" + spec.name + "').");
            foreach (var r in renderers)
                foreach (var m in r.sharedMaterials)
                {
                    if (!m || !m.shader) throw new BridgeError(spec.prefab + " / " + r.name + " has a missing material or shader.");
                    if (!GolfMapTreePlanter.VspKnowsShader(m.shader.name))
                        throw new BridgeError(spec.prefab + " / " + r.name + " (" + m.name + ") uses '" + m.shader.name + "', which GSPro's VSP does not know; it would stop the whole package loading.");
                }
            return prefab;
        }

        // The prefab item's course-local copy with its "material" overrides (see the header).
        static GameObject LocalPrefab(string courseFolder, Item spec, GameObject source, List<string> log)
        {
            var grass = courseFolder + "Grass";
            if (!AssetDatabase.IsValidFolder(grass)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Grass");
            var dir = grass + "/Prefabs";
            if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder(grass, "Prefabs");
            var safe = new string(spec.name.Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray());
            var path = dir + "/" + safe + ".prefab";
            var local = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (!local)
            {
                if (!AssetDatabase.CopyAsset(spec.prefab, path)) throw new BridgeError("Could not copy " + spec.prefab + " to " + path + ".");
                local = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                log.Add("copied " + spec.prefab + " to " + path);
            }
            var from = source.GetComponentsInChildren<Renderer>(true);
            var to = local.GetComponentsInChildren<Renderer>(true);
            if (from.Length != to.Length) throw new BridgeError(path + " no longer matches " + spec.prefab + "; delete it and apply again.");
            for (int r = 0; r < from.Length; r++)
            {
                var mats = from[r].sharedMaterials.Select(m =>
                {
                    if (!m) return m;
                    var copyPath = dir + "/" + safe + " - " + m.name + ".mat";
                    var copy = AssetDatabase.LoadAssetAtPath<Material>(copyPath);
                    if (!copy)
                    {
                        if (!AssetDatabase.CopyAsset(AssetDatabase.GetAssetPath(m), copyPath)) throw new BridgeError("Could not copy material " + m.name + ".");
                        copy = AssetDatabase.LoadAssetAtPath<Material>(copyPath);
                    }
                    else EditorUtility.CopySerialized(m, copy);   // from the source each time: removed overrides go back
                    foreach (var kv in spec.material)
                        if (copy.HasProperty(kv.Key)) copy.SetFloat(kv.Key, kv.Value);
                    EditorUtility.SetDirty(copy);
                    return copy;
                }).ToArray();
                to[r].sharedMaterials = mats;
            }
            EditorUtility.SetDirty(local);
            return local;
        }

        static void Configure(VegetationPackagePro package, VegetationItemInfoPro item, Item spec, Palette palette, Texture2D texture, bool spawn)
        {
            if (spec.prefab == null)
            {
                item.VegetationTexture = texture;
                item.VegetationGuid = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(texture));
                item.VegetationType = VegetationType.Grass;
                item.Rotation = VegetationRotationType.FollowTerrainScale;
            }
            else
            {
                item.VegetationType = VegetationType.Plant;   // drawn to the system's plant distance, like the grass
                item.Rotation = VegetationRotationType.RotateY;   // bushes grow upright, not along the slope
                item.ColliderType = ColliderType.Disabled;
            }
            GolfMapVspRig.KeepOffOuter(item);
            item.SampleDistance = spec.sampleDistance;
            item.Density = spec.density;
            item.RandomizePosition = true;
            item.ScaleMultiplier = new Vector3(spec.width, spec.height, spec.width);
            item.MinScale = spec.minScale;
            item.MaxScale = spec.maxScale;
            item.Offset = new Vector3(0, spec.verticalOffset, 0);
            item.UseNoiseCutoff = spec.noiseCutoff > 0;
            item.NoiseCutoffValue = spec.noiseCutoff;
            item.NoiseCutoffScale = spec.noiseCutoffScale;
            item.NoiseCutoffInverse = false;
            item.NoiseCutoffOffset = Vector2.zero;
            item.UseNoiseDensity = spec.noiseDensityScale > 0;
            item.NoiseDensityScale = spec.noiseDensityScale;
            item.UseNoiseScaleRule = spec.noiseScaleScale > 0;
            item.NoiseScaleMinScale = spec.noiseScaleMin;
            item.NoiseScaleMaxScale = spec.noiseScaleMax;
            item.NoiseScaleScale = spec.noiseScaleScale;
            item.UseHeightRule = false;
            item.UseSteepnessRule = true;
            item.MinSteepness = 0;
            item.MaxSteepness = spec.maxSteepness;
            item.DisableShadows = !spec.shadows;
            item.LODFactor = spec.lodFactor;
            item.UseDistanceFalloff = palette.distanceFalloff > 0;
            item.DistanceFalloffStartDistance = Mathf.Clamp01(palette.distanceFalloff);
            if (spec.prefab == null)
            {
                SetProperty(item, "TintColor1", p => p.ColorValue = spec.dry);
                SetProperty(item, "TintColor2", p => p.ColorValue = spec.healthy);
                SetProperty(item, "TintAreaScale", p => p.FloatValue = palette.tintAreaScale);
                SetProperty(item, "RandomDarkening", p => p.FloatValue = spec.randomDarkening);
                SetProperty(item, "RootAmbient", p => p.FloatValue = spec.rootAmbient);
                SetProperty(item, "AlphaCutoff", p => p.FloatValue = spec.alphaCutoff);
            }
            else if (spec.tinted)
            {
                // VSP's NM tree controller ("HealtyColor", sic), or its NM Advanced Grass one (bilberry, heather, ferns).
                bool grass = !HasControllerProperty(item, "HealtyColor") && HasControllerProperty(item, "HealthyColorTint");
                SetProperty(item, grass ? "HealthyColorTint" : "HealtyColor", p => p.ColorValue = spec.healthy);
                SetProperty(item, grass ? "DryColorTint" : "DryColor", p => p.ColorValue = spec.dry);
            }
            // Only where a zone mask includes it; see the header. An include rule on a group the
            // package no longer has (or none, with include rules on) lets VSP spawn nowhere.
            item.EnableRuntimeSpawn = spawn && GolfMapZoneImporter.HasLiveIncludeRule(package, item);
        }

        [BridgeCommand("golfmap.grass.apply", "Build a grass palette from <course>/grass-palette.json into VSP: greyscale textures, the lower-vegetation package on the terrain's system, texture grass items with tints, scale and spacing. Items spawn only once the zone import gave them an include rule. With \"prefabItems\": \"arborist\" in the file, prefab items (bushes, ground plants) are left out and removed from the package: they come from Arborist.",
            args = "palette (zone type key; default all), terrain=inner|outer (default inner), rebuildTextures=false, spawn=true (false hides the palette's items, e.g. to compare against the bare ground)")]
        static object Apply(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            // Before any asset work: an asset copy or import can leave `course` a stale reference
            // with no asset path (see GolfMapTerrainSculpt).
            var courseFolder = GolfMapCourses.Folder(course);
            var role = a.String("terrain", "inner");
            if (role != "inner" && role != "outer") throw new BridgeError("terrain must be inner or outer.");
            var palettes = Load(course);
            var key = a.String("palette");
            if (key != null) palettes = palettes.Where(p => p.key == key).ToList();
            if (palettes.Count == 0) throw new BridgeError("No palette '" + key + "' in " + PalettePath(course) + ".");

            var terrain = TerrainFor(course, role);
            var system = SystemFor(terrain);
            var log = new List<string>();
            var items = new List<object>();
            foreach (var palette in palettes)
            {
                var package = EnsurePackage(courseFolder, system, palette.package, role, log);
                if (GolfMapTreePlanter.IsImportedCatalogue(package)) throw new BridgeError("Palette package '" + palette.package + "' is the planter's tree catalogue.");
                foreach (var spec in palette.items)
                {
                    if (palette.ArboristDraws(spec))
                    {
                        int removed = package.VegetationInfoList.RemoveAll(i => i != null && (i.Name == spec.name || i.Name == GolfMapZones.TwinName(spec.name)));
                        if (removed > 0) log.Add("removed '" + spec.name + "' (" + removed + " item(s)): prefab items are Arborist's");
                        continue;
                    }
                    var texture = spec.prefab == null ? GreyTexture(courseFolder, spec, a.Bool("rebuildTextures", false), log) : null;
                    var prefab = spec.prefab != null ? LoadPrefab(spec) : null;
                    if (prefab != null && spec.material.Count > 0) prefab = LocalPrefab(courseFolder, spec, prefab, log);
                    var item = package.VegetationInfoList.FirstOrDefault(i => i.Name == spec.name);
                    // VSP builds the item's model from the prefab it was added with: a new prefab
                    // replaces the item (its mask rules go with it until the next zones import).
                    if (item != null && prefab != null && item.VegetationPrefab != prefab)
                    {
                        package.VegetationInfoList.Remove(item);
                        item = null;
                        log.Add("replaced item '" + spec.name + "' (new prefab): re-run golfmap.zones.import, then apply");
                    }
                    if (item == null)
                    {
                        if (prefab != null) package.AddVegetationItem(prefab, VegetationType.Plant, false);
                        else package.AddVegetationItem(texture, VegetationType.Grass, false);
                        item = package.VegetationInfoList.Last();
                        item.Name = spec.name;
                        log.Add("added item '" + spec.name + "'");
                    }
                    Configure(package, item, spec, palette, texture, a.Bool("spawn", true));
                    if (prefab != null) GolfMapZoneImporter.RefreshTwin(package, item, log);   // its height-driven twin, if a zone import made one
                    items.Add(new Dictionary<string, object>
                    {
                        { "palette", palette.key }, { "item", item.Name }, { "id", item.VegetationItemID },
                        { "texture", texture ? AssetDatabase.GetAssetPath(texture) : AssetDatabase.GetAssetPath(prefab) }, { "spawning", item.EnableRuntimeSpawn },
                        { "includeRules", item.TextureMaskIncludeRuleList.Count }, { "densityRules", item.TextureMaskDensityRuleList.Count },
                    });
                }
                EditorUtility.SetDirty(package);
            }
            float plantDistance = palettes.Max(p => p.plantDistance);
            if (plantDistance > 0 && !Mathf.Approximately(system.VegetationSettings.PlantDistance, plantDistance))
            {
                log.Add("plant distance " + system.VegetationSettings.PlantDistance + " -> " + plantDistance + " m on " + system.name);
                system.VegetationSettings.PlantDistance = plantDistance;
            }
            system.RefreshVegetationSystem();
            system.ClearCache();
            EditorUtility.SetDirty(system);
            EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
            AssetDatabase.SaveAssets();
            SceneView.RepaintAll();
            return new Dictionary<string, object>
            {
                { "terrain", terrain.name }, { "system", system.name }, { "plantDistance", system.VegetationSettings.PlantDistance },
                { "log", log }, { "items", items },
            };
        }

        [BridgeCommand("golfmap.grass.refresh", "Refresh the VSP system of a terrain (rebuild items and respawn), e.g. after editing items by hand.", args = "terrain=inner|outer")]
        static object Refresh(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var terrain = TerrainFor(course, a.String("terrain", "inner"));
            var system = SystemFor(terrain);
            system.RefreshVegetationSystem();
            system.ClearCache();
            SceneView.RepaintAll();
            return new Dictionary<string, object> { { "system", system.name }, { "terrain", terrain.name } };
        }
    }
}
