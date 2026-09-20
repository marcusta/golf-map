// GolfMap > Vegetation Zones: imports a golf-map "unity-zones-v1" export
// (GolfMapZones.cs) into Vegetation Studio Pro texture masks and draws the
// zone polygons in the Scene view.
//
// This file holds the window, the terrain match and the read-only overlay.
// Everything that touches VSP (system and package matching, mask groups,
// item rules, refresh, report) is in GolfMapZoneImporterVsp.cs, split the same
// way as the tree planter so the VSP dependency stays in one place.
//
// Coordinates: zone nodes are metres from the plot's south-west corner, x east
// and z north, the unity-trees-v1 convention. The terrain is assumed to sit at
// that corner with identity rotation, as the terrain importer leaves it.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public partial class GolfMapZoneImporter : EditorWindow
    {
        [SerializeField] string filePath = "";
        [SerializeField] Terrain terrain;
        [SerializeField] bool overlay = true;
        [SerializeField] bool labelsAlways = true;
        [SerializeField] float overlayLift = 0.5f;   // metres above the sampled terrain height
        [SerializeField] Vector2 scroll;

        GolfMapZoneFile loaded;
        string loadedPath;
        string status = "Choose a unity-zones-v1 file, Load and check, then Import.";

        // Overlay cache: rebuilt when the file or terrain changes.
        class OverlayZone
        {
            public GolfMapZone zone;
            public Color colour;
            public List<Vector3[]> rings = new List<Vector3[]>();
            public Vector3 centroid;
            public string label;
        }
        readonly List<OverlayZone> overlayZones = new List<OverlayZone>();
        Terrain overlayTerrain;
        GolfMapZoneFile overlayFile;

        partial void DrawVspOptions();
        partial void OnFileLoaded();
        partial void ImportVsp();
        partial void VspSummary(ref string text);

        [MenuItem("GolfMap/Vegetation Zones")]
        public static void Open() { GetWindow<GolfMapZoneImporter>("Vegetation Zones"); }

        void OnEnable()
        {
            SceneView.onSceneGUIDelegate -= OnSceneGUI;
            SceneView.onSceneGUIDelegate += OnSceneGUI;
        }

        void OnDisable()
        {
            SceneView.onSceneGUIDelegate -= OnSceneGUI;
            SceneView.RepaintAll();
        }

        void OnGUI()
        {
            scroll = EditorGUILayout.BeginScrollView(scroll);
            EditorGUILayout.LabelField("Input", EditorStyles.boldLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                filePath = EditorGUILayout.TextField("Zones file", filePath);
                if (GUILayout.Button("...", GUILayout.Width(30)))
                {
                    var picked = EditorUtility.OpenFilePanel("unity-zones-v1 JSON", string.IsNullOrEmpty(filePath) ? "" : Path.GetDirectoryName(filePath), "json");
                    if (!string.IsNullOrEmpty(picked)) { filePath = picked; loaded = null; }
                }
            }
            terrain = (Terrain)EditorGUILayout.ObjectField("Terrain", terrain, typeof(Terrain), true);
            using (new EditorGUI.DisabledScope(loaded == null))
                if (GUILayout.Button("Match terrain by plot bounds")) { MatchTerrain(true); OnFileLoaded(); }
            DrawVspOptions();

            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                if (GUILayout.Button("Load and check")) LoadAndCheck();
                using (new EditorGUI.DisabledScope(loaded == null || terrain == null))
                    if (GUILayout.Button("Import masks and rules")) Import();
            }

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Scene overlay (read-only)", EditorStyles.boldLabel);
            EditorGUI.BeginChangeCheck();
            overlay = EditorGUILayout.Toggle("Draw zone outlines", overlay);
            labelsAlways = EditorGUILayout.Toggle("Labels at centroid", labelsAlways);
            overlayLift = EditorGUILayout.FloatField("Lift above ground (m)", overlayLift);
            if (EditorGUI.EndChangeCheck()) { overlayFile = null; SceneView.RepaintAll(); }
            if (overlay && loaded != null && terrain == null) EditorGUILayout.HelpBox("Assign the terrain to draw the outlines at ground height.", MessageType.None);

            EditorGUILayout.Space();
            EditorGUILayout.HelpBox(status, MessageType.None);
            EditorGUILayout.EndScrollView();
        }

        // ---- loading -------------------------------------------------------

        void LoadAndCheck()
        {
            loaded = null; overlayFile = null;
            try
            {
                loaded = GolfMapZones.Load(filePath);
                loadedPath = filePath;
                MatchTerrain(false);
                OnFileLoaded();
                status = Summary();
            }
            catch (Exception e)
            {
                status = "Load failed: " + e.Message;
                Debug.LogError("[GolfMap] " + status);
            }
            SceneView.RepaintAll();
        }

        string Summary()
        {
            var sb = new System.Text.StringBuilder();
            int nodes = loaded.zones.Sum(z => z.rings.Sum(r => r.nodes.Count));
            sb.Append("Loaded " + loaded.zones.Count + " zones (" + nodes + " nodes), " + loaded.zoneTypes.Count + " zone types, " + loaded.masks.Count + " mask texture(s) at " + string.Join("/", loaded.masks.Select(m => m.resolution.ToString()).ToArray()) + " px for the " + loaded.plot.terrain + " plot (" + GolfMapZones.F(loaded.plot.sizeM) + " m).");
            foreach (var type in loaded.zoneTypes)
                sb.Append("\n  " + type.key + " (" + (string.IsNullOrEmpty(type.name) ? type.key : type.name) + "): texture " + type.texture + " channel " + "RGBA"[type.channel] + ", " + loaded.zones.Count(z => z.zoneType == type.key) + " zone(s), " + type.items.Count + " item binding(s)");
            sb.Append(terrain ? "\nTerrain: " + terrain.name + TerrainCheck() : "\nNo terrain in the scene matches the plot size. Assign one.");
            var vsp = ""; VspSummary(ref vsp); sb.Append(vsp);
            return sb.ToString();
        }

        string TerrainCheck()
        {
            var size = terrain.terrainData.size;
            var notes = "";
            if (Mathf.Abs(size.x - loaded.plot.sizeM) > 0.5f || Mathf.Abs(size.z - loaded.plot.sizeM) > 0.5f)
                notes += "\nWARNING terrain size " + GolfMapZones.F(size.x) + "x" + GolfMapZones.F(size.z) + " m differs from plot size " + GolfMapZones.F(loaded.plot.sizeM) + " m.";
            if (Mathf.Abs(size.y - (loaded.plot.maxM - loaded.plot.minM)) > 0.5f)
                notes += "\nWARNING terrain height " + GolfMapZones.F(size.y) + " m differs from plot range " + GolfMapZones.F(loaded.plot.maxM - loaded.plot.minM) + " m.";
            if (terrain.transform.rotation != Quaternion.identity || terrain.transform.lossyScale != Vector3.one)
                notes += "\nWARNING terrain must use identity rotation and unit scale.";
            return notes;
        }

        // The terrain whose size equals the plot side, like the tree planter's ValidateTarget:
        // Vreta has a 2050 m inner and a 5000 m outer, so the side alone tells them apart.
        // Keeps a hand-picked terrain unless `force` or it does not fit the plot.
        void MatchTerrain(bool force)
        {
            if (loaded == null) return;
            if (!force && terrain && terrain.terrainData && TerrainFits(terrain)) return;
            var candidates = FindObjectsOfType<Terrain>().Where(t => t.terrainData && t.gameObject.scene.isLoaded && TerrainFits(t))
                .OrderBy(t => t.name.IndexOf(loaded.plot.terrain, StringComparison.OrdinalIgnoreCase) < 0 ? 1 : 0).ThenBy(t => t.name).ToList();
            terrain = candidates.FirstOrDefault();
            if (candidates.Count > 1) Debug.LogWarning("[GolfMap] " + candidates.Count + " terrains match the plot size; picked " + terrain.name + ". Change it in the window if that is wrong.");
        }

        bool TerrainFits(Terrain t)
        {
            var size = t.terrainData.size;
            return Mathf.Abs(size.x - loaded.plot.sizeM) <= 0.5f && Mathf.Abs(size.z - loaded.plot.sizeM) <= 0.5f;
        }

        void ValidateTarget()
        {
            if (loaded == null) throw new Exception("Load and check first.");
            if (!terrain || !terrain.terrainData) throw new Exception("Choose the target terrain.");
            if (!TerrainFits(terrain)) throw new Exception("Zone plot size does not match the target terrain.");
            if (terrain.transform.rotation != Quaternion.identity || terrain.transform.lossyScale != Vector3.one) throw new Exception("Terrain must use identity rotation and unit scale.");
        }

        void Import()
        {
            try
            {
                if (loaded == null || loadedPath != filePath) { loaded = GolfMapZones.Load(filePath); loadedPath = filePath; MatchTerrain(false); OnFileLoaded(); }
                ValidateTarget();
                ImportVsp();
            }
            catch (Exception e)
            {
                status = "Import stopped: " + e.Message;
                Debug.LogException(e);
            }
            overlayFile = null;
            SceneView.RepaintAll();
            Repaint();
        }

        // World position of a plot-local node, on the terrain surface.
        Vector3 WorldPos(float x, float z)
        {
            var origin = terrain.transform.position;
            var flat = origin + new Vector3(x, 0, z);
            return new Vector3(flat.x, terrain.SampleHeight(flat) + origin.y + overlayLift, flat.z);
        }

        // ---- overlay -------------------------------------------------------

        void BuildOverlay()
        {
            overlayZones.Clear();
            overlayTerrain = terrain; overlayFile = loaded;
            if (loaded == null || !terrain) return;
            var colours = loaded.zoneTypes.ToDictionary(t => t.key, t => GolfMapZones.ParseColor(t.color, Color.magenta));
            foreach (var zone in loaded.zones)
            {
                var oz = new OverlayZone { zone = zone, colour = colours[zone.zoneType] };
                foreach (var ring in zone.rings)
                {
                    if (ring.nodes.Count < 2) continue;
                    var pts = new Vector3[ring.nodes.Count + 1];
                    for (int i = 0; i < ring.nodes.Count; i++) pts[i] = WorldPos(ring.nodes[i].x, ring.nodes[i].z);
                    pts[ring.nodes.Count] = pts[0];
                    oz.rings.Add(pts);
                }
                var c = GolfMapZones.Centroid(zone);
                oz.centroid = WorldPos(c.x, c.y) + Vector3.up * 0.5f;
                oz.label = zone.id + "  " + zone.zoneType + (zone.weight != 1 ? "  w " + GolfMapZones.F(zone.weight) : "");
                overlayZones.Add(oz);
            }
        }

        void OnSceneGUI(SceneView view)
        {
            if (!overlay || loaded == null || !terrain) return;
            if (overlayFile != loaded || overlayTerrain != terrain) BuildOverlay();
            var e = Event.current;
            if (e.type == EventType.MouseMove) view.Repaint();   // hover labels follow the mouse
            if (e.type != EventType.Repaint) return;
            var mouse = e.mousePosition;
            OverlayZone hovered = null; float best = 40f;
            foreach (var oz in overlayZones)
            {
                Handles.color = oz.colour;
                foreach (var ring in oz.rings) Handles.DrawAAPolyLine(3f, ring);
                var gui = HandleUtility.WorldToGUIPoint(oz.centroid);
                float d = Vector2.Distance(gui, mouse);
                if (d < best) { best = d; hovered = oz; }
            }
            foreach (var oz in overlayZones)
            {
                if (oz != hovered && !labelsAlways) continue;
                var style = oz == hovered ? EditorStyles.whiteBoldLabel : EditorStyles.whiteMiniLabel;
                Handles.color = oz.colour;
                Handles.DrawSolidDisc(oz.centroid, Vector3.up, oz == hovered ? 1.2f : 0.6f);
                Handles.Label(oz.centroid + Vector3.up * 0.5f, oz.label, style);
            }
        }
    }
}
