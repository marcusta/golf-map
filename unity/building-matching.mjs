// Pure building→prefab matching rules (the tree-matching.mjs sibling).
//
// A building is matched on three measured numbers — the footprint
// rectangle's length and width (metres, from the survey's minimum rotated
// rectangle) and its height (the lidar ridge; `unmeasuredHeightM` when the
// survey has none) — against a palette of prefabs measured the same way.
// Unlike a tree, a building cannot be stretched freely: a house at 1.4×
// has four-metre doors. So the footprint scale is uniform in XZ (the prefab
// keeps its proportions), the height scale is separate (the lidar height is
// a real measurement), and BOTH are clamped to a band that depends on how
// close the building is to the course — near it a bad fit is flagged for
// review rather than stretched, far away nobody reads the brick courses.
// Rotation is derived, not random: the survey's `yawDeg` turns local +x
// onto the footprint's long axis; a prefab whose long side is its local z
// adds 90; which end is the front is unknowable from a footprint, so an
// override's `flip` adds 180.
export function hash(text) {
 let value=2166136261;for(const c of text)value=Math.imul(value^c.charCodeAt(0),16777619);
 return (value>>>0)/4294967296;
}
const DEFAULT_RULES={
 reviewRadiusM:400,unmeasuredHeightM:6,lengthWeight:1,widthWeight:1,heightWeight:1,scalePenalty:0.2,
 kindPenalty:0.5,variationBand:0.08,
 near:{minFootprintScale:0.87,maxFootprintScale:1.15,minHeightScale:0.87,maxHeightScale:1.15,maxFootprintError:0.15,maxHeightError:0.2},
 far:{minFootprintScale:0.6,maxFootprintScale:1.6,minHeightScale:0.67,maxHeightScale:1.5,maxFootprintError:0.35,maxHeightError:0.4},
};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
export function matchBuilding(b,config,override){
 if(!b.id)throw Error('Every building needs a stable ID');
 if(![b.x,b.z,b.lengthM,b.widthM].every(Number.isFinite)||b.lengthM<=0||b.widthM<=0)throw Error('Invalid building '+b.id);
 if(override?.exclude)return {buildingId:b.id,status:'excluded',source:'override',position:{x:b.x,z:b.z}};
 const rules={...DEFAULT_RULES,...(config.rules||{})};
 rules.near={...DEFAULT_RULES.near,...(config.rules?.near||{})};rules.far={...DEFAULT_RULES.far,...(config.rules?.far||{})};
 const centre=config.center||{x:(config.plot?.sizeM||0)/2,z:(config.plot?.sizeM||0)/2};
 const distance=Math.hypot(b.x-centre.x,b.z-centre.z);
 const near=distance<=rules.reviewRadiusM;
 const band=near?rules.near:rules.far;
 const measured=Number.isFinite(b.heightM)&&b.heightM>0;
 const height=measured?b.heightM:rules.unmeasuredHeightM;
 const candidates=(config.assets||[]).filter(a=>a.enabled!==false);
 const ranked=candidates.map(a=>{
   if(!(a.lengthM>0&&a.widthM>0&&a.heightM>0))throw Error('Invalid asset dimensions: '+a.guid);
   const ideal=Math.exp((rules.lengthWeight*Math.log(b.lengthM/a.lengthM)+rules.widthWeight*Math.log(b.widthM/a.widthM))/(rules.lengthWeight+rules.widthWeight));
   const footprintScale=clamp(ideal,band.minFootprintScale,band.maxFootprintScale);
   const heightScale=clamp(height/a.heightM,band.minHeightScale,band.maxHeightScale);
   const lengthError=Math.abs(Math.log(a.lengthM*footprintScale/b.lengthM));
   const widthError=Math.abs(Math.log(a.widthM*footprintScale/b.widthM));
   const heightError=Math.abs(Math.log(a.heightM*heightScale/height));
   const kindMiss=Array.isArray(a.kinds)&&a.kinds.length>0&&!a.kinds.includes(b.kind);
   const score=rules.lengthWeight*lengthError+rules.widthWeight*widthError+rules.heightWeight*heightError
     +rules.scalePenalty*(Math.abs(Math.log(footprintScale))+Math.abs(Math.log(heightScale)))+(kindMiss?rules.kindPenalty:0);
   return {guid:a.guid,name:a.name,axis:a.axis==='z'?'z':'x',footprintScale,heightScale,lengthError,widthError,heightError,kindMiss,score};
 }).sort((a,b)=>a.score-b.score||a.guid.localeCompare(b.guid));
 let chosen;
 if(override?.guid){
   const asset=config.assets.find(a=>a.guid===override.guid);
   if(!asset)throw Error('Override asset missing from palette: '+override.guid);
   const fromRules=ranked.find(a=>a.guid===asset.guid);
   const footprintScale=override.footprintScale??fromRules?.footprintScale??1,heightScale=override.heightScale??fromRules?.heightScale??1;
   if(!(footprintScale>0&&heightScale>0))throw Error('Override scales must be positive');
   chosen={guid:asset.guid,name:asset.name,axis:asset.axis==='z'?'z':'x',footprintScale,heightScale,
     lengthError:Math.abs(Math.log(asset.lengthM*footprintScale/b.lengthM)),widthError:Math.abs(Math.log(asset.widthM*footprintScale/b.widthM)),
     heightError:Math.abs(Math.log(asset.heightM*heightScale/height)),kindMiss:false};
 }else if(ranked.length){
   const close=ranked.filter(a=>a.score<=ranked[0].score+rules.variationBand);
   chosen=close.reduce((best,a)=>hash(config.seed+':'+b.id+':'+a.guid)<hash(config.seed+':'+b.id+':'+best.guid)?a:best);
 }
 if(!chosen)return {buildingId:b.id,status:'unmatched',position:{x:b.x,z:b.z},reason:'No enabled building prefab in palette',alternatives:[]};
 const reasons=[];
 if(near)reasons.push('Within '+rules.reviewRadiusM+' m of the course: choose or model by hand');
 if(!override?.guid){
   if(!measured)reasons.push('No lidar height; '+rules.unmeasuredHeightM+' m assumed');
   if(Math.max(chosen.lengthError,chosen.widthError)>Math.log(1+band.maxFootprintError))reasons.push('Footprint fit exceeds tolerance');
   if(chosen.heightError>Math.log(1+band.maxHeightError))reasons.push('Height fit exceeds tolerance');
   if(chosen.kindMiss)reasons.push('Prefab kind does not match '+b.kind);
 }
 const position=override?.position||{x:b.x,z:b.z};
 if(![position.x,position.z].every(Number.isFinite))throw Error('Invalid override position');
 let rotation=override?.rotationY;
 if(rotation===undefined){
   rotation=(b.yawDeg||0)+(chosen.axis==='z'?90:0)+(override?.flip?180:0);
   rotation=((rotation%360)+360)%360;
 }
 if(!Number.isFinite(rotation))throw Error('Invalid rotation');
 return {buildingId:b.id,status:override?.guid?'authored':reasons.length?'review':'proposed',source:override?.guid?'override':'rules',
   guid:chosen.guid,name:chosen.name,position,rotationY:rotation,
   scale:{x:chosen.footprintScale,y:chosen.heightScale,z:chosen.footprintScale},
   errors:{length:chosen.lengthError,width:chosen.widthError,height:chosen.heightError},
   distanceM:distance,near,reasons,
   measured:{lengthM:b.lengthM,widthM:b.widthM,heightM:measured?b.heightM:null,heightSource:b.heightSource,kind:b.kind},
   alternatives:ranked.slice(0,3).map(a=>({guid:a.guid,name:a.name,score:a.score,footprintScale:a.footprintScale,heightScale:a.heightScale}))};
}
