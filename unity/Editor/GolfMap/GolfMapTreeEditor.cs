// Scene-view editor for planted trees (PersistentStorage mode).
//
// Started from the GolfMap Trees Inspector (or GolfMap > Tree Editor). While
// that object is selected its Inspector shows the controls and its Editor
// draws the handles (GolfMapTreesInspector.cs); the session survives selecting
// something else and coming back. Click a tree in the Scene view to select it
// (shift adds), then move it with the position handle, rotate with the disc,
// resize with the scale cube above the crown, or change species/asset, height
// and radius in the Inspector. Delete removes the selection; "Click adds a
// tree" places new ones on the ground.
//
// Every change is applied to VSP storage at once and recorded in the edits
// file next to the survey (GolfMapTreeEdits.cs), so replanting keeps it.
// No Unity undo: use "Reset selected to survey" or the planting backups.
//
// Trees Arborist draws are not in VSP; with the Arborist proxies on for this
// terrain (GolfMapArboristProxies.cs) their stand-ins are picked, moved, turned,
// resized and deleted here the same way. Such a change is only an edit record
// (golfmap.trees.edit's: position, a drawn size with the model kept, rotation,
// delete) and the proxy follows at once; the next Plant and Arborist export
// carry it into GSPro.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using AwesomeTechnologies.VegetationSystem;
using AwesomeTechnologies.Vegetation.PersistentStorage;
using Mode = GolfMap.GolfMapTrees.Mode;

namespace GolfMap.Editor
{
    public partial class GolfMapTreePlanter
    {
        class EditorTree
        {
            public GolfMapTree tree;
            public GameObject prefab;
            public string itemId;
            public Vector3 position, scale;   // as stored in VSP (world space)
            public Quaternion rotation;
            public float yaw;                 // rotation about Y; rotation adds the match's lean
            public bool stored;               // instance found in VSP storage
            public int cellIndex = -1;        // VSP cell holding the instance (-1 unknown)
        }

        bool addMode { get { return T.addMode; } set { T.addMode = value; } }
        string addSpecies { get { return T.addSpecies; } set { T.addSpecies = value; } }
        float addHeight { get { return T.addHeight; } set { T.addHeight = value; } }
        float addRadius { get { return T.addRadius; } set { T.addRadius = value; } }
        bool showStems { get { return T.showStems; } set { T.showStems = value; } }
        bool editing;
        internal bool Editing { get { return editing; } }
        readonly Dictionary<string, EditorTree> index = new Dictionary<string, EditorTree>();
        readonly List<string> selection = new List<string>();
        readonly Dictionary<GameObject, Proto> editProtoCache = new Dictionary<GameObject, Proto>();
        GroundProbe editProbe;
        VegetationSystemPro editSystem;
        PersistentVegetationStoragePackage editPackage;
        string editStatus = "";
        // Fields for the selected tree in the window.
        float fieldH, fieldR, fieldRot, fieldDy; string fieldSpecies = "", fieldGuid = ""; string fieldsFor = "";
        // Drag state (handles): live gizmo, commit on mouse up.
        bool dragMove, dragRotate, dragScale; float dragFactorH = 1, dragFactorW = 1;
        readonly Dictionary<string, Vector3> dragBaseScale = new Dictionary<string, Vector3>();
        static readonly Color StemColour = new Color(0.3f, 1f, 0.4f, 0.35f);
        static readonly Color SelectedColour = new Color(1f, 0.85f, 0.1f, 1f);
        // Selected Arborist proxies by tree id (never together with VSP trees), their drag start and the Inspector fields.
        readonly List<string> proxySelection = new List<string>();
        readonly Dictionary<string, Vector3> proxyDragStart = new Dictionary<string, Vector3>();
        readonly Dictionary<string, Vector2> proxyDragSize = new Dictionary<string, Vector2>();   // drawn height, crown width
        float proxyFieldH, proxyFieldW, proxyFieldRot; string proxyFieldsFor = "";

        void OnDisable() { StopEditing(); }

        [MenuItem("GolfMap/Tree Editor")]
        public static void OpenTreeEditor()
        {
            var p = Select();
            if (!p.editing) p.StartEditing();
        }
        partial void OnFileReloaded() { if (editing) { StopEditing(); editStatus = "Editing stopped: the trees file was reloaded. Start again to continue."; } }

        partial void DrawTreeEditor()
        {
            if (mode != Mode.PersistentStorage) return;
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Tree editor (Scene view)", EditorStyles.boldLabel);
            if (!editing)
            {
                using (new EditorGUI.DisabledScope(!terrain || string.IsNullOrEmpty(filePath) || !useBiome))
                    if (GUILayout.Button("Start editing planted trees")) StartEditing();
                if (!useBiome) EditorGUILayout.HelpBox("The editor needs the biome palette (species and asset choices).", MessageType.None);
                if (!string.IsNullOrEmpty(editStatus)) EditorGUILayout.HelpBox(editStatus, MessageType.Info);
                return;
            }
            if (GUILayout.Button("Stop editing")) { StopEditing(); return; }
            EditorGUILayout.HelpBox("Editing in the Scene view while this object is selected. Selecting something else pauses the editor; select \"" + component.name + "\" again to continue.", MessageType.None);
            showStems = EditorGUILayout.Toggle("Show stems near camera", showStems);
            bool proxiesOn = EditorGUILayout.Toggle(new GUIContent("Arborist proxies", "Stand-ins for the trees Arborist draws (GolfMap > Trees > Show Arborist proxies); pick and edit them like VSP trees."), ProxiesHere);
            if (proxiesOn != ProxiesHere) { GolfMapArboristProxies.Set(proxiesOn, RoleKey); proxySelection.Clear(); }
            addMode = EditorGUILayout.Toggle("Click adds a tree", addMode);
            var tool = Tools.current == Tool.Rotate ? Tool.Rotate : Tools.current == Tool.Scale ? Tool.Scale : Tool.Move;
            using (new EditorGUILayout.HorizontalScope())
            {
                EditorGUILayout.PrefixLabel("Tool");
                int current = tool == Tool.Move ? 0 : tool == Tool.Rotate ? 1 : 2;
                int picked = GUILayout.Toolbar(current, new[] { "Move (W)", "Rotate (E)", "Scale (R)" });
                if (picked != current) { Tools.current = picked == 0 ? Tool.Move : picked == 1 ? Tool.Rotate : Tool.Scale; SceneView.RepaintAll(); }
            }
            var species = SpeciesList();
            if (addMode)
            {
                int si = Mathf.Max(0, species.IndexOf(addSpecies));
                si = EditorGUILayout.Popup("Species", si, species.ToArray());
                addSpecies = species.Count > 0 ? species[si] : "";
                addHeight = EditorGUILayout.FloatField("Height (m)", addHeight);
                addRadius = EditorGUILayout.FloatField("Crown radius (m)", addRadius);
            }
            if (proxySelection.Count > 0) DrawProxyFields();
            else EditorGUILayout.LabelField("Selected", selection.Count + " tree(s)");
            if (selection.Count == 1)
            {
                var et = index[selection[0]];
                if (fieldsFor != et.tree.id) LoadFields(et);
                EditorGUILayout.LabelField("Id", et.tree.id);
                EditorGUILayout.LabelField("Asset", et.prefab ? et.prefab.name : "(none)");
                EditorGUILayout.LabelField("Position", "x " + (et.tree.x).ToString("0.0", CultureInfo.InvariantCulture) + "  z " + et.tree.z.ToString("0.0", CultureInfo.InvariantCulture) + "  (scale h " + et.scale.y.ToString("0.00", CultureInfo.InvariantCulture) + ", w " + et.scale.x.ToString("0.00", CultureInfo.InvariantCulture) + ")");
                fieldH = EditorGUILayout.FloatField("Height (m)", fieldH);
                fieldR = EditorGUILayout.FloatField("Crown radius (m)", fieldR);
                fieldRot = EditorGUILayout.FloatField("Rotation (deg)", fieldRot);
                fieldDy = EditorGUILayout.FloatField("Ground offset (m)", fieldDy);
                var speciesChoices = new List<string> { "(auto)" }; speciesChoices.AddRange(species);
                int sIndex = Mathf.Max(0, speciesChoices.IndexOf(fieldSpecies));
                sIndex = EditorGUILayout.Popup("Species", sIndex, speciesChoices.ToArray());
                string newSpecies = sIndex == 0 ? "" : speciesChoices[sIndex];
                if (newSpecies != fieldSpecies) { fieldSpecies = newSpecies; fieldGuid = ""; }
                var assets = biome.assets.Where(a => a.enabled && (string.IsNullOrEmpty(fieldSpecies) || a.species == fieldSpecies)).OrderBy(a => a.name).ToList();
                var assetChoices = new List<string> { "(auto)" }; assetChoices.AddRange(assets.Select(a => a.name));
                int aIndex = Mathf.Max(0, assets.FindIndex(a => a.MatchKey == fieldGuid) + 1);
                aIndex = EditorGUILayout.Popup("Asset", aIndex, assetChoices.ToArray());
                fieldGuid = aIndex == 0 ? "" : assets[aIndex - 1].MatchKey;
                using (new EditorGUILayout.HorizontalScope())
                {
                    if (GUILayout.Button("Apply")) ApplyFields(et);
                    if (GUILayout.Button("Reset to survey")) ResetSelected();
                    if (GUILayout.Button("Delete")) DeleteSelected();
                }
            }
            else if (selection.Count > 1)
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    if (GUILayout.Button("Reset to survey")) ResetSelected();
                    if (GUILayout.Button("Delete")) DeleteSelected();
                }
            }
            int stored = index.Values.Count(t => t.stored), missing = index.Count - stored;
            EditorGUILayout.LabelField("Indexed", stored + " planted" + (missing > 0 ? ", " + missing + " not found in storage (replant to edit them)" : ""));
            EditorGUILayout.LabelField("Edits file", Path.GetFileName(editsPath) + " (" + (editFile != null ? editFile.edits.Count : 0) + " records)");
            EditorGUILayout.HelpBox("Click a tree to select, shift-click to add. W: move (arrows; x/z snap to ground on release, the green arrow sets a ground offset). E: rotate (red disc). R: scale (green = height, red/blue = crown radius, centre = both). Delete key removes. Esc clears the selection. Changes go to VSP storage and the edits file immediately; there is no Unity undo.", MessageType.None);
            if (!string.IsNullOrEmpty(editStatus)) EditorGUILayout.HelpBox(editStatus, MessageType.Info);
        }

        List<string> SpeciesList()
        {
            return biome == null ? new List<string>() : biome.assets.Where(a => a.enabled && !string.IsNullOrEmpty(a.species)).Select(a => a.species).Distinct().OrderBy(s => s, StringComparer.Ordinal).ToList();
        }

        void LoadFields(EditorTree et)
        {
            fieldsFor = et.tree.id; fieldH = et.tree.h; fieldR = et.tree.r; fieldRot = et.yaw;
            GolfMapTreeEdit edit; treeEdits.TryGetValue(et.tree, out edit);
            fieldSpecies = edit != null ? edit.species : ""; fieldGuid = edit != null ? edit.guid : ""; fieldDy = edit != null ? edit.dy : 0;
        }

        // ---- lifecycle -----------------------------------------------------

        internal void StartEditing()
        {
            if (editing) return;
            try
            {
                LoadFile(); if (loaded == null) throw new Exception(status);
                ValidateTarget();
                if (mode != Mode.PersistentStorage) throw new Exception("The editor works with PersistentStorage mode.");
                var report = PrepareBiome();
                if (!storage) throw new Exception("Select the planted storage first.");
                if (!StorageMatchesTerrain(storage, terrain)) throw new Exception(StorageMismatchDetails(storage, terrain));
                CheckStorageReady(out editSystem, out editPackage);
                editProbe = new GroundProbe(terrain, forceBillboards ? new List<GameObject>() : groundMeshes);
                editProtoCache.Clear();
                var catalog = editSystem.VegetationPackageProList.FirstOrDefault(p => p && p.PackageName == CatalogName);
                var itemIds = new Dictionary<GameObject, string>();
                if (catalog) foreach (var item in catalog.VegetationInfoList) if (item.VegetationPrefab && !itemIds.ContainsKey(item.VegetationPrefab)) itemIds.Add(item.VegetationPrefab, item.VegetationItemID);
                index.Clear(); selection.Clear();
                int meshHits = 0, terrainHits = 0, clamped = 0, stored = 0;
                foreach (var tree in loaded.trees)
                {
                    if (!InsidePlot(tree) || tree.h < minHeightM) continue;
                    var p = PrepareOne(tree, editProbe, editProtoCache, ref meshHits, ref terrainHits, ref clamped);
                    if (!p.prefab) continue;
                    var et = new EditorTree { tree = tree, prefab = p.prefab, position = p.position, scale = p.scale, rotation = p.rotation, yaw = p.yaw };
                    ResolveCell(editSystem, ref et.position);
                    string itemId; if (itemIds.TryGetValue(p.prefab, out itemId)) { et.itemId = itemId; et.stored = FindInstance(et) >= 0; }
                    if (et.stored) stored++;
                    index.Add(tree.id, et);
                }
                editing = true; showSetup = false;
                Tools.hidden = true;   // no transform gizmo for the host object while editing
                editStatus = "Editing " + stored + " planted trees (" + (index.Count - stored) + " eligible stems not found in storage)." + report + EditsReport();
                SceneView.RepaintAll();
            }
            catch (Exception e) { StopEditing(); editStatus = "Editor not started: " + e.Message; Debug.LogException(e); }
        }

        void StopEditing()
        {
            if (editing) Tools.hidden = false;
            if (editProbe != null) { editProbe.Dispose(); editProbe = null; }
            index.Clear(); selection.Clear(); proxySelection.Clear(); survey.Clear(); editing = false; addMode = false;
            editSystem = null; editPackage = null;
            SceneView.RepaintAll();
        }

        // ---- VSP storage access ---------------------------------------------

        // Index of the stored instance for this tree inside its cell's item list, or -1.
        int FindInstance(EditorTree et, out PersistentVegetationInfo info, out VegetationCell cell)
        {
            info = null; cell = null;
            if (string.IsNullOrEmpty(et.itemId)) return -1;
            var cells = new List<VegetationCell>();
            const float eps = 0.05f;
            if (et.cellIndex >= 0 && et.cellIndex < editSystem.VegetationCellList.Count) cells.Add(editSystem.VegetationCellList[et.cellIndex]);
            else editSystem.VegetationCellQuadTree.Query(new Rect(et.position.x - eps, et.position.z - eps, 2 * eps, 2 * eps), cells);
            var local = et.position - editSystem.VegetationSystemPosition;
            foreach (var c in cells)
            {
                var candidate = editPackage.PersistentVegetationCellList[c.Index].GetPersistentVegetationInfo(et.itemId);
                if (candidate == null) continue;
                var list = candidate.VegetationItemList;
                for (int i = 0; i < list.Count; i++)
                {
                    if (list[i].VegetationSourceID != ImportSource) continue;
                    var d = list[i].Position - local;
                    if (Mathf.Abs(d.x) <= eps && Mathf.Abs(d.z) <= eps && Mathf.Abs(d.y) <= 1f) { info = candidate; cell = c; et.cellIndex = c.Index; return i; }
                }
            }
            et.cellIndex = -1;
            return -1;
        }
        int FindInstance(EditorTree et) { PersistentVegetationInfo info; VegetationCell cell; return FindInstance(et, out info, out cell); }

        void RemoveInstance(EditorTree et)
        {
            PersistentVegetationInfo info; VegetationCell cell;
            int i = FindInstance(et, out info, out cell);
            if (i < 0) { et.stored = false; return; }
            info.RemovePersistentVegetationInstanceAtIndex(i);
            editPackage.SetInstanceInfoDirty();
            editSystem.ClearCache(cell);
            et.stored = false; et.cellIndex = -1;
            RefreshVsp();
        }

        // VSP only re-spawns a cleared cell when its edit-mode Update runs, which a
        // scene repaint alone does not guarantee. Ask for a player-loop tick as well.
        static void RefreshVsp()
        {
            EditorApplication.QueuePlayerLoopUpdate();
            SceneView.RepaintAll();
        }

        void AddInstance(EditorTree et)
        {
            ResolveCell(editSystem, ref et.position);
            storage.AddVegetationItemInstance(et.itemId, et.position, et.scale, et.rotation, false, ImportSource, 1f, true);
            editPackage.SetInstanceInfoDirty();
            et.cellIndex = -1;
            et.stored = FindInstance(et) >= 0;
            if (!et.stored) throw new InvalidOperationException("VSP did not store the tree at " + et.position + ".");
            RefreshVsp();
        }

        // Live update of a stored instance's transform without re-adding it (drag preview).
        void UpdateInstanceInPlace(EditorTree et, Vector3 position, Quaternion rotation, Vector3 scale)
        {
            PersistentVegetationInfo info; VegetationCell cell;
            int i = FindInstance(et, out info, out cell);
            if (i < 0) return;
            var item = info.VegetationItemList[i];
            item.Position = position - editSystem.VegetationSystemPosition; item.Rotation = rotation; item.Scale = scale;
            info.VegetationItemList[i] = item;
            et.position = position; et.rotation = rotation; et.scale = scale;
            editSystem.ClearCache(cell);
            RefreshVsp();
        }

        void MarkStorageDirty()
        {
            EditorUtility.SetDirty(editPackage);
            RefreshVsp();
        }

        // ---- edits ---------------------------------------------------------

        GolfMapTreeEdit RecordFor(EditorTree et)
        {
            GolfMapTreeEdit edit;
            if (!treeEdits.TryGetValue(et.tree, out edit))
            {
                edit = new GolfMapTreeEdit { id = et.tree.id, op = "modify", ox = et.tree.x, oz = et.tree.z };
                treeEdits[et.tree] = edit; editFile.edits.Add(edit);
            }
            return edit;
        }

        void SyncRecord(EditorTree et, GolfMapTreeEdit edit)
        {
            var t = et.tree;
            edit.x = t.x; edit.z = t.z; edit.h = t.h; edit.r = t.r; edit.k = t.k; edit.bush = t.bush;
        }

        void SaveEdits()
        {
            editFile.trees = Path.GetFileName(filePath);
            GolfMapTreeEdits.Save(editsPath, editFile);
        }

        // Recomputes match, prefab, scale and rotation for the tree's current state, keeping its position.
        void Rematch(EditorTree et)
        {
            var m = MatchTree(et.tree, woodlandTrees.Contains(et.tree));
            if (m == null) throw new InvalidOperationException("No biome asset fits tree " + et.tree.id + " (height " + et.tree.h + " m, radius " + et.tree.r + " m). Choose another species or size.");
            if (m.asset.IsArborist) throw new InvalidOperationException("Tree " + et.tree.id + " would become " + m.asset.model + ", which Arborist draws: the Scene view editor handles the course's VSP trees only. Use golfmap.trees.edit for it.");
            biomeMatches[et.tree] = m;
            et.prefab = biomePrefabs[biome.PrefabKey(m)];
            var mapping = EnsureCatalog(editSystem, new[] { et.prefab }, false);
            et.itemId = mapping[et.prefab];
            var proto = Measure(et.prefab, editProtoCache);
            float hs = HeightScale(et.tree, proto);
            float ws = WidthScale(et.tree, proto, hs);
            et.scale = new Vector3(ws, hs, ws);
            et.yaw = (float)m.rotation;
            et.rotation = Orientation(m, et.yaw);
        }

        float GroundHeight(GolfMapTree t)
        {
            bool meshHit; return editProbe.Height(WorldPos(t), out meshHit);
        }

        // Ground plus the record's vertical offset, or the record's absolute height (ySet).
        Vector3 GroundedPosition(GolfMapTree t)
        {
            var pos = WorldPos(t); pos.y = GroundHeight(t);
            GolfMapTreeEdit edit; if (treeEdits.TryGetValue(t, out edit)) pos.y = edit.ySet ? edit.y : pos.y + edit.dy;
            return pos;
        }

        // Applies the tree's current survey-space state (x, z, h, r, k, overrides) to storage and the edits file.
        void CommitTree(EditorTree et)
        {
            RemoveInstance(et);
            et.position = GroundedPosition(et.tree);
            Rematch(et);
            AddInstance(et);
            var edit = RecordFor(et); SyncRecord(et, edit);
        }

        void Guard(string what, Action action)
        {
            try { action(); editStatus = what + " done. " + editFile.edits.Count + " edit records."; }
            catch (Exception e) { editStatus = what + " failed: " + e.Message; Debug.LogException(e); }
            finally
            {
                try { SaveEdits(); GolfMapArboristProxies.EditsWritten(editsPath); } catch (Exception e) { editStatus += " Edits file not saved: " + e.Message; Debug.LogException(e); }
                MarkStorageDirty(); Repaint();
            }
        }

        void ApplyFields(EditorTree et)
        {
            Guard("Apply", () =>
            {
                if (!(fieldH > 0) || !(fieldR > 0)) throw new Exception("Height and radius must be positive.");
                var edit = RecordFor(et);
                et.tree.h = fieldH; et.tree.r = fieldR;
                edit.species = fieldSpecies ?? ""; edit.guid = fieldGuid ?? "";
                if (!string.IsNullOrEmpty(edit.guid)) { var a = biome.assets.First(x => x.MatchKey == edit.guid); edit.species = a.species; }
                if (!string.IsNullOrEmpty(edit.species)) et.tree.k = GolfMapBiome.StemKind(biome.assets.Where(a => a.enabled && a.species == edit.species));
                edit.rotation = fieldRot; edit.rotationSet = true; edit.dy = fieldDy; edit.ySet = false;
                CommitTree(et);
                LoadFields(et);
            });
        }

        void DeleteSelected()
        {
            if (selection.Count == 0 && proxySelection.Count > 0) { ProxyGuard("Delete", DeleteProxies); return; }   // records only, VSP untouched
            Guard("Delete", () =>
            {
                foreach (var id in selection.ToList())
                {
                    var et = index[id];
                    RemoveInstance(et);
                    GolfMapTreeEdit edit; treeEdits.TryGetValue(et.tree, out edit);
                    if (edit != null && edit.op == "add") { editFile.edits.Remove(edit); treeEdits.Remove(et.tree); }
                    else { edit = RecordFor(et); edit.op = "delete"; }
                    index.Remove(id); loaded.trees.Remove(et.tree); biomeMatches.Remove(et.tree);
                }
                selection.Clear();
                DeleteProxies();
            });
        }

        void ResetSelected()
        {
            Guard("Reset", () =>
            {
                foreach (var id in selection.ToList())
                {
                    var et = index[id];
                    GolfMapTreeEdit edit;
                    if (!treeEdits.TryGetValue(et.tree, out edit)) continue;
                    if (edit.op == "add") continue; // nothing to reset to; delete it instead
                    editFile.edits.Remove(edit); treeEdits.Remove(et.tree);
                    var original = SurveyTree(et.tree.id);
                    if (original == null) throw new Exception("Survey tree " + et.tree.id + " not found in " + Path.GetFileName(filePath));
                    et.tree.x = original.x; et.tree.z = original.z; et.tree.h = original.h; et.tree.r = original.r; et.tree.k = original.k; et.tree.bush = original.bush;
                    RemoveInstance(et); et.position = GroundedPosition(et.tree); Rematch(et); AddInstance(et);
                }
                fieldsFor = "";
            });
        }

        readonly Dictionary<string, GolfMapTree> survey = new Dictionary<string, GolfMapTree>();
        GolfMapTree SurveyTree(string id)
        {
            if (survey.Count == 0)
            {
                var file = JsonUtility.FromJson<GolfMapTreeFile>(File.ReadAllText(filePath));
                if (file != null && file.trees != null) foreach (var t in file.trees)
                {
                    if (string.IsNullOrEmpty(t.id)) t.id = t.x.ToString("R", CultureInfo.InvariantCulture) + ":" + t.z.ToString("R", CultureInfo.InvariantCulture);
                    if (!survey.ContainsKey(t.id)) survey.Add(t.id, t);
                }
            }
            GolfMapTree found; return survey.TryGetValue(id, out found) ? found : null;
        }

        void AddTreeAt(Vector3 ground)
        {
            Guard("Add", () =>
            {
                if (string.IsNullOrEmpty(addSpecies)) throw new Exception("Choose a species to add.");
                if (!(addHeight > 0) || !(addRadius > 0)) throw new Exception("Height and radius must be positive.");
                var t = new GolfMapTree { id = GolfMapTreeEdits.NewId(), x = ground.x - terrain.transform.position.x, z = ground.z - terrain.transform.position.z, h = addHeight, r = addRadius, g = 0 };
                if (!InsidePlot(t)) throw new Exception("That point is outside the plot (or inside the excluded inner terrain).");
                t.k = GolfMapBiome.StemKind(biome.assets.Where(a => a.enabled && a.species == addSpecies));
                var edit = new GolfMapTreeEdit { id = t.id, op = "add", ox = t.x, oz = t.z, species = addSpecies };
                treeEdits[t] = edit; editFile.edits.Add(edit); loaded.trees.Add(t);
                var et = new EditorTree { tree = t };
                try { et.position = GroundedPosition(t); Rematch(et); AddInstance(et); }
                catch { treeEdits.Remove(t); editFile.edits.Remove(edit); loaded.trees.Remove(t); throw; }
                SyncRecord(et, edit);
                index.Add(t.id, et);
                selection.Clear(); selection.Add(t.id); fieldsFor = "";
            });
        }

        // ---- scene view ----------------------------------------------------

        // Called from the component's Inspector (Editor.OnSceneGUI) while the object is selected.
        internal void OnSceneGUI()
        {
            if (!editing || editSystem == null) return;
            var view = SceneView.currentDrawingSceneView;
            var cam = view ? view.camera : Camera.current;
            if (!cam) return;
            Tools.hidden = true;
            var e = Event.current;
            int control = GUIUtility.GetControlID(FocusType.Passive);
            if (!e.alt) HandleUtility.AddDefaultControl(control);
            if (e.type == EventType.Repaint) DrawTrees(cam);
            DrawHandles(e);
            if (e.type == EventType.MouseDown && e.button == 0 && !e.alt && HandleUtility.nearestControl == control)
            {
                if (addMode)
                {
                    Vector3 ground;
                    if (GroundHit(HandleUtility.GUIPointToWorldRay(e.mousePosition), out ground)) AddTreeAt(ground);
                    else editStatus = "Click on the terrain to add a tree.";
                }
                else
                {
                    // The nearest stem on screen, a VSP tree or an Arborist proxy; one kind is selected at a time.
                    float best = 14f;
                    var hit = PickAt(e.mousePosition, cam, ref best);
                    var proxyHit = ProxiesHere ? PickProxy(e.mousePosition, cam, ref best) : null;
                    if (proxyHit != null) hit = null;
                    if (hit != null || !e.shift) proxySelection.Clear();
                    if (proxyHit != null || !e.shift) selection.Clear();
                    if (hit != null) { if (selection.Contains(hit.tree.id)) { if (e.shift) selection.Remove(hit.tree.id); } else selection.Add(hit.tree.id); }
                    if (proxyHit != null) { if (proxySelection.Contains(proxyHit.id)) { if (e.shift) proxySelection.Remove(proxyHit.id); } else proxySelection.Add(proxyHit.id); }
                    fieldsFor = ""; proxyFieldsFor = "";
                }
                e.Use(); Repaint(); SceneView.RepaintAll();
            }
            bool anySelected = selection.Count > 0 || proxySelection.Count > 0;
            if (e.type == EventType.KeyDown)
            {
                if (e.keyCode == KeyCode.Delete && anySelected) { DeleteSelected(); e.Use(); }
                else if (e.keyCode == KeyCode.Escape && anySelected) { selection.Clear(); proxySelection.Clear(); e.Use(); Repaint(); SceneView.RepaintAll(); }
            }
            // Swallow Delete even with no tree selected: it must never delete the GolfMap Trees object.
            if ((e.type == EventType.ValidateCommand || e.type == EventType.ExecuteCommand) && (e.commandName == "SoftDelete" || e.commandName == "Delete"))
            {
                if (e.type == EventType.ExecuteCommand && anySelected) DeleteSelected();
                e.Use();
            }
        }

        bool GroundHit(Ray ray, out Vector3 point)
        {
            // March the ray against the terrain, then refine; no colliders needed.
            point = Vector3.zero;
            var size = terrain.terrainData.size; var origin = terrain.transform.position;
            float step = 2f, prev = 0; bool prevAbove = true;
            for (float d = 0; d < 6000f; d += step)
            {
                var p = ray.GetPoint(d);
                bool inside = p.x >= origin.x && p.z >= origin.z && p.x <= origin.x + size.x && p.z <= origin.z + size.z;
                bool above = !inside || p.y > terrain.SampleHeight(p) + origin.y;
                if (!above && prevAbove && d > 0)
                {
                    float lo = prev, hi = d;
                    for (int i = 0; i < 20; i++) { float mid = (lo + hi) / 2; var q = ray.GetPoint(mid); if (q.y > terrain.SampleHeight(q) + origin.y) lo = mid; else hi = mid; }
                    point = ray.GetPoint(hi); bool meshHit; point.y = editProbe.Height(point, out meshHit);
                    return true;
                }
                prev = d; prevAbove = above;
            }
            return false;
        }

        // The stored tree whose stem is nearest the mouse within `best` pixels (lowered to its distance), or null.
        EditorTree PickAt(Vector2 mouse, Camera cam, ref float best)
        {
            var ray = HandleUtility.GUIPointToWorldRay(mouse);
            Vector3 camPos = cam.transform.position;
            EditorTree hit = null; const float range = 2500f;
            foreach (var et in index.Values)
            {
                if (!et.stored) continue;
                var d = et.position - camPos;
                if (d.sqrMagnitude > range * range || Vector3.Dot(d, ray.direction) <= 0) continue;
                float px = HandleUtility.DistanceToLine(et.position, et.position + Vector3.up * et.tree.h);
                if (px < best) { best = px; hit = et; }
            }
            return hit;
        }

        void DrawTrees(Camera cam)
        {
            Vector3 camPos = cam.transform.position;
            if (showStems)
            {
                Handles.color = StemColour;
                const float range = 150f;
                foreach (var et in index.Values)
                {
                    if (!et.stored || (et.position - camPos).sqrMagnitude > range * range) continue;
                    Handles.DrawWireDisc(et.position, Vector3.up, Mathf.Max(0.3f, et.tree.r * 0.5f));
                }
            }
            Handles.color = SelectedColour;
            foreach (var id in selection)
            {
                EditorTree et; if (!index.TryGetValue(id, out et)) continue;
                var top = et.position + Vector3.up * et.tree.h * (dragScale ? dragFactorH : 1);
                float r = et.tree.r * (dragScale ? dragFactorW : 1);
                Handles.DrawWireDisc(et.position, Vector3.up, r);
                Handles.DrawWireDisc(top - Vector3.up * r, Vector3.up, r);
                Handles.DrawLine(et.position, top);
                Handles.Label(top + Vector3.up, (et.prefab ? et.prefab.name : "?") + "  " + et.tree.h.ToString("0.0", CultureInfo.InvariantCulture) + " m", EditorStyles.whiteBoldLabel);
            }
            if (ProxiesHere) DrawSelectedProxies();
        }

        void DrawHandles(Event e)
        {
            if (proxySelection.Count > 0) { if (ProxiesHere) DrawProxyHandles(e); return; }
            if (selection.Count == 0) return;
            var trees = selection.Select(id => { EditorTree t; index.TryGetValue(id, out t); return t; }).Where(t => t != null && t.stored).ToList();
            if (trees.Count == 0) return;
            Vector3 centre = Vector3.zero; foreach (var t in trees) centre += t.position; centre /= trees.Count;
            float size = HandleUtility.GetHandleSize(centre);
            var tool = Tools.current == Tool.Rotate ? Tool.Rotate : Tools.current == Tool.Scale ? Tool.Scale : Tool.Move;

            if (tool == Tool.Move)
            {
                // Live preview by editing instances in place; commit (ground snap, cell, record) on mouse up.
                EditorGUI.BeginChangeCheck();
                var moved = Handles.PositionHandle(centre, Quaternion.identity);
                if (EditorGUI.EndChangeCheck())
                {
                    var delta = moved - centre;
                    foreach (var t in trees) UpdateInstanceInPlace(t, t.position + delta, t.rotation, t.scale);
                    dragMove = true; SceneView.RepaintAll();
                }
            }
            else if (tool == Tool.Rotate)
            {
                Handles.color = Color.red;
                var first = trees[0];
                EditorGUI.BeginChangeCheck();
                var rot = Handles.Disc(first.rotation, centre, Vector3.up, size * 1.2f, false, 5f);
                if (EditorGUI.EndChangeCheck())
                {
                    float delta = Mathf.DeltaAngle(first.rotation.eulerAngles.y, rot.eulerAngles.y);
                    foreach (var t in trees) { t.yaw += delta; UpdateInstanceInPlace(t, t.position, Quaternion.Euler(0, delta, 0) * t.rotation, t.scale); }
                    dragRotate = true; SceneView.RepaintAll();
                }
                Handles.color = SelectedColour;
            }
            else
            {
                // Unity's scale gizmo: Y = height, X or Z = crown radius, centre cube = both.
                var current = new Vector3(dragFactorW, dragFactorH, dragFactorW);
                EditorGUI.BeginChangeCheck();
                var next = Handles.ScaleHandle(current, centre, Quaternion.identity, size * 1.5f);
                if (EditorGUI.EndChangeCheck())
                {
                    bool uniform = next.x != current.x && next.y != current.y && next.z != current.z;
                    float fh = uniform || next.y != current.y ? next.y : dragFactorH;
                    float fw = uniform ? next.y : next.x != current.x ? next.x : next.z != current.z ? next.z : dragFactorW;
                    dragFactorH = Mathf.Clamp(fh, 0.2f, 5f); dragFactorW = Mathf.Clamp(fw, 0.2f, 5f);
                    if (!dragScale) { dragBaseScale.Clear(); foreach (var t in trees) dragBaseScale[t.tree.id] = t.scale; dragScale = true; }
                    foreach (var t in trees)
                    {
                        var b = dragBaseScale[t.tree.id];
                        // Outer billboards scale uniformly (VSP uses X for both billboard axes): width follows height there.
                        var s = forceBillboards ? new Vector3(b.x * dragFactorH, b.y * dragFactorH, b.z * dragFactorH) : new Vector3(b.x * dragFactorW, b.y * dragFactorH, b.z * dragFactorW);
                        UpdateInstanceInPlace(t, t.position, t.rotation, s);
                    }
                    SceneView.RepaintAll();
                }
            }

            bool released = e.rawType == EventType.MouseUp || (GUIUtility.hotControl == 0 && e.type == EventType.Repaint);
            if (released && (dragMove || dragRotate || dragScale))
            {
                bool move = dragMove, rotate = dragRotate, scale = dragScale; float fh = dragFactorH, fw = dragFactorW;
                dragMove = dragRotate = dragScale = false; dragFactorH = dragFactorW = 1; dragBaseScale.Clear();
                Guard(move ? "Move" : rotate ? "Rotate" : "Resize", () =>
                {
                    if (move)
                    {
                        var probe = new GolfMapTree();
                        foreach (var t in trees)
                        {
                            probe.x = t.position.x - terrain.transform.position.x; probe.z = t.position.z - terrain.transform.position.z;
                            if (InsidePlot(probe)) continue;
                            foreach (var u in trees) UpdateInstanceInPlace(u, GroundedPosition(u.tree), u.rotation, u.scale);
                            throw new Exception("Tree " + t.tree.id + " would leave the plot. Move reverted.");
                        }
                    }
                    foreach (var t in trees)
                    {
                        var edit = RecordFor(t);
                        if (move) { t.tree.x = t.position.x - terrain.transform.position.x; t.tree.z = t.position.z - terrain.transform.position.z; edit.dy = t.position.y - GroundHeight(t.tree); edit.ySet = false; }
                        if (rotate) { edit.rotation = Mathf.Repeat(t.yaw, 360); edit.rotationSet = true; }
                        if (scale) { t.tree.h *= fh; t.tree.r *= forceBillboards ? fh : fw; }
                        CommitTree(t);
                    }
                    fieldsFor = "";
                });
            }
        }

        // ---- Arborist proxies ------------------------------------------------
        // A proxy edit is only a tree edit record, as golfmap.trees.edit writes it (GolfMapTreeEditsBridge.cs):
        // VSP storage is not touched and nothing is replanted. The proxy shows the change at once.

        bool ProxiesHere { get { return GolfMapArboristProxies.On && GolfMapArboristProxies.TerrainRole == RoleKey; } }
        internal IList<string> SelectedProxyIds { get { return proxySelection; } }
        internal string EditStatus { get { return editStatus; } }

        List<GolfMapArboristProxies.Proxy> SelectedProxies()
        {
            return proxySelection.Select(id => GolfMapArboristProxies.Find(id)).Where(p => p != null).ToList();
        }

        GolfMapTree LoadedTree(string id) { return loaded == null ? null : loaded.trees.FirstOrDefault(t => t.id == id); }

        // The proxy nearest the mouse within `best` pixels (lowered to its distance): its stem, or its crown's outline.
        GolfMapArboristProxies.Proxy PickProxy(Vector2 mouse, Camera cam, ref float best)
        {
            var ray = HandleUtility.GUIPointToWorldRay(mouse);
            Vector3 camPos = cam.transform.position;
            GolfMapArboristProxies.Proxy hit = null; const float range = 2500f;
            foreach (var p in GolfMapArboristProxies.All)
            {
                var d = p.position - camPos;
                if (d.sqrMagnitude > range * range || Vector3.Dot(d, ray.direction) <= 0) continue;
                Vector3 centre, size; float trunkH, trunkD;
                GolfMapArboristProxies.Shape(p, out centre, out size, out trunkH, out trunkD);
                float px = Mathf.Min(HandleUtility.DistanceToLine(p.position, p.position + Vector3.up * Mathf.Max(size.y, centre.y - p.position.y + size.y / 2)),
                    HandleUtility.DistanceToCircle(centre, size.x / 2) + 6f);
                if (px < best) { best = px; hit = p; }
            }
            return hit;
        }

        // The tree's edit record, made as golfmap.trees.edit makes it when the tree has none: from the survey's tree,
        // or (a placement the loaded survey lacks) from the proxy's own place and drawn size with its model.
        GolfMapTreeEdit ProxyRecord(GolfMapArboristProxies.Proxy p)
        {
            var existing = editFile.edits.FirstOrDefault(x => x.id == p.id);
            if (existing != null) return existing;
            var tree = LoadedTree(p.id);
            var origin = terrain.transform.position;
            var edit = new GolfMapTreeEdit { id = p.id, op = "modify" };
            if (tree != null)
            {
                edit.ox = edit.x = tree.x; edit.oz = edit.z = tree.z; edit.h = tree.h; edit.r = tree.r; edit.k = tree.k; edit.bush = tree.bush;
                treeEdits[tree] = edit;
            }
            else
            {
                edit.ox = edit.x = p.position.x - origin.x; edit.oz = edit.z = p.position.z - origin.z;
                edit.h = p.heightM; edit.r = Mathf.Max(p.crownWidthM, 0.1f) / 2; edit.sized = true;
                PinModel(edit, p);
            }
            editFile.edits.Add(edit);
            return edit;
        }

        // A size named by hand keeps the model the proxy shows (else the fit might pick another for that size).
        void PinModel(GolfMapTreeEdit edit, GolfMapArboristProxies.Proxy p)
        {
            if (!string.IsNullOrEmpty(edit.model) || string.IsNullOrEmpty(p.model)) return;
            edit.model = p.model; edit.guid = "";
            var asset = biome != null ? biome.assets.FirstOrDefault(a => a.model == p.model) : null;
            if (asset != null) { edit.species = asset.species ?? ""; edit.k = GolfMapBiome.StemKind(new[] { asset }); }
        }

        void SetDrawnSize(GolfMapTreeEdit edit, GolfMapArboristProxies.Proxy p)
        {
            edit.h = p.heightM; edit.r = Mathf.Max(p.crownWidthM, 0.1f) / 2; edit.sized = true;
            PinModel(edit, p);
            var tree = LoadedTree(p.id); if (tree != null) { tree.h = edit.h; tree.r = edit.r; tree.k = edit.k; }
        }

        void ProxyGuard(string what, Action action)
        {
            try { action(); editStatus = what + " done (Arborist tree: the next Plant and Arborist export bring it to GSPro). " + editFile.edits.Count + " edit records."; }
            catch (Exception e) { editStatus = what + " failed: " + e.Message; Debug.LogException(e); }
            finally
            {
                try { SaveEdits(); GolfMapArboristProxies.EditsWritten(editsPath); } catch (Exception e) { editStatus += " Edits file not saved: " + e.Message; Debug.LogException(e); }
                GolfMapArboristProxies.Changed(); Repaint();
            }
        }

        // Inside DeleteSelected's Guard: the selected proxies' trees are not planted (an added tree's record is dropped).
        void DeleteProxies()
        {
            foreach (var p in SelectedProxies())
            {
                var existing = editFile.edits.FirstOrDefault(x => x.id == p.id);
                var tree = LoadedTree(p.id);
                if (existing != null && existing.op == "add") { editFile.edits.Remove(existing); if (tree != null) treeEdits.Remove(tree); }
                else ProxyRecord(p).op = "delete";
                if (tree != null) { loaded.trees.Remove(tree); biomeMatches.Remove(tree); }
                GolfMapArboristProxies.Remove(p.id);
            }
            proxySelection.Clear(); proxyFieldsFor = "";
        }

        void DrawProxyFields()
        {
            var proxies = SelectedProxies();
            EditorGUILayout.LabelField("Selected", proxies.Count + " Arborist tree(s) (proxies)");
            if (proxies.Count == 1)
            {
                var p = proxies[0];
                if (proxyFieldsFor != p.id) { proxyFieldsFor = p.id; proxyFieldH = p.heightM; proxyFieldW = p.crownWidthM; proxyFieldRot = p.rotationY; }
                EditorGUILayout.LabelField("Id", p.id);
                EditorGUILayout.LabelField("Model", p.model + (p.edited ? "  (edited)" : ""));
                EditorGUILayout.LabelField("Position", "x " + p.position.x.ToString("0.0", CultureInfo.InvariantCulture) + "  z " + p.position.z.ToString("0.0", CultureInfo.InvariantCulture));
                proxyFieldH = EditorGUILayout.FloatField("Height (m)", proxyFieldH);
                proxyFieldW = EditorGUILayout.FloatField("Crown width (m)", proxyFieldW);
                proxyFieldRot = EditorGUILayout.FloatField("Rotation (deg)", proxyFieldRot);
                using (new EditorGUILayout.HorizontalScope())
                {
                    if (GUILayout.Button("Apply")) ApplyProxyFields(p);
                    if (GUILayout.Button("Delete")) DeleteSelected();
                }
            }
            else if (proxies.Count > 1 && GUILayout.Button("Delete")) DeleteSelected();
        }

        void ApplyProxyFields(GolfMapArboristProxies.Proxy p)
        {
            ProxyGuard("Apply", () =>
            {
                if (!(proxyFieldW > 0) || !(proxyFieldH > 0 || (proxyFieldH == 0 && p.heightM == 0))) throw new Exception("Height and crown width must be positive.");
                var edit = ProxyRecord(p);
                if (proxyFieldH != p.heightM || proxyFieldW != p.crownWidthM) { p.heightM = proxyFieldH; p.crownWidthM = proxyFieldW; SetDrawnSize(edit, p); }
                if (Mathf.Abs(Mathf.DeltaAngle(proxyFieldRot, p.rotationY)) > 0.001f || !edit.rotationSet) { p.rotationY = Mathf.Repeat(proxyFieldRot, 360); edit.rotation = p.rotationY; edit.rotationSet = true; }
                p.edited = true; proxyFieldsFor = "";
            });
        }

        void DrawSelectedProxies()
        {
            Handles.color = SelectedColour;
            foreach (var p in SelectedProxies())
            {
                Vector3 centre, size; float trunkH, trunkD;
                GolfMapArboristProxies.Shape(p, out centre, out size, out trunkH, out trunkD);
                float r = size.x / 2;
                var top = centre + Vector3.up * size.y / 2;
                Handles.DrawWireDisc(p.position, Vector3.up, r);
                Handles.DrawWireDisc(centre, Vector3.up, r);
                Handles.DrawLine(p.position, top);
                Handles.DrawLine(centre, centre + Quaternion.Euler(0, p.rotationY, 0) * Vector3.forward * r * 1.4f);   // facing
                Handles.Label(top + Vector3.up, p.Label + "  " + p.heightM.ToString("0.0", CultureInfo.InvariantCulture) + " m", EditorStyles.whiteBoldLabel);
            }
        }

        // As DrawHandles for VSP trees: a live preview on the proxies, the record written on mouse up.
        void DrawProxyHandles(Event e)
        {
            var proxies = SelectedProxies();
            if (proxies.Count == 0) return;
            Vector3 centre = Vector3.zero; foreach (var p in proxies) centre += p.position; centre /= proxies.Count;
            float size = HandleUtility.GetHandleSize(centre);
            var tool = Tools.current == Tool.Rotate ? Tool.Rotate : Tools.current == Tool.Scale ? Tool.Scale : Tool.Move;
            if (tool == Tool.Move)
            {
                EditorGUI.BeginChangeCheck();
                var moved = Handles.PositionHandle(centre, Quaternion.identity);
                if (EditorGUI.EndChangeCheck())
                {
                    if (!dragMove) { proxyDragStart.Clear(); foreach (var p in proxies) proxyDragStart[p.id] = p.position; dragMove = true; }
                    var delta = moved - centre;
                    foreach (var p in proxies) p.position += delta;
                    GolfMapArboristProxies.Changed();
                }
            }
            else if (tool == Tool.Rotate)
            {
                Handles.color = Color.red;
                var first = proxies[0];
                var current = Quaternion.Euler(0, first.rotationY, 0);
                EditorGUI.BeginChangeCheck();
                var rot = Handles.Disc(current, centre, Vector3.up, size * 1.2f, false, 5f);
                if (EditorGUI.EndChangeCheck())
                {
                    float delta = Mathf.DeltaAngle(current.eulerAngles.y, rot.eulerAngles.y);
                    foreach (var p in proxies) p.rotationY = Mathf.Repeat(p.rotationY + delta, 360);
                    dragRotate = true; GolfMapArboristProxies.Changed();
                }
                Handles.color = SelectedColour;
            }
            else
            {
                // Y = height, X or Z = crown width, centre cube = both.
                var current = new Vector3(dragFactorW, dragFactorH, dragFactorW);
                EditorGUI.BeginChangeCheck();
                var next = Handles.ScaleHandle(current, centre, Quaternion.identity, size * 1.5f);
                if (EditorGUI.EndChangeCheck())
                {
                    bool uniform = next.x != current.x && next.y != current.y && next.z != current.z;
                    float fh = uniform || next.y != current.y ? next.y : dragFactorH;
                    float fw = uniform ? next.y : next.x != current.x ? next.x : next.z != current.z ? next.z : dragFactorW;
                    dragFactorH = Mathf.Clamp(fh, 0.2f, 5f); dragFactorW = Mathf.Clamp(fw, 0.2f, 5f);
                    if (!dragScale) { proxyDragSize.Clear(); foreach (var p in proxies) proxyDragSize[p.id] = new Vector2(p.heightM, p.crownWidthM); dragScale = true; }
                    foreach (var p in proxies) { var b = proxyDragSize[p.id]; p.heightM = b.x * dragFactorH; p.crownWidthM = b.y * dragFactorW; }
                    GolfMapArboristProxies.Changed();
                }
            }

            bool released = e.rawType == EventType.MouseUp || (GUIUtility.hotControl == 0 && e.type == EventType.Repaint);
            if (!released || !(dragMove || dragRotate || dragScale)) return;
            bool move = dragMove, rotate = dragRotate, scale = dragScale;
            dragMove = dragRotate = dragScale = false; dragFactorH = dragFactorW = 1;
            var start = new Dictionary<string, Vector3>(proxyDragStart);
            proxyDragStart.Clear(); proxyDragSize.Clear();
            ProxyGuard(move ? "Move" : rotate ? "Rotate" : "Resize", () =>
            {
                var origin = terrain.transform.position;
                if (move)
                {
                    var probe = new GolfMapTree();
                    foreach (var p in proxies)
                    {
                        probe.x = p.position.x - origin.x; probe.z = p.position.z - origin.z;
                        if (InsidePlot(probe)) continue;
                        foreach (var u in proxies) { Vector3 back; if (start.TryGetValue(u.id, out back)) u.position = back; }
                        throw new Exception("Tree " + p.id + " would leave the plot. Move reverted.");
                    }
                }
                foreach (var p in proxies)
                {
                    var edit = ProxyRecord(p);
                    if (move)
                    {
                        Vector3 from; float lift = start.TryGetValue(p.id, out from) ? p.position.y - from.y : 0;   // the green arrow: a ground offset
                        edit.x = p.position.x - origin.x; edit.z = p.position.z - origin.z;
                        bool meshHit; float ground = editProbe.Height(p.position, out meshHit);
                        if (edit.ySet) edit.y += lift; else edit.dy += lift;
                        p.position.y = edit.ySet ? edit.y : ground + edit.dy;
                        var tree = LoadedTree(p.id); if (tree != null) { tree.x = edit.x; tree.z = edit.z; }
                    }
                    if (rotate) { edit.rotation = Mathf.Repeat(p.rotationY, 360); edit.rotationSet = true; }
                    if (scale) SetDrawnSize(edit, p);
                    p.edited = true;
                }
                proxyFieldsFor = "";
            });
        }
    }
}
