// Plants trees from a golf-map "unity-trees-v1" file onto a Unity Terrain.
// Menu: GolfMap > Tree Planter. See unity/README.md for the file format.
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
using UnityEditor;
using UnityEngine;

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
    public partial class GolfMapTreePlanter : EditorWindow
    {
        // PersistentStorage is implemented in GolfMapTreePlanterVsp.cs.
        // Missing backends are reported explicitly before planting.
        public enum Mode { TerrainInstances, GameObjects, PersistentStorage }

        // Extension hooks (C# partial methods: no-ops unless a project-local
        // partial class implements them).
        partial void DrawStorageOptions();
        partial void PlantStorage();
        partial void ClearImported();
        partial void StorageAvailable(ref bool available);

        const string kFormat = "unity-trees-v1";
        const string kParentName = "GolfMapTrees";

        [SerializeField] string filePath = "";
        [SerializeField] Terrain terrain;
        [SerializeField] Mode mode = Mode.PersistentStorage;
        [SerializeField] bool useBiome = true;
        [SerializeField] string biomePath = "Assets/GolfMap/Vreta/palette.json";
        [SerializeField] Terrain innerExclusion;
        [SerializeField] bool includeReviewMatches = true;
        GolfMapBiome biome;
        readonly Dictionary<string,GameObject> biomePrefabs = new Dictionary<string,GameObject>();
        readonly Dictionary<GolfMapTree,GolfMapBiomeMatch> biomeMatches = new Dictionary<GolfMapTree,GolfMapBiomeMatch>();
        [SerializeField] List<GameObject> broadleafPrefabs = new List<GameObject>();
        [SerializeField] List<GameObject> coniferPrefabs = new List<GameObject>();
        [SerializeField] List<GameObject> unknownPrefabs = new List<GameObject>();
        [SerializeField] List<GameObject> bushPrefabs = new List<GameObject>();
        [SerializeField] float minScale = 0.5f;
        [SerializeField] float maxScale = 2.0f;
        [SerializeField] float minHeightM = 0f;
        [SerializeField] bool scaleWidth = true;
        [SerializeField] bool clearExisting = false;
        [SerializeField] int seed = 1;
        [SerializeField] float alignmentToleranceM = 1.0f;
        [SerializeField] bool ignoreAlignment = false;
        // Outer-plot trees are always far from the player, so they go in as
        // billboards only: TerrainInstances mode sets the terrain's billboard
        // start distance to its minimum; the VSP partial reads this too.
        [SerializeField] bool forceBillboards = false;

        GolfMapTreeFile loaded;
        string loadedPath;
        string status = "";
        Vector2 scroll;
        SerializedObject so;

        [MenuItem("GolfMap/Tree Planter")]
        public static void Open() => GetWindow<GolfMapTreePlanter>("GolfMap Trees");

        void OnEnable() { so = new SerializedObject(this); }

        void OnGUI()
        {
            so.Update();
            scroll = EditorGUILayout.BeginScrollView(scroll);

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

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Load and check")) { try { LoadFile(); if (loaded != null) { ValidateTarget(); status = AlignmentReport()+PrepareBiome(); } } catch(Exception e) {status=e.Message;Debug.LogError("[GolfMap] "+status);} }
                using (new EditorGUI.DisabledScope(terrain == null || string.IsNullOrEmpty(filePath)))
                    if (GUILayout.Button("Plant")) Plant();
                if (mode == Mode.PersistentStorage && GUILayout.Button("Clear imported")) ClearImported();
            }
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.Info);

            EditorGUILayout.EndScrollView();
            so.ApplyModifiedProperties();
        }

        // ---- loading -------------------------------------------------------

        void LoadFile()
        {
            loaded = null;
            try
            {
                var text = File.ReadAllText(filePath);
                var file = JsonUtility.FromJson<GolfMapTreeFile>(text);
                if (file == null || file.format != kFormat) throw new Exception($"format must be {kFormat}");
                if (file.plot == null || file.plot.sizeM <= 0) throw new Exception("plot.sizeM missing");
                if (file.trees == null) throw new Exception("trees missing");
                foreach (var t in file.trees)
                    if (t==null || !ValidNumber(t.x)||!ValidNumber(t.z)||!ValidNumber(t.g)||!ValidNumber(t.h)||!ValidNumber(t.r)||t.h <= 0 || t.r <= 0||t.k<0||t.k>2) throw new Exception("Invalid tree coordinates, height, radius or kind");
                loaded = file;
                loadedPath = filePath;
                // An outer-plot file switches billboards on; the toggle stays editable.
                if (file.plot.terrain == "outer" || file.plot.terrain == "inner") forceBillboards = file.plot.terrain == "outer";
            }
            catch (Exception e)
            {
                status = $"Load failed: {e.Message}";
                Debug.LogError($"[GolfMap] {status}");
            }
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
            biomeMatches.Clear();biomePrefabs.Clear();biome=null;
            if(!useBiome)return "";
            biome=JsonUtility.FromJson<GolfMapBiome>(File.ReadAllText(biomePath).TrimStart('\uFEFF'));
            if(biome==null||biome.format!="golfmap-tree-palette-v1"||biome.rules==null||biome.assets==null||biome.assets.Count==0)throw new Exception("Invalid biome palette.");
            var rules=biome.rules;
            if(!(rules.minScale>0&&rules.maxScale>=rules.minScale&&rules.variationBand>=0&&rules.speciesFitSlack>=0&&rules.maxHeightError>=0&&rules.maxWidthError>=0))throw new Exception("Invalid biome rules.");
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
                    }
                }
                if(meshRenderers==0)throw new Exception("No usable mesh renderers: "+a.name);
                biomePrefabs.Add(a.guid,prefab);
            }
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
                string id=string.IsNullOrEmpty(t.id)?t.x.ToString("R",System.Globalization.CultureInfo.InvariantCulture)+":"+t.z.ToString("R",System.Globalization.CultureInfo.InvariantCulture):t.id;
                if(!ids.Add(id))throw new Exception("Duplicate stem ID/coordinate: "+id);
                int neighbours=0;
                if(grid.Count>0&&t.h>rules.shrubMaxHeightM){
                    double gx=Math.Floor(t.x/cell),gz=Math.Floor(t.z/cell);
                    for(int dx=-1;dx<=1;dx++)for(int dz=-1;dz<=1;dz++){
                        List<GolfMapTree> bucket;if(!grid.TryGetValue((gx+dx)+":"+(gz+dz),out bucket))continue;
                        foreach(var other in bucket){double x=(double)other.x-t.x,z=(double)other.z-t.z;if(other!=t&&x*x+z*z<=cell*cell)neighbours++;}
                    }
                }
                bool woodland=grid.Count>0&&neighbours>=rules.woodlandMinNeighbours;
                if(woodland)woodlandCount++;
                var m=GolfMapBiomeMatcher.Match(biome,id,t.h,t.r,t.k,woodland);
                if(m==null){unmatched++;continue;}if(m.review)review++;
                if(!m.review||includeReviewMatches){biomeMatches.Add(t,m);matched++;}
            }
            var speciesCounts=new Dictionary<string,int>();foreach(var m in biomeMatches.Values){string label=string.IsNullOrEmpty(m.asset.species)?m.asset.kind:m.asset.species;if(!speciesCounts.ContainsKey(label))speciesCounts[label]=0;speciesCounts[label]++;}
            var mix="";foreach(var pair in speciesCounts)mix+=pair.Key+" "+pair.Value+"; ";
            return "\nBiome: "+matched+" eligible, "+review+" imperfect/unknown fits, "+unmatched+" unmatched (skipped). "+woodlandCount+" woodland stems use canopy matching. Uniform scale "+minScale+"–"+maxScale+". Uses prepared material colours.\n"+mix;
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
        float WidthScale(GolfMapTree t, Proto p, float hs) => useBiome ? hs : scaleWidth ? Mathf.Clamp(2f * t.r / p.widthM, minScale, maxScale) : hs;
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
