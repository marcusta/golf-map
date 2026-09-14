import fs from 'node:fs';
import path from 'node:path';
import {matchTree} from './tree-matching.mjs';
const [root,stage]=process.argv.slice(2);
if(!root||!stage||fs.existsSync(stage))throw Error('Provide UNITY_ROOT NEW_STAGE');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const save=(p,t)=>{const d=path.join(stage,p);fs.mkdirSync(path.dirname(d),{recursive:true});fs.writeFileSync(d,t);};
const p=JSON.parse(read('Assets/GolfMap/Vreta/palette.json'));
p.rules.woodlandSpeciesFitSlack=1.5;
save('Assets/GolfMap/Vreta/palette.json',JSON.stringify(p,null,2)+'\n');
for(const [name,value] of [['Birch Bark',.68],['Oak Bark',.72]]){
 const file='Assets/GolfMap/Vreta/FoliageTrialV2/'+name+'.mat';let t=read(file);
 const re=/    - _Color: \{r: [^,]+, g: [^,]+, b: [^,]+, a: ([^}]+)}/;
 if(!re.test(t))throw Error('Missing bark tint');
 t=t.replace(re,(_,a)=>`    - _Color: {r: ${value}, g: ${value}, b: ${value}, a: ${a}}`);save(file,t);
}
// Reuse the density classifications from the audited inner export for parity.
const rows=fs.readFileSync('tree-export/canopy-pass-v2/parity.tsv','utf8').trim().split(/\r?\n/);
const totals={},fixtures=[];let review=0,broadleaf=0;
for(const row of rows){const f=row.split('\t');const t={id:f[0],h:+f[1],r:+f[2],k:+f[3],woodland:f[8]==='true',x:0,z:0};
 const m=matchTree(t,p),a=p.assets.find(a=>a.guid===m.guid);
 if(t.k===0&&a){totals[a.species]=(totals[a.species]||0)+1;broadleaf++;if(m.status==='review')review++;}
 fixtures.push([t.id,t.h,t.r,t.k,m.guid||'-',m.scale||0,m.rotationY||0,m.status==='review',t.woodland].join('\t'));
}
save('parity.tsv',fixtures.join('\n'));save('report.json',JSON.stringify({broadleaf,totals,review},null,2));console.log({broadleaf,totals,review});
