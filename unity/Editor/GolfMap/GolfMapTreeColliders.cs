// Unity 2018.2 / C# 6. GSPro colliders for tree prefabs that ship without them. VSP's collider system (collider type
// From Prefab) copies the capsules a tree's prefab carries, and GSPro reads bounce off their physic materials: the
// trunk on GSPwood, the crown on GSPleaves. A tree that lacks one gets it here, sized from its LOD0 bounds, on a child
// object ('GolfMap Colliders') of the prefab. A model (FBX) cannot hold components, so it gets a prefab of its own
// under <course>/TreeColliders/ and its catalogue items are pointed at that: same item id, the planted trees stay.
// The palette keeps naming the model; the planter plants its collider prefab (Planted).
using System;
using System.Collections.Generic;
using System.Linq;
using AwesomeTechnologies.VegetationSystem;
using GolfMap.Bridge;
using UnityEditor;
using UnityEngine;

namespace GolfMap.Editor
{
    static class GolfMapTreeColliders
    {
        const string Child = "GolfMap Colliders";
        const string FolderName = "TreeColliders";

        // What the planter puts in the catalogue for a palette asset: a model's collider prefab when it has one.
        public static GameObject Planted(GolfMapCourse course, GameObject prefab)
        {
            if (PrefabUtility.GetPrefabType(prefab) != PrefabType.ModelPrefab) return prefab;
            var own = AssetDatabase.LoadAssetAtPath<GameObject>(OwnPath(course, prefab));
            return own ? own : prefab;
        }

        static string OwnPath(GolfMapCourse course, GameObject model)
        {
            return GolfMapCourses.Folder(course) + FolderName + "/" + model.name + ".prefab";
        }

        [BridgeCommand("golfmap.trees.colliders.fit", "Give tree prefabs the GSPro colliders they lack: a trunk capsule on GSPwood and a crown capsule on GSPleaves, sized from the tree's LOD0 bounds, on a child 'GolfMap Colliders'. A trunk capsule without a physic material gets GSPwood. Colliders a prefab already has are kept. A model (FBX) gets a prefab of its own under <course>/TreeColliders/ and its catalogue items point at it (same item id: planted trees stay). Sets the items to From Prefab. Writes prefabs and package assets, does not save the scene.",
            args = "only (tree item names or parts, comma-separated; required), dryRun=false, crownFrom=0.3 (where the crown starts, as a part of the tree's height), crownRadius=0.3 (x the crown's width), trunkRadius=0.015 (x the height, kept within 0.1-0.4 m)")]
        static object Fit(BridgeArgs a)
        {
            var only = a.Require("only").Split(',').Select(p => p.Trim()).Where(p => p.Length > 0).ToArray();
            bool dryRun = a.Bool("dryRun", false);
            float crownFrom = (float)a.Number("crownFrom", 0.3), crownRadius = (float)a.Number("crownRadius", 0.3), trunkRadius = (float)a.Number("trunkRadius", 0.015);
            var course = GolfMapCourses.Require();
            var wood = Physic("GSPwood");
            var leaves = Physic("GSPleaves");

            var done = new Dictionary<GameObject, GameObject>();   // prefab -> what its items draw now
            var report = new List<object>();
            var systems = UnityEngine.Object.FindObjectsOfType<VegetationSystemPro>();
            foreach (var s in systems)
                foreach (var p in s.VegetationPackageProList.Where(p => p))
                    foreach (var i in p.VegetationInfoList.Where(i => i.VegetationType == VegetationType.Tree && i.VegetationPrefab))
                    {
                        if (!only.Any(o => i.Name.IndexOf(o, StringComparison.OrdinalIgnoreCase) >= 0)) continue;
                        var prefab = i.VegetationPrefab;
                        GameObject now;
                        if (!done.TryGetValue(prefab, out now))
                        {
                            var row = new Dictionary<string, object> { { "tree", i.Name }, { "prefab", AssetDatabase.GetAssetPath(prefab) } };
                            now = done[prefab] = FitPrefab(course, prefab, wood, leaves, crownFrom, crownRadius, trunkRadius, dryRun, row);
                            report.Add(row);
                        }
                        if (dryRun) continue;
                        if (i.VegetationPrefab != now || i.ColliderType != ColliderType.FromPrefab)
                        {
                            i.VegetationPrefab = now;
                            i.ColliderType = ColliderType.FromPrefab;
                            EditorUtility.SetDirty(p);
                        }
                    }
            if (!dryRun)
            {
                AssetDatabase.SaveAssets();
                foreach (var s in systems) s.RefreshVegetationSystem();
            }
            return new Dictionary<string, object> { { "dryRun", dryRun }, { "trees", report } };
        }

        internal static GameObject FitPrefab(GolfMapCourse course, GameObject prefab, PhysicMaterial wood, PhysicMaterial leaves,
            float crownFrom, float crownRadius, float trunkRadius, bool dryRun, Dictionary<string, object> row)
        {
            bool model = PrefabUtility.GetPrefabType(prefab) == PrefabType.ModelPrefab;
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            try
            {
                instance.transform.position = Vector3.zero;
                instance.transform.rotation = Quaternion.identity;
                instance.transform.localScale = Vector3.one;

                var lodGroup = instance.GetComponentInChildren<LODGroup>();
                var renderers = lodGroup != null && lodGroup.GetLODs().Length > 0 ? lodGroup.GetLODs()[0].renderers.Where(r => r).ToArray() : instance.GetComponentsInChildren<Renderer>();
                if (renderers.Length == 0) throw new InvalidOperationException(prefab.name + " has no renderer to size colliders from.");
                var b = renderers[0].bounds;
                foreach (var r in renderers) b.Encapsulate(r.bounds);
                float height = b.max.y, width = (b.size.x + b.size.z) / 2;
                row["heightM"] = Math.Round(height, 2); row["crownWidthM"] = Math.Round(width, 2);

                var added = new List<string>();
                var capsules = instance.GetComponentsInChildren<CapsuleCollider>(true);
                foreach (var c in capsules.Where(c => c.sharedMaterial == null && c.radius < 1f)) { c.sharedMaterial = wood; added.Add("GSPwood on the trunk capsule (r " + c.radius + ")"); }
                bool hasTrunk = instance.GetComponentsInChildren<Collider>(true).Any(c => c.sharedMaterial == wood);
                bool hasCrown = instance.GetComponentsInChildren<Collider>(true).Any(c => c.sharedMaterial == leaves);
                if (!hasTrunk || !hasCrown)
                {
                    var holder = instance.transform.Find(Child);
                    if (holder == null)
                    {
                        holder = new GameObject(Child).transform;
                        holder.SetParent(instance.transform, false);
                        holder.position = Vector3.zero; holder.rotation = Quaternion.identity;
                    }
                    if (!hasTrunk)
                    {
                        float r = Mathf.Clamp(height * trunkRadius, 0.1f, 0.4f), h = height * 0.9f;
                        Capsule(holder, r, h, new Vector3(b.center.x, h / 2, b.center.z), wood);
                        added.Add("trunk r " + r.ToString("0.00") + " h " + h.ToString("0.0"));
                    }
                    if (!hasCrown)
                    {
                        float r = width * crownRadius, h = Mathf.Max(height * (1 - crownFrom), 2 * r);
                        Capsule(holder, r, h, new Vector3(b.center.x, height - h / 2, b.center.z), leaves);
                        added.Add("crown r " + r.ToString("0.00") + " h " + h.ToString("0.0"));
                    }
                }
                row["added"] = added;
                var target = model ? OwnPath(course, prefab) : AssetDatabase.GetAssetPath(prefab);
                row["writes"] = added.Count == 0 ? null : target;
                if (dryRun || added.Count == 0) return model ? Planted(course, prefab) : prefab;
                if (!model) return PrefabUtility.ReplacePrefab(instance, prefab, ReplacePrefabOptions.ReplaceNameBased);
                var folder = GolfMapCourses.Folder(course);
                if (!AssetDatabase.IsValidFolder(folder + FolderName)) AssetDatabase.CreateFolder(folder.TrimEnd('/'), FolderName);
                var existing = AssetDatabase.LoadAssetAtPath<GameObject>(target);
                return existing ? PrefabUtility.ReplacePrefab(instance, existing, ReplacePrefabOptions.ReplaceNameBased) : PrefabUtility.CreatePrefab(target, instance);
            }
            finally { UnityEngine.Object.DestroyImmediate(instance); }
        }

        static void Capsule(Transform holder, float radius, float height, Vector3 center, PhysicMaterial material)
        {
            var c = holder.gameObject.AddComponent<CapsuleCollider>();
            c.direction = 1; c.radius = radius; c.height = height; c.center = center; c.sharedMaterial = material;
        }

        static PhysicMaterial Physic(string name)
        {
            var found = AssetDatabase.FindAssets(name + " t:PhysicMaterial").Select(g => AssetDatabase.LoadAssetAtPath<PhysicMaterial>(AssetDatabase.GUIDToAssetPath(g))).FirstOrDefault(m => m && m.name == name);
            if (!found) throw new InvalidOperationException("No physic material named " + name + " in the project.");
            return found;
        }
    }
}
