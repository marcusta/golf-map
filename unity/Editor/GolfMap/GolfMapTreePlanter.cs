// Plants trees from a golf-map "unity-trees-v1" file onto a Unity Terrain.
// See unity/README.md for the file format.
//
// The settings live on a GolfMapTrees component (Runtime/GolfMap/GolfMapTrees.cs,
// one scene object per terrain); GolfMap > Tree Planter selects or creates one.
// This class is the editor-only logic behind that component's Inspector
// (GolfMapTreesInspector.cs): a hidden ScriptableObject per component that
// outlives Inspector instances, so loaded surveys, biome matches and a running
// tree-editor session survive selecting something else and coming back.
//
// Two placement modes:
//   TerrainInstances: TreeInstance entries on the terrain (batched, LOD,
//                     billboards). Prefabs must be terrain-tree compatible.
//   GameObjects:      one prefab instance per tree under a parent object.
//
// Coordinates: tree x/z are metres from the plot's south-west corner. The
// terrain is assumed to sit at that corner with x = east and z = north, which
// is what the OPCD heightmap import gives when "Flip Vertically" is ticked.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using Mode = GolfMap.GolfMapTrees.Mode;

namespace GolfMap.Editor
{
    [Serializable]
    public class GolfMapTreeFile
    {
        public string format;
        public GolfMapTreePlot plot;
        public List<GolfMapTree> trees;
    }

    [Serializable]
    public class GolfMapTreePlot
    {
        public string crs;
        public string terrain;   // "inner" | "outer" (outer trees are far away: billboards)
        public double originX;
        public double originY;
        public float sizeM;
        public float minM;
        public float maxM;
    }

    [Serializable]
    public class GolfMapTree
    {
        public float x;      // metres east of plot origin
        public float z;      // metres north of plot origin
        public float h;      // height above ground, metres
        public float r;      // crown radius, metres
        public float g;      // ground elevation, metres (RH2000)
        public int k;        // 0 broadleaf, 1 conifer, 2 unknown
        public bool bush;    // crown wider than 0.35 * height
        public string id;    // optional stable stem id; extensions seed per-stem randomness from it
    }

    // partial: a course project may extend the planter in its own files (e.g. a
    // Vegetation Studio Pro placement mode) without touching this one.
    public partial class GolfMapTreePlanter : ScriptableObject
    {
        // PersistentStorage is implemented in GolfMapTreePlanterVsp.cs.
        // Missing backends are reported explicitly before planting.
        [SerializeField] GolfMapTrees component;   // the scene component whose settings this planter edits
        GolfMapTrees T { get { return component; } }
        internal GolfMapTrees Component { get { return component; } }
        internal UnityEditor.Editor inspector;     // the component's open Inspector, if any
        [SerializeField] bool showSetup = true;
        // Extension hooks (C# partial methods: no-ops unless a project-local
        // partial class implements them).
        partial void DrawStorageOptions();
        partial void PlantStorage();
        partial void ClearImported();
        partial void StorageAvailable(ref bool available);
        partial void DrawTreeEditor();
        partial void OnFileReloaded();

        const string kFormat = "unity-trees-v1";
        const string kParentName = "GolfMapTrees";

        string filePath { get { return T.filePath; } set { T.filePath = value; } }
        Terrain terrain { get { return T.terrain; } set { T.terrain = value; } }
        Mode mode { get { return T.mode; } set { T.mode = value; } }
        bool useBiome { get { return T.useBiome; } set { T.useBiome = value; } }
        string biomePath { get { return T.biomePath; } set { T.biomePath = value; } }
        Terrain innerExclusion { get { return T.innerExclusion; } set { T.innerExclusion = value; } }
        bool includeReviewMatches { get { return T.includeReviewMatches; } set { T.includeReviewMatches = value; } }
        GolfMapBiome biome;
        readonly Dictionary<string,GameObject> biomePrefabs = new Dictionary<string,GameObject>();
        readonly Dictionary<GolfMapTree,GolfMapBiomeMatch> biomeMatches = new Dictionary<GolfMapTree,GolfMapBiomeMatch>();
        readonly HashSet<GolfMapTree> woodlandTrees = new HashSet<GolfMapTree>();
        // Manual edits (GolfMapTreeEdits.cs) applied on top of the loaded survey: tree -> its record.
        readonly Dictionary<GolfMapTree,GolfMapTreeEdit> treeEdits = new Dictionary<GolfMapTree,GolfMapTreeEdit>();
        GolfMapTreeEditFile editFile;
        string editsPath = "";
        List<string> editWarnings = new List<string>();
        List<GameObject> broadleafPrefabs { get { return T.broadleafPrefabs; } set { T.broadleafPrefabs = value; } }
        List<GameObject> coniferPrefabs { get { return T.coniferPrefabs; } set { T.coniferPrefabs = value; } }
        List<GameObject> unknownPrefabs { get { return T.unknownPrefabs; } set { T.unknownPrefabs = value; } }
        List<GameObject> bushPrefabs { get { return T.bushPrefabs; } set { T.bushPrefabs = value; } }
        float minScale { get { return T.minScale; } set { T.minScale = value; } }
        float maxScale { get { return T.maxScale; } set { T.maxScale = value; } }
        float minHeightM { get { return T.minHeightM; } set { T.minHeightM = value; } }
        bool scaleWidth { get { return T.scaleWidth; } set { T.scaleWidth = value; } }
        bool clearExisting { get { return T.clearExisting; } set { T.clearExisting = value; } }
        int seed { get { return T.seed; } set { T.seed = value; } }
        float alignmentToleranceM { get { return T.alignmentToleranceM; } set { T.alignmentToleranceM = value; } }
        bool ignoreAlignment { get { return T.ignoreAlignment; } set { T.ignoreAlignment = value; } }
        // Outer-plot trees are always far from the player, so they go in as
        // billboards only: TerrainInstances mode sets the terrain's billboard
        // start distance to its minimum; the VSP partial reads this too.
        bool forceBillboards { get { return T.forceBillboards; } set { T.forceBillboards = value; } }
        GolfMapTreeFile loaded;
        string loadedPath;
        string status = "";
        SerializedObject soCache;
        SerializedObject so { get { if (soCache == null || soCache.targetObject != component) soCache = new SerializedObject(component); return soCache; } }

        // ---- component binding ---------------------------------------------

        // The planter for a component: reused across Inspector instances and domain reloads.
        public static GolfMapTreePlanter For(GolfMapTrees target)
        {
            foreach (var p in Resources.FindObjectsOfTypeAll<GolfMapTreePlanter>()) if (p && p.component == target) return p;
            var planter = CreateInstance<GolfMapTreePlanter>();
            planter.hideFlags = HideFlags.HideAndDontSave;
            planter.component = target;
            return planter;
        }

        // Selects the GolfMap Trees object to work with: the selected one, else the first in the
        // scene, else a new one. Returns its planter.
        [MenuItem("GolfMap/Tree Planter")]
        public static void Open() { Select(); }
        public static GolfMapTreePlanter Select()
        {
            var target = Selection.activeGameObject ? Selection.activeGameObject.GetComponent<GolfMapTrees>() : null;
            if (!target) target = FindObjectsOfType<GolfMapTrees>().OrderBy(c => c.name).FirstOrDefault();
            if (!target)
            {
                var go = new GameObject("GolfMap Trees");
                Undo.RegisterCreatedObjectUndo(go, "Create GolfMap Trees");
                target = go.AddComponent<GolfMapTrees>();
            }
            Selection.activeGameObject = target.gameObject;
            EditorGUIUtility.PingObject(target.gameObject);
            return For(target);
        }

        void Repaint() { if (inspector) inspector.Repaint(); }

        // Settings changed from code (presets, auto-detected billboards): make the scene save them.
        void Dirty()
        {
            if (!component) return;
            EditorUtility.SetDirty(component);
            if (component.gameObject.scene.IsValid()) UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(component.gameObject.scene);
        }

        // ---- Inspector -----------------------------------------------------

        internal void OnGUI()
        {
            if (!component) return;
            so.Update();
            Undo.RecordObject(component, "GolfMap Trees settings");
            EditorGUI.BeginChangeCheck();

            showSetup = EditorGUILayout.Foldout(showSetup, "Setup", true);
            if (showSetup) DrawSetup();
            DrawActions();
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.Info);

            DrawTreeEditor();

            if (EditorGUI.EndChangeCheck()) Dirty();
            so.ApplyModifiedProperties();
        }

        void DrawSetup()
        {
            EditorGUILayout.LabelField("Input", EditorStyles.boldLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                filePath = EditorGUILayout.TextField("Trees file", filePath);
                if (GUILayout.Button("...", GUILayout.Width(30)))
                {
                    var picked = EditorUtility.OpenFilePanel("unity-trees-v1 JSON", string.IsNullOrEmpty(filePath) ? "" : Path.GetDirectoryName(filePath), "json");
                    if (!string.IsNullOrEmpty(picked)) { filePath = picked; loaded = null; }
                }
            }
            terrain = (Terrain)EditorGUILayout.ObjectField("Terrain", terrain, typeof(Terrain), true);
            if (terrain == null && Terrain.activeTerrain != null && GUILayout.Button("Use active terrain")) terrain = Terrain.activeTerrain;

            EditorGUILayout.Space();
            useBiome = EditorGUILayout.Toggle("Use biome palette", useBiome);
            if(useBiome){
                biomePath=EditorGUILayout.TextField("Biome JSON",biomePath);
                if(GUILayout.Button("Choose biome JSON")) { var p=EditorUtility.OpenFilePanel("Biome palette", "", "json");if(p.Length>0)biomePath=p; }
                includeReviewMatches=EditorGUILayout.Toggle("Include imperfect/unknown fits",includeReviewMatches);
                EditorGUILayout.HelpBox("Reads the selected prefab list, species weights and uniform size limits. Colours come from the biome's prepared prefab materials across all LODs. Load and check previews matches without planting.",MessageType.Info);
            }
            EditorGUILayout.Space();
            if(!useBiome){
            EditorGUILayout.LabelField("Prefabs by crown kind", EditorStyles.boldLabel);
            EditorGUILayout.PropertyField(so.FindProperty("broadleafPrefabs"), true);
            EditorGUILayout.PropertyField(so.FindProperty("coniferPrefabs"), true);
            EditorGUILayout.PropertyField(so.FindProperty("unknownPrefabs"), new GUIContent("Unknown kind prefabs"), true);
            EditorGUILayout.PropertyField(so.FindProperty("bushPrefabs"), true);
            EditorGUILayout.HelpBox("Unknown kind falls back to the broadleaf list when empty. Bushes fall back to the kind list.", MessageType.None);
            }

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Placement", EditorStyles.boldLabel);
            mode = (Mode)EditorGUILayout.EnumPopup("Mode", mode);
            if(!useBiome){
            minScale = EditorGUILayout.FloatField("Min scale", minScale);
            maxScale = EditorGUILayout.FloatField("Max scale", maxScale);
            scaleWidth = EditorGUILayout.Toggle("Scale width from crown radius", scaleWidth);
            seed = EditorGUILayout.IntField("Seed", seed);
            } else EditorGUILayout.HelpBox("Prefab selection, species weights, scale limits and random seed come from the biome JSON.",MessageType.None);
            minHeightM = EditorGUILayout.FloatField("Skip trees under (m)", minHeightM);
            clearExisting = EditorGUILayout.Toggle("Clear existing trees first", clearExisting);
            alignmentToleranceM = EditorGUILayout.FloatField("Alignment tolerance (m)", alignmentToleranceM);
            ignoreAlignment = EditorGUILayout.Toggle("Plant even if misaligned", ignoreAlignment);
            forceBillboards = EditorGUILayout.Toggle("Billboards only (outer plot)", forceBillboards);
            if(forceBillboards)innerExclusion=(Terrain)EditorGUILayout.ObjectField("Inner terrain to exclude",innerExclusion,typeof(Terrain),true);
            DrawStorageOptions();
        }

        void DrawActions()
        {
            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Load and check")) { try { LoadFile(); if (loaded != null) { ValidateTarget(); status = AlignmentReport()+PrepareBiome()+EditsReport(); } } catch(Exception e) {status=e.Message;Debug.LogError("[GolfMap] "+status);} }
                using (new EditorGUI.DisabledScope(terrain == null || string.IsNullOrEmpty(filePath)))
                    if (GUILayout.Button("Plant")) Plant();
                if (mode == Mode.PersistentStorage && GUILayout.Button("Clear imported")) ClearImported();
            }
        }

        // ---- loading -------------------------------------------------------

        void LoadFile()
        {
            loaded = null;
            OnFileReloaded();
            try
            {
                var text = File.ReadAllText(filePath);
                var file = JsonUtility.FromJson<GolfMapTreeFile>(text);
                if (file == null || file.format != kFormat) throw new Exception($"format must be {kFormat}");
                if (file.plot == null || file.plot.sizeM <= 0) throw new Exception("plot.sizeM missing");
                if (file.trees == null) throw new Exception("trees missing");
                foreach (var t in file.trees)
                {
                    if (t==null || !ValidNumber(t.x)||!ValidNumber(t.z)||!ValidNumber(t.g)||!ValidNumber(t.h)||!ValidNumber(t.r)||t.h <= 0 || t.r <= 0||t.k<0||t.k>2) throw new Exception("Invalid tree coordinates, height, radius or kind");
                    if(string.IsNullOrEmpty(t.id))t.id=t.x.ToString("R",System.Globalization.CultureInfo.InvariantCulture)+":"+t.z.ToString("R",System.Globalization.CultureInfo.InvariantCulture);
                }
                // Manual edits overlay the survey before anything looks at the trees.
                treeEdits.Clear();
                editsPath = GolfMapTreeEdits.PathFor(filePath);
                editFile = GolfMapTreeEdits.Load(editsPath);
                editWarnings = GolfMapTreeEdits.Apply(file.trees, editFile.edits, treeEdits);
                foreach (var w in editWarnings) Debug.LogWarning("[GolfMap] " + w);
                loaded = file;
                loadedPath = filePath;
                // An outer-plot file switches billboards on; the toggle stays editable.
                if (file.plot.terrain == "outer" || file.plot.terrain == "inner") { forceBillboards = file.plot.terrain == "outer"; Dirty(); }
            }
            catch (Exception e)
            {
                status = $"Load failed: {e.Message}";
                Debug.LogError($"[GolfMap] {status}");
            }
        }

        string EditsReport()
        {
            if (editFile == null || editFile.edits.Count == 0) return "";
            int modified = 0, deleted = 0, added = 0;
            foreach (var e in editFile.edits) { if (e.op == "delete") deleted++; else if (e.op == "add") added++; else modified++; }
            var text = "\nManual edits: " + modified + " changed, " + deleted + " deleted, " + added + " added (" + Path.GetFileName(editsPath) + ").";
            if (editWarnings.Count > 0) text += "\nWARNING " + editWarnings.Count + " edit(s) match no survey tree: " + editWarnings[0];
            return text;
        }

        // Biome match for one stem, honouring a manual species/asset/rotation override.
        GolfMapBiomeMatch MatchTree(GolfMapTree t, bool woodland)
        {
            GolfMapTreeEdit edit; treeEdits.TryGetValue(t, out edit);
            var source = biome; int kind = t.k;
            if (edit != null && (!string.IsNullOrEmpty(edit.species) || !string.IsNullOrEmpty(edit.guid)))
            {
                var assets = biome.assets.Where(a => a.enabled && (string.IsNullOrEmpty(edit.guid) ? a.species == edit.species : a.guid == edit.guid)).ToList();
                if (assets.Count == 0) throw new Exception("No enabled biome asset for species '" + edit.species + "' / asset '" + edit.guid + "' (tree " + t.id + ").");
                source = new GolfMapBiome { format = biome.format, seed = biome.seed, rules = biome.rules, assets = assets };
                kind = assets.All(a => a.kind == "conifer") ? 1 : assets.All(a => a.kind == "broadleaf") ? 0 : 2;
            }
            var m = GolfMapBiomeMatcher.Match(source, t.id, t.h, t.r, kind, woodland);
            if (m != null && edit != null && edit.rotationSet) m.rotation = edit.rotation;
            if (m != null && edit != null)
            {
                // A hand-edited stem must follow its height and crown radius exactly, so
                // the palette's scale clamp (meant for automatic best-fit picks) is lifted
                // and width gets its own axis. Outer billboards can only scale uniformly.
                m.scale = t.h / m.asset.heightM;
                m.widthScale = forceBillboards ? 0 : 2 * t.r / m.asset.crownWidthM;
                m.heightError = 0;
                m.widthError = m.widthScale > 0 ? 0 : Math.Abs(Math.Log(m.asset.crownWidthM * m.scale / (2 * t.r)));
            }
            return m;
        }

        string AlignmentReport()
        {
            if (terrain == null) return $"Loaded {loaded.trees.Count} trees. Assign a terrain to check alignment.";
            var data = terrain.terrainData;
            var size = data.size;
            var sizeNote = Mathf.Abs(size.x - loaded.plot.sizeM) > 0.5f || Mathf.Abs(size.z - loaded.plot.sizeM) > 0.5f
                ? $"\nWARNING terrain size {size.x:0}x{size.z:0} m differs from plot size {loaded.plot.sizeM:0} m."
                : "";
            var heightNote = Mathf.Abs(size.y - (loaded.plot.maxM - loaded.plot.minM)) > 0.5f
                ? $"\nWARNING terrain height {size.y:0.0} m differs from plot range {loaded.plot.maxM - loaded.plot.minM:0.0} m."
                : "";
            int checkedCount = 0, off = 0;
            float maxDiff = 0, sumDiff = 0;
            foreach (var t in loaded.trees)
            {
                if (!InsidePlot(t)) continue;
                float expected = t.g - loaded.plot.minM;
                float actual = terrain.SampleHeight(WorldPos(t));
                float diff = Mathf.Abs(expected - actual);
                checkedCount++;
                sumDiff += diff;
                if (diff > maxDiff) maxDiff = diff;
                if (diff > alignmentToleranceM) off++;
            }
            float mean = checkedCount > 0 ? sumDiff / checkedCount : 0;
            var verdict = off == 0 ? "Alignment OK." : $"MISALIGNED: {off} of {checkedCount} trees off by more than {alignmentToleranceM} m.";
            return $"Loaded {loaded.trees.Count} trees, {checkedCount} inside the terrain. Ground mismatch mean {mean:0.00} m, max {maxDiff:0.00} m. {verdict}{sizeNote}{heightNote}";
        }

        bool InsidePlot(GolfMapTree t)
        {
            var size = terrain.terrainData.size;
            if(!(t.x >= 0 && t.z >= 0 && t.x < size.x && t.z < size.z))return false;
            if(forceBillboards && innerExclusion){var p=WorldPos(t)-innerExclusion.transform.position;var s=innerExclusion.terrainData.size;if(p.x>=0&&p.z>=0&&p.x<=s.x&&p.z<=s.z)return false;}
            return true;
        }

        static bool ValidNumber(float v) {return !float.IsNaN(v)&&!float.IsInfinity(v);}
        void ValidateTarget()
        {
            if(!terrain||!terrain.terrainData)throw new Exception("Choose the target terrain.");
            if(terrain.transform.rotation!=Quaternion.identity||terrain.transform.lossyScale!=Vector3.one)throw new Exception("Terrain must use identity rotation and unit scale.");
            if(Mathf.Abs(terrain.terrainData.size.x-loaded.plot.sizeM)>.5f||Mathf.Abs(terrain.terrainData.size.z-loaded.plot.sizeM)>.5f)throw new Exception("Tree plot size does not match target terrain.");
            if(loaded.plot.terrain=="outer")forceBillboards=true;
            if(forceBillboards && (!innerExclusion||innerExclusion==terrain||innerExclusion.gameObject.scene!=terrain.gameObject.scene))throw new Exception("Outer planting requires a different inner terrain in the same scene to exclude.");
            if(forceBillboards && mode!=Mode.PersistentStorage)throw new Exception("Use PersistentStorage for guaranteed billboard-only outer planting with this biome.");
            if(!ValidNumber(minScale)||!ValidNumber(maxScale)||minScale<=0||maxScale<minScale)throw new Exception("Invalid scale limits.");
        }
        string PrepareBiome()
        {
            biomeMatches.Clear();biomePrefabs.Clear();woodlandTrees.Clear();biome=null;
            if(!useBiome)return "";
            biome=JsonUtility.FromJson<GolfMapBiome>(File.ReadAllText(biomePath).TrimStart('\uFEFF'));
            if(biome==null||biome.format!="golfmap-tree-palette-v1"||biome.rules==null||biome.assets==null||biome.assets.Count==0)throw new Exception("Invalid biome palette.");
            var rules=biome.rules;
            if(!(rules.minScale>0&&rules.maxScale>=rules.minScale&&rules.variationBand>=0&&rules.speciesFitSlack>=0&&rules.maxHeightError>=0&&rules.maxWidthError>=0))throw new Exception("Invalid biome rules.");
            var renderIssues=new List<string>();var shaderIssues=new List<string>();
            foreach(var a in biome.assets){
                if(!a.enabled)continue;
                if(!(a.heightM>0&&a.crownWidthM>0)||double.IsInfinity(a.heightM)||double.IsInfinity(a.crownWidthM))throw new Exception("Invalid dimensions: "+a.name);
                var actual=AssetDatabase.GUIDToAssetPath(a.guid);
                if(actual!=a.path)throw new Exception("Biome asset missing or moved: "+a.name+". Expected "+a.path);
                var prefab=AssetDatabase.LoadAssetAtPath<GameObject>(actual);
                if(!prefab)throw new Exception("Cannot load biome prefab "+a.name);
                int meshRenderers=0;
                foreach(var renderer in prefab.GetComponentsInChildren<Renderer>(true)){
                    // VSP renders mesh LODs and generates its own billboard atlas.
                    // These packages contain unused BillboardRenderers with null slots.
                    if(mode==Mode.PersistentStorage && renderer is BillboardRenderer)continue;
                    meshRenderers++;
                    var slots=renderer.sharedMaterials;
                    for(int slot=0;slot<slots.Length;slot++){
                        var material=slots[slot];
                        string location=a.name+" / "+renderer.name+" / material slot "+slot;
                        if(!material)throw new Exception("Missing material: "+location);
                        if(!material.shader||!material.shader.isSupported)throw new Exception("Unsupported shader: "+location+" ("+material.name+")");
                        if(mode==Mode.PersistentStorage&&!VspKnowsShader(material.shader.name))shaderIssues.Add(location+" ("+material.name+") uses '"+material.shader.name+"'");
                    }
                }
                if(meshRenderers==0)throw new Exception("No usable mesh renderers: "+a.name);
                if(mode==Mode.PersistentStorage){var issue=VspRenderIssue(a,prefab);if(issue!=null)renderIssues.Add(issue);}
                biomePrefabs.Add(a.guid,prefab);
            }
            if(renderIssues.Count>0)throw new Exception("Palette assets VSP cannot draw faithfully (use VS_/baked variants):\n"+string.Join("\n",renderIssues.ToArray()));
            if(shaderIssues.Count>0)throw new Exception("Shader names GSPro's Vegetation Studio build cannot resolve a controller for. It has no DefaultShaderController fallback: one of these null-refs in VegetationItemModelInfo.SetShaderControllers and stops every tree in the package from loading, silently. Use a stock shader name (NatureManufacture Shaders/Trees/Tree {Bark,Leaves} {Metalic,Specular}, CTI/LOD {Bark,Leaves,Bark Array}, Nature/SpeedTree) and drive colour through the item's shader-controller settings instead:\n"+string.Join("\n",shaderIssues.ToArray()));
            minScale=(float)rules.minScale;maxScale=(float)rules.maxScale;scaleWidth=false;
            int matched=0,review=0,unmatched=0,woodlandCount=0;var ids=new HashSet<string>();
            var grid=new Dictionary<string,List<GolfMapTree>>();
            double cell=rules.woodlandRadiusM;
            if(cell>0&&rules.woodlandMinNeighbours>0)foreach(var stem in loaded.trees){
                if(stem.h<=rules.shrubMaxHeightM||!InsidePlot(stem)||stem.h<minHeightM)continue;
                string key=Math.Floor(stem.x/cell)+":"+Math.Floor(stem.z/cell);
                if(!grid.ContainsKey(key))grid[key]=new List<GolfMapTree>();grid[key].Add(stem);
            }
            foreach(var t in loaded.trees){
                if(!InsidePlot(t)||t.h<minHeightM)continue;
                if(!ids.Add(t.id))throw new Exception("Duplicate stem ID/coordinate: "+t.id);
                int neighbours=0;
                if(grid.Count>0&&t.h>rules.shrubMaxHeightM){
                    double gx=Math.Floor(t.x/cell),gz=Math.Floor(t.z/cell);
                    for(int dx=-1;dx<=1;dx++)for(int dz=-1;dz<=1;dz++){
                        List<GolfMapTree> bucket;if(!grid.TryGetValue((gx+dx)+":"+(gz+dz),out bucket))continue;
                        foreach(var other in bucket){double x=(double)other.x-t.x,z=(double)other.z-t.z;if(other!=t&&x*x+z*z<=cell*cell)neighbours++;}
                    }
                }
                bool woodland=grid.Count>0&&neighbours>=rules.woodlandMinNeighbours;
                if(woodland){woodlandCount++;woodlandTrees.Add(t);}
                var m=MatchTree(t,woodland);
                if(m==null){unmatched++;continue;}if(m.review)review++;
                if(!m.review||includeReviewMatches){biomeMatches.Add(t,m);matched++;}
            }
            var speciesCounts=new Dictionary<string,int>();foreach(var m in biomeMatches.Values){string label=string.IsNullOrEmpty(m.asset.species)?m.asset.kind:m.asset.species;if(!speciesCounts.ContainsKey(label))speciesCounts[label]=0;speciesCounts[label]++;}
            var mix="";foreach(var pair in speciesCounts)mix+=pair.Key+" "+pair.Value+"; ";
            return "\nBiome: "+matched+" eligible, "+review+" imperfect/unknown fits, "+unmatched+" unmatched (skipped). "+woodlandCount+" woodland stems use canopy matching. Uniform scale "+minScale+"–"+maxScale+". Uses prepared material colours.\n"+mix;
        }

        // VSP picks a shader controller by *exact* shader name (ShaderSelector, matched against
        // the hard-coded lists in NMTreeShaderControler/CTIShaderController/Speedtree/...). The
        // Asset Store build in this project ends GetShaderControler with `return new
        // DefaultShaderController()`, so an unrecognised name is completely invisible in the
        // editor. GSPro ships a forked VSP runtime - it has SetShaderControllers(GameObject
        // _sourceLOD0), Arb_* controllers and useShaderControllerOverrides, none of which exist
        // here - and that lookup has no such fallback: an unknown shader throws a
        // NullReferenceException out of the VegetationItemModelInfo constructor, which aborts
        // SetupVegetationItemModels for the whole package. One renamed shader therefore stops
        // every tree in that system from loading, with nothing said in the Unity console.
        // Renaming a copied NM/CTI shader is enough to trigger it.
        // GSPro's VSP is newer than this project's and knows a few names the local controllers do
        // not. Read out of its shipped AwesomeTechnologies.VegetationStudioPro.Runtime.dll, so the
        // check does not reject what the course will actually render - the palette's pines use
        // Cross Model Shader, which only the GSPro side lists.
        static readonly string[] GsproExtraShaders=
        {
            "NatureManufacture Shaders/Trees/Cross Model Shader",
            "NatureManufacture Shaders/Trees/Cross Model Shader Snow",
            "NatureManufacture Shaders/Trees/Tree_Leaves_Metalic",
            "NatureManufacture Shaders/Trees/Tree Bark Metalic Snow",
            "NatureManufacture Shaders/Trees/Tree Bark Specular Snow",
            "NatureManufacture Shaders/Trees/Tree Leaves Metalic Snow",
            "NatureManufacture Shaders/Trees/Tree Leaves Specular Snow",
            "SyntyStudios/Trees",
        };
        static readonly Dictionary<string,bool> KnownShaders=new Dictionary<string,bool>();
        static bool VspKnowsShader(string shaderName)
        {
            bool known;
            if(KnownShaders.TryGetValue(shaderName,out known))return known;
            known=GsproExtraShaders.Contains(shaderName)||
                !(AwesomeTechnologies.Shaders.ShaderSelector.GetShaderControler(shaderName) is AwesomeTechnologies.Shaders.DefaultShaderController);
            KnownShaders[shaderName]=known;
            return known;
        }

        // VSP draws one mesh per LOD (the LOD's first renderer) with the instance
        // transform in place of the prefab root: extra renderers vanish and any
        // transform on the mesh object below the root is dropped. NM's "High
        // Quality" poplars (leaves + trunk per LOD, leaf mesh tilted -90 X)
        // rendered as flat blobs. The root's own transform never matters.
        static string VspRenderIssue(GolfMapBiomeAsset a,GameObject prefab)
        {
            var root=prefab.transform;
            var group=prefab.GetComponentInChildren<LODGroup>(true);
            if(!group)return null;
            var lods=group.GetLODs();
            for(int i=0;i<lods.Length;i++){
                var renderers=lods[i].renderers.Where(r=>r&&!(r is BillboardRenderer)).ToArray();
                if(renderers.Length==0)continue;
                if(renderers.Length>1)return a.name+" LOD"+i+" has "+renderers.Length+" renderers ("+string.Join(", ",renderers.Select(r=>r.name).ToArray())+"); VSP draws only the first.";
                var t=renderers[0].transform;
                var local=root.worldToLocalMatrix*t.localToWorldMatrix;
                var p=local.GetColumn(3);var q=Quaternion.LookRotation(local.GetColumn(2),local.GetColumn(1));
                if(new Vector3(p.x,p.y,p.z).magnitude>0.5f||Quaternion.Angle(q,Quaternion.identity)>1f||(local.lossyScale-Vector3.one).magnitude>0.05f)
                    return a.name+" LOD"+i+" mesh object "+t.name+" is offset/rotated/scaled relative to the root; VSP ignores that.";
            }
            return null;
        }

        Vector3 WorldPos(GolfMapTree t) => terrain.transform.position + new Vector3(t.x, 0, t.z);

        // ---- planting ------------------------------------------------------

        struct Proto
        {
            public GameObject prefab;
            public float heightM;
            public float widthM;
            public int prototypeIndex;
        }

        void Plant()
        {
            LoadFile(); // Always re-read an export changed on disk.
            if (loaded == null) return;
            string biomeReport;
            try { ValidateTarget();biomeReport=PrepareBiome(); } catch(Exception e){status="Not planted: "+e.Message;Debug.LogError("[GolfMap] "+status);return;}
            var report = AlignmentReport();
            if (report.Contains("MISALIGNED") && !ignoreAlignment)
            {
                status = report + "\nNot planted. Fix the plot or tick 'Plant even if misaligned'.";
                return;
            }
            if (!useBiome && Fallback(0).Count == 0 && Fallback(1).Count == 0 && Fallback(2).Count == 0)
            {
                status = "No prefabs assigned.";
                return;
            }

            var protos = new Dictionary<GameObject, Proto>();
            var rng = new System.Random(seed);
            int planted = 0, skipped = 0;

            if(useBiome&&biomeMatches.Count==0){status="No eligible biome matches. Nothing changed.";return;}
            if (mode == Mode.PersistentStorage) {bool available=false;StorageAvailable(ref available);if(!available){status="Install GolfMapTreePlanterVsp.cs for PersistentStorage mode.";return;} PlantStorage();status+=biomeReport; return; }
            if (mode == Mode.TerrainInstances) planted = PlantTerrainInstances(protos, rng, out skipped);
            else planted = PlantGameObjects(protos, rng, out skipped);

            status = $"Planted {planted} trees ({skipped} skipped). {report}"+biomeReport;
            Debug.Log($"[GolfMap] {status}");
        }

        List<GameObject> Fallback(int kind)
        {
            var list = kind == 1 ? coniferPrefabs : kind == 2 ? unknownPrefabs : broadleafPrefabs;
            list = Nonnull(list);
            if (list.Count == 0 && kind == 2) list = Nonnull(broadleafPrefabs);
            if (list.Count == 0 && kind == 2) list = Nonnull(coniferPrefabs);
            return list;
        }

        static List<GameObject> Nonnull(List<GameObject> list)
        {
            var r = new List<GameObject>();
            foreach (var g in list) if (g != null) r.Add(g);
            return r;
        }

        GameObject Pick(GolfMapTree t, System.Random rng)
        {
            if(useBiome){GolfMapBiomeMatch match;return biomeMatches.TryGetValue(t,out match)?biomePrefabs[match.asset.guid]:null;}
            var list = t.bush ? Nonnull(bushPrefabs) : null;
            if (list == null || list.Count == 0) list = Fallback(t.k);
            if (list.Count == 0) return null;
            return list[rng.Next(list.Count)];
        }

        Proto Measure(GameObject prefab, Dictionary<GameObject, Proto> cache)
        {
            if(!prefab)throw new InvalidOperationException("Cannot measure a missing tree asset.");
            Proto p;
            if (cache.TryGetValue(prefab, out p)) return p;
            // Biome fitting already uses validated catalogue dimensions. Do not
            // instantiate assets just to measure them again (2018 prefab APIs
            // can return null for otherwise loadable GameObject/model assets).
            if(useBiome&&biome!=null){
                string assetPath=AssetDatabase.GetAssetPath(prefab);
                foreach(var asset in biome.assets)if(asset.enabled&&asset.path==assetPath){
                    p=new Proto{prefab=prefab,heightM=(float)asset.heightM,widthM=(float)asset.crownWidthM,prototypeIndex=-1};
                    cache[prefab]=p;return p;
                }
                throw new InvalidOperationException("No biome dimensions for "+prefab.name+" ("+assetPath+"). Reload the palette.");
            }
            GameObject temp=null;
            Bounds b = new Bounds(Vector3.zero, Vector3.zero);
            bool any = false;
            try {
                temp=Instantiate(prefab);
                if(!temp)throw new InvalidOperationException("Cannot instantiate tree for measurement: "+AssetDatabase.GetAssetPath(prefab));
                temp.hideFlags = HideFlags.HideAndDontSave;
                temp.transform.position = Vector3.zero;
                temp.transform.rotation = Quaternion.identity;
                temp.transform.localScale = Vector3.one;
                foreach(var r in temp.GetComponentsInChildren<Renderer>()){
                    if(r is BillboardRenderer)continue;
                    if (!any) { b = r.bounds; any = true; } else b.Encapsulate(r.bounds);
                }
            } finally {
                if(temp)DestroyImmediate(temp);
            }
            p = new Proto
            {
                prefab = prefab,
                heightM = any && b.size.y > 0.01f ? b.size.y : 10f,
                widthM = any && Mathf.Max(b.size.x, b.size.z) > 0.01f ? Mathf.Max(b.size.x, b.size.z) : 6f,
                prototypeIndex = -1,
            };
            if (!any) Debug.LogWarning($"[GolfMap] {prefab.name} has no renderers; assuming 10 m tall, 6 m wide.");
            cache[prefab] = p;
            return p;
        }

        float HeightScale(GolfMapTree t, Proto p) => useBiome ? (float)biomeMatches[t].scale : Mathf.Clamp(t.h / p.heightM, minScale, maxScale);
        float WidthScale(GolfMapTree t, Proto p, float hs) => useBiome ? (biomeMatches[t].widthScale > 0 ? (float)biomeMatches[t].widthScale : hs) : scaleWidth ? Mathf.Clamp(2f * t.r / p.widthM, minScale, maxScale) : hs;
        float TreeRotation(GolfMapTree t,System.Random rng) {return useBiome?(float)biomeMatches[t].rotation:(float)(rng.NextDouble()*360);}

        int PlantTerrainInstances(Dictionary<GameObject, Proto> protos, System.Random rng, out int skipped)
        {
            var data = terrain.terrainData;
            Undo.RegisterCompleteObjectUndo(data, "GolfMap plant trees");

            var prototypes = new List<TreePrototype>(clearExisting ? new TreePrototype[0] : data.treePrototypes);
            var instances = new List<TreeInstance>(clearExisting ? new TreeInstance[0] : data.treeInstances);
            var size = data.size;
            skipped = 0;
            int planted = 0;

            foreach (var t in loaded.trees)
            {
                if (t.h < minHeightM || !InsidePlot(t)) { skipped++; continue; }
                var prefab = Pick(t, rng);
                if (prefab == null) { skipped++; continue; }
                var p = Measure(prefab, protos);
                if (p.prototypeIndex < 0)
                {
                    p.prototypeIndex = prototypes.FindIndex(x => x.prefab == prefab);
                    if (p.prototypeIndex < 0)
                    {
                        prototypes.Add(new TreePrototype { prefab = prefab, bendFactor = 0f });
                        p.prototypeIndex = prototypes.Count - 1;
                    }
                    protos[prefab] = p;
                }
                float hs = HeightScale(t, p);
                instances.Add(new TreeInstance
                {
                    position = new Vector3(t.x / size.x, terrain.SampleHeight(WorldPos(t))/size.y, t.z / size.z),
                    prototypeIndex = p.prototypeIndex,
                    heightScale = hs,
                    widthScale = WidthScale(t, p, hs),
                    rotation = TreeRotation(t,rng)*Mathf.Deg2Rad,
                    color = Color.white,
                    lightmapColor = Color.white,
                });
                planted++;
            }

            data.treePrototypes = prototypes.ToArray();
            data.RefreshPrototypes();
            if (forceBillboards)
            {
                Undo.RecordObject(terrain, "GolfMap plant trees");
                terrain.treeBillboardDistance = 0f;  // Unity clamps to its minimum: every tree a billboard
                terrain.treeCrossFadeLength = 0f;
            }
#if UNITY_2019_1_OR_NEWER
            data.SetTreeInstances(instances.ToArray(), true);
#else
            data.treeInstances = instances.ToArray();  // 2018.x: no snap-to-heightmap overload; y is ignored for terrain trees anyway
#endif
            terrain.Flush();
            EditorUtility.SetDirty(data);
            return planted;
        }

        int PlantGameObjects(Dictionary<GameObject, Proto> protos, System.Random rng, out int skipped)
        {
            var existingParent=terrain.transform.Find(kParentName);
            var parent=existingParent?existingParent.gameObject:null;
            if (parent != null && clearExisting)
            {
                Undo.DestroyObjectImmediate(parent);
                parent = null;
            }
            if (parent == null)
            {
                parent = new GameObject(kParentName);
                parent.transform.SetParent(terrain.transform,false);
                Undo.RegisterCreatedObjectUndo(parent, "GolfMap plant trees");
            }
            skipped = 0;
            int planted = 0;
            foreach (var t in loaded.trees)
            {
                if (t.h < minHeightM || !InsidePlot(t)) { skipped++; continue; }
                var prefab = Pick(t, rng);
                if (prefab == null) { skipped++; continue; }
                var p = Measure(prefab, protos);
                var pos = WorldPos(t);
                pos.y = terrain.SampleHeight(pos) + terrain.transform.position.y;
                var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab);  // (prefab, parent) overload is 2018.3+
                go.transform.SetParent(parent.transform, false);
                go.transform.position = pos;
                go.transform.rotation = Quaternion.Euler(0, TreeRotation(t,rng), 0);
                float hs = HeightScale(t, p);
                float ws = WidthScale(t, p, hs);
                go.transform.localScale = new Vector3(ws, hs, ws);
                go.name = $"{prefab.name}_{planted}";
                Undo.RegisterCreatedObjectUndo(go, "GolfMap plant trees");
                planted++;
            }
            return planted;
        }
    }
}
