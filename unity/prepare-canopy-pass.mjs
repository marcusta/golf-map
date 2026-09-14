// Stage foliage changes and audit canopy fits; leaves the live project untouched.
import fs from 'node:fs';
import path from 'node:path';
import {matchTree} from './tree-matching.mjs';
const [root,treeFile,stage]=process.argv.slice(2);
if(!root||!treeFile||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT TREES_FILE NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const palettePath='Assets/GolfMap/Vreta/palette.json';
const old=JSON.parse(read(palettePath)),palette=structuredClone(old);
Object.assign(palette.rules,{woodlandRadiusM:20,woodlandMinNeighbours:4,woodlandCrownMultiplier:1.12,woodlandWidthWeight:2,woodlandScaleBoost:1.10});
save(palettePath,JSON.stringify(palette,null,2)+'\n');
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
const changes=[['Oak Leaves.mat',{_GolfMapLeafTint:'{r: 0.27, g: 0.39, b: 0.25, a: 1}',_HueVariation:'{r: 0.38, g: 0.48, b: 0.32, a: 0.07}'}],
 ['Birch Leaves.mat',{_HealthyColor:'{r: 0.48, g: 0.62, b: 0.49, a: 1}',_DryColor:'{r: 0.44, g: 0.56, b: 0.43, a: 1}'}]];
for(const [file,properties] of changes){let material=read(folder+'/'+file);for(const [key,value] of Object.entries(properties)){
 const pattern=new RegExp('(^    - '+key+': )[^\\r\\n]+','m');if(!pattern.test(material))throw Error('Missing '+key);
 material=material.replace(pattern,(_,prefix)=>prefix+value);
}save(folder+'/'+file,material);}
const trees=JSON.parse(fs.readFileSync(treeFile,'utf8').replace(/^\uFEFF/,'')).trees.map(t=>({...t,x:Math.fround(t.x),z:Math.fround(t.z),h:Math.fround(t.h),r:Math.fround(t.r)}));
const grid=new Map(),cell=20;
for(const t of trees){if(t.h<=palette.rules.shrubMaxHeightM)continue;const key=Math.floor(t.x/cell)+':'+Math.floor(t.z/cell);if(!grid.has(key))grid.set(key,[]);grid.get(key).push(t);}
const sums={count:0,beforeWidth:0,afterWidth:0,beforeHeight:0,afterHeight:0,targetWidth:0,changed:0};
const fixtures=[];
for(const t of trees){let n=0;const gx=Math.floor(t.x/cell),gz=Math.floor(t.z/cell);
 if(t.h>palette.rules.shrubMaxHeightM)for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++)for(const other of grid.get((gx+dx)+':'+(gz+dz))||[]){if(other!==t&&(other.x-t.x)**2+(other.z-t.z)**2<=cell*cell)n++;}
 const woodland=n>=4,before=matchTree(t,old),after=matchTree({...t,woodland},palette);
 fixtures.push([t.id,t.h,t.r,t.k,after.guid||'-',after.scale||0,after.rotationY||0,after.status==='review',woodland].join('\t'));
 if(!woodland){if(before.guid!==after.guid||before.scale!==after.scale)throw Error('Isolated tree changed');continue;}
 if(!before.guid||!after.guid)continue;
 const a=old.assets.find(a=>a.guid===before.guid),b=palette.assets.find(a=>a.guid===after.guid);
 sums.count++;sums.beforeWidth+=a.crownWidthM*before.scale;sums.afterWidth+=b.crownWidthM*after.scale;
 sums.beforeHeight+=a.heightM*before.scale;sums.afterHeight+=b.heightM*after.scale;sums.targetWidth+=2*t.r;
 if(before.guid!==after.guid)sums.changed++;
}
const report={woodlandMatched:sums.count,prefabsChanged:sums.changed,meanWidthBefore:sums.beforeWidth/sums.count,meanWidthAfter:sums.afterWidth/sums.count,meanSurveyWidth:sums.targetWidth/sums.count,meanHeightBefore:sums.beforeHeight/sums.count,meanHeightAfter:sums.afterHeight/sums.count,isolatedMatches:'unchanged',note:'Density proxy: four mature neighbours within 20m. Actual foliage coverage still needs visual review.'};
save('canopy-report.json',JSON.stringify(report,null,2));save('parity.tsv',fixtures.join('\n'));
console.log(JSON.stringify(report,null,2));
