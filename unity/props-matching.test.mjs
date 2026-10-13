import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchPlacedProps, deltaAngle} from './props-matching.mjs';

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

test('yaw wraps: 359 deg to 1 deg is 2 deg, not 358', () => {
 assert.equal(deltaAngle(359, 1), 2);
 assert.equal(deltaAngle(1, 359), -2);
 const records = baseRecords();
 records[0] = {...records[0], placed: poseOf(10, 50.2, 20, 359.8)};
 const scene = [{name: 'shelter#0', pose: poseOf(10, 50.2, 20, 0.1)}, untouchedScene()[1]];
 assert.deepEqual(ruleOf(matchPlacedProps({specs: baseSpecs(), records, scene}))[0], ['unmoved', false]);
});
