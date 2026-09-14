import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {matchTree} from './tree-matching.mjs';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const d=path.join(stage,p);fs.mkdirSync(path.dirname(d),{recursive:true});fs.writeFileSync(d,t);};
const guid=p=>crypto.createHash('md5').update('golfmap-pine-variants:'+p).digest('hex');
const set=(t,key,rgb)=>{const re=new RegExp('(^    - '+key+': \\{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)}','m');if(!re.test(t))throw Error('Missing '+key);return t.replace(re,(_,p,a)=>p+rgb[0]+', g: '+rgb[1]+', b: '+rgb[2]+', a: '+a+'}');};
const p=JSON.parse(read('Assets/GolfMap/Vreta/palette.json'));
const c=JSON.parse(fs.readFileSync('tree-export/GolfMapCatalogue-20260911-205056-6fc852/catalogue.json','utf8').replace(/^\uFEFF/,''));
const names=new Set([...p.assets.filter(a=>a.name.startsWith('Prefab_Forest_pine')).map(a=>a.name),'Prefab_Forest_pine_04','Prefab_Forest_pine_06']);
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
for(const name of names){
 const matches=c.assets.filter(a=>a.name===name&&a.path.endsWith('.prefab'));if(matches.length!==1)throw Error('Missing/ambiguous '+name);
 const a=matches[0];if(a.error||!(a.heightM>0&&a.crownWidthM>0))throw Error('Invalid catalogue entry');
 if(!read(a.path+'.meta').includes('guid: '+a.guid))throw Error('GUID mismatch '+name);
 let prefab=read(a.path);
 for(const m of a.materials){let material=read(m.path);
  if(m.shader.includes('Bark'))material=set(material,'_Color',[.5,.5,.5]);
  else {material=set(material,'_HealthyColor',[.68,.80,.74]);if(material.includes('    - _DryColor:'))material=set(material,'_DryColor',[.64,.75,.69]);}
  const target=folder+'/Pine Variant Materials/'+m.name+'.mat',id=guid(m.path);
  save(target,material);save(target+'.meta',read(m.path+'.meta').replace(/^guid: \w+/m,'guid: '+id));
  if(!prefab.includes(m.guid))throw Error('Missing material reference '+name+' '+m.name);prefab=prefab.replaceAll(m.guid,id);
 }
 const existing=p.assets.find(x=>x.name===name),target=folder+'/'+name+'.prefab',id=existing?.guid||guid(a.path);
 save(target,prefab);save(target+'.meta',read(a.path+'.meta').replace(/^guid: \w+/m,'guid: '+id));
 const entry={guid:id,catalogueGuid:a.guid,originalPath:a.path,name,path:target,heightM:a.heightM,crownWidthM:a.crownWidthM,kind:'conifer',form:'tree',species:'pine',assetType:'prefab',enabled:true,selectionWeight:['Prefab_Forest_pine_03','Prefab_Forest_pine_05'].includes(name)?5:1};
 if(existing)Object.assign(existing,entry);else p.assets.push(entry);
}
const fir='Assets/NatureManufacture Assets/Dynamic Nature - Mountain Tree Pack/Models/Materials/M_Fir_Leaves.mat';
let mat=read(fir);mat=set(mat,'_HealthyColor',[.32,.44,.40]);mat=set(mat,'_DryColor',[.30,.41,.37]);save(fir,mat);
save('Assets/GolfMap/Vreta/palette.json',JSON.stringify(p,null,2)+'\n');
const fixtures=[],counts={};for(const row of fs.readFileSync('tree-export/canopy-pass-v2/parity.tsv','utf8').trim().split(/\r?\n/)){
 const f=row.split('\t'),t={id:f[0],h:+f[1],r:+f[2],k:+f[3],woodland:f[8]==='true',x:0,z:0};const m=matchTree(t,p);
 if(p.assets.find(a=>a.guid===m.guid)?.species==='pine')counts[m.name]=(counts[m.name]||0)+1;
 fixtures.push([t.id,t.h,t.r,t.k,m.guid||'-',m.scale||0,m.rotationY||0,m.status==='review',t.woodland].join('\t'));
}save('parity.tsv',fixtures.join('\n'));save('report.json',JSON.stringify(counts,null,2));console.log({assets:p.assets.length,pines:counts});
