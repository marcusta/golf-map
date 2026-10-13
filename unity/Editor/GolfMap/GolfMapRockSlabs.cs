// Rock slabs: course meshes cut out of the ground into their own objects by the Blender shaping op
// golfmap.cut_out (Spline_<name>_Rock_-_Mesh, surface class Slab). OPCD's Set Default Materials knows no such
// surface, so a (re-)added slab comes with its FBX material and no physics material. This gives every slab the
// course's rock material and stone physics material (GSPro reads bounce and roll off the collider's material),
// from <course>/rock-slabs.json:
//
//   { "format": "golfmap-rock-slabs-v1", "material": "<asset path of a Material>",
//     "physicMaterial": "Assets/Resources/Physics/GSPstone.physicMaterial" }
//
// The slab meshes carry planar UVs in metres / uvM (the cut-out's `uvM`), so any tiling rock material works.
// golfmap.course.refresh runs it after meshes.sync.
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
    public static class GolfMapRockSlabs
    {
        public const string Format = "golfmap-rock-slabs-v1";
        const string SpecFile = "rock-slabs.json";   // GolfMapCourses.Folder ends with a slash
        const string DefaultPhysics = "Assets/Resources/Physics/GSPstone.physicMaterial";

        // OPCD's channel store off every slab of the scene; returns how many had one. OPCD's Set Default Materials
        // reads every store of the scene on each run, whatever is selected, and logs some 40 "Material doesn't
        // have a ... property" errors per slab that carries one (the rock material has no MAHS channels). Called
        // before each such run and by golfmap.slabs.materials.
        public static int StripChannelStores(UnityEngine.SceneManagement.Scene scene)
        {
            int n = 0;
            foreach (var f in UnityEngine.Object.FindObjectsOfType<MeshFilter>())
            {
                if (f.gameObject.scene != scene || !IsSlab(f.name)) continue;
                var store = f.GetComponent("MeshChannelMaterialsStore");
                if (store == null) continue;
                Undo.DestroyObjectImmediate(store);
                n++;
            }
            return n;
        }

        public static bool IsSlab(string name)
        {
            return GolfMapSurfaces.IsCourseMesh(name) && GolfMapSurfaces.Classify(name) == GolfMapSurfaces.Surface.Slab;
        }

        [BridgeCommand("golfmap.slabs.materials", "Give every rock slab mesh (Spline_<name>_Rock_-_Mesh, cut out by Blender's golfmap.cut_out) the course's rock material and stone physics material from <course>/rock-slabs.json. material= / physicMaterial= write the spec first. Marks the scene dirty, does not save it.",
            args = "material (asset path of a Material; stored in the spec), physicMaterial (asset path; default GSPstone), dryRun=false")]
        static object Command(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var file = GolfMapCourses.Folder(course) + SpecFile;
            if (a.Has("material") || a.Has("physicMaterial"))
            {
                var old = File.Exists(file) ? GolfMapJsonDoc.ParseObject(File.ReadAllText(file)) : null;
                var doc = new Dictionary<string, object>
                {
                    { "format", Format },
                    { "material", a.String("material", old != null ? old.String("material") : null) },
                    { "physicMaterial", a.String("physicMaterial", old != null && old.String("physicMaterial") != null ? old.String("physicMaterial") : DefaultPhysics) },
                };
                if (!a.Bool("dryRun", false))
                {
                    File.WriteAllText(file, BridgeJson.Write(doc));
                    AssetDatabase.ImportAsset(file);
                }
            }
            return Apply(a.Bool("dryRun", false));
        }

        // only: just these objects (course.refresh only=), null = every slab in the scene
        internal static Dictionary<string, object> Apply(bool dryRun, ICollection<string> only = null)
        {
            var course = GolfMapCourses.Require();
            var file = GolfMapCourses.Folder(course) + SpecFile;
            var scene = EditorSceneManager.GetActiveScene();
            var slabs = UnityEngine.Object.FindObjectsOfType<MeshFilter>()
                .Where(f => f.gameObject.scene == scene && IsSlab(f.name) && (only == null || only.Contains(f.name)))
                .OrderBy(f => f.name, StringComparer.Ordinal).ToList();
            var result = new Dictionary<string, object> { { "spec", file }, { "dryRun", dryRun }, { "slabs", slabs.Count } };
            if (!File.Exists(file))
            {
                result["status"] = slabs.Count == 0 ? "no slabs, no spec" : "no spec: the slabs keep their FBX material and no physics material (golfmap.slabs.materials material=<asset path>)";
                return result;
            }
            var spec = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            var matPath = spec.String("material");
            var physPath = spec.String("physicMaterial") ?? DefaultPhysics;
            var mat = string.IsNullOrEmpty(matPath) ? null : AssetDatabase.LoadAssetAtPath<Material>(matPath);
            if (!string.IsNullOrEmpty(matPath) && mat == null) throw new BridgeError(file + ": material " + matPath + " is not a Material.");
            var phys = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(physPath);
            if (phys == null) throw new BridgeError(file + ": physicMaterial " + physPath + " is not a PhysicMaterial.");
            var rows = new List<object>();
            int changed = 0;
            foreach (var f in slabs)
            {
                var r = f.GetComponent<MeshRenderer>();
                var c = f.GetComponent<MeshCollider>();
                bool hasUv = f.sharedMesh != null && f.sharedMesh.uv != null && f.sharedMesh.uv.Length == f.sharedMesh.vertexCount;
                bool did = false;
                if (mat != null && r != null && r.sharedMaterial != mat)
                {
                    if (!dryRun) { Undo.RecordObject(r, "Rock slab material"); r.sharedMaterials = new[] { mat }; }
                    did = true;
                }
                if (c != null && c.sharedMaterial != phys)
                {
                    if (!dryRun) { Undo.RecordObject(c, "Rock slab physics"); c.sharedMaterial = phys; }
                    did = true;
                }
                // OPCD's channel store, left by a Set Default Materials that took the slab for the surface it was cut
                // from: on the rock material it makes OPCD log "Material doesn't have a color property
                // '_RedOverallColor'" (and the other MAHS channels) whenever it reads the store again.
                var store = f.GetComponent("MeshChannelMaterialsStore");
                if (store != null)
                {
                    if (!dryRun) Undo.DestroyObjectImmediate(store);
                    did = true;
                }
                if (did) changed++;
                rows.Add(new Dictionary<string, object>
                {
                    { "object", f.name }, { "changed", did }, { "uv", hasUv }, { "collider", c != null },
                    { "vertices", f.sharedMesh != null ? f.sharedMesh.vertexCount : 0 },
                });
            }
            if (changed > 0 && !dryRun) EditorSceneManager.MarkSceneDirty(scene);
            result["material"] = mat != null ? matPath : null;
            result["physicMaterial"] = physPath;
            result["changed"] = changed;
            result["objects"] = rows;
            var noUv = rows.Cast<Dictionary<string, object>>().Where(o => !(bool)o["uv"]).Select(o => o["object"]).ToList();
            if (noUv.Count > 0) result["warnings"] = new List<object> { "no UVs (a textured material draws one flat colour): " + string.Join(", ", noUv.Select(o => o.ToString()).ToArray()) };
            return result;
        }
    }
}
