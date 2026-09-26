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
        const string DefaultMaterial = "NewRough";
        static readonly string[] TerrainScaleProperties = { "_ColorMapTiling", "_TerrainSize" };

        [MenuItem("GolfMap/Plant 3D grass to roughs")]
        public static void Menu()
        {
            Plant(DefaultMaterial);
        }

        [BridgeCommand("golfmap.roughgrass.plant", "Add a StixGames GrassRenderer to every rough course mesh (Spline_*_Rough_-_Mesh, no blends) in the active scene and set its material. Meshes that already have one only get the material. Sets the material's _ColorMapTiling/_TerrainSize to the inner terrain's size.",
            args = "material=NewRough (material asset name)")]
        static object Command(BridgeArgs a)
        {
            return Plant(a.String("material", DefaultMaterial));
        }

        public static Dictionary<string, object> Plant(string materialName)
        {
            var type = AppDomain.CurrentDomain.GetAssemblies()
                .Select(asm => asm.GetType(RendererType, false))
                .FirstOrDefault(t => t != null);
            if (type == null) throw new InvalidOperationException(RendererType + " not found: is the StixGames Grass Shader in this project?");
            var material = FindMaterial(materialName);
            var course = GolfMapCourses.Require();
            var scene = EditorSceneManager.GetActiveScene();
            var terrain = GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
            var meshes = scene.GetRootGameObjects()
                .SelectMany(root => root.GetComponentsInChildren<MeshFilter>(true))
                .Where(f => f.name.StartsWith("Spline_", StringComparison.Ordinal) &&
                            GolfMapSurfaces.Classify(f.name) == GolfMapSurfaces.Surface.Rough)
                .Select(f => f.gameObject).Distinct()
                .OrderBy(g => g.name, StringComparer.Ordinal).ToList();

            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Plant 3D grass to roughs");
            var scaled = FitToTerrain(material, terrain);
            int added = 0, updated = 0, unchanged = 0;
            foreach (var go in meshes)
            {
                var grass = go.GetComponent(type);
                bool isNew = grass == null;
                if (isNew) grass = Undo.AddComponent(go, type);
                var so = new SerializedObject(grass);
                var slot = so.FindProperty("Material");
                if (slot.objectReferenceValue == material) { unchanged++; continue; }
                slot.objectReferenceValue = material;
                so.ApplyModifiedProperties();
                if (isNew) added++; else updated++;
            }
            Undo.CollapseUndoOperations(undoGroup);
            if (added + updated > 0) EditorSceneManager.MarkSceneDirty(scene);
            if (scaled.Count > 0) AssetDatabase.SaveAssets();
            SceneView.RepaintAll();

            var materialPath = AssetDatabase.GetAssetPath(material);
            Debug.Log("[GolfMap Rough grass] " + meshes.Count + " rough meshes in " + scene.name + ": added " + added +
                " GrassRenderers, set the material on " + updated + " existing, " + unchanged + " already had it. Material " +
                materialPath + (scaled.Count > 0 ? " (" + string.Join(", ", scaled.ToArray()) + ")" : "") +
                ". Undo is available for this run.", material);
            return new Dictionary<string, object>
            {
                { "scene", scene.name },
                { "material", materialPath },
                { "roughMeshes", meshes.Count },
                { "added", added },
                { "updated", updated },
                { "unchanged", unchanged },
                { "terrain", terrain.name },
                { "materialChanges", scaled },
            };
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
