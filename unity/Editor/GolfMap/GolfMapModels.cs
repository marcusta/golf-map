// The course's model library (models.json beside palette.json, golfmap-models-v1; CONTEXT.md "Model
// library"): every tree model the course can draw, where it is drawn and its size. The palette refers
// to it by model id ('arborist:<Arborist catalogue label>' or 'vsp:<Unity prefab>'); GolfMapPalette.Load
// resolves those references through it, as shared/vegetation/tree-models.ts does for the matcher in node.
// The repo keeps a copy at docs/gspro/<course>/models.json, equal to this one.
//
// Only a vsp model is a prefab of this project (its "unity" node: guid, path, assetType, catalogueGuid,
// originalPath). An Arborist model has no prefab here: the planter writes its trees as placements for
// the Arborist writer (pipeline/arborist.py trees) and keeps them out of the course's VSP.
//
// The model id is parsed and built only here in C# (Parse, Id); the twins are shared/vegetation/model-id.ts
// and pipeline/arborist.py model_id/parse_model_id. A model's renderer is its id's: a library entry whose
// "renderer" says otherwise is refused. The rules for a new model (Kinds, Forms, catalogue labels trimmed,
// the first of a duplicated label) are the same in shared/vegetation/tree-models.ts; keep the two equal.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace GolfMap.Editor
{
    public static class GolfMapModels
    {
        public const string Format = "golfmap-models-v1";
        public const string FileName = "models.json";
        // What draws a model in GSPro.
        public const string Arborist = "arborist", Vsp = "vsp";
        public static readonly string[] Kinds = { "broadleaf", "conifer" };
        public static readonly string[] Forms = { "tree", "shrub" };

        public static string PathBeside(string palettePath) { return Path.Combine(Path.GetDirectoryName(palettePath) ?? "", FileName).Replace('\\', '/'); }

        // ('vsp', 'PF_Oak_tall Terrain') -> 'vsp:PF_Oak_tall Terrain'.
        public static string Id(string renderer, string label) { return renderer + ":" + label; }

        // 'arborist:S7_American_Elm' -> arborist, S7_American_Elm; false for an id of any other shape.
        public static bool TryParse(string id, out string renderer, out string label)
        {
            int colon = id == null ? -1 : id.IndexOf(':');
            renderer = colon > 0 ? id.Substring(0, colon) : null;
            label = colon > 0 ? id.Substring(colon + 1) : null;
            if ((renderer == Arborist || renderer == Vsp) && label.Length > 0) return true;
            renderer = label = null;
            return false;
        }

        public static void Parse(string id, out string renderer, out string label)
        {
            if (!TryParse(id, out renderer, out label)) throw new Exception("Invalid model id '" + id + "': expected arborist:<catalogue label> or vsp:<Unity prefab>.");
        }

        public static string Label(string id) { string renderer, label; Parse(id, out renderer, out label); return label; }

        // id -> model node; empty when the course has no library yet.
        public static Dictionary<string, GolfMapJsonObject> Load(string path)
        {
            var result = new Dictionary<string, GolfMapJsonObject>();
            if (!File.Exists(path)) return result;
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var models = doc.Array("models");
            if (doc.String("format") != Format || models == null) throw new Exception("Invalid model library " + path + ": format must be " + Format + ".");
            foreach (var entry in models)
            {
                var o = entry as GolfMapJsonObject;
                var id = o == null ? null : o.String("id");
                if (string.IsNullOrEmpty(id)) throw new Exception("A model without an id in " + path + ".");
                if (result.ContainsKey(id)) throw new Exception("Model " + id + " is in " + path + " twice.");
                string renderer, label; Parse(id, out renderer, out label);
                var said = o.String("renderer");
                if (said != null && said != renderer) throw new Exception("Model " + id + " in " + path + " says renderer '" + said + "', but its id is " + renderer + "'s.");
                result[id] = o;
            }
            return result;
        }

        // A library model as the matcher's asset (enabled and share come from the palette).
        public static GolfMapBiomeAsset Asset(GolfMapJsonObject m)
        {
            var id = m.String("id");
            string renderer, label; Parse(id, out renderer, out label);
            var unity = m.Object("unity");
            var unityGuid = unity == null ? null : unity.String("guid");
            return new GolfMapBiomeAsset
            {
                model = id, renderer = renderer, fromLibrary = true,
                guid = string.IsNullOrEmpty(unityGuid) ? null : unityGuid, name = label,
                path = unity == null ? null : unity.String("path"), assetType = unity == null ? null : unity.String("assetType"),
                catalogueGuid = unity == null ? null : unity.String("catalogueGuid"),
                species = m.String("species"), kind = m.String("kind"), form = m.String("form"),
                heightM = m.Number("heightM"), crownWidthM = m.Number("crownWidthM"),
            };
        }

        public struct CatalogueModel { public string label; public double heightM, crownWidthM; }

        // Arborist's model sizes (data/arborist/catalog-sizes.json in the golf-map repo: the mod's arb.catalog
        // with sizes), by label without the trailing spaces some labels have; the first of a label counts.
        public static Dictionary<string, CatalogueModel> ArboristCatalogue(string file)
        {
            var doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(file));
            var result = doc.Object("result");
            var assets = (result != null ? result.Array("assets") : null) ?? doc.Array("assets");
            if (assets == null) throw new Exception("No assets in Arborist's catalogue sizes " + file + ".");
            var models = new Dictionary<string, CatalogueModel>();
            foreach (var a in assets.OfType<GolfMapJsonObject>())
            {
                var label = (a.String("label") ?? "").Trim();
                double h = a.Number("heightM"), w = a.Number("widthM");
                if (label.Length > 0 && h > 0 && w > 0 && !models.ContainsKey(label)) models[label] = new CatalogueModel { label = label, heightM = h, crownWidthM = w };
            }
            return models;
        }

        // Adds an Arborist model, sized from Arborist's catalogue, to the library at `path` (bun run models --
        // add does the same on the repo's copy). Refuses a label Arborist lacks and an id already there.
        public static GolfMapBiomeAsset AddArborist(string path, string label, string species, string kind, string form, string catalogueFile)
        {
            label = (label ?? "").Trim();
            if (string.IsNullOrEmpty(species)) throw new Exception("A model needs its species.");
            if (!Kinds.Contains(kind)) throw new Exception("kind must be broadleaf or conifer.");
            if (!Forms.Contains(form)) throw new Exception("form must be tree or shrub.");
            CatalogueModel size;
            if (!ArboristCatalogue(catalogueFile).TryGetValue(label, out size)) throw new Exception("Arborist has no model '" + label + "' (not in " + catalogueFile + ").");
            var id = Id(Arborist, label);
            GolfMapJsonObject doc;
            if (File.Exists(path)) doc = GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            else { doc = new GolfMapJsonObject(); doc.SetString("format", Format); doc["models"] = new List<object>(); }
            if (doc.String("format") != Format || doc.Array("models") == null) throw new Exception("Invalid model library " + path + ".");
            if (doc.Array("models").OfType<GolfMapJsonObject>().Any(m => m.String("id") == id)) throw new Exception(id + " is already in the model library.");
            var model = new GolfMapJsonObject();
            model.SetString("id", id); model.SetString("species", species); model.SetString("renderer", Arborist);
            model.SetNumber("heightM", size.heightM); model.SetNumber("crownWidthM", size.crownWidthM);
            model.SetString("kind", kind); model.SetString("form", form);
            doc.Array("models").Add(model);
            File.WriteAllText(path, GolfMapJsonDoc.Write(doc));
            return Asset(model);
        }
    }
}
