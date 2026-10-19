// Switch one component of one scene object on or off, Undo-able, without
// deleting it: e.g. the sun's VolumetricLight (OPCD's haze) while comparing
// colours with the haze out of the picture, then back on.
using System.Collections.Generic;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace GolfMap.Editor
{
    static class GolfMapComponentToggle
    {
        [BridgeCommand("golfmap.component.enabled", "Report, or set, the enabled flag of one component (Behaviour or Renderer) on the scene object at path, found by type name. With enabled=true/false it is set through Undo (Ctrl+Z puts it back) and the scene is marked dirty; nothing is deleted. Answers with the flag before and after.",
            args = "path (e.g. /Directional Light), component (type name, e.g. VolumetricLight), enabled (omit to only report), " + GolfMapSceneSave.Arg)]
        static object Enabled(BridgeArgs a)
        {
            var path = a.String("path");
            var type = a.String("component");
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(type)) throw new BridgeError("path and component are required.");
            var go = GameObject.Find(path);
            if (go == null) throw new BridgeError("No scene object at " + path + ".");
            var component = go.GetComponents<Component>().FirstOrDefault(c => c && c.GetType().Name == type);
            if (component == null) throw new BridgeError(path + " has no " + type + ".");
            bool before = IsEnabled(component);
            var result = new Dictionary<string, object> { { "path", path }, { "component", type }, { "before", before } };
            if (!a.Has("enabled"))
            {
                result["after"] = before;
                result["dryRun"] = true;
                return result;
            }
            bool want = a.Bool("enabled", before);
            if (want != before)
            {
                Undo.RecordObject(component, (want ? "Enable " : "Disable ") + type);
                SetEnabled(component, want);
                EditorUtility.SetDirty(component);
                EditorSceneManager.MarkSceneDirty(go.scene);
            }
            result["after"] = IsEnabled(component);
            return result;
        }

        static bool IsEnabled(Component c)
        {
            var behaviour = c as Behaviour;
            if (behaviour != null) return behaviour.enabled;
            var renderer = c as Renderer;
            if (renderer != null) return renderer.enabled;
            throw new BridgeError(c.GetType().Name + " has no enabled flag.");
        }

        static void SetEnabled(Component c, bool on)
        {
            var behaviour = c as Behaviour;
            if (behaviour != null) { behaviour.enabled = on; return; }
            var renderer = c as Renderer;
            if (renderer != null) { renderer.enabled = on; return; }
            throw new BridgeError(c.GetType().Name + " has no enabled flag.");
        }
    }
}
