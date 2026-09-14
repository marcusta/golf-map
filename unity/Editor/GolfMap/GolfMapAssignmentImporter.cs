// Vreta integration, Unity 2018.2 / installed Vegetation Studio Pro.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using UnityEditor;
using UnityEngine;
using AwesomeTechnologies.VegetationSystem;
using AwesomeTechnologies.Vegetation.PersistentStorage;

namespace GolfMap.Editor
{
    public class GolfMapAssignmentImporter : EditorWindow
    {
        [Serializable] public class Point { public float x, z; }
        [Serializable] public class Assignment { public string stemId, status, guid; public float scale, rotationY; public Point position; }
        [Serializable] public class Report { public string format, sourceHash; public List<Assignment> assignments; }
        [Serializable] public class Stem { public string id; public float x,z; }
        [Serializable] public class Plot { public float sizeM; }
        [Serializable] public class Survey { public Plot plot; public List<Stem> trees; }
        const string SurveyPath = "Assets/GolfMap/Vreta/Vreta_trees.json";
        [SerializeField] string reportPath = "D:/golf-map/tree-export/vreta-hole1-assignments.json";
        [SerializeField] string backupPath;
        string status = "Validate first, then apply. The report may contain a subset of the survey.";
        void OnEnable() { Undo.undoRedoPerformed += RefreshAfterUndo; }
        void OnDisable() { Undo.undoRedoPerformed -= RefreshAfterUndo; }
        void RefreshAfterUndo() { try { Storage().VegetationSystemPro.ClearCache(); SceneView.RepaintAll(); } catch {} }
        [MenuItem("GolfMap/Vreta/Review and import assignments")]
        public static void Open() { GetWindow<GolfMapAssignmentImporter>("Tree assignments"); }
        void OnGUI()
        {
            reportPath = EditorGUILayout.TextField("Assignment JSON", reportPath);
            if (GUILayout.Button("Choose report")) { var p=EditorUtility.OpenFilePanel("Assignments", "", "json"); if(p.Length>0)reportPath=p; }
            EditorGUILayout.HelpBox("Replaces selected source-42 trees only. Uses stored ground heights. Backups and Undo preserve the preceding storage. Position changes must be handled in a later ground-probing pass.",MessageType.Info);
            if(GUILayout.Button("Validate assignments")) Execute(false);
            if(GUILayout.Button("Apply assignments")) Execute(true);
            if(GUILayout.Button("Restore last storage backup")) Restore();
            EditorGUILayout.HelpBox(status,MessageType.None);
        }
        static string Key(Vector3 p) { return Math.Round(p.x*1000)+":"+Math.Round(p.z*1000); }
        static bool Valid(float v) { return !float.IsNaN(v)&&!float.IsInfinity(v); }
        static PersistentVegetationStorage Storage()
        {
            var scene=UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            if(scene.name!="Vreta_lidar_scene")throw new InvalidOperationException("Open Vreta_lidar_scene.");
            return FindObjectsOfType<PersistentVegetationStorage>().Single(s=>s.name=="GolfMap Vreta Trees"&&s.gameObject.scene==scene);
        }
        void Restore()
        {
            try {
                var storage=Storage();var package=storage.PersistentVegetationStoragePackage;
                if(string.IsNullOrEmpty(backupPath)||!File.Exists(backupPath))throw new InvalidOperationException("No backup available in this window.");
                Undo.RegisterCompleteObjectUndo(package,"Restore assignment storage");
                EditorJsonUtility.FromJsonOverwrite(File.ReadAllText(backupPath),package);
                EditorUtility.SetDirty(package);storage.VegetationSystemPro.ClearCache();AssetDatabase.SaveAssets();SceneView.RepaintAll();
                status="Restored storage from "+backupPath;
            }catch(Exception e){status=e.Message;Debug.LogException(e);}
        }
        void Execute(bool apply)
        {
            PersistentVegetationStoragePackage package=null;
            string before=null;
            try {
                var report=JsonUtility.FromJson<Report>(File.ReadAllText(reportPath));
                if(report.format!="golfmap-tree-assignments-v1"||report.assignments==null||report.assignments.Count==0)throw new InvalidOperationException("Invalid or empty assignment report.");
                var source=File.ReadAllText(SurveyPath).TrimStart('\uFEFF');
                string digest;using(var sha=SHA256.Create())digest=BitConverter.ToString(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(source))).Replace("-","").ToLowerInvariant();
                if(digest!=report.sourceHash)throw new InvalidOperationException("Survey changed; regenerate the assignments.");
                var survey=JsonUtility.FromJson<Survey>(source);
                var stems=survey.trees.ToDictionary(t=>t.id);
                var storage=Storage();var system=storage.VegetationSystemPro;package=storage.PersistentVegetationStoragePackage;
                var terrain=FindObjectsOfType<Terrain>().Single(t=>t.gameObject.scene==storage.gameObject.scene&&t.terrainData.name=="Vreta_lidar_inner");
                if(terrain.transform.rotation!=Quaternion.identity||terrain.transform.lossyScale!=Vector3.one||Mathf.Abs(terrain.terrainData.size.x-survey.plot.sizeM)>.5f||Mathf.Abs(terrain.terrainData.size.z-survey.plot.sizeM)>.5f)throw new InvalidOperationException("Terrain transform or plot size mismatch.");
                if(!package||storage.DisablePersistentStorage||!storage.HasValidPersistentStorage(system.VegetationCellList.Count))throw new InvalidOperationException("Invalid persistent storage layout.");
                var stored=package.PersistentVegetationCellList.SelectMany(c=>c.PersistentVegetationInfoList).SelectMany(i=>i.VegetationItemList).Where(t=>t.VegetationSourceID==42).GroupBy(t=>Key(t.Position+system.VegetationSystemPosition)).ToDictionary(g=>g.Key,g=>g.ToList());
                var keys=new HashSet<string>();var ids=new HashSet<string>();var prefabs=new Dictionary<string,GameObject>();var positions=new Dictionary<string,Vector3>();
                foreach(var a in report.assignments) {
                    if(!ids.Add(a.stemId)||!stems.ContainsKey(a.stemId))throw new InvalidOperationException("Duplicate or unknown stem: "+a.stemId);
                    var t=stems[a.stemId];var world=terrain.transform.position+new Vector3(t.x,0,t.z);var key=Key(world);
                    if(!keys.Add(key))throw new InvalidOperationException("Ambiguous stem coordinates.");
                    if(a.status!="excluded"&&a.status!="proposed"&&a.status!="review"&&a.status!="authored")throw new InvalidOperationException("Unresolved assignment: "+a.stemId);
                    List<PersistentVegetationItem> matches;stored.TryGetValue(key,out matches);
                    if(matches!=null&&matches.Count!=1)throw new InvalidOperationException("Multiple source-42 trees at "+key);
                    if(a.status=="excluded")continue;
                    if(matches==null)throw new InvalidOperationException("No stored ground height for "+a.stemId+". Restore the base import first.");
                    if(a.position==null||!Valid(a.position.x)||!Valid(a.position.z)||Mathf.Abs(a.position.x-t.x)>.001f||Mathf.Abs(a.position.z-t.z)>.001f)throw new InvalidOperationException("Moved stems require ground reprojection; not applied: "+a.stemId);
                    if(!Valid(a.scale)||a.scale<=0||!Valid(a.rotationY))throw new InvalidOperationException("Invalid transform.");
                    positions[a.stemId]=matches[0].Position+system.VegetationSystemPosition;
                    if(!prefabs.ContainsKey(a.guid)) {
                        var prefab=AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(a.guid));
                        if(!prefab||prefab.GetComponentsInChildren<MeshFilter>(true).All(m=>!m.sharedMesh))throw new InvalidOperationException("Missing mesh asset: "+a.guid);
                        prefabs.Add(a.guid,prefab);
                    }
                }
                int replace=keys.Sum(k=>stored.ContainsKey(k)?stored[k].Count:0);
                int add=report.assignments.Count(a=>a.status!="excluded");
                status="Validated "+report.assignments.Count+" stems, "+prefabs.Count+" assets; replace "+replace+", plant "+add+". Review flags: "+report.assignments.Count(a=>a.status=="review")+".";
                if(!apply){Debug.Log("[GolfMap assignments] "+status);return;}
                var catalog=system.VegetationPackageProList.Single(p=>p&&p.PackageName=="GolfMap imported trees");
                var mapping=new Dictionary<string,string>();
                foreach(var p in prefabs) {
                    var item=catalog.VegetationInfoList.FirstOrDefault(i=>i.VegetationPrefab==p.Value);
                    if(item==null){catalog.AddVegetationItem(p.Value,VegetationType.Tree,false);item=catalog.VegetationInfoList.Last();}
                    item.EnableRuntimeSpawn=false;item.UseBillboards=false;mapping.Add(p.Key,item.VegetationItemID);
                }
                EditorUtility.SetDirty(catalog);system.RefreshVegetationSystem();
                if(!storage.HasValidPersistentStorage(system.VegetationCellList.Count))throw new InvalidOperationException("Cell layout changed during catalogue refresh.");
                before=EditorJsonUtility.ToJson(package);
                Directory.CreateDirectory("GolfMapSpelunk/AssignmentBackups");
                backupPath="GolfMapSpelunk/AssignmentBackups/"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N")+".json";
                File.WriteAllText(backupPath,before);
                Undo.RegisterCompleteObjectUndo(package,"Apply tree assignments");
                int totalBefore=package.PersistentVegetationCellList.Sum(c=>c.PersistentVegetationInfoList.Sum(i=>i.VegetationItemList.Count));
                Func<string[]> untouched=()=>package.PersistentVegetationCellList.SelectMany(c=>c.PersistentVegetationInfoList).SelectMany(i=>i.VegetationItemList.Where(t=>t.VegetationSourceID!=42||!keys.Contains(Key(t.Position+system.VegetationSystemPosition))).Select(t=>i.VegetationItemID+JsonUtility.ToJson(t))).OrderBy(v=>v,StringComparer.Ordinal).ToArray();
                var untouchedBefore=untouched();
                foreach(var cell in package.PersistentVegetationCellList)foreach(var info in cell.PersistentVegetationInfoList)
                    for(int j=info.VegetationItemList.Count-1;j>=0;j--)if(info.VegetationItemList[j].VegetationSourceID==42&&keys.Contains(Key(info.VegetationItemList[j].Position+system.VegetationSystemPosition)))info.RemovePersistentVegetationInstanceAtIndex(j);
                foreach(var a in report.assignments.Where(a=>a.status!="excluded"))storage.AddVegetationItemInstance(mapping[a.guid],positions[a.stemId],Vector3.one*a.scale,Quaternion.Euler(0,a.rotationY,0),false,42,1f,false);
                int totalAfter=package.PersistentVegetationCellList.Sum(c=>c.PersistentVegetationInfoList.Sum(i=>i.VegetationItemList.Count));
                if(totalAfter!=totalBefore-replace+add)throw new InvalidOperationException("Stored count mismatch; reverting.");
                if(!untouchedBefore.SequenceEqual(untouched()))throw new InvalidOperationException("Unselected vegetation changed; reverting.");
                foreach(var a in report.assignments.Where(a=>a.status!="excluded")) {
                    var planted=package.PersistentVegetationCellList.SelectMany(c=>c.PersistentVegetationInfoList).Where(i=>i.VegetationItemID==mapping[a.guid]).SelectMany(i=>i.VegetationItemList).Where(t=>t.VegetationSourceID==42&&Key(t.Position+system.VegetationSystemPosition)==Key(positions[a.stemId])).ToList();
                    if(planted.Count!=1||(planted[0].Scale-Vector3.one*a.scale).sqrMagnitude>0.000001f||Quaternion.Angle(planted[0].Rotation,Quaternion.Euler(0,a.rotationY,0))>.1f)throw new InvalidOperationException("Assignment verification failed; reverting: "+a.stemId);
                }
                EditorUtility.SetDirty(package);AssetDatabase.SaveAssets();system.ClearCache();SceneView.RepaintAll();
                status="Applied and verified. "+status+" Unselected instances unchanged: "+untouchedBefore.Length+". Backup: "+backupPath;Debug.Log("[GolfMap assignments] "+status);
            }catch(Exception e){if(package&&before!=null){EditorJsonUtility.FromJsonOverwrite(before,package);EditorUtility.SetDirty(package);AssetDatabase.SaveAssets();Storage().VegetationSystemPro.ClearCache();}status=e.Message;Debug.LogException(e);}
        }
    }
}
