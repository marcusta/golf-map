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
    }

    public class GolfMapTreePlanter : EditorWindow
    {
        public enum Mode { TerrainInstances, GameObjects }

        const string kFormat = "unity-trees-v1";
        const string kParentName = "GolfMapTrees";

        [SerializeField] string filePath = "";
        [SerializeField] Terrain terrain;
        [SerializeField] Mode mode = Mode.TerrainInstances;
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
            EditorGUILayout.LabelField("Prefabs by crown kind", EditorStyles.boldLabel);
            EditorGUILayout.PropertyField(so.FindProperty("broadleafPrefabs"), true);
            EditorGUILayout.PropertyField(so.FindProperty("coniferPrefabs"), true);
            EditorGUILayout.PropertyField(so.FindProperty("unknownPrefabs"), new GUIContent("Unknown kind prefabs"), true);
            EditorGUILayout.PropertyField(so.FindProperty("bushPrefabs"), true);
            EditorGUILayout.HelpBox("Unknown kind falls back to the broadleaf list when empty. Bushes fall back to the kind list.", MessageType.None);

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Placement", EditorStyles.boldLabel);
            mode = (Mode)EditorGUILayout.EnumPopup("Mode", mode);
            minScale = EditorGUILayout.FloatField("Min scale", minScale);
            maxScale = EditorGUILayout.FloatField("Max scale", maxScale);
            scaleWidth = EditorGUILayout.Toggle("Scale width from crown radius", scaleWidth);
            minHeightM = EditorGUILayout.FloatField("Skip trees under (m)", minHeightM);
            seed = EditorGUILayout.IntField("Seed", seed);
            clearExisting = EditorGUILayout.Toggle("Clear existing trees first", clearExisting);
            alignmentToleranceM = EditorGUILayout.FloatField("Alignment tolerance (m)", alignmentToleranceM);
            ignoreAlignment = EditorGUILayout.Toggle("Plant even if misaligned", ignoreAlignment);

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Load and check")) { LoadFile(); if (loaded != null) status = AlignmentReport(); }
                using (new EditorGUI.DisabledScope(terrain == null || string.IsNullOrEmpty(filePath)))
                    if (GUILayout.Button("Plant")) Plant();
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
                    if (t.h <= 0 || t.r <= 0) throw new Exception("tree with non-positive height or radius");
                loaded = file;
                loadedPath = filePath;
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
            return t.x >= 0 && t.z >= 0 && t.x <= size.x && t.z <= size.z;
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
            if (loaded == null || loadedPath != filePath) LoadFile();
            if (loaded == null) return;
            var report = AlignmentReport();
            if (report.Contains("MISALIGNED") && !ignoreAlignment)
            {
                status = report + "\nNot planted. Fix the plot or tick 'Plant even if misaligned'.";
                return;
            }
            if (Fallback(0).Count == 0 && Fallback(1).Count == 0 && Fallback(2).Count == 0)
            {
                status = "No prefabs assigned.";
                return;
            }

            var protos = new Dictionary<GameObject, Proto>();
            var rng = new System.Random(seed);
            int planted = 0, skipped = 0;

            if (mode == Mode.TerrainInstances) planted = PlantTerrainInstances(protos, rng, out skipped);
            else planted = PlantGameObjects(protos, rng, out skipped);

            status = $"Planted {planted} trees ({skipped} skipped). {report}";
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
            var list = t.bush ? Nonnull(bushPrefabs) : null;
            if (list == null || list.Count == 0) list = Fallback(t.k);
            if (list.Count == 0) return null;
            return list[rng.Next(list.Count)];
        }

        Proto Measure(GameObject prefab, Dictionary<GameObject, Proto> cache)
        {
            if (cache.TryGetValue(prefab, out var p)) return p;
            var temp = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            temp.hideFlags = HideFlags.HideAndDontSave;
            temp.transform.position = Vector3.zero;
            temp.transform.rotation = Quaternion.identity;
            temp.transform.localScale = Vector3.one;
            var renderers = temp.GetComponentsInChildren<Renderer>();
            Bounds b = new Bounds(Vector3.zero, Vector3.zero);
            bool any = false;
            foreach (var r in renderers)
            {
                if (!any) { b = r.bounds; any = true; } else b.Encapsulate(r.bounds);
            }
            DestroyImmediate(temp);
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

        float HeightScale(GolfMapTree t, Proto p) => Mathf.Clamp(t.h / p.heightM, minScale, maxScale);
        float WidthScale(GolfMapTree t, Proto p, float hs) => scaleWidth ? Mathf.Clamp(2f * t.r / p.widthM, minScale, maxScale) : hs;

        int PlantTerrainInstances(Dictionary<GameObject, Proto> protos, System.Random rng, out int skipped)
        {
            var data = terrain.terrainData;
            Undo.RegisterCompleteObjectUndo(data, "GolfMap plant trees");

            var prototypes = new List<TreePrototype>(clearExisting ? Array.Empty<TreePrototype>() : data.treePrototypes);
            var instances = new List<TreeInstance>(clearExisting ? Array.Empty<TreeInstance>() : data.treeInstances);
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
                    position = new Vector3(t.x / size.x, 0f, t.z / size.z),
                    prototypeIndex = p.prototypeIndex,
                    heightScale = hs,
                    widthScale = WidthScale(t, p, hs),
                    rotation = (float)(rng.NextDouble() * Math.PI * 2),
                    color = Color.white,
                    lightmapColor = Color.white,
                });
                planted++;
            }

            data.treePrototypes = prototypes.ToArray();
            data.RefreshPrototypes();
            data.SetTreeInstances(instances.ToArray(), true);
            terrain.Flush();
            EditorUtility.SetDirty(data);
            return planted;
        }

        int PlantGameObjects(Dictionary<GameObject, Proto> protos, System.Random rng, out int skipped)
        {
            var parent = GameObject.Find(kParentName);
            if (parent != null && clearExisting)
            {
                Undo.DestroyObjectImmediate(parent);
                parent = null;
            }
            if (parent == null)
            {
                parent = new GameObject(kParentName);
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
                var go = (GameObject)PrefabUtility.InstantiatePrefab(prefab, parent.transform);
                go.transform.position = pos;
                go.transform.rotation = Quaternion.Euler(0, (float)(rng.NextDouble() * 360), 0);
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
