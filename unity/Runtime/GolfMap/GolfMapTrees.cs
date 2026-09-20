// Planting setup for one terrain, saved with the scene.
//
// Add one "GolfMap Trees" object per terrain (GolfMap > Tree Planter creates
// the first). Its Inspector (GolfMapTreesInspector.cs, Editor folder) loads
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
    [AddComponentMenu("GolfMap/Trees")]
    [DisallowMultipleComponent]
    public class GolfMapTrees : MonoBehaviour
    {
        // PersistentStorage (Vegetation Studio Pro) is the mode the tree editor works with.
        public enum Mode { TerrainInstances, GameObjects, PersistentStorage }

        [Header("Input")]
        public GolfMapCourse course;                 // empty: the scene's active course
        public string filePath = "";                 // unity-trees-v1 JSON (absolute or project-relative)
        public Terrain terrain;
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
        public bool clearExisting = false;
        public int seed = 1;
        public float alignmentToleranceM = 1.0f;
        public bool ignoreAlignment = false;
        // Outer-plot trees are always far from the player, so they go in as
        // billboards only; the inner terrain's footprint is excluded.
        public bool forceBillboards = false;
        public Terrain innerExclusion;

        [Header("Persistent storage")]
        public PersistentVegetationStorage storage;
        public List<GameObject> groundMeshes = new List<GameObject>();   // course meshes probed for ground height
        public float outerBillboardDistance = 10000;
        public bool regenerateBillboards = true;
        public string lastPlantingBackup;

        [Header("Tree editor")]
        public bool showStems = true;
        public bool addMode;
        public string addSpecies = "";
        public float addHeight = 8, addRadius = 2.5f;
    }
}
