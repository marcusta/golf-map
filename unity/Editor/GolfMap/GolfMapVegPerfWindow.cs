// GolfMap > Vegetation Performance: switch VSP systems, storage, shadows, packages, types and
// single items off live, time the Scene view frame, and sweep every part in turn to find the
// expensive one. The work is in GolfMapVegPerf.cs (shared with the golfmap.vegperf.* commands).
using System;
using System.Collections.Generic;
using System.Linq;
using AwesomeTechnologies.VegetationSystem;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    sealed class GolfMapVegPerfWindow : EditorWindow
    {
        [MenuItem("GolfMap/Vegetation Performance")]
        static void Open() { GetWindow<GolfMapVegPerfWindow>("Veg Performance").Show(); }

        int frames = 60;
        int sweepTop = 15;
        bool[] sweepLevels = GolfMapVegPerf.AllLevels.Select(l => true).ToArray();
        Vector2 scroll;
        readonly Dictionary<string, bool> folds = new Dictionary<string, bool>();

        IEnumerator<object> job;
        string jobName, progress;
        GolfMapVegPerf.Timing last, previous;
        Dictionary<string, GolfMapVegPerf.ItemStats> stats = new Dictionary<string, GolfMapVegPerf.ItemStats>();
        List<GolfMapVegPerf.SweepRow> sweepRows;
        double sweepBase;

        void OnEnable() { GolfMapVegPerf.Changed += Repaint; EditorApplication.update += Step; }
        void OnDisable() { GolfMapVegPerf.Changed -= Repaint; EditorApplication.update -= Step; if (job != null) job.Dispose(); job = null; }

        void Step()
        {
            if (job == null) return;
            try
            {
                if (!job.MoveNext()) { job = null; Finish(); }
            }
            catch (Exception e)
            {
                job = null;
                progress = "Failed: " + e.Message;
                Debug.LogException(e);
            }
            Repaint();
        }

        Action Finish = () => { };

        void StartMeasure()
        {
            var holder = new GolfMapVegPerf.Timing[1];
            jobName = "Measuring"; progress = null;
            job = GolfMapVegPerf.Measure(20, frames, 1920, 1080, true, holder).GetEnumerator();
            Finish = () =>
            {
                if (holder[0] == null) return;
                previous = last;
                last = holder[0];
                stats = last.items.ToDictionary(x => StatKey(x.system, x.package, x.name), x => x);
                progress = null;
            };
        }

        void StartSweep()
        {
            var levels = GolfMapVegPerf.AllLevels.Where((l, i) => sweepLevels[i]).ToArray();
            var holder = new object[3];
            jobName = "Sweeping";
            job = GolfMapVegPerf.Sweep(levels, Math.Max(10, frames / 2), sweepTop, 1920, 1080, holder, p => progress = p).GetEnumerator();
            Finish = () =>
            {
                sweepRows = holder[1] as List<GolfMapVegPerf.SweepRow>;
                sweepBase = holder[2] is double ? (double)holder[2] : 0;
                progress = null;
                Debug.Log("[GolfMap] Vegetation sweep:\n" + string.Join("\n", (sweepRows ?? new List<GolfMapVegPerf.SweepRow>())
                    .Select(r => string.Format("{0,7:0.00} ms saved  {1,-8} {2}", r.savedMs, r.level, r.what)).ToArray()));
            };
        }

        static string StatKey(string system, string package, string item) { return system + "|" + package + "|" + item; }

        void OnGUI()
        {
            bool busy = job != null;
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                GUI.enabled = !busy;
                if (GUILayout.Button("Measure", EditorStyles.toolbarButton, GUILayout.Width(70))) StartMeasure();
                if (GUILayout.Button("Sweep", EditorStyles.toolbarButton, GUILayout.Width(60))) StartSweep();
                GUILayout.Label("frames", GUILayout.Width(44));
                frames = Mathf.Clamp(EditorGUILayout.IntField(frames, EditorStyles.toolbarTextField, GUILayout.Width(40)), 5, 1000);
                GUILayout.FlexibleSpace();
                GUI.enabled = !busy && (GolfMapVegPerf.HiddenCount > 0 || GolfMapVegPerf.SwitchesChanged);
                if (GUILayout.Button("Show all", EditorStyles.toolbarButton, GUILayout.Width(70))) GolfMapVegPerf.ShowAll();
                GUI.enabled = true;
            }
            if (busy)
            {
                EditorGUILayout.HelpBox(jobName + "... " + (progress ?? "") + "  (keep the Scene view where it is)", MessageType.Info);
                if (GUILayout.Button("Stop")) { job.Dispose(); job = null; GolfMapVegPerf.ShowAll(); }
            }
            else if (progress != null) EditorGUILayout.HelpBox(progress, MessageType.Error);

            DrawTiming();

            scroll = EditorGUILayout.BeginScrollView(scroll);
            GUI.enabled = !busy;
            foreach (var system in GolfMapVegPerf.Systems()) DrawSystem(system);
            GUI.enabled = true;
            DrawSweep();
            EditorGUILayout.EndScrollView();
        }

        void DrawTiming()
        {
            if (last == null)
            {
                EditorGUILayout.HelpBox("Measure times the Scene view camera at 1920x1080 with the vegetation as switched below. Switch parts off and measure again, or Sweep to try every part in turn.", MessageType.None);
                return;
            }
            string delta = previous == null ? "" : string.Format("   ({0:+0.00;-0.00} ms vs previous)", last.totalMs - previous.totalMs);
            EditorGUILayout.LabelField(string.Format("Frame {0:0.00} ms  ({1:0} fps){2}", last.totalMs, last.Fps, delta), EditorStyles.boldLabel);
            EditorGUILayout.LabelField(string.Format("VSP CPU {0:0.00} ms   other scripts {1:0.00} ms   render + GPU {2:0.00} ms   p90 {3:0.00} ms",
                last.vspMs, last.otherMs, last.renderMs, last.p90Ms));
            if (last.items != null)
                EditorGUILayout.LabelField(string.Format("Vegetation in view: {0:N0} instances   {1:N0}k tris   {2:N0}k shadow tris   ~{3:N0} draw calls",
                    last.items.Sum(x => x.VisibleInstances), last.items.Sum(x => x.VisibleTris) / 1000, last.items.Sum(x => x.ShadowTris) / 1000,
                    last.items.Sum(x => x.DrawCalls)), EditorStyles.miniLabel);
        }

        bool Fold(string key, string label, bool open = false)
        {
            bool v;
            if (!folds.TryGetValue(key, out v)) v = open;
            v = EditorGUILayout.Foldout(v, label, true);
            folds[key] = v;
            return v;
        }

        void DrawSystem(VegetationSystemPro system)
        {
            string label = GolfMapVegPerf.SystemLabel(system);
            EditorGUILayout.Space();
            using (new EditorGUILayout.HorizontalScope())
            {
                bool on = EditorGUILayout.ToggleLeft(label + " system", GolfMapVegPerf.SystemOn(system), EditorStyles.boldLabel, GUILayout.Width(180));
                if (on != GolfMapVegPerf.SystemOn(system)) GolfMapVegPerf.SetSystem(system, on);
                if (GolfMapVegPerf.HasStorage(system))
                {
                    bool st = EditorGUILayout.ToggleLeft("persistent storage", GolfMapVegPerf.StorageOn(system), GUILayout.Width(140));
                    if (st != GolfMapVegPerf.StorageOn(system)) GolfMapVegPerf.SetStorage(system, st);
                }
            }
            if (!system.isActiveAndEnabled) return;
            var items = GolfMapVegPerf.Items(system).ToList();
            var types = GolfMapVegPerf.Types.Where(t => items.Any(r => r.item.VegetationType == t)).ToList();

            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label("Draw", GUILayout.Width(60));
                foreach (var t in types) GroupToggle(t.ToString(), items.Where(r => r.item.VegetationType == t).ToList(), 90);
            }
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label("Shadows", GUILayout.Width(60));
                foreach (var t in types)
                {
                    bool s = GUILayout.Toggle(GolfMapVegPerf.ShadowsOn(system, t), t.ToString(), GUILayout.Width(90));
                    if (s != GolfMapVegPerf.ShadowsOn(system, t)) GolfMapVegPerf.SetShadows(system, t, s);
                }
            }

            foreach (var g in items.GroupBy(r => r.package))
            {
                var list = g.ToList();
                bool open;
                using (new EditorGUILayout.HorizontalScope())
                {
                    GroupToggle("", list, 16);
                    string sum = "";
                    var st = list.Select(r => Stat(r)).Where(x => x != null).ToList();
                    if (st.Count > 0)
                        sum = string.Format("  - {0:N0} stored, {1:N0} visible, {2:N0}k tris, {3:N0}k shadow tris, ~{4:N0} draws",
                            st.Sum(x => x.stored), st.Sum(x => x.VisibleInstances), st.Sum(x => x.VisibleTris) / 1000, st.Sum(x => x.ShadowTris) / 1000, st.Sum(x => x.DrawCalls));
                    open = Fold(label + "|" + g.Key.PackageName, g.Key.PackageName + " (" + list.Count + ")" + sum);
                }
                if (open) DrawItems(list);
            }
        }

        GolfMapVegPerf.ItemStats Stat(GolfMapVegPerf.ItemRef r)
        {
            GolfMapVegPerf.ItemStats s;
            return stats.TryGetValue(StatKey(GolfMapVegPerf.SystemLabel(r.system), r.package.PackageName, r.item.Name), out s) ? s : null;
        }

        void GroupToggle(string label, List<GolfMapVegPerf.ItemRef> refs, float width)
        {
            int hiddenN = refs.Count(GolfMapVegPerf.IsHidden);
            EditorGUI.showMixedValue = hiddenN > 0 && hiddenN < refs.Count;
            bool on = hiddenN < refs.Count;
            bool v = GUILayout.Toggle(on, label, GUILayout.Width(width));
            EditorGUI.showMixedValue = false;
            if (v != on) GolfMapVegPerf.SetHidden(refs, !v);
        }

        void DrawItems(List<GolfMapVegPerf.ItemRef> list)
        {
            var mini = EditorStyles.miniLabel;
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Space(34);
                GUILayout.Label("item", mini, GUILayout.Width(230));
                foreach (var h in new[] { "type", "stored", "visible", "k tris", "k shadow", "draws", "LODs" }) GUILayout.Label(h, mini, GUILayout.Width(62));
                GUILayout.Label("shader", mini);
            }
            var ordered = list.OrderByDescending(r => { var s = Stat(r); return s == null ? 0 : s.VisibleTris + s.ShadowTris; })
                .ThenByDescending(r => { var s = Stat(r); return s == null ? 0 : s.stored; }).ToList();
            foreach (var r in ordered)
            {
                var s = Stat(r);
                using (new EditorGUILayout.HorizontalScope())
                {
                    GUILayout.Space(18);
                    bool on = !GolfMapVegPerf.IsHidden(r);
                    bool v = GUILayout.Toggle(on, GUIContent.none, GUILayout.Width(14));
                    if (v != on) GolfMapVegPerf.SetHidden(new[] { r }, !v);
                    GUILayout.Label(new GUIContent(r.item.Name, r.item.EnableRuntimeSpawn ? "runtime spawned" : "storage only"), mini, GUILayout.Width(230));
                    GUILayout.Label(r.item.VegetationType.ToString(), mini, GUILayout.Width(62));
                    if (s == null) { GUILayout.Label("-", mini); continue; }
                    GUILayout.Label(s.stored.ToString("N0"), mini, GUILayout.Width(62));
                    GUILayout.Label(s.VisibleInstances.ToString("N0"), mini, GUILayout.Width(62));
                    GUILayout.Label((s.VisibleTris / 1000).ToString("N0"), mini, GUILayout.Width(62));
                    GUILayout.Label((s.ShadowTris / 1000).ToString("N0"), mini, GUILayout.Width(62));
                    GUILayout.Label(s.DrawCalls.ToString("N0"), mini, GUILayout.Width(62));
                    GUILayout.Label(new GUIContent(s.lods.ToString(), "tris per LOD: " + string.Join(" / ", s.tris.Take(Math.Max(1, s.lods)).Select(t => t.ToString("N0")).ToArray())), mini, GUILayout.Width(62));
                    GUILayout.Label(s.shaders, mini);
                }
            }
        }

        void DrawSweep()
        {
            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Sweep", EditorStyles.boldLabel);
            using (new EditorGUILayout.HorizontalScope())
            {
                for (int i = 0; i < sweepLevels.Length; i++)
                    sweepLevels[i] = GUILayout.Toggle(sweepLevels[i], GolfMapVegPerf.AllLevels[i], GUILayout.Width(80));
                GUILayout.Label("top items", GUILayout.Width(60));
                sweepTop = Mathf.Clamp(EditorGUILayout.IntField(sweepTop, GUILayout.Width(36)), 1, 200);
            }
            if (sweepRows == null) return;
            EditorGUILayout.LabelField(string.Format("Baseline {0:0.00} ms. Each row: that part switched off.", sweepBase), EditorStyles.miniLabel);
            double max = Math.Max(0.01, sweepRows.Max(r => r.savedMs));
            foreach (var r in sweepRows)
            {
                var rect = EditorGUILayout.GetControlRect(false, 16);
                var bar = new Rect(rect.x, rect.y + 2, (float)(Math.Max(0, r.savedMs) / max) * 160, rect.height - 4);
                EditorGUI.DrawRect(bar, new Color(0.9f, 0.45f, 0.2f, 0.8f));
                GUI.Label(new Rect(rect.x + 166, rect.y, rect.width - 166, rect.height),
                    string.Format("{0,6:0.00} ms  {1}  {2}", r.savedMs, r.level, r.what), EditorStyles.miniLabel);
            }
        }
    }
}
