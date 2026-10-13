// How a loaded course is made to look: per scene its render settings (fog, ambient, skybox),
// the lights, the cameras with what sits on them, the effect components (post-processing, fog,
// sky, weather) with their values, the Vegetation Studio Pro settings item by item, and which
// shaders the scene draws with. Read-only.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using AwesomeTechnologies.VegetationSystem;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Bridge
{
    static class LookCommands
    {
        const string EffectTypes = "PostProcess|Fog|Bloom|Tonemap|ColorGrad|ColorCorrect|Enviro|Sky|Atmospher|Ambient|SSAO|Occlusion|Amplify|Beautify|Aura|Volumetric|Weather|Override|SunShaft|GodRay|Cloud|Vignette|Antialias|Reflection|Wind|Water|Ocean";

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return "/" + string.Join("/", parts.ToArray());
        }

        static List<object> Floats(params float[] v) { return v.Select(f => (object)Math.Round(f, 4)).ToList(); }
        static object ColorOf(Color c) { return Floats(c.r, c.g, c.b, c.a); }

        static object MaterialOf(Material m, string[] floats, string[] colors)
        {
            if (!m) return null;
            var d = new Dictionary<string, object> { { "name", m.name }, { "shader", m.shader ? m.shader.name : null } };
            foreach (var f in floats) if (m.HasProperty(f)) d[f] = Math.Round(m.GetFloat(f), 4);
            foreach (var c in colors) if (m.HasProperty(c)) d[c] = ColorOf(m.GetColor(c));
            if (m.shaderKeywords.Length > 0) d["keywords"] = string.Join(" ", m.shaderKeywords);
            return d;
        }

        // Any value as plain JSON: numbers, names of Unity objects, and the fields of plain classes
        // and of ScriptableObjects (a post-processing profile) down to `depth`.
        static object Dump(object o, int depth)
        {
            if (o == null) return null;
            if (o is string || o is bool || o is int || o is double) return o;
            if (o is float) return Math.Round((float)o, 5);
            var type = o.GetType();
            if (type.IsEnum) return o.ToString();
            if (type.IsPrimitive) return Convert.ToDouble(o);
            if (o is Color) return ColorOf((Color)o);
            if (o is Color32) return ColorOf((Color32)o);
            if (o is Vector2) { var v = (Vector2)o; return Floats(v.x, v.y); }
            if (o is Vector3) { var v = (Vector3)o; return Floats(v.x, v.y, v.z); }
            if (o is Vector4) { var v = (Vector4)o; return Floats(v.x, v.y, v.z, v.w); }
            if (o is Quaternion) { var v = ((Quaternion)o).eulerAngles; return Floats(v.x, v.y, v.z); }
            if (o is LayerMask) return ((LayerMask)o).value;
            if (o is AnimationCurve) return ((AnimationCurve)o).keys.Take(12).Select(k => (object)Floats(k.time, k.value)).ToList();
            if (o is Gradient) return ((Gradient)o).colorKeys.Select(k => (object)new List<object> { Math.Round(k.time, 3), ColorOf(k.color) }).ToList();
            var unityObject = o as UnityEngine.Object;
            if (!ReferenceEquals(unityObject, null))
            {
                if (!unityObject) return null;
                if (o is Material && depth > 0) return MaterialOf((Material)o, new string[0], new string[0]);
                if (!(o is ScriptableObject) || depth <= 0) return "<" + type.Name + " " + unityObject.name + ">";
            }
            else if (o is IDictionary) return "{" + ((IDictionary)o).Count + " entries}";
            else if (o is IEnumerable)
            {
                var items = ((IEnumerable)o).Cast<object>().ToList();
                if (depth <= 0 || items.Count > 64) return "[" + items.Count + " items]";
                return items.Select(i => Dump(i, depth - 1)).ToList();
            }
            if (depth <= 0) return "{" + type.Name + "}";
            return Fields(o, depth);
        }

        // The serialized fields of an object, whatever it is (a component included).
        static object Fields(object o, int depth)
        {
            var type = o.GetType();
            var unityObject = o as UnityEngine.Object;
            if (typeof(Delegate).IsAssignableFrom(type) || type.IsPointer || type == typeof(IntPtr) || type.Namespace == "Unity.Collections") return null;
            var d = new Dictionary<string, object>();
            if (o is ScriptableObject) d["$type"] = type.Name + " " + unityObject.name;
            for (var t = type; t != null && t != typeof(object) && t != typeof(MonoBehaviour) && t != typeof(ScriptableObject) && t != typeof(Behaviour) && t != typeof(Component); t = t.BaseType)
                foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (!f.IsPublic && !f.IsDefined(typeof(SerializeField), false)) continue;
                    if (f.IsDefined(typeof(NonSerializedAttribute), false) || d.ContainsKey(f.Name)) continue;
                    try { d[f.Name] = Dump(f.GetValue(o), depth - 1); }
                    catch (Exception e) { d[f.Name] = "(" + e.GetType().Name + ")"; }
                }
            return d;
        }

        static Dictionary<string, object> RenderSettingsOf(Scene scene)
        {
            var before = SceneManager.GetActiveScene();
            if (scene != before) SceneManager.SetActiveScene(scene);
            try
            {
                return new Dictionary<string, object>
                {
                    { "fog", RenderSettings.fog }, { "fogMode", RenderSettings.fogMode.ToString() }, { "fogColor", ColorOf(RenderSettings.fogColor) },
                    { "fogDensity", RenderSettings.fogDensity }, { "fogStart", RenderSettings.fogStartDistance }, { "fogEnd", RenderSettings.fogEndDistance },
                    { "ambientMode", RenderSettings.ambientMode.ToString() }, { "ambientIntensity", RenderSettings.ambientIntensity },
                    { "ambientLight", ColorOf(RenderSettings.ambientLight) }, { "ambientSky", ColorOf(RenderSettings.ambientSkyColor) },
                    { "ambientEquator", ColorOf(RenderSettings.ambientEquatorColor) }, { "ambientGround", ColorOf(RenderSettings.ambientGroundColor) },
                    { "reflectionMode", RenderSettings.defaultReflectionMode.ToString() }, { "reflectionIntensity", RenderSettings.reflectionIntensity },
                    { "reflectionBounces", RenderSettings.reflectionBounces }, { "reflectionResolution", RenderSettings.defaultReflectionResolution },
                    { "customReflection", RenderSettings.customReflection ? RenderSettings.customReflection.name : null },
                    { "subtractiveShadowColor", ColorOf(RenderSettings.subtractiveShadowColor) },
                    { "haloStrength", RenderSettings.haloStrength }, { "flareStrength", RenderSettings.flareStrength },
                    { "sun", RenderSettings.sun ? PathOf(RenderSettings.sun.transform) : null },
                    { "skybox", MaterialOf(RenderSettings.skybox,
                        new[] { "_Exposure", "_Rotation", "_AtmosphereThickness", "_SunSize", "_SunSizeConvergence", "_Blend" },
                        new[] { "_Tint", "_SkyTint", "_GroundColor", "_Color" }) },
                };
            }
            finally { if (scene != before) SceneManager.SetActiveScene(before); }
        }

        static object LightOf(Light l)
        {
            return new Dictionary<string, object>
            {
                { "path", PathOf(l.transform) }, { "scene", l.gameObject.scene.name }, { "active", l.isActiveAndEnabled }, { "type", l.type.ToString() },
                { "color", ColorOf(l.color) }, { "intensity", l.intensity }, { "bounceIntensity", l.bounceIntensity }, { "colorTemperature", l.colorTemperature },
                { "rotation", Dump(l.transform.rotation, 0) }, { "range", l.range },
                { "shadows", l.shadows.ToString() }, { "shadowStrength", l.shadowStrength }, { "shadowBias", l.shadowBias }, { "shadowNormalBias", l.shadowNormalBias },
                { "shadowResolution", l.shadowResolution.ToString() }, { "renderMode", l.renderMode.ToString() }, { "cullingMask", l.cullingMask },
                { "bakeType", l.bakingOutput.lightmapBakeType.ToString() }, { "cookie", l.cookie ? l.cookie.name : null }, { "flare", l.flare ? l.flare.name : null },
            };
        }

        static object ItemOf(VegetationItemInfoPro i, int stored)
        {
            var d = (Dictionary<string, object>)Dump(i, 4);
            d["stored"] = stored;
            var prefab = i.VegetationPrefab;
            if (prefab)
            {
                var lods = prefab.GetComponentInChildren<LODGroup>();
                d["prefabLods"] = lods ? lods.lodCount : 0;
                d["prefabMaterials"] = prefab.GetComponentsInChildren<Renderer>(true).SelectMany(r => r.sharedMaterials).Where(m => m).Distinct()
                    .Select(m => MaterialOf(m,
                        new[] { "_Cutoff", "_Glossiness", "_Smoothness", "_Metallic", "_HueVariationKwToggle", "_TranslucencyStrength", "_OcclusionStrength", "_BumpScale", "_WindQuality", "_Cull" },
                        new[] { "_Color", "_HueVariation", "_HueVariationColor", "_TranslucencyColor", "_SubsurfaceColor" })).ToList();
            }
            return d;
        }

        [BridgeCommand("look", "How the loaded course is made to look, read-only: per scene the render settings (fog, ambient, reflection, skybox material), every light, every camera with its components, the effect components (post-processing, fog, sky, weather; a component whose script the app lacks shows as missing) with their fields, Vegetation Studio Pro's settings and every item's own, and the shaders the renderers use with how many renderers each.",
            args = "scene (part of a scene name; default every loaded scene), veg=true, effects=<regex on the component type name, default the usual effect names>, depth=5")]
        static object Look(BridgeArgs a)
        {
            string wanted = a.String("scene");
            int depth = a.Int("depth", 5);
            var effect = new Regex(a.String("effects") ?? EffectTypes, RegexOptions.IgnoreCase);
            Func<Scene, bool> inScope = s => s.IsValid() && (wanted == null || s.name.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0);

            var scenes = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var s = SceneManager.GetSceneAt(i);
                if (!s.isLoaded || !inScope(s)) continue;
                scenes.Add(new Dictionary<string, object> { { "name", s.name }, { "active", s == SceneManager.GetActiveScene() }, { "render", RenderSettingsOf(s) } });
            }

            var cameras = new List<object>();
            foreach (var c in Resources.FindObjectsOfTypeAll<Camera>().Where(c => inScope(c.gameObject.scene)))
                cameras.Add(new Dictionary<string, object>
                {
                    { "path", PathOf(c.transform) }, { "scene", c.gameObject.scene.name }, { "active", c.isActiveAndEnabled }, { "fov", c.fieldOfView },
                    { "near", c.nearClipPlane }, { "far", c.farClipPlane }, { "hdr", c.allowHDR }, { "msaa", c.allowMSAA }, { "renderingPath", c.actualRenderingPath.ToString() },
                    { "clearFlags", c.clearFlags.ToString() }, { "background", ColorOf(c.backgroundColor) },
                    { "components", c.GetComponents<Component>().Select(k => (object)(k ? k.GetType().FullName + ((k is Behaviour) && !((Behaviour)k).enabled ? " (off)" : "") : "(missing script)")).ToList() },
                });

            var effects = new List<object>();
            var missing = new List<object>();
            var shaders = new Dictionary<string, int>();
            foreach (var t in Resources.FindObjectsOfTypeAll<Transform>().Where(t => inScope(t.gameObject.scene)))
            {
                foreach (var k in t.GetComponents<Component>())
                {
                    if (!k) { if (missing.Count < 200) missing.Add(PathOf(t)); continue; }
                    var renderer = k as Renderer;
                    if (renderer)
                        foreach (var m in renderer.sharedMaterials.Where(m => m && m.shader))
                        {
                            int n; shaders.TryGetValue(m.shader.name, out n);
                            shaders[m.shader.name] = n + 1;
                        }
                    if (!(k is MonoBehaviour) && !(k is ReflectionProbe) && !(k is WindZone)) continue;
                    var type = k.GetType();
                    if (!effect.IsMatch(type.FullName) || type.FullName.StartsWith("AwesomeTechnologies.Vegetation")) continue;
                    var behaviour = k as Behaviour;
                    var row = new Dictionary<string, object>
                    {
                        { "path", PathOf(t) }, { "scene", t.gameObject.scene.name }, { "type", type.FullName },
                        { "active", behaviour ? behaviour.isActiveAndEnabled : t.gameObject.activeInHierarchy },
                    };
                    if (k is ReflectionProbe)
                    {
                        var p = (ReflectionProbe)k;
                        row["probe"] = new Dictionary<string, object> { { "mode", p.mode.ToString() }, { "intensity", p.intensity }, { "size", Dump(p.size, 0) }, { "resolution", p.resolution }, { "hdr", p.hdr }, { "boxProjection", p.boxProjection } };
                    }
                    else if (k is WindZone)
                    {
                        var w = (WindZone)k;
                        row["wind"] = new Dictionary<string, object> { { "mode", w.mode.ToString() }, { "main", w.windMain }, { "turbulence", w.windTurbulence }, { "pulseMagnitude", w.windPulseMagnitude }, { "pulseFrequency", w.windPulseFrequency } };
                    }
                    else row["fields"] = Fields(k, depth);
                    effects.Add(row);
                }
            }

            var result = new Dictionary<string, object>
            {
                { "scenes", scenes }, { "lights", Resources.FindObjectsOfTypeAll<Light>().Where(l => inScope(l.gameObject.scene)).Select(LightOf).ToList() },
                { "cameras", cameras }, { "effects", effects }, { "missingScripts", missing },
                { "shaders", shaders.OrderByDescending(s => s.Value).Select(s => (object)new List<object> { s.Value, s.Key }).ToList() },
            };
            if (!a.Bool("veg", true)) return result;

            var systems = new List<object>();
            foreach (var s in Resources.FindObjectsOfTypeAll<VegetationSystemPro>().Where(s => s && inScope(s.gameObject.scene)))
            {
                var stored = new Dictionary<string, int>();
                var storage = s.PersistentVegetationStorage;
                if (storage && storage.PersistentVegetationStoragePackage)
                    foreach (var cell in storage.PersistentVegetationStoragePackage.PersistentVegetationCellList)
                        foreach (var info in cell.PersistentVegetationInfoList)
                        {
                            int n; stored.TryGetValue(info.VegetationItemID, out n);
                            stored[info.VegetationItemID] = n + info.VegetationItemList.Count;
                        }
                systems.Add(new Dictionary<string, object>
                {
                    { "path", PathOf(s.transform) }, { "scene", s.gameObject.scene.name }, { "active", s.isActiveAndEnabled },
                    { "settings", Dump(s.VegetationSettings, 2) }, { "renderSettings", Dump(s.VegetationRenderSettings, 2) },
                    { "environment", Dump(s.EnvironmentSettings, 2) },
                    { "cellSize", s.VegetationCellSize }, { "billboardCellSize", s.BillboardCellSize }, { "seaLevel", s.SeaLevel },
                    { "storedInstances", stored.Values.Sum() },
                    { "packages", s.VegetationPackageProList.Where(p => p).Select(p => (object)new Dictionary<string, object>
                        {
                            { "name", p.PackageName }, { "biome", p.BiomeType.ToString() },
                            { "items", p.VegetationInfoList.Select(i => { int n; stored.TryGetValue(i.VegetationItemID, out n); return ItemOf(i, n); }).ToList() },
                        }).ToList() },
                });
            }
            result["vegetation"] = systems;
            return result;
        }
    }
}
