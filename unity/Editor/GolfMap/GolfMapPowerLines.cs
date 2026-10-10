// Power lines: the course's `power_line` features (drawn in golf-map's Draw mode, one point per pole) built as
// H-frame wooden pole lines: at every point two round wooden poles side by side across the line, a crossarm on
// their tops, three suspension insulators hanging from it (one at each end, one in the middle) and three wires
// sagging from structure to structure. Read from the course export folder's <prefix>-power-lines.json
// (`pipeline/gspro.py power-lines`):
//
//   { "format": "golfmap-power-lines-v1", "crs": "EPSG:3006",
//     "lines": [ { "id": "<feature id>", "name": "power_line_<feature number in hex>", "points": [[e, n], ...] } ] }
//
// Each pole stands on the highest collider under it (course meshes, else a terrain); a structure whose poles find no
// ground (outside both terrains) is left out and the wires end at the last one built. One object per line under
// 'GolfMap Power Lines' with three meshes (wood + arm, insulators, wires) saved to <course>/PowerLines/; the poles
// get a MeshCollider with the wood physics material, the wires none (a ball flies through a 6 cm line).
// The three materials are made once in <course>/PowerLines/ and then kept, so hand tuning stays.
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
    public static class GolfMapPowerLines
    {
        public const string Format = "golfmap-power-lines-v1";
        const string RootName = "GolfMap Power Lines";
        const string AssetFolder = "PowerLines";
        const string PolePhysics = "Assets/Resources/Physics/GSPwood.physicMaterial";

        class Style
        {
            public float poleHeightM = 13f;      // pole top over the higher of its two feet
            public float poleSpacingM = 4.6f;    // between the two poles
            public float poleRadiusM = 0.16f;    // at the foot; 0.11 at the top
            public float armLengthM = 9.6f;
            public float wireOffsetM = 4.3f;     // the outer wires from the middle one
            public float insulatorM = 1.1f;      // the hanging string's length
            public float sagFraction = 0.022f;   // of the span
            public float wireRadiusM = 0.03f;    // thicker than a real conductor: a 3 cm line is not drawn at 100 m
            public float buryM = 0.6f;           // the pole goes this far into the ground (slopes)
            public float minClearanceM = 6f;     // the wires' least height over the ground; taller poles where a span needs it ...
            public float maxExtraHeightM = 7f;   // ... up to this much taller
        }

        class Structure
        {
            public Vector3 left, right, armCentre, across; public Vector3[] attach = new Vector3[3]; public float extra;
            public void Raise(float by) { extra += by; armCentre.y += by; for (int k = 0; k < 3; k++) attach[k].y += by; }
        }

        static Vector3 OnWire(Structure a, Structure b, int k, float t, float sagFraction)
        {
            float sag = Vector3.Distance(a.armCentre, b.armCentre) * sagFraction;
            return Vector3.Lerp(a.attach[k], b.attach[k], t) + Vector3.down * (4f * sag * t * (1f - t));
        }

        // The least height of a span's three wires over the ground, sampled every ~5 m; null where no ground is under it.
        static float? Clearance(Structure a, Structure b, Style s, GameObject ignore)
        {
            int n = Mathf.Clamp(Mathf.CeilToInt(Vector3.Distance(a.armCentre, b.armCentre) / 5f), 4, 80);
            float? least = null;
            for (int k = 0; k < 3; k++)
                for (int j = 1; j < n; j++)
                {
                    var p = OnWire(a, b, k, j / (float)n, s.sagFraction);
                    var g = Ground(p.x, p.z, ignore);
                    if (g != null && (least == null || p.y - g.Value < least.Value)) least = p.y - g.Value;
                }
            return least;
        }

        [BridgeCommand("golfmap.powerlines.build", "Build the course's power lines (golf-map `power_line` features, one point per pole; <export folder>/<prefix>-power-lines.json from `gspro.py power-lines`) as H-frame wooden pole lines under 'GolfMap Power Lines': two poles and a crossarm at every point, three hanging insulators, three sagging wires between structures. Poles stand on the ground under them; meshes and materials go to <course>/PowerLines/ (materials are made once and kept). Replaces what the last build made. Marks the scene dirty, does not save it.",
            args = "file (default <export folder>/<prefix>-power-lines.json), dryRun=false (the plan: structures, spans, ground), poleHeightM=13, poleSpacingM=4.6, armLengthM=9.6, wireOffsetM=4.3, sagFraction=0.022, wireRadiusM=0.03, minClearanceM=6 (poles grow, up to 7 m, where a span's wires would come nearer the ground), resetMaterials=false (put the three materials back to the built-in look)")]
        static object Command(BridgeArgs a)
        {
            var s = new Style();
            s.poleHeightM = (float)a.Number("poleHeightM", s.poleHeightM);
            s.poleSpacingM = (float)a.Number("poleSpacingM", s.poleSpacingM);
            s.armLengthM = (float)a.Number("armLengthM", s.armLengthM);
            s.wireOffsetM = (float)a.Number("wireOffsetM", s.wireOffsetM);
            s.sagFraction = (float)a.Number("sagFraction", s.sagFraction);
            s.wireRadiusM = (float)a.Number("wireRadiusM", s.wireRadiusM);
            s.minClearanceM = (float)a.Number("minClearanceM", s.minClearanceM);
            return Build(a.String("file"), a.Bool("dryRun", false), s, a.Bool("resetMaterials", false));
        }

        [BridgeCommand("golfmap.powerlines.clear", "Delete 'GolfMap Power Lines' (everything golfmap.powerlines.build made in the scene; the mesh and material assets stay). Marks the scene dirty.")]
        static object Clear()
        {
            var root = GameObject.Find("/" + RootName);
            if (root == null) return new Dictionary<string, object> { { "removed", 0 } };
            int n = root.transform.childCount;
            Undo.DestroyObjectImmediate(root);
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            return new Dictionary<string, object> { { "removed", n } };
        }

        static string DefaultFile(GolfMapCourse course)
        {
            if (string.IsNullOrEmpty(course.exportFolder)) throw new InvalidOperationException("The course has no export folder.");
            var folder = Path.IsPathRooted(course.exportFolder) ? course.exportFolder : Path.Combine(Application.dataPath, course.exportFolder);
            return Path.Combine(folder, course.exportPrefix + "-power-lines.json");
        }

        static Dictionary<string, object> Build(string file, bool dryRun, Style s, bool resetMaterials)
        {
            var course = GolfMapCourses.Require();
            if (string.IsNullOrEmpty(file)) file = DefaultFile(course);
            if (!File.Exists(file)) throw new InvalidOperationException("No power lines file: " + file + " (run `gspro.py power-lines --course <course> --out` into the export folder).");
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            if (doc.String("format") != Format) throw new InvalidOperationException(file + " is not " + Format + ".");
            double e0, n0; Vector3 origin;
            GolfMapProps.Frame(course, out e0, out n0, out origin);

            var existing = GameObject.Find("/" + RootName);
            GameObject root = null;
            Material wood = null, insulator = null, wire = null;
            PhysicMaterial physics = null;
            string folder = GolfMapCourses.Folder(course) + AssetFolder;
            if (!dryRun)
            {
                if (existing != null) Undo.DestroyObjectImmediate(existing);
                existing = null;
                if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(GolfMapCourses.Folder(course).TrimEnd('/'), AssetFolder);
                wood = MaterialAt(folder + "/Power pole wood.mat", new Color(0.20f, 0.165f, 0.14f), 0.08f, 0f, resetMaterials);
                insulator = MaterialAt(folder + "/Power line insulator.mat", new Color(0.16f, 0.13f, 0.11f), 0.75f, 0f, resetMaterials);
                wire = MaterialAt(folder + "/Power line wire.mat", new Color(0.20f, 0.20f, 0.21f), 0.35f, 0.6f, resetMaterials);
                physics = AssetDatabase.LoadAssetAtPath<PhysicMaterial>(PolePhysics);
                root = new GameObject(RootName);
                Undo.RegisterCreatedObjectUndo(root, "Build power lines");
            }

            var rows = new List<object>();
            int structuresBuilt = 0, spansBuilt = 0;
            foreach (var lo in (doc.Array("lines") ?? new List<object>()).Cast<GolfMapJsonObject>())
            {
                var name = lo.String("name") ?? lo.String("id");
                var pts = (lo.Array("points") ?? new List<object>()).Cast<List<object>>()
                    .Select(q => new Vector2((float)(((GolfMapJsonNumber)q[0]).Value - e0) + origin.x, (float)(((GolfMapJsonNumber)q[1]).Value - n0) + origin.z)).ToList();
                if (pts.Count < 2) continue;

                var structures = new List<Structure>();
                var noGround = new List<int>();
                for (int i = 0; i < pts.Count; i++)
                {
                    var along = (pts[Mathf.Min(i + 1, pts.Count - 1)] - pts[Mathf.Max(i - 1, 0)]).normalized;
                    var across = new Vector3(-along.y, 0f, along.x);
                    var centre = new Vector3(pts[i].x, 0f, pts[i].y);
                    var lf = centre - across * (s.poleSpacingM / 2f);
                    var rf = centre + across * (s.poleSpacingM / 2f);
                    float? gl = Ground(lf.x, lf.z, existing), gr = Ground(rf.x, rf.z, existing);
                    if (gl == null || gr == null) { noGround.Add(i); structures.Add(null); continue; }
                    float top = Mathf.Max(gl.Value, gr.Value) + s.poleHeightM;
                    var st = new Structure { across = across };
                    st.left = new Vector3(lf.x, gl.Value, lf.z);
                    st.right = new Vector3(rf.x, gr.Value, rf.z);
                    st.armCentre = new Vector3(centre.x, top, centre.z);
                    for (int k = 0; k < 3; k++)
                        st.attach[k] = st.armCentre + across * ((k - 1) * s.wireOffsetM) + Vector3.down * (0.12f + s.insulatorM);
                    structures.Add(st);
                }

                // Taller poles where the ground rises under a span (a hill between two structures).
                for (int pass = 0; pass < 6; pass++)
                {
                    bool raised = false;
                    for (int i = 0; i + 1 < structures.Count; i++)
                    {
                        Structure a = structures[i], b = structures[i + 1];
                        if (a == null || b == null) continue;
                        var c = Clearance(a, b, s, existing);
                        if (c == null || c.Value >= s.minClearanceM) continue;
                        float need = s.minClearanceM - c.Value;
                        float da = Mathf.Min(need, s.maxExtraHeightM - a.extra), db = Mathf.Min(need, s.maxExtraHeightM - b.extra);
                        if (da > 0.01f) { a.Raise(da); raised = true; }
                        if (db > 0.01f) { b.Raise(db); raised = true; }
                    }
                    if (!raised) break;
                }

                var woodMesh = new Builder(); var insMesh = new Builder(); var wireMesh = new Builder();
                var spans = new List<object>();
                float lowestWire = float.MaxValue;
                for (int i = 0; i < structures.Count; i++)
                {
                    var st = structures[i];
                    if (st == null) continue;
                    structuresBuilt++;
                    float top = st.armCentre.y;
                    woodMesh.Cylinder(st.left + Vector3.down * s.buryM, new Vector3(st.left.x, top + 0.25f, st.left.z), s.poleRadiusM, s.poleRadiusM * 0.7f, 10);
                    woodMesh.Cylinder(st.right + Vector3.down * s.buryM, new Vector3(st.right.x, top + 0.25f, st.right.z), s.poleRadiusM, s.poleRadiusM * 0.7f, 10);
                    var forward = Vector3.Cross(st.across, Vector3.up).normalized;
                    woodMesh.Box(st.armCentre, st.across, Vector3.up, forward, s.armLengthM / 2f, 0.11f, 0.09f);
                    for (int k = 0; k < 3; k++)
                    {
                        var hang = st.armCentre + st.across * ((k - 1) * s.wireOffsetM) + Vector3.down * 0.11f;
                        insMesh.Cylinder(hang, st.attach[k], 0.035f, 0.035f, 6);
                        for (int d = 0; d < 6; d++)   // the string's discs
                        {
                            var c = Vector3.Lerp(hang, st.attach[k], (d + 1f) / 7.5f);
                            insMesh.Cylinder(c + Vector3.up * 0.035f, c + Vector3.down * 0.035f, 0.07f, 0.12f, 8);
                        }
                    }
                    var next = i + 1 < structures.Count ? structures[i + 1] : null;
                    if (next == null) continue;
                    spansBuilt++;
                    float span = Vector3.Distance(st.armCentre, next.armCentre);
                    float sag = span * s.sagFraction;
                    int segs = Mathf.Clamp(Mathf.CeilToInt(span / 6f), 8, 60);
                    for (int k = 0; k < 3; k++)
                    {
                        var line = new Vector3[segs + 1];
                        for (int j = 0; j <= segs; j++) line[j] = OnWire(st, next, k, j / (float)segs, s.sagFraction);
                        wireMesh.Tube(line, s.wireRadiusM, 5);
                    }
                    float clearance = Clearance(st, next, s, existing) ?? float.MaxValue;
                    if (clearance < float.MaxValue) lowestWire = Mathf.Min(lowestWire, clearance);
                    spans.Add(new Dictionary<string, object> { { "from", i }, { "spanM", Math.Round(span, 1) }, { "sagM", Math.Round(sag, 2) }, { "poleM", Math.Round(s.poleHeightM + st.extra, 1) },
                        { "clearanceM", clearance < float.MaxValue ? (object)Math.Round(clearance, 1) : null } });
                }

                var row = new Dictionary<string, object> { { "line", name }, { "points", pts.Count }, { "structures", structures.Count(x => x != null) },
                    { "noGround", noGround }, { "spans", spans }, { "lowestWireOverGroundM", lowestWire < float.MaxValue ? (object)Math.Round(lowestWire, 1) : null } };
                rows.Add(row);
                if (dryRun || woodMesh.Empty) continue;

                var go = new GameObject(name);
                go.transform.SetParent(root.transform, false);
                var poles = Part(go, "Poles", woodMesh.ToMesh(), folder + "/" + name + " poles.asset", wood);
                var mc = poles.AddComponent<MeshCollider>();
                mc.sharedMesh = poles.GetComponent<MeshFilter>().sharedMesh;
                mc.sharedMaterial = physics;
                Part(go, "Insulators", insMesh.ToMesh(), folder + "/" + name + " insulators.asset", insulator);
                if (!wireMesh.Empty) Part(go, "Wires", wireMesh.ToMesh(), folder + "/" + name + " wires.asset", wire);
            }

            if (!dryRun)
            {
                AssetDatabase.SaveAssets();
                EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            }
            return new Dictionary<string, object> { { "file", file }, { "dryRun", dryRun }, { "lines", rows }, { "structures", structuresBuilt }, { "spans", spansBuilt },
                { "polePhysics", physics != null ? PolePhysics : null } };
        }

        static GameObject Part(GameObject parent, string name, Mesh mesh, string assetPath, Material material)
        {
            var old = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
            if (old != null)
            {
                // Refill the saved mesh in place: a replaced asset file is not reloaded by an open 2018.2 editor.
                old.Clear();
                old.vertices = mesh.vertices; old.normals = mesh.normals; old.uv = mesh.uv; old.triangles = mesh.triangles;
                old.RecalculateBounds();
                EditorUtility.SetDirty(old);
                UnityEngine.Object.DestroyImmediate(mesh);
                mesh = old;
            }
            else AssetDatabase.CreateAsset(mesh, assetPath);
            var go = new GameObject(name);
            go.transform.SetParent(parent.transform, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            go.AddComponent<MeshRenderer>().sharedMaterial = material;
            return go;
        }

        static Material MaterialAt(string path, Color colour, float smoothness, float metallic, bool reset)
        {
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m != null && !reset) return m;   // made once, then the user's
            bool fresh = m == null;
            if (fresh) m = new Material(Shader.Find("Standard"));
            m.color = colour;
            m.SetFloat("_Glossiness", smoothness);
            m.SetFloat("_Metallic", metallic);
            if (fresh) AssetDatabase.CreateAsset(m, path); else EditorUtility.SetDirty(m);
            return m;
        }

        // The highest collider under (x, z) that is not part of the power lines.
        static float? Ground(float x, float z, GameObject ignore)
        {
            var hits = Physics.RaycastAll(new Ray(new Vector3(x, 5000f, z), Vector3.down), 10000f, ~0, QueryTriggerInteraction.Ignore);
            float? best = null;
            foreach (var h in hits)
            {
                if (ignore != null && h.collider.transform.IsChildOf(ignore.transform)) continue;
                if (best == null || h.point.y > best.Value) best = h.point.y;
            }
            return best;
        }

        sealed class Builder
        {
            readonly List<Vector3> v = new List<Vector3>();
            readonly List<Vector3> n = new List<Vector3>();
            readonly List<Vector2> uv = new List<Vector2>();
            readonly List<int> t = new List<int>();
            public bool Empty { get { return v.Count == 0; } }

            static void Frame(Vector3 axis, out Vector3 a, out Vector3 b)
            {
                a = Vector3.Cross(axis, Mathf.Abs(axis.y) < 0.9f ? Vector3.up : Vector3.right).normalized;
                b = Vector3.Cross(axis, a).normalized;
            }

            // A tapered round bar from `from` (radius r0) to `to` (r1), with a cap at `to`.
            public void Cylinder(Vector3 from, Vector3 to, float r0, float r1, int sides)
            {
                var axis = (to - from).normalized;
                Vector3 a, b; Frame(axis, out a, out b);
                int start = v.Count;
                for (int i = 0; i <= sides; i++)
                {
                    float ang = i / (float)sides * Mathf.PI * 2f;
                    var dir = a * Mathf.Cos(ang) + b * Mathf.Sin(ang);
                    v.Add(from + dir * r0); n.Add(dir); uv.Add(new Vector2(i / (float)sides, 0f));
                    v.Add(to + dir * r1); n.Add(dir); uv.Add(new Vector2(i / (float)sides, 1f));
                }
                for (int i = 0; i < sides; i++)
                {
                    int q = start + i * 2;
                    var outward = (n[q] + n[q + 2]).normalized;
                    TriOut(q, q + 1, q + 3, outward);
                    TriOut(q, q + 3, q + 2, outward);
                }
                int cap = v.Count;
                v.Add(to); n.Add(axis); uv.Add(new Vector2(0.5f, 0.5f));
                for (int i = 0; i <= sides; i++)
                {
                    float ang = i / (float)sides * Mathf.PI * 2f;
                    v.Add(to + (a * Mathf.Cos(ang) + b * Mathf.Sin(ang)) * r1); n.Add(axis); uv.Add(new Vector2(0.5f, 0.5f));
                }
                for (int i = 0; i < sides; i++) TriOut(cap, cap + 1 + i, cap + 2 + i, axis);
            }

            // A wire through `line`: a tube of `sides` sides.
            public void Tube(Vector3[] line, float r, int sides)
            {
                int start = v.Count;
                for (int j = 0; j < line.Length; j++)
                {
                    var axis = (line[Mathf.Min(j + 1, line.Length - 1)] - line[Mathf.Max(j - 1, 0)]).normalized;
                    var a = Vector3.Cross(axis, Vector3.up).normalized;
                    var b = Vector3.Cross(axis, a).normalized;
                    for (int i = 0; i <= sides; i++)
                    {
                        float ang = i / (float)sides * Mathf.PI * 2f;
                        var dir = a * Mathf.Cos(ang) + b * Mathf.Sin(ang);
                        v.Add(line[j] + dir * r); n.Add(dir); uv.Add(new Vector2(i / (float)sides, j));
                    }
                }
                int ring = sides + 1;
                for (int j = 0; j < line.Length - 1; j++)
                    for (int i = 0; i < sides; i++)
                    {
                        int q = start + j * ring + i;
                        var c = (v[q] + v[q + ring + 1]) / 2f;
                        var outward = (c - (line[j] + line[j + 1]) / 2f).normalized;
                        TriOut(q, q + ring, q + ring + 1, outward);
                        TriOut(q, q + ring + 1, q + 1, outward);
                    }
            }

            // A box round `centre`: half sizes hx along `x`, hy along `y`, hz along `z`.
            public void Box(Vector3 centre, Vector3 x, Vector3 y, Vector3 z, float hx, float hy, float hz)
            {
                Face(centre + x * hx, y * hy, z * hz, x);
                Face(centre - x * hx, y * hy, z * hz, -x);
                Face(centre + y * hy, x * hx, z * hz, y);
                Face(centre - y * hy, x * hx, z * hz, -y);
                Face(centre + z * hz, x * hx, y * hy, z);
                Face(centre - z * hz, x * hx, y * hy, -z);
            }

            void Face(Vector3 c, Vector3 u, Vector3 w, Vector3 normal)
            {
                int s = v.Count;
                v.Add(c - u - w); v.Add(c + u - w); v.Add(c + u + w); v.Add(c - u + w);
                for (int i = 0; i < 4; i++) { n.Add(normal); uv.Add(new Vector2(i == 1 || i == 2 ? 1f : 0f, i >= 2 ? 1f : 0f)); }
                TriOut(s, s + 1, s + 2, normal);
                TriOut(s, s + 2, s + 3, normal);
            }

            // The triangle wound so that it faces `outward`.
            void TriOut(int a, int b, int c, Vector3 outward)
            {
                var face = Vector3.Cross(v[b] - v[a], v[c] - v[a]);
                if (Vector3.Dot(face, outward) >= 0f) { t.Add(a); t.Add(b); t.Add(c); }
                else { t.Add(a); t.Add(c); t.Add(b); }
            }

            public Mesh ToMesh()
            {
                var m = new Mesh();
                if (v.Count > 65000) m.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
                m.SetVertices(v); m.SetNormals(n); m.SetUVs(0, uv); m.SetTriangles(t, 0);
                m.RecalculateBounds();
                return m;
            }
        }
    }
}
