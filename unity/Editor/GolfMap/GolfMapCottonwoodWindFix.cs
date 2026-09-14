// Unity 2018.2 / C# 6. Changes material settings, never shader source or meshes.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapCottonwoodWindFix
    {
        const string Root = "Assets/CESimgolf 3D Assets/TREES - Cottonwoods";
        const string Property = "_Stiffness";

        [MenuItem("GolfMap/Cottonwoods/Set wind stiffness to 1 (all prefabs)")]
        public static void Run()
        {
            if (!AssetDatabase.IsValidFolder(Root))
                throw new InvalidOperationException("Cottonwood folder not found: " + Root);

            // Gather first so a missing prefab cannot leave a partially applied fix.
            var paths = AssetDatabase.FindAssets("t:GameObject", new[] { Root })
                .Select(AssetDatabase.GUIDToAssetPath)
                .Where(p => p.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
                .Distinct().OrderBy(p => p, StringComparer.Ordinal).ToArray();
            var materials = new HashSet<Material>();
            int missingSlots = 0;
            foreach (var path in paths)
            {
                var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                if (!prefab) throw new InvalidOperationException("Cannot load prefab: " + path);
                // Includes inactive children and every LOD, including billboard renderers.
                var renderers = new HashSet<Renderer>(prefab.GetComponentsInChildren<Renderer>(true));
                foreach (var group in prefab.GetComponentsInChildren<LODGroup>(true))
                    foreach (var lod in group.GetLODs())
                        foreach (var renderer in lod.renderers)
                            if (renderer) renderers.Add(renderer);
                foreach (var renderer in renderers)
                    foreach (var material in renderer.sharedMaterials)
                        if (material) materials.Add(material); else missingSlots++;
            }

            var supported = materials.Where(m => m.HasProperty(Property)).ToArray();
            var changed = supported.Where(m => m.GetFloat(Property) != 1f).ToArray();
            if (changed.Length > 0)
            {
                Undo.IncrementCurrentGroup();
                int undoGroup = Undo.GetCurrentGroup();
                Undo.SetCurrentGroupName("Fix Cottonwood wind stiffness");
                Undo.RecordObjects(changed.Cast<UnityEngine.Object>().ToArray(), "Fix Cottonwood wind stiffness");
                foreach (var material in changed)
                {
                    float previous = material.GetFloat(Property);
                    material.SetFloat(Property, 1f);
                    EditorUtility.SetDirty(material);
                    Debug.Log("[GolfMap Cottonwoods] " + AssetDatabase.GetAssetPath(material) +
                        " : " + Property + " " + previous + " -> 1", material);
                }
                Undo.FlushUndoRecordObjects();
                Undo.CollapseUndoOperations(undoGroup);
                AssetDatabase.SaveAssets();
                SceneView.RepaintAll();
            }
            Debug.Log("[GolfMap Cottonwoods] Scanned " + paths.Length + " prefabs, " + materials.Count +
                " unique materials across all LODs. Changed " + changed.Length + "; already 1: " +
                (supported.Length - changed.Length) + "; no _Stiffness property: " +
                (materials.Count - supported.Length) + "; missing material slots: " + missingSlots +
                ". Shared materials affect every prefab using them. Undo is available for this run.");
        }
    }
}
