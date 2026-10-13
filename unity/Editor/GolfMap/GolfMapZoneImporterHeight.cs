// Bush height for GolfMap > Vegetation Zones (docs/feature-vegetation-zones.md D-VZ17).
//
// A zone can say how tall its bushes grow (heightMin / heightMax, metres). The export
// then carries one more mask, the height mask: 0 where no zone sets a height, else the
// intended height as value / 256 x 12.8 m. VSP has a texture mask scale rule that
// multiplies an instance's size by value / 256 x ScaleMultiplier, before the item's own
// random scale (VegetationCellSpawner.cs, TextureMask.cs SampleRgbaChannelScaleMaskJob).
// A mask can only multiply, though, and a bush item's own size varies several times over
// (MinScale..MaxScale times the noise scale rule), so the item itself cannot be held
// between a min and a max. Hence a twin:
//   - every bush (prefab) item the export names in height.items gets a twin item,
//     "<item> @height": a copy with MinScale = MaxScale = 1 and the noise scale rule off;
//   - the twin shares the item's density mask (one density and one include rule on the
//     item's own group), is excluded where the height mask is 0, and has a scale rule on
//     the height mask with ScaleMultiplier = 12.8 / the prefab's height at scale 1, so a
//     pixel that says 2.5 m gives a 2.5 m bush;
//   - the item itself is excluded where the height mask is above 0.
// So at any point exactly one of the two grows, at the density the zone masks give.
// Texture grass items are left alone: a height is about bushes.
//
// The twin is a copy of the item's settings, refreshed here on every import and by
// golfmap.grass.apply after it configures the item (SyncTwin). Twins nobody needs any
// more are removed from the package.
using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;
using AwesomeTechnologies;
using AwesomeTechnologies.VegetationSystem;
using AwesomeTechnologies.Vegetation.Masks;

namespace GolfMap.Editor
{
    public partial class GolfMapZoneImporter
    {
        const int kHeightChannel = 0;   // a grey PNG: R = G = B

        // A bush item that grows in a zone with a height, and its twin.
        class TwinPlan
        {
            public ItemPlan owner;                 // the item's own mask group and rules
            public VegetationItemInfoPro twin;     // null = create
            public float naturalHeight;            // metres at scale 1
            public TextureMaskRule density, include, exclude, scale;   // the twin's, kept (null = add)
            public TextureMaskRule baseExclude;    // the item's exclude rule on the height mask
        }

        // Top of the prefab's LOD0 mesh above its pivot, as VSP draws it (the mesh, turned by
        // its object's rotation), plus the item's vertical offset, times its height multiplier:
        // the item's height in metres at scale 1. VSP scales the offset with the instance.
        internal static float NaturalHeight(VegetationItemInfoPro item)
        {
            if (!item.VegetationPrefab) return 0;
            var model = MeshUtils.SelectMeshObject(item.VegetationPrefab, LODLevel.LOD0);
            var filter = model ? model.GetComponentInChildren<MeshFilter>() : null;
            if (!filter || !filter.sharedMesh) return 0;
            var bounds = filter.sharedMesh.bounds;
            var rotation = MeshUtils.GetMeshRotation(item.VegetationPrefab, LODLevel.LOD0);
            float top = float.MinValue;
            for (int i = 0; i < 8; i++)
            {
                var corner = bounds.center + Vector3.Scale(bounds.extents, new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1, (i & 4) == 0 ? -1 : 1));
                top = Mathf.Max(top, (rotation * corner).y);
            }
            return (top + item.Offset.y) * item.ScaleMultiplier.y;
        }

        static bool IsBush(VegetationItemInfoPro item)
        {
            return item != null && item.VegetationPrefab && item.VegetationType != VegetationType.Grass;
        }

        // The twin's settings from the item's, keeping the twin's identity and its mask rules,
        // with the item's own size variation taken out. Returns the item's natural height.
        internal static float SyncTwin(VegetationItemInfoPro item, VegetationItemInfoPro twin)
        {
            var id = twin.VegetationItemID;
            bool spawn = twin.EnableRuntimeSpawn;
            var include = twin.TextureMaskIncludeRuleList; var exclude = twin.TextureMaskExcludeRuleList;
            var scale = twin.TextureMaskScaleRuleList; var density = twin.TextureMaskDensityRuleList;
            bool useInclude = twin.UseTextureMaskIncludeRules, useExclude = twin.UseTextureMaskExcludeRules;
            bool useScale = twin.UseTextureMaskScaleRules, useDensity = twin.UseTextureMaskDensityRules;
            // CopySettingValues appends the source's rules to the lists it finds.
            twin.TextureMaskIncludeRuleList = new List<TextureMaskRule>(); twin.TextureMaskExcludeRuleList = new List<TextureMaskRule>();
            twin.TextureMaskScaleRuleList = new List<TextureMaskRule>(); twin.TextureMaskDensityRuleList = new List<TextureMaskRule>();
            twin.RuntimePrefabRuleList.Clear();
            twin.CopySettingValues(item);
            twin.VegetationItemID = id;
            twin.Name = GolfMapZones.TwinName(item.Name);
            twin.Seed = item.Seed + 17;
            twin.EnableRuntimeSpawn = spawn;
            twin.TextureMaskIncludeRuleList = include; twin.TextureMaskExcludeRuleList = exclude;
            twin.TextureMaskScaleRuleList = scale; twin.TextureMaskDensityRuleList = density;
            twin.UseTextureMaskIncludeRules = useInclude; twin.UseTextureMaskExcludeRules = useExclude;
            twin.UseTextureMaskScaleRules = useScale; twin.UseTextureMaskDensityRules = useDensity;
            twin.MinScale = 1;
            twin.MaxScale = 1;
            twin.UseNoiseScaleRule = false;
            return NaturalHeight(item);
        }

        // golfmap.grass.apply, after it configured `item`: bring an existing twin along (tint,
        // spacing, offset...) and re-aim its scale rule, since the offset and the height
        // multiplier are part of the natural height. The twin spawns when the item does.
        internal static void RefreshTwin(VegetationPackagePro package, VegetationItemInfoPro item, List<string> log)
        {
            var name = GolfMapZones.TwinName(item.Name);
            var twin = package.VegetationInfoList.FirstOrDefault(i => i != null && i.Name == name);
            if (twin == null) return;
            float natural = SyncTwin(item, twin);
            var group = package.TextureMaskGroupList.FirstOrDefault(g => g != null && g.TextureMaskName == GolfMapZones.HeightGroupName);
            if (group != null && natural > 0.05f)
                foreach (var rule in twin.TextureMaskScaleRuleList.Where(r => r != null && r.TextureMaskGroupID == group.TextureMaskGroupID))
                    rule.ScaleMultiplier = GolfMapZones.HeightRangeM / natural;
            twin.EnableRuntimeSpawn = item.EnableRuntimeSpawn && HasLiveIncludeRule(package, twin);
            log.Add("height twin '" + name + "' follows '" + item.Name + "' (" + GolfMapZones.F(natural) + " m at scale 1)");
        }

        // Which bush items get a twin, and which existing twins go. Reads only.
        void PlanHeight(ImportPlan plan, VegetationPackagePro package)
        {
            if (!GolfMapZones.HasHeight(loaded)) return;
            var wanted = new HashSet<string>(loaded.height.items);
            foreach (var ip in plan.items)
            {
                if (ip.item == null || !wanted.Contains(ip.entry.item) || !IsBush(ip.item)) continue;
                float natural = NaturalHeight(ip.item);
                if (natural <= 0.05f) { plan.heightNotes.Add("'" + ip.item.Name + "': no usable mesh height (" + GolfMapZones.F(natural) + " m at scale 1); it keeps the palette's sizes"); continue; }
                var name = GolfMapZones.TwinName(ip.item.Name);
                plan.twins[ip.item] = new TwinPlan
                {
                    owner = ip,
                    twin = package.VegetationInfoList.FirstOrDefault(i => i != null && i.Name == name),
                    naturalHeight = natural,
                };
            }
        }

        // Step 3b of the import: the height mask's group, the twins and their rules.
        void ApplyHeight(ImportPlan plan, VegetationPackagePro package, Rect rect)
        {
            foreach (var stale in plan.staleTwins) package.VegetationInfoList.Remove(stale);
            if (!GolfMapZones.HasHeight(loaded)) return;

            var source = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(loadedPath) ?? "", loaded.height.file);
            var texture = ImportMaskTexture(source, plan.folder + System.IO.Path.GetFileName(loaded.height.file), loaded.height.resolution);
            plan.textures.Add(UnityEditor.AssetDatabase.GetAssetPath(texture) + " " + texture.width + "x" + texture.height + " " + texture.format + " (bush height)");

            var group = plan.heightGroup;
            if (group == null)
            {
                group = plan.heightGroup = new TextureMaskGroup(TextureMaskType.RGBAChannel) { TextureMaskName = GolfMapZones.HeightGroupName };
                package.TextureMaskGroupList.Add(group);
            }
            group.TextureMaskType = TextureMaskType.RGBAChannel;
            SetChannel(group.Settings.ControlerPropertyList, kHeightChannel);
            while (group.TextureMaskList.Count > 1) group.TextureMaskList.RemoveAt(group.TextureMaskList.Count - 1);
            if (group.TextureMaskList.Count == 0) group.TextureMaskList.Add(new TextureMask());
            group.TextureMaskList[0].MaskTexture = texture;
            group.TextureMaskList[0].TextureRect = rect;
            group.TextureMaskList[0].Repeat = Vector2.one;

            foreach (var kv in plan.twins)
            {
                var item = kv.Key; var tp = kv.Value;
                var twin = tp.twin;
                if (twin == null)
                {
                    // The copy brings the item's rules along; the twin gets its own below.
                    twin = tp.twin = new VegetationItemInfoPro(item);
                    twin.TextureMaskIncludeRuleList.Clear(); twin.TextureMaskExcludeRuleList.Clear();
                    twin.TextureMaskScaleRuleList.Clear(); twin.TextureMaskDensityRuleList.Clear();
                    package.VegetationInfoList.Add(twin);
                }
                SyncTwin(item, twin);

                // The item's own density mask decides where and how densely the twin grows.
                var density = tp.density ?? AddRule(twin.TextureMaskDensityRuleList, tp.owner.group);
                StampChannel(density, tp.owner.entry.channel);
                density.MinDensity = 0; density.MaxDensity = 1; density.DensityMultiplier = 1;
                twin.UseTextureMaskDensityRules = true;
                var include = tp.include ?? AddRule(twin.TextureMaskIncludeRuleList, tp.owner.group);
                StampChannel(include, tp.owner.entry.channel);
                include.MinDensity = kIncludeThreshold; include.MaxDensity = 1f;
                twin.UseTextureMaskIncludeRules = true;

                // Exclude rules drop a location whose pixel is within [min, max] x 256: the twin
                // where no height is set (pixel 0), the item where one is (pixel 1 and up).
                var twinExclude = tp.exclude ?? AddRule(twin.TextureMaskExcludeRuleList, group);
                StampChannel(twinExclude, kHeightChannel);
                twinExclude.MinDensity = 0; twinExclude.MaxDensity = 0;
                twin.UseTextureMaskExcludeRules = true;
                var itemExclude = tp.baseExclude ?? AddRule(item.TextureMaskExcludeRuleList, group);
                StampChannel(itemExclude, kHeightChannel);
                itemExclude.MinDensity = 1f / 256f; itemExclude.MaxDensity = 1f;
                item.UseTextureMaskExcludeRules = true;

                var scale = tp.scale ?? AddRule(twin.TextureMaskScaleRuleList, group);
                StampChannel(scale, kHeightChannel);
                scale.ScaleMultiplier = GolfMapZones.HeightRangeM / tp.naturalHeight;
                twin.UseTextureMaskScaleRules = true;
                twin.EnableRuntimeSpawn = true;
            }
        }
    }
}
