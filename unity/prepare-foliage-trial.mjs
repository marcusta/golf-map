// Stage dedicated prefab/material copies. Installation into Unity is a separate step.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root=process.argv[2],stage=process.argv[3];
if(!root||!stage||fs.existsSync(stage))throw Error('Provide Unity project and a NEW staging directory');
const read=p=>fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');
const palette=JSON.parse(read('docs/gspro/vreta/palette.json'));
const guid=s=>crypto.createHash('md5').update('golfmap-foliage-v2:'+s).digest('hex');
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
const materialSpecs=[
 {source:'Assets/Oak Trees Package/Oak Trees Version 2.0/Sources/Shared Materials/M_Oak_Leaves.mat',name:'Oak Leaves',changes:{_AmbientTranslucency:'1',_TranslucencyStrength:'0.45'}},
 {source:'Assets/Birch Trees Package/Birches Version 3.0/Sources/Shared Materials/Birch Leaves.mat',name:'Birch Leaves',changes:{_HealthyColor:'{r: 0.8, g: 0.86, b: 0.74, a: 1}',_DryColor:'{r: 0.75, g: 0.77, b: 0.56, a: 1}'}}
];
const remap={};const manifest=[];
function save(relative,text){const f=path.join(stage,relative);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);}
function copyMeta(source,target){const meta=read(path.join(root,source+'.meta'));const old=meta.match(/^guid: (\w+)/m)[1],next=guid(source);save(target+'.meta',meta.replace(/^guid: \w+/m,'guid: '+next));return {old,next};}
for(const spec of materialSpecs){
 let text=read(path.join(root,spec.source));
 for(const [property,value] of Object.entries(spec.changes)){
  const re=new RegExp('(^    - '+property+': )[^\\r\\n]+','m');
  if(!re.test(text))throw Error('Missing material property '+property);
  text=text.replace(re,(_,prefix)=>prefix+value);
 }
 const target=folder+'/'+spec.name+'.mat',ids=copyMeta(spec.source,target);
 save(target,text);remap[ids.old]=ids.next;manifest.push({...spec,target,guid:ids.next});
}
for(const a of palette.assets.filter(a=>['oak','birch'].includes(a.species))){
 if(a.catalogueGuid)throw Error('Palette already uses trial copies');
 const target=folder+'/'+a.name+'.prefab',ids=copyMeta(a.path,target);
 let text=read(path.join(root,a.path));let replaced=0;
 for(const [old,next] of Object.entries(remap))text=text.replaceAll(old,()=>{replaced++;return next;});
 if(!replaced)throw Error('No target leaf material on '+a.name);
 save(target,text);manifest.push({source:a.path,target,guid:ids.next,referencesReplaced:replaced});
 a.catalogueGuid=a.guid;a.originalPath=a.path;a.guid=ids.next;a.path=target;
}
save('manifest.json',JSON.stringify(manifest,null,2));
fs.writeFileSync('docs/gspro/vreta/palette.json',JSON.stringify(palette,null,2)+'\n');
console.log('Staged '+manifest.length+' assets; original assets unchanged.');
