// One course's settings: where its files live and how to find its scene objects.
//
// The asset's own folder is the course folder (Assets/GolfMap/<Course>/): the
// palette, the fallback trees file, VSP storage, catalogues and zone masks all
// live beside it, so moving or copying the folder moves the course. Every
// GolfMap tool resolves paths through the active course (GolfMapCourses.cs,
// Editor folder) instead of naming a course in code.
//
// Runtime folder on purpose: GolfMapTrees references it from the scene.
using UnityEngine;

namespace GolfMap
{
    public class GolfMapCourse : ScriptableObject
    {
        public const string AssetFileName = "Course.asset";

        [Tooltip("Display name; also prefixes report files under GolfMapSpelunk/.")]
        public string courseName = "";
        [Tooltip("Scene this course is built in. Empty: any scene.")]
        public string sceneName = "";

        [Header("Files in the course folder")]
        public string paletteFile = "palette.json";
        [Tooltip("Survey used when the export folder has no trees file.")]
        public string fallbackTreesFile = "";

        [Header("Pipeline export")]
        [Tooltip("Folder the pipeline exports into. Absolute, or relative to the Unity project's Assets folder.")]
        public string exportFolder = "";
        [Tooltip("File name prefix of the exports: <prefix>-inner-trees.json, <prefix>-outer-zones.json ...")]
        public string exportPrefix = "";

        [Header("Course meshes (OPCD FBX from Blender)")]
        [Tooltip("Folder the Blender FBX export writes into, relative to the Unity project's Assets folder.")]
        public string meshFolder = "fbx";
        [Tooltip("Scene object the course meshes sit under; GolfMap > Meshes > Sync adds new FBX there.")]
        public string meshParent = "Meshes";

        [Header("Scene")]
        public string innerTerrainName = "Terrain (Inner)";
        [Tooltip("TerrainData asset name of the inner terrain, matched when the object was renamed.")]
        public string innerTerrainData = "";
        public string outerTerrainName = "Plot (Outer)";
        [Tooltip("TerrainData asset name of the outer terrain, matched when the object was renamed.")]
        public string outerTerrainData = "";
    }
}
