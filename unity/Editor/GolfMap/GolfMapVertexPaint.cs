// Unity 2018.2 / C# 6. The course meshes' vertex paint in Unity: materials, temporary previews, and the tools that
// read the paint.
//
// OPCD's "4 color Vert Paint MAHS" material draws one texture per paint channel (red, green, blue, black), and
// StixGames' 3D grass on the rough meshes (NewRough: ONE_GRASS_TYPE + VERTEX_DENSITY) spawns a blade with the
// probability of the vertex colour's red component.
//
// The paint itself is Blender's: the course meshes (Spline_*) are shaped AND rule-painted only in the Blender shaping
// replay, and the colours come in with the FBX. paint.json's rules and hand strokes (docs/gspro/<course>/paint.json,
// golfmap-paint-v1) are the `golfmap.paint` ops of layer 90-paint (gspro.py shaping-paint, blender/tools/
// shape_paintop.py), the stone walls' bank ground and paint are `golfmap.wall_ground` of layer 80-walls (gspro.py
// shaping-walls). Unity never moves or adds a course-mesh vertex and never paints one by rules. What is left here:
//
// - golfmap.paint.materials (golfmap.course.refresh's paint.materials step, and after golfmap.meshes.sync): MATERIALS,
//   which are not paint: an object rule's `material` in <course>/paint.json (the Unity project's course folder copy)
//   gives the matching meshes a course copy of the nearest rough's (or their own) OPCD material with its channel
//   drawing the pebbles / shore grass (creek beds, pond shores: <course>/Creeks/<base> (<name>).mat, copyFromRough,
//   scale*); `grassFrom: "rough"` copies the nearest rough's Stix grass components onto them; and Rough / Deep meshes
//   on the bank of a stone wall with ground whose FBX colours carry the wall's ground channel wear the walls' stone
//   copy <course>/Walls/<rough> (stone).mat (GolfMapWallGround.StoneMaterial; GolfMapSurfaces' Rock class keys on it).
//   The material each had before is remembered in <course>/PaintedMeshes/restore.json.
// - golfmap.paint.meshes / golfmap.paint.preview / golfmap.paint.clear: a TEMPORARY preview of a paint change (the web
//   Terrain editor's Paint tool, bun run paint: server/services/paint.service.ts computes the colours with
//   blender/tools/shape_paintpreview.py from what paint.meshes sends). A preview is a colour-only copy of the FBX mesh
//   under <course>/PaintedMeshes/<object>.asset in the MeshFilter (the MeshCollider stays on the FBX mesh), the Stix
//   NatureMeshFilter cache reset so the grass follows; restore.json marks it `preview` with the FBX file's stamp. It
//   lasts until the object's next FBX import (golfmap.meshes.sync re-adds the object and drops the entry; a preview
//   whose FBX changed under it is cleared by paint.materials).
// - golfmap.paint.restore: every copy (preview or the old rule-paint / wall-ground copies of before the switch) and
//   every recorded material back to the FBX's, and the big lake's old bed copies (GolfMapLake.RestoreBedCopies).
// - read-only tools: golfmap.paint.probe, survey, streams (OPCD VertexPainterPro hand-paint streams).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapVertexPaint
    {
        public const string Format = "golfmap-paint-v1";
        const string RestoreFormat = "golfmap-paint-restore-v1";
        const string PaintFile = "paint.json";
        const string MeshFolder = "PaintedMeshes";
        const string RestoreFile = "restore.json";
        const string NatureMeshFilterType = "StixGames.NatureCore.NatureMeshFilter";
        const string GrassRendererType = "StixGames.GrassShader.GrassRenderer";
        const string PainterStreamType = "VertexInstanceStream";  // OPCD ships VertexPainterPro in a DLL; matched by class name
        const string BunkerBlendMarker = "_Bunker_-_Blend";

        // ------------------------------------------------------------ paint.json: the material part

        // An enabled kind 'object' rule of paint.json, as far as Unity still reads it: `match` (a substring of the object's
        // name) picks the meshes; `material` (optional) gives them a copy of the nearest rough's OPCD MAHS material (or their
        // own: base "self") whose `channel` draws albedo + normal (black on a creek bed = the pebbles); copyFromRough =
        // [{from, to}] channels taken from that rough; scale* = a channel's overall colour times this; grassFrom "rough"
        // copies the nearest rough's Stix grass components (GrassRenderer, grassonoffnew, NatureMeshFilter) onto them.
        // The rule's paint (belowM, shoreM, fadeM, creek ...) is Blender's golfmap.paint op; edge and road rules too.
        sealed class MaterialRule
        {
            public string id, match, channel;
            public bool grassFromRough;
            public string albedo, normal;     // material: asset paths, null = no texture on the channel
            public float tileM = 1f;
            public Color tint = Color.white;
            public bool hasMaterial, baseSelf;
            public string matName = "creek bed", matFolder = "Creeks";
            public List<string[]> copyRough = new List<string[]>();
            public float scaleRed = 1f, scaleGreen = 1f, scaleBlue = 1f, scaleBlack = 1f;
        }

        static float Num(object o) { var n = o as GolfMapJsonNumber; return n == null ? 0f : (float)n.Value; }

        static List<MaterialRule> LoadMaterialRules(string text, string path)
        {
            var root = GolfMapJsonDoc.ParseObject(text);
            if (root.String("format") != Format) throw new InvalidOperationException(path + ": format must be " + Format + ".");
            var rules = new List<MaterialRule>();
            var list = root.Array("rules") ?? new List<object>();
            for (int i = 0; i < list.Count; i++)
            {
                var o = list[i] as GolfMapJsonObject;
                if (o == null || o.String("kind") != "object") continue;
                if (o["enabled"] is bool && !(bool)o["enabled"]) continue;
                string where = path + " rules[" + i + "]";
                var r = new MaterialRule
                {
                    id = o.String("id") ?? ("rule" + i),
                    match = o.String("match"),
                    channel = (o.String("channel") ?? "black").ToLowerInvariant(),
                    grassFromRough = o.String("grassFrom") == "rough",
                };
                if (string.IsNullOrEmpty(r.match)) throw new InvalidOperationException(where + ": an object rule needs match (a name substring).");
                ChannelColor(r.channel, where);
                var m = o["material"] as GolfMapJsonObject;
                if (m != null)
                {
                    r.hasMaterial = true;
                    r.baseSelf = m.String("base") == "self";
                    r.matName = m.String("name") ?? r.matName;
                    r.matFolder = m.String("folder") ?? r.matFolder;
                    r.albedo = m.String("albedo");
                    r.normal = m.String("normal");
                    if (string.IsNullOrEmpty(r.albedo) != string.IsNullOrEmpty(r.normal)) throw new InvalidOperationException(where + ": material needs albedo and normal (asset paths) together.");
                    foreach (var c in (m.Array("copyFromRough") ?? new List<object>()).OfType<GolfMapJsonObject>())
                    {
                        string from = c.String("from"), to = c.String("to");
                        ChannelColor((from ?? "").ToLowerInvariant(), where); ChannelColor((to ?? "").ToLowerInvariant(), where);
                        r.copyRough.Add(new[] { from.ToLowerInvariant(), to.ToLowerInvariant() });
                    }
                    r.scaleRed = (float)m.Number("scaleRed", 1); r.scaleGreen = (float)m.Number("scaleGreen", 1);
                    r.scaleBlue = (float)m.Number("scaleBlue", 1); r.scaleBlack = (float)m.Number("scaleBlack", 1);
                    r.tileM = (float)m.Number("tileM", 1);
                    var tint = m.Array("tint");
                    if (tint != null && tint.Count >= 3) r.tint = new Color(Num(tint[0]), Num(tint[1]), Num(tint[2]), 1f);
                }
                rules.Add(r);
            }
            return rules;
        }

        static Color ChannelColor(string channel, string where)
        {
            switch (channel)
            {
                case "red": return new Color(1, 0, 0);
                case "green": return new Color(0, 1, 0);
                case "blue": return new Color(0, 0, 1);
                case "black": return new Color(0, 0, 0);
            }
            throw new InvalidOperationException(where + ": channel must be red, green, blue or black.");
        }

        // A copy of the nearest rough's material (<course>/Creeks/<rough> (creek bed).mat) whose rule channel draws the
        // pebbles; rebuilt from the rough on every run so the rule wins. The copy keeps every other channel, so the
        // bed's red fringe still draws the grass ground around it.
        static Material CreekBedMaterial(string courseFolder, MaterialRule rule, Material rough, Material own)
        {
            var baseMat = rule.baseSelf ? own : rough;
            if (baseMat == null || !rule.hasMaterial) return null;
            var dir = courseFolder + rule.matFolder;
            if (!AssetDatabase.IsValidFolder(dir)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), rule.matFolder);
            var path = dir + "/" + baseMat.name + " (" + rule.matName + ").mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null) { m = new Material(baseMat) { name = baseMat.name + " (" + rule.matName + ")" }; AssetDatabase.CreateAsset(m, path); }
            else { m.shader = baseMat.shader; m.CopyPropertiesFromMaterial(baseMat); }
            foreach (var c in rule.copyRough)
                if (rough != null) CopyChannel(m, rough, c[0], c[1]);
            if (!string.IsNullOrEmpty(rule.albedo))
            {
                GolfMapWallGround.ApplyChannelTexture(m, rule.channel, rule.albedo, rule.normal, rule.tileM, rule.tint, dir);
                // the photo under the base would tint the pebbles
                string p = "_" + char.ToUpperInvariant(rule.channel[0]) + rule.channel.Substring(1);
                if (m.HasProperty(p + "UseSatelliteForBase")) m.SetFloat(p + "UseSatelliteForBase", 0);
                m.DisableKeyword((p + "UseSatelliteForBase").ToUpperInvariant() + "_ON");
            }
            ScaleChannel(m, "Red", rule.scaleRed); ScaleChannel(m, "Green", rule.scaleGreen);
            ScaleChannel(m, "Blue", rule.scaleBlue); ScaleChannel(m, "Black", rule.scaleBlack);
            EditorUtility.SetDirty(m);
            return m;
        }

        static string CapChannel(string channel) { return char.ToUpperInvariant(channel[0]) + channel.Substring(1); }

        // Every _<To>* property and _<TO>*_ON keyword of `m` set from the same _<From>* of `src` (a channel of the nearest rough's material
        // drawn on another or the same channel: the pond bed's shore band is the rough's own grass).
        static void CopyChannel(Material m, Material src, string from, string to)
        {
            string F = CapChannel(from), T = CapChannel(to);
            var shader = m.shader;
            for (int i = 0; i < ShaderUtil.GetPropertyCount(shader); i++)
            {
                var name = ShaderUtil.GetPropertyName(shader, i);
                if (!name.StartsWith("_" + T, StringComparison.Ordinal)) continue;
                var other = "_" + F + name.Substring(1 + T.Length);
                if (!src.HasProperty(other)) continue;
                switch (ShaderUtil.GetPropertyType(shader, i))
                {
                    case ShaderUtil.ShaderPropertyType.Color: m.SetColor(name, src.GetColor(other)); break;
                    case ShaderUtil.ShaderPropertyType.Vector: m.SetVector(name, src.GetVector(other)); break;
                    case ShaderUtil.ShaderPropertyType.Float:
                    case ShaderUtil.ShaderPropertyType.Range: m.SetFloat(name, src.GetFloat(other)); break;
                    case ShaderUtil.ShaderPropertyType.TexEnv:
                        m.SetTexture(name, src.GetTexture(other));
                        m.SetTextureScale(name, src.GetTextureScale(other));
                        m.SetTextureOffset(name, src.GetTextureOffset(other));
                        break;
                }
            }
            string TU = "_" + T.ToUpperInvariant(), FU = "_" + F.ToUpperInvariant();
            var kw = new HashSet<string>(m.shaderKeywords.Where(k => !k.StartsWith(TU, StringComparison.Ordinal)));
            foreach (var k in src.shaderKeywords) if (k.StartsWith(FU, StringComparison.Ordinal)) kw.Add(TU + k.Substring(FU.Length));
            m.shaderKeywords = kw.ToArray();
        }

        // The channel's overall colour times `scale` (a few percent darker: 0.9).
        static void ScaleChannel(Material m, string channel, float scale)
        {
            string p = "_" + channel + "OverallColor";
            if (Mathf.Approximately(scale, 1f) || !m.HasProperty(p)) return;
            var c = m.GetColor(p);
            m.SetColor(p, new Color(c.r * scale, c.g * scale, c.b * scale, c.a));
        }

        // The material of the rough mesh nearest to `bed` (by bounds centre) that is a plain OPCD one: no walls stone
        // copy, no creek bed copy.
        static Material NearestRoughMaterial(List<MeshFilter> all, Vector3 centre)
        {
            Material best = null;
            float bestD = float.MaxValue;
            foreach (var f in all)
            {
                if (GolfMapSurfaces.Classify(f.name) != GolfMapSurfaces.Surface.Rough) continue;
                var r = f.GetComponent<Renderer>();
                if (r == null || r.sharedMaterial == null) continue;
                var assetPath = AssetDatabase.GetAssetPath(r.sharedMaterial);
                if (assetPath.IndexOf("/Walls/", StringComparison.OrdinalIgnoreCase) >= 0 || assetPath.IndexOf("/Creeks/", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                var dc = r.bounds.center - centre; float d = dc.x * dc.x + dc.z * dc.z;
                if (d < bestD) { bestD = d; best = r.sharedMaterial; }
            }
            return best;
        }

        // ------------------------------------------------------------ commands

        [MenuItem("GolfMap/Vertex Paint/Apply materials (paint.json, wall stone)")]
        static void MaterialsMenu() { Debug.Log("[GolfMap Vertex paint] " + GolfMapJson.Serialize(Materials(false), false)); }

        [MenuItem("GolfMap/Vertex Paint/Clear paint previews")]
        static void ClearMenu() { Debug.Log("[GolfMap Vertex paint] " + GolfMapJson.Serialize(Clear(null), false)); }

        [MenuItem("GolfMap/Vertex Paint/Restore original meshes and materials")]
        static void RestoreMenu() { Debug.Log("[GolfMap Vertex paint] " + GolfMapJson.Serialize(Restore(true), false)); }

        [BridgeCommand("golfmap.paint.materials", "The course meshes' materials (not paint: the paint is Blender's): every mesh an enabled object rule with `material` in <course>/paint.json matches wears its copy of the nearest rough's (or its own) OPCD material (creek bed, pond shore: <course>/<folder>/<base> (<name>).mat, rebuilt from the rule), grassFrom rough copies the nearest rough's Stix grass components, and Rough/Deep meshes on the bank of a stone wall with ground whose FBX colours carry its ground channel wear <course>/Walls/<rough> (stone).mat. Meshes no longer concerned get their recorded material back; original materials are kept in <course>/PaintedMeshes/restore.json. Also clears paint previews whose FBX changed under them, and reports copies left from before the switch (golfmap.paint.restore). Never changes a mesh's vertices or colours. Marks the scene dirty, does not save it.",
            args = "dryRun=false (report what would change, change nothing), only (object names, comma-separated: just these)")]
        static object MaterialsCommand(BridgeArgs a)
        {
            var only = a.Strings("only").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return Materials(a.Bool("dryRun", false), only.Count == 0 ? null : only);
        }

        [BridgeCommand("golfmap.paint.bedmaterial", "Build the creek bed material of paint.json's first object rule with a material (a copy of the nearest rough's OPCD material with the rule's pebbles on its channel, <course>/Creeks/) and return its path; touches no scene object. golfmap.paint.materials does the same for every matching mesh.",
            args = "x, z (plot metres: the rough nearest to this point is copied; default 0, 0)")]
        static object BedMaterialCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            var recipePath = folder + PaintFile;
            var rule = (File.Exists(recipePath) ? LoadMaterialRules(File.ReadAllText(recipePath), recipePath) : new List<MaterialRule>()).FirstOrDefault(r => r.hasMaterial && !r.baseSelf);
            if (rule == null) throw new BridgeError(recipePath + ": no object rule with a material.");
            var centre = new Vector3((float)a.Number("x", 0), 0, (float)a.Number("z", 0));
            var rough = NearestRoughMaterial(CourseMeshes(EditorSceneManager.GetActiveScene()), centre);
            var bed = CreekBedMaterial(folder, rule, rough, null);
            AssetDatabase.SaveAssets();
            return new Dictionary<string, object> { { "rule", rule.id }, { "rough", rough != null ? AssetDatabase.GetAssetPath(rough) : null }, { "material", bed != null ? AssetDatabase.GetAssetPath(bed) : null } };
        }

        [BridgeCommand("golfmap.paint.restore", "Put every course mesh copy under <course>/PaintedMeshes/ (paint previews, and the rule-paint and wall-ground copies Unity made before the paint moved to Blender) back to its FBX mesh, every recorded material (creek bed, wall stone) back to the original, reset the Stix grass caches, and (lakeBed) the big lake's old <course>/Lake/Bed/ copies back to their FBX meshes. The copy assets stay on disk. Run once when switching to Blender paint, then a full golfmap.course.refresh. Marks the scene dirty, does not save it.",
            args = "lakeBed=true")]
        static object RestoreCommand(BridgeArgs a) { return Restore(a.Bool("lakeBed", true)); }

        [BridgeCommand("golfmap.paint.meshes", "Read-only: the course meshes (Spline_*, no water planes) whose world bounds meet an EPSG:3006 box, as the paint preview reads them: {course, meshes:[{object, surface (GolfMapSurfaces class), vertexCount, positions (base64 float32 x,y,z, Unity world), colors (base64 float32 r,g,b,a of the FBX mesh - the source even while a preview shows; empty when it has none), triangles (base64 int32, every submesh), preview (a preview shows now)}], skipped:[{object, why}]}. All arrays are of the FBX mesh the object comes from.",
            args = "within=[minE, minN, maxE, maxN] (EPSG:3006; through the inner DEM sidecar's frame), names (object names, list or comma-separated; with within both must hold; one of the two is required)")]
        static object MeshesCommand(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var namesList = a.Strings("names").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            var names = namesList.Count == 0 ? null : new HashSet<string>(namesList, StringComparer.Ordinal);
            var w = a.List("within");
            Rect? box = null;
            if (w != null)
            {
                if (w.Count != 4 || !w.All(o => o is double)) throw new BridgeError("within must be [minE, minN, maxE, maxN] (EPSG:3006 metres).");
                double e0, n0; Vector3 origin;
                GolfMapProps.Frame(course, out e0, out n0, out origin);
                box = Rect.MinMaxRect(
                    (float)((double)w[0] - e0) + origin.x, (float)((double)w[1] - n0) + origin.z,
                    (float)((double)w[2] - e0) + origin.x, (float)((double)w[3] - n0) + origin.z);
            }
            else if (names == null) throw new BridgeError("Give within (an EPSG:3006 box) or names.");
            var meshFolder = GolfMapCourses.Folder(course) + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);
            var scene = EditorSceneManager.GetActiveScene();
            var meshes = new List<object>();
            var skipped = new List<object>();
            foreach (var f in CourseMeshes(scene))
            {
                if (names != null && !names.Contains(f.name)) continue;
                var r = f.GetComponent<Renderer>();
                if (r == null) continue;
                if (box.HasValue)
                {
                    var b = r.bounds; var x = box.Value;
                    if (b.max.x < x.xMin || b.min.x > x.xMax || b.max.z < x.yMin || b.min.z > x.yMax) continue;
                }
                var path = PathOf(f.transform);
                bool copy = IsPaintedCopy(f.sharedMesh, meshFolder);
                var source = copy ? LoadOriginal(records, path) : f.sharedMesh;
                if (source == null) { skipped.Add(Why(f.name, "shows a copy under " + MeshFolder + "/ whose FBX mesh is not in " + RestoreFile)); continue; }
                var local = source.vertices;
                var positions = new float[local.Length * 3];
                for (int i = 0; i < local.Length; i++)
                {
                    var p = f.transform.TransformPoint(local[i]);
                    positions[3 * i] = p.x; positions[3 * i + 1] = p.y; positions[3 * i + 2] = p.z;
                }
                var cols = source.colors;
                float[] colors = new float[0];
                if (cols != null && cols.Length == local.Length)
                {
                    colors = new float[cols.Length * 4];
                    for (int i = 0; i < cols.Length; i++) { colors[4 * i] = cols[i].r; colors[4 * i + 1] = cols[i].g; colors[4 * i + 2] = cols[i].b; colors[4 * i + 3] = cols[i].a; }
                }
                Record rec;
                records.TryGetValue(path, out rec);
                meshes.Add(new Dictionary<string, object>
                {
                    { "object", f.name }, { "surface", GolfMapSurfaces.Classify(f.name).ToString() }, { "vertexCount", local.Length },
                    { "positions", B64(positions) }, { "colors", colors.Length == 0 ? "" : B64(colors) }, { "triangles", B64(source.triangles) },
                    { "preview", copy && rec != null && rec.preview },
                });
            }
            var result = new Dictionary<string, object> { { "course", GolfMapCourses.Name(course) }, { "meshes", meshes }, { "skipped", skipped } };
            if (w != null) result["within"] = w;
            return result;
        }

        [BridgeCommand("golfmap.paint.preview", "Show paint TEMPORARILY: each object's MeshFilter gets a colour-only copy of its FBX mesh with these colours (<course>/PaintedMeshes/<object>.asset; the MeshCollider stays on the FBX mesh), its Stix grass cache reset, restore.json marks it a preview with the FBX file's stamp. It lasts until the object's next FBX import (golfmap.meshes.sync), golfmap.paint.clear or golfmap.paint.restore. The colours must have the FBX mesh's vertex count (golfmap.paint.meshes), else the object is skipped. Marks the scene dirty, does not save it.",
            args = "objects=[{object, colors (base64 float32 r,g,b,a per vertex of the FBX mesh)}]")]
        static object PreviewCommand(BridgeArgs a)
        {
            var list = a.List("objects");
            if (list == null) throw new BridgeError("objects=[{object, colors}] is required.");
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            var meshFolder = folder + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);
            var scene = EditorSceneManager.GetActiveScene();
            var byName = CourseMeshes(scene).GroupBy(f => f.name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
            var previewed = new List<object>();
            var skipped = new List<object>();
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Paint preview");
            int undoGroup = Undo.GetCurrentGroup();
            EnsureMeshFolder(folder);
            foreach (var item in list)
            {
                var d = item as Dictionary<string, object>;
                var name = d == null ? null : d.ContainsKey("object") ? d["object"] as string : null;
                if (string.IsNullOrEmpty(name)) { skipped.Add(Why(null, "an entry without object")); continue; }
                var b64 = d.ContainsKey("colors") ? d["colors"] as string : null;
                if (string.IsNullOrEmpty(b64)) { skipped.Add(Why(name, "no colors")); continue; }
                List<MeshFilter> found;
                if (!byName.TryGetValue(name, out found)) { skipped.Add(Why(name, "no course mesh object of that name in the scene")); continue; }
                if (found.Count > 1) { skipped.Add(Why(name, found.Count + " objects carry that name")); continue; }
                var f = found[0];
                var path = PathOf(f.transform);
                bool copy = IsPaintedCopy(f.sharedMesh, meshFolder);
                var source = copy ? LoadOriginal(records, path) : f.sharedMesh;
                if (source == null) { skipped.Add(Why(name, "shows a copy whose FBX mesh is not in " + RestoreFile + " (golfmap.paint.restore, or re-sync it)")); continue; }
                var fbx = AssetDatabase.GetAssetPath(source);
                if (!fbx.EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) { skipped.Add(Why(name, "its mesh is not an FBX mesh (" + (fbx.Length == 0 ? "not an asset" : fbx) + ")")); continue; }
                float[] values;
                try { values = Floats(b64); }
                catch (FormatException) { skipped.Add(Why(name, "colors is not base64 float32")); continue; }
                if (values.Length != source.vertexCount * 4) { skipped.Add(Why(name, "colors has " + (values.Length / 4.0) + " vertices, the FBX mesh " + source.vertexCount)); continue; }
                var cols = new Color[source.vertexCount];
                for (int i = 0; i < cols.Length; i++) cols[i] = new Color(values[4 * i], values[4 * i + 1], values[4 * i + 2], values[4 * i + 3]);

                var mesh = UnityEngine.Object.Instantiate(source);
                mesh.name = source.name + " (preview)";
                mesh.colors = cols;
                var assetPath = meshFolder + Safe(f.name) + ".asset";
                var existing = AssetDatabase.LoadAssetAtPath<Mesh>(assetPath);
                Mesh saved;
                if (existing == null) { AssetDatabase.CreateAsset(mesh, assetPath); saved = mesh; }
                else { Overwrite(existing, mesh); UnityEngine.Object.DestroyImmediate(mesh); saved = existing; EditorUtility.SetDirty(saved); }
                SetMesh(f, saved, source);
                Record rec;
                if (!records.TryGetValue(path, out rec)) records[path] = rec = new Record();
                rec.asset = fbx; rec.mesh = source.name; rec.preview = true; rec.stamp = Stamp(fbx);
                previewed.Add(name);
            }
            Undo.CollapseUndoOperations(undoGroup);
            if (previewed.Count > 0)
            {
                SaveRecords(meshFolder + RestoreFile, records);
                AssetDatabase.SaveAssets();
                EditorSceneManager.MarkSceneDirty(scene);
                SceneView.RepaintAll();
            }
            return new Dictionary<string, object> { { "previewed", previewed }, { "skipped", skipped } };
        }

        [BridgeCommand("golfmap.paint.clear", "Paint previews back to the FBX mesh (golfmap.paint.preview's copies): the named objects, or every preview. Recorded materials stay. Marks the scene dirty, does not save it.",
            args = "objects (object names, list or comma-separated; default every preview)")]
        static object ClearCommand(BridgeArgs a)
        {
            var names = a.Strings("objects").SelectMany(s => s.Split(',')).Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
            return Clear(names.Count == 0 ? null : names);
        }

        // ------------------------------------------------------------ materials

        // only / within (golfmap.course.refresh only=): just the named objects and the course meshes whose bounds meet one
        // of the `within` boxes (XZ). Objects outside keep what they wear. Both null = every course mesh.
        public static Dictionary<string, object> Materials(bool dryRun, ICollection<string> only = null, IList<Bounds> within = null)
        {
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course);
            var recipePath = folder + PaintFile;
            var rules = File.Exists(recipePath) ? LoadMaterialRules(File.ReadAllText(recipePath), recipePath) : new List<MaterialRule>();
            var walls = GolfMapWallGround.Load(course);
            var meshFolder = folder + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);
            var scene = EditorSceneManager.GetActiveScene();
            var errors = new List<string>();
            var warnings = new List<string>();
            bool changed = false;

            if (!dryRun)
            {
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Course mesh materials");
            }
            int undoGroup = Undo.GetCurrentGroup();

            // A copy whose asset is gone (deleted, or zeroed by a crash) leaves an empty MeshFilter that CourseMeshes
            // skips: its FBX mesh back first.
            var healed = new List<object>();
            foreach (var f in scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true)))
            {
                var path = PathOf(f.transform);
                Record rec;
                if (f.sharedMesh != null || !records.TryGetValue(path, out rec)) continue;
                var original = LoadOriginal(records, path);
                if (original == null) continue;
                healed.Add(path);
                if (dryRun) continue;
                SetMesh(f, original, original);
                DropPreview(records, path);
                changed = true;
            }
            // A preview whose FBX changed since (re-exported, not yet re-synced) shows old colours: back to the FBX mesh.
            var stalePreviews = new List<object>();
            foreach (var f in CourseMeshes(scene))
            {
                var path = PathOf(f.transform);
                Record rec;
                if (!records.TryGetValue(path, out rec) || !rec.preview || !IsPaintedCopy(f.sharedMesh, meshFolder) || rec.stamp == Stamp(rec.asset)) continue;
                var original = LoadOriginal(records, path);
                if (original == null) continue;
                stalePreviews.Add(f.name);
                if (dryRun) continue;
                SetMesh(f, original, original);
                DropPreview(records, path);
                changed = true;
            }

            var allFilters = CourseMeshes(scene);
            bool scoped = only != null || within != null;
            var boxes = within ?? new List<Bounds>();
            var named = only == null ? null : new HashSet<string>(only, StringComparer.Ordinal);
            Func<MeshFilter, bool> near = f =>
            {
                var r = f.GetComponent<Renderer>();
                if (r == null) return false;
                var b = r.bounds;
                return boxes.Any(x => b.max.x >= x.min.x && b.min.x <= x.max.x && b.max.z >= x.min.z && b.min.z <= x.max.z);
            };
            var filters = !scoped ? allFilters : allFilters.Where(f => (named != null && named.Contains(f.name)) || near(f)).ToList();

            var wearing = new List<object>();
            var putBack = new List<object>();
            var grass = new List<object>();
            var legacy = new List<string>();
            foreach (var f in filters)
            {
                var mr = f.GetComponent<MeshRenderer>();
                if (mr == null) continue;
                var path = PathOf(f.transform);
                var surface = GolfMapSurfaces.Classify(f.name);
                bool copy = IsPaintedCopy(f.sharedMesh, meshFolder);
                Record rec;
                records.TryGetValue(path, out rec);
                if (copy && (rec == null || !rec.preview)) legacy.Add(f.name);
                var source = copy ? LoadOriginal(records, path) : f.sharedMesh;
                var mine = rules.Where(r => f.name.IndexOf(r.match, StringComparison.Ordinal) >= 0).ToList();

                if (mine.Any(r => r.grassFromRough) && Component(f, NatureMeshFilterType) == null)
                {
                    grass.Add(f.name);
                    if (!dryRun && EnsureGrassComponents(f, allFilters)) { ResetGrassCache(f); changed = true; }
                }

                // what it should wear: an object rule's material, else the walls' stone, else what it had
                var bedRule = mine.FirstOrDefault(r => r.hasMaterial);
                bool stone = bedRule == null && walls != null && source != null
                    && (surface == GolfMapSurfaces.Surface.Rough || surface == GolfMapSurfaces.Surface.Deep)
                    && walls.Meets(mr.bounds) && walls.StoneVertices(f, source) >= GolfMapWallGround.MinStoneVertices;
                var known = RecordMaterial(records, path);
                if (bedRule == null && !stone)
                {
                    if (known != null)
                    {
                        putBack.Add(f.name);
                        if (!dryRun)
                        {
                            if (mr.sharedMaterial != known) { PutBackMaterial(f, records, path); changed = true; }
                            rec.material = null;
                            if (!rec.preview && !copy) records.Remove(path);
                        }
                    }
                    else if (mr.sharedMaterial != null && IsOurMaterial(folder, rules, mr.sharedMaterial))
                        errors.Add(path + ": wears " + AssetDatabase.GetAssetPath(mr.sharedMaterial) + " but its original material is not in " + RestoreFile + "; reassign it by hand (or re-sync the mesh).");
                    continue;
                }
                if (source == null) { errors.Add(path + ": shows a copy whose FBX mesh is not in " + RestoreFile + "; golfmap.paint.restore, or re-sync the mesh."); continue; }
                var original = known ?? mr.sharedMaterial;
                if (known == null && original != null && IsOurMaterial(folder, rules, original))
                {
                    errors.Add(path + ": wears " + AssetDatabase.GetAssetPath(original) + " but its original material is not in " + RestoreFile + "; reassign it by hand (or re-sync the mesh).");
                    continue;
                }
                string why = bedRule != null ? "rule " + bedRule.id : "stone wall bank";
                if (dryRun) { wearing.Add(new Dictionary<string, object> { { "object", f.name }, { "why", why }, { "from", original != null ? AssetDatabase.GetAssetPath(original) : null } }); continue; }
                Material want;
                if (bedRule != null)
                {
                    want = CreekBedMaterial(folder, bedRule, NearestRoughMaterial(allFilters, mr.bounds.center), original);
                    if (want == null) { warnings.Add(path + ": no material to copy for rule " + bedRule.id + " (a rough mesh with a plain material, or the mesh's own)."); continue; }
                }
                else
                {
                    want = walls.StoneMaterial(original);
                    if (want == null) { warnings.Add(path + ": on a wall bank with ground, but the walls spec names no stoneMaterial."); continue; }
                }
                if (mr.sharedMaterial != want) { Undo.RecordObject(mr, "Course mesh materials"); mr.sharedMaterial = want; changed = true; }
                if (original != null && original != want)
                {
                    if (rec == null) records[path] = rec = new Record { asset = AssetDatabase.GetAssetPath(source), mesh = source.name };
                    rec.material = AssetDatabase.GetAssetPath(original);
                }
                wearing.Add(new Dictionary<string, object> { { "object", f.name }, { "why", why }, { "material", AssetDatabase.GetAssetPath(want) } });
            }

            if (!dryRun)
            {
                Undo.CollapseUndoOperations(undoGroup);
                if (records.Count > 0) EnsureMeshFolder(folder);
                SaveRecords(meshFolder + RestoreFile, records);
                AssetDatabase.SaveAssets();
                if (changed) EditorSceneManager.MarkSceneDirty(scene);
                SceneView.RepaintAll();
            }
            if (legacy.Count > 0)
                warnings.Add(legacy.Count + " course mesh(es) still show a rule-paint / wall-ground copy Unity made before the paint moved to Blender (e.g. " + legacy[0] + "): golfmap.paint.restore, then a full golfmap.course.refresh.");

            var result = new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "recipe", File.Exists(recipePath) ? recipePath : null },
                { "dryRun", dryRun },
                { "materialRules", rules.Where(r => r.hasMaterial || r.grassFromRough).Select(r => (object)r.id).ToList() },
                { "wallsWithGround", walls == null ? new List<object>() : walls.Ids.Cast<object>().ToList() },
                { "wearing", wearing },
                { "putBack", putBack },
                { "grassComponents", grass },
                { "healed", healed },
                { "stalePreviews", stalePreviews },
                { "legacyCopies", legacy.Count },
                { "warnings", warnings },
                { "errors", errors },
            };
            if (scoped) result["scope"] = new Dictionary<string, object> { { "meshesInScope", filters.Count }, { "courseMeshes", allFilters.Count } };
            WriteReport(course, result);
            return result;
        }

        // A material one of our tools made for a course mesh: a walls stone copy, or a rule's copy (its folder, default
        // Creeks, and its ' (<name>)' suffix) under the course folder.
        static bool IsOurMaterial(string courseFolder, List<MaterialRule> rules, Material m)
        {
            var p = AssetDatabase.GetAssetPath(m);
            if (!p.StartsWith(courseFolder, StringComparison.OrdinalIgnoreCase)) return false;
            if (p.IndexOf("/Walls/", StringComparison.OrdinalIgnoreCase) >= 0 && m.name.EndsWith("(stone)", StringComparison.Ordinal)) return true;
            if (p.IndexOf("/Creeks/", StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return rules.Any(r => r.hasMaterial && p.StartsWith(courseFolder + r.matFolder + "/", StringComparison.OrdinalIgnoreCase)
                && m.name.EndsWith(" (" + r.matName + ")", StringComparison.Ordinal));
        }

        // ------------------------------------------------------------ previews and restore

        public static Dictionary<string, object> Clear(ICollection<string> objects)
        {
            var course = GolfMapCourses.Require();
            var meshFolder = GolfMapCourses.Folder(course) + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);
            var scene = EditorSceneManager.GetActiveScene();
            var named = objects == null ? null : new HashSet<string>(objects, StringComparer.Ordinal);
            var cleared = new List<object>();
            var errors = new List<object>();
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Clear paint previews");
            int undoGroup = Undo.GetCurrentGroup();
            foreach (var f in CourseMeshes(scene))
            {
                if (named != null && !named.Contains(f.name)) continue;
                var path = PathOf(f.transform);
                Record rec;
                if (!records.TryGetValue(path, out rec) || !rec.preview) continue;
                if (IsPaintedCopy(f.sharedMesh, meshFolder))
                {
                    var original = LoadOriginal(records, path);
                    if (original == null) { errors.Add(path + ": its FBX mesh " + rec.mesh + " is gone from " + rec.asset); continue; }
                    SetMesh(f, original, original);
                }
                DropPreview(records, path);
                cleared.Add(f.name);
            }
            Undo.CollapseUndoOperations(undoGroup);
            if (cleared.Count > 0)
            {
                SaveRecords(meshFolder + RestoreFile, records);
                EditorSceneManager.MarkSceneDirty(scene);
                SceneView.RepaintAll();
            }
            var result = new Dictionary<string, object> { { "cleared", cleared }, { "errors", errors } };
            if (named != null) result["notPreviewed"] = named.Where(n => !cleared.Contains(n)).OrderBy(n => n, StringComparer.Ordinal).Cast<object>().ToList();
            return result;
        }

        public static Dictionary<string, object> Restore(bool lakeBed)
        {
            var course = GolfMapCourses.Require();
            var meshFolder = GolfMapCourses.Folder(course) + MeshFolder + "/";
            var records = LoadRecords(meshFolder + RestoreFile);
            var scene = EditorSceneManager.GetActiveScene();
            var errors = new List<string>();
            int restored = 0, materials = 0;
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Restore vertex paint");
            int undoGroup = Undo.GetCurrentGroup();
            // every MeshFilter, not only CourseMeshes: a copy whose asset is gone reads null
            foreach (var f in scene.GetRootGameObjects().SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true)))
            {
                var path = PathOf(f.transform);
                if (!records.ContainsKey(path)) continue;
                if (f.sharedMesh == null || IsPaintedCopy(f.sharedMesh, meshFolder))
                {
                    var original = LoadOriginal(records, path);
                    if (original == null) { errors.Add(path + ": original mesh unknown"); continue; }
                    SetMesh(f, original, original);
                    restored++;
                }
                if (RecordMaterial(records, path) != null) { PutBackMaterial(f, records, path); materials++; }
                records.Remove(path);
            }
            Undo.CollapseUndoOperations(undoGroup);
            SaveRecords(meshFolder + RestoreFile, records);
            if (restored + materials > 0) EditorSceneManager.MarkSceneDirty(scene);
            object lake = lakeBed ? (object)GolfMapLake.RestoreBedCopies() : "not asked (lakeBed=false)";
            SceneView.RepaintAll();
            return new Dictionary<string, object> { { "scene", scene.name }, { "restored", restored }, { "materials", materials }, { "lakeBed", lake }, { "errors", errors } };
        }

        // A preview entry back to a plain record: dropped when it records no material either.
        static void DropPreview(Dictionary<string, Record> records, string path)
        {
            Record rec;
            if (!records.TryGetValue(path, out rec)) return;
            rec.preview = false;
            rec.stamp = null;
            if (rec.material == null) records.Remove(path);
        }

        static void EnsureMeshFolder(string courseFolder)
        {
            if (!AssetDatabase.IsValidFolder(courseFolder + MeshFolder)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), MeshFolder);
        }

        static Dictionary<string, object> Why(string name, string why) { return new Dictionary<string, object> { { "object", name }, { "why", why } }; }

        static string B64(float[] a)
        {
            var bytes = new byte[a.Length * 4];
            Buffer.BlockCopy(a, 0, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        }

        static string B64(int[] a)
        {
            var bytes = new byte[a.Length * 4];
            Buffer.BlockCopy(a, 0, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        }

        // base64 little-endian float32 (numpy's) -> floats; FormatException when it is not.
        static float[] Floats(string b64)
        {
            var bytes = Convert.FromBase64String(b64);
            if (bytes.Length % 4 != 0) throw new FormatException("not a whole number of float32");
            var values = new float[bytes.Length / 4];
            Buffer.BlockCopy(bytes, 0, values, 0, bytes.Length);
            return values;
        }

        // The FBX file's stamp: size and time, as GolfMapCourseMeshes records a sync (null when the file is gone).
        static string Stamp(string assetPath)
        {
            if (string.IsNullOrEmpty(assetPath) || !File.Exists(assetPath)) return null;
            var info = new FileInfo(assetPath);
            return info.Length + "@" + info.LastWriteTimeUtc.Ticks;
        }

        static List<MeshFilter> CourseMeshes(UnityEngine.SceneManagement.Scene scene)
        {
            return scene.GetRootGameObjects()
                .SelectMany(r => r.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.sharedMesh != null && f.name.StartsWith("Spline_", StringComparison.Ordinal) && !GolfMapWaterplanes.IsWaterPlane(f.name))
                .OrderBy(f => f.name, StringComparer.Ordinal)
                .ToList();
        }

        static bool IsPaintedCopy(Mesh mesh, string meshFolder)
        {
            var p = AssetDatabase.GetAssetPath(mesh);
            return !string.IsNullOrEmpty(p) && p.StartsWith(meshFolder, StringComparison.OrdinalIgnoreCase);
        }

        // Rewrite an existing painted-copy asset (same GUID, so scene references stay) with another mesh's data through
        // the Mesh API. EditorUtility.CopySerialized swaps the serialized data under the loaded mesh but leaves its
        // render buffers: once the FBX under a copy changed its vertices (a Blender shaping run re-exports the meshes),
        // the renderer kept the old index buffer and UVs over the new vertices - sheets and walls of stretched triangles,
        // UVs off the ortho (white) - while the collider, cooked from the CPU data, had the right shape.
        static void Overwrite(Mesh target, Mesh source)
        {
            target.Clear(false);
            target.name = source.name;
            target.indexFormat = source.indexFormat;
            var v = new List<Vector3>(); source.GetVertices(v); target.SetVertices(v);
            var n = new List<Vector3>(); source.GetNormals(n); if (n.Count == v.Count) target.SetNormals(n);
            var t = new List<Vector4>(); source.GetTangents(t); if (t.Count == v.Count) target.SetTangents(t);
            var c = new List<Color>(); source.GetColors(c); if (c.Count == v.Count) target.SetColors(c);
            for (int ch = 0; ch < 4; ch++)
            {
                var uv = new List<Vector4>(); source.GetUVs(ch, uv);
                if (uv.Count != v.Count) continue;
                if (uv.All(u => u.z == 0 && u.w == 0)) target.SetUVs(ch, uv.Select(u => new Vector2(u.x, u.y)).ToList());
                else target.SetUVs(ch, uv);
            }
            target.subMeshCount = source.subMeshCount;
            for (int sm = 0; sm < source.subMeshCount; sm++) target.SetTriangles(source.GetTriangles(sm), sm, false);
            target.RecalculateBounds();
        }

        // Swap the rendered mesh and rebuild the Stix cache from it; the MeshCollider gets `collider` (always the FBX mesh:
        // a preview changes colours only).
        static void SetMesh(MeshFilter f, Mesh mesh, Mesh collider)
        {
            Undo.RecordObject(f, "Vertex paint");
            // Upload the (possibly rewritten, see Overwrite) geometry and rebind it, just as we recook the collider below.
            mesh.vertices = mesh.vertices;
            mesh.normals = mesh.normals;
            mesh.colors = mesh.colors;
            mesh.UploadMeshData(false);
            f.sharedMesh = null;
            f.sharedMesh = mesh;
            var mc = f.GetComponent<MeshCollider>();
            // the restore of an old wall-ground copy (whose collider was the copy) assigns the FBX mesh again: recook it
            if (mc != null && (mc.sharedMesh != collider || collider == mesh))
            {
                Undo.RecordObject(mc, "Vertex paint");
                mc.sharedMesh = null;
                mc.sharedMesh = collider;
            }
            ResetGrassCache(f);
        }

        // The Stix NatureMeshFilter cache rebuilt from the MeshFilter's mesh (the bake: the grass reads the red channel).
        static void ResetGrassCache(MeshFilter f)
        {
            var nmf = Component(f, NatureMeshFilterType);
            if (nmf == null) return;
            Undo.RecordObject(nmf, "Vertex paint");
            var type = nmf.GetType();
            type.GetMethod("ResetCache").Invoke(nmf, null);
            type.GetMethod("GetMeshes").Invoke(nmf, new object[] { false });
            EditorUtility.SetDirty(nmf);
        }

        // The Stix grass components of the nearest rough mesh copied onto `f` where it has none; true when any was added
        // (the caller resets the grass cache).
        static bool EnsureGrassComponents(MeshFilter f, List<MeshFilter> all)
        {
            if (Component(f, NatureMeshFilterType) != null) return false;
            var br = f.GetComponent<Renderer>();
            if (br == null) return false;
            MeshFilter from = null;
            float bestD = float.MaxValue;
            foreach (var o in all)
            {
                if (GolfMapSurfaces.Classify(o.name) != GolfMapSurfaces.Surface.Rough || Component(o, NatureMeshFilterType) == null) continue;
                var r = o.GetComponent<Renderer>();
                if (r == null) continue;
                var dc = r.bounds.center - br.bounds.center;
                float d = dc.x * dc.x + dc.z * dc.z;
                if (d < bestD) { bestD = d; from = o; }
            }
            if (from == null) return false;
            bool added = false;
            foreach (var typeName in new[] { NatureMeshFilterType, "grassonoffnew", GrassRendererType })
            {
                var c = Component(from, typeName);
                if (c == null || Component(f, typeName) != null) continue;
                if (UnityEditorInternal.ComponentUtility.CopyComponent(c) && UnityEditorInternal.ComponentUtility.PasteComponentAsNew(f.gameObject)) added = true;
            }
            return added;
        }

        static IEnumerable<Vector3> BoundaryPoints(MeshFilter f)
        {
            var mp = GolfMapBunkerChannels.Read(f);
            var seen = new HashSet<int>();
            for (int i = 0; i < mp.world.Length; i++)
                if (mp.boundary.Contains(mp.weld[i]) && seen.Add(mp.weld[i])) yield return mp.world[i];
        }

        // ------------------------------------------------------------ records

        // restore.json, per object path: the FBX mesh it comes from (asset, mesh), the material it wore before a material
        // copy (material), and preview: true with the FBX file's stamp when its MeshFilter shows a paint preview.
        sealed class Record
        {
            public string asset, mesh, material, stamp;
            public bool preview;
        }

        static Dictionary<string, Record> LoadRecords(string path)
        {
            var records = new Dictionary<string, Record>();
            if (!File.Exists(path)) return records;
            var root = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var meshes = root.Object("meshes");
            if (meshes == null) return records;
            foreach (var key in meshes.keys)
            {
                var o = meshes.Object(key);
                if (o == null) continue;
                records[key] = new Record
                {
                    asset = o.String("asset"), mesh = o.String("mesh"), material = o.String("material"), stamp = o.String("stamp"),
                    preview = o["preview"] is bool && (bool)o["preview"],
                };
            }
            return records;
        }

        static void SaveRecords(string path, Dictionary<string, Record> records)
        {
            if (records.Count == 0 && !File.Exists(path)) return;
            var meshes = new Dictionary<string, object>();
            foreach (var kv in records.OrderBy(k => k.Key, StringComparer.Ordinal))
            {
                var m = new Dictionary<string, object> { { "asset", kv.Value.asset }, { "mesh", kv.Value.mesh } };
                if (!string.IsNullOrEmpty(kv.Value.material)) m["material"] = kv.Value.material;
                if (kv.Value.preview) { m["preview"] = true; m["stamp"] = kv.Value.stamp; }
                meshes[kv.Key] = m;
            }
            File.WriteAllText(path, GolfMapJson.Serialize(new Dictionary<string, object> { { "format", RestoreFormat }, { "meshes", meshes } }));
        }

        // Object path -> the FBX asset its copy (a preview, or an old rule-paint / wall-ground copy) was made from
        // (restore.json). Takes the course folder: GolfMapCourseMeshes reads it before OPCD's Set Default Materials can
        // unload the course asset.
        internal static Dictionary<string, string> OriginalAssets(string courseFolder)
        {
            return LoadRecords(courseFolder + MeshFolder + "/" + RestoreFile).ToDictionary(kv => kv.Key, kv => kv.Value.asset);
        }

        // golfmap.meshes.sync re-added these objects from their (new) FBX: their records (a preview, the material they wore
        // before a copy) no longer hold - the new object shows the FBX mesh and OPCD's material. Returns the paths dropped.
        internal static List<string> Forget(string courseFolder, IEnumerable<string> objectPaths)
        {
            var file = courseFolder + MeshFolder + "/" + RestoreFile;
            var records = LoadRecords(file);
            var dropped = objectPaths.Where(p => records.Remove(p)).ToList();
            if (dropped.Count > 0) SaveRecords(file, records);
            return dropped;
        }

        // The material a mesh wore before a material copy (null when it was never swapped).
        static Material RecordMaterial(Dictionary<string, Record> records, string objectPath)
        {
            Record r;
            return records.TryGetValue(objectPath, out r) && !string.IsNullOrEmpty(r.material) ? AssetDatabase.LoadAssetAtPath<Material>(r.material) : null;
        }

        static void PutBackMaterial(MeshFilter f, Dictionary<string, Record> records, string objectPath)
        {
            var original = RecordMaterial(records, objectPath);
            var mr = f.GetComponent<MeshRenderer>();
            if (original == null || mr == null || mr.sharedMaterial == original) return;
            Undo.RecordObject(mr, "Vertex paint");
            mr.sharedMaterial = original;
        }

        static Mesh LoadOriginal(Dictionary<string, Record> records, string objectPath)
        {
            Record r;
            if (!records.TryGetValue(objectPath, out r) || string.IsNullOrEmpty(r.asset)) return null;
            return AssetDatabase.LoadAllAssetsAtPath(r.asset).OfType<Mesh>().FirstOrDefault(m => m.name == r.mesh);
        }

        static void WriteReport(GolfMapCourse course, Dictionary<string, object> result)
        {
            var sb = new StringBuilder();
            sb.AppendLine("GolfMap course mesh materials " + DateTime.Now.ToString("yyyy-MM-dd HH:mm") + (((bool)result["dryRun"]) ? " (dry run)" : ""));
            foreach (var kv in result.Where(kv => kv.Key != "wearing")) sb.AppendLine(kv.Key + ": " + GolfMapJson.Serialize(kv.Value, false));
            foreach (Dictionary<string, object> m in (List<object>)result["wearing"])
                sb.AppendLine("  " + m["object"] + ": " + m["why"] + (m.ContainsKey("material") ? " -> " + m["material"] : ""));
            File.WriteAllText(GolfMapCourses.ReportPath(course, "vertex_paint.txt"), sb.ToString());
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t != null; t = t.parent) parts.Insert(0, t.name);
            return "/" + string.Join("/", parts.ToArray());
        }

        static string Safe(string name) { return string.Join("_", name.Split(Path.GetInvalidFileNameChars())); }

        [BridgeCommand("golfmap.paint.probe", "Read-only: the vertex paint of every course mesh within r metres (XZ) of a point: vertex count, how many are not pure red, lowest and mean red (the Stix blade chance), nearest bunker-blend edge distance, whether the mesh is a painted copy, and (stream) the colours of a VertexPainterPro stream on the renderer, which is what it draws.",
            args = "x, z, r=3")]
        static object Probe(BridgeArgs a)
        {
            float x = (float)a.Number("x", double.NaN), z = (float)a.Number("z", double.NaN), r = (float)a.Number("r", 3);
            if (float.IsNaN(x) || float.IsNaN(z)) throw new BridgeError("x and z are required.");
            var scene = EditorSceneManager.GetActiveScene();
            var filters = CourseMeshes(scene);
            var bunkerEdge = new PointGrid(Mathf.Max(r * 2, 3));
            foreach (var f in filters.Where(f => f.name.Contains(BunkerBlendMarker)))
                foreach (var p in BoundaryPoints(f)) bunkerEdge.Add(p);
            var centre = new Vector3(x, 0, z);
            var hits = new List<object>();
            foreach (var f in filters)
            {
                var b = f.GetComponent<Renderer>().bounds;
                if (x < b.min.x - r || x > b.max.x + r || z < b.min.z - r || z > b.max.z + r) continue;
                var local = f.sharedMesh.vertices;
                var colors = f.sharedMesh.colors;
                // A VertexPainterPro stream (hand paint) is what the renderer draws: its colours replace the mesh's.
                var streamMesh = f.GetComponent<MeshRenderer>().additionalVertexStreams;
                var streamColors = streamMesh != null ? streamMesh.colors : new Color[0];
                if (streamColors.Length != local.Length) streamColors = null;
                int n = 0, notRed = 0, streamNotRed = 0; float minRed = 1, sumRed = 0, sumGreen = 0, sumBlue = 0, streamMinRed = 1, streamSumRed = 0, streamSumBlack = 0;
                for (int i = 0; i < local.Length; i++)
                {
                    var p = f.transform.TransformPoint(local[i]);
                    float dx = p.x - x, dz = p.z - z;
                    if (dx * dx + dz * dz > r * r) continue;
                    var c = colors.Length == local.Length ? colors[i] : Color.red;
                    n++; sumRed += c.r; minRed = Mathf.Min(minRed, c.r);
                    sumGreen += c.g; sumBlue += c.b;
                    if (c.r < 0.99f || c.g > 0.01f || c.b > 0.01f) notRed++;
                    if (streamColors != null)
                    {
                        var s = streamColors[i];
                        streamSumRed += s.r; streamMinRed = Mathf.Min(streamMinRed, s.r);
                        streamSumBlack += Mathf.Max(0f, 1f - s.r - s.g - s.b);
                        if (s.r < 0.99f || s.g > 0.01f || s.b > 0.01f) streamNotRed++;
                    }
                }
                if (n == 0) continue;
                var hit = new Dictionary<string, object>
                {
                    { "object", f.name }, { "vertices", n }, { "notRed", notRed },
                    { "vertexStream", streamMesh == null ? null : streamMesh.name },
                    { "minRed", (float)Math.Round(minRed, 3) }, { "meanRed", (float)Math.Round(sumRed / n, 3) },
                    { "meanGreen", (float)Math.Round(sumGreen / n, 3) }, { "meanBlue", (float)Math.Round(sumBlue / n, 3) },
                    { "paintedCopy", AssetDatabase.GetAssetPath(f.sharedMesh).Contains("/" + MeshFolder + "/") },
                };
                if (streamColors != null)
                    hit["stream"] = new Dictionary<string, object>
                    {
                        { "notRed", streamNotRed }, { "minRed", (float)Math.Round(streamMinRed, 3) },
                        { "meanRed", (float)Math.Round(streamSumRed / n, 3) }, { "meanBlack", (float)Math.Round(streamSumBlack / n, 3) },
                    };
                hits.Add(hit);
            }
            float edge = bunkerEdge.NearestXZ(centre, Mathf.Max(r * 2, 3));
            return new Dictionary<string, object> { { "x", x }, { "z", z }, { "r", r }, { "bunkerEdgeM", edge == float.MaxValue ? (object)null : (float)Math.Round(edge, 2) }, { "meshes", hits } };
        }

        // ----------------------------------------------------- painter streams

        // OPCD's painter (VertexPainterPro) keeps hand paint in a VertexInstanceStream: a mesh the renderer draws its
        // colours from (MeshRenderer.additionalVertexStreams) instead of the mesh's own. It outlives FBX re-imports and
        // paint.json, and the Stix grass never sees it. On Vreta one (the rough round 18_1c/18_1d) held black round the
        // bunkers: the rough's dirt base with roots, which no paint rule or Blender paint explained.
        [BridgeCommand("golfmap.paint.streams", "List the course meshes whose renderer draws a VertexPainterPro stream (OPCD hand paint, VertexInstanceStream) instead of its own vertex colours: vertices, how many are not pure red, mean black. remove=true takes the streams off (each stream mesh saved first to <course>/PaintedMeshes/streams/<object>.asset; Undo works), so the renderers draw the mesh's colours (the FBX's, or a paint preview). Marks the scene dirty, does not save it.",
            args = "remove=false, only (object names, comma-separated)")]
        static object Streams(BridgeArgs a)
        {
            bool remove = a.Bool("remove", false);
            var only = new HashSet<string>((a.String("only", "") ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(s => s.Trim()));
            var course = GolfMapCourses.Require();
            var folder = GolfMapCourses.Folder(course) + MeshFolder;
            var scene = EditorSceneManager.GetActiveScene();
            var rows = new List<object>();
            foreach (var f in CourseMeshes(scene))
            {
                if (only.Count > 0 && !only.Contains(f.name)) continue;
                var mr = f.GetComponent<MeshRenderer>();
                var comp = Component(f, PainterStreamType);
                var stream = mr != null ? mr.additionalVertexStreams : null;
                if (comp == null && stream == null) continue;
                var colors = stream != null ? stream.colors : new Color[0];
                int notRed = 0; double black = 0;
                foreach (var c in colors)
                {
                    if (c.r < 0.99f || c.g > 0.01f || c.b > 0.01f) notRed++;
                    black += Mathf.Max(0f, 1f - c.r - c.g - c.b);
                }
                var row = new Dictionary<string, object>
                {
                    { "object", f.name }, { "component", comp != null }, { "streamVertices", colors.Length },
                    { "meshVertices", f.sharedMesh.vertexCount }, { "notRed", notRed },
                    { "meanBlack", colors.Length > 0 ? Math.Round(black / colors.Length, 4) : 0 },
                };
                if (remove)
                {
                    if (stream != null)
                    {
                        if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(GolfMapCourses.Folder(course).TrimEnd('/'), MeshFolder);
                        if (!AssetDatabase.IsValidFolder(folder + "/streams")) AssetDatabase.CreateFolder(folder, "streams");
                        var backup = UnityEngine.Object.Instantiate(stream);
                        var path = AssetDatabase.GenerateUniqueAssetPath(folder + "/streams/" + Safe(f.name) + ".asset");
                        AssetDatabase.CreateAsset(backup, path);
                        row["backup"] = path;
                        Undo.RecordObject(mr, "Remove painter streams");
                        mr.additionalVertexStreams = null;
                    }
                    if (comp != null) Undo.DestroyObjectImmediate(comp);
                    row["removed"] = true;
                }
                rows.Add(row);
            }
            if (remove && rows.Count > 0)
            {
                AssetDatabase.SaveAssets();
                EditorSceneManager.MarkSceneDirty(scene);
            }
            return new Dictionary<string, object> { { "remove", remove }, { "streams", rows } };
        }

        // ------------------------------------------------------------ survey

        [BridgeCommand("golfmap.paint.survey", "Read-only: per surface class of the course meshes (Spline_*), mesh and vertex counts, edge lengths (median/p90, interior edges only), current dominant paint, Stix grass setup (renderer, NatureMeshFilter normalisation, cached meshes) and whether meshes are FBX sub-assets. Plus the rough edges within `near` metres of a bunker blend's outer edge.",
            args = "near=3 (metres)")]
        static object Survey(BridgeArgs a)
        {
            float near = (float)a.Number("near", 3);
            var scene = EditorSceneManager.GetActiveScene();
            var filters = CourseMeshes(scene);

            var bunkerEdge = new PointGrid(near);
            foreach (var f in filters.Where(f => f.name.Contains(BunkerBlendMarker)))
                foreach (var p in BoundaryPoints(f)) bunkerEdge.Add(p);
            var bunkers = filters.Where(f => f.name.EndsWith("_Bunker_-_Mesh", StringComparison.Ordinal))
                .Select(f => { var b = f.GetComponent<Renderer>().bounds; return (object)new Dictionary<string, object> { { "object", f.name }, { "center", b.center }, { "sizeM", Mathf.Round(Mathf.Max(b.size.x, b.size.z)) } }; })
                .ToList();

            var classes = new Dictionary<string, ClassStats>();
            var nearBunker = new List<float>();
            int nearBunkerVerts = 0;
            foreach (var f in filters)
            {
                var surface = GolfMapSurfaces.Classify(f.name).ToString();
                ClassStats s; if (!classes.TryGetValue(surface, out s)) classes[surface] = s = new ClassStats();
                var mp = GolfMapBunkerChannels.Read(f);
                s.meshes++;
                s.welded += mp.links.Count;
                if (AssetDatabase.GetAssetPath(f.sharedMesh).EndsWith(".fbx", StringComparison.OrdinalIgnoreCase)) s.fbx++;
                if (!mp.HasColors) s.noColors++;
                else
                {
                    var seen = new HashSet<int>();
                    for (int i = 0; i < mp.world.Length; i++)
                        if (seen.Add(mp.weld[i])) s.paint.Add(GolfMapBunkerChannels.Dominant(mp.colors[i]));
                }
                var pos = new Dictionary<int, Vector3>();
                for (int i = 0; i < mp.world.Length; i++) pos[mp.weld[i]] = mp.world[i];
                bool rough = surface == "Rough";
                var nearSet = new HashSet<int>();
                foreach (var kv in mp.links)
                    foreach (var b in kv.Value)
                    {
                        if (b <= kv.Key) continue;
                        float len = Vector3.Distance(pos[kv.Key], pos[b]);
                        bool interior = !(mp.boundary.Contains(kv.Key) && mp.boundary.Contains(b));
                        if (interior) s.edges.Add(len);
                        if (rough && bunkerEdge.NearestXZ((pos[kv.Key] + pos[b]) * 0.5f, near) < near)
                        {
                            nearBunker.Add(len);
                            nearSet.Add(kv.Key); nearSet.Add(b);
                        }
                    }
                nearBunkerVerts += nearSet.Count;

                var nmf = Component(f, NatureMeshFilterType);
                if (Component(f, GrassRendererType) != null) s.stix++;
                if (Component(f, PainterStreamType) != null) s.painterStreams++;
                if (nmf != null)
                {
                    var so = new SerializedObject(nmf);
                    var norm = so.FindProperty("NormalizeTriangleSizes");
                    if (norm != null && norm.boolValue) s.normalized++;
                    var cached = so.FindProperty("meshes");
                    if (cached != null && cached.isArray && cached.arraySize > 0)
                    {
                        s.cached++;
                        var first = cached.GetArrayElementAtIndex(0).objectReferenceValue as Mesh;
                        if (first != null && first == f.sharedMesh) s.cacheIsShared++;
                    }
                }
            }

            var result = new Dictionary<string, object> { { "scene", scene.name }, { "meshes", filters.Count } };
            result["classes"] = classes.OrderBy(kv => kv.Key).ToDictionary(kv => kv.Key, kv => (object)kv.Value.ToJson());
            result["roughNearBunker"] = new Dictionary<string, object>
            {
                { "withinM", near },
                { "bunkerEdgePoints", bunkerEdge.Count },
                { "vertices", nearBunkerVerts },
                { "edges", nearBunker.Count },
                { "edgeMedianM", Percentile(nearBunker, 0.5f) },
                { "edgeP90M", Percentile(nearBunker, 0.9f) },
            };
            result["bunkers"] = bunkers;
            return result;
        }

        sealed class ClassStats
        {
            public int meshes, welded, fbx, noColors, stix, normalized, cached, cacheIsShared, painterStreams;
            public readonly List<float> edges = new List<float>();
            public readonly GolfMapBunkerChannels.Tally paint = new GolfMapBunkerChannels.Tally();
            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "meshes", meshes }, { "vertices", welded }, { "fbxMeshes", fbx },
                    { "interiorEdgeMedianM", Percentile(edges, 0.5f) }, { "interiorEdgeP90M", Percentile(edges, 0.9f) },
                    { "paint", paint.ToString() }, { "noVertexColours", noColors }, { "painterStreams", painterStreams },
                    { "stixRenderers", stix }, { "stixNormalized", normalized }, { "stixCached", cached }, { "stixCacheIsSharedMesh", cacheIsShared },
                };
            }
        }

        static float Percentile(List<float> values, float p)
        {
            if (values.Count == 0) return 0;
            var sorted = values.OrderBy(v => v).ToList();
            return (float)Math.Round(sorted[Mathf.Clamp(Mathf.FloorToInt(p * (sorted.Count - 1)), 0, sorted.Count - 1)], 3);
        }

        // Stix and VertexPainterPro live in assemblies editor scripts cannot reference
        // in every project: find their components by type name.
        static Component Component(Component c, string fullName)
        {
            return c.GetComponents<Component>().FirstOrDefault(x => x != null && (x.GetType().FullName == fullName || x.GetType().Name == fullName));
        }

        // Points bucketed on the XZ plane for nearest-within-r queries.
        sealed class PointGrid
        {
            readonly float cell;
            readonly Dictionary<long, List<Vector3>> cells = new Dictionary<long, List<Vector3>>();
            public int Count { get; private set; }
            public PointGrid(float cell) { this.cell = Mathf.Max(cell, 0.25f); }
            static long Key(int x, int z) { return ((long)x << 32) | (uint)z; }
            public void Add(Vector3 p)
            {
                var k = Key(Mathf.FloorToInt(p.x / cell), Mathf.FloorToInt(p.z / cell));
                List<Vector3> l; if (!cells.TryGetValue(k, out l)) cells[k] = l = new List<Vector3>();
                l.Add(p); Count++;
            }
            // Distance on the XZ plane to the nearest point, or float.MaxValue beyond r
            // (r must not exceed the cell size).
            public float NearestXZ(Vector3 p, float r) { Vector3 hit; return NearestXZ(p, r, out hit); }

            public float NearestXZ(Vector3 p, float r, out Vector3 hit)
            {
                hit = Vector3.zero;
                float best = r * r;
                bool found = false;
                int cx = Mathf.FloorToInt(p.x / cell), cz = Mathf.FloorToInt(p.z / cell);
                for (int dx = -1; dx <= 1; dx++)
                    for (int dz = -1; dz <= 1; dz++)
                    {
                        List<Vector3> l; if (!cells.TryGetValue(Key(cx + dx, cz + dz), out l)) continue;
                        foreach (var q in l) { float x = q.x - p.x, z = q.z - p.z, d2 = x * x + z * z; if (d2 <= best) { best = d2; found = true; hit = q; } }
                    }
                return found ? Mathf.Sqrt(best) : float.MaxValue;
            }
        }
    }
}
