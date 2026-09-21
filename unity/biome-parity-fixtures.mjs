// Generate independent expectations from the existing JS matcher for C# parity.
import fs from 'node:fs';
import {matchTree} from './tree-matching.mjs';
// bun unity/biome-parity-fixtures.mjs <trees.json> <out.tsv> [palette.json]
const [treesFile,output,paletteFile='docs/gspro/vreta/palette.json']=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(paletteFile,'utf8').replace(/^﻿/,''));
const trees=JSON.parse(fs.readFileSync(treesFile,'utf8').replace(/^\uFEFF/,'')).trees;
const lines=trees.map(t=>{
 const stem={...t,h:Math.fround(t.h),r:Math.fround(t.r)};
 const m=matchTree(stem,config);
 return [t.id,stem.h,stem.r,t.k,m.guid||'-',m.scale||0,m.rotationY||0,m.status==='review',false,m.look||'-'].join('\t');
});
fs.writeFileSync(output,lines.join('\n'));
console.log('Prepared '+lines.length+' JS expectations');
