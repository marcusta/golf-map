// The bridge's built-in commands: editor state, console, compile, menus,
// scene queries and Scene-view screenshots. Nothing course-specific; course
// tooling registers its own [BridgeCommand]s next to its scripts.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GolfMap.Bridge
{
    static class BridgeBuiltins
    {
        [BridgeCommand("commands", "List every registered bridge command.")]
        static object Commands()
        {
            return BridgeCommands.All.Select(e => new Dictionary<string, object>
            {
                { "name", e.name }, { "description", e.description }, { "args", e.args }, { "declaredIn", e.declaredIn },
            }).ToList();
        }

        [BridgeCommand("status", "Editor state: project, Unity version, open scenes, selection, Scene view camera.")]
        static object Status()
        {
            var sv = SceneView.lastActiveSceneView;
            return new Dictionary<string, object>
            {
                { "projectPath", Path.GetDirectoryName(Application.dataPath).Replace('\\', '/') },
                { "unityVersion", Application.unityVersion },
                { "compiling", EditorApplication.isCompiling },
                { "playing", EditorApplication.isPlaying },
                { "activeScene", SceneManager.GetActiveScene().path },
                { "selection", Selection.gameObjects.Select(g => (object)PathOf(g.transform)).ToList() },
                { "sceneView", sv == null ? null : new Dictionary<string, object> { { "pivot", sv.pivot }, { "rotation", sv.rotation }, { "size", sv.size }, { "camera", sv.camera.transform.position } } },
            };
        }

        [BridgeCommand("console", "Log messages captured since the bridge loaded, oldest first.",
            args = "since=0 (seq), types=[error,exception,assert,warning,log], contains, limit=100, stacks=false")]
        static object Console(BridgeArgs a)
        {
            var types = a.Strings("types").Select(t => t.ToLowerInvariant()).ToArray();
            return new Dictionary<string, object>
            {
                { "lastSeq", BridgeConsole.LastSeq },
                { "entries", BridgeConsole.Query((long)a.Number("since", 0), types, a.String("contains"), a.Int("limit", 100), a.Bool("stacks", false)) },
            };
        }

        [BridgeCommand("console.clear", "Clear the bridge's log buffer, and Unity's Console window with unity=true.", args = "unity=false")]
        static object ConsoleClear(BridgeArgs a)
        {
            BridgeConsole.Clear(a.Bool("unity", false));
            return new Dictionary<string, object> { { "lastSeq", BridgeConsole.LastSeq } };
        }

        [BridgeCommand("compile", "Compiler messages from the last compile of each script assembly.")]
        static object Compile()
        {
            return new Dictionary<string, object> { { "compiling", EditorApplication.isCompiling }, { "assemblies", BridgeConsole.Compile() } };
        }

        [BridgeCommand("refresh", "AssetDatabase.Refresh: import changed files and recompile scripts without focusing Unity. A successful compile reloads the bridge.")]
        static object Refresh()
        {
            AssetDatabase.Refresh();
            return new Dictionary<string, object> { { "compiling", EditorApplication.isCompiling } };
        }

        [BridgeCommand("asset.reimport", "Force-reimport assets edited on disk that a refresh left alone (e.g. a .mat whose YAML was changed outside Unity while the editor held it loaded), then repaint the Scene view.", args = "paths (asset paths, comma-separated), path (one asset path, for a name with a comma in it)")]
        static object Reimport(BridgeArgs a)
        {
            var paths = (a.String("paths") ?? "").Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).ToList();
            if (a.Has("path")) paths.Add(a.String("path"));
            if (paths.Count == 0) throw new BridgeError("paths or path is required.");
            foreach (var p in paths) AssetDatabase.ImportAsset(p, ImportAssetOptions.ForceUpdate | ImportAssetOptions.ForceSynchronousImport);
            SceneView.RepaintAll();
            return paths.Select(p => (object)new Dictionary<string, object> { { "path", p }, { "loaded", AssetDatabase.LoadMainAssetAtPath(p) != null } }).ToList();
        }

        [BridgeCommand("menu", "Run a menu item by its path, e.g. 'GolfMap/Course/Select active course'.", args = "path")]
        static object Menu(BridgeArgs a)
        {
            var path = a.Require("path");
            if (!EditorApplication.ExecuteMenuItem(path)) throw new BridgeError("No enabled menu item '" + path + "'. Call menu.list for script menus.");
            return new Dictionary<string, object> { { "ran", path } };
        }

        [BridgeCommand("menu.list", "Menu items declared by scripts in this project (not Unity's built-in menus).", args = "prefix")]
        static object MenuList(BridgeArgs a)
        {
            var prefix = a.String("prefix", "");
            var items = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var name = assembly.GetName().Name;
                if (!name.StartsWith("Assembly-CSharp", StringComparison.Ordinal) && name.StartsWith("Unity", StringComparison.Ordinal)) continue;
                if (name.StartsWith("System", StringComparison.Ordinal) || name == "mscorlib" || name.StartsWith("Mono", StringComparison.Ordinal)) continue;
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                foreach (var type in types)
                    foreach (var method in type.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic))
                        foreach (MenuItem attr in method.GetCustomAttributes(typeof(MenuItem), false))
                            if (!attr.validate && attr.menuItem.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) items.Add(attr.menuItem);
            }
            return items.ToList();
        }

        [BridgeCommand("scene.find", "Find GameObjects in the open scenes by name and/or component type. Includes inactive objects.",
            args = "name (substring), component (type name), under (object path), limit=200")]
        static object SceneFind(BridgeArgs a)
        {
            var name = a.String("name");
            var component = a.String("component");
            var under = a.String("under");
            int limit = a.Int("limit", 200);
            IEnumerable<Transform> pool = under == null ? AllTransforms() : Descendants(Resolve(under).transform);
            var hits = new List<object>();
            int total = 0;
            foreach (var t in pool)
            {
                if (name != null && t.name.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (component != null && !t.GetComponents<Component>().Any(c => c != null && TypeMatches(c.GetType(), component))) continue;
                total++;
                if (hits.Count < limit) hits.Add(Describe(t.gameObject));
            }
            return new Dictionary<string, object> { { "total", total }, { "objects", hits } };
        }

        [BridgeCommand("scene.inspect", "Serialized fields of one component (as the Inspector sees them), or the component list of an object.",
            args = "path (object path), component (type name; omit for the list), filter (property path substring), depth=3, limit=400")]
        static object SceneInspect(BridgeArgs a)
        {
            var go = Resolve(a.Require("path"));
            var componentName = a.String("component");
            if (componentName == null) return Describe(go);
            var matches = go.GetComponents<Component>().Where(c => c != null && TypeMatches(c.GetType(), componentName)).ToArray();
            if (matches.Length == 0) throw new BridgeError(PathOf(go.transform) + " has no " + componentName + ".");
            return matches.Select(c => Inspect(c, a.String("filter"), a.Int("depth", 3), a.Int("limit", 400))).ToList();
        }

        [BridgeCommand("editor.tick", "Run the editor for some frames as if someone were panning the Scene view: every active [ExecuteInEditMode] behaviour gets Update/LateUpdate (so VSP culls, spawns and loads cells while Unity is unfocused) and the view nudges by a hair, ending at its original pose.", args = "frames=30")]
        static IEnumerator Tick(BridgeArgs a)
        {
            int frames = Mathf.Clamp(a.Int("frames", 30), 1, 3000);
            var sv = SceneView.lastActiveSceneView;
            if (sv == null)
            {
                var calls = EditModeUpdates();
                for (int i = 0; i < frames; i++) { TickEditMode(calls); yield return null; }
            }
            else
                foreach (var step in Nudge(sv, frames)) yield return step;
            yield return new Dictionary<string, object> { { "frames", frames } };
        }

        // An unfocused 2018 editor runs no player loop, and neither QueuePlayerLoopUpdate nor
        // dirtying objects makes it run [ExecuteInEditMode] updates; VSP only re-culls and
        // redraws from its own Update/LateUpdate (a user fixes a blank VSP with a little pan,
        // which works because the focused editor then ticks). So per frame: move the pivot by a
        // hair (alternate frames), call Update then LateUpdate on every active [ExecuteInEditMode]
        // behaviour in the open scenes - what the player loop would do - and repaint. The exact
        // pose is back for the last frames.
        static IEnumerable<object> Nudge(SceneView sv, int frames)
        {
            var calls = EditModeUpdates();
            var pivot = sv.pivot;
            var rotation = sv.rotation;
            var size = sv.size;
            float eps = Mathf.Max(0.001f, size * 0.0005f);
            for (int i = 0; i < frames; i++)
            {
                bool last = i >= frames - 2;
                var offset = !last && i % 2 == 0 ? sv.camera.transform.right * eps : Vector3.zero;
                sv.LookAtDirect(pivot + offset, rotation, size);
                TickEditMode(calls);
                EditorApplication.QueuePlayerLoopUpdate();
                sv.Repaint();
                yield return null;
            }
        }

        sealed class EditModeCalls
        {
            public readonly List<KeyValuePair<MonoBehaviour, MethodInfo>> update = new List<KeyValuePair<MonoBehaviour, MethodInfo>>();
            public readonly List<KeyValuePair<MonoBehaviour, MethodInfo>> lateUpdate = new List<KeyValuePair<MonoBehaviour, MethodInfo>>();
        }

        static EditModeCalls EditModeUpdates()
        {
            var calls = new EditModeCalls();
            const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            foreach (var b in UnityEngine.Object.FindObjectsOfType<MonoBehaviour>())
            {
                if (b == null || !b.isActiveAndEnabled || !b.GetType().IsDefined(typeof(ExecuteInEditMode), true)) continue;
                var u = b.GetType().GetMethod("Update", flags, null, Type.EmptyTypes, null);
                var l = b.GetType().GetMethod("LateUpdate", flags, null, Type.EmptyTypes, null);
                if (u != null) calls.update.Add(new KeyValuePair<MonoBehaviour, MethodInfo>(b, u));
                if (l != null) calls.lateUpdate.Add(new KeyValuePair<MonoBehaviour, MethodInfo>(b, l));
            }
            return calls;
        }

        static void TickEditMode(EditModeCalls calls)
        {
            foreach (var list in new[] { calls.update, calls.lateUpdate })
                foreach (var c in list)
                {
                    if (c.Key == null || !c.Key.isActiveAndEnabled) continue;
                    try { c.Value.Invoke(c.Key, null); }
                    catch (TargetInvocationException e) { Debug.LogException(e.InnerException ?? e); }
                }
        }

        [BridgeCommand("scene.save", "Save the open scenes that have unsaved changes (File > Save), without a dialog. Returns each open scene with whether it was dirty and whether it was saved.", args = "")]
        static object SceneSave(BridgeArgs a)
        {
            var rows = new List<object>();
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                bool dirty = scene.isDirty;
                if (dirty && string.IsNullOrEmpty(scene.path)) throw new BridgeError("Scene '" + scene.name + "' has never been saved: save it once in Unity to give it a file.");
                bool saved = dirty && UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene);
                if (dirty && !saved) throw new BridgeError("Could not save " + scene.path + ".");
                rows.Add(new Dictionary<string, object> { { "scene", scene.path }, { "wasDirty", dirty }, { "saved", saved } });
            }
            return rows;
        }

        [BridgeCommand("scene.open", "Open a scene file (File > Open Scene), replacing the open scenes. Refuses while an open scene has unsaved changes.", args = "path (e.g. Assets/Scenes/Course.unity)")]
        static object SceneOpen(BridgeArgs a)
        {
            var path = a.Require("path");
            if (AssetDatabase.LoadAssetAtPath<SceneAsset>(path) == null) throw new BridgeError("No scene at " + path + ".");
            for (int i = 0; i < SceneManager.sceneCount; i++)
                if (SceneManager.GetSceneAt(i).isDirty) throw new BridgeError("Scene '" + SceneManager.GetSceneAt(i).name + "' has unsaved changes: save or discard them first.");
            var scene = UnityEditor.SceneManagement.EditorSceneManager.OpenScene(path, UnityEditor.SceneManagement.OpenSceneMode.Single);
            return new Dictionary<string, object> { { "scene", scene.path }, { "roots", scene.rootCount } };
        }

        [BridgeCommand("selection", "Get the selection, or select (and ping) the object at path.", args = "path")]
        static object SelectionCommand(BridgeArgs a)
        {
            if (a.Has("path"))
            {
                var go = Resolve(a.String("path"));
                Selection.activeGameObject = go;
                EditorGUIUtility.PingObject(go);
            }
            return Selection.gameObjects.Select(g => (object)PathOf(g.transform)).ToList();
        }

        [BridgeCommand("screenshot", "Render the Scene view camera to a PNG in the project's Temp/GolfMapBridge folder. Optionally move the view first: from/at (world points) or pivot/rotation/size; it stays there unless restore=true puts it back after the capture. mode=view (default) reads the Scene view's own render target (what it shows, VSP included, window size); mode=camera renders its camera offscreen at width x height. Neither reads screen pixels, so both work while Unity is covered or unfocused.",
            args = "width=1280, height=720, from=[x,y,z], at=[x,y,z], pivot=[x,y,z], rotation=[x,y,z] (euler), size, eye=<m above ground; with from/at>, hide=[object paths, renderers off for this capture], mode=view|camera, warmup=12 (editor frames pumped first), restore=false (put the Scene view back to its pose before the call)")]
        static IEnumerator Screenshot(BridgeArgs a)
        {
            var sv = SceneView.lastActiveSceneView;
            if (sv == null) throw new BridgeError("No Scene view is open.");
            var from = a.Vector("from");
            var at = a.Vector("at");
            // eye=<m>: from/at y are ignored; the camera stands <m> above the terrain under
            // `from` and looks at a point 0.5 m above the terrain under `at`.
            if (a.Has("eye") && from.HasValue && at.HasValue)
            {
                float eye = (float)a.Number("eye", 1.7);
                from = new Vector3(from.Value.x, GroundHeight(from.Value) + eye, from.Value.z);
                at = new Vector3(at.Value.x, GroundHeight(at.Value) + 0.5f, at.Value.z);
            }
            if (from.HasValue != at.HasValue) throw new BridgeError("Give both 'from' and 'at', or neither.");
            // Checked before the view moves, so a mistake never leaves it moved.
            string mode = a.String("mode", "view");
            if (mode != "view" && mode != "camera") throw new BridgeError("mode must be 'view' or 'camera'.");
            // hide=[object paths]: their renderers are off for this capture only (see-through for
            // "what is under this mesh"); always restored, never saved.
            var hidden = a.Strings("hide").SelectMany(p => Resolve(p).GetComponentsInChildren<Renderer>()).Where(r => r.enabled).ToList();
            // restore=true: the view goes back to this pose once the image is captured.
            bool restore = a.Bool("restore", false);
            var oldPivot = sv.pivot;
            var oldRotation = sv.rotation;
            var oldSize = sv.size;
            var oldOrtho = sv.orthographic;
            if (from.HasValue)
            {
                var dir = at.Value - from.Value;
                if (dir.sqrMagnitude < 1e-6f) throw new BridgeError("'from' and 'at' are the same point.");
                // In 2018.2 the Scene view camera sits exactly `size` behind the pivot (measured).
                sv.LookAtDirect(at.Value, Quaternion.LookRotation(dir), dir.magnitude);
            }
            else if (a.Has("pivot") || a.Has("rotation") || a.Has("size"))
            {
                var euler = a.Vector("rotation");
                sv.LookAtDirect(a.Vector("pivot") ?? sv.pivot, euler.HasValue ? Quaternion.Euler(euler.Value) : sv.rotation, (float)a.Number("size", sv.size));
            }
            // Let the Scene view and [ExecuteInEditMode] renderers catch up at the new pose.
            int warmup = Mathf.Clamp(a.Int("warmup", 12), 1, 600);
            foreach (var step in Nudge(sv, warmup)) yield return step;

            int width = Mathf.Clamp(a.Int("width", 1280), 16, 4096);
            int height = Mathf.Clamp(a.Int("height", 720), 16, 4096);
            // Never a read of screen pixels: those hold whatever window covers Unity.
            //   view   - the Scene view's own render target after its last repaint: exactly
            //            what the Scene view shows, VSP included (its draws are queued for
            //            that repaint), at the window's size;
            //   camera - a fresh offscreen render of its camera at width x height; misses
            //            draws another repaint already consumed.
            foreach (var r in hidden) r.enabled = false;
            Texture2D shot;
            try
            {
                if (hidden.Count > 0) for (int i = 0; i < 3; i++) { sv.Repaint(); yield return null; }
                shot = mode == "view" ? ReadSceneTarget(sv) : RenderCamera(sv.camera, width, height);
            }
            finally
            {
                foreach (var r in hidden) if (r) r.enabled = true;
            }
            // the pose the image was taken at (the result reports it, restored or not)
            var shotPivot = sv.pivot;
            var shotRotation = sv.rotation;
            var shotSize = sv.size;
            var shotCamera = sv.camera.transform.position;
            if (restore)
            {
                sv.LookAtDirect(oldPivot, oldRotation, oldSize);
                sv.orthographic = oldOrtho;
                sv.Repaint();
            }

            var folder = Path.Combine(Path.GetDirectoryName(Application.dataPath), "Temp/GolfMapBridge");
            Directory.CreateDirectory(folder);
            var file = Path.Combine(folder, "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png").Replace('\\', '/');
            File.WriteAllBytes(file, shot.EncodeToPNG());
            int w = shot.width, h = shot.height;
            UnityEngine.Object.DestroyImmediate(shot);
            var result = new Dictionary<string, object>
            {
                { "file", file }, { "width", w }, { "height", h }, { "mode", mode },
                { "pivot", shotPivot }, { "rotation", shotRotation }, { "size", shotSize }, { "camera", shotCamera },
            };
            if (restore) result["restored"] = true;
            yield return result;
        }

        // ---- helpers ----

        // The visible surface: the highest collider hit straight down (course meshes sit on
        // or above the terrain), else the highest terrain covering the point (a GSPro course
        // nests the inner terrain inside a lower, larger outer one).
        static float GroundHeight(Vector3 p)
        {
            var hits = Physics.RaycastAll(new Vector3(p.x, 10000f, p.z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore);
            if (hits.Length > 0) return hits.Max(h => h.point.y);
            float best = float.NegativeInfinity;
            foreach (var t in Terrain.activeTerrains)
            {
                var o = t.transform.position;
                var size = t.terrainData.size;
                if (p.x >= o.x && p.x <= o.x + size.x && p.z >= o.z && p.z <= o.z + size.z)
                    best = Mathf.Max(best, t.SampleHeight(p) + o.y);
            }
            if (float.IsNegativeInfinity(best)) throw new BridgeError("No terrain under (" + p.x + ", " + p.z + ").");
            return best;
        }

        [BridgeCommand("terrain.height", "World height of the terrain surface at x,z (the highest collider hit straight down - course meshes or terrain - else the highest terrain covering the point).", args = "x, z")]
        static object TerrainHeight(BridgeArgs a)
        {
            var p = new Vector3((float)a.Number("x", double.NaN), 0, (float)a.Number("z", double.NaN));
            if (float.IsNaN(p.x) || float.IsNaN(p.z)) throw new BridgeError("Give x and z.");
            return new Dictionary<string, object> { { "x", p.x }, { "z", p.z }, { "y", GroundHeight(p) } };
        }

        [BridgeCommand("ground.probe", "Everything under a point, top down: each active terrain's height there and every collider hit straight down (object path, height). For 'what is the ground here' questions: meshes above terrain, buried vegetation, seams.", args = "x, z")]
        static object GroundProbe(BridgeArgs a)
        {
            float x = (float)a.Number("x", double.NaN), z = (float)a.Number("z", double.NaN);
            if (float.IsNaN(x) || float.IsNaN(z)) throw new BridgeError("Give x and z.");
            var p = new Vector3(x, 0, z);
            var terrains = new List<object>();
            foreach (var t in Terrain.activeTerrains)
            {
                var o = t.transform.position; var size = t.terrainData.size;
                if (p.x >= o.x && p.x <= o.x + size.x && p.z >= o.z && p.z <= o.z + size.z)
                    terrains.Add(new Dictionary<string, object> { { "terrain", t.name }, { "y", t.SampleHeight(p) + o.y } });
            }
            var hits = Physics.RaycastAll(new Vector3(x, 10000f, z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore)
                .OrderByDescending(h => h.point.y)
                .Select(h => (object)new Dictionary<string, object> { { "object", PathOf(h.collider.transform) }, { "y", h.point.y } }).ToList();
            return new Dictionary<string, object> { { "x", x }, { "z", z }, { "terrains", terrains }, { "hits", hits } };
        }

        [BridgeCommand("ground.profile", "A cross-section: along the line from (x0, z0) to (x1, z1) every `step` metres, the highest collider hit straight down (object and height) and each active terrain's height. For comparing the meshes' shape with the heightmap.", args = "x0, z0, x1, z1, step=0.5, ignore (object path prefix left out, e.g. /GolfMap Walls)")]
        static object GroundProfile(BridgeArgs a)
        {
            float x0 = (float)a.Number("x0", double.NaN), z0 = (float)a.Number("z0", double.NaN), x1 = (float)a.Number("x1", double.NaN), z1 = (float)a.Number("z1", double.NaN);
            if (float.IsNaN(x0) || float.IsNaN(z0) || float.IsNaN(x1) || float.IsNaN(z1)) throw new BridgeError("Give x0, z0, x1, z1.");
            float step = Mathf.Max(0.05f, (float)a.Number("step", 0.5));
            var ignore = a.String("ignore");
            float length = Vector2.Distance(new Vector2(x0, z0), new Vector2(x1, z1));
            int n = Mathf.Min(4000, Mathf.FloorToInt(length / step) + 1);
            var rows = new List<object>();
            for (int i = 0; i < n; i++)
            {
                float f = n > 1 ? i / (float)(n - 1) : 0f, x = Mathf.Lerp(x0, x1, f), z = Mathf.Lerp(z0, z1, f);
                var hit = Physics.RaycastAll(new Vector3(x, 10000f, z), Vector3.down, 20000f, ~0, QueryTriggerInteraction.Ignore)
                    .Where(h => !(h.collider is TerrainCollider) && (string.IsNullOrEmpty(ignore) || !PathOf(h.collider.transform).StartsWith(ignore, StringComparison.Ordinal)))
                    .OrderByDescending(h => h.point.y).FirstOrDefault();
                var row = new Dictionary<string, object> { { "d", Math.Round(f * length, 3) }, { "x", x }, { "z", z } };
                if (hit.collider != null) { row["y"] = hit.point.y; row["object"] = hit.collider.name; }
                foreach (var t in Terrain.activeTerrains)
                {
                    var o = t.transform.position; var size = t.terrainData.size;
                    if (x >= o.x && x <= o.x + size.x && z >= o.z && z <= o.z + size.z) { row[t.name] = t.SampleHeight(new Vector3(x, 0, z)) + o.y; break; }
                }
                rows.Add(row);
            }
            return new Dictionary<string, object> { { "length", length }, { "rows", rows } };
        }

        static Texture2D ReadSceneTarget(SceneView sv)
        {
            var field = typeof(SceneView).GetField("m_SceneTargetTexture", BindingFlags.Instance | BindingFlags.NonPublic);
            var rt = field == null ? null : field.GetValue(sv) as RenderTexture;
            if (rt == null || !rt.IsCreated()) throw new BridgeError("The Scene view has no render target yet (this Unity version keeps it elsewhere?); use mode=camera.");
            var previous = RenderTexture.active;
            // The target may be HDR/linear; blit through an sRGB 8-bit copy so the PNG matches the screen.
            var copy = RenderTexture.GetTemporary(rt.width, rt.height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            Graphics.Blit(rt, copy);
            RenderTexture.active = copy;
            var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
            tex.Apply();
            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(copy);
            return tex;
        }

        static Texture2D RenderCamera(Camera cam, int width, int height)
        {
            var rt = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
            var previousTarget = cam.targetTexture;
            var previousActive = RenderTexture.active;
            try
            {
                cam.targetTexture = rt;
                cam.aspect = (float)width / height;
                cam.Render();
                RenderTexture.active = rt;
                var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
                return tex;
            }
            finally
            {
                cam.targetTexture = previousTarget;
                cam.ResetAspect();
                RenderTexture.active = previousActive;
                RenderTexture.ReleaseTemporary(rt);
            }
        }

        static Dictionary<string, object> Inspect(Component c, string filter, int depth, int limit)
        {
            var so = new SerializedObject(c);
            var props = new List<object>();
            int total = 0;
            var it = so.GetIterator();
            bool enter = true;
            while (it.NextVisible(enter))
            {
                enter = it.depth < depth && it.propertyType != SerializedPropertyType.String;
                if (filter != null && it.propertyPath.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                total++;
                if (props.Count < limit)
                    props.Add(new Dictionary<string, object> { { "path", it.propertyPath }, { "type", it.propertyType.ToString() }, { "value", Value(it) } });
            }
            return new Dictionary<string, object> { { "component", c.GetType().FullName }, { "total", total }, { "properties", props } };
        }

        static object Value(SerializedProperty p)
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer: return p.longValue;
                case SerializedPropertyType.Boolean: return p.boolValue;
                case SerializedPropertyType.Float: return p.doubleValue;
                case SerializedPropertyType.String: return p.stringValue;
                case SerializedPropertyType.Color: return p.colorValue;
                case SerializedPropertyType.Enum:
                    return p.enumValueIndex >= 0 && p.enumValueIndex < p.enumDisplayNames.Length ? p.enumDisplayNames[p.enumValueIndex] : (object)p.intValue;
                case SerializedPropertyType.Vector2: return p.vector2Value;
                case SerializedPropertyType.Vector3: return p.vector3Value;
                case SerializedPropertyType.Vector4: return p.vector4Value;
                case SerializedPropertyType.Quaternion: return p.quaternionValue;
                case SerializedPropertyType.Rect: return p.rectValue;
                case SerializedPropertyType.Bounds: return p.boundsValue;
                case SerializedPropertyType.LayerMask: return p.intValue;
                case SerializedPropertyType.ArraySize: return p.intValue;
                case SerializedPropertyType.ObjectReference:
                    var o = p.objectReferenceValue;
                    if (o == null) return null;
                    var assetPath = AssetDatabase.GetAssetPath(o);
                    return o.name + " (" + o.GetType().Name + (string.IsNullOrEmpty(assetPath) ? "" : ", " + assetPath) + ")";
                case SerializedPropertyType.Generic:
                    return p.isArray ? (object)("array[" + p.arraySize + "]") : null;
                default: return null;
            }
        }

        static Dictionary<string, object> Describe(GameObject go)
        {
            return new Dictionary<string, object>
            {
                { "path", PathOf(go.transform) },
                { "scene", go.scene.name },
                { "active", go.activeInHierarchy },
                { "position", go.transform.position },
                { "children", go.transform.childCount },
                { "components", go.GetComponents<Component>().Select(c => c == null ? "<missing script>" : c.GetType().Name).ToList() },
            };
        }

        // "/Root/Child/Leaf". A name shared with siblings gets its position among them:
        // inner and outer both have "/VegetationStudioPro/VegetationSystemPro#0" and "#1".
        // Names containing '/' cannot be addressed. A name containing '#' (placed props: "<asset>#<index>")
        // resolves when it is unique among its siblings: an exact name match wins over the "#<position>" suffix.
        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t != null; t = t.parent)
            {
                var same = Siblings(t).Where(s => s.name == t.name).ToList();
                parts.Add(same.Count > 1 ? t.name + "#" + same.IndexOf(t) : t.name);
            }
            parts.Reverse();
            return "/" + string.Join("/", parts.ToArray());
        }

        static GameObject Resolve(string path)
        {
            Transform current = null;
            foreach (var part in path.Trim('/').Split('/'))
            {
                string name = part;
                var level = (current == null ? Roots() : current.Cast<Transform>()).ToList();
                var named = level.Where(t => t.name == part).ToList();
                int index = -1, hash = part.LastIndexOf('#');
                if (named.Count == 1) { }
                else if (hash > 0 && int.TryParse(part.Substring(hash + 1), out index)) { name = part.Substring(0, hash); named = level.Where(t => t.name == name).ToList(); }
                else index = -1;
                string where = current == null ? "the open scenes" : PathOf(current);
                if (named.Count == 0) throw new BridgeError("No '" + name + "' in " + where + ". Use scene.find.");
                if (index >= named.Count) throw new BridgeError("Only " + named.Count + " objects named '" + name + "' in " + where + ".");
                if (index < 0 && named.Count > 1) throw new BridgeError(named.Count + " objects named '" + name + "' in " + where + "; address one as " + name + "#0.." + name + "#" + (named.Count - 1) + ".");
                current = named[Math.Max(index, 0)];
            }
            return current.gameObject;
        }

        static IEnumerable<Transform> Siblings(Transform t)
        {
            return t.parent != null ? t.parent.Cast<Transform>() : Roots();
        }

        static IEnumerable<Transform> Roots()
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var scene = SceneManager.GetSceneAt(i);
                if (!scene.isLoaded) continue;
                foreach (var root in scene.GetRootGameObjects()) yield return root.transform;
            }
        }

        static IEnumerable<Transform> AllTransforms()
        {
            return Roots().SelectMany(Descendants);
        }

        static IEnumerable<Transform> Descendants(Transform root)
        {
            var stack = new Stack<Transform>();
            stack.Push(root);
            while (stack.Count > 0)
            {
                var t = stack.Pop();
                yield return t;
                for (int i = t.childCount - 1; i >= 0; i--) stack.Push(t.GetChild(i));
            }
        }

        static bool TypeMatches(Type type, string name)
        {
            for (; type != null; type = type.BaseType)
                if (type.Name == name || type.FullName == name) return true;
            return false;
        }
    }
}
