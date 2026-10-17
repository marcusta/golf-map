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
test('open-grown crown pad widens solitary trees only; off by default',()=>{
 const one={...config,assets:[birch],rules:{...config.rules,speciesWeights:null,scaleJitter:0}};
 const padded={...one,rules:{...one.rules,openCrownPadM:2,openWidthWeight:1.5}};
 const base=matchTree(stem,one),open=matchTree(stem,padded);
 assert.equal(base.scale,1);assert.ok(open.scale>base.scale);
 assert.deepEqual(matchTree(stem,{...one,rules:{...one.rules,openCrownPadM:0,openWidthWeight:0}}),base);
 const wood={...padded,rules:{...padded.rules,woodlandCrownMultiplier:1.12,woodlandWidthWeight:2}};
 assert.deepEqual(matchTree({...stem,woodland:true},wood),matchTree({...stem,woodland:true},{...wood,rules:{...wood.rules,openCrownPadM:0,openWidthWeight:0}}));
 const shrubs={...config,rules:{...config.rules,speciesWeights:null}};
 const bush={...stem,h:2,r:1,k:1};
 assert.deepEqual(matchTree(bush,{...shrubs,rules:{...shrubs.rules,openCrownPadM:2,openWidthWeight:1.5}}),matchTree(bush,shrubs));
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

test('looks split a species by weight without moving any stem to another shape',()=>{
 const assets=['a','b','c'].map(guid=>({...birch,guid,species:'oak',heightM:10,crownWidthM:6}));
 const plain={...config,assets,species:undefined};
 const looks={...plain,species:{oak:{looks:[{id:'default',weight:.8},{id:'dry',weight:.2},{id:'off',weight:0},{id:'only-a',weight:.5,shapes:['a']}]}}};
 const counts={};
 for(let i=0;i<6000;i++){
  const s={...stem,id:'look-'+i,h:10,r:3};const before=matchTree(s,plain),after=matchTree(s,looks);
  assert.equal(before.look,undefined);assert.equal(after.guid,before.guid);
  if(after.look==='only-a')assert.equal(after.guid,'a');
  if(after.guid!=='a')counts[after.look]=(counts[after.look]||0)+1;
 }
 assert.equal(counts.off,undefined);
 const share=counts.dry/(counts.dry+counts.default);assert.ok(share>.17&&share<.23,share);
});

test('conifers and unlabelled assets join the species race under their kind only when weighted',()=>{
 const assets=[{...birch,guid:'fir',kind:'conifer',species:undefined,heightM:10,crownWidthM:6},{...birch,guid:'spruce',kind:'conifer',species:'spruce',heightM:10,crownWidthM:6}];
 const weighted={...config,assets,rules:{...config.rules,speciesWeights:{...config.rules.speciesWeights,conifer:.75,spruce:.25}}};
 let fir=0;
 for(let i=0;i<4000;i++)if(matchTree({...stem,id:'conifer-'+i,h:10,r:3,k:1},weighted).guid==='fir')fir++;
 assert.ok(fir>2850&&fir<3150,fir);
});

test('asset weights share stems within the drawn species and leave unweighted species alone',()=>{
 const make=(guid,species,selectionWeight)=>({...birch,guid,species,heightM:10,crownWidthM:6,selectionWeight});
 const cfg=w=>({...config,assets:[make('o1','oak',w),make('o2','oak'),make('e1','elm'),make('e2','elm')],rules:{...config.rules,speciesWeights:{oak:1,elm:1}}});
 let o1=0,oak=0;
 for(let i=0;i<6000;i++){
  const s={...stem,id:'share-'+i,h:10,r:3};const plain=matchTree(s,cfg(undefined)),shared=matchTree(s,cfg(3));
  if(plain.guid[0]==='e')assert.equal(shared.guid,plain.guid);
  else{oak++;if(shared.guid==='o1')o1++;}
 }
 assert.ok(o1/oak>.71&&o1/oak<.79,o1/oak);
});

test('scale jitter and lean vary neighbours without changing the pick or authored trees',()=>{
 const varied={...config,rules:{...config.rules,scaleJitter:.1,maxLeanDeg:3}};
 const off=matchTree(stem,config);assert.equal(off.leanDeg,0);assert.equal(off.leanDirectionY,0);
 const ratios=[],leans=[];
 for(let i=0;i<4000;i++){
  const s={...stem,id:'jitter-'+i,h:12,r:3};const plain=matchTree(s,config),v=matchTree(s,varied);
  assert.equal(v.guid,plain.guid);assert.equal(v.status,plain.status);assert.equal(v.rotationY,plain.rotationY);assert.equal(v.look,plain.look);
  assert.deepEqual(matchTree(s,varied),v);
  const ratio=v.scale/plain.scale;assert.ok(ratio>=.9&&ratio<=1.1,ratio);ratios.push(ratio);
  assert.ok(v.leanDeg>=0&&v.leanDeg<=3);assert.ok(v.leanDirectionY>=0&&v.leanDirectionY<360);leans.push(v.leanDeg);
 }
 // Spread across the whole band, not bunched: a quarter of stems in each quarter of it.
 for(const [lo,hi] of [[.9,.95],[.95,1],[1,1.05],[1.05,1.1]]){const n=ratios.filter(r=>r>=lo&&r<hi).length/ratios.length;assert.ok(n>.22&&n<.28,lo+': '+n);}
 assert.ok(Math.abs(leans.reduce((a,b)=>a+b)/leans.length-1.5)<.1);
 const authored=matchTree(stem,varied,{guid:birch.guid,scale:.9,rotationY:10});
 assert.equal(authored.scale,.9);assert.equal(authored.rotationY,10);assert.ok(authored.leanDeg>0);
});

test('a tree species area races its own mix, whatever the fit, and only the mix',()=>{
 // oak fits badly (twice the size), birch and elm fit well: the palette would pick by fit and its weights.
 const assets=[{...birch,guid:'oak',species:'oak',heightM:20,crownWidthM:12},{...birch,guid:'birch',species:'birch',heightM:10,crownWidthM:6},{...birch,guid:'elm',species:'elm',heightM:10,crownWidthM:6}];
 const cfg={...config,assets,rules:{...config.rules,speciesFitSlack:.2,speciesWeights:{oak:1,birch:1,elm:1}}};
 const area={species:[{species:'oak',weight:9},{species:'birch',weight:1}],ignoreKind:false};
 const totals={oak:0,birch:0,elm:0},outside={oak:0,birch:0,elm:0};
 for(let i=0;i<3000;i++){
  const s={...stem,id:'area-'+i,h:10,r:3,k:0};
  totals[matchTree(s,cfg,undefined,area).guid]++;
  outside[matchTree(s,cfg).guid]++;
 }
 assert.equal(totals.elm,0);                                // not in the mix
 assert.ok(totals.oak>2550&&totals.oak<2850,totals.oak);     // ~90% although oak fits worst
 assert.equal(outside.oak,0);                               // outside the area the fit guard keeps it out
});

test('an area respects the survey class unless it ignores it, and falls back to the palette without a fitting form',()=>{
 const assets=[{...birch,guid:'oak',species:'oak',kind:'broadleaf'},{...birch,guid:'pine',species:'pine',kind:'conifer'}];
 const cfg={...config,assets};
 const oaks={species:[{species:'oak',weight:1}],ignoreKind:false};
 const conifer={...stem,id:'kind-1',k:1};
 assert.equal(matchTree(conifer,cfg,undefined,oaks).guid,'pine');                          // a conifer keeps the palette's conifers
 assert.equal(matchTree(conifer,cfg,undefined,{...oaks,ignoreKind:true}).guid,'oak');       // unless the area overrides the survey
 const shrub={...stem,id:'kind-2',h:2,r:1,k:1};
 const withShrub={...cfg,assets:[...assets,{...birch,guid:'dwarf',species:'pine',kind:'conifer',form:'shrub',heightM:2,crownWidthM:2}]};
 assert.equal(matchTree(shrub,withShrub,undefined,{...oaks,ignoreKind:true}).guid,'dwarf'); // no oak shrub: the palette decides
 assert.equal(matchTree({...stem,id:'kind-3'},cfg,{guid:'pine',scale:1},oaks).guid,'pine'); // an authored choice wins over the area
});
