// Unity 2018.2 / C# 6. Waterfalls between ponds at different levels.
//
// golf-map's `waterfall` features (a line along a fall's lip, drawn in Draw
// mode or proposed by the terrain editor's Find falls) are exported by
// `gspro.py waterfalls` as <prefix>-inner-waterfalls.json (unity-waterfalls-v1,
// the creeks' plot frame: x/z in inner-plot metres, Y = height - the
// sidecar's minM):
//
//   { "format": "unity-waterfalls-v1", "plot": {...},
//     "waterfalls": [ { "id": "hole_3_241", "style": "sill"|"outlet", "lip": [[x, z], ...],
//                       "topY", "bottomY", "flow": [dx, dz], "widthM", "sillM" } ] }
//
// Each fall becomes one object "Waterfall <id>" under "GolfMap Waterfalls":
// - the water: a NatureManufacture R.A.M. spline running down the fall's
//   middle, as wide as the lip: over the sill's crest at the upper water,
//   over the lip and down to the lower water, so R.A.M.'s profile gives the
//   steep part its fast, foamy flow (flowWaterfall). A `sill` fall starts on
//   the crest `sillM` upstream of the lip; an `outlet` starts in the bank face
//   just below the upper water (the water comes out from under a crossing);
// - white water: two particle systems with R.A.M.'s waterfall particle
//   materials, sized to the fall: foam over the lip, spray and foam where the
//   water lands, both spread along the lip.
// The levels snap to the water that is there: the water plane (or creek) the
// ray straight down hits just upstream of the lip and just past where the
// water lands, else the export's levels.
//
// A rebuild replaces every fall object (they are generated; hand edits to them
// are not kept). R.A.M. lives in Assembly-CSharp, so its types are found by name.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapWaterfalls
    {
        public const string Format = "unity-waterfalls-v1";
        const string RootName = "GolfMap Waterfalls";
        const string NamePrefix = "Waterfall ";
        const string DefaultProfile = "Small Stream Profile";
        const string FoamMaterial = "Waterfall_Top PBR";
        const string SplashMaterial = "Waterfall_Bottom PBR";
        const string MistMaterial = "Waterfall_Clouds PBR";
        const string AssetFolder = "Waterfalls";
        const string WaterMaterial = "Waterfall water";

        sealed class Fall
        {
            public string id, style;
            public List<Vector2> lip = new List<Vector2>();
            public Vector2 flow;
            public float topY, bottomY, widthM, sillM;
        }

        public sealed class Options
        {
            public string profile = DefaultProfile;
            public bool particles = true, snap = true;
            public bool resetMaterial;        // make <course>/Waterfalls/Waterfall water.mat again from the profile, with this builder's look
            public float overhangM = 0.15f;   // how far past the lip the falling water lands, per metre of drop
            public float foamRate = 30f;      // particles per second per metre of lip
            public float splashRate = 14f;
        }

        [MenuItem("GolfMap/Water/Build waterfalls")]
        static void Menu() { Debug.Log("[GolfMap Waterfalls] " + GolfMapJson.Serialize(Build(null, false, new Options()), false)); }

        [BridgeCommand("golfmap.waterfalls.build", "Build the course's waterfalls (golf-map `waterfall` features; <export folder>/<prefix>-inner-waterfalls.json from `gspro.py waterfalls`) under 'GolfMap Waterfalls': per fall a R.A.M. spline from the upper water over the lip down to the lower water (its profile's waterfall flow on the steep part) and foam and spray particles along the lip and where it lands. The levels snap to the water planes or creeks found just upstream and downstream, else the export's. Replaces every fall the last build made. Marks the scene dirty.",
            args = "file (default: the active course's export), dryRun=false, profile=Small Stream Profile (a R.A.M. SplineProfile name; its material is copied once to <course>/Waterfalls/Waterfall water.mat and then kept), particles=true, snap=true (false: the export's levels as they are), overhangM=0.15 (per metre of drop), resetMaterial=false (remake the course's Waterfall water.mat from the profile with the builder's look; hand tuning is lost), " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            var o = new Options();
            o.profile = a.String("profile") ?? o.profile;
            o.particles = a.Bool("particles", o.particles);
            o.snap = a.Bool("snap", o.snap);
            o.overhangM = (float)a.Number("overhangM", o.overhangM);
            o.resetMaterial = a.Bool("resetMaterial", false);
            return Build(a.String("file"), a.Bool("dryRun", false), o);
        }

        [BridgeCommand("golfmap.waterfalls.clear", "Delete 'GolfMap Waterfalls' (everything golfmap.waterfalls.build made). Marks the scene dirty.")]
        static object Clear()
        {
            var root = GameObject.Find("/" + RootName);
            if (root == null) return new Dictionary<string, object> { { "removed", 0 } };
            int n = root.transform.childCount;
            Undo.DestroyObjectImmediate(root);
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return new Dictionary<string, object> { { "removed", n } };
        }

        public static Dictionary<string, object> Build(string file, bool dryRun, Options o)
        {
            var course = GolfMapCourses.Require();
            file = string.IsNullOrEmpty(file) ? GolfMapCourses.ExportFile(course, "inner", "waterfalls") : file;
            if (string.IsNullOrEmpty(file) || !File.Exists(file))
                throw new InvalidOperationException("No waterfalls export at " + (file ?? "(the course has no export folder)") + ": run Update waterfalls on golf-map's GSPro board (or `bun run gspro:export -- <course> waterfalls`).");
            var falls = Load(file);

            var splineType = FindType("RamSpline");
            var profileType = FindType("SplineProfile");
            if (splineType == null || profileType == null)
                throw new InvalidOperationException("NatureManufacture R.A.M. (RamSpline, SplineProfile) is not in this project.");
            var profile = FindAsset(o.profile, profileType);
            if (profile == null) throw new InvalidOperationException("No R.A.M. profile '" + o.profile + "' in the project.");
            var foam = FindAsset(FoamMaterial, typeof(Material)) as Material;
            var splash = FindAsset(SplashMaterial, typeof(Material)) as Material;
            var mist = FindAsset(MistMaterial, typeof(Material)) as Material;
            string madeFrom = null;
            var material = dryRun ? null : WaterLook(course, profileType.GetField("splineMaterial").GetValue(profile) as Material, o.resetMaterial, out madeFrom);
            var creeks = CreekLines(course);

            var scene = EditorSceneManager.GetActiveScene();
            var old = scene.GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
            var rows = new List<object>();
            GameObject root = null;
            if (!dryRun)
            {
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Build waterfalls");
                if (old != null) Undo.DestroyObjectImmediate(old);
                root = new GameObject(RootName);
                Undo.RegisterCreatedObjectUndo(root, "Build waterfalls");
            }
            int undoGroup = Undo.GetCurrentGroup();

            foreach (var f in falls)
            {
                var mid = Mid(f.lip);
                var u = f.flow.normalized;
                float drop0 = f.topY - f.bottomY;
                float land = Mathf.Clamp(o.overhangM * Mathf.Max(drop0, 0.2f) + 0.2f, 0.25f, 1.2f);
                float? top = o.snap ? WaterAt(mid - u * (f.style == "sill" ? f.sillM + 0.6f : 1.2f), f.topY, old, creeks) : null;
                float? bottom = o.snap ? WaterAt(mid + u * (land + 0.8f), f.bottomY, old, creeks) : null;
                float topY = top ?? f.topY, bottomY = bottom ?? f.bottomY;
                float drop = topY - bottomY;
                var row = new Dictionary<string, object>
                {
                    { "id", f.id }, { "style", f.style }, { "widthM", Math.Round(f.widthM, 2) },
                    { "topY", Math.Round(topY, 3) }, { "bottomY", Math.Round(bottomY, 3) }, { "dropM", Math.Round(drop, 2) },
                    { "topFrom", top != null ? "water" : "export" }, { "bottomFrom", bottom != null ? "water" : "export" },
                };
                rows.Add(row);
                if (drop < 0.05f) { row["skipped"] = "no drop between the waters found"; continue; }
                if (dryRun) continue;

                var go = new GameObject(NamePrefix + f.id);
                go.transform.SetParent(root.transform, false);
                Undo.RegisterCreatedObjectUndo(go, "Build waterfalls");

                // The water: down the middle of the lip, as wide as it.
                var pts = Profile(f, mid, u, topY, bottomY, land);
                    var spline = (Component)splineType.GetMethod("CreateSpline", BindingFlags.Public | BindingFlags.Static)
                    .Invoke(null, new object[] { material, null });
                spline.gameObject.name = "Water";
                spline.transform.SetParent(go.transform, false);
                spline.transform.localPosition = Vector3.zero;
                var addPoint = splineType.GetMethod("AddPoint", new[] { typeof(Vector4) });
                foreach (var p in pts) addPoint.Invoke(spline, new object[] { new Vector4(p.x, p.y, p.z, f.widthM) });
                splineType.GetField("width").SetValue(spline, f.widthM);
                splineType.GetField("snapToTerrain").SetValue(spline, false);
                ApplyProfile(spline, splineType, profile, profileType);
                if (material != null) spline.GetComponent<MeshRenderer>().sharedMaterial = material;
                splineType.GetMethod("GenerateSpline").Invoke(spline, new object[] { null });
                foreach (var r in spline.GetComponentsInChildren<MeshRenderer>(true))
                {
                    r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                    r.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.BlendProbes;
                }
                row["points"] = pts.Count;

                if (o.particles)
                {
                    var lipDir = Across(f.lip, u);
                    var lipTop = new Vector3(mid.x, topY + 0.02f, mid.y) + new Vector3(u.x, 0, u.y) * 0.05f;
                    var landAt = new Vector3(mid.x + u.x * land, bottomY + 0.03f, mid.y + u.y * land);
                    if (foam != null) Emitter(go, "Foam over the lip", foam, lipTop, lipDir, f.widthM, u, drop, o.foamRate, false);
                    if (splash != null) Emitter(go, "Splash", splash, landAt, lipDir, f.widthM, u, drop, o.splashRate, true);
                    if (mist != null && drop >= 1f) Emitter(go, "Mist", mist, landAt + Vector3.up * 0.2f, lipDir, f.widthM, u, drop, 3f, true, mist: true);
                }
            }

            if (!dryRun)
            {
                Undo.CollapseUndoOperations(undoGroup);
                EditorSceneManager.MarkSceneDirty(scene);
                SceneView.RepaintAll();
            }
            return new Dictionary<string, object>
            {
                { "file", file }, { "dryRun", dryRun }, { "falls", rows.Count }, { "profile", o.profile },
                { "particles", o.particles }, { "material", material != null ? AssetDatabase.GetAssetPath(material) : null },
                { "madeFrom", madeFrom }, { "rows", rows },
            };
        }

        // The spline's points (x, y, z) down the middle of the fall, upstream to downstream.
        static List<Vector3> Profile(Fall f, Vector2 mid, Vector2 u, float topY, float bottomY, float land)
        {
            float drop = topY - bottomY;
            Func<float, float, Vector3> at = (along, y) => new Vector3(mid.x + u.x * along, y, mid.y + u.y * along);
            var pts = new List<Vector3>();
            if (f.style == "outlet")
            {
                // Out of the bank face a little below the upper water.
                float outY = topY - Mathf.Min(0.15f, drop * 0.2f);
                pts.Add(at(-0.4f, outY + 0.02f));
                pts.Add(at(0f, outY));
            }
            else
            {
                // Over the sill's crest, a few centimetres deep, then over the lip.
                pts.Add(at(-(f.sillM + 0.3f), topY + 0.01f));
                pts.Add(at(-f.sillM * 0.5f, topY - 0.01f));
                pts.Add(at(0f, topY - 0.03f));
            }
            // The free fall: a curtain bowing out, steepening as it goes.
            pts.Add(at(land * 0.35f, bottomY + drop * 0.55f));
            pts.Add(at(land * 0.8f, bottomY + drop * 0.12f));
            // Landing and running out on the lower water.
            pts.Add(at(land + 0.35f, bottomY + 0.01f));
            pts.Add(at(land + 1.2f, bottomY + 0.005f));
            return pts;
        }

        static void Emitter(GameObject parent, string name, Material material, Vector3 at, Vector3 along, float widthM, Vector2 u,
            float drop, float ratePerM, bool landing, bool mist = false)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent.transform, false);
            go.transform.position = at;
            go.transform.rotation = Quaternion.LookRotation(along, Vector3.up);   // local z along the lip
            var ps = go.AddComponent<ParticleSystem>();
            var main = ps.main;
            main.loop = true;
            main.playOnAwake = true;
            main.scalingMode = ParticleSystemScalingMode.Hierarchy;
            main.simulationSpace = ParticleSystemSimulationSpace.World;
            main.maxParticles = 400;
            var shape = ps.shape;
            shape.shapeType = ParticleSystemShapeType.Box;
            shape.scale = new Vector3(0.15f, 0.05f, Mathf.Max(widthM - 0.2f, 0.3f));
            var emission = ps.emission;
            var flowDir = new Vector3(u.x, 0, u.y);
            var vel = ps.velocityOverLifetime;
            vel.enabled = true;
            vel.space = ParticleSystemSimulationSpace.World;
            if (mist)
            {
                main.startLifetime = new ParticleSystem.MinMaxCurve(2f, 3.5f);
                main.startSpeed = 0f;
                main.startSize = new ParticleSystem.MinMaxCurve(0.8f + drop * 0.3f, 1.5f + drop * 0.5f);
                main.startColor = new Color(1f, 1f, 1f, 0.12f);
                emission.rateOverTime = Mathf.Max(widthM, 1f) * ratePerM;
                vel.x = flowDir.x * 0.15f; vel.y = 0.12f; vel.z = flowDir.z * 0.15f;
            }
            else if (landing)
            {
                // Spray and foam where the curtain lands, drifting downstream.
                main.startLifetime = new ParticleSystem.MinMaxCurve(0.8f, 1.6f);
                main.startSpeed = new ParticleSystem.MinMaxCurve(0.1f, 0.3f + drop * 0.2f);
                main.startSize = new ParticleSystem.MinMaxCurve(0.25f + drop * 0.15f, 0.5f + drop * 0.3f);
                main.startRotation = new ParticleSystem.MinMaxCurve(0f, Mathf.PI * 2f);
                main.startColor = new Color(1f, 1f, 1f, 0.55f);
                main.gravityModifier = 0.05f;
                emission.rateOverTime = Mathf.Max(widthM, 0.5f) * ratePerM * Mathf.Clamp(drop, 0.5f, 2f);
                vel.x = flowDir.x * 0.25f; vel.y = 0.05f; vel.z = flowDir.z * 0.25f;
                shape.scale = new Vector3(0.4f, 0.05f, Mathf.Max(widthM - 0.1f, 0.3f));
            }
            else
            {
                // White water breaking over the lip and falling with the curtain.
                main.startLifetime = new ParticleSystem.MinMaxCurve(0.35f, 0.6f);
                main.startSpeed = new ParticleSystem.MinMaxCurve(0.2f, 0.5f);
                main.startSize = new ParticleSystem.MinMaxCurve(0.12f, 0.3f);
                main.startRotation = new ParticleSystem.MinMaxCurve(0f, Mathf.PI * 2f);
                main.startColor = new Color(1f, 1f, 1f, 0.45f);
                main.gravityModifier = 0.6f;
                emission.rateOverTime = Mathf.Max(widthM, 0.5f) * ratePerM;
                vel.x = flowDir.x * 0.6f; vel.y = 0f; vel.z = flowDir.z * 0.6f;
            }
            var col = ps.colorOverLifetime;
            col.enabled = true;
            var g = new Gradient();
            g.SetKeys(new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(1f, 0.15f), new GradientAlphaKey(0.6f, 0.6f), new GradientAlphaKey(0f, 1f) });
            col.color = g;
            var size = ps.sizeOverLifetime;
            size.enabled = true;
            size.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 0.7f, 1f, 1.3f));
            var r = go.GetComponent<ParticleSystemRenderer>();
            r.sharedMaterial = material;
            r.renderMode = ParticleSystemRenderMode.Billboard;
            r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            r.receiveShadows = false;
            // Edit mode does not run particle systems: settle one so the Scene view (and its screenshots) shows it.
            ps.Simulate(2f, true, true);
        }

        // The course's waterfall water: a copy of the profile's R.A.M. material, made once and then kept (hand tuning stays).
        static Material WaterLook(GolfMapCourse course, Material from, bool reset, out string madeFrom)
        {
            madeFrom = null;
            var folder = GolfMapCourses.Folder(course) + AssetFolder;
            var path = folder + "/" + WaterMaterial + ".mat";
            var have = AssetDatabase.LoadAssetAtPath<Material>(path);
            if ((have != null && !reset) || from == null) return have;
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(folder.Substring(0, folder.LastIndexOf('/')), AssetFolder);
            var made = new Material(from) { name = WaterMaterial };
            // R.A.M.'s cascade is drawn for a river's big white falls (HDR white x20, all but opaque): a garden weir's
            // curtain is clear water with white streaks.
            foreach (var name in new[] { "_BigCascadeColor", "_CascadeColor", "_SlowCascadeColor" })
                if (made.HasProperty(name)) made.SetColor(name, new Color(CascadeWhite, CascadeWhite, CascadeWhite, 0f));
            if (made.HasProperty("_FoamColor")) made.SetColor("_FoamColor", new Color(FoamWhite, FoamWhite, FoamWhite, 0f));
            if (made.HasProperty("_BigCascadeTransparency")) made.SetFloat("_BigCascadeTransparency", CascadeTransparency);
            if (have != null) { EditorUtility.CopySerialized(made, have); EditorUtility.SetDirty(have); made = have; }
            else AssetDatabase.CreateAsset(made, path);
            madeFrom = AssetDatabase.GetAssetPath(from);
            return made;
        }

        const float CascadeWhite = 2.5f, FoamWhite = 3f, CascadeTransparency = 0.35f;

        // The creeks' water (the creeks export golfmap.creeks.import fits; one line per creek stretch, [x, y, z]):
        // R.A.M. splines have no collider to hit.
        static List<List<Vector3>> CreekLines(GolfMapCourse course)
        {
            var lines = new List<List<Vector3>>();
            var file = GolfMapCourses.ExportFile(course, "inner", "creeks");
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) return lines;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            foreach (var c in (root.Array("creeks") ?? new List<object>()).OfType<GolfMapJsonObject>())
            {
                var line = (c.Array("points") ?? new List<object>()).OfType<List<object>>()
                    .Select(q => q.OfType<GolfMapJsonNumber>().Select(n => (float)n.Value).ToArray())
                    .Where(v => v.Length >= 3).Select(v => new Vector3(v[0], v[1], v[2])).ToList();
                if (line.Count >= 2) lines.Add(line);
            }
            return lines;
        }

        // A creek's water at p: the nearest creek stretch within CreekReachM (along its line), within 1.5 m of `near`.
        const float CreekReachM = 6f;
        static float? CreekAt(Vector2 p, float near, List<List<Vector3>> creeks)
        {
            float best = CreekReachM;
            float? y = null;
            foreach (var line in creeks)
                for (int i = 1; i < line.Count; i++)
                {
                    var a = new Vector2(line[i - 1].x, line[i - 1].z); var b = new Vector2(line[i].x, line[i].z);
                    var ab = b - a;
                    float t = ab.sqrMagnitude > 1e-6f ? Mathf.Clamp01(Vector2.Dot(p - a, ab) / ab.sqrMagnitude) : 0f;
                    float d = Vector2.Distance(p, a + ab * t);
                    float h = Mathf.Lerp(line[i - 1].y, line[i].y, t);
                    if (d < best && Mathf.Abs(h - near) <= 1.5f) { best = d; y = h; }
                }
            return y;
        }

        // The water's surface straight down at p: the highest water plane hit within 1.5 m of `near`, else the
        // nearest creek stretch's water.
        static float? WaterAt(Vector2 p, float near, GameObject ignore, List<List<Vector3>> creeks)
        {
            var plane = PlaneAt(p, near, ignore);
            return plane ?? CreekAt(p, near, creeks);
        }

        static float? PlaneAt(Vector2 p, float near, GameObject ignore)
        {
            var hits = Physics.RaycastAll(new Ray(new Vector3(p.x, near + 50f, p.y), Vector3.down), 100f, ~0, QueryTriggerInteraction.Collide);
            float? best = null;
            foreach (var h in hits)
            {
                var t = h.collider.transform;
                if (ignore != null && t.IsChildOf(ignore.transform)) continue;
                bool water = GolfMapWaterplanes.IsWaterPlane(t.name) || (t.parent != null && t.parent.name == "GolfMap Creeks");
                if (!water || Mathf.Abs(h.point.y - near) > 1.5f) continue;
                if (best == null || h.point.y > best.Value) best = h.point.y;
            }
            return best;
        }

        static Vector2 Mid(List<Vector2> lip)
        {
            float total = 0;
            for (int i = 1; i < lip.Count; i++) total += Vector2.Distance(lip[i - 1], lip[i]);
            float half = total / 2, run = 0;
            for (int i = 1; i < lip.Count; i++)
            {
                float d = Vector2.Distance(lip[i - 1], lip[i]);
                if (run + d >= half && d > 0) return Vector2.Lerp(lip[i - 1], lip[i], (half - run) / d);
                run += d;
            }
            return lip[0];
        }

        // Along the lip (horizontal, unit): its end-to-end direction, else square to the flow.
        static Vector3 Across(List<Vector2> lip, Vector2 u)
        {
            var d = lip[lip.Count - 1] - lip[0];
            if (d.sqrMagnitude < 1e-4f) d = new Vector2(-u.y, u.x);
            d.Normalize();
            return new Vector3(d.x, 0, d.y);
        }

        static List<Fall> Load(string file)
        {
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            if (root.String("format") != Format) throw new InvalidOperationException(file + ": format must be " + Format + ".");
            var list = new List<Fall>();
            var plot = root.Object("plot");
            if (plot == null || plot.String("terrain") != "inner") throw new InvalidOperationException(file + ": waterfalls are for the inner terrain.");
            foreach (var o in (root.Array("waterfalls") ?? new List<object>()).OfType<GolfMapJsonObject>())
            {
                var f = new Fall
                {
                    id = o.String("id"), style = o.String("style") ?? "sill",
                    topY = (float)o.Number("topY"), bottomY = (float)o.Number("bottomY"),
                    widthM = (float)o.Number("widthM", 1.5), sillM = (float)o.Number("sillM", 1),
                };
                foreach (var p in (o.Array("lip") ?? new List<object>()).OfType<List<object>>())
                {
                    var v = p.OfType<GolfMapJsonNumber>().Select(n => (float)n.Value).ToArray();
                    if (v.Length >= 2) f.lip.Add(new Vector2(v[0], v[1]));
                }
                var flow = (o.Array("flow") ?? new List<object>()).OfType<GolfMapJsonNumber>().Select(n => (float)n.Value).ToArray();
                if (flow.Length >= 2) f.flow = new Vector2(flow[0], flow[1]);
                if (!string.IsNullOrEmpty(f.id) && f.lip.Count >= 2 && f.flow.sqrMagnitude > 0) list.Add(f);
            }
            return list;
        }

        static void ApplyProfile(Component spline, Type splineType, UnityEngine.Object profile, Type profileType)
        {
            splineType.GetField("currentProfile").SetValue(spline, profile);
            foreach (var name in new[] { "meshCurve", "minVal", "maxVal", "traingleDensity", "vertsInShape", "uvScale", "uvRotation",
                "flowFlat", "flowWaterfall", "receiveShadows", "shadowCastingMode" })
            {
                var from = profileType.GetField(name);
                var to = splineType.GetField(name);
                if (from != null && to != null) to.SetValue(spline, from.GetValue(profile));
            }
            var curve = (AnimationCurve)splineType.GetField("meshCurve").GetValue(spline);
            var curves = (List<AnimationCurve>)splineType.GetField("controlPointsMeshCurves").GetValue(spline);
            for (int i = 0; i < curves.Count; i++) curves[i] = new AnimationCurve(curve.keys);
            var renderer = spline.GetComponent<MeshRenderer>();
            var material = profileType.GetField("splineMaterial").GetValue(profile) as Material;
            if (renderer != null && material != null) renderer.sharedMaterial = material;
            splineType.GetField("oldProfile").SetValue(spline, profile);
        }

        static UnityEngine.Object FindAsset(string name, Type type)
        {
            return AssetDatabase.FindAssets(name + " t:" + type.Name)
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(p => Path.GetFileNameWithoutExtension(p) == name)
                .Select(p => AssetDatabase.LoadAssetAtPath(p, type))
                .FirstOrDefault(x => x != null);
        }

        static Type FindType(string name)
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => { try { return a.GetType(name, false); } catch { return null; } })
                .FirstOrDefault(t => t != null);
        }
    }
}
