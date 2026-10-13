// Unity 2018.2 / C# 6. Dry-stone walls: boulder faces on the banks of raised tees (or any steep bank).
//
// A golfmap-walls-v1 spec (docs/gspro/<course>/stone-walls.gen.py writes <course>/stone-walls.json) gives
// each wall as paired stations in EPSG:3006 along a bank: its foot (toe) and its top edge (lip), traced
// from the lidar DEM, plus the boulders to build it from and how they sit. The boulders are Blender-built
// (props_kit `boulder`, built by build_props.py into the spec's stonesFolder; materials and FBX import
// settings come from that folder's manifest through GolfMapProps) or prefabs.
//
// The lidar smooths a near-vertical wall into a 45-60 deg bank and the Blender meshes flatten it further
// (~35 deg), so stones bedded in that bank would mostly vanish into it. The build stands a steeper face in
// front of it: courses of stones from the foot up, each course's front row followBank of the way in to the
// bank at its base and proudFrac of a stone's depth out from there, long side along the wall, top leaning
// back into the bank. Behind a front stone more stones fill in while the bank there is still lower than its
// top, so there is no trench between the wall and the plateau. Course bases are courseStepM apart, less
// than a stone is high, so each course nests into the one below; every other course starts half a stone
// along. Heights come from the scene (the highest course mesh under a point, else the terrain), so a
// rebuild after the meshes or the heightmap changed fits the new ground.
//
// Stones are instances under 'GolfMap Walls/<wall id>/' named <model>#<n>, with a prefab's own LODs and
// colliders (a Blender boulder gets a MeshCollider) and no custom component (GSPro would load it as a
// missing script). A build replaces the stones of the walls it builds. A wall's seed (+ variant) makes the
// same stones every time; stones moved by hand are lost on a rebuild.
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
    public static class GolfMapWalls
    {
        public const string Format = "golfmap-walls-v1";
        public const string RootName = "GolfMap Walls";
        const string SpecFile = "stone-walls.json";

        internal sealed class Settings
        {
            public Vector2 baseStoneM = new Vector2(0.85f, 1.25f), stoneM = new Vector2(0.6f, 1f), heightScale = new Vector2(0.95f, 1.25f);
            public float courseStepM = 0.65f, followBank = 0.5f, proudFrac = 0.45f, leanDeg = 10f, spinDeg = 12f, sinkM = 0.15f, gapM = -0.12f,
                topMarginM = 0.3f, minFaceM = 0.35f, fillMarginM = 0.35f, capM = 0.08f;
            public int maxFill = 3;
            // the ground (GolfMapWallGround): reshape the course meshes on the bank into a terrace
            public bool ground = false;
            public float faceDeg = 60f, baseInM = 0.2f, beyondM = 0.5f, taperM = 1.5f, subdivideM = 0.35f, paintFeatherM = 0.25f;
            public string groundChannel = "blue";
            // the stone the rough's groundChannel draws: this material's channel copied onto a copy of the rough material
            public string stoneMaterial = "", stoneMaterialChannel = "red";
            public Color? stoneColor;  // the stone channel's overall colour (_<Channel>OverallColor), replacing the source's
            // style: "rose" (a stenröse: a heap of rounded stones, nested courses proud of the bank) or "wall" (a
            // dry-stone wall: courses of flat-faced stones fitted into the face's plane); stoneSet: the spec's stoneSets
            public string style = "rose", stoneSet = "default";
            public Vector2 baseCourseM = new Vector2(0.5f, 0.65f), courseM = new Vector2(0.34f, 0.5f), lengthRatio = new Vector2(1.3f, 2.6f), depthM = new Vector2(0.55f, 0.8f);
            public float maxStoneM = 1.4f, faceProudM = 0.03f, faceJitterM = 0.03f, minTopCourseM = 0.18f, bedJitterM = 0.05f;
            public float jitterDeg = 0f;  // cliff: the face angle varies this much either way along the face
            public Vector2 stoneHeightVar = new Vector2(0.94f, 1.04f);  // a stone's height / its course's

            public string stoneAlbedo = "", stoneNormal = "";
            public float stoneTileM = 4f;
            public bool paintOnly = false;
            public float paintInsetM = 0f;
            public float roundTopM = 0f;
            public bool placeStones = true;

            public Settings Over(GolfMapJsonObject o)
            {
                var s = (Settings)MemberwiseClone();
                if (o == null) return s;
                s.baseStoneM = Range(o, "baseStoneM", s.baseStoneM);
                s.stoneM = Range(o, "stoneM", s.stoneM);
                s.heightScale = Range(o, "heightScale", s.heightScale);
                s.courseStepM = (float)o.Number("courseStepM", s.courseStepM);
                s.followBank = (float)o.Number("followBank", s.followBank);
                s.proudFrac = (float)o.Number("proudFrac", s.proudFrac);
                s.leanDeg = (float)o.Number("leanDeg", s.leanDeg);
                s.spinDeg = (float)o.Number("spinDeg", s.spinDeg);
                s.sinkM = (float)o.Number("sinkM", s.sinkM);
                s.gapM = (float)o.Number("gapM", s.gapM);
                s.topMarginM = (float)o.Number("topMarginM", s.topMarginM);
                s.minFaceM = (float)o.Number("minFaceM", s.minFaceM);
                s.fillMarginM = (float)o.Number("fillMarginM", s.fillMarginM);
                s.capM = (float)o.Number("capM", s.capM);
                s.maxFill = (int)o.Number("maxFill", s.maxFill);
                s.ground = o.Bool("ground", s.ground);
                s.faceDeg = (float)o.Number("faceDeg", s.faceDeg);
                s.baseInM = (float)o.Number("baseInM", s.baseInM);
                s.beyondM = (float)o.Number("beyondM", s.beyondM);
                s.taperM = (float)o.Number("taperM", s.taperM);
                s.subdivideM = (float)o.Number("subdivideM", s.subdivideM);
                s.paintFeatherM = (float)o.Number("paintFeatherM", s.paintFeatherM);
                s.groundChannel = o.String("groundChannel") ?? s.groundChannel;
                s.stoneMaterial = o.String("stoneMaterial") ?? s.stoneMaterial;
                s.stoneMaterialChannel = o.String("stoneMaterialChannel") ?? s.stoneMaterialChannel;
                s.stoneAlbedo = o.String("stoneAlbedo") ?? s.stoneAlbedo;
                s.stoneNormal = o.String("stoneNormal") ?? s.stoneNormal;
                s.stoneTileM = (float)o.Number("stoneTileM", s.stoneTileM);
                s.paintOnly = o.Bool("paintOnly", s.paintOnly);
                s.paintInsetM = (float)o.Number("paintInsetM", s.paintInsetM);
                s.roundTopM = (float)o.Number("roundTopM", s.roundTopM);
                s.placeStones = o.Bool("placeStones", s.placeStones);
                var sc = o.Array("stoneColor");
                if (sc != null && sc.Count >= 3) s.stoneColor = new Color(F(sc[0]), F(sc[1]), F(sc[2]), 0f);
                s.style = o.String("style") ?? s.style;
                s.stoneSet = o.String("stoneSet") ?? s.stoneSet;
                s.baseCourseM = Range(o, "baseCourseM", s.baseCourseM);
                s.courseM = Range(o, "courseM", s.courseM);
                s.lengthRatio = Range(o, "lengthRatio", s.lengthRatio);
                s.depthM = Range(o, "depthM", s.depthM);
                s.maxStoneM = (float)o.Number("maxStoneM", s.maxStoneM);
                s.faceProudM = (float)o.Number("faceProudM", s.faceProudM);
                s.faceJitterM = (float)o.Number("faceJitterM", s.faceJitterM);
                s.minTopCourseM = (float)o.Number("minTopCourseM", s.minTopCourseM);
                s.jitterDeg = (float)o.Number("jitterDeg", s.jitterDeg);
                s.bedJitterM = (float)o.Number("bedJitterM", s.bedJitterM);
                s.stoneHeightVar = Range(o, "stoneHeightVar", s.stoneHeightVar);
                return s;
            }

            static Vector2 Range(GolfMapJsonObject o, string key, Vector2 fallback)
            {
                var l = o.Array(key);
                return l == null || l.Count < 2 ? fallback : new Vector2(F(l[0]), F(l[1]));
            }
        }

        internal sealed class Wall
        {
            public string id, note;
            public int seed;
            public Settings s;
            public List<Vector2> toe = new List<Vector2>(), lip = new List<Vector2>();  // scene x, z
            public List<Vector2> outline;  // cliff: the rock seen from above (painted as rock), scene x, z
            public List<Vector4> grassPatches = new List<Vector4>(); // scene x/z centre, east/north radii
            public float[] along;  // distance along the toe line at each station
            public float Length { get { return along[along.Length - 1]; } }
        }

        // A single boulder placed whole: centre, compass bearing of its long side, length, and how far its top stands
        // over the highest ground under it.
        sealed class Boulder
        {
            public string id, note;
            public Stone stone;
            public Vector2 at;  // scene x, z
            public float yawDeg, lengthM, topM;
            // pose: placed exactly as set by hand in Unity (captured into the spec): dy over the ground under its
            // centre, rotation (Euler), local scale. Kept through rebuilds; follows the ground if the meshes change.
            public bool hasPose;
            public float poseDy;
            public Vector3 poseEuler, poseScale;
        }

        // A boulder model (Blender-built FBX or prefab) measured once: its first LOD's vertices in the frame of an
        // instance at the origin with no rotation (the root's scale applied), and its longest horizontal side.
        sealed class Stone
        {
            public string path, name;
            public GameObject prefab;
            public float weight, longM;
            public bool longAlongZ, meshCollider;  // meshCollider: an FBX without one of its own
            public Color? tint;                    // drawn with copies of its materials, _Color multiplied by this
            public Dictionary<string, float> matFloats;   // ... and these float properties set (e.g. the moss amount)
            public Dictionary<string, Color> matColors;   // ... and these colour properties set
            public float heightM, depthM;          // extents up and across the long side
            public int faceSign;                   // which end of the depth axis is its flattest side (a wall stone's face)
            public Vector3[] verts;
        }

        static float F(object o, float fallback = 0f)
        {
            var n = o as GolfMapJsonNumber;
            return n == null ? fallback : (float)n.Value;
        }

        [MenuItem("GolfMap/Walls/Build stone walls")]
        static void Menu() { Debug.Log("[GolfMap Walls] " + GolfMapJson.Serialize(Build(null, null, false, 0, null), false)); }

        [MenuItem("GolfMap/Walls/Clear stone walls")]
        static void MenuClear() { Debug.Log("[GolfMap Walls] " + GolfMapJson.Serialize(Clear(null), false)); }

        [BridgeCommand("golfmap.walls.build", "Build dry-stone walls from the course's golfmap-walls-v1 spec (<course>/stone-walls.json, from docs/gspro/<course>/stone-walls.gen.py): each wall's bank, between its traced foot and top edge, faced with courses of boulders (Blender-built, the spec's stonesFolder, or prefabs), fitted to the course meshes; and the spec's single boulders, each topM over the highest ground under it. Replaces the stones of the walls and boulders it builds under 'GolfMap Walls'; the same seed + variant gives the same stones (a stone moved by hand is not kept: capture it as a pose boulder in the generator). Marks the scene dirty; save=true saves it (and the assets it changed) once the build has succeeded.",
            args = "file (default <course>/stone-walls.json), only (wall or boulder ids, comma-separated), dryRun=false (plan and counts, nothing placed), variant=0 (another random layout), profile (a wall id: its bank measured on the meshes every metre), " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return GolfMapSceneSave.After(a, Build(a.String("file"), only.Count == 0 ? null : new HashSet<string>(only), a.Bool("dryRun", false), a.Int("variant", 0), a.String("profile")));
        }

        [BridgeCommand("golfmap.walls.clear", "Delete the stones golfmap.walls.build placed ('GolfMap Walls', or only the named walls). Marks the scene dirty.", args = "only (wall ids, comma-separated), " + GolfMapSceneSave.Arg)]
        static object ClearCommand(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return GolfMapSceneSave.After(a, Clear(only.Count == 0 ? null : new HashSet<string>(only)));
        }

        static GameObject FindRoot()
        {
            return EditorSceneManager.GetActiveScene().GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
        }

        [BridgeCommand("golfmap.walls.colors", "Apply the course recipe's placedColors to existing rock groups without moving or rebuilding them.")]
        static object ApplyPlacedColors()
        {
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            var spec = GolfMapJsonDoc.ParseObject(File.ReadAllText(folder + SpecFile));
            var colors = spec.Object("placedColors");
            var root = FindRoot();
            int count = 0;
            if (colors == null || root == null) return new Dictionary<string, object> { { "renderers", count } };
            foreach (var id in colors.keys)
            {
                var group = root.transform.Find(id);
                if (group == null) continue;
                var values = colors.Array(id);
                var color = new Color(F(values[0]), F(values[1]), F(values[2]), 1);
                foreach (var r in group.GetComponentsInChildren<Renderer>(true))
                {
                    var materials = r.sharedMaterials;
                    for (int i = 0; i < materials.Length; i++)
                    {
                        var original = materials[i];
                        if (original == null || !original.HasProperty("_Color")) continue;
                        var name = original.name.Split(new[] { " (rock color " }, StringSplitOptions.None)[0];
                        var path = folder + "Walls/" + name + " (rock color " + id + ").mat";
                        var copy = AssetDatabase.LoadAssetAtPath<Material>(path);
                        if (copy == null) { copy = new Material(original); AssetDatabase.CreateAsset(copy, path); }
                        copy.SetColor("_Color", color); EditorUtility.SetDirty(copy);
                        materials[i] = copy;
                    }
                    Undo.RecordObject(r, "Match rock colors"); r.sharedMaterials = materials; count++;
                }
            }
            AssetDatabase.SaveAssets(); EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return new Dictionary<string, object> { { "renderers", count } };
        }

        static Dictionary<string, object> Clear(HashSet<string> only)
        {
            var root = FindRoot();
            int n = 0;
            if (root != null)
            {
                if (only == null)
                {
                    n = root.GetComponentsInChildren<Transform>(true).Count(t => t.name.Contains("#"));
                    Undo.DestroyObjectImmediate(root);
                }
                else
                    foreach (var t in root.transform.Cast<Transform>().Where(t => only.Contains(t.name)).ToList())
                    {
                        n += t.GetComponentsInChildren<Transform>(true).Count(c => c.name.Contains("#"));
                        Undo.DestroyObjectImmediate(t.gameObject);
                    }
                EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            }
            return new Dictionary<string, object> { { "removed", n } };
        }

        // The walls and boulders the scene has that stand on one of these course mesh objects (their bounds meet the
        // wall's bank or the boulder); null when the course has no walls spec or the scene no walls.
        internal static List<string> WallsOver(IList<GameObject> meshes)
        {
            GameObject root;
            var areas = WallAreas(out root);
            if (areas == null) return null;
            // a mesh stands under a wall when one of its vertices lies in the wall's area (its bounds alone say little:
            // a long rough or the outer deep reaches round half the course)
            var hit = new HashSet<string>();
            foreach (var g in meshes.Where(g => g != null))
            {
                var r = g.GetComponent<Renderer>();
                var f = g.GetComponent<MeshFilter>();
                if (r == null || f == null || f.sharedMesh == null) continue;
                var b = r.bounds;
                var near = areas.Where(kv => !hit.Contains(kv.Key) && root.transform.Find(kv.Key) != null &&
                    b.max.x >= kv.Value.xMin && b.min.x <= kv.Value.xMax && b.max.z >= kv.Value.yMin && b.min.z <= kv.Value.yMax).ToList();
                if (near.Count == 0) continue;
                foreach (var v in f.sharedMesh.vertices)
                {
                    var p = g.transform.TransformPoint(v);
                    foreach (var kv in near) if (kv.Value.Contains(new Vector2(p.x, p.z))) hit.Add(kv.Key);
                    if (near.All(kv => hit.Contains(kv.Key))) break;
                }
            }
            return hit.OrderBy(x => x, StringComparer.Ordinal).ToList();
        }

        // The walls and boulders the scene has whose area meets one of these world XZ boxes (golfmap.course.refresh only=
        // plans with it for meshes not in the scene yet: their bounds from the FBX or the shaping report); null as WallsOver.
        internal static List<string> WallsIn(IList<Rect> boxes)
        {
            GameObject root;
            var areas = WallAreas(out root);
            if (areas == null) return null;
            return areas.Where(kv => root.transform.Find(kv.Key) != null && boxes.Any(b => b.Overlaps(kv.Value)))
                .Select(kv => kv.Key).OrderBy(x => x, StringComparer.Ordinal).ToList();
        }

        // Each wall's bank (foot and top edge, +3 m) and each boulder's footprint (+1 m), world XZ, by id; null when the
        // course has no walls spec or the scene no walls.
        static Dictionary<string, Rect> WallAreas(out GameObject root)
        {
            root = FindRoot();
            if (root == null) return null;
            var course = GolfMapCourses.Require();
            var file = GolfMapCourses.Folder(course) + SpecFile;
            if (!File.Exists(file)) return null;
            var spec = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            double e0, n0; Vector3 origin;
            GolfMapProps.Frame(course, out e0, out n0, out origin);
            var areas = new Dictionary<string, Rect>();
            foreach (var w in ReadWalls(spec, file, e0, n0, origin))
            {
                float x0 = float.MaxValue, z0 = float.MaxValue, x1 = float.MinValue, z1 = float.MinValue;
                foreach (var p in w.toe.Concat(w.lip)) { x0 = Mathf.Min(x0, p.x); z0 = Mathf.Min(z0, p.y); x1 = Mathf.Max(x1, p.x); z1 = Mathf.Max(z1, p.y); }
                areas[w.id] = Rect.MinMaxRect(x0 - 3f, z0 - 3f, x1 + 3f, z1 + 3f);
            }
            foreach (var bo in (spec.Array("boulders") ?? new List<object>()).Cast<GolfMapJsonObject>())
            {
                var at = Scene(new List<object> { bo["e"], bo["n"] }, e0, n0, origin);
                float r = (float)bo.Number("lengthM", 1) / 2 + 1f;
                areas[bo.String("id")] = Rect.MinMaxRect(at.x - r, at.y - r, at.x + r, at.y + r);
            }
            return areas;
        }

        // After golfmap.meshes.sync replaced or added course meshes (and the paint reshaped their ground): build again the
        // walls and boulders standing on them, so their stones meet the new meshes. Walls elsewhere keep their stones, hand
        // edits included; a wall never built in this scene is not started. Null when there are no walls.
        internal static Dictionary<string, object> RebuildOver(IList<GameObject> changed)
        {
            var ids = WallsOver(changed);
            if (ids == null) return null;
            if (ids.Count == 0) return new Dictionary<string, object> { { "rebuilt", new List<object>() } };
            var built = Build(null, new HashSet<string>(ids), false, 0, null, false);
            return new Dictionary<string, object> { { "rebuilt", ids.Cast<object>().ToList() }, { "placed", built["placed"] }, { "report", built["report"] } };
        }

        // ---- spec ------------------------------------------------------------------------------

        // stones: [{asset, weight}] from the Blender-built props folder `stonesFolder` (under the course folder; its
        // props.json manifest gives the materials and colliders), or [{prefab, weight}] for a Unity prefab.
        // boulders: [{id, asset|prefab, e, n, yawDeg, lengthM, topM}], single stones placed whole.
        static void Load(string courseFolder, string path, double e0, double n0, Vector3 origin, out Dictionary<string, List<Stone>> stones, out List<Wall> walls, out List<Boulder> boulders)
        {
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            if (root.String("format") != Format) throw new InvalidOperationException(path + " is not " + Format + ".");
            walls = ReadWalls(root, path, e0, n0, origin);
            physics = LoadPhysics(root, path);
            Dictionary<string, GameObject> models = null;
            Dictionary<string, string> colliders = null;
            var folder = root.String("stonesFolder");
            if (!string.IsNullOrEmpty(folder)) models = GolfMapProps.PrepareModels(courseFolder + folder, out colliders);
            Func<GolfMapJsonObject, Stone> resolve = so =>
            {
                var id = so.String("asset");
                GameObject model;
                if (id == null) model = AssetDatabase.LoadAssetAtPath<GameObject>(so.String("prefab") ?? "");
                else if (models == null || !models.TryGetValue(id, out model)) throw new InvalidOperationException(path + ": stone asset " + id + " is not in " + (folder ?? "(no stonesFolder)"));
                if (model == null) throw new InvalidOperationException(path + ": missing stone prefab " + so.String("prefab"));
                var st = Measure(model, (float)so.Number("weight", 1));
                st.meshCollider = id != null && colliders[id] == "mesh";
                var tint = so.Array("tint");
                if (tint != null && tint.Count >= 3) st.tint = new Color(F(tint[0]), F(tint[1]), F(tint[2]), 1f);
                var mfl = so.Object("materialFloats");
                if (mfl != null) { st.matFloats = new Dictionary<string, float>(); foreach (var k in mfl.keys) st.matFloats[k] = (float)mfl.Number(k); }
                var mco = so.Object("materialColors");
                if (mco != null)
                {
                    st.matColors = new Dictionary<string, Color>();
                    foreach (var k in mco.keys) { var c = mco.Array(k); st.matColors[k] = new Color(F(c[0]), F(c[1]), F(c[2]), c.Count > 3 ? F(c[3]) : 1f); }
                }
                return st;
            };
            // stoneSets: {name: [stones]}; a plain `stones` list is the set "default"
            stones = new Dictionary<string, List<Stone>>();
            var sets = root.Object("stoneSets");
            if (sets != null) foreach (var k in sets.keys) stones[k] = sets.Array(k).Cast<GolfMapJsonObject>().Select(resolve).ToList();
            if (root.Array("stones") != null) stones["default"] = root.Array("stones").Cast<GolfMapJsonObject>().Select(resolve).ToList();
            foreach (var wall in walls)
            {
                List<Stone> set;
                if (!stones.TryGetValue(wall.s.stoneSet, out set) || set.Count == 0)
                    throw new InvalidOperationException(path + ": wall " + wall.id + " uses stone set '" + wall.s.stoneSet + "', which lists no stones.");
            }
            boulders = new List<Boulder>();
            foreach (var bo in (root.Array("boulders") ?? new List<object>()).Cast<GolfMapJsonObject>())
            {
                var b = new Boulder
                {
                    id = bo.String("id"), note = bo.String("note"), stone = resolve(bo),
                    at = Scene(new List<object> { bo["e"], bo["n"] }, e0, n0, origin),
                    yawDeg = (float)bo.Number("yawDeg", 0), lengthM = (float)bo.Number("lengthM", 1), topM = (float)bo.Number("topM", 0.5),
                };
                var pose = bo.Object("pose");
                if (pose != null)
                {
                    b.hasPose = true;
                    b.poseDy = (float)pose.Number("dy", 0);
                    var eu = pose.Array("euler"); var sc = pose.Array("scale");
                    b.poseEuler = eu != null && eu.Count >= 3 ? new Vector3(F(eu[0]), F(eu[1]), F(eu[2])) : Vector3.zero;
                    b.poseScale = sc != null && sc.Count >= 3 ? new Vector3(F(sc[0]), F(sc[1]), F(sc[2])) : Vector3.one;
                }
                if (string.IsNullOrEmpty(b.id)) throw new InvalidOperationException(path + ": a boulder has no id.");
                boulders.Add(b);
            }
        }

        // The course's walls (scene x/z stations and settings) without their stones, or null when it has no walls spec.
        internal static List<Wall> LoadWalls(GolfMapCourse course)
        {
            var path = GolfMapCourses.Folder(course) + SpecFile;
            if (!File.Exists(path)) return null;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            if (root.String("format") != Format) throw new InvalidOperationException(path + " is not " + Format + ".");
            double e0, n0; Vector3 origin;
            GolfMapProps.Frame(course, out e0, out n0, out origin);
            return ReadWalls(root, path, e0, n0, origin);
        }

        static List<Wall> ReadWalls(GolfMapJsonObject root, string path, double e0, double n0, Vector3 origin)
        {
            var defaults = new Settings().Over(root.Object("defaults"));
            var styles = root.Object("styles");
            var walls = new List<Wall>();
            foreach (var wo in (root.Array("walls") ?? new List<object>()).Cast<GolfMapJsonObject>())
            {
                var style = wo.String("style") ?? defaults.style;
                var preset = styles == null ? null : styles.Object(style);
                if (styles != null && preset == null) throw new InvalidOperationException(path + ": wall " + wo.String("id") + " has style '" + style + "', which `styles` does not define.");
                var ws = defaults.Over(preset).Over(wo);
                ws.style = style;
                if (style != "rose" && style != "wall" && style != "cliff") throw new InvalidOperationException(path + ": wall " + wo.String("id") + ": style must be rose, wall or cliff.");
                var w = new Wall { id = wo.String("id"), note = wo.String("note"), seed = (int)wo.Number("seed", 1), s = ws };
                var ol = wo.Array("outline");
                if (ol != null) w.outline = ol.Cast<List<object>>().Select(q => Scene(q, e0, n0, origin)).ToList();
                var patches = wo.Array("grassPatches");
                if (patches != null) foreach (var q in patches.Cast<List<object>>())
                {
                    var p = Scene(q, e0, n0, origin);
                    float rx = F(q[2]), rz = q.Count > 3 ? F(q[3]) : rx;
                    if (rx <= 0 || rz <= 0) throw new InvalidOperationException("Grass patch radii must be positive.");
                    w.grassPatches.Add(new Vector4(p.x, p.y, rx, rz));
                }
                if (string.IsNullOrEmpty(w.id)) throw new InvalidOperationException(path + ": a wall has no id.");
                var toe = wo.Array("toe");
                var lip = wo.Array("lip");
                if (toe == null || lip == null || toe.Count != lip.Count || toe.Count < 2)
                    throw new InvalidOperationException(path + ": wall " + w.id + " needs toe and lip with the same number (>= 2) of stations.");
                for (int i = 0; i < toe.Count; i++)
                {
                    w.toe.Add(Scene((List<object>)toe[i], e0, n0, origin));
                    w.lip.Add(Scene((List<object>)lip[i], e0, n0, origin));
                }
                w.along = new float[w.toe.Count];
                for (int i = 1; i < w.toe.Count; i++) w.along[i] = w.along[i - 1] + Vector2.Distance(w.toe[i - 1], w.toe[i]);
                walls.Add(w);
            }
            return walls;
        }

        static Vector2 Scene(List<object> en, double e0, double n0, Vector3 origin)
        {
            return new Vector2((float)(((GolfMapJsonNumber)en[0]).Value - e0) + origin.x, (float)(((GolfMapJsonNumber)en[1]).Value - n0) + origin.z);
        }

        static Stone Measure(GameObject pf, float weight)
        {
            var path = AssetDatabase.GetAssetPath(pf);
            var lod = pf.GetComponentInChildren<LODGroup>();
            var lods = lod == null ? null : lod.GetLODs();
            IEnumerable<Renderer> rs = lods != null && lods.Length > 0 ? lods[0].renderers.Where(r => r != null) : pf.GetComponentsInChildren<MeshRenderer>().Cast<Renderer>();
            var toRoot = Matrix4x4.Scale(pf.transform.localScale) * pf.transform.worldToLocalMatrix;
            var verts = new List<Vector3>();
            foreach (var r in rs)
            {
                var mf = r.GetComponent<MeshFilter>();
                if (mf == null || mf.sharedMesh == null) continue;
                var m = toRoot * r.transform.localToWorldMatrix;
                verts.AddRange(mf.sharedMesh.vertices.Select(v => m.MultiplyPoint3x4(v)));
            }
            if (verts.Count == 0) throw new InvalidOperationException("Stone prefab " + path + " has no mesh.");
            float sx = verts.Max(v => v.x) - verts.Min(v => v.x), sz = verts.Max(v => v.z) - verts.Min(v => v.z);
            bool longZ = sz > sx;
            // the face: the end of the depth axis where more of the surface lies within 4 % of the extreme (flat)
            Func<Vector3, float> depthOf = v => longZ ? v.x : v.z;
            float dMin = verts.Min(depthOf), dMax = verts.Max(depthOf), band = 0.04f * (dMax - dMin);
            int nearMax = verts.Count(v => depthOf(v) > dMax - band), nearMin = verts.Count(v => depthOf(v) < dMin + band);
            // every vertex is not needed for extents; keep at most ~2000
            int step = Math.Max(1, verts.Count / 2000);
            return new Stone
            {
                path = path, name = pf.name, prefab = pf, weight = Math.Max(0.01f, weight),
                longAlongZ = longZ, longM = Math.Max(sx, sz), depthM = Math.Min(sx, sz),
                heightM = verts.Max(v => v.y) - verts.Min(v => v.y), faceSign = nearMax >= nearMin ? 1 : -1,
                verts = verts.Where((v, i) => i % step == 0).ToArray(),
            };
        }

        // ---- the bank --------------------------------------------------------------------------

        // The highest course mesh under (x, z), else the highest terrain: what the player stands on. Stones, trees,
        // props and water planes do not count.
        static float? Ground(float x, float z)
        {
            var hits = Physics.RaycastAll(new Ray(new Vector3(x, 5000f, z), Vector3.down), 10000f, ~0, QueryTriggerInteraction.Ignore);
            float? mesh = null, terrain = null;
            foreach (var h in hits)
            {
                if (h.collider is TerrainCollider) { if (terrain == null || h.point.y > terrain.Value) terrain = h.point.y; }
                else if (GolfMapSurfaces.IsCourseMesh(h.collider.name) && (mesh == null || h.point.y > mesh.Value)) mesh = h.point.y;
            }
            return mesh ?? terrain;
        }

        // The bank across the wall at distance s along its foot: the foot, the direction along the wall and into the
        // bank (both horizontal), the ground at the foot, the height of the lip over it, and the ground profile
        // from the foot to the lip (every 0.1 m) for finding where the bank reaches a height.
        sealed class Bank
        {
            public Vector2 toe, along, inward;
            public float depth, groundAtToe, height;
            public float[] rise;  // ground above the foot, every 0.1 m inwards

            public float At(float z)  // how far in from the foot the bank reaches height z
            {
                for (int i = 0; i < rise.Length; i++) if (rise[i] >= z) return i * 0.1f;
                return depth;
            }

            public float Rise(float t)  // the bank's height t in from the foot (the lip's beyond it)
            {
                return rise[Mathf.Clamp(Mathf.RoundToInt(t / 0.1f), 0, rise.Length - 1)];
            }
        }

        static Bank BankAt(Wall w, float s)
        {
            s = Mathf.Clamp(s, 0f, w.Length);
            int i = 0;
            while (i < w.along.Length - 2 && w.along[i + 1] < s) i++;
            float seg = w.along[i + 1] - w.along[i];
            float f = seg > 1e-4f ? (s - w.along[i]) / seg : 0f;
            var b = new Bank { toe = Vector2.Lerp(w.toe[i], w.toe[i + 1], f) };
            var lip = Vector2.Lerp(w.lip[i], w.lip[i + 1], f);
            // along: over a metre or so either side, so one short segment does not swing the stones round
            int i0 = Math.Max(0, i - 2), i1 = Math.Min(w.toe.Count - 1, i + 3);
            b.along = (w.toe[i1] - w.toe[i0]).normalized;
            var into = lip - b.toe;
            b.depth = into.magnitude;
            b.inward = b.depth > 1e-3f ? into / b.depth : new Vector2(-b.along.y, b.along.x);
            var g0 = Ground(b.toe.x, b.toe.y);
            b.groundAtToe = g0 ?? 0f;
            int n = Mathf.CeilToInt(b.depth / 0.1f) + 1;
            b.rise = new float[n];
            for (int k = 0; k < n; k++)
            {
                var p = b.toe + b.inward * Mathf.Min(k * 0.1f, b.depth);
                var g = Ground(p.x, p.y);
                b.rise[k] = (g ?? b.groundAtToe) - b.groundAtToe;
                if (k > 0) b.rise[k] = Mathf.Max(b.rise[k], b.rise[k - 1]);  // monotone: a dip in the bank is not the lip
            }
            b.height = g0 == null ? 0f : b.rise[n - 1];
            return b;
        }

        // ---- build -----------------------------------------------------------------------------

        sealed class Placement
        {
            public Stone stone;
            public Vector3 position, scale;
            public Quaternion rotation;
            public int course, fill;  // fill: 0 = the front row, 1.. = set in behind it
            public bool absoluteScale;  // scale is the local scale itself, not a factor on the prefab's
            public float along, bankHeight, stoneHeight;
        }

        public static Dictionary<string, object> Build(string file, HashSet<string> only, bool dryRun, int variant, string profile, bool runPaint = true)
        {
            var course = GolfMapCourses.Require();
            // read from the course now: importing the stones saves assets, which can leave `course` without a path
            var courseFolder = GolfMapCourses.Folder(course);
            var report = GolfMapCourses.ReportPath(course, "walls.txt");
            file = string.IsNullOrEmpty(file) ? courseFolder + SpecFile : file;
            if (!File.Exists(file)) throw new InvalidOperationException("No walls spec at " + file + ": run docs/gspro/<course>/stone-walls.gen.py --out <course folder>.");
            double e0, n0; Vector3 origin;
            GolfMapProps.Frame(course, out e0, out n0, out origin);
            Dictionary<string, List<Stone>> stones; List<Wall> walls;
            List<Boulder> boulders;
            Load(courseFolder, file, e0, n0, origin, out stones, out walls, out boulders);
            var ids = walls.Select(w => w.id).Concat(boulders.Select(b => b.id)).ToList();
            if (only != null)
            {
                var unknown = only.Where(id => !ids.Contains(id)).ToList();
                if (unknown.Count > 0) throw new InvalidOperationException("No wall " + string.Join(", ", unknown.ToArray()) + " in " + file);
            }
            var result = new Dictionary<string, object> { { "spec", file }, { "dryRun", dryRun }, { "variant", variant } };
            tintFolder = courseFolder + "Walls/Materials";
            // walls with ground: the course meshes on their banks reshaped (and painted) first, through the vertex
            // paint, which also redoes it after every mesh sync
            if (runPaint && !dryRun && string.IsNullOrEmpty(profile) && walls.Any(w => w.s.ground))
            {
                var paint = GolfMapVertexPaint.Apply(false);
                result["ground"] = paint.ContainsKey("ground") ? paint["ground"] : null;
                var errors = paint["errors"] as List<string>;
                if (errors != null && errors.Count > 0) result["paintErrors"] = errors;
            }
            Physics.SyncTransforms();

            if (!string.IsNullOrEmpty(profile))
            {
                var w = walls.FirstOrDefault(x => x.id == profile);
                if (w == null) throw new InvalidOperationException("No wall " + profile + " in " + file);
                var rows = new List<object>();
                for (float s = 0; s <= w.Length; s += 1f)
                {
                    var b = BankAt(w, s);
                    rows.Add(new Dictionary<string, object> {
                        { "s", s }, { "x", b.toe.x }, { "z", b.toe.y }, { "ground", b.groundAtToe }, { "height", b.height }, { "depth", b.depth },
                        { "halfHeightIn", b.At(b.height / 2) } });
                }
                result["profile"] = rows;
                return result;
            }

            var root = FindRoot();
            if (!dryRun)
            {
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Build stone walls");
                if (root == null) { root = new GameObject(RootName); Undo.RegisterCreatedObjectUndo(root, "Build stone walls"); }
            }
            var sb = new StringBuilder();
            sb.AppendLine("GolfMap walls: " + file + "  variant " + variant + "  " + DateTime.Now.ToString("s"));
            var wallRows = new List<object>();
            int placed = 0;
            foreach (var w in walls)
            {
                if (only != null && !only.Contains(w.id)) continue;
                if (w.s.paintOnly || !w.s.placeStones) continue; // exposed ground beneath separately placed outcrop rocks
                var set = stones[w.s.stoneSet];
                var plan = w.s.style == "wall" || w.s.style == "cliff" ? PlanWall(w, set, variant) : Plan(w, set, variant);
                var heights = Enumerable.Range(0, Mathf.FloorToInt(w.Length) + 1).Select(s => BankAt(w, s).height).ToList();
                var perCourse = plan.GroupBy(p => p.course).OrderBy(g => g.Key).Select(g => g.Count()).ToArray();
                wallRows.Add(new Dictionary<string, object> {
                    { "id", w.id }, { "lengthM", Math.Round(w.Length, 1) }, { "bankM", new[] { Math.Round(heights.Min(), 2), Math.Round(heights.Max(), 2) } },
                    { "stones", plan.Count }, { "perCourse", perCourse }, { "filledBehind", plan.Count(p => p.fill > 0) },
                    { "byPrefab", plan.GroupBy(p => p.stone.name).OrderBy(g => g.Key).ToDictionary(g => g.Key, g => (object)g.Count()) } });
                sb.AppendLine(string.Format("{0}: {1:F1} m, bank {2:F2}-{3:F2} m, {4} stones, per course {5}", w.id, w.Length, heights.Min(), heights.Max(), plan.Count, string.Join("/", perCourse.Select(c => c.ToString()).ToArray())));
                foreach (var p in plan)
                    sb.AppendLine(string.Format("  c{0}{1} s {2,5:F2}  {3,-24} h {4:F2}  bank {5:F2}  at {6:F2} {7:F2} {8:F2}", p.course, p.fill == 0 ? "  " : "+" + p.fill, p.along, p.stone.name, p.stoneHeight, p.bankHeight, p.position.x, p.position.y, p.position.z));
                if (dryRun) continue;

                var wt = root.transform.Find(w.id);
                if (wt != null) Undo.DestroyObjectImmediate(wt.gameObject);
                var wg = new GameObject(w.id);
                Undo.RegisterCreatedObjectUndo(wg, "Build stone walls");
                wg.transform.SetParent(root.transform, false);
                int n = 0;
                foreach (var p in plan) Instantiate(p, wg.transform, p.stone.name + "#" + n++);
                placed += n;
            }
            var boulderRows = new List<object>();
            foreach (var bd in boulders)
            {
                if (only != null && !only.Contains(bd.id)) continue;
                var st = bd.stone;
                if (bd.hasPose)
                {
                    var g0 = Ground(bd.at.x, bd.at.y);
                    if (g0 == null) throw new InvalidOperationException("Boulder " + bd.id + ": nothing to stand on.");
                    var pp = new Vector3(bd.at.x, g0.Value + bd.poseDy, bd.at.y);
                    boulderRows.Add(new Dictionary<string, object> { { "id", bd.id }, { "model", st.name }, { "pose", true }, { "y", Math.Round(pp.y, 2) } });
                    sb.AppendLine(string.Format("{0}: {1} as set by hand, {2:F2} m over the ground  at {3:F2} {4:F2} {5:F2}", bd.id, st.name, bd.poseDy, pp.x, pp.y, pp.z));
                    if (dryRun) continue;
                    var pt = root.transform.Find(bd.id);
                    if (pt != null) Undo.DestroyObjectImmediate(pt.gameObject);
                    var pg = new GameObject(bd.id);
                    Undo.RegisterCreatedObjectUndo(pg, "Build stone walls");
                    pg.transform.SetParent(root.transform, false);
                    Instantiate(new Placement { stone = st, position = pp, rotation = Quaternion.Euler(bd.poseEuler), scale = bd.poseScale, absoluteScale = true }, pg.transform, st.name + "#0");
                    placed++;
                    continue;
                }
                var scale = Vector3.one * (bd.lengthM / st.longM);
                var rot = Quaternion.Euler(0f, bd.yawDeg + (st.longAlongZ ? 0f : -90f), 0f);
                // its top topM over the highest ground under it (the ground under every vertex)
                float ymax = float.MinValue, groundMax = float.MinValue, groundMin = float.MaxValue;
                foreach (var v in st.verts)
                {
                    var p = rot * Vector3.Scale(v, scale);
                    ymax = Mathf.Max(ymax, p.y);
                    var g = Ground(bd.at.x + p.x, bd.at.y + p.z);
                    if (g == null) continue;
                    groundMax = Mathf.Max(groundMax, g.Value);
                    groundMin = Mathf.Min(groundMin, g.Value);
                }
                if (groundMax == float.MinValue) throw new InvalidOperationException("Boulder " + bd.id + ": nothing to stand on.");
                var pos = new Vector3(bd.at.x, groundMax + bd.topM - ymax, bd.at.y);
                boulderRows.Add(new Dictionary<string, object> {
                    { "id", bd.id }, { "model", st.name }, { "top", Math.Round(groundMax + bd.topM, 2) }, { "groundUnder", new[] { Math.Round(groundMin, 2), Math.Round(groundMax, 2) } } });
                sb.AppendLine(string.Format("{0}: {1} {2:F1} m, top {3:F2} (ground under it {4:F2}-{5:F2})  at {6:F2} {7:F2} {8:F2}", bd.id, st.name, bd.lengthM, groundMax + bd.topM, groundMin, groundMax, pos.x, pos.y, pos.z));
                if (dryRun) continue;
                var bt = root.transform.Find(bd.id);
                if (bt != null) Undo.DestroyObjectImmediate(bt.gameObject);
                var bg = new GameObject(bd.id);
                Undo.RegisterCreatedObjectUndo(bg, "Build stone walls");
                bg.transform.SetParent(root.transform, false);
                Instantiate(new Placement { stone = st, position = pos, rotation = rot, scale = scale }, bg.transform, st.name + "#0");
                placed++;
            }
            if (!dryRun && only == null)
                foreach (var t in root.transform.Cast<Transform>().Where(t => !ids.Contains(t.name)).ToList())
                {
                    sb.AppendLine("removed stale " + t.name);
                    Undo.DestroyObjectImmediate(t.gameObject);
                }
            File.WriteAllText(report, sb.ToString());
            if (!dryRun) EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            result["walls"] = wallRows;
            result["boulders"] = boulderRows;
            result["placed"] = placed;
            result["report"] = report;
            if (!dryRun) result["colors"] = ApplyPlacedColors();
            return result;
        }

        // A stone picked, sized and turned for a spot on the wall, and its extents from its pivot along the wall,
        // into the bank and up.
        sealed class Shaped
        {
            public Stone stone;
            public Quaternion rotation;
            public Vector3 scale;
            public float amin, amax, umin, umax, ymin, ymax;
            public float Width { get { return amax - amin; } }
            public float Depth { get { return umax - umin; } }
            public float Height { get { return ymax - ymin; } }
        }

        static void Instantiate(Placement p, Transform parent, string name)
        {
            var go = (GameObject)PrefabUtility.InstantiatePrefab(p.stone.prefab);
            Undo.RegisterCreatedObjectUndo(go, "Build stone walls");
            go.name = name;
            go.transform.SetParent(parent, false);
            go.transform.position = p.position;
            go.transform.rotation = p.rotation;
            go.transform.localScale = p.absoluteScale ? p.scale : Vector3.Scale(p.stone.prefab.transform.localScale, p.scale);
            if (p.stone.tint.HasValue || p.stone.matFloats != null || p.stone.matColors != null)
                foreach (var r in go.GetComponentsInChildren<Renderer>(true))
                    r.sharedMaterials = r.sharedMaterials.Select(m => Tinted(m, p.stone)).ToArray();
            if (p.stone.meshCollider)
                foreach (var mf in go.GetComponentsInChildren<MeshFilter>()) mf.gameObject.AddComponent<MeshCollider>().sharedMesh = mf.sharedMesh;
            if (physics != null) foreach (var c in go.GetComponentsInChildren<Collider>(true)) c.sharedMaterial = physics;
            foreach (var t in go.GetComponentsInChildren<Transform>(true))
                GameObjectUtility.SetStaticEditorFlags(t.gameObject, StaticEditorFlags.BatchingStatic | StaticEditorFlags.OccludeeStatic | StaticEditorFlags.OccluderStatic | StaticEditorFlags.ReflectionProbeStatic);
        }

        // A pack's material with its _Color multiplied by `tint`: a course-local copy under <course>/Walls/Materials/, made
        // once per material and tint and then kept (its other settings stay the pack's). The pack's own stay untouched.
        static string tintFolder;
        static readonly Dictionary<string, Material> tinted = new Dictionary<string, Material>();
        static Material Tinted(Material m, Stone st)
        {
            if (m == null || tintFolder == null) return m;
            var tint = st.tint ?? Color.white;
            var key = new StringBuilder(ColorUtility.ToHtmlStringRGB(tint));
            if (st.matFloats != null) foreach (var kv in st.matFloats.OrderBy(k => k.Key, StringComparer.Ordinal)) key.Append(";" + kv.Key + "=" + kv.Value.ToString("R", System.Globalization.CultureInfo.InvariantCulture));
            if (st.matColors != null) foreach (var kv in st.matColors.OrderBy(k => k.Key, StringComparer.Ordinal)) key.Append(";" + kv.Key + "=" + ColorUtility.ToHtmlStringRGBA(kv.Value));
            var suffix = st.matFloats == null && st.matColors == null ? ColorUtility.ToHtmlStringRGB(tint) : ShortHash(key.ToString());
            var path = tintFolder + "/" + m.name + " x" + suffix + ".mat";
            Material t;
            if (tinted.TryGetValue(path, out t) && t != null) return t;
            t = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (t == null)
            {
                if (!AssetDatabase.IsValidFolder(tintFolder)) AssetDatabase.CreateFolder(tintFolder.Substring(0, tintFolder.LastIndexOf('/')), "Materials");
                t = new Material(m) { name = m.name + " x" + suffix };
                AssetDatabase.CreateAsset(t, path);
            }
            else { t.shader = m.shader; t.CopyPropertiesFromMaterial(m); }   // the spec wins: rebuilt from the pack's material
            if (m.HasProperty("_Color")) { var c = m.GetColor("_Color"); t.SetColor("_Color", new Color(c.r * tint.r, c.g * tint.g, c.b * tint.b, c.a)); }
            if (st.matFloats != null) foreach (var kv in st.matFloats) if (t.HasProperty(kv.Key)) t.SetFloat(kv.Key, kv.Value);
            if (st.matColors != null) foreach (var kv in st.matColors) if (t.HasProperty(kv.Key)) t.SetColor(kv.Key, kv.Value);
            EditorUtility.SetDirty(t);
            tinted[path] = t;
            return t;
        }

        static string ShortHash(string text)
        {
            uint h = 2166136261;
            foreach (var ch in text) { h ^= ch; h *= 16777619; }
            return h.ToString("X8").Substring(0, 6);
        }

        // The GSPro physics material stone colliders get (the spec's physicMaterial, e.g. GSPstone): GSPro reads the
        // ball's bounce and roll off the collider's material, as on the course meshes (GSPrough, GSPfairway ...).
        static PhysicMaterial physics;

        [BridgeCommand("golfmap.walls.colliders", "Give every collider under 'GolfMap Walls' the walls spec's physicMaterial (GSPro reads bounce and roll off it; the course meshes carry GSPrough, GSPfairway ...). Counts colliders per wall. Marks the scene dirty.", args = "")]
        static object CollidersCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var file = GolfMapCourses.Folder(course) + SpecFile;
            var spec = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            var mat = LoadPhysics(spec, file);
            var root = FindRoot();
            var rows = new Dictionary<string, object>();
            if (root == null || mat == null) return new Dictionary<string, object> { { "physicMaterial", mat == null ? null : mat.name }, { "walls", rows } };
            foreach (Transform w in root.transform)
            {
                var cs = w.GetComponentsInChildren<Collider>(true);
                foreach (var c in cs) if (c.sharedMaterial != mat) { Undo.RecordObject(c, "Wall colliders"); c.sharedMaterial = mat; }
                rows[w.name] = cs.Length;
            }
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return new Dictionary<string, object> { { "physicMaterial", mat.name }, { "walls", rows } };
        }

        static PhysicMaterial LoadPhysics(GolfMapJsonObject spec, string path)
        {
            var p = spec.String("physicMaterial");
            if (string.IsNullOrEmpty(p)) return null;
            var m = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(p);
            if (m == null) throw new InvalidOperationException(path + ": physicMaterial " + p + " is not a PhysicMaterial.");
            return m;
        }

        // A stone turned and sized for a wall: its extents from its pivot along the wall, along the face's outward
        // normal (the face: the largest) and up the face.
        sealed class Fitted
        {
            public Quaternion rotation;
            public Vector3 scale;
            public float amin, amax, face, emin, emax;
            public float Width { get { return amax - amin; } }
            public float Rise { get { return emax - emin; } }
        }

        static Fitted Fit(Stone st, Quaternion rot, Vector3 scale, Vector3 along, Vector3 normal, Vector3 upFace)
        {
            var o = new Fitted { rotation = rot, scale = scale, amin = float.MaxValue, amax = float.MinValue, face = float.MinValue, emin = float.MaxValue, emax = float.MinValue };
            foreach (var v in st.verts)
            {
                var p = rot * Vector3.Scale(v, scale);
                float pa = Vector3.Dot(p, along), pn = Vector3.Dot(p, normal), pe = Vector3.Dot(p, upFace);
                o.amin = Mathf.Min(o.amin, pa); o.amax = Mathf.Max(o.amax, pa);
                o.face = Mathf.Max(o.face, pn);
                o.emin = Mathf.Min(o.emin, pe); o.emax = Mathf.Max(o.emax, pe);
            }
            return o;
        }

        // A dry-stone wall: courses up the face, each a run of wall stones of about the course's height and 1.3-2.6
        // times as long, their flattest side out and set faceProudM (give or take faceJitterM) proud of the face's
        // plane: faceDeg from the horizontal, rising from baseInM in from the foot (the plane the ground reshaping
        // builds). Beds follow the batter. The top course is cut down to end capM over the plateau, or left out
        // where that leaves less than minTopCourseM; the reshaped face, painted stone, shows there.
        // A cliff (style "cliff", a klippa) is built the same way from big angular blocks, but its ground was
        // sharpened through the bank's mid-height point with the face angle varying along it (GolfMapWallGround), so
        // each block's plane is moved in or out to meet the sharpened mesh at the block's mid height.
        static List<Placement> PlanWall(Wall w, List<Stone> stones, int variant)
        {
            var s = w.s;
            var rnd = new System.Random(w.seed * 7919 + variant);
            Func<float, float, float> range = (a, b) => a + (float)rnd.NextDouble() * (b - a);
            float total = stones.Sum(x => x.weight);
            Func<Stone> pick = () =>
            {
                float r = (float)rnd.NextDouble() * total;
                foreach (var x in stones) { r -= x.weight; if (r <= 0) return x; }
                return stones[stones.Count - 1];
            };
            float F = Mathf.Clamp(s.faceDeg, 30f, 89f) * Mathf.Deg2Rad, sinF = Mathf.Sin(F), cosF = Mathf.Cos(F);
            float highest = 0f;
            for (float s0 = 0; s0 <= w.Length; s0 += 1f) highest = Mathf.Max(highest, BankAt(w, s0).height);
            var plan = new List<Placement>();
            float q = -s.sinkM / sinF;  // the course's bed, up the face from its foot
            for (int k = 0; q < (highest - s.topMarginM) / sinF && k < 40; k++)
            {
                var hr = k == 0 ? s.baseCourseM : s.courseM;
                float hc = range(hr.x, hr.y);
                float cursor = -range(0f, 0.6f);  // joints do not line up course to course
                while (cursor < w.Length)
                {
                    var st = pick();
                    float h = hc * range(s.stoneHeightVar.x, s.stoneHeightVar.y);
                    float qs = q + range(-s.bedJitterM, s.bedJitterM);  // beds not in one line
                    float len = Mathf.Min(s.maxStoneM, h * range(s.lengthRatio.x, s.lengthRatio.y));
                    float depth = range(s.depthM.x, s.depthM.y);
                    var guess = BankAt(w, cursor + len / 2);
                    var along = new Vector3(guess.along.x, 0f, guess.along.y).normalized;
                    var inward = new Vector3(guess.inward.x, 0f, guess.inward.y).normalized;
                    var normal = -inward * sinF + Vector3.up * cosF;    // the face's outward normal
                    var upFace = inward * cosF + Vector3.up * sinF;     // up the face
                    var faceLocal = st.longAlongZ ? new Vector3(st.faceSign, 0f, 0f) : new Vector3(0f, 0f, st.faceSign);
                    var rot = Quaternion.LookRotation(normal, upFace) * Quaternion.Inverse(Quaternion.LookRotation(faceLocal, Vector3.up));
                    rot = Quaternion.AngleAxis(range(-s.spinDeg, s.spinDeg), normal) * Quaternion.AngleAxis(range(-s.spinDeg, s.spinDeg), along)
                        * Quaternion.AngleAxis(range(-s.spinDeg, s.spinDeg), upFace) * rot;
                    Func<float, Vector3> scaleFor = height =>
                    {
                        float sl = len / st.longM, sh = height / st.heightM, sd = depth / st.depthM;
                        return st.longAlongZ ? new Vector3(sd, sh, sl) : new Vector3(sl, sh, sd);
                    };
                    var o = Fit(st, rot, scaleFor(h), along, normal, upFace);
                    float centre = cursor + o.Width / 2;
                    cursor += o.Width + s.gapM + range(0f, 0.03f);
                    if (centre < 0f || centre > w.Length) continue;
                    var b = BankAt(w, centre);
                    float top = b.height / sinF;  // the plateau, up the face
                    if (b.height < s.minFaceM || q > top - s.topMarginM / sinF) continue;
                    float room = top + s.capM / sinF - qs;
                    if (o.Rise > room)
                    {
                        if (room < s.minTopCourseM) continue;
                        o = Fit(st, rot, scaleFor(h * room / o.Rise), along, normal, upFace);
                    }
                    float proud = s.faceProudM + range(-s.faceJitterM, s.faceJitterM);
                    float t0 = s.baseInM;
                    if (s.style == "cliff")
                    {
                        float qm = qs + o.Rise / 2;
                        t0 = b.At(Mathf.Clamp(qm * sinF, 0f, b.height)) - qm * cosF;
                    }
                    var origin = new Vector3(b.toe.x, b.groundAtToe, b.toe.y) + new Vector3(b.inward.x, 0f, b.inward.y).normalized * t0;
                    var pos = origin - along * ((o.amin + o.amax) / 2) + normal * (proud - o.face) + upFace * (qs - o.emin);
                    plan.Add(new Placement { stone = st, rotation = o.rotation, scale = o.scale, course = k, along = centre, bankHeight = b.height, stoneHeight = o.Rise * sinF, position = pos });
                }
                q += hc * 0.97f;
            }
            return plan;
        }

        // Courses from the foot up. A course runs the length of the wall a stone at a time, skipping the stretches
        // where the bank is too low for it. Its front row stands out of the bank; where the bank behind a stone is
        // still lower than the stone's top, stones are set in behind it (up to maxFill), so the courses stay packed
        // back to where the bank rises above them and the top of the wall meets the plateau.
        static List<Placement> Plan(Wall w, List<Stone> stones, int variant)
        {
            var s = w.s;
            var rnd = new System.Random(w.seed * 7919 + variant);
            Func<float, float, float> range = (a, b) => a + (float)rnd.NextDouble() * (b - a);
            float total = stones.Sum(x => x.weight);
            Func<Vector2, Vector3, Vector3, Shaped> shape = (size, along, inward) =>
            {
                float r = (float)rnd.NextDouble() * total;
                var st = stones[stones.Count - 1];
                foreach (var x in stones) { r -= x.weight; if (r <= 0) { st = x; break; } }
                float sc = range(size.x, size.y) / st.longM;
                var o = new Shaped { stone = st, scale = new Vector3(sc, sc * range(s.heightScale.x, s.heightScale.y), sc) };
                // long side along the wall (either way round), a little askew; turned a little about that long side
                // (spinDeg: a Blender boulder's moss is on its top); top leaning back into the bank
                float yaw = Mathf.Atan2(along.x, along.z) * Mathf.Rad2Deg + (st.longAlongZ ? 0f : -90f) + (rnd.NextDouble() < 0.5 ? 0f : 180f) + range(-15f, 15f);
                var spin = Quaternion.AngleAxis(range(-s.spinDeg, s.spinDeg), st.longAlongZ ? Vector3.forward : Vector3.right);
                float lean = (s.leanDeg + range(-4f, 4f)) * Mathf.Deg2Rad;
                var tilt = Quaternion.FromToRotation(Vector3.up, (Vector3.up * Mathf.Cos(lean) + inward * Mathf.Sin(lean)).normalized);
                o.rotation = tilt * Quaternion.Euler(0f, yaw, 0f) * spin;
                o.amin = o.umin = o.ymin = float.MaxValue;
                o.amax = o.umax = o.ymax = float.MinValue;
                foreach (var v in st.verts)
                {
                    var p = o.rotation * Vector3.Scale(v, o.scale);
                    float pa = Vector3.Dot(p, along), pu = Vector3.Dot(p, inward);
                    o.amin = Mathf.Min(o.amin, pa); o.amax = Mathf.Max(o.amax, pa);
                    o.umin = Mathf.Min(o.umin, pu); o.umax = Mathf.Max(o.umax, pu);
                    o.ymin = Mathf.Min(o.ymin, p.y); o.ymax = Mathf.Max(o.ymax, p.y);
                }
                return o;
            };
            var plan = new List<Placement>();
            float highest = 0f;
            for (float s0 = 0; s0 <= w.Length; s0 += 1f) highest = Mathf.Max(highest, BankAt(w, s0).height);

            for (int k = 0; k * s.courseStepM <= highest - s.topMarginM || k == 0; k++)
            {
                float zBase = k * s.courseStepM;
                var size = k == 0 ? s.baseStoneM : s.stoneM;
                float cursor = k % 2 == 1 ? -range(0.3f, 0.5f) : 0f;  // stagger the joints
                while (cursor < w.Length)
                {
                    var guess = BankAt(w, cursor + (size.x + size.y) / 4);
                    var along = new Vector3(guess.along.x, 0f, guess.along.y);
                    var inward = new Vector3(guess.inward.x, 0f, guess.inward.y);
                    var o = shape(size, along, inward);
                    float centre = cursor + o.Width / 2;
                    cursor += o.Width + s.gapM + range(0f, 0.06f);
                    if (centre < 0f || centre > w.Length) continue;
                    var b = BankAt(w, centre);
                    if (b.height < s.minFaceM || (k > 0 && zBase > b.height - s.topMarginM)) continue;

                    // the front row: lowest point on the course base (the bottom course bedded sinkM); its front where the
                    // wall face is at the course base (followBank of the way in to the bank there) less proudFrac of
                    // its depth; its middle on the station
                    float bottom = zBase - (k == 0 ? s.sinkM : 0f);
                    // no top higher than capM over the plateau: the top course sinks into the one below (up to half
                    // its height) so the wall's top meets the grass; a stone that would have to go deeper is left out
                    float over = bottom + o.Height - (b.height + s.capM);
                    if (over > 0)
                    {
                        if (k > 0 && over > 0.5f * o.Height) continue;
                        bottom -= over;
                    }
                    float front = s.followBank * b.At(Mathf.Max(0f, bottom)) - s.proudFrac * o.Depth;
                    var foot = new Vector3(b.toe.x, b.groundAtToe, b.toe.y);
                    Action<Shaped, float, float, int> add = (x, tFront, yBottom, fill) => plan.Add(new Placement
                    {
                        stone = x.stone, rotation = x.rotation, scale = x.scale, course = k, fill = fill, along = centre,
                        bankHeight = b.height, stoneHeight = x.Height,
                        position = foot + inward * (tFront - x.umin) + Vector3.up * (yBottom - x.ymin) - along * ((x.amin + x.amax) / 2),
                    });
                    add(o, front, bottom, 0);
                    // fill in behind while the bank there is lower than this stone's top (less fillMarginM)
                    float top = bottom + o.Height, back = front + o.Depth;
                    for (int f = 1; f <= s.maxFill && back < b.depth && b.Rise(back) < top - s.fillMarginM; f++)
                    {
                        var x = shape(s.stoneM, along, inward);
                        float tFront = back - 0.25f * x.Depth;
                        float yBottom = Mathf.Max(bottom, top - x.Height);
                        add(x, tFront, yBottom, f);
                        back = tFront + x.Depth;
                    }
                }
            }
            return plan;
        }
    }
}
