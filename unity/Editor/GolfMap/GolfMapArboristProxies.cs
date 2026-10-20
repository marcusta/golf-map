// Scene view proxies for the trees Arborist draws (GolfMap > Trees > Show Arborist proxies, bridge
// golfmap.trees.proxies).
//
// An arborist: placement never goes into the course's VSP: it lives only in
// <export folder>/<prefix>-<terrain>-placements.json and Arborist draws it in GSPro. Here each one is
// drawn as a stand-in - a trunk cylinder and a crown ellipsoid at the placement's height and crown width,
// tinted by species - with Graphics.DrawMeshInstanced for the Scene view camera only. Nothing is a scene
// object: nothing is saved into the scene, nothing reaches a GSPro build.
//
// The proxies are the placements file with the terrain's tree edits laid over it
// (<prefix>-<terrain>-tree-edits.json: a moved, resized, turned, deleted or added Arborist tree shows as
// the next Plant will place it). Both files are watched; a change re-reads them. The Scene view tree
// editor (GolfMapTreeEditor.cs) picks, moves, turns, resizes and deletes proxies, writes the same edit
// records as golfmap.trees.edit, and updates the proxy at once (no replant).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace GolfMap.Editor
{
    [InitializeOnLoad]
    public static class GolfMapArboristProxies
    {
        // One Arborist tree as the Scene view shows it. World metres; rotationY in degrees.
        internal class Proxy
        {
            public string id, model, species;
            public Vector3 position;
            public float rotationY, heightM, crownWidthM;
            public bool edited;   // a tree edit record changed it (or added it) since the placements were written
            public string Label { get { return model != null && model.StartsWith(GolfMapModels.Arborist + ":", StringComparison.Ordinal) ? model.Substring(GolfMapModels.Arborist.Length + 1) : model; } }
        }

#pragma warning disable 0649   // filled by JsonUtility
        [Serializable] class PlacementFile { public string format; public List<Placement> placements; }
        [Serializable] class Placement
        {
            public string id, model, species, renderer;
            public float x, y, z, rotationY, scale, widthScale, heightM, crownWidthM;
        }
#pragma warning restore 0649

        const string PlacementsFormat = "golfmap-placements-v1";
        const string PrefOn = "GolfMap.ArboristProxies.On";
        const string PrefTerrain = "GolfMap.ArboristProxies.Terrain";
        const string MenuPath = "GolfMap/Trees/Show Arborist proxies";

        static readonly List<Proxy> proxies = new List<Proxy>();
        static readonly Dictionary<string, Proxy> byId = new Dictionary<string, Proxy>();
        static string placementsPath, editsPath, status = "";
        static DateTime placementsTime, editsTime;
        static int editedCount, deletedCount;
        static bool loadedOnce, batchesDirty = true;
        static double nextPoll;

        static Mesh sphere, cylinder;
        static Material trunkMaterial;
        static readonly Dictionary<string, Material> crownMaterials = new Dictionary<string, Material>();
        // species -> crown matrices, in chunks of at most 1023 (DrawMeshInstanced's limit); trunks in one list.
        static readonly Dictionary<string, List<Matrix4x4[]>> crownBatches = new Dictionary<string, List<Matrix4x4[]>>();
        static readonly List<Matrix4x4[]> trunkBatches = new List<Matrix4x4[]>();

        static GolfMapArboristProxies()
        {
            Camera.onPreCull -= PreCull;
            Camera.onPreCull += PreCull;
            EditorApplication.update -= Poll;
            EditorApplication.update += Poll;
            EditorSceneManager.sceneOpened -= SceneOpened;
            EditorSceneManager.sceneOpened += SceneOpened;
        }

        // ---- state ---------------------------------------------------------

        public static bool On { get { return EditorPrefs.GetBool(PrefOn, false); } }
        public static string TerrainRole { get { var t = EditorPrefs.GetString(PrefTerrain, "inner"); return t == "outer" ? "outer" : "inner"; } }
        internal static IList<Proxy> All { get { EnsureLoaded(); return proxies; } }
        internal static string Status { get { return status; } }

        internal static Proxy Find(string id)
        {
            EnsureLoaded();
            Proxy p; return id != null && byId.TryGetValue(id, out p) ? p : null;
        }

        public static void Set(bool on, string terrain)
        {
            if (terrain != null && terrain != "inner" && terrain != "outer") throw new InvalidOperationException("terrain must be inner or outer.");
            bool reload = terrain != null && terrain != TerrainRole;
            EditorPrefs.SetBool(PrefOn, on);
            if (terrain != null) EditorPrefs.SetString(PrefTerrain, terrain);
            if (on && (reload || !loadedOnce)) Reload();
            Menu.SetChecked(MenuPath, on);
            SceneView.RepaintAll();
        }

        // The tree editor changed a proxy in place: redraw it.
        internal static void Changed() { batchesDirty = true; SceneView.RepaintAll(); }

        internal static void Remove(string id)
        {
            Proxy p; if (id == null || !byId.TryGetValue(id, out p)) return;
            byId.Remove(id); proxies.Remove(p); deletedCount++;
            Changed();
        }

        internal static void Add(Proxy p)
        {
            if (byId.ContainsKey(p.id)) return;
            byId.Add(p.id, p); proxies.Add(p);
            Changed();
        }

        // The tree editor wrote the edits file itself: the proxies already show it, no re-read.
        internal static void EditsWritten(string path)
        {
            if (editsPath != null && path != null && Path.GetFullPath(path) == Path.GetFullPath(editsPath) && File.Exists(editsPath))
                editsTime = File.GetLastWriteTimeUtc(editsPath);
        }

        // ---- menu and bridge -----------------------------------------------

        [MenuItem(MenuPath)]
        static void ToggleMenu() { Set(!On, null); Debug.Log("[GolfMap] Arborist proxies " + (On ? "on: " + status : "off.")); }

        [MenuItem(MenuPath, true)]
        static bool ToggleMenuValidate() { Menu.SetChecked(MenuPath, On); return true; }

        [BridgeCommand("golfmap.trees.proxies", "Scene view proxies for the trees Arborist draws (arborist: placements of <prefix>-<terrain>-placements.json with the terrain's tree edits laid over): a trunk and a crown at the placement's height and crown width, tinted by species, drawn for the Scene view camera only (no scene objects, nothing saved or built). on=true|false turns them on or off (omit to keep; the menu GolfMap > Trees > Show Arborist proxies is the same switch); terrain picks the placements file; reload=true re-reads it (it is re-read by itself when the placements or edits file changes). x, z (world metres) with radius list the proxies near that point. The Scene view tree editor selects, moves, turns, resizes and deletes them (tree edit records, no replant).",
            args = "on (omit to keep), terrain=inner|outer (omit to keep), reload=false, x, z, radius=15")]
        static object ProxiesCommand(BridgeArgs a)
        {
            string terrain = a.Has("terrain") ? a.String("terrain") : null;
            bool on = a.Has("on") ? a.Bool("on", true) : On;
            Set(on, terrain);
            if (a.Bool("reload", false) || (on && !loadedOnce)) Reload();
            var result = new Dictionary<string, object>
            {
                { "on", On }, { "terrain", TerrainRole }, { "placements", placementsPath }, { "edits", editsPath },
                { "count", proxies.Count }, { "edited", editedCount }, { "deleted", deletedCount }, { "status", status },
            };
            if (a.Has("x") && a.Has("z"))
            {
                float x = (float)a.Number("x", 0), z = (float)a.Number("z", 0), r = (float)a.Number("radius", 15);
                result["near"] = proxies.Where(p => Sq(p.position.x - x) + Sq(p.position.z - z) <= r * r)
                    .OrderBy(p => Sq(p.position.x - x) + Sq(p.position.z - z))
                    .Select(p => (object)new Dictionary<string, object>
                    {
                        { "id", p.id }, { "model", p.model }, { "species", p.species }, { "x", Round(p.position.x) }, { "y", Round(p.position.y) }, { "z", Round(p.position.z) },
                        { "rotationY", Round(p.rotationY) }, { "heightM", Round(p.heightM) }, { "crownWidthM", Round(p.crownWidthM) }, { "edited", p.edited },
                    }).ToList();
            }
            return result;
        }

        // A hand drag in the Scene view, as mouse events: click the proxy (the tree editor selects it), then pull the
        // move handle's red arrow dx metres along x. The tree editor must be editing this terrain's trees.
        [BridgeCommand("golfmap.trees.proxies.drag", "Drags one Arborist proxy in the Scene view the way a hand does it, with mouse events sent to the Scene view: a click on the proxy (the tree editor selects it), then the move handle's x arrow pulled dx metres. The Scene view tree editor must be editing (GolfMap > Tree Editor, its object selected) and the proxies on for its terrain; the view is framed on the tree first. What the editor records is what a hand drag records: the tree edit in <prefix>-<terrain>-tree-edits.json. Returns the proxy before and after, the selection and the editor's status.",
            args = "id (tree id), dx (metres along world x)")]
        static IEnumerator DragCommand(BridgeArgs a)
        {
            var id = a.Require("id");
            float dx = (float)a.Number("dx", double.NaN);
            if (float.IsNaN(dx)) throw new BridgeError("Give dx (metres).");
            var p = Find(id);
            if (p == null) throw new BridgeError("No proxy " + id + " (are the proxies on for the right terrain?).");
            var host = UnityEngine.Object.FindObjectsOfType<GolfMapTrees>().FirstOrDefault(c => (c.role == GolfMapTrees.Role.Outer ? "outer" : "inner") == TerrainRole);
            if (!host) throw new BridgeError("No GolfMap Trees component for the " + TerrainRole + " terrain.");
            var planter = GolfMapTreePlanter.For(host);
            if (!planter.Editing) throw new BridgeError("The tree editor is not editing: GolfMap > Tree Editor first.");
            var sv = SceneView.lastActiveSceneView;
            if (sv == null) throw new BridgeError("No Scene view is open.");
            Selection.activeGameObject = host.gameObject;
            Tools.current = Tool.Move;
            var before = p.position;
            sv.LookAtDirect(p.position + Vector3.up, Quaternion.Euler(50, 0, 0), 14f);
            for (int i = 0; i < 6; i++) { sv.Repaint(); yield return null; }

            var cam = sv.camera;
            Vector3 stem = p.position + Vector3.up * Mathf.Max(0.5f, p.heightM * 0.3f);
            var click = Gui(sv, stem) + new Vector2(0, SentEventOffsetY);
            Send(sv, EventType.MouseDown, click); Send(sv, EventType.MouseUp, click);
            for (int i = 0; i < 4; i++) { sv.Repaint(); yield return null; }
            bool grabbed = false;
            if (!planter.SelectedProxyIds.Contains(id)) throw new BridgeError("The click did not select the proxy (another tree nearer the mouse?).");
            // HandleUtility.GetHandleSize for this camera: the x arrow ends that far from the centre.
            var t = cam.transform;
            float z = Vector3.Dot(p.position - t.position, t.forward);
            float screen = (cam.WorldToScreenPoint(t.position + t.forward * z) - cam.WorldToScreenPoint(t.position + t.forward * z + t.right)).magnitude;
            float handle = 80f / Mathf.Max(screen, 0.0001f) * EditorGUIUtility.pixelsPerPoint;
            var grab = p.position + Vector3.right * handle * 0.8f;
            // The arrow is a few points wide: try the near offsets too until it takes the mouse.
            foreach (var oy in new[] { SentEventOffsetY, SentEventOffsetY - 6, SentEventOffsetY + 6, 0f })
            {
                var at = Gui(sv, grab) + new Vector2(0, oy);
                Send(sv, EventType.MouseDown, at);
                if (GUIUtility.hotControl != 0) { grabbed = true; break; }
                Send(sv, EventType.MouseUp, at);
            }
            if (!grabbed) throw new BridgeError("The move handle did not take the mouse; the proxy stays where it was.");
            var last = Gui(sv, grab);
            for (int step = 1; step <= 5; step++)
            {
                var next = Gui(sv, grab + Vector3.right * dx * step / 5f);
                Send(sv, EventType.MouseDrag, next, next - last);   // the slider follows the event's delta
                last = next;
                sv.Repaint(); yield return null;
            }
            Send(sv, EventType.MouseUp, last);
            for (int i = 0; i < 4; i++) { sv.Repaint(); yield return null; }
            var after = Find(id);
            yield return new Dictionary<string, object>
            {
                { "id", id }, { "before", new[] { Round(before.x), Round(before.y), Round(before.z) } },
                { "after", after == null ? null : new[] { Round(after.position.x), Round(after.position.y), Round(after.position.z) } },
                { "edited", after != null && after.edited }, { "grabbed", grabbed }, { "status", planter.EditStatus }, { "edits", editsPath },
            };
        }

        // A sent event's window position sits one tab header (about 17 points) below the Scene view's own GUI
        // position in 2018.2 (measured: the arrow took the mouse there).
        const float SentEventOffsetY = 17f;

        // A world point as the Scene view window's GUI position (below its toolbar).
        static Vector2 Gui(SceneView sv, Vector3 world)
        {
            var cam = sv.camera;
            var s = cam.WorldToScreenPoint(world);
            float ppp = EditorGUIUtility.pixelsPerPoint;
            return new Vector2(s.x / ppp, (cam.pixelHeight - s.y) / ppp + (sv.position.height - cam.pixelHeight / ppp));
        }

        static void Send(SceneView sv, EventType type, Vector2 at, Vector2 delta = default(Vector2))
        {
            sv.SendEvent(new Event { type = EventType.Layout, mousePosition = at });
            sv.SendEvent(new Event { type = type, mousePosition = at, delta = delta, button = 0, clickCount = 1 });
        }

        static float Sq(float v) { return v * v; }
        static double Round(float v) { return Math.Round(v, 3); }

        // ---- loading -------------------------------------------------------

        static void EnsureLoaded() { if (!loadedOnce) Reload(); }

        static void SceneOpened(UnityEngine.SceneManagement.Scene scene, OpenSceneMode mode) { loadedOnce = false; if (On) Reload(); }

        static void Poll()
        {
            if (!On || EditorApplication.timeSinceStartup < nextPoll) return;
            nextPoll = EditorApplication.timeSinceStartup + 1.0;
            if (!loadedOnce) { Reload(); SceneView.RepaintAll(); return; }
            if (FileChanged(placementsPath, placementsTime) || FileChanged(editsPath, editsTime)) { Reload(); SceneView.RepaintAll(); }
        }

        static bool FileChanged(string path, DateTime seen)
        {
            if (string.IsNullOrEmpty(path)) return false;
            var now = File.Exists(path) ? File.GetLastWriteTimeUtc(path) : DateTime.MinValue;
            return now != seen;
        }

        internal static void Reload()
        {
            loadedOnce = true; batchesDirty = true;
            proxies.Clear(); byId.Clear(); editedCount = deletedCount = 0;
            placementsPath = editsPath = null; placementsTime = editsTime = DateTime.MinValue;
            try
            {
                var course = GolfMapCourses.Active();
                if (!course) { status = "No GolfMap course claims this scene."; return; }
                string role = TerrainRole;
                placementsPath = GolfMapCourses.ExportFile(course, role, "placements");
                if (placementsPath == null) { status = "The course has no export folder."; return; }
                var component = UnityEngine.Object.FindObjectsOfType<GolfMapTrees>()
                    .FirstOrDefault(c => (c.role == GolfMapTrees.Role.Outer ? "outer" : "inner") == role && (!c.course || c.course == course));
                string treesFile = component && !string.IsNullOrEmpty(component.filePath) ? component.filePath : GolfMapCourses.TreesFile(course, role);
                if (!string.IsNullOrEmpty(treesFile)) editsPath = GolfMapTreeEdits.PathFor(treesFile);
                var terrain = component && component.terrain ? component.terrain : FindTerrain(role == "outer" ? course.outerTerrainName : course.innerTerrainName);
                if (!File.Exists(placementsPath)) { status = "No placements file yet (plant the " + role + " trees): " + placementsPath; return; }
                placementsTime = File.GetLastWriteTimeUtc(placementsPath);
                var file = JsonUtility.FromJson<PlacementFile>(File.ReadAllText(placementsPath).TrimStart('﻿'));
                if (file == null || file.format != PlacementsFormat || file.placements == null) { status = "Not a " + PlacementsFormat + " file: " + placementsPath; return; }
                var all = new Dictionary<string, Placement>();
                foreach (var p in file.placements)
                {
                    if (p == null || string.IsNullOrEmpty(p.id)) continue;
                    all[p.id] = p;
                    if (p.renderer != GolfMapModels.Arborist || byId.ContainsKey(p.id)) continue;
                    var proxy = new Proxy
                    {
                        id = p.id, model = p.model, species = p.species ?? "", position = new Vector3(p.x, p.y, p.z),
                        rotationY = p.rotationY, heightM = p.heightM, crownWidthM = p.crownWidthM,
                    };
                    byId.Add(proxy.id, proxy); proxies.Add(proxy);
                }
                string editsNote = "";
                if (editsPath != null && File.Exists(editsPath))
                {
                    editsTime = File.GetLastWriteTimeUtc(editsPath);
                    try { Overlay(GolfMapTreeEdits.Load(editsPath), all, terrain); editsNote = ", tree edits " + Path.GetFileName(editsPath) + " laid over (" + editedCount + " changed or added, " + deletedCount + " deleted)"; }
                    catch (Exception e) { editsNote = "; tree edits not laid over: " + e.Message; Debug.LogWarning("[GolfMap] Arborist proxies: " + e.Message); }
                }
                status = proxies.Count + " Arborist trees from " + Path.GetFileName(placementsPath) + editsNote + ".";
            }
            catch (Exception e) { status = "Arborist proxies not loaded: " + e.Message; Debug.LogException(e); }
        }

        static Terrain FindTerrain(string name)
        {
            return string.IsNullOrEmpty(name) ? null : UnityEngine.Object.FindObjectsOfType<Terrain>().FirstOrDefault(t => t.name == name);
        }

        static float GroundHeight(Terrain terrain, Vector3 world, float fallback)
        {
            if (!terrain || !terrain.terrainData) return fallback;
            return terrain.SampleHeight(world) + terrain.transform.position.y;
        }

        // The edit records over the placements, as the next Plant would place the Arborist trees: a delete hides
        // the proxy, a modify moves, sizes and turns it, an added Arborist tree gets one. A record that names a vsp
        // model takes the tree out of Arborist's hands. A moved tree keeps its height above the terrain.
        static void Overlay(GolfMapTreeEditFile edits, Dictionary<string, Placement> placements, Terrain terrain)
        {
            var origin = terrain ? terrain.transform.position : Vector3.zero;
            foreach (var e in edits.edits)
            {
                Proxy p; byId.TryGetValue(e.id, out p);
                if (e.op == "delete") { if (p != null) { byId.Remove(e.id); proxies.Remove(p); deletedCount++; } continue; }
                bool namesArborist = e.model.StartsWith(GolfMapModels.Arborist + ":", StringComparison.Ordinal);
                if (!string.IsNullOrEmpty(e.model) && !namesArborist) { if (p != null) { byId.Remove(e.id); proxies.Remove(p); } continue; }
                if (p == null && !namesArborist) continue;   // a vsp tree's edit (the biome decides its model)
                var world = new Vector3(origin.x + e.x, 0, origin.z + e.z);
                if (p == null)
                {
                    // Turned into an Arborist tree, or added, since the placements were written.
                    Placement was; placements.TryGetValue(e.id, out was);
                    world.y = e.ySet ? e.y : was != null && Mathf.Abs(was.x - world.x) < 0.02f && Mathf.Abs(was.z - world.z) < 0.02f ? was.y : GroundHeight(terrain, world, origin.y) + e.dy;
                    p = new Proxy { id = e.id, position = world, rotationY = was != null ? was.rotationY : 0, heightM = e.h, crownWidthM = 2 * e.r, edited = true };
                    byId.Add(p.id, p); proxies.Add(p);
                }
                else if (Mathf.Abs(p.position.x - world.x) > 0.02f || Mathf.Abs(p.position.z - world.z) > 0.02f)
                {
                    world.y = p.position.y + GroundHeight(terrain, world, p.position.y) - GroundHeight(terrain, p.position, p.position.y);
                    p.position = world; p.edited = true;
                }
                if (e.ySet) p.position.y = e.y;
                if (namesArborist && e.model != p.model) { p.model = e.model; p.edited = true; }
                if (!string.IsNullOrEmpty(e.species)) p.species = e.species;
                if (e.sized && (Mathf.Abs(p.heightM - e.h) > 0.01f || Mathf.Abs(p.crownWidthM - 2 * e.r) > 0.01f)) { p.heightM = e.h; p.crownWidthM = 2 * e.r; p.edited = true; }
                if (e.rotationSet && Mathf.Abs(Mathf.DeltaAngle(p.rotationY, e.rotation)) > 0.01f) { p.rotationY = e.rotation; p.edited = true; }
                if (p.edited) editedCount++;
            }
        }

        // ---- drawing -------------------------------------------------------

        static void PreCull(Camera cam)
        {
            if (!cam || cam.cameraType != CameraType.SceneView || !On) return;
            EnsureLoaded();
            if (proxies.Count == 0 || !EnsureResources()) return;
            if (batchesDirty) Rebuild();
            foreach (var kv in crownBatches)
            {
                var material = CrownMaterial(kv.Key);
                foreach (var chunk in kv.Value) Graphics.DrawMeshInstanced(sphere, 0, material, chunk, chunk.Length, null, ShadowCastingMode.Off, false, 0, cam);
            }
            foreach (var chunk in trunkBatches) Graphics.DrawMeshInstanced(cylinder, 0, trunkMaterial, chunk, chunk.Length, null, ShadowCastingMode.Off, false, 0, cam);
        }

        static bool EnsureResources()
        {
            if (!sphere || !cylinder)
            {
                var s = GameObject.CreatePrimitive(PrimitiveType.Sphere); s.hideFlags = HideFlags.HideAndDontSave;
                var c = GameObject.CreatePrimitive(PrimitiveType.Cylinder); c.hideFlags = HideFlags.HideAndDontSave;
                sphere = s.GetComponent<MeshFilter>().sharedMesh; cylinder = c.GetComponent<MeshFilter>().sharedMesh;
                UnityEngine.Object.DestroyImmediate(s); UnityEngine.Object.DestroyImmediate(c);
            }
            if (!trunkMaterial) { trunkMaterial = NewMaterial(new Color(0.36f, 0.25f, 0.16f)); crownMaterials.Clear(); }
            return sphere && cylinder && trunkMaterial;
        }

        static Material NewMaterial(Color colour)
        {
            var shader = Shader.Find("Standard");
            if (!shader) return null;
            var m = new Material(shader) { hideFlags = HideFlags.HideAndDontSave, enableInstancing = true, color = colour };
            m.SetFloat("_Glossiness", 0.05f);
            return m;
        }

        static Material CrownMaterial(string species)
        {
            Material m;
            if (crownMaterials.TryGetValue(species, out m) && m) return m;
            m = NewMaterial(SpeciesColour(species)) ?? trunkMaterial;
            crownMaterials[species] = m;
            return m;
        }

        static readonly Dictionary<string, Color> Known = new Dictionary<string, Color>
        {
            { "beech", new Color(0.42f, 0.62f, 0.20f) }, { "oak", new Color(0.30f, 0.50f, 0.18f) }, { "deadoak", new Color(0.55f, 0.47f, 0.40f) },
            { "elm", new Color(0.22f, 0.55f, 0.30f) }, { "poplar", new Color(0.62f, 0.75f, 0.25f) }, { "birch", new Color(0.70f, 0.80f, 0.35f) },
            { "pine", new Color(0.12f, 0.36f, 0.26f) }, { "conifer", new Color(0.10f, 0.30f, 0.32f) }, { "spruce", new Color(0.08f, 0.28f, 0.22f) },
            { "bush", new Color(0.48f, 0.52f, 0.16f) }, { "fern", new Color(0.35f, 0.72f, 0.30f) }, { "water_lily", new Color(0.92f, 0.55f, 0.75f) },
            { "bur_reed", new Color(0.70f, 0.70f, 0.30f) }, { "bulrush", new Color(0.58f, 0.45f, 0.25f) }, { "yellow_flag", new Color(0.95f, 0.85f, 0.20f) },
        };

        internal static Color SpeciesColour(string species)
        {
            Color c;
            if (species != null && Known.TryGetValue(species, out c)) return c;
            int h = 17; foreach (var ch in species ?? "") h = h * 31 + ch;
            return Color.HSVToRGB(Mathf.Repeat(h * 0.61803f, 1f), 0.55f, 0.75f);
        }

        // The proxy's shape: a crown ellipsoid (centre, size) and a trunk (base, height, diameter; height 0 = none).
        // A plant under 0.3 m (a lily pad) is a flat disc; one under 4 m or about as wide as tall (a bush, a reed
        // clump) is a crown from the ground up; a conifer's crown is long and narrow.
        internal static void Shape(Proxy p, out Vector3 crownCentre, out Vector3 crownSize, out float trunkH, out float trunkD)
        {
            float h = Mathf.Max(p.heightM, 0f), w = Mathf.Max(p.crownWidthM, 0.3f);
            trunkH = 0; trunkD = 0;
            if (h < 0.3f) { crownSize = new Vector3(w, Mathf.Max(h, 0.08f), w); crownCentre = p.position + Vector3.up * crownSize.y / 2; return; }
            if (h < 4f || h < w * 0.9f) { crownSize = new Vector3(w, h, w); crownCentre = p.position + Vector3.up * h / 2; return; }
            string s = p.species ?? "";
            bool conifer = s == "pine" || s == "conifer" || s == "spruce" || s == "fir";
            float crownH = h * (conifer ? 0.82f : 0.64f);
            crownSize = new Vector3(w, crownH, w);
            crownCentre = p.position + Vector3.up * (h - crownH / 2);
            trunkH = h - crownH * 0.5f;
            trunkD = Mathf.Clamp(w * 0.06f, 0.15f, 1.2f);
        }

        static void Rebuild()
        {
            batchesDirty = false;
            crownBatches.Clear(); trunkBatches.Clear();
            var crowns = new Dictionary<string, List<Matrix4x4>>();
            var trunks = new List<Matrix4x4>();
            foreach (var p in proxies)
            {
                Vector3 centre, size; float trunkH, trunkD;
                Shape(p, out centre, out size, out trunkH, out trunkD);
                var yaw = Quaternion.Euler(0, p.rotationY, 0);
                List<Matrix4x4> list;
                if (!crowns.TryGetValue(p.species ?? "", out list)) crowns[p.species ?? ""] = list = new List<Matrix4x4>();
                list.Add(Matrix4x4.TRS(centre, yaw, size));
                // Unity's cylinder is 2 m tall and 1 m across, centred on its origin.
                if (trunkH > 0) trunks.Add(Matrix4x4.TRS(p.position + Vector3.up * trunkH / 2, yaw, new Vector3(trunkD, trunkH / 2, trunkD)));
            }
            foreach (var kv in crowns) crownBatches[kv.Key] = Chunk(kv.Value);
            trunkBatches.AddRange(Chunk(trunks));
        }

        static List<Matrix4x4[]> Chunk(List<Matrix4x4> all)
        {
            var chunks = new List<Matrix4x4[]>();
            for (int i = 0; i < all.Count; i += 1023) chunks.Add(all.GetRange(i, Math.Min(1023, all.Count - i)).ToArray());
            return chunks;
        }
    }
}
