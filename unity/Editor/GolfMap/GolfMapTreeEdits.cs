// Manual tree edits layered over a unity-trees-v1 survey file.
//
// The scene editor (GolfMapTreeEditor.cs) records every manual change here so
// replanting, regenerating the survey or rebuilding the Unity project keeps
// the manual work. One record per tree id: the record is the current state of
// that tree. Stored next to the trees file as <course>-<terrain>-tree-edits.json.
using System;
using System.Collections.Generic;
using System.IO;
using UnityEngine;

namespace GolfMap.Editor
{
    [Serializable]
    public class GolfMapTreeEditFile
    {
        public string format = GolfMapTreeEdits.Format;
        public string trees;                       // file name of the survey this overlays
        public List<GolfMapTreeEdit> edits = new List<GolfMapTreeEdit>();
    }

    [Serializable]
    public class GolfMapTreeEdit
    {
        public string id;
        public string op;             // "modify" | "delete" | "add"
        public float ox, oz;          // survey position when the record was made (fallback match if the id changes)
        public float x, z, h, r;      // resolved state for modify/add
        public int k;                 // crown kind 0 broadleaf, 1 conifer, 2 unknown
        public bool bush;
        public string species = "";   // "" = biome decides
        public string guid = "";      // "" = biome decides within the species; else the asset's MatchKey (its prefab guid)
        public string model = "";     // a model id of the palette (arborist:<label> | vsp:<prefab>); wins over species and guid
        public bool sized;            // h and r are the tree's drawn size (golfmap.trees.edit heightM / crownWidthM): the fit takes them as they are
        public float rotation;        // degrees, used when rotationSet
        public bool rotationSet;
        public float dy;              // vertical offset from the ground, metres (sink a tree to lower its branches)

        public GolfMapTreeEdit Clone() { return (GolfMapTreeEdit)MemberwiseClone(); }
    }

    public static class GolfMapTreeEdits
    {
        public const string Format = "golfmap-tree-edits-v1";
        public const string AddedPrefix = "manual:";
        public const float FallbackMatchM = 1f;

        public static string PathFor(string treesPath)
        {
            var dir = Path.GetDirectoryName(treesPath) ?? "";
            var name = Path.GetFileNameWithoutExtension(treesPath);
            if (name.EndsWith("-trees")) name = name.Substring(0, name.Length - 6);
            return Path.Combine(dir, name + "-tree-edits.json");
        }

        public static GolfMapTreeEditFile Load(string path)
        {
            if (!File.Exists(path)) return new GolfMapTreeEditFile();
            var file = JsonUtility.FromJson<GolfMapTreeEditFile>(File.ReadAllText(path).TrimStart('\uFEFF'));
            if (file == null || file.format != Format) throw new Exception("Edits file format must be " + Format + ": " + path);
            if (file.edits == null) file.edits = new List<GolfMapTreeEdit>();
            var seen = new HashSet<string>();
            foreach (var e in file.edits)
            {
                if (e == null || string.IsNullOrEmpty(e.id)) throw new Exception("Edit without id in " + path);
                if (!seen.Add(e.id)) throw new Exception("Duplicate edit id " + e.id + " in " + path);
                if (e.op != "modify" && e.op != "delete" && e.op != "add") throw new Exception("Unknown edit op '" + e.op + "' for " + e.id);
                if (e.species == null) e.species = "";
                if (e.guid == null) e.guid = "";
                if (e.model == null) e.model = "";
                // a flat Arborist plant (a lily pad floating on the water) is 0 m tall; Arborist draws it, Unity does not plant it
                bool flatArborist = e.h == 0 && e.model.StartsWith("arborist:", StringComparison.Ordinal);
                if (e.op != "delete" && (!(e.h > 0 || flatArborist) || !(e.r > 0) || e.k < 0 || e.k > 2)) throw new Exception("Invalid height, radius or kind for edit " + e.id);
            }
            return file;
        }

        public static void Save(string path, GolfMapTreeEditFile file)
        {
            File.WriteAllText(path, JsonUtility.ToJson(file, true));
        }

        // Applies the records to the survey list in place. Trees the records
        // change or add are reported in `applied` (tree -> record) so matching
        // can honour species/asset/rotation overrides. Returns warnings for
        // records that matched nothing; those are kept in the file untouched.
        public static List<string> Apply(List<GolfMapTree> trees, List<GolfMapTreeEdit> edits, Dictionary<GolfMapTree, GolfMapTreeEdit> applied)
        {
            var warnings = new List<string>();
            var byId = new Dictionary<string, GolfMapTree>();
            foreach (var t in trees) if (!string.IsNullOrEmpty(t.id) && !byId.ContainsKey(t.id)) byId.Add(t.id, t);
            var remove = new HashSet<GolfMapTree>();
            foreach (var e in edits)
            {
                if (e.op == "add")
                {
                    if (byId.ContainsKey(e.id)) { warnings.Add("Added tree id already exists in the survey: " + e.id); continue; }
                    var t = new GolfMapTree { id = e.id, x = e.x, z = e.z, h = e.h, r = e.r, k = e.k, bush = e.bush, g = 0 };
                    trees.Add(t); byId.Add(t.id, t); applied[t] = e;
                    continue;
                }
                GolfMapTree target;
                if (!byId.TryGetValue(e.id, out target))
                {
                    target = Nearest(trees, e.ox, e.oz, FallbackMatchM, applied, remove);
                    // A tree the user shaped by hand outlives its survey stem: a regenerated survey may have dropped
                    // the stem (the detector's solid-object rule, a rock or power line keep-out), the tree stays.
                    if (target == null && e.op == "modify" && e.h > 0 && e.r > 0)
                    {
                        var kept = new GolfMapTree { id = e.id, x = e.x, z = e.z, h = e.h, r = e.r, k = e.k, bush = e.bush, g = 0 };
                        trees.Add(kept); byId.Add(kept.id, kept); applied[kept] = e;
                        warnings.Add("Edit modify " + e.id + ": the survey no longer has this tree; planted from the edit.");
                        continue;
                    }
                    if (target == null) { warnings.Add("Edit " + e.op + " " + e.id + " matches no survey tree (none within " + FallbackMatchM + " m of its original position)."); continue; }
                }
                if (e.op == "delete") { remove.Add(target); continue; }
                target.x = e.x; target.z = e.z; target.h = e.h; target.r = e.r; target.k = e.k; target.bush = e.bush;
                applied[target] = e;
            }
            if (remove.Count > 0) trees.RemoveAll(t => remove.Contains(t));
            return warnings;
        }

        static GolfMapTree Nearest(List<GolfMapTree> trees, float x, float z, float within, Dictionary<GolfMapTree, GolfMapTreeEdit> taken, HashSet<GolfMapTree> removed)
        {
            GolfMapTree best = null; float bestD = within * within;
            foreach (var t in trees)
            {
                if (taken.ContainsKey(t) || removed.Contains(t)) continue;
                float dx = t.x - x, dz = t.z - z, d = dx * dx + dz * dz;
                if (d < bestD) { bestD = d; best = t; }
            }
            return best;
        }

        public static string NewId() { return AddedPrefix + Guid.NewGuid().ToString("N").Substring(0, 12); }
    }
}
