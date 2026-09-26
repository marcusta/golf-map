// Lift a terrain up to the course meshes lying on it, so anything planted on the
// terrain (VSP grass spawns on the terrain surface) stands on the visible ground.
//
// OPCD's course meshes follow the terrain only roughly: across ditches and dips
// the mesh bridges the hollow, up to tens of centimetres above the heightmap, and
// grass planted in the hollow is buried by the mesh - a bare line along the seam.
// The terrain under a mesh is never seen and GSPro plays on the mesh colliders, so
// raising it there changes nothing else. Only raised, never lowered; the target at
// each heightmap sample is the mesh top there minus a margin. When the Terrain component
// is enabled (drawn), the LOWEST mesh top at the sample and 0.25 m around it is used
// instead, so the terrain cannot poke through the mesh between samples; OPCD course
// scenes usually disable the inner terrain (the meshes are the ground), and then the
// terrain can hug the mesh.
// VSP keeps its own copy of the terrain heights (UnityTerrain), reloaded afterwards.
//
// The TerrainData is copied to <course>/Backups/ first; golfmap.terrain.restore
// puts a backup's heights back. Re-run after a mesh rebuild or a terrain re-import.
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
    static class GolfMapTerrainConform
    {
        static Terrain TerrainFor(GolfMapCourse course, string role)
        {
            var scene = EditorSceneManager.GetActiveScene();
            return role == "outer"
                ? GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer")
                : GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
        }

        [BridgeCommand("golfmap.terrain.conform", "Raise the terrain under the course meshes (Spline_*, Gap_Issue_*) to just below the mesh surface wherever it lies lower, so VSP grass is not buried along seams and dips. Backs up the TerrainData first. Never lowers.",
            args = "terrain=inner|outer (default inner), margin=0.01 (m below the mesh), dryRun=false, debugX/debugZ (report one sample, change nothing)")]
        static IEnumerator Conform(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);   // before any asset work (see GolfMapTerrainSculpt)
            var role = a.String("terrain", "inner");
            float margin = (float)a.Number("margin", 0.01);
            bool dryRun = a.Bool("dryRun", false);
            var terrain = TerrainFor(course, role);
            var td = terrain.terrainData;
            var origin = terrain.transform.position;
            var size = td.size;
            int res = td.heightmapResolution;
            float stepX = size.x / (res - 1), stepZ = size.z / (res - 1);

            // Top mesh height at every heightmap sample (row = z index from the south edge).
            var top = new float[res * res];
            for (int i = 0; i < top.Length; i++) top[i] = float.NegativeInfinity;
            var scene = terrain.gameObject.scene;
            var meshes = UnityEngine.Object.FindObjectsOfType<MeshFilter>()
                .Where(f => f.sharedMesh && f.gameObject.activeInHierarchy && f.gameObject.scene == scene &&
                            (f.name.StartsWith("Spline_", StringComparison.Ordinal) || f.name.StartsWith("Gap_Issue", StringComparison.Ordinal)))
                .ToList();
            int done = 0;
            foreach (var mf in meshes)
            {
                var local = mf.sharedMesh.vertices;
                var m = mf.transform.localToWorldMatrix;
                var world = new Vector3[local.Length];
                for (int i = 0; i < local.Length; i++) world[i] = m.MultiplyPoint3x4(local[i]);
                var tris = mf.sharedMesh.triangles;
                for (int t = 0; t < tris.Length; t += 3)
                {
                    Vector3 p0 = world[tris[t]], p1 = world[tris[t + 1]], p2 = world[tris[t + 2]];
                    float x0 = (p0.x - origin.x) / stepX, z0 = (p0.z - origin.z) / stepZ;
                    float x1 = (p1.x - origin.x) / stepX, z1 = (p1.z - origin.z) / stepZ;
                    float x2 = (p2.x - origin.x) / stepX, z2 = (p2.z - origin.z) / stepZ;
                    int cx0 = Mathf.Max(0, Mathf.CeilToInt(Mathf.Min(x0, Mathf.Min(x1, x2)))), cx1 = Mathf.Min(res - 1, Mathf.FloorToInt(Mathf.Max(x0, Mathf.Max(x1, x2))));
                    int cz0 = Mathf.Max(0, Mathf.CeilToInt(Mathf.Min(z0, Mathf.Min(z1, z2)))), cz1 = Mathf.Min(res - 1, Mathf.FloorToInt(Mathf.Max(z0, Mathf.Max(z1, z2))));
                    if (cx0 > cx1 || cz0 > cz1) continue;
                    float det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
                    if (Mathf.Abs(det) < 1e-9f) continue;
                    for (int cz = cz0; cz <= cz1; cz++)
                        for (int cx = cx0; cx <= cx1; cx++)
                        {
                            float l0 = ((z1 - z2) * (cx - x2) + (x2 - x1) * (cz - z2)) / det;
                            float l1 = ((z2 - z0) * (cx - x2) + (x0 - x2) * (cz - z2)) / det;
                            float l2 = 1 - l0 - l1;
                            if (l0 < -1e-5f || l1 < -1e-5f || l2 < -1e-5f) continue;
                            float y = l0 * p0.y + l1 * p1.y + l2 * p2.y;
                            int idx = cz * res + cx;
                            if (y > top[idx]) top[idx] = y;
                        }
                }
                if (++done % 25 == 0) yield return null;
            }

            var heights = td.GetHeights(0, 0, res, res);   // [z, x], 0..1 of size.y above origin.y
            if (a.Has("debugX"))
            {
                int dx = Mathf.RoundToInt(((float)a.Number("debugX", 0) - origin.x) / stepX), dz = Mathf.RoundToInt(((float)a.Number("debugZ", 0) - origin.z) / stepZ);
                float wx0 = origin.x + dx * stepX, wz0 = origin.z + dz * stepZ;
                yield return new Dictionary<string, object>
                {
                    { "sample", new object[] { dx, dz, wx0, wz0 } }, { "terrainEnabled", terrain.enabled },
                    { "heightmapY", origin.y + heights[dz, dx] * size.y }, { "sampleHeight", terrain.SampleHeight(new Vector3(wx0, 0, wz0)) + origin.y },
                    { "rasterTop", top[dz * res + dx] }, { "rayTop", MeshTopAt(wx0, wz0) },
                    { "rayAround", new object[] { MeshTopAt(wx0 + 0.25f, wz0), MeshTopAt(wx0 - 0.25f, wz0), MeshTopAt(wx0, wz0 + 0.25f), MeshTopAt(wx0, wz0 - 0.25f) } },
                };
                yield break;
            }
            int raised = 0, clamped = 0;
            var raisedBy = new Dictionary<int, float>();   // for the sculpt capture: a conform is not a sculpt
            double sumCm = 0, maxCm = 0;
            const float probe = 0.25f;
            var offsets = new[] { new Vector2(probe, 0), new Vector2(-probe, 0), new Vector2(0, probe), new Vector2(0, -probe) };
            for (int z = 0; z < res; z++)
            {
                for (int x = 0; x < res; x++)
                {
                    float own = top[z * res + x];
                    if (float.IsNegativeInfinity(own)) continue;
                    float ground = origin.y + heights[z, x] * size.y;
                    if (own - margin <= ground) continue;
                    float low = own;
                    if (terrain.enabled)
                    {
                        float wx = origin.x + x * stepX, wz = origin.z + z * stepZ;
                        foreach (var o in offsets)
                        {
                            float m = MeshTopAt(wx + o.x, wz + o.y);
                            if (!float.IsNegativeInfinity(m) && m < low) low = m;
                        }
                    }
                    float target = (low - margin - origin.y) / size.y;
                    if (target <= heights[z, x]) continue;
                    if (target > 1f) { target = 1f; clamped++; }
                    double cm = (target - heights[z, x]) * size.y * 100;
                    raisedBy[z * res + x] = (target - heights[z, x]) * size.y;
                    sumCm += cm; if (cm > maxCm) maxCm = cm;
                    heights[z, x] = target;
                    raised++;
                }
                if (z % 256 == 0) yield return null;
            }

            string backup = null;
            if (!dryRun && raised > 0)
            {
                var dataPath = AssetDatabase.GetAssetPath(td);
                var folder = GolfMapCourses.Folder(course) + "Backups";
                if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(GolfMapCourses.Folder(course).TrimEnd('/'), "Backups");
                backup = folder + "/" + td.name + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".asset";
                if (!AssetDatabase.CopyAsset(dataPath, backup)) throw new BridgeError("Could not back up " + dataPath + " to " + backup + "; nothing changed.");
                td.SetHeights(0, 0, heights);
                terrain.Flush();
                EditorUtility.SetDirty(td);
                AssetDatabase.SaveAssets();
                RefreshVsp(terrain);
                GolfMapTerrainSculpt.RecordConform(courseFolder, role, raisedBy);
            }
            float cell2 = stepX * stepZ;
            yield return new Dictionary<string, object>
            {
                { "terrain", terrain.name }, { "terrainDrawn", terrain.enabled }, { "meshes", meshes.Count }, { "dryRun", dryRun },
                { "raisedM2", Math.Round(raised * cell2) }, { "meanRaiseCm", raised > 0 ? Math.Round(sumCm / raised, 1) : 0 },
                { "maxRaiseCm", Math.Round(maxCm, 1) }, { "clampedToTerrainTop", clamped }, { "backup", backup },
            };
        }

        [BridgeCommand("golfmap.terrain.restore", "Put a TerrainData backup's heights back onto the terrain (golfmap.terrain.conform writes backups to <course>/Backups/).",
            args = "backup (asset path), terrain=inner|outer (default inner)")]
        static object Restore(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var terrain = TerrainFor(course, a.String("terrain", "inner"));
            var path = a.Require("backup");
            var src = AssetDatabase.LoadAssetAtPath<TerrainData>(path);
            if (!src) throw new BridgeError("No TerrainData at " + path + ".");
            var td = terrain.terrainData;
            if (src.heightmapResolution != td.heightmapResolution) throw new BridgeError("Backup resolution " + src.heightmapResolution + " != terrain " + td.heightmapResolution + ".");
            int res = td.heightmapResolution;
            td.SetHeights(0, 0, src.GetHeights(0, 0, res, res));
            terrain.Flush();
            EditorUtility.SetDirty(td);
            AssetDatabase.SaveAssets();
            RefreshVsp(terrain);
            return new Dictionary<string, object> { { "terrain", terrain.name }, { "restoredFrom", path } };
        }

        // Top course-mesh collider hit straight down at (x, z); -inf when none.
        static float MeshTopAt(float x, float z)
        {
            float best = float.NegativeInfinity;
            foreach (var h in Physics.RaycastAll(new Vector3(x, 10000f, z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore))
            {
                var n = h.collider.name;
                if ((n.StartsWith("Spline_", StringComparison.Ordinal) || n.StartsWith("Gap_Issue", StringComparison.Ordinal)) && h.point.y > best) best = h.point.y;
            }
            return best;
        }

        internal static void RefreshVsp(Terrain terrain)
        {
            // VSP samples its own cached copy of the heightmap.
            var vspTerrain = terrain.GetComponent<UnityTerrain>();
            if (vspTerrain) vspTerrain.RefreshTerrainData();
            foreach (var system in UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>().Where(s => GolfMapZoneImporter.SystemMatchesTerrain(s, terrain)))
            {
                system.RefreshVegetationSystem();
                system.ClearCache();
            }
            SceneView.RepaintAll();
        }
    }
}
