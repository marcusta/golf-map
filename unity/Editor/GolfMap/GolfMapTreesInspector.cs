// Inspector for the GolfMap Trees object (Runtime/GolfMap/GolfMapTrees.cs).
//
// The object carries an inner and an outer component; this Inspector belongs to the inner
// one and shows both as the Inner | Outer panels (the outer component is hidden from the
// Inspector). Thin: it fetches the open panel's planter (GolfMapTreePlanter, a hidden
// ScriptableObject that outlives Inspector instances) and forwards the Inspector and
// Scene-view callbacks to it. Everything else is in GolfMapTreePlanter*.cs.
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    [CustomEditor(typeof(GolfMapTrees))]
    public class GolfMapTreesInspector : UnityEditor.Editor
    {
        GolfMapTreePlanter planter;
        static readonly string[] Panels = { "Inner  (course area)", "Outer  (surrounding plot)", "Palette  (whole course)" };
        // The palette is the course's, shared by both areas, so it is a panel of its own. Which area
        // is open is saved with the scene; that the palette is open is editor state only.
        static bool showPalette;

        GolfMapTrees Host { get { return (GolfMapTrees)target; } }

        void Bind()
        {
            var component = Host.role == GolfMapTrees.Role.Inner ? GolfMapTreePlanter.Active(Host) : Host;
            if (planter && planter.Component == component) return;
            Release();
            planter = GolfMapTreePlanter.For(component);
            planter.inspector = this;
            Tools.hidden = planter.Editing;
        }

        void Release()
        {
            if (planter && planter.inspector == this) planter.inspector = null;
            planter = null;
            Tools.hidden = false;
        }

        void OnEnable() { if (target) Bind(); }
        void OnDisable() { Release(); }

        public override void OnInspectorGUI()
        {
            if (targets.Length > 1) { EditorGUILayout.HelpBox("Select one GolfMap Trees object at a time.", MessageType.Info); return; }
            Bind();
            if (Host.role == GolfMapTrees.Role.Inner)
            {
                // A running tree-editing session belongs to its panel: finish it before switching.
                using (new EditorGUI.DisabledScope(planter.Editing))
                {
                    int current = showPalette ? 2 : Host.showOuter ? 1 : 0;
                    int open = GUILayout.Toolbar(current, Panels, GUILayout.Height(24));
                    bool sameArea = (open == 1) == Host.showOuter;
                    if (open != current && (open == 2 || sameArea)) { showPalette = open == 2; Repaint(); GUIUtility.ExitGUI(); }
                    if (open != current)
                    {
                        showPalette = false;
                        Undo.RecordObject(Host, "Switch GolfMap Trees panel");
                        Host.showOuter = open == 1;
                        EditorUtility.SetDirty(Host);
                        Bind(); Repaint();
                        GUIUtility.ExitGUI();
                    }
                }
            }
            if (showPalette && Host.role == GolfMapTrees.Role.Inner)
            {
                var inner = GolfMapTreePlanter.For(Host);
                inner.inspector = this;
                inner.OnPaletteGUI(new[] { inner, GolfMapTreePlanter.For(GolfMapTreePlanter.Outer(Host)) });
                return;
            }
            planter.OnGUI();
        }

        void OnSceneGUI()
        {
            if (planter) planter.OnSceneGUI();
        }
    }
}
