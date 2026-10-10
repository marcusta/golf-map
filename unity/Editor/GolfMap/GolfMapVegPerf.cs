// Vegetation performance: switch parts of the VSP vegetation off live and time the Scene view
// frame, to find what makes a scene slow (GolfMap > Vegetation Performance, bridge
// golfmap.vegperf.*).
//
// Hiding an item never touches the package asset: VSP skips an item in both draw paths (the
// CPU LOD lists and the compute-shader path) when its cell's distance band is beyond the item's
// VegetationItemModelInfo.DistanceBand, and the model infos are runtime-only objects. So a hidden
// item gets DistanceBand = Hidden; it stays loaded and spawned (storage, cells), only its merge,
// culling and drawing stop, which is the per-frame cost. A VSP refresh rebuilds the model infos,
// so the hidden set is put back every editor update.
// Whole systems, their persistent storage and per-type shadows are scene settings. What those
// switches changed is remembered and put back before a scene save, a script reload and quit.
//
// Timing: per frame, Update then LateUpdate on every active [ExecuteInEditMode] behaviour (what
// the player loop does; VSP culls in Update and draws in LateUpdate), then the Scene view camera
// renders into a render texture and one pixel is read back, which waits for the GPU. So "render"
// is CPU submission + GPU, "vsp" is VSP's own CPU work. Medians over the measured frames.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

namespace GolfMap.Editor
{
    static class GolfMapVegPerf
    {
        const int Hidden = -100;   // below every cell distance band VSP uses (0 near, 1 trees, 99 unloaded)
        const int InstancedBatch = 1023;

        internal static readonly VegetationType[] Types =
            { VegetationType.Tree, VegetationType.Grass, VegetationType.Plant, VegetationType.Objects, VegetationType.LargeObjects };

        // ---- what is in the scene -------------------------------------------------------------

        internal sealed class ItemRef
        {
            public VegetationSystemPro system;
            public VegetationPackagePro package;
            public VegetationItemInfoPro item;
            public int packageIndex, itemIndex;
            public string Key { get { return Key(system, package, item); } }
        }

        static string Key(VegetationSystemPro s, VegetationPackagePro p, VegetationItemInfoPro i)
        {
            return s.GetInstanceID() + "|" + p.GetInstanceID() + "|" + i.VegetationItemID;
        }

        // Every system in the active scene, including one whose GameObject is inactive (FindObjectsOfType
        // skips those, and switching the inner system off is often done by deactivating it).
        internal static List<VegetationSystemPro> Systems()
        {
            var scene = EditorSceneManager.GetActiveScene();
            return Resources.FindObjectsOfTypeAll<VegetationSystemPro>()
                .Where(s => s && s.gameObject.scene == scene && (s.hideFlags & HideFlags.HideInHierarchy) == 0 && !EditorUtility.IsPersistent(s))
                .OrderBy(s => SystemLabel(s) == "inner" ? 0 : SystemLabel(s) == "outer" ? 1 : 2).ToList();
        }

        static readonly Dictionary<int, string> labels = new Dictionary<int, string>();

        // inner / outer from the active course's terrains, else the system's terrain name.
        internal static string SystemLabel(VegetationSystemPro s)
        {
            string label;
            if (labels.TryGetValue(s.GetInstanceID(), out label)) return label;
            label = null;
            try
            {
                var course = GolfMapCourses.Require();
                var scene = EditorSceneManager.GetActiveScene();
                var inner = GolfMapTreePlanter.RoleTerrain(scene, course.innerTerrainName, course.innerTerrainData, "inner");
                var outer = GolfMapTreePlanter.RoleTerrain(scene, course.outerTerrainName, course.outerTerrainData, "outer");
                if (inner && GolfMapZoneImporter.SystemMatchesTerrain(s, inner)) label = "inner";
                else if (outer && GolfMapZoneImporter.SystemMatchesTerrain(s, outer)) label = "outer";
            }
            catch (Exception) { }
            if (label == null)
            {
                var t = s.VegetationStudioTerrainObjectList.FirstOrDefault(o => o);
                label = t ? t.name : s.name;
            }
            labels[s.GetInstanceID()] = label;
            return label;
        }

        internal static IEnumerable<ItemRef> Items(VegetationSystemPro system)
        {
            for (int p = 0; p < system.VegetationPackageProList.Count; p++)
            {
                var package = system.VegetationPackageProList[p];
                if (!package) continue;
                for (int i = 0; i < package.VegetationInfoList.Count; i++)
                    yield return new ItemRef { system = system, package = package, item = package.VegetationInfoList[i], packageIndex = p, itemIndex = i };
            }
        }

        internal static IEnumerable<ItemRef> Items() { return Systems().SelectMany(s => Items(s)); }

        static VegetationItemModelInfo Model(ItemRef r)
        {
            var models = r.system.VegetationPackageProModelsList;
            if (r.packageIndex >= models.Count || models[r.packageIndex] == null) return null;
            var list = models[r.packageIndex].VegetationItemModelList;
            return r.itemIndex < list.Count ? list[r.itemIndex] : null;
        }

        // ---- item hides (runtime only) ---------------------------------------------------------

        static readonly HashSet<string> hidden = new HashSet<string>();

        internal static bool IsHidden(ItemRef r) { return hidden.Contains(r.Key); }
        internal static int HiddenCount { get { return hidden.Count; } }

        internal static void SetHidden(IEnumerable<ItemRef> items, bool hide)
        {
            foreach (var r in items)
            {
                if (hide) hidden.Add(r.Key); else hidden.Remove(r.Key);
                var m = Model(r);
                if (m != null) m.DistanceBand = hide ? Hidden : r.item.GetDistanceBand();
            }
            Repaint();
        }

        static void ApplyHides()
        {
            if (hidden.Count == 0) return;
            foreach (var r in Items())
            {
                if (!hidden.Contains(r.Key)) continue;
                var m = Model(r);
                if (m != null && m.DistanceBand != Hidden) m.DistanceBand = Hidden;
            }
        }

        // ---- scene switches (saved with the scene: remembered and put back) --------------------

        // key -> restore action; one entry per switch that differs from how the scene was.
        static readonly Dictionary<string, Action> switches = new Dictionary<string, Action>();

        internal static bool SwitchesChanged { get { return switches.Count > 0; } }

        static void Remember(string key, Action restore)
        {
            if (!switches.ContainsKey(key)) switches[key] = restore;
        }

        internal static bool SystemOn(VegetationSystemPro s) { return s.isActiveAndEnabled; }

        // On = component enabled and GameObject active; off = component disabled (the GameObject is
        // left alone). Both are remembered and put back.
        internal static void SetSystem(VegetationSystemPro s, bool on)
        {
            if (SystemOn(s) == on) return;
            var go = s.gameObject;
            if (on && !go.activeSelf) SwitchScene("active|" + go.GetInstanceID(), false, v => { if (go) go.SetActive(v); }, true);
            if (s.enabled != on) SwitchScene("system|" + s.GetInstanceID(), s.enabled, v => { if (s) s.enabled = v; }, on);
            Repaint();
        }

        // Set a scene value, remembering how it was; setting it back to that forgets it.
        static void SwitchScene(string key, bool was, Action<bool> write, bool value)
        {
            if (switches.ContainsKey(key)) switches.Remove(key);
            else Remember(key, () => write(was));
            write(value);
        }

        internal static bool HasStorage(VegetationSystemPro s) { return s.PersistentVegetationStorage; }
        internal static bool StorageOn(VegetationSystemPro s) { return s.PersistentVegetationStorage && !s.PersistentVegetationStorage.DisablePersistentStorage; }

        internal static void SetStorage(VegetationSystemPro s, bool on)
        {
            var storage = s.PersistentVegetationStorage;
            if (!storage || StorageOn(s) == on) return;
            SwitchScene("storage|" + s.GetInstanceID(), storage.DisablePersistentStorage,
                v => { if (!storage) return; storage.DisablePersistentStorage = v; if (s && s.isActiveAndEnabled) s.ClearCache(); }, !on);
            Repaint();
        }

        internal static bool ShadowsOn(VegetationSystemPro s, VegetationType t)
        {
            var v = s.VegetationSettings;
            switch (t)
            {
                case VegetationType.Tree: return v.TreeShadows;
                case VegetationType.Grass: return v.GrassShadows;
                case VegetationType.Plant: return v.PlantShadows;
                case VegetationType.Objects: return v.ObjectShadows;
                default: return v.LargeObjectShadows;
            }
        }

        static void WriteShadows(VegetationSystemPro s, VegetationType t, bool on)
        {
            var v = s.VegetationSettings;
            switch (t)
            {
                case VegetationType.Tree: v.TreeShadows = on; break;
                case VegetationType.Grass: v.GrassShadows = on; break;
                case VegetationType.Plant: v.PlantShadows = on; break;
                case VegetationType.Objects: v.ObjectShadows = on; break;
                default: v.LargeObjectShadows = on; break;
            }
        }

        internal static void SetShadows(VegetationSystemPro s, VegetationType t, bool on)
        {
            if (ShadowsOn(s, t) == on) return;
            SwitchScene("shadows|" + s.GetInstanceID() + "|" + t, ShadowsOn(s, t), v => { if (s) WriteShadows(s, t, v); }, on);
            Repaint();
        }

        // Everything back as the scene was.
        internal static int ShowAll(string reason = null)
        {
            int n = hidden.Count + switches.Count;
            var items = Items().Where(r => hidden.Contains(r.Key)).ToList();
            hidden.Clear();
            SetHidden(items, false);
            RestoreSwitches(reason);
            Repaint();
            return n;
        }

        static void RestoreSwitches(string reason)
        {
            if (switches.Count == 0) return;
            var restores = switches.Values.ToList();
            switches.Clear();
            foreach (var r in restores)
                try { r(); } catch (Exception e) { Debug.LogException(e); }
            if (reason != null) Debug.Log("[GolfMap] Vegetation performance: switched systems/storage/shadows back on " + reason + ".");
        }

        [InitializeOnLoadMethod]
        static void Hooks()
        {
            EditorApplication.update += ApplyHides;
            EditorSceneManager.sceneSaving += (scene, path) => RestoreSwitches("before saving the scene");
            AssemblyReloadEvents.beforeAssemblyReload += () => RestoreSwitches("before a script reload");
            EditorApplication.quitting += () => RestoreSwitches("on quit");
        }

        internal static event Action Changed;
        static void Repaint()
        {
            SceneView.RepaintAll();
            EditorApplication.QueuePlayerLoopUpdate();
            if (Changed != null) Changed();
        }

        // ---- per-item numbers ------------------------------------------------------------------

        internal sealed class ItemStats
        {
            public string system, package, name, type, renderMode, shaders;
            public bool runtimeSpawn, castsShadows, hiddenNow;
            public long stored;
            public int lods;
            public int[] tris = new int[4], subMeshes = new int[4];
            public int[] visible = new int[4], shadowOnly = new int[4];
            public long VisibleInstances { get { return visible.Sum(); } }
            public long VisibleTris { get { long t = 0; for (int l = 0; l < 4; l++) t += (long)visible[l] * tris[l]; return t; } }
            public long ShadowTris
            {
                get
                {
                    if (!castsShadows) return 0;
                    long t = 0; for (int l = 0; l < 4; l++) t += (long)(visible[l] + shadowOnly[l]) * tris[l]; return t;
                }
            }
            // Instanced draws are batches of 1023 per submesh (the editor draws grass this way too).
            public int DrawCalls
            {
                get
                {
                    int d = 0;
                    for (int l = 0; l < 4; l++)
                        d += ((visible[l] + InstancedBatch - 1) / InstancedBatch) * Math.Max(1, subMeshes[l]) * (castsShadows ? 2 : 1)
                           + (castsShadows ? ((shadowOnly[l] + InstancedBatch - 1) / InstancedBatch) * Math.Max(1, subMeshes[l]) : 0);
                    return d;
                }
            }

            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "system", system }, { "package", package }, { "item", name }, { "type", type }, { "renderMode", renderMode },
                    { "runtimeSpawn", runtimeSpawn }, { "stored", stored }, { "hidden", hiddenNow },
                    { "visible", VisibleInstances }, { "visibleByLod", visible.Take(Math.Max(1, lods)).ToList() },
                    { "shadowOnly", shadowOnly.Sum() }, { "castsShadows", castsShadows },
                    { "trisPerLod", tris.Take(Math.Max(1, lods)).ToList() },
                    { "visibleTrisK", Math.Round(VisibleTris / 1000.0, 1) }, { "shadowTrisK", Math.Round(ShadowTris / 1000.0, 1) },
                    { "drawCallsEst", DrawCalls }, { "shaders", shaders },
                };
            }
        }

        static int Tris(Mesh m, out int subMeshes)
        {
            subMeshes = 0;
            if (!m) return 0;
            subMeshes = m.subMeshCount;
            long n = 0;
            for (int s = 0; s < m.subMeshCount; s++) n += m.GetIndexCount(s);
            return (int)(n / 3);
        }

        static Dictionary<string, long> StoredCounts(VegetationSystemPro s)
        {
            var counts = new Dictionary<string, long>();
            var storage = s.PersistentVegetationStorage;
            var package = storage ? storage.PersistentVegetationStoragePackage : null;
            if (package == null) return counts;
            foreach (var cell in package.PersistentVegetationCellList)
                foreach (var info in cell.PersistentVegetationInfoList)
                {
                    long c;
                    counts.TryGetValue(info.VegetationItemID, out c);
                    counts[info.VegetationItemID] = c + info.VegetationItemList.Count;
                }
            return counts;
        }

        static readonly Dictionary<int, Dictionary<string, long>> storedCache = new Dictionary<int, Dictionary<string, long>>();

        // Visible counts come from the camera's LOD lists as VSP's last LateUpdate left them; in the
        // editor every item, grass included, goes through them (InstancedIndirect is play mode only).
        internal static List<ItemStats> Snapshot(Camera camera, bool refreshStored = false)
        {
            if (refreshStored) storedCache.Clear();
            var result = new List<ItemStats>();
            foreach (var s in Systems().Where(x => x.isActiveAndEnabled))
            {
                Dictionary<string, long> stored;
                if (!storedCache.TryGetValue(s.GetInstanceID(), out stored)) storedCache[s.GetInstanceID()] = stored = StoredCounts(s);
                VegetationStudioCamera vc = null;
                foreach (var c in s.VegetationStudioCameraList)
                    if (c != null && c.SelectedCamera == camera) { vc = c; break; }
                foreach (var r in Items(s))
                {
                    var m = Model(r);
                    var st = new ItemStats
                    {
                        system = SystemLabel(s), package = r.package.PackageName, name = r.item.Name, type = r.item.VegetationType.ToString(),
                        renderMode = r.item.VegetationRenderMode.ToString(), runtimeSpawn = r.item.EnableRuntimeSpawn, hiddenNow = IsHidden(r),
                        castsShadows = !r.item.DisableShadows && s.VegetationSettings.GetShadowCastingMode(r.item.VegetationType) == UnityEngine.Rendering.ShadowCastingMode.On,
                    };
                    long n; stored.TryGetValue(r.item.VegetationItemID, out n); st.stored = n;
                    if (m != null)
                    {
                        st.lods = m.LODCount;
                        for (int l = 0; l < 4; l++) st.tris[l] = Tris(m.GetLODMesh(l), out st.subMeshes[l]);
                        var mats = m.GetLODMaterials(0);
                        st.shaders = mats == null ? "" : string.Join(", ", mats.Where(x => x && x.shader).Select(x => x.shader.name).Distinct().ToArray());
                    }
                    if (vc != null && vc.VegetationStudioCameraRenderList != null && r.packageIndex < vc.VegetationStudioCameraRenderList.Count)
                    {
                        var rl = vc.VegetationStudioCameraRenderList[r.packageIndex];
                        int k = r.itemIndex;
                        if (k < rl.VegetationItemLOD0MatrixList.Count)
                        {
                            st.visible[0] = rl.VegetationItemLOD0MatrixList[k].Length;
                            st.visible[1] = rl.VegetationItemLOD1MatrixList[k].Length;
                            st.visible[2] = rl.VegetationItemLOD2MatrixList[k].Length;
                            st.visible[3] = rl.VegetationItemLOD3MatrixList[k].Length;
                            st.shadowOnly[0] = rl.VegetationItemLOD0ShadowMatrixList[k].Length;
                            st.shadowOnly[1] = rl.VegetationItemLOD1ShadowMatrixList[k].Length;
                            st.shadowOnly[2] = rl.VegetationItemLOD2ShadowMatrixList[k].Length;
                            st.shadowOnly[3] = rl.VegetationItemLOD3ShadowMatrixList[k].Length;
                        }
                    }
                    result.Add(st);
                }
            }
            return result;
        }

        // ---- timing ----------------------------------------------------------------------------

        internal sealed class Timing
        {
            public int frames, width, height;
            public double totalMs, vspMs, otherMs, renderMs, p90Ms;
            public List<ItemStats> items;
            public List<object> cameras = new List<object>();

            public double Fps { get { return totalMs > 0 ? 1000 / totalMs : 0; } }

            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "frames", frames }, { "resolution", width + "x" + height }, { "cameras", cameras },
                    { "frameMs", Math.Round(totalMs, 2) }, { "fps", Math.Round(Fps, 1) }, { "p90Ms", Math.Round(p90Ms, 2) },
                    { "vspCpuMs", Math.Round(vspMs, 2) }, { "otherCpuMs", Math.Round(otherMs, 2) }, { "renderGpuMs", Math.Round(renderMs, 2) },
                    { "vegetation", items == null ? null : new Dictionary<string, object>
                        {
                            { "visibleInstances", items.Sum(x => x.VisibleInstances) },
                            { "visibleTrisK", Math.Round(items.Sum(x => x.VisibleTris) / 1000.0, 1) },
                            { "shadowTrisK", Math.Round(items.Sum(x => x.ShadowTris) / 1000.0, 1) },
                            { "drawCallsEst", items.Sum(x => x.DrawCalls) },
                        } },
                };
            }
        }

        sealed class Calls
        {
            public readonly List<KeyValuePair<MonoBehaviour, MethodInfo>> update = new List<KeyValuePair<MonoBehaviour, MethodInfo>>();
            public readonly List<KeyValuePair<MonoBehaviour, MethodInfo>> lateUpdate = new List<KeyValuePair<MonoBehaviour, MethodInfo>>();
        }

        static Calls EditModeCalls()
        {
            var calls = new Calls();
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            foreach (var b in Object.FindObjectsOfType<MonoBehaviour>())
            {
                if (b == null || !b.isActiveAndEnabled || !b.GetType().IsDefined(typeof(ExecuteInEditMode), true)) continue;
                var u = b.GetType().GetMethod("Update", flags, null, Type.EmptyTypes, null);
                var l = b.GetType().GetMethod("LateUpdate", flags, null, Type.EmptyTypes, null);
                if (u != null) calls.update.Add(new KeyValuePair<MonoBehaviour, MethodInfo>(b, u));
                if (l != null) calls.lateUpdate.Add(new KeyValuePair<MonoBehaviour, MethodInfo>(b, l));
            }
            return calls;
        }

        // Update + LateUpdate on every behaviour; returns ms spent in VSP and elsewhere.
        static void Tick(Calls calls, Stopwatch sw, out double vspMs, out double otherMs)
        {
            vspMs = 0; otherMs = 0;
            foreach (var list in new[] { calls.update, calls.lateUpdate })
                foreach (var c in list)
                {
                    if (c.Key == null || !c.Key.isActiveAndEnabled) continue;
                    double t0 = sw.Elapsed.TotalMilliseconds;
                    try { c.Value.Invoke(c.Key, null); }
                    catch (TargetInvocationException e) { Debug.LogException(e.InnerException ?? e); }
                    double dt = sw.Elapsed.TotalMilliseconds - t0;
                    if (c.Key is VegetationSystemPro) vspMs += dt; else otherMs += dt;
                }
        }

        static double Median(List<double> v) { var s = v.OrderBy(x => x).ToList(); return s.Count == 0 ? 0 : s[s.Count / 2]; }
        static double Percentile(List<double> v, double p) { var s = v.OrderBy(x => x).ToList(); return s.Count == 0 ? 0 : s[Math.Min(s.Count - 1, (int)(s.Count * p))]; }

        // Yields null once per editor frame; the result lands in holder[0].
        internal static IEnumerable<object> Measure(int warmup, int frames, int width, int height, bool withItems, Timing[] holder)
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null) throw new BridgeError("No Scene view is open.");
            var cam = sv.camera;
            var rt = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
            var probe = new Texture2D(1, 1, TextureFormat.RGB24, false);
            var total = new List<double>(); var vsp = new List<double>(); var other = new List<double>(); var render = new List<double>();
            var timing = new Timing { frames = frames, width = width, height = height };
            try
            {
                var calls = EditModeCalls();
                var sw = Stopwatch.StartNew();
                for (int f = 0; f < warmup + frames; f++)
                {
                    ApplyHides();
                    double t0 = sw.Elapsed.TotalMilliseconds, vMs, oMs;
                    Tick(calls, sw, out vMs, out oMs);
                    if (withItems && f == warmup + frames - 1)
                    {
                        timing.items = Snapshot(cam);
                        foreach (var s in Systems().Where(x => x.isActiveAndEnabled))
                            foreach (var c in s.VegetationStudioCameraList)
                                timing.cameras.Add(SystemLabel(s) + ": " + (c.SelectedCamera ? c.SelectedCamera.name + "#" + c.SelectedCamera.GetInstanceID() : "none")
                                    + (c.SelectedCamera == cam ? " (measured)" : " (measured #" + cam.GetInstanceID() + ")")
                                    + ", visible cells " + (c.JobCullingGroup == null ? -1 : c.JobCullingGroup.VisibleCellIndexList.Length)
                                    + ", potential " + (c.PotentialVisibleCellList == null ? -1 : c.PotentialVisibleCellList.Count));
                    }
                    double t1 = sw.Elapsed.TotalMilliseconds;
                    var previousTarget = cam.targetTexture;
                    var previousActive = RenderTexture.active;
                    try
                    {
                        cam.targetTexture = rt;
                        cam.aspect = (float)width / height;
                        cam.Render();
                        RenderTexture.active = rt;
                        probe.ReadPixels(new Rect(0, 0, 1, 1), 0, 0, false);   // waits for the GPU
                    }
                    finally
                    {
                        cam.targetTexture = previousTarget;
                        cam.ResetAspect();
                        RenderTexture.active = previousActive;
                    }
                    double t2 = sw.Elapsed.TotalMilliseconds;
                    if (f >= warmup)
                    {
                        total.Add(t2 - t0); vsp.Add(vMs); other.Add(oMs); render.Add(t2 - t1);
                    }
                    yield return null;
                }
            }
            finally
            {
                RenderTexture.ReleaseTemporary(rt);
                Object.DestroyImmediate(probe);
                SceneView.RepaintAll();
            }
            timing.totalMs = Median(total); timing.vspMs = Median(vsp); timing.otherMs = Median(other); timing.renderMs = Median(render);
            timing.p90Ms = Percentile(total, 0.9);
            holder[0] = timing;
        }

        // ---- sweep: switch each part off in turn and time it -----------------------------------

        internal sealed class SweepRow
        {
            public string level, what;
            public double ms, savedMs;
            public int items;
            public Dictionary<string, object> ToJson()
            {
                return new Dictionary<string, object>
                {
                    { "level", level }, { "off", what }, { "items", items }, { "frameMs", Math.Round(ms, 2) }, { "savedMs", Math.Round(savedMs, 2) },
                };
            }
        }

        sealed class Case
        {
            public string level, what;
            public int items, warmup;
            public Action off, on;
        }

        static List<Case> Cases(string[] levels, List<ItemStats> baseline, int top)
        {
            var cases = new List<Case>();
            var systems = Systems().Where(s => s.isActiveAndEnabled).ToList();
            Func<string, bool> want = l => levels.Contains(l);
            if (want("systems"))
                foreach (var s in systems)
                {
                    var sys = s;
                    cases.Add(new Case { level = "system", what = SystemLabel(sys) + " (whole system)", items = Items(sys).Count(), warmup = 40,
                        off = () => SetSystem(sys, false), on = () => SetSystem(sys, true) });
                }
            if (want("storage"))
                foreach (var s in systems.Where(x => StorageOn(x)))
                {
                    var sys = s;
                    cases.Add(new Case { level = "storage", what = SystemLabel(sys) + " persistent storage", warmup = 40,
                        off = () => SetStorage(sys, false), on = () => SetStorage(sys, true) });
                }
            if (want("shadows"))
                foreach (var s in systems)
                    foreach (var t in Types)
                    {
                        var sys = s; var type = t;
                        if (!ShadowsOn(sys, type) || !Items(sys).Any(r => r.item.VegetationType == type)) continue;
                        cases.Add(new Case { level = "shadows", what = SystemLabel(sys) + " " + type + " shadows", warmup = 5,
                            off = () => SetShadows(sys, type, false), on = () => SetShadows(sys, type, true) });
                    }
            Action<string, string, List<ItemRef>> hideCase = (level, what, refs) =>
            {
                if (refs.Count == 0 || refs.All(IsHidden)) return;
                var set = refs.Where(r => !IsHidden(r)).ToList();
                cases.Add(new Case { level = level, what = what, items = set.Count, warmup = 5,
                    off = () => SetHidden(set, true), on = () => SetHidden(set, false) });
            };
            if (want("source"))
                foreach (var s in systems)
                {
                    var stored = StoredCounts(s);
                    hideCase("source", SystemLabel(s) + " items with stored instances", Items(s).Where(r => stored.ContainsKey(r.item.VegetationItemID)).ToList());
                    hideCase("source", SystemLabel(s) + " runtime-spawned items", Items(s).Where(r => r.item.EnableRuntimeSpawn).ToList());
                }
            if (want("packages"))
                foreach (var s in systems)
                    foreach (var g in Items(s).GroupBy(r => r.package))
                        hideCase("package", SystemLabel(s) + " / " + g.Key.PackageName, g.ToList());
            if (want("types"))
                foreach (var s in systems)
                    foreach (var g in Items(s).GroupBy(r => r.item.VegetationType))
                        hideCase("type", SystemLabel(s) + " " + g.Key, g.ToList());
            if (want("items") && baseline != null)
            {
                var all = Items().ToList();
                foreach (var st in baseline.Where(x => x.VisibleInstances > 0 && !x.hiddenNow)
                             .OrderByDescending(x => x.VisibleTris + x.ShadowTris).Take(top))
                {
                    var match = all.Where(r => SystemLabel(r.system) == st.system && r.package.PackageName == st.package && r.item.Name == st.name).ToList();
                    hideCase("item", st.system + " / " + st.name, match);
                }
            }
            return cases;
        }

        internal static readonly string[] AllLevels = { "systems", "storage", "shadows", "source", "packages", "types", "items" };

        // Yields null per editor frame; holder[0] = JSON { baseline, rows }, [1] = rows, [2] = baseline ms (if room).
        internal static IEnumerable<object> Sweep(string[] levels, int frames, int top, int width, int height, object[] holder, Action<string> progress)
        {
            var t = new Timing[1];
            if (progress != null) progress("baseline");
            foreach (var step in Measure(30, frames, width, height, true, t)) yield return step;
            var baseline = t[0];
            var cases = Cases(levels, baseline.items, top);
            var rows = new List<SweepRow>();
            var baselines = new List<double> { baseline.totalMs };
            for (int c = 0; c < cases.Count; c++)
            {
                var cs = cases[c];
                if (progress != null) progress((c + 1) + "/" + cases.Count + ": " + cs.what + " off");
                cs.off();
                try
                {
                    foreach (var step in Measure(cs.warmup, frames, width, height, false, t)) yield return step;
                }
                finally { cs.on(); }
                rows.Add(new SweepRow { level = cs.level, what = cs.what, items = cs.items, ms = t[0].totalMs });
                // Re-take the baseline every few cases: GPU clocks and editor load drift.
                if (c % 6 == 5 || c == cases.Count - 1)
                {
                    if (progress != null) progress("baseline again");
                    foreach (var step in Measure(cs.warmup + 10, frames, width, height, false, t)) yield return step;
                    baselines.Add(t[0].totalMs);
                }
            }
            double baseMs = Median(baselines);
            foreach (var r in rows) r.savedMs = baseMs - r.ms;
            holder[0] = new Dictionary<string, object>
            {
                { "baseline", baseline.ToJson() },
                { "baselineRunsMs", baselines.Select(b => (object)Math.Round(b, 2)).ToList() },
                { "rows", rows.OrderByDescending(r => r.savedMs).Select(r => (object)r.ToJson()).ToList() },
                { "note", "savedMs = median baseline frame minus the frame with that part off. Differences under ~" + Math.Round(Spread(baselines), 1) + " ms (baseline spread) are noise." },
            };
            if (holder.Length > 1) holder[1] = rows.OrderByDescending(r => r.savedMs).ToList();
            if (holder.Length > 2) holder[2] = baseMs;
        }

        static double Spread(List<double> v) { return v.Count < 2 ? 0 : v.Max() - v.Min(); }

        // ---- selectors (bridge) ----------------------------------------------------------------

        static Regex Glob(string pattern)
        {
            return new Regex("^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$", RegexOptions.IgnoreCase);
        }

        static List<VegetationSystemPro> SelectSystems(BridgeArgs a)
        {
            string which = a.String("system", "all");
            var list = Systems().Where(s => which == "all" || string.Equals(SystemLabel(s), which, StringComparison.OrdinalIgnoreCase)).ToList();
            if (list.Count == 0) throw new BridgeError("No VSP system '" + which + "'. Systems: " + string.Join(", ", Systems().Select(SystemLabel).ToArray()));
            return list;
        }

        static List<ItemRef> SelectItems(BridgeArgs a, List<VegetationSystemPro> systems)
        {
            var package = a.Has("package") ? Glob(a.String("package")) : null;
            var item = a.Has("item") ? Glob(a.String("item")) : null;
            string type = a.String("type");
            return systems.Where(s => s.isActiveAndEnabled).SelectMany(s => Items(s)).Where(r =>
                (package == null || package.IsMatch(r.package.PackageName ?? "")) &&
                (item == null || item.IsMatch(r.item.Name ?? "")) &&
                (type == null || string.Equals(r.item.VegetationType.ToString(), type, StringComparison.OrdinalIgnoreCase))).ToList();
        }

        static VegetationType ParseType(string t)
        {
            var match = Types.Where(x => string.Equals(x.ToString(), t, StringComparison.OrdinalIgnoreCase)).ToList();
            if (match.Count == 0) throw new BridgeError("Unknown vegetation type '" + t + "' (Tree, Grass, Plant, Objects, LargeObjects).");
            return match[0];
        }

        static object Toggle(BridgeArgs a, bool on)
        {
            var systems = SelectSystems(a);
            var done = new List<object>();
            if (a.Bool("wholeSystem", false))
            {
                foreach (var s in systems) { SetSystem(s, on); done.Add(SystemLabel(s) + " system " + (on ? "on" : "off")); }
            }
            else if (a.Bool("storage", false))
            {
                foreach (var s in systems.Where(HasStorage)) { SetStorage(s, on); done.Add(SystemLabel(s) + " storage " + (on ? "on" : "off")); }
            }
            else if (a.Has("shadows"))
            {
                string which = a.String("shadows");
                var types = which == "all" ? Types : new[] { ParseType(which) };
                foreach (var s in systems) foreach (var t in types) { SetShadows(s, t, on); }
                done.Add(string.Join(", ", systems.Select(SystemLabel).ToArray()) + " shadows " + which + " " + (on ? "on" : "off"));
            }
            else
            {
                var items = SelectItems(a, systems);
                if (items.Count == 0) throw new BridgeError("No items match.");
                SetHidden(items, !on);
                done.AddRange(items.Select(r => (object)(SystemLabel(r.system) + " / " + r.package.PackageName + " / " + r.item.Name)));
            }
            return new Dictionary<string, object> { { on ? "shown" : "hidden", done }, { "state", State() } };
        }

        static Dictionary<string, object> State()
        {
            return new Dictionary<string, object>
            {
                { "hiddenItems", Items().Where(IsHidden).Select(r => (object)(SystemLabel(r.system) + " / " + r.package.PackageName + " / " + r.item.Name)).ToList() },
                { "systems", Systems().Select(s => (object)new Dictionary<string, object>
                    {
                        { "system", SystemLabel(s) }, { "on", s.isActiveAndEnabled }, { "gameObjectActive", s.gameObject.activeInHierarchy }, { "storage", HasStorage(s) ? (object)StorageOn(s) : null },
                        { "shadows", Types.Where(t => ShadowsOn(s, t)).Select(t => (object)t.ToString()).ToList() },
                    }).ToList() },
                { "sceneSwitchesChanged", switches.Count },
            };
        }

        // ---- bridge commands -------------------------------------------------------------------

        static IEnumerator Run(IEnumerable<object> steps, Func<object> result)
        {
            foreach (var s in steps) yield return s;
            yield return result();
        }

        [BridgeCommand("golfmap.vegperf.measure", "Time the Scene view frame with the vegetation as it is now (Update+LateUpdate of every edit-mode behaviour, then a GPU-synced render of the Scene view camera): median frame ms, VSP CPU ms, render+GPU ms, and per VSP item the visible instances per LOD, triangles, shadow casting and estimated draw calls, heaviest first.",
            args = "frames=60, warmup=20, width=1920, height=1080, items=25 (rows of the item table; 0 = none, -1 = all)")]
        static IEnumerator MeasureCommand(BridgeArgs a)
        {
            var t = new Timing[1];
            int items = a.Int("items", 25);
            var steps = Measure(Mathf.Clamp(a.Int("warmup", 20), 0, 600), Mathf.Clamp(a.Int("frames", 60), 1, 2000),
                Mathf.Clamp(a.Int("width", 1920), 16, 4096), Mathf.Clamp(a.Int("height", 1080), 16, 4096), items != 0, t);
            return Run(steps, () =>
            {
                var json = t[0].ToJson();
                if (t[0].items != null)
                {
                    var sorted = t[0].items.OrderByDescending(x => x.VisibleTris + x.ShadowTris).ThenByDescending(x => x.stored).ToList();
                    json["items"] = (items < 0 ? sorted : sorted.Take(items)).Select(x => (object)x.ToJson()).ToList();
                    json["byPackage"] = t[0].items.GroupBy(x => x.system + " / " + x.package).Select(g => (object)new Dictionary<string, object>
                    {
                        { "package", g.Key }, { "items", g.Count() }, { "stored", g.Sum(x => x.stored) }, { "visible", g.Sum(x => x.VisibleInstances) },
                        { "visibleTrisK", Math.Round(g.Sum(x => x.VisibleTris) / 1000.0, 1) }, { "shadowTrisK", Math.Round(g.Sum(x => x.ShadowTris) / 1000.0, 1) },
                        { "drawCallsEst", g.Sum(x => x.DrawCalls) },
                    }).ToList();
                }
                json["state"] = State();
                return json;
            });
        }

        // A probe for rendering faults: VSP draws its own material copies per LOD, with keywords it
        // sets itself (LOD_FADE_*), so the asset does not show what is drawn. Runtime only: a VSP
        // refresh or script reload rebuilds the copies from the assets.
        [BridgeCommand("golfmap.vegperf.materials", "Read, and optionally change, the material copies VSP draws for items (per LOD: material, shader, keywords, the floats/vectors asked for). on/off switch shader keywords, floats/vectors set properties. Runtime only - a VSP refresh or script reload puts the assets' values back.",
            args = "item=<glob> (required), system=inner|outer|all, package=<glob>, lod (0-3; default all), material=<glob>, on (keywords, comma-separated), off (keywords), floats ({name: value}), vectors ({name: [x,y,z,w]}), show (property names to report, comma-separated)")]
        static object MaterialsCommand(BridgeArgs a)
        {
            if (!a.Has("item")) throw new BridgeError("Missing argument 'item'.");
            int lod = a.Int("lod", -1);
            var material = a.Has("material") ? Glob(a.String("material")) : null;
            Func<string, string[]> split = k => (a.String(k) ?? "").Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries).Select(x => x.Trim()).ToArray();
            string[] on = split("on"), off = split("off"), show = split("show");
            var floats = a.Raw("floats") as Dictionary<string, object>;
            var vectors = a.Raw("vectors") as Dictionary<string, object>;
            var rows = new List<object>();
            foreach (var r in SelectItems(a, SelectSystems(a)))
            {
                var info = Model(r);
                if (info == null) continue;
                var lods = new[] { info.VegetationMaterialsLOD0, info.VegetationMaterialsLOD1, info.VegetationMaterialsLOD2, info.VegetationMaterialsLOD3 };
                for (int l = 0; l < Math.Min(lods.Length, info.LODCount); l++)
                {
                    if (lods[l] == null || (lod >= 0 && lod != l)) continue;
                    foreach (var m in lods[l].Where(x => x && (material == null || material.IsMatch(x.name))))
                    {
                        foreach (var k in on) m.EnableKeyword(k);
                        foreach (var k in off) m.DisableKeyword(k);
                        if (floats != null)
                            foreach (var f in floats) m.SetFloat(f.Key, Convert.ToSingle(f.Value, System.Globalization.CultureInfo.InvariantCulture));
                        if (vectors != null)
                            foreach (var v in vectors)
                            {
                                var c = ((IList)v.Value).Cast<object>().Select(x => Convert.ToSingle(x, System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                                m.SetVector(v.Key, new Vector4(c[0], c.Length > 1 ? c[1] : 0, c.Length > 2 ? c[2] : 0, c.Length > 3 ? c[3] : 0));
                            }
                        var row = new Dictionary<string, object>
                        {
                            { "system", SystemLabel(r.system) }, { "item", r.item.Name }, { "lod", l }, { "material", m.name }, { "shader", m.shader ? m.shader.name : null },
                            { "keywords", string.Join(" ", m.shaderKeywords) },
                        };
                        foreach (var p in show.Where(m.HasProperty))
                        {
                            int index = Enumerable.Range(0, ShaderUtil.GetPropertyCount(m.shader)).First(i => ShaderUtil.GetPropertyName(m.shader, i) == p);
                            var type = ShaderUtil.GetPropertyType(m.shader, index);
                            row[p] = type == ShaderUtil.ShaderPropertyType.Vector || type == ShaderUtil.ShaderPropertyType.Color ? (object)m.GetVector(p).ToString("0.###")
                                : type == ShaderUtil.ShaderPropertyType.TexEnv ? (m.GetTexture(p) ? m.GetTexture(p).name : null) : (object)m.GetFloat(p);
                        }
                        rows.Add(row);
                    }
                }
            }
            Repaint();
            return new Dictionary<string, object> { { "materials", rows } };
        }

        [BridgeCommand("golfmap.vegperf.hide","Switch part of the vegetation off, live and without touching assets. Items by system/package/type/item (globs); or storage=true (the system's persistent storage), shadows=<type|all>, wholeSystem=true. Scene switches are put back before a scene save or script reload. golfmap.vegperf.show undoes.",
            args = "system=inner|outer|all, package=<glob>, type=Tree|Grass|Plant|Objects|LargeObjects, item=<glob>, storage=false, shadows=<type|all>, wholeSystem=false")]
        static object HideCommand(BridgeArgs a) { return Toggle(a, false); }

        [BridgeCommand("golfmap.vegperf.show", "Switch vegetation back on: same selectors as golfmap.vegperf.hide, or all=true for everything the performance tool switched off.",
            args = "all=false, system, package, type, item, storage, shadows, wholeSystem")]
        static object ShowCommand(BridgeArgs a)
        {
            if (a.Bool("all", false)) { int n = ShowAll(); return new Dictionary<string, object> { { "restored", n }, { "state", State() } }; }
            return Toggle(a, true);
        }

        [BridgeCommand("golfmap.vegperf.state", "What the vegetation performance tool has switched off.")]
        static object StateCommand() { return State(); }

        [BridgeCommand("golfmap.vegperf.sweep", "Find the expensive vegetation: time a baseline, then switch each part off in turn (whole systems, persistent storage, shadows per type, stored vs runtime items, packages, types, the heaviest items) and time again. Rows sorted by ms saved. Everything is switched back on after each case.",
            args = "levels=systems,storage,shadows,source,packages,types,items, frames=40, top=15 (items level), width=1920, height=1080")]
        static IEnumerator SweepCommand(BridgeArgs a)
        {
            var levels = a.Has("levels") ? a.String("levels").Split(',').Select(x => x.Trim()).ToArray() : AllLevels;
            var bad = levels.Where(l => !AllLevels.Contains(l)).ToList();
            if (bad.Count > 0) throw new BridgeError("Unknown level(s) " + string.Join(", ", bad.ToArray()) + ". Levels: " + string.Join(", ", AllLevels));
            var holder = new object[1];
            var steps = Sweep(levels, Mathf.Clamp(a.Int("frames", 40), 5, 500), a.Int("top", 15),
                Mathf.Clamp(a.Int("width", 1920), 16, 4096), Mathf.Clamp(a.Int("height", 1080), 16, 4096), holder, null);
            return Run(steps, () => holder[0]);
        }
    }
}
