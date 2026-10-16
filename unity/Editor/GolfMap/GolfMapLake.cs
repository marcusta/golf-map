// Unity 2018.2 / C# 6. A big lake's water: Lux Water planes from the export folder's
// <prefix>-inner-lake-plane.json (golfmap-lake-plane-v1, `golfpipe lake-plane`), for a lake
// like Vättern at Omberg that reaches past both terrain squares out to the horizon backdrop.
// A pond's plane comes from its OPCD lake mesh (GolfMapWaterplanes); this one is cut from the
// lake's outline in the pipeline, flat at the lake level, coarser with distance:
//   - <name>_WaterPlane (near: the inner square and a margin, fine enough for Gerstner waves),
//     <name>_WaterPlane_Outer and _Far (no vertex waves: their cells are too big for them);
//   - <name>_WaterPlane_Collider: flat, no renderer, the GSPwater physic material over the near
//     part (what GSPro calls water, and what the ball lands on);
//   - a realtime reflection probe (on awake) over open water, the anchor of all three, its far
//     clip out past the horizon backdrop;
//   - meshes saved to <course>/Lake/, materials <course>/Lake/<name> near.mat and far.mat, made
//     once from Lux's 'water cristal clear gerstner' demo and tuned for a calm clear lake; a
//     rebuild keeps them, so a material tuned by hand survives.
// golfmap.lake.bed lightens the bed near the shore: its OPCD lake meshes get <course>/Lake/<name> bed.mat
// (their OPCD material with OPCD's bunker sand in the red channel, tinted light beige) and red vertex paint
// within bandM of the shore, fading out over fadeM (the file's shore distance grid, islands included):
// the bright shallows of a clear lake. It runs in every golfmap.course.refresh after the water planes,
// since OPCD's Set Default Materials and the FBX sync undo both.
// The names carry "WaterPlane": golfmap.waterplanes.build then treats the lake as covered and
// leaves its OPCD lake mesh alone; the planes it had built there before (at the wrong level for a
// lake whose mesh ends out in the dug bed) are switched off here, not deleted.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace GolfMap.Editor
{
    public static class GolfMapLake
    {
        const string Format = "golfmap-lake-plane-v1";
        const string AssetFolder = "Lake";
        const string LuxDemoMaterial = "Assets/LuxWater/Demos/Water Materials/water cristal clear gerstner.mat";
        const string WaterPhysics = "Assets/Resources/Physics/GSPwater.physicMaterial";
        const string ProbeName = "Lake Reflection Probe";

        [Serializable]
        sealed class MeshDoc
        {
            public string name = "", role = "";
            public float cellM;
            public float[] vertices = new float[0];
            public int[] triangles = new int[0];
        }

        [Serializable]
        sealed class ProbeDoc { public float x, y, z; }

        [Serializable]
        sealed class ShoreGrid { public float x0, z0, cellM, stepM; public int width, height; public string data = "", cliff = ""; }

        [Serializable]
        sealed class PlaneDoc
        {
            public string format = "", name = "";
            public float levelM, surfaceY, radiusM, areaKm2;
            public List<MeshDoc> meshes = new List<MeshDoc>();
            public MeshDoc collider = new MeshDoc();
            public ProbeDoc probe = new ProbeDoc();
            public ShoreGrid shoreDistance = new ShoreGrid();
        }

        [BridgeCommand("golfmap.lake.build", "Build a big lake's Lux Water planes from <prefix>-inner-lake-plane.json in the course export folder (golfpipe lake-plane): <name>_WaterPlane (near, Gerstner waves), _Outer and _Far (no vertex waves) at the file's surfaceY, a flat _Collider with the GSPwater physic material, and a realtime reflection probe (on awake) they all anchor on. Meshes go to <course>/Lake/; the materials <course>/Lake/<name> near.mat and far.mat are made from Lux's clear-water Gerstner demo the first time (calm, clear lake) and kept on a rebuild. Switches off the waterplanes.build planes the lake covers that lie more than 1 m under its surface. dryRun reports what it would build.",
            args = "file (default <export folder>/<prefix>-inner-lake-plane.json), parent=Waterplanes, resetMaterials=false (make the two materials again from the Lux demo, dropping hand tuning), dryRun=false, " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var file = a.String("file") ?? GolfMapCourses.ExportFile(course, "inner", "lake-plane");
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) throw new BridgeError("No lake plane file " + (file ?? "(the course names no export folder)") + ": run golfpipe lake-plane first.");
            var doc = JsonUtility.FromJson<PlaneDoc>(File.ReadAllText(file));
            if (doc == null || doc.format != Format) throw new BridgeError(file + ": format must be " + Format + ".");
            if (doc.meshes.Count == 0) throw new BridgeError(file + ": no meshes.");
            var folder = GolfMapCourses.Folder(course) + AssetFolder;
            bool dryRun = a.Bool("dryRun", false);
            var parentName = a.String("parent", "Waterplanes");

            var report = new Dictionary<string, object>
            {
                { "file", file }, { "name", doc.name }, { "levelM", doc.levelM }, { "surfaceY", doc.surfaceY }, { "areaKm2", doc.areaKm2 },
                { "meshes", doc.meshes.Select(m => (object)new Dictionary<string, object> { { "name", m.name }, { "role", m.role }, { "cellM", m.cellM }, { "vertices", m.vertices.Length / 2 }, { "triangles", m.triangles.Length / 3 } }).ToList() },
                { "dryRun", dryRun },
            };
            var scene = EditorSceneManager.GetActiveScene();
            var all = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<Transform>(true)).Select(t => t.gameObject).ToList();
            var ourNames = new HashSet<string>(doc.meshes.Select(m => m.name)) { doc.collider.name };
            if (dryRun)
            {
                report["wouldSwitchOff"] = Covered(all, ourNames, doc).Select(g => (object)Path(g)).ToList();
                return report;
            }

            EnsureFolder(folder);
            if (a.Bool("resetMaterials", false))
                foreach (var suffix in new[] { " near.mat", " far.mat" }) AssetDatabase.DeleteAsset(folder + "/" + doc.name + suffix);
            var near = MaterialFor(folder + "/" + doc.name + " near.mat", null, true);
            var far = MaterialFor(folder + "/" + doc.name + " far.mat", near, false);
            var parent = all.FirstOrDefault(g => g.transform.parent == null && g.name == parentName) ?? new GameObject(parentName);

            var built = new List<GameObject>();
            foreach (var m in doc.meshes)
            {
                var go = ObjectFor(all, parent, m.name);
                var mesh = SaveMesh(BuildMesh(m, doc.surfaceY), folder + "/" + m.name + ".asset");
                go.GetComponent<MeshFilter>().sharedMesh = mesh;
                var r = go.GetComponent<MeshRenderer>();
                r.sharedMaterial = m.role == "near" ? near : far;
                r.shadowCastingMode = ShadowCastingMode.Off;
                r.receiveShadows = true;
                r.reflectionProbeUsage = ReflectionProbeUsage.BlendProbes;
                var c = go.GetComponent<MeshCollider>();
                if (c != null) UnityEngine.Object.DestroyImmediate(c);
                EditorUtility.SetDirty(go);
                built.Add(go);
            }

            var nearGo = built.First();
            object collider = null;
            if (doc.collider != null && doc.collider.triangles.Length > 0)
            {
                var go = ObjectFor(all, parent, doc.collider.name);
                var mesh = SaveMesh(BuildMesh(doc.collider, doc.surfaceY), folder + "/" + doc.collider.name + ".asset");
                go.GetComponent<MeshFilter>().sharedMesh = mesh;
                var r = go.GetComponent<MeshRenderer>();
                if (r != null) UnityEngine.Object.DestroyImmediate(r);
                var c = go.GetComponent<MeshCollider>();   // not ??: a missing component is Unity's fake null
                if (c == null) c = go.AddComponent<MeshCollider>();
                c.sharedMesh = mesh;
                c.sharedMaterial = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(WaterPhysics);
                if (c.sharedMaterial == null) throw new BridgeError("No " + WaterPhysics + ": GSPro would not call the lake water.");
                EditorUtility.SetDirty(go);
                collider = Path(go);
            }

            var probe = ProbeFor(nearGo, new Vector3(doc.probe.x, doc.probe.y, doc.probe.z), doc.radiusM);
            foreach (var go in built) go.GetComponent<MeshRenderer>().probeAnchor = probe.transform;
            probe.RenderProbe();

            var off = Covered(all, ourNames, doc);
            foreach (var g in off) { Undo.RecordObject(g, "Lake covers it"); g.SetActive(false); }

            EditorSceneManager.MarkSceneDirty(scene);
            report["built"] = built.Select(g => (object)Path(g)).ToList();
            report["collider"] = collider;
            report["probe"] = Vec(probe.transform.position);
            report["materials"] = new List<object> { AssetDatabase.GetAssetPath(near), AssetDatabase.GetAssetPath(far) };
            report["switchedOff"] = off.Select(g => (object)Path(g)).ToList();
            return report;
        }

        // Flat at surfaceY; x, z from the file; normals up, a +x tangent, white vertex colour, UVs every 10 m.
        static Mesh BuildMesh(MeshDoc m, float y)
        {
            int n = m.vertices.Length / 2;
            var v = new Vector3[n];
            var uv = new Vector2[n];
            for (int i = 0; i < n; i++)
            {
                v[i] = new Vector3(m.vertices[2 * i], y, m.vertices[2 * i + 1]);
                uv[i] = new Vector2(v[i].x / 10f, v[i].z / 10f);
            }
            var tris = (int[])m.triangles.Clone();
            if (tris.Length >= 3)
            {
                var up = Vector3.Cross(v[tris[1]] - v[tris[0]], v[tris[2]] - v[tris[0]]);
                if (up.y < 0) for (int i = 0; i < tris.Length; i += 3) { int t = tris[i + 1]; tris[i + 1] = tris[i + 2]; tris[i + 2] = t; }
            }
            var mesh = new Mesh { name = m.name };
            mesh.indexFormat = n > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16;
            mesh.vertices = v;
            mesh.uv = uv;
            mesh.normals = Enumerable.Repeat(Vector3.up, n).ToArray();
            mesh.tangents = Enumerable.Repeat(new Vector4(1, 0, 0, -1), n).ToArray();
            mesh.colors = Enumerable.Repeat(Color.white, n).ToArray();
            mesh.triangles = tris;
            mesh.RecalculateBounds();
            return mesh;
        }

        static Mesh SaveMesh(Mesh mesh, string path)
        {
            var existing = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (existing == null) { AssetDatabase.CreateAsset(mesh, path); return mesh; }
            EditorUtility.CopySerialized(mesh, existing);
            UnityEngine.Object.DestroyImmediate(mesh);
            EditorUtility.SetDirty(existing);
            return existing;
        }

        static GameObject ObjectFor(List<GameObject> all, GameObject parent, string name)
        {
            var go = all.FirstOrDefault(g => g != null && g.name == name && g.transform.parent == parent.transform);
            if (go == null)
            {
                go = new GameObject(name);
                go.transform.SetParent(parent.transform, false);
                all.Add(go);
            }
            go.transform.localPosition = Vector3.zero;
            go.transform.localRotation = Quaternion.identity;
            go.transform.localScale = Vector3.one;
            go.SetActive(true);
            if (go.GetComponent<MeshFilter>() == null) go.AddComponent<MeshFilter>();
            if (go.GetComponent<MeshRenderer>() == null) go.AddComponent<MeshRenderer>();
            return go;
        }

        static ReflectionProbe ProbeFor(GameObject plane, Vector3 at, float radiusM)
        {
            var t = plane.transform.Find(ProbeName);
            var probe = t != null ? t.GetComponent<ReflectionProbe>() : null;
            if (probe == null)
            {
                var go = new GameObject(ProbeName);
                go.transform.SetParent(plane.transform, false);
                probe = go.AddComponent<ReflectionProbe>();
            }
            probe.transform.position = at;
            probe.mode = ReflectionProbeMode.Realtime;
            probe.refreshMode = ReflectionProbeRefreshMode.OnAwake;
            probe.timeSlicingMode = ReflectionProbeTimeSlicingMode.NoTimeSlicing;
            probe.boxProjection = false;
            probe.size = new Vector3(2f * radiusM, 600f, 2f * radiusM);
            probe.nearClipPlane = 1f;
            probe.farClipPlane = Mathf.Max(6000f, radiusM * 1.5f);   // past the horizon backdrop, so the far shore is in the water
            probe.resolution = 256;
            probe.hdr = true;
            probe.clearFlags = ReflectionProbeClearFlags.Skybox;
            probe.importance = 1;
            return probe;
        }

        // The near material: made once from Lux's clear-water Gerstner demo, calm. The far one: a copy
        // without vertex waves or wave-crest foam. Existing materials are left as they are.
        static Material MaterialFor(string path, Material from, bool near)
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null) return existing;
            var source = from ?? AssetDatabase.LoadAssetAtPath<Material>(LuxDemoMaterial);
            if (source == null) throw new BridgeError("No " + LuxDemoMaterial + ": import Lux Water into the project first.");
            var m = new Material(source) { name = System.IO.Path.GetFileNameWithoutExtension(path) };
            if (near)
            {
                // Calm: half the demo's wave height, waves twice as long, half as fast.
                Scale(m, "_GAmplitude", 0.5f);
                m.SetFloat("_GGlobalFrequency", 2f);
                m.SetFloat("_GGlobalSpeed", 0.5f);
                m.SetVector("_GFinalFrequency", m.GetVector("_GFrequency") * m.GetFloat("_GGlobalFrequency"));
                m.SetVector("_GFinalSpeed", m.GetVector("_GSpeed") * m.GetFloat("_GGlobalSpeed"));
                m.SetFloat("_GerstnerEnabled", 1f);
                m.EnableKeyword("_GERSTNERDISPLACEMENT");
                // No crest foam: calm water, and with the waves on the demo's caps whiten the whole surface.
                m.SetFloat("_FoamCaps", 0f);
                // Clear blue-green lake water: the shallow shelf shows, and it reads as deep from ~6 m, so
                // the flat 8 m bed and open water with no ground under it (past the outer terrain) match.
                m.SetColor("_Color", new Color(0.04f, 0.16f, 0.20f, 1f));
                m.SetVector("_DepthAtten", new Vector4(0f, 6f, 1f, 0f));
                m.SetFloat("_Density", 0.12f);
                m.SetColor("_TranslucencyColor", new Color(0.12f, 0.32f, 0.33f, 1f));
                // Caustics from the depth buffer: "normals from GBuffer" (the demo's) draws a white cell
                // pattern under a forward camera. Faint: a hint of sun on the shallow stones.
                m.SetFloat("_CausticMode", 0f);
                m.DisableKeyword("GEOM_TYPE_LEAF");
                m.SetFloat("_CausticsScale", 0.5f);
            }
            else
            {
                m.SetFloat("_GerstnerEnabled", 0f);
                m.DisableKeyword("_GERSTNERDISPLACEMENT");
                m.SetFloat("_FoamCaps", 0f);
                m.SetFloat("_CausticsEnabled", 0f);
                m.DisableKeyword("_CAUSTICS");
                // Deep from 2 m: water over the outer terrain's flat bed and over no ground at all alike.
                m.SetVector("_DepthAtten", new Vector4(0f, 2f, 1f, 0f));
            }
            AssetDatabase.CreateAsset(m, path);
            return m;
        }

        [BridgeCommand("golfmap.lake.material", "Tune a lake's Lux materials (<course>/Lake/<name> near.mat / far.mat) without the inspector: floats, colours ([r,g,b,a]) and vectors ([x,y,z,w]) by shader property name, keywords on/off (e.g. _GERSTNERDISPLACEMENT, GEOM_TYPE_FROND = caustics, GEOM_TYPE_BRANCH_DETAIL = foam). Recomputes what Lux's material editor derives (_GFinalFrequency, _GFinalSpeed). Reports the values it set and the keywords now on.",
            args = "name (the lake plane's name, default: the lake-plane file's), which=near|far|both|bed (default both; bed = golfmap.lake.bed's), floats={}, colors={}, vectors={}, on=[keywords], off=[keywords], " + GolfMapSceneSave.Arg)]
        static object MaterialCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var name = a.String("name");
            if (name == null)
            {
                var file = GolfMapCourses.ExportFile(course, "inner", "lake-plane");
                if (file == null || !File.Exists(file)) throw new BridgeError("Give name: no lake plane file to read it from.");
                name = JsonUtility.FromJson<PlaneDoc>(File.ReadAllText(file)).name;
            }
            var folder = GolfMapCourses.Folder(course) + AssetFolder + "/";
            var which = a.String("which", "both");
            var paths = new List<string>();
            if (which == "near" || which == "both") paths.Add(folder + name + " near.mat");
            if (which == "far" || which == "both") paths.Add(folder + name + " far.mat");
            if (which == "bed") paths.Add(folder + name + " bed.mat");
            var result = new List<object>();
            foreach (var path in paths)
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(path);
                if (m == null) throw new BridgeError("No " + path + ": run golfmap.lake.build first.");
                var set = new List<object>();
                foreach (var kv in Dict(a.Raw("floats"))) { Need(m, kv.Key); m.SetFloat(kv.Key, Convert.ToSingle(kv.Value)); set.Add(kv.Key); }
                foreach (var kv in Dict(a.Raw("colors"))) { Need(m, kv.Key); var v = Vec4(kv.Value); m.SetColor(kv.Key, new Color(v.x, v.y, v.z, v.w)); set.Add(kv.Key); }
                foreach (var kv in Dict(a.Raw("vectors"))) { Need(m, kv.Key); m.SetVector(kv.Key, Vec4(kv.Value)); set.Add(kv.Key); }
                foreach (var k in a.Strings("on")) m.EnableKeyword(k);
                foreach (var k in a.Strings("off")) m.DisableKeyword(k);
                if (m.HasProperty("_GFinalFrequency")) m.SetVector("_GFinalFrequency", m.GetVector("_GFrequency") * m.GetFloat("_GGlobalFrequency"));
                if (m.HasProperty("_GFinalSpeed")) m.SetVector("_GFinalSpeed", m.GetVector("_GSpeed") * m.GetFloat("_GGlobalSpeed"));
                EditorUtility.SetDirty(m);
                result.Add(new Dictionary<string, object> { { "material", path }, { "set", set }, { "keywords", m.shaderKeywords.Select(k => (object)k).ToList() } });
            }
            return result;
        }

        static IEnumerable<KeyValuePair<string, object>> Dict(object raw)
        {
            var d = raw as Dictionary<string, object>;
            return d ?? new Dictionary<string, object>();
        }

        static void Need(Material m, string property)
        {
            if (!m.HasProperty(property)) throw new BridgeError(m.name + " has no property " + property + ".");
        }

        static Vector4 Vec4(object raw)
        {
            var l = raw as List<object>;
            if (l == null || l.Count < 3) throw new BridgeError("Colours and vectors are [x, y, z] or [x, y, z, w].");
            return new Vector4(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]), l.Count > 3 ? Convert.ToSingle(l[3]) : 1f);
        }

        // ---- The bed: a light band of sand in the shallows ----

        const string BedSuffix = "_Water_Base_Lake_-_Mesh";
        const string SandMaterial = "Assets/Resources/Materials/Theme - Satellite/OPCD MAHS Sand Raked Dirt Lip_Sat.mat";
        const string LakeBedMaterial = "Assets/Resources/Materials/Theme - Satellite/OPCD MAHS Water Base Lake_Sat.mat";
        const float AboveWaterKeepM = 0.3f;   // bed vertices higher than this over the water are bank: left as painted

        [Serializable]
        sealed class BedSettings { public float bandM = 25f, fadeM = 20f; }

        [Serializable]
        sealed class Original { public string obj = "", path = "", mesh = ""; }

        [Serializable]
        sealed class Originals { public List<Original> entries = new List<Original>(); }

        [BridgeCommand("golfmap.lake.bed", "Lighten a big lake's bed near the shore: its OPCD lake meshes (*" + BedSuffix + " under the water, in the lake-plane file's shore distance grid) get <course>/Lake/<name> bed.mat - their OPCD material with OPCD's bunker sand copied into the red channel, satellite and base blend off, tinted light beige - and red vertex paint within bandM of the shore, fading out over fadeM (islands and skerries are shore too), none at the foot of a cliff (the file's cliff grid). Painted mesh copies go to <course>/Lake/Bed/ (computed from the FBX colours every run). bandM/fadeM are kept in <course>/Lake/<name> bed.json for golfmap.course.refresh, which runs this after the water planes. Tune the colour with golfmap.lake.material which=bed.",
            args = "bandM (default 25, or the kept value), fadeM (default 20, or the kept value), resetMaterial=false (make bed.mat again), dryRun=false, " + GolfMapSceneSave.Arg)]
        static object BedCommand(BridgeArgs a)
        {
            var r = Bed(a.Bool("dryRun", false), a);
            if (r == null) throw new BridgeError("No lake-plane file for the course: run golfpipe lake-plane first.");
            return r;
        }

        // golfmap.course.refresh's step; null when the course has no lake-plane file.
        public static Dictionary<string, object> Bed(bool dryRun, BridgeArgs a = null)
        {
            var course = GolfMapCourses.Require();
            var file = GolfMapCourses.ExportFile(course, "inner", "lake-plane");
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) return null;
            var doc = JsonUtility.FromJson<PlaneDoc>(File.ReadAllText(file));
            var grid = doc.shoreDistance;
            if (grid == null || grid.width == 0 || string.IsNullOrEmpty(grid.data)) throw new BridgeError(file + " has no shore distance grid: run golfpipe lake-plane again.");
            var folder = GolfMapCourses.Folder(course) + AssetFolder;
            var bedFolder = folder + "/Bed";
            var settingsPath = folder + "/" + doc.name + " bed.json";
            var settings = File.Exists(settingsPath) ? JsonUtility.FromJson<BedSettings>(File.ReadAllText(settingsPath)) : new BedSettings();
            if (a != null && a.Has("bandM")) settings.bandM = Mathf.Max(0f, (float)a.Number("bandM", 25));
            if (a != null && a.Has("fadeM")) settings.fadeM = Mathf.Max(0.01f, (float)a.Number("fadeM", 20));
            var dist = Convert.FromBase64String(grid.data);
            if (dist.Length != grid.width * grid.height) throw new BridgeError(file + ": the shore grid's data is not width x height.");
            // How much of a cliff the shore is (0-255): no sand at the foot of a cliff, the rock goes on down there.
            var cliff = string.IsNullOrEmpty(grid.cliff) ? null : Convert.FromBase64String(grid.cliff);
            if (cliff != null && cliff.Length != dist.Length) throw new BridgeError(file + ": the shore grid's cliff is not width x height.");
            var cliffGrid = new ShoreGrid { x0 = grid.x0, z0 = grid.z0, cellM = grid.cellM, stepM = 1f / 255f, width = grid.width, height = grid.height };
            float gx1 = grid.x0 + grid.width * grid.cellM, gz1 = grid.z0 + grid.height * grid.cellM;

            var scene = EditorSceneManager.GetActiveScene();
            var beds = scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.gameObject.name.EndsWith(BedSuffix, StringComparison.Ordinal) && f.sharedMesh != null)
                .Where(f =>
                {
                    var r = f.GetComponent<MeshRenderer>();
                    if (r == null) return false;
                    var b = r.bounds;
                    return b.min.y < doc.surfaceY && b.max.x > grid.x0 && b.min.x < gx1 && b.max.z > grid.z0 && b.min.z < gz1;
                }).ToList();
            var report = new Dictionary<string, object>
            {
                { "bandM", settings.bandM }, { "fadeM", settings.fadeM }, { "meshes", beds.Select(f => (object)f.gameObject.name).ToList() }, { "dryRun", dryRun },
            };
            if (dryRun || beds.Count == 0) return report;

            EnsureFolder(bedFolder);
            File.WriteAllText(settingsPath, JsonUtility.ToJson(settings, true));
            var originalsPath = bedFolder + "/originals.json";
            var originals = File.Exists(originalsPath) ? JsonUtility.FromJson<Originals>(File.ReadAllText(originalsPath)) : new Originals();
            var material = BedMaterial(folder + "/" + doc.name + " bed.mat", beds[0].GetComponent<MeshRenderer>().sharedMaterial, a != null && a.Bool("resetMaterial", false));

            int painted = 0, verts = 0;
            foreach (var f in beds)
            {
                var source = OriginalOf(f, bedFolder, originals);
                var copy = UnityEngine.Object.Instantiate(source);
                copy.name = source.name;
                var v = source.vertices;
                var c = source.colors;
                if (c == null || c.Length != v.Length) c = Enumerable.Repeat(Color.black, v.Length).ToArray();
                var t = f.transform;
                for (int i = 0; i < v.Length; i++)
                {
                    var w = t.TransformPoint(v[i]);
                    if (w.y > doc.surfaceY + AboveWaterKeepM) continue;
                    float d = Sample(grid, dist, w.x, w.z);
                    float k = d <= settings.bandM ? 1f : Mathf.Clamp01(1f - (d - settings.bandM) / settings.fadeM);
                    if (cliff != null) { float cl = Sample(cliffGrid, cliff, w.x, w.z); if (cl < float.MaxValue) k *= 1f - Mathf.Clamp01(cl); }
                    if (k <= 0f) continue;
                    c[i] = Color.Lerp(c[i], new Color(1f, 0f, 0f, c[i].a), k);
                    painted++;
                }
                verts += v.Length;
                copy.colors = c;
                f.sharedMesh = SaveMesh(copy, bedFolder + "/" + f.gameObject.name + ".asset");
                f.GetComponent<MeshRenderer>().sharedMaterial = material;
                EditorUtility.SetDirty(f);
            }
            File.WriteAllText(originalsPath, JsonUtility.ToJson(originals, true));
            EditorSceneManager.MarkSceneDirty(scene);
            report["material"] = AssetDatabase.GetAssetPath(material);
            report["verticesPainted"] = painted;
            report["vertices"] = verts;
            return report;
        }

        // The mesh to paint from: the FBX mesh, remembered when the filter already holds our copy.
        static Mesh OriginalOf(MeshFilter f, string bedFolder, Originals originals)
        {
            var current = f.sharedMesh;
            var path = AssetDatabase.GetAssetPath(current);
            var entry = originals.entries.FirstOrDefault(e => e.obj == f.gameObject.name);
            if (!path.StartsWith(bedFolder + "/", StringComparison.OrdinalIgnoreCase))
            {
                if (entry == null) { entry = new Original { obj = f.gameObject.name }; originals.entries.Add(entry); }
                entry.path = path;
                entry.mesh = current.name;
                return current;
            }
            if (entry == null) throw new BridgeError(f.gameObject.name + " holds a bed copy with no original on record: re-sync the meshes (golfmap.meshes.sync) and run again.");
            var original = AssetDatabase.LoadAllAssetsAtPath(entry.path).OfType<Mesh>().FirstOrDefault(m => m.name == entry.mesh);
            if (original == null) throw new BridgeError(f.gameObject.name + ": its original mesh " + entry.mesh + " is gone from " + entry.path + ": re-sync the meshes and run again.");
            return original;
        }

        // Distance from the shore (m) at x, z, bilinear over the grid's cell centres; far out past its edges.
        static float Sample(ShoreGrid g, byte[] data, float x, float z)
        {
            float fx = (x - g.x0) / g.cellM - 0.5f, fz = (z - g.z0) / g.cellM - 0.5f;
            if (fx < 0 || fz < 0 || fx > g.width - 1 || fz > g.height - 1) return float.MaxValue;
            int ix = Mathf.Min((int)fx, g.width - 2), iz = Mathf.Min((int)fz, g.height - 2);
            float tx = fx - ix, tz = fz - iz;
            Func<int, int, float> at = (cx, cz) => data[cz * g.width + cx] * g.stepM;
            return Mathf.Lerp(Mathf.Lerp(at(ix, iz), at(ix + 1, iz), tx), Mathf.Lerp(at(ix, iz + 1), at(ix + 1, iz + 1), tx), tz);
        }

        // <course>/Lake/<name> bed.mat: the bed's OPCD lake material with OPCD's bunker sand in the red channel,
        // drawn at every distance (satellite and base blend off: the far base would be the dark lake photo), light
        // beige. Made once; kept (hand tuning survives) unless reset.
        static Material BedMaterial(string path, Material current, bool reset)
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null && !reset) return existing;
            var source = current != null && AssetDatabase.GetAssetPath(current) != path ? current : AssetDatabase.LoadAssetAtPath<Material>(LakeBedMaterial);
            var sand = AssetDatabase.LoadAssetAtPath<Material>(SandMaterial);
            if (source == null || sand == null) throw new BridgeError("Need " + LakeBedMaterial + " and " + SandMaterial + " (OPCD's materials).");
            var m = new Material(source) { name = System.IO.Path.GetFileNameWithoutExtension(path) };
            GolfMapBunkerChannels.CopyChannel(sand, BunkerPaintChannel.Black, m, BunkerPaintChannel.Red);
            ToggleProperty(m, "_RedUseSatelliteforBase", false);
            ToggleProperty(m, "_RedBaseBlend", false);
            // Soft: OPCD's bunker blend makes a crisp line of the band's 20 m fade; at 0.5 the paint gradient shows.
            foreach (var kv in new[] { new KeyValuePair<string, float>("_RedBlendStrength", 0.5f), new KeyValuePair<string, float>("_BlackBlendStrength", 0.5f), new KeyValuePair<string, float>("_RedBlendSharpness", 0.3f), new KeyValuePair<string, float>("_RedFalloff", 0.2f) })
                if (m.HasProperty(kv.Key)) m.SetFloat(kv.Key, kv.Value);
            if (m.HasProperty("_RedDetailColorTint")) m.SetColor("_RedDetailColorTint", new Color(1.0f, 0.88f, 0.70f, 1f));
            if (m.HasProperty("_RedOverallColor")) m.SetColor("_RedOverallColor", Color.white);
            if (m.HasProperty("_RedOverallColorStrength")) m.SetFloat("_RedOverallColorStrength", 1.35f);
            if (existing != null) { EditorUtility.CopySerialized(m, existing); UnityEngine.Object.DestroyImmediate(m); EditorUtility.SetDirty(existing); return existing; }
            AssetDatabase.CreateAsset(m, path);
            return m;
        }

        // A [Toggle] property: the float and the keyword the shader reads.
        static void ToggleProperty(Material m, string property, bool on)
        {
            if (!m.HasProperty(property)) return;
            m.SetFloat(property, on ? 1 : 0);
            var kw = property.ToUpperInvariant() + "_ON";
            if (on) m.EnableKeyword(kw); else m.DisableKeyword(kw);
        }

        static void Scale(Material m, string property, float factor)
        {
            if (m.HasProperty(property)) m.SetVector(property, m.GetVector(property) * factor);
        }

        // Water planes not of this lake that it covers (most of their XZ footprint inside the near
        // plane's) and that lie more than 1 m under its surface: stale planes of its OPCD lake mesh.
        static List<GameObject> Covered(List<GameObject> all, HashSet<string> ours, PlaneDoc doc)
        {
            var nearMesh = doc.meshes[0];
            float minX = float.MaxValue, minZ = float.MaxValue, maxX = float.MinValue, maxZ = float.MinValue;
            for (int i = 0; i < nearMesh.vertices.Length; i += 2)
            {
                minX = Mathf.Min(minX, nearMesh.vertices[i]); maxX = Mathf.Max(maxX, nearMesh.vertices[i]);
                minZ = Mathf.Min(minZ, nearMesh.vertices[i + 1]); maxZ = Mathf.Max(maxZ, nearMesh.vertices[i + 1]);
            }
            var result = new List<GameObject>();
            foreach (var g in all)
            {
                if (g == null || !g.activeInHierarchy || ours.Contains(g.name) || !GolfMapWaterplanes.IsWaterPlane(g.name)) continue;
                var r = g.GetComponent<Renderer>();
                if (r == null) continue;
                var b = r.bounds;
                float w = Mathf.Min(b.max.x, maxX) - Mathf.Max(b.min.x, minX);
                float d = Mathf.Min(b.max.z, maxZ) - Mathf.Max(b.min.z, minZ);
                bool inside = w > 0 && d > 0 && w * d >= 0.5f * Mathf.Max(1e-3f, b.size.x * b.size.z);
                if (inside && b.max.y < doc.surfaceY - 1f) result.Add(g);
            }
            return result;
        }

        static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parent = System.IO.Path.GetDirectoryName(folder).Replace('\\', '/');
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, System.IO.Path.GetFileName(folder));
        }

        static string Path(GameObject g)
        {
            var p = "/" + g.name;
            for (var t = g.transform.parent; t != null; t = t.parent) p = "/" + t.name + p;
            return p;
        }

        static List<object> Vec(Vector3 v) { return new List<object> { Math.Round(v.x, 3), Math.Round(v.y, 3), Math.Round(v.z, 3) }; }
    }
}
