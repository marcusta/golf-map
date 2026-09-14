using System;
using System.Collections.Generic;
using System.Linq;

namespace GolfMap.Editor
{
    [Serializable] public class GolfMapBiome
    {
        public string format, seed;
        public GolfMapBiomeRules rules;
        public List<GolfMapBiomeAsset> assets;
    }
    [Serializable] public class GolfMapBiomeRules
    {
        public double minScale, maxScale, variationBand, maxWidthError, maxHeightError, scalePenalty, shrubMaxHeightM, speciesFitSlack;
        public GolfMapSpeciesWeights speciesWeights;
        public double woodlandRadiusM, woodlandCrownMultiplier, woodlandWidthWeight, woodlandScaleBoost;
        public int woodlandMinNeighbours;
        public double woodlandSpeciesFitSlack;
    }
    [Serializable] public class GolfMapSpeciesWeights
    {
        public double oak, elm, birch, poplar, broadleaf, maple;
        public double Weight(string species) { return species=="oak"?oak:species=="elm"?elm:species=="birch"?birch:species=="poplar"?poplar:species=="broadleaf"?broadleaf:species=="maple"?maple:0; }
    }
    [Serializable] public class GolfMapBiomeAsset
    {
        public string guid, catalogueGuid, name, path, kind, form, species, assetType;
        public double heightM, crownWidthM, selectionWeight;
        public bool enabled=true;
    }
    public class GolfMapBiomeMatch
    {
        public GolfMapBiomeAsset asset;
        public double scale, heightError, widthError, score, rotation;
        public double widthScale;   // 0 = uniform (scale); set for hand-edited stems on mesh terrains
        public bool review;
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
        public static GolfMapBiomeMatch Match(GolfMapBiome biome,string id,double height,double radius,int kind,bool woodland=false)
        {
            var r=biome.rules;
            if(string.IsNullOrEmpty(id)||double.IsNaN(height)||double.IsInfinity(height)||height<=0||double.IsNaN(radius)||double.IsInfinity(radius)||radius<=0||kind<0||kind>2)throw new ArgumentException("Invalid tree dimensions, kind or ID");
            string form=height<=r.shrubMaxHeightM?"shrub":"tree";
            bool canopy=woodland&&form=="tree"&&r.woodlandCrownMultiplier>=1&&r.woodlandWidthWeight>0;
            double targetWidth=2*radius*(canopy?r.woodlandCrownMultiplier:1);
            double widthWeight=canopy?r.woodlandWidthWeight:1;
            var ranked=biome.assets.Where(a=>a.enabled&&a.form==form&&(kind==2||a.kind==(kind==0?"broadleaf":"conifer"))).Select(a=>{
                if(a.heightM<=0||a.crownWidthM<=0)throw new ArgumentException("Invalid biome dimensions");
                double ideal=Math.Exp((2*Math.Log(height/a.heightM)+widthWeight*Math.Log(targetWidth/a.crownWidthM))/(2+widthWeight));
                var m=new GolfMapBiomeMatch {asset=a,scale=Math.Max(r.minScale,Math.Min(r.maxScale,ideal))};
                m.heightError=Math.Abs(Math.Log(a.heightM*m.scale/height));m.widthError=Math.Abs(Math.Log(a.crownWidthM*m.scale/targetWidth));
                m.score=2*m.heightError+widthWeight*m.widthError+r.scalePenalty*Math.Abs(Math.Log(m.scale));return m;
            }).OrderBy(m=>m.score).ThenBy(m=>m.asset.guid,StringComparer.Ordinal).ToList();
            if(ranked.Count==0)return null;
            var pool=ranked;
            if(kind==0&&r.speciesWeights!=null){
                double slack=canopy&&r.woodlandSpeciesFitSlack>0?r.woodlandSpeciesFitSlack:r.speciesFitSlack;
                var eligible=ranked.Where(m=>m.score<=ranked[0].score+slack).ToList();
                var species=eligible.Select(m=>m.asset.species).Distinct().Where(s=>r.speciesWeights.Weight(s)>0).OrderBy(s=>s,StringComparer.Ordinal).ToList();
                if(species.Count>0){
                    string chosen=species.OrderBy(s=>-Math.Log(Math.Max(2.220446049250313e-16,SpeciesHash(biome.seed+":"+id+":species:"+s)))/r.speciesWeights.Weight(s)).First();
                    pool=eligible.Where(m=>m.asset.species==chosen).ToList();
                }
            }
            var result=pool.Where(m=>m.score<=pool[0].score+r.variationBand).OrderBy(m=>Hash(biome.seed+":"+id+":"+m.asset.guid)).First();
            if(result.asset.species=="pine"){
                var pinePool=pool.Where(m=>m.asset.species=="pine"&&m.score<=pool[0].score+Math.Max(r.variationBand,0.5));
                result=pinePool.OrderBy(m=>-Math.Log(Math.Max(2.220446049250313e-16,SpeciesHash(biome.seed+":"+id+":pine:"+m.asset.guid)))/(m.asset.selectionWeight>0?m.asset.selectionWeight:1)).First();
            }
            if(canopy&&r.woodlandScaleBoost>1){
                result.scale=Math.Min(r.maxScale,result.scale*r.woodlandScaleBoost);
                result.heightError=Math.Abs(Math.Log(result.asset.heightM*result.scale/height));
                result.widthError=Math.Abs(Math.Log(result.asset.crownWidthM*result.scale/targetWidth));
            }
            result.rotation=Hash(biome.seed+":"+id+":rotation")*360;
            result.review=kind==2||result.heightError>Math.Log(1+r.maxHeightError)||result.widthError>Math.Log(1+r.maxWidthError)||result.asset.assetType=="model";
            return result;
        }
    }
}
