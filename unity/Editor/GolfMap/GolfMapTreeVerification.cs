using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using AwesomeTechnologies.Vegetation.PersistentStorage;

namespace GolfMap.Editor
{
    public partial class GolfMapTreePlanter
    {
        [MenuItem("GolfMap/Vreta/Verify imported trees and clear safety %&v")]
        public static void VerifyVreta()
        {
            var window = Select();
            window.ConfigureVreta();
            window.LoadFile();
            if (!window.storage || window.loaded == null) throw new InvalidOperationException("Import Vreta first.");
            var package = window.storage.PersistentVegetationStoragePackage;
            var system = window.storage.VegetationSystemPro;
            Directory.CreateDirectory("GolfMapSpelunk");
            File.WriteAllText("GolfMapSpelunk/Vreta_render_diagnostics.txt", JsonUtility.ToJson(system.EnvironmentSettings, true) + "\n" + string.Join("\n", system.VegetationPackageProModelsList.SelectMany(p => p.VegetationItemModelList).Select(m => m.BillboardMaterial ? m.BillboardMaterial.name + " texture=" + AssetDatabase.GetAssetPath(m.BillboardMaterial.mainTexture) + " color=" + m.BillboardMaterial.GetColor("_Color") + " brightness=" + m.BillboardMaterial.GetFloat("_Brightness") + " snow=" + m.BillboardMaterial.GetFloat("_SnowAmount") : "no billboard").ToArray()));
            var entries = package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList).SelectMany(i => i.VegetationItemList).Where(t => t.VegetationSourceID == ImportSource).ToList();
            if (entries.Count != window.loaded.trees.Count) throw new InvalidOperationException("Tree count mismatch.");
            var byPosition = entries.ToDictionary(t => PositionKey(t.Position + system.VegetationSystemPosition));
            float maxPositionError = 0;
            foreach (var tree in window.loaded.trees)
            {
                var expected = window.WorldPos(tree);
                PersistentVegetationItem item;
                if (!byPosition.TryGetValue(PositionKey(expected), out item)) throw new InvalidOperationException("Missing stem at " + expected);
                var actual = item.Position + system.VegetationSystemPosition;
                maxPositionError = Mathf.Max(maxPositionError, Vector2.Distance(new Vector2(expected.x, expected.z), new Vector2(actual.x, actual.z)));
                if (maxPositionError > 0.001f) throw new InvalidOperationException("Position error exceeds 1 mm.");
                if (item.DistanceFalloff != 1 || item.Scale.x <= 0 || item.Scale.y <= 0) throw new InvalidOperationException("Invalid instance dimensions or draw distance.");
            }
            // Exercise real VSP removal on an isolated copy with a hand-painted sentinel.
            var copy = Instantiate(package);
            try
            {
                string id = StoredIDs(copy).First();
                copy.AddVegetationItemInstance(0, id, Vector3.zero, Vector3.one, Quaternion.identity, 1, 1);
                int otherCount = copy.PersistentVegetationCellList.Sum(c => c.PersistentVegetationInfoList.Sum(i => i.VegetationItemList.Count(t => t.VegetationSourceID != ImportSource)));
                foreach (var key in StoredIDs(copy)) copy.RemoveVegetationItemInstances(key, ImportSource);
                if (SourceCount(copy) != 0) throw new InvalidOperationException("Clear left imported trees.");
                int remaining = copy.PersistentVegetationCellList.Sum(c => c.PersistentVegetationInfoList.Sum(i => i.VegetationItemList.Count));
                if (remaining != otherCount) throw new InvalidOperationException("Clear changed another source.");
                foreach (var key in StoredIDs(copy)) copy.RemoveVegetationItemInstances(key, ImportSource);
                if (copy.PersistentVegetationCellList.Sum(c => c.PersistentVegetationInfoList.Sum(i => i.VegetationItemList.Count)) != otherCount) throw new InvalidOperationException("Second clear was not idempotent.");
            }
            finally { DestroyImmediate(copy); }
            string report = "PASS: " + entries.Count + " imported trees; unique positions; max XZ error " + maxPositionError + " m; falloff 1; positive scales. Clear removes source 42, preserves other sources, and is idempotent (isolated storage copy). Unity " + Application.unityVersion;
            File.WriteAllText("GolfMapSpelunk/Vreta_tree_verification.txt", report);
            Debug.Log("[GolfMap] " + report);
            EditorSceneManager.SaveScene(window.terrain.gameObject.scene);
        }

        static string PositionKey(Vector3 p)
        {
            return Mathf.FloorToInt(p.x) + ":" + Mathf.FloorToInt(p.z);
        }
    }
}
