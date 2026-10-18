// Acceptance A2: the size fit picks among a species' models by their own sizes, Arborist models
// included. Omberg's beech and elm are Arborist-only models (Marcus, Arborist Ultra lineup 2026-10-18);
// their sizes are the Arborist catalogue's (data/arborist/catalog-sizes.json, first LOD).
// A stem of exactly one model's size, grown in the open, gets that model: the worked examples
// below were checked by hand against the fit's score (the runner-up scores > 0.2, well outside
// the palette's variationBand), and 50 stem ids each rule out a lucky draw.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchTree} from '../tree-matching.mjs';
import {loadCoursePalette} from '../tree-models.mjs';

const omberg=loadCoursePalette('docs/gspro/ombergs-golfklubb');
const BEECH=['Forest_Large_beech_tree_03','Forest_Large_beech_tree_04','Forest_Large_beech_tree_05',
 'CE_DA_Forest_Tree_16018','CE_DA_Forest_Tree_18195','CE_DA_Forest_Tree_11164'].map(l=>'arborist:'+l);
const ELM=['S7_American_Elm','CE_Oak_CE_Tall_Fanned_1','CE_Oak_CE_Tall_Fanned_2','CE_Oak_CE_Tall_Fanned_3'].map(l=>'arborist:'+l);

const only=species=>({...omberg,assets:omberg.assets.filter(a=>a.species===species)});
// The lidar loses an open-grown crown's edge: the fit adds openCrownPadM to the measured width.
const openStem=(id,heightM,crownWidthM)=>({id,x:100,z:200,k:0,h:heightM,r:(crownWidthM-(omberg.rules.openCrownPadM||0))/2});

test("Omberg's beech and elm are exactly the approved Arborist models, sized from Arborist's catalogue",()=>{
 const models=species=>omberg.assets.filter(a=>a.species===species&&a.enabled!==false).map(a=>a.model).sort();
 assert.deepEqual(models('beech'),[...BEECH].sort());
 assert.deepEqual(models('elm'),[...ELM].sort());
 const size=model=>omberg.assets.find(a=>a.model===model);
 assert.ok(Math.abs(size('arborist:CE_DA_Forest_Tree_11164').heightM-28.2)<0.05);
 assert.ok(Math.abs(size('arborist:CE_DA_Forest_Tree_11164').crownWidthM-15.6)<0.05);
 assert.ok(Math.abs(size('arborist:CE_DA_Forest_Tree_16018').heightM-22.9)<0.05);
 assert.ok(Math.abs(size('arborist:CE_DA_Forest_Tree_16018').crownWidthM-14.0)<0.05);
 // The stand-ins are gone: no Unity prefab is a beech or an elm any more.
 assert.ok(!omberg.assets.some(a=>['beech','elm'].includes(a.species)&&!String(a.model).startsWith('arborist:')));
});

for(const [species,heightM,crownWidthM,expected] of [
 ['beech',28.2,15.6,'arborist:CE_DA_Forest_Tree_11164'],
 ['beech',20.9,18.0,'arborist:Forest_Large_beech_tree_05'],
 ['elm',16.8,17.9,'arborist:CE_Oak_CE_Tall_Fanned_2'],
]){
 test(`a ${heightM} m ${species} with a ${crownWidthM} m crown becomes ${expected}`,()=>{
  for(let i=0;i<50;i++){
   const m=matchTree(openStem(`${species}-${heightM}-${i}`,heightM,crownWidthM),only(species));
   assert.equal(m.model,expected,`stem ${i}`);
   assert.ok(Math.abs(m.scale-1)<0.12,`stem ${i}: scale ${m.scale}`);   // its own size, give or take the jitter
  }
 });
}
