using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using AwesomeTechnologies.VegetationSystem;
using AwesomeTechnologies.Vegetation.PersistentStorage;

namespace GolfMap.Editor
{
    // Editing a leaf/bark material is not enough on its own: VSP keeps the NM shader-controller
    // colours in the vegetation package and overrides the prefab's material with them when it
    // draws, and it caches the rest of the material state per item. Replanting picks both up but
    // costs a full plant; this syncs the colours back from the prefabs and refreshes every GolfMap
    // system instead. Tree instances are never touched - the storage package is compared before
    // and after to prove it, and nothing is saved if it moved.
    public static class GolfMapVegetationRefresh
    {
        // No keyboard shortcut: Unity's "&" modifier is Alt, and Windows hands Alt+key to the
        // editor's own menu bar first, so an Alt shortcut here silently never fires.
        [MenuItem("GolfMap/Refresh vegetation from materials")]
        public static void Refresh()
        {
            // Import material files edited outside Unity first; otherwise the sync below reads the
            // previous in-memory colours and writes those back into the catalogue.
            AssetDatabase.Refresh();
            var scene=UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            var storages=UnityEngine.Object.FindObjectsOfType<PersistentVegetationStorage>()
                .Where(s=>s&&s.gameObject.scene==scene&&s.VegetationSystemPro).ToList();
            if(storages.Count==0)throw new InvalidOperationException("No vegetation storage in "+scene.name+".");
            var refreshed=new List<string>();
            int colours=0,reshadered=0;
            foreach(var storage in storages){
                var system=storage.VegetationSystemPro;
                var catalogs=system.VegetationPackageProList.Where(GolfMapTreePlanter.IsImportedCatalogue).ToList();
                if(catalogs.Count==0)continue;
                var package=storage.PersistentVegetationStoragePackage;
                var before=package?EditorJsonUtility.ToJson(package):null;
                foreach(var catalog in catalogs){
                    Undo.RegisterCompleteObjectUndo(catalog,"Refresh vegetation from materials");
                    // An item caches the shader name it was created with, and VSP picks its shader
                    // controller from that string. Retargeting a material to a different shader
                    // leaves the cached name stale, so re-derive it - which also rebuilds the
                    // controller settings from the new material and regenerates the billboard.
                    // Only for items whose shader actually moved: it is the expensive path, and it
                    // replaces a GolfMap-baked billboard with VSP's default atlas, so replant the
                    // outer with "Rebake billboard colours" afterwards.
                    int moved=0;
                    foreach(var item in catalog.VegetationInfoList){
                        if(!item.VegetationPrefab)continue;
                        if(AwesomeTechnologies.Shaders.ShaderSelector.GetShaderName(item.VegetationPrefab)==item.ShaderName)continue;
                        catalog.RefreshVegetationItemPrefab(item);moved++;
                    }
                    int updated=0;
                    foreach(var item in catalog.VegetationInfoList)if(GolfMapTreePlanter.SyncPrefabColours(item))updated++;
                    reshadered+=moved;
                    if(updated>0||moved>0){colours+=updated;EditorUtility.SetDirty(catalog);}
                }
                system.RefreshVegetationSystem();
                system.ClearCache();
                if(before!=null&&before!=EditorJsonUtility.ToJson(package))
                    throw new InvalidOperationException("Refreshing "+storage.name+" changed stored instances. Nothing was saved.");
                refreshed.Add(storage.name);
            }
            if(refreshed.Count==0)throw new InvalidOperationException("No GolfMap catalogue on any vegetation system in "+scene.name+".");
            AssetDatabase.SaveAssets();
            SceneView.RepaintAll();
            Debug.Log("[GolfMap] Refreshed "+string.Join(", ",refreshed.ToArray())+". Re-synced "+colours
                +" shader-controller colour(s) from the prefab materials"
                +(reshadered>0?", re-derived "+reshadered+" item(s) whose material moved to a different shader":"")
                +". No tree instances changed. Billboard textures still need rebaking.");
        }
    }
}
