// Stage a repeatable middle-brightness pass; never write package assets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [root,stage]=process.argv.slice(2);
if(!root||!stage)throw Error('Usage: node prepare-foliage-balance.mjs UNITY_ROOT STAGE');
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const set=(t,k,v)=>{const re=new RegExp('(^    - '+k+': )[^\\r\\n]+','m');if(!re.test(t))throw Error('Missing '+k);return t.replace(re,(_,p)=>p+v);};
let oak=read(folder+'/Oak Leaves.mat');
oak=set(oak,'_GolfMapLeafTint','{r: 0.32, g: 0.45, b: 0.23, a: 1}');
oak=set(oak,'_AmbientTranslucency','0.35');oak=set(oak,'_TranslucencyStrength','0.25');
save(folder+'/Oak Leaves.mat',oak);
let birch=read(folder+'/Birch Leaves.mat');
birch=set(birch,'_HealthyColor','{r: 0.65, g: 0.74, b: 0.50, a: 1}');
birch=set(birch,'_DryColor','{r: 0.60, g: 0.66, b: 0.40, a: 1}');
save(folder+'/Birch Leaves.mat',birch);
const original='Assets/Trees/Broadleaf/Broadleaf_Desktop.prefab';
let prefab=read(original);let count=0;
const matRoot='Assets/Trees/Broadleaf/Broadleaf_Desktop Materials';
for(const lod of fs.readdirSync(path.join(root,matRoot))){
 const dir=path.join(root,matRoot,lod);if(!fs.statSync(dir).isDirectory())continue;
 for(const name of fs.readdirSync(dir).filter(n=>/^(Leaves|FacingLeaves|Fronds).*\.mat$/.test(n))){
  const src=matRoot+'/'+lod+'/'+name, meta=read(src+'.meta');
  const old=meta.match(/^guid: (\w+)/m)[1];if(!prefab.includes(old))continue;
  const guid=crypto.createHash('md5').update('golfmap-balance:'+src).digest('hex');
  let mat=read(src);
  const colour=/    - _Color: \{r: ([\d.]+), g: ([\d.]+), b: ([\d.]+), a: ([\d.]+)}/;
  if(!colour.test(mat))throw Error('Missing leaf tint: '+src);
  const lift=v=>Math.min(1,Number(v)*1.15).toFixed(6);
  mat=mat.replace(colour,(_,r,g,b,a)=>`    - _Color: {r: ${lift(r)}, g: ${lift(g)}, b: ${lift(b)}, a: ${a}}`);
  const dest=folder+'/Balanced Broadleaf/'+lod+'/'+name;
  save(dest,mat);save(dest+'.meta',meta.replace(/^guid: \w+/m,'guid: '+guid));
  prefab=prefab.replaceAll(old,guid);count++;
 }
}
if(!count)throw Error('No broadleaf foliage materials found');
const meta=read(original+'.meta');
save(folder+'/Broadleaf Balanced.prefab',prefab);
save(folder+'/Broadleaf Balanced.prefab.meta',meta.replace(/^guid: \w+/m,'guid: '+crypto.createHash('md5').update('golfmap-balance:'+original).digest('hex')));
console.log('Staged oak/birch balance and '+count+' broadleaf foliage materials across LODs.');
