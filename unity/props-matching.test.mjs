import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchPlacedProps, matchRecordedProps, pairNearest, deltaAngle} from './props-matching.mjs';

// One asset ("shelter"), two instances. The frame does not matter to the rule: spec positions are
// EPSG:3006 e/n, scene transforms are Unity world metres.
const specOf = (e, n, yawDeg = 90, dz = 0, scale = [1, 1, 1]) => ({e, n, yawDeg, dz, scale});
const poseOf = (x, y, z, yaw = 0, scale = [1, 1, 1]) => ({pos: [x, y, z], euler: [0, yaw, 0], scale});

// A place that put #0 at (10, 50.2, 20) and #1 at (40, 51, 20), straight from the spec.
const baseRecords = () => ([
 {name: 'shelter#0', index: 0, hand: false, spec: specOf(1000, 2000), placed: poseOf(10, 50.2, 20, 0)},
 {name: 'shelter#1', index: 1, hand: false, spec: specOf(1030, 2000), placed: poseOf(40, 51, 20, 0)},
]);
const baseSpecs = () => ([
 {index: 0, spec: specOf(1000, 2000)},
 {index: 1, spec: specOf(1030, 2000)},
]);
const untouchedScene = () => ([
 {name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)},
 {name: 'shelter#1', pose: poseOf(40, 51, 20, 0)},
]);
const ruleOf = r => r.decisions.map(d => [d.rule, d.kept]);

test('nothing touched: every instance takes the spec again', () => {
 const r = matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene: untouchedScene()});
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['unmoved', false]]);
 assert.equal(r.dropped.length, 0);
});

test('an instance dragged in Unity keeps the transform the user gave it', () => {
 const scene = untouchedScene();
 scene[1] = {name: 'shelter#1', pose: poseOf(43.5, 51.2, 22, 37)};
 const r = matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene});
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['hand-moved', true]]);
 assert.deepEqual(r.decisions[1].keep.pos, [43.5, 51.2, 22]);
 assert.deepEqual(r.decisions[1].keep.euler, [0, 37, 0]);
 assert.deepEqual(r.decisions[1].was.pos, [40, 51, 20]);
 assert.ok(r.decisions[1].movedM > 3.5 && r.decisions[1].movedDeg === 37);
});

test('under the tolerance nothing counts as a hand move: 9 mm and 0.4 deg are the tool\'s own noise', () => {
 const scene = untouchedScene();
 scene[0] = {name: 'shelter#0', pose: poseOf(10.009, 50.2, 20, 0.4)};
 const r = matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene});
 assert.deepEqual(ruleOf(r)[0], ['unmoved', false]);
 scene[0] = {name: 'shelter#0', pose: poseOf(10.011, 50.2, 20, 0)};
 assert.deepEqual(ruleOf(matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene}))[0], ['hand-moved', true]);
 scene[0] = {name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0.6)};
 assert.deepEqual(ruleOf(matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene}))[0], ['hand-moved', true]);
 scene[0] = {name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0, [1.002, 1, 1])};
 assert.deepEqual(ruleOf(matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene}))[0], ['hand-moved', true]);
});

test('a tilt counts as a hand edit too (the tool only ever sets yaw)', () => {
 const scene = untouchedScene();
 scene[0] = {name: 'shelter#0', pose: {pos: [10, 50.2, 20], euler: [3, 0, 0], scale: [1, 1, 1]}};
 assert.deepEqual(ruleOf(matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene}))[0], ['hand-moved', true]);
});

test('a hand move stays kept over the next places, without the user touching it again', () => {
 // the place that kept it recorded hand: true at the hand transform
 const records = baseRecords();
 records[1] = {name: 'shelter#1', index: 1, hand: true, spec: specOf(1030, 2000), placed: poseOf(43.5, 51.2, 22, 37)};
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'shelter#1', pose: poseOf(43.5, 51.2, 22, 37)}];
 const r = matchPlacedProps({specs: baseSpecs(), records, scene});
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['hand-kept', true]]);
 assert.deepEqual(r.decisions[1].keep.pos, [43.5, 51.2, 22]);
});

test('the spec wins over an old hand move once the spec moved that instance', () => {
 const records = baseRecords();
 records[1] = {name: 'shelter#1', index: 1, hand: true, spec: specOf(1030, 2000), placed: poseOf(43.5, 51.2, 22, 37)};
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'shelter#1', pose: poseOf(43.5, 51.2, 22, 37)}];
 // the user edited the .gen.py: 0.9 m north
 const specs = [{index: 0, spec: specOf(1000, 2000)}, {index: 1, spec: specOf(1030, 2000.9)}];
 const r = matchPlacedProps({specs, records, scene});
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['spec-moved', false]]);
 assert.ok(Math.abs(r.decisions[1].specMovedM - 0.9) < 1e-9);
 // 8 mm is under the tolerance: still the user's
 const nudged = [{index: 0, spec: specOf(1000, 2000)}, {index: 1, spec: specOf(1030, 2000.008)}];
 assert.deepEqual(ruleOf(matchPlacedProps({specs: nudged, records, scene})), [['unmoved', false], ['hand-kept', true]]);
 // so is a yaw the spec turned by 0.4 deg; 0.6 deg is a spec change
 const turned = y => [{index: 0, spec: specOf(1000, 2000)}, {index: 1, spec: specOf(1030, 2000, y)}];
 assert.deepEqual(ruleOf(matchPlacedProps({specs: turned(90.4), records, scene}))[1], ['hand-kept', true]);
 assert.deepEqual(ruleOf(matchPlacedProps({specs: turned(90.6), records, scene}))[1], ['spec-moved', false]);
 // a spec dz change is a spec move as well
 const lifted = [{index: 0, spec: specOf(1000, 2000)}, {index: 1, spec: specOf(1030, 2000, 90, 0.3)}];
 assert.deepEqual(ruleOf(matchPlacedProps({specs: lifted, records, scene}))[1], ['spec-moved', false]);
});

test('records pair by nearest recorded position, not by index: a place() call removed from the spec', () => {
 // #0 is gone from the spec, so the remaining instance is index 0 but it is the old #1
 const records = baseRecords();
 records[1] = {name: 'shelter#1', index: 1, hand: true, spec: specOf(1030, 2000), placed: poseOf(43.5, 51.2, 22, 37)};
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'shelter#1', pose: poseOf(43.5, 51.2, 22, 37)}];
 const r = matchPlacedProps({specs: [{index: 0, spec: specOf(1030, 2000)}], records, scene});
 assert.deepEqual(ruleOf(r), [['hand-kept', true]]);
 assert.equal(r.decisions[0].record, 'shelter#1');
 assert.deepEqual(r.decisions[0].keep.pos, [43.5, 51.2, 22]);
 assert.deepEqual(r.dropped.map(d => d.name), ['shelter#0']);
});

test('a new place() call in the spec has no record and takes the spec', () => {
 const specs = [...baseSpecs(), {index: 2, spec: specOf(1060, 2000)}];
 const r = matchPlacedProps({specs, records: baseRecords(), scene: untouchedScene()});
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['unmoved', false], ['no-record', false]]);
});

test('closest pair first: two instances the spec swapped round still pair with their own record', () => {
 const records = [
   {name: 'shelter#0', index: 0, hand: true, spec: specOf(1000, 2000), placed: poseOf(10, 50.2, 20, 0)},
   {name: 'shelter#1', index: 1, hand: true, spec: specOf(1002, 2000), placed: poseOf(12, 50.2, 20, 0)},
 ];
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'shelter#1', pose: poseOf(12, 50.2, 20, 0)}];
 // the spec lists them the other way round now
 const specs = [{index: 0, spec: specOf(1002, 2000)}, {index: 1, spec: specOf(1000, 2000)}];
 const r = matchPlacedProps({specs, records, scene});
 assert.deepEqual(r.decisions.map(d => d.record), ['shelter#1', 'shelter#0']);
 assert.deepEqual(r.decisions.map(d => d.keep.pos), [[12, 50.2, 20], [10, 50.2, 20]]);
});

test('an instance the user deleted takes the spec, unless an earlier place kept it by hand', () => {
 const records = baseRecords();
 const r = matchPlacedProps({specs: baseSpecs(), records, scene: [untouchedScene()[0]]});
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['no-instance', false]]);
 records[1] = {...records[1], hand: true, placed: poseOf(43.5, 51.2, 22, 37)};
 const kept = matchPlacedProps({specs: baseSpecs(), records, scene: [untouchedScene()[0]]});
 assert.deepEqual(ruleOf(kept)[1], ['hand-recorded', true]);
 assert.deepEqual(kept.decisions[1].keep.pos, [43.5, 51.2, 22]);
});

test('a renamed scene object is found by nearest recorded position, within matchM', () => {
 const near = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'range shelter', pose: poseOf(40.5, 51, 20, 37)}];
 const r = matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene: near});
 assert.deepEqual(ruleOf(r)[1], ['hand-moved', true]);
 assert.deepEqual(r.decisions[1].keep.pos, [40.5, 51, 20]);
 // renamed AND dragged further than matchM: there is no way to tell which instance it was, so the
 // spec decides (the name is what carries a long hand move)
 const far = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'range shelter', pose: poseOf(43.5, 51.2, 22, 37)}];
 assert.deepEqual(ruleOf(matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene: far}))[1], ['no-instance', false]);
});

test('no records at all (the first place after this existed): everything from the spec', () => {
 const r = matchPlacedProps({specs: baseSpecs(), records: [], scene: untouchedScene()});
 assert.deepEqual(ruleOf(r), [['no-record', false], ['no-record', false]]);
 assert.equal(r.dropped.length, 0);
});

test('pairNearest is one to one, closest pair first, with no radius', () => {
 assert.deepEqual(pairNearest([[0, 0], [10, 0]], [[10.2, 0], [0.1, 0]]), [1, 0]);
 // b runs out
 assert.deepEqual(pairNearest([[0, 0], [10, 0], [20, 0]], [[0, 0]]), [0, -1, -1]);
 // no radius: a lone point 500 m away still pairs, because nothing else wants that entry
 assert.deepEqual(pairNearest([[500, 0]], [[0, 0]]), [0]);
 // EPSG:3006 magnitudes keep their millimetres (a float northing would lose half a metre)
 assert.deepEqual(pairNearest([[512345.67, 6482210.4], [512345.67, 6482212.4]],
                              [[512345.67, 6482212.4], [512345.67, 6482210.41]]), [1, 0]);
});

// The tie the two implementations used to break differently: C#'s Math.Round(double) is banker's
// rounding (2.5 -> 2), JS Math.round is half up (2.5 -> 3). a1 is 2.5 mm from b0 and a0 is 3 mm from
// it, so half up makes both 3 - a draw that the a index settles, giving b0 to a0 - while half to even
// makes them 2 and 3 and gives b0 to a1 instead. C# now asks for MidpointRounding.AwayFromZero.
test('pairNearest: an exact half-millimetre rounds half UP, as JS Math.round does', () => {
 assert.equal(Math.round(2.5), 3);
 assert.equal(Math.hypot(0.0025, 0) * 1000, 2.5, 'the half millimetre is exact in doubles');
 const paired = pairNearest([[0.003, 0], [0.0025, 0]], [[0, 0], [100, 0]]);
 assert.deepEqual(paired, [0, 1], 'both round to 3 mm, so the first a point takes b0');
});

// The bug this rule exists for: the scene was placed with an older spec, so every object's #i is off by
// a constant. Names would pair each mat with the spec entry 2 along the row and report 5 "hand moves"
// (on Vreta: 88 of them, 11 range_mat all off by exactly 5.745-5.805 m).
const matRow = (n, x0 = 100) => Array.from({length: n}, (_, k) => ({index: k, plan: [x0 + 2 * k, 40]}));
const matScene = (n, shift = 0, x0 = 100) => Array.from({length: n}, (_, k) => ({
 name: 'range_mat#' + (k + shift),
 pose: {pos: [x0 + 2 * k, 50.4, 40], euler: [0, 90, 0], scale: [1, 1, 1]},
}));

test('record: a stale index shift is not a hand move - 5 mats shifted by 2 give 0 hand-placed', () => {
 const r = matchRecordedProps({asset: 'range_mat', specs: matRow(5), scene: matScene(5, 2)});
 assert.equal(r.handPlaced, 0);
 assert.equal(r.pairedByPosition, 5);
 assert.equal(r.indexStillRight, 0);
 assert.deepEqual(r.notInScene, []);
 // each mat took the spec entry it actually stands on, not the one its name says
 assert.deepEqual(r.records.map(x => [x.name, x.index]), [
   ['range_mat#2', 0], ['range_mat#3', 1], ['range_mat#4', 2], ['range_mat#5', 3], ['range_mat#6', 4]]);
 assert.deepEqual(r.records.map(x => x.offSpecM), [0, 0, 0, 0, 0]);
 assert.deepEqual(r.records.map(x => x.pairedBy), ['position', 'position', 'position', 'position', 'position']);
});

test('record: an unshifted row pairs by name and is also 0 hand-placed', () => {
 const r = matchRecordedProps({asset: 'range_mat', specs: matRow(5), scene: matScene(5)});
 assert.equal(r.handPlaced, 0);
 assert.equal(r.indexStillRight, 5);
 assert.equal(r.pairedByPosition, 0);
});

test('record: a real hand move inside a shifted row is still found, and only that one', () => {
 const scene = matScene(5, 2);
 scene[2] = {...scene[2], pose: {pos: [104 + 1.5, 50.4, 41.2], euler: [0, 115, 0], scale: [1, 1, 1]}};
 const r = matchRecordedProps({asset: 'range_mat', specs: matRow(5), scene});
 assert.equal(r.handPlaced, 1);
 const moved = r.records.find(x => x.hand);
 assert.equal(moved.name, 'range_mat#4');
 assert.equal(moved.index, 2, 'the unmoved mats pair at distance 0 first, so only its own entry is left');
 assert.ok(Math.abs(moved.offSpecM - Math.hypot(1.5, 1.2)) < 1e-9, String(moved.offSpecM));
});

test('record: mark=all marks every instance, shift or no shift', () => {
 const r = matchRecordedProps({asset: 'range_mat', specs: matRow(5), scene: matScene(5, 2), markAll: true});
 assert.equal(r.handPlaced, 5);
 assert.ok(r.records.every(x => x.hand && x.offSpecM === 0));
});

test('record: an instance with no spec entry left is unpaired, a spec entry with no instance is notInScene', () => {
 const more = matchRecordedProps({asset: 'range_mat', specs: matRow(4), scene: matScene(5, 2)});
 assert.equal(more.handPlaced, 1);
 const lone = more.records.find(x => x.index === -1);
 assert.equal(lone.name, 'range_mat#6');
 assert.equal(lone.spec, null);
 assert.equal(lone.hand, true);
 assert.deepEqual(more.notInScene, []);
 const fewer = matchRecordedProps({asset: 'range_mat', specs: matRow(6), scene: matScene(5, 2)});
 assert.equal(fewer.handPlaced, 0);
 assert.deepEqual(fewer.notInScene, [5]);
});

test('record: nothing in the scene for an asset, or nothing in the spec', () => {
 const none = matchRecordedProps({asset: 'range_mat', specs: matRow(3), scene: []});
 assert.deepEqual(none.notInScene, [0, 1, 2]);
 assert.equal(none.records.length, 0);
 const orphans = matchRecordedProps({asset: 'range_mat', specs: [], scene: matScene(2, 2)});
 assert.equal(orphans.handPlaced, 2);
 assert.ok(orphans.records.every(x => x.index === -1 && x.spec === null && x.hand));
});

test('place: a record without a spec entry pairs with nothing and is reported dropped', () => {
 const records = [
   {name: 'shelter#0', index: 0, hand: false, spec: specOf(1000, 2000), placed: poseOf(10, 50.2, 20, 0)},
   {name: 'shelter#9', index: -1, hand: true, spec: null, placed: poseOf(99, 51, 20, 0)},
 ];
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'shelter#9', pose: poseOf(99, 51, 20, 0)}];
 const r = matchPlacedProps({specs: [{index: 0, spec: specOf(1000, 2000)}], records, scene});
 assert.deepEqual(ruleOf(r), [['unmoved', false]]);
 assert.deepEqual(r.dropped.map(d => d.name), ['shelter#9']);
});

test('place: an instance duplicated by hand in Unity is kept, not deleted', () => {
 // Ctrl+D on shelter#1 in Unity, then dragged a few metres: no record made it, so the old rule
 // paired it with nothing and the next place destroyed it without a word.
 const scene = [...untouchedScene(), {name: 'shelter#1 (1)', pose: poseOf(60, 51, 24, 12)}];
 const r = matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene});
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['unmoved', false]]);
 assert.deepEqual(r.handAdded.map(s => s.name), ['shelter#1 (1)']);
 assert.deepEqual(r.handAdded[0].pose.pos, [60, 51, 24]);
 assert.equal(r.dropped.length, 0);
 // it is only "added by hand" because no record claims it: a duplicate within matchM of a record
 // whose own object is gone is still read as that record's instance, renamed
 const renamed = [untouchedScene()[0], {name: 'shelter#1 (1)', pose: poseOf(40.5, 51, 20, 0)}];
 const near = matchPlacedProps({specs: baseSpecs(), records: baseRecords(), scene: renamed});
 assert.deepEqual(near.handAdded, []);
});

test('place: the record pairing has no radius either - a spec entry moved 30 m keeps its record and loses to it', () => {
 const records = baseRecords();
 records[1] = {name: 'shelter#1', index: 1, hand: true, spec: specOf(1030, 2000), placed: poseOf(43.5, 51.2, 22, 37)};
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0)}, {name: 'shelter#1', pose: poseOf(43.5, 51.2, 22, 37)}];
 const specs = [{index: 0, spec: specOf(1000, 2000)}, {index: 1, spec: specOf(1060, 2000)}];
 const r = matchPlacedProps({specs, records, scene});
 // it still finds its own record (distance 30 m, nothing nearer is free), and the spec move wins
 assert.deepEqual(ruleOf(r), [['unmoved', false], ['spec-moved', false]]);
 assert.equal(r.decisions[1].record, 'shelter#1');
 assert.ok(Math.abs(r.decisions[1].specMovedM - 30) < 1e-9);
});

test('yaw wraps: 359 deg to 1 deg is 2 deg, not 358', () => {
 assert.equal(deltaAngle(359, 1), 2);
 assert.equal(deltaAngle(1, 359), -2);
 const records = baseRecords();
 records[0] = {...records[0], placed: poseOf(10, 50.2, 20, 359.8)};
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0.1)}, untouchedScene()[1]];
 assert.deepEqual(ruleOf(matchPlacedProps({specs: baseSpecs(), records, scene}))[0], ['unmoved', false]);
});
