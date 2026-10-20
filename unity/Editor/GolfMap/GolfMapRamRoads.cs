// Unity 2018.2 / C# 6. Roads as NatureManufacture R.A.M. splines lying on the course meshes (test stage).
//
// A path with render=ram has no shape in the SVG (pipeline/gspro.py _is_ram_road): OPCD builds the ground under it
// as if there were no road, and this draws the road on top. It reads a unity-ramroads-v1 file (default the course's
// <prefix>-inner-ramroads.json; plot metres from the inner square's south-west corner, like the creeks export: x east,
// z north) and builds one RamSpline per road under 'GolfMap RAM Roads'.
// - Look: the profile's texture; its alpha edge (not geometry) makes the irregular border, so the ribbon is
//   widthM / bandFraction wide and the texture's opaque band covers the drawn road. look/tint/brightness make a
//   course copy of the profile's material (<course>/RAM Roads/<material> (<look>).mat).
// - Fit: R.A.M.'s own snap (every vertex raycast down onto the Default layer's colliders, R.A.M. adds 0.1 m) with the
//   mesh curve across the ribbon: the opaque band liftM above the ground, the see-through margins ramping down to it, so
//   a rolling ball meets no step at the edge. Both ends fade out over endFadeM by vertex alpha (the shader multiplies
//   its alpha by it), so a R.A.M. road running into an OPCD road melts into it.
// - Physics: a MeshCollider on R.A.M.'s own mesh with the surface's physic material from <course>/Paths/path-surfaces.json
//   (as the path meshes have). It spans the whole ribbon, margins included. It is off while R.A.M. regenerates (the
//   snap would land on it); regenerating from R.A.M.'s inspector with it on lifts the road onto itself, so re-run this.
// - The ground under a road: paint.json's kind 'road' rule (GolfMapVertexPaint) paints the rough black there (no Stix grass).

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
    public static class GolfMapRamRoads
    {
        public const string Format = "unity-ramroads-v1";
        const string RootName = "GolfMap RAM Roads";
        const string NamePrefix = "RAM road ";
        const float RamSnapLiftM = 0.1f;  // RamSpline.GenerateSpline puts a snapped vertex this far above the hit
        const string DefaultPhysics = "Assets/Resources/Physics/GSPconcrete.physicMaterial";

        [BridgeCommand("golfmap.ramroads.build", "Build the course's R.A.M. roads (unity-ramroads-v1, default <prefix>-inner-ramroads.json) under 'GolfMap RAM Roads': one RamSpline per road draped on the course meshes (the opaque band liftM above them, the see-through margins down to the ground), widthM / bandFraction wide so the profile texture's opaque band covers the road, ends faded out over endFadeM, a MeshCollider with the surface's physic material (Paths/path-surfaces.json). Roads no longer in the file are removed. visible=false (and no build) hides or shows the ribbons: only=visible. Marks the scene dirty; save=true saves it.",
            args = "file, profile='Path RamSpline Profile', bandFraction=0.54 (the texture's opaque share across), liftM=0.03, endFadeM=2, triangleDensity=0.25 (edge loops per control-point gap = 1/x), vertsInShape=7, look (with tint: the name of a copy of the profile's material in <course>/RAM Roads/, '<material> (<look>)', made or updated), tint=#rrggbb (_MainRoadColor), brightness (_MainRoadBrightness), collider=true, visible=true, only=build|visible, " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            bool visible = a.Bool("visible", true);
            if (a.String("only") == "visible") return SetVisible(visible);
            var o = new Options
            {
                profile = a.String("profile") ?? "Path RamSpline Profile",
                bandFraction = (float)a.Number("bandFraction", 0.54),
                liftM = (float)a.Number("liftM", 0.03),
                endFadeM = (float)a.Number("endFadeM", 2),
                density = (float)a.Number("triangleDensity", 0.25),
                vertsInShape = (int)a.Number("vertsInShape", 7),
                collider = a.Bool("collider", true),
                visible = visible,
                look = a.String("look"), tint = a.String("tint"),
                brightness = a.Has("brightness") ? (float?)a.Number("brightness", 0) : null,
            };
            if (o.bandFraction <= 0 || o.bandFraction > 1) throw new InvalidOperationException("bandFraction must be in (0, 1].");
            return Build(a.String("file"), o);
        }

        sealed class Options
        {
            public string profile, look, tint;
            public float bandFraction, liftM, endFadeM, density;
            public int vertsInShape;
            public bool collider, visible;
            public float? brightness;
        }

        sealed class Road
        {
            public string id, surface;
            public float widthM;
            public List<Vector2> points = new List<Vector2>();
        }

        static string DefaultFile(GolfMapCourse course) { return GolfMapCourses.ExportFile(course, "inner", "ramroads"); }

        static List<Road> Load(string file)
        {
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            if (doc.String("format") != Format) throw new InvalidOperationException(file + ": format must be " + Format + ".");
            var roads = new List<Road>();
            foreach (var o in (doc.Array("roads") ?? new List<object>()).OfType<GolfMapJsonObject>())
            {
                var r = new Road { id = o.String("id"), surface = o.String("surface") ?? "gravel", widthM = (float)o.Number("widthM", 3) };
                foreach (var p in (o.Array("points") ?? new List<object>()).OfType<List<object>>())
                {
                    var v = p.OfType<GolfMapJsonNumber>().Select(n => (float)n.Value).ToArray();
                    if (v.Length >= 2) r.points.Add(new Vector2(v[0], v[1]));
                }
                if (!string.IsNullOrEmpty(r.id) && r.points.Count >= 2) roads.Add(r);
            }
            return roads;
        }

        // The course's R.A.M. roads as centrelines (plot x, z) and drawn widths, for the vertex paint; empty without an export.
        public static List<KeyValuePair<List<Vector2>, float>> Lines(GolfMapCourse course)
        {
            var file = DefaultFile(course);
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) return new List<KeyValuePair<List<Vector2>, float>>();
            return Load(file).Select(r => new KeyValuePair<List<Vector2>, float>(r.points, r.widthM)).ToList();
        }

        // The profile's material, or (look given) a copy of it in the course's folder with the tint/brightness.
        static Material LookMaterial(string courseFolder, Material from, Options o)
        {
            if (from == null || string.IsNullOrEmpty(o.look)) return from;
            var folder = courseFolder + "RAM Roads";
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(folder.Substring(0, folder.LastIndexOf('/')), "RAM Roads");
            var path = folder + "/" + from.name + " (" + o.look + ").mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(from);
                AssetDatabase.CreateAsset(mat, path);
            }
            else mat.CopyPropertiesFromMaterial(from);  // rebuilt from the profile's material: the args are the spec
            Color c;
            if (!string.IsNullOrEmpty(o.tint))
            {
                if (!ColorUtility.TryParseHtmlString(o.tint, out c)) throw new InvalidOperationException("tint must be #rrggbb: " + o.tint);
                mat.SetColor("_MainRoadColor", c);
            }
            if (o.brightness.HasValue) mat.SetFloat("_MainRoadBrightness", o.brightness.Value);
            EditorUtility.SetDirty(mat);
            AssetDatabase.SaveAssets();
            return mat;
        }

        // surface -> physic material asset path, from the course's path looks spec (what the OPCD path meshes collide with).
        static Dictionary<string, string> SurfacePhysics(string courseFolder)
        {
            var map = new Dictionary<string, string>();
            var spec = courseFolder + "Paths/path-surfaces.json";
            if (!File.Exists(spec)) return map;
            var surfaces = GolfMapJsonDoc.ParseObject(File.ReadAllText(spec)).Object("surfaces");
            if (surfaces == null) return map;
            foreach (var key in surfaces.keys)
            {
                var s = surfaces.Object(key);
                var p = s != null ? s.String("physicMaterial") : null;
                if (!string.IsNullOrEmpty(p)) map[key] = p;
            }
            return map;
        }

        static object SetVisible(bool visible)
        {
            var root = EditorSceneManager.GetActiveScene().GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
            if (root == null) throw new InvalidOperationException("No '" + RootName + "' in the scene.");
            int n = 0;
            foreach (var r in root.GetComponentsInChildren<MeshRenderer>(true)) { r.enabled = visible; n++; }
            EditorSceneManager.MarkSceneDirty(root.scene);
            return new Dictionary<string, object> { { "renderers", n }, { "visible", visible } };
        }

        static object Build(string file, Options o)
        {
            var course = GolfMapCourses.Require();
            file = string.IsNullOrEmpty(file) ? DefaultFile(course) : file;
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) throw new InvalidOperationException("No R.A.M. roads export at " + (file ?? "(the course has no export folder)") + ".");
            var roads = Load(file);
            var splineType = FindType("RamSpline");
            var profileType = FindType("SplineProfile");
            if (splineType == null || profileType == null)
                throw new InvalidOperationException("NatureManufacture R.A.M. (RamSpline, SplineProfile) is not in this project.");
            var profile = AssetDatabase.FindAssets("t:" + profileType.Name)
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(p => Path.GetFileNameWithoutExtension(p) == o.profile)
                .Select(p => AssetDatabase.LoadAssetAtPath(p, profileType)).FirstOrDefault(p => p != null);
            if (profile == null) throw new InvalidOperationException("No R.A.M. profile named '" + o.profile + "' in the project.");
            var material = profileType.GetField("splineMaterial").GetValue(profile) as Material;
            // The folder once, up front: AssetDatabase.SaveAssets (the look's material) can leave the course
            // object without an asset path for the rest of the call ("The course is not a saved asset").
            var courseFolder = GolfMapCourses.Folder(course);
            var physics = SurfacePhysics(courseFolder);
            var worn = LookMaterial(courseFolder, material, o);

            var scene = EditorSceneManager.GetActiveScene();
            var root = scene.GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("R.A.M. roads");
            if (root == null)
            {
                root = new GameObject(RootName);
                Undo.RegisterCreatedObjectUndo(root, "R.A.M. roads");
            }
            var keep = new HashSet<string>(roads.Select(r => NamePrefix + r.id));
            var removed = new List<string>();
            foreach (var t in root.transform.Cast<Transform>().Where(t => !keep.Contains(t.name)).ToList())
            {
                removed.Add(t.name);
                Undo.DestroyObjectImmediate(t.gameObject);
            }
            // Margins: the see-through share of the ribbon on each side, where the mesh ramps down to the ground.
            float margin = (1f - o.bandFraction) / 2f;
            var across = margin > 0.001f
                ? new AnimationCurve(new Keyframe(0, -RamSnapLiftM), new Keyframe(margin, o.liftM - RamSnapLiftM),
                                     new Keyframe(1 - margin, o.liftM - RamSnapLiftM), new Keyframe(1, -RamSnapLiftM))
                : new AnimationCurve(new Keyframe(0, o.liftM - RamSnapLiftM), new Keyframe(1, o.liftM - RamSnapLiftM));
            for (int k = 0; k < across.length; k++) { AnimationUtility.SetKeyLeftTangentMode(across, k, AnimationUtility.TangentMode.Linear); AnimationUtility.SetKeyRightTangentMode(across, k, AnimationUtility.TangentMode.Linear); }

            var rows = new List<object>();
            foreach (var road in roads)
            {
                float ribbonM = road.widthM / o.bandFraction;
                var old = root.transform.Find(NamePrefix + road.id);
                if (old != null) Undo.DestroyObjectImmediate(old.gameObject);
                var spline = (Component)splineType.GetMethod("CreateSpline", BindingFlags.Public | BindingFlags.Static)
                    .Invoke(null, new object[] { material, null });
                var go = spline.gameObject;
                go.name = NamePrefix + road.id;
                go.transform.SetParent(root.transform, false);
                go.transform.localPosition = Vector3.zero;
                Undo.RegisterCreatedObjectUndo(go, "R.A.M. roads");

                // Control points on the ground (the course meshes' colliders); R.A.M. snaps the vertices between them.
                int missed = 0;
                var addPoint = splineType.GetMethod("AddPoint", new[] { typeof(Vector4) });
                foreach (var v in road.points)
                {
                    RaycastHit hit;
                    float y = 0;
                    if (Physics.Raycast(new Vector3(v.x, 500, v.y), Vector3.down, out hit, 1000, 1)) y = hit.point.y;
                    else missed++;
                    addPoint.Invoke(spline, new object[] { new Vector4(v.x, y, v.y, ribbonM) });
                }
                ApplyProfile(spline, splineType, profile, profileType);
                splineType.GetField("width").SetValue(spline, ribbonM);
                splineType.GetField("vertsInShape").SetValue(spline, o.vertsInShape);
                splineType.GetField("traingleDensity").SetValue(spline, o.density);
                splineType.GetField("snapToTerrain").SetValue(spline, true);
                splineType.GetField("snapMask").SetValue(spline, (LayerMask)1);
                splineType.GetField("normalFromRaycast").SetValue(spline, true);
                var snaps = (List<float>)splineType.GetField("controlPointsSnap").GetValue(spline);
                for (int i = 0; i < snaps.Count; i++) snaps[i] = 1;
                splineType.GetField("meshCurve").SetValue(spline, new AnimationCurve(across.keys));
                var curves = (List<AnimationCurve>)splineType.GetField("controlPointsMeshCurves").GetValue(spline);
                for (int i = 0; i < curves.Count; i++) curves[i] = new AnimationCurve(across.keys);
                splineType.GetMethod("GenerateSpline").Invoke(spline, new object[] { null });
                int faded = FadeEnds(spline, splineType, o.endFadeM);

                var renderer = go.GetComponent<MeshRenderer>();
                if (worn != null) renderer.sharedMaterial = worn;
                renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                renderer.receiveShadows = true;
                renderer.enabled = o.visible;
                var mesh = go.GetComponent<MeshFilter>().sharedMesh;
                string physicsPath = null;
                if (o.collider)
                {
                    string p;
                    physicsPath = physics.TryGetValue(road.surface, out p) ? p : DefaultPhysics;
                    var collider = Undo.AddComponent<MeshCollider>(go);
                    collider.sharedMesh = mesh;
                    collider.sharedMaterial = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(physicsPath);
                }
                EditorUtility.SetDirty(spline);
                rows.Add(new Dictionary<string, object>
                {
                    { "id", road.id }, { "surface", road.surface }, { "points", road.points.Count }, { "pointsOffGround", missed },
                    { "ribbonM", Math.Round(ribbonM, 2) }, { "endFadeVertices", faded },
                    { "vertices", mesh != null ? mesh.vertexCount : 0 }, { "triangles", mesh != null ? mesh.triangles.Length / 3 : 0 },
                    { "material", renderer.sharedMaterial != null ? renderer.sharedMaterial.name : null }, { "physics", physicsPath },
                });
            }
            EditorSceneManager.MarkSceneDirty(scene);
            return new Dictionary<string, object> { { "file", file }, { "profile", o.profile }, { "roads", rows }, { "removed", removed } };
        }

        // R.A.M.'s vertex colour alpha: 1 along the road, easing to 0 over the last fadeM at each end (by each edge loop's
        // centre along the line). R.A.M. keeps the colours of a spline whose vertex count is unchanged; the spline is
        // regenerated with them. The number of vertices made see-through at all.
        static int FadeEnds(Component spline, Type splineType, float fadeM)
        {
            if (fadeM <= 0) return 0;
            var mesh = spline.GetComponent<MeshFilter>().sharedMesh;
            var field = splineType.GetField("colors");
            var colors = field.GetValue(spline) as Color[];
            int per = (int)splineType.GetField("vertsInShape").GetValue(spline);
            if (mesh == null || colors == null || colors.Length != mesh.vertexCount || per <= 0 || mesh.vertexCount % per != 0) return 0;
            var vertices = mesh.vertices;
            int loops = vertices.Length / per;
            var cum = new float[loops];
            Vector2 prev = Vector2.zero;
            for (int l = 0; l < loops; l++)
            {
                Vector3 sum = Vector3.zero;
                for (int j = 0; j < per; j++) sum += vertices[l * per + j];
                var c = new Vector2(sum.x / per, sum.z / per);
                if (l > 0) cum[l] = cum[l - 1] + Vector2.Distance(prev, c);
                prev = c;
            }
            float total = cum[loops - 1];
            int faded = 0;
            for (int i = 0; i < vertices.Length; i++)
            {
                float d = Mathf.Min(cum[i / per], total - cum[i / per]);
                float a = Mathf.SmoothStep(0f, 1f, Mathf.Clamp01(d / fadeM));
                if (a < 1f) faded++;
                colors[i].a = a;
            }
            field.SetValue(spline, colors);
            splineType.GetMethod("GenerateSpline").Invoke(spline, new object[] { null });
            return faded;
        }

        // RamSplineEditor.ResetToProfile, by reflection (as GolfMapCreeks.ApplyProfile).
        static readonly string[] ProfileFields =
        {
            "meshCurve", "minVal", "maxVal", "traingleDensity", "vertsInShape", "uvScale", "uvRotation",
            "flowFlat", "flowWaterfall", "terrainCarve", "distSmooth", "distSmoothStart", "terrainPaintCarve",
            "receiveShadows", "shadowCastingMode",
        };

        static void ApplyProfile(Component spline, Type splineType, UnityEngine.Object profile, Type profileType)
        {
            splineType.GetField("currentProfile").SetValue(spline, profile);
            foreach (var f in ProfileFields)
            {
                var from = profileType.GetField(f);
                var to = splineType.GetField(f);
                if (from != null && to != null) to.SetValue(spline, from.GetValue(profile));
            }
            var renderer = spline.GetComponent<MeshRenderer>();
            var material = profileType.GetField("splineMaterial").GetValue(profile) as Material;
            if (renderer != null && material != null) renderer.sharedMaterial = material;
            splineType.GetField("oldProfile").SetValue(spline, profile);
        }

        static Type FindType(string name)
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => { try { return a.GetType(name, false); } catch { return null; } })
                .FirstOrDefault(t => t != null);
        }
    }
}
