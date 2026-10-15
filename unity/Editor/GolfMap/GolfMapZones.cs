// Model and loader for a golf-map "unity-zones-v2" export: vegetation zones
// rasterised into RGBA texture masks for Vegetation Studio Pro, one channel per
// VSP item (the pipeline bakes each item's final density into its channel), plus
// the zone polygons for the Scene-view overlay and the zone types with their
// variants for the summary. See docs/feature-vegetation-zones.md and unity/README.md.
//
// Why one channel per item and not per zone type: VSP multiplies an item's texture
// mask density rules (TextureMask.cs, SpawnChance *= value/256 * DensityMultiplier
// per rule), so an item bound to two channels would only spawn where both are
// non-zero. With variants sharing items that is the normal case, so every item gets
// exactly one density and one include rule against its own channel.
//
// Plain JsonUtility classes: objects and lists only, no dictionaries. The plot
// record is shared with unity-trees-v1 (GolfMapTreePlot) so terrain matching
// by bounds is the same code path as the tree planter's.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEngine;

namespace GolfMap.Editor
{
    [Serializable]
    public class GolfMapZoneFile
    {
        public string format;
        public GolfMapTreePlot plot;
        public List<GolfMapZoneMask> masks;
        public List<GolfMapZoneItem> items;
        public List<GolfMapZoneType> zoneTypes;
        public List<GolfMapZone> zones;
        public GolfMapZoneHeight height; // the bush-height mask; no file = no zone sets a height
        // Not in the file: consistency notes found while loading (unknown slot keys and
        // the like). They do not stop an import; the summary and the report list them.
        [NonSerialized] public List<string> warnings = new List<string>();
    }

    [Serializable]
    public class GolfMapZoneMask
    {
        public string file;              // PNG next to the JSON
        public int resolution;           // square, pixels
        public List<string> channels;    // VSP item name per channel R, G, B, A ("" = unused)
    }

    // The bush-height mask (D-VZ17): a grey PNG, 0 = no height set, else the intended height
    // as value / 256 x rangeM metres, and the items that can grow where a height is set.
    [Serializable]
    public class GolfMapZoneHeight
    {
        public string file;              // PNG next to the JSON
        public int resolution;           // square, pixels
        public float rangeM;
        public List<string> items;       // VSP item names; the bushes among them get a height-driven twin
    }

    // One VSP item and the mask channel holding its baked density.
    [Serializable]
    public class GolfMapZoneItem
    {
        public string item;              // VegetationItemInfoPro.Name in the package
        public int texture;              // index into masks
        public int channel;              // 0 R, 1 G, 2 B, 3 A
        public List<string> sources;     // slot keys binding it: "<type>" (Default) or "<type>/<variant>"
    }

    [Serializable]
    public class GolfMapZoneType
    {
        public string key;
        public string name;
        public string color;             // "#rrggbb" for the overlay
        public List<GolfMapZoneItemBinding> items;       // the Default mix
        public List<GolfMapZoneVariant> variants;
    }

    [Serializable]
    public class GolfMapZoneVariant
    {
        public string key;
        public string name;
        public List<GolfMapZoneItemBinding> items;
    }

    [Serializable]
    public class GolfMapZoneItemBinding
    {
        public string item;              // VegetationItemInfoPro.Name in the package
        public float minDensity;         // information only: VSP has no density floor
        public float maxDensity = 1;     // baked into the item's mask pixels by the pipeline
    }

    [Serializable]
    public class GolfMapZone
    {
        public string id;
        public string zoneType;
        public string variant;           // variant key, "" = the type's Default mix
        public float weight = 1;
        public float feather = 2;
        public float noise;
        public float heightMin, heightMax;   // metres its bushes are scaled to; 0 = the palette's sizes
        public List<GolfMapZoneRing> rings;
    }

    [Serializable]
    public class GolfMapZoneRing
    {
        public List<GolfMapZoneNode> nodes;
    }

    [Serializable]
    public class GolfMapZoneNode
    {
        public float x;                  // metres east of the plot origin
        public float z;                  // metres north of the plot origin
    }

    public static class GolfMapZones
    {
        public const string Format = "unity-zones-v2";
        const string LegacyFormat = "unity-zones-v1";
        // Every texture mask group whose name starts with this belongs to the importer: a
        // re-import updates the current ones in place and deletes the rest.
        public const string GroupPrefix = "golfmap-zone:";
        // The per-item groups: "golfmap-zone:item:<VSP item name>".
        public const string ItemGroupPrefix = GroupPrefix + "item:";

        public static string GroupName(string item) { return ItemGroupPrefix + item; }

        // The one group on the bush-height mask, and the name of a bush item's height-driven
        // twin: the same prefab with its own random size taken out, scaled by that mask.
        public const string HeightGroupName = GroupPrefix + "height";
        public const string TwinSuffix = " @height";
        // Metres a full height-mask pixel stands for (pipeline/gspro.py ZONE_HEIGHT_RANGE_M).
        public const float HeightRangeM = 12.8f;

        public static string TwinName(string item) { return item + TwinSuffix; }

        public static bool IsTwinName(string name) { return name != null && name.EndsWith(TwinSuffix, StringComparison.Ordinal); }

        public static string TwinBase(string name) { return name.Substring(0, name.Length - TwinSuffix.Length); }

        // A grass item's distance copy (grass-palette.json "copies"): the same item drawn only to
        // that many metres, so the grass is denser near the camera (stingreye's trick). It has no
        // mask of its own: golfmap.grass.apply gives it its base item's mask rules, and the zone
        // import keeps them.
        static readonly System.Text.RegularExpressions.Regex CopyName = new System.Text.RegularExpressions.Regex(@"^(.*) @(\d+)m$");

        public static string DistanceCopyName(string item, float metres) { return item + " @" + Mathf.RoundToInt(metres) + "m"; }

        public static bool IsDistanceCopyName(string name) { return name != null && CopyName.IsMatch(name); }

        public static string DistanceCopyBase(string name) { var m = CopyName.Match(name ?? ""); return m.Success ? m.Groups[1].Value : null; }

        public static bool HasHeight(GolfMapZoneFile file) { return file != null && file.height != null && !string.IsNullOrEmpty(file.height.file); }

        public static bool IsGroupName(string name) { return name != null && name.StartsWith(GroupPrefix, StringComparison.Ordinal); }

        // The item a per-item group is for; null for any other name (v1 per-type groups included).
        public static string ItemFromGroupName(string name)
        {
            return name != null && name.StartsWith(ItemGroupPrefix, StringComparison.Ordinal) ? name.Substring(ItemGroupPrefix.Length) : null;
        }

        // "rough_tall" for the Default mix, "rough_tall/dry" for a variant.
        public static string SlotKey(string type, string variant) { return string.IsNullOrEmpty(variant) ? type : type + "/" + variant; }

        static bool Finite(float v) { return !float.IsNaN(v) && !float.IsInfinity(v); }

        // Reads and validates the file. Mask PNGs are checked for existence and size from
        // their header, not loaded: a 4096 RGBA mask is 64 MB and the importer loads it
        // once, through the asset pipeline.
        public static GolfMapZoneFile Load(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new Exception("Zones file not found: " + path);
            var file = JsonUtility.FromJson<GolfMapZoneFile>(File.ReadAllText(path).TrimStart('﻿'));
            if (file != null && file.format == LegacyFormat)
                throw new Exception(Path.GetFileName(path) + " is " + LegacyFormat + ": re-export zones from golf-map (v2: one mask channel per item).");
            if (file == null || file.format != Format) throw new Exception("format must be " + Format);
            file.warnings = new List<string>();
            if (file.plot == null || !(file.plot.sizeM > 0) || !Finite(file.plot.sizeM)) throw new Exception("plot.sizeM missing");
            if (file.plot.terrain != "inner" && file.plot.terrain != "outer") throw new Exception("plot.terrain must be inner or outer");
            if (file.masks == null || file.masks.Count == 0) throw new Exception("masks missing");
            if (file.items == null) file.items = new List<GolfMapZoneItem>();
            if (file.zoneTypes == null) file.zoneTypes = new List<GolfMapZoneType>();
            if (file.zones == null) file.zones = new List<GolfMapZone>();

            var folder = Path.GetDirectoryName(path) ?? "";
            for (int i = 0; i < file.masks.Count; i++)
            {
                var mask = file.masks[i];
                if (mask == null || string.IsNullOrEmpty(mask.file)) throw new Exception("masks[" + i + "].file missing");
                if (mask.resolution <= 0) throw new Exception("masks[" + i + "].resolution must be positive");
                if (mask.channels == null || mask.channels.Count == 0 || mask.channels.Count > 4) throw new Exception("masks[" + i + "].channels must list 1 to 4 item names");
                var png = Path.Combine(folder, mask.file);
                if (!File.Exists(png)) throw new Exception("Mask PNG missing: " + png);
                int w, h;
                if (!ReadPngSize(png, out w, out h)) throw new Exception("Not a PNG: " + png);
                if (w != mask.resolution || h != mask.resolution) throw new Exception(mask.file + " is " + w + "x" + h + ", expected " + mask.resolution + " square");
            }

            if (HasHeight(file))
            {
                var png = Path.Combine(folder, file.height.file);
                if (!File.Exists(png)) throw new Exception("Height mask PNG missing: " + png);
                int w, h;
                if (!ReadPngSize(png, out w, out h)) throw new Exception("Not a PNG: " + png);
                if (w != file.height.resolution || h != file.height.resolution) throw new Exception(file.height.file + " is " + w + "x" + h + ", expected " + file.height.resolution + " square");
                if (Mathf.Abs(file.height.rangeM - HeightRangeM) > 1e-3f) throw new Exception("height.rangeM is " + F(file.height.rangeM) + ", this importer reads " + F(HeightRangeM));
                if (file.height.items == null) file.height.items = new List<string>();
            }

            // Zone types first: item sources are checked against their slot keys.
            var keys = new HashSet<string>();
            var slots = new HashSet<string>();
            foreach (var type in file.zoneTypes)
            {
                if (type == null || string.IsNullOrEmpty(type.key)) throw new Exception("zoneTypes entry without key");
                if (!keys.Add(type.key)) throw new Exception("Duplicate zone type key " + type.key);
                slots.Add(type.key);
                type.items = CheckBindings(type.items, "Zone type " + type.key);
                if (type.variants == null) type.variants = new List<GolfMapZoneVariant>();
                var variantKeys = new HashSet<string>();
                foreach (var variant in type.variants)
                {
                    if (variant == null || string.IsNullOrEmpty(variant.key)) throw new Exception("Zone type " + type.key + " has a variant without key");
                    if (!variantKeys.Add(variant.key)) throw new Exception("Zone type " + type.key + " has duplicate variant key " + variant.key);
                    variant.items = CheckBindings(variant.items, "Zone type " + type.key + " variant " + variant.key);
                    slots.Add(SlotKey(type.key, variant.key));
                }
            }

            // Items: one channel each, and the mask manifest must say the same.
            var names = new HashSet<string>();
            for (int i = 0; i < file.items.Count; i++)
            {
                var item = file.items[i];
                if (item == null || string.IsNullOrEmpty(item.item)) throw new Exception("items[" + i + "] has no item name");
                if (!names.Add(item.item)) throw new Exception("Item '" + item.item + "' is listed twice in items[]");
                if (item.texture < 0 || item.texture >= file.masks.Count) throw new Exception("Item '" + item.item + "' names texture " + item.texture + " but there are " + file.masks.Count + " masks");
                if (item.channel < 0 || item.channel > 3) throw new Exception("Item '" + item.item + "' channel must be 0..3");
                var channels = file.masks[item.texture].channels;
                if (item.channel >= channels.Count || channels[item.channel] != item.item)
                    throw new Exception("Item '" + item.item + "' claims texture " + item.texture + " channel " + item.channel + " but masks[].channels says '" + (item.channel < channels.Count ? channels[item.channel] : "") + "'");
                if (item.sources == null) item.sources = new List<string>();
                foreach (var source in item.sources)
                    if (!slots.Contains(source)) file.warnings.Add("Item '" + item.item + "' names source '" + source + "', which is no zone type or variant in the file.");
            }
            for (int t = 0; t < file.masks.Count; t++)
                foreach (var channel in file.masks[t].channels)
                    if (!string.IsNullOrEmpty(channel) && !names.Contains(channel)) throw new Exception("masks[" + t + "] has a channel for '" + channel + "' but items[] has no entry for it");
            foreach (var type in file.zoneTypes)
            {
                foreach (var b in type.items)
                    if (!names.Contains(b.item)) file.warnings.Add("Zone type " + type.key + " binds '" + b.item + "' but items[] has no mask for it.");
                foreach (var v in type.variants)
                    foreach (var b in v.items)
                        if (!names.Contains(b.item)) file.warnings.Add("Zone type " + type.key + " variant " + v.key + " binds '" + b.item + "' but items[] has no mask for it.");
            }

            var ids = new HashSet<string>();
            for (int i = 0; i < file.zones.Count; i++)
            {
                var zone = file.zones[i];
                if (zone == null) throw new Exception("zones[" + i + "] is null");
                if (string.IsNullOrEmpty(zone.id)) zone.id = "zone-" + i;
                if (!ids.Add(zone.id)) throw new Exception("Duplicate zone id " + zone.id);
                if (!keys.Contains(zone.zoneType)) throw new Exception("Zone " + zone.id + " uses unknown zone type '" + zone.zoneType + "'");
                if (zone.variant == null) zone.variant = "";
                if (zone.variant.Length > 0 && !slots.Contains(SlotKey(zone.zoneType, zone.variant)))
                    file.warnings.Add("Zone " + zone.id + " names variant '" + zone.variant + "' that zone type " + zone.zoneType + " does not have.");
                if (zone.rings == null) zone.rings = new List<GolfMapZoneRing>();
                foreach (var ring in zone.rings)
                {
                    if (ring == null || ring.nodes == null) throw new Exception("Zone " + zone.id + " has an empty ring");
                    foreach (var node in ring.nodes)
                        if (node == null || !Finite(node.x) || !Finite(node.z)) throw new Exception("Zone " + zone.id + " has an invalid node");
                }
            }
            return file;
        }

        // Blank item names are dropped (the pipeline skips them too); ranges must be sane.
        static List<GolfMapZoneItemBinding> CheckBindings(List<GolfMapZoneItemBinding> bindings, string owner)
        {
            if (bindings == null) return new List<GolfMapZoneItemBinding>();
            bindings = bindings.Where(b => b != null && (b.item ?? "").Trim().Length > 0).ToList();
            foreach (var binding in bindings)
                if (!Finite(binding.minDensity) || !Finite(binding.maxDensity) || binding.minDensity < 0 || binding.maxDensity > 1 || binding.maxDensity < binding.minDensity)
                    throw new Exception(owner + " item '" + binding.item + "' density range must satisfy 0 <= min <= max <= 1");
            return bindings;
        }

        // Display name of a zone's variant: "Default" for none.
        public static string VariantName(GolfMapZoneType type, string variant)
        {
            if (string.IsNullOrEmpty(variant)) return "Default";
            var v = type == null ? null : type.variants.FirstOrDefault(x => x.key == variant);
            return v == null ? variant + " (unknown)" : (string.IsNullOrEmpty(v.name) ? v.key : v.name);
        }

        // Width and height from the IHDR chunk; false when the signature does not match.
        public static bool ReadPngSize(string path, out int width, out int height)
        {
            width = height = 0;
            using (var stream = File.OpenRead(path))
            {
                var header = new byte[24];
                if (stream.Read(header, 0, 24) != 24) return false;
                byte[] signature = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
                for (int i = 0; i < 8; i++) if (header[i] != signature[i]) return false;
                if (header[12] != (byte)'I' || header[13] != (byte)'H' || header[14] != (byte)'D' || header[15] != (byte)'R') return false;
                width = (header[16] << 24) | (header[17] << 16) | (header[18] << 8) | header[19];
                height = (header[20] << 24) | (header[21] << 16) | (header[22] << 8) | header[23];
                return width > 0 && height > 0;
            }
        }

        // "vreta-inner-zones.json" -> "Vreta": the course folder under Assets/GolfMap/,
        // mirroring where the trees file and catalogues live.
        public static string CourseName(string zonesPath, GolfMapTreePlot plot)
        {
            var name = Path.GetFileNameWithoutExtension(zonesPath) ?? "";
            if (name.EndsWith("-zones", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 6);
            if (plot != null && !string.IsNullOrEmpty(plot.terrain) && name.EndsWith("-" + plot.terrain, StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - plot.terrain.Length - 1);
            int dash = name.IndexOf('-');
            if (dash > 0) name = name.Substring(0, dash);
            if (name.Length == 0) return "Course";
            return char.ToUpperInvariant(name[0]) + name.Substring(1);
        }

        public static Color ParseColor(string html, Color fallback)
        {
            Color c;
            if (!string.IsNullOrEmpty(html) && ColorUtility.TryParseHtmlString(html, out c)) return c;
            return fallback;
        }

        // Area-weighted centroid of the first ring (the outer one), plot-local metres.
        public static Vector2 Centroid(GolfMapZone zone)
        {
            if (zone.rings.Count == 0 || zone.rings[0].nodes.Count == 0) return Vector2.zero;
            var nodes = zone.rings[0].nodes;
            double area = 0, cx = 0, cz = 0;
            for (int i = 0, j = nodes.Count - 1; i < nodes.Count; j = i++)
            {
                double cross = (double)nodes[j].x * nodes[i].z - (double)nodes[i].x * nodes[j].z;
                area += cross;
                cx += (nodes[j].x + nodes[i].x) * cross;
                cz += (nodes[j].z + nodes[i].z) * cross;
            }
            if (Math.Abs(area) < 1e-6)
            {
                float sx = 0, sz = 0;
                foreach (var n in nodes) { sx += n.x; sz += n.z; }
                return new Vector2(sx / nodes.Count, sz / nodes.Count);
            }
            area *= 0.5;
            return new Vector2((float)(cx / (6 * area)), (float)(cz / (6 * area)));
        }

        public static string F(float v) { return v.ToString("0.##", CultureInfo.InvariantCulture); }
    }
}
