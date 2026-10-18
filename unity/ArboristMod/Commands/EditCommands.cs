// One placed vegetation instance changed live, the optimistic half of the Arborist edit loop
// (server/services/arborist-edit.service.ts persists the same change into the files): the
// instance is found by its item and position, removed, and added again as it should now be.
// VSP draws the change on the next frame. Nothing is written to disk here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using AwesomeTechnologies.Vegetation.PersistentStorage;
using AwesomeTechnologies.VegetationSystem;
using UnityEngine;

namespace GolfMap.Bridge
{
    static class EditCommands
    {
        /** The planted trees' source id (pipeline/arborist.py TREE_SOURCE_ID), for an instance added from nothing. */
        const byte TreeSourceId = 42;

        // The system that holds `item` (by VegetationItemID, or by name with the trailing spaces of the catalogue's
        // names ignored); `system` narrows it to the systems whose path contains it.
        static VegetationSystemPro SystemOf(string item, string system, out VegetationItemInfoPro info)
        {
            foreach (var s in Resources.FindObjectsOfTypeAll<VegetationSystemPro>().Where(s => s && s.gameObject.scene.IsValid() && s.isActiveAndEnabled))
            {
                if (system != null && PathOf(s.transform).IndexOf(system, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (!s.PersistentVegetationStorage) continue;
                info = s.VegetationPackageProList.Where(p => p).SelectMany(p => p.VegetationInfoList)
                    .FirstOrDefault(i => i.VegetationItemID == item || (i.Name ?? "").Trim() == item.Trim());
                if (info != null) return s;
            }
            info = null;
            return null;
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return "/" + string.Join("/", parts.ToArray());
        }

        static List<object> V(Vector3 v) { return new List<object> { Math.Round(v.x, 3), Math.Round(v.y, 3), Math.Round(v.z, 3) }; }
        static List<object> Q(Quaternion q) { return new List<object> { Math.Round(q.x, 6), Math.Round(q.y, 6), Math.Round(q.z, 6), Math.Round(q.w, 6) }; }

        static Vector3 Vec(List<object> l, string what)
        {
            if (l == null || l.Count != 3) throw new BridgeError(what + " must be [x, y, z].");
            return new Vector3(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]));
        }

        static Quaternion Quat(List<object> l)
        {
            if (l == null || l.Count != 4) throw new BridgeError("rotation must be [x, y, z, w].");
            return new Quaternion(Convert.ToSingle(l[0]), Convert.ToSingle(l[1]), Convert.ToSingle(l[2]), Convert.ToSingle(l[3]));
        }

        // The stored instance of `id` nearest to world (x, z) within `within` metres, ignoring height.
        static bool Nearest(VegetationSystemPro s, string id, Vector3 at, float within, out PersistentVegetationItem found)
        {
            found = default(PersistentVegetationItem);
            var package = s.PersistentVegetationStorage.PersistentVegetationStoragePackage;
            if (!package) return false;
            Vector3 origin = s.VegetationSystemPosition;
            float best = within * within;
            bool any = false;
            foreach (var cell in package.PersistentVegetationCellList)
                foreach (var info in cell.PersistentVegetationInfoList)
                {
                    if (info.VegetationItemID != id) continue;
                    foreach (var item in info.VegetationItemList)
                    {
                        var world = item.Position + origin;
                        float dx = world.x - at.x, dz = world.z - at.z, d = dx * dx + dz * dz;
                        if (d > best) continue;
                        best = d; found = item; found.Position = world; any = true;
                    }
                }
            return any;
        }

        static Dictionary<string, object> Describe(VegetationItemInfoPro info, PersistentVegetationItem i)
        {
            return new Dictionary<string, object>
            {
                { "item", info.Name }, { "itemId", info.VegetationItemID }, { "position", V(i.Position) }, { "scale", V(i.Scale) },
                { "rotation", Q(i.Rotation) }, { "source", (int)i.VegetationSourceID },
            };
        }

        [BridgeCommand("veg.edit", "Change one placed (persistent storage) vegetation instance live, drawn on the next frame, nothing saved: the instance of `item` nearest to `at` (world x, z within `within` m) is removed, and unless delete=true added again with what is given (position, scale, rotation, another item `as`). Without `at` a new instance of `item` is added at `position` (scale and rotation needed). Returns the instance as it was and as it is now.",
            args = "item (required: VegetationItemID or name), at=[x,y,z] (world), within=0.5, delete=false, position=[x,y,z] (world), scale=[x,y,z], rotation=[x,y,z,w], as (another item, same system), system (part of its path)")]
        static object Edit(BridgeArgs a)
        {
            var clock = Stopwatch.StartNew();
            string item = a.Require("item"), system = a.String("system");
            VegetationItemInfoPro info;
            var s = SystemOf(item, system, out info);
            if (s == null) throw new BridgeError("No vegetation system holds an item '" + item + "'" + (system != null ? " under '" + system + "'" : "") + " (a new item needs the file reloaded).");
            var storage = s.PersistentVegetationStorage;
            var result = new Dictionary<string, object> { { "system", PathOf(s.transform) } };

            PersistentVegetationItem was;
            var atList = a.List("at");
            if (atList != null)
            {
                float within = (float)a.Number("within", 0.5);
                if (!Nearest(s, info.VegetationItemID, Vec(atList, "at"), within, out was))
                    throw new BridgeError("No instance of '" + info.Name + "' within " + within + " m of (" + atList[0] + ", " + atList[2] + ").");
                result["was"] = Describe(info, was);
            }
            else
            {
                if (a.Bool("delete", false)) throw new BridgeError("delete needs `at`: which instance.");
                was = new PersistentVegetationItem { VegetationSourceID = TreeSourceId, DistanceFalloff = 1, Scale = Vector3.one, Rotation = Quaternion.identity };
                if (a.List("position") == null || a.List("scale") == null || a.List("rotation") == null)
                    throw new BridgeError("A new instance (no `at`) needs position, scale and rotation.");
            }

            var target = info;
            string other = a.String("as");
            if (other != null)
            {
                target = s.VegetationPackageProList.Where(p => p).SelectMany(p => p.VegetationInfoList)
                    .FirstOrDefault(i => i.VegetationItemID == other || (i.Name ?? "").Trim() == other.Trim());
                if (target == null) throw new BridgeError("The system has no item '" + other + "' (a new item needs the file reloaded).");
            }

            if (atList != null) storage.RemoveVegetationItemInstance(info.VegetationItemID, was.Position, 0.05f, true);
            if (!a.Bool("delete", false))
            {
                var now = was;
                if (a.List("position") != null) now.Position = Vec(a.List("position"), "position");
                if (a.List("scale") != null) now.Scale = Vec(a.List("scale"), "scale");
                if (a.List("rotation") != null) now.Rotation = Quat(a.List("rotation"));
                storage.AddVegetationItemInstance(target.VegetationItemID, now.Position, now.Scale, now.Rotation, false, now.VegetationSourceID, now.DistanceFalloff, true);
                result["now"] = Describe(target, now);
            }
            result["ms"] = clock.ElapsedMilliseconds;
            return result;
        }

        // Height of an item's model (its first LOD's mesh), for aiming at the middle of the plant; 4 m when unknown.
        static Dictionary<string, float> ModelHeights(VegetationSystemPro s)
        {
            var heights = new Dictionary<string, float>();
            foreach (var package in s.VegetationPackageProModelsList)
                foreach (var model in package.VegetationItemModelList)
                {
                    if (model == null || model.VegetationItemInfo == null) continue;
                    var mesh = model.VegetationMeshLod0;
                    heights[model.VegetationItemInfo.VegetationItemID] = mesh ? Mathf.Max(0.3f, mesh.bounds.max.y) : 4f;
                }
            return heights;
        }

        // The pick under the mouse, as veg.pick makes it (null when nothing is there).
        internal static Dictionary<string, object> PickAt(Vector2 point, float window, string system)
        {
            var hits = Hits(point, window, 600f, system);
            return hits.Count > 0 ? hits.OrderBy(h => h.Key).First().Value : null;
        }

        [BridgeCommand("veg.picker", "The P key in the app: P over a tree or bush marks it (the placed instance under the mouse in `system`, as veg.pick finds it) and draws a marker over it until the next P or Esc; veg.picked reads it. on=false takes the key away. Idempotent, and put back after a commands reload.",
            args = "on=true, system=/ArbVegetationStudioPro (part of the systems' path)")]
        static object Picker(BridgeArgs a)
        {
            var old = GameObject.Find("GolfMapTreePicker");
            var kept = TreePicker.Marked;
            if (old) UnityEngine.Object.Destroy(old);
            if (!a.Bool("on", true)) { TreePicker.Marked = null; return new Dictionary<string, object> { { "picker", false } }; }
            var go = new GameObject("GolfMapTreePicker");
            UnityEngine.Object.DontDestroyOnLoad(go);
            var picker = go.AddComponent<TreePicker>();
            picker.system = a.String("system", "/ArbVegetationStudioPro");
            TreePicker.Marked = kept;
            return new Dictionary<string, object> { { "picker", true }, { "key", "P" }, { "marked", kept } };
        }

        // The picker of this commands assembly is up (one left by an earlier assembly keeps its own marked tree).
        static bool Installed()
        {
            var go = GameObject.Find("GolfMapTreePicker");
            return go && go.GetComponent<TreePicker>() != null;
        }

        [BridgeCommand("veg.picked", "The tree or bush marked with the P key (veg.picker): item, id, position, scale, rotation, system, when; null when none is marked. clear=true unmarks it.",
            args = "clear=false")]
        static object Picked(BridgeArgs a)
        {
            var marked = TreePicker.Marked;
            if (a.Bool("clear", false)) TreePicker.Marked = null;
            return new Dictionary<string, object> { { "marked", marked }, { "picker", Installed() } };
        }


        // Every placed instance whose stem (foot to top, as seen) passes within `window` (picture heights) of
        // viewport `point`, keyed for ordering: nearest on screen first, then nearest to the camera.
        static List<KeyValuePair<float, Dictionary<string, object>>> Hits(Vector2 point, float window, float far, string system)
        {
            var camera = Camera.main;
            if (!camera) throw new BridgeError("No main camera.");
            float aspect = camera.aspect;
            var hits = new List<KeyValuePair<float, Dictionary<string, object>>>();
            foreach (var s in Resources.FindObjectsOfTypeAll<VegetationSystemPro>().Where(s => s && s.gameObject.scene.IsValid() && s.isActiveAndEnabled))
            {
                if (system != null && PathOf(s.transform).IndexOf(system, StringComparison.OrdinalIgnoreCase) < 0) continue;
                var storage = s.PersistentVegetationStorage;
                if (!storage || !storage.PersistentVegetationStoragePackage) continue;
                var items = s.VegetationPackageProList.Where(p => p).SelectMany(p => p.VegetationInfoList).GroupBy(i => i.VegetationItemID).ToDictionary(g => g.Key, g => g.First());
                var heights = ModelHeights(s);
                Vector3 origin = s.VegetationSystemPosition;
                foreach (var cell in storage.PersistentVegetationStoragePackage.PersistentVegetationCellList)
                    foreach (var info in cell.PersistentVegetationInfoList)
                    {
                        VegetationItemInfoPro item;
                        if (!items.TryGetValue(info.VegetationItemID, out item)) continue;
                        float h; if (!heights.TryGetValue(info.VegetationItemID, out h)) h = 4f;
                        foreach (var i in info.VegetationItemList)
                        {
                            var foot = i.Position + origin;
                            float top = h * i.Scale.y;
                            var p0 = camera.WorldToViewportPoint(foot);
                            var p1 = camera.WorldToViewportPoint(foot + Vector3.up * top);
                            if (p0.z <= 0 || p0.z > far) continue;
                            var a2 = new Vector2(p0.x * aspect, p0.y); var b2 = new Vector2(p1.x * aspect, p1.y); var q = new Vector2(point.x * aspect, point.y);
                            var ab = b2 - a2;
                            float t = ab.sqrMagnitude > 1e-9f ? Mathf.Clamp01(Vector2.Dot(q - a2, ab) / ab.sqrMagnitude) : 0f;
                            float d = (a2 + t * ab - q).magnitude;
                            if (d > window) continue;
                            hits.Add(new KeyValuePair<float, Dictionary<string, object>>(d * 1000f + p0.z * 1e-4f, new Dictionary<string, object>
                            {
                                { "item", item.Name }, { "itemId", item.VegetationItemID }, { "type", item.VegetationType.ToString() }, { "system", PathOf(s.transform) },
                                { "position", V(foot) }, { "scale", V(i.Scale) }, { "rotation", Q(i.Rotation) }, { "heightM", Math.Round(top, 2) },
                                { "distance", Math.Round(p0.z, 1) }, { "screenDistance", Math.Round(d, 4) },
                            }));
                        }
                    }
            }
            return hits;
        }

        [BridgeCommand("veg.pick", "The placed vegetation instance at a point of the picture: by default the one under the mouse (mouse=true; the window must have it), else viewport u, v (0-1 from the bottom left; 0.5, 0.5 = the middle). Each instance is judged by its stem, foot to top, as seen: the nearest on screen wins, the nearer to the camera on a tie. Returns the best `limit` with item, id, position, scale, rotation, height, system.",
            args = "mouse=true, u, v, window=0.03 (of the picture's height), maxDistance=600, system (part of its path), limit=5")]
        static object Pick(BridgeArgs a)
        {
            Vector2 point;
            if (!a.Has("u") && a.Bool("mouse", true))
            {
                var m = Input.mousePosition;
                point = new Vector2(m.x / Screen.width, m.y / Screen.height);
            }
            else point = new Vector2((float)a.Number("u", 0.5), (float)a.Number("v", 0.5));
            var hits = Hits(point, (float)a.Number("window", 0.03), (float)a.Number("maxDistance", 600), a.String("system"));
            return new Dictionary<string, object>
            {
                { "point", new List<object> { Math.Round(point.x, 4), Math.Round(point.y, 4) } }, { "matches", hits.Count },
                { "instances", hits.OrderBy(h => h.Key).Take(a.Int("limit", 5)).Select(h => (object)h.Value).ToList() },
            };
        }
    }

    // The P key: marks the tree or bush under the mouse (EditCommands.PickAt) and draws a marker over it, so
    // "this one" can be named without coordinates (veg.picked; `bun run arborist -- edit <course> <op> --picked`).
    sealed class TreePicker : MonoBehaviour
    {
        internal static Dictionary<string, object> Marked;
        internal string system;
        string note;
        float noteUntil;
        GUIStyle style;

        void Update()
        {
            if (Input.GetKeyDown(KeyCode.Escape) && Marked != null) { Marked = null; Say("unmarked"); }
            if (!Input.GetKeyDown(KeyCode.P) || Typing()) return;
            var m = Input.mousePosition;
            try
            {
                var hit = EditCommands.PickAt(new Vector2(m.x / Screen.width, m.y / Screen.height), 0.03f, system);
                if (hit == null) { Say("nothing under the mouse"); return; }
                hit["when"] = DateTime.Now.ToString("HH:mm:ss");
                Marked = hit;
                Say("marked " + hit["item"]);
            }
            catch (Exception e) { Say(e.Message); }
        }

        // A text field has the keyboard: P is a letter then.
        static bool Typing()
        {
            var es = UnityEngine.EventSystems.EventSystem.current;
            var go = es ? es.currentSelectedGameObject : null;
            return go && go.GetComponent<UnityEngine.UI.InputField>() != null;
        }

        void Say(string text) { note = text; noteUntil = Time.unscaledTime + 3f; }

        void OnGUI()
        {
            if (style == null) style = new GUIStyle(GUI.skin.label) { fontSize = 15, fontStyle = FontStyle.Bold, alignment = TextAnchor.LowerCenter, normal = { textColor = new Color(1f, 0.85f, 0.2f) } };
            var marked = Marked;
            var camera = Camera.main;
            if (marked != null && camera)
            {
                var pos = (List<object>)marked["position"];
                var top = new Vector3(Convert.ToSingle(pos[0]), Convert.ToSingle(pos[1]), Convert.ToSingle(pos[2])) + Vector3.up * (Convert.ToSingle(marked["heightM"]) + 0.5f);
                var p = camera.WorldToScreenPoint(top);
                if (p.z > 0) GUI.Label(new Rect(p.x - 150, Screen.height - p.y - 40, 300, 40), "▼", style);
            }
            string line = Time.unscaledTime < noteUntil ? "GolfMap: " + note : marked != null ? "GolfMap: " + marked["item"] + " marked (P another, Esc none)" : null;
            if (line != null) GUI.Label(new Rect(Screen.width / 2 - 300, 8, 600, 24), line, style);
        }
    }
}
