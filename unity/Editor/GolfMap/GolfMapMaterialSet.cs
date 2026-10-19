// Set float or colour properties on one material asset, Undo-able, and report
// the values before and after: small look tweaks on the course's OPCD MAHS
// materials (one course per Unity project, so editing them in place is safe).
using System.Collections.Generic;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    static class GolfMapMaterialSet
    {
        [BridgeCommand("golfmap.material.set", "Read, or set, properties of one material asset. values is {property: number | [r, g, b, a]}; with multiply=true each number or channel multiplies the current value instead of replacing it (alpha left alone). Set through Undo and saved to the asset. dryRun=true (or no values) only reports. Answers with every named property before and after.",
            args = "path (Assets/...mat), values {prop: number | [r,g,b,a]}, multiply=false, dryRun=false, props (comma-separated names to report when values is omitted)")]
        static object Set(BridgeArgs a)
        {
            var path = a.String("path");
            var material = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (material == null) throw new BridgeError("No material at " + path + ".");
            var values = a.Raw("values") as Dictionary<string, object>;
            bool multiply = a.Bool("multiply", false), dryRun = a.Bool("dryRun", false) || values == null;
            var names = new List<string>();
            if (values != null) names.AddRange(values.Keys);
            else foreach (var n in (a.String("props") ?? "").Split(',')) if (n.Trim().Length > 0) names.Add(n.Trim());
            foreach (var n in names) if (!material.HasProperty(n)) throw new BridgeError(path + " has no property " + n + ".");

            var before = Read(material, names);
            if (!dryRun)
            {
                Undo.RecordObject(material, "Set " + material.name);
                foreach (var kv in values)
                {
                    var list = kv.Value as IList<object>;
                    if (list != null)
                    {
                        var c = material.GetColor(kv.Key);
                        float r = Num(list, 0), g = Num(list, 1), b = Num(list, 2);
                        float al = list.Count > 3 ? Num(list, 3) : (multiply ? 1f : c.a);
                        material.SetColor(kv.Key, multiply ? new Color(c.r * r, c.g * g, c.b * b, c.a) : new Color(r, g, b, al));
                    }
                    else
                    {
                        float v = System.Convert.ToSingle(kv.Value);
                        material.SetFloat(kv.Key, multiply ? material.GetFloat(kv.Key) * v : v);
                    }
                }
                EditorUtility.SetDirty(material);
                AssetDatabase.SaveAssets();
            }
            return new Dictionary<string, object> { { "path", path }, { "dryRun", dryRun }, { "before", before }, { "after", Read(material, names) } };
        }

        static float Num(IList<object> list, int i) { return System.Convert.ToSingle(list[i]); }

        static Dictionary<string, object> Read(Material m, List<string> names)
        {
            var o = new Dictionary<string, object>();
            foreach (var n in names)
            {
                // Colour properties answer GetColor; everything else is read as a float.
                var c = m.GetColor(n);
                bool isColor = n.ToLowerInvariant().Contains("color") || n.ToLowerInvariant().Contains("tint");
                o[n] = isColor ? (object)new[] { Round(c.r), Round(c.g), Round(c.b), Round(c.a) } : Round(m.GetFloat(n));
            }
            return o;
        }

        static double Round(float v) { return System.Math.Round(v, 5); }
    }
}
