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
        public List<GolfMapTreeArea> areas;   // tree species areas (optional; gspro.py trees --course)
    }

    // A tree species area drawn in golf-map (shared/features/tree-areas.ts): the stems that
    // name it in `area` race its species mix instead of the palette's.
    [Serializable]
    public class GolfMapTreeArea
    {
        public string id;
        public string name;
        public bool ignoreKind;      // the mix decides even against the survey's broadleaf/conifer class
        public List<GolfMapTreeAreaSpecies> species;
        public int stems;
        public List<GolfMapZoneRing> rings;   // plot-local outline, for the Scene view
    }

    [Serializable]
    public class GolfMapTreeAreaSpecies
    {
        public string species;
        public double weight;
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
        public string area;  // id of the tree species area it stands in; empty = none
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
        partial void DuplicateReport(ref string report);

        const string kFormat = "unity-trees-v1";
        const string kParentName = "GolfMapTrees";

        string filePath { get { return T.filePath; } set { T.filePath = value; } }
        Terrain terrain { get { return T.terrain; } set { T.terrain = value; } }
        Mode mode { get { return T.mode; } set { T.mode = value; } }
        bool useBiome { get { return T.useBiome; } set { T.useBiome = value; } }
        string biomePath { get { return T.biomePath; } set { T.biomePath = value; } }
        // An empty path means the course's own palette.
        internal string BiomeFile { get { return string.IsNullOrEmpty(biomePath) ? GolfMapCourses.PalettePath(GolfMapCourses.For(component)) : biomePath; } }
        Terrain innerExclusion { get { return T.innerExclusion; } set { T.innerExclusion = value; } }
        bool includeReviewMatches { get { return T.includeReviewMatches; } set { T.includeReviewMatches = value; } }
        GolfMapBiome biome;
        readonly Dictionary<string,GameObject> biomePrefabs = new Dictionary<string,GameObject>();
        readonly Dictionary<GolfMapTree,GolfMapBiomeMatch> biomeMatches = new Dictionary<GolfMapTree,GolfMapBiomeMatch>();
        readonly HashSet<GolfMapTree> woodlandTrees = new HashSet<GolfMapTree>();
        // Manual edits (GolfMapTreeEdits.cs) applied on top of the loaded survey: tree -> its record.
        readonly Dictionary<GolfMapTree,GolfMapTreeEdit> treeEdits = new Dictionary<GolfMapTree,GolfMapTreeEdit>();
        readonly Dictionary<string,GolfMapAreaMix> areaMixes = new Dictionary<string,GolfMapAreaMix>();   // loaded file's tree species areas by id
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
        int seed { get { return T.seed; } set { T.seed = value; } }
        float alignmentToleranceM { get { return T.alignmentToleranceM; } set { T.alignmentToleranceM = value; } }
        bool ignoreAlignment { get { return T.ignoreAlignment; } set { T.ignoreAlignment = value; } }
        // Outer-plot trees are always far from the player, so they go in as
        // billboards only: TerrainInstances mode sets the terrain's billboard
        // start distance to its minimum; the VSP partial reads this too.
        // Fixed by the component's role, never toggled by hand or by the loaded file.
        bool forceBillboards { get { return T.role == GolfMapTrees.Role.Outer; } }
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
            var host = Host();
            Selection.activeGameObject = host.gameObject;
            EditorGUIUtility.PingObject(host.gameObject);
            return For(Active(host));
        }

        // One "GolfMap Trees" object per scene carries both areas: the inner component, whose
        // Inspector shows the Inner and Outer panels, and the outer component beside it, hidden
        // from the Inspector. Two components rather than one with two settings blocks, because a
        // planter (loaded survey, matches, editing session) belongs to exactly one component.
        const string kHostName = "GolfMap Trees";
        internal static GolfMapTrees Host()
        {
            var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            var all = FindObjectsOfType<GolfMapTrees>().Where(c => c.gameObject.scene == scene).OrderBy(c => c.name).ToArray();
            foreach (var c in all) AdoptRole(c);
            var host = all.FirstOrDefault(c => c.role == GolfMapTrees.Role.Inner);
            if (!host)
            {
                var go = new GameObject(kHostName);
                Undo.RegisterCreatedObjectUndo(go, "Create GolfMap Trees");
                host = go.AddComponent<GolfMapTrees>();
                host.role = GolfMapTrees.Role.Inner; host.roleAssigned = true;
            }
            if (host.name == RoleObjectName(GolfMapTrees.Role.Inner)) { Undo.RecordObject(host.gameObject, "Rename GolfMap Trees"); host.name = kHostName; }
            Outer(host);
            return host;
        }

        // The panel the host's Inspector has open.
        internal static GolfMapTrees Active(GolfMapTrees host) { return host.showOuter ? Outer(host) : host; }

        // The outer component on the host's object, created when missing. An outer component
        // left on an object of its own by an earlier version is moved here with its settings.
        internal static GolfMapTrees Outer(GolfMapTrees host)
        {
            var outer = host.GetComponents<GolfMapTrees>().FirstOrDefault(c => c != host && c.role == GolfMapTrees.Role.Outer);
            if (!outer)
            {
                outer = Undo.AddComponent<GolfMapTrees>(host.gameObject);
                outer.role = GolfMapTrees.Role.Outer; outer.roleAssigned = true;
                var stray = FindObjectsOfType<GolfMapTrees>().FirstOrDefault(c => c.gameObject != host.gameObject && c.gameObject.scene == host.gameObject.scene && c.roleAssigned && c.role == GolfMapTrees.Role.Outer);
                if (stray)
                {
                    EditorUtility.CopySerialized(stray, outer);
                    if (stray.GetComponents<Component>().Length == 2 && stray.transform.childCount == 0) Undo.DestroyObjectImmediate(stray.gameObject);
                    else Undo.DestroyObjectImmediate(stray);
                }
                EditorUtility.SetDirty(outer);
            }
            if ((outer.hideFlags & HideFlags.HideInInspector) == 0) { outer.hideFlags |= HideFlags.HideInInspector; EditorUtility.SetDirty(outer); }
            return outer;
        }

        static string RoleObjectName(GolfMapTrees.Role role) { return "GolfMap Trees (" + role + ")"; }
        string RoleKey { get { return T.role == GolfMapTrees.Role.Outer ? "outer" : "inner"; } }

        static void AdoptRole(GolfMapTrees c)
        {
            if (c.roleAssigned) return;
            Undo.RecordObject(c, "Assign GolfMap Trees role");
            c.role = c.forceBillboards ? GolfMapTrees.Role.Outer : GolfMapTrees.Role.Inner;
            c.roleAssigned = true;
            EditorUtility.SetDirty(c);
        }

        // ---- role ----------------------------------------------------------

        // Everything the role decides is resolved here rather than picked by hand: the terrain,
        // the inner square an outer planting excludes, the course's trees export and the one
        // storage that belongs to that terrain. Returns what stops planting, or null.
        string roleProblem;
        string SyncRole()
        {
            AdoptRole(component);
            try
            {
                var course = Course;
                var scene = component.gameObject.scene;
                bool outer = T.role == GolfMapTrees.Role.Outer;
                var inner = RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
                var target = outer ? RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer") : inner;
                var exclusion = outer ? inner : null;
                if (outer && target == inner) throw new Exception("The course names the same terrain as inner and outer.");
                bool changed = false;
                if (terrain != target) { terrain = target; loaded = null; changed = true; }
                if (innerExclusion != exclusion) { innerExclusion = exclusion; changed = true; }
                if (!T.customFile)
                {
                    var file = GolfMapCourses.TreesFile(course, RoleKey);
                    if (string.IsNullOrEmpty(file)) throw new Exception("The course has no " + RoleKey + " trees export (" + GolfMapCourses.ExportFile(course, RoleKey, "trees") + "). Tick Custom trees file to pick one.");
                    if (filePath != file) { filePath = file; loaded = null; changed = true; }
                }
                if (outer && mode != Mode.PersistentStorage) { mode = Mode.PersistentStorage; changed = true; }
                string storageProblem = null;
                SyncStorage(ref changed, ref storageProblem);
                if (changed) Dirty();
                return storageProblem;
            }
            catch (Exception e) { return e.Message; }
        }
        partial void SyncStorage(ref bool changed, ref string problem);

        internal static Terrain RoleTerrain(UnityEngine.SceneManagement.Scene scene, string objectName, string dataName, string label)
        {
            var found = FindObjectsOfType<Terrain>().Where(t => t.gameObject.scene == scene && t.terrainData &&
                ((!string.IsNullOrEmpty(objectName) && t.name == objectName) || (!string.IsNullOrEmpty(dataName) && t.terrainData.name == dataName))).ToArray();
            if (found.Length != 1) throw new Exception("Expected one " + label + " terrain named '" + objectName + "'" + (string.IsNullOrEmpty(dataName) ? "" : " or using " + dataName + " data") + "; found " + found.Length + ". Set the terrain names on the course asset.");
            return found[0];
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

            if (Event.current.type == EventType.Layout) roleProblem = SyncRole();
            DrawRoleHeader();
            if (!string.IsNullOrEmpty(roleProblem)) EditorGUILayout.HelpBox(roleProblem, MessageType.Error);
            showSetup = EditorGUILayout.Foldout(showSetup, "Setup", true);
            if (showSetup) DrawSetup();
            DrawActions();
            if (!string.IsNullOrEmpty(status)) EditorGUILayout.HelpBox(status, MessageType.Info);

            DrawTreeEditor();

            if (EditorGUI.EndChangeCheck()) Dirty();
            so.ApplyModifiedProperties();
        }

        // Which area's panel this is, in a colour that cannot be mistaken. The Inspector draws the
        // Inner | Outer tabs above it.
        void DrawRoleHeader()
        {
            bool outer = T.role == GolfMapTrees.Role.Outer;
            var style = new GUIStyle(EditorStyles.boldLabel) { alignment = TextAnchor.MiddleCenter, fontSize = 13 };
            style.normal.textColor = Color.white;
            var rect = GUILayoutUtility.GetRect(0, 26, GUILayout.ExpandWidth(true));
            EditorGUI.DrawRect(rect, outer ? new Color(0.20f, 0.35f, 0.60f) : new Color(0.16f, 0.48f, 0.22f));
            GUI.Label(rect, outer ? "OUTER  -  surrounding plot, billboards only" : "INNER  -  course area, mesh trees", style);
        }

        void DrawSetup()
        {
            EditorGUILayout.LabelField("Resolved from the course for this area", EditorStyles.boldLabel);
            T.course = (GolfMapCourse)EditorGUILayout.ObjectField(new GUIContent("Course", "Empty: the course that claims this scene."), T.course, typeof(GolfMapCourse), false);
            using (new EditorGUI.DisabledScope(true))
            {
                EditorGUILayout.ObjectField("Terrain", terrain, typeof(Terrain), true);
                if (forceBillboards) EditorGUILayout.ObjectField("Inner square excluded", innerExclusion, typeof(Terrain), true);
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                using (new EditorGUI.DisabledScope(!T.customFile)) filePath = EditorGUILayout.TextField("Trees file", filePath);
                if (T.customFile && GUILayout.Button("...", GUILayout.Width(30)))
                {
                    var picked = EditorUtility.OpenFilePanel("unity-trees-v1 JSON", string.IsNullOrEmpty(filePath) ? "" : Path.GetDirectoryName(filePath), "json");
                    if (!string.IsNullOrEmpty(picked)) { filePath = picked; loaded = null; }
                }
            }
            T.customFile = EditorGUILayout.Toggle(new GUIContent("Custom trees file", "Off: the course's " + RoleKey + " export. A custom file must still be a " + RoleKey + " plot."), T.customFile);

            EditorGUILayout.Space();
            useBiome = EditorGUILayout.Toggle("Use biome palette", useBiome);
            if(useBiome){
                biomePath=EditorGUILayout.TextField(new GUIContent("Biome JSON","Empty: the course's palette."),biomePath);
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
            using (new EditorGUI.DisabledScope(forceBillboards)) mode = (Mode)EditorGUILayout.EnumPopup("Mode", mode);
            if(!useBiome){
            minScale = EditorGUILayout.FloatField("Min scale", minScale);
            maxScale = EditorGUILayout.FloatField("Max scale", maxScale);
            scaleWidth = EditorGUILayout.Toggle("Scale width from crown radius", scaleWidth);
            seed = EditorGUILayout.IntField("Seed", seed);
            } else EditorGUILayout.HelpBox("Prefab selection, species weights, scale limits and random seed come from the biome JSON.",MessageType.None);
            minHeightM = EditorGUILayout.FloatField("Skip trees under (m)", minHeightM);
            alignmentToleranceM = EditorGUILayout.FloatField("Alignment tolerance (m)", alignmentToleranceM);
            ignoreAlignment = EditorGUILayout.Toggle("Plant even if misaligned", ignoreAlignment);
            DrawStorageOptions();
        }

        void DrawActions()
        {
            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                using (new EditorGUI.DisabledScope(terrain == null || string.IsNullOrEmpty(filePath)))
                {
                    if (GUILayout.Button("Load and check")) Check();
                    using (new EditorGUI.DisabledScope(!string.IsNullOrEmpty(roleProblem)))
                        if (GUILayout.Button(new GUIContent("Plant " + RoleKey, "Replaces this area's imported trees with the file's. Never appends."))) Plant();
                }
                if (mode == Mode.PersistentStorage && GUILayout.Button("Clear " + RoleKey + " trees")) ClearImported();
            }
        }

        // The bridge's way in (golfmap.trees.plant): the panel's 'Load and check', or its 'Plant' without the
        // replace question (nobody can answer a modal dialog over the bridge; the planting backup is written as ever).
        bool unattended;
        internal string RunFromBridge(bool plant)
        {
            var problem = SyncRole();
            if (!string.IsNullOrEmpty(problem)) return "Not planted: " + problem;
            if (terrain == null || string.IsNullOrEmpty(filePath)) return "Not planted: the " + RoleKey + " panel has no terrain or trees file.";
            unattended = true;
            try { if (plant) Plant(); else Check(); }
            finally { unattended = false; }
            return status;
        }

        // Load the survey and match it against the saved palette, without planting.
        internal void Check()
        {
            try { LoadFile(); if (loaded != null) { ValidateTarget(); string doubles = ""; DuplicateReport(ref doubles); status = AlignmentReport()+PrepareBiome()+EditsReport()+doubles; } }
            catch(Exception e) {status=e.Message;Debug.LogError("[GolfMap] "+status);}
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
                // The other area's survey planted here is how a course ends up with every tree twice.
                if (!string.IsNullOrEmpty(file.plot.terrain) && file.plot.terrain != RoleKey)
                    throw new Exception("this is the " + file.plot.terrain + " plot's file and this is the " + RoleKey + " panel. Plant it from the other panel");
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
                areaMixes.Clear();
                foreach (var a in file.areas ?? new List<GolfMapTreeArea>())
                {
                    if (a == null || string.IsNullOrEmpty(a.id)) continue;
                    var mix = new GolfMapAreaMix { ignoreKind = a.ignoreKind };
                    foreach (var s in a.species ?? new List<GolfMapTreeAreaSpecies>()) if (s != null && !string.IsNullOrEmpty(s.species) && s.weight > 0) mix.weights[s.species] = s.weight;
                    areaMixes[a.id] = mix;
                }
                loaded = file;
                loadedPath = filePath;
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
            if (edit != null && !string.IsNullOrEmpty(edit.model))
            {
                // A hand-picked model: that one, whatever the palette enables.
                var assets = biome.assets.Where(a => a.model == edit.model).ToList();
                if (assets.Count == 0) throw new Exception("Model '" + edit.model + "' is not in the palette (tree " + t.id + ").");
                if (!assets[0].enabled && !assets[0].IsArborist) throw new Exception("Model '" + edit.model + "' is disabled in the palette: enable it to plant tree " + t.id + " with it.");
                source = biome.OnlyAssets(assets.Take(1).Select(a => { var c = a.Clone(); c.enabled = true; return c; }).ToList());
                kind = GolfMapBiome.StemKind(source.assets);
            }
            else if (edit != null && (!string.IsNullOrEmpty(edit.species) || !string.IsNullOrEmpty(edit.guid)))
            {
                var assets = biome.assets.Where(a => a.enabled && (string.IsNullOrEmpty(edit.guid) ? a.species == edit.species : a.MatchKey == edit.guid)).ToList();
                if (assets.Count == 0) throw new Exception("No enabled biome asset for species '" + edit.species + "' / asset '" + edit.guid + "' (tree " + t.id + ").");
                source = biome.OnlyAssets(assets);
                kind = GolfMapBiome.MatchKind(assets);
            }
            // A tree species area gives the stem its mix; a hand-picked species or asset wins over it.
            GolfMapAreaMix area = null;
            if (source == biome && !string.IsNullOrEmpty(t.area)) areaMixes.TryGetValue(t.area, out area);
            // Match owns the sized rule: a stem sized by hand gets no woodland canopy.
            var m = GolfMapBiomeMatcher.Match(source, t.id, t.h, t.r, kind, woodland, area, edit != null && edit.sized);
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
                // A tree whose model or size was set by hand is what was asked for, not a fit to review.
                if (!string.IsNullOrEmpty(edit.model) || edit.sized) m.review = false;
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
            if(forceBillboards && (!innerExclusion||innerExclusion==terrain||innerExclusion.gameObject.scene!=terrain.gameObject.scene))throw new Exception("Outer planting requires a different inner terrain in the same scene to exclude.");
            if(forceBillboards && mode!=Mode.PersistentStorage)throw new Exception("Use PersistentStorage for guaranteed billboard-only outer planting with this biome.");
            if(!ValidNumber(minScale)||!ValidNumber(maxScale)||minScale<=0||maxScale<minScale)throw new Exception("Invalid scale limits.");
        }
        // Plantable tree-form stems with at least woodlandMinNeighbours others within woodlandRadiusM.
        HashSet<GolfMapTree> WoodlandStems(GolfMapBiomeRules rules)
        {
            var result=new HashSet<GolfMapTree>();
            double cell=rules.woodlandRadiusM;
            if(!(cell>0&&rules.woodlandMinNeighbours>0))return result;
            var grid=new Dictionary<string,List<GolfMapTree>>();
            foreach(var stem in loaded.trees){
                if(stem.h<=rules.shrubMaxHeightM||!InsidePlot(stem)||stem.h<minHeightM)continue;
                string key=Math.Floor(stem.x/cell)+":"+Math.Floor(stem.z/cell);
                if(!grid.ContainsKey(key))grid[key]=new List<GolfMapTree>();grid[key].Add(stem);
            }
            foreach(var bucketed in grid.Values)foreach(var t in bucketed){
                int neighbours=0;
                double gx=Math.Floor(t.x/cell),gz=Math.Floor(t.z/cell);
                for(int dx=-1;dx<=1;dx++)for(int dz=-1;dz<=1;dz++){
                    List<GolfMapTree> bucket;if(!grid.TryGetValue((gx+dx)+":"+(gz+dz),out bucket))continue;
                    foreach(var other in bucket){double x=(double)other.x-t.x,z=(double)other.z-t.z;if(other!=t&&x*x+z*z<=cell*cell)neighbours++;}
                }
                if(neighbours>=rules.woodlandMinNeighbours)result.Add(t);
            }
            return result;
        }
        // Materials VSP can draw: present, supported, and on a shader name GSPro's build resolves.
        int CheckRenderers(string name,GameObject prefab,List<string> shaderIssues)
        {
            int meshRenderers=0;
            foreach(var renderer in prefab.GetComponentsInChildren<Renderer>(true)){
                // VSP renders mesh LODs and generates its own billboard atlas.
                // These packages contain unused BillboardRenderers with null slots.
                if(mode==Mode.PersistentStorage && renderer is BillboardRenderer)continue;
                meshRenderers++;
                var slots=renderer.sharedMaterials;
                for(int slot=0;slot<slots.Length;slot++){
                    var material=slots[slot];
                    string location=name+" / "+renderer.name+" / material slot "+slot;
                    if(!material)throw new Exception("Missing material: "+location);
                    if(!material.shader||!material.shader.isSupported)throw new Exception("Unsupported shader: "+location+" ("+material.name+")");
                    if(mode==Mode.PersistentStorage&&!VspKnowsShader(material.shader.name))shaderIssues.Add(location+" ("+material.name+") uses '"+material.shader.name+"'");
                }
            }
            return meshRenderers;
        }
        string PrepareBiome()
        {
            biomeMatches.Clear();biomePrefabs.Clear();woodlandTrees.Clear();biome=null;
            if(!useBiome)return "";
            biome=GolfMapPalette.Load(BiomeFile);
            if(biome.assets.Count==0)throw new Exception("Invalid biome palette.");
            var rules=biome.rules;
            if(!(rules.minScale>0&&rules.maxScale>=rules.minScale&&rules.variationBand>=0&&rules.speciesFitSlack>=0&&rules.maxHeightError>=0&&rules.maxWidthError>=0&&rules.scaleJitter>=0&&rules.scaleJitter<1&&rules.maxLeanDeg>=0&&rules.maxLeanDeg<=45))throw new Exception("Invalid biome rules.");
            var renderIssues=new List<string>();var shaderIssues=new List<string>();
            foreach(var a in biome.assets){
                if(!a.enabled)continue;
                if(!(a.heightM>0&&a.crownWidthM>0)||double.IsInfinity(a.heightM)||double.IsInfinity(a.crownWidthM))throw new Exception("Invalid dimensions: "+a.name);
                // An Arborist model has no prefab here: its trees become placements for the Arborist writer.
                if(a.IsArborist)continue;
                var actual=AssetDatabase.GUIDToAssetPath(a.guid);
                if(actual!=a.path)throw new Exception("Biome asset missing or moved: "+a.name+". Expected "+a.path);
                var prefab=AssetDatabase.LoadAssetAtPath<GameObject>(actual);
                if(!prefab)throw new Exception("Cannot load biome prefab "+a.name);
                int meshRenderers=CheckRenderers(a.name,prefab,shaderIssues);
                if(meshRenderers==0)throw new Exception("No usable mesh renderers: "+a.name);
                if(mode==Mode.PersistentStorage){var issue=VspRenderIssue(a,prefab);if(issue!=null)renderIssues.Add(issue);}
                biomePrefabs.Add(a.guid,GolfMapTreeColliders.Planted(Course,prefab));
            }
            // A look with its own materials plants its generated copy of each shape.
            foreach(var group in biome.species)foreach(var look in group.looks){
                if(look.original||!(look.weight>0))continue;
                foreach(var shape in GolfMapLooks.Shapes(biome,group.name,look)){
                    if(!shape.enabled||shape.IsArborist)continue;
                    var copy=GolfMapLooks.Prefab(GolfMapCourses.For(component),group.name,look,shape);
                    // A look the palette records but this project never generated: build it from the recorded values.
                    if(!copy){GolfMapLooks.Generate(GolfMapCourses.For(component),biome,group.name,look,null);GolfMapLooks.Apply(GolfMapCourses.For(component),biome,group.name,look);copy=GolfMapLooks.Prefab(GolfMapCourses.For(component),group.name,look,shape);}
                    if(!copy)throw new Exception("Look '"+look.id+"' of "+group.name+" has no prefab for "+shape.name+". Open the look in the Palette panel and press Regenerate.");
                    CheckRenderers(shape.name+" ["+look.id+"]",copy,shaderIssues);
                    biomePrefabs.Add(GolfMapBiome.LookKey(shape.guid,look.id),copy);
                }
            }
            if(renderIssues.Count>0)throw new Exception("Palette assets VSP cannot draw faithfully (use VS_/baked variants):\n"+string.Join("\n",renderIssues.ToArray()));
            if(shaderIssues.Count>0)throw new Exception("Shader names GSPro's Vegetation Studio build cannot resolve a controller for. It has no DefaultShaderController fallback: one of these null-refs in VegetationItemModelInfo.SetShaderControllers and stops every tree in the package from loading, silently. Use a stock shader name (NatureManufacture Shaders/Trees/Tree {Bark,Leaves} {Metalic,Specular}, CTI/LOD {Bark,Leaves,Bark Array}, Nature/SpeedTree) and drive colour through the item's shader-controller settings instead:\n"+string.Join("\n",shaderIssues.ToArray()));
            minScale=(float)rules.minScale;maxScale=(float)rules.maxScale;scaleWidth=false;
            int matched=0,review=0,unmatched=0,woodlandCount=0;var ids=new HashSet<string>();
            foreach(var stem in WoodlandStems(rules))woodlandTrees.Add(stem);
            foreach(var t in loaded.trees){
                if(!InsidePlot(t)||t.h<minHeightM)continue;
                if(!ids.Add(t.id))throw new Exception("Duplicate stem ID/coordinate: "+t.id);
                bool woodland=woodlandTrees.Contains(t);
                if(woodland)woodlandCount++;
                var m=MatchTree(t,woodland);
                if(m==null){unmatched++;continue;}if(m.review)review++;
                if(!m.review||includeReviewMatches){biomeMatches.Add(t,m);matched++;}
            }
            var speciesCounts=new Dictionary<string,int>();foreach(var m in biomeMatches.Values){string label=string.IsNullOrEmpty(m.asset.species)?m.asset.kind:m.asset.species;if(!speciesCounts.ContainsKey(label))speciesCounts[label]=0;speciesCounts[label]++;}
            var mix="";foreach(var pair in speciesCounts)mix+=pair.Key+" "+pair.Value+"; ";
            return "\nBiome: "+matched+" eligible, "+review+" imperfect/unknown fits, "+unmatched+" unmatched (skipped). "+woodlandCount+" woodland stems use canopy matching. Uniform scale "+minScale+"–"+maxScale+". Uses prepared material colours.\n"+mix+AreasReport();
        }

        // What each tree species area asked for and what its stems got, and species it names that
        // the palette has no enabled asset for (those never plant).
        string AreasReport()
        {
            var areas = loaded == null || loaded.areas == null ? new List<GolfMapTreeArea>() : loaded.areas.Where(a => a != null && !string.IsNullOrEmpty(a.id)).ToList();
            if (areas.Count == 0) return "";
            var known = new HashSet<string>(biome.assets.Where(a => a.enabled).Select(a => a.Label));
            var text = "\nTree species areas: " + areas.Count + ".";
            foreach (var a in areas)
            {
                var got = new Dictionary<string, int>();
                foreach (var pair in biomeMatches) if (pair.Key.area == a.id) { string label = pair.Value.asset.Label; int n; got.TryGetValue(label, out n); got[label] = n + 1; }
                var species = a.species ?? new List<GolfMapTreeAreaSpecies>();
                double total = species.Sum(s => Math.Max(0, s.weight));
                string asked = string.Join(", ", species.Where(s => s.weight > 0).Select(s => s.species + " " + (total > 0 ? Math.Round(100 * s.weight / total) : 0) + "%").ToArray());
                string planted = got.Count == 0 ? "none" : string.Join(", ", got.OrderByDescending(g => g.Value).Select(g => g.Key + " " + g.Value).ToArray());
                text += "\n  " + (string.IsNullOrEmpty(a.name) ? a.id : a.name) + ": " + asked + (a.ignoreKind ? " (any survey class)" : "") + " -> " + planted;
                var unknown = species.Where(s => s.weight > 0 && !known.Contains(s.species)).Select(s => s.species).ToArray();
                if (unknown.Length > 0) text += "  WARNING no enabled palette asset for: " + string.Join(", ", unknown);
            }
            return text;
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
        internal static bool VspKnowsShader(string shaderName)
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
            var buildingNote = ClearBuildingStems();
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
            if (mode == Mode.PersistentStorage) {bool available=false;StorageAvailable(ref available);if(!available){status="Install GolfMapTreePlanterVsp.cs for PersistentStorage mode.";return;} PlantStorage();status+=biomeReport+buildingNote; return; }
            if (mode == Mode.TerrainInstances) planted = PlantTerrainInstances(protos, rng, out skipped);
            else planted = PlantGameObjects(protos, rng, out skipped);

            status = $"Planted {planted} trees ({skipped} skipped). {report}"+biomeReport+buildingNote;
            Debug.Log($"[GolfMap] {status}");
        }

        // Survey stems under or within kBuildingClearM of a placed building (GolfMap Props/Buildings)
        // are left out: lidar reads roof edges and corners as small crowns, and a house fitted to its
        // lidar roof covers stems the trees export never knew about. A stem right under any other
        // placed prop or structure (a boxwood hedge block, a shed) goes too: that prop is what the
        // lidar saw. Hand-edited stems stay. The re-read file is planted from, so this only drops
        // stems for this planting.
        const float kBuildingClearM = 1.0f;
        string ClearBuildingStems()
        {
            if (terrain == null || loaded == null) return "";
            var root = terrain.gameObject.scene.GetRootGameObjects().FirstOrDefault(g => g.name == GolfMapProps.RootName);
            if (!root) return "";
            var buildings = new List<MeshCollider>();
            var others = new List<MeshCollider>();
            var temporary = new List<GameObject>();
            try
            {
                foreach (Transform group in root.transform)
                    foreach (var filter in group.GetComponentsInChildren<MeshFilter>())
                    {
                        if (!filter.sharedMesh || !filter.gameObject.activeInHierarchy) continue;
                        var go = new GameObject("GolfMap building probe") { hideFlags = HideFlags.HideAndDontSave };
                        temporary.Add(go);
                        go.transform.SetParent(filter.transform, false);
                        var c = go.AddComponent<MeshCollider>();
                        c.sharedMesh = filter.sharedMesh;
                        (group.name == "Buildings" ? buildings : others).Add(c);
                    }
                Physics.SyncTransforms();
                int before = loaded.trees.Count;
                loaded.trees.RemoveAll(t => !treeEdits.ContainsKey(t) && NearBuilding(buildings, WorldPos(t), kBuildingClearM));
                int nearBuildings = before - loaded.trees.Count;
                loaded.trees.RemoveAll(t => !treeEdits.ContainsKey(t) && NearBuilding(others, WorldPos(t), 0));
                int underProps = before - nearBuildings - loaded.trees.Count;
                return (nearBuildings > 0 ? "\nLeft out " + nearBuildings + " stems under or within " + kBuildingClearM + " m of a building." : "")
                    + (underProps > 0 ? "\nLeft out " + underProps + " stems standing under a placed prop or structure." : "");
            }
            finally { foreach (var go in temporary) if (go) DestroyImmediate(go); }
        }

        // A downward ray at the stem and at eight points clearM around it (none for clearM 0): any
        // hit on a mesh means the stem stands inside its outline or against its wall.
        static bool NearBuilding(List<MeshCollider> colliders, Vector3 stem, float clearM)
        {
            for (int i = -1; i < (clearM > 0 ? 8 : 0); i++)
            {
                var p = i < 0 ? stem : stem + new Vector3(Mathf.Cos(i * Mathf.PI / 4), 0, Mathf.Sin(i * Mathf.PI / 4)) * clearM;
                foreach (var c in colliders)
                {
                    var b = c.bounds;
                    if (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z) continue;
                    RaycastHit hit;
                    if (c.Raycast(new Ray(new Vector3(p.x, b.max.y + 1, p.z), Vector3.down), out hit, b.size.y + 2)) return true;
                }
            }
            return false;
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
            if(useBiome){GolfMapBiomeMatch match;return biomeMatches.TryGetValue(t,out match)&&!match.asset.IsArborist?biomePrefabs[biome.PrefabKey(match)]:null;}
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
                // A look's generated copy sits at its own path: it has the dimensions of the shape it copies.
                foreach(var entry in biomePrefabs)if(entry.Value==prefab){
                    string guid=entry.Key.Split(':')[0];
                    var shape=biome.assets.FirstOrDefault(a=>a.guid==guid);
                    if(shape==null)continue;
                    p=new Proto{prefab=prefab,heightM=(float)shape.heightM,widthM=(float)shape.crownWidthM,prototypeIndex=-1};
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
        // Yaw plus the biome match's lean. Unity terrain trees can only turn about Y and use TreeRotation.
        Quaternion TreeOrientation(GolfMapTree t, System.Random rng) => useBiome ? Orientation(biomeMatches[t], (float)biomeMatches[t].rotation) : Quaternion.Euler(0, TreeRotation(t, rng), 0);
        // The lean tilts the trunk towards leanDirection in the tree's own frame, so turning the tree turns its lean with it.
        static Quaternion Orientation(GolfMapBiomeMatch m, float yaw) => Quaternion.Euler(0, yaw, 0) * Quaternion.AngleAxis((float)m.lean, Quaternion.Euler(0, (float)m.leanDirection, 0) * Vector3.right);

        int PlantTerrainInstances(Dictionary<GameObject, Proto> protos, System.Random rng, out int skipped)
        {
            var data = terrain.terrainData;
            Undo.RegisterCompleteObjectUndo(data, "GolfMap plant trees");

            // Planting always replaces: appending the same survey twice doubles every tree.
            var prototypes = new List<TreePrototype>();
            var instances = new List<TreeInstance>();
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
            if (parent != null)
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
                go.transform.rotation = TreeOrientation(t, rng);
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
