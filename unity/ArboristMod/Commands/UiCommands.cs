// The app's own UI, for finding the way without a hand on the mouse: what is on screen (canvases
// are not in a camera's picture), the controls that can be pressed, a press, typed text.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;

namespace GolfMap.Bridge
{
    static class UiCommands
    {
        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return "/" + string.Join("/", parts.ToArray());
        }

        // Text and TextMeshPro alike: any component under the control with a string `text`.
        static string Label(GameObject go)
        {
            var texts = new List<string>();
            foreach (var c in go.GetComponentsInChildren<Component>(false))
            {
                if (!c || c is InputField) continue;
                var p = c.GetType().GetProperty("text");
                if (p == null || p.PropertyType != typeof(string) || !p.CanRead) continue;
                var s = p.GetValue(c, null) as string;
                if (!string.IsNullOrEmpty(s) && !texts.Contains(s.Trim())) texts.Add(s.Trim());
            }
            var label = string.Join(" | ", texts.ToArray()).Replace("\n", " ");
            return label.Length > 120 ? label.Substring(0, 120) : label;
        }

        static Selectable Find(BridgeArgs a)
        {
            string path = a.String("path"), label = a.String("label");
            if (path == null && label == null) throw new BridgeError("Give path or label.");
            var hits = Selectable.allSelectables.Where(s => s && s.isActiveAndEnabled &&
                (path != null ? PathOf(s.transform) == path : Label(s.gameObject).IndexOf(label, StringComparison.OrdinalIgnoreCase) >= 0)).ToList();
            if (path == null && hits.Count > 1)
            {
                var exact = hits.Where(s => string.Equals(Label(s.gameObject), label, StringComparison.OrdinalIgnoreCase)).ToList();
                if (exact.Count > 0) hits = exact;
            }
            int index = a.Int("index", 0);
            if (hits.Count == 0) throw new BridgeError("No active control matches.");
            if (index >= hits.Count) throw new BridgeError("Only " + hits.Count + " control(s) match.");
            if (hits.Count > 1 && !a.Has("index")) throw new BridgeError(hits.Count + " controls match; give index or path: " + string.Join("; ", hits.Take(8).Select(s => PathOf(s.transform)).ToArray()));
            return hits[index];
        }

        [BridgeCommand("ui", "The controls that can be pressed now (active buttons, toggles, dropdowns, input fields, sliders): path, kind, label, whether interactable. contains filters on path or label.",
            args = "contains, limit=150")]
        static object List(BridgeArgs a)
        {
            string contains = a.String("contains");
            var rows = new List<object>();
            foreach (var s in Selectable.allSelectables.Where(s => s && s.isActiveAndEnabled).OrderBy(s => PathOf(s.transform)))
            {
                string path = PathOf(s.transform), label = Label(s.gameObject);
                if (contains != null && path.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0 && label.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) continue;
                var row = new Dictionary<string, object> { { "path", path }, { "kind", s.GetType().Name }, { "label", label }, { "interactable", s.IsInteractable() } };
                var toggle = s as Toggle; if (toggle) row["on"] = toggle.isOn;
                var input = s as InputField; if (input) row["text"] = input.text;
                var drop = s as Dropdown; if (drop) { row["value"] = drop.value; row["options"] = drop.options.Take(40).Select(o => (object)o.text).ToList(); }
                rows.Add(row);
                if (rows.Count >= a.Int("limit", 150)) break;
            }
            return new Dictionary<string, object> { { "count", rows.Count }, { "controls", rows } };
        }

        [BridgeCommand("ui.click", "Press a control as a mouse click would (pointer click on the control, by path or by label). A dropdown takes value=<index> instead.",
            args = "path | label, index (when several match), value (dropdown option index)")]
        static object Click(BridgeArgs a)
        {
            var s = Find(a);
            if (!s.IsInteractable()) throw new BridgeError(PathOf(s.transform) + " is not interactable now.");
            var drop = s as Dropdown;
            if (drop && a.Has("value")) { drop.value = a.Int("value", 0); drop.RefreshShownValue(); }
            else
            {
                var data = new PointerEventData(EventSystem.current) { button = PointerEventData.InputButton.Left, position = RectTransformUtility.WorldToScreenPoint(null, s.transform.position) };
                ExecuteEvents.Execute(s.gameObject, data, ExecuteEvents.pointerEnterHandler);
                ExecuteEvents.Execute(s.gameObject, data, ExecuteEvents.pointerDownHandler);
                ExecuteEvents.Execute(s.gameObject, data, ExecuteEvents.pointerUpHandler);
                ExecuteEvents.Execute(s.gameObject, data, ExecuteEvents.pointerClickHandler);
            }
            return new Dictionary<string, object> { { "pressed", PathOf(s.transform) }, { "kind", s.GetType().Name }, { "label", Label(s.gameObject) } };
        }

        [BridgeCommand("ui.type", "Put text into an input field (by path or label) and fire its change and end-edit events.", args = "path | label, index, text (required)")]
        static object TypeText(BridgeArgs a)
        {
            var input = Find(a) as InputField;
            if (!input) throw new BridgeError("That control is not an input field.");
            input.text = a.String("text") ?? "";
            input.onEndEdit.Invoke(input.text);
            return new Dictionary<string, object> { { "field", PathOf(input.transform) }, { "text", input.text } };
        }

        static IEnumerator Grab(Action<Texture2D> done)
        {
            yield return new WaitForEndOfFrame();
            var shot = new Texture2D(UnityEngine.Screen.width, UnityEngine.Screen.height, TextureFormat.RGB24, false);
            shot.ReadPixels(new Rect(0, 0, shot.width, shot.height), 0, 0);
            shot.Apply();
            done(shot);
        }

        [BridgeCommand("screen", "The window as it is shown, UI included, as a PNG (path in the result): the frame's own pixels at its end, so the window must not be minimised. scale < 1 shrinks the file.",
            args = "scale=1")]
        static IEnumerator Screen(BridgeArgs a)
        {
            // The bridge steps a command once per Update and takes the first thing it yields as
            // the result, so the wait for the frame's end runs as a coroutine of its own.
            Texture2D shot = null;
            PlayerBridge.Run(Grab(t => shot = t));
            for (int i = 0; i < 300 && shot == null; i++) yield return null;
            if (shot == null) throw new BridgeError("No frame was drawn (is the window minimised?).");
            int w = shot.width, h = shot.height;
            float scale = Mathf.Clamp((float)a.Number("scale", 1), 0.1f, 1f);
            Texture2D result = shot;
            if (scale < 1f)
            {
                var rt = RenderTexture.GetTemporary(Mathf.RoundToInt(w * scale), Mathf.RoundToInt(h * scale), 0);
                Graphics.Blit(shot, rt);
                var old = RenderTexture.active; RenderTexture.active = rt;
                result = new Texture2D(rt.width, rt.height, TextureFormat.RGB24, false);
                result.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
                result.Apply();
                RenderTexture.active = old; RenderTexture.ReleaseTemporary(rt);
            }
            var folder = Path.Combine(Path.GetTempPath(), "GolfMapPlayerBridge");
            Directory.CreateDirectory(folder);
            string file = Path.Combine(folder, "screen-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png").Replace('\\', '/');
            File.WriteAllBytes(file, result.EncodeToPNG());
            if (result != shot) UnityEngine.Object.Destroy(result);
            UnityEngine.Object.Destroy(shot);
            yield return new Dictionary<string, object> { { "file", file }, { "width", w }, { "height", h } };
        }
    }
}
