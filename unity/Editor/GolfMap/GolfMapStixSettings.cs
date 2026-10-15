// Unity 2018.2 / C# 6. The course's StixGames 3D grass shader values: <course>/stix.json (golfmap-stix-v1),
// the values tuned by hand for look and frame time, so a rebuild does not lose them.
//
//   rough       set on the rough's material (NewRough) by golfmap.roughgrass.plant, before the bunker-lip
//               material is derived from it
//   wispy       set on <course>/Grass/<rough> Wispy.mat by golfmap.wispy.build, after it is derived from the rough
//   wispyFloor  set on <course>/Grass/<rough> Wispy Floor.mat by golfmap.wispy.build, likewise
//
// Each section maps shader float properties (_TargetDensity, _Softness00, _MinHeight00, ...) to values. A
// section that is missing, or a file that is missing, changes nothing. "before" and the other keys are notes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapStixSettings
    {
        public const string FileName = "stix.json";
        const string Format = "golfmap-stix-v1";

        public static string PathOf(GolfMapCourse course) { return GolfMapCourses.Folder(course) + FileName; }

        public static Dictionary<string, float> Floats(GolfMapCourse course, string section)
        {
            var result = new Dictionary<string, float>();
            var path = PathOf(course);
            if (!File.Exists(path)) return result;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            if (root.String("format") != Format) throw new InvalidOperationException(path + ": format must be " + Format + ".");
            var o = root.Object(section);
            if (o == null) return result;
            foreach (var key in o.keys)
            {
                if (!key.StartsWith("_", StringComparison.Ordinal)) continue;   // shader properties only
                var n = o[key] as GolfMapJsonNumber;
                if (n == null) throw new InvalidOperationException(path + " " + section + "." + key + ": not a number.");
                result[key] = (float)n.Value;
            }
            return result;
        }

        // For comparing frame times in the editor: the file's values (which=current) or its 'before' block on the
        // three materials now, without planting or deriving anything. End with which=current.
        [GolfMap.Bridge.BridgeCommand("golfmap.stix.apply", "Set <course>/stix.json's values on the Stix materials now: which=current (the rough, wispy and wispyFloor sections) or which=before (the 'before' block: the values until the hand tuning), for an A/B of the frame time at a view (golfmap.perf.report current=true). Nothing is planted or derived; end with which=current.",
            args = "which=current|before")]
        static object ApplyCommand(GolfMap.Bridge.BridgeArgs a)
        {
            var which = a.String("which", "current");
            if (which != "current" && which != "before") throw new InvalidOperationException("which is current or before.");
            var course = GolfMapCourses.Require();
            var rough = FindMaterial(GolfMapRoughGrass.DefaultMaterial);
            var targets = new Dictionary<string, Material>
            {
                { "rough", rough }, { "wispy", FindMaterial(rough.name + " Wispy") }, { "wispyFloor", FindMaterial(rough.name + " Wispy Floor") },
            };
            var result = new Dictionary<string, object> { { "which", which } };
            foreach (var t in targets)
            {
                if (t.Value == null) { result[t.Key] = "no material"; continue; }
                var values = which == "current" ? Floats(course, t.Key) : Floats(course, "before", t.Key);
                foreach (var kv in values) if (t.Value.HasProperty(kv.Key)) t.Value.SetFloat(kv.Key, kv.Value);
                result[t.Key] = values;
            }
            SceneView.RepaintAll();
            return result;
        }

        // The shader values worth tuning by hand (the terrain scale, _ColorMapTiling/_TerrainSize, is set by the tools).
        static readonly string[] Tunable = new[] { "_TargetDensity", "_Disorder", "_GrassFadeStart", "_GrassFadeEnd", "_LODStart", "_LODEnd", "_LODMax",
            "_DensityFalloffStart", "_DensityFalloffScale", "_DensityFalloffPower", "_TextureCutoff", "_BurnCutoff", "_WindRotation", "_bladeSlopePower", "_floorSlopePower" }
            .Concat(new[] { "_Softness", "_MinHeight", "_MaxHeight", "_Width", "_Weight", "_Smoothness", "_Subsurface" }.SelectMany(p => new[] { p + "00", p + "01", p + "02", p + "03" }))
            .ToArray();

        [GolfMap.Bridge.BridgeCommand("golfmap.stix.read", "Read-only: the hand-tunable float values of the Stix materials as they are in the editor now (rough = NewRough, wispy, wispyFloor, lip), for writing hand edits into <course>/stix.json.")]
        static object ReadCommand(GolfMap.Bridge.BridgeArgs a)
        {
            var rough = FindMaterial(GolfMapRoughGrass.DefaultMaterial);
            var result = new Dictionary<string, object>();
            foreach (var t in new Dictionary<string, Material> { { "rough", rough }, { "wispy", FindMaterial(rough.name + " Wispy") }, { "wispyFloor", FindMaterial(rough.name + " Wispy Floor") }, { "lip", FindMaterial(rough.name + " Lip") } })
            {
                if (t.Value == null) continue;
                var values = new Dictionary<string, object>();
                foreach (var p in Tunable) if (t.Value.HasProperty(p)) values[p] = Math.Round(t.Value.GetFloat(p), 5);
                result[t.Key] = values;
            }
            return result;
        }

        static Material FindMaterial(string name)
        {
            foreach (var guid in AssetDatabase.FindAssets(name + " t:Material"))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(guid));
                if (m != null && m.name == name) return m;
            }
            return null;
        }

        // A section nested in another one ("before" -> "rough").
        static Dictionary<string, float> Floats(GolfMapCourse course, string outer, string section)
        {
            var result = new Dictionary<string, float>();
            var path = PathOf(course);
            if (!File.Exists(path)) return result;
            var o = GolfMapJsonDoc.ParseObject(File.ReadAllText(path)).Object(outer);
            o = o == null ? null : o.Object(section);
            if (o == null) return result;
            foreach (var key in o.keys) { var n = o[key] as GolfMapJsonNumber; if (n != null && key.StartsWith("_", StringComparison.Ordinal)) result[key] = (float)n.Value; }
            return result;
        }

        // Sets the section's values on the material (an asset: marked dirty, saved by the caller's SaveAssets).
        // Returns what it set, for the command's report; a property the shader lacks is an error.
        public static Dictionary<string, object> Apply(Material material, GolfMapCourse course, string section)
        {
            var set = new Dictionary<string, object>();
            foreach (var kv in Floats(course, section))
            {
                if (!material.HasProperty(kv.Key)) throw new InvalidOperationException(PathOf(course) + " " + section + "." + kv.Key + ": " + material.name + " has no such property.");
                if (!Mathf.Approximately(material.GetFloat(kv.Key), kv.Value)) material.SetFloat(kv.Key, kv.Value);
                set[kv.Key] = kv.Value;
            }
            if (set.Count > 0) EditorUtility.SetDirty(material);
            return set;
        }
    }
}
