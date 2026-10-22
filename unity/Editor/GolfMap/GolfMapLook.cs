// The course's look as data: <course>/look.json (golfmap-look-v1) holds the ambient light, the
// sun's shadow strength and the few post-processing values that set the mood, and
// golfmap.look.apply writes them into the open scene. The post-processing profile is copied into
// the course folder first (<course>/Look/<name>.asset) and the scene's volume pointed at the
// copy, so OPCD's shared profiles stay as shipped. Values were found live in GSPro
// (unity/ArboristMod: `set` on RenderSettings and the volume's profile) against the reference
// courses in docs/gspro/reference-courses.md.
// GSPro does not read the scene's profile when the course folder holds an arborist_postprocess.dat
// (written by Arborist's save and by Tools > Arborist Postprocessing): it builds the volume's
// profile from that file (seen 2026-10-13: Vreta ran saturation -0.7 from the .dat while the built
// scene's profile said -18). After a change under "post", export that file again from the profile
// or remove it. Ambient, the sun and the fog come from the scene and need only the build.
// Not in unity/check-planter.ps1's list: it needs the project's post-processing assembly.
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.PostProcessing;
using UnityEngine.SceneManagement;

namespace GolfMap.Editor
{
    static class GolfMapLook
    {
        const string Format = "golfmap-look-v1";

        static Color Colour(GolfMapJsonObject o, string key, Color fallback)
        {
            Color c;
            var text = o.String(key);
            return text != null && ColorUtility.TryParseHtmlString(text, out c) ? c : fallback;
        }

        // OPCD's fog object (GradientFogGO on "GradientFog"), found by type name so this file does
        // not depend on OPCD's assembly. Its OnValidate copies the three fields into the fog material.
        static MonoBehaviour Fog()
        {
            return Object.FindObjectsOfType<MonoBehaviour>().FirstOrDefault(m => m && m.GetType().Name == "GradientFogGO");
        }

        static object FogValue(MonoBehaviour fog, string field)
        {
            var f = fog.GetType().GetField(field, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            return f != null ? f.GetValue(fog) : null;
        }

        static void FogSet(SerializedObject so, GolfMapJsonObject o, string key, string field)
        {
            var p = so.FindProperty(field);
            if (o.Has(key) && p != null && p.propertyType == SerializedPropertyType.Float) p.floatValue = (float)o.Number(key, p.floatValue);
        }

        // The course folder's look folder as it is spelled on disk ("look" or "Look"): AssetDatabase paths
        // are case-sensitive while the file system is not, so a second spelling would copy nothing.
        static string LookDir(string folder)
        {
            string root = folder.TrimEnd('/');
            var found = AssetDatabase.GetSubFolders(root).FirstOrDefault(d => string.Equals(Path.GetFileName(d), "Look", System.StringComparison.OrdinalIgnoreCase));
            if (found != null) return found;
            AssetDatabase.CreateFolder(root, "Look");
            return root + "/Look";
        }

        static bool Under(string assetPath, string dir)
        {
            return assetPath.StartsWith(dir + "/", System.StringComparison.OrdinalIgnoreCase);
        }

        // [x, y, z, w] -> a colour grading trackball (lift / gamma / gain)
        static Vector4 Ball(GolfMapJsonObject o, string key, Vector4 fallback)
        {
            var a = o.Array(key);
            if (a == null || a.Count != 4) return fallback;
            var n = a.Select(v => v as GolfMapJsonNumber).ToArray();
            return n.Any(v => v == null) ? fallback : new Vector4((float)n[0].Value, (float)n[1].Value, (float)n[2].Value, (float)n[3].Value);
        }

        static float[] Ball(Vector4 v) { return new[] { v.x, v.y, v.z, v.w }; }

        [BridgeCommand("golfmap.look.apply", "Write <course>/look.json (golfmap-look-v1) into the open scene: trilight ambient colours, the sun's shadow strength / intensity / direction and TimeAdjust clock, the skybox (a project material by name, on a course-local copy) with its exposure and the reflection intensity, OPCD's gradient fog (start / end / intensity), and on a course-local copy of the scene's post-processing profile the colour grading saturation / post exposure / temperature / contrast / lift / gamma / gain (trackballs as [x, y, z, w]) / lift offset, the ambient occlusion colour / intensity and the bloom threshold / intensity / colour. Keys left out are left alone. GSPro takes the post-processing from the course folder's arborist_postprocess.dat when there is one: export it again after a change under post. Without a look.json: reports the scene's current values. Marks the scene dirty; a course build saves it.",
            args = "dryRun=false")]
        internal static object Apply(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            string folder = GolfMapCourses.Folder(course), path = folder + "look.json";
            var scene = SceneManager.GetActiveScene();
            var volume = Object.FindObjectsOfType<PostProcessVolume>().FirstOrDefault(v => v.isGlobal && v.sharedProfile);
            var sun = RenderSettings.sun;
            var log = new List<string>();
            if (File.Exists(path) && !a.Bool("dryRun", false))
            {
                var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
                if (doc.String("format") != Format) throw new BridgeError(path + " is not " + Format + ".");
                var ambient = doc.Object("ambient");
                if (ambient != null)
                {
                    RenderSettings.ambientMode = AmbientMode.Trilight;
                    RenderSettings.ambientSkyColor = Colour(ambient, "sky", RenderSettings.ambientSkyColor);
                    RenderSettings.ambientEquatorColor = Colour(ambient, "equator", RenderSettings.ambientEquatorColor);
                    RenderSettings.ambientGroundColor = Colour(ambient, "ground", RenderSettings.ambientGroundColor);
                    log.Add("ambient set");
                }
                var sunDoc = doc.Object("sun");
                if (sunDoc != null && sun)
                {
                    Undo.RecordObject(sun, "GolfMap look");
                    sun.shadowStrength = (float)sunDoc.Number("shadowStrength", sun.shadowStrength);
                    sun.intensity = (float)sunDoc.Number("intensity", sun.intensity);
                    // "hh:mm" on OPCD's TimeAdjust: what its Hour/minutes say when someone turns it back on
                    var clockText = sunDoc.String("clock");
                    if (clockText != null)
                    {
                        var parts = clockText.Split(':');
                        int hour, minutes;
                        if (parts.Length != 2 || !int.TryParse(parts[0], out hour) || !int.TryParse(parts[1], out minutes)) throw new BridgeError("sun.clock wants \"hh:mm\", got " + clockText + ".");
                        foreach (var clock in sun.GetComponents<Behaviour>().Where(c => c && c.GetType().Name == "TimeAdjust"))
                        {
                            var so = new SerializedObject(clock);
                            var h = so.FindProperty("Hour");
                            var m = so.FindProperty("minutes");
                            if (h != null) h.intValue = hour;
                            if (m != null) m.intValue = minutes;
                            so.ApplyModifiedProperties();
                        }
                    }
                    // elevation = degrees over the horizon, azimuth = the compass bearing the sun stands at (z is north)
                    if (sunDoc.Has("elevation") && sunDoc.Has("azimuth"))
                    {
                        // OPCD's TimeAdjust on the light turns it to its own Hour/minutes in the editor every update
                        // (the script is not in GSPro, which keeps what the scene saved): off, or the direction is lost
                        foreach (var clock in sun.GetComponents<Behaviour>().Where(c => c && c.GetType().Name == "TimeAdjust" && c.enabled))
                        {
                            Undo.RecordObject(clock, "GolfMap look");
                            clock.enabled = false;
                            log.Add("TimeAdjust on the sun switched off (it overrides the direction)");
                        }
                        Undo.RecordObject(sun.transform, "GolfMap look");
                        sun.transform.rotation = Quaternion.Euler((float)sunDoc.Number("elevation", 45), (float)sunDoc.Number("azimuth", 180) + 180f, 0);
                    }
                    log.Add("sun set");
                }
                var sky = doc.Object("sky");
                if (sky != null && sky.String("material") != null)
                {
                    // a skybox of the project by name (OPCD's Assets/Skyboxes/Material/<name>.mat), never a course's copy
                    string name = sky.String("material");
                    var source = AssetDatabase.FindAssets(name + " t:Material").Select(AssetDatabase.GUIDToAssetPath)
                        .Where(p => Path.GetFileNameWithoutExtension(p) == name && !p.StartsWith("Assets/GolfMap/")).OrderBy(p => p.Length).FirstOrDefault();
                    if (source == null) throw new BridgeError("sky.material: no material called " + name + " outside Assets/GolfMap.");
                    if (!RenderSettings.skybox || RenderSettings.skybox.name != name)
                    {
                        RenderSettings.skybox = AssetDatabase.LoadAssetAtPath<Material>(source);
                        log.Add("skybox " + source);
                    }
                }
                if (sky != null && sky.Has("reflectionIntensity"))
                {
                    RenderSettings.reflectionIntensity = (float)sky.Number("reflectionIntensity", RenderSettings.reflectionIntensity);
                    log.Add("reflection intensity set");
                }
                if (sky != null && RenderSettings.skybox && RenderSettings.skybox.HasProperty("_Exposure"))
                {
                    // on a course-local copy: the skybox material is shared with other course projects' scenes
                    string dir = LookDir(folder), copy = dir + "/" + RenderSettings.skybox.name + ".mat";
                    if (!Under(AssetDatabase.GetAssetPath(RenderSettings.skybox), dir))
                    {
                        if (!File.Exists(copy) && !AssetDatabase.CopyAsset(AssetDatabase.GetAssetPath(RenderSettings.skybox), copy)) throw new BridgeError("Could not copy the skybox to " + copy + ".");
                        RenderSettings.skybox = AssetDatabase.LoadAssetAtPath<Material>(copy);
                        log.Add("skybox now " + copy);
                    }
                    RenderSettings.skybox.SetFloat("_Exposure", (float)sky.Number("exposure", RenderSettings.skybox.GetFloat("_Exposure")));
                    EditorUtility.SetDirty(RenderSettings.skybox);
                    log.Add("sky set");
                }
                var fogDoc = doc.Object("fog");
                if (fogDoc != null)
                {
                    var fog = Fog();
                    if (fog)
                    {
                        var so = new SerializedObject(fog);
                        FogSet(so, fogDoc, "start", "fogStart");
                        FogSet(so, fogDoc, "end", "fogEnd");
                        FogSet(so, fogDoc, "intensity", "fogIntensity");
                        so.ApplyModifiedProperties();
                        var validate = fog.GetType().GetMethod("OnValidate", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                        if (validate != null) validate.Invoke(fog, null);
                        EditorUtility.SetDirty(fog);
                        log.Add("fog set");
                    }
                    else log.Add("fog: no GradientFogGO in the scene, left alone");
                }
                var post = doc.Object("post");
                if (post != null && volume)
                {
                    string dir = LookDir(folder);
                    var profile = volume.sharedProfile;
                    // The course's own profile, when its Look folder has one (unity:new-project --look-from puts a
                    // tuned course's there): the scene's template profile has other effects and settings than look.json sets.
                    var own = AssetDatabase.FindAssets("t:PostProcessProfile", new[] { dir })
                        .Select(guid => AssetDatabase.LoadAssetAtPath<PostProcessProfile>(AssetDatabase.GUIDToAssetPath(guid)))
                        .FirstOrDefault(p => p != null);
                    if (own != null && own != profile)
                    {
                        Undo.RecordObject(volume, "GolfMap look");
                        volume.sharedProfile = own;
                        profile = own;
                        log.Add("volume now uses the course's profile " + AssetDatabase.GetAssetPath(own));
                    }
                    if (!Under(AssetDatabase.GetAssetPath(profile), dir))
                    {
                        string copy = dir + "/" + profile.name + ".asset";
                        if (!File.Exists(copy) && !AssetDatabase.CopyAsset(AssetDatabase.GetAssetPath(profile), copy)) throw new BridgeError("Could not copy the profile to " + copy + ".");
                        profile = AssetDatabase.LoadAssetAtPath<PostProcessProfile>(copy);
                        Undo.RecordObject(volume, "GolfMap look");
                        volume.sharedProfile = profile;
                        log.Add("volume now uses " + copy);
                    }
                    ColorGrading grading; AmbientOcclusion occlusion; Bloom bloom;
                    if (profile.TryGetSettings(out grading))
                    {
                        if (post.Has("saturation")) grading.saturation.Override((float)post.Number("saturation", 0));
                        if (post.Has("postExposure")) grading.postExposure.Override((float)post.Number("postExposure", 0));
                        if (post.Has("temperature")) grading.temperature.Override((float)post.Number("temperature", 0));
                        if (post.Has("contrast")) grading.contrast.Override((float)post.Number("contrast", 0));
                        if (post.Has("lift")) grading.lift.Override(Ball(post, "lift", grading.lift.value));
                        if (post.Has("gamma")) grading.gamma.Override(Ball(post, "gamma", grading.gamma.value));
                        if (post.Has("gain")) grading.gain.Override(Ball(post, "gain", grading.gain.value));
                        // The lift trackball's offset (w) alone: -0.2 crushes the forest floor to black, -0.03 keeps it.
                        if (post.Has("liftW")) { var lift = grading.lift.value; lift.w = (float)post.Number("liftW", lift.w); grading.lift.Override(lift); }
                        EditorUtility.SetDirty(grading);
                    }
                    if (profile.TryGetSettings(out occlusion))
                    {
                        if (post.Has("aoColor")) occlusion.color.Override(Colour(post, "aoColor", occlusion.color.value));
                        if (post.Has("aoIntensity")) occlusion.intensity.Override((float)post.Number("aoIntensity", 0));
                        EditorUtility.SetDirty(occlusion);
                    }
                    var bloomDoc = post.Object("bloom");
                    if (bloomDoc != null && profile.TryGetSettings(out bloom))
                    {
                        if (bloomDoc.Has("threshold")) bloom.threshold.Override((float)bloomDoc.Number("threshold", 0));
                        if (bloomDoc.Has("intensity")) bloom.intensity.Override((float)bloomDoc.Number("intensity", 0));
                        if (bloomDoc.Has("color")) bloom.color.Override(Colour(bloomDoc, "color", bloom.color.value));
                        EditorUtility.SetDirty(bloom);
                    }
                    EditorUtility.SetDirty(profile);
                    AssetDatabase.SaveAssets();
                    log.Add("post-processing set (GSPro reads arborist_postprocess.dat instead when the course folder has one: export it again)");
                }
                EditorSceneManager.MarkSceneDirty(scene);
            }
            ColorGrading g = null; AmbientOcclusion ao = null; Bloom b = null;
            if (volume) { volume.sharedProfile.TryGetSettings(out g); volume.sharedProfile.TryGetSettings(out ao); volume.sharedProfile.TryGetSettings(out b); }
            var fogNow = Fog();
            return new Dictionary<string, object>
            {
                { "file", File.Exists(path) ? path : "(none)" }, { "log", log },
                { "ambient", new Dictionary<string, object> { { "sky", "#" + ColorUtility.ToHtmlStringRGB(RenderSettings.ambientSkyColor) }, { "equator", "#" + ColorUtility.ToHtmlStringRGB(RenderSettings.ambientEquatorColor) }, { "ground", "#" + ColorUtility.ToHtmlStringRGB(RenderSettings.ambientGroundColor) } } },
                { "sun", sun ? (object)new Dictionary<string, object> { { "shadowStrength", sun.shadowStrength }, { "intensity", sun.intensity }, { "euler", new[] { sun.transform.eulerAngles.x, sun.transform.eulerAngles.y, sun.transform.eulerAngles.z } } } : null },
                { "sky", new Dictionary<string, object> { { "material", RenderSettings.skybox ? AssetDatabase.GetAssetPath(RenderSettings.skybox) : null }, { "exposure", RenderSettings.skybox && RenderSettings.skybox.HasProperty("_Exposure") ? (object)RenderSettings.skybox.GetFloat("_Exposure") : null }, { "reflectionIntensity", RenderSettings.reflectionIntensity } } },
                { "profile", volume ? AssetDatabase.GetAssetPath(volume.sharedProfile) : "(no global volume)" },
                { "post", g ? (object)new Dictionary<string, object> { { "saturation", g.saturation.value }, { "postExposure", g.postExposure.value }, { "temperature", g.temperature.value }, { "aoColor", ao ? "#" + ColorUtility.ToHtmlStringRGB(ao.color.value) : null }, { "aoIntensity", ao ? (object)ao.intensity.value : null }, { "liftW", g.lift.value.w }, { "contrast", g.contrast.value }, { "lift", Ball(g.lift.value) }, { "gamma", Ball(g.gamma.value) }, { "gain", Ball(g.gain.value) } } : null },
                { "bloom", b ? (object)new Dictionary<string, object> { { "threshold", b.threshold.value }, { "intensity", b.intensity.value }, { "color", "#" + ColorUtility.ToHtmlStringRGB(b.color.value) } } : null },
                { "fog", fogNow ? (object)new Dictionary<string, object> { { "start", FogValue(fogNow, "fogStart") }, { "end", FogValue(fogNow, "fogEnd") }, { "intensity", FogValue(fogNow, "fogIntensity") } } : null },
            };
        }
    }
}
