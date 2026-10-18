// Pure matching rules. k: 0 broadleaf, 1 conifer, 2 unknown.
// An asset without a species races, and is looked up, under its kind.
export const speciesLabel=a=>a.species||a.kind;
// What the matcher hashes and breaks ties on: a resolved asset's key (shared/vegetation/tree-models.ts:
// the prefab guid, else the model id); an inline palette read as it is has only its prefab guid.
export const keyOf=a=>a.key??a.guid;
export function hash(text) {
 let value=2166136261;for(const c of text)value=Math.imul(value^c.charCodeAt(0),16777619);
 return (value>>>0)/4294967296;
}
export function speciesHash(text) {
 let h=(hash(text)*4294967296)>>>0;
 h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;h=Math.imul(h,0xc2b2ae35);h^=h>>>16;
 return (h>>>0)/4294967296;
}
// `area`: the tree species area the stem stands in (the trees export's `areas`,
// shared/features/tree-areas.ts): {species:[{species,weight}], ignoreKind}.
export function matchTree(stem,config,override,area) {
 if(!stem.id)throw Error('Every stem needs a stable ID');
 if(![stem.h,stem.r,stem.x,stem.z].every(Number.isFinite)||stem.h<=0||stem.r<=0||![0,1,2].includes(stem.k))throw Error('Invalid stem '+stem.id);
 if(override?.exclude)return {stemId:stem.id,status:'excluded',source:'override',position:{x:stem.x,z:stem.z}};
 const rules={...config.rules,...(config.zones?.[stem.zoneId]?.rules||{})};
 const allowed=config.zones?.[stem.zoneId]?.allowedGuids;
 const candidates=config.assets.filter(a=>a.enabled!==false&&(!allowed||allowed.includes(keyOf(a))));
 const kind=stem.k===0?'broadleaf':stem.k===1?'conifer':'unknown';
 // Detector bush flags are crown-ratio heuristics: broad mature oaks must remain trees.
 const form=stem.h<=rules.shrubMaxHeightM?'shrub':'tree';
 // A stem sized by hand (a tree edit naming its height and crown width) is that size: no lidar pad,
 // no woodland canopy.
 const sized=stem.sized===true;
 const canopy=!sized&&stem.woodland===true&&form==='tree'&&rules.woodlandCrownMultiplier>=1&&rules.woodlandWidthWeight>0;
 // Lidar also loses the edge of an open-grown crown, about the same width whatever the tree's
 // size (the ortho's shadows): a pad in metres, not a multiplier. 0 = off, as the weight's 0.
 const open=!sized&&form==='tree'&&!canopy;
 const targetWidth=canopy?2*stem.r*rules.woodlandCrownMultiplier:2*stem.r+(open?rules.openCrownPadM||0:0);
 const widthWeight=canopy?rules.woodlandWidthWeight:open&&rules.openWidthWeight>0?rules.openWidthWeight:1;
 const fit=a=>{
   if(!(a.heightM>0&&a.crownWidthM>0))throw Error('Invalid asset dimensions: '+keyOf(a));
   const h=stem.h/a.heightM,w=targetWidth/a.crownWidthM;
   const ideal=Math.exp((2*Math.log(h)+widthWeight*Math.log(w))/(2+widthWeight));
   const scale=Math.max(rules.minScale,Math.min(rules.maxScale,ideal));
   const heightError=Math.abs(Math.log(a.heightM*scale/stem.h));
   const widthError=Math.abs(Math.log(a.crownWidthM*scale/targetWidth));
   const score=2*heightError+widthWeight*widthError+rules.scalePenalty*Math.abs(Math.log(scale));
   return {guid:a.guid,key:keyOf(a),name:a.name,model:a.model,species:a.species,label:speciesLabel(a),weight:a.selectionWeight,scale,heightError,widthError,score};
 };
 const byFit=(a,b)=>a.score-b.score||a.key.localeCompare(b.key);
 let ranked=candidates.filter(a=>a.form===form&&(kind==='unknown'||a.kind===kind)).map(fit).sort(byFit);
 // Inside a tree species area the mix is the rule: every species of it with a model of the
 // stem's form races by the area's weight, however well it fits (the fit picks the size), and
 // the survey's broadleaf/conifer class only counts unless the area ignores it. No such model
 // (a shrub-size stem, a conifer in an oak area): the palette decides, as outside.
 let areaPool=null;
 const areaWeight=s=>area?.species?.find(x=>x.species===s)?.weight||0;
 if(area&&!override?.guid){
   const inMix=candidates.filter(a=>a.form===form&&(area.ignoreKind||kind==='unknown'||a.kind===kind)&&areaWeight(speciesLabel(a))>0).map(fit).sort(byFit);
   if(inMix.length){
     const species=[...new Set(inMix.map(a=>a.label))].sort();
     const race=s=>-Math.log(Math.max(Number.EPSILON,speciesHash(config.seed+':'+stem.id+':species:'+s)))/areaWeight(s);
     const selected=species.reduce((best,s)=>race(s)<race(best)?s:best);
     ranked=inMix;
     areaPool=inMix.filter(a=>a.label===selected);
   }
 }
 let chosen;
 if(override?.guid){
   const asset=config.assets.find(a=>a.guid===override.guid||a.catalogueGuid===override.guid||a.model===override.guid);
   if(!asset)throw Error('Override asset missing from palette: '+override.guid);
   if(!Number.isFinite(override.scale)||override.scale<=0)throw Error('Override requires positive uniform scale');
   chosen={guid:asset.guid,key:keyOf(asset),name:asset.name,model:asset.model,scale:override.scale};
 }else if(ranked.length){
   let pool=areaPool||ranked;
   // Pick species once, independently of its number of prefab variants. Poor fits
   // cannot win merely to meet a species target; proportions are preferences.
   if(!areaPool&&kind!=='unknown'&&rules.speciesWeights){
     const slack=canopy&&rules.woodlandSpeciesFitSlack>0?rules.woodlandSpeciesFitSlack:(rules.speciesFitSlack??0);
     const eligible=ranked.filter(a=>a.score<=ranked[0].score+slack);
     const species=[...new Set(eligible.map(a=>a.label))].filter(s=>(rules.speciesWeights[s]||0)>0).sort();
     if(species.length){
       const race=s=>-Math.log(Math.max(Number.EPSILON,speciesHash(config.seed+':'+stem.id+':species:'+s)))/rules.speciesWeights[s];
       const selected=species.reduce((best,s)=>race(s)<race(best)?s:best);
       pool=eligible.filter(a=>a.label===selected);
     }
   }
   const close=pool.filter(a=>a.score<=pool[0].score+rules.variationBand);
   chosen=close.reduce((best,a)=>hash(config.seed+':'+stem.id+':'+a.key)<hash(config.seed+':'+stem.id+':'+best.key)?a:best);
   if(chosen.species==='pine'){
     const pinePool=pool.filter(a=>a.species==='pine'&&a.score<=pool[0].score+Math.max(rules.variationBand,.5));
    const race=a=>{const weight=config.assets.find(x=>keyOf(x)===a.key).selectionWeight;return -Math.log(Math.max(Number.EPSILON,speciesHash(config.seed+':'+stem.id+':pine:'+a.key)))/(weight>0?weight:1);};
     chosen=pinePool.reduce((best,a)=>race(a)<race(best)?a:best);
   }else if(close.some(a=>a.label===chosen.label&&a.weight>0)){
     // Opt-in shares within the drawn species, between its variants that fit: no weights,
     // no change to the plain hash pick.
     const same=close.filter(a=>a.label===chosen.label);
     const race=a=>-Math.log(Math.max(Number.EPSILON,speciesHash(config.seed+':'+stem.id+':asset:'+a.key)))/(a.weight>0?a.weight:1);
     chosen=same.reduce((best,a)=>race(a)<race(best)?a:best);
   }
 }
 if(!chosen)return {stemId:stem.id,status:'unmatched',position:{x:stem.x,z:stem.z},reason:'No compatible '+kind+' '+form+' in palette',alternatives:[]};
 if(canopy&&!override?.guid&&rules.woodlandScaleBoost>1){
   chosen={...chosen,scale:Math.min(rules.maxScale,chosen.scale*rules.woodlandScaleBoost)};
   const asset=config.assets.find(a=>keyOf(a)===chosen.key);
   chosen.heightError=Math.abs(Math.log(asset.heightM*chosen.scale/stem.h));
   chosen.widthError=Math.abs(Math.log(asset.crownWidthM*chosen.scale/targetWidth));
 }
 // The look (material settings) is drawn on its own hash, so adding one never moves a stem to another shape.
 let look;
 if(!override?.guid){
   const asset=config.assets.find(a=>keyOf(a)===chosen.key);
   const looks=(config.species?.[speciesLabel(asset)]?.looks||[]).filter(l=>l.weight>0&&(!l.shapes||l.shapes.includes(keyOf(asset))));
   if(looks.length){
     const race=l=>-Math.log(Math.max(Number.EPSILON,speciesHash(config.seed+':'+stem.id+':look:'+l.id)))/l.weight;
     look=looks.reduce((best,l)=>race(l)<race(best)||race(l)===race(best)&&l.id<best.id?l:best).id;
   }
 }
 const reasons=[];
 if(!override?.guid){
   if(kind==='unknown')reasons.push('Detector kind unknown; species is a proposal');
   if(chosen.heightError>Math.log(1+rules.maxHeightError))reasons.push('Height fit exceeds tolerance');
   if(chosen.widthError>Math.log(1+rules.maxWidthError))reasons.push('Crown width fit exceeds tolerance');
   const asset=config.assets.find(a=>keyOf(a)===chosen.key);
   if(asset.assetType==='model')reasons.push('Model asset: Unity/VSP setup needs verification');
 }
 const position=override?.position||{x:stem.x,z:stem.z};
 if(![position.x,position.z].every(Number.isFinite))throw Error('Invalid override position');
 const rotation=override?.rotationY??hash(config.seed+':'+stem.id+':rotation')*360;
 if(!Number.isFinite(rotation))throw Error('Invalid rotation');
 // Cosmetic per-stem variety, after the fit and its review: neighbours with the same measured
 // height (or pinned at a scale limit) would otherwise be identical copies. Authored scales stay exact.
 const scale=override?.guid?chosen.scale:chosen.scale*(1+(rules.scaleJitter||0)*(2*speciesHash(config.seed+':'+stem.id+':scale')-1));
 const leanDeg=(rules.maxLeanDeg||0)*speciesHash(config.seed+':'+stem.id+':lean');
 const leanDirectionY=leanDeg>0?speciesHash(config.seed+':'+stem.id+':leanDirection')*360:0;
 return {stemId:stem.id,status:override?.guid?'authored':reasons.length?'review':'proposed',source:override?.guid?'override':'rules',
   guid:chosen.guid,key:chosen.key,name:chosen.name,model:chosen.model,look,scale,rotationY:rotation,leanDeg,leanDirectionY,position,reasons,
   measured:{heightM:stem.h,crownRadiusM:stem.r,kind:stem.k},alternatives:ranked.slice(0,3)};
}
