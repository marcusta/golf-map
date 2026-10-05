using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace GolfMap.Editor
{
    [Serializable] public class GolfMapBiome
    {
        public string format, seed;
        public GolfMapBiomeRules rules;
        public List<GolfMapBiomeAsset> assets;
        public List<GolfMapBiomeSpecies> species=new List<GolfMapBiomeSpecies>();
        public GolfMapBiomeSpecies Species(string label) { foreach(var s in species)if(s.name==label)return s;return null; }
        // What a match plants: the asset itself, or its generated copy for a look with its own materials.
        public string PrefabKey(GolfMapBiomeMatch m)
        {
            if(m.look==null)return m.asset.guid;
            var group=Species(m.asset.Label);
            var look=group==null?null:group.looks.FirstOrDefault(l=>l.id==m.look);
            return look==null||look.original?m.asset.guid:LookKey(m.asset.guid,m.look);
        }
        public static string LookKey(string guid,string look) { return guid+":"+look; }
    }
    // A species groups shapes (assets: sizes and LOD sets) under looks (material settings).
    public class GolfMapBiomeSpecies
    {
        public string name;
        public List<GolfMapBiomeLook> looks=new List<GolfMapBiomeLook>();
    }
    public class GolfMapBiomeLook
    {
        public string id;
        public double weight;
        public List<string> shapes;   // asset guids; null = every shape of the species
        // The source prefabs and materials as they are. Every other look plants generated copies
        // (GolfMapLooks) whose material settings the look's "materials" node records.
        public bool original;
        public GolfMapJsonObject node; // the look as the file holds it, with whatever this class does not model
    }
    [Serializable] public class GolfMapBiomeRules
    {
        public double minScale, maxScale, variationBand, maxWidthError, maxHeightError, scalePenalty, shrubMaxHeightM, speciesFitSlack;
        public GolfMapSpeciesWeights speciesWeights;
        public double woodlandRadiusM, woodlandCrownMultiplier, woodlandWidthWeight, woodlandScaleBoost;
        public int woodlandMinNeighbours;
        public double woodlandSpeciesFitSlack;
        public double scaleJitter, maxLeanDeg;   // cosmetic per-stem variety; 0 = off
    }
    // Species -> share of the broadleaf species race. A map, not fields, so a palette can
    // name any species; order is the file's.
    public class GolfMapSpeciesWeights
    {
        public readonly List<string> species=new List<string>();
        readonly Dictionary<string,double> weights=new Dictionary<string,double>();
        public double Weight(string name) { double w;return name!=null&&weights.TryGetValue(name,out w)?w:0; }
        public void Set(string name,double weight) { if(!weights.ContainsKey(name))species.Add(name);weights[name]=weight; }
        public void Remove(string name) { if(weights.Remove(name))species.Remove(name); }
    }
    [Serializable] public class GolfMapBiomeAsset
    {
        public string guid, catalogueGuid, name, path, kind, form, species, assetType;
        public double heightM, crownWidthM, selectionWeight;
        public bool enabled=true;
        // An asset without a species races, and is looked up, under its kind.
        public string Label { get { return string.IsNullOrEmpty(species)?kind:species; } }
    }
    // A tree species area's mix (the trees export's `areas`, shared/features/tree-areas.ts).
    public class GolfMapAreaMix
    {
        public readonly Dictionary<string,double> weights=new Dictionary<string,double>();
        public bool ignoreKind;
        public double Weight(string species) { double w;return species!=null&&weights.TryGetValue(species,out w)?w:0; }
    }
    public class GolfMapBiomeMatch
    {
        public GolfMapBiomeAsset asset;
        public double scale, heightError, widthError, score, rotation;
        public double lean, leanDirection;   // degrees of tilt off vertical, and its heading relative to rotation
        public double widthScale;   // 0 = uniform (scale); set for hand-edited stems on mesh terrains
        public bool review;
        public string look;         // id of the drawn look; null when the species defines none
    }
    // palette.json <-> GolfMapBiome. The document keeps everything the classes do not model
    // (catalogue, zones, originalPath ...), so Save only rewrites what was edited.
    public static class GolfMapPalette
    {
        public const string Format="golfmap-tree-palette-v1";
        static readonly FieldInfo[] RuleNumbers=typeof(GolfMapBiomeRules).GetFields().Where(f=>f.FieldType==typeof(double)).ToArray();

        public static GolfMapBiome Load(string path,out GolfMapJsonObject doc)
        {
            doc=GolfMapJsonDoc.ParseObject(File.ReadAllText(path));
            var rules=doc.Object("rules");var assets=doc.Array("assets");
            if(doc.String("format")!=Format||rules==null||assets==null)throw new Exception("Invalid biome palette: "+path);
            var biome=new GolfMapBiome {format=Format,seed=doc.String("seed"),rules=new GolfMapBiomeRules(),assets=new List<GolfMapBiomeAsset>()};
            foreach(var f in RuleNumbers)f.SetValue(biome.rules,rules.Number(f.Name));
            biome.rules.woodlandMinNeighbours=(int)rules.Number("woodlandMinNeighbours");
            var weights=rules.Object("speciesWeights");
            if(weights!=null){
                biome.rules.speciesWeights=new GolfMapSpeciesWeights();
                foreach(var key in weights.keys)biome.rules.speciesWeights.Set(key,weights.Number(key));
            }
            var speciesDoc=doc.Object("species");
            if(speciesDoc!=null)foreach(var name in speciesDoc.keys){
                var group=new GolfMapBiomeSpecies {name=name};
                var looks=speciesDoc.Object(name)!=null?speciesDoc.Object(name).Array("looks"):null;
                if(looks!=null)foreach(var entry in looks){
                    var o=entry as GolfMapJsonObject;if(o==null||string.IsNullOrEmpty(o.String("id")))throw new Exception("Invalid look under species "+name+".");
                    var shapes=o.Array("shapes");
                    group.looks.Add(new GolfMapBiomeLook {id=o.String("id"),weight=o.Number("weight"),original=o.Bool("original",false),node=o,shapes=shapes==null?null:shapes.Select(g=>g as string).ToList()});
                }
                biome.species.Add(group);
            }
            foreach(var entry in assets){
                var o=entry as GolfMapJsonObject;if(o==null)throw new Exception("Invalid biome asset entry.");
                biome.assets.Add(new GolfMapBiomeAsset {guid=o.String("guid"),catalogueGuid=o.String("catalogueGuid"),name=o.String("name"),path=o.String("path"),
                    kind=o.String("kind"),form=o.String("form"),species=o.String("species"),assetType=o.String("assetType"),
                    heightM=o.Number("heightM"),crownWidthM=o.Number("crownWidthM"),selectionWeight=o.Number("selectionWeight"),enabled=o.Bool("enabled",true)});
            }
            return biome;
        }

        public static GolfMapBiome Load(string path) { GolfMapJsonObject doc;return Load(path,out doc); }

        public static void Save(string path,GolfMapBiome biome,GolfMapJsonObject doc) { File.WriteAllText(path,Text(biome,doc)); }

        // The file Save would write: the document brought up to date with the biome.
        public static string Text(GolfMapBiome biome,GolfMapJsonObject doc)
        {
            doc.SetString("seed",biome.seed);
            var rules=doc.Object("rules");
            foreach(var f in RuleNumbers){double v=(double)f.GetValue(biome.rules);if(rules.Has(f.Name)||v!=0)rules.SetNumber(f.Name,v);}
            if(rules.Has("woodlandMinNeighbours")||biome.rules.woodlandMinNeighbours!=0)rules.SetNumber("woodlandMinNeighbours",biome.rules.woodlandMinNeighbours);
            if(biome.rules.speciesWeights!=null){
                var weights=rules.Object("speciesWeights");
                if(weights==null){weights=new GolfMapJsonObject();rules["speciesWeights"]=weights;}
                foreach(var key in weights.keys.ToArray())if(!biome.rules.speciesWeights.species.Contains(key))weights.Remove(key);
                foreach(var name in biome.rules.speciesWeights.species)weights.SetNumber(name,biome.rules.speciesWeights.Weight(name));
            }
            var existing=doc.Array("assets").Cast<GolfMapJsonObject>().ToDictionary(o=>o.String("guid"));
            var list=new List<object>();
            foreach(var a in biome.assets){
                GolfMapJsonObject o;
                if(!existing.TryGetValue(a.guid,out o))o=new GolfMapJsonObject();
                // Key order of a new entry follows the entries the node scripts write.
                o.SetString("guid",a.guid);o.SetString("name",a.name);o.SetString("path",a.path);
                o.SetNumber("heightM",a.heightM);o.SetNumber("crownWidthM",a.crownWidthM);
                o.SetString("kind",a.kind);o.SetString("form",a.form);o.SetString("assetType",a.assetType);o.SetBool("enabled",a.enabled);
                if(o.Has("species")||!string.IsNullOrEmpty(a.species))o.SetString("species",a.species);
                if(o.Has("catalogueGuid")||!string.IsNullOrEmpty(a.catalogueGuid))o.SetString("catalogueGuid",a.catalogueGuid);
                if(o.Has("selectionWeight")||a.selectionWeight>0)o.SetNumber("selectionWeight",a.selectionWeight);
                list.Add(o);
            }
            doc["assets"]=list;
            if(biome.species.Any(g=>g.looks.Count>0)||doc.Has("species")){
                var speciesDoc=doc.Object("species");
                if(speciesDoc==null){speciesDoc=new GolfMapJsonObject();doc["species"]=speciesDoc;}
                foreach(var key in speciesDoc.keys.ToArray())if(biome.Species(key)==null)speciesDoc.Remove(key);
                foreach(var group in biome.species){
                    var g=speciesDoc.Object(group.name);
                    if(g==null){g=new GolfMapJsonObject();speciesDoc[group.name]=g;}
                    var looks=new List<object>();
                    foreach(var look in group.looks){
                        var o=look.node??(look.node=new GolfMapJsonObject());
                        o.SetString("id",look.id);o.SetNumber("weight",look.weight);
                        if(look.original||o.Has("original"))o.SetBool("original",look.original);
                        if(look.shapes==null)o.Remove("shapes");else o["shapes"]=look.shapes.Cast<object>().ToList();
                        looks.Add(o);
                    }
                    g["looks"]=looks;
                }
            }
            return GolfMapJsonDoc.Write(doc);
        }
    }
    // Same uniform fit and species race as tree-matching.mjs. No Unity dependency.
    public static class GolfMapBiomeMatcher
    {
        public static double Hash(string text)
        {
            unchecked { uint h=2166136261;foreach(char c in text)h=(h^c)*16777619;return h/4294967296.0; }
        }
        public static double SpeciesHash(string text)
        {
            unchecked { uint h=(uint)(Hash(text)*4294967296.0);h^=h>>16;h*=0x85ebca6b;h^=h>>13;h*=0xc2b2ae35;h^=h>>16;return h/4294967296.0; }
        }
        public static GolfMapBiomeMatch Match(GolfMapBiome biome,string id,double height,double radius,int kind,bool woodland=false,GolfMapAreaMix area=null)
        {
            var r=biome.rules;
            if(string.IsNullOrEmpty(id)||double.IsNaN(height)||double.IsInfinity(height)||height<=0||double.IsNaN(radius)||double.IsInfinity(radius)||radius<=0||kind<0||kind>2)throw new ArgumentException("Invalid tree dimensions, kind or ID");
            string form=height<=r.shrubMaxHeightM?"shrub":"tree";
            bool canopy=woodland&&form=="tree"&&r.woodlandCrownMultiplier>=1&&r.woodlandWidthWeight>0;
            double targetWidth=2*radius*(canopy?r.woodlandCrownMultiplier:1);
            double widthWeight=canopy?r.woodlandWidthWeight:1;
            Func<GolfMapBiomeAsset,GolfMapBiomeMatch> fit=a=>{
                if(a.heightM<=0||a.crownWidthM<=0)throw new ArgumentException("Invalid biome dimensions");
                double ideal=Math.Exp((2*Math.Log(height/a.heightM)+widthWeight*Math.Log(targetWidth/a.crownWidthM))/(2+widthWeight));
                var m=new GolfMapBiomeMatch {asset=a,scale=Math.Max(r.minScale,Math.Min(r.maxScale,ideal))};
                m.heightError=Math.Abs(Math.Log(a.heightM*m.scale/height));m.widthError=Math.Abs(Math.Log(a.crownWidthM*m.scale/targetWidth));
                m.score=2*m.heightError+widthWeight*m.widthError+r.scalePenalty*Math.Abs(Math.Log(m.scale));return m;
            };
            string detected=kind==0?"broadleaf":"conifer";
            var ranked=biome.assets.Where(a=>a.enabled&&a.form==form&&(kind==2||a.kind==detected)).Select(fit).OrderBy(m=>m.score).ThenBy(m=>m.asset.guid,StringComparer.Ordinal).ToList();
            // Inside a tree species area the mix is the rule: every species of it with a model of the
            // stem's form races by the area's weight, however well it fits (the fit picks the size), and
            // the survey's broadleaf/conifer class only counts unless the area ignores it. No such model
            // (a shrub-size stem, a conifer in an oak area): the palette decides, as outside.
            List<GolfMapBiomeMatch> pool=null;
            if(area!=null){
                var inMix=biome.assets.Where(a=>a.enabled&&a.form==form&&(area.ignoreKind||kind==2||a.kind==detected)&&area.Weight(a.Label)>0)
                    .Select(fit).OrderBy(m=>m.score).ThenBy(m=>m.asset.guid,StringComparer.Ordinal).ToList();
                if(inMix.Count>0){
                    var mixSpecies=inMix.Select(m=>m.asset.Label).Distinct().OrderBy(s=>s,StringComparer.Ordinal).ToList();
                    string picked=mixSpecies.OrderBy(s=>-Math.Log(Math.Max(2.220446049250313e-16,SpeciesHash(biome.seed+":"+id+":species:"+s)))/area.Weight(s)).First();
                    ranked=inMix;
                    pool=inMix.Where(m=>m.asset.Label==picked).ToList();
                }
            }
            if(ranked.Count==0)return null;
            if(pool==null)pool=ranked;
            if(pool==ranked&&kind!=2&&r.speciesWeights!=null){
                double slack=canopy&&r.woodlandSpeciesFitSlack>0?r.woodlandSpeciesFitSlack:r.speciesFitSlack;
                var eligible=ranked.Where(m=>m.score<=ranked[0].score+slack).ToList();
                var species=eligible.Select(m=>m.asset.Label).Distinct().Where(s=>r.speciesWeights.Weight(s)>0).OrderBy(s=>s,StringComparer.Ordinal).ToList();
                if(species.Count>0){
                    string chosen=species.OrderBy(s=>-Math.Log(Math.Max(2.220446049250313e-16,SpeciesHash(biome.seed+":"+id+":species:"+s)))/r.speciesWeights.Weight(s)).First();
                    pool=eligible.Where(m=>m.asset.Label==chosen).ToList();
                }
            }
            var close=pool.Where(m=>m.score<=pool[0].score+r.variationBand).ToList();
            var result=close.OrderBy(m=>Hash(biome.seed+":"+id+":"+m.asset.guid)).First();
            if(result.asset.species=="pine"){
                var pinePool=pool.Where(m=>m.asset.species=="pine"&&m.score<=pool[0].score+Math.Max(r.variationBand,0.5));
                result=pinePool.OrderBy(m=>-Math.Log(Math.Max(2.220446049250313e-16,SpeciesHash(biome.seed+":"+id+":pine:"+m.asset.guid)))/(m.asset.selectionWeight>0?m.asset.selectionWeight:1)).First();
            }
            else if(close.Any(m=>m.asset.Label==result.asset.Label&&m.asset.selectionWeight>0)){
                // Opt-in shares within the drawn species, between its variants that fit: no weights,
                // no change to the plain hash pick.
                string label=result.asset.Label;
                result=close.Where(m=>m.asset.Label==label).OrderBy(m=>-Math.Log(Math.Max(2.220446049250313e-16,SpeciesHash(biome.seed+":"+id+":asset:"+m.asset.guid)))/(m.asset.selectionWeight>0?m.asset.selectionWeight:1)).First();
            }
            // The look is drawn on its own hash, so adding one never moves a stem to another shape.
            var group=biome.Species(result.asset.Label);
            if(group!=null){
                var looks=group.looks.Where(l=>l.weight>0&&(l.shapes==null||l.shapes.Contains(result.asset.guid))).ToList();
                if(looks.Count>0)result.look=looks.OrderBy(l=>-Math.Log(Math.Max(2.220446049250313e-16,SpeciesHash(biome.seed+":"+id+":look:"+l.id)))/l.weight).ThenBy(l=>l.id,StringComparer.Ordinal).First().id;
            }
            if(canopy&&r.woodlandScaleBoost>1){
                result.scale=Math.Min(r.maxScale,result.scale*r.woodlandScaleBoost);
                result.heightError=Math.Abs(Math.Log(result.asset.heightM*result.scale/height));
                result.widthError=Math.Abs(Math.Log(result.asset.crownWidthM*result.scale/targetWidth));
            }
            result.rotation=Hash(biome.seed+":"+id+":rotation")*360;
            result.review=kind==2||result.heightError>Math.Log(1+r.maxHeightError)||result.widthError>Math.Log(1+r.maxWidthError)||result.asset.assetType=="model";
            // Cosmetic per-stem variety, after the fit and its review: neighbours with the same measured
            // height (or pinned at a scale limit) would otherwise be identical copies.
            result.scale*=1+r.scaleJitter*(2*SpeciesHash(biome.seed+":"+id+":scale")-1);
            result.lean=r.maxLeanDeg*SpeciesHash(biome.seed+":"+id+":lean");
            result.leanDirection=result.lean>0?SpeciesHash(biome.seed+":"+id+":leanDirection")*360:0;
            return result;
        }
    }
}
