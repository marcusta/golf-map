import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {matchTree} from './tree-matching.mjs';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8').replace(/^\uFEFF/,'');
const save=(p,t)=>{const d=path.join(stage,p);fs.mkdirSync(path.dirname(d),{recursive:true});fs.writeFileSync(d,t);};
const guid=p=>crypto.createHash('md5').update('golfmap-expanded-palette:'+p).digest('hex');
const catalogue=JSON.parse(fs.readFileSync('tree-export/GolfMapCatalogue-20260911-205056-6fc852/catalogue.json','utf8').replace(/^\uFEFF/,''));
const p=JSON.parse(read('Assets/GolfMap/Vreta/palette.json'));
p.rules.speciesWeights={poplar:.10,broadleaf:.15,elm:.20,birch:.10,oak:.30,maple:.15};
// VSP draws one renderer per LOD with the instance transform only, so the
// "High Quality" poplars (two or three renderers per LOD, tilted leaf meshes,
// offset roots) render as flat leaf blobs. The VS_ prefabs are NM's one-mesh
// per LOD builds for Vegetation Studio; all poplars use them.
const names=['VS_prefab_01_Poplar','VS_prefab_07_Poplar','VS_prefab_05_Poplar','VS_prefab_03_Poplar','VS_prefab_06_Poplar','Broadleaf_Desktop','Elm-Split PREFAB','Maple','Elm','PF_Oak_tall_bare Terrain','PF_Oak_tall Terrain'];
const retired=['prefab_01_Poplar','prefab_06_Poplar_skan','prefab_Baked_03_Poplar','prefab_Baked_05_Poplar','prefab_Baked_07_Poplar'];
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
for(const name of names){
 const found=catalogue.assets.filter(a=>a.name===name&&a.path.endsWith('.prefab'));
 if(found.length!==1)throw Error('Ambiguous/missing prefab '+name);
 const a=found[0];if(a.error||!(a.heightM>0&&a.crownWidthM>0))throw Error('Invalid catalogue measurement '+name);
 if(!read(a.path+'.meta').includes('guid: '+a.guid))throw Error('Catalogue GUID changed '+name);
 const species=name.includes('Poplar')?'poplar':name.startsWith('PF_Oak_')?'oak':name==='Maple'?'maple':name==='Broadleaf_Desktop'?'broadleaf':'elm';
 let target=a.path,next=a.guid;
 if(species==='broadleaf'){
  target=folder+'/Broadleaf Balanced.prefab';next=read(target+'.meta').match(/^guid: (\w+)/m)[1];
 }else if(species==='oak'){
  let prefab=read(a.path);
  for(const m of a.materials){
   const prepared=m.name==='M_Oak_Bark'?'Oak Bark':m.name==='M_Oak_Leaves'?'Oak Leaves':null;
   if(!prepared)throw Error('Unrecognized oak material '+m.name);
   const materialGuid=read(folder+'/'+prepared+'.mat.meta').match(/^guid: (\w+)/m)[1];
   if(!prefab.includes(m.guid))throw Error('Oak material reference changed '+name);
   prefab=prefab.replaceAll(m.guid,materialGuid);
  }
  target=folder+'/'+name+'.prefab';next=guid(a.path);save(target,prefab);save(target+'.meta',read(a.path+'.meta').replace(/^guid: \w+/m,'guid: '+next));
 }else if(species==='elm'||species==='poplar'){
  let prefab=read(a.path);
  for(const m of a.materials){
   let material=read(m.path);
   if(!material.includes('    - _HealthyColor:'))continue;
   for(const [key,rgb] of [['_HealthyColor',[.44,.56,.49]],['_DryColor',[.46,.58,.51]]]){
    const re=new RegExp('(^    - '+key+': \\{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)}','m');
    // Cross-card shaders can expose only the healthy tint.
    if(re.test(material))material=material.replace(re,(_,prefix,alpha)=>prefix+rgb[0]+', g: '+rgb[1]+', b: '+rgb[2]+', a: '+alpha+'}');
   }
   const mt=folder+'/Expanded Foliage/'+m.name+'-'+m.guid.slice(0,8)+'.mat';
   const mg=guid(m.path);save(mt,material);save(mt+'.meta',read(m.path+'.meta').replace(/^guid: \w+/m,'guid: '+mg));
   if(!prefab.includes(m.guid))throw Error('Catalogue material reference changed '+name+' / '+m.name);
   prefab=prefab.replaceAll(m.guid,mg);
  }
  target=folder+'/'+name+'.prefab';next=guid(a.path);save(target,prefab);save(target+'.meta',read(a.path+'.meta').replace(/^guid: \w+/m,'guid: '+next));
 }
 const entry={guid:next,name,path:target,heightM:a.heightM,crownWidthM:a.crownWidthM,kind:'broadleaf',form:'tree',species,assetType:'prefab',enabled:true};
 if(next!==a.guid)Object.assign(entry,{catalogueGuid:a.guid,originalPath:a.path});
 const existing=p.assets.findIndex(x=>x.name===name);if(existing>=0)p.assets[existing]=entry;else p.assets.push(entry);
}
p.assets=p.assets.filter(a=>!retired.includes(a.name));
save('Assets/GolfMap/Vreta/palette.json',JSON.stringify(p,null,2)+'\n');
const rows=fs.readFileSync('tree-export/canopy-pass-v2/parity.tsv','utf8').trim().split(/\r?\n/),fixtures=[],counts={};
for(const row of rows){const f=row.split('\t');const t={id:f[0],h:+f[1],r:+f[2],k:+f[3],woodland:f[8]==='true',x:0,z:0};
 const m=matchTree(t,p),a=p.assets.find(a=>a.guid===m.guid);
 if(t.k===0&&a)counts[a.species]=(counts[a.species]||0)+1;
 fixtures.push([t.id,t.h,t.r,t.k,m.guid||'-',m.scale||0,m.rotationY||0,m.status==='review',t.woodland].join('\t'));
}
save('parity.tsv',fixtures.join('\n'));save('mix-report.json',JSON.stringify(counts,null,2));console.log({assets:p.assets.length,counts});
