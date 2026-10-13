// Arborist's own operations as named commands: the asset catalogue, biomes (Arborist's word for a
// VSP vegetation package), adding a species the way the UI's "add" does it (Arborist loads the
// prefab, sets its default item settings and bakes the billboards), and exporting a biome file.
// Arborist's members are reached by reflection: most are private or static UI state.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using AwesomeTechnologies.VegetationSystem;
using UnityEngine;

namespace GolfMap.Bridge
{
    static class ArboristCommands
    {
        const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.FlattenHierarchy;

        static Type TypeNamed(string fullName)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                var t = assembly.GetType(fullName, false);
                if (t != null) return t;
            }
            throw new BridgeError("This build of Arborist has no type " + fullName + ".");
        }

        static Type Menu { get { return TypeNamed("OPCD_Arborist.MenuSystem"); } }

        static object MenuInstance()
        {
            var menu = Resources.FindObjectsOfTypeAll(Menu).FirstOrDefault();
            if (!menu) throw new BridgeError("Arborist's MenuSystem is not loaded yet.");
            return menu;
        }

        static object Field(Type type, object target, string name)
        {
            var f = type.GetField(name, Any);
            if (f == null) throw new BridgeError(type.Name + " has no field " + name + " in this build of Arborist.");
            return f.GetValue(f.IsStatic ? null : target);
        }

        static object Invoke(Type type, object target, string name, params object[] args)
        {
            var m = type.GetMethods(Any).FirstOrDefault(x => x.Name == name && x.GetParameters().Length == args.Length &&
                x.GetParameters().Select((p, i) => args[i] == null || p.ParameterType.IsInstanceOfType(args[i])).All(ok => ok));
            if (m == null) throw new BridgeError(type.Name + " has no method " + name + " taking these " + args.Length + " argument(s) in this build of Arborist.");
            try { return m.Invoke(m.IsStatic ? null : target, args); }
            catch (TargetInvocationException e) { throw e.InnerException ?? e; }
        }

        // The system Arborist edits, not the course's own or the 3D browser's.
        static VegetationSystemPro ArbSystem()
        {
            var system = Resources.FindObjectsOfTypeAll<VegetationSystemPro>().FirstOrDefault(s => s.gameObject.scene.IsValid() && s.name == "ArbVegetationSystemPro");
            if (!system) throw new BridgeError("No ArbVegetationSystemPro: open a course in Arborist first.");
            return system;
        }

        static int BiomeIndex(VegetationSystemPro system, BridgeArgs a)
        {
            var list = system.VegetationPackageProList;
            string key = a.Require("biome");
            int index;
            if (int.TryParse(key, out index))
            {
                if (index < 0 || index >= list.Count) throw new BridgeError("Arborist has " + list.Count + " biome(s).");
                return index;
            }
            var hits = Enumerable.Range(0, list.Count).Where(i => list[i] && list[i].PackageName == key).ToList();
            if (hits.Count != 1) throw new BridgeError(hits.Count + " biomes are named '" + key + "'; give its index.");
            return hits[0];
        }

        static Dictionary<string, object> ItemRow(VegetationItemInfoPro i)
        {
            return new Dictionary<string, object>
            {
                { "name", i.Name }, { "id", i.VegetationItemID }, { "type", i.VegetationType.ToString() }, { "spawn", i.EnableRuntimeSpawn },
                { "sampleDistance", i.SampleDistance }, { "density", i.Density }, { "minScale", i.MinScale }, { "maxScale", i.MaxScale },
                { "billboards", i.UseBillboards }, { "collider", i.ColliderType.ToString() }, { "shader", i.ShaderName },
            };
        }

        // As golfmap.trees.dump measures a course's own tree prefabs (GolfMapVspStatus.ModelSize): the
        // first LOD's mesh, height above the prefab's origin and the wider horizontal extent.
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

        [BridgeCommand("arb.catalog", "Arborist's asset catalogue: prefabs or grass textures whose address contains `contains`; sizes=true adds each prefab's model size (widthM, heightM of its first LOD).",
            args = "contains, kind=prefab|texture, limit=60, sizes=false")]
        static object Catalog(BridgeArgs a)
        {
            string contains = a.String("contains", "");
            var list = (IEnumerable)Field(Menu, null, a.String("kind", "prefab") == "texture" ? "texaddressables" : "prefabaddressables");
            if (list == null) throw new BridgeError("The catalogue is not loaded yet.");
            var rows = new List<object>();
            int total = 0;
            foreach (var asset in list)
            {
                var t = asset.GetType();
                string address = (string)Field(t, asset, "address");
                if (address == null || address.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) continue;
                total++;
                if (rows.Count < a.Int("limit", 60))
                {
                    var row = new Dictionary<string, object> { { "address", address }, { "label", Field(t, asset, "label") }, { "trisLod0", Field(t, asset, "tricountLOD0") } };
                    var prefab = a.Bool("sizes", false) ? Field(t, asset, "prefab") as GameObject : null;
                    if (prefab) { var size = ModelSize(prefab); row["widthM"] = size.x; row["heightM"] = size.y; }
                    rows.Add(row);
                }
            }
            return new Dictionary<string, object> { { "matched", total }, { "assets", rows } };
        }

        [BridgeCommand("arb.biomes", "The biomes (vegetation packages) of the course open in Arborist: index, name, biome type, and with items=true each item's main settings.",
            args = "items=false")]
        static object Biomes(BridgeArgs a)
        {
            var system = ArbSystem();
            var active = Field(Menu, null, "activeVSProBiome") as VegetationPackagePro;
            return system.VegetationPackageProList.Select((p, i) =>
            {
                var row = new Dictionary<string, object>
                {
                    { "index", i }, { "name", p ? p.PackageName : null }, { "biomeType", p ? p.BiomeType.ToString() : null },
                    { "items", p ? p.VegetationInfoList.Count : 0 }, { "textureMaskGroups", p ? p.TextureMaskGroupList.Count : 0 }, { "active", p && p == active },
                };
                if (p && a.Bool("items", false)) row["itemList"] = p.VegetationInfoList.Select(x => (object)ItemRow(x)).ToList();
                return (object)row;
            }).ToList();
        }

        static bool SetFloats(object settings, Dictionary<string, object> floats)
        {
            if (settings == null || floats == null) return false;
            var list = Field(settings.GetType(), settings, "ControlerPropertyList") as IEnumerable;
            if (list == null) return false;
            bool any = false;
            foreach (var p in list)
            {
                var t = p.GetType();
                object value;
                if (!floats.TryGetValue((string)Field(t, p, "PropertyName"), out value)) continue;
                t.GetField("FloatValue").SetValue(p, Convert.ToSingle(value, System.Globalization.CultureInfo.InvariantCulture));
                any = true;
            }
            return any;
        }

        static bool SetColours(object settings, Color? leaf, Color? bark, float? saturation)
        {
            if (settings == null) return false;
            var list = Field(settings.GetType(), settings, "ControlerPropertyList") as IEnumerable;
            if (list == null) return false;
            bool any = false;
            foreach (var p in list)
            {
                var t = p.GetType();
                string name = (string)Field(t, p, "PropertyName");
                if (leaf.HasValue && (name == "TintColor1" || name == "TintColor2" || name == "HealthyColorTint" || name == "DryColorTint")) { t.GetField("ColorValue").SetValue(p, leaf.Value); any = true; }
                else if (bark.HasValue && (name == "BarkColor" || name == "BarkTintColor" || name == "BarkTint")) { t.GetField("ColorValue").SetValue(p, bark.Value); any = true; }
                else if (saturation.HasValue && name == "TextureSaturation") { t.GetField("FloatValue").SetValue(p, saturation.Value); any = true; }
            }
            return any;
        }

        static Color Hex(string value)
        {
            Color c;
            if (!ColorUtility.TryParseHtmlString(value.StartsWith("#") ? value : "#" + value, out c)) throw new BridgeError("'" + value + "' is not a #rrggbb colour.");
            return c;
        }

        [BridgeCommand("arb.tint", "Set the leaf tint (both of the shader's leaf tones, so the crown is one even colour), bark tint and/or texture saturation of every item whose name contains `item`, in all of Arborist's biomes, and refresh the materials: the change shows at once and is not saved anywhere but in the open session.",
            args = "item (required, part of the item name; \"\" = every item), leaf (#rrggbb), bark (#rrggbb), saturation (0-1), floats ({shader property: value}, e.g. AOPower, Smoothness, OcclusionStrength), lodFactor")]
        static object Tint(BridgeArgs a)
        {
            string match = a.String("item", "");
            Color? leaf = a.Has("leaf") ? Hex(a.String("leaf")) : (Color?)null;
            Color? bark = a.Has("bark") ? Hex(a.String("bark")) : (Color?)null;
            float? saturation = a.Has("saturation") ? (float)a.Number("saturation", 1) : (float?)null;
            var floats = a.Raw("floats") as Dictionary<string, object>;
            var system = ArbSystem();
            var changed = new List<object>();
            foreach (var package in system.VegetationPackageProList.Where(p => p))
                foreach (var item in package.VegetationInfoList.Where(i => i.Name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    bool any = SetColours(item.ShaderControllerSettings, leaf, bark, saturation) | SetFloats(item.ShaderControllerSettings, floats);
                    if (a.Has("lodFactor")) { item.LODFactor = (float)a.Number("lodFactor", 1); any = true; }
                    var arrayField = item.GetType().GetField("ShaderControllerSettingsArray");
                    var array = arrayField != null ? arrayField.GetValue(item) as IEnumerable : null;
                    if (array != null) foreach (var block in array) any |= SetColours(block, leaf, bark, saturation) | SetFloats(block, floats);
                    if (any) changed.Add(package.PackageName + " / " + item.Name);
                }
            if (a.Has("lodFactor")) system.RefreshVegetationSystem(); else system.RefreshMaterials();
            return new Dictionary<string, object> { { "changed", changed.Count } };
        }

        [BridgeCommand("arb.biome.new", "Add an empty biome, as Arborist's own 'new biome' does, and make it the active one. Not saved until the course is saved in Arborist.",
            args = "name (required)")]
        static object BiomeNew(BridgeArgs a)
        {
            string name = a.Require("name");
            var system = ArbSystem();
            int before = system.VegetationPackageProList.Count;
            Invoke(Menu, MenuInstance(), "AddNewBiome");
            if (system.VegetationPackageProList.Count != before + 1) throw new BridgeError("Arborist did not add a biome.");
            var package = system.VegetationPackageProList[before];
            package.PackageName = name;
            Invoke(Menu, null, "_EditBiome_BiomeChanged", before);
            return new Dictionary<string, object> { { "index", before }, { "name", package.PackageName }, { "biomeType", package.BiomeType.ToString() } };
        }

        [BridgeCommand("arb.biome.add", "Add a catalogue asset to a biome the way Arborist's UI does: Arborist loads it, sets its default item settings and bakes its billboards. Returns the item it made.",
            args = "biome (index or name, required), address (required, from arb.catalog), type=Tree|Plant|Grass|Objects|LargeObjects (default Tree), spawn (true|false: set EnableRuntimeSpawn after adding)")]
        static IEnumerator BiomeAdd(BridgeArgs a)
        {
            var system = ArbSystem();
            int index = BiomeIndex(system, a);
            var package = system.VegetationPackageProList[index];
            string address = a.Require("address");
            var type = (VegetationType)Enum.Parse(typeof(VegetationType), a.String("type", "Tree"), true);
            Invoke(Menu, null, "_EditBiome_BiomeChanged", index);
            int before = package.VegetationInfoList.Count;
            PlayerBridge.Run((IEnumerator)Invoke(Menu, MenuInstance(), "_addPrefab", address, type, true));
            for (int frame = 0; frame < 1800 && package.VegetationInfoList.Count == before; frame++) yield return null;
            if (package.VegetationInfoList.Count == before) throw new BridgeError("Arborist did not add '" + address + "' within 1800 frames (wrong address or type?).");
            for (int frame = 0; frame < 10; frame++) yield return null;   // the billboard bake finishes a few frames on
            var item = package.VegetationInfoList[package.VegetationInfoList.Count - 1];
            if (a.Has("spawn")) item.EnableRuntimeSpawn = a.Bool("spawn", true);
            var row = ItemRow(item);
            row["biome"] = package.PackageName;
            row["hasBillboard"] = item.BillboardTexture != null;
            yield return row;
        }

        [BridgeCommand("arb.biome.export", "Write a biome to a .biome file with Arborist's own exporter (the same JSON a shared biome is).",
            args = "biome (index or name, required), file (required, absolute path)")]
        static object BiomeExport(BridgeArgs a)
        {
            var system = ArbSystem();
            var package = system.VegetationPackageProList[BiomeIndex(system, a)];
            string file = a.Require("file");
            if (!Path.IsPathRooted(file)) throw new BridgeError("file must be an absolute path.");
            Directory.CreateDirectory(Path.GetDirectoryName(file));
            var exporterType = TypeNamed("AAT.ExportVSPro");
            object exporter = typeof(UnityEngine.Object).IsAssignableFrom(exporterType)
                ? (object)Resources.FindObjectsOfTypeAll(exporterType).FirstOrDefault()
                : Activator.CreateInstance(exporterType, true);
            if (exporter == null || exporter.Equals(null)) throw new BridgeError("No ExportVSPro object is loaded.");
            Invoke(exporterType, exporter, "ExportBiome", file, package);
            return new Dictionary<string, object> { { "file", file.Replace('\\', '/') }, { "bytes", File.Exists(file) ? new FileInfo(file).Length : 0 }, { "biome", package.PackageName }, { "items", package.VegetationInfoList.Count } };
        }
    }
}
