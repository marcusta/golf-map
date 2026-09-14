using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using AwesomeTechnologies.Vegetation.PersistentStorage;

namespace GolfMap.Editor
{
    public static class GolfMapFoliageBalance
    {
        [MenuItem("GolfMap/Vreta/Apply foliage colour balance")]
        public static void Apply()
        {
            var scene=UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            if(scene.name!="Vreta_lidar_scene")throw new InvalidOperationException("Open Vreta_lidar_scene.");
            AssetDatabase.Refresh();
            var storage=UnityEngine.Object.FindObjectsOfType<PersistentVegetationStorage>().Single(s=>s.name=="GolfMap Vreta Trees"&&s.gameObject.scene==scene);
            var system=storage.VegetationSystemPro;
            var catalog=system.VegetationPackageProList.Single(p=>p&&p.PackageName=="GolfMap imported trees");
            var original=AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Trees/Broadleaf/Broadleaf_Desktop.prefab");
            var balanced=AssetDatabase.LoadAssetAtPath<GameObject>("Assets/GolfMap/Vreta/FoliageTrialV2/Broadleaf Balanced.prefab");
            if(!original||!balanced)throw new InvalidOperationException("Missing broadleaf prefab.");
            var items=catalog.VegetationInfoList.Where(i=>i.VegetationPrefab==original||i.VegetationPrefab==balanced).ToList();
            if(items.Count==0)throw new InvalidOperationException("Original broadleaf is not in this catalogue.");
            var before=EditorJsonUtility.ToJson(storage.PersistentVegetationStoragePackage);
            Directory.CreateDirectory("GolfMapSpelunk/ColourBackups");
            File.WriteAllText("GolfMapSpelunk/ColourBackups/catalog-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+".json",EditorJsonUtility.ToJson(catalog));
            Undo.RegisterCompleteObjectUndo(catalog,"Balance broadleaf foliage");
            foreach(var item in items)item.VegetationPrefab=balanced;
            EditorUtility.SetDirty(catalog);
            AssetDatabase.SaveAssets();
            system.RefreshVegetationSystem();
            SceneView.RepaintAll();
            if(before!=EditorJsonUtility.ToJson(storage.PersistentVegetationStoragePackage))throw new InvalidOperationException("Unexpected storage change during refresh.");
            Debug.Log("[GolfMap foliage] Balanced broadleaf catalogue entries: "+items.Count+". Refreshed oak/birch materials. Verified all stored tree instances unchanged.");
        }
    }
}
