// Bridge diagnostics for Vegetation Studio Pro: what each system in the open
// scene holds and whether it is in a state to draw, for when a screenshot shows
// no vegetation and the question is "is VSP drawing at all, and why not".
using System.Collections.Generic;
using System.Linq;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    static class GolfMapVspStatus
    {
        [BridgeCommand("golfmap.vsp", "Every VegetationSystemPro in the open scenes: init state, cells, cameras (bound camera, culling state, visible cells), packages and items (type, spawning, mask rules), stored instances.")]
        static object Status()
        {
            return Object.FindObjectsOfType<VegetationSystemPro>().Select(s =>
            {
                var storage = s.PersistentVegetationStorage;
                var storagePackage = storage ? storage.PersistentVegetationStoragePackage : null;
                long instances = storagePackage == null ? 0 : storagePackage.PersistentVegetationCellList
                    .SelectMany(c => c.PersistentVegetationInfoList).Sum(i => (long)i.VegetationItemList.Count);
                return (object)new Dictionary<string, object>
                {
                    { "name", s.name },
                    { "active", s.isActiveAndEnabled },
                    { "initDone", s.InitDone },
                    { "cells", s.VegetationCellList.Count },
                    { "bounds", s.VegetationSystemBounds },
                    { "terrains", s.VegetationStudioTerrainObjectList.Where(t => t).Select(t => (object)t.name).ToList() },
                    { "plantDistance", s.VegetationSettings.PlantDistance },
                    { "grassDensity", s.VegetationSettings.GrassDensity },
                    { "storage", storagePackage ? AssetDatabase.GetAssetPath(storagePackage) : null },
                    { "storedInstances", instances },
                    { "cameras", s.VegetationStudioCameraList.Select(c => (object)new Dictionary<string, object>
                        {
                            { "type", c.VegetationStudioCameraType.ToString() },
                            { "enabled", c.Enabled },
                            { "camera", c.SelectedCamera ? c.SelectedCamera.name : null },
                            { "cullingGroup", c.JobCullingGroup != null },
                            { "renderLists", c.VegetationStudioCameraRenderList == null ? -1 : c.VegetationStudioCameraRenderList.Count },
                            { "potentialVisibleCells", c.PotentialVisibleCellList == null ? -1 : c.PotentialVisibleCellList.Count },
                        }).ToList() },
                    { "packages", s.VegetationPackageProList.Where(p => p).Select(p => (object)new Dictionary<string, object>
                        {
                            { "name", p.PackageName },
                            { "biome", p.BiomeType.ToString() },
                            { "asset", AssetDatabase.GetAssetPath(p) },
                            { "items", p.VegetationInfoList.Count },
                            { "spawning", p.VegetationInfoList.Count(i => i.EnableRuntimeSpawn) },
                            { "grass", p.VegetationInfoList.Where(i => i.VegetationType == VegetationType.Grass).Select(i => (object)new Dictionary<string, object>
                                {
                                    { "name", i.Name }, { "spawning", i.EnableRuntimeSpawn }, { "shader", i.ShaderName },
                                    { "renderMode", i.VegetationRenderMode.ToString() },
                                    { "include", i.TextureMaskIncludeRuleList.Count }, { "density", i.TextureMaskDensityRuleList.Count },
                                }).ToList() },
                        }).ToList() },
                };
            }).ToList();
        }
    }
}
