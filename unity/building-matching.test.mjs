import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchBuilding} from './building-matching.mjs';

const assets=[
 {guid:'villa',name:'Villa 12x8',lengthM:12,widthM:8,heightM:7,kinds:['detached','house','yes'],axis:'x'},
 {guid:'villa-z',name:'Villa 10x7 (z long)',lengthM:10,widthM:7,heightM:6.5,kinds:['detached','house','yes'],axis:'z'},
 {guid:'barn',name:'Barn 30x12',lengthM:30,widthM:12,heightM:9,kinds:['barn','farm_auxiliary'],axis:'x'},
 {guid:'shed',name:'Shed 4x3',lengthM:4,widthM:3,heightM:2.6,kinds:['shed','garage'],axis:'x'},
 {guid:'block',name:'Apartments 40x14',lengthM:40,widthM:14,heightM:12,kinds:['apartments'],axis:'x'},
];
const config={format:'golfmap-building-palette-v1',seed:'test',assets,plot:{sizeM:5000}};
const house=(over={})=>({id:'osm:way/1',kind:'detached',x:2500,z:2500,lengthM:12.5,widthM:8.2,yawDeg:30,heightM:7.2,heightSource:'lidar',...over});

test('a villa gets the villa, rotated to the footprint, scaled in XZ and Y separately',()=>{
 const r=matchBuilding(house({x:4000,z:4000}),config);
 assert.equal(r.guid,'villa');
 assert.equal(r.status,'proposed');
 assert.equal(r.rotationY,30);
 assert.ok(Math.abs(r.scale.x-1.033)<0.01&&r.scale.x===r.scale.z,JSON.stringify(r.scale));
 assert.ok(Math.abs(r.scale.y-7.2/7)<1e-9);
 assert.equal(r.alternatives[0].guid,'villa');
});

test('a prefab whose long side is local z is turned 90 more; flip adds 180',()=>{
 const only={...config,assets:[assets[1]]};
 assert.equal(matchBuilding(house({x:4000,z:4000}),only).rotationY,120);
 assert.equal(matchBuilding(house({x:4000,z:4000}),only,{flip:true}).rotationY,300);
 assert.equal(matchBuilding(house({x:4000,z:4000,yawDeg:350}),only).rotationY,80);
});

test('near the course the band is tight and the building is flagged for review',()=>{
 const far=matchBuilding(house({x:4000,z:4000,lengthM:18,widthM:12}),config);
 const near=matchBuilding(house({x:2600,z:2500,lengthM:18,widthM:12}),config);
 assert.equal(far.guid,'villa');
 assert.ok(far.scale.x>1.15,String(far.scale.x));
 assert.equal(near.near,true);
 assert.ok(near.scale.x<=1.15);
 assert.equal(near.status,'review');
 assert.ok(near.reasons.some(s=>s.includes('Within 400 m')));
 assert.ok(near.reasons.some(s=>s.includes('Footprint fit')));
 assert.equal(far.status,'proposed');
});

test('kind steers the choice without forcing a bad size',()=>{
 const shed=matchBuilding(house({x:4000,z:4000,kind:'garage',lengthM:4.2,widthM:3.1,heightM:2.5}),config);
 assert.equal(shed.guid,'shed');
 // A "garage" the size of a barn is a barn-sized building first.
 const big=matchBuilding(house({x:4000,z:4000,kind:'garage',lengthM:31,widthM:12,heightM:9}),config);
 assert.equal(big.guid,'barn');
 assert.ok(big.reasons.includes('Prefab kind does not match garage'));
});

test('an unmeasured height uses the assumed height and says so',()=>{
 const r=matchBuilding(house({x:4000,z:4000,heightM:0,heightSource:'none'}),config);
 assert.equal(r.measured.heightM,null);
 assert.ok(r.reasons.some(s=>s.includes('No lidar height')));
 assert.equal(r.status,'review');
});

test('overrides win: authored prefab, scales, rotation, exclusion',()=>{
 const authored=matchBuilding(house(),config,{guid:'barn',footprintScale:0.5,heightScale:0.8,rotationY:12});
 assert.equal(authored.status,'authored');
 assert.deepEqual([authored.guid,authored.scale.x,authored.scale.y,authored.rotationY],['barn',0.5,0.8,12]);
 assert.equal(matchBuilding(house(),config,{exclude:true}).status,'excluded');
 assert.throws(()=>matchBuilding(house(),config,{guid:'nope'}),/missing from palette/);
});

test('results are deterministic and independent of asset order',()=>{
 for(let i=0;i<50;i++){
  const b=house({id:'b'+i,x:3000+i*7,z:4000,lengthM:11+i%3,widthM:7.5,heightM:6.8});
  const a=matchBuilding(b,config),c=matchBuilding(b,{...config,assets:[...assets].reverse()});
  assert.deepEqual(a,c);
 }
});

test('an empty palette is unmatched, invalid input throws',()=>{
 assert.equal(matchBuilding(house(),{...config,assets:[]}).status,'unmatched');
 assert.throws(()=>matchBuilding({...house(),id:''},config),/stable ID/);
 assert.throws(()=>matchBuilding(house({lengthM:0}),config),/Invalid building/);
});
