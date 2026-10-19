// Unity 2018.2 / C# 6. Baked stone walls: a wall's placed stones merged into a few chunks with the hidden geometry
// removed, LOD meshes and one simplified collider per chunk.
//
// golfmap.walls.build places a wall as hundreds of single boulder instances (each ~440 tris with its own non-convex
// MeshCollider), overlapping on purpose and partly buried in the ground and the bank. The bake keeps that layout (it
// is still the generator's, and stones moved by hand are kept until the next build) and only changes how it is drawn:
//   1. the wall's stones as they stand in the scene (meshes, world matrices, materials, distance along the wall's foot)
//      and the ground under them (GolfMapWalls.Ground on a 0.15 m grid) go to GolfMapSpelunk/wall-bake/<Course>_<wall>.in.json;
//   2. Blender runs headless on it (blender/walls/wall_bake.py, synced into <project>/GolfMapTools/blender-walls by
//      unity_sync): triangles below the ground, inside another stone or that no ray reaches are dropped, the rest merged
//      into chunks of bakeChunkM along the wall, each decimated into its LODs (bakeLods) plus a collider mesh;
//   3. the result becomes <course>/Walls/Baked/<wall>.asset (all the meshes) and 'GolfMap Walls/<wall>/Baked/chunk-NN'
//      objects (LODGroup switching at bakeLodM metres, MeshCollider with the spec's physicMaterial, static), and the
//      stones move under '<wall>/Stones', inactive (the source for the next bake; golfmap.walls.unbake shows them again).
// A wall is baked whenever golfmap.walls.build builds it and its settings say bake: true (defaults/styles/the wall in
// stone-walls.gen.py); golfmap.walls.bake bakes walls already standing (after hand edits to their stones).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using Debug = UnityEngine.Debug;

namespace GolfMap.Editor
{
    public static class GolfMapWallBake
    {
        const string InFormat = "golfmap-wallbake-in-v1", OutFormat = "golfmap-wallbake-out-v1";
        const string BakedName = "Baked", StonesName = "Stones";
        const string Script = "GolfMapTools/blender-walls/wall_bake.py";
        const string WindowsBlender = @"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe";
        const float GroundCellM = 0.15f, GroundMarginM = 0.3f;
        const float FovDeg = 60f;  // the camera the LOD distances are worked out for (GSPro's lodBias scales them in game)
        static readonly CultureInfo C = CultureInfo.InvariantCulture;

        [BridgeCommand("golfmap.walls.bake", "Bake stone walls already built by golfmap.walls.build: each wall's stones (as they stand, hand edits included) merged in Blender into chunks of bakeChunkM along the wall with the triangles below the ground, inside another stone or out of sight removed, LOD meshes (bakeLods ratios, switching at bakeLodM metres) and one collider mesh per chunk. The chunks go under 'GolfMap Walls/<wall>/Baked', the stones under '<wall>/Stones' (inactive). walls.build bakes walls whose settings say bake: true by itself; this is for baking again after editing stones, or a wall without bake on. Reports triangles and colliders before/after. Marks the scene dirty.",
            args = "only (wall ids, comma-separated; default the walls with bake: true), dryRun=false (counts only, Blender not run), " + GolfMapSceneSave.Arg)]
        static object BakeCommand(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return Bake(only.Count == 0 ? null : only, a.Bool("dryRun", false));
        }

        [BridgeCommand("golfmap.walls.unbake", "Undo golfmap.walls.bake on walls: delete their 'Baked' chunks and show their stones again (to move stones by hand; golfmap.walls.bake then bakes them as they stand). Marks the scene dirty.",
            args = "only (wall ids, comma-separated; default every baked wall), " + GolfMapSceneSave.Arg)]
        static object UnbakeCommand(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            var root = GolfMapWalls.FindRoot();
            var done = new List<object>();
            if (root != null)
                foreach (Transform w in root.transform)
                {
                    if (only.Count > 0 && !only.Contains(w.name)) continue;
                    var baked = w.Find(BakedName);
                    if (baked == null) continue;
                    Undo.DestroyObjectImmediate(baked.gameObject);
                    var stones = w.Find(StonesName);
                    if (stones != null) { Undo.RecordObject(stones.gameObject, "Unbake wall"); stones.gameObject.SetActive(true); }
                    done.Add(w.name);
                }
            if (done.Count > 0) EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return new Dictionary<string, object> { { "unbaked", done } };
        }

        // Bakes the named walls (null: every wall in the scene whose settings say bake). One wall failing does not stop
        // the others: its stones stay shown and the row carries the error.
        public static Dictionary<string, object> Bake(IList<string> only, bool dryRun)
        {
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);
            var walls = GolfMapWalls.LoadWalls(course);
            if (walls == null) throw new InvalidOperationException("No walls spec in " + courseFolder + ".");
            var root = GolfMapWalls.FindRoot();
            if (root == null) throw new InvalidOperationException("No '" + GolfMapWalls.RootName + "' in the scene: run golfmap.walls.build first.");
            if (only != null)
            {
                var unknown = only.Where(id => walls.All(w => w.id != id)).ToList();
                if (unknown.Count > 0) throw new InvalidOperationException("No wall " + string.Join(", ", unknown.ToArray()) + " in the walls spec (single boulders are not baked).");
            }
            var physics = GolfMapWalls.LoadPhysics(GolfMapJsonDoc.ParseObject(File.ReadAllText(courseFolder + "stone-walls.json")), courseFolder + "stone-walls.json");
            Physics.SyncTransforms();
            var rows = new List<object>();
            int failed = 0;
            foreach (var w in walls)
            {
                if (only != null ? !only.Contains(w.id) : !w.s.bake) continue;
                var group = root.transform.Find(w.id);
                if (group == null) { rows.Add(new Dictionary<string, object> { { "id", w.id }, { "skipped", "not built in this scene" } }); continue; }
                var row = new Dictionary<string, object> { { "id", w.id } };
                rows.Add(row);
                try { BakeWall(course, courseFolder, w, group, physics, dryRun, row); }
                catch (Exception e)
                {
                    failed++;
                    row["error"] = e.Message;
                    Debug.LogError("[GolfMap Walls] bake " + w.id + ": " + e);
                }
            }
            if (!dryRun && rows.Count > 0) EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return new Dictionary<string, object> { { "dryRun", dryRun }, { "walls", rows }, { "failed", failed } };
        }

        sealed class Part
        {
            public MeshFilter filter;
            public Renderer renderer;
            public string model;
            public int[] materials;
            public float along;
        }

        static void BakeWall(GolfMapCourse course, string courseFolder, GolfMapWalls.Wall w, Transform group, PhysicMaterial physics, bool dryRun, Dictionary<string, object> row)
        {
            var s = w.s;
            if (s.bakeLods == null || s.bakeLods.Length == 0) throw new InvalidOperationException("bakeLods lists no LOD.");
            if (s.bakeLodM.Length < s.bakeLods.Length - 1) throw new InvalidOperationException("bakeLodM needs " + (s.bakeLods.Length - 1) + " distances (one per LOD switch).");
            var stones = group.Find(StonesName);
            var parts = Parts(group, stones);
            if (parts.Count == 0) throw new InvalidOperationException("the wall has no stones to bake.");
            int trisIn = parts.Sum(p => p.filter.sharedMesh.triangles.Length / 3);
            int collidersIn = parts.Sum(p => p.filter.GetComponentsInChildren<Collider>(true).Length);
            row["stones"] = parts.Count;
            row["trisBefore"] = trisIn;
            row["collidersBefore"] = collidersIn;
            if (dryRun) return;

            var watch = Stopwatch.StartNew();
            // the stones' materials, models and placements, and the ground around them
            var materials = new List<string>();
            var models = new Dictionary<string, Mesh>();
            foreach (var p in parts)
            {
                var mesh = p.filter.sharedMesh;
                var assetPath = AssetDatabase.GetAssetPath(mesh);
                p.model = (string.IsNullOrEmpty(assetPath) ? "scene:" + mesh.GetInstanceID() : assetPath) + "#" + mesh.name;
                models[p.model] = mesh;
                var mats = p.renderer.sharedMaterials;
                p.materials = new int[mesh.subMeshCount];
                for (int i = 0; i < mesh.subMeshCount; i++)
                {
                    var m = mats.Length == 0 ? null : mats[Math.Min(i, mats.Length - 1)];
                    var path = m == null ? null : AssetDatabase.GetAssetPath(m);
                    if (string.IsNullOrEmpty(path)) throw new InvalidOperationException(p.filter.name + ": submesh " + i + " has no material asset.");
                    int k = materials.IndexOf(path);
                    if (k < 0) { k = materials.Count; materials.Add(path); }
                    p.materials[i] = k;
                }
                p.along = Along(w, p.renderer.bounds.center);
            }
            var folder = Path.GetFullPath("GolfMapSpelunk/wall-bake");
            Directory.CreateDirectory(folder);
            var stem = Path.Combine(folder, GolfMapCourses.Name(course) + "_" + w.id);
            File.WriteAllText(stem + ".in.json", InputJson(w, parts, models, materials));
            File.Delete(stem + ".out.json");
            row["input"] = stem + ".in.json";
            float exportS = (float)watch.Elapsed.TotalSeconds;

            RunBlender(stem + ".in.json", stem + ".out.json");
            float blenderS = (float)watch.Elapsed.TotalSeconds - exportS;

            var outDoc = GolfMapJsonDoc.ParseObject(File.ReadAllText(stem + ".out.json"));
            if (outDoc.String("format") != OutFormat) throw new InvalidOperationException(stem + ".out.json is not " + OutFormat + ".");
            var bin = File.ReadAllBytes(Path.Combine(folder, outDoc.String("bin")));
            var outMaterials = outDoc.Array("materials").Cast<string>().Select(p =>
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(p);
                if (m == null) throw new InvalidOperationException("Material " + p + " is gone.");
                return m;
            }).ToArray();

            // the meshes: one asset per wall, every chunk's LODs and collider in it
            var assetFolder = courseFolder + "Walls/Baked";
            EnsureFolder(assetFolder);
            var asset = assetFolder + "/" + w.id + ".asset";
            var old = group.Find(BakedName);
            if (old != null) Undo.DestroyObjectImmediate(old.gameObject);
            AssetDatabase.DeleteAsset(asset);
            var meshes = new List<Mesh>();
            var baked = new GameObject(BakedName);
            Undo.RegisterCreatedObjectUndo(baked, "Bake stone wall");
            baked.transform.SetParent(group, false);
            int chunks = 0, colliderTris = 0;
            var trisLod = new int[s.bakeLods.Length];
            foreach (var co in outDoc.Array("chunks").Cast<GolfMapJsonObject>())
            {
                var id = co.String("id");
                var pv = co.Array("pivot");
                var go = new GameObject(id);
                go.transform.SetParent(baked.transform, false);
                go.transform.position = new Vector3(F(pv[0]), F(pv[1]), F(pv[2]));
                var lodRows = co.Array("lods").Cast<GolfMapJsonObject>().ToList();
                var renderers = new List<Renderer>();
                for (int k = 0; k < lodRows.Count; k++)
                {
                    var mesh = ReadLod(bin, lodRows[k], w.id + "_" + id + "_LOD" + k);
                    meshes.Add(mesh);
                    trisLod[Math.Min(k, trisLod.Length - 1)] += mesh.triangles.Length / 3;
                    var lg = new GameObject(id + "_LOD" + k);
                    lg.transform.SetParent(go.transform, false);
                    lg.AddComponent<MeshFilter>().sharedMesh = mesh;
                    var mr = lg.AddComponent<MeshRenderer>();
                    mr.sharedMaterials = lodRows[k].Array("submeshes").Cast<GolfMapJsonObject>().Select(sm => outMaterials[(int)sm.Number("material")]).ToArray();
                    if (k == lodRows.Count - 1 && k > 0 && !s.bakeLastLodShadows) mr.shadowCastingMode = ShadowCastingMode.Off;
                    renderers.Add(mr);
                }
                var col = ReadCollider(bin, co.Object("collider"), w.id + "_" + id + "_collider");
                meshes.Add(col);
                colliderTris += col.triangles.Length / 3;
                var mc = go.AddComponent<MeshCollider>();
                mc.sharedMesh = col;
                if (physics != null) mc.sharedMaterial = physics;
                var lod = go.AddComponent<LODGroup>();
                lod.fadeMode = LODFadeMode.None;
                lod.RecalculateBounds();
                lod.SetLODs(Lods(renderers, lod.size, s));
                foreach (var t in go.GetComponentsInChildren<Transform>(true)) GolfMapWalls.MarkStatic(t.gameObject);
                chunks++;
            }
            AssetDatabase.CreateAsset(meshes[0], asset);
            foreach (var m in meshes.Skip(1)) AssetDatabase.AddObjectToAsset(m, asset);
            AssetDatabase.SaveAssets();
            GolfMapWalls.MarkStatic(baked);

            // the stones: kept, out of sight, as the source for the next bake
            if (stones == null)
            {
                stones = new GameObject(StonesName).transform;
                Undo.RegisterCreatedObjectUndo(stones.gameObject, "Bake stone wall");
                stones.SetParent(group, false);
                foreach (var t in group.Cast<Transform>().Where(t => t != stones && t != baked.transform).ToList())
                    Undo.SetTransformParent(t, stones, "Bake stone wall");
            }
            Undo.RecordObject(stones.gameObject, "Bake stone wall");
            stones.gameObject.SetActive(false);

            var stats = outDoc.Object("stats");
            row["chunks"] = chunks;
            row["trisLod"] = trisLod;
            row["colliders"] = chunks;
            row["colliderTris"] = colliderTris;
            row["culled"] = new Dictionary<string, object> {
                { "ground", (int)stats.Number("culledGround") }, { "inside", (int)stats.Number("culledInside") }, { "hidden", (int)stats.Number("culledHidden") } };
            row["asset"] = asset;
            row["seconds"] = new Dictionary<string, object> {
                { "export", Math.Round(exportS, 1) }, { "blender", Math.Round(blenderS, 1) }, { "import", Math.Round(watch.Elapsed.TotalSeconds - exportS - blenderS, 1) } };
        }

        // The wall's stone meshes: under '<wall>/Stones' once baked, else the wall's own children; a prefab with its own
        // LODGroup gives only its first LOD's renderers.
        static List<Part> Parts(Transform group, Transform stones)
        {
            var from = stones != null ? new[] { stones } : group.Cast<Transform>().Where(t => t.name != BakedName).ToArray();
            var parts = new List<Part>();
            foreach (var t in from)
                foreach (var mf in t.GetComponentsInChildren<MeshFilter>(true))
                {
                    var r = mf.GetComponent<Renderer>();
                    if (mf.sharedMesh == null || r == null || !r.enabled) continue;
                    var lg = mf.GetComponentInParent<LODGroup>();
                    if (lg != null && lg.GetLODs().Length > 0 && !lg.GetLODs()[0].renderers.Contains(r)) continue;
                    parts.Add(new Part { filter = mf, renderer = r });
                }
            return parts;
        }

        // Distance along the wall's foot of the point nearest to p (x/z).
        static float Along(GolfMapWalls.Wall w, Vector3 p)
        {
            var q = new Vector2(p.x, p.z);
            float best = float.MaxValue, along = 0f;
            for (int i = 0; i + 1 < w.toe.Count; i++)
            {
                var a = w.toe[i]; var d = w.toe[i + 1] - a;
                float len2 = d.sqrMagnitude, t = len2 > 1e-8f ? Mathf.Clamp01(Vector2.Dot(q - a, d) / len2) : 0f;
                float dist = (a + d * t - q).sqrMagnitude;
                if (dist < best) { best = dist; along = w.along[i] + t * (w.along[i + 1] - w.along[i]); }
            }
            return along;
        }

        static string InputJson(GolfMapWalls.Wall w, List<Part> parts, Dictionary<string, Mesh> models, List<string> materials)
        {
            var s = w.s;
            var sb = new StringBuilder();
            sb.Append("{\"format\":\"").Append(InFormat).Append("\",\"wall\":").Append(BridgeJson.Write(w.id)).Append(",\"models\":{");
            bool first = true;
            foreach (var kv in models)
            {
                var m = kv.Value;
                if (!first) sb.Append(','); first = false;
                sb.Append(BridgeJson.Write(kv.Key)).Append(":{\"vertices\":");
                Floats(sb, m.vertices.SelectMany(v => new[] { v.x, v.y, v.z }), "R");
                sb.Append(",\"normals\":");
                Floats(sb, m.normals.SelectMany(v => new[] { v.x, v.y, v.z }), "R");
                sb.Append(",\"uv\":");
                Floats(sb, m.uv.SelectMany(v => new[] { v.x, v.y }), "R");
                sb.Append(",\"submeshes\":[");
                for (int i = 0; i < m.subMeshCount; i++)
                {
                    if (i > 0) sb.Append(',');
                    sb.Append('[').Append(string.Join(",", m.GetTriangles(i).Select(x => x.ToString(C)).ToArray())).Append(']');
                }
                sb.Append("]}");
            }
            sb.Append("},\"materials\":[").Append(string.Join(",", materials.Select(x => BridgeJson.Write(x)).ToArray())).Append("],\"stones\":[");
            for (int i = 0; i < parts.Count; i++)
            {
                var p = parts[i];
                var mx = p.filter.transform.localToWorldMatrix;
                if (i > 0) sb.Append(',');
                sb.Append("{\"model\":").Append(BridgeJson.Write(p.model)).Append(",\"matrix\":");
                Floats(sb, Enumerable.Range(0, 16).Select(k => mx[k / 4, k % 4]), "R");
                sb.Append(",\"materials\":[").Append(string.Join(",", p.materials.Select(x => x.ToString(C)).ToArray())).Append("],\"along\":")
                  .Append(p.along.ToString("R", C)).Append('}');
            }
            sb.Append("],\"ground\":");
            Ground(sb, parts);
            sb.Append(",\"settings\":{\"chunkM\":").Append(s.bakeChunkM.ToString("R", C)).Append(",\"lods\":");
            Floats(sb, s.bakeLods, "R");
            sb.Append(",\"colliderLod\":").Append(s.bakeColliderLod.ToString(C))
              .Append(",\"cullHidden\":").Append(s.bakeCullHidden ? "true" : "false")
              .Append(",\"rays\":").Append(s.bakeRays.ToString(C)).Append("}}");
            return sb.ToString();
        }

        // The ground (GolfMapWalls.Ground: the highest course mesh, else the terrain) on a GroundCellM grid over the
        // stones' bounds, sampled only within GroundMarginM of a stone; null elsewhere.
        static void Ground(StringBuilder sb, List<Part> parts)
        {
            var all = parts[0].renderer.bounds;
            foreach (var p in parts) all.Encapsulate(p.renderer.bounds);
            float x0 = all.min.x - GroundMarginM, z0 = all.min.z - GroundMarginM;
            int nx = Mathf.CeilToInt((all.size.x + 2 * GroundMarginM) / GroundCellM) + 1, nz = Mathf.CeilToInt((all.size.z + 2 * GroundMarginM) / GroundCellM) + 1;
            var want = new bool[nx * nz];
            foreach (var p in parts)
            {
                var b = p.renderer.bounds;
                int ix0 = Mathf.Max(0, Mathf.FloorToInt((b.min.x - GroundMarginM - x0) / GroundCellM)), ix1 = Mathf.Min(nx - 1, Mathf.CeilToInt((b.max.x + GroundMarginM - x0) / GroundCellM));
                int iz0 = Mathf.Max(0, Mathf.FloorToInt((b.min.z - GroundMarginM - z0) / GroundCellM)), iz1 = Mathf.Min(nz - 1, Mathf.CeilToInt((b.max.z + GroundMarginM - z0) / GroundCellM));
                for (int iz = iz0; iz <= iz1; iz++) for (int ix = ix0; ix <= ix1; ix++) want[iz * nx + ix] = true;
            }
            sb.Append("{\"x0\":").Append(x0.ToString("R", C)).Append(",\"z0\":").Append(z0.ToString("R", C)).Append(",\"cell\":").Append(GroundCellM.ToString("R", C))
              .Append(",\"nx\":").Append(nx).Append(",\"nz\":").Append(nz).Append(",\"heights\":[");
            for (int i = 0; i < want.Length; i++)
            {
                if (i > 0) sb.Append(',');
                float? g = want[i] ? GolfMapWalls.Ground(x0 + (i % nx) * GroundCellM, z0 + (i / nx) * GroundCellM) : null;
                sb.Append(g.HasValue ? g.Value.ToString("0.####", C) : "null");
            }
            sb.Append("]}");
        }

        static void Floats(StringBuilder sb, IEnumerable<float> values, string format)
        {
            sb.Append('[');
            bool first = true;
            foreach (var v in values) { if (!first) sb.Append(','); first = false; sb.Append(v.ToString(format, C)); }
            sb.Append(']');
        }

        static float F(object o) { return (float)((GolfMapJsonNumber)o).Value; }

        // GOLFMAP_BLENDER, else Blender 4.5's default install on Windows, else `blender` on PATH (as ShapingService).
        static string Blender()
        {
            var env = Environment.GetEnvironmentVariable("GOLFMAP_BLENDER");
            if (!string.IsNullOrEmpty(env)) return env;
            return File.Exists(WindowsBlender) ? WindowsBlender : "blender";
        }

        static void RunBlender(string input, string output)
        {
            var script = Path.GetFullPath(Script);
            if (!File.Exists(script)) throw new InvalidOperationException("No " + script + ": run unity_sync push (it copies blender/walls/ from the golf-map repo).");
            var psi = new ProcessStartInfo(Blender(), "-b --factory-startup --python-exit-code 1 --python \"" + script + "\" -- --in \"" + input + "\" --out \"" + output + "\"")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true,
            };
            var log = new StringBuilder();
            using (var p = new Process { StartInfo = psi })
            {
                p.OutputDataReceived += (o, e) => { if (e.Data != null) lock (log) log.AppendLine(e.Data); };
                p.ErrorDataReceived += (o, e) => { if (e.Data != null) lock (log) log.AppendLine(e.Data); };
                p.Start();
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                if (!p.WaitForExit(15 * 60 * 1000)) { try { p.Kill(); } catch { } throw new InvalidOperationException("Blender took over 15 minutes on " + input + "."); }
                p.WaitForExit();
                File.WriteAllText(Path.ChangeExtension(output, null) + ".log", log.ToString());
                if (p.ExitCode != 0 || !File.Exists(output))
                {
                    var tail = string.Join("\n", log.ToString().Split('\n').Reverse().Take(15).Reverse().ToArray());
                    throw new InvalidOperationException("Blender failed (exit " + p.ExitCode + ") on " + input + ":\n" + tail);
                }
            }
        }

        static Mesh ReadLod(byte[] bin, GolfMapJsonObject o, string name)
        {
            int offset = (int)o.Number("offset"), n = (int)o.Number("vertexCount");
            var pos = Vectors3(bin, ref offset, n);
            var nor = Vectors3(bin, ref offset, n);
            var uv = new Vector2[n];
            var f = new float[2 * n];
            Buffer.BlockCopy(bin, offset, f, 0, 8 * n); offset += 8 * n;
            for (int i = 0; i < n; i++) uv[i] = new Vector2(f[2 * i], f[2 * i + 1]);
            var subs = o.Array("submeshes").Cast<GolfMapJsonObject>().ToList();
            var mesh = new Mesh { name = name };
            if (n > 65000) mesh.indexFormat = IndexFormat.UInt32;
            mesh.vertices = pos; mesh.normals = nor; mesh.uv = uv;
            mesh.subMeshCount = subs.Count;
            for (int k = 0; k < subs.Count; k++) mesh.SetTriangles(Ints(bin, ref offset, (int)subs[k].Number("indexCount")), k);
            mesh.RecalculateBounds();
            mesh.RecalculateTangents();
            return mesh;
        }

        static Mesh ReadCollider(byte[] bin, GolfMapJsonObject o, string name)
        {
            int offset = (int)o.Number("offset"), n = (int)o.Number("vertexCount");
            var mesh = new Mesh { name = name };
            if (n > 65000) mesh.indexFormat = IndexFormat.UInt32;
            mesh.vertices = Vectors3(bin, ref offset, n);
            mesh.triangles = Ints(bin, ref offset, (int)o.Number("indexCount"));
            mesh.RecalculateBounds();
            return mesh;
        }

        static Vector3[] Vectors3(byte[] bin, ref int offset, int n)
        {
            var f = new float[3 * n];
            Buffer.BlockCopy(bin, offset, f, 0, 12 * n); offset += 12 * n;
            var v = new Vector3[n];
            for (int i = 0; i < n; i++) v[i] = new Vector3(f[3 * i], f[3 * i + 1], f[3 * i + 2]);
            return v;
        }

        static int[] Ints(byte[] bin, ref int offset, int n)
        {
            var a = new int[n];
            Buffer.BlockCopy(bin, offset, a, 0, 4 * n); offset += 4 * n;
            return a;
        }

        // LOD k shows until the chunk is bakeLodM[k] metres away (a FovDeg camera, lodBias 1); the last LOD until
        // bakeCullM (0: never culled).
        static LOD[] Lods(List<Renderer> renderers, float size, GolfMapWalls.Settings s)
        {
            Func<float, float> height = d => size / (2f * d * Mathf.Tan(FovDeg * 0.5f * Mathf.Deg2Rad));
            var lods = new LOD[renderers.Count];
            float prev = 1f;
            for (int k = 0; k < renderers.Count; k++)
            {
                bool last = k == renderers.Count - 1;
                float h = last ? (s.bakeCullM > 0 ? height(s.bakeCullM) : 0f) : height(s.bakeLodM[k]);
                h = Mathf.Min(h, prev * 0.999f);  // strictly decreasing, as LODGroup needs
                lods[k] = new LOD(Mathf.Max(0f, h), new[] { renderers[k] });
                prev = h;
            }
            return lods;
        }

        static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parent = folder.Substring(0, folder.LastIndexOf('/'));
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, folder.Substring(folder.LastIndexOf('/') + 1));
        }
    }
}
