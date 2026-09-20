// NatureManufacture's leaf shaders draw leaf cards with Cull Off and mirror the normal on back
// faces only when _BackFaceMirrorNormal is on:
//     switchResult = (ASEVFace > 0) ? normal : normal * -1;
//     o.Normal = lerp(normal, switchResult, _BackFaceMirrorNormal);
// At 0 a card seen from behind lights as if it faced away from the sun and renders dark - speckled
// on fine-leaved trees like birch, in whole patches on elms, whose clusters are large cards facing
// the same way. The package ships it off; every leaf material here needs it on.
// Bark is left alone: it is solid geometry with no back faces to mirror.
import fs from 'node:fs';
import path from 'node:path';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const index=new Map();
const walk=dir=>{
 for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
  const rel=dir+'/'+entry.name;
  if(entry.isDirectory())walk(rel);
  else if(entry.name.endsWith('.mat.meta')||entry.name.endsWith('.shader.meta')){
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
const fixed=[],skipped=[];
for(const [file,users] of materials){
 const text=read(file);
 const shader=index.get(/m_Shader: \{fileID: \d+, guid: (\w+)/.exec(text)?.[1]);
 const leaf=shader&&/Leaves/i.test(path.posix.basename(shader));
 const flag=/^    - _BackFaceMirrorNormal: ([-0-9.]+)$/m.exec(text);
 if(!flag)continue;
 const name=path.posix.basename(file,'.mat');
 if(!leaf){skipped.push({material:name,reason:'not a leaf shader'});continue;}
 if(+flag[1]!==0){skipped.push({material:name,reason:'already mirrored'});continue;}
 save(file,text.replace(/^(    - _BackFaceMirrorNormal: )[-0-9.]+$/m,(_,p)=>p+1));
 fixed.push({material:name,species:[...new Set(users)]});
}
if(!fixed.length)throw Error('No leaf material still has back-face mirroring off');
save('report.json',JSON.stringify({fixed,skipped},null,2)+'\n');
console.log(JSON.stringify({fixed,skipped},null,2));
