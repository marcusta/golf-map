// Inspector for the GolfMap Trees component (Runtime/GolfMap/GolfMapTrees.cs).
//
// Thin: it fetches the component's planter (GolfMapTreePlanter, a hidden
// ScriptableObject that outlives Inspector instances) and forwards the
// Inspector and Scene-view callbacks to it. Everything else is in
// GolfMapTreePlanter*.cs.
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    [CustomEditor(typeof(GolfMapTrees))]
    public class GolfMapTreesInspector : UnityEditor.Editor
    {
        GolfMapTreePlanter planter;

        void OnEnable()
        {
            planter = GolfMapTreePlanter.For((GolfMapTrees)target);
            planter.inspector = this;
            Tools.hidden = planter.Editing;
        }

        void OnDisable()
        {
            if (planter && planter.inspector == this) planter.inspector = null;
            Tools.hidden = false;
        }

        public override void OnInspectorGUI()
        {
            if (targets.Length > 1) { EditorGUILayout.HelpBox("Select one GolfMap Trees object at a time.", MessageType.Info); return; }
            if (!planter || planter.Component != target) OnEnable();
            planter.OnGUI();
        }

        void OnSceneGUI()
        {
            if (planter && planter.Component == target) planter.OnSceneGUI();
        }
    }
}
