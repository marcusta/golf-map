// NatureManufacture's Tree Leaves Metalic reads smoothness as _MetalicRAOGSmothnessA.a x
// _SmoothnessPower. With that map unassigned Unity substitutes the white default, so smoothness
// sits at _SmoothnessPower for every texel: leaves become mirror-smooth and flare white at
// grazing angles. Where the package ships no mask (the CESimgolf elms), the fix is to clamp
// _SmoothnessPower instead; where it ships one, assign it (see prepare-birch-leaf-maps.mjs).
// Scans every material reachable from the enabled palette so new prefabs get caught too.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage,limit='0.152']=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE [SMOOTHNESS_LIMIT]');
const clamp=Number(limit);
if(!(clamp>=0&&clamp<=1))throw Error('Bad smoothness limit '+limit);
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const index=new Map();
const walk=dir=>{
 for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
  const rel=dir+'/'+entry.name;
  if(entry.isDirectory())walk(rel);
  else if(entry.name.endsWith('.mat.meta')){
   const id=/^guid: (\w+)/m.exec(read(rel))?.[1];
   if(id)index.set(id,rel.slice(0,-5));
  }
 }
};
walk('Assets');
const palette=JSON.parse(read('Assets/GolfMap/Vreta/palette.json'));
const materials=new Map();
for(const asset of palette.assets.filter(a=>a.enabled))
 for(const id of new Set([...read(asset.path).matchAll(/fileID: 2100000, guid: (\w+)/g)].map(m=>m[1]))){
  const file=index.get(id);
  if(file)materials.set(file,(materials.get(file)||[]).concat(asset.species+'/'+asset.name));
 }
const fixed=[];
for(const [file,users] of materials){
 const text=read(file);
 const mask=/^    - _MetalicRAOGSmothnessA:\n        m_Texture: \{([^}]*)\}/m.exec(text);
 const power=/^    - _SmoothnessPower: ([-0-9.]+)$/m.exec(text);
 if(!mask||mask[1]!=='fileID: 0'||!power||+power[1]<=clamp)continue;
 save(file,text.replace(/^(    - _SmoothnessPower: )[-0-9.]+$/m,(_,p)=>p+clamp));
 fixed.push({material:path.posix.basename(file,'.mat'),was:+power[1],now:clamp,users:[...new Set(users)]});
}
if(!fixed.length)throw Error('No unmasked glossy leaf materials found');
save('report.json',JSON.stringify(fixed,null,2)+'\n');
console.log(JSON.stringify(fixed,null,2));
