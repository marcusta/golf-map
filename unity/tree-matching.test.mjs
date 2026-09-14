import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {matchTree} from './tree-matching.mjs';
const config=JSON.parse(fs.readFileSync(new URL('../docs/gspro/vreta/palette.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const birch=config.assets.find(a=>a.name==='PF Birch A large 1');
const stem={id:'sample',x:10,z:20,h:birch.heightM,r:birch.crownWidthM/2,k:0,bush:false};

test('pine preferences favour 03 and 05 without forcing a poor size fit',()=>{
 const assets=['03','05','01','04','06','B','C'].map((id,i)=>({...birch,guid:id,kind:'conifer',species:'pine',heightM:20,crownWidthM:10,selectionWeight:i<2?5:1}));
 const cfg={...config,assets};let preferred=0;
 for(let i=0;i<3000;i++){
  const s={...stem,id:'pine-'+i,h:20,r:5,k:1};const result=matchTree(s,cfg);
  if(['03','05'].includes(result.guid))preferred++;
  assert.deepEqual(matchTree(s,{...cfg,assets:[...assets].reverse()}),result);
  assert.ok(result.scale>=.75&&result.scale<=1.4);
 }
 assert.ok(preferred>1850&&preferred<2150,preferred);
 const guarded={...cfg,assets:assets.map(a=>a.selectionWeight===5?{...a,heightM:100,crownWidthM:100}:a)};
 for(let i=0;i<100;i++)assert.ok(!['03','05'].includes(matchTree({...stem,id:'guard-'+i,h:20,r:5,k:1},guarded).guid));
});

test('six equally fitting broadleaf groups follow requested weights, regardless of variant count',()=>{
 const weights={poplar:.10,broadleaf:.15,elm:.20,birch:.10,oak:.30,maple:.15};
 const assets=Object.keys(weights).flatMap(species=>Array.from({length:species==='poplar'?5:1},(_,i)=>({...birch,guid:species+i,species,heightM:10,crownWidthM:6})));
 const cfg={...config,assets,rules:{...config.rules,speciesWeights:weights}};
 const counts={};for(let i=0;i<10000;i++){
  const result=matchTree({...stem,id:'six-species-'+i,h:10,r:3},cfg);
  const species=assets.find(a=>a.guid===result.guid).species;counts[species]=(counts[species]||0)+1;
 }
 for(const [species,weight] of Object.entries(weights))assert.ok(Math.abs(counts[species]/10000-weight)<.025,species+' weight drift');
});

test('woodland pass increases overlap within uniform limits and preserves isolated/authored trees',()=>{
 const next={...config,rules:{...config.rules,woodlandCrownMultiplier:1.12,woodlandWidthWeight:2,woodlandScaleBoost:1.1}};
 assert.deepEqual(matchTree(stem,next),matchTree(stem,config));
 const one={...next,assets:[birch],rules:{...next.rules,speciesWeights:null}};
 const normal=matchTree(stem,one),wood=matchTree({...stem,woodland:true},one);
 assert.ok(wood.scale>normal.scale);assert.ok(wood.scale<=one.rules.maxScale);
 const authored=matchTree({...stem,woodland:true},one,{guid:birch.guid,scale:0.9});
 assert.equal(authored.scale,0.9);
 const huge=matchTree({...stem,woodland:true,h:100,r:30},one);
 assert.equal(huge.scale,one.rules.maxScale);assert.equal(huge.status,'review');
});
test('real palette chooses an exact natural fit',()=>{
 const result=matchTree(stem,{...config,rules:{...config.rules,variationBand:0,speciesWeights:null}});
 assert.equal(result.guid,birch.guid);assert.equal(result.scale,1);assert.equal(result.status,'proposed');
});
test('known conifers never become broadleaf; size limits are respected',()=>{
 for(const h of [2,6,15,30,100]){
  const result=matchTree({...stem,h,k:1},config);
  assert.equal(config.assets.find(a=>a.guid===result.guid).kind,'conifer');
  assert.ok(result.scale>=.75&&result.scale<=1.4);
 }
 assert.equal(matchTree({...stem,h:100,k:1},config).status,'review');
});
test('palette ordering and unrelated stems do not reshuffle choices',()=>{
 const result=matchTree(stem,config);
 matchTree({...stem,id:'unrelated'},config);
 assert.deepEqual(matchTree(stem,{...config,assets:[...config.assets].reverse()}),result);
});
test('overrides survive rules, exclusions are explicit, missing overrides fail',()=>{
 const choice={guid:birch.guid,scale:1.2,position:{x:1,z:2},rotationY:35};
 const result=matchTree({...stem,k:1},config,choice);
 assert.equal(result.guid,birch.guid);assert.equal(result.status,'authored');assert.equal(result.rotationY,35);
 assert.deepEqual(result.position,choice.position);
 assert.equal(matchTree(stem,config,{exclude:true}).status,'excluded');
 assert.throws(()=>matchTree(stem,config,{guid:'missing',scale:1}));
 if(birch.catalogueGuid)assert.equal(matchTree(stem,config,{guid:birch.catalogueGuid,scale:1}).guid,birch.guid);
});
test('zone restrictions and unknown kind remain explicit',()=>{
 assert.equal(matchTree({...stem,zoneId:'empty'},{...config,zones:{empty:{allowedGuids:[]}}}).status,'unmatched');
 assert.equal(matchTree({...stem,k:2},config).status,'review');
 assert.equal(matchTree({...stem,h:2,k:0},config).status,'unmatched');
});

test('species weights are independent of prefab count and keep a fit guard',()=>{
 const assets=['oak','elm','birch'].map(species=>({...birch,guid:species,species,heightM:10,crownWidthM:6}));
 const cfg={...config,assets,rules:{...config.rules,speciesFitSlack:.8,speciesWeights:{oak:.45,elm:.4,birch:.15}}};
 const totals={oak:0,elm:0,birch:0};
 for(let i=0;i<3000;i++){
  const s={...stem,id:'mix-'+i,h:10,r:3};
  const a=matchTree(s,cfg);totals[a.guid]++;
  const expanded={...cfg,assets:[...assets,...Array.from({length:6},(_,j)=>({...assets[2],guid:'birch-'+j}))]};
  assert.equal(expanded.assets.find(x=>x.guid===matchTree(s,expanded).guid).species,a.guid);
 }
 assert.ok(totals.oak>1100&&totals.oak<1600);assert.ok(totals.elm>950&&totals.elm<1450);assert.ok(totals.birch>300&&totals.birch<650);
 const guarded={...cfg,assets:assets.map(a=>a.species==='birch'?a:{...a,heightM:100,crownWidthM:100})};
 assert.equal(matchTree({...stem,h:10,r:3},guarded).guid,'birch');
});
