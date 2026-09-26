// Planting setup for one area of the course, saved with the scene.
//
// The scene's one "GolfMap Trees" object (GolfMap > Tree Planter creates it) carries two
// of these: the inner component, and the outer one hidden from the Inspector. The inner
// component's Inspector shows both as the Inner and Outer panels, each with its own
// settings. That Inspector (GolfMapTreesInspector.cs, Editor folder) loads
// the survey, checks alignment, plants and hosts the Scene-view tree editor;
// the logic lives in GolfMapTreePlanter*.cs. This component only carries the
// settings, so a built course ships an empty component and nothing else.
//
// Runtime folder on purpose: a MonoBehaviour must live outside Editor folders
// to be saved in a scene. Mirror to Assets/GolfMap/Runtime/ in the course project.
using System.Collections.Generic;
using UnityEngine;
using AwesomeTechnologies.Vegetation.PersistentStorage;

namespace GolfMap
{
    [AddComponentMenu("")]   // created in pairs by GolfMap > Tree Planter, never by hand
    public class GolfMapTrees : MonoBehaviour
    {
        // PersistentStorage (Vegetation Studio Pro) is the mode the tree editor works with.
        public enum Mode { TerrainInstances, GameObjects, PersistentStorage }

        // Which of the course's two areas this component plants. The role fixes the terrain,
        // the trees file, the storage and billboards-only, so one area's setup can never be
        // pointed at the other's terrain or storage by hand.
        public enum Role { Inner, Outer }

        [Header("Input")]
        public Role role = Role.Inner;
        public bool roleAssigned;                    // false: a component saved before roles existed
        public bool showOuter;                       // inner component only: the panel its Inspector has open
        public GolfMapCourse course;                 // empty: the scene's active course
        public bool customFile;                      // false: the course's export for this role
        public string filePath = "";                 // unity-trees-v1 JSON (absolute or project-relative)
        public Terrain terrain;                      // resolved from the course and the role
        public bool useBiome = true;
        public string biomePath = "";                // empty: the course's palette
        public bool includeReviewMatches = true;

        [Header("Prefabs by crown kind (biome off)")]
        public List<GameObject> broadleafPrefabs = new List<GameObject>();
        public List<GameObject> coniferPrefabs = new List<GameObject>();
        public List<GameObject> unknownPrefabs = new List<GameObject>();
        public List<GameObject> bushPrefabs = new List<GameObject>();

        [Header("Placement")]
        public Mode mode = Mode.PersistentStorage;
        public float minScale = 0.5f;
        public float maxScale = 2.0f;
        public float minHeightM = 0f;
        public bool scaleWidth = true;
        public int seed = 1;
        public float alignmentToleranceM = 1.0f;
        public bool ignoreAlignment = false;
        // Outer-plot trees are always far from the player, so they go in as
        // billboards only; the inner terrain's footprint is excluded.
        [HideInInspector] public bool forceBillboards = false;   // legacy: read once to assign the role
        public Terrain innerExclusion;               // outer role: resolved from the course

        [Header("Persistent storage")]
        public PersistentVegetationStorage storage;
        public List<GameObject> groundMeshes = new List<GameObject>();   // course meshes probed for ground height
        public float outerBillboardDistance = 10000;
        public bool regenerateBillboards = true;
        // Grade baked into the outer atlas. A billboard is flat albedo x tint, without the AO and
        // self-shadowing a mesh crown gets, so at 1 the outer reads brighter than the inner.
        public float billboardBrightness = 0.45f;
        public float billboardSaturation = 0.85f;
        public string lastPlantingBackup;

        [Header("Tree editor")]
        public bool showStems = true;
        public bool addMode;
        public string addSpecies = "";
        public float addHeight = 8, addRadius = 2.5f;
    }
}
