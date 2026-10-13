// Reversible runtime diagnostics for baked vertex AO and leaf normals. Never saved to bundles.
using System;
using System.Collections.Generic;
using System.Linq;
using AwesomeTechnologies.VegetationSystem;
using UnityEngine;

namespace GolfMap.Bridge
{
    static class FoliageProbeCommands
    {
        sealed class Original { public Mesh mesh; public Color[] colors; public Vector3[] normals; }
        static readonly Dictionary<int, Original> originals = new Dictionary<int, Original>();

        [BridgeCommand("arb.foliage.probe", "Inspect or temporarily remove baked leaf vertex AO / flatten leaf normals. Restore before reloading commands. Does not edit files or tree placements.",
            args = "item (required), mode=inspect|ao|normals|both|restore, aoFloor=1, normalBlend=1")]
        static object Probe(BridgeArgs a)
        {
            string mode = a.String("mode", "inspect");
            if (mode == "restore")
            {
                int count = originals.Count;
                foreach (var o in originals.Values) if (o.mesh) { o.mesh.colors = o.colors; o.mesh.normals = o.normals; o.mesh.UploadMeshData(false); }
                originals.Clear();
                return new { restoredMeshes = count };
            }
            if (!new[] { "inspect", "ao", "normals", "both" }.Contains(mode)) throw new BridgeError("Unknown probe mode.");
            string match = a.Require("item");
            if (match.Length == 0) throw new BridgeError("Give a specific item name.");
            var system = Resources.FindObjectsOfTypeAll<VegetationSystemPro>().First(s => s.name == "ArbVegetationSystemPro");
            var visited = new HashSet<int>();
            var rows = new List<object>();
            foreach (var package in system.VegetationPackageProModelsList)
            foreach (var model in package.VegetationItemModelList)
            {
                if (model.VegetationItemInfo.Name.IndexOf(match, StringComparison.OrdinalIgnoreCase) < 0) continue;
                var meshes = new[] { model.VegetationMeshLod0, model.VegetationMeshLod1, model.VegetationMeshLod2, model.VegetationMeshLod3 };
                var materials = new[] { model.VegetationMaterialsLOD0, model.VegetationMaterialsLOD1, model.VegetationMaterialsLOD2, model.VegetationMaterialsLOD3 };
                for (int lod = 0; lod < meshes.Length; lod++)
                {
                    var mesh = meshes[lod];
                    if (!mesh || !visited.Add(mesh.GetInstanceID())) continue;
                    var leaves = new HashSet<int>();
                    for (int sub = 0; sub < mesh.subMeshCount && sub < materials[lod].Length; sub++)
                    {
                        var mat = materials[lod][sub];
                        if (!mat || !(mat.IsKeywordEnabled("GEOM_TYPE_LEAF") || mat.IsKeywordEnabled("GEOM_TYPE_FROND"))) continue;
                        foreach (int vertex in mesh.GetTriangles(sub)) leaves.Add(vertex);
                    }
                    if (leaves.Count == 0) continue;
                    Original saved;
                    if (!originals.TryGetValue(mesh.GetInstanceID(), out saved))
                        saved = new Original { mesh = mesh, colors = mesh.colors, normals = mesh.normals };
                    var ao = leaves.Select(i => saved.colors.Length == mesh.vertexCount ? saved.colors[i].r : 1f).OrderBy(x => x).ToArray();
                    rows.Add(new Dictionary<string, object> { { "mesh", mesh.name }, { "leaves", leaves.Count }, { "vertices", mesh.vertexCount },
                        { "aoMin", ao.First() }, { "aoMedian", ao[ao.Length / 2] }, { "aoMax", ao.Last() },
                        { "normalYMin", leaves.Min(i => saved.normals[i].y) }, { "normalYMax", leaves.Max(i => saved.normals[i].y) } });
                    if (mode == "inspect") continue;
                    originals[mesh.GetInstanceID()] = saved;
                    var colors = saved.colors.Length == mesh.vertexCount ? (Color[])saved.colors.Clone() : Enumerable.Repeat(Color.white, mesh.vertexCount).ToArray();
                    var normals = (Vector3[])saved.normals.Clone();
                    foreach (int i in leaves)
                    {
                        if (mode == "ao" || mode == "both")
                        {
                            float v = Mathf.Max(colors[i].r, Mathf.Clamp01((float)a.Number("aoFloor", 1)));
                            colors[i] = new Color(v, v, v, colors[i].a);
                        }
                        if (mode == "normals" || mode == "both") normals[i] = Vector3.Lerp(normals[i], Vector3.up, Mathf.Clamp01((float)a.Number("normalBlend", 1))).normalized;
                    }
                    mesh.colors = colors;
                    mesh.normals = normals;
                    mesh.UploadMeshData(false);
                }
            }
            return rows;
        }
    }
}
