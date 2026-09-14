// node unity/match-tree-palette.mjs <unity-trees.json> <palette.json> <output.json> [overrides.json]
import fs from 'node:fs';
import crypto from 'node:crypto';
import {matchTree} from './tree-matching.mjs';
const [input,palette,output,overrides]=process.argv.slice(2);
if(!output)throw Error('Provide trees, palette and output paths');
if(fs.existsSync(output))throw Error('Output exists: choose a new report path');
const read=p=>fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');
const source=read(input),configuration=read(palette),overrideText=overrides?read(overrides):'{}';
const trees=JSON.parse(source),config=JSON.parse(configuration),choices=JSON.parse(overrideText);
if(trees.format!=='unity-trees-v1'||config.format!=='golfmap-tree-palette-v1')throw Error('Unsupported input format');
const ids=new Set();
const assignments=trees.trees.map(t=>{if(ids.has(t.id))throw Error('Duplicate stem ID '+t.id);ids.add(t.id);return matchTree(t,config,choices[t.id]);});
const summary={};for(const a of assignments)summary[a.status]=(summary[a.status]||0)+1;
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
fs.writeFileSync(output,JSON.stringify({format:'golfmap-tree-assignments-v1',algorithm:'uniform-species-fit-v2',
 sourceHash:digest(source),paletteHash:digest(configuration),overridesHash:digest(overrideText),plot:trees.plot,summary,
 unusedOverrideIds:Object.keys(choices).filter(id=>!ids.has(id)),assignments},null,2));
console.log(JSON.stringify(summary));
