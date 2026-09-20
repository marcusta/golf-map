// Retire named assets from the biome palette.
//
// tree-matching picks a species with an exponential race over rules.speciesWeights, but only
// across species that still have an eligible asset:
//     const species=[...new Set(eligible.map(a=>a.species))].filter(s=>(rules.speciesWeights[s]||0)>0)
// so disabling the last asset of a species drops that species out of the race and its share is
// renormalised across the rest in proportion to their existing weights - which is exactly
// "give its numbers to the others". Nothing needs reweighting by hand.
//
// Assets are disabled (enabled: false) rather than deleted so the entry, its guid and its recorded
// originalPath survive for a later change of mind, and so an existing planted catalogue can still
// resolve the item. A species left with no enabled asset also has its now-dead weight dropped, and
// the remaining weights are renormalised to sum to 1 - cosmetic, since only ratios matter.
//
// Writes both copies: the repo's docs/gspro/vreta/palette.json is the source, the Unity project's
// Assets/GolfMap/Vreta/palette.json is the copy the planter reads.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage,...names]=process.argv.slice(2);
if(!root||!stage||!names.length||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE NAME [NAME...]');
const PALETTE='Assets/GolfMap/Vreta/palette.json';
const palette=JSON.parse(fs.readFileSync(path.join(root,PALETTE),'utf8'));
const wanted=new Set(names);
const retired=[];
for(const asset of palette.assets){
 if(!wanted.has(asset.name))continue;
 if(asset.enabled===false)throw Error(asset.name+' is already disabled');
 asset.enabled=false;
 retired.push({name:asset.name,species:asset.species||null});
 wanted.delete(asset.name);
}
if(wanted.size)throw Error('Not in the palette: '+[...wanted].join(', '));
const live=new Set(palette.assets.filter(a=>a.enabled!==false&&a.species).map(a=>a.species));
const weights=palette.rules.speciesWeights;
const dropped=Object.keys(weights).filter(s=>!live.has(s));
for(const species of dropped)delete weights[species];
const total=Object.values(weights).reduce((a,b)=>a+b,0);
const before=JSON.parse(JSON.stringify(weights));
for(const species of Object.keys(weights))weights[species]=Math.round(weights[species]/total*1000)/1000;
// Put any rounding drift on the largest weight so the set still sums to exactly 1.
const drift=Math.round((1-Object.values(weights).reduce((a,b)=>a+b,0))*1000)/1000;
if(drift){const top=Object.keys(weights).sort((a,b)=>weights[b]-weights[a])[0];weights[top]=Math.round((weights[top]+drift)*1000)/1000;}
const text=JSON.stringify(palette,null,2)+'\n';
for(const rel of [PALETTE,'docs/gspro/vreta/palette.json']){
 const dest=path.join(stage,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,text);
}
const remaining={};
for(const asset of palette.assets)if(asset.enabled!==false&&asset.species)remaining[asset.species]=(remaining[asset.species]||0)+1;
const report={retired,droppedSpecies:dropped,weightsBefore:before,weightsAfter:weights,enabledAssetsPerSpecies:remaining};
fs.writeFileSync(path.join(stage,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
