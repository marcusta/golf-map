// How a loaded course's bunkers are built, measured: per bunker mesh the edge rings counted in
// from its seam (distance from the seam, height against it, vertex paint), the same outward for
// its blend strips, the normals across the seam and the materials. Read-only; numbers, no geometry.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using UnityEngine;

namespace GolfMap.Bridge
{
    static class MeshCommands
    {
        static readonly string[] Channels = { "_Red", "_Green", "_Blue", "_Black" };
        static readonly string[] ChannelFloats = { "DetailIndex", "BaseIndex", "Index", "BlendStrength", "AOBrightness", "NearNRMStrength", "FarNRMStrength", "Smoothness", "Tiling", "DetailTiling", "NearTiling", "FarTiling", "Height", "Grass3D", "Darken" };
        static readonly string[] ChannelColors = { "OverallColor", "DetailColorTint", "BaseColorTint", "Color", "Tint" };

        static bool OwnScene(GameObject g) { return !g.scene.IsValid() || g.scene.name == "ArboristUI" || g.scene.name == "3DBrowsingScene" || g.scene.name == "DontDestroyOnLoad"; }
        static double R(double v, int digits = 3) { return Math.Round(v, digits); }
        static double Median(List<float> v) { if (v.Count == 0) return 0; v.Sort(); return v[v.Count / 2]; }
        static double Pct(List<float> v, double p) { if (v.Count == 0) return 0; v.Sort(); return v[Math.Min(v.Count - 1, (int)(v.Count * p))]; }

        static object MaterialOf(Material m)
        {
            if (!m) return null;
            var d = new Dictionary<string, object> { { "name", m.name }, { "shader", m.shader ? m.shader.name : null } };
            foreach (var c in Channels)
            {
                var row = new Dictionary<string, object>();
                foreach (var f in ChannelFloats) if (m.HasProperty(c + f)) row[f] = R(m.GetFloat(c + f));
                foreach (var f in ChannelColors) if (m.HasProperty(c + f)) { var k = m.GetColor(c + f); row[f] = new List<object> { R(k.r), R(k.g), R(k.b), R(k.a) }; }
                if (row.Count > 0) d[c.Substring(1)] = row;
            }
            foreach (var f in new[] { "_Satellite", "_SatelliteStrength", "_SatStrength", "_SlopeShading", "_Glossiness", "_Smoothness", "_Metallic" })
                if (m.HasProperty(f)) { try { d[f] = R(m.GetFloat(f)); } catch (Exception) { } }
            if (m.shaderKeywords.Length > 0) d["keywords"] = string.Join(" ", m.shaderKeywords);
            return d;
        }

        [BridgeCommand("material", "The values of named shader properties on the course's materials whose name contains `name` (a player cannot list a shader's properties, so the names come from the caller, e.g. out of a .mat file): floats, colours, and per texture its name, kind and size (slices for an array).",
            args = "name (part of a material name, required), floats=[...], colors=[...], textures=[...], limit=12")]
        static object MaterialCommand(BridgeArgs a)
        {
            string name = a.Require("name");
            var floats = a.Strings("floats") ?? new string[0]; var colors = a.Strings("colors") ?? new string[0]; var textures = a.Strings("textures") ?? new string[0];
            var seen = new HashSet<Material>();
            var rows = new List<object>();
            // Every loaded material, not only the renderers': a 3D grass material sits on its GrassRenderer.
            {
                foreach (var m in Resources.FindObjectsOfTypeAll<Material>().OrderBy(m => m.name))
                {
                    if (!m || m.name.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0 || !seen.Add(m) || rows.Count >= a.Int("limit", 12)) continue;
                    var d = new Dictionary<string, object> { { "name", m.name }, { "shader", m.shader ? m.shader.name : null }, { "keywords", string.Join(" ", m.shaderKeywords) }, { "renderQueue", m.renderQueue } };
                    var f = new Dictionary<string, object>(); var c = new Dictionary<string, object>(); var t = new Dictionary<string, object>();
                    foreach (var p in floats) if (m.HasProperty(p)) { try { f[p] = R(m.GetFloat(p)); } catch (Exception) { } }
                    foreach (var p in colors) if (m.HasProperty(p)) { try { var k = m.GetColor(p); c[p] = new List<object> { R(k.r), R(k.g), R(k.b), R(k.a) }; } catch (Exception) { } }
                    foreach (var p in textures)
                        if (m.HasProperty(p))
                        {
                            Texture x = null;
                            try { x = m.GetTexture(p); } catch (Exception) { }
                            if (!x) continue;
                            var array = x as Texture2DArray;
                            t[p] = x.name + " (" + x.GetType().Name + " " + x.width + "x" + x.height + (array ? " x" + array.depth : "") + ")";
                        }
                    d["floats"] = f; d["colors"] = c; d["textures"] = t;
                    rows.Add(d);
                }
            }
            return rows;
        }

        [BridgeCommand("veg.surfaces", "What stands on what: every placed (persistent storage) vegetation instance by the course mesh under it (a ray straight down, mesh names with the digits taken out), as item x surface counts with the scale range. `surface` keeps only surfaces whose name contains it and adds up to `examples` positions.",
            args = "surface (e.g. Bunker), examples=6")]
        static object VegSurfaces(BridgeArgs a)
        {
            string wanted = a.String("surface");
            var counts = new Dictionary<string, Dictionary<string, object>>();
            var examples = new List<object>();
            foreach (var s in Resources.FindObjectsOfTypeAll<AwesomeTechnologies.VegetationSystem.VegetationSystemPro>())
            {
                if (!s || OwnScene(s.gameObject)) continue;
                var storage = s.PersistentVegetationStorage;
                if (!storage || !storage.PersistentVegetationStoragePackage) continue;
                var names = s.VegetationPackageProList.Where(p => p).SelectMany(p => p.VegetationInfoList).GroupBy(i => i.VegetationItemID).ToDictionary(g => g.Key, g => g.First());
                Vector3 origin = s.VegetationSystemPosition;
                foreach (var cell in storage.PersistentVegetationStoragePackage.PersistentVegetationCellList)
                    foreach (var info in cell.PersistentVegetationInfoList)
                    {
                        AwesomeTechnologies.VegetationSystem.VegetationItemInfoPro item;
                        if (!names.TryGetValue(info.VegetationItemID, out item)) continue;
                        for (int i = 0; i < info.VegetationItemList.Count; i++)
                        {
                            var world = info.VegetationItemList[i].Position + origin;
                            string surface = "(nothing)";
                            foreach (var hit in Physics.RaycastAll(world + Vector3.up * 30f, Vector3.down, 80f).OrderBy(h => h.distance))
                            {
                                if (!hit.collider.name.StartsWith("Spline") && !(hit.collider is TerrainCollider)) continue;
                                surface = Regex.Replace(hit.collider.name, @"\d+", "#"); break;
                            }
                            if (wanted != null && surface.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) < 0) continue;
                            string key = item.VegetationType + " | " + item.Name + " | " + surface;
                            Dictionary<string, object> row;
                            float scale = info.VegetationItemList[i].Scale.y;
                            if (!counts.TryGetValue(key, out row)) counts[key] = row = new Dictionary<string, object> { { "key", key }, { "n", 0 }, { "minScale", scale }, { "maxScale", scale } };
                            row["n"] = (int)row["n"] + 1;
                            row["minScale"] = Mathf.Min((float)row["minScale"], scale); row["maxScale"] = Mathf.Max((float)row["maxScale"], scale);
                            if (wanted != null && examples.Count < a.Int("examples", 6) && i % 7 == 0) examples.Add(new Dictionary<string, object> { { "item", item.Name }, { "position", new List<object> { R(world.x, 1), R(world.y, 1), R(world.z, 1) } } });
                        }
                    }
            }
            return new Dictionary<string, object> { { "rows", counts.Values.OrderByDescending(r => (int)r["n"]).Select(r => (object)r).ToList() }, { "examples", examples } };
        }

        [BridgeCommand("mesh.classes", "The course's meshes by name with the digits taken out: how many, vertices, how many are readable and carry vertex colours, and the materials (shader) they draw with.",
            args = "contains=Spline, limit=80")]
        static object Classes(BridgeArgs a)
        {
            string contains = a.String("contains") ?? "Spline";
            var groups = new Dictionary<string, Dictionary<string, object>>();
            foreach (var f in Resources.FindObjectsOfTypeAll<MeshFilter>())
            {
                if (OwnScene(f.gameObject) || !f.sharedMesh || f.name.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) continue;
                string key = Regex.Replace(f.name, @"\d+", "#");
                Dictionary<string, object> g;
                if (!groups.TryGetValue(key, out g))
                    groups[key] = g = new Dictionary<string, object> { { "class", key }, { "meshes", 0 }, { "vertices", 0 }, { "readable", 0 }, { "coloured", 0 }, { "materials", new List<object>() }, { "example", f.name } };
                var mesh = f.sharedMesh;
                g["meshes"] = (int)g["meshes"] + 1;
                g["vertices"] = (int)g["vertices"] + mesh.vertexCount;
                if (mesh.isReadable) { g["readable"] = (int)g["readable"] + 1; if (mesh.colors32.Length > 0) g["coloured"] = (int)g["coloured"] + 1; }
                var renderer = f.GetComponent<Renderer>();
                var list = (List<object>)g["materials"];
                if (renderer)
                    foreach (var m in renderer.sharedMaterials.Where(m => m))
                    {
                        string label = m.name + " [" + (m.shader ? m.shader.name : "?") + "]";
                        if (list.Count < 6 && !list.Contains(label)) list.Add(label);
                    }
            }
            return groups.Values.OrderByDescending(g => (int)g["vertices"]).Take(a.Int("limit", 80)).Select(g => (object)g).ToList();
        }

        // One mesh in world space with coincident vertices welded (Unity splits them at UV and
        // normal seams), its boundary edges and neighbours.
        class Welded
        {
            public string name; public GameObject go; public Material material;
            public List<Vector3> pos = new List<Vector3>(); public List<Color> col = new List<Color>(); public List<Vector3> nrm = new List<Vector3>();
            public List<HashSet<int>> near = new List<HashSet<int>>();
            public List<int[]> boundary = new List<int[]>();
            public bool coloured, streamed; public int rawVertices, triangles;
        }

        struct Key : IEquatable<Key>
        {
            public int x, y, z;
            public Key(Vector3 p, float cell) { x = Mathf.RoundToInt(p.x / cell); y = Mathf.RoundToInt(p.y / cell); z = Mathf.RoundToInt(p.z / cell); }
            public bool Equals(Key o) { return x == o.x && y == o.y && z == o.z; }
            public override int GetHashCode() { return x * 73856093 ^ y * 19349663 ^ z * 83492791; }
        }

        static Welded Weld(MeshFilter f)
        {
            var mesh = f.sharedMesh;
            var w = new Welded { name = f.name, go = f.gameObject, rawVertices = mesh.vertexCount };
            var renderer = f.GetComponent<Renderer>();
            w.material = renderer ? renderer.sharedMaterial : null;
            var verts = mesh.vertices; var colors = mesh.colors; var normals = mesh.normals; var tris = mesh.triangles;
            // Hand paint (VertexPainterPro) lives in a stream on the renderer, which is what it draws.
            var meshRenderer = renderer as MeshRenderer;
            var stream = meshRenderer ? meshRenderer.additionalVertexStreams : null;
            if (stream && stream.isReadable && stream.colors.Length == verts.Length) { colors = stream.colors; w.streamed = true; }
            if (stream && stream.isReadable && stream.vertexCount == verts.Length)
            {
                var moved = stream.vertices; var turned = stream.normals;
                if (moved.Length == verts.Length) verts = moved;
                if (turned.Length == verts.Length) normals = turned;
            }
            w.coloured = colors.Length == verts.Length; w.triangles = tris.Length / 3;
            var t = f.transform;
            var ids = new Dictionary<Key, int>();
            var map = new int[verts.Length];
            for (int i = 0; i < verts.Length; i++)
            {
                var p = t.TransformPoint(verts[i]);
                var k = new Key(p, 0.001f);
                int id;
                if (!ids.TryGetValue(k, out id))
                {
                    ids[k] = id = w.pos.Count;
                    w.pos.Add(p); w.col.Add(w.coloured ? colors[i] : Color.clear);
                    w.nrm.Add(normals.Length == verts.Length ? t.TransformDirection(normals[i]) : Vector3.up);
                    w.near.Add(new HashSet<int>());
                }
                map[i] = id;
            }
            var edges = new Dictionary<long, int>();
            for (int i = 0; i < tris.Length; i += 3)
                for (int e = 0; e < 3; e++)
                {
                    int p = map[tris[i + e]], q = map[tris[i + (e + 1) % 3]];
                    if (p == q) continue;
                    w.near[p].Add(q); w.near[q].Add(p);
                    long key = p < q ? ((long)p << 32) | (uint)q : ((long)q << 32) | (uint)p;
                    int n; edges.TryGetValue(key, out n); edges[key] = n + 1;
                }
            foreach (var e in edges) if (e.Value == 1) w.boundary.Add(new[] { (int)(e.Key >> 32), (int)(e.Key & 0xffffffff) });
            return w;
        }

        // XZ distance from p to the nearest of the seam's segments, and the seam's height there.
        static float ToSeam(Vector3 p, List<Vector3[]> seam, out float seamY)
        {
            float best = float.MaxValue; seamY = p.y;
            for (int i = 0; i < seam.Count; i++)
            {
                Vector3 a = seam[i][0], b = seam[i][1];
                float dx = b.x - a.x, dz = b.z - a.z, len = dx * dx + dz * dz;
                float u = len < 1e-10f ? 0 : Mathf.Clamp01(((p.x - a.x) * dx + (p.z - a.z) * dz) / len);
                float ex = a.x + dx * u - p.x, ez = a.z + dz * u - p.z, d = ex * ex + ez * ez;
                if (d < best) { best = d; seamY = a.y + (b.y - a.y) * u; }
            }
            return Mathf.Sqrt(best);
        }

        static string Tone(Color c)
        {
            float m = Mathf.Max(c.r, Mathf.Max(c.g, c.b));
            if (m < 0.25f) return "black";
            return c.r >= c.g && c.r >= c.b ? "red" : c.g >= c.b ? "green" : "blue";
        }

        // The rings of a mesh counted from a start set of welded vertices: per ring how far from
        // the seam it runs (XZ, cm), its height against the seam (cm) and its paint.
        static List<object> Rings(Welded w, List<int> start, List<Vector3[]> seam, int maxRings, out int[] ringOf, out int ringCount)
        {
            ringOf = Enumerable.Repeat(-1, w.pos.Count).ToArray();
            var rows = new List<object>();
            var front = start.Distinct().ToList();
            foreach (int v in front) ringOf[v] = 0;
            int ring = 0;
            while (front.Count > 0)
            {
                if (ring <= maxRings)
                {
                    var dist = new List<float>(); var rel = new List<float>();
                    float r = 0, g = 0, b = 0, al = 0;
                    var tones = new Dictionary<string, int>();
                    foreach (int v in front)
                    {
                        float seamY; float d = ToSeam(w.pos[v], seam, out seamY);
                        dist.Add(d * 100f); rel.Add((w.pos[v].y - seamY) * 100f);
                        var c = w.col[v]; r += c.r; g += c.g; b += c.b; al += c.a;
                        string tone = Tone(c); int n; tones.TryGetValue(tone, out n); tones[tone] = n + 1;
                    }
                    int count = front.Count;
                    rows.Add(new Dictionary<string, object>
                    {
                        { "ring", ring }, { "n", count },
                        { "distCm", new List<object> { R(Pct(dist, 0.1), 1), R(Median(dist), 1), R(Pct(dist, 0.9), 1) } },
                        { "heightCm", new List<object> { R(Pct(rel, 0.1), 1), R(Median(rel), 1), R(Pct(rel, 0.9), 1) } },
                        { "rgba", new List<object> { R(r / count, 2), R(g / count, 2), R(b / count, 2), R(al / count, 2) } },
                        { "tones", tones.OrderByDescending(t => t.Value).ToDictionary(t => t.Key, t => (object)t.Value) },
                    });
                }
                var next = new List<int>();
                foreach (int v in front)
                    foreach (int n in w.near[v])
                        if (ringOf[n] < 0) { ringOf[n] = ring + 1; next.Add(n); }
                front = next; ring++;
            }
            ringCount = ring;
            return rows;
        }

        [BridgeCommand("mesh.bunkers", "Measure how the course's bunkers are built (read-only, numbers only): per bunker mesh its rings counted in from the seam (XZ distance from the seam, height against the seam, vertex paint: p10/median/p90 and mean colour per ring), the interior's depth and paint, per blend strip the same counted outward from the bunker, how far the normals differ across the seam, and the materials with their four paint channels. `detail` bunkers in full, all of them as one line each.",
            args = "contains=Bunker, blend=Blend, detail=4, rings=14, only (part of a bunker name: just those), seamMm=3")]
        static object Bunkers(BridgeArgs a)
        {
            string contains = a.String("contains") ?? "Bunker", blendWord = a.String("blend") ?? "Blend", only = a.String("only");
            int maxRings = a.Int("rings", 14), detail = a.Int("detail", 4);
            float seamTolerance = (float)a.Number("seamMm", 3) / 1000f;
            var filters = Resources.FindObjectsOfTypeAll<MeshFilter>().Where(f => !OwnScene(f.gameObject) && f.sharedMesh && f.name.IndexOf(contains, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
            int unreadable = filters.Count(f => !f.sharedMesh.isReadable);
            var bunkers = new List<Welded>(); var blends = new List<Welded>();
            foreach (var f in filters.Where(f => f.sharedMesh.isReadable).OrderBy(f => f.name))
            {
                bool isBlend = f.name.IndexOf(blendWord, StringComparison.OrdinalIgnoreCase) >= 0;
                if (!isBlend && only != null && f.name.IndexOf(only, StringComparison.OrdinalIgnoreCase) < 0) continue;
                (isBlend ? blends : bunkers).Add(Weld(f));
            }

            // Every bunker's seam vertices, to find where a blend touches which bunker.
            var seamOwner = new Dictionary<Key, int>();
            var seamNormal = new Dictionary<Key, Vector3>();
            for (int b = 0; b < bunkers.Count; b++)
                foreach (var e in bunkers[b].boundary)
                    foreach (int v in e)
                    {
                        var k = new Key(bunkers[b].pos[v], seamTolerance);
                        seamOwner[k] = b; seamNormal[k] = bunkers[b].nrm[v];
                    }
            Func<Vector3, Key?> onSeam = p =>
            {
                var k = new Key(p, seamTolerance);
                for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++)
                        {
                            var n = new Key { x = k.x + x, y = k.y + y, z = k.z + z };
                            if (seamOwner.ContainsKey(n)) return n;
                        }
                return null;
            };

            var blendRows = new Dictionary<int, List<object>>();
            var materials = new Dictionary<string, object>();
            var blendSummary = new List<object>();
            int strays = 0;
            foreach (var w in blends)
            {
                var start = new List<int>(); var owners = new Dictionary<int, int>(); var angles = new List<float>();
                for (int v = 0; v < w.pos.Count; v++)
                {
                    var k = onSeam(w.pos[v]);
                    if (k == null) continue;
                    start.Add(v);
                    int n; owners.TryGetValue(seamOwner[k.Value], out n); owners[seamOwner[k.Value]] = n + 1;
                    angles.Add(Vector3.Angle(w.nrm[v], seamNormal[k.Value]));
                }
                if (start.Count < 2) { strays++; continue; }
                int owner = owners.OrderByDescending(o => o.Value).First().Key;
                var inSeam = new HashSet<int>(start);
                var seam = w.boundary.Where(e => inSeam.Contains(e[0]) && inSeam.Contains(e[1])).Select(e => new[] { w.pos[e[0]], w.pos[e[1]] }).ToList();
                if (seam.Count == 0) { strays++; continue; }
                int[] ringOf; int ringCount;
                var rings = Rings(w, start, seam, maxRings, out ringOf, out ringCount);
                var row = new Dictionary<string, object>
                {
                    { "name", w.name }, { "vertices", w.pos.Count }, { "rows", ringCount - 1 }, { "seamNormalAngleDeg", R(Median(angles), 1) },
                    { "material", w.material ? w.material.name : null }, { "rings", rings },
                };
                List<object> list;
                if (!blendRows.TryGetValue(owner, out list)) blendRows[owner] = list = new List<object>();
                list.Add(row);
                var last = (Dictionary<string, object>)rings[rings.Count - 1];
                blendSummary.Add(new Dictionary<string, object> { { "name", w.name }, { "rows", ringCount - 1 }, { "outerDistCm", ((List<object>)last["distCm"])[1] }, { "outerHeightCm", ((List<object>)last["heightCm"])[1] }, { "seamNormalAngleDeg", R(Median(angles), 1) } });
                if (w.material && !materials.ContainsKey(w.material.name)) materials[w.material.name] = MaterialOf(w.material);
            }

            var lines = new List<object>(); var full = new List<object>();
            for (int b = 0; b < bunkers.Count; b++)
            {
                var w = bunkers[b];
                if (w.material && !materials.ContainsKey(w.material.name)) materials[w.material.name] = MaterialOf(w.material);
                var seam = w.boundary.Select(e => new[] { w.pos[e[0]], w.pos[e[1]] }).ToList();
                if (seam.Count == 0) continue;
                var spacing = seam.Select(s => Vector3.Distance(s[0], s[1]) * 100f).ToList();
                float perimeter = spacing.Sum() / 100f;
                int[] ringOf; int ringCount;
                var rings = Rings(w, w.boundary.SelectMany(e => e).ToList(), seam, maxRings, out ringOf, out ringCount);
                // The floor: everything past the measured rings.
                var depth = new List<float>(); var tones = new Dictionary<string, int>(); var inside = new Dictionary<string, int>();
                float seamMean = seam.Average(s => s[0].y);
                var redSum = Vector3.zero; int redCount = 0;
                for (int v = 0; v < w.pos.Count; v++)
                {
                    if (ringOf[v] >= 4)
                    {
                        string t = Tone(w.col[v]); int k; inside.TryGetValue(t, out k); inside[t] = k + 1;
                        if (t == "red") { redSum += w.pos[v]; redCount++; }
                    }
                    if (ringOf[v] <= maxRings) continue;
                    depth.Add((w.pos[v].y - seamMean) * 100f);
                    string tone = Tone(w.col[v]); int n; tones.TryGetValue(tone, out n); tones[tone] = n + 1;
                }
                var all = w.pos.Select(p => (p.y - seamMean) * 100f).ToList();
                var seamY = seam.Select(s => s[0].y * 100f).ToList();
                var line = new Dictionary<string, object>
                {
                    { "name", w.name }, { "vertices", w.pos.Count }, { "triangles", w.triangles }, { "coloured", w.coloured }, { "perimeterM", R(perimeter, 1) },
                    { "seamSpacingCm", new List<object> { R(Pct(spacing, 0.1), 1), R(Median(spacing), 1), R(Pct(spacing, 0.9), 1) } },
                    { "ringsToCentre", ringCount - 1 }, { "lowestCm", R(all.Min(), 1) }, { "highestCm", R(all.Max(), 1) },
                    { "seamHeightRangeCm", R(Pct(seamY, 0.95) - Pct(seamY, 0.05), 1) },
                    { "material", w.material ? w.material.name : null }, { "blends", blendRows.ContainsKey(b) ? blendRows[b].Count : 0 },
                    { "paintFromStream", w.streamed }, { "insideTones", inside.ToDictionary(t => t.Key, t => (object)t.Value) },
                    { "children", Enumerable.Range(0, w.go.transform.childCount).Select(i => (object)w.go.transform.GetChild(i).name).Take(8).ToList() },
                    { "layer", LayerMask.LayerToName(w.go.layer) }, { "tag", w.go.tag },
                    { "components", w.go.GetComponents<Component>().Select(c => (object)(c ? c.GetType().Name : "(missing script)")).ToList() },
                };
                if (redCount > 0) { var c = redSum / redCount; line["redInsideAt"] = new List<object> { R(c.x, 1), R(c.y, 1), R(c.z, 1) }; }
                lines.Add(line);
                if (full.Count >= detail) continue;
                var d = new Dictionary<string, object>(line);
                d["rings"] = rings;
                d["floor"] = new Dictionary<string, object> { { "vertices", depth.Count }, { "heightCm", new List<object> { R(Pct(depth, 0.1), 1), R(Median(depth), 1), R(Pct(depth, 0.9), 1) } }, { "tones", tones.ToDictionary(t => t.Key, t => (object)t.Value) } };
                d["blendStrips"] = blendRows.ContainsKey(b) ? blendRows[b] : new List<object>();
                full.Add(d);
            }
            return new Dictionary<string, object>
            {
                { "bunkerMeshes", bunkers.Count }, { "blendMeshes", blends.Count }, { "blendsNotOnASeam", strays }, { "unreadableMeshes", unreadable },
                { "materials", materials }, { "detail", full }, { "bunkers", lines }, { "blends", blendSummary },
            };
        }
    }
}
