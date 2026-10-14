// Patching an imported zones export in place (golf-map's "Update N zones" on
// selected zones): `gspro.py zones-patch` re-rasterizes the window the zones
// cover and rewrites only the mask PNGs that changed, and writes a
// unity-zones-patch-v1 record next to them. This takes those PNGs into the
// project (copy + reimport, the full import's own ImportMaskTexture) and
// respawns VSP only inside the window (VegetationSystemPro.ClearCache(Bounds)).
// Nothing about the package changes: the patch keeps the export's channel
// layout, so the groups and rules a full import made stay right. The patch
// refuses when the package does not hold that import (a group missing, a
// group on another texture or channel): then only a full import can follow.
//
// VSP samples mask textures with GetRawTextureData at every spawn
// (TextureMask.cs), so the reimported pixels are what the respawned cells see.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using GolfMap.Bridge;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using AwesomeTechnologies.VegetationSystem;
using AwesomeTechnologies.Vegetation.Masks;

namespace GolfMap.Editor
{
    public partial class GolfMapZoneImporter
    {
        const string kPatchFormat = "unity-zones-patch-v1";

        // JsonUtility fills these by reflection, so the compiler sees no assignment: CS0649 off for
        // the record, not for the file (check-planter.ps1 compiles it and would print 12 warnings).
#pragma warning disable 0649
        [Serializable]
        class ZonesPatchRegion { public float x0, z0, x1, z1; }

        [Serializable]
        class ZonesPatch
        {
            public string format, zonesFile, terrain;
            public bool changed;
            public List<string> textures;
            public ZonesPatchRegion region;
            public List<string> zones, removed;
        }
#pragma warning restore 0649

        [BridgeCommand("golfmap.zones.patch", "Take a zones-patch (gspro.py zones-patch) into the scene: reimport only the mask PNGs it changed and respawn VSP only inside its window. Needs a full golfmap.zones.import of the same export first; changes no groups or rules. Marks the scene dirty; save=true saves it (and the assets it changed) once the patch has succeeded.",
            args = "terrain=inner|outer or file (the zones JSON), patch=<unity-zones-patch-v1 json>, package (name), " + GolfMapSceneSave.Arg)]
        static object BridgePatch(BridgeArgs a)
        {
            return WithImporter(a, w =>
            {
                w.ValidateTarget();
                return w.ApplyPatch(Path.GetFullPath(a.Require("patch")));
            });
        }

        Dictionary<string, object> ApplyPatch(string patchPath)
        {
            var clock = Stopwatch.StartNew();
            if (!File.Exists(patchPath)) throw new BridgeError("No patch record at " + patchPath);
            var patch = JsonUtility.FromJson<ZonesPatch>(File.ReadAllText(patchPath));
            if (patch == null || patch.format != kPatchFormat) throw new BridgeError(patchPath + " is not a " + kPatchFormat + " record.");
            if (!string.Equals(patch.zonesFile, Path.GetFileName(loadedPath), StringComparison.OrdinalIgnoreCase))
                throw new BridgeError("The patch is for " + patch.zonesFile + ", not " + Path.GetFileName(loadedPath) + ".");

            VegetationSystemPro system; VegetationPackagePro package;
            CheckPackage(out system, out package);
            string course, folder;
            ZonesFolder(out course, out folder);
            var problems = ImportedLayoutProblems(package, folder);
            if (problems.Count > 0)
                throw new BridgeError("The scene does not hold this zones export's import (" + string.Join("; ", problems.Take(3).ToArray())
                    + (problems.Count > 3 ? "; ..." : "") + "). Update vegetation (a full import) instead.");

            var reimported = new List<object>();
            var textures = patch.textures ?? new List<string>();
            foreach (var file in textures)
            {
                var mask = loaded.masks.FirstOrDefault(m => string.Equals(m.file, file, StringComparison.OrdinalIgnoreCase));
                bool height = mask == null && GolfMapZones.HasHeight(loaded) && string.Equals(loaded.height.file, file, StringComparison.OrdinalIgnoreCase);
                if (mask == null && !height) throw new BridgeError("The patch names " + file + ", which " + patch.zonesFile + " has no mask for.");
                var name = height ? loaded.height.file : mask.file;
                var source = Path.Combine(Path.GetDirectoryName(loadedPath) ?? "", name);
                var texture = ImportMaskTexture(source, folder + Path.GetFileName(name), height ? loaded.height.resolution : mask.resolution);
                reimported.Add(AssetDatabase.GetAssetPath(texture));
            }
            long importMs = clock.ElapsedMilliseconds;

            Bounds? cleared = null;
            if (patch.changed && patch.region != null)
            {
                // Plot-local metres (x east, z north from the square's corner) = terrain-local.
                var origin = terrain.transform.position;
                var size = terrain.terrainData.size;
                var min = new Vector3(origin.x + patch.region.x0, origin.y, origin.z + patch.region.z0);
                var max = new Vector3(origin.x + patch.region.x1, origin.y + size.y, origin.z + patch.region.z1);
                var bounds = new Bounds((min + max) / 2, max - min);
                system.ClearCache(bounds);
                cleared = bounds;
                EditorSceneManager.MarkSceneDirty(terrain.gameObject.scene);
                SceneView.RepaintAll();
            }

            status = patch.changed
                ? "Patched " + reimported.Count + " mask texture(s) for " + (patch.zones != null ? patch.zones.Count : 0) + " zone(s)"
                  + (patch.removed != null && patch.removed.Count > 0 ? " (" + patch.removed.Count + " removed)" : "")
                  + ", respawned " + (patch.region.x1 - patch.region.x0).ToString("0") + " x " + (patch.region.z1 - patch.region.z0).ToString("0") + " m"
                  + " in " + clock.ElapsedMilliseconds + " ms. Save the scene."
                : "Nothing changed in the masks; nothing to respawn.";
            UnityEngine.Debug.Log("[GolfMap] " + status);
            return new Dictionary<string, object>
            {
                { "file", filePath },
                { "terrain", terrain.name },
                { "system", system.name },
                { "package", package.PackageName },
                { "textures", reimported },
                { "cleared", cleared.HasValue ? (object)new Dictionary<string, object> {
                    { "min", new List<object> { cleared.Value.min.x, cleared.Value.min.z } },
                    { "max", new List<object> { cleared.Value.max.x, cleared.Value.max.z } } } : null },
                { "importMs", importMs },
                { "ms", clock.ElapsedMilliseconds },
                { "status", status },
            };
        }

        // What keeps a patch from being enough: an exported item whose group is missing, or
        // holds another texture or channel than this export gives it.
        List<string> ImportedLayoutProblems(VegetationPackagePro package, string folder)
        {
            var problems = new List<string>();
            foreach (var entry in loaded.items)
            {
                var name = GolfMapZones.GroupName(entry.item);
                var group = package.TextureMaskGroupList.FirstOrDefault(g => g != null && g.TextureMaskName == name);
                if (group == null || group.TextureMaskList.Count == 0) { problems.Add("no mask group for '" + entry.item + "'"); continue; }
                var expected = folder + Path.GetFileName(loaded.masks[entry.texture].file);
                var actual = group.TextureMaskList[0].MaskTexture ? AssetDatabase.GetAssetPath(group.TextureMaskList[0].MaskTexture) : "(none)";
                if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) problems.Add("'" + entry.item + "' samples " + actual + ", not " + expected);
                var channel = group.Settings.ControlerPropertyList.FirstOrDefault(p => p.PropertyName == kChannelProperty);
                if (channel == null || channel.IntValue != entry.channel) problems.Add("'" + entry.item + "' reads another channel");
            }
            // The bush-height mask and the twins a full import made for it.
            var heightGroup = package.TextureMaskGroupList.FirstOrDefault(g => g != null && g.TextureMaskName == GolfMapZones.HeightGroupName);
            if (!GolfMapZones.HasHeight(loaded))
            {
                if (heightGroup != null) problems.Add("a bush-height mask group this export does not have");
                return problems;
            }
            var heightPath = folder + Path.GetFileName(loaded.height.file);
            if (heightGroup == null || heightGroup.TextureMaskList.Count == 0 || !heightGroup.TextureMaskList[0].MaskTexture
                || !string.Equals(AssetDatabase.GetAssetPath(heightGroup.TextureMaskList[0].MaskTexture), heightPath, StringComparison.OrdinalIgnoreCase))
                problems.Add("no bush-height mask group on " + heightPath);
            foreach (var name in loaded.height.items)
            {
                var item = FindItem(package, name);
                if (IsBush(item) && NaturalHeight(item) > 0.05f && !package.VegetationInfoList.Any(i => i != null && i.Name == GolfMapZones.TwinName(item.Name)))
                    problems.Add("no height twin for '" + name + "'");
            }
            return problems;
        }
    }
}
