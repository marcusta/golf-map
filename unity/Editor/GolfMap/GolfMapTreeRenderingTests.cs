using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
using AwesomeTechnologies.VegetationSystem;

namespace GolfMap.Editor
{
    // Diagnostic previews only. Persist the small set of edited properties by GUID so
    // restoration also works after a restart, without rolling back whole scene/assets.
    public class GolfMapTreeRenderingTests : EditorWindow
    {
        const string Folder = "Assets/GolfMap/Vreta/FoliageTrialV2/";
        const string Recovery = "Library/GolfMapTreeRenderingBaseline.json";
        [Serializable] public class Leaf
        {
            public string guid, normalGuid;
            public Color healthy, dry;
        }
        [Serializable] public class Tint
        {
            public string catalogGuid, itemId, property;
            public Color color;
        }
        [Serializable] public class Baseline
        {
            public string scene;
            public int ambientMode;
            public float intensity;
            public Color sky, equator, ground, flat;
            public Leaf[] leaves;
            public List<Tint> tints = new List<Tint>();
        }
        Baseline baseline;
        Texture2D neutral;
        string current = "Baseline", message = "";
        Vector2 scroll;

        [MenuItem("GolfMap/Vreta/Tree rendering tests")]
        public static void Open() { GetWindow<GolfMapTreeRenderingTests>("Tree rendering tests"); }
        void OnEnable()
        {
            if(File.Exists(Recovery)) {
                baseline=JsonUtility.FromJson<Baseline>(File.ReadAllText(Recovery));
                current="Recovery baseline available";
                message="Restore baseline before starting a new comparison.";
            }
            EditorSceneManager.sceneClosing+=SceneClosing;
            EditorApplication.playModeStateChanged+=PlayModeChanged;
        }
        void OnDisable()
        {
            EditorSceneManager.sceneClosing-=SceneClosing;
            EditorApplication.playModeStateChanged-=PlayModeChanged;
            if(baseline!=null) Run(()=>Finish());
            if(neutral) DestroyImmediate(neutral);
        }
        void SceneClosing(Scene scene, bool removing) { if(baseline!=null && scene.path==baseline.scene) Run(()=>Finish()); }
        void PlayModeChanged(PlayModeStateChange state)
        { if(state==PlayModeStateChange.ExitingEditMode && baseline!=null) Run(()=>Finish()); }
        Material MaterialFor(Leaf leaf)
        {
            var material=AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(leaf.guid));
            if(!material) throw new InvalidOperationException("A baseline leaf material is missing.");
            return material;
        }
        VegetationSystemPro[] Systems()
        {
            var scene=SceneManager.GetActiveScene();
            return FindObjectsOfType<VegetationSystemPro>().Where(s=>s.gameObject.scene==scene
                && s.VegetationPackageProList.Any(GolfMapTreePlanter.IsImportedCatalogue)).ToArray();
        }
        void Capture()
        {
            var scene=SceneManager.GetActiveScene();
            if(string.IsNullOrEmpty(scene.path)) throw new InvalidOperationException("Save the scene once before starting.");
            var systems=Systems();
            if(systems.Length==0) throw new InvalidOperationException("No GolfMap VSP system in the active scene.");
            var state=new Baseline {scene=scene.path, ambientMode=(int)RenderSettings.ambientMode,
                intensity=RenderSettings.ambientIntensity, sky=RenderSettings.ambientSkyColor,
                equator=RenderSettings.ambientEquatorColor, ground=RenderSettings.ambientGroundColor,
                flat=RenderSettings.ambientLight};
            state.leaves=new[]{"Oak Leaves", "Birch Leaves"}.Select(name=>{
                var path=Folder+name+".mat";
                var m=AssetDatabase.LoadAssetAtPath<Material>(path);
                if(!m || !m.HasProperty("_HealthyColor") || !m.HasProperty("_DryColor") || !m.HasProperty("_BumpMap"))
                    throw new InvalidOperationException("Missing compatible leaf material: "+path);
                if(m.shader.name!="NatureManufacture Shaders/Trees/Tree Leaves Metalic"
                    && m.shader.name!="NatureManufacture Shaders/Trees/Tree_Leaves_Specular")
                    throw new InvalidOperationException("Unsupported leaf shader: "+m.shader.name);
                var normal=m.GetTexture("_BumpMap");
                string normalGuid=normal?AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(normal)):"";
                if(normal && string.IsNullOrEmpty(normalGuid)) throw new InvalidOperationException("Normal map must be a saved asset.");
                return new Leaf {guid=AssetDatabase.AssetPathToGUID(path), normalGuid=normalGuid,
                    healthy=m.GetColor("_HealthyColor"), dry=m.GetColor("_DryColor")};
            }).ToArray();
            foreach(var catalog in systems.SelectMany(s=>s.VegetationPackageProList).Where(GolfMapTreePlanter.IsImportedCatalogue).Distinct())
                foreach(var item in catalog.VegetationInfoList) {
                    if(item.ShaderControllerSettings==null) continue;
                    foreach(var p in item.ShaderControllerSettings.ControlerPropertyList)
                        if(p.PropertyName=="HealtyColor" || p.PropertyName=="DryColor")
                            state.tints.Add(new Tint {catalogGuid=AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(catalog)),
                                itemId=item.VegetationItemID, property=p.PropertyName, color=p.ColorValue});
                }
            File.WriteAllText(Recovery,JsonUtility.ToJson(state,true));
            baseline=state;
        }
        void RestoreValues()
        {
            if(SceneManager.GetActiveScene().path!=baseline.scene)
                throw new InvalidOperationException("Open baseline scene before restoring: "+baseline.scene);
            foreach(var leaf in baseline.leaves) {
                var m=MaterialFor(leaf);
                var normal=string.IsNullOrEmpty(leaf.normalGuid)?null:
                    AssetDatabase.LoadAssetAtPath<Texture>(AssetDatabase.GUIDToAssetPath(leaf.normalGuid));
                if(!string.IsNullOrEmpty(leaf.normalGuid) && !normal) throw new InvalidOperationException("Baseline normal texture is missing.");
                m.SetTexture("_BumpMap",normal);
                m.SetColor("_HealthyColor",leaf.healthy); m.SetColor("_DryColor",leaf.dry);
            }
            foreach(var tint in baseline.tints) {
                var catalog=AssetDatabase.LoadAssetAtPath<VegetationPackagePro>(AssetDatabase.GUIDToAssetPath(tint.catalogGuid));
                var item=catalog?catalog.VegetationInfoList.FirstOrDefault(i=>i.VegetationItemID==tint.itemId):null;
                if(item==null || item.ShaderControllerSettings==null) throw new InvalidOperationException("Baseline catalogue item is missing.");
                var property=item.ShaderControllerSettings.ControlerPropertyList.FirstOrDefault(p=>p.PropertyName==tint.property);
                if(property==null) throw new InvalidOperationException("Baseline colour property is missing.");
                property.ColorValue=tint.color;
            }
            RenderSettings.ambientMode=(AmbientMode)baseline.ambientMode;
            RenderSettings.ambientIntensity=baseline.intensity;
            RenderSettings.ambientSkyColor=baseline.sky; RenderSettings.ambientEquatorColor=baseline.equator;
            RenderSettings.ambientGroundColor=baseline.ground; RenderSettings.ambientLight=baseline.flat;
        }
        void Refresh()
        {
            // Do not call the normal refresh menu: it saves assets and synchronises
            // unrelated materials. Tests touch no planting/storage APIs or billboards.
            foreach(var system in Systems()) { system.RefreshVegetationSystem(); system.ClearCache(); }
            DynamicGI.UpdateEnvironment();
            SceneView.RepaintAll();
            UnityEditorInternal.InternalEditorUtility.RepaintAllViews();
        }
        void Finish()
        {
            RestoreValues(); Refresh();
            File.Delete(Recovery); baseline=null; current="Baseline";
            message="Baseline restored. Test session ended.";
        }
        void Test(string name, Action change)
        {
            if(baseline==null) Capture();
            RestoreValues();
            try { change(); Refresh(); current=name; }
            catch { RestoreValues(); Refresh(); throw; }
        }
        void Normal(int species)
        {
            if(!neutral) {
                // Unity 2018 UnpackNormal and UnpackScaleNormal multiply R by A
                // before decoding XY. (.5,.5,1,1) is neutral in that and RGB mode.
                neutral=new Texture2D(2,2,TextureFormat.RGBA32,false,true);
                neutral.name="GolfMap neutral normal preview"; neutral.hideFlags=HideFlags.HideAndDontSave;
                neutral.SetPixels(Enumerable.Repeat(new Color(.5f,.5f,1,1),4).ToArray()); neutral.Apply();
            }
            MaterialFor(baseline.leaves[species]).SetTexture("_BumpMap",neutral);
            message="Look for reduced fine speckling. Mesh normals, leaf shapes and albedo remain unchanged.";
        }
        void Colour(int species, Color? probe = null)
        {
            var m=MaterialFor(baseline.leaves[species]);
            foreach(var key in new[]{"_HealthyColor","_DryColor"}) {
                var c=m.GetColor(key);
                if(probe.HasValue) c=probe.Value;
                else if(species==0) {
                    float gray=.2126f*c.r+.7152f*c.g+.0722f*c.b;
                    c=Color.Lerp(c,new Color(gray,gray,gray,c.a),.2f);
                } else {
                    float old=.2126f*c.r+.7152f*c.g+.0722f*c.b;
                    c=new Color(c.r*.95f,c.g*1.05f,c.b*.95f,c.a);
                    float scale=old/Mathf.Max(.0001f,.2126f*c.r+.7152f*c.g+.0722f*c.b);
                    c=new Color(c.r*scale,c.g*scale,c.b*scale,c.a);
                }
                m.SetColor(key,c);
            }
            // Match only items actually using this material; retain unrelated overrides.
            int matched=0, updated=0;
            var names=new List<string>();
            foreach(var catalog in Systems().SelectMany(s=>s.VegetationPackageProList).Where(GolfMapTreePlanter.IsImportedCatalogue).Distinct())
                foreach(var item in catalog.VegetationInfoList) {
                    if(!item.VegetationPrefab || item.ShaderControllerSettings==null) continue;
                    bool uses=item.VegetationPrefab.GetComponentsInChildren<Renderer>(true).Any(r=>r.sharedMaterials.Contains(m));
                    if(!uses) continue;
                    matched++;
                    names.Add(item.VegetationPrefab.name);
                    foreach(var p in item.ShaderControllerSettings.ControlerPropertyList) {
                        if(p.PropertyName=="HealtyColor") { p.ColorValue=m.GetColor("_HealthyColor"); updated++; }
                        if(p.PropertyName=="DryColor") { p.ColorValue=m.GetColor("_DryColor"); updated++; }
                    }
                }
            if(matched==0 || updated==0)
                throw new InvalidOperationException("No matching VSP colour overrides for "+m.name+". This material is not reaching a supported catalogue item in the active scene.");
            string details=matched+" catalogue item(s), "+updated+" colour overrides; not a visible-instance count.";
            if(probe.HasValue) {
                message=(probe.Value==Color.red
                    ? "Leaves using this material should turn red. If they stay green, stop colour tuning: investigate the actual LOD/material, billboard or VSP cache."
                    : "Leaf albedo is black. On the fixed oak, leaves should be nearly black. Remaining brightness can reveal other materials or lighting terms; birch still has specular. Trunks remain unchanged.")
                    +"\n"+details;
            } else message="Exploratory tint only. Compare both angles; this is not an accepted colour correction.\n"+details;
            Debug.Log("[GolfMap tree test] "+m.name+" | "+m.shader.name+" | "+details+" Prefabs: "+string.Join(", ",names.Distinct().ToArray()));
        }
        void Ambient()
        {
            if(RenderSettings.ambientMode==AmbientMode.Skybox) RenderSettings.ambientIntensity=baseline.intensity*1.3f;
            else {
                RenderSettings.ambientSkyColor=baseline.sky*1.3f;
                RenderSettings.ambientEquatorColor=baseline.equator*1.3f;
                RenderSettings.ambientGroundColor=baseline.ground*1.3f;
                RenderSettings.ambientLight=baseline.flat*1.3f;
            }
            message="Ambient fill +30%; sun unchanged. Look for readable shadows versus flatter crowns. Baked lighting may not respond; zero ambient stays zero.";
        }
        void Run(Action action)
        {
            try { action(); } catch(Exception e) { message=e.Message; Debug.LogException(e); }
            Repaint();
        }
        void Button(string label, Action change)
        { if(GUILayout.Button(label)) Run(()=>Test(label,change)); }
        void OnGUI()
        {
            scroll=EditorGUILayout.BeginScrollView(scroll);
            EditorGUILayout.HelpBox("Each button starts from the same baseline. Keep the camera and sun fixed; enable Scene Lighting. Tests affect shared oak/birch mesh materials, not baked billboards.",MessageType.Info);
            EditorGUILayout.LabelField("Current test",current);
            EditorGUILayout.HelpBox("Preview session: do not save/export or edit materials and lighting while testing. Closing this window restores baseline. A recovery file is kept in Library until restoration succeeds.",MessageType.Info);
            EditorGUI.BeginDisabledGroup(EditorApplication.isPlayingOrWillChangePlaymode);
            Button("Baseline",()=>{message="Original material, catalogue colours and ambient lighting.";});
            Button("Ambient fill +30%",Ambient);
            EditorGUILayout.LabelField("Verify the material first",EditorStyles.boldLabel);
            Button("Oak — RED material probe",()=>Colour(0,Color.red));
            Button("Birch — RED material probe",()=>Colour(1,Color.red));
            Button("Oak — BLACK albedo probe",()=>Colour(0,Color.black));
            Button("Birch — BLACK albedo probe",()=>Colour(1,Color.black));
            EditorGUILayout.LabelField("Appearance comparisons",EditorStyles.boldLabel);
            Button("Oak — neutral leaf normals",()=>Normal(0));
            Button("Birch — neutral leaf normals",()=>Normal(1));
            Button("Oak — tint saturation -20%",()=>Colour(0));
            Button("Birch — greener tint",()=>Colour(1));
            EditorGUI.BeginDisabledGroup(baseline==null);
            if(GUILayout.Button("Restore baseline and end tests")) Run(()=>Finish());
            EditorGUI.EndDisabledGroup(); EditorGUI.EndDisabledGroup();
            if(!string.IsNullOrEmpty(message)) EditorGUILayout.HelpBox(message,MessageType.Info);
            EditorGUILayout.EndScrollView();
        }
    }
}
