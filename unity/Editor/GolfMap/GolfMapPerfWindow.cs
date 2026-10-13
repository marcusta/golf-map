// GolfMap > Performance Ranking: what costs frame time on the course, ranked per category, with the
// geometry behind it, and a button to select or hide a category in the scene. The work is in
// GolfMapPerf.cs (shared with golfmap.perf.report / hide / show).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    sealed class GolfMapPerfWindow : EditorWindow
    {
        [MenuItem("GolfMap/Performance Ranking")]
        static void Open() { GetWindow<GolfMapPerfWindow>("Performance").Show(); }

        int rounds = 3, frames = 40;
        bool currentView;
        int shownView;   // 0 = overall, n = the n-th viewpoint
        Vector2 scroll;

        IEnumerator<object> job;
        string progress, error;
        GolfMapPerf.Result result;

        void OnEnable() { GolfMapPerf.Changed += Repaint; EditorApplication.update += Step; }
        void OnDisable() { GolfMapPerf.Changed -= Repaint; EditorApplication.update -= Step; Stop(); }

        void Stop()
        {
            if (job == null) return;
            job.Dispose();   // runs the report's own clean-up (everything back on, the view where it was)
            job = null;
        }

        void Step()
        {
            if (job == null) return;
            try
            {
                if (!job.MoveNext()) { job = null; progress = null; }
            }
            catch (Exception e)
            {
                job = null;
                progress = null;
                error = e.Message;
                if (!(e is BridgeError)) Debug.LogException(e);
            }
            Repaint();
        }

        void Guarded(Action action)
        {
            error = null;
            try { action(); }
            catch (Exception e)
            {
                error = e.Message;
                if (!(e is BridgeError) && !(e is InvalidOperationException)) Debug.LogException(e);
            }
        }

        void StartGeometry() { Guarded(() => { result = GolfMapPerf.Geometry(); shownView = 0; }); }

        void StartReport()
        {
            Guarded(() =>
            {
                var o = new GolfMapPerf.Options { rounds = rounds, frames = frames };
                if (currentView || !File.Exists(GolfMapPerf.DefaultViewsFile())) o.views.Add(GolfMapPerf.CurrentView());
                else o.views = GolfMapPerf.LoadViews(GolfMapPerf.DefaultViewsFile());
                var holder = new GolfMapPerf.Result[1];
                job = Finishing(GolfMapPerf.Run(o, holder, p => progress = p), holder).GetEnumerator();
            });
        }

        IEnumerable<object> Finishing(IEnumerable<object> steps, GolfMapPerf.Result[] holder)
        {
            foreach (var s in steps) yield return s;
            result = holder[0];
            shownView = 0;
            Debug.Log("[GolfMap] Performance ranking:\n" + string.Join("\n", result.ranking.Select(r =>
                string.Format("{0,-22} {1}", CostText(r.savedMs, r.fpsGain, r.share, r.status), Label(r.id))).ToArray()));
        }

        string Label(string id)
        {
            var c = result.categories.FirstOrDefault(x => x.id == id);
            return c != null ? c.label : id;
        }

        static string CostText(double? savedMs, double? fpsGain, double? share, string status)
        {
            if (status == "not run" || !savedMs.HasValue) return "-";
            if (status == "noise") return "not measurable";
            return string.Format("{0:0.00} ms  {1:+0.0;-0.0} fps  {2:0} %", savedMs.Value, fpsGain ?? 0, (share ?? 0) * 100);
        }

        static string Count(long n) { return n < 0 ? "-" : n >= 1000000 ? (n / 1e6).ToString("0.00") + " M" : n >= 10000 ? (n / 1000).ToString("N0") + " k" : n.ToString("N0"); }

        void OnGUI()
        {
            bool busy = job != null;
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                GUI.enabled = !busy;
                if (GUILayout.Button(new GUIContent("Rank", "Time every category at each viewpoint"), EditorStyles.toolbarButton, GUILayout.Width(50))) StartReport();
                if (GUILayout.Button(new GUIContent("Geometry", "Count what is in the scene, nothing timed"), EditorStyles.toolbarButton, GUILayout.Width(70))) StartGeometry();
                GUILayout.Label("rounds", GUILayout.Width(44));
                rounds = Mathf.Clamp(EditorGUILayout.IntField(rounds, EditorStyles.toolbarTextField, GUILayout.Width(28)), 1, 20);
                GUILayout.Label("frames", GUILayout.Width(44));
                frames = Mathf.Clamp(EditorGUILayout.IntField(frames, EditorStyles.toolbarTextField, GUILayout.Width(36)), 5, 2000);
                currentView = GUILayout.Toggle(currentView, new GUIContent("current view only", "Off: the viewpoints of " + GolfMapPerf.ViewsFile + " in the course folder, when there is one"), EditorStyles.toolbarButton, GUILayout.Width(110));
                GUILayout.FlexibleSpace();
                GUI.enabled = !busy && GolfMapPerf.AnythingOff;
                if (GUILayout.Button("Show all", EditorStyles.toolbarButton, GUILayout.Width(70))) GolfMapPerf.RestoreAll();
                GUI.enabled = true;
            }
            EditorGUILayout.HelpBox(GolfMapPerf.EditorNote, MessageType.None);
            if (busy)
            {
                EditorGUILayout.HelpBox("Measuring... " + (progress ?? "") + "  (leave the Scene view alone)", MessageType.Info);
                if (GUILayout.Button("Stop")) { Stop(); progress = null; }
            }
            else if (error != null) EditorGUILayout.HelpBox(error, MessageType.Error);
            if (result == null) return;

            var views = new[] { "Overall (mean over the viewpoints)" }.Concat(result.views.Select(v => v.name)).ToArray();
            shownView = Mathf.Clamp(shownView, 0, views.Length - 1);
            if (result.views.Count > 0) shownView = EditorGUILayout.Popup("Viewpoint", shownView, views);
            var view = shownView > 0 ? result.views[shownView - 1] : null;
            if (view != null)
                EditorGUILayout.LabelField(string.Format("Everything on: {0:0.00} ms ({1:0} fps).  Noise {2:0.00} ms: a saving no larger is not measurable.", view.baselineMs, view.BaselineFps, view.noiseMs), EditorStyles.miniLabel);
            EditorGUILayout.LabelField(string.Format("The rules caught {0:0.0} % of the renderers and {1:0.0} % of the triangles; the rest is under \"Other: <root object>\".",
                result.renderers > 0 ? 100.0 * result.namedRenderers / result.renderers : 100, result.triangles > 0 ? 100.0 * result.namedTriangles / result.triangles : 100), EditorStyles.miniLabel);
            foreach (var note in result.notes) EditorGUILayout.LabelField(note, EditorStyles.miniLabel);
            if (result.disagreements.Count > 0) EditorGUILayout.HelpBox("The rules and the surface classifier disagree on " + result.disagreements.Count + " course mesh(es), e.g. " + result.disagreements[0], MessageType.Warning);

            var mini = EditorStyles.miniLabel;
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label("category", mini, GUILayout.Width(220));
                GUILayout.Label(new GUIContent("triangles", "Every LOD level; in brackets the nearest level only. VSP: items and placed (stored) instances."), mini, GUILayout.Width(120));
                GUILayout.Label("renderers", mini, GUILayout.Width(60));
                GUILayout.Label(new GUIContent("shadows", "Renderers that cast shadows"), mini, GUILayout.Width(55));
                GUILayout.Label(new GUIContent("saved: ms, fps, share of frame", "Frame time with everything on minus with this category off"), mini, GUILayout.Width(190));
            }
            scroll = EditorGUILayout.BeginScrollView(scroll);
            // A viewpoint's own costs first, largest saving first; the rest as the overall ranking has them (measured,
            // then by triangles, the "other" rows last).
            var order = new List<GolfMapPerf.Category>();
            if (view != null) order.AddRange(view.costs.Where(k => k.status != "noise").Select(k => result.categories.FirstOrDefault(c => c.id == k.id)).Where(c => c != null));
            order.AddRange(result.ranking.Select(r => result.categories.FirstOrDefault(c => c.id == r.id)).Where(c => c != null && !order.Contains(c)));
            double max = 0.01;
            foreach (var c in order) max = Math.Max(max, Saved(c, view) ?? 0);
            foreach (var c in order) DrawRow(c, view, max, busy);
            if (result.absent.Count > 0) EditorGUILayout.LabelField("Not in this scene: " + string.Join(", ", result.absent.ToArray()), mini);
            EditorGUILayout.EndScrollView();
        }

        double? Saved(GolfMapPerf.Category c, GolfMapPerf.ViewResult view)
        {
            if (view != null)
            {
                var cost = view.costs.FirstOrDefault(k => k.id == c.id);
                return cost != null && cost.status != "noise" ? cost.savedMs : (double?)null;
            }
            var row = result.ranking.FirstOrDefault(r => r.id == c.id);
            return row != null && row.status == "measured" ? row.savedMs : null;
        }

        void DrawRow(GolfMapPerf.Category c, GolfMapPerf.ViewResult view, double max, bool busy)
        {
            var mini = EditorStyles.miniLabel;
            using (new EditorGUILayout.HorizontalScope())
            {
                GUILayout.Label(new GUIContent(c.label, c.id), mini, GUILayout.Width(220));
                string tris = c.triangles >= 0 ? Count(c.triangles) + (c.trianglesLod0 >= 0 && c.trianglesLod0 != c.triangles ? " (" + Count(c.trianglesLod0) + ")" : "")
                    : c.stored >= 0 ? c.items + " items, " + Count(c.stored) + " placed" : c.objects >= 0 ? c.objects + " objects" : "-";
                GUILayout.Label(new GUIContent(tris, c.objects >= 0 ? c.objects + " objects, " + c.meshes.Count + " meshes, " + c.materials.Count + " materials, " + Math.Max(0, c.lodGroups) + " LODGroups" : ""), mini, GUILayout.Width(120));
                GUILayout.Label(Count(c.renderers), mini, GUILayout.Width(60));
                GUILayout.Label(Count(c.shadowCasters), mini, GUILayout.Width(55));

                string text;
                if (view != null)
                {
                    var cost = view.costs.FirstOrDefault(k => k.id == c.id);
                    text = cost == null ? "-" : CostText(cost.savedMs, cost.fpsGain, cost.share, cost.status);
                }
                else
                {
                    var row = result.ranking.FirstOrDefault(r => r.id == c.id);
                    text = row == null ? "-" : CostText(row.savedMs, row.fpsGain, row.share, row.status);
                }
                var rect = GUILayoutUtility.GetRect(190, 16, GUILayout.Width(190));
                double saved = Saved(c, view) ?? 0;
                EditorGUI.DrawRect(new Rect(rect.x, rect.y + 2, (float)(Math.Max(0, saved) / max) * rect.width, rect.height - 4), new Color(0.9f, 0.45f, 0.2f, 0.5f));
                GUI.Label(rect, text, mini);

                GUI.enabled = c.select.Count > 0;
                if (GUILayout.Button("Select", EditorStyles.miniButton, GUILayout.Width(50))) Selection.objects = c.select.Where(g => g).Cast<UnityEngine.Object>().ToArray();
                GUI.enabled = !busy && c.off != null;
                bool hidden = GolfMapPerf.IsHidden(c.id);
                if (GUILayout.Button(hidden ? "Show" : "Hide", EditorStyles.miniButton, GUILayout.Width(44))) Guarded(() => GolfMapPerf.SetHidden(c, !hidden));
                GUI.enabled = true;
            }
        }
    }
}
