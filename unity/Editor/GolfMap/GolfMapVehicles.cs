// Low-poly vehicle prefabs for course props. blender/tools/vehicle_models*.py merges a vehicle pack's
// prefab (30-43 renderers a car) into one FBX with two objects, <id>_body (casts shadows) and <id>_details
// (does not), one material slot per original material, and writes vehicles.json beside the FBX files in
// <course>/Props/VehiclesLowPoly/. golfmap.vehicles.build turns each entry into a prefab there: the model
// under an empty root, the pack's own materials (found by name on the source prefab) on the slots, shadows
// off on the details. A props spec then points its vehicle assets at these prefabs; golfmap.props.place
// recolours them by material name as before. golfmap.props.stats counts what a place left in the scene.
// Unity 2018.2 / C# 6.
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
    public static class GolfMapVehicles
    {
        const string Format = "golfmap-vehicles-v1";

        [BridgeCommand("golfmap.vehicles.build", "Build the low-poly vehicle prefabs of <course>/Props/VehiclesLowPoly/vehicles.json (golfmap-vehicles-v1 from blender/tools/vehicle_models_10k.py): per entry <name>.prefab = the entry's FBX under an empty root, each object's material slots filled with the materials of that name on the entry's source prefab, Cast Shadows off on objects marked castShadows false. An existing prefab is replaced in place (same GUID, scene instances follow). Returns each prefab's renderers, triangles and bounds next to the source prefab's.",
            args = "folder (default <course>/Props/VehiclesLowPoly/), dryRun=false")]
        static object Build(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var folder = a.String("folder");
            folder = string.IsNullOrEmpty(folder) ? GolfMapCourses.Folder(course) + "Props/VehiclesLowPoly/" : folder.Replace('\\', '/').TrimEnd('/') + "/";
            bool dryRun = a.Bool("dryRun", false);
            var manifest = folder + "vehicles.json";
            if (!File.Exists(manifest)) throw new BridgeError("No " + manifest + ": run blender/tools/vehicle_models_10k.py with --out " + folder);
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(manifest));
            if (root.String("format") != Format) throw new BridgeError(manifest + " is not " + Format + ".");
            AssetDatabase.Refresh();
            var rows = new List<object>();
            foreach (var p in root.Array("prefabs").Cast<GolfMapJsonObject>())
            {
                var name = p.String("name");
                var fbxPath = folder + p.String("fbx");
                var sourcePath = p.String("materialsFrom");
                var source = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePath);
                if (source == null) throw new BridgeError(name + ": no source prefab " + sourcePath);
                var mi = AssetImporter.GetAtPath(fbxPath) as ModelImporter;
                if (mi == null) { AssetDatabase.ImportAsset(fbxPath); mi = AssetImporter.GetAtPath(fbxPath) as ModelImporter; }
                if (mi == null) throw new BridgeError(name + ": no model " + fbxPath);
                if (!dryRun && (mi.importMaterials || mi.importAnimation || mi.animationType != ModelImporterAnimationType.None || mi.globalScale != 1f || !mi.useFileScale
                    || mi.importNormals != ModelImporterNormals.Import || mi.meshCompression != ModelImporterMeshCompression.Off || mi.addCollider))
                {
                    mi.globalScale = 1f;
                    mi.useFileScale = true;
                    mi.importMaterials = false;  // the slots get the pack's materials below
                    mi.importAnimation = false;
                    mi.importCameras = false;
                    mi.importLights = false;
                    mi.animationType = ModelImporterAnimationType.None;
                    mi.addCollider = false;
                    mi.importNormals = ModelImporterNormals.Import;
                    mi.meshCompression = ModelImporterMeshCompression.Off;
                    mi.SaveAndReimport();
                }
                var model = AssetDatabase.LoadAssetAtPath<GameObject>(fbxPath);
                var byName = source.GetComponentsInChildren<Renderer>(true).SelectMany(r => r.sharedMaterials).Where(m => m != null)
                    .GroupBy(m => m.name).ToDictionary(g => g.Key, g => g.First());

                var go = new GameObject(name);
                try
                {
                    var inst = UnityEngine.Object.Instantiate(model);
                    inst.name = "Model";
                    inst.transform.SetParent(go.transform, false);  // keeps whatever rotation/scale the import gave the model
                    var missing = new List<string>();
                    int renderers = 0, casters = 0;
                    foreach (var o in p.Array("objects").Cast<GolfMapJsonObject>())
                    {
                        var t = inst.GetComponentsInChildren<Transform>(true).FirstOrDefault(x => x.name == o.String("name"));
                        var r = t != null ? t.GetComponent<MeshRenderer>() : null;
                        if (r == null) throw new BridgeError(name + ": " + fbxPath + " has no mesh object '" + o.String("name") + "'");
                        var want = o.Array("materials").Select(x => x as string).ToList();
                        var mesh = t.GetComponent<MeshFilter>().sharedMesh;
                        if (mesh.subMeshCount != want.Count) throw new BridgeError(name + ": " + t.name + " has " + mesh.subMeshCount + " submeshes, the manifest lists " + want.Count + " materials");
                        var mats = new Material[want.Count];
                        for (int i = 0; i < want.Count; i++)
                        {
                            Material m;
                            if (byName.TryGetValue(want[i], out m)) mats[i] = m; else missing.Add(want[i]);
                        }
                        r.sharedMaterials = mats;
                        bool cast = o.Bool("castShadows", true);
                        r.shadowCastingMode = cast ? ShadowCastingMode.On : ShadowCastingMode.Off;
                        r.receiveShadows = true;
                        renderers++;
                        if (cast) casters++;
                    }
                    if (missing.Count > 0) throw new BridgeError(name + ": " + sourcePath + " has no material named " + string.Join(", ", missing.Distinct().ToArray()));
                    var b = Bounds(go);
                    var sb = BoundsOfPrefab(source);
                    var row = new Dictionary<string, object>
                    {
                        { "prefab", folder + name + ".prefab" }, { "fbx", fbxPath }, { "materialsFrom", sourcePath },
                        { "renderers", renderers }, { "shadowCasters", casters }, { "triangles", Triangles(go) },
                        { "size", V(b.size) }, { "center", V(b.center) },
                        { "source", new Dictionary<string, object> {
                            { "renderers", source.GetComponentsInChildren<Renderer>().Length }, { "triangles", Triangles(source) }, { "size", V(sb.size) }, { "center", V(sb.center) } } },
                        { "sizeDiff", V(b.size - sb.size) }, { "centerDiff", V(b.center - sb.center) },
                    };
                    if (!dryRun)
                    {
                        var path = folder + name + ".prefab";
                        var existing = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                        if (existing != null) PrefabUtility.ReplacePrefab(go, existing, ReplacePrefabOptions.ReplaceNameBased);
                        else PrefabUtility.CreatePrefab(path, go);
                    }
                    rows.Add(row);
                }
                finally { UnityEngine.Object.DestroyImmediate(go); }
            }
            if (!dryRun) AssetDatabase.SaveAssets();
            return new Dictionary<string, object> { { "manifest", manifest }, { "dryRun", dryRun }, { "prefabs", rows } };
        }

        static double[] V(Vector3 v) { return new[] { Math.Round(v.x, 4), Math.Round(v.y, 4), Math.Round(v.z, 4) }; }

        static Bounds Bounds(GameObject go)
        {
            var rs = go.GetComponentsInChildren<Renderer>();
            var b = rs.Length > 0 ? rs[0].bounds : new Bounds();
            foreach (var r in rs) b.Encapsulate(r.bounds);
            return b;
        }

        // prefab assets have no renderer bounds: stand it at the origin for a moment (root scale kept, as props.measure does)
        static Bounds BoundsOfPrefab(GameObject prefab)
        {
            var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                go.transform.position = Vector3.zero;
                go.transform.rotation = Quaternion.identity;
                return Bounds(go);
            }
            finally { UnityEngine.Object.DestroyImmediate(go); }
        }

        // Triangles the renderers draw, from each mesh's own submeshes (a player's static batching hands every
        // renderer the whole combined mesh, so sharedMesh.triangles there counts it once per renderer).
        static long Triangles(GameObject go)
        {
            long n = 0;
            foreach (var mf in go.GetComponentsInChildren<MeshFilter>())
            {
                var m = mf.sharedMesh;
                var r = mf.GetComponent<MeshRenderer>();
                if (m == null || r == null || !r.enabled) continue;
                for (int s = 0; s < m.subMeshCount; s++) n += m.GetIndexCount(s) / 3;
            }
            return n;
        }

        [BridgeCommand("golfmap.props.stats", "What golfmap.props.place left under 'GolfMap Props': per group (Vehicles, Buildings, ...) and per asset the objects, renderers, shadow casters, triangles (from each mesh's submeshes), distinct materials and renderers with a missing material or the error shader. transforms=true adds each object's position, yaw, tilt and how far its lowest point is above the ground under its origin.",
            args = "group (e.g. Vehicles; default all), transforms=false")]
        static object Stats(BridgeArgs a)
        {
            var root = EditorSceneManager.GetActiveScene().GetRootGameObjects().FirstOrDefault(g => g.name == GolfMapProps.RootName);
            if (root == null) throw new BridgeError("No '" + GolfMapProps.RootName + "' in the scene.");
            var only = a.String("group");
            bool transforms = a.Bool("transforms", false);
            Physics.SyncTransforms();
            var groups = new List<object>();
            foreach (Transform g in root.transform)
            {
                if (only != null && !string.Equals(g.name, only, StringComparison.OrdinalIgnoreCase)) continue;
                var placed = g.Cast<Transform>().Where(t => t.name.Contains("#")).ToList();
                if (placed.Count == 0) continue;
                var assets = new SortedDictionary<string, object>();
                var objects = new List<object>();
                var allMats = new HashSet<Material>();
                int gr = 0, gc = 0, bad = 0; long gt = 0;
                foreach (var grp in placed.GroupBy(t => t.name.Substring(0, t.name.IndexOf('#'))))
                {
                    int rn = 0, cn = 0; long tn = 0;
                    var mats = new HashSet<string>();
                    foreach (var t in grp)
                    {
                        foreach (var r in t.GetComponentsInChildren<Renderer>())
                        {
                            if (!r.enabled) continue;
                            rn++;
                            if (r.shadowCastingMode != ShadowCastingMode.Off) cn++;
                            foreach (var m in r.sharedMaterials)
                            {
                                if (m == null || m.shader == null || m.shader.name == "Hidden/InternalErrorShader") { bad++; continue; }
                                mats.Add(m.name);
                                allMats.Add(m);
                            }
                        }
                        tn += Triangles(t.gameObject);
                        if (!transforms) continue;
                        var b = Bounds(t.gameObject);
                        var ground = GolfMapProps.Ground(t.position.x, t.position.z, root.transform);
                        objects.Add(new Dictionary<string, object>
                        {
                            { "name", t.name }, { "x", Math.Round(t.position.x, 3) }, { "y", Math.Round(t.position.y, 3) }, { "z", Math.Round(t.position.z, 3) },
                            { "yaw", Math.Round(t.eulerAngles.y, 2) }, { "tilt", Math.Round(Vector3.Angle(t.up, Vector3.up), 2) },
                            { "aboveGround", ground == null ? (object)null : Math.Round(b.min.y - ground.Value, 3) },
                            { "collider", t.GetComponentInChildren<Collider>() != null },
                        });
                    }
                    assets[grp.Key] = new Dictionary<string, object> { { "objects", grp.Count() }, { "renderers", rn }, { "shadowCasters", cn }, { "triangles", tn }, { "materials", mats.OrderBy(x => x).ToArray() } };
                    gr += rn; gc += cn; gt += tn;
                }
                var row = new Dictionary<string, object>
                {
                    { "group", g.name }, { "objects", placed.Count }, { "renderers", gr }, { "shadowCasters", gc }, { "triangles", gt },
                    { "materials", allMats.Count }, { "missingMaterials", bad }, { "assets", assets },
                };
                if (transforms) row["transforms"] = objects;
                groups.Add(row);
            }
            return groups;
        }
    }
}
