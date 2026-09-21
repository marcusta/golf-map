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
using Mode = GolfMap.GolfMapTrees.Mode;

namespace GolfMap.Editor
{
    public partial class GolfMapTreePlanter
    {
        const byte ImportSource = 42;
        internal GolfMapCourse Course { get { return GolfMapCourses.For(component); } }
        PersistentVegetationStorage storage { get { return T.storage; } set { T.storage = value; } }
        List<GameObject> groundMeshes { get { return T.groundMeshes; } set { T.groundMeshes = value; } }
        float outerBillboardDistance { get { return T.outerBillboardDistance; } set { T.outerBillboardDistance = value; } }
        bool regenerateBillboards { get { return T.regenerateBillboards; } set { T.regenerateBillboards = value; } }
        string lastPlantingBackup { get { return T.lastPlantingBackup; } set { T.lastPlantingBackup = value; } }
        partial void StorageAvailable(ref bool available) {available=true;}
        static bool Finite(float v) { return !float.IsNaN(v) && !float.IsInfinity(v); }

        [MenuItem("GolfMap/Configure course planter %&g")]
        public static void ConfigureCourse()
        {
            var planter = Select();
            try { planter.ConfigureFromCourse(); }
            catch(Exception e) {
                planter.status = "Course setup stopped: " + e.Message;
                Debug.LogWarning("[GolfMap] " + planter.status);
            }
            planter.Repaint(); // Configuring must never replant the whole course.
        }

        // Resets the selected area's settings to the course defaults. Terrain, trees file and
        // storage are not set here: SyncRole resolves them from the role on every repaint.
        void ConfigureFromCourse()
        {
            var course = Course;
            var scene = SceneManager.GetActiveScene();
            if (!string.IsNullOrEmpty(course.sceneName) && scene.name != course.sceneName) throw new InvalidOperationException("Open " + course.sceneName + " first.");
            T.customFile = false;
            mode = Mode.PersistentStorage;
            broadleafPrefabs = new List<GameObject> { AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Trees/Broadleaf/Broadleaf_Desktop.prefab") };
            coniferPrefabs = new List<GameObject> { AssetDatabase.LoadAssetAtPath<GameObject>("Assets/Trees/Conifer/Conifer_Desktop.prefab") };
            unknownPrefabs.Clear(); bushPrefabs.Clear();
            useBiome=true;biomePath="";
            minScale = 0.75f; maxScale = 1.4f; scaleWidth = false;
            groundMeshes = forceBillboards ? new List<GameObject>() : FindObjectsOfType<MeshFilter>().Where(m => m.gameObject.scene == scene && m.name.StartsWith("Spline_") && !m.name.Contains("Blend") && m.sharedMesh != null).Select(m => m.gameObject).ToList();
            loaded = null;
            var problem = SyncRole();
            status = GolfMapCourses.Name(course) + " " + RoleKey + " preset ready: " + groundMeshes.Count + " course meshes, terrain fallback. Plant creates dedicated VSP storage if needed." + (string.IsNullOrEmpty(problem) ? "" : "\n" + problem);
            Dirty();
        }

        // The area's storage is the one GolfMap system laid out for its terrain. Picking it by
        // hand is what let inner trees land in the outer system, so it is only ever resolved.
        partial void SyncStorage(ref bool changed, ref string problem)
        {
            if (mode != Mode.PersistentStorage || !terrain) return;
            var matches = FindObjectsOfType<PersistentVegetationStorage>().Where(v => IsGolfMapStorage(v) && StorageMatchesTerrain(v, terrain)).ToArray();
            if (matches.Length > 1)
            {
                problem = matches.Length + " GolfMap storage systems are laid out for " + terrain.name + " (" +
                    string.Join(", ", matches.Select(m => Path.GetFileNameWithoutExtension(AssetDatabase.GetAssetPath(m.PersistentVegetationStoragePackage))).ToArray()) +
                    "). Every one of them renders. Keep one and remove the rest with Delete storage.";
                if (!matches.Contains(storage)) { storage = null; changed = true; }
                return;
            }
            var resolved = matches.Length == 1 ? matches[0] : null;
            if (storage != resolved) { storage = resolved; changed = true; }
        }

        partial void DrawStorageOptions()
        {
            if (mode != Mode.PersistentStorage) return;
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Storage for this area", EditorStyles.boldLabel);
            using (new EditorGUI.DisabledScope(true)) EditorGUILayout.ObjectField("Persistent storage", storage, typeof(PersistentVegetationStorage), true);
            if(storage&&storage.PersistentVegetationStoragePackage)EditorGUILayout.LabelField("Storage asset",AssetDatabase.GetAssetPath(storage.PersistentVegetationStoragePackage));
            else EditorGUILayout.LabelField("Storage asset","None yet: Plant creates it");
            if(forceBillboards){outerBillboardDistance=EditorGUILayout.FloatField("Outer billboard distance (m)",outerBillboardDistance);regenerateBillboards=EditorGUILayout.Toggle("Rebake billboard colours",regenerateBillboards);}
            if(!forceBillboards)EditorGUILayout.PropertyField(so.FindProperty("groundMeshes"), new GUIContent("Ground mesh objects / roots"), true);
            using(new EditorGUI.DisabledScope(!storage||!storage.VegetationSystemPro)){
                if(GUILayout.Button("Refresh planted colours from prefab materials"))RefreshPlantedColours();
            }
            using(new EditorGUILayout.HorizontalScope()){
                if(GUILayout.Button("Check for doubled trees")){string report="";DuplicateReport(ref report);status=string.IsNullOrEmpty(report)?"No storage to check.":report.TrimStart();}
                if(GUILayout.Button("Remove doubled trees..."))RemoveDoubles();
            }
            using(new EditorGUILayout.HorizontalScope()){
                if(GUILayout.Button("Restore from planting backup")){
                    if(!storage||!storage.PersistentVegetationStoragePackage){status="Nothing planted in this area to restore.";return;}
                    var chosen=EditorUtility.OpenFilePanel("Planting backup for this storage", "GolfMapSpelunk/PlantingBackups", "json");
                    if(chosen.Length>0){
                        var package=storage.PersistentVegetationStoragePackage;
                        if(!File.Exists(chosen+".target")||File.ReadAllText(chosen+".target")!=AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(package))){status="Backup belongs to a different storage asset.";return;}
                        Undo.RegisterCompleteObjectUndo(package,"Restore GolfMap planting");EditorJsonUtility.FromJsonOverwrite(File.ReadAllText(chosen),package);EditorUtility.SetDirty(package);RefreshStorage();AssetDatabase.SaveAssets();status="Restored storage. Prefab/material settings are unchanged.";
                    }
                }
                if(GUILayout.Button("Delete storage...")){
                    var dialog=CreateInstance<DeleteStorageWindow>();dialog.planter=this;
                    dialog.titleContent=new GUIContent("Delete storage");dialog.minSize=new Vector2(660,390);dialog.ShowUtility();
                }
            }
            EditorGUILayout.HelpBox("The storage is found from the area's terrain; Plant creates it when there is none. Plant and Clear replace this area's imported trees (source 42) only, after writing a backup.", MessageType.None);
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

        void RefreshStorage()
        {
            if (storage && storage.VegetationSystemPro) { storage.VegetationSystemPro.ClearCache(); SceneView.RepaintAll(); }
        }

        internal static bool IsImportedCatalogue(VegetationPackagePro catalog)
        {
            return catalog&&(catalog.PackageName=="GolfMap imported trees"||catalog.PackageName=="GolfMap imported trees (billboards)");
        }

        // VSP caches NM colours separately and overrides the prefab's material.
        // Find bark by shader, not the first _Color (leaf materials also have it).
        internal static bool SyncPrefabColours(VegetationItemInfoPro item)
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
                // Import material files edited outside Unity first; otherwise the sync reads the
                // previous in-memory colours and writes those back into the catalogue.
                AssetDatabase.Refresh();
                int updated=0;
                foreach(var catalog in storage.VegetationSystemPro.VegetationPackageProList){
                    if(!IsImportedCatalogue(catalog))continue;
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
            if (!storage || !storage.PersistentVegetationStoragePackage) { status = "Nothing planted in the " + RoleKey + " area: it has no storage yet."; return; }
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

        // Every system is named VegetationSystemPro for GSPro's sake (GolfMapVspRig), so identity
        // comes from the storage asset the planter created for it, never from the object's name.
        static bool IsGolfMapStorage(PersistentVegetationStorage candidate)
        {
            if(!candidate||!candidate.PersistentVegetationStoragePackage)return false;
            return GolfMapCourses.Owns(AssetDatabase.GetAssetPath(candidate.PersistentVegetationStoragePackage));
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
            var manager = GolfMapVspRig.EnsureManager(terrain.gameObject.scene);
            if (storage&&!createNew) return;
            var candidates=FindObjectsOfType<PersistentVegetationStorage>()
                .Where(s=>s.gameObject.scene==terrain.gameObject.scene&&IsGolfMapStorage(s)).ToArray();
            var compatible=candidates.Where(s=>StorageMatchesTerrain(s,terrain)).ToArray();
            if(!createNew&&compatible.Length>1)throw new InvalidOperationException("Several matching GolfMap systems exist. Select the intended storage explicitly.");
            if(!createNew&&compatible.Length==1){storage=compatible[0];return;}
            var go = new GameObject(GolfMapVspRig.SystemObjectName);
            Undo.RegisterCreatedObjectUndo(go, "Create GolfMap VSP system");
            SceneManager.MoveGameObjectToScene(go, terrain.gameObject.scene);
            storage = go.AddComponent<PersistentVegetationStorage>();
            var system = go.AddComponent<VegetationSystemPro>();
            storage.VegetationSystemPro = system;
            system.PersistentVegetationStorage = storage;
            // Match the shape VSP's own wizard builds, which is what GSPro expects to find.
            GolfMapVspRig.Standardise(system, manager);
            system.AutomaticBoundsCalculation = false;
            var size = terrain.terrainData.size;
            system.VegetationSystemBounds = new Bounds(terrain.transform.position + size / 2, size + new Vector3(2, 100, 2));
            if (!terrain.GetComponent<UnityTerrain>()) Undo.AddComponent<UnityTerrain>(terrain.gameObject);
            system.AddTerrain(terrain.gameObject);
            var package = CreateInstance<PersistentVegetationStoragePackage>();
            AssetDatabase.CreateAsset(package, AssetDatabase.GenerateUniqueAssetPath(GolfMapCourses.Folder(Course) + "ImportedTreeStorage.asset"));
            storage.SetPersistentVegetationStoragePackage(package);
            system.RefreshVegetationSystem();
            storage.InitializePersistentStorage(); // New, empty package only. Never reinitialize existing storage.
            EditorUtility.SetDirty(system);
            EditorUtility.SetDirty(storage);
        }

        struct PreparedTree
        {
            public GolfMapTree tree;
            public GameObject prefab;
            public Vector3 position, scale;
            public Quaternion rotation;
        }

        // Ground height for a stem: course meshes first (temporary colliders),
        // the terrain otherwise. Dispose removes the probe objects.
        class GroundProbe : IDisposable
        {
            readonly Terrain terrain;
            readonly List<GameObject> temporary = new List<GameObject>();
            readonly List<MeshCollider> colliders = new List<MeshCollider>();
            public GroundProbe(Terrain terrain, IEnumerable<GameObject> roots)
            {
                this.terrain = terrain;
                var filters = roots.Where(g => g).SelectMany(g => g.GetComponentsInChildren<MeshFilter>()).Where(m => m.sharedMesh && m.gameObject.activeInHierarchy).Distinct().ToList();
                foreach (var filter in filters)
                {
                    if (filter.gameObject.scene != terrain.gameObject.scene) { Dispose(); throw new InvalidOperationException("Ground meshes must belong to the terrain scene."); }
                    var go = new GameObject("GolfMap ground probe") { hideFlags = HideFlags.HideAndDontSave };
                    temporary.Add(go);
                    go.transform.SetParent(filter.transform, false);
                    var collider = go.AddComponent<MeshCollider>();
                    collider.sharedMesh = filter.sharedMesh;
                    colliders.Add(collider);
                }
                Physics.SyncTransforms();
            }
            public float Height(Vector3 pos, out bool meshHit)
            {
                float best = float.NegativeInfinity;
                foreach (var collider in colliders)
                {
                    var b = collider.bounds;
                    if (pos.x < b.min.x || pos.x > b.max.x || pos.z < b.min.z || pos.z > b.max.z) continue;
                    RaycastHit hit;
                    if (collider.Raycast(new Ray(new Vector3(pos.x, b.max.y + 1, pos.z), Vector3.down), out hit, b.size.y + 2)) best = Mathf.Max(best, hit.point.y);
                }
                meshHit = !float.IsNegativeInfinity(best);
                return meshHit ? best : terrain.SampleHeight(pos) + terrain.transform.position.y;
            }
            public void Dispose() { foreach (var go in temporary) if (go) DestroyImmediate(go); temporary.Clear(); colliders.Clear(); }
        }

        // Prefab, ground position, scale and rotation for one survey stem.
        // prefab is null when the stem has no mapping (biome: unmatched).
        PreparedTree PrepareOne(GolfMapTree tree, GroundProbe probe, Dictionary<GameObject, Proto> cache, ref int meshHits, ref int terrainHits, ref int clamped)
        {
            var rng = new System.Random(StemSeed(tree, seed));
            var prefab = Pick(tree, rng);
            if (!prefab) return new PreparedTree { tree = tree };
            var proto = Measure(prefab, cache);
            var pos = WorldPos(tree);
            bool meshHit; pos.y = probe.Height(pos, out meshHit);
            if (meshHit) meshHits++; else terrainHits++;
            GolfMapTreeEdit edit; if (treeEdits.TryGetValue(tree, out edit)) pos.y += edit.dy;
            float hs = HeightScale(tree, proto), ws = WidthScale(tree, proto, hs);
            if (Mathf.Abs(hs - tree.h / proto.heightM) > 0.0001f || (scaleWidth && Mathf.Abs(ws - 2 * tree.r / proto.widthM) > 0.0001f)) clamped++;
            return new PreparedTree { tree = tree, prefab = prefab, position = pos, scale = new Vector3(ws, hs, ws), rotation = Quaternion.Euler(0, TreeRotation(tree, rng), 0) };
        }

        // VSP resolves a position with a zero-size rect (also inside AddVegetationItemInstance), which misses
        // points lying exactly on a cell edge. Survey stems use whole-metre coordinates, so thousands sit on the
        // cell grid. Nudge those a centimetre into the nearest cell instead of dropping them.
        static bool ResolveCell(VegetationSystemPro system, ref Vector3 position)
        {
            var cells = new List<VegetationCell>();
            system.VegetationCellQuadTree.Query(new Rect(new Vector2(position.x, position.z), Vector2.zero), cells);
            if (cells.Count == 1) return false;
            const float eps = 0.01f;
            cells.Clear();
            system.VegetationCellQuadTree.Query(new Rect(position.x - eps, position.z - eps, 2 * eps, 2 * eps), cells);
            if (cells.Count == 0) throw new InvalidOperationException("Tree at " + position + " falls outside VSP coverage " + system.VegetationSystemBounds + ". Existing import retained.");
            var r = cells[0].Rectangle;
            position.x = Mathf.Clamp(position.x, r.xMin + eps, r.xMax - eps);
            position.z = Mathf.Clamp(position.z, r.yMin + eps, r.yMax - eps);
            cells.Clear();
            system.VegetationCellQuadTree.Query(new Rect(new Vector2(position.x, position.z), Vector2.zero), cells);
            if (cells.Count != 1) throw new InvalidOperationException("Tree at " + position + " maps to " + cells.Count + " VSP cells after nudging. Existing import retained.");
            return true;
        }

        string CatalogName { get { return forceBillboards ? "GolfMap imported trees (billboards)" : "GolfMap imported trees"; } }

        // The selected storage must be enabled, in the terrain scene and laid out for the system's cells.
        void CheckStorageReady(out VegetationSystemPro system, out PersistentVegetationStoragePackage package)
        {
            EnsureStorage();
            system = storage.VegetationSystemPro;
            package = storage.PersistentVegetationStoragePackage;
            if (!system || !package || storage.DisablePersistentStorage || system.gameObject.scene != terrain.gameObject.scene)
                throw new InvalidOperationException("Storage must be enabled and reference a system and package in the terrain scene.");
            if (!storage.HasValidPersistentStorage(system.VegetationCellList.Count) || system.VegetationCellList.Count == 0)
                throw new InvalidOperationException("Persistent storage cell layout does not match VSP. Refusing to reset existing storage.");
        }

        // Adds the prefabs to the GolfMap catalogue (creating it if needed) and returns prefab -> vegetation item id.
        Dictionary<GameObject, string> EnsureCatalog(VegetationSystemPro system, IEnumerable<GameObject> prefabs, bool rebake)
        {
            var mapping = new Dictionary<GameObject, string>();
            var catalog = system.VegetationPackageProList.FirstOrDefault(p => p && p.PackageName == CatalogName);
            if (!catalog)
            {
                catalog = CreateInstance<VegetationPackagePro>();
                catalog.PackageName = CatalogName;
                AssetDatabase.CreateAsset(catalog, AssetDatabase.GenerateUniqueAssetPath(GolfMapCourses.Folder(Course) + "TreeCatalog.asset"));
                system.AddVegetationPackage(catalog);
            }
            bool changed = false;
            foreach (var prefab in prefabs.Distinct())
            {
                var item = catalog.VegetationInfoList.FirstOrDefault(i => i.VegetationPrefab == prefab);
                if (item == null) { catalog.AddVegetationItem(prefab, VegetationType.Tree, false); item = catalog.VegetationInfoList.Last(); changed = true; }
                if(useBiome)SyncPrefabColours(item);
                item.EnableRuntimeSpawn = false;
                item.UseBillboards = forceBillboards;
                if(forceBillboards&&(rebake||!item.BillboardTexture)){BakeBiomeBillboard(catalog,item);changed=true;}
                mapping.Add(prefab, item.VegetationItemID);
            }
            EditorUtility.SetDirty(catalog);
            if (changed) system.RefreshVegetationSystem();
            if(!storage.HasValidPersistentStorage(system.VegetationCellList.Count))throw new InvalidOperationException("Storage layout changed on catalogue refresh. Import stopped.");
            return mapping;
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
            GroundProbe probe = null;
            var prepared = new List<PreparedTree>();
            var cache = new Dictionary<GameObject, Proto>();
            int meshHits = 0, terrainHits = 0, skipped = 0, clamped = 0, nudged = 0;
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
                    if(catalogs.Any(p=>p&&p.VegetationInfoList.Count>0&&p.PackageName!=CatalogName))throw new InvalidOperationException("Storage contains a different planting layer. Inner and outer must use separate systems.");
                }
                probe = new GroundProbe(terrain, forceBillboards ? new List<GameObject>() : groundMeshes);
                foreach (var tree in loaded.trees)
                {
                    if (!InsidePlot(tree) || tree.h < minHeightM) { skipped++; continue; }
                    var t = PrepareOne(tree, probe, cache, ref meshHits, ref terrainHits, ref clamped);
                    if (!t.prefab) {if(useBiome){skipped++;continue;}throw new InvalidOperationException("No prefab mapping for kind " + tree.k + ". Existing import retained.");}
                    prepared.Add(t);
                }
                if (prepared.Count == 0) throw new InvalidOperationException("No eligible trees. Existing import retained.");
                VegetationSystemPro system; PersistentVegetationStoragePackage package;
                CheckStorageReady(out system, out package);
                system.PersistentVegetationStorage = storage;
                system.VegetationCellSpawner.PersistentVegetationStorage = storage;
                // This VSP billboard generator uses X scale for both billboard axes.
                // The survey uses independent crown width and height: retain mesh LODs.
                system.VegetationSettings.AdditionalTreeMeshDistance = forceBillboards ? 0 : 3000;
                if(forceBillboards){system.VegetationSettings.PlantDistance=0;system.VegetationSettings.AdditionalBillboardDistance=outerBillboardDistance;system.VegetationSettings.TreeShadows=false;}
                for (int i = 0; i < prepared.Count; i++)
                {
                    var t = prepared[i];
                    if (ResolveCell(system, ref t.position)) { prepared[i] = t; nudged++; }
                }
                int strays = Doubles(false).Where(d => d.storage != storage).Sum(d => d.items.Count);
                if (strays > 0) throw new InvalidOperationException(strays + " imported trees from another storage already stand in the " + RoleKey + " area and would render on top of these. Use Remove doubled trees first. Nothing changed.");
                int prior = SourceCount(package);
                if (prior > 0 && !EditorUtility.DisplayDialog("Replace " + RoleKey + " trees?", "Replace the " + prior + " imported trees in " + Path.GetFileName(AssetDatabase.GetAssetPath(package)) + " with " + prepared.Count + " from " + Path.GetFileName(filePath) + "?\n\nA backup is written first.", "Replace", "Cancel")) { status = "Plant cancelled. Nothing changed."; return; }
                var mapping = EnsureCatalog(system, prepared.Select(t => t.prefab), regenerateBillboards);
                var backup=BackupStorage(package);
                Undo.RegisterCompleteObjectUndo(package, "Import GolfMap trees");
                try {
                // Always replace. Appending the survey to an earlier import of it puts every tree in
                // twice, a hair apart wherever the palette's scale limits changed in between.
                foreach (var id in StoredIDs(package)) package.RemoveVegetationItemInstances(id, ImportSource);
                foreach (var t in prepared) storage.AddVegetationItemInstance(mapping[t.prefab], t.position, t.scale, t.rotation, false, ImportSource, 1f, false);
                if (SourceCount(package) != prepared.Count) throw new InvalidOperationException("Stored count differs from expected count.");
                } catch {EditorJsonUtility.FromJsonOverwrite(backup,package);EditorUtility.SetDirty(package);RefreshStorage();throw;}
                // Retired palette prefabs would otherwise stay in the catalogue for good and keep
                // failing VSP's per-item validation at load. Only safe once the instances are in.
                int pruned=GolfMapVspRig.PruneCatalogues(system);
                EditorUtility.SetDirty(package); EditorUtility.SetDirty(system); EditorUtility.SetDirty(storage);
                EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
                RefreshStorage();
                AssetDatabase.SaveAssets();
                status = "Replaced " + prior + " " + RoleKey + " trees with " + prepared.Count + ": " + meshHits + " mesh hits, " + terrainHits + " terrain fallback, " + skipped + " skipped, " + clamped + " scale-clamped, " + nudged + " nudged off cell edges" + (pruned > 0 ? ", " + pruned + " retired catalogue item(s) pruned" : "") + ". Source 42. Save the scene to retain setup.";
                File.WriteAllText(GolfMapCourses.ReportPath(Course, "tree_import.txt"), DateTime.UtcNow.ToString("o") + "\n" + status + "\n" + AlignmentReport() + "\nStorage: " + AssetDatabase.GetAssetPath(package));
                Debug.Log("[GolfMap] " + status);
            }
            catch (Exception e) { status = "Import stopped: " + e.Message; Debug.LogException(e); }
            finally { if (probe != null) probe.Dispose(); }
        }

        // ---- doubled trees ---------------------------------------------------

        // Imported instances that render on top of another one: a second copy of a stem in this
        // area's own storage (Plant used to append), or any instance another GolfMap storage
        // holds inside this area (the other area's setup pointed here).
        class DoubleSet
        {
            public PersistentVegetationStorage storage;
            public bool own;
            public List<KeyValuePair<PersistentVegetationInfo,int>> items = new List<KeyValuePair<PersistentVegetationInfo,int>>();
        }

        // The ground this role plants: its terrain, minus the inner square for the outer role.
        bool InsideArea(Vector3 world)
        {
            var p = world - terrain.transform.position; var size = terrain.terrainData.size;
            if (!(p.x >= 0 && p.z >= 0 && p.x < size.x && p.z < size.z)) return false;
            if (forceBillboards && innerExclusion) { var q = world - innerExclusion.transform.position; var s = innerExclusion.terrainData.size; if (q.x >= 0 && q.z >= 0 && q.x <= s.x && q.z <= s.z) return false; }
            return true;
        }

        List<DoubleSet> Doubles(bool includeOwn)
        {
            var result = new List<DoubleSet>();
            if (!terrain || !terrain.terrainData) return result;
            foreach (var candidate in FindObjectsOfType<PersistentVegetationStorage>())
            {
                if (!IsGolfMapStorage(candidate) || !candidate.VegetationSystemPro || candidate.gameObject.scene != terrain.gameObject.scene) continue;
                bool own = candidate == storage;
                if (own && !includeOwn) continue;
                var set = new DoubleSet { storage = candidate, own = own };
                var origin = candidate.VegetationSystemPro.VegetationSystemPosition;
                var seen = new HashSet<long>();
                foreach (var cell in candidate.PersistentVegetationStoragePackage.PersistentVegetationCellList)
                    foreach (var info in cell.PersistentVegetationInfoList)
                        for (int i = info.VegetationItemList.Count - 1; i >= 0; i--)   // newest first: the latest planting is the copy kept
                        {
                            var item = info.VegetationItemList[i];
                            if (item.VegetationSourceID != ImportSource) continue;
                            var world = item.Position + origin;
                            bool doubled;
                            // Own storage: another instance within 25 cm of one already seen. Survey stems are metres apart.
                            if (own) doubled = !seen.Add(((long)Mathf.RoundToInt(world.x * 4) << 32) ^ (uint)Mathf.RoundToInt(world.z * 4));
                            else doubled = InsideArea(world);
                            if (doubled) set.items.Add(new KeyValuePair<PersistentVegetationInfo,int>(info, i));
                        }
                if (set.items.Count > 0) result.Add(set);
            }
            return result;
        }

        static string DoubleLabel(DoubleSet d)
        {
            return Path.GetFileNameWithoutExtension(AssetDatabase.GetAssetPath(d.storage.PersistentVegetationStoragePackage)) + " (" +
                string.Join(", ", d.storage.VegetationSystemPro.VegetationStudioTerrainObjectList.Where(g => g).Select(g => g.name).ToArray()) + ")";
        }

        partial void DuplicateReport(ref string report)
        {
            if (mode != Mode.PersistentStorage) return;
            var doubles = Doubles(true);
            if (doubles.Count == 0) { report = "\nNo doubled trees in the " + RoleKey + " area."; return; }
            foreach (var d in doubles)
                report += "\nWARNING " + d.items.Count + (d.own ? " trees are stored twice in this area's own storage " : " trees from another storage stand inside the " + RoleKey + " area: ") + DoubleLabel(d) + ".";
            report += "\nThey render on top of the real trees. Remove doubled trees clears them.";
        }

        void RemoveDoubles()
        {
            try
            {
                var doubles = Doubles(true);
                if (doubles.Count == 0) { status = "No doubled trees in the " + RoleKey + " area."; return; }
                string summary = string.Join("\n", doubles.Select(d => d.items.Count + (d.own ? " second copies in " : " strays in ") + DoubleLabel(d)).ToArray());
                if (!EditorUtility.DisplayDialog("Remove doubled trees?", "In the " + RoleKey + " area:\n\n" + summary + "\n\nOne copy of each tree stays. Every storage touched is backed up first.", "Remove", "Cancel")) return;
                int removed = 0;
                foreach (var d in doubles)
                {
                    var package = d.storage.PersistentVegetationStoragePackage;
                    BackupStorage(package);
                    Undo.RegisterCompleteObjectUndo(package, "Remove doubled GolfMap trees");
                    // Highest index first, so the indices collected for the same list stay valid.
                    foreach (var pair in d.items.OrderByDescending(x => x.Value)) { pair.Key.RemovePersistentVegetationInstanceAtIndex(pair.Value); removed++; }
                    package.SetInstanceInfoDirty();
                    EditorUtility.SetDirty(package);
                    d.storage.VegetationSystemPro.ClearCache();
                }
                AssetDatabase.SaveAssets();
                EditorApplication.QueuePlayerLoopUpdate(); SceneView.RepaintAll();
                status = "Removed " + removed + " doubled trees from the " + RoleKey + " area. Backups are in GolfMapSpelunk/PlantingBackups. Undo is available.";
                Debug.Log("[GolfMap] " + status);
            }
            catch (Exception e) { status = "Removal stopped: " + e.Message; Debug.LogException(e); }
        }
    }
}
