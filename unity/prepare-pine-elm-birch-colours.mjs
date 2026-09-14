// Private material/prefab copies, including the pine cross-card LOD materials.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const guid=p=>crypto.createHash('md5').update('golfmap-cool-foliage:'+p).digest('hex');
const set=(text,key,rgb)=>{
 const re=new RegExp('(^    - '+key+': \\{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)}','m');
 if(!re.test(text))throw Error('Missing colour '+key);
 return text.replace(re,(_,prefix,a)=>prefix+rgb[0]+', g: '+rgb[1]+', b: '+rgb[2]+', a: '+a+'}');
};
let birch=read(folder+'/Birch Leaves.mat');
birch=set(birch,'_HealthyColor',[.34,.49,.43]);birch=set(birch,'_DryColor',[.32,.46,.40]);
save(folder+'/Birch Leaves.mat',birch);
const palette=JSON.parse(read('Assets/GolfMap/Vreta/palette.json'));
const index=new Map();
for(const file of execFileSync('rg',['--files',path.join(root,'Assets'),'-g','*.mat.meta'],{encoding:'utf8'}).trim().split(/\r?\n/)){
 const meta=fs.readFileSync(file,'utf8');const id=meta.match(/^guid: (\w+)/m)?.[1];if(id)index.set(id,path.relative(root,file.slice(0,-5)).replaceAll('\\','/'));
}
const remapped=new Map(),report=[];
for(const asset of palette.assets.filter(a=>a.enabled&&(a.species==='elm'||a.name.toLowerCase().includes('pine')))){
 const original=asset.path;let prefab=read(original);let count=0;
 const refs=[...new Set([...prefab.matchAll(/fileID: 2100000, guid: (\w+)/g)].map(m=>m[1]))];
 for(const id of refs){const source=index.get(id);if(!source)throw Error('Material missing '+id);
  const material=read(source);
  if(!material.includes('    - _HealthyColor:'))continue; // Preserve trunk/cut/knot materials.
  let entry=remapped.get(id);
  if(!entry){
   const elm=asset.species==='elm';let modified=set(material,'_HealthyColor',elm?[.44,.56,.49]:[.52,.65,.61]);
   modified=set(modified,'_DryColor',elm?[.46,.58,.51]:[.48,.59,.55]);
   const target=folder+'/Cool Foliage/'+path.posix.basename(source,'.mat')+'-'+id.slice(0,8)+'.mat';
   const next=guid(source);save(target,modified);save(target+'.meta',read(source+'.meta').replace(/^guid: \w+/m,'guid: '+next));
   entry={target,guid:next};remapped.set(id,entry);
  }
  count+=prefab.split(id).length-1;prefab=prefab.replaceAll(id,entry.guid);
 }
 if(!count)throw Error('No foliage remapped on '+asset.name);
 const target=folder+'/'+asset.name+'.prefab';
 const next=original===target?asset.guid:guid(original);
 save(target,prefab);save(target+'.meta',read(original+'.meta').replace(/^guid: \w+/m,'guid: '+next));
 if(original!==target){asset.catalogueGuid=asset.catalogueGuid||asset.guid;asset.originalPath=asset.originalPath||original;asset.guid=next;asset.path=target;}
 report.push({name:asset.name,foliageReferences:count});
}
save('Assets/GolfMap/Vreta/palette.json',JSON.stringify(palette,null,2)+'\n');
save('colour-report.json',JSON.stringify({prefabs:report,materials:[...remapped.values()]},null,2));
console.log(JSON.stringify({prefabs:report,privateMaterials:remapped.size},null,2));
