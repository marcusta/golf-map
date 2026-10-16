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
        sealed class PlaneDoc
        {
            public string format = "", name = "";
            public float levelM, surfaceY, radiusM, areaKm2;
            public List<MeshDoc> meshes = new List<MeshDoc>();
            public MeshDoc collider = new MeshDoc();
            public ProbeDoc probe = new ProbeDoc();
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
            args = "name (the lake plane's name, default: the lake-plane file's), which=near|far|both (default both), floats={}, colors={}, vectors={}, on=[keywords], off=[keywords], " + GolfMapSceneSave.Arg)]
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
