// Pure props re-place rule: on a `golfmap.props.place`, which instances keep the transform the
// user gave them in Unity and which take the spec again (the tree-matching.mjs /
// building-matching.mjs sibling, and the mirror of `GolfMapPropsPlaced.Decide` in
// unity/Editor/GolfMap/GolfMapPropsPlaced.cs — change both together).
//
// props.place used to rebuild `GolfMap Props/<Category>s/<asset>#<i>` from the spec and drop every
// prop moved or rotated by hand. Now each place records, in `<props folder>/placed.json`, the
// transform it gave each instance and the spec entry it came from, and the next place decides per
// instance. Matching is never by the instance index: `#i` is the index the spec had when the prop was
// placed, and one `place(...)` call added or removed shifts every later one (on Vreta that read as 88
// "hand moves" that were one index shift per asset - 11 range_mat all off by exactly 5.745-5.805 m).
//
//   scene object -> record    by object name - trusted only here, because the record was written by the
//                             place that made that object - then (a renamed object) the nearest
//                             unclaimed record within `matchM` of where the tool left it;
//   record -> spec entry      `pairNearest` on the recorded spec positions (e, n);
//   scene object -> spec      `pairNearest` on x/z, for `golfmap.props.record`, which has no records to
//                             go by (`matchRecordedProps`).
//
// `pairNearest` is one-to-one, closest pair first, with NO radius: within one asset the instances stand
// far further apart than any hand nudge, so the unmoved ones pair at distance 0 and are consumed first,
// and a moved one can only pair with what is left over.
//
// The decision, per spec entry (`rule` is the branch that decided):
//
//   no-record       no record left for it: a new place(...) call, or more spec entries than records -> spec
//   unmoved         it stands where the tool put it -> spec
//   no-instance     nothing in the scene for it and it was never hand-placed -> spec
//   spec-moved      hand-placed, but the spec moved this instance since it was recorded -> spec wins
//   hand-moved      moved/rotated/scaled in Unity since the tool placed it -> kept
//   hand-kept       kept by an earlier place and still standing there -> kept
//   hand-recorded   hand-placed earlier, nothing in the scene now -> kept, at the recorded transform
//
// Outside the per-spec-entry decisions, two lists say what has no spec entry at all:
//   dropped         records no spec entry claimed: that place(...) call is gone from the spec
//   handAdded       instances in the scene no record claimed: duplicated by hand in Unity
//                   ("<asset>#3 (1)"), so the place leaves them standing - and out of the record,
//                   which is what makes the next place find them the same way
// matchM is only the radius for finding a RENAMED scene object by its recorded position; the spec
// pairing has no radius.
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
// within matchM of where the tool left it. `handAdded` gets the instances no record claimed: the tool
// never made them, so they were added by hand (a Ctrl+D duplicate, "<asset>#3 (1)") and the next place
// must leave them where they are instead of deleting them without a word.
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
 return {found, handAdded: scene.filter(s => !taken.has(s.name))};
}

// One-to-one nearest pairing of two sets of points ([[x, y], ...]), closest pair first and no radius:
// returns, per point of a, the index of the point of b it paired with, or -1 when b ran out.
// Distances are rounded to the millimetre so this and the C# break ties the same way: Math.round is
// half UP for a positive number, which is why the C# side asks for MidpointRounding.AwayFromZero
// (its default is banker's rounding, half to even, and an exact x.5 mm tie would pair differently).
export function pairNearest(a, b) {
 const paired = a.map(() => -1), pairs = [];
 for (let i = 0; i < a.length; i++)
   for (let k = 0; k < b.length; k++)
     pairs.push([Math.round(Math.hypot(a[i][0] - b[k][0], a[i][1] - b[k][1]) * 1000), i, k]);
 pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
 const used = new Set();
 for (const [, i, k] of pairs) {
   if (paired[i] >= 0 || used.has(k)) continue;
   paired[i] = k; used.add(k);
 }
 return paired;
}

// spec entry -> record index (-1 for none): nearest recorded spec position. Records without a spec (an
// instance the spec had no entry for) take part in nothing.
function pairSpecs(specs, records) {
 const usable = records.map((r, k) => [r, k]).filter(([r]) => r.spec);
 const paired = pairNearest(specs.map(s => [s.spec.e, s.spec.n]), usable.map(([r]) => [r.spec.e, r.spec.n]));
 return paired.map(k => (k < 0 ? -1 : usable[k][1]));
}

// specs:   [{index, spec:{e, n, yawDeg, dz, scale:[x,y,z]}}]           one asset's manifest instances
// records: [{name, index, hand, spec:{...}, placed:{pos, euler, scale}}]  that asset's placed.json rows
// scene:   [{name, pose:{pos, euler, scale}}]                          what stands in the scene now
// -> {decisions: [{index, kept, rule, record, keep, was, movedM, movedDeg, movedScale,
//                  specMovedM, specMovedDeg, specMovedScale}],
//     dropped: [record, ...],      records no spec entry claimed (the spec lost that place() call)
//     handAdded: [scene, ...]}     instances no record claimed: added by hand, kept as they stand
export function matchPlacedProps({ specs, records = [], scene = [], tolerance } = {}) {
 const tol = { ...DEFAULT_TOLERANCE, ...(tolerance || {}) };
 const {found: inScene, handAdded} = pairScene(records, scene, tol);
 const paired = pairSpecs(specs, records);
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
 return { decisions, dropped: records.filter((_, k) => !claimed.has(k)), handAdded };
}

// `golfmap.props.record` (GolfMapProps.Record): seed the records from the scene as it stands, for an
// older scene that has no placed.json. One asset at a time, because the pairing is per asset.
//
// specs: [{index, plan:[x, z]}]   the manifest's entries for this asset and where the spec puts each
//                                (x = e - e0 + origin.x, z = n - n0 + origin.z; the frame conversion
//                                stays in GolfMapProps, it is not part of the rule)
// scene: [{name, pose:{pos, euler, scale}}]   the asset's instances standing in the scene
// -> {records: [{name, index, hand, spec, placed, offSpecM, pairedBy}],
//     notInScene: [spec index, ...], indexStillRight, pairedByPosition, handPlaced}
//
// Only x/z is compared against the spec: those are a pure function of the spec and the frame, while
// the height comes from a raycast that moves with the terrain and the meshes.
export function matchRecordedProps({ asset, specs = [], scene = [], tolerance, markAll = false } = {}) {
 const tol = { ...DEFAULT_TOLERANCE, ...(tolerance || {}) };
 const standing = [...scene].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
 const paired = pairNearest(standing.map(s => [s.pose.pos[0], s.pose.pos[2]]), specs.map(s => s.plan));
 const records = [];
 let indexStillRight = 0, pairedByPosition = 0, handPlaced = 0;
 standing.forEach((s, i) => {
   if (paired[i] < 0) {
     records.push({ name: s.name, index: -1, hand: true, spec: null, placed: pose(s.pose), offSpecM: null, pairedBy: null });
     handPlaced++;
     return;
   }
   const entry = specs[paired[i]];
   const offSpecM = Math.hypot(s.pose.pos[0] - entry.plan[0], s.pose.pos[2] - entry.plan[1]);
   const sameIndex = s.name === asset + '#' + entry.index;
   if (sameIndex) indexStillRight++; else pairedByPosition++;
   const hand = markAll || offSpecM > tol.positionM;
   if (hand) handPlaced++;
   records.push({ name: s.name, index: entry.index, hand, spec: entry.spec || null, placed: pose(s.pose), offSpecM, pairedBy: sameIndex ? 'name' : 'position' });
 });
 const claimed = new Set(paired.filter(k => k >= 0));
 return {
   records, indexStillRight, pairedByPosition, handPlaced,
   notInScene: specs.filter((_, k) => !claimed.has(k)).map(s => s.index),
 };
}
