// Generate independent expectations from the existing JS matcher for C# parity.
import fs from 'node:fs';
import {matchTree} from './tree-matching.mjs';
// bun unity/biome-parity-fixtures.mjs <trees.json> <out.tsv> [palette.json]
const [treesFile,output,paletteFile='docs/gspro/vreta/palette.json']=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(paletteFile,'utf8').replace(/^\uFEFF/,''));
const file=JSON.parse(fs.readFileSync(treesFile,'utf8').replace(/^\uFEFF/,''));
const trees=file.trees;
// Tree species areas (gspro.py trees --course): the stem's area travels in the last
// column as `<species>:<weight>,...;<ignoreKind 0|1>` ('-' = none).
const areas=new Map((file.areas||[]).map(a=>[a.id,a]));
const areaSpec=a=>a?a.species.map(s=>s.species+':'+s.weight).join(',')+';'+(a.ignoreKind?1:0):'-';
const lines=trees.map(t=>{
 const stem={...t,h:Math.fround(t.h),r:Math.fround(t.r)};
 const area=t.area?areas.get(t.area):undefined;
 const m=matchTree(stem,config,undefined,area);
 return [t.id,stem.h,stem.r,t.k,m.guid||'-',m.scale||0,m.rotationY||0,m.status==='review',false,m.look||'-',m.leanDeg||0,m.leanDirectionY||0,areaSpec(area)].join('\t');
});
fs.writeFileSync(output,lines.join('\n'));
console.log('Prepared '+lines.length+' JS expectations');
