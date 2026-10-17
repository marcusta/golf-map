// Unity 2018.2 / C# 6. Cart path look: which material the path meshes (OPCD's *_Concrete_-_Mesh and the *Concrete*
// blends) draw with.
//
// OPCD writes every path as its one hard surface, concrete: `OPCD MAHS Concrete - Asphalt_Sat`, whose colour comes
// from the -meshes orthophoto, so gravel, dirt and asphalt all rendered as the same satellite-tinted concrete, and its
// fringe strips (Spline_<shape>_B_<Neighbour>_Concrete_-_Blend) wear `Blend_Concrete ... to Concrete ...`: concrete
// on both sides, so the path ended in a razor-sharp line against the grass mesh beside the strip.
// golf-map's SVG export writes one road shape per path surface (the Draw panel's Surface) and lists them in
// <prefix>-paths.json next to the SVG (pipeline/gspro.py, golfmap-path-regions-v1: a mixed road's dominant surface
// until Blender has cut its mesh apart by surface); OPCD names the meshes
// Spline_<shape>_... (unity/README.md, "Cart paths").
//   look=surface (default) every path mesh gets <course>/Paths/Surfaces/<surface>.mat: a copy of OPCD's non-satellite
//               asphalt (`OPCD MAHS Concrete - Asphalt default`, the stock `OPCD 4 color Vert Paint MAHS` shader, so
//               OPCD's knobs and channel tools keep working) whose four channels all draw the surface's textures,
//               appended as slices to copies of OPCD's arrays (GolfMapTextureArrays), satellite off, the distant
//               base blend tinted to the surface's mean colour. The look comes from <course>/Paths/path-surfaces.json
//               (golfmap-path-looks-v2, written with defaults on the first run; a v1 spec is kept as
//               path-surfaces.v1.bak.json). A mesh no road shape names (older SVG, no sidecar) is `unknownSurface`.
//               Every fringe strip fades: its paint is red on the path edge and black on the far edge (OPCD's blend
//               convention; checked per strip against the road mesh's boundary, not assumed), so the strip draws
//               "<surface> to <neighbour material>.mat" - a copy of the material the mesh beside the strip wears
//               (found by raycasts just past the strip's far edge), its grass channels untouched, the far channel
//               given the channel that mesh is painted with there, the path channel the surface (its height map x
//               paint x blend strength interleaves stones and grass across the strip). A surface with a `tracks`
//               look draws it on the strip material's black: the Blender wear (blender/README.md "Shaping: path
//               transitions") takes the path's green out of the paint where wheels have packed the stones, and a
//               worn road's meshes wear the strip material. A strip between two roads
//               (Spline_<shape>_B_Concrete_-_Blend) fades into the other road's surface ("<surface> to <other>.mat"),
//               except the pairs the spec lists as sharp (asphalt/concrete) and same-surface pairs, which wear the
//               owning road's surface. A blend whose OPCD channels name no concrete (a fairway blend OPCD named after
//               the path it meets) is left alone. Path meshes take the surface's collider physic material; blends keep
//               theirs.
//   look=photo  puts OPCD's own materials (and the colliders' physics) back, from <course>/Paths/paths.json.
// golfmap.course.refresh runs this as step paths.materials (arg pathLook), after the bunker convention: OPCD's Set
// Default Materials gives a re-added path mesh the satellite material again.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    static class GolfMapPathMaterials
    {
        public const string Photo = "photo", Surface = "surface";
        public const string DefaultLook = Surface;
        const string SubFolder = "Paths/";
        const string RecordFile = "paths.json";
        const string SpecFile = "path-surfaces.json";
        const string SpecFormat = "golfmap-path-looks-v2";
        const string OldSpecFormat = "golfmap-path-looks-v1";
        // golfmap-path-regions-v1: `shapes` = each road shape's dominant surface (the whole mesh wears it until the
        // Blender step has cut a mixed shape's mesh apart by surface), `regions` = the pieces, for that step.
        static readonly string[] SidecarFormats = { "golfmap-path-regions-v1", "golfmap-path-surfaces-v1" };
        const string DefaultBase = "Assets/Resources/Materials/Theme - Default/OPCD MAHS Concrete - Asphalt default.mat";
        // The distant base (BaseBlend): OPCD's asphalt default draws its base from base-array slice 6 repeated every
        // 2580 m - a near-uniform colour with a slow drift - tinted; the surfaces do the same, tinted to their own mean.
        const int BaseSlice = 6;
        const float BaseTilingM = 2580f;
        const float SeamToleranceM = 0.05f;   // a blend vertex this close to its road's boundary is on the path edge
        const float ProbeOutM = 0.15f;
        // golfmap.path_kerb's surfaces (blender/tools/shape_kerb.py SURFACES) and the shadow band's tint
        static readonly HashSet<string> KerbSurfaces = new HashSet<string> { "asphalt", "concrete", "paving" };
        static readonly Color KerbShadowTint = new Color(0.30f, 0.27f, 0.24f);        // the neighbour is looked for this far past the strip's far edge
        const int ProbeRays = 40;

        [BridgeCommand("golfmap.paths.materials", "Cart path look on the path meshes (*Concrete* course meshes and blends): look=surface (default) = each path mesh's surface (from the SVG export's <prefix>-paths.json) on OPCD's MAHS shader with satellite off (copy of OPCD MAHS Concrete - Asphalt default, all four channels the surface's tiled textures appended to OPCD's arrays), looks from <course>/Paths/path-surfaces.json (golfmap-path-looks-v2, written with defaults on the first run); every fringe blend fades from the surface into the material of the mesh beside it (a copy of that material, its path channel swapped), road-to-road strips into the other road's surface (spec sharpPairs keep a hard edge); look=photo = OPCD's own satellite materials and physics back. OPCD's originals are never edited. Marks the scene dirty, does not save it.",
            args = "look=surface|photo, only (object names, comma-separated), dryRun=false (the plan: surfaces, each blend's channels and neighbour), sidecar (path of the <prefix>-paths.json; default the course export folder's)")]
        static object Command(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return Apply(a.String("look", DefaultLook), a.Bool("dryRun", false), only.Count > 0 ? only : null, a.String("sidecar"));
        }

        public static bool IsPathMesh(string name)
        {
            return GolfMapSurfaces.IsCourseMesh(name) && name.Contains("Concrete");
        }

        static bool IsBlend(string name) { return name.EndsWith("_-_Blend", StringComparison.Ordinal); }

        // A path mesh with green paint: plain path meshes are all red.
        static bool FadePainted(MeshRenderer r)
        {
            var mf = r.GetComponent<MeshFilter>();
            if (GolfMapPathTransitionMetadata.IsPainted(mf)) return true;
            var colors = mf != null && mf.sharedMesh != null ? mf.sharedMesh.colors : null;
            return colors != null && colors.Length > 0 && colors.Any(c => c.g >= 0.25f);
        }

        static bool DirtPainted(MeshRenderer r)
        {
            var mf = r.GetComponent<MeshFilter>();
            var colors = mf != null && mf.sharedMesh != null ? mf.sharedMesh.colors32 : null;
            return colors != null && colors.Any(c => c.b > 1) && FadePainted(r);
        }

        static string TransitionKey(string shape, string surface) { return shape + "|" + surface; }

        // The exported convention is explicit: a fully grass/dirt-painted end may have no green left.
        // Also recognise the earlier FBX-only prototype, whose sidecar predates transitions.
        static HashSet<string> TransitionRoads(string sidecar, List<MeshRenderer> all,
            Dictionary<string, string> shapes, ICollection<string> surfaces)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            if (!string.IsNullOrEmpty(sidecar) && File.Exists(sidecar))
            {
                var entries = GolfMapJsonDoc.ParseObject(File.ReadAllText(sidecar)).Array("transitions");
                if (entries != null) foreach (var entry in entries.OfType<GolfMapJsonObject>())
                {
                    var treatments = entry.Array("transitions");
                    if (entry.String("shape") != null && treatments != null && treatments.Count > 0)
                        result.Add(TransitionKey(entry.String("shape"), entry.String("surface")));
                }
            }
            foreach (var r in all.Where(DirtPainted))
            {
                string shape;
                var surface = SurfaceOf(r.name, shapes, surfaces, out shape);
                if (shape != null) result.Add(TransitionKey(shape, surface));
            }
            foreach (var r in all.Where(r => GolfMapPathTransitionMetadata.IsPainted(r.GetComponent<MeshFilter>())))
            {
                string shape;
                var surface = SurfaceOf(r.name, shapes, surfaces, out shape);
                if (shape != null) result.Add(TransitionKey(shape, surface));
            }
            return result;
        }

        // What an object wore before this tool touched it.
        sealed class Record { public string material, channels, physic; }

        sealed class Look
        {
            public string albedo, normal, occlusion, height, physicMaterial;
            public double tileM = 3, smoothness = 0.1, nearNRMStrength = 1, farNRMStrength = 0.7, farNRMTilingM = 9,
                aoBrightness = 1, detailOpacity = 1, detailDistanceM = 30, fringeBlendStrength = 3;
            public Color tint = Color.white;
            // Where traffic has packed the surface (wheel tracks): drawn on MAHS's black, the paint the Blender
            // wear takes out of the path's green. Null = the surface has no worn look.
            public Look tracks;
            public double tracksBlendStrength = 1.5;
        }

        const string TracksSuffix = " tracks";   // a worn look's slice key: "<surface> tracks" (never a surface name)

        sealed class Spec
        {
            public Dictionary<string, Look> looks = new Dictionary<string, Look>(StringComparer.Ordinal);
            public string unknownSurface = "asphalt", baseMaterial = DefaultBase;
            public List<string[]> sharpPairs = new List<string[]>();
            public Color transitionDirtTint = new Color(89f / 255, 83f / 255, 72f / 255, 1);
            public double transitionPathStrength = 3, transitionDirtStrength = 1;
            public bool Sharp(string a, string b)
            {
                return a == b || sharpPairs.Any(p => (p[0] == a && p[1] == b) || (p[0] == b && p[1] == a));
            }
        }

        // One object's planned look.
        sealed class Plan
        {
            public MeshRenderer r;
            public Record rec;
            public string surface, shape, kind, other, target, note;   // kind: mesh | fringe | pair | same
            public BunkerPaintChannel pathCh = BunkerPaintChannel.Red, farCh = BunkerPaintChannel.Black, nbCh = BunkerPaintChannel.Red;
            public Material neighbour;
            public string paint;   // inner/outer tallies, for the report
            public bool transition;
        }

        internal static Dictionary<string, object> Apply(string look, bool dryRun, ICollection<string> only = null, string sidecarPath = null)
        {
            if (look == "plain") throw new BridgeError("look=plain is gone: paths draw with OPCD's MAHS shader per surface now (look=surface); look=photo puts OPCD's back.");
            if (look != Photo && look != Surface) throw new BridgeError("look must be surface or photo (got " + look + ").");
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course) + SubFolder;
            var recordPath = folder + RecordFile;
            var records = ReadRecords(recordPath);
            var scene = EditorSceneManager.GetActiveScene();
            var all = UnityEngine.Object.FindObjectsOfType<MeshRenderer>()
                .Where(r => r.gameObject.scene == scene && IsPathMesh(r.name))
                .OrderBy(r => r.name, StringComparer.Ordinal).ToList();
            var meshes = all.Where(r => only == null || only.Contains(r.name)).ToList();
            triangleCache.Clear();
            if (!dryRun) Undo.SetCurrentGroupName("GolfMap path materials");
            var result = new Dictionary<string, object> { { "look", look }, { "dryRun", dryRun }, { "pathMeshes", meshes.Count }, { "record", recordPath } };
            if (look == Photo) RestorePhoto(meshes, records, recordPath, dryRun, scene, result);
            else ApplySurfaces(course, folder, all, meshes, records, recordPath, dryRun, scene, sidecarPath, result);
            return result;
        }

        static void RestorePhoto(List<MeshRenderer> meshes, Dictionary<string, Record> records, string recordPath,
            bool dryRun, UnityEngine.SceneManagement.Scene scene, Dictionary<string, object> result)
        {
            int restored = 0, kept = 0, missing = 0;
            foreach (var r in meshes)
            {
                Record rec;
                if (!records.TryGetValue(r.name, out rec)) { kept++; continue; }
                var original = AssetDatabase.LoadAssetAtPath<Material>(rec.material);
                if (original == null) { missing++; continue; }
                restored++;
                if (dryRun) continue;
                Assign(r, original);
                var store = Opcd(r, "MeshChannelMaterialsStore");
                var channels = string.IsNullOrEmpty(rec.channels) ? null : AssetDatabase.LoadMainAssetAtPath(rec.channels);
                if (store != null && channels != null)
                {
                    var so = new SerializedObject(store);
                    Undo.RecordObject(store, "GolfMap path materials");
                    so.FindProperty("MeshChannelMaterials").objectReferenceValue = channels;
                    so.ApplyModifiedProperties();
                }
                var col = r.GetComponent<MeshCollider>();
                if (col != null && rec.physic != null)
                {
                    Undo.RecordObject(col, "GolfMap path materials");
                    col.sharedMaterial = rec.physic.Length == 0 ? null : AssetDatabase.LoadAssetAtPath<PhysicMaterial>(rec.physic);
                }
                records.Remove(r.name);
            }
            if (!dryRun && restored > 0)
            {
                WriteRecords(recordPath, records);
                EditorSceneManager.MarkSceneDirty(scene);
            }
            result[dryRun ? "wouldRestore" : "restored"] = restored;
            result["alreadyOpcd"] = kept;
            result["originalMissing"] = missing;
        }

        static void ApplySurfaces(GolfMapCourse course, string folder, List<MeshRenderer> all, List<MeshRenderer> meshes,
            Dictionary<string, Record> records, string recordPath, bool dryRun, UnityEngine.SceneManagement.Scene scene,
            string sidecarPath, Dictionary<string, object> result)
        {
            var specPath = folder + SpecFile;
            var problems = new List<string>();
            var spec = ReadSpec(specPath, GolfMapCourses.Folder(course), dryRun, result);
            sidecarPath = sidecarPath ?? SidecarPath(course);
            var shapes = ReadSidecar(sidecarPath);
            result["spec"] = specPath;
            result["sidecar"] = shapes != null ? sidecarPath
                : "(none: " + (sidecarPath ?? "the course names no export folder") + ") - every path mesh is " + spec.unknownSurface;
            var roads = new Roads(all, shapes, spec.looks.Keys);
            var transitionRoads = TransitionRoads(sidecarPath, all, shapes, spec.looks.Keys);
            Physics.SyncTransforms();

            // 1. the plan: every object's surface, and for blends the paint and the neighbour (read-only, also dry runs)
            var plans = new List<Plan>();
            var unnamed = new List<string>();
            int notPath = 0;
            foreach (var r in meshes)
            {
                var current = r.sharedMaterial;
                Record rec;
                if (!records.TryGetValue(r.name, out rec) || !IsOurs(current, folder))
                {
                    var channels = Field(Opcd(r, "MeshChannelMaterialsStore"), "MeshChannelMaterials");
                    // A fairway/semi blend OPCD named *Concrete* after the path it meets: not a path.
                    if (IsBlend(r.name) && current != null && channels != null && !ConcreteChannels(channels).Any()) { notPath++; continue; }
                    rec = new Record { material = current != null ? AssetDatabase.GetAssetPath(current) : "", channels = AssetPathOf(channels), physic = PhysicPath(r) };
                }
                string shape;
                var surface = SurfaceOf(r.name, shapes, spec.looks.Keys, out shape);
                if (surface == null) { surface = spec.unknownSurface; if (shapes != null) unnamed.Add(r.name); }
                if (!spec.looks.ContainsKey(surface)) { problems.Add(r.name + ": surface '" + surface + "' has no look in " + SpecFile); continue; }
                var p = new Plan { r = r, rec = rec, surface = surface, shape = shape, kind = "mesh",
                    transition = transitionRoads.Contains(TransitionKey(shape, surface)) };
                if (IsBlend(r.name)) PlanBlend(p, roads, spec, problems);
                plans.Add(p);
            }
            // A path mesh painted the fade way (green = the path, red = grass: a road end that fades out) wears the
            // fringe material of its own strips, so the paint runs across the seam between the two meshes unbroken.
            foreach (var p in plans.Where(q => q.kind == "mesh" && FadePainted(q.r)).ToList())
            {
                var strip = plans.FirstOrDefault(q => q.kind == "fringe" && q.shape == p.shape && q.surface == p.surface);
                if (strip == null)
                    foreach (var r in all.Where(r => IsBlend(r.name) && !meshes.Contains(r)))
                    {
                        string shape;
                        if (SurfaceOf(r.name, shapes, spec.looks.Keys, out shape) != p.surface || shape != p.shape) continue;
                        var q = new Plan { r = r, surface = p.surface, shape = shape, kind = "mesh", transition = p.transition };
                        PlanBlend(q, roads, spec, new List<string>());
                        if (q.kind == "fringe" && q.pathCh == BunkerPaintChannel.Green) { strip = q; break; }
                    }
                if (strip == null) { problems.Add(p.r.name + ": fade paint but no faded strip of its road to take the material from; wears its surface"); continue; }
                p.kind = "fringe"; p.neighbour = strip.neighbour; p.pathCh = strip.pathCh; p.farCh = strip.farCh; p.nbCh = strip.nbCh;
                p.note = "fade paint: the material of " + strip.r.name;
            }
            foreach (var p in plans) p.target = folder + "Surfaces/" + Safe(TargetName(p)) + ".mat";

            // 2. the arrays and materials, then assign
            var built = new Dictionary<string, Material>(StringComparer.Ordinal);
            int changed = 0, kept = 0;
            Slices slices = null;
            if (!dryRun && plans.Count > 0)
            {
                EnsureFolder(folder + "Surfaces");
                slices = BuildSlices(spec, folder, problems);
            }
            foreach (var p in plans)
            {
                if (p.r.sharedMaterial != null && AssetDatabase.GetAssetPath(p.r.sharedMaterial) == p.target) kept++;
                else changed++;
                records[p.r.name] = p.rec;
                if (dryRun) continue;
                Material m;
                if (!built.TryGetValue(p.target, out m))
                    m = built[p.target] = BuildMaterial(p, spec, slices, folder, built, problems);
                if (m == null) continue;
                Assign(p.r, m);
                if (!IsBlend(p.r.name)) SetPhysic(p.r, spec.looks[p.surface].physicMaterial, problems);
            }
            // A whole run built every material a path mesh wears. What else lies in Surfaces/ is from an earlier plan
            // (another neighbour, paint or transition since) and still names the arrays of its day.
            bool whole = meshes.Count == all.Count;
            var surfacesDir = folder + "Surfaces/";
            var wanted = new HashSet<string>(built.Keys.Concat(plans.Select(p => p.target))
                .Concat(plans.Select(p => surfacesDir + Safe(p.surface) + ".mat")), StringComparer.Ordinal);
            if (!dryRun && (changed > 0 || built.Count > 0))
            {
                WriteRecords(recordPath, records);
                if (slices != null && whole)
                {
                    var stores = new Stores();
                    int followed = plans.Sum(p => stores.FollowRenderer(p.r, surfacesDir, p.rec != null ? p.rec.channels : null, problems));
                    if (followed > 0) result["opcdStoresUpdated"] = followed;
                    DropOrphans(surfacesDir, folder + "Arrays/", wanted, slices, scene, stores, result, problems);
                }
                AssetDatabase.SaveAssets();
                EditorSceneManager.MarkSceneDirty(scene);
                // arrays no material under Paths/ references any more go
                if (slices != null && whole)
                {
                    var keptArrays = DeleteStaleArrays(folder + "Arrays", slices);
                    if (keptArrays.Count > 0) result["oldArraysKept"] = keptArrays;
                }
            }
            else if (dryRun && whole && AssetDatabase.IsValidFolder(surfacesDir.TrimEnd('/')))
            {
                var orphans = AssetDatabase.FindAssets("t:Material", new[] { surfacesDir.TrimEnd('/') })
                    .Select(g => AssetDatabase.GUIDToAssetPath(g)).Where(p => !wanted.Contains(p)).OrderBy(p => p, StringComparer.Ordinal).ToList();
                if (orphans.Count > 0) result["orphanMaterials"] = orphans;   // deleted by a real run unless the scene holds them
            }
            result[dryRun ? "wouldChange" : "changed"] = changed;
            result["alreadyThatLook"] = kept;
            result["meshesPerSurface"] = new SortedDictionary<string, object>(plans.Where(p => p.kind == "mesh").GroupBy(p => p.surface)
                .ToDictionary(g => g.Key, g => (object)g.Count()), StringComparer.Ordinal);
            result["materials"] = new SortedDictionary<string, object>(plans.GroupBy(p => p.target)
                .ToDictionary(g => Path.GetFileNameWithoutExtension(g.Key), g => (object)g.Count()), StringComparer.Ordinal);
            result["blends"] = plans.Where(p => IsBlend(p.r.name)).Select(p => (object)(p.r.name + ": " + p.kind + " -> " + Path.GetFileNameWithoutExtension(p.target)
                + " | paint " + p.paint + (p.kind == "fringe" ? " | path " + p.pathCh + ", far " + p.farCh + " = " + (p.neighbour != null ? p.neighbour.name : "?") + " " + p.nbCh : "")
                + (p.note != null ? " | " + p.note : ""))).ToList();
            if (slices != null)
            {
                result["arrays"] = new[] { AssetDatabase.GetAssetPath(slices.detail), AssetDatabase.GetAssetPath(slices.normals) };
                // the fringe materials' grass channels draw OPCD's slices from our copies: they must be OPCD's, unchanged
                result["opcdSlicesPreserved"] = Preserved(slices.source, slices.detail) && Preserved(slices.sourceNormals, slices.normals);
                result["baseSliceMean"] ="#" + ColorUtility.ToHtmlStringRGB(slices.baseMean) + (slices.baseMeasured ? "" : " (array not readable: assumed)");
                result["surfaceMean"] = slices.mean.ToDictionary(kv => kv.Key, kv => (object)("#" + ColorUtility.ToHtmlStringRGB(kv.Value)));
            }
            result["unknownSurface"] = spec.unknownSurface;
            if (notPath > 0) result["blendsNotPath"] = notPath;
            if (unnamed.Count > 0) result["noRoadShape"] = unnamed;   // SVG and meshes from different exports?
            if (problems.Count > 0) result["problems"] = problems;
        }

        static string TargetName(Plan p)
        {
            switch (p.kind)
            {
                case "fringe":
                    var name = p.surface + " to " + p.neighbour.name;
                    // OPCD's blend convention (path red, far black, the neighbour painted red) needs no qualifier.
                    if (p.pathCh != BunkerPaintChannel.Red || p.farCh != BunkerPaintChannel.Black || p.nbCh != BunkerPaintChannel.Red)
                        name += " (path " + p.pathCh + ", far " + p.farCh + " from " + p.nbCh + ")";
                    return name + (p.transition ? " (transition dirt Blue)" : "");
                case "pair": return p.surface + " to " + p.other + (p.pathCh != BunkerPaintChannel.Red || p.farCh != BunkerPaintChannel.Black ? " (path " + p.pathCh + ", far " + p.farCh + ")" : "");
                default: return p.surface;
            }
        }

        // ------------------------------------------------------------ blends

        // The roads in the scene: each shape's non-blend path meshes and their boundary (the edge a fringe strip starts at).
        sealed class Roads
        {
            readonly List<MeshRenderer> all;
            readonly Dictionary<string, string> shapes;
            readonly ICollection<string> surfaces;
            readonly Dictionary<string, List<Vector3>> seams = new Dictionary<string, List<Vector3>>(StringComparer.Ordinal);
            public Roads(List<MeshRenderer> all, Dictionary<string, string> shapes, ICollection<string> surfaces) { this.all = all; this.shapes = shapes; this.surfaces = surfaces; }

            public string ShapeOf(string name) { string s; SurfaceOf(name, shapes, surfaces, out s); return s; }
            public string SurfaceOfMesh(string name) { string s; return SurfaceOf(name, shapes, surfaces, out s); }

            // Boundary points of the road meshes of a shape (all roads when the shape is unknown).
            public List<Vector3> Seam(string shape)
            {
                var key = shape ?? "";
                List<Vector3> pts;
                if (seams.TryGetValue(key, out pts)) return pts;
                pts = new List<Vector3>();
                foreach (var r in all)
                {
                    if (IsBlend(r.name) || (shape != null && ShapeOf(r.name) != shape)) continue;
                    var mf = r.GetComponent<MeshFilter>();
                    if (mf == null || mf.sharedMesh == null) continue;
                    var mp = GolfMapBunkerChannels.Read(mf);
                    var seen = new HashSet<int>();
                    for (int i = 0; i < mp.world.Length; i++) if (mp.boundary.Contains(mp.weld[i]) && seen.Add(mp.weld[i])) pts.Add(mp.world[i]);
                }
                return seams[key] = pts;
            }
        }

        // Which edge of a blend is the path's (paint tallied on its boundary: within SeamToleranceM of its road's
        // boundary = path edge, the rest = far edge), and what lies past the far edge (raycasts ProbeOutM out from it).
        static void PlanBlend(Plan p, Roads roads, Spec spec, List<string> problems)
        {
            var name = p.r.name;
            var mf = p.r.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) { Same(p, "no mesh"); return; }
            var mp = GolfMapBunkerChannels.Read(mf);
            if (!mp.HasColors) { Same(p, "no vertex paint"); problems.Add(name + ": no vertex paint, wears its road's surface"); return; }
            var seam = roads.Seam(p.shape);
            var grid = Grid(seam, 0.5f);
            var inner = new GolfMapBunkerChannels.Tally();
            var outer = new GolfMapBunkerChannels.Tally();
            var innerPts = new List<Vector3>();
            var outerPts = new List<int>();
            var seen = new HashSet<int>();
            for (int i = 0; i < mp.world.Length; i++)
            {
                int w = mp.weld[i];
                if (!mp.boundary.Contains(w) || !seen.Add(w)) continue;
                if (Near(grid, mp.world[i], SeamToleranceM, 0.5f)) { inner.Add(GolfMapBunkerChannels.Dominant(mp.colors[i])); innerPts.Add(mp.world[i]); }
                else { outer.Add(GolfMapBunkerChannels.Dominant(mp.colors[i])); outerPts.Add(i); }
            }
            p.paint = "path edge " + inner + ", far edge " + outer;
            if (inner.total == 0 || outer.total == 0) { Same(p, "no edge on its road"); problems.Add(name + ": " + (inner.total == 0 ? "no edge on its road's boundary" : "no far edge") + ", wears its road's surface"); return; }
            p.pathCh = inner.Top; p.farCh = outer.Top;
            // Dirt/grass can dominate even the inner edge. Never infer a transition's roles from its weights.
            if (p.transition) { p.pathCh = BunkerPaintChannel.Green; p.farCh = BunkerPaintChannel.Red; }
            if (p.pathCh == p.farCh) { Same(p, "one colour both edges"); problems.Add(name + ": paint " + p.pathCh + " on both edges, wears its road's surface"); return; }

            // past the far edge, straight down
            var hits = new List<Hit>();
            int step = Math.Max(1, outerPts.Count / ProbeRays);
            for (int k = 0; k < outerPts.Count; k += step)
            {
                var v = mp.world[outerPts[k]];
                var q = Nearest(innerPts, v);
                var dir = new Vector3(v.x - q.x, 0, v.z - q.z);
                if (dir.sqrMagnitude < 1e-8f) continue;
                var h = Probe(v + dir.normalized * ProbeOutM, p.r, p.shape, roads);
                if (h != null) hits.Add(h);
            }
            var token = NeighbourToken(name);
            var roadHits = hits.Where(h => h.road).ToList();
            var grassHits = hits.Where(h => !h.road && h.material != null).ToList();
            if (token == null && roadHits.Count > 0 && roadHits.Count >= grassHits.Count)
            {
                // road to road: the other road's surface
                var other = roadHits.GroupBy(h => h.surface ?? spec.unknownSurface).OrderByDescending(g => g.Count()).First().Key;
                if (!spec.looks.ContainsKey(other)) { Same(p, "other road's surface '" + other + "' has no look"); problems.Add(name + ": " + p.note + ", wears its road's surface"); return; }
                p.other = other;
                p.note = "meets " + roadHits.First().obj + " (" + other + ", " + roadHits.Count + "/" + hits.Count + " rays)";
                p.kind = spec.Sharp(p.surface, other) ? "same" : "pair";
                if (p.kind == "same") p.note += ", sharp pair";
                return;
            }
            // grass: the meshes of the strip's neighbour type when the rays found them, else whatever they found
            var typed = token == null ? grassHits : grassHits.Where(h => h.obj.IndexOf("_" + token + "_", StringComparison.Ordinal) >= 0).ToList();
            var use = typed.Count > 0 ? typed : grassHits;
            var why = token == null ? "no neighbour in the name" : typed.Count > 0 ? null : "rays found no *_" + token + "_* mesh";
            Material mat = null;
            if (use.Count > 0)
            {
                var best = use.GroupBy(h => h.material).OrderByDescending(g => g.Count()).First();
                mat = best.Key;
                p.nbCh = best.GroupBy(h => h.channel).OrderByDescending(g => g.Count()).First().Key;
                p.note = "beside " + best.First().obj + " (" + best.Count() + "/" + hits.Count + " rays)" + (why != null ? ", " + why : "");
            }
            else if (token != null)
            {
                // nothing under the rays: the nearest mesh of that type in the scene, painted red as OPCD paints them
                var c = p.r.bounds.center;
                var near = UnityEngine.Object.FindObjectsOfType<MeshRenderer>()
                    .Where(r => r.gameObject.scene == p.r.gameObject.scene && GolfMapSurfaces.IsCourseMesh(r.name) && !IsBlend(r.name) && !IsPathMesh(r.name)
                        && r.name.IndexOf("_" + token + "_", StringComparison.Ordinal) >= 0 && Usable(r.sharedMaterial))
                    .OrderBy(r => (r.bounds.ClosestPoint(c) - c).sqrMagnitude).FirstOrDefault();
                if (near != null) { mat = near.sharedMaterial; p.note = "no ray hit a mesh; nearest *_" + token + "_* " + near.name; }
            }
            if (mat == null) { Same(p, "no neighbour found"); problems.Add(name + ": no neighbour found past its far edge, wears its road's surface"); return; }
            p.kind = "fringe";
            p.neighbour = mat;
        }

        static void Same(Plan p, string note) { p.kind = "same"; p.note = note; }

        // Spline_<shape>_..._B_<Neighbour>_Concrete_-_Blend -> Neighbour; null for _B_Concrete_-_Blend (road to road).
        static string NeighbourToken(string name)
        {
            const string tail = "_Concrete_-_Blend";
            if (!name.EndsWith(tail, StringComparison.Ordinal) || name.EndsWith("_B" + tail, StringComparison.Ordinal)) return null;
            int b = name.LastIndexOf("_B_", name.Length - tail.Length, StringComparison.Ordinal);
            if (b < 0) return null;
            var mid = name.Substring(b + 3, name.Length - tail.Length - (b + 3));
            return mid.Length == 0 ? null : mid.Split('_')[0];
        }

        sealed class Hit { public string obj, surface; public bool road; public Material material; public BunkerPaintChannel channel; }

        // Per run (cleared in Apply): a Mesh re-imported in place by golfmap.meshes.sync keeps its object and changes its
        // data, so a cache that outlived the run indexed the new colours with the old triangles.
        static readonly Dictionary<Mesh, int[]> triangleCache = new Dictionary<Mesh, int[]>();

        // The topmost course mesh under a point, other than the blend and its own road; blends are passed through.
        static Hit Probe(Vector3 at, MeshRenderer self, string shape, Roads roads)
        {
            var hits = Physics.RaycastAll(new Vector3(at.x, at.y + 30f, at.z), Vector3.down, 80f);
            foreach (var h in hits.OrderBy(h => h.distance))
            {
                var n = h.collider.name;
                if (h.collider.gameObject == self.gameObject || !GolfMapSurfaces.IsCourseMesh(n) || IsBlend(n)) continue;
                var r = h.collider.GetComponent<MeshRenderer>();
                if (r == null || !r.enabled) continue;
                if (IsPathMesh(n))
                {
                    var s = roads.ShapeOf(n);
                    if (s != null && s == shape) continue;
                    if (shape == null && s == null) continue;   // no sidecar: every road is "the" road
                    return new Hit { obj = n, road = true, surface = roads.SurfaceOfMesh(n) };
                }
                return new Hit { obj = n, material = Usable(r.sharedMaterial) ? r.sharedMaterial : null, channel = PaintAt(h) };
            }
            return null;
        }

        // A neighbour material we can copy: OPCD's MAHS (same shader as the path materials), not one of the course's own
        // copies (stone-wall ground under <course>/, a bunker convention copy): those are rebuilt by their tools.
        static bool Usable(Material m)
        {
            return m != null && m.shader != null && m.HasProperty("_DetailArray") && m.HasProperty("_RedDetailIndex")
                && !AssetDatabase.GetAssetPath(m).StartsWith("Assets/GolfMap/", StringComparison.Ordinal);
        }

        // The paint channel at a ray hit: the hit triangle's vertex colours (collider mesh, or the renderer's when the
        // collider's has none), interpolated.
        static BunkerPaintChannel PaintAt(RaycastHit h)
        {
            var mc = h.collider as MeshCollider;
            if (mc == null || mc.sharedMesh == null || h.triangleIndex < 0) return BunkerPaintChannel.Red;
            var mesh = mc.sharedMesh;
            var colors = mesh.colors;
            if (colors.Length != mesh.vertexCount)
            {
                var mf = mc.GetComponent<MeshFilter>();
                if (mf != null && mf.sharedMesh != null && mf.sharedMesh.vertexCount == mesh.vertexCount) colors = mf.sharedMesh.colors;
            }
            if (colors.Length != mesh.vertexCount) return BunkerPaintChannel.Red;   // no paint = OPCD's red
            int[] tris;
            if (!triangleCache.TryGetValue(mesh, out tris)) triangleCache[mesh] = tris = mesh.triangles;
            int t = h.triangleIndex * 3;
            if (t + 2 >= tris.Length || tris[t] >= colors.Length || tris[t + 1] >= colors.Length || tris[t + 2] >= colors.Length) return BunkerPaintChannel.Red;
            var b = h.barycentricCoordinate;
            return GolfMapBunkerChannels.Dominant(colors[tris[t]] * b.x + colors[tris[t + 1]] * b.y + colors[tris[t + 2]] * b.z);
        }

        static Dictionary<long, List<Vector3>> Grid(List<Vector3> pts, float cell)
        {
            var g = new Dictionary<long, List<Vector3>>();
            foreach (var p in pts)
            {
                long k = Cell(Mathf.FloorToInt(p.x / cell), Mathf.FloorToInt(p.z / cell));
                List<Vector3> l; if (!g.TryGetValue(k, out l)) g[k] = l = new List<Vector3>();
                l.Add(p);
            }
            return g;
        }

        static long Cell(int x, int z) { return ((long)x << 32) | (uint)z; }

        static bool Near(Dictionary<long, List<Vector3>> grid, Vector3 p, float tol, float cell)
        {
            int cx = Mathf.FloorToInt(p.x / cell), cz = Mathf.FloorToInt(p.z / cell);
            for (int dx = -1; dx <= 1; dx++)
                for (int dz = -1; dz <= 1; dz++)
                {
                    List<Vector3> l;
                    if (!grid.TryGetValue(Cell(cx + dx, cz + dz), out l)) continue;
                    foreach (var q in l) if ((q - p).sqrMagnitude <= tol * tol) return true;
                }
            return false;
        }

        static Vector3 Nearest(List<Vector3> pts, Vector3 v)
        {
            Vector3 best = v; float d = float.MaxValue;
            foreach (var q in pts) { float e = (q.x - v.x) * (q.x - v.x) + (q.z - v.z) * (q.z - v.z); if (e < d) { d = e; best = q; } }
            return best;
        }

        // ------------------------------------------------------------ surfaces

        static string SidecarPath(GolfMapCourse course)
        {
            if (string.IsNullOrEmpty(course.exportFolder) || string.IsNullOrEmpty(course.exportPrefix)) return null;
            var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            return Path.GetFullPath(Path.Combine(folder, course.exportPrefix + "-paths.json"));
        }

        static Dictionary<string, string> ReadSidecar(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            if (Array.IndexOf(SidecarFormats, root.String("format")) < 0) throw new BridgeError(path + " is not a " + string.Join(" / ", SidecarFormats) + " file.");
            var shapes = root.Object("shapes");
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            if (shapes != null) foreach (var k in shapes.keys) result[k] = shapes.String(k);
            return result;
        }

        // The surface of the road shape a mesh was built from: Spline_<shape>_..., the longest shape name that fits
        // (roads_12f_2 before roads_12f; OPCD adds _0, _1 ... for the pieces a shape is cut into). A part the Blender
        // step cut out of a mixed shape by surface names its surface right after the shape
        // (Spline_roads_124_gravel_0_Concrete_-_Mesh, Spline_roads_124_gravel_B_Concrete_-_Blend): that wins over the
        // sidecar's dominant surface for the whole shape. `surfaces` = the names the spec knows.
        internal static string SurfaceOf(string meshName, Dictionary<string, string> shapes, ICollection<string> surfaces, out string shape)
        {
            shape = null;
            if (shapes == null || !meshName.StartsWith("Spline_", StringComparison.Ordinal)) return null;
            var rest = meshName.Substring("Spline_".Length);
            foreach (var kv in shapes.OrderByDescending(kv => kv.Key.Length))
            {
                if (!rest.StartsWith(kv.Key + "_", StringComparison.Ordinal)) continue;
                shape = kv.Key;
                var token = rest.Substring(kv.Key.Length + 1).Split('_')[0];
                return surfaces != null && surfaces.Contains(token) ? token : kv.Value;
            }
            return null;
        }

        // The surfaces' slices in copies of OPCD's arrays: detail index of surface s = detail[s] (albedo; its MAHS map
        // one up), normal at detail[s] / 2 (the shader's rule). Every spec surface whose textures exist gets one, in name
        // order, so the indices and the arrays do not depend on which meshes a run touches; a new spec texture = a new
        // array (old ones are deleted when nothing of ours references them any more).
        sealed class Slices
        {
            public Texture2DArray source, sourceNormals, detail, normals;
            public Dictionary<string, int> index = new Dictionary<string, int>(StringComparer.Ordinal);
            public Dictionary<string, Color> mean = new Dictionary<string, Color>(StringComparer.Ordinal);   // albedo x AO bytes
            public Color baseMean;
            public bool baseMeasured;
        }

        static Slices BuildSlices(Spec spec, string folder, List<string> problems)
        {
            var baseMat = AssetDatabase.LoadAssetAtPath<Material>(spec.baseMaterial);
            if (baseMat == null) throw new BridgeError("baseMaterial " + spec.baseMaterial + " is not a material (" + SpecFile + ").");
            var detail = baseMat.GetTexture("_DetailArray") as Texture2DArray;
            var normals = baseMat.GetTexture("_NormalArray") as Texture2DArray;
            var baseArray = baseMat.GetTexture("_BaseArray") as Texture2DArray;
            if (detail == null || normals == null || detail.depth != normals.depth * 2)
                throw new BridgeError(spec.baseMaterial + " needs OPCD detail/normal arrays with paired slices.");
            var s = new Slices { source = detail, sourceNormals = normals };
            var dl = new List<GolfMapTextureArrays.Layer>();
            var nl = new List<GolfMapTextureArrays.Layer>();
            var key = new List<string> { "v2", GolfMapTextureArrays.Hash(AssetDatabase.GetAssetPath(detail)), GolfMapTextureArrays.Hash(AssetDatabase.GetAssetPath(normals)) };
            var looks = spec.looks.OrderBy(kv => kv.Key, StringComparer.Ordinal)
                .SelectMany(kv => kv.Value.tracks == null ? new[] { kv }
                    : new[] { kv, new KeyValuePair<string, Look>(kv.Key + TracksSuffix, kv.Value.tracks) });
            foreach (var kv in looks)
            {
                var lk = kv.Value;
                var albedo = Texture(lk.albedo, false, kv.Key, problems);
                var normal = Texture(lk.normal, true, kv.Key, problems);
                if (albedo == null || normal == null) { problems.Add(kv.Key + ": needs an albedo and a normal map; no slice (its meshes keep what they wear)"); continue; }
                var ao = Texture(lk.occlusion, false, kv.Key, problems);
                var height = Texture(lk.height, false, kv.Key, problems);
                s.index[kv.Key] = detail.depth + dl.Count;
                dl.Add(new GolfMapTextureArrays.Layer { texture = albedo, linear = false });
                dl.Add(new GolfMapTextureArrays.Layer { flat = new Color(0, 1, 1, 1), green = ao, blue = height, linear = true });  // metallic 0, AO, height, smoothness x1
                nl.Add(new GolfMapTextureArrays.Layer { texture = normal, linear = true });
                var a = GolfMapTextureArrays.MeanBytes(albedo);
                float o = ao != null ? GolfMapTextureArrays.MeanBytes(ao).r : 1f;
                s.mean[kv.Key] = new Color(a.r * o, a.g * o, a.b * o, 1);
                key.Add(kv.Key + ":" + string.Join(",", new[] { lk.albedo, lk.normal, lk.occlusion, lk.height }.Select(GolfMapTextureArrays.Hash).ToArray()));
            }
            var dir = folder + "Arrays";
            EnsureFolder(dir);
            var k = GolfMapTextureArrays.Key(key);
            // OPCD's arrays sample their bytes linearly (colour slices too); the copies must as well, or the grass
            // channels of a fringe material would draw darker than the mesh beside the strip.
            s.detail = GolfMapTextureArrays.Extend(detail, dl, true, dir + "/Path detail " + k + ".asset", "OPCD with path surfaces detail");
            s.normals = GolfMapTextureArrays.Extend(normals, nl, true, dir + "/Path normals " + k + ".asset", "OPCD with path surfaces normals");
            var measured = baseArray != null ? GolfMapTextureArrays.MeanSlice(baseArray, BaseSlice) : null;
            s.baseMeasured = measured.HasValue;
            s.baseMean = measured ?? new Color(0.5f, 0.5f, 0.5f, 1);
            return s;
        }

        // Every slice of `source` equal in `copy` (texels of a small mip; the slices are copied raw, so any change shows).
        static bool Preserved(Texture2DArray source, Texture2DArray copy)
        {
            if (copy.depth <= source.depth || copy.format != source.format) return false;
            try
            {
                for (int i = 0; i < source.depth; i++)
                    if (!source.GetPixels(i, 6).SequenceEqual(copy.GetPixels(i, 6))) return false;
                return true;
            }
            catch (Exception) { return false; }
        }

        // Deletes the arrays in `dir` other than the current pair that no material under Paths/ references (hand-made
        // ones count: Paths/EndTrials). Returns the old arrays that stay, each with a material that keeps it.
        static List<string> DeleteStaleArrays(string dir, Slices s)
        {
            var keep = new HashSet<string> { AssetDatabase.GetAssetPath(s.detail), AssetDatabase.GetAssetPath(s.normals) };
            var used = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var g in AssetDatabase.FindAssets("t:Material", new[] { dir.Substring(0, dir.LastIndexOf('/')) }))
            {
                var mp = AssetDatabase.GUIDToAssetPath(g);
                var m = AssetDatabase.LoadAssetAtPath<Material>(mp);
                if (m == null || !m.HasProperty("_DetailArray") || !m.HasProperty("_NormalArray")) continue;
                foreach (var t in new[] { m.GetTexture("_DetailArray"), m.GetTexture("_NormalArray") })
                    if (t != null && !used.ContainsKey(AssetDatabase.GetAssetPath(t))) used[AssetDatabase.GetAssetPath(t)] = mp;
            }
            var kept = new List<string>();
            foreach (var g in AssetDatabase.FindAssets("t:Texture2DArray", new[] { dir }))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                if (keep.Contains(p)) continue;
                if (used.ContainsKey(p)) kept.Add(p + " (used by " + used[p] + ")");
                else AssetDatabase.DeleteAsset(p);
            }
            return kept;
        }

        // OPCD's helper components on a path mesh remember a material of ours once OPCD's tools have run over it
        // (MeshChannelMaterialsStore.MeshChannelMaterials -> a ChannelMaterials asset beside OPCD's, named after the
        // material; BlendTarget.BlendSourceMaterialRed / BlendToMaterialBlack) and keep the one of that day when a later
        // plan gives the mesh another. The scene then drags that material and its arrays into the build with no
        // renderer wearing it (golfmap.build.usedby shows them under `components`).
        sealed class Stores
        {
            // the folders ChannelMaterials assets were seen in: where OPCD writes the ones it makes for our materials
            public readonly HashSet<string> dirs = new HashSet<string>(StringComparer.Ordinal);
            readonly Dictionary<string, List<KeyValuePair<UnityEngine.Object, Material>>> byDir = new Dictionary<string, List<KeyValuePair<UnityEngine.Object, Material>>>(StringComparer.Ordinal);

            // The ChannelMaterials assets in a folder, each with its RenderMaterial.
            public List<KeyValuePair<UnityEngine.Object, Material>> In(string dir)
            {
                List<KeyValuePair<UnityEngine.Object, Material>> list;
                if (byDir.TryGetValue(dir, out list)) return list;
                list = new List<KeyValuePair<UnityEngine.Object, Material>>();
                foreach (var g in AssetDatabase.FindAssets("t:ScriptableObject", new[] { dir }))
                {
                    var o = AssetDatabase.LoadMainAssetAtPath(AssetDatabase.GUIDToAssetPath(g));
                    var render = Field(o, "RenderMaterial") as Material;
                    if (render != null) list.Add(new KeyValuePair<UnityEngine.Object, Material>(o, render));
                }
                return byDir[dir] = list;
            }

            // Points the components of a path mesh that hold another material of ours at the one its renderer wears:
            // material fields directly, a ChannelMaterials reference at the asset of the worn material (else at
            // `opcdChannels`, what the store held before this tool). Returns the components changed.
            public int FollowRenderer(MeshRenderer r, string surfacesDir, string opcdChannels, List<string> problems)
            {
                var worn = r.sharedMaterial;
                if (worn == null || !AssetDatabase.GetAssetPath(worn).StartsWith(surfacesDir, StringComparison.Ordinal)) return 0;
                int changed = 0;
                foreach (var c in r.GetComponents<MonoBehaviour>())
                {
                    if (c == null) continue;
                    var so = new SerializedObject(c);
                    var it = so.GetIterator();
                    bool dirty = false;
                    while (it.NextVisible(true))
                    {
                        if (it.propertyType != SerializedPropertyType.ObjectReference || it.propertyPath == "m_Script") continue;
                        var o = it.objectReferenceValue;
                        if (o == null) continue;
                        var held = o as Material;
                        if (held != null)
                        {
                            if (held != worn && AssetDatabase.GetAssetPath(held).StartsWith(surfacesDir, StringComparison.Ordinal)) { it.objectReferenceValue = worn; dirty = true; }
                            continue;
                        }
                        if (!(o is ScriptableObject)) continue;
                        var render = Field(o, "RenderMaterial") as Material;
                        if (render == null) continue;
                        var path = AssetDatabase.GetAssetPath(o);
                        var dir = path.Substring(0, path.LastIndexOf('/'));
                        dirs.Add(dir);
                        if (render == worn || !AssetDatabase.GetAssetPath(render).StartsWith(surfacesDir, StringComparison.Ordinal)) continue;
                        var channels = In(dir).Where(kv => kv.Value == worn).Select(kv => kv.Key).FirstOrDefault()
                            ?? (string.IsNullOrEmpty(opcdChannels) ? null : AssetDatabase.LoadMainAssetAtPath(opcdChannels));
                        if (channels == null) { problems.Add(r.name + ": " + c.GetType().Name + "." + it.propertyPath + " holds " + path + " (" + render.name + ") and no ChannelMaterials asset names " + worn.name + "; left"); continue; }
                        it.objectReferenceValue = channels;
                        dirty = true;
                    }
                    if (!dirty) continue;
                    so.ApplyModifiedProperties();
                    changed++;
                }
                return changed;
            }
        }

        // The materials in Surfaces/ this whole run did not build. One nothing in the scene holds goes to the trash with
        // the ChannelMaterials asset OPCD made for it (the next run that plans it builds it again); one the scene still
        // holds (a renderer or component outside the path meshes) stays and is moved to the current arrays when its own
        // have as many slices (same surfaces, so the same indices), so it does not keep an old pair in the build.
        static void DropOrphans(string surfacesDir, string arraysDir, HashSet<string> wanted, Slices s, UnityEngine.SceneManagement.Scene scene,
            Stores stores, Dictionary<string, object> result, List<string> problems)
        {
            var orphans = new HashSet<string>(AssetDatabase.FindAssets("t:Material", new[] { surfacesDir.TrimEnd('/') })
                .Select(g => AssetDatabase.GUIDToAssetPath(g)).Where(p => !wanted.Contains(p)), StringComparer.Ordinal);
            if (orphans.Count == 0) return;
            var holders = SceneHolders(scene, orphans);
            var deleted = new List<string>();
            var kept = new List<string>();
            foreach (var path in orphans.OrderBy(p => p, StringComparer.Ordinal))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(path);
                string holder;
                if (!holders.TryGetValue(path, out holder))
                {
                    foreach (var dir in stores.dirs)
                        foreach (var kv in stores.In(dir).Where(kv => kv.Value == m).ToList())
                        {
                            stores.In(dir).Remove(kv);
                            AssetDatabase.MoveAssetToTrash(AssetDatabase.GetAssetPath(kv.Key));
                        }
                    if (AssetDatabase.MoveAssetToTrash(path)) deleted.Add(Path.GetFileNameWithoutExtension(path));
                    else problems.Add(path + ": not built by this run and not held by the scene, but could not be moved to the trash");
                    continue;
                }
                var note = Path.GetFileNameWithoutExtension(path) + " (held by " + holder + ")";
                var detail = m != null && m.HasProperty("_DetailArray") ? m.GetTexture("_DetailArray") as Texture2DArray : null;
                var normals = m != null && m.HasProperty("_NormalArray") ? m.GetTexture("_NormalArray") as Texture2DArray : null;
                bool old = (detail != null && detail != s.detail && AssetDatabase.GetAssetPath(detail).StartsWith(arraysDir, StringComparison.Ordinal))
                    || (normals != null && normals != s.normals && AssetDatabase.GetAssetPath(normals).StartsWith(arraysDir, StringComparison.Ordinal));
                if (old && detail != null && normals != null && detail.depth == s.detail.depth && normals.depth == s.normals.depth)
                {
                    m.SetTexture("_DetailArray", s.detail);
                    m.SetTexture("_NormalArray", s.normals);
                    EditorUtility.SetDirty(m);
                    note += ", moved to the current arrays";
                }
                else if (old) problems.Add(path + ": held by " + holder + " and on older arrays with another slice count (" + (detail != null ? detail.name : "?") + "); they stay in the build until nothing holds it");
                kept.Add(note);
            }
            if (deleted.Count > 0) result["orphanMaterialsDeleted"] = deleted;
            if (kept.Count > 0) result["orphanMaterialsKept"] = kept;
        }

        // Which of `paths` (material assets) the scene holds, each with one holder: a renderer wearing it, or a
        // component referencing it directly or through a ScriptableObject (OPCD's ChannelMaterials). Inactive objects too.
        static Dictionary<string, string> SceneHolders(UnityEngine.SceneManagement.Scene scene, HashSet<string> paths)
        {
            var held = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var r in Resources.FindObjectsOfTypeAll<Renderer>())
            {
                if (r == null || EditorUtility.IsPersistent(r) || r.gameObject.scene != scene) continue;
                foreach (var m in r.sharedMaterials)
                {
                    var p = m != null ? AssetDatabase.GetAssetPath(m) : null;
                    if (p != null && paths.Contains(p) && !held.ContainsKey(p)) held[p] = r.name + ", renderer";
                }
            }
            var none = new string[0];
            var hits = new Dictionary<UnityEngine.Object, string[]>();
            foreach (var c in Resources.FindObjectsOfTypeAll<MonoBehaviour>())
            {
                if (c == null || EditorUtility.IsPersistent(c) || c.gameObject.scene != scene) continue;
                var it = new SerializedObject(c).GetIterator();
                while (it.NextVisible(true))
                {
                    if (it.propertyType != SerializedPropertyType.ObjectReference || it.propertyPath == "m_Script") continue;
                    var o = it.objectReferenceValue;
                    if (o == null) continue;
                    string[] hit;
                    if (!hits.TryGetValue(o, out hit))
                    {
                        var p = AssetDatabase.GetAssetPath(o);
                        hit = hits[o] = string.IsNullOrEmpty(p) ? none : paths.Contains(p) ? new[] { p }
                            : o is ScriptableObject ? AssetDatabase.GetDependencies(p, false).Where(paths.Contains).ToArray() : none;
                    }
                    foreach (var p in hit) if (!held.ContainsKey(p)) held[p] = c.name + ", " + c.GetType().Name + "." + it.propertyPath;
                }
            }
            return held;
        }

        // The material of a plan: built once per target per run (fringe and pair copies start from it).
        static Material BuildMaterial(Plan p, Spec spec, Slices s, string folder, Dictionary<string, Material> built, List<string> problems)
        {
            if (!s.index.ContainsKey(p.surface)) { problems.Add(p.r.name + ": surface '" + p.surface + "' has no slice"); return null; }
            var lk = spec.looks[p.surface];
            Material source;
            if (p.kind == "fringe") source = p.neighbour;
            else if (p.kind == "pair")
            {
                if (!s.index.ContainsKey(p.other)) { problems.Add(p.r.name + ": surface '" + p.other + "' has no slice; wears " + p.surface); p.kind = "same"; p.target = folder + "Surfaces/" + Safe(p.surface) + ".mat"; }
                source = null;
            }
            else source = null;
            if (p.kind == "same" || p.kind == "mesh")
            {
                var path = folder + "Surfaces/" + Safe(p.surface) + ".mat";
                Material m0;
                if (built.TryGetValue(path, out m0)) return m0;
                return built[path] = SurfaceMaterial(p.surface, lk, spec, s, path);
            }
            if (p.kind == "pair")
            {
                var ownPath = folder + "Surfaces/" + Safe(p.surface) + ".mat";
                Material own;
                if (!built.TryGetValue(ownPath, out own)) own = built[ownPath] = SurfaceMaterial(p.surface, lk, spec, s, ownPath);
                source = own;
            }
            var m = Copy(source, p.target);
            if (m.shader != source.shader) m.shader = source.shader;
            m.SetTexture("_DetailArray", s.detail);
            m.SetTexture("_NormalArray", s.normals);
            if (p.kind == "fringe")
            {
                // The far channel draws what the mesh beside the strip shows there (OPCD paints its meshes red, and a
                // MAHS material's black is another ground - roots and dirt on the roughs).
                if (p.nbCh != p.farCh) GolfMapBunkerChannels.CopyChannel(source, p.nbCh, m, p.farCh);
                SetSurfaceChannel(m, p.pathCh, p.surface, lk, s);
                m.SetFloat(GolfMapBunkerChannels.Prefix(p.pathCh) + "BlendStrength", (float)lk.fringeBlendStrength);
                // Black is free on a strip painted red grass / green path (its paint sums to one): the worn look.
                if (lk.tracks != null && s.index.ContainsKey(p.surface + TracksSuffix)
                    && p.pathCh != BunkerPaintChannel.Black && p.farCh != BunkerPaintChannel.Black)
                {
                    SetSurfaceChannel(m, BunkerPaintChannel.Black, p.surface + TracksSuffix, lk.tracks, s);
                    m.SetFloat("_BlackBlendStrength", (float)lk.tracksBlendStrength);
                }
                // A hard road's strip rounded into a lip (Blender golfmap.path_kerb, green road / red grass) paints a
                // band on black in the angle of the lip: dark dirt in its shadow, not the neighbour's pale dirt base.
                else if (KerbSurfaces.Contains(p.surface) && p.pathCh == BunkerPaintChannel.Green && p.farCh == BunkerPaintChannel.Red)
                {
                    Look dirt;
                    if (spec.looks.TryGetValue("dirt", out dirt) && s.index.ContainsKey("dirt"))
                    {
                        SetSurfaceChannel(m, BunkerPaintChannel.Black, "dirt", dirt, s);
                        m.SetColor("_BlackDetailColorTint", KerbShadowTint);
                        m.SetColor("_BlackBaseColorTint", KerbShadowTint);
                        m.SetFloat("_BlackBlendStrength", 1.5f);
                    }
                }
                if (p.transition)
                {
                    Look dirt;
                    if (!spec.looks.TryGetValue("dirt", out dirt) || !s.index.ContainsKey("dirt"))
                        throw new BridgeError("Path transitions require a dirt surface with available textures in " + SpecFile + ".");
                    SetSurfaceChannel(m, BunkerPaintChannel.Blue, "dirt", dirt, s);
                    m.SetColor("_BlueDetailColorTint", spec.transitionDirtTint);
                    // Keep the distant colour consistent with the independently tinted transition dirt.
                    var originalTint = dirt.tint;
                    dirt.tint = spec.transitionDirtTint;
                    m.SetColor("_BlueBaseColorTint", BaseTint(dirt, s.mean["dirt"], s.baseMean));
                    dirt.tint = originalTint;
                    m.SetFloat("_BlueBlendStrength", (float)spec.transitionDirtStrength);
                    m.SetFloat("_GreenBlendStrength", (float)spec.transitionPathStrength);
                }
            }
            else
            {
                var other = spec.looks[p.other];
                SetSurfaceChannel(m, p.farCh, p.other, other, s);
                m.SetFloat(GolfMapBunkerChannels.Prefix(p.pathCh) + "BlendStrength", (float)lk.fringeBlendStrength);
                m.SetFloat(GolfMapBunkerChannels.Prefix(p.farCh) + "BlendStrength", (float)other.fringeBlendStrength);
            }
            EditorUtility.SetDirty(m);
            return m;
        }

        // <surface>.mat: OPCD's non-satellite asphalt with all four channels the surface.
        static Material SurfaceMaterial(string surface, Look lk, Spec spec, Slices s, string path)
        {
            var src = AssetDatabase.LoadAssetAtPath<Material>(spec.baseMaterial);
            var m = Copy(src, path);
            m.SetTexture("_DetailArray", s.detail);
            m.SetTexture("_NormalArray", s.normals);
            m.SetFloat("_OverallDesaturate", 0);   // the default theme's 0.18 greys dirt and gravel
            foreach (var ch in GolfMapBunkerChannels.All) SetSurfaceChannel(m, ch, surface, lk, s);
            EditorUtility.SetDirty(m);
            return m;
        }

        // A course-local copy of `source` at `path`, its properties and keywords reset to the source's on every run (the
        // spec wins over hand edits; tune the spec).
        static Material Copy(Material source, string path)
        {
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null)
            {
                m = new Material(source) { name = Path.GetFileNameWithoutExtension(path) };
                AssetDatabase.CreateAsset(m, path);
            }
            else
            {
                m.shader = source.shader;
                m.CopyPropertiesFromMaterial(source);
                m.shaderKeywords = source.shaderKeywords;
                m.name = Path.GetFileNameWithoutExtension(path);
            }
            return m;
        }

        // One channel drawing a surface: its detail slice tiled by world metres, no satellite, mowlines and the surface
        // grunge off, the distant base (BaseBlend, so it does not tile toward the horizon) the surface's mean colour.
        static void SetSurfaceChannel(Material m, BunkerPaintChannel channel, string surface, Look lk, Slices s)
        {
            string p = GolfMapBunkerChannels.Prefix(channel);
            int index = s.index[surface];
            Toggle(m, p + "UseSatelliteforBase", false);
            Toggle(m, p + "BaseBlend", true);
            m.SetFloat(p + "DetailIndex", index);
            m.SetFloat(p + "DetailTiling", (float)lk.tileM);
            m.SetFloat(p + "FarNRMTiling", (float)lk.farNRMTilingM);
            m.SetFloat(p + "NearNRMStrength", (float)lk.nearNRMStrength);
            m.SetFloat(p + "FarNRMStrength", (float)lk.farNRMStrength);
            m.SetFloat(p + "NRMBlendDistance", (float)lk.detailDistanceM);
            m.SetFloat(p + "NRMFalloff", 2);
            m.SetFloat(p + "AOBrightness", (float)lk.aoBrightness);
            m.SetFloat(p + "DetailOpacity", (float)lk.detailOpacity);
            m.SetFloat(p + "DetailDistance", (float)lk.detailDistanceM);
            m.SetFloat(p + "DetailFalloff", 3);
            m.SetFloat(p + "DetailDesaturate", 0);
            m.SetColor(p + "DetailColorTint", lk.tint);
            m.SetColor(p + "OverallColor", Color.white);
            m.SetFloat(p + "OverallColorStrength", 1);
            m.SetFloat(p + "BaseIndex", BaseSlice);
            m.SetFloat(p + "BaseTiling", BaseTilingM);
            m.SetColor(p + "BaseColorTint", BaseTint(lk, s.mean[surface], s.baseMean));
            m.SetTexture(p + "HeightTexture", Texture(lk.height, false, surface, null) ?? Texture2D.whiteTexture);
            m.SetFloat(p + "BlendStrength", 2);
            m.SetFloat(p + "Smoothness", (float)lk.smoothness);
            m.SetFloat(p + "MowlineTiling", 1);   // avoid division by zero even with opacity zero
            m.SetFloat(p + "MowlineOpacity", 0);
            m.SetFloat(p + "SurfaceOpacity", 0);
        }

        // The base colour that equals the detail on average: detail = DetailColorTint x albedo x AO x AOBrightness (all
        // sampled as stored bytes, the arrays are linear), base = BaseColorTint x base slice. Material colours reach the
        // shader converted to linear in a linear project, so the tint is solved in linear and stored as gamma.
        static Color BaseTint(Look lk, Color mean, Color baseMean)
        {
            bool lin = QualitySettings.activeColorSpace == ColorSpace.Linear;
            var t = lin ? lk.tint.linear : lk.tint;
            float ao = (float)lk.aoBrightness;
            var c = new Color(t.r * mean.r * ao / Mathf.Max(0.01f, baseMean.r), t.g * mean.g * ao / Mathf.Max(0.01f, baseMean.g), t.b * mean.b * ao / Mathf.Max(0.01f, baseMean.b), 0);
            return lin ? c.gamma : c;
        }

        // A [Toggle] property: the float the shader reads and the keyword the inspector (and our audit) shows.
        static void Toggle(Material m, string property, bool on)
        {
            m.SetFloat(property, on ? 1 : 0);
            var kw = property.ToUpperInvariant() + "_ON";
            if (on) m.EnableKeyword(kw); else m.DisableKeyword(kw);
        }

        // The texture at `path`, imported to repeat (and as a normal map when it is one).
        static Texture2D Texture(string path, bool normalMap, string surface, List<string> problems)
        {
            if (string.IsNullOrEmpty(path)) return null;
            var imp = AssetImporter.GetAtPath(path) as TextureImporter;
            if (imp == null) { if (problems != null) problems.Add(surface + ": no texture at " + path); return null; }
            bool reimport = false;
            if (normalMap && imp.textureType != TextureImporterType.NormalMap)
            {
                imp.textureType = TextureImporterType.NormalMap;
                if (problems != null) problems.Add(surface + ": " + path + " was not imported as a normal map; set to Normal map");
                reimport = true;
            }
            if (imp.wrapMode != TextureWrapMode.Repeat) { imp.wrapMode = TextureWrapMode.Repeat; reimport = true; }
            if (reimport) imp.SaveAndReimport();
            return AssetDatabase.LoadAssetAtPath<Texture2D>(path);
        }

        static void SetPhysic(MeshRenderer r, string path, List<string> problems)
        {
            if (string.IsNullOrEmpty(path)) return;
            var col = r.GetComponent<MeshCollider>();
            if (col == null) return;
            var pm = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(path);
            if (pm == null) { problems.Add(r.name + ": no physic material at " + path); return; }
            if (col.sharedMaterial == pm) return;
            Undo.RecordObject(col, "GolfMap path materials");
            col.sharedMaterial = pm;
        }

        static string PhysicPath(MeshRenderer r)
        {
            var col = r.GetComponent<MeshCollider>();
            if (col == null) return null;
            return col.sharedMaterial != null ? AssetDatabase.GetAssetPath(col.sharedMaterial) : "";
        }

        static bool IsOurs(Material m, string folder)
        {
            return m != null && AssetDatabase.GetAssetPath(m).StartsWith(folder, StringComparison.Ordinal);
        }

        // The channels whose OPCD source (ChannelMaterials) is a concrete material.
        static IEnumerable<BunkerPaintChannel> ConcreteChannels(UnityEngine.Object channels)
        {
            foreach (var ch in GolfMapBunkerChannels.All)
            {
                var source = Field(channels, ch + "ChannelMaterial") as Material;
                if (source != null && source.name.Contains("Concrete")) yield return ch;
            }
        }

        // ------------------------------------------------------------ spec

        // Defaults: textures already in a GSPro base project (OPCD's asphalt set, the GroundTextures pack, NatureManufacture's
        // river pack) and the Blender props kit's (<course>/Props/Textures/, when the course has built props).
        static GolfMapJsonObject DefaultSpec(string courseFolder)
        {
            var props = courseFolder + "Props/Textures/";
            const string opcd = "Assets/Resources/OPCD MAHS Resources/OPCD Height Textures/Asphalt Clean/Asphalt Clean_";
            const string ground = "Assets/GroundTextures/";
            const string g32 = "Assets/GroundTextures/Ground032/Ground032_";
            var text = GolfMapJson.Serialize(new Dictionary<string, object>
            {
                { "format", SpecFormat },
                { "note", "golfmap.paths.materials look=surface: how each path surface is drawn, on OPCD's MAHS shader (satellite off). Keys = the Draw panel's path surfaces (shared/features/path-surface.ts); grass tracks are rough meshes and not listed. albedo/normal/occlusion/height = asset paths (occlusion and height optional: occlusion goes into the MAHS map's AO, height is the channel's Height Texture, which with the vertex paint and fringeBlendStrength decides where stones show through the grass across a fringe strip), tileM = metres one repeat covers (Detail Tiling), tint = #rrggbb (Detail Color Tint; OPCD's arrays are sampled as stored bytes, brighter than a Standard material shows the same file, so tints run dark), smoothness 0-1, nearNRMStrength/farNRMStrength/farNRMTilingM = the normal map near and beyond detailDistanceM, aoBrightness multiplies the AO, detailOpacity 0-1 = how much of the texture shows over the surface's mean colour (the base, which also takes over beyond detailDistanceM so it does not tile), fringeBlendStrength = the path channel's Blend Strength on fringe strips (higher = the path reaches further across), physicMaterial = the path mesh collider's (GSPro reads bounce and roll off it), tracks = optional worn look of the surface (wheel tracks, a trodden middle: where the Blender wear paint took the path's green out; same keys, what it leaves out is the surface's own, blendStrength = how hard it takes over). unknownSurface = the look of a path mesh no road shape of the export names. sharpPairs = road-to-road strips that keep a hard edge. baseMaterial = what the surface materials are copied from. Edit and run again." },
                { "unknownSurface", "asphalt" },
                { "baseMaterial", DefaultBase },
                { "sharpPairs", new List<object> { new List<object> { "asphalt", "concrete" } } },
                { "transitions", new Dictionary<string, object> { { "dirtTint", "#595348" }, { "pathBlendStrength", 3 }, { "dirtBlendStrength", 1 } } },
                { "surfaces", new Dictionary<string, object>
                    {
                        // Tuned on Vreta 2026-10-04 at 1.7 m eye height (unity/README.md "Cart paths"), to read as the
                        // GolfMap/Path Surface shader looks of 2026-09-29 did. OPCD's asphalt albedo is a light base meant to be tinted.
                        { "asphalt", LookJson(opcd + "Albedo.png", opcd + "Normal.png", opcd + "AO.png", opcd + "Height.png", 4, "#626262", 0.2, 1.0, 0.8, 12, 1.0, 0.9, 40, 2, "GSPconcrete") },
                        { "concrete", LookJson(props + "concrete.png", props + "concrete_n.png", null, null, 3, "#9a9a9a", 0.15, 0.8, 0.6, 12, 1.0, 0.9, 40, 2, "GSPconcrete") },
                        { "paving", LookJson(props + "brick_paving.png", props + "brick_paving_n.png", null, null, 2, "#9a9a9a", 0.15, 1.0, 0.6, 8, 1.0, 0.9, 30, 2, "GSPconcrete") },
                        // ambientCG Ground032 (CC0, 2K, NormalGL): fine grey gravel path, no height map (its twig heights make the fringe interleave look like grey straw once the strip is 0.6 m wide), 3.5 m a repeat (stones exaggerated: at 1.7 m eye height the real 1.5 m scale mips to an even grain).
                        // tracks: the same stones at their real scale and flatter, paler and warmer - fines packed by wheels.
                        { "gravel", With(LookJson(g32 + "A.png", g32 + "N.png", g32 + "AO.png", null, 3.5, "#676f6c", 0.05, 0.5, 0.8, 6, 1.0, 1.0, 25, 3, "GSPconcrete"),
                            "tracks", new Dictionary<string, object> { { "tileM", 1.5 }, { "tint", "#66625a" }, { "height", g32 + "H.png" }, { "nearNRMStrength", 0.2 }, { "farNRMStrength", 0.3 }, { "blendStrength", 1.6 } }) },
                        { "dirt", LookJson(ground + "GroundCracked01.png", ground + "GroundCracked01_N.png", null, null, 3, "#665c4e", 0.05, 1.0, 0.7, 9, 1.0, 0.9, 30, 2, "GSPconcrete") },
                        { "wood", LookJson(props + "wood_deck_grey.png", props + "wood_deck_grey_n.png", null, null, 2, "#9a9a9a", 0.1, 1.0, 0.6, 8, 1.0, 1.0, 30, 2, "GSPwood") },
                    }
                },
            });
            return GolfMapJsonDoc.ParseObject(text);
        }

        static Dictionary<string, object> LookJson(string albedo, string normal, string occlusion, string height, double tileM, string tint,
            double smoothness, double nearNRM, double farNRM, double farNRMTilingM, double aoBrightness, double detailOpacity,
            double detailDistanceM, double fringeBlendStrength, string physic)
        {
            var d = new Dictionary<string, object> { { "albedo", albedo }, { "normal", normal } };
            if (occlusion != null) d["occlusion"] = occlusion;
            if (height != null) d["height"] = height;
            d["tileM"] = tileM;
            d["tint"] = tint;
            d["smoothness"] = smoothness;
            d["nearNRMStrength"] = nearNRM;
            d["farNRMStrength"] = farNRM;
            d["farNRMTilingM"] = farNRMTilingM;
            d["aoBrightness"] = aoBrightness;
            d["detailOpacity"] = detailOpacity;
            d["detailDistanceM"] = detailDistanceM;
            d["fringeBlendStrength"] = fringeBlendStrength;
            d["physicMaterial"] = "Assets/Resources/Physics/" + physic + ".physicMaterial";
            return d;
        }

        static Dictionary<string, object> With(Dictionary<string, object> d, string key, object value) { d[key] = value; return d; }

        static Spec ReadSpec(string path, string courseFolder, bool dryRun, Dictionary<string, object> result)
        {
            GolfMapJsonObject root = File.Exists(path) ? GolfMapJsonDoc.ParseObject(File.ReadAllText(path)) : null;
            if (root != null && root.String("format") == OldSpecFormat)
            {
                // v1 drew on the retired GolfMap/Path Surface shader (macroTileM, variation): kept beside, defaults written.
                var bak = Path.ChangeExtension(path, null) + ".v1.bak.json";
                result["specMigrated"] = dryRun ? "would move the v1 spec to " + bak + " and write v2 defaults" : "v1 spec moved to " + bak + ", v2 defaults written";
                if (!dryRun)
                {
                    if (File.Exists(bak)) File.Delete(bak);
                    File.Move(path, bak);
                    if (File.Exists(path + ".meta")) File.Delete(path + ".meta");
                    AssetDatabase.ImportAsset(bak);
                }
                root = null;
            }
            if (root == null)
            {
                root = DefaultSpec(courseFolder);
                if (!dryRun)
                {
                    EnsureFolder(Path.GetDirectoryName(path).Replace('\\', '/'));
                    File.WriteAllText(path, GolfMapJsonDoc.Write(root) + "\n");
                    AssetDatabase.ImportAsset(path);
                }
            }
            if (root.String("format") != SpecFormat) throw new BridgeError(path + " is not a " + SpecFormat + " file.");
            var spec = new Spec { unknownSurface = root.String("unknownSurface") ?? "asphalt", baseMaterial = root.String("baseMaterial") ?? DefaultBase };
            var transition = root.Object("transitions");
            if (transition != null)
            {
                Color tint;
                if (!ColorUtility.TryParseHtmlString(transition.String("dirtTint") ?? "#595348", out tint))
                    throw new BridgeError("transitions.dirtTint must be a HTML colour in " + path);
                spec.transitionDirtTint = tint;
                spec.transitionPathStrength = transition.Number("pathBlendStrength", 3);
                spec.transitionDirtStrength = transition.Number("dirtBlendStrength", 1);
                if (double.IsNaN(spec.transitionPathStrength) || double.IsInfinity(spec.transitionPathStrength) || spec.transitionPathStrength <= 0
                    || double.IsNaN(spec.transitionDirtStrength) || double.IsInfinity(spec.transitionDirtStrength) || spec.transitionDirtStrength <= 0)
                    throw new BridgeError("Transition blend strengths must be finite and positive in " + path);
            }
            var pairs = root.Array("sharpPairs");
            if (pairs != null)
                foreach (var pr in pairs.OfType<List<object>>())
                {
                    var two = pr.OfType<string>().ToArray();
                    if (two.Length == 2) spec.sharpPairs.Add(two);
                }
            var surfaces = root.Object("surfaces");
            if (surfaces == null) return spec;
            foreach (var key in surfaces.keys)
            {
                var o = surfaces.Object(key);
                if (o == null) continue;
                var look = spec.looks[key] = ReadLook(o, new Look());
                var tracks = o.Object("tracks");
                if (tracks == null) continue;
                // what the worn look does not say is the surface's own
                look.tracks = ReadLook(tracks, look);
                look.tracksBlendStrength = tracks.Number("blendStrength", 1.5);
            }
            return spec;
        }

        static Look ReadLook(GolfMapJsonObject o, Look d)
        {
            Color tint;
            return new Look
            {
                albedo = o.String("albedo") ?? d.albedo, normal = o.String("normal") ?? d.normal,
                occlusion = o.String("occlusion") ?? d.occlusion, height = o.String("height") ?? d.height,
                physicMaterial = o.String("physicMaterial") ?? d.physicMaterial,
                tileM = o.Number("tileM", d.tileM), smoothness = o.Number("smoothness", d.smoothness),
                nearNRMStrength = o.Number("nearNRMStrength", d.nearNRMStrength), farNRMStrength = o.Number("farNRMStrength", d.farNRMStrength),
                farNRMTilingM = o.Number("farNRMTilingM", d.farNRMTilingM), aoBrightness = o.Number("aoBrightness", d.aoBrightness),
                detailOpacity = o.Number("detailOpacity", d.detailOpacity), detailDistanceM = o.Number("detailDistanceM", d.detailDistanceM),
                fringeBlendStrength = o.Number("fringeBlendStrength", d.fringeBlendStrength),
                tint = o.String("tint") != null && ColorUtility.TryParseHtmlString(o.String("tint"), out tint) ? tint : d.tint,
            };
        }

        // ------------------------------------------------------------ plumbing

        // OPCD's MeshChannelMaterialsStore keeps pointing at its ChannelMaterials, so OPCD's channel editor would
        // rebuild the satellite look; golfmap.course.refresh (step paths.materials) puts the surface back. Once OPCD's
        // tools have made the store remember a material of ours, a whole run keeps it on the worn one (Stores).
        static void Assign(MeshRenderer r, Material m)
        {
            Undo.RecordObject(r, "GolfMap path materials");
            r.sharedMaterial = m;
        }

        // OPCD components live in SetMeshRuntimeDLL: found by type name (compiles without it).
        static MonoBehaviour Opcd(Component c, string typeName)
        {
            return c.GetComponents<MonoBehaviour>().FirstOrDefault(m => m != null && m.GetType().Name == typeName);
        }

        static UnityEngine.Object Field(UnityEngine.Object o, string field)
        {
            if (o == null) return null;
            var p = new SerializedObject(o).FindProperty(field);
            return p != null ? p.objectReferenceValue : null;
        }

        static string AssetPathOf(UnityEngine.Object o) { return o != null ? AssetDatabase.GetAssetPath(o) : null; }

        // paths.json: per object what it wore before look=surface (objects), and - from the retired look=plain -
        // which OPCD material each "(plain)" copy was made from (copies), so photo can still put those back.
        static Dictionary<string, Record> ReadRecords(string path)
        {
            var result = new Dictionary<string, Record>(StringComparer.Ordinal);
            if (!File.Exists(path)) return result;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var objects = root.Object("objects");
            if (objects != null)
                foreach (var key in objects.keys)
                {
                    var o = objects.Object(key);
                    if (o != null) result[key] = new Record { material = o.String("material"), channels = o.String("channelMaterials"), physic = o.String("physicMaterial") };
                }
            var copies = root.Object("copies");
            if (copies != null)
            {
                // Objects still wearing a plain copy: recorded as wearing its original.
                foreach (var r in UnityEngine.Object.FindObjectsOfType<MeshRenderer>())
                {
                    if (result.ContainsKey(r.name) || r.sharedMaterial == null) continue;
                    var o = copies.Object(AssetDatabase.GetAssetPath(r.sharedMaterial));
                    if (o != null) result[r.name] = new Record { material = o.String("original"), channels = o.String("channelMaterials"), physic = PhysicPath(r) };
                }
            }
            return result;
        }

        static void WriteRecords(string path, Dictionary<string, Record> records)
        {
            var objects = new SortedDictionary<string, object>(StringComparer.Ordinal);
            foreach (var kv in records)
            {
                var d = new Dictionary<string, object> { { "material", kv.Value.material }, { "channelMaterials", kv.Value.channels } };
                if (kv.Value.physic != null) d["physicMaterial"] = kv.Value.physic;
                objects[kv.Key] = d;
            }
            EnsureFolder(Path.GetDirectoryName(path).Replace('\\', '/'));
            File.WriteAllText(path, GolfMapJson.Serialize(new Dictionary<string, object>
            {
                { "note", "golfmap.paths.materials: what each path mesh and blend wore (OPCD material, ChannelMaterials, collider physic material) before look=surface. look=photo puts these back." },
                { "objects", objects },
            }) + "\n");
            AssetDatabase.ImportAsset(path);
        }

        static string Safe(string name) { return string.Join("_", name.Split(Path.GetInvalidFileNameChars())); }

        static void EnsureFolder(string folder)
        {
            var parts = folder.TrimEnd('/').Split('/');
            var path = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                var next = path + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(path, parts[i]);
                path = next;
            }
        }
    }
}
