// Unity 2018.2 / C# 6. An explicit FBX convention marker survives all-grass
// transition paint (R=1,G=B=0), which cannot be identified from colours alone.
using System;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public static class GolfMapPathTransitionMetadata
    {
        public const string PropertyName = "golfmap_path_transition";
        // Append/remove only our exact suffix. Existing userData remains byte-for-byte
        // intact; no AssetDatabase import is triggered from a postprocess callback.
        private const string Marker = "\n[golfmap.path-transition.rgb.v1]\n";

        public static bool HasMarker(string userData)
        {
            return !string.IsNullOrEmpty(userData) && userData.Contains(Marker);
        }

        public static string WithMarker(string userData, bool painted)
        {
            string clean = (userData ?? "").Replace(Marker, "");
            return painted ? clean + Marker : clean;
        }

        private static bool AssetIsPainted(UnityEngine.Object asset)
        {
            if (asset == null) return false;
            string path = AssetDatabase.GetAssetPath(asset);
            if (string.IsNullOrEmpty(path)) return false;
            var importer = AssetImporter.GetAtPath(path) as ModelImporter;
            return importer != null && HasMarker(importer.userData);
        }

        public static bool IsPainted(MeshFilter filter)
        {
            if (filter == null) return false;
            if (AssetIsPainted(filter.sharedMesh) || AssetIsPainted(filter.gameObject)) return true;
            // The grass tools can replace a scene mesh with a PaintedMeshes asset.
            // Its prefab source still identifies the original imported FBX.
            var source = PrefabUtility.GetCorrespondingObjectFromSource(filter.gameObject) as GameObject;
            if (source == null) return false;
            var sourceFilter = source.GetComponent<MeshFilter>();
            return AssetIsPainted(source) || (sourceFilter != null && AssetIsPainted(sourceFilter.sharedMesh));
        }
    }

    public sealed class GolfMapPathTransitionPostprocessor : AssetPostprocessor
    {
        private bool painted;

        private void OnPreprocessModel()
        {
            painted = false;
        }

        private void OnPostprocessGameObjectWithUserProperties(GameObject gameObject, string[] names, object[] values)
        {
            if (names == null || values == null) return;
            for (int i = 0; i < Math.Min(names.Length, values.Length); i++)
            {
                if (names[i] == GolfMapPathTransitionMetadata.PropertyName
                    && values[i] != null && !string.IsNullOrEmpty(Convert.ToString(values[i])))
                    painted = true;
            }
        }

        private void OnPostprocessModel(GameObject model)
        {
            // FBXs are exported one object per file. Marker is therefore per model,
            // including separate fringe files, rather than inferred per colour array.
            var importer = assetImporter as ModelImporter;
            if (importer == null) return;
            string updated = GolfMapPathTransitionMetadata.WithMarker(importer.userData, painted);
            if (updated != importer.userData) importer.userData = updated;
        }
    }
}
