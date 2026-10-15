// Performance ranking: what costs the most frame time on this course, per category, with the geometry
// behind it (GolfMap > Performance Ranking, bridge golfmap.perf.report / hide / show). Unity 2018.2 / C# 6.
//
// Categories come from GolfMapPerfCategories.json beside this file, by rule and never by object list:
// course meshes by surface, props by group, stone, water, power lines (regexes on the hierarchy path),
// Stix 3D grass and terrains (component types), the VSP systems per vegetation type, all shadows,
// post-processing. A renderer no rule catches lands in "other:<root object>", and the report says what
// share of the renderers and triangles the rules caught. The game side (unity/ArboristMod/perf.ts --rank)
// reads the same file and writes the same JSON (golfmap-perf-rank-v1; model and tests in
// unity/perf-rank.ts), so the two can be laid side by side.
//
// Cost: at each viewpoint the Scene view frame is timed with everything on, then with exactly one
// category off, with a fresh baseline every few cases, over several rounds. A case is compared with
// the baselines just before and after it; the saving is the median over the rounds, in milliseconds
// per frame (which add up; fps is derived). A saving no larger than the noise (the median difference
// between one baseline and the next) or than half the spread of its own rounds is "not measurable".
// Timing and the VSP item hides are GolfMapVegPerf's (Update + LateUpdate of every edit-mode behaviour,
// then a GPU-synced render of the Scene view camera).
//
// What the numbers are: Scene view rendering in the editor. No frame-rate cap, no GSPro systems (the
// Arborist vegetation, GSPro's sky and UI are not in the editor). Good for ranking and for geometry
// (the real meshes, before a build's static batching); the game is the truth for absolute fps.
//
// Everything switched off is scene or project state (renderers, components, VSP layers, the shadow
// quality): it is put back after each case, and before a scene save, a script reload and quit.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using Object = UnityEngine.Object;

namespace GolfMap.Editor
{
    static class GolfMapPerf
    {
        public const string Format = "golfmap-perf-rank-v1";
        const string RulesFormat = "golfmap-perf-categories-v1";
        const string RulesFile = "GolfMapPerfCategories.json";
        // The course's judged viewpoints, a copy of docs/gspro/<course>/perf-views.json in the course folder.
        public const string ViewsFile = "perf-views.json";

        internal const string EditorNote = "Editor numbers: the Scene view camera rendered off screen, no frame-rate cap, no GSPro systems (the Arborist vegetation, GSPro's sky and UI are not in the editor). Good for ranking and geometry; the game (unity/ArboristMod/perf.ts --rank) is the truth for absolute fps.";

        // ---- rules ------------------------------------------------------------------------------

        sealed class Rule
        {
            public string id, label, group, kind, component, system, type;
            public Regex match;
        }

        static List<Rule> LoadRules()
        {
            var script = AssetDatabase.FindAssets("GolfMapPerf t:MonoScript").Select(AssetDatabase.GUIDToAssetPath)
                .FirstOrDefault(p => Path.GetFileName(p) == "GolfMapPerf.cs");
            var file = script == null ? null : Path.Combine(Path.GetDirectoryName(script), RulesFile);
            if (file == null || !File.Exists(file)) throw new BridgeError("No " + RulesFile + " beside GolfMapPerf.cs: sync unity/Editor/GolfMap into the project.");
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            if (root.String("format") != RulesFormat) throw new BridgeError(file + " is not " + RulesFormat + ".");
            var rules = new List<Rule>();
            foreach (var c in root.Array("categories").Cast<GolfMapJsonObject>())
                rules.Add(new Rule
                {
                    id = c.String("id"), label = c.String("label"), group = c.String("group"), kind = c.String("kind"),
                    component = c.String("component"), system = c.String("system"), type = c.String("type"),
                    match = c.String("match") == null ? null : new Regex(c.String("match")),
                });
            return rules;
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return "/" + string.Join("/", parts.ToArray());
        }

        // The rule of a path (null: none, the renderer is "other:<root>"), and how many levels deep one unit of the
        // category is (a car, a wall, a course mesh): the path up to the end of the segment the match ends in, or of
        // the next one when the match ends on a slash. Same as the mod's scene.geometry and unity/perf-rank.ts.
        static Rule GroupOf(List<Rule> rules, string path, out int unitDepth)
        {
            foreach (var rule in rules)
            {
                if (rule.kind != "renderers" || rule.match == null) continue;
                var m = rule.match.Match(path);
                if (!m.Success) continue;
                int slash = path.IndexOf('/', m.Index + m.Length);
                unitDepth = (slash < 0 ? path : path.Substring(0, slash)).Count(c => c == '/');
                return rule;
            }
            unitDepth = 1;   // no rule: one unit of "other:<root>" is a root object
            return null;
        }

        // Numbered siblings and instantiated copies share one "other" row: FlagAssembly_0..17 -> FlagAssembly_#,
        // teeMarker(Clone)143 -> teeMarker#.
        static string OtherKey(string root)
        {
            return Regex.Replace(root.Replace("(Clone)", ""), "[0-9]+", "#").Trim();
        }

        static Transform Ancestor(Transform t, int depth)
        {
            int own = 0;
            for (var p = t; p; p = p.parent) own++;
            for (; own > depth && t.parent; own--) t = t.parent;
            return t;
        }

        // What the existing classifiers call a course mesh: the rules' course-mesh patterns are checked against them.
        static string SurfaceId(string name)
        {
            if (GolfMapPathMaterials.IsPathMesh(name)) return "mesh.path";
            return "mesh." + GolfMapSurfaces.Classify(name).ToString().ToLowerInvariant();
        }

        // ---- categories -------------------------------------------------------------------------

        internal sealed class Category
        {
            public string id, label, group, kind;
            public List<string> members;   // other:small: the "other" rows folded into it
            // -1: does not apply to this kind of category.
            public long triangles = -1, trianglesLod0 = -1, stored = -1;
            public int objects = -1, renderers = -1, inactiveRenderers = -1, shadowCasters = -1, lodGroups = -1, items = -1;
            public readonly HashSet<Mesh> meshes = new HashSet<Mesh>();
            public readonly HashSet<Material> materials = new HashSet<Material>();
            public readonly HashSet<Transform> units = new HashSet<Transform>();
            public readonly List<Object> targets = new List<Object>();   // renderers or components to switch
            public readonly List<GameObject> select = new List<GameObject>();
            // Switches the category off and returns what puts it back; null: nothing to switch.
            public Func<Action> off;

            static object N(long n) { return n < 0 ? null : (object)n; }

            public Dictionary<string, object> ToJson()
            {
                bool mesh = kind == "renderers";
                var json = new Dictionary<string, object>
                {
                    { "id", id }, { "label", label }, { "group", group }, { "kind", kind },
                    { "geometry", new Dictionary<string, object>
                        {
                            { "objects", N(objects) }, { "renderers", N(renderers) }, { "inactiveRenderers", N(inactiveRenderers) },
                            { "triangles", N(triangles) }, { "trianglesLod0", N(trianglesLod0) },
                            { "meshes", mesh ? (object)meshes.Count : null }, { "materials", mesh ? (object)materials.Count : null },
                            { "shadowCasters", N(shadowCasters) }, { "lodGroups", N(lodGroups) }, { "batchedRenderers", null },
                            { "items", N(items) }, { "storedInstances", N(stored) },
                        } },
                };
                if (members != null) json["members"] = members.Cast<object>().ToList();
                return json;
            }
        }

        static long Triangles(Mesh m)
        {
            long n = 0;
            for (int s = 0; s < m.subMeshCount; s++) n += m.GetIndexCount(s);
            return n / 3;
        }

        static bool TypeIs(string type, VegetationItemInfoPro item)
        {
            switch (type)
            {
                case "Grass": return item.VegetationType == VegetationType.Grass;
                case "Plant": return item.VegetationType == VegetationType.Plant;
                case "Tree": return item.VegetationType == VegetationType.Tree;
                case "Billboard": return item.VegetationType == VegetationType.Tree && item.UseBillboards;
                case "Object": return item.VegetationType == VegetationType.Objects || item.VegetationType == VegetationType.LargeObjects;
                default: return false;
            }
        }

        // The same types as GolfMapVegPerf.ItemStats.type names them.
        static bool TypeIs(string type, string statType)
        {
            return type == "Object" ? statType == "Objects" || statType == "LargeObjects" : type == statType;
        }

        // What is in the active scene, by category, with what switches each off. `absent`: rule ids with nothing in the
        // scene; `disagreements`: course meshes the rules put elsewhere than GolfMapSurfaces.Classify / IsPathMesh do.
        internal static List<Category> Discover(List<string> absent, List<string> disagreements)
        {
            var scene = EditorSceneManager.GetActiveScene();
            var rules = LoadRules();
            var byId = new Dictionary<string, Category>();
            var result = new List<Category>();
            var roots = scene.GetRootGameObjects();

            // The LOD level a renderer is first drawn at; a renderer in no LODGroup counts as level 0.
            var lodOf = new Dictionary<Renderer, int>();
            var lodGroups = new List<LODGroup>();
            foreach (var root in roots)
                foreach (var l in root.GetComponentsInChildren<LODGroup>(true))
                {
                    lodGroups.Add(l);
                    var lods = l.GetLODs();
                    for (int i = 0; i < lods.Length; i++)
                        foreach (var r in lods[i].renderers ?? new Renderer[0])
                        {
                            int was;
                            if (r && (!lodOf.TryGetValue(r, out was) || i < was)) lodOf[r] = i;
                        }
                }

            var categoryOf = new Dictionary<Renderer, Category>();
            int casters = 0;
            foreach (var root in roots)
                foreach (var r in root.GetComponentsInChildren<Renderer>(true))
                {
                    string path = PathOf(r.transform);
                    int unitDepth;
                    var rule = GroupOf(rules, path, out unitDepth);
                    string other = rule != null ? null : OtherKey(root.name);
                    string id = rule != null ? rule.id : "other:" + other;
                    Category cat;
                    if (!byId.TryGetValue(id, out cat))
                    {
                        cat = new Category
                        {
                            id = id, label = rule != null ? rule.label : "Other: " + other, group = rule != null ? rule.group : "Other", kind = "renderers",
                            triangles = 0, trianglesLod0 = 0, objects = 0, renderers = 0, inactiveRenderers = 0, shadowCasters = 0, lodGroups = 0,
                        };
                        byId[id] = cat;
                        result.Add(cat);
                    }
                    categoryOf[r] = cat;
                    if (disagreements != null && GolfMapSurfaces.IsCourseMesh(r.name) && SurfaceId(r.name) != id && disagreements.Count < 20)
                        disagreements.Add(r.name + ": rules " + id + ", classifier " + SurfaceId(r.name));
                    // A renderer this tool has switched off is still part of the scene.
                    if (!r.gameObject.activeInHierarchy || !(r.enabled || switchedOff.Contains(r))) { cat.inactiveRenderers++; continue; }
                    cat.renderers++;
                    cat.targets.Add(r);
                    cat.units.Add(Ancestor(r.transform, unitDepth));
                    if (r.shadowCastingMode != ShadowCastingMode.Off) { cat.shadowCasters++; casters++; }
                    Mesh mesh = null;
                    var skinned = r as SkinnedMeshRenderer;
                    if (skinned) mesh = skinned.sharedMesh;
                    else if (r is MeshRenderer) { var f = r.GetComponent<MeshFilter>(); if (f) mesh = f.sharedMesh; }
                    if (mesh)
                    {
                        long tris = Triangles(mesh);
                        int lod;
                        cat.triangles += tris;
                        if (!lodOf.TryGetValue(r, out lod) || lod == 0) cat.trianglesLod0 += tris;
                        cat.meshes.Add(mesh);
                    }
                    foreach (var m in r.sharedMaterials) if (m) cat.materials.Add(m);
                }
            foreach (var l in lodGroups)
            {
                var first = l.GetLODs().SelectMany(x => x.renderers ?? new Renderer[0]).FirstOrDefault(x => x);
                Category cat;
                if (first && categoryOf.TryGetValue(first, out cat)) cat.lodGroups++;
            }
            result = FoldOthers(result);
            foreach (var c in result)
            {
                var cat = c;
                cat.objects = cat.units.Count;
                if (cat.id == SmallOther) cat.label = "Other: small objects (" + cat.objects + " roots)";
                cat.select.AddRange(cat.units.Where(u => u).Select(u => u.gameObject));
                if (cat.targets.Count > 0) cat.off = () => SwitchOff(cat.targets);
            }
            // The rules' own order first, then what no rule caught.
            result = result.OrderBy(c => { int i = rules.FindIndex(r => r.id == c.id); return i < 0 ? int.MaxValue : i; }).ToList();
            foreach (var rule in rules.Where(r => r.kind == "renderers" && !byId.ContainsKey(r.id))) absent.Add(rule.id);
            // The folded small rows last.
            result = result.OrderBy(c => c.id == SmallOther ? 1 : 0).ToList();

            // A plain loop: Mono's SelectMany + ToList over these arrays threw ArrayTypeMismatchException
            // (an array of a derived component type stored into the List<Behaviour>), 2026-10-14.
            var behaviours = new List<Behaviour>();
            foreach (var g in roots)
                foreach (var c in g.GetComponentsInChildren(typeof(Behaviour), true))
                {
                    var b = c as Behaviour;   // not every element casts (seen on Vreta: a broken script reference)
                    if (b) behaviours.Add(b);
                }
            var systems = GolfMapVegPerf.Systems().Where(s => s.isActiveAndEnabled).ToList();
            var sv = SceneView.lastActiveSceneView;
            var stored = new Dictionary<string, long>();
            foreach (var st in GolfMapVegPerf.Snapshot(sv != null ? sv.camera : null, true)) stored[st.system + "|" + st.package + "|" + st.name] = st.stored;

            foreach (var r in rules)
            {
                var rule = r;
                var cat = new Category { id = rule.id, label = rule.label, group = rule.group, kind = rule.kind };
                if (rule.kind == "component")
                {
                    var list = behaviours.Where(b => b.GetType().FullName.IndexOf(rule.component, StringComparison.OrdinalIgnoreCase) >= 0
                        && b.gameObject.activeInHierarchy && (b.enabled || switchedOff.Contains(b))).ToList();
                    if (list.Count == 0) { absent.Add(rule.id); continue; }
                    cat.objects = list.Count;
                    cat.targets.AddRange(list.Cast<Object>());
                    cat.select.AddRange(list.Select(b => b.gameObject));
                    cat.off = () => SwitchOff(cat.targets);
                }
                else if (rule.kind == "vsp")
                {
                    // Every system of the scene is the course's own; GSPro's (the Arborist file) exists only in the game.
                    var items = rule.system == "course" ? systems.SelectMany(s => GolfMapVegPerf.Items(s)).Where(i => TypeIs(rule.type, i.item)).ToList() : new List<GolfMapVegPerf.ItemRef>();
                    if (items.Count == 0) { absent.Add(rule.id); continue; }
                    cat.items = items.Count;
                    cat.stored = 0;
                    foreach (var i in items)
                    {
                        long n;
                        if (stored.TryGetValue(GolfMapVegPerf.SystemLabel(i.system) + "|" + i.package.PackageName + "|" + i.item.Name, out n)) cat.stored += n;
                    }
                    cat.select.AddRange(systems.Select(s => s.gameObject));
                    if (rule.type == "Billboard") cat.off = () => BillboardsOff(systems);
                    else cat.off = () =>
                    {
                        var set = items.Where(i => !GolfMapVegPerf.IsHidden(i)).ToList();
                        GolfMapVegPerf.SetHidden(set, true);
                        return Pending(() => GolfMapVegPerf.SetHidden(set, false));
                    };
                }
                else if (rule.kind == "shadows")
                {
                    if (QualitySettings.shadows == ShadowQuality.Disable && !shadowsOff) { absent.Add(rule.id); continue; }
                    cat.shadowCasters = casters;
                    cat.off = ShadowsOff;
                }
                else continue;
                result.Add(cat);
            }
            return result;
        }

        internal const string SmallOther = "other:small";

        // Every "other" row holding under 0.5 % of the scene's triangles and under 0.5 % of its renderers goes into one
        // row, whose members are listed in the JSON only (unity/perf-rank.ts foldOthers). A single small row stays.
        static List<Category> FoldOthers(List<Category> categories)
        {
            long renderers = categories.Sum(c => (long)c.renderers), triangles = categories.Sum(c => c.triangles);
            var small = categories.Where(c => c.id.StartsWith("other:", StringComparison.Ordinal) && c.triangles < 0.005 * triangles && c.renderers < 0.005 * renderers).ToList();
            if (small.Count < 2) return categories;
            var folded = new Category
            {
                id = SmallOther, label = "Other: small objects", group = "Other", kind = "renderers", members = small.Select(c => c.id).ToList(),
                triangles = 0, trianglesLod0 = 0, objects = 0, renderers = 0, inactiveRenderers = 0, shadowCasters = 0, lodGroups = 0,
            };
            foreach (var c in small)
            {
                folded.triangles += c.triangles; folded.trianglesLod0 += c.trianglesLod0; folded.renderers += c.renderers;
                folded.inactiveRenderers += c.inactiveRenderers; folded.shadowCasters += c.shadowCasters; folded.lodGroups += c.lodGroups;
                folded.meshes.UnionWith(c.meshes); folded.materials.UnionWith(c.materials); folded.units.UnionWith(c.units);
                folded.targets.AddRange(c.targets);
            }
            var result = categories.Where(c => !small.Contains(c)).ToList();
            result.Add(folded);
            return result;
        }

        // ---- switches (scene and project state: remembered and put back) ---------------------------

        static readonly HashSet<Object> switchedOff = new HashSet<Object>();
        static readonly List<Action> pending = new List<Action>();
        static readonly Dictionary<string, Action> hidden = new Dictionary<string, Action>();   // window / golfmap.perf.hide
        static bool shadowsOff;

        // Registers a restore; the returned action runs it once and forgets it.
        static Action Pending(Action restore)
        {
            Action once = null;
            once = () =>
            {
                if (!pending.Remove(once)) return;
                try { restore(); } catch (Exception e) { Debug.LogException(e); }
            };
            pending.Add(once);
            return once;
        }

        static void Enable(Object o, bool on)
        {
            var r = o as Renderer;
            var b = o as Behaviour;
            if (r) r.enabled = on; else if (b) b.enabled = on;
        }

        static bool Enabled(Object o)
        {
            var r = o as Renderer;
            var b = o as Behaviour;
            return r ? r.enabled : b && b.enabled;
        }

        static Action SwitchOff(List<Object> targets)
        {
            var changed = new List<Object>();
            foreach (var o in targets)
            {
                if (!o || !Enabled(o)) continue;
                Enable(o, false);
                switchedOff.Add(o);
                changed.Add(o);
            }
            Repaint();
            return Pending(() =>
            {
                foreach (var o in changed)
                {
                    switchedOff.Remove(o);
                    if (o) Enable(o, true);
                }
                Repaint();
            });
        }

        // Billboards have no item to hide (VSP draws a cell's billboards as one mesh on the system's billboard layer),
        // so, as the mod's veg.draw does in the game: the layer goes to an unused one that the Scene view does not draw.
        static Action BillboardsOff(List<VegetationSystemPro> systems)
        {
            int layer = -1;
            for (int i = 31; i >= 8 && layer < 0; i--) if (string.IsNullOrEmpty(LayerMask.LayerToName(i))) layer = i;
            if (layer < 0) throw new BridgeError("every layer has a name: there is none to hide the billboards on");
            var was = systems.Where(s => s).ToDictionary(s => s, s => s.VegetationSettings.BillboardLayer);
            int visible = Tools.visibleLayers;
            var sv = SceneView.lastActiveSceneView;
            int mask = sv != null ? sv.camera.cullingMask : 0;
            foreach (var s in was.Keys) s.VegetationSettings.BillboardLayer = layer;
            Tools.visibleLayers = visible & ~(1 << layer);
            if (sv != null) sv.camera.cullingMask = mask & ~(1 << layer);
            Repaint();
            return Pending(() =>
            {
                foreach (var kv in was) if (kv.Key) kv.Key.VegetationSettings.BillboardLayer = kv.Value;
                Tools.visibleLayers = visible;
                if (sv != null) sv.camera.cullingMask = mask;
                Repaint();
            });
        }

        static Action ShadowsOff()
        {
            if (shadowsOff) return Pending(() => { });
            var was = QualitySettings.shadows;
            QualitySettings.shadows = ShadowQuality.Disable;
            shadowsOff = true;
            Repaint();
            return Pending(() => { QualitySettings.shadows = was; shadowsOff = false; Repaint(); });
        }

        internal static bool IsHidden(string id) { return hidden.ContainsKey(id); }
        internal static bool AnythingOff { get { return pending.Count > 0; } }

        internal static void SetHidden(Category cat, bool hide)
        {
            Action restore;
            if (hide)
            {
                if (hidden.ContainsKey(cat.id) || cat.off == null) return;
                hidden[cat.id] = cat.off();
            }
            else if (hidden.TryGetValue(cat.id, out restore))
            {
                hidden.Remove(cat.id);
                restore();
            }
            if (Changed != null) Changed();
        }

        // Everything back as the scene was.
        internal static int RestoreAll(string reason = null)
        {
            int n = pending.Count;
            hidden.Clear();
            foreach (var restore in pending.ToList()) restore();
            if (n > 0 && reason != null) Debug.Log("[GolfMap] Performance ranking: switched " + n + " hidden part(s) back on " + reason + ".");
            if (n > 0 && Changed != null) Changed();
            return n;
        }

        [InitializeOnLoadMethod]
        static void Hooks()
        {
            EditorSceneManager.sceneSaving += (scene, path) => RestoreAll("before saving the scene");
            AssemblyReloadEvents.beforeAssemblyReload += () => RestoreAll("before a script reload");
            EditorApplication.quitting += () => RestoreAll("on quit");
        }

        internal static event Action Changed;
        static void Repaint()
        {
            SceneView.RepaintAll();
            EditorApplication.QueuePlayerLoopUpdate();
        }

        // ---- statistics (the same sums as unity/perf-rank.ts: change both) -------------------------

        internal sealed class Reading
        {
            public string id;   // null: a baseline
            public double ms;
        }

        internal sealed class Cost
        {
            public string id, status;
            public double savedMs, spreadMs, share, caseMs;
            public double? fpsGain;
            public List<double> deltas = new List<double>();

            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "id", id }, { "savedMs", Math.Round(savedMs, 3) }, { "spreadMs", Math.Round(spreadMs, 3) },
                    { "fpsGain", fpsGain.HasValue ? (object)Math.Round(fpsGain.Value, 1) : null }, { "share", Math.Round(share, 4) },
                    { "status", status }, { "caseMs", Math.Round(caseMs, 3) }, { "deltas", deltas.Select(d => (object)Math.Round(d, 3)).ToList() },
                };
            }
        }

        internal sealed class ViewResult
        {
            public string name;
            public Vector3 position, rotation;
            public double baselineMs, noiseMs;
            public List<double> baselines = new List<double>();
            public List<Cost> costs = new List<Cost>();
            public GolfMapVegPerf.Timing frame;
            public Dictionary<string, object> inView = new Dictionary<string, object>();
            public double BaselineFps { get { return baselineMs > 0 ? 1000 / baselineMs : 0; } }

            public Dictionary<string, object> ToJson()
            {
                var json = new Dictionary<string, object>
                {
                    { "name", name }, { "position", new List<object> { position.x, position.y, position.z } }, { "rotation", new List<object> { rotation.x, rotation.y, rotation.z } },
                    { "baselineMs", Math.Round(baselineMs, 3) }, { "baselineFps", Math.Round(BaselineFps, 1) }, { "noiseMs", Math.Round(noiseMs, 3) }, { "capped", false },
                    { "baselines", baselines.Select(b => (object)Math.Round(b, 3)).ToList() }, { "costs", costs.Select(c => (object)c.ToJson()).ToList() },
                    { "inView", inView },
                };
                if (frame != null)
                    json["frame"] = new Dictionary<string, object>
                    {
                        { "vspCpuMs", Math.Round(frame.vspMs, 2) }, { "otherCpuMs", Math.Round(frame.otherMs, 2) }, { "renderGpuMs", Math.Round(frame.renderMs, 2) }, { "p90Ms", Math.Round(frame.p90Ms, 2) },
                    };
                return json;
            }
        }

        internal sealed class RankRow
        {
            public string id, status;
            public double? savedMs, share, fpsGain;
            public int measuredViews, views;

            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "id", id }, { "savedMs", savedMs.HasValue ? (object)Math.Round(savedMs.Value, 3) : null }, { "share", share.HasValue ? (object)Math.Round(share.Value, 4) : null },
                    { "fpsGain", fpsGain.HasValue ? (object)Math.Round(fpsGain.Value, 1) : null }, { "measuredViews", measuredViews }, { "views", views }, { "status", status },
                };
            }
        }

        internal static double Median(List<double> values)
        {
            if (values.Count == 0) return 0;
            var s = values.OrderBy(x => x).ToList();
            int mid = s.Count / 2;
            return s.Count % 2 == 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
        }

        // What each category costs at one viewpoint, from its readings in the order they were taken. The editor has no
        // frame-rate cap, so the statuses are "measured" and "noise" only (the game adds "capped" and "floor").
        internal static void Costs(List<Reading> readings, ViewResult view)
        {
            view.baselines = readings.Where(r => r.id == null).Select(r => r.ms).ToList();
            view.baselineMs = Median(view.baselines);
            var steps = new List<double>();
            for (int i = 1; i < view.baselines.Count; i++) steps.Add(Math.Abs(view.baselines[i] - view.baselines[i - 1]));
            view.noiseMs = Median(steps);
            var byId = new Dictionary<string, Cost>();
            var caseMs = new Dictionary<string, List<double>>();
            for (int i = 0; i < readings.Count; i++)
            {
                var r = readings[i];
                if (r.id == null) continue;
                double? before = null, after = null;
                for (int j = i - 1; j >= 0 && before == null; j--) if (readings[j].id == null) before = readings[j].ms;
                for (int j = i + 1; j < readings.Count && after == null; j++) if (readings[j].id == null) after = readings[j].ms;
                double around = before.HasValue && after.HasValue ? (before.Value + after.Value) / 2 : before ?? after ?? view.baselineMs;
                Cost cost;
                if (!byId.TryGetValue(r.id, out cost)) { byId[r.id] = cost = new Cost { id = r.id }; caseMs[r.id] = new List<double>(); view.costs.Add(cost); }
                cost.deltas.Add(around - r.ms);
                caseMs[r.id].Add(r.ms);
            }
            foreach (var cost in view.costs)
            {
                cost.savedMs = Median(cost.deltas);
                cost.spreadMs = cost.deltas.Max() - cost.deltas.Min();
                cost.caseMs = Median(caseMs[cost.id]);
                cost.status = Math.Abs(cost.savedMs) <= view.noiseMs || Math.Abs(cost.savedMs) <= cost.spreadMs / 2 ? "noise" : "measured";
                cost.fpsGain = view.baselineMs > 0 && view.baselineMs - cost.savedMs > 0 ? 1000 / (view.baselineMs - cost.savedMs) - 1000 / view.baselineMs : (double?)null;
                cost.share = view.baselineMs > 0 ? cost.savedMs / view.baselineMs : 0;
            }
            view.costs = view.costs.OrderByDescending(c => c.savedMs).ToList();
        }

        // Overall: the mean saving over the viewpoints; a saving inside the noise counts as none.
        internal static List<RankRow> Ranking(List<Category> categories, List<ViewResult> views)
        {
            var rows = new List<RankRow>();
            foreach (var c in categories)
            {
                var costs = views.Select(v => v.costs.FirstOrDefault(k => k.id == c.id)).Where(k => k != null).ToList();
                var row = new RankRow { id = c.id, views = costs.Count, status = "not run" };
                if (costs.Count > 0)
                {
                    var real = costs.Where(k => k.status != "noise").ToList();
                    row.savedMs = real.Sum(k => k.savedMs) / costs.Count;
                    row.share = real.Sum(k => k.share) / costs.Count;
                    row.fpsGain = real.Sum(k => k.fpsGain ?? 0) / costs.Count;
                    row.measuredViews = real.Count;
                    row.status = real.Count == 0 ? "noise" : "measured";
                }
                rows.Add(row);
            }
            // Measured savings first, largest first; then what could not be measured or was not run, by triangles; the
            // "other" rows last.
            Func<RankRow, int> tier = r => r.status == "measured" ? 0 : r.id.StartsWith("other:", StringComparison.Ordinal) ? 2 : 1;
            Func<RankRow, double> key = r => r.status == "measured" ? r.savedMs ?? 0 : categories.First(c => c.id == r.id).triangles;
            return rows.OrderBy(tier).ThenByDescending(key).ToList();
        }

        // ---- viewpoints ---------------------------------------------------------------------------

        internal sealed class ViewSpec
        {
            public string name;
            public Vector3 position, rotation;
            public float eye = float.NaN;   // metres over the ground instead of position.y
            public bool current;            // the Scene view as it stands
        }

        internal static string DefaultViewsFile()
        {
            return GolfMapCourses.Folder(GolfMapCourses.Require()) + ViewsFile;
        }

        static Vector3 Vector(List<object> list, string what)
        {
            if (list == null || list.Count != 3 || !list.All(o => o is GolfMapJsonNumber)) throw new BridgeError(what + " must be [x, y, z].");
            return new Vector3((float)((GolfMapJsonNumber)list[0]).Value, (float)((GolfMapJsonNumber)list[1]).Value, (float)((GolfMapJsonNumber)list[2]).Value);
        }

        // golfmap-perf-views-v1 ({ views: [...] }); a file of the first shape, { "<Course>": [...] }, still reads.
        internal static List<ViewSpec> LoadViews(string file)
        {
            if (!File.Exists(file)) throw new BridgeError("No viewpoints file " + file + " (copy docs/gspro/<course>/perf-views.json into the course folder, or measure the current view).");
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            var list = root.Array("views") ?? root.Array(GolfMapCourses.Name(GolfMapCourses.Require()));
            if (list == null) throw new BridgeError(file + " holds no views.");
            var views = new List<ViewSpec>();
            foreach (var v in list.Cast<GolfMapJsonObject>())
                views.Add(new ViewSpec
                {
                    name = v.String("name"), position = Vector(v.Array("position"), "position"), rotation = Vector(v.Array("rotation"), "rotation"),
                    eye = v.Has("eye") ? (float)v.Number("eye", double.NaN) : float.NaN,
                });
            return views;
        }

        internal static ViewSpec CurrentView() { return new ViewSpec { name = "current view", current = true }; }

        // In 2018.2 the Scene view camera sits exactly `size` behind the pivot (BridgeBuiltins.Screenshot).
        static void Pose(SceneView sv, ViewSpec view, out Vector3 position, out Quaternion rotation)
        {
            position = view.position;
            if (!float.IsNaN(view.eye))
            {
                var ground = GolfMapProps.Ground(position.x, position.z, null);
                if (ground == null) throw new BridgeError("No ground (collider) under view '" + view.name + "'.");
                position.y = ground.Value + view.eye;
            }
            rotation = Quaternion.Euler(view.rotation);
            const float distance = 10f;
            sv.orthographic = false;
            sv.LookAtDirect(position + rotation * Vector3.forward * distance, rotation, distance);
        }

        // ---- the report ---------------------------------------------------------------------------

        internal sealed class Options
        {
            public List<ViewSpec> views = new List<ViewSpec>();
            public int rounds = 3, frames = 40, settle = 90, width = 1920, height = 1080, baselineEvery = 3;
            public string[] only;   // category ids (or their first part) and group names; null: all
        }

        internal sealed class Result
        {
            public List<Category> categories = new List<Category>();
            public List<ViewResult> views = new List<ViewResult>();
            public List<RankRow> ranking = new List<RankRow>();
            public List<string> absent = new List<string>(), notes = new List<string>(), disagreements = new List<string>();
            public long renderers, namedRenderers, triangles, namedTriangles;
            public Dictionary<string, object> json;
        }

        // The "other" rows are counted but not timed unless asked for (only=other).
        static bool Wanted(string[] only, Category c)
        {
            if (only == null || only.Length == 0) return c.group != "Other";
            return only.Any(o => c.id.StartsWith(o, StringComparison.OrdinalIgnoreCase) || string.Equals(c.group, o, StringComparison.OrdinalIgnoreCase));
        }

        // Geometry only: what is in the scene per category, nothing timed.
        internal static Result Geometry()
        {
            var result = new Result();
            result.categories = Discover(result.absent, result.disagreements);
            Finish(result, new Options { rounds = 0 });
            return result;
        }

        // Yields null once per editor frame; the result lands in holder[0].
        internal static IEnumerable<object> Run(Options o, Result[] holder, Action<string> progress)
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null) throw new BridgeError("No Scene view is open.");
            RestoreAll();
            var result = new Result();
            result.categories = Discover(result.absent, result.disagreements);
            var cases = result.categories.Where(c => c.off != null && Wanted(o.only, c)).ToList();
            var oldPivot = sv.pivot; var oldRotation = sv.rotation; var oldSize = sv.size; bool oldOrtho = sv.orthographic;
            var t = new GolfMapVegPerf.Timing[1];
            try
            {
                foreach (var spec in o.views)
                {
                    var view = new ViewResult { name = spec.name };
                    if (!spec.current)
                    {
                        Vector3 position; Quaternion rotation;
                        Pose(sv, spec, out position, out rotation);
                        for (int i = 0; i < 4; i++) { sv.Repaint(); yield return null; }
                        // The measured render reads the camera's transform; an unfocused editor may not have repainted yet.
                        sv.camera.transform.position = position;
                        sv.camera.transform.rotation = rotation;
                    }
                    view.position = sv.camera.transform.position;
                    view.rotation = sv.camera.transform.eulerAngles;
                    var readings = new List<Reading>();
                    for (int round = 0; round < o.rounds; round++)
                    {
                        string where = spec.name + ", round " + (round + 1) + "/" + o.rounds + ": ";
                        if (progress != null) progress(where + "baseline");
                        // The first baseline also lets VSP load the cells round the new viewpoint.
                        foreach (var step in GolfMapVegPerf.Measure(round == 0 ? o.settle : 10, o.frames, o.width, o.height, round == 0, t)) yield return step;
                        if (round == 0) view.frame = t[0];
                        readings.Add(new Reading { ms = t[0].totalMs });
                        for (int c = 0; c < cases.Count; c++)
                        {
                            var cat = cases[c];
                            if (progress != null) progress(where + (c + 1) + "/" + cases.Count + " " + cat.label + " off");
                            Action restore;
                            try { restore = cat.off(); }
                            catch (BridgeError e)
                            {
                                result.notes.Add(cat.label + " could not be switched off: " + e.Message + ".");
                                cases.RemoveAt(c--);
                                continue;
                            }
                            try
                            {
                                foreach (var step in GolfMapVegPerf.Measure(8, o.frames, o.width, o.height, false, t)) yield return step;
                            }
                            finally { restore(); }
                            readings.Add(new Reading { id = cat.id, ms = t[0].totalMs });
                            // A fresh baseline every few cases: GPU clocks and editor load drift.
                            if (c % o.baselineEvery == o.baselineEvery - 1 || c == cases.Count - 1)
                            {
                                foreach (var step in GolfMapVegPerf.Measure(10, o.frames, o.width, o.height, false, t)) yield return step;
                                readings.Add(new Reading { ms = t[0].totalMs });
                            }
                        }
                    }
                    Costs(readings, view);
                    if (view.frame != null && view.frame.items != null)
                        foreach (var cat in result.categories.Where(c => c.kind == "vsp" && !c.id.EndsWith(".billboard", StringComparison.Ordinal)))
                        {
                            string type = TypeOf(cat.id);
                            var seen = view.frame.items.Where(s => TypeIs(type, s.type)).ToList();
                            view.inView[cat.id] = new Dictionary<string, object> { { "instances", seen.Sum(s => s.VisibleInstances) }, { "triangles", seen.Sum(s => s.VisibleTris) } };
                        }
                    result.views.Add(view);
                }
            }
            finally
            {
                RestoreAll();
                if (o.views.Any(v => !v.current))
                {
                    sv.LookAtDirect(oldPivot, oldRotation, oldSize);
                    sv.orthographic = oldOrtho;
                }
                sv.Repaint();
            }
            Finish(result, o);
            holder[0] = result;
        }

        // "vsp.course.grass" -> "Grass", as the rules file spells the types.
        static string TypeOf(string id)
        {
            string last = id.Substring(id.LastIndexOf('.') + 1);
            return last.Length == 0 ? last : char.ToUpperInvariant(last[0]) + last.Substring(1);
        }

        static void Finish(Result result, Options o)
        {
            result.ranking = Ranking(result.categories, result.views);
            var mesh = result.categories.Where(c => c.kind == "renderers").ToList();
            var named = mesh.Where(c => !c.id.StartsWith("other:", StringComparison.Ordinal)).ToList();
            result.renderers = mesh.Sum(c => (long)c.renderers); result.namedRenderers = named.Sum(c => (long)c.renderers);
            result.triangles = mesh.Sum(c => c.triangles); result.namedTriangles = named.Sum(c => c.triangles);
            var notes = new List<object> { EditorNote, "The VSP type rows include VSP's own CPU work for the type (merging, culling); the game's rows (veg.draw) only the drawing." };
            notes.AddRange(result.notes.Cast<object>());
            if (result.disagreements.Count > 0) notes.Add("Rules and GolfMapSurfaces.Classify disagree on " + result.disagreements.Count + " course mesh(es): " + string.Join("; ", result.disagreements.Take(5).ToArray()) + ".");
            var course = GolfMapCourses.Active();
            var sv = SceneView.lastActiveSceneView;
            result.json = new Dictionary<string, object>
            {
                { "format", Format }, { "source", "editor" },
                { "course", course ? GolfMapCourses.Name(course) : EditorSceneManager.GetActiveScene().name },
                { "created", DateTime.Now.ToString("s") },
                { "conditions", new Dictionary<string, object>
                    {
                        { "resolution", o.width + "x" + o.height }, { "quality", QualitySettings.names[QualitySettings.GetQualityLevel()] }, { "capFps", null },
                        { "rounds", o.rounds }, { "reading", o.frames + " frames (median)" }, { "frameMsIs", "median frame of a reading" },
                        { "settleFrames", o.settle }, { "baselineEvery", o.baselineEvery },
                        { "camera", "Scene view" }, { "fov", sv != null ? (object)sv.camera.fieldOfView : null },
                        { "shadowDistance", QualitySettings.shadowDistance }, { "shadowCascades", QualitySettings.shadowCascades },
                        { "unity", Application.unityVersion }, { "scene", EditorSceneManager.GetActiveScene().name }, { "notes", notes },
                    } },
                { "categories", result.categories.Select(c => (object)c.ToJson()).ToList() },
                { "absent", result.absent.Cast<object>().ToList() },
                { "coverage", new Dictionary<string, object>
                    {
                        { "renderers", result.renderers }, { "categorisedRenderers", result.namedRenderers },
                        { "rendererShare", Math.Round(result.renderers > 0 ? (double)result.namedRenderers / result.renderers : 1, 4) },
                        { "triangles", result.triangles }, { "categorisedTriangles", result.namedTriangles },
                        { "triangleShare", Math.Round(result.triangles > 0 ? (double)result.namedTriangles / result.triangles : 1, 4) },
                        { "other", mesh.Where(c => c.id.StartsWith("other:", StringComparison.Ordinal)).Select(c => (object)c.id).ToList() },
                    } },
                { "views", result.views.Select(v => (object)v.ToJson()).ToList() },
                { "ranking", result.ranking.Select(r => (object)r.ToJson()).ToList() },
            };
        }

        // ---- bridge commands ------------------------------------------------------------------------

        // ---- the quick reading -----------------------------------------------------------------------

        // A few seconds per view instead of minutes: pose, let VSP load until two short readings agree
        // (or maxSettle readings), then one reading with VSP's per-item counts. No categories switched
        // off, nothing ranked: for an A/B of one change, the same views before and after.
        static IEnumerable<object> Quick(List<ViewSpec> views, int frames, int maxSettle, int top, List<object> rows)
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null) throw new BridgeError("No Scene view is open.");
            var oldPivot = sv.pivot; var oldRotation = sv.rotation; var oldSize = sv.size; bool oldOrtho = sv.orthographic;
            var t = new GolfMapVegPerf.Timing[1];
            try
            {
                foreach (var spec in views)
                {
                    var watch = System.Diagnostics.Stopwatch.StartNew();
                    if (!spec.current)
                    {
                        Vector3 position; Quaternion rotation;
                        Pose(sv, spec, out position, out rotation);
                        for (int i = 0; i < 4; i++) { sv.Repaint(); yield return null; }
                        sv.camera.transform.position = position;
                        sv.camera.transform.rotation = rotation;
                    }
                    double last = -1; int settles = 0;
                    for (; settles < maxSettle; settles++)
                    {
                        foreach (var step in GolfMapVegPerf.Measure(1, 6, 1920, 1080, false, t)) yield return step;
                        double ms = t[0].totalMs;
                        if (last > 0 && Math.Abs(ms - last) <= Math.Max(0.5, 0.03 * last)) break;
                        last = ms;
                    }
                    foreach (var step in GolfMapVegPerf.Measure(0, frames, 1920, 1080, true, t)) yield return step;
                    var f = t[0];
                    var grass = f.items == null ? null : f.items.Where(s => TypeIs("Grass", s.type)).ToList();
                    rows.Add(new Dictionary<string, object>
                    {
                        { "view", spec.name }, { "ms", Math.Round(f.totalMs, 2) }, { "fps", Math.Round(f.Fps, 1) },
                        { "vspCpuMs", Math.Round(f.vspMs, 2) }, { "otherCpuMs", Math.Round(f.otherMs, 2) }, { "renderGpuMs", Math.Round(f.renderMs, 2) }, { "p90Ms", Math.Round(f.p90Ms, 2) },
                        { "settled", settles < maxSettle }, { "grassInstances", grass == null ? 0 : grass.Sum(s => s.VisibleInstances) },
                        { "grassTriangles", grass == null ? 0 : grass.Sum(s => s.VisibleTris) }, { "seconds", Math.Round(watch.Elapsed.TotalSeconds, 1) },
                        // what draws most here: the VSP items (any type) with the most triangles in view
                        { "top", f.items == null ? new List<object>() : f.items.Where(s => s.VisibleTris > 0).OrderByDescending(s => s.VisibleTris).Take(top)
                            .Select(s => (object)(s.name + " (" + s.type + "): " + s.VisibleInstances + " inst, " + Math.Round(s.VisibleTris / 1e6, 2) + " M tris")).ToList() },
                    });
                }
            }
            finally
            {
                if (views.Any(v => !v.current)) { sv.LookAtDirect(oldPivot, oldRotation, oldSize); sv.orthographic = oldOrtho; }
                sv.Repaint();
            }
        }

        [BridgeCommand("golfmap.perf.quick", "The Scene view frame time at the course's viewpoints in a few seconds each, for an A/B of one change: per view the median ms, VSP CPU / other CPU / render ms, and the VSP grass instances and triangles drawn. Waits at each view until two short readings agree (VSP done loading), at most maxSettle readings ('settled': false = still loading, read again). Nothing is switched off or ranked (golfmap.perf.report does that). " + EditorNote,
            args = "views (file; default <course folder>/perf-views.json), view (part of a viewpoint's name; several comma-separated), current=false, frames=30, maxSettle=6, top=8 (the VSP items drawing the most triangles in view)")]
        static IEnumerator QuickCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            List<ViewSpec> views;
            if (a.Bool("current", false)) views = new List<ViewSpec> { CurrentView() };
            else
            {
                views = LoadViews(a.String("views") ?? GolfMapCourses.Folder(course) + "perf-views.json");
                var parts = a.Strings("view").SelectMany(x => x.Split(',')).Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
                if (parts.Count > 0) views = views.Where(v => parts.Any(p => v.name.IndexOf(p, StringComparison.OrdinalIgnoreCase) >= 0)).ToList();
                if (views.Count == 0) throw new BridgeError("No viewpoint matches.");
            }
            var rows = new List<object>();
            var watch = System.Diagnostics.Stopwatch.StartNew();
            foreach (var s in Quick(views, Mathf.Clamp(a.Int("frames", 30), 5, 500), Mathf.Clamp(a.Int("maxSettle", 6), 1, 50), Mathf.Clamp(a.Int("top", 8), 0, 100), rows)) yield return s;
            yield return new Dictionary<string, object> { { "seconds", Math.Round(watch.Elapsed.TotalSeconds, 1) }, { "views", rows } };
        }

        static IEnumerator RunCommand(IEnumerable<object> steps, Func<object> result)
        {
            foreach (var s in steps) yield return s;
            yield return result();
        }

        [BridgeCommand("golfmap.perf.report", "What costs frame time on this course, ranked, per category (course meshes by surface, Stix grass, VSP per type, props by group, stone, water, power lines, terrains, shadows, post-processing; rules in GolfMapPerfCategories.json, anything else as other:<root>, numbered roots together and the small ones folded into other:small): geometry per category (objects, renderers, triangles of every LOD and of LOD0, meshes, materials, shadow casters, LODGroups, VSP items and stored instances) and, at each viewpoint, the Scene view frame time with everything on and with exactly one category off, baselines in between, `rounds` times: median ms saved, the fps that is there, the spread, 'noise' when not measurable; ranked per viewpoint and overall. Result is golfmap-perf-rank-v1, the same JSON unity/ArboristMod/perf.ts --rank writes from GSPro. " + EditorNote,
            args = "views (file; default <course folder>/perf-views.json, else the current view), view (part of a viewpoint's name), current=false (the Scene view as it stands), rounds=3 (0: geometry only), frames=40 (per reading), settle=90 (frames at a new viewpoint first), width=1920, height=1080, only (category ids or their first part, or group names, comma-separated: mesh, vsp, props.vehicles, Vegetation; default all but the other:<root> rows, only=other times those), baselineEvery=3, json=<path> (also write the result there)")]
        static IEnumerator ReportCommand(BridgeArgs a)
        {
            var o = new Options
            {
                rounds = Mathf.Clamp(a.Int("rounds", 3), 0, 20), frames = Mathf.Clamp(a.Int("frames", 40), 5, 2000), settle = Mathf.Clamp(a.Int("settle", 90), 0, 3000),
                width = Mathf.Clamp(a.Int("width", 1920), 16, 4096), height = Mathf.Clamp(a.Int("height", 1080), 16, 4096),
                baselineEvery = Mathf.Clamp(a.Int("baselineEvery", 3), 1, 100),
                // a list or a comma-separated string (a list used to read as no filter at all: every category timed)
                only = a.Has("only") ? a.Strings("only").SelectMany(x => x.Split(',')).Select(x => x.Trim()).Where(x => x.Length > 0).ToArray() : null,
            };
            string json = a.String("json");
            var holder = new Result[1];
            Func<object> finish = () =>
            {
                if (json != null)
                {
                    var folder = Path.GetDirectoryName(Path.GetFullPath(json));
                    Directory.CreateDirectory(folder);
                    File.WriteAllText(json, BridgeJson.Write(holder[0].json));
                }
                return holder[0].json;
            };
            if (o.rounds == 0)
            {
                holder[0] = Geometry();
                return RunCommand(new object[0], finish);
            }
            if (a.Bool("current", false)) o.views.Add(CurrentView());
            else
            {
                string file = a.String("views");
                if (file == null && !File.Exists(DefaultViewsFile())) o.views.Add(CurrentView());
                else o.views = LoadViews(file ?? DefaultViewsFile());
                string part = a.String("view");
                if (part != null) o.views = o.views.Where(v => v.name.IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
                if (o.views.Count == 0) throw new BridgeError("No viewpoint matches.");
            }
            return RunCommand(Run(o, holder, null), finish);
        }

        static Category Find(BridgeArgs a, List<Category> categories)
        {
            string id = a.Require("category");
            var cat = categories.FirstOrDefault(c => string.Equals(c.id, id, StringComparison.OrdinalIgnoreCase));
            if (cat == null) throw new BridgeError("No category '" + id + "' in this scene. Categories: " + string.Join(", ", categories.Select(c => c.id).ToArray()));
            return cat;
        }

        [BridgeCommand("golfmap.perf.hide", "Switch one category of golfmap.perf.report off in the scene (to look at the course without it, or to measure by hand). Nothing is saved: golfmap.perf.show puts it back, and so does a scene save, a script reload and the next report.",
            args = "category (an id of golfmap.perf.report, e.g. props.vehicles, mesh.rough, vsp.course.grass, stix, shadows)")]
        static object HideCommand(BridgeArgs a)
        {
            var cat = Find(a, Discover(new List<string>(), null));
            if (cat.off == null) throw new BridgeError(cat.label + " has nothing to switch off.");
            SetHidden(cat, true);
            return new Dictionary<string, object> { { "hidden", hidden.Keys.Cast<object>().ToList() } };
        }

        [BridgeCommand("golfmap.perf.show", "Switch back on what golfmap.perf.hide switched off: one category, or everything without it.", args = "category")]
        static object ShowCommand(BridgeArgs a)
        {
            if (a.Has("category")) SetHidden(Find(a, Discover(new List<string>(), null)), false);
            else RestoreAll();
            return new Dictionary<string, object> { { "hidden", hidden.Keys.Cast<object>().ToList() } };
        }
    }
}
