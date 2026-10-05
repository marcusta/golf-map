// Unity 2018.2 / C# 6. 3D grass on the rough meshes: StixGames' GrassRenderer
// (which pulls in NatureMeshFilter and grassonoffnew via RequireComponent) on
// every Spline_* mesh GolfMapSurfaces classifies as Rough, blends excluded.
// StixGames lives in Assembly-CSharp, which editor scripts cannot see in
// check-planter.ps1 and some course projects lack, so the type is resolved by
// name at run time.
// The shader samples its colour map (the terrain ortho) at world x/z divided by
// _ColorMapTiling and its floor colour texture at x/z / _TerrainSize, with no
// offset: both must be the inner terrain's size, which sits at the origin.
// A few percent off moves the lookup tens of metres and paints rough grass with
// the ortho's bunkers and paths, so every run sets them from the terrain.
//
// Bunker lips: a bunker mesh painted with a red grass-lip ring (golfmap convention) gets a GrassRenderer on the
// rough material itself (blades by red: the ring grows grass, the sand none). Every bunker blend
// (*_Bunker_-_Blend) gets a GrassRenderer too, on
// a lip material derived from the rough one on every run (<course>/Grass/<rough>
// Lip.mat): UNIFORM_DENSITY instead of VERTEX_DENSITY, because a blend's vertex
// red runs from 1 at the rough to 0 at the sand (OPCD's fade), and blade chance by
// red would thin the grass to nothing exactly where the references have it
// densest - right up to and hanging over the sand. Denser (_TargetDensity is
// the target distance between blades: rough x lipDensity), a little taller and
// more disordered; blades grow along the surface normal (GRASS_FOLLOW_SURFACE_NORMAL),
// which on the lip leans them out over the sand.
using System;
using System.Collections.Generic;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapRoughGrass
    {
        const string RendererType = "StixGames.GrassShader.GrassRenderer";
        const string NatureMeshFilterType = "StixGames.NatureCore.NatureMeshFilter";
        public const string DefaultMaterial = "NewRough";
        const string BunkerBlendMarker = "_Bunker_-_Blend";
        const string LipSuffix = " Lip";
        static readonly string[] TerrainScaleProperties = { "_ColorMapTiling", "_TerrainSize" };

        public sealed class LipOptions
        {
            public bool enabled = true;
            public float density = 0.7f;    // x the rough's _TargetDensity (blade spacing): < 1 is denser
            public float height = 1.15f;    // x the rough's blade heights
            public float disorder = 1.5f;   // x the rough's _Disorder (random lean)
        }

        [MenuItem("GolfMap/Plant 3D grass to roughs")]
        public static void Menu()
        {
            Plant(DefaultMaterial, new LipOptions(), false);
        }

        [BridgeCommand("golfmap.roughgrass.plant", "Add a StixGames GrassRenderer to every rough course mesh (Spline_*_Rough_-_Mesh, no blends) in the active scene and set its material; with lip=true (default) also to bunker meshes painted with a red grass-lip ring (rough material, blades by red) and to every bunker blend (*_Bunker_-_Blend) on a lip material derived from the rough one (<course>/Grass/<material> Lip.mat, rebuilt every run: even density instead of by vertex red, denser, taller, more lean), so the grass grows right up to the sand. Meshes that already have one only get the material; new ones get their Stix mesh cache rebuilt. Sets _ColorMapTiling/_TerrainSize to the inner terrain's size.",
            args = "material=NewRough (material asset name), lip=true, lipDensity=0.7 (x the rough's blade spacing), lipHeight=1.15, lipDisorder=1.5, dryRun=false")]
        static object Command(BridgeArgs a)
        {
            var lip = new LipOptions
            {
                enabled = a.Bool("lip", true),
                density = (float)a.Number("lipDensity", 0.7),
                height = (float)a.Number("lipHeight", 1.15),
                disorder = (float)a.Number("lipDisorder", 1.5),
            };
            return Plant(a.String("material", DefaultMaterial), lip, a.Bool("dryRun", false));
        }

        public static bool IsBunkerMesh(string name)
        {
            return name.StartsWith("Spline_", StringComparison.Ordinal) && name.EndsWith("_Bunker_-_Mesh", StringComparison.Ordinal) && !name.Contains("Potwall");
        }

        // Some vertex with red >= 0.25 (Stix's blade chance): a grass-lip ring worth a renderer.
        static bool HasRedLip(MeshFilter f)
        {
            var mesh = f.sharedMesh;
            if (mesh == null) return false;
            var colors = mesh.colors;
            return colors != null && colors.Length == mesh.vertexCount && colors.Any(c => c.r >= 0.25f);
        }

        public static bool IsBunkerBlend(string name)
        {
            return name.StartsWith("Spline_", StringComparison.Ordinal) && name.Contains(BunkerBlendMarker) && !name.Contains("Potwall");
        }

        public static Dictionary<string, object> Plant(string materialName, LipOptions lip, bool dryRun)
        {
            var type = AppDomain.CurrentDomain.GetAssemblies()
                .Select(asm => asm.GetType(RendererType, false))
                .FirstOrDefault(t => t != null);
            if (type == null) throw new InvalidOperationException(RendererType + " not found: is the StixGames Grass Shader in this project?");
            var material = FindMaterial(materialName);
            var course = GolfMapCourses.Require();
            var courseFolder = GolfMapCourses.Folder(course);
            var scene = EditorSceneManager.GetActiveScene();
            var terrain = GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
            var filters = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.name.StartsWith("Spline_", StringComparison.Ordinal) && !GolfMapWaterplanes.IsWaterPlane(f.name))
                .ToList();
            var meshes = filters
                .Where(f => GolfMapSurfaces.Classify(f.name) == GolfMapSurfaces.Surface.Rough)
                .Select(f => f.gameObject).Distinct()
                .OrderBy(g => g.name, StringComparer.Ordinal).ToList();
            var blends = !lip.enabled ? new List<GameObject>() : filters
                .Where(f => IsBunkerBlend(f.name))
                .Select(f => f.gameObject).Distinct()
                .OrderBy(g => g.name, StringComparer.Ordinal).ToList();
            // the bunker mesh's own grass lip: the rings painted red (golfmap convention: grass lip, 3D grass grows),
            // on the rough material itself, so blades follow the paint exactly and the sand (no red) stays bare
            var bunkerMeshes = filters.Where(f => IsBunkerMesh(f.name)).ToList();
            var paintedLips = !lip.enabled ? new List<GameObject>() : bunkerMeshes.Where(HasRedLip)
                .Select(f => f.gameObject).Distinct().OrderBy(g => g.name, StringComparer.Ordinal).ToList();
            // lip off: blends and bunker meshes that have a renderer of ours are cleared below (and bunker meshes whose
            // red lip is gone)
            var lipOff = filters.Where(f => (IsBunkerBlend(f.name) || IsBunkerMesh(f.name)) && f.GetComponent(type) != null)
                .Select(f => f.gameObject).Distinct().Where(g => !blends.Contains(g) && !paintedLips.Contains(g)).ToList();

            if (dryRun)
            {
                return new Dictionary<string, object>
                {
                    { "scene", scene.name }, { "dryRun", true }, { "material", AssetDatabase.GetAssetPath(material) },
                    { "roughMeshes", meshes.Count }, { "roughWithout", meshes.Count(g => g.GetComponent(type) == null) },
                    { "bunkerBlends", blends.Count }, { "blendsWithout", blends.Count(g => g.GetComponent(type) == null) },
                    { "lipMaterial", lip.enabled ? LipPath(courseFolder, material) : null }, { "lipRenderersToRemove", lipOff.Count },
                    { "bunkerMeshesWithRedLip", paintedLips.Count },
                };
            }

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Plant 3D grass to roughs");
            var scaled = FitToTerrain(material, terrain);
            var rough = Put(type, meshes, material);
            Material lipMaterial = null;
            Dictionary<string, int> lipCounts = null;
            if (lip.enabled)
            {
                lipMaterial = LipMaterial(courseFolder, material, lip);
                lipCounts = Put(type, blends, lipMaterial);
                var painted = Put(type, paintedLips, material);
                lipCounts["bunkerAdded"] = painted["added"];
                lipCounts["bunkerUpdated"] = painted["updated"];
            }
            foreach (var go in lipOff)
            {
                var nmf = go.GetComponent(NatureMeshFilterType);
                Undo.DestroyObjectImmediate(go.GetComponent(type));
                var onOff = go.GetComponents<MonoBehaviour>().FirstOrDefault(m => m != null && m.GetType().Name == "grassonoffnew");
                if (onOff != null) Undo.DestroyObjectImmediate(onOff);
                if (nmf != null) Undo.DestroyObjectImmediate(nmf);
            }
            Undo.CollapseUndoOperations(undoGroup);
            if (rough["added"] + rough["updated"] + (lipCounts == null ? 0 : lipCounts["added"] + lipCounts["updated"] + lipCounts["bunkerAdded"] + lipCounts["bunkerUpdated"]) + lipOff.Count > 0)
                EditorSceneManager.MarkSceneDirty(scene);
            if (scaled.Count > 0 || lipMaterial != null) AssetDatabase.SaveAssets();
            SceneView.RepaintAll();

            var materialPath = AssetDatabase.GetAssetPath(material);
            Debug.Log("[GolfMap Rough grass] " + meshes.Count + " rough meshes in " + scene.name + ": added " + rough["added"] +
                " GrassRenderers, set the material on " + rough["updated"] + " existing, " + rough["unchanged"] + " already had it. Material " +
                materialPath + (scaled.Count > 0 ? " (" + string.Join(", ", scaled.ToArray()) + ")" : "") +
                (lipCounts != null ? ". Bunker lips: " + blends.Count + " blends, added " + lipCounts["added"] + ", updated " + lipCounts["updated"] + ", material " + AssetDatabase.GetAssetPath(lipMaterial) : "") +
                (lipCounts != null ? "; " + paintedLips.Count + " bunker meshes with a red grass lip on " + materialPath : "") +
                (lipOff.Count > 0 ? ". Lip grass removed from " + lipOff.Count + " blends/bunkers" : "") +
                ". Undo is available for this run.", material);
            return new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "material", materialPath },
                { "roughMeshes", meshes.Count },
                { "added", rough["added"] },
                { "updated", rough["updated"] },
                { "unchanged", rough["unchanged"] },
                { "terrain", terrain.name },
                { "materialChanges", scaled },
                { "lip", lipCounts == null ? null : new Dictionary<string, object>
                    {
                        { "material", AssetDatabase.GetAssetPath(lipMaterial) }, { "bunkerBlends", blends.Count },
                        { "added", lipCounts["added"] }, { "updated", lipCounts["updated"] }, { "unchanged", lipCounts["unchanged"] },
                        { "bunkerMeshesWithRedLip", paintedLips.Count }, { "bunkerMeshesAdded", lipCounts["bunkerAdded"] },
                        { "targetDensity", lipMaterial.GetFloat("_TargetDensity") }, { "maxHeight", lipMaterial.GetFloat("_MaxHeight00") },
                    } },
                { "lipRemoved", lipOff.Count },
            };
        }

        // A GrassRenderer with `material` on each object; new ones get their NatureMeshFilter cache built from the
        // mesh the object shows now (a painted copy included).
        static Dictionary<string, int> Put(Type type, List<GameObject> objects, Material material)
        {
            int added = 0, updated = 0, unchanged = 0;
            foreach (var go in objects)
            {
                var grass = go.GetComponent(type);
                bool isNew = grass == null;
                if (isNew) grass = Undo.AddComponent(go, type);
                var so = new SerializedObject(grass);
                var slot = so.FindProperty("Material");
                if (!isNew && slot.objectReferenceValue == material) { unchanged++; continue; }
                slot.objectReferenceValue = material;
                so.ApplyModifiedProperties();
                if (isNew)
                {
                    added++;
                    var nmf = go.GetComponent(NatureMeshFilterType);
                    if (nmf != null)
                    {
                        nmf.GetType().GetMethod("ResetCache").Invoke(nmf, null);
                        nmf.GetType().GetMethod("GetMeshes").Invoke(nmf, new object[] { false });
                        EditorUtility.SetDirty(nmf);
                    }
                }
                else updated++;
            }
            return new Dictionary<string, int> { { "added", added }, { "updated", updated }, { "unchanged", unchanged } };
        }

        static string LipPath(string courseFolder, Material rough)
        {
            return courseFolder + "Grass/" + rough.name + LipSuffix + ".mat";
        }

        // The lip material: the rough's (colour map, blades, colours, fitted terrain scale) with even density and the
        // lip's spacing/height/lean. Rebuilt from the rough on every run, in place (same asset, same references).
        static Material LipMaterial(string courseFolder, Material rough, LipOptions lip)
        {
            if (lip.density <= 0 || lip.height <= 0 || lip.disorder < 0) throw new InvalidOperationException("lipDensity and lipHeight must be > 0, lipDisorder >= 0.");
            var path = LipPath(courseFolder, rough);
            var folder = System.IO.Path.GetDirectoryName(path).Replace('\\', '/');
            if (!AssetDatabase.IsValidFolder(folder)) AssetDatabase.CreateFolder(courseFolder.TrimEnd('/'), "Grass");
            var m = new Material(rough) { name = rough.name + LipSuffix };
            var keywords = m.shaderKeywords.Where(k => k != "VERTEX_DENSITY" && k != "UNIFORM_DENSITY").ToList();
            keywords.Add("UNIFORM_DENSITY");
            m.shaderKeywords = keywords.ToArray();
            if (m.HasProperty("_DensityValues")) m.SetVector("_DensityValues", Vector4.one);
            Scale(m, "_TargetDensity", lip.density);
            foreach (var p in new[] { "_MaxHeight00", "_MinHeight00", "_MaxHeight01", "_MinHeight01" }) Scale(m, p, lip.height);
            Scale(m, "_Disorder", lip.disorder);
            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing == null) { AssetDatabase.CreateAsset(m, path); return m; }
            Undo.RecordObject(existing, "Plant 3D grass to roughs");
            existing.shader = m.shader;
            existing.CopyPropertiesFromMaterial(m);
            existing.shaderKeywords = m.shaderKeywords;
            UnityEngine.Object.DestroyImmediate(m);
            EditorUtility.SetDirty(existing);
            return existing;
        }

        static void Scale(Material m, string property, float factor)
        {
            if (m.HasProperty(property)) m.SetFloat(property, m.GetFloat(property) * factor);
        }

        // Match the shader's world-to-texture scale to the terrain the ortho covers.
        static List<string> FitToTerrain(Material material, Terrain terrain)
        {
            var size = terrain.terrainData.size;
            var origin = terrain.transform.position;
            if (Mathf.Abs(size.x - size.z) > 0.01f)
                Debug.LogWarning("[GolfMap Rough grass] " + terrain.name + " is not square (" + size.x + " x " + size.z + " m); the grass colour map assumes it is and uses the width.", terrain);
            if (Mathf.Abs(origin.x) > 0.01f || Mathf.Abs(origin.z) > 0.01f)
                Debug.LogWarning("[GolfMap Rough grass] " + terrain.name + " is at " + origin + ", not the origin; the grass shader samples its colour map from world 0,0, so the colours will be offset by that much.", terrain);

            var changes = new List<string>();
            var stale = TerrainScaleProperties.Where(p => material.HasProperty(p) && material.GetFloat(p) != size.x).ToArray();
            if (stale.Length == 0) return changes;
            Undo.RecordObject(material, "Plant 3D grass to roughs");
            foreach (var p in stale)
            {
                changes.Add(p + " " + material.GetFloat(p) + " -> " + size.x);
                material.SetFloat(p, size.x);
            }
            EditorUtility.SetDirty(material);
            return changes;
        }

        static Material FindMaterial(string name)
        {
            var paths = AssetDatabase.FindAssets(name + " t:Material")
                .Select(AssetDatabase.GUIDToAssetPath).Distinct()
                .Where(p => System.IO.Path.GetFileNameWithoutExtension(p) == name)
                .ToList();
            if (paths.Count == 0) throw new InvalidOperationException("No material named '" + name + "' in the project.");
            if (paths.Count > 1) throw new InvalidOperationException("Several materials named '" + name + "': " + string.Join(", ", paths.ToArray()));
            return AssetDatabase.LoadAssetAtPath<Material>(paths[0]);
        }
    }
}
