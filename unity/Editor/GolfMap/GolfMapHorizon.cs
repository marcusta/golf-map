// Unity 2018.2 / C# 6. A big lake's far shore (golfpipe horizon): a low hazy ridge where the lake's water reaches
// the horizon, so the lake does not end in bare sky at its planes' edge (Omberg: Vättern, 4 km out, GSPro's far
// clip 5 km). The ridge is drawn unlit with the file's haze texture and without depth (GolfMap/FarShore: OPCD's
// GradientFog would otherwise fog it into the sky): it reads as land far away in any light, casts and takes no shadow.
//
// golfmap.horizon.build reads <export folder>/<prefix>-inner-horizon.json (golfmap-horizon-v1: vertices x,y,z,
// triangles, uvs) and the texture next to it, and writes <course>/Horizon/<name>.asset, <name>.png and <name>.mat;
// the object is /<parent>/<name> (default /Horizon). A rebuild refills the same object and assets.

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
    public static class GolfMapHorizon
    {
        const string Format = "golfmap-horizon-v1";
        const string AssetFolder = "Horizon";

        [Serializable]
        sealed class Stretch { public float fromDeg, toDeg; }

        [Serializable]
        sealed class HorizonDoc
        {
            public string format = "", name = "", texture = "";
            public float distanceM, waterY;
            public float[] centre = new float[0], heightM = new float[0], vertices = new float[0], uvs = new float[0];
            public int[] triangles = new int[0];
            public List<Stretch> stretches = new List<Stretch>();
        }

        [BridgeCommand("golfmap.horizon.build", "Build a big lake's far shore from <prefix>-inner-horizon.json in the course export folder (golfpipe horizon): a low hazy ridge where the lake's water reaches the horizon, unlit, no depth (GolfMap/FarShore with the file's haze texture, so the gradient fog leaves it alone), no shadows, no collider. Assets under <course>/Horizon/, the object /<parent>/<name>. Marks the scene dirty; save=true saves it.",
            args = "file (default <export folder>/<prefix>-inner-horizon.json), parent=Horizon, dryRun=false, " + GolfMapSceneSave.Arg)]
        static object Command(BridgeArgs a)
        {
            var course = GolfMapCourses.Require();
            var file = a.String("file") ?? GolfMapCourses.ExportFile(course, "inner", "horizon");
            if (string.IsNullOrEmpty(file) || !File.Exists(file)) throw new BridgeError("No horizon file " + (file ?? "(the course names no export folder)") + ": run golfpipe horizon first.");
            var doc = JsonUtility.FromJson<HorizonDoc>(File.ReadAllText(file));
            if (doc == null || doc.format != Format) throw new BridgeError(file + ": format must be " + Format + ".");
            int n = doc.vertices.Length / 3;
            if (n == 0 || doc.triangles.Length == 0) throw new BridgeError(file + ": no ridge (the lake reaches no open horizon).");
            if (doc.uvs.Length != n * 2) throw new BridgeError(file + ": uvs are not 2 per vertex.");
            var texSource = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(file), doc.texture);
            if (string.IsNullOrEmpty(doc.texture) || !File.Exists(texSource)) throw new BridgeError("No haze texture " + texSource + ".");

            var report = new Dictionary<string, object>
            {
                { "file", file }, { "name", doc.name }, { "distanceM", doc.distanceM }, { "vertices", n }, { "triangles", doc.triangles.Length / 3 },
                { "stretches", doc.stretches.Select(s => (object)new List<object> { s.fromDeg, s.toDeg }).ToList() },
            };
            bool dryRun = a.Bool("dryRun", false);
            report["dryRun"] = dryRun;
            if (dryRun) return report;

            var folder = GolfMapCourses.Folder(course) + AssetFolder;
            EnsureFolder(folder);

            // the texture: copied in, clamped, no mipmap shimmer at 4 km
            var texPath = folder + "/" + doc.name + ".png";
            File.Copy(texSource, texPath, true);
            AssetDatabase.ImportAsset(texPath, ImportAssetOptions.ForceUpdate);
            var ti = (TextureImporter)AssetImporter.GetAtPath(texPath);
            ti.wrapMode = TextureWrapMode.Clamp;
            ti.mipmapEnabled = false;
            ti.filterMode = FilterMode.Bilinear;
            ti.textureCompression = TextureImporterCompression.Uncompressed;
            ti.SaveAndReimport();
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(texPath);

            var matPath = folder + "/" + doc.name + ".mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(matPath);
            var shader = Shader.Find("GolfMap/FarShore");
            if (shader == null) throw new BridgeError("No GolfMap/FarShore shader (unity/Runtime/GolfMap/GolfMapFarShore.shader): install the repo's Runtime folder.");
            if (mat == null) { mat = new Material(shader); AssetDatabase.CreateAsset(mat, matPath); }
            mat.shader = shader;
            mat.mainTexture = tex;
            EditorUtility.SetDirty(mat);

            // Filled in place when the asset exists: EditorUtility.CopySerialized into a mesh asset left the scene
            // drawing the old vertices (the first, 6-20 m ridge) until Unity restarted.
            var meshPath = folder + "/" + doc.name + ".asset";
            var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(meshPath);
            bool fresh = mesh == null;
            if (fresh) mesh = new Mesh { name = doc.name };
            mesh.Clear();
            mesh.indexFormat = n > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16;
            var v = new Vector3[n];
            var uv = new Vector2[n];
            for (int i = 0; i < n; i++)
            {
                v[i] = new Vector3(doc.vertices[i * 3], doc.vertices[i * 3 + 1], doc.vertices[i * 3 + 2]);
                uv[i] = new Vector2(doc.uvs[i * 2], doc.uvs[i * 2 + 1]);
            }
            mesh.vertices = v;
            mesh.uv = uv;
            mesh.triangles = doc.triangles;
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            if (fresh) AssetDatabase.CreateAsset(mesh, meshPath);
            else EditorUtility.SetDirty(mesh);

            var scene = EditorSceneManager.GetActiveScene();
            var parentName = a.String("parent", "Horizon");
            var roots = scene.GetRootGameObjects();
            var parent = roots.FirstOrDefault(g => g.name == parentName);
            if (parent == null) { parent = new GameObject(parentName); Undo.RegisterCreatedObjectUndo(parent, "Build horizon"); }
            var go = parent.transform.Cast<Transform>().Select(t => t.gameObject).FirstOrDefault(g => g.name == doc.name);
            if (go == null)
            {
                go = new GameObject(doc.name);
                Undo.RegisterCreatedObjectUndo(go, "Build horizon");
                go.transform.SetParent(parent.transform, false);
            }
            var filter = go.GetComponent<MeshFilter>();
            if (filter == null) filter = go.AddComponent<MeshFilter>();
            filter.sharedMesh = mesh;
            var r = go.GetComponent<MeshRenderer>();
            if (r == null) r = go.AddComponent<MeshRenderer>();
            r.sharedMaterial = mat;
            r.shadowCastingMode = ShadowCastingMode.Off;
            r.receiveShadows = false;
            r.reflectionProbeUsage = ReflectionProbeUsage.Off;
            r.lightProbeUsage = LightProbeUsage.Off;
            EditorUtility.SetDirty(go);
            AssetDatabase.SaveAssets();
            EditorSceneManager.MarkSceneDirty(scene);

            report["object"] = "/" + parentName + "/" + doc.name;
            report["assets"] = new List<object> { AssetDatabase.GetAssetPath(mesh), matPath, texPath };
            return report;
        }

        static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            var parent = System.IO.Path.GetDirectoryName(folder).Replace('\\', '/');
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, System.IO.Path.GetFileName(folder));
        }
    }
}
