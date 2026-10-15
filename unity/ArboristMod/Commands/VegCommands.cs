// Vegetation Studio Pro as the player runs it (Arborist and GSPro alike): which systems there
// are, what they hold, and which placed instance is the thing in the picture.
using System;
using System.Collections.Generic;
using System.Linq;
using AwesomeTechnologies.VegetationSystem;
using UnityEngine;

namespace GolfMap.Bridge
{
    static class VegCommands
    {
        static IEnumerable<VegetationSystemPro> Systems(bool inactive)
        {
            return Resources.FindObjectsOfTypeAll<VegetationSystemPro>().Where(s => s && s.gameObject.scene.IsValid() && (inactive || s.isActiveAndEnabled));
        }

        static string PathOf(Transform t)
        {
            var parts = new List<string>();
            for (; t; t = t.parent) parts.Add(t.name);
            parts.Reverse();
            return "/" + string.Join("/", parts.ToArray());
        }

        [BridgeCommand("veg.systems", "Every Vegetation Studio Pro system in the loaded scenes: active?, cameras, distances, terrains, and per package its items (type, runtime spawn, render distance factor, billboards, shader) with how many placed instances the persistent storage holds of each.",
            args = "items=true")]
        static object SystemsCommand(BridgeArgs a)
        {
            var rows = new List<object>();
            foreach (var s in Systems(true))
            {
                var stored = new Dictionary<string, int>();
                var storage = s.PersistentVegetationStorage;
                if (storage && storage.PersistentVegetationStoragePackage)
                    foreach (var cell in storage.PersistentVegetationStoragePackage.PersistentVegetationCellList)
                        foreach (var info in cell.PersistentVegetationInfoList)
                        {
                            int n; stored.TryGetValue(info.VegetationItemID, out n);
                            stored[info.VegetationItemID] = n + info.VegetationItemList.Count;
                        }
                var packages = new List<object>();
                foreach (var p in s.VegetationPackageProList.Where(p => p))
                {
                    var d = new Dictionary<string, object> { { "name", p.PackageName }, { "items", p.VegetationInfoList.Count } };
                    if (a.Bool("items", true))
                        d["itemList"] = p.VegetationInfoList.Select(i =>
                        {
                            int n; stored.TryGetValue(i.VegetationItemID, out n);
                            return (object)new Dictionary<string, object>
                            {
                                { "name", i.Name }, { "type", i.VegetationType.ToString() }, { "spawn", i.EnableRuntimeSpawn }, { "stored", n },
                                { "renderDistanceFactor", i.RenderDistanceFactor }, { "billboards", i.UseBillboards }, { "lodFactor", i.LODFactor },
                                { "shader", i.ShaderName },
                            };
                        }).ToList();
                    packages.Add(d);
                }
                var settings = s.VegetationSettings;
                rows.Add(new Dictionary<string, object>
                {
                    { "path", PathOf(s.transform) }, { "active", s.isActiveAndEnabled },
                    { "cameras", s.VegetationStudioCameraList.Select(c => (object)(c.SelectedCamera ? c.SelectedCamera.name : "(none)")).ToList() },
                    { "plantDistance", settings.PlantDistance }, { "treeDistance", settings.GetTreeDistance() }, { "billboardDistance", settings.GetBillboardDistance() },
                    { "terrains", s.VegetationStudioTerrainObjectList.Where(t => t).Select(t => (object)t.name).ToList() },
                    { "storedInstances", stored.Values.Sum() }, { "packages", packages },
                });
            }
            return rows;
        }

        [BridgeCommand("fps", "The frame rate where the camera stands now, measured over `seconds`: frames per second (mean), the mean, median and worst frame time in ms, the 1 % low, and how many frames took longer than overMs (a hitch: under 40 fps at the default 25). The app's own counter shows the same thing; this one can be read.",
            args = "seconds=3, overMs=25")]
        static System.Collections.IEnumerator Fps(BridgeArgs a)
        {
            float seconds = Mathf.Clamp((float)a.Number("seconds", 3), 0.5f, 60f);
            float overMs = (float)a.Number("overMs", 25);
            var frames = new List<float>();
            float start = Time.realtimeSinceStartup;
            yield return null;   // the bridge steps a command once per frame
            while (Time.realtimeSinceStartup - start < seconds) { frames.Add(Time.unscaledDeltaTime * 1000f); yield return null; }
            if (frames.Count == 0) throw new BridgeError("No frame was drawn.");
            var sorted = frames.OrderBy(f => f).ToList();
            float mean = frames.Average();
            int slow = Mathf.Max(1, sorted.Count / 100);
            yield return new Dictionary<string, object>
            {
                { "fps", Math.Round(1000f / mean, 1) }, { "frames", frames.Count }, { "meanMs", Math.Round(mean, 2) }, { "medianMs", Math.Round(sorted[sorted.Count / 2], 2) },
                { "worstMs", Math.Round(sorted[sorted.Count - 1], 2) }, { "onePercentLowFps", Math.Round(1000f / sorted.Skip(sorted.Count - slow).Average(), 1) },
                { "overMs", overMs }, { "framesOver", frames.Count(f => f > overMs) },
                { "vSync", QualitySettings.vSyncCount }, { "targetFrameRate", Application.targetFrameRate }, { "refreshRate", Screen.currentResolution.refreshRate },
                { "resolution", Screen.width + "x" + Screen.height }, { "quality", QualitySettings.names[QualitySettings.GetQualityLevel()] },
            };
        }

        // GSPro sets QualitySettings.vSyncCount again in its Update every frame, so a plain `set` does not hold.
        // Setting it at the end of each frame is after that and before the frame is presented.
        static bool uncapped;
        static System.Collections.IEnumerator HoldVSyncOff()
        {
            var endOfFrame = new WaitForEndOfFrame();
            while (uncapped) { QualitySettings.vSyncCount = 0; Application.targetFrameRate = -1; yield return endOfFrame; }
        }

        [BridgeCommand("vsync", "Frame-rate cap for measuring: on=false takes vSync off and keeps it off (the app sets it again every frame; this sets it back at the end of each frame), so a frame takes what it costs instead of a whole number of display refreshes. on=true hands vSync back to the app. A display at 60 Hz otherwise shows every viewpoint slower than 60 fps as 30.",
            args = "on (true|false; without it the state is only reported)")]
        static object VSync(BridgeArgs a)
        {
            if (a.Has("on"))
            {
                bool off = !a.Bool("on", true);
                if (off && !uncapped) { uncapped = true; PlayerBridge.Run(HoldVSyncOff()); }
                else if (!off) uncapped = false;
            }
            return new Dictionary<string, object> { { "heldOff", uncapped }, { "vSync", QualitySettings.vSyncCount }, { "refreshRate", Screen.currentResolution.refreshRate } };
        }

        // `system` is a part of the system's path; one that starts with "/" must be where the path starts.
        // GSPro's own system is /MainGameObjects/VegetationStudioPro/..., so "/VegetationStudioPro" as a mere part
        // also took the Arborist system: "course trees off" hid every tree (found 2026-10-13).
        static bool OfSystem(VegetationSystemPro s, string system)
        {
            string path = PathOf(s.transform);
            return system.StartsWith("/") ? path.StartsWith(system, StringComparison.OrdinalIgnoreCase) : path.IndexOf(system, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // What veg.set changed, to put back: item id -> (spawn, density, sample distance); storage -> disabled.
        sealed class Was { public bool spawn; public float density, sample, render; }
        static readonly Dictionary<VegetationItemInfoPro, Was> changedItems = new Dictionary<VegetationItemInfoPro, Was>();
        static readonly Dictionary<AwesomeTechnologies.Vegetation.PersistentStorage.PersistentVegetationStorage, bool> changedStorages = new Dictionary<AwesomeTechnologies.Vegetation.PersistentStorage.PersistentVegetationStorage, bool>();

        [BridgeCommand("veg.set", "Try a vegetation change in the running player, for measuring what it costs or saves before anything is rebuilt: on the items picked by system / package / type / item (parts of names; all given must match) set spawn (runtime spawning on or off), density (x the item's own) and sampleDistance (x the item's own; 2 = a quarter as many), renderDistance (the item's render distance factor itself: the share of the system's plant or tree distance it is drawn to); stored=false stops the picked systems drawing their placed trees. restore=true puts back everything veg.set changed (do it before `reload`). Nothing is saved.",
            args = "system, package, type (Grass|Plant|Tree|Objects), item, spawn, density, sampleDistance, renderDistance, stored, restore")]
        static object SetCommand(BridgeArgs a)
        {
            var touched = new HashSet<VegetationSystemPro>();
            int items = 0, storages = 0;
            if (a.Bool("restore", false))
            {
                foreach (var s in Systems(true))
                {
                    foreach (var item in s.VegetationPackageProList.Where(p => p).SelectMany(p => p.VegetationInfoList))
                    {
                        Was was;
                        if (!changedItems.TryGetValue(item, out was)) continue;
                        item.EnableRuntimeSpawn = was.spawn; item.Density = was.density; item.SampleDistance = was.sample; item.RenderDistanceFactor = was.render;
                        touched.Add(s); items++;
                    }
                    bool disabled;
                    if (s.PersistentVegetationStorage && changedStorages.TryGetValue(s.PersistentVegetationStorage, out disabled))
                    { s.PersistentVegetationStorage.DisablePersistentStorage = disabled; touched.Add(s); storages++; }
                }
                changedItems.Clear(); changedStorages.Clear();
            }
            else
            {
                string system = a.String("system"), package = a.String("package"), type = a.String("type"), name = a.String("item");
                foreach (var s in Systems(false))
                {
                    if (system != null && !OfSystem(s, system)) continue;
                    if (a.Has("stored") && s.PersistentVegetationStorage)
                    {
                        var storage = s.PersistentVegetationStorage;
                        if (!changedStorages.ContainsKey(storage)) changedStorages[storage] = storage.DisablePersistentStorage;
                        storage.DisablePersistentStorage = !a.Bool("stored", true);
                        touched.Add(s); storages++;
                    }
                    if (!a.Has("spawn") && !a.Has("density") && !a.Has("sampleDistance") && !a.Has("renderDistance")) continue;
                    foreach (var p in s.VegetationPackageProList.Where(p => p))
                    {
                        if (package != null && p.PackageName.IndexOf(package, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        foreach (var item in p.VegetationInfoList)
                        {
                            if (type != null && !string.Equals(item.VegetationType.ToString(), type, StringComparison.OrdinalIgnoreCase)) continue;
                            if (name != null && item.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                            if (!changedItems.ContainsKey(item)) changedItems[item] = new Was { spawn = item.EnableRuntimeSpawn, density = item.Density, sample = item.SampleDistance, render = item.RenderDistanceFactor };
                            var was = changedItems[item];
                            if (a.Has("spawn")) item.EnableRuntimeSpawn = a.Bool("spawn", true) && was.spawn;
                            if (a.Has("density")) item.Density = was.density * (float)a.Number("density", 1);
                            if (a.Has("sampleDistance")) item.SampleDistance = was.sample * (float)a.Number("sampleDistance", 1);
                            if (a.Has("renderDistance")) item.RenderDistanceFactor = (float)a.Number("renderDistance", 1);
                            touched.Add(s); items++;
                        }
                    }
                }
            }
            foreach (var s in touched) { s.RefreshVegetationSystem(); s.ClearCache(); }
            return new Dictionary<string, object> { { "items", items }, { "storages", storages }, { "systems", touched.Select(s => (object)PathOf(s.transform)).ToList() }, { "pendingRestore", changedItems.Count + changedStorages.Count } };
        }

        // What veg.draw moved to the hidden layer: per system and type the layer it had.
        static readonly Dictionary<VegetationSystemPro, Dictionary<string, int>> hiddenLayers = new Dictionary<VegetationSystemPro, Dictionary<string, int>>();
        static readonly string[] DrawTypes = { "Grass", "Plant", "Tree", "Object", "LargeObject", "Billboard" };

        [BridgeCommand("veg.draw", "Stop (on=false) or resume drawing one kind of vegetation of the picked systems at once, without a refresh: the kind's render layer is moved to a layer the game camera does not draw. For measuring what a kind costs to draw: a veg.set refresh makes the system load its cells again, which in GSPro takes minutes at under 30 fps, while this takes one frame (the cells stay loaded and culled, so the CPU side of the cost is still there). type = Grass, Plant, Tree, Object, LargeObject or Billboard; none = all six. restore=true puts every layer back.",
            args = "system (part of its path), type, on=false, restore=true")]
        static object DrawCommand(BridgeArgs a)
        {
            int changed = 0;
            if (a.Bool("restore", false))
            {
                foreach (var kv in hiddenLayers)
                {
                    if (!kv.Key) continue;
                    var settings = kv.Key.VegetationSettings;
                    foreach (var layer in kv.Value) { typeof(VegetationSettings).GetField(layer.Key + "Layer").SetValue(settings, (LayerMask)layer.Value); changed++; }
                }
                hiddenLayers.Clear();
                return new Dictionary<string, object> { { "restored", changed } };
            }
            var camera = Camera.main;
            if (!camera) throw new BridgeError("No main camera.");
            int hide = -1;
            for (int layer = 31; layer >= 8; layer--) if ((camera.cullingMask & (1 << layer)) == 0) { hide = layer; break; }
            if (hide < 0) throw new BridgeError("The camera draws every layer: there is none to hide vegetation on.");
            string system = a.String("system"), type = a.String("type");
            bool on = a.Bool("on", false);
            foreach (var s in Systems(false))
            {
                if (system != null && !OfSystem(s, system)) continue;
                foreach (var kind in DrawTypes)
                {
                    if (type != null && !string.Equals(kind, type, StringComparison.OrdinalIgnoreCase)) continue;
                    var field = typeof(VegetationSettings).GetField(kind + "Layer");
                    Dictionary<string, int> was;
                    if (!hiddenLayers.TryGetValue(s, out was)) hiddenLayers[s] = was = new Dictionary<string, int>();
                    if (on) { if (was.ContainsKey(kind)) { field.SetValue(s.VegetationSettings, (LayerMask)was[kind]); was.Remove(kind); changed++; } }
                    else if (!was.ContainsKey(kind)) { was[kind] = ((LayerMask)field.GetValue(s.VegetationSettings)).value; field.SetValue(s.VegetationSettings, (LayerMask)hide); changed++; }
                }
            }
            return new Dictionary<string, object> { { "changed", changed }, { "hiddenLayer", hide }, { "pendingRestore", hiddenLayers.Sum(kv => kv.Value.Count) } };
        }

        [BridgeCommand("veg.material", "Read or set shader values straight on the loaded materials (every LOD) of the vegetation items whose name contains `item`, in the systems whose path contains `system`: floats={_Property: value}, colors={_Property: \"#rrggbb\"}. Without floats/colors: lists each material's shader and the values of `read` (property names). For finding out what a look depends on; nothing is saved, and the app's own refresh of an item puts its values back.",
            args = "item (required), system, floats, colors, read=[names]")]
        static object MaterialCommand(BridgeArgs a)
        {
            string name = a.String("item"), system = a.String("system");
            if (name == null) throw new BridgeError("Give item.");
            var floats = a.Raw("floats") as Dictionary<string, object>;
            var colors = a.Raw("colors") as Dictionary<string, object>;
            var read = a.Strings("read") ?? new string[0];
            var rows = new List<object>();
            var seen = new HashSet<Material>();
            foreach (var s in Systems(false))
            {
                if (system != null && !OfSystem(s, system)) continue;
                foreach (var package in s.VegetationPackageProModelsList)
                    foreach (var model in package.VegetationItemModelList)
                    {
                        if (model.VegetationItemInfo == null || model.VegetationItemInfo.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        foreach (var set in new[] { model.VegetationMaterialsLOD0, model.VegetationMaterialsLOD1, model.VegetationMaterialsLOD2, model.VegetationMaterialsLOD3 })
                            foreach (var m in set ?? new Material[0])
                            {
                                if (!m || !seen.Add(m)) continue;
                                if (floats != null) foreach (var f in floats) if (m.HasProperty(f.Key)) m.SetFloat(f.Key, Convert.ToSingle(f.Value, System.Globalization.CultureInfo.InvariantCulture));
                                if (colors != null) foreach (var c in colors) { Color colour; if (m.HasProperty(c.Key) && ColorUtility.TryParseHtmlString((string)c.Value, out colour)) m.SetColor(c.Key, colour); }
                                if (rows.Count >= 40) continue;
                                var row = new Dictionary<string, object> { { "item", model.VegetationItemInfo.Name }, { "material", m.name }, { "shader", m.shader ? m.shader.name : "" } };
                                foreach (var r in read) row[r] = m.HasProperty(r) ? (object)m.GetFloat(r) : "(none)";
                                rows.Add(row);
                            }
                    }
            }
            return new Dictionary<string, object> { { "materials", seen.Count }, { "shown", rows } };
        }

        [BridgeCommand("veg.at", "The placed (persistent storage) vegetation the camera sees at a spot of the picture: instances whose position falls within `window` of viewport point u,v (0-1 from the bottom left), nearest first, with item, system, distance, position and scale. Runtime-spawned items (mask-driven bushes and grass) are not instances and do not show here.",
            args = "u (required), v (required), window=0.04, maxDistance=600, camera (name), limit=12")]
        static object At(BridgeArgs a)
        {
            var camera = Camera.main;
            string named = a.String("camera");
            if (named != null) camera = Resources.FindObjectsOfTypeAll<Camera>().FirstOrDefault(c => c.name == named && c.gameObject.scene.IsValid());
            if (!camera) throw new BridgeError("No camera.");
            float u = (float)a.Number("u", 0.5), v = (float)a.Number("v", 0.5), window = (float)a.Number("window", 0.04), far = (float)a.Number("maxDistance", 600);
            var hits = new List<KeyValuePair<float, Dictionary<string, object>>>();
            foreach (var s in Systems(false))
            {
                var storage = s.PersistentVegetationStorage;
                if (!storage || !storage.PersistentVegetationStoragePackage) continue;
                var names = s.VegetationPackageProList.Where(p => p).SelectMany(p => p.VegetationInfoList).GroupBy(i => i.VegetationItemID).ToDictionary(g => g.Key, g => g.First());
                Vector3 origin = s.VegetationSystemPosition;
                foreach (var cell in storage.PersistentVegetationStoragePackage.PersistentVegetationCellList)
                    foreach (var info in cell.PersistentVegetationInfoList)
                    {
                        VegetationItemInfoPro item;
                        if (!names.TryGetValue(info.VegetationItemID, out item)) continue;
                        for (int i = 0; i < info.VegetationItemList.Count; i++)
                        {
                            var world = info.VegetationItemList[i].Position + origin;
                            // Aim at the middle of the plant rather than its foot.
                            var p = camera.WorldToViewportPoint(world + Vector3.up * 2f);
                            if (p.z <= 0 || p.z > far || Mathf.Abs(p.x - u) > window || Mathf.Abs(p.y - v) > window * 2) continue;
                            hits.Add(new KeyValuePair<float, Dictionary<string, object>>(p.z, new Dictionary<string, object>
                            {
                                { "item", item.Name }, { "type", item.VegetationType.ToString() }, { "system", PathOf(s.transform) }, { "distance", p.z },
                                { "position", new List<object> { world.x, world.y, world.z } }, { "scale", info.VegetationItemList[i].Scale.y },
                                { "viewport", new List<object> { p.x, p.y } }, { "shader", item.ShaderName },
                            }));
                        }
                    }
            }
            return new Dictionary<string, object>
            {
                { "camera", camera.name }, { "matches", hits.Count },
                { "instances", hits.OrderBy(h => h.Key).Take(a.Int("limit", 12)).Select(h => (object)h.Value).ToList() },
            };
        }
    }
}
