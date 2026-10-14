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
// mode=match (the Blender shaping loop: meshes dug and raised in Blender) moves the
// terrain both ways: every sample under a mesh goes to exactly `margin` below the mesh
// top (lowered under a dug bunker, raised under a built-up tee), and the change fades
// out over `featherM` outside the meshes' footprint (inverse-distance mean of the
// nearest edge samples' change, smoothstep falloff), so no cliff is left at the edge.
// With the terrain drawn, the lowest top of the sample and its four neighbours is used
// (raster, not the raise mode's raycasts: match touches every covered sample).
// VSP keeps its own copy of the terrain heights (UnityTerrain), reloaded afterwards.
//
// The TerrainData is copied to <course>/Backups/ first (a run limited to rectangles - x0..z1, or
// golfmap.course.refresh only= - saves just its heightmap window as a .heights file); golfmap.terrain.restore
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

        [BridgeCommand("golfmap.terrain.conform", "mode=raise (default): raise the terrain under the course meshes (Spline_*, Gap_Issue_*) to just below the mesh surface wherever it lies lower, so VSP grass is not buried along seams and dips; never lowers. mode=match: put the terrain under the meshes at exactly margin below the mesh surface (raise AND lower, for meshes shaped in Blender), feathered back to the untouched terrain over featherM outside the meshes. Backs up the TerrainData first (a windowed run - x0..z1 - backs up just its window: <course>/Backups/*.heights, golfmap.terrain.restore takes either).",
            args = "mode=raise|match, terrain=inner|outer (default inner), margin=0.01 (m below the mesh), featherM=2 (match: fade-out band outside the meshes), dryRun=false (counts only), debugX/debugZ (report one sample, change nothing), x0/z0/x1/z1 (world rectangle: change only inside it; only the meshes over it are read), " + GolfMapSceneSave.Arg)]
        internal static IEnumerator Conform(BridgeArgs a) { return Conform(a, null); }

        // within (golfmap.course.refresh only=): change only inside these world XZ rectangles (the union); only the meshes
        // over them are rasterised and only the heightmap window around them is read, written and backed up, so a
        // per-feature run takes a fraction of a second. Replaces x0..z1 when given.
        internal static IEnumerator Conform(BridgeArgs a, IList<Rect> within)
        {
            var laps = new Laps();
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);   // before any asset work (see GolfMapTerrainSculpt)
            var role = a.String("terrain", "inner");
            float margin = (float)a.Number("margin", 0.01);
            bool dryRun = a.Bool("dryRun", false);
            var mode = a.String("mode", "raise");
            if (mode != "raise" && mode != "match") throw new BridgeError("mode must be raise or match.");
            float featherM = Mathf.Clamp((float)a.Number("featherM", 2), 0f, 50f);
            var terrain = TerrainFor(course, role);
            var td = terrain.terrainData;
            var origin = terrain.transform.position;
            var size = td.size;
            int res = td.heightmapResolution;
            float stepX = size.x / (res - 1), stepZ = size.z / (res - 1);
            if ((within == null || within.Count == 0) && a.Has("x0"))
            {
                float rx0 = (float)a.Number("x0", 0), rz0 = (float)a.Number("z0", 0), rx1 = (float)a.Number("x1", 0), rz1 = (float)a.Number("z1", 0);
                within = new List<Rect> { Rect.MinMaxRect(Mathf.Min(rx0, rx1), Mathf.Min(rz0, rz1), Mathf.Max(rx0, rx1), Mathf.Max(rz0, rz1)) };
            }
            if (within != null && within.Count == 0) within = null;

            // The heightmap window worked on: the whole grid, or the samples around the rectangles.
            var win = new Window { x0 = 0, z0 = 0, w = res, h = res, res = res };
            Rect union = new Rect();
            if (within != null)
            {
                union = within[0];
                foreach (var r in within.Skip(1)) union = Rect.MinMaxRect(Mathf.Min(union.xMin, r.xMin), Mathf.Min(union.yMin, r.yMin), Mathf.Max(union.xMax, r.xMax), Mathf.Max(union.yMax, r.yMax));
                int ix0 = Mathf.Clamp(Mathf.FloorToInt((union.xMin - origin.x) / stepX) - 1, 0, res - 1), ix1 = Mathf.Clamp(Mathf.CeilToInt((union.xMax - origin.x) / stepX) + 1, 0, res - 1);
                int iz0 = Mathf.Clamp(Mathf.FloorToInt((union.yMin - origin.z) / stepZ) - 1, 0, res - 1), iz1 = Mathf.Clamp(Mathf.CeilToInt((union.yMax - origin.z) / stepZ) + 1, 0, res - 1);
                if (ix1 < ix0 || iz1 < iz0) throw new BridgeError("The rectangle is outside the terrain " + terrain.name + ".");
                win = new Window { x0 = ix0, z0 = iz0, w = ix1 - ix0 + 1, h = iz1 - iz0 + 1, res = res };
            }

            // Top mesh height at every heightmap sample of the window (row = z index from the window's south edge).
            var top = new float[win.w * win.h];
            for (int i = 0; i < top.Length; i++) top[i] = float.NegativeInfinity;
            var scene = terrain.gameObject.scene;
            var meshes = UnityEngine.Object.FindObjectsOfType<MeshFilter>()
                .Where(f => f.sharedMesh && f.gameObject.activeInHierarchy && f.gameObject.scene == scene &&
                            (f.name.StartsWith("Spline_", StringComparison.Ordinal) || f.name.StartsWith("Gap_Issue", StringComparison.Ordinal)) &&
                            !GolfMapWaterplanes.IsWaterPlane(f.name))
                .ToList();
            if (within != null)
            {
                // only the meshes over the window (a little margin: renderer bounds are the mesh's, samples are points)
                meshes = meshes.Where(f =>
                {
                    var r = f.GetComponent<Renderer>();
                    if (r == null) return true;
                    var b = r.bounds;
                    return b.max.x >= union.xMin - stepX && b.min.x <= union.xMax + stepX && b.max.z >= union.yMin - stepZ && b.min.z <= union.yMax + stepZ;
                }).ToList();
            }
            laps.Mark("findMeshes");
            int done = 0;
            foreach (var mf in meshes)
            {
                var local = mf.sharedMesh.vertices;
                var m = mf.transform.localToWorldMatrix;
                var world = new Vector3[local.Length];
                for (int i = 0; i < local.Length; i++) world[i] = m.MultiplyPoint3x4(local[i]);
                var tris = mf.sharedMesh.triangles;
                int gx1 = win.x0 + win.w - 1, gz1 = win.z0 + win.h - 1;
                for (int t = 0; t < tris.Length; t += 3)
                {
                    Vector3 p0 = world[tris[t]], p1 = world[tris[t + 1]], p2 = world[tris[t + 2]];
                    float x0 = (p0.x - origin.x) / stepX, z0 = (p0.z - origin.z) / stepZ;
                    float x1 = (p1.x - origin.x) / stepX, z1 = (p1.z - origin.z) / stepZ;
                    float x2 = (p2.x - origin.x) / stepX, z2 = (p2.z - origin.z) / stepZ;
                    int cx0 = Mathf.Max(win.x0, Mathf.CeilToInt(Mathf.Min(x0, Mathf.Min(x1, x2)))), cx1 = Mathf.Min(gx1, Mathf.FloorToInt(Mathf.Max(x0, Mathf.Max(x1, x2))));
                    int cz0 = Mathf.Max(win.z0, Mathf.CeilToInt(Mathf.Min(z0, Mathf.Min(z1, z2)))), cz1 = Mathf.Min(gz1, Mathf.FloorToInt(Mathf.Max(z0, Mathf.Max(z1, z2))));
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
                            int idx = (cz - win.z0) * win.w + (cx - win.x0);
                            if (y > top[idx]) top[idx] = y;
                        }
                }
                ++done;
                if (laps.Due()) yield return null;
            }

            laps.Mark("raster");
            var heights = td.GetHeights(win.x0, win.z0, win.w, win.h);   // [z, x] of the window, 0..1 of size.y above origin.y
            laps.Mark("getHeights");
            if (a.Has("debugX"))
            {
                int dx = Mathf.RoundToInt(((float)a.Number("debugX", 0) - origin.x) / stepX), dz = Mathf.RoundToInt(((float)a.Number("debugZ", 0) - origin.z) / stepZ);
                if (dx < win.x0 || dz < win.z0 || dx >= win.x0 + win.w || dz >= win.z0 + win.h) throw new BridgeError("debugX/debugZ is outside the rectangle.");
                float wx0 = origin.x + dx * stepX, wz0 = origin.z + dz * stepZ;
                yield return new Dictionary<string, object>
                {
                    { "sample", new object[] { dx, dz, wx0, wz0 } }, { "terrainEnabled", terrain.enabled },
                    { "heightmapY", origin.y + heights[dz - win.z0, dx - win.x0] * size.y }, { "sampleHeight", terrain.SampleHeight(new Vector3(wx0, 0, wz0)) + origin.y },
                    { "rasterTop", top[(dz - win.z0) * win.w + (dx - win.x0)] }, { "rayTop", MeshTopAt(wx0, wz0) },
                    { "rayAround", new object[] { MeshTopAt(wx0 + 0.25f, wz0), MeshTopAt(wx0 - 0.25f, wz0), MeshTopAt(wx0, wz0 + 0.25f), MeshTopAt(wx0, wz0 - 0.25f) } },
                };
                yield break;
            }
            if (mode == "match")
            {
                var steps = Match(terrain, heights, top, win, meshes.Count, margin, featherM, dryRun, courseFolder, role, within, laps);
                while (steps.MoveNext()) yield return steps.Current;
                yield break;
            }
            int raised = 0, clamped = 0;
            var raisedBy = new Dictionary<int, float>();   // for the sculpt capture: a conform is not a sculpt (full-grid index)
            double sumCm = 0, maxCm = 0;
            const float probe = 0.25f;
            var offsets = new[] { new Vector2(probe, 0), new Vector2(-probe, 0), new Vector2(0, probe), new Vector2(0, -probe) };
            for (int z = 0; z < win.h; z++)
            {
                for (int x = 0; x < win.w; x++)
                {
                    float own = top[z * win.w + x];
                    if (float.IsNegativeInfinity(own)) continue;
                    float wx = origin.x + (win.x0 + x) * stepX, wz = origin.z + (win.z0 + z) * stepZ;
                    if (within != null && !InsideAny(within, wx, wz)) continue;
                    float ground = origin.y + heights[z, x] * size.y;
                    if (own - margin <= ground) continue;
                    float low = own;
                    if (terrain.enabled)
                    {
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
                    raisedBy[win.Global(x, z)] = (target - heights[z, x]) * size.y;
                    sumCm += cm; if (cm > maxCm) maxCm = cm;
                    heights[z, x] = target;
                    raised++;
                }
                if (laps.Due()) yield return null;
            }

            string backup = null;
            if (!dryRun && raised > 0)
            {
                backup = Backup(td, courseFolder, win, "");
                td.SetHeights(win.x0, win.z0, heights);
                terrain.Flush();
                EditorUtility.SetDirty(td);
                AssetDatabase.SaveAssets();
                RefreshVsp(terrain, within == null ? (Bounds?)null : WindowBounds(terrain, win));
                GolfMapTerrainSculpt.RecordConform(courseFolder, role, raisedBy);
            }
            float cell2 = stepX * stepZ;
            var result = new Dictionary<string, object>
            {
                { "mode", "raise" }, { "terrain", terrain.name }, { "terrainDrawn", terrain.enabled }, { "meshes", meshes.Count }, { "dryRun", dryRun },
                { "samplesRise", raised }, { "raisedM2", Math.Round(raised * cell2) }, { "meanRaiseCm", raised > 0 ? Math.Round(sumCm / raised, 1) : 0 },
                { "maxRaiseCm", Math.Round(maxCm, 1) }, { "clampedToTerrainTop", clamped }, { "backup", backup },
            };
            if (within != null) result["window"] = win.ToJson();
            yield return result;
        }

        // The part of the heightmap a run reads and writes (samples; x0/z0 from the south-west corner).
        sealed class Window
        {
            public int x0, z0, w, h, res;
            public bool Full { get { return x0 == 0 && z0 == 0 && w == res && h == res; } }
            public int Global(int x, int z) { return (z0 + z) * res + (x0 + x); }
            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object> { { "x0", x0 }, { "z0", z0 }, { "w", w }, { "h", h }, { "samples", w * h } };
            }
        }

        static bool InsideAny(IList<Rect> rects, float x, float z)
        {
            for (int i = 0; i < rects.Count; i++) if (rects[i].Contains(new Vector2(x, z))) return true;
            return false;
        }

        // Before a write: the whole TerrainData copied as an asset, or for a window only its heights, as
        // <course>/Backups/<terrain>-<stamp><suffix>.heights (golfmap-heights-v1: int x0, z0, w, h, res, then w*h floats
        // row by row from the south), which golfmap.terrain.restore also takes. A per-feature refresh then does not
        // copy 36 MB every time.
        static string Backup(TerrainData td, string courseFolder, Window win, string suffix)
        {
            var folder = courseFolder + "Backups";
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Backups");
            var stamp = td.name + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + suffix;
            if (win.Full)
            {
                var dataPath = AssetDatabase.GetAssetPath(td);
                var backup = folder + "/" + stamp + ".asset";
                if (!AssetDatabase.CopyAsset(dataPath, backup)) throw new BridgeError("Could not back up " + dataPath + " to " + backup + "; nothing changed.");
                return backup;
            }
            var path = folder + "/" + stamp + HeightsExtension;
            var old = td.GetHeights(win.x0, win.z0, win.w, win.h);
            using (var w = new BinaryWriter(File.Create(path)))
            {
                w.Write(HeightsMagic);
                w.Write(win.x0); w.Write(win.z0); w.Write(win.w); w.Write(win.h); w.Write(win.res);
                for (int z = 0; z < win.h; z++) for (int x = 0; x < win.w; x++) w.Write(old[z, x]);
            }
            return path;
        }

        const string HeightsExtension = ".heights";
        const int HeightsMagic = 0x31484D47;   // "GMH1"

        // mode=match: see the header. heights is the window's [z, x] grid (0..1), top the highest mesh top per window
        // sample (-inf where no mesh). Yields null between chunks and the result last.
        static IEnumerator Match(Terrain terrain, float[,] heights, float[] top, Window win, int meshCount, float margin, float featherM, bool dryRun,
            string courseFolder, string role, IList<Rect> within, Laps laps)
        {
            var td = terrain.terrainData;
            var origin = terrain.transform.position;
            var size = td.size;
            int W = win.w, H = win.h;
            float stepX = size.x / (win.res - 1), stepZ = size.z / (win.res - 1);
            Func<int, int, bool> inside = (x, z) => within == null || InsideAny(within, origin.x + (win.x0 + x) * stepX, origin.z + (win.z0 + z) * stepZ);

            // Under the meshes: the change that puts each sample at margin below the mesh top (0..1 units).
            var covered = new bool[W * H];
            var delta = new float[W * H];
            int clampedLow = 0, clampedHigh = 0, coveredCount = 0;
            for (int z = 0; z < H; z++)
            {
                for (int x = 0; x < W; x++)
                {
                    int idx = z * W + x;
                    float own = top[idx];
                    if (float.IsNegativeInfinity(own) || !inside(x, z)) continue;
                    float low = own;
                    if (terrain.enabled)
                    {
                        if (x > 0 && top[idx - 1] < low && !float.IsNegativeInfinity(top[idx - 1])) low = top[idx - 1];
                        if (x < W - 1 && top[idx + 1] < low && !float.IsNegativeInfinity(top[idx + 1])) low = top[idx + 1];
                        if (z > 0 && top[idx - W] < low && !float.IsNegativeInfinity(top[idx - W])) low = top[idx - W];
                        if (z < H - 1 && top[idx + W] < low && !float.IsNegativeInfinity(top[idx + W])) low = top[idx + W];
                    }
                    float target = (low - margin - origin.y) / size.y;
                    if (target > 1f) { target = 1f; clampedHigh++; }
                    if (target < 0f) { target = 0f; clampedLow++; }
                    covered[idx] = true;
                    delta[idx] = target - heights[z, x];
                    coveredCount++;
                }
                if (laps.Due()) yield return null;
            }

            // Outside them, within featherM: the edge samples' change, weighted 1/d^2, faded out with the distance to
            // the nearest edge sample (smoothstep). Samples between two meshes take a mix of both sides.
            var feather = new Dictionary<int, Vector3>();   // x = sum w, y = sum w*delta, z = nearest edge distance
            int r = featherM > 0 ? Mathf.CeilToInt(featherM / Mathf.Min(stepX, stepZ)) : 0;
            if (r > 0)
            {
                for (int z = 0; z < H; z++)
                {
                    for (int x = 0; x < W; x++)
                    {
                        int idx = z * W + x;
                        if (!covered[idx]) continue;
                        bool edge = (x > 0 && !covered[idx - 1]) || (x < W - 1 && !covered[idx + 1]) || (z > 0 && !covered[idx - W]) || (z < H - 1 && !covered[idx + W]);
                        if (!edge) continue;
                        float d0 = delta[idx];
                        for (int dz = -r; dz <= r; dz++)
                        {
                            int nz = z + dz;
                            if (nz < 0 || nz >= H) continue;
                            for (int dx = -r; dx <= r; dx++)
                            {
                                int nx = x + dx;
                                if (nx < 0 || nx >= W) continue;
                                int n = nz * W + nx;
                                if (covered[n]) continue;
                                float dist = Mathf.Sqrt(dx * stepX * dx * stepX + dz * stepZ * dz * stepZ);
                                if (dist > featherM || !inside(nx, nz)) continue;
                                float w = 1f / (dist * dist);
                                Vector3 acc;
                                if (!feather.TryGetValue(n, out acc)) acc = new Vector3(0, 0, float.PositiveInfinity);
                                feather[n] = new Vector3(acc.x + w, acc.y + w * d0, Mathf.Min(acc.z, dist));
                            }
                        }
                    }
                    if (laps.Due()) yield return null;
                }
            }

            // Apply (to the local grid), count, and remember the change for the sculpt capture (full-grid index).
            const float minChangeM = 0.001f;   // below the 16-bit heightmap step on most terrains: not a change
            int rose = 0, fell = 0, featherRose = 0, featherFell = 0;
            double maxRise = 0, maxFall = 0, sumAbs = 0;
            var changedBy = dryRun ? null : new Dictionary<int, float>();
            Action<int, float, bool> apply = (idx, d, isFeather) =>
            {
                float m = d * size.y;
                if (Mathf.Abs(m) < minChangeM) return;
                int z = idx / W, x = idx % W;
                heights[z, x] = Mathf.Clamp01(heights[z, x] + d);
                if (m > 0) { if (isFeather) featherRose++; else rose++; maxRise = Math.Max(maxRise, m); }
                else { if (isFeather) featherFell++; else fell++; maxFall = Math.Max(maxFall, -m); }
                sumAbs += Mathf.Abs(m);
                if (changedBy != null) changedBy[win.Global(x, z)] = m;
            };
            for (int idx = 0; idx < covered.Length; idx++)
                if (covered[idx]) apply(idx, delta[idx], false);
            foreach (var kv in feather)
            {
                float t = 1f - kv.Value.z / featherM;
                t = t * t * (3f - 2f * t);
                apply(kv.Key, kv.Value.y / kv.Value.x * t, true);
            }
            if (laps.Due()) yield return null;
            laps.Mark("match");

            string backup = null;
            int changed = rose + fell + featherRose + featherFell;
            if (!dryRun && changed > 0)
            {
                backup = Backup(td, courseFolder, win, "-match");
                laps.Mark("backup");
                td.SetHeights(win.x0, win.z0, heights);
                terrain.Flush();
                laps.Mark("setHeights");
                EditorUtility.SetDirty(td);
                AssetDatabase.SaveAssets();
                laps.Mark("saveAssets");
                RefreshVsp(terrain, within == null ? (Bounds?)null : WindowBounds(terrain, win));
                laps.Mark("vsp");
                GolfMapTerrainSculpt.RecordConform(courseFolder, role, changedBy);
                laps.Mark("recordConform");
            }
            float cell2 = stepX * stepZ;
            var result = new Dictionary<string, object>
            {
                { "mode", "match" }, { "terrain", terrain.name }, { "terrainDrawn", terrain.enabled }, { "meshes", meshCount }, { "dryRun", dryRun },
                { "marginM", margin }, { "featherM", featherM },
                { "samplesUnderMeshes", coveredCount }, { "samplesFeathered", feather.Count },
                { "samplesRise", rose }, { "samplesFall", fell }, { "featherRise", featherRose }, { "featherFall", featherFell },
                { "changedM2", Math.Round(changed * cell2) },
                { "maxRiseCm", Math.Round(maxRise * 100, 1) }, { "maxFallCm", Math.Round(maxFall * 100, 1) },
                { "meanChangeCm", changed > 0 ? Math.Round(sumAbs / changed * 100, 1) : 0 },
                { "clampedToTerrainTop", clampedHigh }, { "clampedToTerrainBottom", clampedLow }, { "backup", backup },
            };
            if (within != null) result["window"] = win.ToJson();
            result["timings"] = laps.times;
            yield return result;
        }

        // Seconds per part of a run (the result's `timings`), for profiling the per-feature path.
        internal sealed class Laps
        {
            readonly System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            public readonly Dictionary<string, object> times = new Dictionary<string, object>();
            System.Diagnostics.Stopwatch sinceYield = System.Diagnostics.Stopwatch.StartNew();
            /// True (and restarts) once 0.2 s of work has passed since the last true: yield a frame then. A yield costs
            /// an editor frame (up to seconds on a big scene), so small windows run in one go.
            public bool Due()
            {
                if (sinceYield.ElapsedMilliseconds < 200) return false;
                sinceYield.Reset();
                sinceYield.Start();
                return true;
            }
            public void Mark(string part)
            {
                object prev;
                double t = sw.Elapsed.TotalSeconds + (times.TryGetValue(part, out prev) ? (double)prev : 0);
                times[part] = Math.Round(t, 3);
                sw.Reset();
                sw.Start();
            }
        }

        [BridgeCommand("golfmap.terrain.restore", "Put a backup's heights back onto the terrain: a TerrainData asset (golfmap.terrain.conform's full backups in <course>/Backups/) or a window's .heights file (a windowed conform, e.g. golfmap.course.refresh only=).",
            args = "backup (asset path), terrain=inner|outer (default inner)")]
        static object Restore(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var terrain = TerrainFor(course, a.String("terrain", "inner"));
            var path = a.Require("backup");
            var td = terrain.terrainData;
            int res = td.heightmapResolution;
            if (path.EndsWith(HeightsExtension, StringComparison.OrdinalIgnoreCase))
            {
                if (!File.Exists(path)) throw new BridgeError("No heights backup at " + path + ".");
                using (var rd = new BinaryReader(File.OpenRead(path)))
                {
                    if (rd.ReadInt32() != HeightsMagic) throw new BridgeError(path + " is not a golfmap heights backup.");
                    int x0 = rd.ReadInt32(), z0 = rd.ReadInt32(), w = rd.ReadInt32(), h = rd.ReadInt32(), bres = rd.ReadInt32();
                    if (bres != res) throw new BridgeError("Backup resolution " + bres + " != terrain " + res + ".");
                    var grid = new float[h, w];
                    for (int z = 0; z < h; z++) for (int x = 0; x < w; x++) grid[z, x] = rd.ReadSingle();
                    td.SetHeights(x0, z0, grid);
                }
            }
            else
            {
                var src = AssetDatabase.LoadAssetAtPath<TerrainData>(path);
                if (!src) throw new BridgeError("No TerrainData at " + path + ".");
                if (src.heightmapResolution != res) throw new BridgeError("Backup resolution " + src.heightmapResolution + " != terrain " + res + ".");
                td.SetHeights(0, 0, src.GetHeights(0, 0, res, res));
            }
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
                if ((n.StartsWith("Spline_", StringComparison.Ordinal) || n.StartsWith("Gap_Issue", StringComparison.Ordinal)) && !GolfMapWaterplanes.IsWaterPlane(n) && h.point.y > best) best = h.point.y;
            }
            return best;
        }

        // Lower the inner terrain to `margin` under the given mesh points wherever it is above them (the stone walls'
        // ground lowered a course mesh there, and VSP grass on the terrain would float over it): every heightmap vertex
        // within `radius` of a point takes the lowest such point's height. Backs up the TerrainData first; recorded in
        // the conform record (negative), so a sculpt capture does not read it as a sculpt. Returns what changed.
        internal static Dictionary<string, object> LowerUnder(string courseFolder, Terrain terrain, IList<Vector3> points, float radius = 0.6f, float margin = 0.01f)
        {
            var result = new Dictionary<string, object> { { "terrain", terrain.name }, { "lowered", 0 } };
            if (points.Count == 0) return result;
            var td = terrain.terrainData;
            int res = td.heightmapResolution;
            var origin = terrain.transform.position; var size = td.size;
            float stepX = size.x / (res - 1), stepZ = size.z / (res - 1);
            var target = new Dictionary<int, float>();
            foreach (var p in points)
            {
                int x0 = Mathf.Max(0, Mathf.FloorToInt((p.x - radius - origin.x) / stepX)), x1 = Mathf.Min(res - 1, Mathf.CeilToInt((p.x + radius - origin.x) / stepX));
                int z0 = Mathf.Max(0, Mathf.FloorToInt((p.z - radius - origin.z) / stepZ)), z1 = Mathf.Min(res - 1, Mathf.CeilToInt((p.z + radius - origin.z) / stepZ));
                for (int z = z0; z <= z1; z++)
                    for (int x = x0; x <= x1; x++)
                    {
                        float dx = origin.x + x * stepX - p.x, dz = origin.z + z * stepZ - p.z;
                        if (dx * dx + dz * dz > radius * radius) continue;
                        int k = z * res + x; float y = p.y - margin, cur;
                        if (!target.TryGetValue(k, out cur) || y < cur) target[k] = y;
                    }
            }
            int minX = res, minZ = res, maxX = -1, maxZ = -1;
            foreach (var k in target.Keys) { int x = k % res, z = k / res; minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minZ = Math.Min(minZ, z); maxZ = Math.Max(maxZ, z); }
            int w = maxX - minX + 1, h = maxZ - minZ + 1;
            var heights = td.GetHeights(minX, minZ, w, h);
            var loweredBy = new Dictionary<int, float>();
            double maxCm = 0;
            foreach (var kv in target)
            {
                int x = kv.Key % res, z = kv.Key / res;
                float cur = origin.y + heights[z - minZ, x - minX] * size.y;
                if (kv.Value >= cur) continue;
                float nh = Mathf.Max(0f, (kv.Value - origin.y) / size.y);
                loweredBy[kv.Key] = (nh - heights[z - minZ, x - minX]) * size.y;
                maxCm = Math.Max(maxCm, -loweredBy[kv.Key] * 100);
                heights[z - minZ, x - minX] = nh;
            }
            if (loweredBy.Count == 0) return result;
            var dataPath = AssetDatabase.GetAssetPath(td);
            var folder = courseFolder + "Backups";
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Backups");
            var backup = folder + "/" + td.name + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-walls.asset";
            if (!AssetDatabase.CopyAsset(dataPath, backup)) throw new BridgeError("Could not back up " + dataPath + " to " + backup + "; nothing changed.");
            td.SetHeights(minX, minZ, heights);
            terrain.Flush();
            EditorUtility.SetDirty(td);
            AssetDatabase.SaveAssets();
            RefreshVsp(terrain);
            GolfMapTerrainSculpt.RecordConform(courseFolder, "inner", loweredBy);
            result["lowered"] = loweredBy.Count;
            result["m2"] = Math.Round(loweredBy.Count * stepX * stepZ, 1);
            result["maxLowerCm"] = Math.Round(maxCm, 1);
            result["backup"] = backup;
            return result;
        }

        internal static Terrain InnerTerrain(GolfMapCourse course) { return TerrainFor(course, "inner"); }

        // area: only the vegetation cells over it are refreshed (a windowed conform); null = the whole system is set up
        // again (1-2 s on a course).
        internal static void RefreshVsp(Terrain terrain, Bounds? area = null)
        {
            // VSP samples its own cached copy of the heightmap.
            var vspTerrain = terrain.GetComponent<UnityTerrain>();
            if (vspTerrain) vspTerrain.RefreshTerrainData();
            foreach (var system in UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>().Where(s => GolfMapZoneImporter.SystemMatchesTerrain(s, terrain)))
            {
                if (area.HasValue)
                {
                    system.RefreshTerrainArea(area.Value);
                    system.ClearCache(area.Value);
                    continue;
                }
                system.RefreshVegetationSystem();
                system.ClearCache();
            }
            SceneView.RepaintAll();
        }

        // A heightmap window's world bounds (a sample's width wider each side; full height).
        static Bounds WindowBounds(Terrain terrain, Window win)
        {
            var td = terrain.terrainData;
            var origin = terrain.transform.position;
            float stepX = td.size.x / (win.res - 1), stepZ = td.size.z / (win.res - 1);
            var min = new Vector3(origin.x + (win.x0 - 1) * stepX, origin.y - 1, origin.z + (win.z0 - 1) * stepZ);
            var max = new Vector3(origin.x + (win.x0 + win.w) * stepX, origin.y + td.size.y + 1, origin.z + (win.z0 + win.h) * stepZ);
            var b = new Bounds();
            b.SetMinMax(min, max);
            return b;
        }
    }
}
