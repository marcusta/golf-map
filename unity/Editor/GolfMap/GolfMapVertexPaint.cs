// Unity 2018.2 / C# 6. Generated vertex paint on the OPCD course meshes.
//
// OPCD's "4 color Vert Paint MAHS" material draws one texture per paint channel
// (red, green, blue, black), and StixGames' 3D grass on the rough meshes
// (NewRough: ONE_GRASS_TYPE + VERTEX_DENSITY) spawns a blade with the probability
// of the vertex colour's red component. So on a rough mesh red is full grass and
// anything else is fewer blades, down to none; rough's black channel is OPCD's
// dirt base (roots and debris), which reads as a worn or dry patch. MAHS blends
// black -> red -> green -> blue, each by its own vertex channel, so a rule in
// mode 'overlay' raises one channel and leaves red alone: the ground under the
// blades changes colour and the grass stays (Vreta's bunker-surround: blue).
//
// The course meshes are read-only FBX sub-assets. OPCD's own painter
// (VertexPainterPro) paints into a VertexInstanceStream that only the renderer
// sees and "bakes" it into a mesh asset for Stix. This tool writes the baked
// result directly: a mesh copy per painted object under <course>/PaintedMeshes/,
// swapped into the MeshFilter (the MeshCollider keeps the FBX mesh, colours do not
// matter to physics, unless wall ground changed the shape: see below), and the
// Stix NatureMeshFilter cache reset so the grass
// renders from the copy. Paint is always computed from the original FBX colours,
// so a re-run after tuning or after an FBX re-import gives the same result.
//
// The recipe is <course>/paint.json (golfmap-paint-v1), written with defaults on
// the first run. <course>/PaintedMeshes/restore.json remembers each object's
// original mesh for restore and re-runs.
//
// Stone walls with `ground` (GolfMapWallGround, from <course>/stone-walls.json) reshape
// the meshes on their banks here too, before the rules paint: the copy is then a
// new shape (subdivided, raised, painted on the face), and the MeshCollider takes it
// as well; every other copy leaves the collider on the FBX mesh.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapVertexPaint
    {
        public const string Format = "golfmap-paint-v1";
        const string RestoreFormat = "golfmap-paint-restore-v1";
        const string PaintFile = "paint.json";
        const string MeshFolder = "PaintedMeshes";
        const string RestoreFile = "restore.json";
        const string NatureMeshFilterType = "StixGames.NatureCore.NatureMeshFilter";
        const string GrassRendererType = "StixGames.GrassShader.GrassRenderer";
        const string PainterStreamType = "VertexInstanceStream";  // OPCD ships VertexPainterPro in a DLL; matched by class name
        const string BunkerBlendMarker = "_Bunker_-_Blend";

        const string DefaultRecipe =
@"{
  ""format"": ""golfmap-paint-v1"",
  ""notes"": [
    ""Vertex paint generated onto the course meshes by GolfMap > Vertex Paint > Apply (bridge: golfmap.paint.apply). Re-run after editing this file or re-importing the FBX meshes."",
    ""edge rules paint near an edge: 'bunker' is the outer edge of every bunker blend. 'surfaces' are the mesh classes painted (GolfMapSurfaces: Rough, Semi, Fairway, Deep, ...)."",
    ""channel: red, green, blue or black. mode 'replace' (default) blends the vertex colour toward that channel: on rough anything but red then thins the Stix 3D grass (blade chance = red), and black shows the material's dirt base. mode 'overlay' (red, green or blue) raises that channel and keeps the others, so red and the Stix grass stay: a colour-only change of the ground under the blades (MAHS blends black, red, green, blue in that order, each by its own channel)."",
    ""widthM: how far from the edge the paint can reach; each spot reaches 35-100 % of it. strength: paint at the edge where the rule applies, 0-1. coverage: share of the edge where it applies at all, 0-1; the rest keeps its grass up to the edge. noiseM: length of those stretches. seed: change for a different pattern."",
    ""enabled: false keeps a rule (and its tuning) without painting it. bunker-surround is off: on OPCD's rough material (OPCD MAHS Rough No Mowlines_Sat) blue and black both draw the dirt base (base index 4) with a root and twig detail (detail 20 / 22 at 0.5), so any band of either reads as root streaks round the bunkers; the rough stays clean up to the blend.""
  ],
  ""rules"": [
    {
      ""id"": ""bunker-surround"",
      ""enabled"": false,
      ""kind"": ""edge"",
      ""edge"": ""bunker"",
      ""surfaces"": [""Rough""],
      ""channel"": ""blue"",
      ""mode"": ""overlay"",
      ""widthM"": 2.2,
      ""strength"": 0.9,
      ""coverage"": 0.55,
      ""noiseM"": 3.5,
      ""seed"": 1
    }
  ]
}
";

        // ------------------------------------------------------------ recipe

        sealed class EdgeRule
        {
            public string id, edge;
            public HashSet<GolfMapSurfaces.Surface> surfaces = new HashSet<GolfMapSurfaces.Surface>();
            public Color target;
            public string channel;
            public bool overlay;             // mode 'overlay': raise the channel, keep the others (red, so the Stix grass)
            public float widthM, strength, coverage, noiseM;
            public int seed;
            public float threshold;          // noise value above which the rule applies (from coverage)
            public Vector2 offset, offset2;  // seeded noise offsets
        }

        // kind 'object': paint named objects (a creek bed cut out of the ground) from their own border in. `match` is a
        // substring of the object's name; the paint goes to `channel` with `strength` where the vertex is `fadeM` or more
        // inside the mesh's boundary and fades to nothing at the boundary, so the bed blends into the ground around it.
        // `material` (optional) gives the object a copy of the nearest rough's OPCD MAHS material whose `channel` draws
        // the albedo + normal: black paint on a creek bed is the pebbles, and black is no 3D grass.
        sealed class ObjectRule
        {
            public string id, match, channel;
            public Color target;
            public float strength, fadeM;
            // belowM > 0: paint by depth instead of by distance from the border. The grass level is the height of the mesh's
            // nearest border vertex (within reachM); vertices less than belowM under it keep their colour, so a grass lip
            // stands at the top, and the paint is full from belowM + softM down.
            public float belowM = -1f, softM = 0.08f, reachM = 1.5f;
            public string albedo, normal;     // material: asset paths, null = keep the material
            public float tileM = 1f;
            public Color tint = Color.white;
        }

        static float Num(object o) { var n = o as GolfMapJsonNumber; return n == null ? 0f : (float)n.Value; }

        static List<ObjectRule> LoadObjectRules(string text, string path)
        {
            var root = GolfMapJsonDoc.ParseObject(text);
            var rules = new List<ObjectRule>();
            var list = root.Array("rules") ?? new List<object>();
            for (int i = 0; i < list.Count; i++)
            {
                var o = list[i] as GolfMapJsonObject;
                if (o == null || o.String("kind") != "object") continue;
                if (o["enabled"] is bool && !(bool)o["enabled"]) continue;
                string where = path + " rules[" + i + "]";
                var r = new ObjectRule
                {
                    id = o.String("id") ?? ("rule" + i),
                    match = o.String("match"),
                    channel = (o.String("channel") ?? "black").ToLowerInvariant(),
                    strength = Mathf.Clamp01((float)o.Number("strength", 1)),
                    fadeM = (float)o.Number("fadeM", 0.5),
                    belowM = (float)o.Number("belowM", -1),
                    softM = (float)o.Number("softM", 0.08),
                    reachM = (float)o.Number("reachM", 1.5),
                };
                if (r.belowM > 0 && (r.softM <= 0 || r.reachM <= 0)) throw new InvalidOperationException(where + ": softM and reachM must be > 0.");
                if (string.IsNullOrEmpty(r.match)) throw new InvalidOperationException(where + ": an object rule needs match (a name substring).");
                if (r.fadeM <= 0) throw new InvalidOperationException(where + ": fadeM must be > 0.");
                r.target = ChannelColor(r.channel, where);
                var m = o["material"] as GolfMapJsonObject;
                if (m != null)
                {
                    r.albedo = m.String("albedo");
                    r.normal = m.String("normal");
                    if (string.IsNullOrEmpty(r.albedo) || string.IsNullOrEmpty(r.normal)) throw new InvalidOperationException(where + ": material needs albedo and normal (asset paths).");
                    r.tileM = (float)m.Number("tileM", 1);
                    var tint = m.Array("tint");
                    if (tint != null && tint.Count >= 3) r.tint = new Color(Num(tint[0]), Num(tint[1]), Num(tint[2]), 1f);
                }
                rules.Add(r);
            }
            return rules;
        }

        // A copy of the nearest rough's material (<course>/Creeks/<rough> (creek bed).mat) whose rule channel draws the
        // pebbles; rebuilt from the rough on every run so the rule wins. The copy keeps every other channel, so the
        // bed's red fringe still draws the grass ground around it.
        static Material CreekBedMaterial(string courseFolder, ObjectRule rule, Material rough)
        {
            if (rough == null || string.IsNullOrEmpty(rule.albedo)) return null;
            var dir = courseFolder + "Creeks";
            if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Creeks");
            var path = dir + "/" + rough.name + " (creek bed).mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null) { m = new Material(rough) { name = rough.name + " (creek bed)" }; AssetDatabase.CreateAsset(m, path); }
            else { m.shader = rough.shader; m.CopyPropertiesFromMaterial(rough); }
            GolfMapWallGround.ApplyChannelTexture(m, rule.channel, rule.albedo, rule.normal, rule.tileM, rule.tint, dir);
            // the photo under the base would tint the pebbles
            string p = "_" + char.ToUpperInvariant(rule.channel[0]) + rule.channel.Substring(1);
            if (m.HasProperty(p + "UseSatelliteForBase")) m.SetFloat(p + "UseSatelliteForBase", 0);
            m.DisableKeyword((p + "UseSatelliteForBase").ToUpperInvariant() + "_ON");
            EditorUtility.SetDirty(m);
            return m;
        }

        // The material of the rough mesh nearest to `bed` (by bounds centre) that is a plain OPCD one: no walls stone
        // copy, no creek bed copy.
        static Material NearestRoughMaterial(List<MeshFilter> all, Vector3 centre)
        {
            Material best = null;
            float bestD = float.MaxValue;
            foreach (var f in all)
            {
                if (GolfMapSurfaces.Classify(f.name) != GolfMapSurfaces.Surface.Rough) continue;
                var r = f.GetComponent<Renderer>();
                if (r == null || r.sharedMaterial == null) continue;
                var assetPath = AssetDatabase.GetAssetPath(r.sharedMaterial);
                if (assetPath.IndexOf("/Walls/", StringComparison.OrdinalIgnoreCase) >= 0 || assetPath.IndexOf("/Creeks/", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                var dc = r.bounds.center - centre; float d = dc.x * dc.x + dc.z * dc.z;
                if (d < bestD) { bestD = d; best = r.sharedMaterial; }
            }
            return best;
        }

        static List<EdgeRule> LoadRules(string text, string path)
        {
            var root = GolfMapJsonDoc.ParseObject(text);
            if (root.String("format") != Format) throw new InvalidOperationException(path + ": format must be " + Format + ".");
            var rules = new List<EdgeRule>();
            var list = root.Array("rules") ?? new List<object>();
            for (int i = 0; i < list.Count; i++)
            {
                var o = list[i] as GolfMapJsonObject;
                string where = path + " rules[" + i + "]";
                if (o == null) throw new InvalidOperationException(where + ": not an object.");
                if (o.String("kind") == "object") continue;  // LoadObjectRules
                if (o.String("kind") != "edge") throw new InvalidOperationException(where + ": kind must be 'edge' or 'object'.");
                if (o["enabled"] is bool && !(bool)o["enabled"]) continue;  // kept in the file, not painted
                var r = new EdgeRule
                {
                    id = o.String("id") ?? ("rule" + i),
                    edge = o.String("edge"),
                    channel = (o.String("channel") ?? "black").ToLowerInvariant(),
                    widthM = (float)o.Number("widthM", 1.5),
                    strength = Mathf.Clamp01((float)o.Number("strength", 1)),
                    coverage = Mathf.Clamp01((float)o.Number("coverage", 0.5)),
                    noiseM = Mathf.Max(0.5f, (float)o.Number("noiseM", 4)),
                    seed = (int)o.Number("seed", 1),
                };
                if (r.edge != "bunker") throw new InvalidOperationException(where + ": edge '" + r.edge + "' is not supported (bunker).");
                if (r.widthM <= 0) throw new InvalidOperationException(where + ": widthM must be > 0.");
                r.target = ChannelColor(r.channel, where);
                var mode = (o.String("mode") ?? "replace").ToLowerInvariant();
                if (mode != "replace" && mode != "overlay") throw new InvalidOperationException(where + ": mode must be replace or overlay.");
                r.overlay = mode == "overlay";
                if (r.overlay && r.channel == "black") throw new InvalidOperationException(where + ": black has no overlay (it is the absence of the others); use mode replace.");
                foreach (var s in o.Array("surfaces") ?? new List<object> { "Rough" })
                {
                    GolfMapSurfaces.Surface surface;
                    try { surface = (GolfMapSurfaces.Surface)Enum.Parse(typeof(GolfMapSurfaces.Surface), Convert.ToString(s), true); }
                    catch (ArgumentException) { throw new InvalidOperationException(where + ": unknown surface '" + s + "'."); }
                    r.surfaces.Add(surface);
                }
                r.offset = new Vector2(Frac(r.seed * 0.6180339f) * 200f + 11.3f, Frac(r.seed * 0.4142136f) * 200f + 23.7f);
                r.offset2 = r.offset + new Vector2(57.1f, 91.9f);
                r.threshold = Threshold(r);
                rules.Add(r);
            }
            return rules;
        }

        static Color ChannelColor(string channel, string where)
        {
            switch (channel)
            {
                case "red": return new Color(1, 0, 0);
                case "green": return new Color(0, 1, 0);
                case "blue": return new Color(0, 0, 1);
                case "black": return new Color(0, 0, 0);
            }
            throw new InvalidOperationException(where + ": channel must be red, green, blue or black.");
        }

        static float Frac(float x) { return x - Mathf.Floor(x); }

        // Perlin noise is not uniform (it clusters around 0.5), so the coverage share is
        // turned into a threshold from the noise's own distribution under this seed.
        static float Threshold(EdgeRule r)
        {
            if (r.coverage >= 1) return float.MinValue;
            if (r.coverage <= 0) return float.MaxValue;
            const int n = 96;
            var samples = new float[n * n];
            for (int i = 0; i < n; i++)
                for (int j = 0; j < n; j++)
                    samples[i * n + j] = Mathf.PerlinNoise(r.offset.x + i * 0.37f, r.offset.y + j * 0.37f);
            Array.Sort(samples);
            return samples[Mathf.Clamp(Mathf.RoundToInt((1 - r.coverage) * (samples.Length - 1)), 0, samples.Length - 1)];
        }

        static float Smooth(float e0, float e1, float x)
        {
            float t = Mathf.Clamp01((x - e0) / (e1 - e0));
            return t * t * (3 - 2 * t);
        }

        // Mode overlay: the channel raised toward 1 by `w`, the others kept.
        static Color Overlay(Color c, string channel, float w)
        {
            switch (channel)
            {
                case "red": c.r = Mathf.Lerp(c.r, 1, w); break;
                case "green": c.g = Mathf.Lerp(c.g, 1, w); break;
                case "blue": c.b = Mathf.Lerp(c.b, 1, w); break;
            }
            return c;
        }

        // Paint weight of one rule at a world point `d` metres from its edge.
        static float Weight(EdgeRule r, Vector3 p, float d)
        {
            if (d >= r.widthM) return 0;
            float n1 = Mathf.PerlinNoise(r.offset.x + p.x / r.noiseM, r.offset.y + p.z / r.noiseM);
            float applies = Smooth(r.threshold - 0.035f, r.threshold + 0.035f, n1);
            if (applies <= 0) return 0;
            float n2 = Mathf.PerlinNoise(r.offset2.x + p.x * 2f / r.noiseM, r.offset2.y + p.z * 2f / r.noiseM);
            float reach = r.widthM * Mathf.Lerp(0.35f, 1f, Mathf.Clamp01((n2 - 0.2f) / 0.6f));
            if (d >= reach) return 0;
            return r.strength * applies * (1 - Smooth(0, reach, d));
        }

        // ------------------------------------------------------------ apply

        [MenuItem("GolfMap/Vertex Paint/Apply paint.json")]
        static void ApplyMenu() { Debug.Log("[GolfMap Vertex paint] " + GolfMapJson.Serialize(Apply(false), false)); }

        [MenuItem("GolfMap/Vertex Paint/Restore original meshes")]
        static void RestoreMenu() { Debug.Log("[GolfMap Vertex paint] " + GolfMapJson.Serialize(Restore(), false)); }

        [BridgeCommand("golfmap.paint.apply", "Generate vertex paint from <course>/paint.json (written with defaults if missing) onto the course meshes: painted mesh copies under <course>/PaintedMeshes/ swapped into the MeshFilters, Stix grass caches reset (the bake). Always paints from the original FBX colours; objects no rule touches any more go back to their original mesh. Marks the scene dirty, does not save it.",
            args = "dryRun=false (report what would be painted, change nothing)")]
        static object ApplyCommand(BridgeArgs a) { return Apply(a.Bool("dryRun", false)); }

        [BridgeCommand("golfmap.paint.bedmaterial", "Build the creek bed material of paint.json's object rule (a copy of the nearest rough's OPCD material with the rule's pebbles on its channel, <course>/Creeks/) and return its path; touches no scene object. Apply does the same for every matching mesh.",
            args = "x, z (plot metres: the rough nearest to this point is copied; default 0, 0)")]
        static object BedMaterialCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            var recipePath = folder + PaintFile;
            var rule = (File.Exists(recipePath) ? LoadObjectRules(File.ReadAllText(recipePath), recipePath) : new List<ObjectRule>()).FirstOrDefault(r => !string.IsNullOrEmpty(r.albedo));
            if (rule == null) throw new BridgeError(recipePath + ": no object rule with a material.");
            var centre = new Vector3((float)a.Number("x", 0), 0, (float)a.Number("z", 0));
            var rough = NearestRoughMaterial(CourseMeshes(EditorSceneManager.GetActiveScene()), centre);
            var bed = CreekBedMaterial(folder, rule, rough);
            AssetDatabase.SaveAssets();
            return new Dictionary<string, object> { { "rule", rule.id }, { "rough", rough != null ? AssetDatabase.GetAssetPath(rough) : null }, { "material", bed != null ? AssetDatabase.GetAssetPath(bed) : null } };
        }

        [BridgeCommand("golfmap.paint.restore", "Put every painted course mesh back to its original FBX mesh and reset its Stix grass cache. The painted copies stay in <course>/PaintedMeshes/.")]
        static object RestoreCommand(BridgeArgs a) { return Restore(); }

        // only / within (golfmap.course.refresh only=): paint just the named objects and the course meshes whose bounds
        // meet one of the `within` boxes (XZ) grown by the rules' widest reach; the bunker edges are read from the blends
        // near them. Objects outside keep their paint as it is (never reverted). Both null = every course mesh.
        public static Dictionary<string, object> Apply(bool dryRun, ICollection<string> only = null, IList<Bounds> within = null)
        {
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            var recipePath = folder + PaintFile;
            bool created = false, exists = File.Exists(recipePath);
            if (!exists && !dryRun)
            {
                File.WriteAllText(recipePath, DefaultRecipe);
                AssetDatabase.ImportAsset(recipePath);
                created = exists = true;
            }
            // A dry run before the first apply previews the defaults.
            var recipeText = exists ? File.ReadAllText(recipePath) : DefaultRecipe;
            var rules = LoadRules(recipeText, recipePath);
            var objectRules = LoadObjectRules(recipeText, recipePath);
            var meshFolder = folder + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);

            var scene = EditorSceneManager.GetActiveScene();
            // A painted copy whose asset is gone (deleted, or zeroed by a crash) leaves an empty MeshFilter that
            // CourseMeshes skips: put its original back first, so it is painted (and reshaped) again below.
            var healed = new List<object>();
            foreach (var f in scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true)))
            {
                if (f.sharedMesh != null || !records.ContainsKey(PathOf(f.transform))) continue;
                var original = LoadOriginal(records, PathOf(f.transform));
                if (original == null) continue;
                healed.Add(PathOf(f.transform));
                if (!dryRun) SetMesh(f, original, original);
            }
            var allFilters = CourseMeshes(scene);
            float reach = Mathf.Max(1f, rules.Where(r => r.edge == "bunker").Select(r => r.widthM).DefaultIfEmpty(1f).Max());
            bool scoped = only != null || within != null;
            var boxes = (within ?? new List<Bounds>()).Select(b => { var g = b; g.Expand(new Vector3(2 * reach, 0, 2 * reach)); return g; }).ToList();
            Func<MeshFilter, float, bool> near = (f, grow) =>
            {
                var r = f.GetComponent<Renderer>();
                if (r == null) return false;
                var b = r.bounds;
                return boxes.Any(x => b.max.x >= x.min.x - grow && b.min.x <= x.max.x + grow && b.max.z >= x.min.z - grow && b.min.z <= x.max.z + grow);
            };
            var named = only == null ? null : new HashSet<string>(only, StringComparer.Ordinal);
            var filters = !scoped ? allFilters : allFilters.Where(f => (named != null && named.Contains(f.name)) || near(f, 0)).ToList();
            // the wall ground measures each bank's profile on every mesh around it, so it gets them all
            var ground = GolfMapWallGround.Load(course, allFilters,
                f => IsPaintedCopy(f.sharedMesh, meshFolder) ? LoadOriginal(records, PathOf(f.transform)) : f.sharedMesh);

            // Edges from the meshes as they are now (blends are never painted by this tool).
            var bunkerEdge = new PointGrid(reach);
            foreach (var f in allFilters.Where(f => f.name.Contains(BunkerBlendMarker) && (!scoped || filters.Contains(f) || near(f, reach))))
                foreach (var p in BoundaryPoints(f)) bunkerEdge.Add(p);

            var targets = new HashSet<GolfMapSurfaces.Surface>(rules.SelectMany(r => r.surfaces));
            var painted = new List<object>();
            var errors = new List<string>();
            var warnings = new List<string>();
            int reverted = 0, unchanged = 0, totalVerts = 0, totalPainted = 0;

            if (!dryRun)
            {
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Apply vertex paint");
                if (!AssetDatabase.IsValidFolder(folder + MeshFolder)) AssetDatabase.CreateFolder(folder.TrimEnd('/'), MeshFolder);
            }
            int undoGroup = Undo.GetCurrentGroup();

            foreach (var f in filters)
            {
                var surface = GolfMapSurfaces.Classify(f.name);
                string path = PathOf(f.transform);
                bool isPainted = IsPaintedCopy(f.sharedMesh, meshFolder);
                bool reshape = ground != null && ground.Touches(f);
                var mine = objectRules.Where(r => f.name.IndexOf(r.match, StringComparison.Ordinal) >= 0).ToList();
                if (!targets.Contains(surface) && !isPainted && !reshape && mine.Count == 0) continue;

                var source = isPainted ? LoadOriginal(records, path) : f.sharedMesh;
                if (source == null) { errors.Add(path + ": has a painted mesh but its original is not in " + RestoreFile + "; restore it by hand (reassign the FBX mesh)."); continue; }
                var shaped = reshape ? ground.Shape(f, source, surface) : null;
                bool reshaped = shaped != null;  // held: `shaped` is destroyed once copied into an existing asset
                var baseMesh = shaped ?? source;

                bool stoneOnBlue = reshaped && (surface == GolfMapSurfaces.Surface.Rough || surface == GolfMapSurfaces.Surface.Deep);
                var local = baseMesh.vertices;
                var colors = baseMesh.colors;
                if (colors == null || colors.Length != local.Length) colors = Enumerable.Repeat(new Color(1, 0, 0, 1), local.Length).ToArray();
                int count = 0;
                var outColors = new Color[local.Length];
                PointGrid ownEdge = null;
                if (mine.Count > 0)
                {
                    ownEdge = new PointGrid(mine.Max(r => r.belowM > 0 ? r.reachM : r.fadeM));
                    foreach (var q in BoundaryPoints(f)) ownEdge.Add(q);
                }
                for (int i = 0; i < local.Length; i++)
                {
                    var c = colors[i];
                    var p = f.transform.TransformPoint(local[i]);
                    foreach (var r in mine)
                    {
                        float w;
                        if (r.belowM > 0)
                        {
                            Vector3 top;
                            // no border vertex in reach: far from any edge, fully inside
                            float depth = ownEdge.NearestXZ(p, r.reachM, out top) == float.MaxValue ? float.MaxValue : top.y - p.y;
                            w = r.strength * Smooth(r.belowM, r.belowM + r.softM, depth);
                        }
                        else
                        {
                            float d = ownEdge.NearestXZ(p, r.fadeM);
                            w = r.strength * (d == float.MaxValue ? 1f : Smooth(0, r.fadeM, d));
                        }
                        if (w <= 0.001f) continue;
                        var t = r.target; t.a = c.a; c = Color.Lerp(c, t, w);
                    }
                    foreach (var r in rules)
                    {
                        if (!r.surfaces.Contains(surface)) continue;
                        // a wall-ground rough draws stone on blue: no ground-colour rule may paint it there
                        if (stoneOnBlue && r.channel == "blue") continue;
                        float d = bunkerEdge.NearestXZ(p, r.widthM);
                        float w = Weight(r, p, d);
                        if (w <= 0.001f) continue;
                        if (r.overlay) c = Overlay(c, r.channel, w);
                        else { var t = r.target; t.a = c.a; c = Color.Lerp(c, t, w); }
                    }
                    outColors[i] = c;
                    if (c != colors[i]) count++;
                }
                totalVerts += local.Length;
                totalPainted += count;

                if (count == 0 && !reshaped)
                {
                    if (!isPainted) { unchanged++; continue; }
                    reverted++;
                    if (!dryRun) { SetMesh(f, source, source); PutBackMaterial(f, records, path); records.Remove(path); }
                    continue;
                }
                if (Component(f, PainterStreamType) != null)
                    warnings.Add(path + ": has a VertexPainterPro stream (hand paint), which draws over the generated colours; bake or remove it.");
                painted.Add(new Dictionary<string, object> { { "object", f.name }, { "surface", surface.ToString() }, { "vertices", local.Length }, { "painted", count } });
                if (dryRun) continue;

                var copy = shaped ?? UnityEngine.Object.Instantiate(source);
                if (!reshaped) copy.name = source.name + " (painted)";
                copy.colors = outColors;
                var assetPath = meshFolder + Safe(f.name) + ".asset";
                var existing = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
                Mesh saved;
                if (existing == null) { AssetDatabase.CreateAsset(copy, assetPath); saved = copy; }
                else { Overwrite(existing, copy); UnityEngine.Object.DestroyImmediate(copy); saved = existing; EditorUtility.SetDirty(saved); }
                SetMesh(f, saved, reshaped ? saved : source);
                // a reshaped rough draws its stone channel from a copy of its material (the original is remembered)
                string material = null;
                var mr = f.GetComponent<MeshRenderer>();
                if (reshaped && (surface == GolfMapSurfaces.Surface.Rough || surface == GolfMapSurfaces.Surface.Deep) && mr != null)
                {
                    var known = RecordMaterial(records, path);
                    var original = known ?? mr.sharedMaterial;
                    var stone = ground.StoneMaterial(original);
                    if (stone != null && stone != original)
                    {
                        if (mr.sharedMaterial != stone) { Undo.RecordObject(mr, "Vertex paint"); mr.sharedMaterial = stone; }
                        material = AssetDatabase.GetAssetPath(original);
                    }
                    else if (stone != null && known == null) errors.Add(path + ": renders a walls stone material but its original is not in " + RestoreFile + ".");
                }
                // a creek bed draws its pebbles from a copy of the nearest rough's material (the original is remembered)
                var bedRule = mine.FirstOrDefault(r => !string.IsNullOrEmpty(r.albedo));
                if (bedRule != null && mr != null)
                {
                    var known = RecordMaterial(records, path);
                    var original = known ?? mr.sharedMaterial;
                    var bed = CreekBedMaterial(folder, bedRule, NearestRoughMaterial(allFilters, mr.bounds.center));
                    if (bed != null)
                    {
                        if (mr.sharedMaterial != bed) { Undo.RecordObject(mr, "Vertex paint"); mr.sharedMaterial = bed; }
                        material = original != null && original != bed ? AssetDatabase.GetAssetPath(original) : null;
                    }
                    else warnings.Add(path + ": no rough mesh with a plain material to copy the creek bed material from.");
                }
                if (material == null) PutBackMaterial(f, records, path);
                records[path] = material == null ? new[] { AssetDatabase.GetAssetPath(source), source.name } : new[] { AssetDatabase.GetAssetPath(source), source.name, material };
            }

            object terrainLowered = null;
            if (!dryRun && ground != null && ground.loweredPoints.Count > 0)
            {
                // VSP grass grows on the terrain: bring it down under ground the walls lowered
                var inner = GolfMapTerrainConform.InnerTerrain(course);
                if (inner != null) terrainLowered = GolfMapTerrainConform.LowerUnder(folder, inner, ground.loweredPoints);
            }
            if (!dryRun)
            {
                Undo.CollapseUndoOperations(undoGroup);
                SaveRecords(meshFolder + RestoreFile, records);
                AssetDatabase.SaveAssets();
                if (painted.Count + reverted > 0) EditorSceneManager.MarkSceneDirty(scene);
                SceneView.RepaintAll();
            }

            var result = new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "recipe", recipePath },
                { "recipeCreated", created },
                { "dryRun", dryRun },
                { "rules", rules.Select(r => r.id).ToList() },
                { "objectRules", objectRules.Select(r => r.id).ToList() },
                { "bunkerEdgePoints", bunkerEdge.Count },
                { "paintedMeshes", painted.Count },
                { "paintedVertices", totalPainted },
                { "checkedVertices", totalVerts },
                { "reverted", reverted },
                { "healed", healed },
                { "untouched", unchanged },
                { "ground", ground == null ? null : ground.report },
                { "terrainLowered", terrainLowered },
                { "meshes", painted },
                { "warnings", warnings },
                { "errors", errors },
            };
            if (scoped) result["scope"] = new Dictionary<string, object> { { "meshesInScope", filters.Count }, { "courseMeshes", allFilters.Count }, { "reachM", reach } };
            WriteReport(course, result);
            return result;
        }

        public static Dictionary<string, object> Restore()
        {
            var course = GolfMapCourses.Require();
            var meshFolder = GolfMapCourses.Folder(course) + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);
            var scene = EditorSceneManager.GetActiveScene();
            var errors = new List<string>();
            int restored = 0;
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Restore vertex paint");
            int undoGroup = Undo.GetCurrentGroup();
            foreach (var f in CourseMeshes(scene))
            {
                if (!IsPaintedCopy(f.sharedMesh, meshFolder)) continue;
                var path = PathOf(f.transform);
                var original = LoadOriginal(records, path);
                if (original == null) { errors.Add(path + ": original mesh unknown"); continue; }
                SetMesh(f, original, original);
                PutBackMaterial(f, records, path);
                records.Remove(path);
                restored++;
            }
            Undo.CollapseUndoOperations(undoGroup);
            SaveRecords(meshFolder + RestoreFile, records);
            if (restored > 0) EditorSceneManager.MarkSceneDirty(scene);
            SceneView.RepaintAll();
            return new Dictionary<string, object> { { "scene", scene.name }, { "restored", restored }, { "errors", errors } };
        }

        static List<MeshFilter> CourseMeshes(UnityEngine.SceneManagement.Scene scene)
        {
            return scene.GetRootGameObjects()
                .SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.sharedMesh != null && f.name.StartsWith("Spline_", StringComparison.Ordinal) && !GolfMapWaterplanes.IsWaterPlane(f.name))
                .OrderBy(f => f.name, StringComparer.Ordinal)
                .ToList();
        }

        static bool IsPaintedCopy(Mesh mesh, string meshFolder)
        {
            var p = AssetDatabase.GetAssetPath(mesh);
            return !string.IsNullOrEmpty(p) && p.StartsWith(meshFolder, StringComparison.OrdinalIgnoreCase);
        }

        // Rewrite an existing painted-copy asset (same GUID, so scene references stay) with another mesh's data through
        // the Mesh API. EditorUtility.CopySerialized swaps the serialized data under the loaded mesh but leaves its
        // render buffers: once the FBX under a copy changed its vertices (a Blender shaping run re-exports the meshes),
        // the renderer kept the old index buffer and UVs over the new vertices - sheets and walls of stretched triangles,
        // UVs off the ortho (white) - while the collider, cooked from the CPU data, had the right shape.
        static void Overwrite(Mesh target, Mesh source)
        {
            target.Clear(false);
            target.name = source.name;
            target.indexFormat = source.indexFormat;
            var v = new List<Vector3>(); source.GetVertices(v); target.SetVertices(v);
            var n = new List<Vector3>(); source.GetNormals(n); if (n.Count == v.Count) target.SetNormals(n);
            var t = new List<Vector4>(); source.GetTangents(t); if (t.Count == v.Count) target.SetTangents(t);
            var c = new List<Color>(); source.GetColors(c); if (c.Count == v.Count) target.SetColors(c);
            for (int ch = 0; ch < 4; ch++)
            {
                var uv = new List<Vector4>(); source.GetUVs(ch, uv);
                if (uv.Count != v.Count) continue;
                if (uv.All(u => u.z == 0 && u.w == 0)) target.SetUVs(ch, uv.Select(u => new Vector2(u.x, u.y)).ToList());
                else target.SetUVs(ch, uv);
            }
            target.subMeshCount = source.subMeshCount;
            for (int sm = 0; sm < source.subMeshCount; sm++) target.SetTriangles(source.GetTriangles(sm), sm, false);
            target.RecalculateBounds();
        }

        // Swap the rendered mesh and rebuild the Stix cache from it (the bake); the MeshCollider gets `collider`
        // (the FBX mesh, or a wall-ground copy that changed the shape).
        static void SetMesh(MeshFilter f, Mesh mesh, Mesh collider)
        {
            Undo.RecordObject(f, "Vertex paint");
            // Upload the (possibly rewritten, see Overwrite) geometry and rebind it, just as we recook the collider below.
            mesh.vertices = mesh.vertices;
            mesh.normals = mesh.normals;
            mesh.colors = mesh.colors;
            mesh.UploadMeshData(false);
            f.sharedMesh = null;
            f.sharedMesh = mesh;
            var mc = f.GetComponent<MeshCollider>();
            // a reshaped copy is rewritten in place on a re-run: assign it again so the collider cooks the new shape
            if (mc != null && (mc.sharedMesh != collider || collider == mesh))
            {
                Undo.RecordObject(mc, "Vertex paint");
                mc.sharedMesh = null;
                mc.sharedMesh = collider;
            }
            var nmf = Component(f, NatureMeshFilterType);
            if (nmf == null) return;
            Undo.RecordObject(nmf, "Vertex paint");
            var type = nmf.GetType();
            type.GetMethod("ResetCache").Invoke(nmf, null);
            type.GetMethod("GetMeshes").Invoke(nmf, new object[] { false });
            EditorUtility.SetDirty(nmf);
        }

        static IEnumerable<Vector3> BoundaryPoints(MeshFilter f)
        {
            var mp = GolfMapBunkerChannels.Read(f);
            var seen = new HashSet<int>();
            for (int i = 0; i < mp.world.Length; i++)
                if (mp.boundary.Contains(mp.weld[i]) && seen.Add(mp.weld[i])) yield return mp.world[i];
        }

        // ------------------------------------------------------------ records

        static Dictionary<string, string[]> LoadRecords(string path)
        {
            var records = new Dictionary<string, string[]>();
            if (!File.Exists(path)) return records;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var meshes = root.Object("meshes");
            if (meshes == null) return records;
            foreach (var key in meshes.keys)
            {
                var o = meshes.Object(key);
                if (o != null) records[key] = o.String("material") == null ? new[] { o.String("asset"), o.String("mesh") } : new[] { o.String("asset"), o.String("mesh"), o.String("material") };
            }
            return records;
        }

        static void SaveRecords(string path, Dictionary<string, string[]> records)
        {
            if (records.Count == 0 && !File.Exists(path)) return;
            var meshes = new Dictionary<string, object>();
            foreach (var kv in records.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                var m = new Dictionary<string, object> { { "asset", kv.Value[0] }, { "mesh", kv.Value[1] } };
                if (kv.Value.Length > 2) m["material"] = kv.Value[2];
                meshes[kv.Key] = m;
            }
            File.WriteAllText(path, GolfMapJson.Serialize(new Dictionary<string, object> { { "format", RestoreFormat }, { "meshes", meshes } }));
        }

        // Object path -> the FBX asset its painted (or wall-ground reshaped) copy was made from (restore.json). Takes the
        // course folder: GolfMapCourseMeshes reads it before OPCD's Set Default Materials can unload the course asset.
        internal static Dictionary<string, string> OriginalAssets(string courseFolder)
        {
            return LoadRecords(courseFolder + MeshFolder + "/" + RestoreFile).ToDictionary(kv => kv.Key, kv => kv.Value[0]);
        }

        // The material a wall-ground mesh had before it drew stone (null when it was never swapped).
        static Material RecordMaterial(Dictionary<string, string[]> records, string objectPath)
        {
            string[] r;
            return records.TryGetValue(objectPath, out r) && r.Length > 2 && !string.IsNullOrEmpty(r[2]) ? AssetDatabase.LoadAssetAtPath<Material>(r[2]) : null;
        }

        static void PutBackMaterial(MeshFilter f, Dictionary<string, string[]> records, string objectPath)
        {
            var original = RecordMaterial(records, objectPath);
            var mr = f.GetComponent<MeshRenderer>();
            if (original == null || mr == null || mr.sharedMaterial == original) return;
            Undo.RecordObject(mr, "Vertex paint");
            mr.sharedMaterial = original;
        }

        static Mesh LoadOriginal(Dictionary<string, string[]> records, string objectPath)
        {
            string[] r;
            if (!records.TryGetValue(objectPath, out r) || string.IsNullOrEmpty(r[0])) return null;
            return AssetDatabase.LoadAllAssetsAtPath(r[0]).OfType<Mesh>().FirstOrDefault(m => m.name == r[1]);
        }

        static void WriteReport(GolfMapCourse course, Dictionary<string, object> result)
        {
            var sb = new StringBuilder();
            sb.AppendLine("GolfMap vertex paint " + DateTime.Now.ToString("yyyy-MM-dd HH:mm") + (((bool)result["dryRun"]) ? " (dry run)" : ""));
            foreach (var kv in result.Where(kv => kv.Key != "meshes")) sb.AppendLine(kv.Key + ": " + GolfMapJson.Serialize(kv.Value, false));
            foreach (Dictionary<string, object> m in (List<object>)result["meshes"])
                sb.AppendLine("  " + m["object"] + " (" + m["surface"] + "): " + m["painted"] + " / " + m["vertices"] + " vertices");
            File.WriteAllText(GolfMapCourses.ReportPath(course, "vertex_paint.txt"), sb.ToString());
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t != null; t = t.parent) parts.Insert(0, t.name);
            return "/" + string.Join("/", parts.ToArray());
        }

        static string Safe(string name) { return string.Join("_", name.Split(Path.GetInvalidFileNameChars())); }

        [BridgeCommand("golfmap.paint.probe", "Read-only: the vertex paint of every course mesh within r metres (XZ) of a point: vertex count, how many are not pure red, lowest and mean red (the Stix blade chance), nearest bunker-blend edge distance, whether the mesh is a painted copy, and (stream) the colours of a VertexPainterPro stream on the renderer, which is what it draws.",
            args = "x, z, r=3")]
        static object Probe(BridgeArgs a)
        {
            float x = (float)a.Number("x", double.NaN), z = (float)a.Number("z", double.NaN), r = (float)a.Number("r", 3);
            if (float.IsNaN(x) || float.IsNaN(z)) throw new BridgeError("x and z are required.");
            var scene = EditorSceneManager.GetActiveScene();
            var filters = CourseMeshes(scene);
            var bunkerEdge = new PointGrid(Mathf.Max(r * 2, 3));
            foreach (var f in filters.Where(f => f.name.Contains(BunkerBlendMarker)))
                foreach (var p in BoundaryPoints(f)) bunkerEdge.Add(p);
            var centre = new Vector3(x, 0, z);
            var hits = new List<object>();
            foreach (var f in filters)
            {
                var b = f.GetComponent<Renderer>().bounds;
                if (x < b.min.x - r || x > b.max.x + r || z < b.min.z - r || z > b.max.z + r) continue;
                var local = f.sharedMesh.vertices;
                var colors = f.sharedMesh.colors;
                // A VertexPainterPro stream (hand paint) is what the renderer draws: its colours replace the mesh's.
                var streamMesh = f.GetComponent<MeshRenderer>().additionalVertexStreams;
                var streamColors = streamMesh != null ? streamMesh.colors : new Color[0];
                if (streamColors.Length != local.Length) streamColors = null;
                int n = 0, notRed = 0, streamNotRed = 0; float minRed = 1, sumRed = 0, sumGreen = 0, sumBlue = 0, streamMinRed = 1, streamSumRed = 0, streamSumBlack = 0;
                for (int i = 0; i < local.Length; i++)
                {
                    var p = f.transform.TransformPoint(local[i]);
                    float dx = p.x - x, dz = p.z - z;
                    if (dx * dx + dz * dz > r * r) continue;
                    var c = colors.Length == local.Length ? colors[i] : Color.red;
                    n++; sumRed += c.r; minRed = Mathf.Min(minRed, c.r);
                    sumGreen += c.g; sumBlue += c.b;
                    if (c.r < 0.99f || c.g > 0.01f || c.b > 0.01f) notRed++;
                    if (streamColors != null)
                    {
                        var s = streamColors[i];
                        streamSumRed += s.r; streamMinRed = Mathf.Min(streamMinRed, s.r);
                        streamSumBlack += Mathf.Max(0f, 1f - s.r - s.g - s.b);
                        if (s.r < 0.99f || s.g > 0.01f || s.b > 0.01f) streamNotRed++;
                    }
                }
                if (n == 0) continue;
                var hit = new Dictionary<string, object>
                {
                    { "object", f.name }, { "vertices", n }, { "notRed", notRed },
                    { "vertexStream", streamMesh == null ? null : streamMesh.name },
                    { "minRed", (float)Math.Round(minRed, 3) }, { "meanRed", (float)Math.Round(sumRed / n, 3) },
                    { "meanGreen", (float)Math.Round(sumGreen / n, 3) }, { "meanBlue", (float)Math.Round(sumBlue / n, 3) },
                    { "paintedCopy", AssetDatabase.GetAssetPath(f.sharedMesh).Contains("/" + MeshFolder + "/") },
                };
                if (streamColors != null)
                    hit["stream"] = new Dictionary<string, object>
                    {
                        { "notRed", streamNotRed }, { "minRed", (float)Math.Round(streamMinRed, 3) },
                        { "meanRed", (float)Math.Round(streamSumRed / n, 3) }, { "meanBlack", (float)Math.Round(streamSumBlack / n, 3) },
                    };
                hits.Add(hit);
            }
            float edge = bunkerEdge.NearestXZ(centre, Mathf.Max(r * 2, 3));
            return new Dictionary<string, object> { { "x", x }, { "z", z }, { "r", r }, { "bunkerEdgeM", edge == float.MaxValue ? (object)null : (float)Math.Round(edge, 2) }, { "meshes", hits } };
        }

        // ----------------------------------------------------- painter streams

        // OPCD's painter (VertexPainterPro) keeps hand paint in a VertexInstanceStream: a mesh the renderer draws its
        // colours from (MeshRenderer.additionalVertexStreams) instead of the mesh's own. It outlives FBX re-imports and
        // paint.json, and the Stix grass never sees it. On Vreta one (the rough round 18_1c/18_1d) held black round the
        // bunkers: the rough's dirt base with roots, which no paint rule or Blender paint explained.
        [BridgeCommand("golfmap.paint.streams", "List the course meshes whose renderer draws a VertexPainterPro stream (OPCD hand paint, VertexInstanceStream) instead of its own vertex colours: vertices, how many are not pure red, mean black. remove=true takes the streams off (each stream mesh saved first to <course>/PaintedMeshes/streams/<object>.asset; Undo works), so the renderers draw the mesh's colours (FBX or paint.json). Marks the scene dirty, does not save it.",
            args = "remove=false, only (object names, comma-separated)")]
        static object Streams(BridgeArgs a)
        {
            bool remove = a.Bool("remove", false);
            var only = new HashSet<string>((a.String("only", "") ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(s => s.Trim()));
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course) + MeshFolder;
            var scene = EditorSceneManager.GetActiveScene();
            var rows = new List<object>();
            foreach (var f in CourseMeshes(scene))
            {
                if (only.Count > 0 && !only.Contains(f.name)) continue;
                var mr = f.GetComponent<MeshRenderer>();
                var comp = Component(f, PainterStreamType);
                var stream = mr != null ? mr.additionalVertexStreams : null;
                if (comp == null && stream == null) continue;
                var colors = stream != null ? stream.colors : new Color[0];
                int notRed = 0; double black = 0;
                foreach (var c in colors)
                {
                    if (c.r < 0.99f || c.g > 0.01f || c.b > 0.01f) notRed++;
                    black += Mathf.Max(0f, 1f - c.r - c.g - c.b);
                }
                var row = new Dictionary<string, object>
                {
                    { "object", f.name }, { "component", comp != null }, { "streamVertices", colors.Length },
                    { "meshVertices", f.sharedMesh.vertexCount }, { "notRed", notRed },
                    { "meanBlack", colors.Length > 0 ? Math.Round(black / colors.Length, 4) : 0 },
                };
                if (remove)
                {
                    if (stream != null)
                    {
                        if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(GolfMapCourses.Folder(course).TrimEnd('/'), MeshFolder);
                        if (!AssetDatabase.IsValidFolder(folder + "/streams")) AssetDatabase.CreateFolder(folder, "streams");
                        var backup = UnityEngine.Object.Instantiate(stream);
                        var path = AssetDatabase.GenerateUniqueAssetPath(folder + "/streams/" + Safe(f.name) + ".asset");
                        AssetDatabase.CreateAsset(backup, path);
                        row["backup"] = path;
                        Undo.RecordObject(mr, "Remove painter streams");
                        mr.additionalVertexStreams = null;
                    }
                    if (comp != null) Undo.DestroyObjectImmediate(comp);
                    row["removed"] = true;
                }
                rows.Add(row);
            }
            if (remove && rows.Count > 0)
            {
                AssetDatabase.SaveAssets();
                EditorSceneManager.MarkSceneDirty(scene);
            }
            return new Dictionary<string, object> { { "remove", remove }, { "streams", rows } };
        }

        // ------------------------------------------------------------ survey

        [BridgeCommand("golfmap.paint.survey", "Read-only: per surface class of the course meshes (Spline_*), mesh and vertex counts, edge lengths (median/p90, interior edges only), current dominant paint, Stix grass setup (renderer, NatureMeshFilter normalisation, cached meshes) and whether meshes are FBX sub-assets. Plus the rough edges within `near` metres of a bunker blend's outer edge.",
            args = "near=3 (metres)")]
        static object Survey(BridgeArgs a)
        {
            float near = (float)a.Number("near", 3);
            var scene = EditorSceneManager.GetActiveScene();
            var filters = CourseMeshes(scene);

            var bunkerEdge = new PointGrid(near);
            foreach (var f in filters.Where(f => f.name.Contains(BunkerBlendMarker)))
                foreach (var p in BoundaryPoints(f)) bunkerEdge.Add(p);
            var bunkers = filters.Where(f => f.name.EndsWith("_Bunker_-_Mesh", StringComparison.Ordinal))
                .Select(f => { var b = f.GetComponent<Renderer>().bounds; return (object)new Dictionary<string, object> { { "object", f.name }, { "center", b.center }, { "sizeM", Mathf.Round(Mathf.Max(b.size.x, b.size.z)) } }; })
                .ToList();

            var classes = new Dictionary<string, ClassStats>();
            var nearBunker = new List<float>();
            int nearBunkerVerts = 0;
            foreach (var f in filters)
            {
                var surface = GolfMapSurfaces.Classify(f.name).ToString();
                ClassStats s; if (!classes.TryGetValue(surface, out s)) classes[surface] = s = new ClassStats();
                var mp = GolfMapBunkerChannels.Read(f);
                s.meshes++;
                s.welded += mp.links.Count;
                if (AssetDatabase.GetAssetPath(f.sharedMesh).EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) s.fbx++;
                if (!mp.HasColors) s.noColors++;
                else
                {
                    var seen = new HashSet<int>();
                    for (int i = 0; i < mp.world.Length; i++)
                        if (seen.Add(mp.weld[i])) s.paint.Add(GolfMapBunkerChannels.Dominant(mp.colors[i]));
                }
                var pos = new Dictionary<int, Vector3>();
                for (int i = 0; i < mp.world.Length; i++) pos[mp.weld[i]] = mp.world[i];
                bool rough = surface == "Rough";
                var nearSet = new HashSet<int>();
                foreach (var kv in mp.links)
                    foreach (var b in kv.Value)
                    {
                        if (b <= kv.Key) continue;
                        float len = Vector3.Distance(pos[kv.Key], pos[b]);
                        bool interior = !(mp.boundary.Contains(kv.Key) && mp.boundary.Contains(b));
                        if (interior) s.edges.Add(len);
                        if (rough && bunkerEdge.NearestXZ((pos[kv.Key] + pos[b]) * 0.5f, near) < near)
                        {
                            nearBunker.Add(len);
                            nearSet.Add(kv.Key); nearSet.Add(b);
                        }
                    }
                nearBunkerVerts += nearSet.Count;

                var nmf = Component(f, NatureMeshFilterType);
                if (Component(f, GrassRendererType) != null) s.stix++;
                if (Component(f, PainterStreamType) != null) s.painterStreams++;
                if (nmf != null)
                {
                    var so = new SerializedObject(nmf);
                    var norm = so.FindProperty("NormalizeTriangleSizes");
                    if (norm != null && norm.boolValue) s.normalized++;
                    var cached = so.FindProperty("meshes");
                    if (cached != null && cached.isArray && cached.arraySize > 0)
                    {
                        s.cached++;
                        var first = cached.GetArrayElementAtIndex(0).objectReferenceValue as Mesh;
                        if (first != null && first == f.sharedMesh) s.cacheIsShared++;
                    }
                }
            }

            var result = new Dictionary<string, object> { { "scene", scene.name }, { "meshes", filters.Count } };
            result["classes"] = classes.OrderBy(kv => kv.Key).ToDictionary(kv => kv.Key, kv => (object)kv.Value.ToJson());
            result["roughNearBunker"] = new Dictionary<string, object>
            {
                { "withinM", near },
                { "bunkerEdgePoints", bunkerEdge.Count },
                { "vertices", nearBunkerVerts },
                { "edges", nearBunker.Count },
                { "edgeMedianM", Percentile(nearBunker, 0.5f) },
                { "edgeP90M", Percentile(nearBunker, 0.9f) },
            };
            result["bunkers"] = bunkers;
            return result;
        }

        sealed class ClassStats
        {
            public int meshes, welded, fbx, noColors, stix, normalized, cached, cacheIsShared, painterStreams;
            public readonly List<float> edges = new List<float>();
            public readonly GolfMapBunkerChannels.Tally paint = new GolfMapBunkerChannels.Tally();
            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "meshes", meshes }, { "vertices", welded }, { "fbxMeshes", fbx },
                    { "interiorEdgeMedianM", Percentile(edges, 0.5f) }, { "interiorEdgeP90M", Percentile(edges, 0.9f) },
                    { "paint", paint.ToString() }, { "noVertexColours", noColors }, { "painterStreams", painterStreams },
                    { "stixRenderers", stix }, { "stixNormalized", normalized }, { "stixCached", cached }, { "stixCacheIsSharedMesh", cacheIsShared },
                };
            }
        }

        static float Percentile(List<float> values, float p)
        {
            if (values.Count == 0) return 0;
            var sorted = values.OrderBy(v => v).ToList();
            return (float)Math.Round(sorted[Mathf.Clamp(Mathf.FloorToInt(p * (sorted.Count - 1)), 0, sorted.Count - 1)], 3);
        }

        // Stix and VertexPainterPro live in assemblies editor scripts cannot reference
        // in every project: find their components by type name.
        static Component Component(Component c, string fullName)
        {
            return c.GetComponents<Component>().FirstOrDefault(x => x != null && (x.GetType().FullName == fullName || x.GetType().Name == fullName));
        }

        // Points bucketed on the XZ plane for nearest-within-r queries.
        sealed class PointGrid
        {
            readonly float cell;
            readonly Dictionary<long, List<Vector3>> cells = new Dictionary<long, List<Vector3>>();
            public int Count { get; private set; }
            public PointGrid(float cell) { this.cell = Mathf.Max(cell, 0.25f); }
            static long Key(int x, int z) { return ((long)x << 32) | (uint)z; }
            public void Add(Vector3 p)
            {
                var k = Key(Mathf.FloorToInt(p.x / cell), Mathf.FloorToInt(p.z / cell));
                List<Vector3> l; if (!cells.TryGetValue(k, out l)) cells[k] = l = new List<Vector3>();
                l.Add(p); Count++;
            }
            // Distance on the XZ plane to the nearest point, or float.MaxValue beyond r
            // (r must not exceed the cell size).
            public float NearestXZ(Vector3 p, float r) { Vector3 hit; return NearestXZ(p, r, out hit); }

            public float NearestXZ(Vector3 p, float r, out Vector3 hit)
            {
                hit = Vector3.zero;
                float best = r * r;
                bool found = false;
                int cx = Mathf.FloorToInt(p.x / cell), cz = Mathf.FloorToInt(p.z / cell);
                for (int dx = -1; dx <= 1; dx++)
                    for (int dz = -1; dz <= 1; dz++)
                    {
                        List<Vector3> l; if (!cells.TryGetValue(Key(cx + dx, cz + dz), out l)) continue;
                        foreach (var q in l) { float x = q.x - p.x, z = q.z - p.z, d2 = x * x + z * z; if (d2 <= best) { best = d2; found = true; hit = q; } }
                    }
                return found ? Mathf.Sqrt(best) : float.MaxValue;
            }
        }
    }
}
