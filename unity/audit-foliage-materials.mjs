// Audit every material reachable from the enabled palette prefabs: which shader it uses, whether
// the maps that shader's smoothness/specular come from are actually assigned, and the resulting
// smoothness. A missing mask map falls back to Unity's white default, which pins smoothness at
// full and makes the canopy flare white at grazing angles.
import fs from 'node:fs';
import path from 'node:path';
const root=process.argv[2];
if(!root)throw Error('Provide UNITY_ROOT');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
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
const slot=(t,key)=>{
 const found=new RegExp('^    - '+key+':\\n        m_Texture: \\{([^}]*)\\}','m').exec(t);
 return found?(found[1]==='fileID: 0'?'MISSING':'ok'):'-';
};
const float=(t,key)=>{const f=new RegExp('^    - '+key+': ([-0-9.]+)$','m').exec(t);return f?+f[1]:null;};
const seen=new Map();
for(const asset of palette.assets.filter(a=>a.enabled)){
 const prefab=read(asset.path);
 for(const id of new Set([...prefab.matchAll(/fileID: 2100000, guid: (\w+)/g)].map(m=>m[1]))){
  const file=index.get(id);
  if(!file){console.log('  !! material not found',id,'in',asset.name);continue;}
  const row=seen.get(file)||{file,users:new Set()};
  row.users.add(asset.species+'/'+asset.name);
  seen.set(file,row);
 }
}
const rows=[];
for(const row of seen.values()){
 const text=read(row.file);
 const shaderGuid=/m_Shader: \{fileID: \d+, guid: (\w+)/.exec(text)?.[1];
 const shader=index.get(shaderGuid);
 const shaderName=shader?path.posix.basename(shader,'.shader'):shaderGuid;
 const smoothness=float(text,'_SmoothnessPower');
 rows.push({
  material:path.posix.basename(row.file,'.mat'),
  shader:shaderName,
  mask:slot(text,'_MetalicRAOGSmothnessA'),
  bump:slot(text,'_BumpMap'),
  translucency:slot(text,'_TranslucencyMap'),
  bumpSpec:slot(text,'_BumpSpecMap'),
  smoothnessPower:smoothness,
  glossiness:float(text,'_Glossiness'),
  metallicPower:float(text,'_MetallicPower'),
  // The NM leaf/bark shaders read smoothness as mask.a * power; an unassigned mask samples white.
  effective:smoothness===null?null:(slot(text,'_MetalicRAOGSmothnessA')==='MISSING'?Math.min(1,smoothness):null),
  species:[...row.users].sort().join(' '),
 });
}
rows.sort((a,b)=>(b.effective??-1)-(a.effective??-1)||a.material.localeCompare(b.material));
for(const r of rows){
 const flag=r.effective!==null&&r.effective>=0.5?'  <-- WHITE FLARE':'';
 console.log([r.material.padEnd(34),r.shader.padEnd(26),'mask:'+r.mask.padEnd(8),'bump:'+r.bump.padEnd(8),
  'smoothPow:'+String(r.smoothnessPower).padEnd(6),'effective:'+String(r.effective).padEnd(6),r.species].join(' ')+flag);
}
