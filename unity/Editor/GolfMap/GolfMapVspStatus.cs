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

        // VSP completes the jobs one Update schedules in the next LateUpdate. When
        // that pairing breaks (an asset refresh or domain event between the two), the
        // jobs' lists stay claimed and every later frame and every GolfMap command that
        // refreshes VSP throws "The previously scheduled job ... You must call
        // JobHandle.Complete()". Disabling a system disposes its cells, cameras and
        // lists; enabling it builds them fresh.
        [BridgeCommand("golfmap.vsp.reset", "Disable and re-enable every VegetationSystemPro (fresh cells, cameras and job lists), then refresh it. For VSP stuck throwing 'The previously scheduled job ... JobHandle.Complete()' on every frame.")]
        static object Reset()
        {
            return Object.FindObjectsOfType<VegetationSystemPro>().Select(s =>
            {
                string disposeError = null;
                try { s.enabled = false; }
                catch (System.Exception e) { disposeError = e.GetType().Name + ": " + e.Message; }
                s.enabled = true;
                s.RefreshVegetationSystem();
                return (object)new Dictionary<string, object>
                {
                    { "name", s.name }, { "initDone", s.InitDone }, { "cells", s.VegetationCellList.Count }, { "disposeError", disposeError },
                };
            }).ToList();
        }
    }
}
