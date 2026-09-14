import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const dest=path.join(stage,p);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,t);};
const set=(t,key,rgb)=>{const re=new RegExp('(^    - '+key+': \\{r: )[^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)}','m');if(!re.test(t))throw Error('Missing '+key);return t.replace(re,(_,p,a)=>p+rgb[0]+', g: '+rgb[1]+', b: '+rgb[2]+', a: '+a+'}');};
const folder='Assets/GolfMap/Vreta/FoliageTrialV2';
let birch=read(folder+'/Birch Leaves.mat');
birch=set(birch,'_HealthyColor',[.22,.37,.38]);birch=set(birch,'_DryColor',[.21,.35,.36]);save(folder+'/Birch Leaves.mat',birch);
// These four fir entries include three model assets. Their shared material gives
// consistent mesh LOD colouring without changing model import settings or GUIDs.
const firPath='Assets/NatureManufacture Assets/Dynamic Nature - Mountain Tree Pack/Models/Materials/M_Fir_Leaves.mat';
let fir=read(firPath);fir=set(fir,'_HealthyColor',[.46,.59,.54]);fir=set(fir,'_DryColor',[.42,.55,.50]);save(firPath,fir);
const p=JSON.parse(read('Assets/GolfMap/Vreta/palette.json'));
const remap=new Map();
for(const name of ['M_Pine_trunk_01','M_Pine_trunk_03','M_Pine_trunk_05']){
 const source='Assets/NatureManufacture Assets/Mountain Environment/Pine_trees/Materialas/'+name+'.mat';
 const meta=read(source+'.meta'),old=meta.match(/^guid: (\w+)/m)[1];
 const next=crypto.createHash('md5').update('golfmap-pine-bark:'+source).digest('hex');
 const target=folder+'/Pine Bark/'+name+'.mat';
 save(target,set(read(source),'_Color',[.62,.62,.62]));save(target+'.meta',meta.replace(/^guid: \w+/m,'guid: '+next));
 remap.set(old,next);
}
const report=[];
for(const a of p.assets.filter(a=>a.name.startsWith('Prefab_Forest_pine'))){
 if(!a.path.startsWith(folder+'/'))throw Error('Expected private pine prefab '+a.name);
 let text=read(a.path),count=0;
 for(const [old,next] of remap){count+=text.split(old).length-1;text=text.replaceAll(old,next);}
 if(!count)throw Error('Missing pine bark references '+a.name);
 save(a.path,text);report.push({name:a.name,barkSlots:count});
}
save('report.json',JSON.stringify(report,null,2));console.log(report);
