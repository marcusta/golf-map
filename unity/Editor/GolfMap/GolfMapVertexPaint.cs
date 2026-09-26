// Unity 2018.2 / C# 6. Generated vertex paint on the OPCD course meshes.
//
// OPCD's "4 color Vert Paint MAHS" material draws one texture per paint channel
// (red, green, blue, black), and StixGames' 3D grass on the rough meshes
// (NewRough: ONE_GRASS_TYPE + VERTEX_DENSITY) spawns a blade with the probability
// of the vertex colour's red component. So on a rough mesh red is full grass and
// anything else is fewer blades, down to none; rough's black channel is OPCD's
// dirt base, which reads as a worn or dry patch.
//
// The course meshes are read-only FBX sub-assets. OPCD's own painter
// (VertexPainterPro) paints into a VertexInstanceStream that only the renderer
// sees and "bakes" it into a mesh asset for Stix. This tool writes the baked
// result directly: a mesh copy per painted object under <course>/PaintedMeshes/,
// swapped into the MeshFilter (the MeshCollider keeps the FBX mesh; colours do not
// matter to physics), and the Stix NatureMeshFilter cache reset so the grass
// renders from the copy. Paint is always computed from the original FBX colours,
// so a re-run after tuning or after an FBX re-import gives the same result.
//
// The recipe is <course>/paint.json (golfmap-paint-v1), written with defaults on
// the first run. <course>/PaintedMeshes/restore.json remembers each object's
// original mesh for restore and re-runs.
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
    ""channel: red, green, blue or black. On rough, anything but red thins the Stix 3D grass (blade chance = red) and black shows the material's dirt base."",
    ""widthM: how far from the edge the paint can reach; each spot reaches 35-100 % of it. strength: paint at the edge where the rule applies, 0-1. coverage: share of the edge where it applies at all, 0-1; the rest keeps its grass up to the edge. noiseM: length of those stretches. seed: change for a different pattern.""
  ],
  ""rules"": [
    {
      ""id"": ""bunker-surround"",
      ""kind"": ""edge"",
      ""edge"": ""bunker"",
      ""surfaces"": [""Rough""],
      ""channel"": ""black"",
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
            public float widthM, strength, coverage, noiseM;
            public int seed;
            public float threshold;          // noise value above which the rule applies (from coverage)
            public Vector2 offset, offset2;  // seeded noise offsets
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
                if (o.String("kind") != "edge") throw new InvalidOperationException(where + ": kind must be 'edge'.");
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

        [BridgeCommand("golfmap.paint.restore", "Put every painted course mesh back to its original FBX mesh and reset its Stix grass cache. The painted copies stay in <course>/PaintedMeshes/.")]
        static object RestoreCommand(BridgeArgs a) { return Restore(); }

        public static Dictionary<string, object> Apply(bool dryRun)
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
            var rules = LoadRules(exists ? File.ReadAllText(recipePath) : DefaultRecipe, recipePath);
            var meshFolder = folder + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);

            var scene = EditorSceneManager.GetActiveScene();
            var filters = CourseMeshes(scene);

            // Edges from the meshes as they are now (blends are never painted by this tool).
            var bunkerEdge = new PointGrid(Mathf.Max(1f, rules.Where(r => r.edge == "bunker").Select(r => r.widthM).DefaultIfEmpty(1f).Max()));
            foreach (var f in filters.Where(f => f.name.Contains(BunkerBlendMarker)))
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
                if (!targets.Contains(surface) && !isPainted) continue;

                var source = isPainted ? LoadOriginal(records, path) : f.sharedMesh;
                if (source == null) { errors.Add(path + ": has a painted mesh but its original is not in " + RestoreFile + "; restore it by hand (reassign the FBX mesh)."); continue; }

                var local = source.vertices;
                var colors = source.colors;
                if (colors == null || colors.Length != local.Length) colors = Enumerable.Repeat(new Color(1, 0, 0, 1), local.Length).ToArray();
                int count = 0;
                var outColors = new Color[local.Length];
                for (int i = 0; i < local.Length; i++)
                {
                    var c = colors[i];
                    var p = f.transform.TransformPoint(local[i]);
                    foreach (var r in rules)
                    {
                        if (!r.surfaces.Contains(surface)) continue;
                        float d = bunkerEdge.NearestXZ(p, r.widthM);
                        float w = Weight(r, p, d);
                        if (w <= 0.001f) continue;
                        var t = r.target; t.a = c.a;
                        c = Color.Lerp(c, t, w);
                    }
                    outColors[i] = c;
                    if (c != colors[i]) count++;
                }
                totalVerts += local.Length;
                totalPainted += count;

                if (count == 0)
                {
                    if (!isPainted) { unchanged++; continue; }
                    reverted++;
                    if (!dryRun) { SetMesh(f, source); records.Remove(path); }
                    continue;
                }
                if (Component(f, PainterStreamType) != null)
                    warnings.Add(path + ": has a VertexPainterPro stream (hand paint), which draws over the generated colours; bake or remove it.");
                painted.Add(new Dictionary<string, object> { { "object", f.name }, { "surface", surface.ToString() }, { "vertices", local.Length }, { "painted", count } });
                if (dryRun) continue;

                var copy = UnityEngine.Object.Instantiate(source);
                copy.name = source.name + " (painted)";
                copy.colors = outColors;
                var assetPath = meshFolder + Safe(f.name) + ".asset";
                var existing = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
                Mesh saved;
                if (existing == null) { AssetDatabase.CreateAsset(copy, assetPath); saved = copy; }
                else { EditorUtility.CopySerialized(copy, existing); UnityEngine.Object.DestroyImmediate(copy); saved = existing; EditorUtility.SetDirty(saved); }
                SetMesh(f, saved);
                records[path] = new[] { AssetDatabase.GetAssetPath(source), source.name };
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
                { "bunkerEdgePoints", bunkerEdge.Count },
                { "paintedMeshes", painted.Count },
                { "paintedVertices", totalPainted },
                { "checkedVertices", totalVerts },
                { "reverted", reverted },
                { "untouched", unchanged },
                { "meshes", painted },
                { "warnings", warnings },
                { "errors", errors },
            };
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
                SetMesh(f, original);
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
                .Where(f => f.sharedMesh != null && f.name.StartsWith("Spline_", StringComparison.Ordinal))
                .OrderBy(f => f.name, StringComparer.Ordinal)
                .ToList();
        }

        static bool IsPaintedCopy(Mesh mesh, string meshFolder)
        {
            var p = AssetDatabase.GetAssetPath(mesh);
            return !string.IsNullOrEmpty(p) && p.StartsWith(meshFolder, StringComparison.OrdinalIgnoreCase);
        }

        // Swap the rendered mesh and rebuild the Stix cache from it (the bake).
        static void SetMesh(MeshFilter f, Mesh mesh)
        {
            Undo.RecordObject(f, "Vertex paint");
            f.sharedMesh = mesh;
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
                if (o != null) records[key] = new[] { o.String("asset"), o.String("mesh") };
            }
            return records;
        }

        static void SaveRecords(string path, Dictionary<string, string[]> records)
        {
            if (records.Count == 0 && !File.Exists(path)) return;
            var meshes = new Dictionary<string, object>();
            foreach (var kv in records.OrderBy(k => k.Key, StringComparer.Ordinal))
                meshes[kv.Key] = new Dictionary<string, object> { { "asset", kv.Value[0] }, { "mesh", kv.Value[1] } };
            File.WriteAllText(path, GolfMapJson.Serialize(new Dictionary<string, object> { { "format", RestoreFormat }, { "meshes", meshes } }));
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

        [BridgeCommand("golfmap.paint.probe", "Read-only: the vertex paint of every course mesh within r metres (XZ) of a point: vertex count, how many are not pure red, lowest and mean red (the Stix blade chance), nearest bunker-blend edge distance, and whether the mesh is a painted copy.",
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
                int n = 0, notRed = 0; float minRed = 1, sumRed = 0;
                for (int i = 0; i < local.Length; i++)
                {
                    var p = f.transform.TransformPoint(local[i]);
                    float dx = p.x - x, dz = p.z - z;
                    if (dx * dx + dz * dz > r * r) continue;
                    var c = colors.Length == local.Length ? colors[i] : Color.red;
                    n++; sumRed += c.r; minRed = Mathf.Min(minRed, c.r);
                    if (c.r < 0.99f || c.g > 0.01f || c.b > 0.01f) notRed++;
                }
                if (n == 0) continue;
                hits.Add(new Dictionary<string, object>
                {
                    { "object", f.name }, { "vertices", n }, { "notRed", notRed },
                    { "minRed", (float)Math.Round(minRed, 3) }, { "meanRed", (float)Math.Round(sumRed / n, 3) },
                    { "paintedCopy", AssetDatabase.GetAssetPath(f.sharedMesh).Contains("/" + MeshFolder + "/") },
                });
            }
            float edge = bunkerEdge.NearestXZ(centre, Mathf.Max(r * 2, 3));
            return new Dictionary<string, object> { { "x", x }, { "z", z }, { "r", r }, { "bunkerEdgeM", edge == float.MaxValue ? (object)null : (float)Math.Round(edge, 2) }, { "meshes", hits } };
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
            public float NearestXZ(Vector3 p, float r)
            {
                float best = r * r;
                bool found = false;
                int cx = Mathf.FloorToInt(p.x / cell), cz = Mathf.FloorToInt(p.z / cell);
                for (int dx = -1; dx <= 1; dx++)
                    for (int dz = -1; dz <= 1; dz++)
                    {
                        List<Vector3> l; if (!cells.TryGetValue(Key(cx + dx, cz + dz), out l)) continue;
                        foreach (var q in l) { float x = q.x - p.x, z = q.z - p.z, d2 = x * x + z * z; if (d2 <= best) { best = d2; found = true; } }
                    }
                return found ? Mathf.Sqrt(best) : float.MaxValue;
            }
        }
    }
}
