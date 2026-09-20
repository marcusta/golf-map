// Model and loader for a golf-map "unity-zones-v1" export: vegetation zones
// rasterised into RGBA texture masks for Vegetation Studio Pro (one channel
// per zone type), plus the zone polygons for the Scene-view overlay and the
// item bindings the importer turns into VSP texture mask rules.
// See docs/feature-vegetation-zones.md section 7 and unity/README.md.
//
// Plain JsonUtility classes: objects and lists only, no dictionaries. The plot
// record is shared with unity-trees-v1 (GolfMapTreePlot) so terrain matching
// by bounds is the same code path as the tree planter's.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using UnityEngine;

namespace GolfMap.Editor
{
    [Serializable]
    public class GolfMapZoneFile
    {
        public string format;
        public GolfMapTreePlot plot;
        public List<GolfMapZoneMask> masks;
        public List<GolfMapZoneType> zoneTypes;
        public List<GolfMapZone> zones;
    }

    [Serializable]
    public class GolfMapZoneMask
    {
        public string file;              // PNG next to the JSON
        public int resolution;           // square, pixels
        public List<string> channels;    // zone type key per channel R, G, B, A ("" = unused)
    }

    [Serializable]
    public class GolfMapZoneType
    {
        public string key;
        public string name;
        public string color;             // "#rrggbb" for the overlay
        public int texture;              // index into masks
        public int channel;              // 0 R, 1 G, 2 B, 3 A
        public List<GolfMapZoneItemBinding> items;
    }

    [Serializable]
    public class GolfMapZoneItemBinding
    {
        public string item;              // VegetationItemInfoPro.Name in the package
        public float minDensity;
        public float maxDensity = 1;
    }

    [Serializable]
    public class GolfMapZone
    {
        public string id;
        public string zoneType;
        public float weight = 1;
        public float feather = 2;
        public float noise;
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
        public const string Format = "unity-zones-v1";
        // Texture mask groups the importer owns are named after the zone type key so a
        // re-import finds and updates them in place.
        public const string GroupPrefix = "golfmap-zone:";

        public static string GroupName(string key) { return GroupPrefix + key; }

        public static bool IsGroupName(string name) { return name != null && name.StartsWith(GroupPrefix, StringComparison.Ordinal); }

        public static string KeyFromGroupName(string name) { return IsGroupName(name) ? name.Substring(GroupPrefix.Length) : null; }

        static bool Finite(float v) { return !float.IsNaN(v) && !float.IsInfinity(v); }

        // Reads and validates the file. Mask PNGs are checked for existence and size from
        // their header, not loaded: a 4096 RGBA mask is 64 MB and the importer loads it
        // once, through the asset pipeline.
        public static GolfMapZoneFile Load(string path)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) throw new Exception("Zones file not found: " + path);
            var file = JsonUtility.FromJson<GolfMapZoneFile>(File.ReadAllText(path).TrimStart('﻿'));
            if (file == null || file.format != Format) throw new Exception("format must be " + Format);
            if (file.plot == null || !(file.plot.sizeM > 0) || !Finite(file.plot.sizeM)) throw new Exception("plot.sizeM missing");
            if (file.plot.terrain != "inner" && file.plot.terrain != "outer") throw new Exception("plot.terrain must be inner or outer");
            if (file.masks == null || file.masks.Count == 0) throw new Exception("masks missing");
            if (file.zoneTypes == null) file.zoneTypes = new List<GolfMapZoneType>();
            if (file.zones == null) file.zones = new List<GolfMapZone>();

            var folder = Path.GetDirectoryName(path) ?? "";
            for (int i = 0; i < file.masks.Count; i++)
            {
                var mask = file.masks[i];
                if (mask == null || string.IsNullOrEmpty(mask.file)) throw new Exception("masks[" + i + "].file missing");
                if (mask.resolution <= 0) throw new Exception("masks[" + i + "].resolution must be positive");
                if (mask.channels == null || mask.channels.Count == 0 || mask.channels.Count > 4) throw new Exception("masks[" + i + "].channels must list 1 to 4 zone type keys");
                var png = Path.Combine(folder, mask.file);
                if (!File.Exists(png)) throw new Exception("Mask PNG missing: " + png);
                int w, h;
                if (!ReadPngSize(png, out w, out h)) throw new Exception("Not a PNG: " + png);
                if (w != mask.resolution || h != mask.resolution) throw new Exception(mask.file + " is " + w + "x" + h + ", expected " + mask.resolution + " square");
            }

            var keys = new HashSet<string>();
            foreach (var type in file.zoneTypes)
            {
                if (type == null || string.IsNullOrEmpty(type.key)) throw new Exception("zoneTypes entry without key");
                if (!keys.Add(type.key)) throw new Exception("Duplicate zone type key " + type.key);
                if (type.texture < 0 || type.texture >= file.masks.Count) throw new Exception("Zone type " + type.key + " names texture " + type.texture + " but there are " + file.masks.Count + " masks");
                if (type.channel < 0 || type.channel > 3) throw new Exception("Zone type " + type.key + " channel must be 0..3");
                var channels = file.masks[type.texture].channels;
                if (type.channel >= channels.Count || channels[type.channel] != type.key)
                    throw new Exception("Zone type " + type.key + " claims texture " + type.texture + " channel " + type.channel + " but masks[].channels says '" + (type.channel < channels.Count ? channels[type.channel] : "") + "'");
                if (type.items == null) type.items = new List<GolfMapZoneItemBinding>();
                foreach (var binding in type.items)
                {
                    if (binding == null || string.IsNullOrEmpty(binding.item)) throw new Exception("Zone type " + type.key + " has an item binding without a name");
                    if (!Finite(binding.minDensity) || !Finite(binding.maxDensity) || binding.minDensity < 0 || binding.maxDensity > 1 || binding.maxDensity < binding.minDensity)
                        throw new Exception("Zone type " + type.key + " item '" + binding.item + "' density range must satisfy 0 <= min <= max <= 1");
                }
            }

            var ids = new HashSet<string>();
            for (int i = 0; i < file.zones.Count; i++)
            {
                var zone = file.zones[i];
                if (zone == null) throw new Exception("zones[" + i + "] is null");
                if (string.IsNullOrEmpty(zone.id)) zone.id = "zone-" + i;
                if (!ids.Add(zone.id)) throw new Exception("Duplicate zone id " + zone.id);
                if (!keys.Contains(zone.zoneType)) throw new Exception("Zone " + zone.id + " uses unknown zone type '" + zone.zoneType + "'");
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
