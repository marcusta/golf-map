// A compact summary of what the matcher makes of a trees file, for comparing two versions of it:
// per stem its model (the model id without a 'vsp:' prefix, or the asset's name before the model
// library), scale, rotation, look and lean, as a count and a sha256.
import crypto from 'node:crypto';
import fs from 'node:fs';
import {matchTree} from '../tree-matching.mjs';

export const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));

export function matchingDigest(treesFile,config){
 const file=readJson(treesFile);
 const areas=new Map((file.areas||[]).map(a=>[a.id,a]));
 const rows=file.trees.map(t=>{
  const stem={...t,h:Math.fround(t.h),r:Math.fround(t.r)};
  const m=matchTree(stem,config,undefined,t.area?areas.get(t.area):undefined);
  const model=(m.model??m.name??'-').replace(/^vsp:/,'');
  return [t.id,m.status,model,(m.scale||0).toFixed(5),(m.rotationY||0).toFixed(3),m.look||'-',(m.leanDeg||0).toFixed(4),(m.leanDirectionY||0).toFixed(3)].join('\t');
 });
 return {count:rows.length,sha256:crypto.createHash('sha256').update(rows.join('\n')).digest('hex'),sample:rows.slice(0,5)};
}
