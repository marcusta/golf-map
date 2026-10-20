// Unity 2018.2 / C# 6. Roads as NatureManufacture R.A.M. splines lying on the course meshes.
//
// A path with render=ram has no shape in the SVG (pipeline/gspro.py _is_ram_road): OPCD builds the ground under it
// as if there were no road, and this draws the road on top. It reads a unity-ramroads-v1 file (default the course's
// <prefix>-inner-ramroads.json; plot metres from the inner square's south-west corner, like the creeks export: x east,
// z north) and builds one RamSpline per road under 'GolfMap RAM Roads'. unity/README.md "R.A.M. roads".
// - Look: per surface from the looks spec <course>/RAM Roads/ram-roads.json (golfmap-ramroads-looks-v1, written with
//   defaults on first run): the profile, its texture's opaque share across (bandFraction; the alpha edge, not
//   geometry, makes the irregular border, so the ribbon is widthM / bandFraction wide), tint/brightness, lift, end
//   fade, mesh density. One material copy per surface, <course>/RAM Roads/<material> (<surface>).mat, rebuilt from the
//   profile's material on every run: the spec is the truth, hand edits to the copies are lost.
// - Fit: R.A.M.'s own snap (every vertex raycast down onto the Default layer's colliders, R.A.M. adds 0.1 m) with the
//   mesh curve across the ribbon: the opaque band liftM above the ground, the see-through margins ramping down to it, so
//   a rolling ball meets no step at the edge. Both ends fade out over endFadeM by vertex alpha (the shader multiplies
//   its alpha by it), so a R.A.M. road running into an OPCD road melts into it.
// - Physics: a MeshCollider on R.A.M.'s own mesh with the surface's physic material from <course>/Paths/path-surfaces.json
//   (as the path meshes have). It spans the whole ribbon, margins included. Every R.A.M. road's collider is off while
//   R.A.M. regenerates (the snap would land on it); regenerating from R.A.M.'s inspector with it on lifts the road
//   onto itself, so re-run the build instead.
// - Colour: golfmap.ramroads.tint renders the roads top-down and moves each surface's tint/brightness until the road
//   as rendered matches the export's orthoRgb (the road's median sunlit colour in the orthophoto).
// - The ground under a road: paint.json's kind 'road' rule paints the rough black there (no Stix grass).

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
        public const string SpecFormat = "golfmap-ramroads-looks-v1";
        const string SpecFolder = "RAM Roads";
        const string SpecName = "ram-roads.json";
        const string RootName = "GolfMap RAM Roads";
        const string NamePrefix = "RAM road ";
        const float RamSnapLiftM = 0.1f;  // RamSpline.GenerateSpline puts a snapped vertex this far above the hit
        const string DefaultPhysics = "Assets/Resources/Physics/GSPconcrete.physicMaterial";
        const string PathProfile = "Path RamSpline Profile", DirtyRoadProfile = "Dirty Road RamSpline Profile", RoadProfile = "Road Profile";

        // ------------------------------------------------------------ commands

        [BridgeCommand("golfmap.ramroads.build", "Build the course's R.A.M. roads (unity-ramroads-v1, default <prefix>-inner-ramroads.json) under 'GolfMap RAM Roads': one RamSpline per road draped on the course meshes (the opaque band liftM above them, the see-through margins down to the ground), widthM / bandFraction wide so the profile texture's opaque band covers the road, ends faded out over endFadeM, a MeshCollider with the surface's physic material (Paths/path-surfaces.json). Each road wears its surface's look from <course>/RAM Roads/ram-roads.json (written with defaults on first run; fallback 'default'), one material copy per surface '<course>/RAM Roads/<material> (<surface>).mat' rebuilt from the spec every run. Roads no longer in the file are removed. The look args override the spec for this run, for every road. No export at the default path: {skipped}. dryRun lists what would be built. visible=false (and no build) hides or shows the ribbons: only=visible.",
            args = "file, dryRun=false, profile, bandFraction, liftM, endFadeM, triangleDensity, vertsInShape, tint=#rrggbb, brightness (overrides of the spec's look for every road, this run only), collider=true, visible=true, only=build|visible, " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            bool visible = a.Bool("visible", true);
            if (a.String("only") == "visible") return SetVisible(visible);
            var ov = new Overrides
            {
                profile = a.String("profile"),
                tint = a.String("tint"),
                bandFraction = a.Has("bandFraction") ? (float?)a.Number("bandFraction", 0) : null,
                liftM = a.Has("liftM") ? (float?)a.Number("liftM", 0) : null,
                endFadeM = a.Has("endFadeM") ? (float?)a.Number("endFadeM", 0) : null,
                density = a.Has("triangleDensity") ? (float?)a.Number("triangleDensity", 0) : null,
                vertsInShape = a.Has("vertsInShape") ? (int?)a.Int("vertsInShape", 0) : null,
                brightness = a.Has("brightness") ? (float?)a.Number("brightness", 0) : null,
            };
            return Run(a.String("file"), ov, a.Bool("collider", true), visible, a.Bool("dryRun", false));
        }

        // Course refresh step (GolfMapCourseRefresh, by reflection): every road of the course's default export with the
        // spec's looks. No export: { skipped }. dryRun changes nothing and reports what would be built and removed.
        public static object Build(bool dryRun)
        {
            return Run(null, null, true, true, dryRun);
        }

        [BridgeCommand("golfmap.ramroads.tint", "Match each surface's R.A.M. road colour, as rendered, to the export's surfaces.<surface>.orthoRgb (the median sunlit sRGB of the roads in the orthophoto): top-down renders (a narrow camera straight down, ~viewM square, with the main camera's settings and post-processing, the scene's lighting, VSP off) over a few points along the surface's roads; the road's core where an ID render (the roads in flat magenta) sees the road, sunlit, gives the per-channel median colour; the linear-light gain to the target moves the surface's tint (max channel 1) and brightness; repeated until within toleranceLevels per channel. Updates ram-roads.json and rebuilds the surface materials unless dryRun (then nothing is changed). Needs the roads built (golfmap.ramroads.build).",
            args = "file, surface (one only), dryRun=false, iterations=3, toleranceLevels=3, points=4 (capture points per surface), viewM=15, pixels=384, debug=false (writes the captures with the mask to Temp/GolfMapRamRoads/), " + GolfMapSceneSave.Arg)]
        static object TintCommand(BridgeArgs a)
        {
            return Tint(a.String("file"), a.String("surface"), a.Bool("dryRun", false), Math.Max(0, a.Int("iterations", 3)),
                (int)a.Number("toleranceLevels", 3), Math.Max(1, a.Int("points", 4)), Mathf.Clamp((float)a.Number("viewM", 15), 4f, 60f),
                Mathf.Clamp(a.Int("pixels", 384), 64, 1024), a.Bool("debug", false));
        }

        // ------------------------------------------------------------ export and spec

        sealed class Road
        {
            public string id, surface;
            public float widthM;
            public List<Vector2> points = new List<Vector2>();
        }

        sealed class Look
        {
            public string profile, tint;
            public float bandFraction, liftM, endFadeM, density;
            public int vertsInShape;
            public float? brightness;
            public Look Clone() { return (Look)MemberwiseClone(); }
        }

        sealed class Overrides
        {
            public string profile, tint;
            public float? bandFraction, liftM, endFadeM, density, brightness;
            public int? vertsInShape;
            public Look Apply(Look l)
            {
                l = l.Clone();
                if (!string.IsNullOrEmpty(profile)) l.profile = profile;
                if (!string.IsNullOrEmpty(tint)) l.tint = tint;
                if (bandFraction.HasValue) l.bandFraction = bandFraction.Value;
                if (liftM.HasValue) l.liftM = liftM.Value;
                if (endFadeM.HasValue) l.endFadeM = endFadeM.Value;
                if (density.HasValue) l.density = density.Value;
                if (vertsInShape.HasValue) l.vertsInShape = vertsInShape.Value;
                if (brightness.HasValue) l.brightness = brightness.Value;
                return l;
            }
        }

        sealed class Spec
        {
            public string path;
            public GolfMapJsonObject root;
            public bool created;
            public Dictionary<string, Look> looks = new Dictionary<string, Look>();

            // The surface's own look key, else "default".
            public string KeyFor(string surface) { return surface != null && looks.ContainsKey(surface) ? surface : "default"; }
            public Look LookFor(string key) { Look l; return looks.TryGetValue(key, out l) ? l.Clone() : BuiltIn(); }
        }

        static Look BuiltIn()
        {
            return new Look { profile = PathProfile, bandFraction = 0.54f, liftM = 0.03f, endFadeM = 2f, vertsInShape = 7, density = 0.25f };
        }

        static string DefaultFile(GolfMapCourse course) { return GolfMapCourses.ExportFile(course, "inner", "ramroads"); }

        static List<Road> Load(GolfMapJsonObject doc, string file)
        {
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

        static List<Road> Load(string file) { return Load(GolfMapJsonDoc.ParseObject(File.ReadAllText(file)), file); }

        // The course's R.A.M. roads as centrelines (plot x, z) and drawn widths, for the vertex paint; empty without an export.
        public static List<KeyValuePair<List<Vector2>, float>> Lines(GolfMapCourse course)
        {
            var file = DefaultFile(course);
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) return new List<KeyValuePair<List<Vector2>, float>>();
            return Load(file).Select(r => new KeyValuePair<List<Vector2>, float>(r.points, r.widthM)).ToList();
        }

        static Dictionary<string, object> LookJson(string profile, double bandFraction, string tint, double? brightness)
        {
            return new Dictionary<string, object>
            {
                { "profile", profile }, { "bandFraction", bandFraction }, { "tint", tint }, { "brightness", brightness },
                { "liftM", 0.03 }, { "endFadeM", 2 }, { "vertsInShape", 7 }, { "triangleDensity", 0.25 },
            };
        }

        static GolfMapJsonObject DefaultSpec()
        {
            var text = GolfMapJson.Serialize(new Dictionary<string, object>
            {
                { "format", SpecFormat },
                { "notes", new List<object>
                    {
                        "How the R.A.M. roads (paths with render=ram, <prefix>-inner-ramroads.json) are drawn: golfmap.ramroads.build gives each road the look of its surface, else 'default'. unity/README.md \"R.A.M. roads\". Edit and run the build again.",
                        "Keys = the path surfaces (gravel, dirt, gravel-track, asphalt, concrete, paving) plus 'default'. A surface added here gets its own look and material.",
                        "profile = the name of a R.A.M. SplineProfile asset (its mesh settings and material). 'Path RamSpline Profile' = M_Path, one worn strip; 'Dirty Road RamSpline Profile' = M_Road, two wheel tracks with see-through grass between; 'Road Profile' = R.A.M.'s own asphalt with lines (a Standard opaque material, texture road_01_A without alpha, so it has no see-through edge: bandFraction 1).",
                        "bandFraction = the share of the texture's width that is opaque (0-1]: the ribbon is widthM / bandFraction wide, so the opaque band covers the drawn road and the see-through margins lie beyond it. M_Path 0.54, M_Road ~0.78 (its outer edges at 11 % and 89 %).",
                        "tint = #rrggbb, brightness = number: the material's _MainRoadColor and _MainRoadBrightness (on a Standard material: _Color, multiplied by brightness in linear light). null = the profile material's own. golfmap.ramroads.tint sets both from the orthophoto (tint with its largest channel at ff, the rest in brightness).",
                        "liftM = how far the opaque band lies above the ground (the margins ramp down to it); endFadeM = metres over which both ends fade out by vertex alpha; vertsInShape = vertices across the ribbon; triangleDensity = edge loops per control-point gap = 1/x.",
                        "Materials: one copy per surface, <course>/RAM Roads/<material> (<surface>).mat, rebuilt from the profile's material on every build. This file is the truth: edits made to the copies by hand are lost on the next build.",
                    }
                },
                { "surfaces", new Dictionary<string, object>
                    {
                        // Omberg road 38, 2026-10-20: matched as rendered top-down to the ortho (199,180,170).
                        { "gravel", LookJson(PathProfile, 0.54, "#f3ebff", 0.563) },
                        { "dirt", LookJson(PathProfile, 0.54, null, null) },
                        { "gravel-track", LookJson(DirtyRoadProfile, 0.78, null, null) },
                        { "asphalt", LookJson(RoadProfile, 1.0, null, null) },
                        { "concrete", LookJson(RoadProfile, 1.0, null, null) },
                        { "paving", LookJson(RoadProfile, 1.0, null, null) },
                        { "default", LookJson(PathProfile, 0.54, null, null) },
                    }
                },
            });
            return GolfMapJsonDoc.ParseObject(text);
        }

        static Look ParseLook(GolfMapJsonObject o)
        {
            var l = BuiltIn();
            if (o.String("profile") != null) l.profile = o.String("profile");
            if (o.Has("bandFraction")) l.bandFraction = (float)o.Number("bandFraction", l.bandFraction);
            l.tint = o.String("tint");
            l.brightness = o["brightness"] is GolfMapJsonNumber ? (float?)o.Number("brightness") : null;
            if (o.Has("liftM")) l.liftM = (float)o.Number("liftM", l.liftM);
            if (o.Has("endFadeM")) l.endFadeM = (float)o.Number("endFadeM", l.endFadeM);
            if (o.Has("vertsInShape")) l.vertsInShape = (int)o.Number("vertsInShape", l.vertsInShape);
            if (o.Has("triangleDensity")) l.density = (float)o.Number("triangleDensity", l.density);
            return l;
        }

        // The looks spec; written with the defaults when there is none (not on a dry run).
        static Spec ReadSpec(string courseFolder, bool dryRun)
        {
            var spec = new Spec { path = courseFolder + SpecFolder + "/" + SpecName };
            spec.root = File.Exists(spec.path) ? GolfMapJsonDoc.ParseObject(File.ReadAllText(spec.path)) : null;
            if (spec.root == null)
            {
                spec.root = DefaultSpec();
                spec.created = true;
                if (!dryRun) WriteSpec(spec, courseFolder);
            }
            if (spec.root.String("format") != SpecFormat) throw new BridgeError(spec.path + " is not a " + SpecFormat + " file.");
            var surfaces = spec.root.Object("surfaces");
            if (surfaces == null) throw new BridgeError(spec.path + " has no 'surfaces'.");
            foreach (var key in surfaces.keys)
            {
                var o = surfaces.Object(key);
                if (o != null) spec.looks[key] = ParseLook(o);
            }
            return spec;
        }

        static void WriteSpec(Spec spec, string courseFolder)
        {
            EnsureFolder(courseFolder);
            File.WriteAllText(spec.path, GolfMapJsonDoc.Write(spec.root));
            AssetDatabase.ImportAsset(spec.path);
        }

        static void EnsureFolder(string courseFolder)
        {
            var folder = courseFolder + SpecFolder;
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), SpecFolder);
        }

        // ------------------------------------------------------------ profiles and materials

        static Type FindType(string name)
        {
            return AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => { try { return a.GetType(name, false); } catch { return null; } })
                .FirstOrDefault(t => t != null);
        }

        static UnityEngine.Object FindProfile(Type profileType, string name, Dictionary<string, UnityEngine.Object> cache)
        {
            UnityEngine.Object p;
            if (cache.TryGetValue(name, out p)) return p;
            p = AssetDatabase.FindAssets("t:" + profileType.Name)
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(x => Path.GetFileNameWithoutExtension(x) == name)
                .Select(x => AssetDatabase.LoadAssetAtPath(x, profileType)).FirstOrDefault(x => x != null);
            cache[name] = p;
            return p;
        }

        static Material ProfileMaterial(UnityEngine.Object profile, Type profileType)
        {
            return profileType.GetField("splineMaterial").GetValue(profile) as Material;
        }

        static string CopyPath(string courseFolder, Material from, string key)
        {
            return courseFolder + SpecFolder + "/" + from.name + " (" + key + ").mat";
        }

        static Color ParseTint(string tint)
        {
            Color c;
            if (!ColorUtility.TryParseHtmlString(tint, out c)) throw new BridgeError("tint must be #rrggbb: " + tint);
            return c;
        }

        // tint/brightness onto a material built from the profile's: R.A.M.'s road shaders' _MainRoadColor and
        // _MainRoadBrightness, or a Standard material's _Color (times brightness in linear light).
        static void ApplyKnobs(Material m, Look look)
        {
            if (m.HasProperty("_MainRoadColor"))
            {
                if (!string.IsNullOrEmpty(look.tint)) m.SetColor("_MainRoadColor", ParseTint(look.tint));
                if (look.brightness.HasValue && m.HasProperty("_MainRoadBrightness")) m.SetFloat("_MainRoadBrightness", look.brightness.Value);
            }
            else if (m.HasProperty("_Color") && (!string.IsNullOrEmpty(look.tint) || look.brightness.HasValue))
            {
                var c = !string.IsNullOrEmpty(look.tint) ? ParseTint(look.tint) : m.GetColor("_Color");
                float b = look.brightness ?? 1f;
                var l = c.linear;
                m.SetColor("_Color", new Color(l.r * b, l.g * b, l.b * b, c.a).gamma);
            }
        }

        // The colour factor the look multiplies the texture by, in linear light (tint.linear x brightness).
        static Vector3 Factor(Material from, Look look)
        {
            bool road = from.HasProperty("_MainRoadColor");
            var c = !string.IsNullOrEmpty(look.tint) ? ParseTint(look.tint) : from.GetColor(road ? "_MainRoadColor" : "_Color");
            float b = look.brightness ?? (road && from.HasProperty("_MainRoadBrightness") ? from.GetFloat("_MainRoadBrightness") : 1f);
            var l = c.linear;
            return new Vector3(l.r * b, l.g * b, l.b * b);
        }

        static void SetFactor(Look look, Vector3 f)
        {
            float b = Mathf.Max(f.x, f.y, f.z, 1e-4f);
            var t = new Color(f.x / b, f.y / b, f.z / b, 1f).gamma;
            look.tint = "#" + ColorUtility.ToHtmlStringRGB(t).ToLowerInvariant();
            look.brightness = (float)Math.Round(b, 3);
        }

        // The surface's material copy, made or rebuilt from the profile's material with the look's knobs.
        static Material SurfaceMaterial(string courseFolder, Material from, string key, Look look)
        {
            EnsureFolder(courseFolder);
            var path = CopyPath(courseFolder, from, key);
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(from);
                ApplyKnobs(mat, look);
                AssetDatabase.CreateAsset(mat, path);
            }
            else
            {
                if (mat.shader != from.shader) mat.shader = from.shader;
                mat.CopyPropertiesFromMaterial(from);  // the spec is the truth: hand edits to the copy do not survive
                ApplyKnobs(mat, look);
            }
            EditorUtility.SetDirty(mat);
            return mat;
        }

        // surface -> physic material asset path, from the course's path looks spec (what the OPCD path meshes collide with).
        internal static Dictionary<string, string> SurfacePhysics(string courseFolder)
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

        // ------------------------------------------------------------ build

        static GameObject Root()
        {
            return EditorSceneManager.GetActiveScene().GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
        }

        static object SetVisible(bool visible)
        {
            var root = Root();
            if (root == null) throw new InvalidOperationException("No '" + RootName + "' in the scene.");
            int n = 0;
            foreach (var r in root.GetComponentsInChildren<MeshRenderer>(true)) { r.enabled = visible; n++; }
            EditorSceneManager.MarkSceneDirty(root.scene);
            return new Dictionary<string, object> { { "renderers", n }, { "visible", visible } };
        }

        static object Run(string file, Overrides ov, bool collider, bool visible, bool dryRun)
        {
            // Course folder and export path once, up front: AssetDatabase.SaveAssets / CreateAsset can leave the course
            // object without an asset path for the rest of the call ("The course is not a saved asset").
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);
            bool explicitFile = !string.IsNullOrEmpty(file);
            if (!explicitFile) file = DefaultFile(course);
            if (string.IsNullOrEmpty(file) || !File.Exists(file))
            {
                if (explicitFile) throw new InvalidOperationException("No R.A.M. roads export at " + file + ".");
                return new Dictionary<string, object> { { "skipped", "no " + (file ?? "export folder for the course") }, { "dryRun", dryRun } };
            }
            var roads = Load(file);
            var splineType = FindType("RamSpline");
            var profileType = FindType("SplineProfile");
            if (splineType == null || profileType == null)
                throw new InvalidOperationException("NatureManufacture R.A.M. (RamSpline, SplineProfile) is not in this project.");
            var spec = ReadSpec(courseFolder, dryRun);

            // Every road's look and profile, checked before anything changes.
            var profiles = new Dictionary<string, UnityEngine.Object>();
            var keys = new List<string>();
            var looks = new List<Look>();
            var missing = new List<string>();
            foreach (var road in roads)
            {
                var key = spec.KeyFor(road.surface);
                var look = spec.LookFor(key);
                if (ov != null) look = ov.Apply(look);
                if (look.bandFraction <= 0 || look.bandFraction > 1) throw new BridgeError(key + ": bandFraction must be in (0, 1].");
                if (FindProfile(profileType, look.profile, profiles) == null && !missing.Contains(look.profile)) missing.Add(look.profile);
                keys.Add(key);
                looks.Add(look);
            }
            var root = Root();
            var keepNames = new HashSet<string>(roads.Select(r => NamePrefix + r.id));
            var toRemove = root == null ? new List<string>() : root.transform.Cast<Transform>().Where(t => !keepNames.Contains(t.name)).Select(t => t.name).ToList();

            if (dryRun)
            {
                var plan = new List<object>();
                for (int i = 0; i < roads.Count; i++)
                {
                    var p = profiles[looks[i].profile];
                    var m = p != null ? ProfileMaterial(p, profileType) : null;
                    plan.Add(new Dictionary<string, object>
                    {
                        { "id", roads[i].id }, { "surface", roads[i].surface }, { "look", keys[i] }, { "profile", looks[i].profile },
                        { "material", m != null ? CopyPath(courseFolder, m, keys[i]) : null },
                        { "tint", looks[i].tint }, { "brightness", looks[i].brightness },
                        { "ribbonM", Math.Round(roads[i].widthM / looks[i].bandFraction, 2) }, { "points", roads[i].points.Count },
                    });
                }
                return new Dictionary<string, object>
                {
                    { "dryRun", true }, { "file", file }, { "spec", spec.path }, { "specWouldBeWritten", spec.created },
                    { "roads", plan }, { "wouldRemove", toRemove }, { "missingProfiles", missing },
                };
            }
            if (missing.Count > 0) throw new BridgeError("No R.A.M. profile named " + string.Join(", ", missing.Select(m => "'" + m + "'").ToArray()) + " in the project (" + spec.path + ").");

            var physics = SurfacePhysics(courseFolder);
            var materials = new Dictionary<string, Material>();
            var scene = EditorSceneManager.GetActiveScene();
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("R.A.M. roads");
            if (root == null)
            {
                root = new GameObject(RootName);
                Undo.RegisterCreatedObjectUndo(root, "R.A.M. roads");
            }
            foreach (var t in root.transform.Cast<Transform>().Where(t => !keepNames.Contains(t.name)).ToList())
                Undo.DestroyObjectImmediate(t.gameObject);

            // No R.A.M. road collider may be on while R.A.M. snaps (GenerateSpline): the vertices would land on it.
            var collidersOff = root.GetComponentsInChildren<MeshCollider>(true).Where(c => c.enabled).ToList();
            var rows = new List<object>();
            try
            {
                foreach (var c in collidersOff) c.enabled = false;
                for (int i = 0; i < roads.Count; i++)
                {
                    var road = roads[i];
                    var look = looks[i];
                    var profile = profiles[look.profile];
                    var from = ProfileMaterial(profile, profileType);
                    Material worn = null;
                    if (from != null)
                    {
                        var mkey = keys[i] + "|" + from.name;
                        if (!materials.TryGetValue(mkey, out worn)) materials[mkey] = worn = SurfaceMaterial(courseFolder, from, keys[i], look);
                    }

                    float ribbonM = road.widthM / look.bandFraction;
                    // Margins: the see-through share of the ribbon on each side, where the mesh ramps down to the ground.
                    float margin = (1f - look.bandFraction) / 2f;
                    var across = margin > 0.001f
                        ? new AnimationCurve(new Keyframe(0, -RamSnapLiftM), new Keyframe(margin, look.liftM - RamSnapLiftM),
                                             new Keyframe(1 - margin, look.liftM - RamSnapLiftM), new Keyframe(1, -RamSnapLiftM))
                        : new AnimationCurve(new Keyframe(0, look.liftM - RamSnapLiftM), new Keyframe(1, look.liftM - RamSnapLiftM));
                    for (int k = 0; k < across.length; k++) { AnimationUtility.SetKeyLeftTangentMode(across, k, AnimationUtility.TangentMode.Linear); AnimationUtility.SetKeyRightTangentMode(across, k, AnimationUtility.TangentMode.Linear); }

                    var old = root.transform.Find(NamePrefix + road.id);
                    if (old != null) Undo.DestroyObjectImmediate(old.gameObject);
                    var spline = (Component)splineType.GetMethod("CreateSpline", BindingFlags.Public | BindingFlags.Static)
                        .Invoke(null, new object[] { from, null });
                    var go = spline.gameObject;
                    go.name = NamePrefix + road.id;
                    go.transform.SetParent(root.transform, false);
                    go.transform.localPosition = Vector3.zero;
                    Undo.RegisterCreatedObjectUndo(go, "R.A.M. roads");
                    var own = go.GetComponent<MeshCollider>();   // none on a new spline; off if R.A.M. ever adds one
                    if (own != null && own.enabled) { own.enabled = false; collidersOff.Add(own); }

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
                    splineType.GetField("vertsInShape").SetValue(spline, look.vertsInShape);
                    splineType.GetField("traingleDensity").SetValue(spline, look.density);
                    splineType.GetField("snapToTerrain").SetValue(spline, true);
                    splineType.GetField("snapMask").SetValue(spline, (LayerMask)1);
                    splineType.GetField("normalFromRaycast").SetValue(spline, true);
                    var snaps = (List<float>)splineType.GetField("controlPointsSnap").GetValue(spline);
                    for (int s = 0; s < snaps.Count; s++) snaps[s] = 1;
                    splineType.GetField("meshCurve").SetValue(spline, new AnimationCurve(across.keys));
                    var curves = (List<AnimationCurve>)splineType.GetField("controlPointsMeshCurves").GetValue(spline);
                    for (int s = 0; s < curves.Count; s++) curves[s] = new AnimationCurve(across.keys);
                    splineType.GetMethod("GenerateSpline").Invoke(spline, new object[] { null });
                    int faded = FadeEnds(spline, splineType, look.endFadeM);

                    var renderer = go.GetComponent<MeshRenderer>();
                    if (worn != null) renderer.sharedMaterial = worn;
                    renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                    renderer.receiveShadows = true;
                    renderer.enabled = visible;
                    var mesh = go.GetComponent<MeshFilter>().sharedMesh;
                    string physicsPath = null;
                    if (collider)
                    {
                        string p;
                        physicsPath = physics.TryGetValue(road.surface, out p) ? p : DefaultPhysics;
                        var mc = own != null ? own : Undo.AddComponent<MeshCollider>(go);   // not ??: GetComponent's editor fake null
                        mc.enabled = false;   // on with the rest once every road is built
                        if (!collidersOff.Contains(mc)) collidersOff.Add(mc);
                        mc.sharedMesh = mesh;
                        mc.sharedMaterial = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(physicsPath);
                    }
                    else if (own != null) { collidersOff.Remove(own); Undo.DestroyObjectImmediate(own); }
                    EditorUtility.SetDirty(spline);
                    rows.Add(new Dictionary<string, object>
                    {
                        { "id", road.id }, { "surface", road.surface }, { "look", keys[i] }, { "profile", look.profile },
                        { "tint", look.tint }, { "brightness", look.brightness },
                        { "points", road.points.Count }, { "pointsOffGround", missed },
                        { "ribbonM", Math.Round(ribbonM, 2) }, { "endFadeVertices", faded },
                        { "vertices", mesh != null ? mesh.vertexCount : 0 }, { "triangles", mesh != null ? mesh.triangles.Length / 3 : 0 },
                        { "material", renderer.sharedMaterial != null ? renderer.sharedMaterial.name : null }, { "physics", physicsPath },
                    });
                }
            }
            finally
            {
                foreach (var c in collidersOff) if (c) c.enabled = true;
            }
            AssetDatabase.SaveAssets();
            EditorSceneManager.MarkSceneDirty(scene);
            return new Dictionary<string, object>
            {
                { "file", file }, { "spec", spec.path }, { "specWritten", spec.created }, { "roads", rows }, { "removed", toRemove },
                { "materials", materials.Values.Select(m => AssetDatabase.GetAssetPath(m)).ToList() },
            };
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
            var material = ProfileMaterial(profile, profileType);
            if (renderer != null && material != null) renderer.sharedMaterial = material;
            splineType.GetField("oldProfile").SetValue(spline, profile);
        }

        // ------------------------------------------------------------ tint

        // One top-down view over a road: which pixels count (the road's core, and the road seen there), once.
        sealed class View
        {
            public Vector3 centre;
            public bool[] core, seen;
            public int corePixels;
        }

        sealed class Measure
        {
            public Color32 median;
            public int core, seen, used, shadowed;
        }

        static object Tint(string file, string onlySurface, bool dryRun, int iterations, int tol, int pointCount, float viewM, int px, bool debug)
        {
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);
            if (string.IsNullOrEmpty(file)) file = DefaultFile(course);
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) throw new BridgeError("No R.A.M. roads export at " + (file ?? "(the course has no export folder)") + ".");
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            var roads = Load(doc, file);
            var targets = doc.Object("surfaces");
            var profileType = FindType("SplineProfile");
            if (profileType == null) throw new BridgeError("NatureManufacture R.A.M. is not in this project.");
            var spec = ReadSpec(courseFolder, dryRun);
            var root = Root();
            if (root == null) throw new BridgeError("No '" + RootName + "' in the scene: run golfmap.ramroads.build first.");
            var debugDir = debug ? Path.Combine(Path.GetDirectoryName(Application.dataPath), "Temp/GolfMapRamRoads") : null;
            if (debugDir != null) Directory.CreateDirectory(debugDir);

            var results = new List<object>();
            var skipped = new Dictionary<string, object>();
            var profiles = new Dictionary<string, UnityEngine.Object>();
            bool specChanged = false;
            var changedMaterials = new List<string>();

            // Every R.A.M. road renderer's state, put back whatever happens.
            var allRenderers = root.GetComponentsInChildren<MeshRenderer>(true);
            var wasEnabled = allRenderers.ToDictionary(r => r, r => r.enabled);
            var wasMaterial = allRenderers.ToDictionary(r => r, r => r.sharedMaterial);
            var systems = UnityEngine.Object.FindObjectsOfType<AwesomeTechnologies.VegetationSystem.VegetationSystemPro>().Where(s => s.enabled).ToList();
            var camGo = new GameObject("GolfMap R.A.M. road capture") { hideFlags = HideFlags.HideAndDontSave };
            camGo.SetActive(false);
            var rt = RenderTexture.GetTemporary(px, px, 24, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            var tex = new Texture2D(px, px, TextureFormat.RGB24, false);
            var previousActive = RenderTexture.active;
            var temps = new List<Material>();
            var keep = new Dictionary<MeshRenderer, Material>();   // renderers that keep a new material after a real run
            var effects = new List<string>();
            var idMat = new Material(Shader.Find("Unlit/Color")) { hideFlags = HideFlags.HideAndDontSave, color = Color.magenta };
            temps.Add(idMat);
            try
            {
                foreach (var s in systems) s.enabled = false;
                var cam = camGo.AddComponent<Camera>();
                // As the game camera sees it: the main camera's settings and its post-processing (the components the
                // Scene view copies too, e.g. PostProcessLayer: the profile's exposure and tonemapping roughly double
                // the road's brightness, and the match by hand was judged with them on).
                var main = MainCamera();
                if (main != null)
                {
                    cam.CopyFrom(main);
                    effects = CopyImageEffects(main, camGo);
                }
                camGo.SetActive(true);
                cam.enabled = false;
                // A narrow perspective camera high above, looking straight down (a game camera's projection, which the
                // post-processing's ambient occlusion expects).
                cam.orthographic = false;
                cam.fieldOfView = 2f * Mathf.Atan(viewM / 2f / CaptureHeightM) * Mathf.Rad2Deg;
                cam.aspect = 1f;
                cam.transform.rotation = Quaternion.Euler(90f, 0f, 0f);   // straight down, north up, east right
                cam.nearClipPlane = 1f;
                cam.farClipPlane = CaptureHeightM + 60f;
                cam.clearFlags = CameraClearFlags.Skybox;
                cam.targetTexture = rt;

                var bySurface = roads.GroupBy(r => r.surface).ToList();
                foreach (var group in bySurface)
                {
                    var surface = group.Key;
                    if (!string.IsNullOrEmpty(onlySurface) && surface != onlySurface) continue;
                    var key = spec.KeyFor(surface);
                    if (key != surface) { skipped[surface] = "no look of its own in " + SpecName + " (it wears 'default'); add one to tint it"; continue; }
                    var t = targets != null && targets.Object(surface) != null ? targets.Object(surface).Array("orthoRgb") : null;
                    var tv = t != null ? t.OfType<GolfMapJsonNumber>().Select(n => (float)n.Value).ToArray() : new float[0];
                    if (tv.Length < 3) { skipped[surface] = "no surfaces." + surface + ".orthoRgb in the export"; continue; }
                    var target = new Color32((byte)Mathf.Clamp(Mathf.RoundToInt(tv[0]), 0, 255), (byte)Mathf.Clamp(Mathf.RoundToInt(tv[1]), 0, 255), (byte)Mathf.Clamp(Mathf.RoundToInt(tv[2]), 0, 255), 255);
                    var surfaceRoads = group.Where(r => root.transform.Find(NamePrefix + r.id) != null).ToList();
                    if (surfaceRoads.Count == 0) { skipped[surface] = "none of its roads is built in the scene"; continue; }
                    var renderers = surfaceRoads.Select(r => root.transform.Find(NamePrefix + r.id).GetComponent<MeshRenderer>()).Where(r => r != null).ToList();
                    var look = spec.LookFor(key);
                    var profile = FindProfile(profileType, look.profile, profiles);
                    var from = profile != null ? ProfileMaterial(profile, profileType) : null;
                    if (from == null) { skipped[surface] = "no R.A.M. profile (or material) '" + look.profile + "'"; continue; }

                    // A working copy of the material on the surface's roads while measuring.
                    var work = new Material(from) { hideFlags = HideFlags.HideAndDontSave, name = from.name + " (tint " + surface + ")" };
                    temps.Add(work);
                    ApplyKnobs(work, look);
                    foreach (var r in renderers) { r.sharedMaterial = work; r.enabled = true; }

                    var views = new List<View>();
                    foreach (var c in CapturePoints(surfaceRoads, pointCount, look.endFadeM + viewM / 2f + 1f))
                    {
                        RaycastHit hit;
                        if (!Physics.Raycast(new Vector3(c.x, 500, c.y), Vector3.down, out hit, 1000, 1)) continue;
                        var v = new View { centre = new Vector3(c.x, hit.point.y, c.y) };
                        v.core = CoreMask(surfaceRoads, look.endFadeM + 0.5f, v.centre, viewM, px, out v.corePixels);
                        v.seen = SeenMask(cam, rt, tex, v.centre, renderers, work, idMat, px);
                        views.Add(v);
                    }
                    if (views.Count == 0) { skipped[surface] = "no capture point over the ground"; continue; }

                    var tintBefore = look.tint;
                    var brightnessBefore = look.brightness;
                    var history = new List<object>();
                    var m = MeasureViews(cam, rt, tex, views, px, viewM, debugDir, surface, 0);
                    if (m.used < 200) { skipped[surface] = "only " + m.used +  " road pixels seen (core " + m.core + ", road seen there " + m.seen + ")"; continue; }
                    var before = m;
                    var best = look.Clone();
                    var bestM = m;
                    history.Add(Step(look, m, target));
                    int done = 0;
                    while (done < iterations && Error(m.median, target) > tol)
                    {
                        var f = Factor(from, look);
                        var g = new Vector3(Gain(target.r, m.median.r), Gain(target.g, m.median.g), Gain(target.b, m.median.b));
                        SetFactor(look, Vector3.Scale(f, g));
                        work.CopyPropertiesFromMaterial(from);
                        ApplyKnobs(work, look);
                        m = MeasureViews(cam, rt, tex, views, px, viewM, debugDir, surface, ++done);
                        history.Add(Step(look, m, target));
                        if (Error(m.median, target) < Error(bestM.median, target)) { best = look.Clone(); bestM = m; }
                    }
                    bool within = Error(bestM.median, target) <= tol;
                    bool changed = best.tint != tintBefore || best.brightness != brightnessBefore;
                    if (!dryRun && changed)
                    {
                        var o = spec.root.Object("surfaces").Object(key);
                        o.SetString("tint", best.tint);
                        o.SetNumber("brightness", Math.Round((double)best.brightness.Value, 3));
                        spec.looks[key] = best.Clone();
                        specChanged = true;
                    }
                    if (!dryRun)
                    {
                        var mat = SurfaceMaterial(courseFolder, from, key, spec.LookFor(key));
                        changedMaterials.Add(AssetDatabase.GetAssetPath(mat));
                        foreach (var r in renderers) keep[r] = mat;
                    }
                    results.Add(new Dictionary<string, object>
                    {
                        { "surface", surface }, { "roads", surfaceRoads.Select(r => r.id).ToList() },
                        { "target", Rgb(target) }, { "renderedBefore", Rgb(before.median) }, { "renderedAfter", Rgb(bestM.median) },
                        { "within", within }, { "maxErrorLevels", Error(bestM.median, target) },
                        { "tintBefore", tintBefore }, { "brightnessBefore", brightnessBefore },
                        { "tintAfter", best.tint }, { "brightnessAfter", best.brightness },
                        { "iterations", done }, { "views", views.Count },
                        { "pixels", new Dictionary<string, object> { { "core", bestM.core }, { "seen", bestM.seen }, { "shadowedDropped", bestM.shadowed }, { "used", bestM.used } } },
                        { "history", history },
                    });
                }
            }
            finally
            {
                foreach (var s in systems) if (s) s.enabled = true;
                foreach (var kv in wasEnabled) if (kv.Key) kv.Key.enabled = kv.Value;
                foreach (var kv in wasMaterial) if (kv.Key) kv.Key.sharedMaterial = keep.ContainsKey(kv.Key) ? keep[kv.Key] : kv.Value;
                RenderTexture.active = previousActive;
                RenderTexture.ReleaseTemporary(rt);
                UnityEngine.Object.DestroyImmediate(tex);
                UnityEngine.Object.DestroyImmediate(camGo);
                foreach (var m in temps) if (m) UnityEngine.Object.DestroyImmediate(m);
            }
            if (!dryRun)
            {
                if (specChanged || spec.created) WriteSpec(spec, courseFolder);
                AssetDatabase.SaveAssets();
                if (keep.Any(kv => wasMaterial[kv.Key] != kv.Value)) EditorSceneManager.MarkSceneDirty(root.scene);
            }
            return new Dictionary<string, object>
            {
                { "dryRun", dryRun }, { "file", file }, { "spec", spec.path }, { "specWritten", !dryRun && (specChanged || spec.created) },
                { "toleranceLevels", tol }, { "surfaces", results }, { "skipped", skipped }, { "materials", changedMaterials },
                { "effects", effects }, { "debug", debugDir },
            };
        }

        static Camera MainCamera()
        {
            if (Camera.main != null) return Camera.main;
            return UnityEngine.Object.FindObjectsOfType<Camera>().FirstOrDefault(c => c.gameObject.scene == EditorSceneManager.GetActiveScene());
        }

        // The camera's enabled image effects that the Scene view would copy too ([ImageEffectAllowedInSceneView]), added to
        // the (inactive) capture object with their serialized settings, so they initialise from them when it turns on.
        static List<string> CopyImageEffects(Camera from, GameObject to)
        {
            var names = new List<string>();
            foreach (var c in from.GetComponents<MonoBehaviour>())
            {
                if (c == null || !c.enabled) continue;
                if (c.GetType().GetCustomAttributes(typeof(ImageEffectAllowedInSceneView), true).Length == 0) continue;
                var copy = to.AddComponent(c.GetType());
                EditorUtility.CopySerialized(c, copy);
                names.Add(c.GetType().Name);
            }
            return names;
        }

        const float CaptureHeightM = 40f;

        static object Rgb(Color32 c) { return new List<object> { (int)c.r, (int)c.g, (int)c.b }; }

        static int Error(Color32 a, Color32 b) { return Math.Max(Math.Abs(a.r - b.r), Math.Max(Math.Abs(a.g - b.g), Math.Abs(a.b - b.b))); }

        static float Lin(byte v) { return Mathf.GammaToLinearSpace(Mathf.Max(v, 1) / 255f); }

        // The linear-light gain from rendered to target, held to [0.5, 2] a step.
        static float Gain(byte target, byte rendered) { return Mathf.Clamp(Lin(target) / Lin(rendered), 0.5f, 2f); }

        static object Step(Look look, Measure m, Color32 target)
        {
            return new Dictionary<string, object>
            {
                { "tint", look.tint }, { "brightness", look.brightness }, { "rendered", Rgb(m.median) }, { "errorLevels", Error(m.median, target) }, { "pixels", m.used },
            };
        }

        static Color32[] Render(Camera cam, RenderTexture rt, Texture2D tex, Vector3 centre)
        {
            cam.transform.position = centre + Vector3.up * CaptureHeightM;   // viewM x viewM at the road's height
            cam.Render();
            RenderTexture.active = rt;
            tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
            tex.Apply(false);
            return tex.GetPixels32();
        }

        // Where the surface's roads are seen at all in this view: they are drawn once in flat magenta (unlit, opaque,
        // the post-processing off) and the magenta pixels, eroded by one pixel against edge blending, count. Not a
        // difference against a render without the roads: the course meshes under a road carry the same road from the
        // orthophoto, so the closer the tint gets, the more road pixels equal the ground and drop out (up to half).
        static bool[] SeenMask(Camera cam, RenderTexture rt, Texture2D tex, Vector3 centre, List<MeshRenderer> renderers, Material work, Material id, int px)
        {
            var fx = cam.GetComponents<MonoBehaviour>().Where(b => b.enabled).ToList();
            Color32[] shot;
            try
            {
                foreach (var b in fx) b.enabled = false;
                foreach (var r in renderers) r.sharedMaterial = id;
                shot = Render(cam, rt, tex, centre);
            }
            finally
            {
                foreach (var r in renderers) r.sharedMaterial = work;
                foreach (var b in fx) if (b) b.enabled = true;
            }
            var seen = new bool[px * px];
            for (int i = 0; i < seen.Length; i++)
            {
                var c = shot[i];
                seen[i] = c.r > 150 && c.b > 150 && c.g < Math.Min(c.r, c.b) / 3;
            }
            return Erode(seen, px, 1);
        }

        // Renders each view; a pixel counts inside the road's core where the road is seen (SeenMask) and sunlit (luma at
        // least 0.6 x the median: tree shadows, which the ortho's sunlit median leaves out). Per-channel median.
        static Measure MeasureViews(Camera cam, RenderTexture rt, Texture2D tex, List<View> views, int px, float viewM, string debugDir, string surface, int step)
        {
            var result = new Measure();
            var picked = new List<Color32>();
            for (int vi = 0; vi < views.Count; vi++)
            {
                var v = views[vi];
                var shown = Render(cam, rt, tex, v.centre);
                var changed = v.seen;
                for (int i = 0; i < shown.Length; i++)
                {
                    if (!v.core[i]) continue;
                    result.core++;
                    if (!changed[i]) continue;
                    result.seen++;
                    picked.Add(shown[i]);
                }
                if (debugDir != null)
                {
                    var dbg = new Color32[shown.Length];
                    for (int i = 0; i < dbg.Length; i++)
                        dbg[i] = v.core[i] && changed[i] ? shown[i] : v.core[i] ? new Color32(255, 0, 255, 255) : new Color32((byte)(shown[i].r / 3), (byte)(shown[i].g / 3), (byte)(shown[i].b / 3), 255);
                    var t = new Texture2D(px * 2, px, TextureFormat.RGB24, false);
                    var both = new Color32[px * px * 2];
                    for (int y = 0; y < px; y++)
                        for (int x = 0; x < px; x++) { both[y * px * 2 + x] = shown[y * px + x]; both[y * px * 2 + px + x] = dbg[y * px + x]; }
                    t.SetPixels32(both);
                    t.Apply(false);
                    File.WriteAllBytes(Path.Combine(debugDir, "tint-" + surface + "-step" + step + "-view" + vi + ".png"), t.EncodeToPNG());
                    UnityEngine.Object.DestroyImmediate(t);
                }
            }
            if (picked.Count == 0) return result;
            var luma = picked.Select(c => 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b).ToArray();
            var sorted = luma.OrderBy(x => x).ToArray();
            float floor = 0.6f * sorted[sorted.Length / 2];
            var sunlit = new List<Color32>();
            for (int i = 0; i < picked.Count; i++) if (luma[i] >= floor) sunlit.Add(picked[i]);
            result.shadowed = picked.Count - sunlit.Count;
            result.used = sunlit.Count;
            result.median = new Color32(Median(sunlit, 0), Median(sunlit, 1), Median(sunlit, 2), 255);
            return result;
        }

        static byte Median(List<Color32> cs, int channel)
        {
            var hist = new int[256];
            foreach (var c in cs) hist[channel == 0 ? c.r : channel == 1 ? c.g : c.b]++;
            int half = (cs.Count + 1) / 2, run = 0;
            for (int i = 0; i < 256; i++) { run += hist[i]; if (run >= half) return (byte)i; }
            return 255;
        }

        // Square erosion of radius r (separable min).
        static bool[] Erode(bool[] mask, int n, int r)
        {
            var tmp = new bool[mask.Length];
            var outp = new bool[mask.Length];
            for (int y = 0; y < n; y++)
            {
                int run = 0;
                var row = new int[n];
                for (int x = 0; x < n; x++) { run = mask[y * n + x] ? run + 1 : 0; row[x] = run; }
                for (int x = 0; x < n; x++)
                {
                    int hi = Math.Min(n - 1, x + r), lo = Math.Max(0, x - r);
                    tmp[y * n + x] = row[hi] >= hi - lo + 1;
                }
            }
            for (int x = 0; x < n; x++)
            {
                int run = 0;
                var col = new int[n];
                for (int y = 0; y < n; y++) { run = tmp[y * n + x] ? run + 1 : 0; col[y] = run; }
                for (int y = 0; y < n; y++)
                {
                    int hi = Math.Min(n - 1, y + r), lo = Math.Max(0, y - r);
                    outp[y * n + x] = col[hi] >= hi - lo + 1;
                }
            }
            return outp;
        }

        // Pixels (row 0 = south, as ReadPixels gives them) within 35 % of the road's width of a centreline and a quarter of the view
        // from its centre, the faded ends left out.
        static bool[] CoreMask(List<Road> roads, float trimM, Vector3 centre, float viewM, int px, out int count)
        {
            var segs = new List<KeyValuePair<Vector4, float>>();   // (a.x, a.y, b.x, b.y), radius
            float reach = viewM * 0.75f;
            var c2 = new Vector2(centre.x, centre.z);
            foreach (var r in roads)
            {
                var pts = Trim(r.points, trimM);
                for (int i = 0; i + 1 < pts.Count; i++)
                {
                    var a = pts[i];
                    var b = pts[i + 1];
                    if (DistToSeg(c2, a, b) > reach + r.widthM) continue;
                    segs.Add(new KeyValuePair<Vector4, float>(new Vector4(a.x, a.y, b.x, b.y), 0.35f * r.widthM));
                }
            }
            var mask = new bool[px * px];
            count = 0;
            float cell = viewM / px;
            float x0 = centre.x - viewM / 2f, z0 = centre.z - viewM / 2f;
            float disc = 0.25f * viewM;   // the middle of the view only: the post-processing's vignette darkens its edges
            for (int y = 0; y < px; y++)
                for (int x = 0; x < px; x++)
                {
                    var p = new Vector2(x0 + (x + 0.5f) * cell, z0 + (y + 0.5f) * cell);
                    if ((p - c2).sqrMagnitude > disc * disc) continue;
                    foreach (var s in segs)
                        if (DistToSeg(p, new Vector2(s.Key.x, s.Key.y), new Vector2(s.Key.z, s.Key.w)) <= s.Value) { mask[y * px + x] = true; count++; break; }
                }
            return mask;
        }

        static float DistToSeg(Vector2 p, Vector2 a, Vector2 b)
        {
            var ab = b - a;
            float l2 = ab.sqrMagnitude;
            float t = l2 > 1e-8f ? Mathf.Clamp01(Vector2.Dot(p - a, ab) / l2) : 0f;
            return Vector2.Distance(p, a + ab * t);
        }

        static float Length(List<Vector2> pts)
        {
            float s = 0;
            for (int i = 1; i < pts.Count; i++) s += Vector2.Distance(pts[i - 1], pts[i]);
            return s;
        }

        static Vector2 PointAt(List<Vector2> pts, float d)
        {
            for (int i = 1; i < pts.Count; i++)
            {
                float l = Vector2.Distance(pts[i - 1], pts[i]);
                if (d <= l) return Vector2.Lerp(pts[i - 1], pts[i], l > 0 ? d / l : 0);
                d -= l;
            }
            return pts[pts.Count - 1];
        }

        // The polyline without its first and last trimM metres (empty when shorter than that).
        static List<Vector2> Trim(List<Vector2> pts, float trimM)
        {
            float len = Length(pts);
            var outp = new List<Vector2>();
            if (len <= 2 * trimM) return outp;
            outp.Add(PointAt(pts, trimM));
            float d = 0;
            for (int i = 1; i < pts.Count - 1; i++)
            {
                d += Vector2.Distance(pts[i - 1], pts[i]);
                if (d > trimM && d < len - trimM) outp.Add(pts[i]);
            }
            outp.Add(PointAt(pts, len - trimM));
            return outp;
        }

        // count points spread evenly over the surface's roads, each at least skipM from a road's end (a road too
        // short for that gives its midpoint).
        static List<Vector2> CapturePoints(List<Road> roads, int count, float skipM)
        {
            var spans = roads.Select(r => new KeyValuePair<Road, float>(r, Length(r.points))).ToList();
            float usable = spans.Sum(s => Math.Max(0f, s.Value - 2 * skipM));
            var outp = new List<Vector2>();
            if (usable <= 0)
            {
                foreach (var s in spans.Take(count)) outp.Add(PointAt(s.Key.points, s.Value / 2f));
                return outp;
            }
            for (int i = 0; i < count; i++)
            {
                float at = (i + 0.5f) / count * usable;
                foreach (var s in spans)
                {
                    float u = Math.Max(0f, s.Value - 2 * skipM);
                    if (at <= u && u > 0) { outp.Add(PointAt(s.Key.points, skipM + at)); break; }
                    at -= u;
                }
            }
            return outp;
        }
    }
}
