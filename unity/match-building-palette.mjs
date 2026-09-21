// node unity/match-building-palette.mjs <unity-buildings.json> <palette.json> <output.json> [overrides.json]
//
// Offline proposal generator for the building planter (the tree
// match-tree-palette.mjs sibling): every building in a unity-buildings-v1
// file gets a prefab from a golfmap-building-palette-v1 palette, or an
// authored choice from the overrides file (keyed by building id:
// { "osm:way/123": { guid, footprintScale?, heightScale?, rotationY?, flip?,
// position? } | { exclude: true } }). Generating a report modifies nothing;
// GolfMapBuildingPlanter (Unity) validates and applies it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {matchBuilding} from './building-matching.mjs';
const [input,palette,output,overrides]=process.argv.slice(2);
if(!output)throw Error('Provide buildings, palette and output paths');
if(fs.existsSync(output))throw Error('Output exists: choose a new report path');
const read=p=>fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'');
const source=read(input),configuration=read(palette),overrideText=overrides?read(overrides):'{}';
const buildings=JSON.parse(source),config=JSON.parse(configuration),choices=JSON.parse(overrideText);
if(buildings.format!=='unity-buildings-v1'||config.format!=='golfmap-building-palette-v1')throw Error('Unsupported input format');
const ids=new Set();
const cfg={...config,plot:buildings.plot};
const assignments=buildings.buildings.map(b=>{if(ids.has(b.id))throw Error('Duplicate building ID '+b.id);ids.add(b.id);return matchBuilding(b,cfg,choices[b.id]);});
const summary={};for(const a of assignments)summary[a.status]=(summary[a.status]||0)+1;
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
fs.writeFileSync(output,JSON.stringify({format:'golfmap-building-assignments-v1',algorithm:'footprint-height-band-v1',
 sourceHash:digest(source),paletteHash:digest(configuration),overridesHash:digest(overrideText),plot:buildings.plot,summary,
 unusedOverrideIds:Object.keys(choices).filter(id=>!ids.has(id)),assignments},null,2));
console.log(JSON.stringify(summary));
