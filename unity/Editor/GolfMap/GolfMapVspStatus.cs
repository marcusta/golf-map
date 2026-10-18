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

        // The first LOD's mesh as VSP draws it: height above the prefab's origin and the wider of its
        // horizontal extents, in the prefab's own metres. The same measure is taken of Arborist's
        // models (unity/ArboristMod), so a planted tree keeps its size when the model changes.
        static Vector2 ModelSize(GameObject prefab)
        {
            Renderer renderer = null;
            var group = prefab.GetComponentInChildren<LODGroup>(true);
            if (group) foreach (var lod in group.GetLODs()) { renderer = lod.renderers.FirstOrDefault(r => r && !(r is BillboardRenderer)); if (renderer) break; }
            if (!renderer) renderer = prefab.GetComponentsInChildren<MeshRenderer>(true).FirstOrDefault();
            var filter = renderer ? renderer.GetComponent<MeshFilter>() : null;
            if (!filter || !filter.sharedMesh) return Vector2.zero;
            var toRoot = prefab.transform.worldToLocalMatrix * renderer.transform.localToWorldMatrix;
            var b = filter.sharedMesh.bounds;
            float top = float.NegativeInfinity, half = 0;
            for (int i = 0; i < 8; i++)
            {
                var corner = toRoot.MultiplyPoint3x4(b.center + Vector3.Scale(b.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1)));
                top = Mathf.Max(top, corner.y);
                half = Mathf.Max(half, Mathf.Max(Mathf.Abs(corner.x), Mathf.Abs(corner.z)));
            }
            return new Vector2(2 * half, top);
        }

        // The colours VSP's shader controller puts on the item's materials (NM trees: HealtyColor,
        // DryColor, BarkColor; SpeedTree: FoliageTintColor, BarkTintColor), as #rrggbb: the look
        // approved in Unity, for the same models elsewhere.
        static Dictionary<string, object> LeafColours(VegetationItemInfoPro item)
        {
            var colours = new Dictionary<string, object>();
            var settings = item.ShaderControllerSettings;
            if (settings == null || settings.ControlerPropertyList == null) return colours;
            foreach (var p in settings.ControlerPropertyList)
            {
                if (p.PropertyName != "HealtyColor" && p.PropertyName != "DryColor" && p.PropertyName != "BarkColor" && p.PropertyName != "FoliageTintColor" && p.PropertyName != "BarkTintColor") continue;
                colours[p.PropertyName] = "#" + ColorUtility.ToHtmlStringRGB(p.ColorValue).ToLowerInvariant();
            }
            return colours;
        }

        [BridgeCommand("golfmap.trees.dump", "Write every planted tree of the scene's GolfMap storages to a JSON file (golfmap-planted-trees-v1), for pipeline/arborist.py trees: per tree catalogue item its prefab, model size (widthM, heightM of the first LOD) and its instances as [x, y, z, scaleX, scaleY, scaleZ, qx, qy, qz, qw] in world metres. Reads the storage assets, so switched-off systems and storages are included.",
            args = "file (required, absolute path)")]
        static object TreesDump(BridgeArgs a)
        {
            string file = a.Require("file");
            var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            var culture = System.Globalization.CultureInfo.InvariantCulture;
            var text = new System.Text.StringBuilder("{\"format\":\"golfmap-planted-trees-v1\",\"items\":[");
            var report = new List<object>();
            bool firstItem = true;
            foreach (var s in Resources.FindObjectsOfTypeAll<VegetationSystemPro>().Where(x => x && x.gameObject.scene == scene && !EditorUtility.IsPersistent(x)))
            {
                var storage = s.PersistentVegetationStorage;
                var package = storage ? storage.PersistentVegetationStoragePackage : null;
                if (!package) continue;
                var origin = s.VegetationSystemPosition;
                var trimmed = GolfMapVspRig.Trimmed(package);   // taken out of the storage for a hybrid course, still the course's trees
                foreach (var catalog in s.VegetationPackageProList.Where(GolfMapTreePlanter.IsImportedCatalogue))
                {
                    long count = 0;
                    foreach (var item in catalog.VegetationInfoList)
                    {
                        var rows = package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList)
                            .Where(i => i.VegetationItemID == item.VegetationItemID).SelectMany(i => i.VegetationItemList).ToList();
                        if (trimmed.ContainsKey(item.VegetationItemID)) rows.AddRange(trimmed[item.VegetationItemID]);
                        if (rows.Count == 0 || !item.VegetationPrefab) continue;
                        var size = ModelSize(item.VegetationPrefab);
                        if (!firstItem) text.Append(',');
                        firstItem = false;
                        text.Append("\n{\"catalogue\":").Append(GolfMap.Bridge.BridgeJson.Write(catalog.PackageName))
                            .Append(",\"name\":").Append(GolfMap.Bridge.BridgeJson.Write(item.Name))
                            .Append(",\"prefab\":").Append(GolfMap.Bridge.BridgeJson.Write(AssetDatabase.GetAssetPath(item.VegetationPrefab)))
                            .Append(",\"widthM\":").Append(size.x.ToString("R", culture)).Append(",\"heightM\":").Append(size.y.ToString("R", culture))
                            .Append(",\"colours\":").Append(GolfMap.Bridge.BridgeJson.Write(LeafColours(item)))
                            .Append(",\"instances\":[");
                        for (int i = 0; i < rows.Count; i++)
                        {
                            var r = rows[i]; var p = r.Position + origin;
                            if (i > 0) text.Append(',');
                            text.Append('[').Append(p.x.ToString("0.###", culture)).Append(',').Append(p.y.ToString("0.###", culture)).Append(',').Append(p.z.ToString("0.###", culture))
                                .Append(',').Append(r.Scale.x.ToString("0.####", culture)).Append(',').Append(r.Scale.y.ToString("0.####", culture)).Append(',').Append(r.Scale.z.ToString("0.####", culture))
                                .Append(',').Append(r.Rotation.x.ToString("0.#####", culture)).Append(',').Append(r.Rotation.y.ToString("0.#####", culture))
                                .Append(',').Append(r.Rotation.z.ToString("0.#####", culture)).Append(',').Append(r.Rotation.w.ToString("0.#####", culture)).Append(']');
                        }
                        text.Append("]}");
                        count += rows.Count;
                    }
                    report.Add(new Dictionary<string, object> { { "catalogue", catalog.PackageName }, { "storage", AssetDatabase.GetAssetPath(package) }, { "trees", count } });
                }
            }
            text.Append("\n]}\n");
            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file));
            System.IO.File.WriteAllText(file, text.ToString());
            return new Dictionary<string, object> { { "file", file }, { "bytes", text.Length }, { "catalogues", report } };
        }

        [BridgeCommand("golfmap.vsp.trees.stored", "The trees the course's own VSP holds: the instances stored in the scene's GolfMap storages for the planted tree catalogues (trees golfmap.vsp.trees.trim took out are not stored). Without near: the count per catalogue item (only items with instances). near=[x, z] with radiusM: every stored tree within that many metres of the point, with its item and world position.",
            args = "near ([x, z] world metres; omit for the counts), radiusM=1")]
        static object TreesStored(BridgeArgs a)
        {
            var near = a.List("near");
            if (near != null && (near.Count != 2 || !near.All(o => o is double))) throw new System.InvalidOperationException("near must be [x, z].");
            double radius = a.Number("radiusM", 1);
            var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            var counts = new SortedDictionary<string, long>(System.StringComparer.Ordinal);
            var instances = new List<object>();
            foreach (var s in Resources.FindObjectsOfTypeAll<VegetationSystemPro>().Where(x => x && x.gameObject.scene == scene && !EditorUtility.IsPersistent(x)))
            {
                var storage = s.PersistentVegetationStorage;
                var package = storage ? storage.PersistentVegetationStoragePackage : null;
                if (!package || !GolfMapTreePlanter.IsGolfMapStorage(storage)) continue;
                var origin = s.VegetationSystemPosition;
                var items = s.VegetationPackageProList.Where(GolfMapTreePlanter.IsImportedCatalogue).SelectMany(c => c.VegetationInfoList).GroupBy(i => i.VegetationItemID).ToDictionary(g => g.Key, g => g.First().Name);
                foreach (var info in package.PersistentVegetationCellList.SelectMany(c => c.PersistentVegetationInfoList))
                {
                    string name;
                    if (!items.TryGetValue(info.VegetationItemID, out name) || info.VegetationItemList.Count == 0) continue;
                    if (near == null) { long n; counts.TryGetValue(name, out n); counts[name] = n + info.VegetationItemList.Count; continue; }
                    foreach (var it in info.VegetationItemList)
                    {
                        var p = it.Position + origin;
                        double dx = p.x - (double)near[0], dz = p.z - (double)near[1];
                        if (dx * dx + dz * dz <= radius * radius)
                            instances.Add(new Dictionary<string, object> { { "item", name }, { "x", (double)p.x }, { "y", (double)p.y }, { "z", (double)p.z } });
                    }
                }
            }
            if (near != null) return new Dictionary<string, object> { { "near", near }, { "radiusM", radius }, { "instances", instances } };
            return new Dictionary<string, object> { { "items", counts.ToDictionary(kv => kv.Key, kv => (object)kv.Value) }, { "total", counts.Values.Sum() } };
        }

        [BridgeCommand("golfmap.trees.colliders", "Tree colliders in VSP: per tree item of the scene's systems its collider type and what its prefab carries (capsule/sphere/mesh colliders, their physic materials; GSPro reads bounce off those). enable=true sets every tree item to From Prefab, so VSP's collider system builds the prefab's own colliders; the tree planter does the same on every plant. Trees whose prefab has no collider are listed under noCollider. Writes the package assets, does not save the scene.",
            args = "enable=false")]
        static object TreeColliders(BridgeArgs a)
        {
            bool enable = a.Bool("enable", false);
            var result = new List<object>();
            foreach (var s in Object.FindObjectsOfType<VegetationSystemPro>())
            {
                var trees = new List<object>();
                var none = new List<object>();
                int changed = 0;
                foreach (var p in s.VegetationPackageProList.Where(p => p))
                {
                    foreach (var i in p.VegetationInfoList.Where(i => i.VegetationType == VegetationType.Tree))
                    {
                        var colliders = i.VegetationPrefab ? i.VegetationPrefab.GetComponentsInChildren<Collider>(true) : new Collider[0];
                        if (colliders.Length == 0) none.Add(i.Name);
                        var was = i.ColliderType;
                        if (enable && was != ColliderType.FromPrefab) { i.ColliderType = ColliderType.FromPrefab; EditorUtility.SetDirty(p); changed++; }
                        trees.Add(new Dictionary<string, object>
                        {
                            { "name", i.Name }, { "package", p.PackageName }, { "colliderType", i.ColliderType.ToString() }, { "was", was.ToString() },
                            { "prefabColliders", colliders.Select(c => (object)(c.GetType().Name.Replace("Collider", "") + (c.enabled ? "" : " (off)")
                                + ":" + (c.sharedMaterial ? c.sharedMaterial.name : "no physic material"))).ToList() },
                        });
                    }
                }
                if (changed > 0) { AssetDatabase.SaveAssets(); s.RefreshVegetationSystem(); }
                result.Add(new Dictionary<string, object>
                {
                    { "system", s.name }, { "colliderSystem", Object.FindObjectsOfType<AwesomeTechnologies.ColliderSystem.ColliderSystemPro>().Any(c => c.VegetationSystemPro == s) },
                    { "changed", changed }, { "noCollider", none }, { "trees", trees },
                });
            }
            return result;
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
