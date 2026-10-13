// Pure props re-place rule: on a `golfmap.props.place`, which instances keep the transform the
// user gave them in Unity and which take the spec again (the tree-matching.mjs /
// building-matching.mjs sibling, and the mirror of `GolfMapPropsPlaced.Decide` in
// unity/Editor/GolfMap/GolfMapPropsPlaced.cs — change both together).
//
// props.place used to rebuild `GolfMap Props/<Category>s/<asset>#<i>` from the spec and drop every
// prop moved or rotated by hand. Now each place records, in `<props folder>/placed.json`, the
// transform it gave each instance and the spec entry it came from, and the next place decides per
// instance. Matching is never by the instance index (`#i` goes stale as soon as the spec gains or
// loses a `place(...)` call):
//
//   scene object -> record    by object name, then (a renamed object) the nearest unclaimed record
//                             within `matchM` of where the tool left it;
//   record -> spec entry      by the nearest recorded spec position (e, n), one to one, closest first.
//
// The decision, per spec entry (`rule` is the branch that decided):
//
//   no-record       no record paired with it: new, or the spec moved it further than matchM -> spec
//   unmoved         it stands where the tool put it -> spec
//   no-instance     nothing in the scene for it and it was never hand-placed -> spec
//   spec-moved      hand-placed, but the spec moved this instance since it was recorded -> spec wins
//   hand-moved      moved/rotated/scaled in Unity since the tool placed it -> kept
//   hand-kept       kept by an earlier place and still standing there -> kept
//   hand-recorded   hand-placed earlier, nothing in the scene now -> kept, at the recorded transform
export const DEFAULT_TOLERANCE = { positionM: 0.01, rotDeg: 0.5, scale: 0.001, matchM: 2 };

export function deltaAngle(a, b) {
 let d = (b - a) % 360;
 if (d > 180) d -= 360;
 if (d < -180) d += 360;
 return d;
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rotDelta = (a, b) => Math.max(...[0, 1, 2].map(i => Math.abs(deltaAngle(a[i], b[i]))));
const scaleDelta = (a, b) => Math.max(...[0, 1, 2].map(i => Math.abs(a[i] - b[i]) / Math.max(1e-6, Math.abs(b[i]))));
const pose = p => ({ pos: [...p.pos], euler: [...(p.euler || [0, 0, 0])], scale: [...(p.scale || [1, 1, 1])] });

// record -> the instance standing in the scene for it: by name, else the nearest unclaimed instance
// within matchM of where the tool left it.
function pairScene(records, scene, tol) {
 const found = new Map(), taken = new Set();
 for (const r of records) {
   const byName = scene.find(s => s.name === r.name);
   if (!byName) continue;
   found.set(r, byName.pose); taken.add(byName.name);
 }
 for (const r of records) {
   if (found.has(r)) continue;
   let best = null, bestD = tol.matchM;
   for (const s of scene) {
     if (taken.has(s.name)) continue;
     const d = distance(s.pose.pos, r.placed.pos);
     if (d <= bestD) { bestD = d; best = s; }
   }
   if (best) { found.set(r, best.pose); taken.add(best.name); }
 }
 return found;
}

// spec entry -> record index (-1 for none): nearest recorded spec position, one to one, closest pair
// first. Distances are rounded to the millimetre so both implementations break ties the same way.
function pairSpecs(specs, records, tol) {
 const paired = specs.map(() => -1), pairs = [];
 for (let i = 0; i < specs.length; i++)
   for (let k = 0; k < records.length; k++) {
     const d = Math.hypot(specs[i].spec.e - records[k].spec.e, specs[i].spec.n - records[k].spec.n);
     if (d > tol.matchM) continue;
     pairs.push([i, k, Math.round(d * 1000)]);
   }
 pairs.sort((x, y) => x[2] - y[2] || x[0] - y[0] || x[1] - y[1]);
 const usedRecord = new Set();
 for (const [i, k] of pairs) {
   if (paired[i] >= 0 || usedRecord.has(k)) continue;
   paired[i] = k; usedRecord.add(k);
 }
 return paired;
}

// specs:   [{index, spec:{e, n, yawDeg, dz, scale:[x,y,z]}}]           one asset's manifest instances
// records: [{name, index, hand, spec:{...}, placed:{pos, euler, scale}}]  that asset's placed.json rows
// scene:   [{name, pose:{pos, euler, scale}}]                          what stands in the scene now
// -> {decisions: [{index, kept, rule, record, keep, was, movedM, movedDeg, movedScale,
//                  specMovedM, specMovedDeg, specMovedScale}],
//     dropped: [record, ...]}   records no spec entry claimed (the spec lost that place() call)
export function matchPlacedProps({ specs, records = [], scene = [], tolerance } = {}) {
 const tol = { ...DEFAULT_TOLERANCE, ...(tolerance || {}) };
 const inScene = pairScene(records, scene, tol);
 const paired = pairSpecs(specs, records, tol);
 const decisions = specs.map((entry, i) => {
   const d = {
     index: entry.index, kept: false, rule: null, record: null, keep: null, was: null,
     movedM: 0, movedDeg: 0, movedScale: 0, specMovedM: 0, specMovedDeg: 0, specMovedScale: 0,
   };
   const record = paired[i] < 0 ? null : records[paired[i]];
   if (!record) { d.rule = 'no-record'; return d; }
   d.record = record.name;
   d.was = pose(record.placed);
   const now = inScene.get(record) || null;
   let moved = false;
   if (now) {
     d.movedM = distance(now.pos, record.placed.pos);
     d.movedDeg = rotDelta(now.euler || [0, 0, 0], record.placed.euler || [0, 0, 0]);
     d.movedScale = scaleDelta(now.scale || [1, 1, 1], record.placed.scale || [1, 1, 1]);
     moved = d.movedM > tol.positionM || d.movedDeg > tol.rotDeg || d.movedScale > tol.scale;
   }
   if (!(record.hand || moved)) { d.rule = now ? 'unmoved' : 'no-instance'; return d; }
   d.specMovedM = Math.max(
     Math.hypot(entry.spec.e - record.spec.e, entry.spec.n - record.spec.n),
     Math.abs((entry.spec.dz || 0) - (record.spec.dz || 0)));
   d.specMovedDeg = Math.abs(deltaAngle(record.spec.yawDeg, entry.spec.yawDeg));
   d.specMovedScale = scaleDelta(entry.spec.scale || [1, 1, 1], record.spec.scale || [1, 1, 1]);
   if (d.specMovedM > tol.positionM || d.specMovedDeg > tol.rotDeg || d.specMovedScale > tol.scale) {
     d.rule = 'spec-moved'; return d;
   }
   d.kept = true;
   d.keep = pose(now || record.placed);
   d.rule = !now ? 'hand-recorded' : (moved ? 'hand-moved' : 'hand-kept');
   return d;
 });
 const claimed = new Set(paired.filter(k => k >= 0));
 return { decisions, dropped: records.filter((_, k) => !claimed.has(k)) };
}
