// GolfMap > Vegetation Palettes: one editor for the course's lower vegetation (grass and
// bushes, grass-palette.json) and its tree looks (palette.json), built for quick tuning:
//
//   left   every palette and tree species with its items/looks (thumbnail, tint chips,
//          unsaved dot). Click selects, Ctrl-click adds, Shift-click a range; clicking a
//          palette or species takes all of it. Select across palettes and trees at will.
//   right  "Adjust together": relative sliders over the whole selection (brightness,
//          saturation, hue, warmth in linear light; height, width, density, size spread),
//          from where the selection stood when the first slider moved - Keep sets that as the
//          new start, Reset goes back. Below it every setting of the selection, the same
//          kinds for all (mixed values show a dash; setting one sets all), then copy/paste,
//          tree look actions and the Lab.
//   top    Save / Revert, A/B (show the saved values in the scene), Solo (hide every other
//          lower-vegetation item), Go to (jump the Scene view to where the selection grows;
//          again for the next spot), saved views, Rebuild VSP.
//
// Every change shows in the Scene view as the slider moves (GolfMapVegLive); nothing is
// written until Save. Ctrl+Z undoes edits, the scene follows. The model and the files:
// GolfMapVegPalette; the shared working copy: GolfMapVegSession (also driven by bridge
// commands golfmap.vegpalette.*).
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    public class GolfMapVegPaletteWindow : EditorWindow
    {
        [MenuItem("GolfMap/Vegetation Palettes")]
        public static void Open() { GetWindow<GolfMapVegPaletteWindow>("Veg Palettes").Show(); }

        // Open with some entries selected (the Trees Inspector's "Tune" buttons).
        public static void OpenWith(IEnumerable<string> keys)
        {
            var w = GetWindow<GolfMapVegPaletteWindow>("Veg Palettes");
            w.SetSelection(keys.ToList());
            foreach (var k in keys) { var e = GolfMapVegSession.Current.Get(k); if (e != null) w.Expand(GroupKey(e), true); }
            w.Show(); w.Focus();
        }

        [GolfMap.Bridge.BridgeCommand("golfmap.vegpalette.show", "Open GolfMap > Vegetation Palettes with a selection (patterns as golfmap.vegpalette.list), e.g. to point the user at what an agent changed.", args = "select, expand=true")]
        static object ShowCommand(GolfMap.Bridge.BridgeArgs a)
        {
            GolfMapVegSession.Fresh();
            var entries = GolfMapVegSession.Select(a.String("select", ""));
            OpenWith(entries.Select(e => e.key));
            return entries.Select(e => (object)e.key).ToList();
        }

        [SerializeField] List<string> selection = new List<string>();
        [SerializeField] List<string> expanded = new List<string>();
        [SerializeField] List<string> folded = new List<string> { "Rendering", "More material" };
        [SerializeField] string search = "", anchor, newLook = "";
        [SerializeField] float listWidth = 330;
        [SerializeField] Vector2 listScroll, detailScroll;
        [SerializeField] GolfMapVegAdjust adjust = new GolfMapVegAdjust();
        [SerializeField] bool solo, showSaved, showAllMaterial;
        [SerializeField] List<string> pasteSections = new List<string> { "Colours", "Size", "Placement", "Shading" };

        // Editor-session state only: Unity's script-reload serialisation would otherwise bring
        // these back as empty objects.
        [NonSerialized] Dictionary<string, GolfMapVegEntry> baseline;     // where "Adjust together" started
        [NonSerialized] GolfMapVegEntry clipboard;
        [NonSerialized] string note = "";
        [NonSerialized] List<Vector3> spots; [NonSerialized] string spotSignature; [NonSerialized] int spotIndex;
        [NonSerialized] bool resizing;
        [NonSerialized] double lastDiskCheck;
        [NonSerialized] bool diskChanged;   // checked in Update, not on every repaint
        readonly Dictionary<string, Texture> thumbs = new Dictionary<string, Texture>();
        readonly Dictionary<Material, UnityEditor.Editor> materialEditors = new Dictionary<Material, UnityEditor.Editor>();
        List<Row> rows = new List<Row>();

        static GolfMapVegState State { get { return GolfMapVegSession.Current; } }

        void OnEnable()
        {
            Undo.undoRedoPerformed += OnUndo;
            GolfMapVegSession.Changed += Repaint;
            wantsMouseMove = true;
            adjust.Clear();   // its start point did not survive the reload: begin a new adjust from here
            if (solo) EditorApplication.delayCall += () => { if (this && solo) GolfMapVegLive.Solo(SelectedGrassNames()); };
        }

        void OnDisable()
        {
            Undo.undoRedoPerformed -= OnUndo;
            GolfMapVegSession.Changed -= Repaint;
            CloseMaterialEditors();
        }

        void OnDestroy()
        {
            if (showSaved) GolfMapVegSession.ShowSaved(false);
            GolfMapVegLive.Unsolo();
            int dirty = GolfMapVegSession.DirtyEntries().Count;
            if (dirty == 0) return;
            int choice = EditorUtility.DisplayDialogComplex("Vegetation palettes", dirty + " palette entr" + (dirty == 1 ? "y has" : "ies have") + " unsaved changes (the scene shows them).",
                "Save", "Discard", "Keep for later");
            if (choice == 0) GolfMapVegSession.Save();
            else if (choice == 1) GolfMapVegSession.Revert();
        }

        void OnUndo()
        {
            State.Reindex();
            baseline = null; adjust.Clear();
            GolfMapVegSession.PushAll();
            Repaint();
        }

        void Update()
        {
            if (GolfMapVegLive.RespawnPending && GUIUtility.hotControl == 0) { GolfMapVegLive.FlushRespawns(); }
            // Baked tints (CTI): once the slider is let go and the value has settled.
            if (GolfMapVegLive.BakeDue && GUIUtility.hotControl == 0 && !showSaved) { note = GolfMapVegSession.FlushBakes(); Repaint(); }
            if (EditorApplication.timeSinceStartup - lastDiskCheck > 1.5)
            {
                lastDiskCheck = EditorApplication.timeSinceStartup;
                bool was = diskChanged;
                diskChanged = GolfMapVegSession.DiskChanged;
                if (diskChanged != was) Repaint();
                if (diskChanged)
                {
                    // Edited elsewhere (an agent, the Trees Inspector, a text editor): follow it while nothing is pending here.
                    if (GolfMapVegSession.DirtyEntries().Count == 0) { GolfMapVegSession.Load(); note = "Reloaded: a palette file changed on disk."; }
                    Repaint();
                }
            }
        }

        // ---- layout ----------------------------------------------------------------------

        void OnGUI()
        {
            // No course for this scene, unreadable palette ...: say so instead of drawing.
            try { if (State == null) return; }
            catch (Exception e) { EditorGUILayout.HelpBox(e.Message, MessageType.Warning); if (GUILayout.Button("Retry")) { try { GolfMapVegSession.Load(); } catch (Exception) { } } return; }
            HandleKeys();
            // Fixed rects, the same in the Layout and Repaint passes (GetRect would hand the
            // Layout pass a dummy rect and the panes would lay out to nothing).
            float top = 0, width = position.width;
            GUILayout.BeginArea(new Rect(0, top, width, 21)); DrawToolbar(); GUILayout.EndArea();
            top += 21;
            if (diskChanged && GolfMapVegSession.DirtyEntries().Count > 0)
            {
                GUILayout.BeginArea(new Rect(4, top + 2, width - 8, 30));
                using (new EditorGUILayout.HorizontalScope(EditorStyles.helpBox))
                {
                    GUILayout.Label("A palette file changed on disk while you have unsaved edits here.", EditorStyles.wordWrappedMiniLabel);
                    if (GUILayout.Button("Reload (drop mine)", GUILayout.Width(130))) { GolfMapVegSession.Load(); GUIUtility.ExitGUI(); }
                }
                GUILayout.EndArea();
                top += 34;
            }
            if (showSaved)
            {
                EditorGUI.HelpBox(new Rect(4, top + 2, width - 8, 26), "Showing the SAVED values in the scene (A/B). Editing is off until you switch back.", MessageType.Info);
                top += 30;
            }
            var status = new Rect(0, position.height - 20, width, 20);
            var body = new Rect(0, top, width, Mathf.Max(0, status.y - top));
            listWidth = Mathf.Clamp(listWidth, 220, Mathf.Max(240, position.width - 320));
            var left = new Rect(body.x, body.y, listWidth, body.height);
            var splitter = new Rect(left.xMax, body.y, 4, body.height);
            var right = new Rect(splitter.xMax, body.y, body.width - splitter.xMax, body.height);
            DrawList(left);
            DrawSplitter(splitter);
            GUILayout.BeginArea(new Rect(right.x + 6, right.y + 4, right.width - 10, right.height - 4));
            detailScroll = EditorGUILayout.BeginScrollView(detailScroll);
            using (new EditorGUI.DisabledScope(showSaved)) DrawDetail();
            EditorGUILayout.EndScrollView();
            GUILayout.EndArea();
            DrawStatus(status);
        }

        void DrawSplitter(Rect r)
        {
            EditorGUI.DrawRect(new Rect(r.x + 1, r.y, 1, r.height), new Color(0, 0, 0, 0.35f));
            EditorGUIUtility.AddCursorRect(r, MouseCursor.ResizeHorizontal);
            var e = Event.current;
            if (e.type == EventType.MouseDown && r.Contains(e.mousePosition)) { resizing = true; e.Use(); }
            if (resizing && e.type == EventType.MouseDrag) { listWidth = e.mousePosition.x; Repaint(); e.Use(); }
            if (e.type == EventType.MouseUp) resizing = false;
        }

        void DrawStatus(Rect r)
        {
            EditorGUI.DrawRect(r, new Color(0, 0, 0, 0.12f));
            string text = !string.IsNullOrEmpty(note) ? note : GolfMapVegSession.LastResult;
            GUI.Label(new Rect(r.x + 6, r.y + 2, r.width - 12, r.height - 2), new GUIContent(text, text), EditorStyles.miniLabel);
        }

        // ---- toolbar -------------------------------------------------------------------------

        void DrawToolbar()
        {
            int dirty = GolfMapVegSession.DirtyEntries().Count;
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                using (new EditorGUI.DisabledScope(dirty == 0 || showSaved))
                {
                    if (GUILayout.Button(new GUIContent(dirty > 0 ? "Save (" + dirty + ")" : "Save", "Write the edits to grass-palette.json / palette.json."), EditorStyles.toolbarButton, GUILayout.Width(64)))
                    { CommitAdjust(); note = GolfMapVegSession.Save(); }
                    if (GUILayout.Button(new GUIContent("Revert", "Put every entry back to the saved values (undoable)."), EditorStyles.toolbarButton, GUILayout.Width(52)))
                    { CommitAdjust(); GolfMapVegSession.Revert(); note = "Reverted to the saved palettes."; }
                }
                using (new EditorGUI.DisabledScope(dirty == 0 && !showSaved))
                {
                    bool ab = GUILayout.Toggle(showSaved, new GUIContent(showSaved ? "B: saved" : "A: edited", "Flip the scene between your edits and the saved values, to judge a change."), EditorStyles.toolbarButton, GUILayout.Width(66));
                    if (ab != showSaved) { showSaved = ab; CommitAdjust(); GolfMapVegSession.ShowSaved(showSaved); }
                }
                bool s = GUILayout.Toggle(solo, new GUIContent("Solo", "Hide every other lower-vegetation item while judging the selected ones. Undone on toggle-off, close, scene save and script reload."), EditorStyles.toolbarButton, GUILayout.Width(40));
                if (s != solo) { solo = s; if (solo) note = "Solo: hid " + GolfMapVegLive.Solo(SelectedGrassNames()) + " other item(s)."; else { GolfMapVegLive.Unsolo(); note = "Solo off."; } }
                using (new EditorGUI.DisabledScope(selection.Count == 0))
                    if (GUILayout.Button(new GUIContent("Go to", "Frame the Scene view where the selection grows most; click again for the next spot. (Double-click a row, or F.)"), EditorStyles.toolbarButton, GUILayout.Width(44))) GoTo();
                if (GUILayout.Button(new GUIContent("Views", "Saved Scene view positions for this course: come back to the same spot after each change."), EditorStyles.toolbarDropDown, GUILayout.Width(52))) ViewsMenu();
                GUILayout.FlexibleSpace();
                search = GUILayout.TextField(search, GUI.skin.FindStyle("ToolbarSeachTextField") ?? EditorStyles.toolbarTextField, GUILayout.Width(150));
                if (GUILayout.Button("", GUI.skin.FindStyle(string.IsNullOrEmpty(search) ? "ToolbarSeachCancelButtonEmpty" : "ToolbarSeachCancelButton") ?? EditorStyles.toolbarButton)) { search = ""; GUI.FocusControl(null); }
                if (GUILayout.Button(new GUIContent("Rebuild VSP", "Save, then golfmap.grass.apply (+ zones import when items were added/replaced): for what a live push cannot show - texture white point, a bush's first material overrides, new items."), EditorStyles.toolbarButton, GUILayout.Width(80)))
                { CommitAdjust(); note = GolfMapVegSession.Rebuild(); }
                if (GUILayout.Button(new GUIContent("Reload", "Read both palette files again."), EditorStyles.toolbarButton, GUILayout.Width(48)))
                {
                    if (dirty == 0 || EditorUtility.DisplayDialog("Vegetation palettes", "Drop " + dirty + " unsaved change(s) and read the files again?", "Reload", "Cancel"))
                    { GolfMapVegSession.Revert(); GolfMapVegSession.Load(); thumbs.Clear(); note = "Reloaded."; GUIUtility.ExitGUI(); }
                }
            }
        }

        // ---- list ----------------------------------------------------------------------------

        sealed class Row
        {
            public string group;            // expand key for group rows
            public string label, tip;
            public bool section, header;
            public GolfMapVegEntry entry;   // item/look rows, and a palette's own entry on its header
            public List<GolfMapVegEntry> members = new List<GolfMapVegEntry>();
            public Rect rect;
        }

        static string GroupKey(GolfMapVegEntry e)
        {
            if (e.kind == GolfMapVegKind.Tree) return "s:" + e.species;
            if (e.kind == GolfMapVegKind.Palette) return e.key;
            return "p:" + (e.palettes.FirstOrDefault() ?? "");
        }

        void Expand(string group, bool on) { if (on && !expanded.Contains(group)) expanded.Add(group); if (!on) expanded.Remove(group); }

        bool Matches(GolfMapVegEntry e) { return string.IsNullOrEmpty(search) || e.name.IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0 || (e.species ?? "").IndexOf(search, StringComparison.OrdinalIgnoreCase) >= 0; }

        List<Row> BuildRows()
        {
            var list = new List<Row>();
            var palettes = State.entries.Where(e => e.kind == GolfMapVegKind.Palette).ToList();
            if (palettes.Count > 0) list.Add(new Row { section = true, label = "LOWER VEGETATION", tip = GolfMapVegSession.Saved.grassPath });
            foreach (var pe in palettes)
            {
                var members = pe.members.Select(k => State.Get(k)).Where(x => x != null).ToList();
                bool groupHit = Matches(pe);
                var shown = groupHit ? members : members.Where(Matches).ToList();
                if (!groupHit && shown.Count == 0) continue;
                list.Add(new Row { header = true, group = pe.key, label = pe.name, entry = pe, members = members });
                if (expanded.Contains(pe.key) || !string.IsNullOrEmpty(search))
                    foreach (var e in shown) list.Add(new Row { entry = e, group = pe.key, label = e.name });
            }
            var trees = State.entries.Where(e => e.kind == GolfMapVegKind.Tree).ToList();
            if (trees.Count > 0) list.Add(new Row { section = true, label = "TREES", tip = GolfMapVegSession.Saved.treePath });
            foreach (var species in trees.GroupBy(e => e.species))
            {
                var members = species.ToList();
                bool groupHit = Matches(members[0]);
                var shown = groupHit ? members : members.Where(Matches).ToList();
                if (shown.Count == 0) continue;
                string g = "s:" + species.Key;
                list.Add(new Row { header = true, group = g, label = species.Key, members = members });
                if (expanded.Contains(g) || !string.IsNullOrEmpty(search))
                    foreach (var e in shown) list.Add(new Row { entry = e, group = g, label = e.name });
            }
            return list;
        }

        static readonly Color SelectedColour = new Color(0.24f, 0.48f, 0.9f, 0.45f), HoverColour = new Color(1, 1, 1, 0.06f);

        void DrawList(Rect area)
        {
            rows = BuildRows();
            float height = rows.Sum(r => r.section ? 20 : r.header ? 22 : 24) + 8;
            var view = new Rect(0, 0, area.width - 16, height);
            listScroll = GUI.BeginScrollView(area, listScroll, view);
            float y = 2;
            var e = Event.current;
            foreach (var row in rows)
            {
                float h = row.section ? 20 : row.header ? 22 : 24;
                row.rect = new Rect(0, y, view.width, h);
                y += h;
                if (row.rect.yMax < listScroll.y || row.rect.y > listScroll.y + area.height) continue;
                if (row.section) { GUI.Label(new Rect(6, row.rect.y + 4, row.rect.width, 16), new GUIContent(row.label, row.tip), EditorStyles.miniBoldLabel); continue; }
                bool selected = row.header ? row.members.Count > 0 && row.members.All(m => selection.Contains(m.key)) : selection.Contains(row.entry.key);
                if (selected) EditorGUI.DrawRect(row.rect, SelectedColour);
                else if (row.rect.Contains(e.mousePosition)) EditorGUI.DrawRect(row.rect, HoverColour);
                if (row.header) DrawHeaderRow(row); else DrawItemRow(row);
            }
            // Not over the scrollbar: EndScrollView handles those clicks.
            if (e.mousePosition.x < view.width) HandleListMouse(e);
            GUI.EndScrollView();
            if (e.type == EventType.MouseMove && area.Contains(e.mousePosition)) Repaint();
        }

        void DrawHeaderRow(Row row)
        {
            var r = row.rect;
            bool open = expanded.Contains(row.group) || !string.IsNullOrEmpty(search);
            GUI.Label(new Rect(r.x + 4, r.y + 3, 14, 16), open ? "▾" : "▸", EditorStyles.label);
            bool dirty = row.members.Any(GolfMapVegSession.IsDirty) || (row.entry != null && GolfMapVegSession.IsDirty(row.entry));
            GUI.Label(new Rect(r.x + 18, r.y + 3, r.width - 120, 16), new GUIContent(row.label + (dirty ? "  ●" : ""), row.header && row.entry != null ? "Palette (zone type slot). Click: select all of it." : "Species. Click: select all its looks."), EditorStyles.boldLabel);
            // The members' healthy tints at a glance.
            float x = r.xMax - 8;
            foreach (var m in row.members.Take(10).Reverse())
            {
                var c = m.Role("healthy").FirstOrDefault();
                if (c == null) continue;
                x -= 9;
                EditorGUI.DrawRect(new Rect(x, r.y + 7, 8, 8), c.c);
            }
            GUI.Label(new Rect(x - 28, r.y + 4, 26, 16), row.members.Count.ToString(), EditorStyles.miniLabel);
        }

        void DrawItemRow(Row row)
        {
            var r = row.rect; var e = row.entry;
            var thumb = new Rect(r.x + 18, r.y + 2, 20, 20);
            DrawThumb(thumb, e, false);
            bool dirty = GolfMapVegSession.IsDirty(e);
            string label = e.kind == GolfMapVegKind.Tree ? e.name + (e.readOnly ? "  (source)" : "") : ShortName(e);
            var style = e.readOnly ? EditorStyles.centeredGreyMiniLabel : EditorStyles.label;
            string tip = e.name + (e.palettes.Count > 1 ? "\nAlso in: " + string.Join(", ", e.palettes.ToArray()) + " (one VSP item: edits change it everywhere)" : "") + (e.readOnly ? "\n" + e.readOnlyWhy : "");
            var labelRect = new Rect(thumb.xMax + 4, r.y + 4, r.width - thumb.xMax - 64, 16);
            GUI.Label(labelRect, new GUIContent(label + (dirty ? "  ●" : ""), tip), e.readOnly ? new GUIStyle(EditorStyles.label) { normal = { textColor = Color.gray } } : style);
            float x = r.xMax - 6;
            var dry = e.Role("dry").FirstOrDefault(); var healthy = e.Role("healthy").FirstOrDefault();
            if (dry != null) { x -= 10; EditorGUI.DrawRect(new Rect(x, r.y + 5, 9, 14), dry.c); }
            if (healthy != null) { x -= 10; EditorGUI.DrawRect(new Rect(x, r.y + 5, 9, 14), healthy.c); }
            if (e.palettes.Count > 1 && e.kind != GolfMapVegKind.Tree) { x -= 22; GUI.Label(new Rect(x, r.y + 5, 22, 14), new GUIContent("×" + e.palettes.Count, tip), EditorStyles.miniLabel); }
            if (!GolfMapVegLive.InScene(e)) { x -= 14; GUI.Label(new Rect(x, r.y + 4, 14, 16), new GUIContent("!", "Not in VSP yet: Rebuild VSP creates it (and a zones import gives it its mask)."), EditorStyles.boldLabel); }
        }

        // "Creek reed - upright blades" under creek_bank/reed reads better as "upright blades".
        static string ShortName(GolfMapVegEntry e)
        {
            int dash = e.name.IndexOf(" - ", StringComparison.Ordinal);
            return dash > 0 && dash < e.name.Length - 3 ? e.name.Substring(dash + 3) + "   " + e.name.Substring(0, dash) : e.name;
        }

        void HandleListMouse(Event e)
        {
            if (e.type != EventType.MouseDown || e.button != 0) return;
            var row = rows.FirstOrDefault(r => !r.section && r.rect.Contains(e.mousePosition));
            if (row == null) { if (!e.control && !e.shift) { SetSelection(new List<string>()); e.Use(); } return; }
            if (row.header && e.mousePosition.x < row.rect.x + 18) { Expand(row.group, !expanded.Contains(row.group)); e.Use(); Repaint(); return; }
            if (e.clickCount == 2 && !row.header) { SetSelection(new List<string> { row.entry.key }); GoTo(); e.Use(); return; }
            var keys = row.header ? row.members.Select(m => m.key).Concat(row.entry != null ? new[] { row.entry.key } : new string[0]).ToList() : new List<string> { row.entry.key };
            var next = new List<string>(selection);
            if (e.shift && anchor != null && !row.header)
            {
                var flat = rows.Where(r => !r.section && !r.header).Select(r => r.entry.key).ToList();
                int a = flat.IndexOf(anchor), b = flat.IndexOf(row.entry.key);
                if (a >= 0 && b >= 0) foreach (var k in flat.Skip(Math.Min(a, b)).Take(Math.Abs(a - b) + 1)) if (!next.Contains(k)) next.Add(k);
            }
            else if (EditorGUI.actionKey || e.control)
            {
                if (keys.All(next.Contains)) next.RemoveAll(keys.Contains); else next.AddRange(keys.Where(k => !next.Contains(k)));
                anchor = row.header ? anchor : row.entry.key;
            }
            else { next = keys; anchor = row.header ? null : row.entry.key; if (row.header) Expand(row.group, true); }
            SetSelection(next);
            GUI.FocusControl(null);
            e.Use();
        }

        void SetSelection(List<string> keys)
        {
            CommitAdjust();
            selection = keys.Distinct().ToList();
            CloseMaterialEditors();
            if (solo) GolfMapVegLive.Solo(SelectedGrassNames());
            Repaint();
        }

        List<GolfMapVegEntry> Selected() { return selection.Select(k => State.Get(k)).Where(e => e != null).ToList(); }
        List<GolfMapVegEntry> Editable() { return Selected().Where(e => !e.readOnly).ToList(); }
        IEnumerable<string> SelectedGrassNames()
        {
            return Selected().SelectMany(e => e.kind == GolfMapVegKind.Palette ? e.members.Select(k => State.Get(k)).Where(x => x != null) : new[] { e })
                .Where(e => e.kind == GolfMapVegKind.Grass || e.kind == GolfMapVegKind.Bush).Select(e => e.name).Distinct();
        }

        void HandleKeys()
        {
            var e = Event.current;
            if (e.type != EventType.KeyDown || GUIUtility.keyboardControl != 0) return;
            var flat = rows.Where(r => !r.section && !r.header).Select(r => r.entry.key).ToList();
            if (e.keyCode == KeyCode.Escape) { SetSelection(new List<string>()); e.Use(); }
            else if (e.keyCode == KeyCode.F && selection.Count > 0) { GoTo(); e.Use(); }
            else if (e.keyCode == KeyCode.A && (e.control || e.command)) { SetSelection(flat); e.Use(); }
            else if ((e.keyCode == KeyCode.DownArrow || e.keyCode == KeyCode.UpArrow) && flat.Count > 0)
            {
                int at = selection.Count > 0 ? flat.IndexOf(selection.Last()) : -1;
                at = Mathf.Clamp(at + (e.keyCode == KeyCode.DownArrow ? 1 : -1), 0, flat.Count - 1);
                if (e.shift) { var next = new List<string>(selection); if (!next.Contains(flat[at])) next.Add(flat[at]); SetSelection(next); }
                else { SetSelection(new List<string> { flat[at] }); anchor = flat[at]; }
                e.Use();
            }
        }

        // ---- thumbnails ---------------------------------------------------------------------

        Texture Thumb(GolfMapVegEntry e)
        {
            string key = e.kind == GolfMapVegKind.Grass ? "g:" + e.source + ":" + e.Get("whitePoint", 0.92f) : e.source ?? "";
            Texture t;
            if (thumbs.TryGetValue(key, out t) && t) return t;
            if (string.IsNullOrEmpty(e.source)) return null;
            if (e.kind == GolfMapVegKind.Grass)
            {
                // The greyscale copy VSP draws (tinted below exactly as the shader tints it), else the pack's texture.
                string grey = GolfMapGrass.GreyTexturePath(GolfMapCourses.Folder(GolfMapVegSession.Course()), e.source, e.Get("whitePoint", 0.92f));
                t = AssetDatabase.LoadAssetAtPath<Texture2D>(grey) ?? AssetDatabase.LoadAssetAtPath<Texture2D>(e.source);
                thumbs[key] = t;
                return t;
            }
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(e.source);
            if (!prefab) return null;
            t = AssetPreview.GetAssetPreview(prefab);
            if (t) thumbs[key] = t; else if (AssetPreview.IsLoadingAssetPreview(prefab.GetInstanceID())) Repaint();
            return t;
        }

        // A sky-grey backdrop and a little light on the tint: VSP draws the blades lit by the sun,
        // so the plain texture x tint reads far darker than the grass on screen.
        static readonly Color Backdrop = new Color(0.62f, 0.67f, 0.72f);
        static Color Lit(Color c) { return new Color(Mathf.Clamp01(c.r * 1.35f), Mathf.Clamp01(c.g * 1.35f), Mathf.Clamp01(c.b * 1.35f), 1); }

        void DrawThumb(Rect r, GolfMapVegEntry e, bool split)
        {
            EditorGUI.DrawRect(r, e.kind == GolfMapVegKind.Grass ? Backdrop : new Color(0.2f, 0.21f, 0.2f));
            var t = Thumb(e);
            if (!t) return;
            if (e.kind != GolfMapVegKind.Grass) { GUI.DrawTexture(r, t, ScaleMode.ScaleToFit); return; }
            var healthy = e.Role("healthy").FirstOrDefault(); var dry = e.Role("dry").FirstOrDefault();
            var old = GUI.color;
            if (split && healthy != null && dry != null)
            {
                // Left half healthy, right half dry: the two ends of VSP's tint noise.
                GUI.color = Lit(healthy.c); GUI.DrawTextureWithTexCoords(new Rect(r.x, r.y, r.width / 2, r.height), t, new Rect(0, 0, 0.5f, 1));
                GUI.color = Lit(dry.c); GUI.DrawTextureWithTexCoords(new Rect(r.x + r.width / 2, r.y, r.width / 2, r.height), t, new Rect(0.5f, 0, 0.5f, 1));
            }
            else { GUI.color = healthy != null ? Lit(healthy.c) : Color.white; GUI.DrawTexture(r, t, ScaleMode.StretchToFill); }
            GUI.color = old;
        }

        // ---- detail ----------------------------------------------------------------------------

        void DrawDetail()
        {
            var selected = Selected();
            if (selected.Count == 0)
            {
                EditorGUILayout.Space();
                EditorGUILayout.LabelField("Select what to tune", EditorStyles.boldLabel);
                EditorGUILayout.LabelField("Click an item or look; Ctrl-click adds, Shift-click adds a range; click a palette or species to take all of it. Select across palettes and trees to change them together.\n\nChanges show in the Scene view while you drag (Go to jumps there). Nothing is written until Save; Ctrl+Z undoes.", EditorStyles.wordWrappedLabel);
                foreach (var n in GolfMapVegSession.Notes) EditorGUILayout.HelpBox(n, MessageType.None);
                return;
            }
            DrawSelectionHeader(selected);
            DrawAdjust(selected);
            float labels = EditorGUIUtility.labelWidth;
            EditorGUIUtility.labelWidth = Mathf.Clamp((position.width - listWidth) * 0.4f, 150, 300);
            foreach (var section in GolfMapVegPalette.Sections) DrawSection(section, selected);
            EditorGUIUtility.labelWidth = labels;
            DrawTreeActions(selected);
            DrawCopyPaste(selected);
            GUILayout.Space(12);
        }

        void DrawSelectionHeader(List<GolfMapVegEntry> selected)
        {
            var items = selected.Where(e => e.kind != GolfMapVegKind.Palette).ToList();
            var palettes = items.SelectMany(e => e.palettes).Distinct().ToList();
            string title = items.Count == 1 ? items[0].kind == GolfMapVegKind.Tree ? items[0].species + " / " + items[0].name : items[0].name
                : items.Count + " selected" + (palettes.Count > 0 ? "  ·  used in " + string.Join(", ", palettes.Take(4).ToArray()) + (palettes.Count > 4 ? " +" + (palettes.Count - 4) : "") : "");
            if (items.Count == 0) title = string.Join(", ", selected.Select(e => e.name).ToArray());
            EditorGUILayout.LabelField(title, EditorStyles.boldLabel);
            if (items.Count == 1)
            {
                var e = items[0];
                string what = e.kind == GolfMapVegKind.Grass ? "Texture grass" : e.kind == GolfMapVegKind.Bush ? "Mesh bush" : "Tree look";
                if (e.kind != GolfMapVegKind.Tree && e.palettes.Count > 0) what += "  ·  in " + string.Join(", ", e.palettes.ToArray()) + (e.palettes.Count > 1 ? " (one VSP item: a change shows in all)" : "");
                EditorGUILayout.LabelField(what, EditorStyles.miniLabel);
                if (e.HasModel) DrawModelLine(e);
                if (e.readOnly) EditorGUILayout.HelpBox(e.readOnlyWhy, MessageType.Info);
                if (!string.IsNullOrEmpty(e.note)) EditorGUILayout.HelpBox(e.note, MessageType.Warning);
            }
            else if (items.Any(e => e.HasModel))
            {
                var models = items.Where(e => e.HasModel).Select(e => e.model).Distinct().ToList();
                EditorGUILayout.LabelField(new GUIContent("Models: " + string.Join(", ", models.Take(3).ToArray()) + (models.Count > 3 ? " +" + (models.Count - 3) : ""),
                    "Colours, shading and material (marked 'model') belong to the models: a change shows in every item that wears one."), EditorStyles.miniLabel);
            }
            if (items.Count > 1 && items.Any(e => !string.IsNullOrEmpty(e.note)))
                EditorGUILayout.HelpBox(string.Join(", ", items.Where(e => !string.IsNullOrEmpty(e.note)).Select(e => e.species + "/" + e.name).ToArray()) + ": draw with materials outside their look folder (select one for details).", MessageType.Warning);
            // Tiles: the selection as it looks now (grass: healthy | dry halves).
            int size = items.Count == 1 ? 96 : 40;
            float width = position.width - listWidth - 30;
            int perRow = Mathf.Max(1, (int)(width / (size + 4)));
            var shown = items.Take(perRow * 3).ToList();
            for (int i = 0; i < shown.Count; i += perRow)
            {
                var line = GUILayoutUtility.GetRect(width, size + 4);
                for (int j = 0; j < perRow && i + j < shown.Count; j++)
                {
                    var r = new Rect(line.x + j * (size + 4), line.y + 2, size, size);
                    DrawThumb(r, shown[i + j], true);
                    GUI.Label(r, new GUIContent("", shown[i + j].name));
                }
            }
            if (items.Count > shown.Count) EditorGUILayout.LabelField("+ " + (items.Count - shown.Count) + " more", EditorStyles.miniLabel);
        }

        // One line: the model the item wears, and how many items share its look.
        static void DrawModelLine(GolfMapVegEntry e)
        {
            var others = GolfMapVegSession.Current.entries.Where(o => o.model == e.model && o != e).Select(o => o.name).ToList();
            string tip = "Colours, shading and material are the model's (models.json, bun run models -- look): a change shows in "
                + (others.Count > 0 ? "these items too: " + string.Join(", ", others.ToArray()) : "every item that wears it") + ". Size and placement are this item's.";
            EditorGUILayout.LabelField(new GUIContent("Model " + e.model + (others.Count > 0 ? "  ·  " + (others.Count + 1) + " items" : ""), tip), EditorStyles.miniLabel);
        }

        // ---- adjust together ------------------------------------------------------------------

        void CommitAdjust() { baseline = null; adjust.Clear(); }

        void DrawAdjust(List<GolfMapVegEntry> selected)
        {
            var editable = selected.Where(e => !e.readOnly && e.kind != GolfMapVegKind.Palette).ToList();
            if (editable.Count == 0) return;
            bool anySize = editable.Any(e => e.Has("height"));
            GUILayout.Space(6);
            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Label(new GUIContent("Adjust together", "Relative to where the selection stood when you started: drag back to 0 to undo a slider. Keep makes the result the new start."), EditorStyles.boldLabel);
                    GUILayout.FlexibleSpace();
                    GUILayout.Label("Colours:", EditorStyles.miniLabel);
                    adjust.healthy = GUILayout.Toggle(adjust.healthy, "healthy", EditorStyles.miniButtonLeft);
                    adjust.dry = GUILayout.Toggle(adjust.dry, "dry", EditorStyles.miniButtonMid);
                    using (new EditorGUI.DisabledScope(!editable.Any(e => e.Has("bark"))))
                        adjust.bark = GUILayout.Toggle(adjust.bark, "bark", EditorStyles.miniButtonRight);
                }
                // Never a slider that silently does nothing: say what is missing instead.
                bool anyTint = editable.Any(e => e.values.Any(v => v.colour && (v.role == "healthy" && adjust.healthy || v.role == "dry" && adjust.dry || v.role == "bark" && adjust.bark)));
                if (!anyTint)
                    EditorGUILayout.LabelField(editable.Any(e => e.values.Any(v => v.colour && v.role == "bark")) && !adjust.bark
                        ? "Tick bark above to grade the bark: the selection has no leaf/blade tint of the ticked kinds."
                        : "The selection has no tint colour of the ticked kinds, so the colour sliders are off.", EditorStyles.wordWrappedMiniLabel);
                EditorGUI.BeginChangeCheck();
                using (new EditorGUI.DisabledScope(!anyTint))
                {
                    adjust.brightness = Percent("Brightness", "Linear-light brightness of the tints: -10% is 'a bit darker'.", adjust.brightness, -75, 100);
                    adjust.saturation = Percent("Saturation", "Colourfulness of the tints, luminance kept.", adjust.saturation, -100, 100);
                    adjust.hue = Slider("Hue", "Turns the tints round the colour wheel (degrees): + towards green/blue, - towards yellow/red.", adjust.hue, -45, 45, "0°");
                    adjust.warmth = Slider("Warmth", "+ warmer (yellow/red), - cooler (blue), brightness kept.", adjust.warmth * 100, -100, 100, "0") / 100;
                }
                using (new EditorGUI.DisabledScope(!anySize))
                {
                    adjust.height = Percent("Height", "Taller or shorter (grass and bushes).", adjust.height, -75, 200);
                    adjust.width = Percent("Width", "Wider or narrower cards / bushes.", adjust.width, -75, 200);
                    adjust.density = Percent("Density", "Instances per square metre (+100% = twice as many): spacing scales by 1/sqrt.", adjust.density, -90, 300);
                    adjust.spread = Percent("Size spread", "Widen (+) or narrow (-) the min..max scale range around its middle: more or less size variety.", adjust.spread, -100, 200);
                }
                if (EditorGUI.EndChangeCheck())
                {
                    if (baseline == null) baseline = editable.ToDictionary(e => e.key, e => e.Copy());
                    GolfMapVegSession.Record("Adjust vegetation palettes");
                    foreach (var e in editable) { GolfMapVegEntry b; if (baseline.TryGetValue(e.key, out b)) GolfMapVegPalette.Adjust(b, e, adjust); }
                    GolfMapVegSession.Push(editable, GUIUtility.hotControl != 0);
                    note = "";
                }
                using (new EditorGUILayout.HorizontalScope())
                {
                    if (baseline != null) DrawBeforeAfter(editable);
                    GUILayout.FlexibleSpace();
                    using (new EditorGUI.DisabledScope(baseline == null))
                    {
                        if (GUILayout.Button(new GUIContent("Reset", "Back to where the sliders started."), EditorStyles.miniButtonLeft, GUILayout.Width(50)))
                        {
                            GolfMapVegSession.Record("Reset adjust");
                            adjust.Clear();
                            foreach (var e in editable) { GolfMapVegEntry b; if (baseline.TryGetValue(e.key, out b)) GolfMapVegPalette.Adjust(b, e, adjust); }
                            GolfMapVegSession.Push(editable, false);
                            baseline = null;
                        }
                        if (GUILayout.Button(new GUIContent("Keep", "Keep the result and put the sliders back to 0 for the next step (Save writes the files)."), EditorStyles.miniButtonRight, GUILayout.Width(50))) CommitAdjust();
                    }
                }
            }
        }

        // Baseline over current healthy tint of each graded entry: what the sliders did.
        void DrawBeforeAfter(List<GolfMapVegEntry> editable)
        {
            var r = GUILayoutUtility.GetRect(10, 16, GUILayout.ExpandWidth(true));
            float x = r.x;
            foreach (var e in editable.Take(40))
            {
                GolfMapVegEntry b;
                if (!baseline.TryGetValue(e.key, out b)) continue;
                var now = e.Role("healthy").FirstOrDefault(); var then = b.Role("healthy").FirstOrDefault();
                if (now == null || then == null) continue;
                if (x + 10 > r.xMax) break;
                EditorGUI.DrawRect(new Rect(x, r.y, 9, 7), then.c);
                EditorGUI.DrawRect(new Rect(x, r.y + 8, 9, 7), now.c);
                x += 11;
            }
            GUI.Label(new Rect(x + 2, r.y, 120, 16), "before / after", EditorStyles.miniLabel);
        }

        static float Percent(string label, string tip, float fraction, float min, float max)
        {
            return Slider(label, tip, fraction * 100, min, max, "0%") / 100;
        }

        static float Slider(string label, string tip, float value, float min, float max, string zero)
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label(new GUIContent(label, tip), GUILayout.Width(88));
                var track = GUILayoutUtility.GetRect(80, 10000, 18, 18, GUILayout.MinWidth(80));
                // The start (0) marked on the track: ranges are not symmetric.
                if (Event.current.type == EventType.Repaint)
                {
                    float zeroX = track.x + 5 + (track.width - 10) * Mathf.InverseLerp(min, max, 0);
                    EditorGUI.DrawRect(new Rect(zeroX - 1, track.y + 2, 2, 14), value == 0 ? new Color(0.3f, 0.3f, 0.3f, 0.5f) : new Color(0.24f, 0.48f, 0.9f, 0.9f));
                }
                value = GUI.HorizontalSlider(track, value, min, max);
                value = EditorGUILayout.FloatField(Mathf.Round(value * 10) / 10, GUILayout.Width(46));
                if (GUILayout.Button(new GUIContent("Ø", "Back to " + zero), EditorStyles.miniButton, GUILayout.Width(20))) value = 0;
            }
            return Mathf.Clamp(value, min, max);
        }

        // ---- settings, one section at a time ---------------------------------------------------

        bool Folded(string section) { return folded.Contains(section); }
        bool Foldout(string section, string label)
        {
            bool open = EditorGUILayout.Foldout(!Folded(section), label, true, EditorStyles.foldout);
            if (open == Folded(section)) { if (open) folded.Remove(section); else folded.Add(section); }
            return open;
        }

        // A setting row: the selection's values of one role (and material part), mixed or not.
        sealed class Field
        {
            public GolfMapVegRole role;
            public string part, slot;
            public List<GolfMapVegValue> values = new List<GolfMapVegValue>();
            public int entries;
        }

        List<Field> Fields(List<GolfMapVegEntry> entries, string section)
        {
            var fields = new List<Field>();
            bool single = entries.Count == 1;
            foreach (var e in entries)
                foreach (var v in e.values)
                {
                    var role = GolfMapVegPalette.Role(v.role);
                    if (role.section != section) continue;
                    // Binding weights: one row per palette for a single item, one for all otherwise.
                    string slot = v.role == "maxDensity" && single ? v.slot : null;
                    string part = e.kind == GolfMapVegKind.Tree && (GolfMapVegPalette.IsMaterial(v.role)) ? v.part : "";
                    var f = fields.FirstOrDefault(x => x.role.id == v.role && x.part == part && x.slot == slot);
                    if (f == null) { f = new Field { role = role, part = part, slot = slot }; fields.Add(f); }
                    f.values.Add(v);
                }
            foreach (var f in fields) f.entries = entries.Count(e => e.values.Any(f.values.Contains));
            return fields;
        }

        void DrawSection(string section, List<GolfMapVegEntry> selected)
        {
            var entries = selected.Where(e => !e.readOnly).ToList();
            entries = section == "Palette" ? entries.Where(e => e.kind == GolfMapVegKind.Palette).ToList() : entries.Where(e => e.kind != GolfMapVegKind.Palette).ToList();
            var fields = Fields(entries, section);
            if (fields.Count == 0) return;
            string title = section == "Material" ? "Material (bushes and tree looks)" : section == "Palette" ? "Palette-wide" : section == "Look" ? "Planting" : section;
            if (!Foldout(section, title)) return;
            EditorGUI.indentLevel++;
            if (section == "Material")
            {
                var curated = fields.Where(f => GolfMapVegPalette.CuratedMaterial.Contains(f.role.id.Substring(4))).OrderBy(f => Array.IndexOf(GolfMapVegPalette.CuratedMaterial, f.role.id.Substring(4))).ThenBy(f => f.part).ToList();
                foreach (var f in curated) DrawField(f, entries);
                var rest = fields.Except(curated).OrderBy(f => f.part).ThenBy(f => f.role.label).ToList();
                if (rest.Count > 0 && Foldout("More material", "More material settings (" + rest.Count + ")"))
                    foreach (var f in rest) DrawField(f, entries);
                DrawAllMaterialSettings(selected);
            }
            else foreach (var f in fields) DrawField(f, entries);
            EditorGUI.indentLevel--;
        }

        void DrawField(Field f, List<GolfMapVegEntry> entries)
        {
            var role = f.role;
            string label = role.label;
            if (!string.IsNullOrEmpty(f.part)) label = char.ToUpperInvariant(f.part[0]) + f.part.Substring(1) + " · " + label;
            if (f.slot != null) label += " · " + f.slot;
            if (f.entries < entries.Count) label += "  (" + f.entries + "/" + entries.Count + ")";
            bool model = GolfMapVegPalette.IsLookRole(role.id) && entries.Any(e => e.HasModel && e.values.Any(f.values.Contains));
            if (model) label += " · model";
            string tip = role.tip + (role.live == GolfMapVegRefresh.Rebuild ? "\n(Shows after Rebuild VSP.)" : role.live == GolfMapVegRefresh.File ? "\n(Only in the file: not shown live.)" : "")
                + (model ? "\n(The model's: every item of the model changes with it.)" : "");
            var first = f.values[0];
            bool mixed = f.values.Any(v => !v.Same(first));
            var content = new GUIContent(label + (role.live == GolfMapVegRefresh.Rebuild ? "  ↻" : role.live == GolfMapVegRefresh.File ? "  ↓" : ""), tip);
            EditorGUI.showMixedValue = mixed;
            EditorGUI.BeginChangeCheck();
            float f2 = first.f; Color c2 = first.c;
            if (first.colour) c2 = EditorGUILayout.ColorField(content, first.c, true, role.id == "hue", GolfMapVegPalette.IsBaked(first));
            else if (role.toggle || first.toggle) f2 = EditorGUILayout.Toggle(content, first.f > 0.5f) ? 1 : 0;
            else f2 = EditorGUILayout.Slider(content, first.f, Mathf.Min(role.min, first.f), Mathf.Max(role.max, first.f));
            bool changed = EditorGUI.EndChangeCheck();
            EditorGUI.showMixedValue = false;
            if (!changed) return;
            CommitAdjust();
            GolfMapVegSession.Record("Edit " + role.label);
            var targets = entries.Where(e => e.values.Any(f.values.Contains)).ToList();
            if (first.colour) GolfMapVegSession.Set(targets, role.id, string.IsNullOrEmpty(f.part) ? null : f.part, f.slot, null, c2);
            else GolfMapVegSession.Set(targets, role.id, string.IsNullOrEmpty(f.part) ? null : f.part, f.slot, f2, null);
            // Scale limits stay ordered.
            if (role.id == "minScale" || role.id == "maxScale")
                foreach (var e in targets)
                {
                    var min = e.Role("minScale").FirstOrDefault(); var max = e.Role("maxScale").FirstOrDefault();
                    if (min != null && max != null && min.f > max.f) { if (role.id == "minScale") max.f = min.f; else min.f = max.f; }
                }
            GolfMapVegSession.Push(targets, GUIUtility.hotControl != 0);
            note = "";
        }

        // Unity's own material editor for one tree look's materials: every shader property.
        void DrawAllMaterialSettings(List<GolfMapVegEntry> selected)
        {
            if (selected.Count != 1 || selected[0].kind != GolfMapVegKind.Tree || selected[0].readOnly) return;
            var e = selected[0];
            showAllMaterial = EditorGUILayout.Foldout(showAllMaterial, "All shader properties (Unity material editor)", true);
            if (!showAllMaterial) return;
            var materials = e.values.Select(v => v.slot).Where(s => !string.IsNullOrEmpty(s)).Distinct()
                .Select(g => AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g))).Where(m => m).ToList();
            EditorGUI.BeginChangeCheck();
            foreach (var m in materials)
            {
                UnityEditor.Editor editor;
                if (!materialEditors.TryGetValue(m, out editor) || !editor) materialEditors[m] = editor = UnityEditor.Editor.CreateEditor(m);
                editor.DrawHeader();
                var me = editor as MaterialEditor;
                if (me == null || me.isVisible) editor.OnInspectorGUI();
            }
            if (!EditorGUI.EndChangeCheck()) return;
            // The materials changed underneath: read them back so the palette and the scene follow.
            var biome = GolfMapVegSession.Biome();
            var group = biome == null ? null : biome.Species(e.species);
            var look = group == null ? null : group.looks.FirstOrDefault(l => l.id == e.look);
            if (look == null) return;
            var fresh = GolfMapVegPalette.TreeEntry(GolfMapVegSession.Course(), biome, e.species, look, false);
            GolfMapVegSession.Record("Edit look material");
            foreach (var v in e.values) { var n = fresh.Find(v); if (n != null) { v.c = n.c; v.f = n.f; } }
            GolfMapVegLive.Forget();
            GolfMapVegSession.Push(new[] { e }, GUIUtility.hotControl != 0);
        }

        void CloseMaterialEditors()
        {
            foreach (var ed in materialEditors.Values) if (ed) DestroyImmediate(ed);
            materialEditors.Clear();
        }

        // ---- tree looks -----------------------------------------------------------------------------

        void DrawTreeActions(List<GolfMapVegEntry> selected)
        {
            var trees = selected.Where(e => e.kind == GolfMapVegKind.Tree).ToList();
            if (trees.Count == 0) return;
            if (!Foldout("Tree looks", "Look actions")) return;
            EditorGUI.indentLevel++;
            var course = GolfMapVegSession.Course();
            var sourceOnly = trees.Where(e => e.readOnly && e.look == "original").Select(e => e.species).Distinct()
                .Where(s => !State.entries.Any(x => x.kind == GolfMapVegKind.Tree && x.species == s && !x.readOnly)).ToList();
            if (sourceOnly.Count > 0)
            {
                EditorGUILayout.HelpBox(string.Join(", ", sourceOnly.ToArray()) + (sourceOnly.Count == 1 ? " draws" : " draw") + " with the pack's own materials. A tunable look is a copy of them (and of the prefabs) that the species plants with instead; the Lab shows it at once, planted trees after the next Plant.", MessageType.Info);
                if (GUILayout.Button("Create a tunable look for " + string.Join(", ", sourceOnly.ToArray())))
                {
                    var made = new List<string>();
                    foreach (var s in sourceOnly) made.Add("t:" + s + "/" + GolfMapVegSession.CreateLook(s, "tuned", null));
                    SetSelection(made);
                    note = GolfMapVegSession.LastResult;
                    GUIUtility.ExitGUI();
                }
            }
            if (trees.Count == 1 && !trees[0].readOnly || trees.Count == 1 && trees[0].look != "original")
            {
                var e = trees[0];
                using (new EditorGUILayout.HorizontalScope())
                {
                    newLook = EditorGUILayout.TextField(new GUIContent("New look from this", "A copy of this look's materials to tune separately; the species then splits its stems between its looks by weight."), newLook);
                    using (new EditorGUI.DisabledScope(string.IsNullOrEmpty(newLook.Trim())))
                        if (GUILayout.Button("Duplicate", GUILayout.Width(72)))
                        {
                            string id = GolfMapVegSession.CreateLook(e.species, newLook, e);
                            newLook = ""; SetSelection(new List<string> { "t:" + e.species + "/" + id }); note = GolfMapVegSession.LastResult; GUIUtility.ExitGUI();
                        }
                }
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Space(EditorGUI.indentLevel * 15);
                    if (!e.readOnly && GUILayout.Button(new GUIContent("Regenerate", "Create missing material/prefab copies and re-point the prefab copies. Tuned materials are kept."))) note = GolfMapVegSession.RegenerateLook(e);
                    if (e.readOnly && e.look != "original" && GUILayout.Button("Create its copies")) note = GolfMapVegSession.RegenerateLook(e);
                    using (new EditorGUI.DisabledScope(State.entries.Count(x => x.kind == GolfMapVegKind.Tree && x.species == e.species) <= 1))
                        if (GUILayout.Button(new GUIContent("Remove look", "From the palette; its folder stays (planted trees use it until the next Plant).")) &&
                            EditorUtility.DisplayDialog("Remove look", "Remove the look '" + e.look + "' from " + e.species + "?", "Remove", "Cancel"))
                        { note = GolfMapVegSession.RemoveLook(e); SetSelection(new List<string>()); GUIUtility.ExitGUI(); }
                }
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Space(EditorGUI.indentLevel * 15);
                if (GUILayout.Button(new GUIContent("Show in Lab", "Stand one tree per selected look and shape at the Scene view's pivot (rows = looks, shapes by height). They draw with the materials being tuned: every change shows at once.")))
                    note = GolfMapVegLive.BuildLab(course, trees);
                using (new EditorGUI.DisabledScope(!GolfMapVegLive.LabRoot()))
                {
                    if (GUILayout.Button("Look at Lab")) GolfMapVegLive.FrameLab();
                    if (GUILayout.Button("Clear Lab")) GolfMapVegLive.ClearLab();
                }
            }
            EditorGUILayout.LabelField("Colour and material changes show on planted inner trees live. New looks and weights: the next Plant. Outer billboards: Plant outer with rebake.", EditorStyles.wordWrappedMiniLabel);
            EditorGUI.indentLevel--;
        }

        // ---- copy / paste --------------------------------------------------------------------

        static readonly string[] PasteSections = { "Colours", "Size", "Placement", "Shading", "Rendering", "Material" };

        void DrawCopyPaste(List<GolfMapVegEntry> selected)
        {
            var items = selected.Where(e => e.kind != GolfMapVegKind.Palette).ToList();
            if (items.Count == 0) return;
            if (!Foldout("Copy", "Copy settings between items")) return;
            EditorGUI.indentLevel++;
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Space(EditorGUI.indentLevel * 15);
                using (new EditorGUI.DisabledScope(items.Count != 1))
                    if (GUILayout.Button(new GUIContent("Copy " + (items.Count == 1 ? "'" + items[0].name + "'" : "(select one)"), "Remember this item's settings to paste onto others.")))
                    { clipboard = items[0].Copy(); note = "Copied " + clipboard.name + "."; }
                using (new EditorGUI.DisabledScope(clipboard == null || items.All(e => e.readOnly)))
                    if (GUILayout.Button(new GUIContent("Paste onto selection", clipboard == null ? "Copy an item first." : "Set the ticked kinds of settings from " + clipboard.name + ".")))
                    {
                        CommitAdjust();
                        GolfMapVegSession.Record("Paste vegetation settings");
                        var editable = items.Where(e => !e.readOnly).ToList();
                        GolfMapVegSession.Paste(clipboard, editable, new HashSet<string>(pasteSections));
                        GolfMapVegSession.Push(editable, false);
                        note = "Pasted " + string.Join(", ", pasteSections.ToArray()).ToLowerInvariant() + " from " + clipboard.name + " onto " + editable.Count + ".";
                    }
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Space(EditorGUI.indentLevel * 15);
                foreach (var s in PasteSections)
                {
                    bool on = pasteSections.Contains(s), now = GUILayout.Toggle(on, s, EditorStyles.miniButton);
                    if (now != on) { if (now) pasteSections.Add(s); else pasteSections.Remove(s); }
                }
            }
            if (clipboard != null) EditorGUILayout.LabelField("Clipboard: " + clipboard.name, EditorStyles.miniLabel);
            EditorGUI.indentLevel--;
        }

        // ---- going places ------------------------------------------------------------------------

        void GoTo()
        {
            var selected = Selected();
            string signature = string.Join("|", selection.OrderBy(k => k, StringComparer.Ordinal).ToArray());
            if (signature != spotSignature || spots == null)
            {
                string problem;
                spots = GolfMapVegSession.Spots(selected, out problem);
                spotSignature = signature; spotIndex = 0;
                if (spots.Count == 0) { note = problem ?? "Nowhere to go."; return; }
            }
            else spotIndex = (spotIndex + 1) % Math.Max(1, spots.Count);
            if (spots.Count == 0) return;
            bool trees = selected.All(e => e.kind == GolfMapVegKind.Tree);
            GolfMapVegLive.Frame(spots[spotIndex], trees ? 40 : 16);
            note = "Spot " + (spotIndex + 1) + " of " + spots.Count + (trees ? " (planted trees)" : " (densest first)") + ": Go to again for the next.";
        }

        [Serializable] class SavedView { public string name; public Vector3 pivot; public Quaternion rotation; public float size; }
        [Serializable] class SavedViews { public List<SavedView> views = new List<SavedView>(); }

        static string ViewsKey { get { return "GolfMapVegViews:" + GolfMapVegSession.Saved.coursePath; } }
        static SavedViews LoadViews()
        {
            var text = EditorPrefs.GetString(ViewsKey, "");
            try { return string.IsNullOrEmpty(text) ? new SavedViews() : JsonUtility.FromJson<SavedViews>(text) ?? new SavedViews(); }
            catch (Exception) { return new SavedViews(); }
        }

        void ViewsMenu()
        {
            var views = LoadViews();
            var menu = new GenericMenu();
            foreach (var v in views.views)
            {
                var view = v;
                menu.AddItem(new GUIContent(view.name), false, () => { var sv = SceneView.lastActiveSceneView; if (sv) { sv.LookAt(view.pivot, view.rotation, view.size); sv.Repaint(); } });
            }
            if (views.views.Count > 0) menu.AddSeparator("");
            var scene = SceneView.lastActiveSceneView;
            string name = (Selected().FirstOrDefault(e => e.kind != GolfMapVegKind.Palette) ?? Selected().FirstOrDefault())?.name ?? "View";
            name = name.Replace("/", "∕") + " " + (views.views.Count + 1);
            if (scene) menu.AddItem(new GUIContent("Save current view as “" + name + "”"), false, () =>
            {
                views.views.Add(new SavedView { name = name, pivot = scene.pivot, rotation = scene.rotation, size = scene.size });
                EditorPrefs.SetString(ViewsKey, JsonUtility.ToJson(views));
            });
            foreach (var v in views.views)
            {
                var view = v;
                menu.AddItem(new GUIContent("Delete/" + view.name), false, () => { views.views.Remove(view); EditorPrefs.SetString(ViewsKey, JsonUtility.ToJson(views)); });
            }
            menu.ShowAsContext();
        }
    }
}
