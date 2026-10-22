// Unity 2018.2 / C# 6. golfmap.course.ready: a general make-ready before a course build. Checks that every object a
// ball can meet near the playing field has its colliders on, with the GSPro physic material it should have (GSPro
// reads bounce and roll off the collider's material), and that nothing that must not collide does. Report only by
// default; fix=true applies the fixes named below. Never moves an object: it only adds or enables colliders, sets
// physic materials, and takes colliders off the things listed under "must not collide".
//
// The near area: the course meshes (GolfMapSurfaces.IsCourseMesh) whose class is Tee, Fairway, Green, Semi, Rough or
// Bunker, rasterised top-down into a 1 m grid and grown by marginM (40 m) with a 5x5 chamfer distance (within ~2%).
// An object is near when its world bounds (XZ) meet that area; a VSP tree or plant when one of its stored instances
// stands in it. Only activeInHierarchy objects count. Categories (physic materials: Assets/Resources/Physics/GSP*):
//   trees        VSP tree items: ColliderType FromPrefab; the prefab has an enabled trunk collider on GSPwood and a
//                crown on GSPleaves (missing ones are fitted by GolfMapTreeColliders, switched-off ones enabled);
//                PlantDistance x ColliderDistanceFactor >= 300 m (GSPro's advice; the planter sets it too); a billboard-only
//                item near play warns. Items hidden for Arborist (GolfMapVspRig.ShowOnly, <catalogue>.hidden.json) are skipped.
//   bushes       VSP plant items and shrub props (boxwood, arborvitae, hedge ...) over 0.5 m tall AND wide: a collider
//                on GSPleaves; smaller VSP plants: no collider.
//   water        water planes (GolfMapWaterplanes.IsWaterPlane) and the Lux lake's _Collider: an enabled non-convex
//                MeshCollider on GSPwater; Lux's render-only planes (_Outer, _Far, the near plane beside a _Collider): none.
//   creeks / waterfalls   R.A.M. water (RamSpline) under 'GolfMap Creeks' / 'GolfMap Waterfalls': a MeshCollider on
//                its own mesh with GSPwater (as GolfMapCreeks.WaterCollider); the falls' particle systems: no collider.
//   ram-roads    'GolfMap RAM Roads': a MeshCollider with the road surface's physic material (<course>/Paths/
//                path-surfaces.json, as the build; a surface it lacks: GSPconcrete for asphalt/concrete/paving/gravel,
//                GSPrough for dirt and gravel-track).
//   buildings / structures / props / vehicles / markings   'GolfMap Props/<Group>s/<asset>#<n>' (and 'GolfMap
//                Buildings'): the physic material per asset from an explicit `physics` on its <course>/Props/props.json
//                asset, else by keywords in its id and material names (decisions.assets in the report says which);
//                buildings and structures need an enabled collider (fix adds MeshColliders, the baked <id>_collider
//                first), props and vehicles a box when they have none; markings none.
//   walls        'GolfMap Walls': every collider on the walls spec's physicMaterial (GSPstone), as golfmap.walls.colliders.
//   power-lines  'GolfMap Power Lines/<line>/Poles': a MeshCollider on GSPwood; Wires: none.
//   course-meshes  counted (golfmap.course.check owns their colliders); the creek bed (*_WaterBrook_-_Mesh) wants
//                GSPwater, rock slabs the rock-slabs.json physicMaterial (GSPstone), any mesh without one is an error.
//   wispy-rough / horizon / grass   Stix wispy rough, the far shore and VSP grass items: no collider.
//   scene        missing prefab instances; paint previews left (they would ship in the build; fix runs paint.clear);
//                terrain colliders the build leaves out; the scene unsaved.
// Writes <course export folder>/make-ready.json (golfmap-make-ready-v1). golfmap.props.place gives its colliders the
// same physic material (AssetPhysics, one rule for both), so a re-place keeps material fixes; colliders this adds to
// props are made again only when props.json asks for them.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapMakeReady
    {
        public const string Format = "golfmap-make-ready-v1";
        public const string ReportFile = "make-ready.json";
        const string PhysicsFolder = "Assets/Resources/Physics/";
        internal const float ColliderReachM = 300f;    // GSPro: tree colliders out to 300 m from the camera
        const float BushM = 0.5f;             // a plant this tall and wide stops a ball
        internal const float BuildingColliderM = 50f;  // a building farther than this from play carries no collider (props.place adds none)
        static readonly string[] PhysicNames = { "GSPconcrete", "GSPdeeprough", "GSPfairway", "GSPgreen", "GSPleaves", "GSPpinestraw", "GSPrough", "GSPsand", "GSPsemirough", "GSPstone", "GSPtee", "GSPtimber", "GSPwater", "GSPwood" };
        static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;

        [BridgeCommand("golfmap.course.ready", "Make-ready check before a build: every object within marginM of the playing field (course meshes classed Tee/Fairway/Green/Semi/Rough/Bunker, rasterised 1 m and grown by marginM) has its colliders on with the GSPro physic material it should have, and nothing that must not collide does. Categories: VSP trees (From Prefab, trunk GSPwood + crown GSPleaves on the prefab, switched-off prefab colliders, ColliderDistanceFactor x PlantDistance >= 300 m, billboard-only items), bushes (VSP plants and shrub props over 0.5 m: GSPleaves; smaller plants: none), water planes and the Lux lake collider (non-convex MeshCollider, GSPwater; render-only Lux planes: none), R.A.M. creeks and waterfalls (GSPwater; particles: none), R.A.M. roads (surface physics from Paths/path-surfaces.json, else concrete/rough by road type), props buildings/structures/props/vehicles (physic material per asset: props.json `physics`, else keywords; markings: none), walls (spec physicMaterial), power-line poles (GSPwood; wires: none), course meshes (counted; creek bed GSPwater, slabs GSPstone, none = error), wispy rough/horizon/VSP grass (no collider), missing prefabs, paint previews left (fix: paint.clear), terrain colliders the build leaves out, unsaved scene, errors standing in Unity's Console window (handle, then clear it). fix=true adds/enables colliders and sets physic materials (prefab and VSP package assets included, with undo); it never moves an object. Writes <export folder>/make-ready.json (golfmap-make-ready-v1).",
            args = "fix=false (report only; true applies the fixes), marginM=40 (metres round the playing field), limit=60 (findings returned; the file has all), dryRun=false (as fix=false, and no file written), removeMissingPrefabs=false (with fix: delete missing prefab instances, which are otherwise only reported), " + GolfMapSceneSave.Arg)]
        static IEnumerator Command(BridgeArgs a)
        {
            bool dryRun = a.Bool("dryRun", false);
            removeMissingPrefabs = a.Bool("removeMissingPrefabs", false);
            var steps = Run(a.Bool("fix", false) && !dryRun, Mathf.Clamp((float)a.Number("marginM", 40), 0f, 500f), Math.Max(0, a.Int("limit", 60)), !dryRun);
            while (steps.MoveNext()) yield return steps.Current;
        }

        [MenuItem("GolfMap/Check make-ready (colliders near play)")]
        static void Menu()
        {
            var steps = Run(false, 40f, 60, true);
            object last = null;
            while (steps.MoveNext()) if (steps.Current != null) last = steps.Current;
            Debug.Log("[GolfMap Make-ready] " + GolfMapJson.Serialize(last));
        }

        // ------------------------------------------------------------------ the near area

        // The playing field grown by margin, as a 1 m grid with a summed-area table: does a rectangle meet it?
        sealed class NearArea
        {
            public readonly float x0, z0;
            public readonly int w, h;
            readonly int[] sum;   // (w + 1) x (h + 1)
            public long playCells, nearCells;

            public NearArea(List<MeshFilter> play, float margin)
            {
                Bounds all = new Bounds(); bool any = false;
                foreach (var f in play)
                {
                    var b = WorldBounds(f.sharedMesh.bounds, f.transform.localToWorldMatrix);
                    if (!any) { all = b; any = true; } else all.Encapsulate(b);
                }
                int pad = Mathf.CeilToInt(margin) + 4;
                x0 = Mathf.Floor(all.min.x) - pad; z0 = Mathf.Floor(all.min.z) - pad;
                w = Mathf.CeilToInt(all.max.x - x0) + pad; h = Mathf.CeilToInt(all.max.z - z0) + pad;
                if ((long)w * h > 60000000L) throw new BridgeError("The playing field spans " + w + " x " + h + " m: too big for one grid.");
                var dist = new float[w * h];
                for (int i = 0; i < dist.Length; i++) dist[i] = 1e9f;
                foreach (var f in play)
                {
                    var m = f.transform.localToWorldMatrix;
                    var local = f.sharedMesh.vertices;
                    var t = f.sharedMesh.triangles;
                    var px = new float[local.Length]; var pz = new float[local.Length];
                    for (int i = 0; i < local.Length; i++) { var p = m.MultiplyPoint3x4(local[i]); px[i] = p.x - x0; pz[i] = p.z - z0; }
                    for (int i = 0; i + 2 < t.Length; i += 3) Fill(dist, px[t[i]], pz[t[i]], px[t[i + 1]], pz[t[i + 1]], px[t[i + 2]], pz[t[i + 2]]);
                }
                for (int i = 0; i < dist.Length; i++) if (dist[i] == 0f) playCells++;
                // 5x5 chamfer (1, sqrt 2, sqrt 5): two passes; the pad keeps every neighbour inside the grid
                const float d1 = 1f, d2 = 1.41421356f, d3 = 2.23606798f;
                for (int iz = 2; iz < h - 2; iz++)
                    for (int ix = 2; ix < w - 2; ix++)
                    {
                        int i = iz * w + ix; float d = dist[i];
                        if (d == 0f) continue;
                        d = Mathf.Min(d, dist[i - 1] + d1); d = Mathf.Min(d, dist[i - w] + d1);
                        d = Mathf.Min(d, dist[i - w - 1] + d2); d = Mathf.Min(d, dist[i - w + 1] + d2);
                        d = Mathf.Min(d, dist[i - w - 2] + d3); d = Mathf.Min(d, dist[i - w + 2] + d3);
                        d = Mathf.Min(d, dist[i - 2 * w - 1] + d3); d = Mathf.Min(d, dist[i - 2 * w + 1] + d3);
                        dist[i] = d;
                    }
                for (int iz = h - 3; iz >= 2; iz--)
                    for (int ix = w - 3; ix >= 2; ix--)
                    {
                        int i = iz * w + ix; float d = dist[i];
                        if (d == 0f) continue;
                        d = Mathf.Min(d, dist[i + 1] + d1); d = Mathf.Min(d, dist[i + w] + d1);
                        d = Mathf.Min(d, dist[i + w + 1] + d2); d = Mathf.Min(d, dist[i + w - 1] + d2);
                        d = Mathf.Min(d, dist[i + w + 2] + d3); d = Mathf.Min(d, dist[i + w - 2] + d3);
                        d = Mathf.Min(d, dist[i + 2 * w + 1] + d3); d = Mathf.Min(d, dist[i + 2 * w - 1] + d3);
                        dist[i] = d;
                    }
                float limit = margin + 0.5f;   // half a cell: the cell centre against the play cell's edge
                sum = new int[(w + 1) * (h + 1)];
                for (int iz = 0; iz < h; iz++)
                {
                    int row = 0;
                    for (int ix = 0; ix < w; ix++)
                    {
                        if (dist[iz * w + ix] <= limit) { row++; nearCells++; }
                        sum[(iz + 1) * (w + 1) + ix + 1] = sum[iz * (w + 1) + ix + 1] + row;
                    }
                }
            }

            // a triangle (grid metres) into the grid: cells whose centre it covers, and the cells of its corners
            void Fill(float[] dist, float ax, float az, float bx, float bz, float cx, float cz)
            {
                int x0i = Mathf.Max(0, Mathf.FloorToInt(Mathf.Min(ax, Mathf.Min(bx, cx)))), x1i = Mathf.Min(w - 1, Mathf.FloorToInt(Mathf.Max(ax, Mathf.Max(bx, cx))));
                int z0i = Mathf.Max(0, Mathf.FloorToInt(Mathf.Min(az, Mathf.Min(bz, cz)))), z1i = Mathf.Min(h - 1, Mathf.FloorToInt(Mathf.Max(az, Mathf.Max(bz, cz))));
                if (x0i > x1i || z0i > z1i) return;
                Mark(dist, ax, az); Mark(dist, bx, bz); Mark(dist, cx, cz);
                if (x0i == x1i && z0i == z1i) return;
                float det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
                if (Mathf.Abs(det) < 1e-9f) return;
                for (int iz = z0i; iz <= z1i; iz++)
                {
                    float pz = iz + 0.5f;
                    for (int ix = x0i; ix <= x1i; ix++)
                    {
                        float px = ix + 0.5f;
                        float l0 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
                        float l1 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
                        if (l0 < -1e-5f || l1 < -1e-5f || 1f - l0 - l1 < -1e-5f) continue;
                        dist[iz * w + ix] = 0f;
                    }
                }
            }

            void Mark(float[] dist, float x, float z)
            {
                int ix = Mathf.FloorToInt(x), iz = Mathf.FloorToInt(z);
                if (ix >= 0 && iz >= 0 && ix < w && iz < h) dist[iz * w + ix] = 0f;
            }

            public bool Meets(Bounds b) { return Meets(b.min.x, b.min.z, b.max.x, b.max.z); }

            public bool Meets(float minX, float minZ, float maxX, float maxZ)
            {
                int ix0 = Mathf.FloorToInt(minX - x0), iz0 = Mathf.FloorToInt(minZ - z0), ix1 = Mathf.FloorToInt(maxX - x0), iz1 = Mathf.FloorToInt(maxZ - z0);
                if (ix1 < 0 || iz1 < 0 || ix0 >= w || iz0 >= h) return false;
                ix0 = Mathf.Max(0, ix0); iz0 = Mathf.Max(0, iz0); ix1 = Mathf.Min(w - 1, ix1); iz1 = Mathf.Min(h - 1, iz1);
                int s = sum[(iz1 + 1) * (w + 1) + ix1 + 1] - sum[iz0 * (w + 1) + ix1 + 1] - sum[(iz1 + 1) * (w + 1) + ix0] + sum[iz0 * (w + 1) + ix0];
                return s > 0;
            }

            public bool Inside(float x, float z) { return Meets(x, z, x, z); }
        }

        // ------------------------------------------------------------------ findings and counts

        sealed class Stat { public int objects, near, findings; public HashSet<string> bad = new HashSet<string>(), done = new HashSet<string>(); }

        sealed class Finding
        {
            public string category, severity, note, fix;
            public List<string> objects = new List<string>();
            public Vector3 at;
            public bool fixedNow;
        }

        static bool removeMissingPrefabs;   // Command's arg; the menu leaves them

        sealed class Ctx
        {
            public bool fix;
            public NearArea area, buildingArea;   // buildingArea: within BuildingColliderM of play
            public GolfMapCourse course;
            public string courseFolder;
            public Dictionary<string, PhysicMaterial> phys = new Dictionary<string, PhysicMaterial>();
            public List<Finding> findings = new List<Finding>();
            public List<object> fixedRows = new List<object>();
            public Dictionary<string, Stat> stats = new Dictionary<string, Stat>();
            public Dictionary<string, object> decisions = new Dictionary<string, object>();
            public bool sceneChanged;
            public HashSet<UnityEngine.Object> assetsChanged = new HashSet<UnityEngine.Object>();

            public Stat Of(string cat)
            {
                Stat s;
                if (!stats.TryGetValue(cat, out s)) stats[cat] = s = new Stat();
                return s;
            }

            // one object of a category; true when it is near (and so checked)
            public bool Consider(string cat, bool near)
            {
                var s = Of(cat);
                s.objects++;
                if (near) s.near++;
                return near;
            }

            public PhysicMaterial P(string name)
            {
                PhysicMaterial m;
                return name != null && phys.TryGetValue(name, out m) ? m : null;
            }

            // A finding; with fix on and an apply, the fix runs now and is listed under `fixed`.
            public Finding Issue(string cat, string severity, string obj, string note, Vector3 at, string fixWhat = null, Action apply = null)
            {
                var f = new Finding { category = cat, severity = severity, note = note, at = at, fix = fixWhat };
                f.objects.Add(obj);
                var s = Of(cat);
                s.findings++;
                if (severity != "info") s.bad.Add(obj);
                if (fix && apply != null)
                {
                    try
                    {
                        apply();
                        f.fixedNow = true;
                        s.done.Add(obj);
                        fixedRows.Add(new Dictionary<string, object> { { "category", cat }, { "object", obj }, { "what", fixWhat } });
                    }
                    catch (Exception e) { f.note += " (fix failed: " + e.Message + ")"; }
                }
                findings.Add(f);
                return f;
            }
        }

        // ------------------------------------------------------------------ the run

        static IEnumerator Run(bool fix, float marginM, int limit, bool write)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var times = new Dictionary<string, object>();
            Action<string> lap = k => { times[k] = Math.Round(clock.Elapsed.TotalSeconds, 2); };
            var course = GolfMapCourses.Require();
            var scene = EditorSceneManager.GetActiveScene();
            bool wasDirty = scene.isDirty;
            var c = new Ctx { fix = fix, course = course, courseFolder = GolfMapCourses.Folder(course) };
            foreach (var n in PhysicNames)
            {
                var m = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(PhysicsFolder + n + ".physicMaterial");
                if (m != null) c.phys[n] = m;
            }
            var missingPhysics = PhysicNames.Where(n => !c.phys.ContainsKey(n)).ToList();
            string reportPath = null;
            if (!string.IsNullOrEmpty(course.exportFolder))
            {
                var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
                reportPath = Path.GetFullPath(Path.Combine(folder, ReportFile)).Replace('\\', '/');
            }
            double e0 = 0, n0 = 0; Vector3 origin = Vector3.zero; bool epsg = false;
            try { GolfMapProps.Frame(course, out e0, out n0, out origin); epsg = true; } catch (Exception) { }
            if (fix) { Undo.IncrementCurrentGroup(); Undo.SetCurrentGroupName("Make course ready"); }
            int undoGroup = Undo.GetCurrentGroup();

            // every object of the scene once, by root
            var roots = scene.GetRootGameObjects();
            Func<string, GameObject> root = name => roots.FirstOrDefault(g => g.name == name);

            // ------------------------------------------------ the playing field
            var courseMeshes = roots.SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.sharedMesh != null && f.gameObject.activeInHierarchy && GolfMapSurfaces.IsCourseMesh(f.name)).ToList();
            var play = courseMeshes.Where(f => IsPlay(GolfMapSurfaces.Classify(f.name))).ToList();
            if (play.Count == 0) throw new BridgeError("No course meshes of the playing field (tee, fairway, green, semi, rough, bunker) in " + scene.name + ".");
            c.area = new NearArea(play, marginM);
            c.buildingArea = marginM == BuildingColliderM ? c.area : new NearArea(play, BuildingColliderM);
            lap("area");
            yield return null;

            Trees(c, scene);
            lap("vegetation");
            yield return null;
            Water(c, roots);
            Creeks(c, root("GolfMap Creeks"), root("GolfMap Waterfalls"));
            Roads(c, root("GolfMap RAM Roads"));
            lap("water, roads");
            yield return null;
            Props(c, root(GolfMapProps.RootName), root("GolfMap Buildings"));
            Walls(c, root(GolfMapWalls.RootName));
            PowerLines(c, root("GolfMap Power Lines"));
            NoColliders(c, roots);
            lap("objects");
            yield return null;
            CourseMeshes(c, courseMeshes);
            SceneChecks(c, scene, roots, wasDirty);
            lap("course, scene");

            if (fix)
            {
                Undo.CollapseUndoOperations(undoGroup);
                foreach (var asset in c.assetsChanged) EditorUtility.SetDirty(asset);
                if (c.assetsChanged.Count > 0) AssetDatabase.SaveAssets();   // the prefabs and VSP packages, as golfmap.trees.colliders.fit does
                if (c.assetsChanged.Count > 0)
                    foreach (var s in UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>()) s.RefreshVegetationSystem();
                if (c.sceneChanged || c.fixedRows.Count > 0) EditorSceneManager.MarkSceneDirty(scene);
            }

            // ------------------------------------------------ report
            Func<string, int> rank = s => s == "error" ? 0 : s == "warn" ? 1 : 2;
            var ordered = c.findings.OrderBy(f => rank(f.severity)).ThenBy(f => f.category, StringComparer.Ordinal).ThenBy(f => f.objects[0], StringComparer.Ordinal).ToList();
            Func<Finding, object> describe = f =>
            {
                var d = new Dictionary<string, object>
                {
                    { "category", f.category }, { "severity", f.severity },
                    { "objects", f.objects.Take(12).Cast<object>().ToList() }, { "note", f.note },
                    { "fix", f.fix }, { "fixed", f.fixedNow },
                    { "unity", new List<object> { Math.Round(f.at.x, 2), Math.Round(f.at.y, 2), Math.Round(f.at.z, 2) } },
                };
                if (f.objects.Count > 12) d["moreObjects"] = f.objects.Count - 12;
                if (epsg) d["epsg3006"] = new List<object> { Math.Round(f.at.x - origin.x + e0, 2), Math.Round(f.at.z - origin.z + n0, 2) };
                return d;
            };
            var counts = c.stats.OrderBy(kv => kv.Key, StringComparer.Ordinal).ToDictionary(kv => kv.Key, kv => (object)new Dictionary<string, object>
            {
                { "objects", kv.Value.objects }, { "near", kv.Value.near }, { "ok", Math.Max(0, kv.Value.near - kv.Value.bad.Count) },
                { "fixed", kv.Value.done.Count }, { "findings", kv.Value.findings },
            });
            int errors = c.findings.Count(f => f.severity == "error" && !f.fixedNow), warnings = c.findings.Count(f => f.severity == "warn" && !f.fixedNow);
            lap("total");
            var result = new Dictionary<string, object>
            {
                { "format", Format }, { "generated", DateTime.UtcNow.ToString("o") }, { "scene", scene.name },
                { "marginM", marginM }, { "fix", fix }, { "dryRun", !fix },
                { "ok", errors == 0 }, { "errors", errors }, { "warnings", warnings },
                { "area", new Dictionary<string, object> { { "playMeshes", play.Count }, { "playM2", c.area.playCells }, { "nearM2", c.area.nearCells }, { "gridM", new List<object> { c.area.w, c.area.h } } } },
                { "counts", counts }, { "decisions", c.decisions },
                { "missingPhysicMaterials", missingPhysics.Count > 0 ? missingPhysics.Cast<object>().ToList() : null },
                { "seconds", times },
            };
            if (write && reportPath != null)
            {
                var file = new Dictionary<string, object>(result);
                file["findings"] = ordered.Select(describe).ToList();
                file["fixed"] = c.fixedRows;
                File.WriteAllText(reportPath, GolfMapJson.Serialize(file));
                result["report"] = reportPath;
            }
            result["findings"] = ordered.Take(limit).Select(describe).ToList();
            result["fixed"] = c.fixedRows.Take(200).ToList();
            if (c.fixedRows.Count > 200) result["fixedMore"] = c.fixedRows.Count - 200;
            yield return result;
        }

        // The ColliderDistanceFactor that puts a system's VSP colliders ColliderReachM from the camera (at most 1).
        internal static float ColliderFactor(VegetationSystemPro system)
        {
            float plant = system.VegetationSettings.PlantDistance;
            return plant <= 0f ? 1f : Mathf.Min(1f, ColliderReachM / plant);
        }

        // golfmap.props.place's half of the BuildingColliderM rule: does this building (placed, colliders not yet added)
        // stand within BuildingColliderM of the playing field? Every building does in a scene without play meshes.
        internal static Func<GameObject, bool> BuildingNeedsColliders(GameObject[] roots)
        {
            var play = roots.SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.sharedMesh != null && f.gameObject.activeInHierarchy && GolfMapSurfaces.IsCourseMesh(f.name) && IsPlay(GolfMapSurfaces.Classify(f.name))).ToList();
            if (play.Count == 0) return g => true;
            var area = new NearArea(play, BuildingColliderM);
            return g => area.Meets(ObjectBounds(g));
        }

        static bool IsPlay(GolfMapSurfaces.Surface s)
        {
            return s == GolfMapSurfaces.Surface.Tee || s == GolfMapSurfaces.Surface.Fairway || s == GolfMapSurfaces.Surface.Green
                || s == GolfMapSurfaces.Surface.Semi || s == GolfMapSurfaces.Surface.Rough || s == GolfMapSurfaces.Surface.Bunker;
        }

        // ------------------------------------------------------------------ 1, 2, 12: VSP trees, plants, grass

        sealed class ItemUse
        {
            public VegetationPackagePro package;
            public VegetationItemInfoPro item;
            public int near, stored;
            public float plantDistance = float.MaxValue;   // the smallest of the systems it stands near in
            public float maxScaleXZ, maxScaleY;
            public Vector3 at;
            public bool atSet;
        }

        static void Trees(Ctx c, UnityEngine.SceneManagement.Scene scene)
        {
            var systems = Resources.FindObjectsOfTypeAll<VegetationSystemPro>()
                .Where(s => s && s.gameObject.scene == scene && !EditorUtility.IsPersistent(s) && s.gameObject.activeInHierarchy).ToList();
            var uses = new Dictionary<VegetationItemInfoPro, ItemUse>();
            foreach (var s in systems)
            {
                var origin = s.VegetationSystemPosition;
                float plant = s.VegetationSettings.PlantDistance;
                var byId = new Dictionary<string, List<ItemUse>>();
                foreach (var p in s.VegetationPackageProList.Where(p => p))
                    foreach (var i in p.VegetationInfoList)
                    {
                        ItemUse u;
                        if (!uses.TryGetValue(i, out u)) uses[i] = u = new ItemUse { package = p, item = i };
                        if (i.EnableRuntimeSpawn) { u.plantDistance = Mathf.Min(u.plantDistance, plant); if (!u.atSet) { u.at = s.VegetationSystemBounds.center; u.atSet = true; } }
                        List<ItemUse> l;
                        if (!byId.TryGetValue(i.VegetationItemID, out l)) byId[i.VegetationItemID] = l = new List<ItemUse>();
                        l.Add(u);
                    }
                var storage = s.PersistentVegetationStorage;
                var package = storage ? storage.PersistentVegetationStoragePackage : null;
                if (!package) continue;
                foreach (var info in package.PersistentVegetationCellList.SelectMany(cell => cell.PersistentVegetationInfoList))
                {
                    List<ItemUse> l;
                    if (info.VegetationItemList.Count == 0 || !byId.TryGetValue(info.VegetationItemID, out l)) continue;
                    foreach (var it in info.VegetationItemList)
                    {
                        var p = it.Position + origin;
                        bool near = c.area.Inside(p.x, p.z);
                        foreach (var u in l)
                        {
                            u.stored++;
                            if (!near) continue;
                            if (u.near++ == 0) { u.at = p; u.atSet = true; }
                            u.plantDistance = Mathf.Min(u.plantDistance, plant);
                            u.maxScaleXZ = Mathf.Max(u.maxScaleXZ, Mathf.Max(it.Scale.x, it.Scale.z));
                            u.maxScaleY = Mathf.Max(u.maxScaleY, it.Scale.y);
                        }
                    }
                }
            }

            var prefabsSeen = new HashSet<GameObject>();
            var wood = c.P("GSPwood"); var leaves = c.P("GSPleaves");
            // items GolfMapVspRig.ShowOnly hid on a hybrid course (<catalogue>.hidden.json): Arborist draws those trees
            var hiddenIds = new HashSet<string>();
            foreach (var pkg in uses.Values.Select(x => x.package).Distinct())
            {
                var file = AssetDatabase.GetAssetPath(pkg) + ".hidden.json";
                if (File.Exists(file)) foreach (var k in GolfMapJsonDoc.ParseObject(File.ReadAllText(file)).keys) hiddenIds.Add(k);
            }
            var hidden = new List<object>();
            foreach (var u in uses.Values.OrderBy(x => x.item.Name, StringComparer.Ordinal))
            {
                var i = u.item; var pkg = u.package;
                string key = pkg.PackageName + "/" + i.Name;
                bool near = u.near > 0 || (i.EnableRuntimeSpawn && u.stored == 0 && u.plantDistance < float.MaxValue);
                string where = u.near > 0 ? u.near + " near play" : "spawned by rule (where is not known: counted near)";
                if (i.VegetationType == VegetationType.Grass)
                {
                    if (!c.Consider("grass", true)) continue;
                    if (i.ColliderType != ColliderType.Disabled)
                        c.Issue("grass", "warn", key, "grass with a " + i.ColliderType + " collider: grass must not stop the ball", u.at, "ColliderType Disabled",
                            () => { Undo.RecordObject(pkg, "Make course ready"); i.ColliderType = ColliderType.Disabled; c.assetsChanged.Add(pkg); });
                    continue;
                }
                if (i.VegetationType == VegetationType.Tree)
                {
                    // hidden: drawn by Arborist (its colliders are Arborist's), or drawing nothing at all
                    if (hiddenIds.Contains(i.VegetationItemID) || (i.RenderDistanceFactor <= 0f && !i.UseBillboards))
                    {
                        if (near) hidden.Add(key);
                        c.Consider("trees", false);
                        continue;
                    }
                    if (!c.Consider("trees", near)) continue;
                    TreeItem(c, u, key, where, wood, leaves, prefabsSeen, uses.Values);
                }
                else if (i.VegetationType == VegetationType.Plant)
                {
                    if (!c.Consider("bushes", near)) continue;
                    PlantItem(c, u, key, leaves, prefabsSeen);
                }
            }
            if (hidden.Count > 0) c.decisions["treeItemsHidden"] = new Dictionary<string, object> { { "note", "near play but hidden in VSP (hybrid course: Arborist draws them, GolfMapVspRig.ShowOnly); not checked here" }, { "items", hidden } };
        }

        static void TreeItem(Ctx c, ItemUse u, string key, string where, PhysicMaterial wood, PhysicMaterial leaves,
            HashSet<GameObject> prefabsSeen, IEnumerable<ItemUse> all)
        {
            var i = u.item; var pkg = u.package;
            if (!i.VegetationPrefab) { c.Issue("trees", "error", key, "tree item without a prefab (" + where + ")", u.at); return; }
            if (i.RenderDistanceFactor <= 0f)
                c.Issue("trees", "warn", key, "drawn as a billboard only (RenderDistanceFactor 0), " + where + ": a tree this near play should be a full model with colliders", u.at);
            if (i.ColliderType != ColliderType.FromPrefab)
                c.Issue("trees", i.ColliderType == ColliderType.Disabled ? "error" : "warn", key,
                    "collider type " + i.ColliderType + " (" + where + "): " + (i.ColliderType == ColliderType.Disabled ? "the ball flies through it" : "VSP's own collider carries no physic material"),
                    u.at, "ColliderType FromPrefab", () => { Undo.RecordObject(pkg, "Make course ready"); i.ColliderType = ColliderType.FromPrefab; c.assetsChanged.Add(pkg); });
            // colliders exist only out to PlantDistance x ColliderDistanceFactor from the camera
            if (u.plantDistance < float.MaxValue && u.plantDistance * i.ColliderDistanceFactor < ColliderReachM - 0.5f)
            {
                float want = Mathf.Min(1f, Mathf.Max(i.ColliderDistanceFactor, ColliderReachM / u.plantDistance));
                c.Issue("trees", "warn", key, "colliders only within " + Math.Round(u.plantDistance * i.ColliderDistanceFactor) + " m of the camera (PlantDistance " + u.plantDistance
                    + " x ColliderDistanceFactor " + i.ColliderDistanceFactor.ToString("0.###", Inv) + "); GSPro advises " + ColliderReachM + " m" + (want * u.plantDistance < ColliderReachM - 0.5f ? " - PlantDistance is too short for that even at 1" : ""),
                    u.at, "ColliderDistanceFactor " + want.ToString("0.###", Inv), () => { Undo.RecordObject(pkg, "Make course ready"); i.ColliderDistanceFactor = want; c.assetsChanged.Add(pkg); });
            }
            var prefab = i.VegetationPrefab;
            if (!prefabsSeen.Add(prefab)) return;   // its prefab was checked with an earlier item
            string path = AssetDatabase.GetAssetPath(prefab);
            bool model = PrefabUtility.GetPrefabType(prefab) == PrefabType.ModelPrefab;
            var colliders = prefab.GetComponentsInChildren<Collider>(true);
            var off = colliders.Where(x => !x.enabled).ToList();
            if (off.Count > 0)
                c.Issue("trees", "error", key, "prefab " + path + ": " + off.Count + " collider(s) switched off (" + string.Join(", ", off.Select(x => "'" + x.name + "' " + x.GetType().Name.Replace("Collider", "").ToLowerInvariant()).Take(4).ToArray()) + ")",
                    u.at, model ? null : "enable them on the prefab", model ? (Action)null : () => { foreach (var x in off) { Undo.RecordObject(x, "Make course ready"); x.enabled = true; c.assetsChanged.Add(x); } });
            var hidden = colliders.Where(x => x.enabled && !x.gameObject.activeSelf).ToList();
            if (hidden.Count > 0) c.Issue("trees", "warn", key, "prefab " + path + ": " + hidden.Count + " collider(s) on a switched-off child (" + hidden[0].name + "): not fixed here", u.at);
            bool trunk = colliders.Any(x => x.sharedMaterial == wood) || colliders.Any(x => x is CapsuleCollider && x.sharedMaterial == null && ((CapsuleCollider)x).radius < 1f);
            bool crown = colliders.Any(x => x.sharedMaterial == leaves);
            var other = colliders.Where(x => x.sharedMaterial != null && x.sharedMaterial != wood && x.sharedMaterial != leaves).Select(x => x.sharedMaterial.name).Distinct().ToList();
            if (other.Count > 0) c.Issue("trees", "info", key, "prefab " + path + ": colliders on " + string.Join(", ", other.ToArray()) + " besides the trunk/crown", u.at);
            if (!trunk || !crown || colliders.Any(x => x is CapsuleCollider && x.sharedMaterial == null))
            {
                string missing = (!trunk ? "no trunk collider on GSPwood" : "") + (!trunk && !crown ? ", " : "") + (!crown ? "no crown collider on GSPleaves" : "");
                if (missing.Length == 0) missing = "a trunk capsule without a physic material";
                c.Issue("trees", trunk && crown ? "warn" : "error", key, "prefab " + path + ": " + missing, u.at,
                    "golfmap.trees.colliders.fit (" + (model ? "a collider prefab under <course>/TreeColliders/, its items pointed at it" : "a 'GolfMap Colliders' child on the prefab") + ")",
                    wood == null || leaves == null ? (Action)null : () =>
                    {
                        var row = new Dictionary<string, object>();
                        var now = GolfMapTreeColliders.FitPrefab(c.course, prefab, wood, leaves, 0.3f, 0.3f, 0.015f, false, row);
                        foreach (var o in all.Where(x => x.item.VegetationPrefab == prefab))
                        {
                            Undo.RecordObject(o.package, "Make course ready");
                            o.item.VegetationPrefab = now;
                            o.item.ColliderType = ColliderType.FromPrefab;
                            c.assetsChanged.Add(o.package);
                        }
                    });
            }
        }

        // Soft plants a ball goes through, whatever their size (Marcus 2026-10-20): reeds, rushes, flags, ferns, sprigs,
        // heather and grasses. Only woody bushes over BushM (juniper, pine, buckthorn, willow, boxwood ...) get GSPleaves.
        static readonly string[] SoftWords = { "reed", "rush", "sedge", "typha", "cattail", "flag", "iris", "fern", "bracken",
            "bilberry", "blueberry", "lingonberry", "heather", "grass", "vass", "igelknopp", "svardslilja", "ormbunke", "blabar" };

        internal static bool SoftPlant(string name)
        {
            var n = (name ?? "").ToLowerInvariant().Replace("-", "").Replace("_", "").Replace(" ", "");
            return SoftWords.Any(w => n.Contains(w));
        }

        static void PlantItem(Ctx c, ItemUse u, string key, PhysicMaterial leaves, HashSet<GameObject> prefabsSeen)
        {
            var i = u.item; var pkg = u.package;
            var size = i.VegetationPrefab ? PrefabSize(i.VegetationPrefab) : Vector3.zero;
            if (size == Vector3.zero) size = i.Bounds.size;
            float sxz = u.maxScaleXZ > 0 ? u.maxScaleXZ : i.MaxScale * Mathf.Max(i.ScaleMultiplier.x, i.ScaleMultiplier.z);
            float sy = u.maxScaleY > 0 ? u.maxScaleY : i.MaxScale * i.ScaleMultiplier.y * i.YScale;
            float height = size.y * sy, width = Mathf.Max(size.x, size.z) * sxz;
            string dims = Math.Round(height, 2) + " m tall, " + Math.Round(width, 2) + " m wide";
            if (SoftPlant(key + " " + (i.VegetationPrefab ? i.VegetationPrefab.name : "")))
            {
                if (i.ColliderType != ColliderType.Disabled)
                    c.Issue("bushes", "warn", key, "a soft plant (" + dims + ") with a " + i.ColliderType + " collider: a ball goes through reeds, ferns and sprigs, it should have none", u.at);
                return;
            }
            if (height <= BushM || width <= BushM)
            {
                if (i.ColliderType != ColliderType.Disabled)
                    c.Issue("bushes", "warn", key, "a small plant (" + dims + ") with a " + i.ColliderType + " collider: under " + BushM + " m it should have none", u.at);
                return;
            }
            var colliders = i.VegetationPrefab ? i.VegetationPrefab.GetComponentsInChildren<Collider>(true) : new Collider[0];
            bool model = i.VegetationPrefab && PrefabUtility.GetPrefabType(i.VegetationPrefab) == PrefabType.ModelPrefab;
            Action toLeaves = () =>
            {
                if (leaves == null) throw new InvalidOperationException("no GSPleaves physic material");
                Undo.RecordObject(pkg, "Make course ready");
                i.ColliderType = ColliderType.FromPrefab;
                c.assetsChanged.Add(pkg);
                if (!prefabsSeen.Add(i.VegetationPrefab)) return;
                foreach (var x in colliders.Where(x => x.sharedMaterial != leaves || !x.enabled))
                {
                    Undo.RecordObject(x, "Make course ready");
                    x.sharedMaterial = leaves; x.enabled = true;
                    c.assetsChanged.Add(x);
                }
            };
            bool fixable = colliders.Length > 0 && !model;
            if (i.ColliderType == ColliderType.Disabled)
                c.Issue("bushes", "warn", key, "a bush " + dims + " with no collider" + (colliders.Length == 0 ? " (its prefab has none to use)" : ""), u.at,
                    fixable ? "ColliderType FromPrefab, the prefab's colliders on GSPleaves" : null, fixable ? toLeaves : null);
            else if (i.ColliderType != ColliderType.FromPrefab)
                c.Issue("bushes", "warn", key, "a bush " + dims + " with VSP's own " + i.ColliderType + " collider: no physic material (GSPleaves wanted)", u.at,
                    fixable ? "ColliderType FromPrefab, the prefab's colliders on GSPleaves" : null, fixable ? toLeaves : null);
            else if (colliders.Length == 0)
                c.Issue("bushes", "warn", key, "From Prefab, but its prefab " + AssetDatabase.GetAssetPath(i.VegetationPrefab) + " has no collider", u.at);
            else if (colliders.Any(x => x.sharedMaterial != leaves || !x.enabled))
                c.Issue("bushes", "warn", key, "prefab colliders not all on GSPleaves (" + string.Join(", ", colliders.Select(x => PhysName(x) + (x.enabled ? "" : " off")).Distinct().ToArray()) + ")", u.at,
                    model ? null : "the prefab's colliders on GSPleaves, enabled", model ? null : toLeaves);
        }

        // the first LOD's meshes in the prefab's own metres (as GolfMapVspStatus.ModelSize measures a tree)
        static Vector3 PrefabSize(GameObject prefab)
        {
            var group = prefab.GetComponentInChildren<LODGroup>(true);
            IEnumerable<Renderer> renderers = group != null && group.GetLODs().Length > 0 ? group.GetLODs()[0].renderers.Where(r => r) : prefab.GetComponentsInChildren<MeshRenderer>(true).Cast<Renderer>();
            var toRoot = prefab.transform.worldToLocalMatrix;
            Bounds b = new Bounds(); bool any = false;
            foreach (var r in renderers)
            {
                var f = r.GetComponent<MeshFilter>();
                if (f == null || f.sharedMesh == null) continue;
                var wb = WorldBounds(f.sharedMesh.bounds, toRoot * r.transform.localToWorldMatrix);
                if (!any) { b = wb; any = true; } else b.Encapsulate(wb);
            }
            return any ? b.size : Vector3.zero;
        }

        // ------------------------------------------------------------------ 3: water planes and the Lux lake collider

        static void Water(Ctx c, GameObject[] roots)
        {
            var water = c.P("GSPwater");
            var planes = roots.SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject)
                .Where(g => g.activeInHierarchy && GolfMapWaterplanes.IsWaterPlane(g.name) && (g.GetComponent<MeshFilter>() != null || g.GetComponent<Collider>() != null)).ToList();
            var names = new HashSet<string>(planes.Select(g => g.name));
            foreach (var g in planes)
            {
                var b = ObjectBounds(g);
                if (!c.Consider("water", c.area.Meets(b))) continue;
                bool renderOnly = g.name.EndsWith("_Outer", StringComparison.Ordinal) || g.name.EndsWith("_Far", StringComparison.Ordinal) || names.Contains(g.name + "_Collider");
                if (renderOnly) { NoCollider(c, "water", g, b.center, "a render-only Lux plane (the lake's _Collider is what the ball meets)"); continue; }
                var mf = g.GetComponent<MeshFilter>();
                WaterCollider(c, "water", g, mf != null ? mf.sharedMesh : null, water, b.center);
            }
        }

        // An enabled non-convex MeshCollider on `mesh` with `material`; one finding for what is wrong.
        static void MeshColliderOn(Ctx c, string cat, GameObject g, Mesh mesh, PhysicMaterial material, string want, Vector3 at, string missingSeverity, string wrongSeverity, string what)
        {
            var mc = g.GetComponent<MeshCollider>();
            var problems = new List<string>();
            bool hard = false;
            if (mc == null) { problems.Add("no collider: " + what); hard = true; }
            else
            {
                if (!mc.enabled) { problems.Add("its collider is switched off"); hard = true; }
                if (mc.convex) { problems.Add("its collider is convex (a hull, not the surface)"); hard = true; }
                if (mc.sharedMesh == null) { problems.Add("its collider has no mesh"); hard = true; }
                if (PhysName(mc) != want) problems.Add("physic material " + (PhysName(mc) ?? "none") + ", " + want + " wanted");
            }
            if (problems.Count == 0) return;
            bool canFix = material != null && (mesh != null || (mc != null && mc.sharedMesh != null));
            c.Issue(cat, hard ? missingSeverity : wrongSeverity, PathOf(g), string.Join("; ", problems.ToArray()), at,
                canFix ? "an enabled non-convex MeshCollider on its mesh with " + want : null,
                canFix ? () =>
                {
                    var col = g.GetComponent<MeshCollider>();   // not ??: a missing component is Unity's fake null
                    if (col == null) { col = Undo.AddComponent<MeshCollider>(g); col.sharedMesh = mesh; }
                    else Undo.RecordObject(col, "Make course ready");
                    if (col.sharedMesh == null) col.sharedMesh = mesh;
                    col.convex = false; col.enabled = true; col.sharedMaterial = material;
                    c.sceneChanged = true;
                } : (Action)null);
        }

        static void WaterCollider(Ctx c, string cat, GameObject g, Mesh mesh, PhysicMaterial water, Vector3 at)
        {
            MeshColliderOn(c, cat, g, mesh, water, "GSPwater", at, "error", "error", "the ball falls through the water");
        }

        // colliders where none belong: one finding, the fix takes them off
        static void NoCollider(Ctx c, string cat, GameObject g, Vector3 at, string why, bool removable = true)
        {
            var cs = g.GetComponentsInChildren<Collider>(true).Where(x => x.enabled && x.gameObject.activeInHierarchy).ToList();
            if (cs.Count == 0) return;
            c.Issue(cat, "warn", PathOf(g), cs.Count + " collider(s) on " + why + ": nothing here should stop the ball", at,
                removable ? "remove the colliders" : null,
                removable ? () => { foreach (var x in cs) Undo.DestroyObjectImmediate(x); c.sceneChanged = true; } : (Action)null);
        }

        // ------------------------------------------------------------------ 4: R.A.M. creeks and waterfalls

        static void Creeks(Ctx c, GameObject creeks, GameObject falls)
        {
            var water = c.P("GSPwater");
            foreach (var pair in new[] { new KeyValuePair<string, GameObject>("creeks", creeks), new KeyValuePair<string, GameObject>("waterfalls", falls) })
            {
                if (pair.Value == null) continue;
                foreach (var t in pair.Value.GetComponentsInChildren<Transform>(true))
                {
                    var g = t.gameObject;
                    if (!g.activeInHierarchy) continue;
                    if (g.GetComponent("RamSpline") != null)
                    {
                        var mf = g.GetComponent<MeshFilter>();
                        if (!c.Consider(pair.Key, NearMesh(c, mf, ObjectBounds(g)))) continue;
                        WaterCollider(c, pair.Key, g, mf != null ? mf.sharedMesh : null, water, ObjectBounds(g).center);
                    }
                    else if (g.GetComponent<ParticleSystem>() != null)
                    {
                        var b = ObjectBounds(g);
                        if (!c.Consider(pair.Key, c.area.Meets(b))) continue;
                        NoCollider(c, pair.Key, g, b.center, "a particle system (white water)");
                    }
                }
            }
        }

        // ------------------------------------------------------------------ 5: R.A.M. roads

        static void Roads(Ctx c, GameObject root)
        {
            if (root == null) return;
            var surfaceOf = new Dictionary<string, string>();
            var file = GolfMapCourses.ExportFile(c.course, "inner", "ramroads");
            if (file != null && File.Exists(file))
                foreach (var o in (GolfMapJsonDoc.ParseObject(File.ReadAllText(file)).Array("roads") ?? new List<object>()).OfType<GolfMapJsonObject>())
                    if (o.String("id") != null) surfaceOf[o.String("id")] = o.String("surface") ?? "gravel";
            var spec = GolfMapRamRoads.SurfacePhysics(c.courseFolder);
            var chosen = new Dictionary<string, object>();
            foreach (Transform t in root.transform)
            {
                var g = t.gameObject;
                if (!g.activeInHierarchy || !g.name.StartsWith("RAM road ", StringComparison.Ordinal)) continue;
                var mf = g.GetComponent<MeshFilter>();
                var b = ObjectBounds(g);
                if (!c.Consider("ram-roads", NearMesh(c, mf, b))) continue;
                string id = g.name.Substring("RAM road ".Length), surface;
                if (!surfaceOf.TryGetValue(id, out surface)) surface = "gravel";
                string path, from;
                PhysicMaterial material = null;
                if (spec.TryGetValue(surface, out path) && (material = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(path)) != null) from = "Paths/path-surfaces.json";
                else
                {
                    material = c.P(surface == "dirt" || surface == "gravel-track" ? "GSPrough" : "GSPconcrete");
                    from = "by road type (Paths/path-surfaces.json has no physicMaterial for " + surface + ")";
                }
                string want = material != null ? material.name : "?";
                if (!chosen.ContainsKey(surface)) chosen[surface] = new Dictionary<string, object> { { "physics", want }, { "from", from } };
                MeshColliderOn(c, "ram-roads", g, mf != null ? mf.sharedMesh : null, material, want, b.center, "error", "warn", "a " + surface + " road the ball falls through");
            }
            c.decisions["roadSurfaces"] = chosen;
        }

        // ------------------------------------------------------------------ 6, 7, 8: the props tool's objects

        sealed class PropAsset { public string id, category, collider, prefab, physics; public List<string> materials = new List<string>(); }

        static Dictionary<string, PropAsset> LoadProps(string courseFolder)
        {
            var map = new Dictionary<string, PropAsset>();
            var file = courseFolder + "Props/props.json";
            if (!File.Exists(file)) return map;
            var assets = GolfMapJsonDoc.ParseObject(File.ReadAllText(file)).Object("assets");
            if (assets == null) return map;
            foreach (var k in assets.keys)
            {
                var o = assets.Object(k);
                if (o == null) continue;
                var a = new PropAsset { id = k, category = o.String("category") ?? "prop", collider = o.String("collider"), prefab = o.String("prefab"), physics = o.String("physics") };
                var ml = o.Array("materials");
                if (ml != null) a.materials.AddRange(ml.OfType<string>());
                map[k] = a;
            }
            return map;
        }

        static void Props(Ctx c, GameObject props, GameObject planted)
        {
            var assets = LoadProps(c.courseFolder);
            var decided = new Dictionary<string, object>();
            var instances = new List<KeyValuePair<string, GameObject>>();   // group -> instance
            if (props != null)
                foreach (Transform group in props.transform)
                    foreach (Transform t in group)
                        if (t.name.IndexOf('#') > 0) instances.Add(new KeyValuePair<string, GameObject>(group.name, t.gameObject));
            if (planted != null)
                foreach (Transform t in planted.transform) instances.Add(new KeyValuePair<string, GameObject>("Buildings", t.gameObject));
            foreach (var kv in instances)
            {
                var g = kv.Value;
                if (!g.activeInHierarchy) continue;
                int hash = g.name.IndexOf('#');
                string id = hash > 0 ? g.name.Substring(0, hash) : g.name;
                PropAsset asset;
                assets.TryGetValue(id, out asset);
                var b = ObjectBounds(g);
                string category = CategoryOfGroup(kv.Key), rule;
                if (category == "marking")
                {
                    if (c.Consider("markings", c.area.Meets(b))) NoCollider(c, "markings", g, b.center, "a painted marking");
                    continue;
                }
                string cat = category == "building" ? "buildings" : category == "structure" ? "structures" : category == "vehicle" ? "vehicles" : "props";
                var want = AssetPhysics(category, id, asset != null ? asset.physics : null, asset != null ? asset.materials : null, asset != null ? asset.prefab : null, g, out rule);
                if (category == "prop" && want == "GSPleaves") cat = "bushes";
                var material = LoadPhysic(asset != null && !string.IsNullOrEmpty(asset.physics) ? asset.physics : want);
                if (category == "building" && !c.buildingArea.Meets(b))
                {
                    // no ball reaches a building this far out: it carries no collider (nor anything GSPro's build asks about)
                    c.Consider(cat, false);
                    var any = g.GetComponentsInChildren<Collider>(true).Where(x => !x.isTrigger).ToList();
                    if (any.Count > 0)
                        c.Issue(cat, "warn", PathOf(g), any.Count + " collider(s) on a building more than " + BuildingColliderM + " m from play: it needs none", b.center,
                            "colliders removed", () => { foreach (var x in any) Undo.DestroyObjectImmediate(x); c.sceneChanged = true; });
                    continue;
                }
                if (!c.Consider(cat, c.area.Meets(b)))
                {
                    // far from play the ball never gets there, but GSPro's build asks about every collider of the scene without one
                    var unset = g.GetComponentsInChildren<Collider>(true).Where(x => x.enabled && !x.isTrigger && x.gameObject.activeInHierarchy && x.sharedMaterial == null).ToList();
                    if (unset.Count > 0 && material != null)
                        c.Issue(cat, "warn", PathOf(g), unset.Count + " collider(s) on no physic material, far from play (GSPro's build asks about them), " + want + " wanted", b.center,
                            "physic material " + want, () => { foreach (var x in unset) { Undo.RecordObject(x, "Make course ready"); x.sharedMaterial = material; } c.sceneChanged = true; });
                    continue;
                }
                if (cat == "bushes")
                {
                    float height = b.size.y, width = Mathf.Max(b.size.x, b.size.z);
                    if (height <= BushM || width <= BushM)
                    {
                        NoCollider(c, "bushes", g, b.center, "a shrub under " + BushM + " m (" + Math.Round(height, 2) + " x " + Math.Round(width, 2) + " m)", false);
                        continue;
                    }
                    Solid(c, cat, g, id, asset, material, want, b, false, "warn");
                    continue;
                }
                Decide(c, decided, id, want, rule, cat, g, b);
                bool mesh = category == "building" || category == "structure";
                Solid(c, cat, g, id, asset, material, want, b, mesh, mesh ? "error" : "warn");
            }
            c.decisions["assets"] = decided;
        }

        static string CategoryOfGroup(string group)
        {
            switch (group)
            {
                case "Buildings": return "building";
                case "Structures": return "structure";
                case "Markings": return "marking";
                case "Vehicles": return "vehicle";
                default: return "prop";
            }
        }

        static void Decide(Ctx c, Dictionary<string, object> decided, string id, string want, string rule, string cat, GameObject g, Bounds b)
        {
            if (decided.ContainsKey(id)) return;
            decided[id] = new Dictionary<string, object> { { "physics", want }, { "rule", rule } };
            if (rule.StartsWith("guessed", StringComparison.Ordinal))
                c.Issue(cat, "info", id, want + " guessed (no keyword in its id or materials): set `physics` on the props.json asset to decide", b.center);
        }

        // ---- the physic material of a props asset: one rule for golfmap.props.place and this check

        // A physic material by name (GSPwood: Assets/Resources/Physics/GSPwood.physicMaterial) or by asset path.
        internal static PhysicMaterial LoadPhysic(string nameOrPath)
        {
            if (string.IsNullOrEmpty(nameOrPath)) return null;
            var path = nameOrPath.IndexOf('/') >= 0 ? nameOrPath : PhysicsFolder + nameOrPath + ".physicMaterial";
            return AssetDatabase.LoadAssetAtPath<PhysicMaterial>(path);
        }

        // The GSPro physic material (by name) a props.json asset's colliders get, and the rule that decided it; null for a
        // marking (no collider). category: the manifest's (building, structure, prop, marking, vehicle). physics: the
        // asset's explicit `physics` (a name or an asset path), which wins. instance: a placed instance (a building's wall
        // materials are weighed by area on it); may be null.
        internal static string AssetPhysics(string category, string id, string physics, IList<string> materials, string prefab, GameObject instance, out string rule)
        {
            if (!string.IsNullOrEmpty(physics)) { rule = "props.json physics"; return Path.GetFileNameWithoutExtension(physics); }
            materials = materials ?? new List<string>();
            switch (category)
            {
                case "marking": rule = "a marking: no collider"; return null;
                case "vehicle": rule = "a vehicle (no metal material exists)"; return "GSPconcrete";
                case "building": return BuildingPhysics(instance, id, materials, out rule);
                case "structure": return StructurePhysics(id, materials, out rule);
                default:
                    if (Kw(id + " " + prefab, "boxwood", "buxus", "arborvitae", "thuja", "hedge", "shrub", "bush", "juniper", "yew")) { rule = "a shrub"; return "GSPleaves"; }
                    return PropPhysics(id, materials, out rule);
            }
        }

        // An object a ball meets: an enabled collider on `want`. None at all -> `missingSeverity`, fixed by MeshColliders
        // (mesh = true: the baked <id>_collider first, else LOD0's meshes) or a box round it.
        static void Solid(Ctx c, string cat, GameObject g, string id, PropAsset asset, PhysicMaterial material, string want, Bounds b, bool mesh, string missingSeverity)
        {
            var all = g.GetComponentsInChildren<Collider>(true).Where(x => !x.isTrigger && x.gameObject.activeInHierarchy).ToList();
            var on = all.Where(x => x.enabled).ToList();
            var off = all.Where(x => !x.enabled).ToList();
            string name = PathOf(g);
            if (material == null) { c.Issue(cat, "error", name, "no physic material " + want + " in " + PhysicsFolder, b.center); return; }
            if (on.Count == 0 && off.Count > 0)
            {
                c.Issue(cat, "error", name, off.Count + " collider(s) switched off", b.center, "enable them, on " + want,
                    () => { foreach (var x in off) { Undo.RecordObject(x, "Make course ready"); x.enabled = true; x.sharedMaterial = material; } c.sceneChanged = true; });
                return;
            }
            if (on.Count == 0)
            {
                if (asset != null && asset.collider == "none")
                {
                    c.Issue(cat, "info", name, "no collider (props.json: collider none, left so)", b.center);
                    return;
                }
                c.Issue(cat, missingSeverity, name, "no collider: the ball flies through it", b.center,
                    (mesh ? "MeshColliders on its meshes" : "a box collider round it") + ", on " + want,
                    () =>
                    {
                        var added = mesh ? AddMeshColliders(g, id) : AddBox(g);
                        if (added.Count == 0) throw new InvalidOperationException("no mesh to make a collider of");
                        foreach (var x in added) x.sharedMaterial = material;
                        c.sceneChanged = true;
                    });
                return;
            }
            var wrong = on.Where(x => PhysName(x) != want).ToList();
            if (wrong.Count == 0) return;
            c.Issue(cat, "warn", name, wrong.Count + " of " + on.Count + " collider(s) on " + string.Join(", ", wrong.Select(x => PhysName(x) ?? "no physic material").Distinct().ToArray()) + ", " + want + " wanted", b.center,
                "physic material " + want, () => { foreach (var x in wrong) { Undo.RecordObject(x, "Make course ready"); x.sharedMaterial = material; } c.sceneChanged = true; });
        }

        static List<Collider> AddMeshColliders(GameObject g, string id)
        {
            var added = new List<Collider>();
            var baked = g.GetComponentsInChildren<MeshFilter>(true).FirstOrDefault(f => f.name == id + "_collider" && f.sharedMesh != null);
            if (baked != null)
            {
                var mc = Undo.AddComponent<MeshCollider>(baked.gameObject);
                mc.sharedMesh = baked.sharedMesh;
                added.Add(mc);
                return added;
            }
            var lod = g.GetComponentInChildren<LODGroup>();
            IEnumerable<Renderer> renderers = lod != null && lod.GetLODs().Length > 0 ? lod.GetLODs()[0].renderers.Where(r => r) : g.GetComponentsInChildren<MeshRenderer>().Where(r => r.enabled).Cast<Renderer>();
            foreach (var r in renderers)
            {
                var f = r.GetComponent<MeshFilter>();
                if (f == null || f.sharedMesh == null || f.GetComponent<MeshCollider>() != null) continue;
                var mc = Undo.AddComponent<MeshCollider>(f.gameObject);
                mc.sharedMesh = f.sharedMesh;
                added.Add(mc);
            }
            return added;
        }

        // as GolfMapProps places a native box: the renderers' bounds in the root's frame, 95 %
        static List<Collider> AddBox(GameObject g)
        {
            var rs = g.GetComponentsInChildren<Renderer>().Where(r => r.enabled).ToList();
            if (rs.Count == 0) return new List<Collider>();
            var wb = rs[0].bounds;
            foreach (var r in rs) wb.Encapsulate(r.bounds);
            var bc = Undo.AddComponent<BoxCollider>(g);
            var lossy = g.transform.lossyScale;
            var ls = Quaternion.Inverse(g.transform.rotation) * wb.size;
            bc.center = g.transform.InverseTransformPoint(wb.center);
            bc.size = new Vector3(Mathf.Abs(ls.x) / lossy.x, Mathf.Abs(ls.y) / lossy.y, Mathf.Abs(ls.z) / lossy.z) * 0.95f;
            return new List<Collider> { bc };
        }

        // ---- physic material by keywords

        static readonly string[] WoodWords = { "falu", "red", "wood", "wooden", "timber", "plank", "panel", "board", "log", "barn", "cottage", "shed", "cabin", "hut", "stuga", "lada" };
        static readonly string[] ConcreteWords = { "concrete", "stone", "granite", "brick", "plaster", "render", "stucco", "galvan", "metal", "steel", "container", "glass", "glasshouse", "greenhouse", "precast" };
        // materials that are not the walls: trims, openings, roofs, plinths
        static readonly string[] TrimWords = { "trim", "frame", "window", "glazing", "door", "fascia", "gutter", "flash", "roof", "tile", "shutter", "sedum", "void", "reveal", "plinth", "basement", "foundation", "sign", "chimney", "vent", "line", "cap" };

        // keyword match: short words (red, log, hut, mat, car ...) as whole tokens, longer ones anywhere
        static bool Kw(string text, params string[] words)
        {
            if (string.IsNullOrEmpty(text)) return false;
            var lower = text.ToLowerInvariant();
            string[] tokens = null;
            foreach (var w in words)
            {
                if (w.Length > 3) { if (lower.Contains(w)) return true; continue; }
                if (tokens == null) tokens = lower.Split(new[] { '_', ' ', '-', '.', '/', '(', ')', '#' }, StringSplitOptions.RemoveEmptyEntries);
                if (tokens.Contains(w)) return true;
            }
            return false;
        }

        // `physics` on the asset; its id; else the walls' materials by area (LOD0, trims and roofs left out); else concrete
        static string BuildingPhysics(GameObject g, string id, IList<string> manifestMaterials, out string rule)
        {
            if (Kw(id, "barn", "cottage", "shed", "cabin", "hut", "stuga", "lada", "falu", "wood", "wooden", "timber", "log")) { rule = "id (timber word)"; return "GSPwood"; }
            if (Kw(id, "container", "glasshouse", "greenhouse", "concrete", "brick", "stone", "steel", "metal", "garage")) { rule = "id (masonry/metal word)"; return "GSPconcrete"; }
            float wood = 0, concrete = 0;
            string woodMat = null, concreteMat = null;
            var lod = g != null ? g.GetComponentInChildren<LODGroup>() : null;
            IEnumerable<Renderer> renderers = g == null ? new Renderer[0] : lod != null && lod.GetLODs().Length > 0 ? lod.GetLODs()[0].renderers.Where(r => r) : g.GetComponentsInChildren<MeshRenderer>().Where(r => r.enabled).Cast<Renderer>();
            foreach (var r in renderers)
            {
                var f = r.GetComponent<MeshFilter>();
                if (f == null || f.sharedMesh == null) continue;
                var mesh = f.sharedMesh;
                var mats = r.sharedMaterials;
                Vector3[] v = null;
                for (int s = 0; s < mesh.subMeshCount && s < mats.Length; s++)
                {
                    if (mats[s] == null) continue;
                    var n = mats[s].name;
                    if (Kw(n, TrimWords)) continue;
                    bool isWood = Kw(n, WoodWords), isConcrete = Kw(n, ConcreteWords);
                    if (isWood == isConcrete) continue;   // neither, or both: no vote
                    if (v == null) { v = mesh.vertices; var m = r.transform.localToWorldMatrix; for (int i = 0; i < v.Length; i++) v[i] = m.MultiplyPoint3x4(v[i]); }
                    var t = mesh.GetTriangles(s);
                    float area = 0;
                    for (int i = 0; i + 2 < t.Length; i += 3) area += Vector3.Cross(v[t[i + 1]] - v[t[i]], v[t[i + 2]] - v[t[i]]).magnitude * 0.5f;
                    if (isWood) { wood += area; if (woodMat == null) woodMat = n; } else { concrete += area; if (concreteMat == null) concreteMat = n; }
                }
            }
            if (wood == 0 && concrete == 0)
            {
                // nothing drawn to measure: the manifest's material names, first wall material decides
                foreach (var n in manifestMaterials.Where(n => !Kw(n, TrimWords)))
                {
                    bool isWood = Kw(n, WoodWords), isConcrete = Kw(n, ConcreteWords);
                    if (isWood == isConcrete) continue;
                    rule = "material " + n + " (manifest)";
                    return isWood ? "GSPwood" : "GSPconcrete";
                }
            }
            if (wood > concrete) { rule = "materials by area: timber " + Math.Round(wood) + " m2 (" + woodMat + ") > masonry/metal " + Math.Round(concrete) + " m2"; return "GSPwood"; }
            if (concrete > 0) { rule = "materials by area: masonry/metal " + Math.Round(concrete) + " m2 (" + concreteMat + ") >= timber " + Math.Round(wood) + " m2"; return "GSPconcrete"; }
            rule = "guessed";
            return "GSPconcrete";
        }

        // id and materials together, first rule in this order wins
        static string StructurePhysics(string id, IList<string> materials, out string rule)
        {
            var text = id + " " + string.Join(" ", materials.ToArray());
            if (Kw(text, "sand")) { rule = "sand"; return "GSPsand"; }
            if (Kw(id, "kitchen", "bed", "flowerbed", "vegetable")) { rule = "garden bed"; return "GSPrough"; }
            if (Kw(text, "wooden", "timber", "deck", "boardwalk", "plank", "jetty", "pier") || (Kw(id, "bridge") && Kw(text, "wood"))) { rule = "timber word"; return "GSPtimber"; }
            if (Kw(text, "precast", "concrete", "asphalt", "paving", "slab")) { rule = "paving/concrete word"; return "GSPconcrete"; }
            if (Kw(text, "stone", "granite", "basement", "edge", "wall", "bridge", "boulder", "rock", "cobble")) { rule = "stone word"; return "GSPstone"; }
            if (Kw(text, "yard", "forecourt", "courtyard", "path", "gravel", "terrace", "apron")) { rule = "yard/path word"; return "GSPconcrete"; }
            rule = "guessed";
            return "GSPconcrete";
        }

        // the id first, then the material names, in this order: stone, paving/metal, timber
        static string PropPhysics(string id, IList<string> materials, out string rule)
        {
            var texts = new List<KeyValuePair<string, string>> { new KeyValuePair<string, string>("id", id), new KeyValuePair<string, string>("materials", string.Join(" ", materials.ToArray())) };
            foreach (var kv in texts)
            {
                if (Kw(kv.Value, "stone", "granite", "boulder", "rock", "marble")) { rule = "stone word (" + kv.Key + ")"; return "GSPstone"; }
                if (Kw(kv.Value, "paving", "concrete", "slab", "vehicle", "vehicles", "car", "tyre", "tire", "trailer", "container", "bin", "galvan", "chrome")) { rule = "paving/metal word (" + kv.Key + ")"; return "GSPconcrete"; }
                if (Kw(kv.Value, "sign", "bench", "fence", "mat", "mats", "furniture", "wood", "wooden", "timber", "plank", "post", "table", "chair", "deck", "rail")) { rule = "timber word (" + kv.Key + ")"; return "GSPtimber"; }
            }
            rule = "guessed";
            return "GSPconcrete";
        }

        // ------------------------------------------------------------------ 9: walls, 10: power lines

        static void Walls(Ctx c, GameObject root)
        {
            if (root == null) return;
            var file = c.courseFolder + "stone-walls.json";
            PhysicMaterial material = null;
            try { if (File.Exists(file)) material = GolfMapWalls.LoadPhysics(GolfMapJsonDoc.ParseObject(File.ReadAllText(file)), file); }
            catch (Exception e) { c.Issue("walls", "warn", file, e.Message + ": GSPstone checked instead", root.transform.position); }
            if (material == null) material = c.P("GSPstone");
            string want = material != null ? material.name : "GSPstone";
            foreach (Transform w in root.transform)
            {
                if (!w.gameObject.activeInHierarchy) continue;
                var b = ObjectBounds(w.gameObject);
                if (!c.Consider("walls", c.area.Meets(b))) continue;
                var cs = w.GetComponentsInChildren<Collider>(true);
                var wrong = cs.Where(x => x.enabled && x.gameObject.activeInHierarchy && PhysName(x) != want).ToList();
                if (wrong.Count == 0) continue;
                c.Issue("walls", "warn", PathOf(w.gameObject), wrong.Count + " of " + cs.Length + " stone collider(s) not on " + want + " (" + string.Join(", ", wrong.Select(x => PhysName(x) ?? "none").Distinct().ToArray()) + ")", b.center,
                    material == null ? null : "physic material " + want + " on every collider of the wall (golfmap.walls.colliders)",
                    material == null ? (Action)null : () => { foreach (var x in cs.Where(x => x.sharedMaterial != material)) { Undo.RecordObject(x, "Make course ready"); x.sharedMaterial = material; } c.sceneChanged = true; });
            }
        }

        static void PowerLines(Ctx c, GameObject root)
        {
            if (root == null) return;
            var wood = c.P("GSPwood");
            foreach (Transform line in root.transform)
            {
                if (!line.gameObject.activeInHierarchy) continue;
                var poles = line.Find("Poles");
                var wires = line.Find("Wires");
                var pf = poles != null ? poles.GetComponent<MeshFilter>() : null;
                bool near = (pf != null && NearMesh(c, pf, ObjectBounds(poles.gameObject))) || (wires != null && NearMesh(c, wires.GetComponent<MeshFilter>(), ObjectBounds(wires.gameObject)));
                if (!c.Consider("power-lines", near)) continue;
                if (poles != null && poles.gameObject.activeInHierarchy)
                    MeshColliderOn(c, "power-lines", poles.gameObject, pf != null ? pf.sharedMesh : null, wood, "GSPwood", ObjectBounds(poles.gameObject).center, "error", "warn", "the ball flies through the poles");
                if (wires != null && wires.gameObject.activeInHierarchy) NoCollider(c, "power-lines", wires.gameObject, ObjectBounds(wires.gameObject).center, "the wires (a ball flies through a 6 cm line)");
            }
        }

        // ------------------------------------------------------------------ 12: what must not collide

        static void NoColliders(Ctx c, GameObject[] roots)
        {
            var wispy = roots.FirstOrDefault(g => g.name == "GolfMap Wispy Rough");
            if (wispy != null)
                foreach (Transform t in wispy.transform)
                {
                    if (!t.gameObject.activeInHierarchy) continue;
                    var b = ObjectBounds(t.gameObject);
                    if (c.Consider("wispy-rough", c.area.Meets(b))) NoCollider(c, "wispy-rough", t.gameObject, b.center, "Stix wispy rough (grass)");
                }
            // the far shore: the Horizon root, and anything drawn with its shader
            var horizon = roots.SelectMany(r => r.GetComponentsInChildren<Renderer>(true))
                .Where(r => r.gameObject.activeInHierarchy && (r.transform.root.name == "Horizon" || r.sharedMaterials.Any(m => m != null && m.shader != null && m.shader.name == "GolfMap/FarShore")))
                .Select(r => r.gameObject).Distinct().ToList();
            foreach (var g in horizon)
            {
                var b = ObjectBounds(g);
                if (c.Consider("horizon", c.area.Meets(b))) NoCollider(c, "horizon", g, b.center, "the far shore (render only)");
            }
        }

        // ------------------------------------------------------------------ 11: course meshes

        static readonly Dictionary<GolfMapSurfaces.Surface, string> Expected = new Dictionary<GolfMapSurfaces.Surface, string>
        {
            { GolfMapSurfaces.Surface.Tee, "GSPtee" }, { GolfMapSurfaces.Surface.Fairway, "GSPfairway" }, { GolfMapSurfaces.Surface.Green, "GSPgreen" },
            { GolfMapSurfaces.Surface.Semi, "GSPsemirough" }, { GolfMapSurfaces.Surface.Rough, "GSPrough" }, { GolfMapSurfaces.Surface.Deep, "GSPdeeprough" },
            { GolfMapSurfaces.Surface.Bunker, "GSPsand" },
        };

        static void CourseMeshes(Ctx c, List<MeshFilter> meshes)
        {
            string slabWant = "GSPstone";
            var slabSpec = c.courseFolder + "rock-slabs.json";
            if (File.Exists(slabSpec))
            {
                var p = GolfMapJsonDoc.ParseObject(File.ReadAllText(slabSpec)).String("physicMaterial");
                if (!string.IsNullOrEmpty(p)) slabWant = Path.GetFileNameWithoutExtension(p);
            }
            var slabMaterial = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(PhysicsFolder + slabWant + ".physicMaterial") ?? c.P(slabWant);
            int withCollider = 0, near = 0;
            var mismatch = new Dictionary<string, Finding>();
            foreach (var f in meshes)
            {
                var g = f.gameObject;
                var b = ObjectBounds(g);
                c.Consider("course-meshes", true);   // all of them are the course: checked wherever they lie
                if (c.area.Meets(b)) near++;
                var mc = g.GetComponent<MeshCollider>();
                if (mc == null || !mc.enabled) continue;   // golfmap.course.check reports these
                withCollider++;
                var cls = GolfMapSurfaces.Classify(g.name);
                var have = PhysName(mc);
                if (g.name.Contains("_WaterBrook_-_Mesh"))
                {
                    if (have != "GSPwater")
                    {
                        var water = c.P("GSPwater");
                        c.Issue("course-meshes", "warn", g.name, "the creek bed on " + (have ?? "no physic material") + ", GSPwater wanted", b.center, water == null ? null : "physic material GSPwater",
                            water == null ? (Action)null : () => { Undo.RecordObject(mc, "Make course ready"); mc.sharedMaterial = water; c.sceneChanged = true; });
                    }
                }
                else if (cls == GolfMapSurfaces.Surface.Slab)
                {
                    if (have != slabWant)
                        c.Issue("course-meshes", have == null ? "error" : "warn", g.name, "a rock slab on " + (have ?? "no physic material") + ", " + slabWant + " wanted (rock-slabs.json)", b.center,
                            slabMaterial == null ? null : "physic material " + slabWant + " (as golfmap.slabs.materials)",
                            slabMaterial == null ? (Action)null : () => { Undo.RecordObject(mc, "Make course ready"); mc.sharedMaterial = slabMaterial; c.sceneChanged = true; });
                }
                else if (have == null)
                    c.Issue("course-meshes", "error", g.name, "no physic material: GSPro has no surface to read the ball's bounce and roll off", b.center);
                else
                {
                    string want;
                    if (!Expected.TryGetValue(cls, out want) || want == have) continue;
                    // OPCD's Set Default Materials gives these; a mismatch is listed, not changed
                    var k = cls + " on " + have;
                    Finding fi;
                    if (!mismatch.TryGetValue(k, out fi)) mismatch[k] = c.Issue("course-meshes", "info", g.name, cls + " meshes on " + have + " (" + want + " expected; OPCD's Set Default Materials decides)", b.center);
                    else fi.objects.Add(g.name);
                }
            }
            foreach (var fi in mismatch.Values) fi.note = fi.objects.Count + " " + fi.note;
            c.decisions["courseMeshes"] = new Dictionary<string, object> { { "active", meshes.Count }, { "nearPlay", near }, { "withCollider", withCollider }, { "colliders", "golfmap.course.check" } };
        }

        // ------------------------------------------------------------------ 13: scene readiness, missing prefabs

        static void SceneChecks(Ctx c, UnityEngine.SceneManagement.Scene scene, GameObject[] roots, bool wasDirty)
        {
            // missing prefab instances (only the top of each); removeMissingPrefabs=true with fix deletes them (undo)
            var missing = roots.SelectMany(r => r.GetComponentsInChildren<Transform>(true))
                .Where(t => PrefabUtility.GetPrefabType(t.gameObject) == PrefabType.MissingPrefabInstance
                    && !(t.parent != null && PrefabUtility.GetPrefabType(t.parent.gameObject) == PrefabType.MissingPrefabInstance))
                .ToList();
            foreach (var t in missing)
            {
                c.Consider("scene", true);
                var go = t.gameObject;
                c.Issue("scene", "error", PathOf(go), "missing prefab instance: its prefab asset is gone", t.position,
                    removeMissingPrefabs ? "deleted (removeMissingPrefabs)" : null,
                    removeMissingPrefabs ? (Action)(() => { Undo.DestroyObjectImmediate(go); c.sceneChanged = true; }) : null);
            }
            // paint previews left: colour-only copies under <course>/PaintedMeshes/ that would ship in the build
            var restore = c.courseFolder + "PaintedMeshes/restore.json";
            if (File.Exists(restore))
            {
                var meshes = GolfMapJsonDoc.ParseObject(File.ReadAllText(restore)).Object("meshes");
                var previews = meshes == null ? new List<string>() : meshes.keys.Where(k => meshes.Object(k) != null && meshes.Object(k).Bool("preview", false)).ToList();
                c.Consider("scene", true);
                if (previews.Count > 0)
                {
                    var f = c.Issue("scene", "error", previews[0], previews.Count + " paint preview(s) left: the preview colours would ship in the build", Vector3.zero,
                        "golfmap.paint.clear (back to the FBX meshes)", () =>
                        {
                            var r = GolfMapVertexPaint.Clear(null);
                            var errs = r["errors"] as List<object>;
                            if (errs != null && errs.Count > 0) throw new InvalidOperationException(string.Join("; ", errs.Select(e => e.ToString()).ToArray()));
                        });
                    f.objects.AddRange(previews.Skip(1));
                }
            }
            // terrain colliders the build leaves out (golfmap.course.build's defaults)
            var defaults = new BridgeArgs(null);
            foreach (var t in UnityEngine.Object.FindObjectsOfType<Terrain>().Where(t => t.gameObject.scene == scene))
            {
                var tc = t.GetComponent<TerrainCollider>();
                if (tc == null || !tc.enabled) continue;
                c.Consider("scene", true);
                if (!GolfMapCourseBuild.KeepCollider(t.name, defaults))
                    c.Issue("scene", "info", t.name, "terrain collider on in the editor: golfmap.course.build leaves it out of the bundle (terrainCollider/outerCollider=false), so the ball never meets it in GSPro", t.transform.position);
            }
            // what GSPro's build counts in its "Colliders missing Physic Materials" dialog: every collider of the scene
            // without one, wherever it lies (terrain colliders aside: the build leaves them out); after this run's fixes
            var unset = roots.SelectMany(r => r.GetComponentsInChildren<Collider>(true))
                .Where(x => x.enabled && !x.isTrigger && x.gameObject.activeInHierarchy && !(x is TerrainCollider) && x.sharedMaterial == null)
                .ToList();
            foreach (var group in unset.GroupBy(x => x.transform.root.name))
            {
                c.Consider("scene", true);
                var f = c.Issue("scene", "error", PathOf(group.First().gameObject), group.Count() + " collider(s) under " + group.Key + " on no physic material" + (c.fix ? " after the fixes" : "") + ": GSPro's build stops on them (Collider Errors)", group.First().bounds.center);
                f.objects.AddRange(group.Skip(1).Select(x => PathOf(x.gameObject)).Distinct());
            }
            c.decisions["collidersWithoutPhysics"] = unset.Count;
            ConsoleErrors(c);
            if (wasDirty) { c.Consider("scene", true); c.Issue("scene", "info", scene.name, "the scene has unsaved changes (save=true saves it after this run)", Vector3.zero); }
        }

        // ------------------------------------------------------------------ 14: Unity's Console

        // Errors still standing in Unity's Console window, compile errors included (the same message once, with its
        // count): to be handled, then cleared, before a build. Nothing to fix here, so no fix action.
        static void ConsoleErrors(Ctx c)
        {
            c.Consider("console", true);
            var rows = BridgeConsole.UnityConsoleErrors(5000);
            if (rows == null)
            {
                c.Issue("console", "info", "Console", "could not read Unity's Console window (internal LogEntries API changed): look at it yourself", Vector3.zero);
                return;
            }
            foreach (var g in rows.GroupBy(r => (string)r["message"]))
            {
                var r0 = g.First();
                var where = r0["file"] as string;
                c.Issue("console", "error", string.IsNullOrEmpty(where) ? "Console" : where + ":" + r0["line"],
                    (g.Count() > 1 ? g.Count() + "x " : "") + g.Key + " (Unity's Console: handle it, then clear the Console)", Vector3.zero);
            }
            c.decisions["consoleErrors"] = rows.Count;
        }

        // ------------------------------------------------------------------ helpers

        static string PhysName(Collider c) { return c.sharedMaterial != null ? c.sharedMaterial.name : null; }

        static Bounds WorldBounds(Bounds local, Matrix4x4 m)
        {
            var b = new Bounds(m.MultiplyPoint3x4(local.center), Vector3.zero);
            for (int i = 0; i < 8; i++)
                b.Encapsulate(m.MultiplyPoint3x4(local.center + Vector3.Scale(local.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1))));
            return b;
        }

        // world bounds of what an object draws or collides with: its meshes (renderer on or off: a hidden R.A.M.
        // road still collides), enabled renderers, colliders; else its position
        static Bounds ObjectBounds(GameObject g)
        {
            Bounds b = new Bounds(g.transform.position, Vector3.zero); bool any = false;
            Action<Bounds> add = x => { if (!any) { b = x; any = true; } else b.Encapsulate(x); };
            foreach (var f in g.GetComponentsInChildren<MeshFilter>())
                if (f.sharedMesh != null) add(WorldBounds(f.sharedMesh.bounds, f.transform.localToWorldMatrix));
            foreach (var r in g.GetComponentsInChildren<Renderer>())
                if (r.enabled && !(r is MeshRenderer) && r.bounds.size != Vector3.zero) add(r.bounds);
            foreach (var c in g.GetComponentsInChildren<Collider>())
                if (c.enabled) add(c.bounds);
            return b;
        }

        // a long thin mesh (a road, a creek, a power line): near when one of its vertices is, not its box
        static bool NearMesh(Ctx c, MeshFilter f, Bounds b)
        {
            if (!c.area.Meets(b)) return false;
            if (f == null || f.sharedMesh == null) return true;
            var m = f.transform.localToWorldMatrix;
            var v = f.sharedMesh.vertices;
            int step = Math.Max(1, v.Length / 20000);
            for (int i = 0; i < v.Length; i += step)
            {
                var p = m.MultiplyPoint3x4(v[i]);
                if (c.area.Inside(p.x, p.z)) return true;
            }
            return false;
        }

        static string PathOf(GameObject g)
        {
            var p = g.name;
            for (var t = g.transform.parent; t != null; t = t.parent) p = t.name + "/" + p;
            return p;
        }
    }
}
