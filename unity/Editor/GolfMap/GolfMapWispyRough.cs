// Unity 2018.2 / C# 6. Wispy rough: links-style deep rough inside the course's hand-drawn `rough_wispy`
// vegetation zones (golf-map Vegetation mode; read from the unity-zones-v2 export, which carries the outlines).
// A floor of rough-height blades with thin, longer, sparser blades over it, both StixGames 3D grass coloured
// from the orthophoto.
//
// The grass grows from its own mesh, not from the deep-rough mesh under it: StixGames' GrassRenderer draws the
// mesh of the MeshFilter beside it (Graphics.DrawMesh, no MeshRenderer needed), so each zone gets an object
// under 'GolfMap Wispy Rough' whose mesh is the part of the deep and rough course meshes under the zone, painted for Stix
// alone (blade chance = vertex red). The course meshes, their paint and their materials stay as they are, and
// nothing is tessellated outside the zone.
//
// Two renderers per zone, so the wisps are added to the floor instead of taking its blades:
//   floor  the rough's own Stix material (the same asset the rough meshes use), red = the zone's weight: the
//          sward is the rough's, blade for blade. With floor != 1 it is <course>/Grass/<rough> Wispy Floor.mat
//          instead: the rough's material with the blades that much longer (rebuilt from the rough's on every run,
//          like the wisps');
//   wisps  <course>/Grass/<rough> Wispy.mat on a second copy of the mesh, red = the zone's weight x the drift
//          noise. The material is rebuilt from the rough's on every run (so it follows the rough's colour map
//          and terrain scale): the same blade, longer, thinner, paler, and spaced wider (the rough's spacing /
//          sqrt(wisp share)). Hand-tuned values go in <course>/stix.json (wispy, wispyFloor), set after that.
// Both grow on the deep rough under the zone only: a rough mesh there keeps its own Stix and gets nothing of
// ours on top, the zone's look there being the VSP wispy grass alone.
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
    public static class GolfMapWispyRough
    {
        const string RendererType = "StixGames.GrassShader.GrassRenderer";
        const string NatureMeshFilterType = "StixGames.NatureCore.NatureMeshFilter";
        const string RootName = "GolfMap Wispy Rough";
        const string MeshFolder = "WispyRough";
        const string MaterialSuffix = " Wispy";
        const string FloorSuffix = " Wispy Floor";
        public const string DefaultZoneType = "rough_wispy";

        public sealed class Options
        {
            public string zoneType = DefaultZoneType;
            public string material = GolfMapRoughGrass.DefaultMaterial;
            public float floor = 1.3f;          // floor blade length, x the rough's (1 = the rough's own material)
            public float wisp = 0.15f;         // wisps per floor blade
            public float patch = 0.7f;         // how much the wisp share drifts over the area: 0 even, 1 from none to twice
            public float patchM = 7f;          // size of those drifts
            public float wispMinM = 0.20f, wispMaxM = 0.38f;
            public float wispWidthM = 0.006f;
            public Color wispColor = new Color(1.3f, 1.25f, 1f, 1), wispSecColor = new Color(0.95f, 0.88f, 0.62f, 1);
            public bool dryRun;
        }

        [BridgeCommand("golfmap.wispy.build", "Wispy rough (links-style deep rough) in every vegetation zone of type rough_wispy in the course's inner zones export: one object per zone under 'GolfMap Wispy Rough' holding the deep-rough course meshes under the zone (deep only: rough meshes keep their own Stix and get none of ours), cut to it (blade chance fading out over the zone's feather), with two StixGames GrassRenderers: the floor on the rough's own Stix material (the rough's sward, blade for blade) and, added to it, the wisps on <course>/Grass/<material> Wispy.mat (rebuilt from the rough's material: longer, thinner, paler blades, spaced wider, in drifts; then <course>/stix.json's wispy / wispyFloor values). The course meshes and their materials are not touched. Replaces what the last run made; zones that are gone lose their object. Marks the scene dirty, does not save it.",
            args = "zoneType=rough_wispy, material=NewRough (the rough's Stix material), floor=1.3 (floor blade length x the rough's; other than 1 = its own material <material> Wispy Floor.mat), wisp=0.15 (wisps per floor blade), patch=0.7 (drift of that over the area, 0 = even), patchM=7 (drift size), wispMin=0.20, wispMax=0.38 (m), wispWidth=0.006 (m), wispColor/wispSecColor (multipliers on the ortho colour: #rrggbb, or r,g,b which may exceed 1), file (zones export; default the course's inner), dryRun=false")]
        static object BuildCommand(BridgeArgs a)
        {
            var o = new Options
            {
                zoneType = a.String("zoneType", DefaultZoneType),
                material = a.String("material", GolfMapRoughGrass.DefaultMaterial),
                floor = (float)a.Number("floor", 1.3),
                wisp = Mathf.Clamp((float)a.Number("wisp", 0.15), 0.001f, 1f),
                patch = Mathf.Clamp01((float)a.Number("patch", 0.7)),
                patchM = Mathf.Max(1f, (float)a.Number("patchM", 7)),
                wispMinM = (float)a.Number("wispMin", 0.20),
                wispMaxM = (float)a.Number("wispMax", 0.38),
                wispWidthM = (float)a.Number("wispWidth", 0.006),
                dryRun = a.Bool("dryRun", false),
            };
            o.wispColor = ColorArg(a, "wispColor", o.wispColor);
            o.wispSecColor = ColorArg(a, "wispSecColor", o.wispSecColor);
            return Build(o, a.String("file", null));
        }

        [BridgeCommand("golfmap.wispy.clear", "Delete 'GolfMap Wispy Rough' (every object golfmap.wispy.build made; the mesh assets stay in <course>/WispyRough/). Marks the scene dirty.")]
        static object ClearCommand(BridgeArgs a)
        {
            var scene = EditorSceneManager.GetActiveScene();
            var root = scene.GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
            int n = root == null ? 0 : root.transform.childCount;
            if (root != null) { Undo.DestroyObjectImmediate(root); EditorSceneManager.MarkSceneDirty(scene); }
            return new Dictionary<string, object> { { "scene", scene.name }, { "removed", n } };
        }

        static Color ColorArg(BridgeArgs a, string name, Color fallback)
        {
            var s = a.String(name, null);
            if (string.IsNullOrEmpty(s)) return fallback;
            Color c;
            if (ColorUtility.TryParseHtmlString(s, out c)) return c;
            var parts = s.Trim('[', ']').Split(',').Select(p => float.Parse(p.Trim(), System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            if (parts.Length != 3) throw new InvalidOperationException(name + " must be #rrggbb or r,g,b.");
            return new Color(parts[0], parts[1], parts[2], 1);
        }

        public static Dictionary<string, object> Build(Options o, string file = null)
        {
            if (o.wispMinM <= 0 || o.wispMaxM < o.wispMinM) throw new InvalidOperationException("wispMin must be > 0 and <= wispMax.");
            if (o.floor <= 0) throw new InvalidOperationException("floor must be > 0.");
            if (o.wispWidthM <= 0) throw new InvalidOperationException("wispWidth must be > 0.");
            var type = AppDomain.CurrentDomain.GetAssemblies().Select(asm => asm.GetType(RendererType, false)).FirstOrDefault(t => t != null);
            if (type == null) throw new InvalidOperationException(RendererType + " not found: is the StixGames Grass Shader in this project?");
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            file = string.IsNullOrEmpty(file) ? GolfMapCourses.ExportFile(course, "inner", "zones") : file;
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) throw new InvalidOperationException("No zones export at " + file + ": export the vegetation zones from golf-map first.");
            var zones = GolfMapZones.Load(file).zones.Where(z => z.zoneType == o.zoneType && z.weight > 0 && z.rings != null && z.rings.Count > 0).ToList();

            var scene = EditorSceneManager.GetActiveScene();
            var terrain = GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
            var origin = terrain.transform.position;   // zone nodes are metres from the plot's south-west corner
            // Deep rough only gets the floor and the wisps. A rough mesh under the zone keeps its own Stix sward
            // (golfmap.roughgrass.plant) and gets no Stix of ours on top: there the zone's look is the VSP wispy
            // grass alone (Marcus, 2026-10-14: rough + floor + wisps there was Stix planted two and three times over).
            var ground = scene.GetRootGameObjects()
                .SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.sharedMesh != null && f.name.StartsWith("Spline_", StringComparison.Ordinal) && !GolfMapWaterplanes.IsWaterPlane(f.name)
                    && GolfMapSurfaces.Classify(f.name) == GolfMapSurfaces.Surface.Deep
                    && f.GetComponent<Renderer>() != null)
                .OrderBy(f => f.name, StringComparer.Ordinal).ToList();

            var built = new List<Patch>();
            var report = new List<object>();
            foreach (var zone in zones)
            {
                var patch = Cut(zone, origin, ground, o);
                report.Add(new Dictionary<string, object>
                {
                    { "zone", zone.id }, { "featherM", zone.feather }, { "areaM2", Mathf.Round(patch.areaM2) },
                    { "vertices", patch.vertices.Count }, { "triangles", patch.triangles.Count / 3 }, { "floorTriangles", patch.floorTriangles.Count / 3 },
                    { "meanDrift", patch.vertices.Count == 0 ? 0 : (float)Math.Round(patch.wisps.Average(c => c.r), 3) },
                    { "from", patch.sources }, { "centre", new[] { patch.centre.x, patch.centre.y, patch.centre.z } },
                });
                if (patch.triangles.Count > 0) built.Add(patch);
            }

            var result = new Dictionary<string, object>
            {
                { "scene", scene.name }, { "file", file }, { "zoneType", o.zoneType }, { "zones", zones.Count }, { "groundMeshes", ground.Count },
                { "dryRun", o.dryRun }, { "patches", report },
            };
            if (o.dryRun) return result;

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Build wispy rough");
            var rough = FindMaterial(o.material);
            var material = built.Count > 0 ? WispyMaterial(folder, rough, o) : null;
            var floor = built.Count > 0 && !Mathf.Approximately(o.floor, 1f) ? FloorMaterial(folder, rough, o) : rough;
            // the hand-tuned values (<course>/stix.json) over what was just derived from the rough's
            var tunedWisps = material == null ? new Dictionary<string, object>() : GolfMapStixSettings.Apply(material, course, "wispy");
            var tunedFloor = floor == null || floor == rough ? new Dictionary<string, object>() : GolfMapStixSettings.Apply(floor, course, "wispyFloor");
            if (!AssetDatabase.IsValidFolder(folder + MeshFolder)) AssetDatabase.CreateFolder(folder.TrimEnd('/'), MeshFolder);

            var root = scene.GetRootGameObjects().FirstOrDefault(g => g.name == RootName);
            if (root != null) Undo.DestroyObjectImmediate(root);
            if (built.Count > 0)
            {
                root = new GameObject(RootName);
                Undo.RegisterCreatedObjectUndo(root, "Build wispy rough");
                foreach (var patch in built) Place(root.transform, patch, type, floor, material, folder + MeshFolder + "/");
            }
            Undo.CollapseUndoOperations(undoGroup);
            AssetDatabase.SaveAssets();
            EditorSceneManager.MarkSceneDirty(scene);
            SceneView.RepaintAll();

            result["floorMaterial"] = AssetDatabase.GetAssetPath(floor);
            result["floorMaxHeightM"] = floor.GetFloat("_MaxHeight00");
            result["wispMaterial"] = material == null ? null : AssetDatabase.GetAssetPath(material);
            result["wispSpacingM"] = material == null ? 0 : material.GetFloat("_TargetDensity");
            result["objects"] = built.Count;
            result["stixSettings"] = new Dictionary<string, object> { { "wispy", tunedWisps }, { "wispyFloor", tunedFloor } };
            Debug.Log("[GolfMap Wispy rough] " + built.Count + " of " + zones.Count + " " + o.zoneType + " zone(s) built under '" + RootName + "' in " + scene.name +
                (material == null ? "" : ", material " + AssetDatabase.GetAssetPath(material)) + ". Undo is available for this run.");
            return result;
        }

        // ------------------------------------------------------------ the zone's mesh

        sealed class Patch
        {
            public string id;
            public Vector3 centre;
            public float areaM2;
            public readonly List<Vector3> vertices = new List<Vector3>();   // world space
            public readonly List<Vector3> normals = new List<Vector3>();
            public readonly List<Color> floor = new List<Color>();   // red = the zone's weight
            public readonly List<Color> wisps = new List<Color>();   // red = weight x drift (1 where the wisps stand thickest)
            public readonly List<int> triangles = new List<int>();        // where the wisps grow: deep and rough
            public readonly List<int> floorTriangles = new List<int>();   // where the floor is ours to grow: deep only, unless it is longer than the rough's
            public readonly List<string> sources = new List<string>();
        }

        // The triangles of the deep meshes that reach into the zone, as one world-space mesh, with the
        // blade chance (red) of the floor and of the wisps. Both fade over the zone's feather, centred on its outline.
        static Patch Cut(GolfMapZone zone, Vector3 origin, List<MeshFilter> ground, Options o)
        {
            var rings = zone.rings.Where(r => r.nodes != null && r.nodes.Count >= 3)
                .Select(r => r.nodes.Select(n => new Vector2(origin.x + n.x, origin.z + n.z)).ToArray()).ToList();
            var patch = new Patch { id = zone.id };
            if (rings.Count == 0) return patch;
            float half = Mathf.Max(0.01f, zone.feather * 0.5f);
            var min = rings.SelectMany(r => r).Aggregate((a, b) => Vector2.Min(a, b)) - Vector2.one * half;
            var max = rings.SelectMany(r => r).Aggregate((a, b) => Vector2.Max(a, b)) + Vector2.one * half;
            var mid = (min + max) * 0.5f;
            float seedX = (zone.id.GetHashCode() & 0xff) * 3.7f, seedZ = ((zone.id.GetHashCode() >> 8) & 0xff) * 5.3f;

            // a longer floor also grows on the rough meshes, over their own shorter sward
            bool ownFloor = !Mathf.Approximately(o.floor, 1f);
            var world = new List<Vector3>();
            foreach (var f in ground)
            {
                bool deep = GolfMapSurfaces.Classify(f.name) == GolfMapSurfaces.Surface.Deep;
                var b = f.GetComponent<Renderer>().bounds;
                if (b.max.x < min.x || b.min.x > max.x || b.max.z < min.y || b.min.z > max.y) continue;
                var mesh = f.sharedMesh;
                var local = mesh.vertices;
                var normals = mesh.normals;
                var tris = mesh.triangles;
                var weight = new float[local.Length];
                var point = new Vector3[local.Length];
                var known = new bool[local.Length];
                var index = new Dictionary<int, int>();
                int before = patch.triangles.Count;
                for (int t = 0; t < tris.Length; t += 3)
                {
                    bool any = false;
                    for (int k = 0; k < 3; k++)
                    {
                        int v = tris[t + k];
                        if (!known[v])
                        {
                            known[v] = true;
                            point[v] = f.transform.TransformPoint(local[v]);
                            var p = new Vector2(point[v].x, point[v].z);
                            weight[v] = p.x < min.x || p.x > max.x || p.y < min.y || p.y > max.y ? 0 : zone.weight * Smooth(-half, half, SignedDistance(rings, p));
                        }
                        any |= weight[v] > 0.001f;
                    }
                    if (!any) continue;
                    for (int k = 0; k < 3; k++)
                    {
                        int v = tris[t + k], at;
                        if (!index.TryGetValue(v, out at))
                        {
                            at = world.Count;
                            index[v] = at;
                            world.Add(point[v]);
                            patch.normals.Add(normals.Length == local.Length ? f.transform.TransformDirection(normals[v]).normalized : Vector3.up);
                            float n = Mathf.PerlinNoise(seedX + point[v].x / o.patchM, seedZ + point[v].z / o.patchM);
                            float drift = (1 + o.patch * (2 * Mathf.Clamp01((n - 0.2f) / 0.6f) - 1)) / (1 + o.patch);
                            patch.floor.Add(new Color(weight[v], 0, 0, 1));
                            patch.wisps.Add(new Color(weight[v] * drift, 0, 0, 1));
                        }
                        patch.triangles.Add(at);
                        if (deep || ownFloor) patch.floorTriangles.Add(at);
                    }
                    var a0 = world[patch.triangles[patch.triangles.Count - 3]];
                    var a1 = world[patch.triangles[patch.triangles.Count - 2]];
                    var a2 = world[patch.triangles[patch.triangles.Count - 1]];
                    patch.areaM2 += Vector3.Cross(a1 - a0, a2 - a0).magnitude * 0.5f;
                }
                if (patch.triangles.Count > before) patch.sources.Add(f.name);
            }
            float y = world.Count == 0 ? origin.y : world.Average(p => p.y);
            patch.centre = new Vector3(mid.x, y, mid.y);
            patch.vertices.AddRange(world);
            return patch;
        }

        static float Smooth(float e0, float e1, float x)
        {
            float t = Mathf.Clamp01((x - e0) / (e1 - e0));
            return t * t * (3 - 2 * t);
        }

        // Metres to the zone's outline, positive inside (even-odd over the rings, so holes count as outside).
        static float SignedDistance(List<Vector2[]> rings, Vector2 p)
        {
            bool inside = false;
            float best = float.MaxValue;
            foreach (var ring in rings)
            {
                for (int i = 0, j = ring.Length - 1; i < ring.Length; j = i++)
                {
                    var a = ring[j]; var b = ring[i];
                    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
                    var ab = b - a;
                    float len = ab.sqrMagnitude;
                    float t = len < 1e-9f ? 0 : Mathf.Clamp01(Vector2.Dot(p - a, ab) / len);
                    best = Mathf.Min(best, (p - (a + ab * t)).sqrMagnitude);
                }
            }
            float d = Mathf.Sqrt(best);
            return inside ? d : -d;
        }

        // ------------------------------------------------------------ scene objects

        static void Place(Transform root, Patch patch, Type rendererType, Material floor, Material wisps, string meshFolder)
        {
            var go = new GameObject("Wispy rough " + patch.id.Substring(0, Math.Min(8, patch.id.Length)));
            go.transform.SetParent(root, false);
            // At the origin with world-space vertices: GSPro's DisableGrassRenderer takes the mesh bounds' centre as a
            // world point when the object has no MeshCollider, and switches the grass off beyond 300 m from the camera.
            if (patch.floorTriangles.Count > 0)
                Grow(go, PatchMesh(patch, patch.floor, patch.floorTriangles, meshFolder + patch.id + ".asset", "floor"), rendererType, floor);
            var over = new GameObject("Wisps");
            over.transform.SetParent(go.transform, false);
            Grow(over, PatchMesh(patch, patch.wisps, patch.triangles, meshFolder + patch.id + "-wisps.asset", "wisps"), rendererType, wisps);
        }

        // The mesh asset is refilled in place on a re-run (same GUID).
        static Mesh PatchMesh(Patch patch, List<Color> colors, List<int> triangles, string assetPath, string what)
        {
            var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
            bool isNew = mesh == null;
            if (isNew) mesh = new Mesh();
            mesh.Clear(false);
            mesh.name = "Wispy rough " + what + " " + patch.id;
            mesh.indexFormat = patch.vertices.Count > 65000 ? UnityEngine.Rendering.IndexFormat.UInt32 : UnityEngine.Rendering.IndexFormat.UInt16;
            mesh.SetVertices(patch.vertices);
            mesh.SetNormals(patch.normals);
            mesh.SetColors(colors);
            mesh.SetUVs(0, patch.vertices.Select(v => new Vector2(v.x, v.z)).ToList());
            mesh.SetTriangles(triangles, 0, true);
            if (isNew) AssetDatabase.CreateAsset(mesh, assetPath); else EditorUtility.SetDirty(mesh);
            mesh.UploadMeshData(false);
            return mesh;
        }

        static void Grow(GameObject go, Mesh mesh, Type rendererType, Material material)
        {
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var grass = go.AddComponent(rendererType);   // brings NatureMeshFilter and grassonoffnew
            var so = new SerializedObject(grass);
            so.FindProperty("Material").objectReferenceValue = material;
            so.ApplyModifiedPropertiesWithoutUndo();
            var nmf = go.GetComponent(NatureMeshFilterType);
            if (nmf == null) return;
            nmf.GetType().GetMethod("ResetCache").Invoke(nmf, null);
            nmf.GetType().GetMethod("GetMeshes").Invoke(nmf, new object[] { false });
            EditorUtility.SetDirty(nmf);
        }

        // ------------------------------------------------------------ material

        // The wisps' material: the rough's Stix material with its one blade made the wisp - longer, thinner, softer,
        // paler - and spaced wider. Rebuilt in place on every run.
        static Material WispyMaterial(string courseFolder, Material rough, Options o)
        {
            var path = courseFolder + "Grass/" + rough.name + MaterialSuffix + ".mat";
            if (!AssetDatabase.IsValidFolder(courseFolder + "Grass")) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Grass");
            var m = new Material(rough) { name = rough.name + MaterialSuffix };
            var keywords = m.shaderKeywords.Where(k => k != "UNIFORM_DENSITY" && k != "VERTEX_DENSITY").ToList();
            keywords.Add("VERTEX_DENSITY");
            m.shaderKeywords = keywords.ToArray();
            // _TargetDensity is the distance between blades; the paint peaks at 1, the mean drift is 1 / (1 + patch)
            m.SetFloat("_TargetDensity", Mathf.Clamp(m.GetFloat("_TargetDensity") / Mathf.Sqrt(o.wisp * (1 + o.patch)), 0.01f, 1f));
            m.SetFloat("_MinHeight00", o.wispMinM);
            m.SetFloat("_MaxHeight00", o.wispMaxM);
            m.SetFloat("_Width00", o.wispWidthM);
            m.SetFloat("_Softness00", 1f);
            m.SetFloat("_Weight00", m.GetFloat("_Weight00") * 0.6f);   // less droop: a wisp stands and leans
            var c = o.wispColor; c.a = m.GetColor("_Color00").a;
            var s = o.wispSecColor; s.a = m.GetColor("_SecColor00").a;
            m.SetColor("_Color00", c);
            m.SetColor("_SecColor00", s);
            m.SetFloat("_LODMax", Mathf.Max(m.GetFloat("_LODMax"), 4));   // segments per blade: a 30 cm wisp bends in a curve

            return StoreMaterial(m, path);
        }

        // The floor's material when it is not the rough's own: the rough's with every blade `floor` times as long.
        static Material FloorMaterial(string courseFolder, Material rough, Options o)
        {
            if (!AssetDatabase.IsValidFolder(courseFolder + "Grass")) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Grass");
            var m = new Material(rough) { name = rough.name + FloorSuffix };
            foreach (var p in new[] { "_MinHeight00", "_MaxHeight00", "_MinHeight01", "_MaxHeight01" })
                if (m.HasProperty(p)) m.SetFloat(p, m.GetFloat(p) * o.floor);
            return StoreMaterial(m, courseFolder + "Grass/" + m.name + ".mat");
        }

        // Rebuilt in place: the asset at `path` takes m's values (same GUID, same references).
        static Material StoreMaterial(Material m, string path)
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing == null) { AssetDatabase.CreateAsset(m, path); return m; }
            Undo.RecordObject(existing, "Build wispy rough");
            existing.shader = m.shader;
            existing.CopyPropertiesFromMaterial(m);
            existing.shaderKeywords = m.shaderKeywords;
            UnityEngine.Object.DestroyImmediate(m);
            EditorUtility.SetDirty(existing);
            return existing;
        }

        static Material FindMaterial(string name)
        {
            var paths = AssetDatabase.FindAssets(name + " t:Material").Select(AssetDatabase.GUIDToAssetPath).Distinct()
                .Where(p => Path.GetFileNameWithoutExtension(p) == name).ToList();
            if (paths.Count != 1) throw new InvalidOperationException((paths.Count == 0 ? "No material" : "Several materials") + " named '" + name + "' in the project.");
            return AssetDatabase.LoadAssetAtPath<Material>(paths[0]);
        }
    }
}
