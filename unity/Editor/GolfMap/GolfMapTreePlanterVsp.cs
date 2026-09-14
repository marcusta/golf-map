using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using AwesomeTechnologies.VegetationSystem;
using AwesomeTechnologies.Vegetation.PersistentStorage;

namespace GolfMap.Editor
{
    public partial class GolfMapTreePlanter
    {
        const byte ImportSource = 42;
        const string VretaFolder = "Assets/GolfMap/Vreta/";
        [SerializeField] PersistentVegetationStorage storage;
        [SerializeField] List<GameObject> groundMeshes = new List<GameObject>();
        [SerializeField] float outerBillboardDistance = 10000;
        [SerializeField] bool regenerateBillboards = true;
        [SerializeField] string lastPlantingBackup;
        partial void StorageAvailable(ref bool available) {available=true;}
        static bool Finite(float v) { return !float.IsNaN(v) && !float.IsInfinity(v); }

        [MenuItem("GolfMap/Vreta/Configure manual biome planter %&g")]
        public static void ImportVreta()
        {
            var window = GetWindow<GolfMapTreePlanter>("GolfMap Trees");
            try { window.ConfigureVreta(); }
            catch(Exception e) {
                window.status = "Vreta setup stopped: " + e.Message;
                Debug.LogWarning("[GolfMap] " + window.status);
            }
            window.Show(); // Configuring must never replant the whole course.
        }

        void ConfigureVreta()
        {
            var scene = SceneManager.GetActiveScene();
            if (scene.name != "Vreta_lidar_scene") throw new InvalidOperationException("Open Vreta_lidar_scene first.");
            var innerTerrains = FindObjectsOfType<Terrain>().Where(t => t.gameObject.scene == scene && t.terrainData &&
                (t.name == "Terrain (Inner)" || t.terrainData.name == "Vreta_lidar_inner")).ToArray();
            if(innerTerrains.Length != 1)throw new InvalidOperationException(
                "Expected one inner terrain named Terrain (Inner) or using Vreta_lidar_inner data; found " + innerTerrains.Length +
                ". Select the target terrain and trees file manually in this window.");
            var chosenTerrain = innerTerrains[0];
            var systems = FindObjectsOfType<PersistentVegetationStorage>().Where(v => v.gameObject.scene == scene &&
                (v.name == "GolfMap Vreta Trees" || v.name.StartsWith("GolfMap Vreta Trees (")) &&
                StorageMatchesTerrain(v,chosenTerrain)).ToArray();
            if(systems.Length > 1)throw new InvalidOperationException("Several inner storage systems match. Select the intended storage manually.");
            terrain = chosenTerrain;
            innerExclusion = null;
            var currentExport = Path.GetFullPath(Path.Combine(Application.dataPath, "../../vreta-opcd/vreta-inner-trees.json"));
            filePath = File.Exists(currentExport) ? currentExport : VretaFolder + "Vreta_trees.json";
            mode = Mode.PersistentStorage;
            broadleafPrefabs = new List<GameObject> { AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Trees/Broadleaf/Broadleaf_Desktop.prefab") };
            coniferPrefabs = new List<GameObject> { AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Trees/Conifer/Conifer_Desktop.prefab") };
            unknownPrefabs.Clear(); bushPrefabs.Clear();
            useBiome=true;biomePath=VretaFolder+"palette.json";
            forceBillboards=false;minScale = 0.75f; maxScale = 1.4f; scaleWidth = false;
            clearExisting = false;
            groundMeshes = FindObjectsOfType<MeshFilter>().Where(m => m.gameObject.scene == scene && m.name.StartsWith("Spline_") && !m.name.Contains("Blend") && m.sharedMesh != null).Select(m => m.gameObject).ToList();
            storage = systems.Length == 1 ? systems[0] : null;
            loaded = null;
            status = "Vreta preset ready: " + groundMeshes.Count + " course meshes, terrain fallback. Plant creates dedicated VSP storage if needed.";
            so = new SerializedObject(this);
        }

        partial void DrawStorageOptions()
        {
            if (mode != Mode.PersistentStorage) return;
            storage = (PersistentVegetationStorage)EditorGUILayout.ObjectField("Persistent storage", storage, typeof(PersistentVegetationStorage), true);
            if(GUILayout.Button("Delete storage...")){
                var dialog=CreateInstance<DeleteStorageWindow>();dialog.planter=this;
                dialog.titleContent=new GUIContent("Delete storage");dialog.minSize=new Vector2(660,390);dialog.ShowUtility();
            }
            using(new EditorGUI.DisabledScope(!terrain||string.IsNullOrEmpty(filePath))){
                if(GUILayout.Button("Create / select storage for this terrain"))CreateOrSelectStorage();
                if(GUILayout.Button("Create new empty storage"))CreateOrSelectStorage(true);
            }
            if(storage&&storage.PersistentVegetationStoragePackage)EditorGUILayout.LabelField("Storage asset",AssetDatabase.GetAssetPath(storage.PersistentVegetationStoragePackage));
            using(new EditorGUI.DisabledScope(!storage||!storage.VegetationSystemPro)){
                if(GUILayout.Button("Refresh planted colours from prefab materials"))RefreshPlantedColours();
            }
            if(forceBillboards){outerBillboardDistance=EditorGUILayout.FloatField("Outer billboard distance (m)",outerBillboardDistance);regenerateBillboards=EditorGUILayout.Toggle("Rebake billboard colours",regenerateBillboards);}
            if(GUILayout.Button("Restore storage from planting backup")){
                if(!storage||!storage.PersistentVegetationStoragePackage){status="Assign the storage to restore first.";return;}
                var chosen=EditorUtility.OpenFilePanel("Planting backup for this storage", "GolfMapSpelunk/PlantingBackups", "json");
                if(chosen.Length>0){
                    var package=storage.PersistentVegetationStoragePackage;
                    if(!File.Exists(chosen+".target")||File.ReadAllText(chosen+".target")!=AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(package))){status="Backup belongs to a different storage asset.";return;}
                    Undo.RegisterCompleteObjectUndo(package,"Restore GolfMap planting");EditorJsonUtility.FromJsonOverwrite(File.ReadAllText(chosen),package);EditorUtility.SetDirty(package);RefreshStorage();AssetDatabase.SaveAssets();status="Restored storage. Prefab/material settings are unchanged.";
                }
            }
            if(!forceBillboards)EditorGUILayout.PropertyField(so.FindProperty("groundMeshes"), new GUIContent("Ground mesh objects / roots"), true);
            EditorGUILayout.HelpBox("Create / select reuses matching storage. Create new empty storage always creates and selects a separate system and asset for the target terrain, preserving existing systems. Creating storage does not plant trees. Replace/Clear affect source 42 in the selected storage. Backups are written before replacement.", MessageType.None);
        }

        public class DeleteStorageWindow : EditorWindow
        {
            internal GolfMapTreePlanter planter;
            PersistentVegetationStorage selected;
            string error;
            void OnGUI()
            {
                var choices=Resources.FindObjectsOfTypeAll<PersistentVegetationStorage>()
                    .Where(s=>s&&s.gameObject.scene.IsValid()&&s.gameObject.scene.isLoaded&&!EditorUtility.IsPersistent(s))
                    .OrderBy(s=>s.gameObject.scene.name).ThenBy(s=>s.name).ThenBy(s=>s.GetInstanceID()).ToArray();
                if(!selected&&choices.Length>0)selected=choices[0];
                EditorGUILayout.LabelField("Choose the storage to remove",EditorStyles.boldLabel);
                var labels=choices.Select(s=>s.gameObject.scene.name+" / "+s.name+" ["+s.GetInstanceID()+"]").ToArray();
                int index=Array.IndexOf(choices,selected);
                int next=EditorGUILayout.Popup("Storage",index,labels);
                if(next>=0&&next<choices.Length)selected=choices[next];
                if(!selected){EditorGUILayout.HelpBox("No storage systems in the loaded scenes.",MessageType.Info);return;}
                var system=selected.VegetationSystemPro;
                var package=selected.PersistentVegetationStoragePackage;
                int count=package?package.PersistentVegetationCellList.Sum(c=>c.PersistentVegetationInfoList.Sum(i=>i.VegetationItemList.Count)):0;
                EditorGUILayout.LabelField("Stored instances (all sources)",count.ToString());
                EditorGUILayout.LabelField("Storage asset",package?AssetDatabase.GetAssetPath(package):"None");
                EditorGUILayout.LabelField("Terrains",system?string.Join(", ",system.VegetationStudioTerrainObjectList.Where(g=>g).Select(g=>g.name).ToArray()):"No system");
                EditorGUILayout.HelpBox("Removes this storage's scene object and vegetation system. Its planted instances will no longer render through that system. Storage and vegetation assets are retained. Undo restores the scene object. Save the scene after deletion.",MessageType.Warning);
                int childCount=selected.GetComponentsInChildren<Transform>(true).Length-1;
                EditorGUILayout.LabelField("Child objects removed with system",childCount.ToString());
                // VSP creates hidden WindSampler children on ordinary storage systems.
                bool dedicated=(!system||system.gameObject==selected.gameObject)&&
                    !choices.Any(s=>s!=selected&&system&&s.VegetationSystemPro==system)&&
                    selected.GetComponents<Component>().All(c=>c is Transform||c is PersistentVegetationStorage||c is VegetationSystemPro);
                if(!dedicated)EditorGUILayout.HelpBox("This object has additional components or a separate/shared vegetation system. Delete it manually in the Hierarchy after reviewing those dependencies.",MessageType.Info);
                if(!string.IsNullOrEmpty(error))EditorGUILayout.HelpBox(error,MessageType.Error);
                using(new EditorGUI.DisabledScope(!dedicated||!planter)){
                    if(GUILayout.Button("Delete selected storage")){
                        string name=selected.name;
                        if(!EditorUtility.DisplayDialog("Delete storage?","Remove '"+name+"' from scene '"+selected.gameObject.scene.name+"'?\n\nStored instances: "+count+" (all sources).\nChild objects removed: "+childCount+" (including VSP wind samplers).\nAssets are retained. This can be undone.","Delete storage","Cancel"))return;
                        try {
                            if(package)planter.BackupStorage(package);
                            var scene=selected.gameObject.scene;
                            Undo.DestroyObjectImmediate(selected.gameObject);
                            EditorSceneManager.MarkSceneDirty(scene);
                            planter.status="Deleted scene storage '"+name+"'. Assets retained; Undo available. Save the scene.";
                            planter.Repaint();SceneView.RepaintAll();Close();GUIUtility.ExitGUI();
                        }catch(ExitGUIException){throw;}catch(Exception e){error=e.Message;Debug.LogException(e);}
                    }
                }
                if(GUILayout.Button("Cancel"))Close();
            }
        }

        void CreateOrSelectStorage(bool createNew=false)
        {
            var previous=storage;
            try {
                LoadFile();if(loaded==null)return;
                ValidateTarget();
                string targetName=forceBillboards?"GolfMap Outer Trees":"GolfMap Vreta Trees";
                var matches=createNew?new PersistentVegetationStorage[0]:FindObjectsOfType<PersistentVegetationStorage>().Where(s=>
                    (s.name==targetName||s.name.StartsWith(targetName+" ("))&&StorageMatchesTerrain(s,terrain)).ToArray();
                if(matches.Length>1)throw new InvalidOperationException("Several "+targetName+" systems exist. Resolve duplicates before selecting storage.");
                if(matches.Length==1){
                    var candidate=matches[0];
                    storage=candidate;status="Selected existing "+targetName+". No trees changed.";
                } else {
                    storage=null;EnsureStorage(createNew);
                    AssetDatabase.SaveAssets();EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
                    status="Created and selected "+storage.name+" with a new empty storage asset. Existing systems preserved. Save the scene, then Load and check.";
                }
            } catch(Exception e){storage=previous;status="Storage setup stopped: "+e.Message;Debug.LogException(e);}
        }

        void RefreshStorage()
        {
            if (storage && storage.VegetationSystemPro) { storage.VegetationSystemPro.ClearCache(); SceneView.RepaintAll(); }
        }

        // VSP caches NM colours separately and overrides the prefab's material.
        // Find bark by shader, not the first _Color (leaf materials also have it).
        static bool SyncPrefabColours(VegetationItemInfoPro item)
        {
            if(!item.VegetationPrefab||item.ShaderControllerSettings==null)return false;
            var settings=item.ShaderControllerSettings;
            if(settings.Heading!="Nature Manufacture tree")return false;
            var materials=item.VegetationPrefab.GetComponentsInChildren<Renderer>(true)
                .Where(r=>!(r is BillboardRenderer)).SelectMany(r=>r.sharedMaterials).Where(m=>m&&m.shader).ToArray();
            var bark=materials.FirstOrDefault(m=>m.shader.name=="NatureManufacture Shaders/Trees/Tree Bark Metalic"||m.shader.name=="NatureManufacture Shaders/Trees/Tree Bark Specular");
            var leaf=materials.FirstOrDefault(m=>m.shader.name=="NatureManufacture Shaders/Trees/Tree Leaves Metalic"||m.shader.name=="NatureManufacture Shaders/Trees/Tree_Leaves_Specular");
            bool changed=false;
            foreach(var property in settings.ControlerPropertyList){
                Material source=null;string key=null;
                if(property.PropertyName=="BarkColor"){source=bark;key="_Color";}
                else if(property.PropertyName=="HealtyColor"){source=leaf;key="_HealthyColor";}
                else if(property.PropertyName=="DryColor"){source=leaf;key="_DryColor";}
                if(source&&source.HasProperty(key)&&property.ColorValue!=source.GetColor(key)){
                    property.ColorValue=source.GetColor(key);changed=true;
                }
            }
            return changed;
        }

        void RefreshPlantedColours()
        {
            try {
                if(!storage||!storage.VegetationSystemPro)throw new InvalidOperationException("Select the planted storage first.");
                int updated=0;
                foreach(var catalog in storage.VegetationSystemPro.VegetationPackageProList){
                    if(!catalog||(catalog.PackageName!="GolfMap imported trees"&&catalog.PackageName!="GolfMap imported trees (billboards)"))continue;
                    Undo.RegisterCompleteObjectUndo(catalog,"Refresh planted colours");
                    foreach(var item in catalog.VegetationInfoList)if(SyncPrefabColours(item))updated++;
                    EditorUtility.SetDirty(catalog);
                }
                storage.VegetationSystemPro.RefreshVegetationSystem();
                RefreshStorage();AssetDatabase.SaveAssets();
                status="Refreshed stored colours for "+updated+" tree types. Positions unchanged. Existing billboard textures still need rebaking.";
            }catch(Exception e){status="Colour refresh stopped: "+e.Message;Debug.LogException(e);}
        }

        static HashSet<string> StoredIDs(PersistentVegetationStoragePackage package)
        {
            return new HashSet<string>(package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList).Select(i => i.VegetationItemID));
        }

        static int SourceCount(PersistentVegetationStoragePackage package)
        {
            return package.PersistentVegetationCellList.Sum(c => c.PersistentVegetationInfoList.Sum(i => i.VegetationItemList.Count(t => t.VegetationSourceID == ImportSource)));
        }

        partial void ClearImported()
        {
            if (!storage || !storage.PersistentVegetationStoragePackage) { status = "Assign persistent storage (or use the Vreta preset)."; return; }
            var package = storage.PersistentVegetationStoragePackage;
            int count = SourceCount(package);
            BackupStorage(package);
            Undo.RegisterCompleteObjectUndo(package, "Clear GolfMap imported trees");
            foreach (var id in StoredIDs(package)) package.RemoveVegetationItemInstances(id, ImportSource);
            EditorUtility.SetDirty(package);
            RefreshStorage();
            AssetDatabase.SaveAssets();
            status = "Cleared " + count + " imported instances. Other sources preserved. Undo is available.";
        }

        static bool StorageMatchesTerrain(PersistentVegetationStorage candidate,Terrain target)
        {
            if(!candidate||!target||!target.terrainData||!candidate.VegetationSystemPro||
                !candidate.PersistentVegetationStoragePackage||candidate.gameObject.scene!=target.gameObject.scene)return false;
            var system=candidate.VegetationSystemPro;
            if(!system.VegetationStudioTerrainObjectList.Contains(target.gameObject))return false;
            var bounds=system.VegetationSystemBounds;var size=target.terrainData.size;
            var center=target.transform.position+size/2;
            return Mathf.Abs(bounds.size.x-(size.x+2))<=2&&Mathf.Abs(bounds.size.z-(size.z+2))<=2&&
                Mathf.Abs(bounds.center.x-center.x)<=1&&Mathf.Abs(bounds.center.z-center.z)<=1;
        }

        static string StorageMismatchDetails(PersistentVegetationStorage candidate,Terrain target)
        {
            if(!candidate)return "No storage selected.";
            var system=candidate.VegetationSystemPro;
            if(!system)return "Storage '"+candidate.name+"' has no vegetation system.";
            if(!candidate.PersistentVegetationStoragePackage)return "Storage '"+candidate.name+"' has no storage asset.";
            if(candidate.gameObject.scene!=target.gameObject.scene)return "Storage and terrain belong to different scenes.";
            if(!system.VegetationStudioTerrainObjectList.Contains(target.gameObject))return "Storage '"+candidate.name+"' is not associated with terrain '"+target.name+"'.";
            return "Storage '"+candidate.name+"' bounds "+system.VegetationSystemBounds+" differ from terrain '"+target.name+"' at "+target.transform.position+" with size "+target.terrainData.size+".";
        }

        void EnsureStorage(bool createNew=false)
        {
            if (!FindObjectOfType<AwesomeTechnologies.VegetationStudio.VegetationStudioManager>())
            {
                var manager = new GameObject("VegetationStudioPro");
                Undo.RegisterCreatedObjectUndo(manager, "Create VSP manager");
                manager.AddComponent<AwesomeTechnologies.VegetationStudio.VegetationStudioManager>();
            }
            if (storage&&!createNew) return;
            string baseName=forceBillboards?"GolfMap Outer Trees":"GolfMap Vreta Trees";
            var candidates=FindObjectsOfType<PersistentVegetationStorage>().Where(s=>s.gameObject.scene==terrain.gameObject.scene&&
                (s.name==baseName||s.name.StartsWith(baseName+" ("))).ToArray();
            var compatible=candidates.Where(s=>StorageMatchesTerrain(s,terrain)).ToArray();
            if(!createNew&&compatible.Length>1)throw new InvalidOperationException("Several matching GolfMap systems exist. Select the intended storage explicitly.");
            if(!createNew&&compatible.Length==1){storage=compatible[0];return;}
            string newName=baseName;int suffix=2;
            var usedNames=new HashSet<string>(FindObjectsOfType<Transform>().Where(t=>t.gameObject.scene==terrain.gameObject.scene).Select(t=>t.name));
            while(usedNames.Contains(newName))newName=baseName+" ("+(suffix++)+")";
            var go = new GameObject(newName);
            Undo.RegisterCreatedObjectUndo(go, "Create GolfMap VSP system");
            SceneManager.MoveGameObjectToScene(go, terrain.gameObject.scene);
            storage = go.AddComponent<PersistentVegetationStorage>();
            var system = go.AddComponent<VegetationSystemPro>();
            storage.VegetationSystemPro = system;
            system.PersistentVegetationStorage = storage;
            system.AutomaticBoundsCalculation = false;
            var size = terrain.terrainData.size;
            system.VegetationSystemBounds = new Bounds(terrain.transform.position + size / 2, size + new Vector3(2, 100, 2));
            if (!terrain.GetComponent<UnityTerrain>()) Undo.AddComponent<UnityTerrain>(terrain.gameObject);
            system.AddTerrain(terrain.gameObject);
            var package = CreateInstance<PersistentVegetationStoragePackage>();
            AssetDatabase.CreateAsset(package, AssetDatabase.GenerateUniqueAssetPath(VretaFolder + "ImportedTreeStorage.asset"));
            storage.SetPersistentVegetationStoragePackage(package);
            system.RefreshVegetationSystem();
            storage.InitializePersistentStorage(); // New, empty package only. Never reinitialize existing storage.
            EditorUtility.SetDirty(system);
            EditorUtility.SetDirty(storage);
        }

        struct PreparedTree
        {
            public GameObject prefab;
            public Vector3 position, scale;
            public Quaternion rotation;
        }

        static int StemSeed(GolfMapTree t, int seedValue)
        {
            // FNV-1a: independent of list order and .NET string hash randomization.
            string key = string.IsNullOrEmpty(t.id) ? t.x.ToString("F2", System.Globalization.CultureInfo.InvariantCulture) + ":" + t.z.ToString("F2", System.Globalization.CultureInfo.InvariantCulture) : t.id;
            unchecked { uint hash = 2166136261u ^ (uint)seedValue; foreach (char c in key) hash = (hash ^ c) * 16777619u; return (int)(hash & 0x7fffffff); }
        }

        string BackupStorage(PersistentVegetationStoragePackage package)
        {
            Directory.CreateDirectory("GolfMapSpelunk/PlantingBackups");
            var text=EditorJsonUtility.ToJson(package);
            lastPlantingBackup="GolfMapSpelunk/PlantingBackups/"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N")+".json";
            File.WriteAllText(lastPlantingBackup,text);
            File.WriteAllText(lastPlantingBackup+".target",AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(package)));
            return text;
        }

        // Bake prepared material colours rather than VSP's default SpeedTree atlas,
        // which ignores the private oak tint and NM healthy/dry colours.
        void BakeBiomeBillboard(VegetationPackagePro catalog,VegetationItemInfoPro item)
        {
            var shader=Shader.Find("Hidden/GolfMap/BiomeAtlas");
            if(!shader||!shader.isSupported)throw new InvalidOperationException("Install GolfMapBiomeAtlas.shader before outer planting.");
            var original=item.VegetationPrefab;
            var temp=Instantiate(original);temp.hideFlags=HideFlags.HideAndDontSave;
            var materials=new List<Material>();
            var previous=item.ShaderControllerSettings.OverrideBillboardAtlasShader;
            try {
                foreach(var renderer in temp.GetComponentsInChildren<Renderer>(true)){
                    if(renderer is BillboardRenderer){renderer.enabled=false;continue;}
                    var slots=renderer.sharedMaterials;
                    for(int i=0;i<slots.Length;i++){
                        var source=slots[i];if(!source||!source.HasProperty("_MainTex"))throw new InvalidOperationException("Billboard material needs a main texture: "+original.name);
                        var mat=new Material(shader);materials.Add(mat);
                        mat.SetTexture("_MainTex",source.GetTexture("_MainTex"));mat.SetTextureScale("_MainTex",source.GetTextureScale("_MainTex"));mat.SetTextureOffset("_MainTex",source.GetTextureOffset("_MainTex"));
                        Color tint=Color.white;
                        if(source.HasProperty("_GolfMapLeafTint"))tint=source.GetColor("_GolfMapLeafTint");
                        else if(source.HasProperty("_HealthyColor")&&source.HasProperty("_DryColor"))tint=Color.Lerp(source.GetColor("_HealthyColor"),source.GetColor("_DryColor"),0.5f);
                        else if(source.HasProperty("_Color"))tint=source.GetColor("_Color");
                        mat.SetColor("_Color",tint);mat.SetFloat("_Cutoff",source.HasProperty("_Cutoff")?source.GetFloat("_Cutoff"):0);
                        if(source.HasProperty("_BumpMap"))mat.SetTexture("_BumpMap",source.GetTexture("_BumpMap"));
                        slots[i]=mat;
                    }
                    renderer.sharedMaterials=slots;
                }
                item.VegetationPrefab=temp;item.ShaderControllerSettings.OverrideBillboardAtlasShader=shader.name;
                catalog.GenerateBillboard(item.VegetationItemID);
                if(!item.BillboardTexture||!item.BillboardNormalTexture)throw new InvalidOperationException("Billboard bake failed: "+original.name);
            } finally {item.VegetationPrefab=original;item.ShaderControllerSettings.OverrideBillboardAtlasShader=previous;DestroyImmediate(temp);foreach(var mat in materials)DestroyImmediate(mat);EditorUtility.ClearProgressBar();}
        }

        partial void PlantStorage()
        {
            var temporary = new List<GameObject>();
            var prepared = new List<PreparedTree>();
            var cache = new Dictionary<GameObject, Proto>();
            int meshHits = 0, terrainHits = 0, skipped = 0, clamped = 0;
            try
            {
                if (terrain.transform.rotation != Quaternion.identity || terrain.transform.lossyScale != Vector3.one)
                    throw new InvalidOperationException("Terrain must have identity rotation and unit scale.");
                if (Mathf.Abs(terrain.terrainData.size.x - loaded.plot.sizeM) > 0.5f || Mathf.Abs(terrain.terrainData.size.z - loaded.plot.sizeM) > 0.5f)
                    throw new InvalidOperationException("Plot size does not match terrain. Re-export using the terrain plot.");
                if(forceBillboards&&(!ValidNumber(outerBillboardDistance)||outerBillboardDistance<=0))throw new InvalidOperationException("Set a positive outer billboard distance.");
                if(forceBillboards&&!useBiome&&scaleWidth)throw new InvalidOperationException("Outer VSP billboards require uniform scaling. Disable width scaling or use the biome.");
                if(storage&&!StorageMatchesTerrain(storage,terrain)){
                    string reason=StorageMismatchDetails(storage,terrain);
                    if(!EditorUtility.DisplayDialog("Create matching storage?",reason+"\n\nCreate and select a new empty storage for '"+terrain.name+"' and continue planting? The old system and its trees will remain. You can remove it with Delete storage.","Create new and continue","Cancel")){
                        status="Plant cancelled. "+reason;return;
                    }
                    var previousStorage=storage;
                    try {
                        storage=null;EnsureStorage(true);
                        if(!StorageMatchesTerrain(storage,terrain))throw new InvalidOperationException("New storage setup failed. "+StorageMismatchDetails(storage,terrain));
                        AssetDatabase.SaveAssets();EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
                    }catch{storage=previousStorage;throw;}
                }
                if(storage&&storage.VegetationSystemPro){
                    if(!StorageMatchesTerrain(storage,terrain))throw new InvalidOperationException("Storage does not match the current terrain/bounds. Click Create / select storage for this terrain to select or create a matching system. The old storage will be preserved.");
                    var catalogs=storage.VegetationSystemPro.VegetationPackageProList;
                    if(catalogs.Any(p=>p&&p.VegetationInfoList.Count>0&&p.PackageName!=(forceBillboards?"GolfMap imported trees (billboards)":"GolfMap imported trees")))throw new InvalidOperationException("Storage contains a different planting layer. Inner and outer must use separate systems.");
                }
                var filters = (forceBillboards?new List<GameObject>():groundMeshes).Where(g => g).SelectMany(g => g.GetComponentsInChildren<MeshFilter>()).Where(m => m.sharedMesh && m.gameObject.activeInHierarchy).Distinct().ToList();
                var colliders = new List<MeshCollider>();
                foreach (var filter in filters)
                {
                    if (filter.gameObject.scene != terrain.gameObject.scene) throw new InvalidOperationException("Ground meshes must belong to the terrain scene.");
                    var go = new GameObject("GolfMap ground probe") { hideFlags = HideFlags.HideAndDontSave };
                    temporary.Add(go);
                    go.transform.SetParent(filter.transform, false);
                    var collider = go.AddComponent<MeshCollider>();
                    collider.sharedMesh = filter.sharedMesh;
                    colliders.Add(collider);
                }
                Physics.SyncTransforms();
                foreach (var tree in loaded.trees)
                {
                    if (!InsidePlot(tree) || tree.h < minHeightM) { skipped++; continue; }
                    var rng = new System.Random(StemSeed(tree, seed));
                    var prefab = Pick(tree, rng);
                    if (!prefab) {if(useBiome){skipped++;continue;}throw new InvalidOperationException("No prefab mapping for kind " + tree.k + ". Existing import retained.");}
                    var proto = Measure(prefab, cache);
                    var pos = WorldPos(tree);
                    pos.y = terrain.SampleHeight(pos) + terrain.transform.position.y;
                    float best = float.NegativeInfinity;
                    foreach (var collider in colliders)
                    {
                        var b = collider.bounds;
                        if (pos.x < b.min.x || pos.x > b.max.x || pos.z < b.min.z || pos.z > b.max.z) continue;
                        RaycastHit hit;
                        if (collider.Raycast(new Ray(new Vector3(pos.x, b.max.y + 1, pos.z), Vector3.down), out hit, b.size.y + 2)) best = Mathf.Max(best, hit.point.y);
                    }
                    if (!float.IsNegativeInfinity(best)) { pos.y = best; meshHits++; } else terrainHits++;
                    float hs = HeightScale(tree, proto), ws = WidthScale(tree, proto, hs);
                    if (Mathf.Abs(hs - tree.h / proto.heightM) > 0.0001f || (scaleWidth && Mathf.Abs(ws - 2 * tree.r / proto.widthM) > 0.0001f)) clamped++;
                    prepared.Add(new PreparedTree { prefab = prefab, position = pos, scale = new Vector3(ws, hs, ws), rotation = Quaternion.Euler(0, TreeRotation(tree,rng), 0) });
                }
                if (prepared.Count == 0) throw new InvalidOperationException("No eligible trees. Existing import retained.");
                EnsureStorage();
                var system = storage.VegetationSystemPro;
                var package = storage.PersistentVegetationStoragePackage;
                if (!system || !package || storage.DisablePersistentStorage || system.gameObject.scene != terrain.gameObject.scene)
                    throw new InvalidOperationException("Storage must be enabled and reference a system and package in the terrain scene.");
                if (!storage.HasValidPersistentStorage(system.VegetationCellList.Count) || system.VegetationCellList.Count == 0)
                    throw new InvalidOperationException("Persistent storage cell layout does not match VSP. Refusing to reset existing storage.");
                system.PersistentVegetationStorage = storage;
                system.VegetationCellSpawner.PersistentVegetationStorage = storage;
                // This VSP billboard generator uses X scale for both billboard axes.
                // The survey uses independent crown width and height: retain mesh LODs.
                system.VegetationSettings.AdditionalTreeMeshDistance = forceBillboards ? 0 : 3000;
                if(forceBillboards){system.VegetationSettings.PlantDistance=0;system.VegetationSettings.AdditionalBillboardDistance=outerBillboardDistance;system.VegetationSettings.TreeShadows=false;}
                int nudged = 0;
                for (int i = 0; i < prepared.Count; i++)
                {
                    var t = prepared[i];
                    var cells = new List<VegetationCell>();
                    system.VegetationCellQuadTree.Query(new Rect(new Vector2(t.position.x, t.position.z), Vector2.zero), cells);
                    if (cells.Count == 1) continue;
                    // VSP resolves a position with a zero-size rect (also inside AddVegetationItemInstance), which misses
                    // points lying exactly on a cell edge. Survey stems use whole-metre coordinates, so thousands sit on the
                    // cell grid. Nudge those a centimetre into the nearest cell instead of dropping them.
                    const float eps = 0.01f;
                    cells.Clear();
                    system.VegetationCellQuadTree.Query(new Rect(t.position.x - eps, t.position.z - eps, 2 * eps, 2 * eps), cells);
                    if (cells.Count == 0) throw new InvalidOperationException("Tree at " + t.position + " falls outside VSP coverage " + system.VegetationSystemBounds + ". Existing import retained.");
                    var r = cells[0].Rectangle;
                    t.position.x = Mathf.Clamp(t.position.x, r.xMin + eps, r.xMax - eps);
                    t.position.z = Mathf.Clamp(t.position.z, r.yMin + eps, r.yMax - eps);
                    cells.Clear();
                    system.VegetationCellQuadTree.Query(new Rect(new Vector2(t.position.x, t.position.z), Vector2.zero), cells);
                    if (cells.Count != 1) throw new InvalidOperationException("Tree at " + t.position + " maps to " + cells.Count + " VSP cells after nudging. Existing import retained.");
                    prepared[i] = t; nudged++;
                }
                var mapping = new Dictionary<GameObject, string>();
                var catalogName = forceBillboards ? "GolfMap imported trees (billboards)" : "GolfMap imported trees";
                var catalog = system.VegetationPackageProList.FirstOrDefault(p => p && p.PackageName == catalogName);
                if (!catalog)
                {
                    catalog = CreateInstance<VegetationPackagePro>();
                    catalog.PackageName = catalogName;
                    AssetDatabase.CreateAsset(catalog, AssetDatabase.GenerateUniqueAssetPath(VretaFolder + "TreeCatalog.asset"));
                    system.AddVegetationPackage(catalog);
                }
                foreach (var prefab in prepared.Select(t => t.prefab).Distinct())
                {
                    var item = catalog.VegetationInfoList.FirstOrDefault(i => i.VegetationPrefab == prefab);
                    if (item == null) { catalog.AddVegetationItem(prefab, VegetationType.Tree, false); item = catalog.VegetationInfoList.Last(); }
                    if(useBiome)SyncPrefabColours(item);
                    item.EnableRuntimeSpawn = false;
                    item.UseBillboards = forceBillboards;
                    if(forceBillboards&&(regenerateBillboards||!item.BillboardTexture))BakeBiomeBillboard(catalog,item);
                    mapping.Add(prefab, item.VegetationItemID);
                }
                system.RefreshVegetationSystem();
                if(!storage.HasValidPersistentStorage(system.VegetationCellList.Count))throw new InvalidOperationException("Storage layout changed on catalogue refresh. Import stopped.");
                var backup=BackupStorage(package);
                Undo.RegisterCompleteObjectUndo(package, "Import GolfMap trees");
                int prior = SourceCount(package);
                try {
                if (clearExisting) foreach (var id in StoredIDs(package)) package.RemoveVegetationItemInstances(id, ImportSource);
                foreach (var t in prepared) storage.AddVegetationItemInstance(mapping[t.prefab], t.position, t.scale, t.rotation, false, ImportSource, 1f, false);
                int expected = prepared.Count + (clearExisting ? 0 : prior);
                if (SourceCount(package) != expected) throw new InvalidOperationException("Stored count differs from expected count.");
                } catch {EditorJsonUtility.FromJsonOverwrite(backup,package);EditorUtility.SetDirty(package);RefreshStorage();throw;}
                EditorUtility.SetDirty(package); EditorUtility.SetDirty(catalog); EditorUtility.SetDirty(system); EditorUtility.SetDirty(storage);
                EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
                RefreshStorage();
                AssetDatabase.SaveAssets();
                status = "Imported " + prepared.Count + " trees: " + meshHits + " mesh hits, " + terrainHits + " terrain fallback, " + skipped + " skipped, " + clamped + " scale-clamped, " + nudged + " nudged off cell edges. Source 42. Save the scene to retain setup.";
                Directory.CreateDirectory("GolfMapSpelunk");
                File.WriteAllText("GolfMapSpelunk/Vreta_tree_import.txt", DateTime.UtcNow.ToString("o") + "\n" + status + "\n" + AlignmentReport() + "\nStorage: " + AssetDatabase.GetAssetPath(package));
                Debug.Log("[GolfMap] " + status);
            }
            catch (Exception e) { status = "Import stopped: " + e.Message; Debug.LogException(e); }
            finally { foreach (var go in temporary) if (go) DestroyImmediate(go); }
        }
    }
}
