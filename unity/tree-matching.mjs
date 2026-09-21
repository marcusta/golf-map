// Pure matching rules. k: 0 broadleaf, 1 conifer, 2 unknown.
// An asset without a species races, and is looked up, under its kind.
export const speciesLabel=a=>a.species||a.kind;
export function hash(text) {
 let value=2166136261;for(const c of text)value=Math.imul(value^c.charCodeAt(0),16777619);
 return (value>>>0)/4294967296;
}
export function speciesHash(text) {
 let h=(hash(text)*4294967296)>>>0;
 h^=h>>>16;h=Math.imul(h,0x85ebca6b);h^=h>>>13;h=Math.imul(h,0xc2b2ae35);h^=h>>>16;
 return (h>>>0)/4294967296;
}
export function matchTree(stem,config,override) {
 if(!stem.id)throw Error('Every stem needs a stable ID');
 if(![stem.h,stem.r,stem.x,stem.z].every(Number.isFinite)||stem.h<=0||stem.r<=0||![0,1,2].includes(stem.k))throw Error('Invalid stem '+stem.id);
 if(override?.exclude)return {stemId:stem.id,status:'excluded',source:'override',position:{x:stem.x,z:stem.z}};
 const rules={...config.rules,...(config.zones?.[stem.zoneId]?.rules||{})};
 const allowed=config.zones?.[stem.zoneId]?.allowedGuids;
 const candidates=config.assets.filter(a=>a.enabled!==false&&(!allowed||allowed.includes(a.guid)));
 const kind=stem.k===0?'broadleaf':stem.k===1?'conifer':'unknown';
 // Detector bush flags are crown-ratio heuristics: broad mature oaks must remain trees.
 const form=stem.h<=rules.shrubMaxHeightM?'shrub':'tree';
 const canopy=stem.woodland===true&&form==='tree'&&rules.woodlandCrownMultiplier>=1&&rules.woodlandWidthWeight>0;
 const targetWidth=2*stem.r*(canopy?rules.woodlandCrownMultiplier:1),widthWeight=canopy?rules.woodlandWidthWeight:1;
 const ranked=candidates.filter(a=>a.form===form&&(kind==='unknown'||a.kind===kind)).map(a=>{
   if(!(a.heightM>0&&a.crownWidthM>0))throw Error('Invalid asset dimensions: '+a.guid);
   const h=stem.h/a.heightM,w=targetWidth/a.crownWidthM;
   const ideal=Math.exp((2*Math.log(h)+widthWeight*Math.log(w))/(2+widthWeight));
   const scale=Math.max(rules.minScale,Math.min(rules.maxScale,ideal));
   const heightError=Math.abs(Math.log(a.heightM*scale/stem.h));
   const widthError=Math.abs(Math.log(a.crownWidthM*scale/targetWidth));
   const score=2*heightError+widthWeight*widthError+rules.scalePenalty*Math.abs(Math.log(scale));
   return {guid:a.guid,name:a.name,species:a.species,label:speciesLabel(a),weight:a.selectionWeight,scale,heightError,widthError,score};
 }).sort((a,b)=>a.score-b.score||a.guid.localeCompare(b.guid));
 let chosen;
 if(override?.guid){
   const asset=config.assets.find(a=>a.guid===override.guid||a.catalogueGuid===override.guid);
   if(!asset)throw Error('Override asset missing from palette: '+override.guid);
   if(!Number.isFinite(override.scale)||override.scale<=0)throw Error('Override requires positive uniform scale');
   chosen={guid:asset.guid,name:asset.name,scale:override.scale};
 }else if(ranked.length){
   let pool=ranked;
   // Pick species once, independently of its number of prefab variants. Poor fits
   // cannot win merely to meet a species target; proportions are preferences.
   if(kind!=='unknown'&&rules.speciesWeights){
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
   chosen=close.reduce((best,a)=>hash(config.seed+':'+stem.id+':'+a.guid)<hash(config.seed+':'+stem.id+':'+best.guid)?a:best);
   if(chosen.species==='pine'){
     const pinePool=pool.filter(a=>a.species==='pine'&&a.score<=pool[0].score+Math.max(rules.variationBand,.5));
    const race=a=>{const weight=config.assets.find(x=>x.guid===a.guid).selectionWeight;return -Math.log(Math.max(Number.EPSILON,speciesHash(config.seed+':'+stem.id+':pine:'+a.guid)))/(weight>0?weight:1);};
     chosen=pinePool.reduce((best,a)=>race(a)<race(best)?a:best);
   }else if(close.some(a=>a.label===chosen.label&&a.weight>0)){
     // Opt-in shares within the drawn species, between its variants that fit: no weights,
     // no change to the plain hash pick.
     const same=close.filter(a=>a.label===chosen.label);
     const race=a=>-Math.log(Math.max(Number.EPSILON,speciesHash(config.seed+':'+stem.id+':asset:'+a.guid)))/(a.weight>0?a.weight:1);
     chosen=same.reduce((best,a)=>race(a)<race(best)?a:best);
   }
 }
 if(!chosen)return {stemId:stem.id,status:'unmatched',position:{x:stem.x,z:stem.z},reason:'No compatible '+kind+' '+form+' in palette',alternatives:[]};
 if(canopy&&!override?.guid&&rules.woodlandScaleBoost>1){
   chosen={...chosen,scale:Math.min(rules.maxScale,chosen.scale*rules.woodlandScaleBoost)};
   const asset=config.assets.find(a=>a.guid===chosen.guid);
   chosen.heightError=Math.abs(Math.log(asset.heightM*chosen.scale/stem.h));
   chosen.widthError=Math.abs(Math.log(asset.crownWidthM*chosen.scale/targetWidth));
 }
 // The look (material settings) is drawn on its own hash, so adding one never moves a stem to another shape.
 let look;
 if(!override?.guid){
   const asset=config.assets.find(a=>a.guid===chosen.guid);
   const looks=(config.species?.[speciesLabel(asset)]?.looks||[]).filter(l=>l.weight>0&&(!l.shapes||l.shapes.includes(asset.guid)));
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
   const asset=config.assets.find(a=>a.guid===chosen.guid);
   if(asset.assetType==='model')reasons.push('Model asset: Unity/VSP setup needs verification');
 }
 const position=override?.position||{x:stem.x,z:stem.z};
 if(![position.x,position.z].every(Number.isFinite))throw Error('Invalid override position');
 const rotation=override?.rotationY??hash(config.seed+':'+stem.id+':rotation')*360;
 if(!Number.isFinite(rotation))throw Error('Invalid rotation');
 return {stemId:stem.id,status:override?.guid?'authored':reasons.length?'review':'proposed',source:override?.guid?'override':'rules',
   guid:chosen.guid,name:chosen.name,look,scale:chosen.scale,rotationY:rotation,position,reasons,
   measured:{heightM:stem.h,crownRadiusM:stem.r,kind:stem.k},alternatives:ranked.slice(0,3)};
}
