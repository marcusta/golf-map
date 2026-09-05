import { describe, expect, test } from 'bun:test';
import { hazardsAlongLine } from './carry';
import { type FlatRing } from './corridor';
import {
    APEX_CARRY_FRACTION,
    buildTreeIndex,
    trajectoryHeightAt,
    treeClearance,
    treeCrossingsAlongLine,
    treeHeightM,
    type TreeFeatureInput,
} from './tree-clearance';

// Hand-computed planar fixtures. Shot line runs from (0,0) east along +x.

const trees = (
    minX: number,
    maxX: number,
    attributes?: TreeFeatureInput['attributes'],
    type = 'trees',
): TreeFeatureInput => ({
    type,
    attributes,
    points: [
        { x: minX, y: -10 },
        { x: maxX, y: -10 },
        { x: maxX, y: 10 },
        { x: minX, y: 10 },
    ],
});

const O = { x: 0, y: 0 };
const T = { x: 200, y: 0 };

describe('treeHeightM', () => {
    test('prefers heightP90M, falls back to heightMaxM, else null', () => {
        expect(treeHeightM(trees(0, 1, { heightP90M: 18, heightMaxM: 25 }))).toBe(18);
        expect(treeHeightM(trees(0, 1, { heightMaxM: 25 }))).toBe(25);
        expect(treeHeightM(trees(0, 1, { heightMeanM: 12 }))).toBeNull();
        expect(treeHeightM(trees(0, 1))).toBeNull();
        expect(treeHeightM(trees(0, 1, null))).toBeNull();
    });

    test('non-positive or non-numeric values count as missing', () => {
        expect(treeHeightM(trees(0, 1, { heightP90M: 0, heightMaxM: 20 }))).toBe(20);
        expect(treeHeightM(trees(0, 1, { heightP90M: 'tall' as unknown as number }))).toBeNull();
    });
});

describe('treeCrossingsAlongLine', () => {
    test('miss reports nothing', () => {
        const off = { ...trees(50, 80), points: trees(50, 80).points.map((p) => ({ x: p.x, y: p.y + 100 })) };
        expect(treeCrossingsAlongLine(O, T, [off])).toEqual([]);
    });

    test('single crossing reports entry, exit, feature and height', () => {
        const f = trees(130, 150, { heightP90M: 18 });
        const out = treeCrossingsAlongLine(O, T, [f]);
        expect(out).toHaveLength(1);
        expect(out[0].feature).toBe(f);
        expect(out[0].entryM).toBeCloseTo(130, 9);
        expect(out[0].exitM).toBeCloseTo(150, 9);
        expect(out[0].treeHeightM).toBe(18);
    });

    test('origin inside a ring reports entry 0', () => {
        const out = treeCrossingsAlongLine({ x: 20, y: 0 }, { x: 200, y: 0 }, [trees(10, 40)]);
        expect(out).toHaveLength(1);
        expect(out[0].entryM).toBe(0);
        expect(out[0].exitM).toBeCloseTo(20, 9);
    });

    test('two trees are both reported, sorted by entry', () => {
        const far = trees(150, 170);
        const near = trees(60, 80);
        const out = treeCrossingsAlongLine(O, T, [far, near]);
        expect(out.map((c) => c.entryM)).toEqual([60, 150]);
    });

    test('non-tree features and degenerate rings are ignored; zero-length line yields nothing', () => {
        const bunker = trees(60, 80, undefined, 'bunker');
        const degenerate: TreeFeatureInput = { type: 'trees', points: [{ x: 60, y: 0 }, { x: 80, y: 0 }] };
        expect(treeCrossingsAlongLine(O, T, [bunker, degenerate])).toEqual([]);
        expect(treeCrossingsAlongLine(O, O, [trees(60, 80)])).toEqual([]);
    });
});

describe('trajectoryHeightAt (model)', () => {
    const carry = 200;
    const apex = 30;

    test('zero at both ends and outside the flight', () => {
        expect(trajectoryHeightAt(0, carry, apex)).toBe(0);
        expect(trajectoryHeightAt(carry, carry, apex)).toBe(0);
        expect(trajectoryHeightAt(-5, carry, apex)).toBe(0);
        expect(trajectoryHeightAt(250, carry, apex)).toBe(0);
    });

    test('apex sits at ~62% of carry and equals apexM', () => {
        let bestD = 0;
        let bestH = -1;
        for (let d = 0; d <= carry; d += 0.5) {
            const h = trajectoryHeightAt(d, carry, apex);
            if (h > bestH) {
                bestH = h;
                bestD = d;
            }
        }
        expect(bestD / carry).toBeCloseTo(APEX_CARRY_FRACTION, 2);
        expect(bestH).toBeCloseTo(apex, 6);
        expect(APEX_CARRY_FRACTION).toBeGreaterThanOrEqual(0.6);
        expect(APEX_CARRY_FRACTION).toBeLessThanOrEqual(0.65);
    });

    test('monotone rising before the apex and falling after it', () => {
        const apexD = APEX_CARRY_FRACTION * carry;
        let prev = -1;
        for (let d = 0; d <= apexD; d += 1) {
            const h = trajectoryHeightAt(d, carry, apex);
            expect(h).toBeGreaterThan(prev);
            prev = h;
        }
        prev = Infinity;
        for (let d = apexD; d <= carry; d += 1) {
            const h = trajectoryHeightAt(d, carry, apex);
            expect(h).toBeLessThan(prev);
            prev = h;
        }
    });

    test('the descent is steeper than the launch (skew)', () => {
        expect(trajectoryHeightAt(20, carry, apex)).toBeLessThan(trajectoryHeightAt(carry - 20, carry, apex));
    });

    test('invalid carry or apex yields 0', () => {
        expect(trajectoryHeightAt(50, 0, apex)).toBe(0);
        expect(trajectoryHeightAt(50, carry, 0)).toBe(0);
    });
});

describe('trajectoryHeightAt (samples)', () => {
    const samples = [
        { d: 0, h: 0 },
        { d: 50, h: 12 },
        { d: 120, h: 28 },
        { d: 180, h: 10 },
        { d: 200, h: 0 },
    ];

    test('interpolates linearly between samples and hits sample points exactly', () => {
        expect(trajectoryHeightAt(50, 999, 999, samples)).toBe(12);
        expect(trajectoryHeightAt(25, 999, 999, samples)).toBeCloseTo(6, 9);
        expect(trajectoryHeightAt(150, 999, 999, samples)).toBeCloseTo(19, 9);
    });

    test('outside the sampled range is 0; fewer than two samples falls back to the model', () => {
        expect(trajectoryHeightAt(-1, 999, 999, samples)).toBe(0);
        expect(trajectoryHeightAt(201, 999, 999, samples)).toBe(0);
        expect(trajectoryHeightAt(124, 200, 30, [{ d: 0, h: 0 }])).toBeCloseTo(30, 6);
    });
});

describe('treeClearance', () => {
    const shot = { carryM: 200, apexM: 30 };

    test('low trees under the apex clear; the summary names them as worst', () => {
        const f = trees(110, 130, { heightP90M: 10 });
        const r = treeClearance(O, T, [f], shot);
        expect(r.crossings).toHaveLength(1);
        expect(r.crossings[0].status).toBe('clears');
        expect(r.crossings[0].minClearanceM!).toBeGreaterThan(2);
        expect(r.crossings[0].landsIn).toBe(false);
        expect(r.summary.status).toBe('clears');
        expect(r.summary.worst).toBe(r.crossings[0]);
        expect(r.beyondCarry).toEqual([]);
    });

    test('tall trees near the origin block, with the worst point at the entry edge', () => {
        // Ball at d=10 is ~4.6 m up; an 18 m tree wall blocks it.
        const f = trees(10, 30, { heightP90M: 18 });
        const r = treeClearance(O, T, [f], shot);
        expect(r.crossings[0].status).toBe('blocked');
        expect(r.crossings[0].minClearanceM!).toBeLessThan(0);
        expect(r.crossings[0].worstAtM).toBe(10);
        expect(r.summary.status).toBe('blocked');
    });

    test('marginal when 0 <= clearance < margin, and margin is configurable', () => {
        // Ball at the apex (124 m) is exactly 30 m; a 28.5 m tree leaves 1.5 m.
        const f = trees(123, 125, { heightP90M: 28.5 });
        const r = treeClearance(O, T, [f], shot);
        expect(r.crossings[0].status).toBe('marginal');
        expect(r.crossings[0].minClearanceM!).toBeGreaterThanOrEqual(0);
        expect(r.crossings[0].minClearanceM!).toBeLessThan(2);
        expect(treeClearance(O, T, [f], shot, { marginM: 1 }).crossings[0].status).toBe('clears');
    });

    test('hand-drawn tree without attributes is unknown', () => {
        const r = treeClearance(O, T, [trees(110, 130)], shot);
        expect(r.crossings[0].status).toBe('unknown');
        expect(r.crossings[0].minClearanceM).toBeNull();
        expect(r.crossings[0].worstAtM).toBeNull();
        expect(r.summary.status).toBe('unknown');
        expect(r.summary.worst).toBeNull();
    });

    test('uphill tree line lowers clearance; flat ground with the same tree clears', () => {
        const f = trees(110, 130, { heightP90M: 20 });
        const flat = treeClearance(O, T, [f], shot);
        expect(flat.crossings[0].status).toBe('clears');

        // 12 m rise at the tree line (10% grade): 20 m trees on 12 m ground vs 30 m ball.
        const uphill = treeClearance(O, T, [f], shot, { groundAt: (d) => d * 0.1 });
        expect(uphill.crossings[0].minClearanceM!).toBeLessThan(flat.crossings[0].minClearanceM!);
        expect(uphill.crossings[0].status).toBe('blocked');
    });

    test('originGroundM defaults to groundAt(0), so a uniform offset cancels out', () => {
        const f = trees(110, 130, { heightP90M: 20 });
        const flat = treeClearance(O, T, [f], shot);
        const raised = treeClearance(O, T, [f], shot, { groundAt: () => 250 });
        expect(raised.crossings[0].minClearanceM!).toBeCloseTo(flat.crossings[0].minClearanceM!, 9);
    });

    test('trees wholly beyond the carry point are listed as beyondCarry, not crossings', () => {
        const f = trees(210, 230, { heightP90M: 18 });
        const r = treeClearance(O, { x: 300, y: 0 }, [f], shot);
        expect(r.crossings).toEqual([]);
        expect(r.beyondCarry).toHaveLength(1);
        expect(r.beyondCarry[0].feature).toBe(f);
        expect(r.beyondCarry[0].entryM).toBeCloseTo(210, 9);
        expect(r.summary.status).toBe('clears');
    });

    test('a ring the ball lands in is flagged landsIn and evaluated only up to the carry point', () => {
        const f = trees(190, 230, { heightP90M: 18 });
        const r = treeClearance(O, { x: 300, y: 0 }, [f], shot);
        expect(r.crossings).toHaveLength(1);
        expect(r.crossings[0].landsIn).toBe(true);
        expect(r.crossings[0].status).toBe('blocked');
        expect(r.crossings[0].worstAtM).toBe(200);
    });

    test('summary precedence: blocked > marginal > unknown > clears, worst is the lowest clearance', () => {
        const low = trees(60, 70, { heightP90M: 5 }); // clears
        const unknown = trees(80, 90); // unknown
        const marginal = trees(123, 125, { heightP90M: 28.5 });
        const wall = trees(150, 160, { heightP90M: 40 }); // blocked

        expect(treeClearance(O, T, [low], shot).summary.status).toBe('clears');
        expect(treeClearance(O, T, [low, unknown], shot).summary.status).toBe('unknown');
        expect(treeClearance(O, T, [low, unknown, marginal], shot).summary.status).toBe('marginal');
        const all = treeClearance(O, T, [low, unknown, marginal, wall], shot);
        expect(all.summary.status).toBe('blocked');
        expect(all.summary.worst!.feature).toBe(wall);
        expect(all.crossings.map((c) => c.feature)).toEqual([low, unknown, marginal, wall]);
    });

    test('real trajectory samples drive the evaluation instead of the model', () => {
        const f = trees(110, 130, { heightP90M: 20 });
        // A flat 5 m flight never clears a 20 m tree even though apexM says 30.
        const samples = [{ d: 0, h: 0 }, { d: 10, h: 5 }, { d: 190, h: 5 }, { d: 200, h: 0 }];
        const r = treeClearance(O, T, [f], { ...shot, samples });
        expect(r.crossings[0].status).toBe('blocked');
        expect(r.crossings[0].minClearanceM!).toBeCloseTo(-15, 9);
    });

    test('no trees at all is a clear summary with null worst', () => {
        const r = treeClearance(O, T, [], shot);
        expect(r).toEqual({ crossings: [], beyondCarry: [], summary: { status: 'clears', worst: null } });
    });
});

// ---------------------------------------------------------------------------
// Bbox index: equivalence with the plain sweep, and timing
// ---------------------------------------------------------------------------

/** Deterministic LCG so the scatter is the same on every run. */
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** 2200 twenty-vertex star-ish polygons (radius 5-15 m) scattered over 3 km x 3 km. */
function syntheticForest(count = 2200, verts = 20, extentM = 3000): TreeFeatureInput[] {
    const rnd = lcg(42);
    const out: TreeFeatureInput[] = [];
    for (let i = 0; i < count; i++) {
        const cx = rnd() * extentM;
        const cy = rnd() * extentM;
        const r0 = 5 + rnd() * 10;
        const points: { x: number; y: number }[] = [];
        for (let k = 0; k < verts; k++) {
            const a = (k / verts) * Math.PI * 2;
            const r = r0 * (0.7 + rnd() * 0.6);
            points.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
        }
        out.push({ type: 'trees', points, attributes: { heightP90M: 10 + rnd() * 15 } });
    }
    return out;
}

/** The pre-index algorithm: sweep every ring, no prefilter. */
function sweepAll(origin: { x: number; y: number }, target: { x: number; y: number }, features: TreeFeatureInput[]) {
    const bearing = ((Math.atan2(target.x - origin.x, target.y - origin.y) * 180) / Math.PI + 360) % 360;
    const rings: FlatRing[] = [];
    const byRing = new Map<FlatRing, TreeFeatureInput>();
    for (const f of features) {
        const ring: FlatRing = { kind: 'trees', points: f.points.slice() };
        rings.push(ring);
        byRing.set(ring, f);
    }
    return hazardsAlongLine(origin, bearing, rings)
        .map(h => ({ feature: byRing.get(h.ring)!, entryM: h.frontM, exitM: h.carryM }))
        .sort((a, b) => a.entryM - b.entryM);
}

describe('buildTreeIndex / bbox prefilter', () => {
    const forest = syntheticForest();
    const index = buildTreeIndex(forest);
    const rnd = lcg(7);
    const legs = Array.from({ length: 200 }, () => {
        const ox = 200 + rnd() * 2600;
        const oy = 200 + rnd() * 2600;
        const a = rnd() * Math.PI * 2;
        return { o: { x: ox, y: oy }, t: { x: ox + Math.cos(a) * 250, y: oy + Math.sin(a) * 250 } };
    });

    test('index only holds trees rings with >= 3 points', () => {
        const idx = buildTreeIndex([
            ...forest.slice(0, 3),
            { type: 'bunker', points: forest[0].points },
            { type: 'trees', points: forest[0].points.slice(0, 2) },
        ]);
        expect(idx.entries).toHaveLength(3);
        expect(idx.entries[0].minX).toBeCloseTo(Math.min(...forest[0].points.map(p => p.x)), 9);
        expect(idx.entries[0].maxY).toBeCloseTo(Math.max(...forest[0].points.map(p => p.y)), 9);
    });

    test('indexed, plain-array and reference sweep report identical crossings (incl. beyond target)', () => {
        let total = 0;
        for (const { o, t } of legs) {
            const ref = sweepAll(o, t, forest);
            const viaIndex = treeCrossingsAlongLine(o, t, index);
            const viaArray = treeCrossingsAlongLine(o, t, forest);
            const strip = (c: { feature: TreeFeatureInput; entryM: number; exitM: number }) =>
                ({ feature: c.feature, entryM: c.entryM, exitM: c.exitM });
            expect(viaIndex.map(strip)).toEqual(ref);
            expect(viaArray.map(strip)).toEqual(ref);
            total += ref.length;
        }
        // The ray is unbounded, so a 250 m leg over a 3 km forest crosses many rings past the target.
        expect(total).toBeGreaterThan(200);
    });

    test('origin inside a ring still reports entryM = 0 through the index', () => {
        const f = forest[10];
        const cx = f.points.reduce((s, p) => s + p.x, 0) / f.points.length;
        const cy = f.points.reduce((s, p) => s + p.y, 0) / f.points.length;
        const hits = treeCrossingsAlongLine({ x: cx, y: cy }, { x: cx + 100, y: cy }, index);
        expect(hits[0].feature).toBe(f);
        expect(hits[0].entryM).toBe(0);
    });

    test('200 evaluations: indexed sweep well under 1 ms per leg', () => {
        const shot = { carryM: 230, apexM: 30 };
        const msPerLeg = (fn: (o: { x: number; y: number }, t: { x: number; y: number }) => void): number => {
            fn(legs[0].o, legs[0].t); // warm-up
            const t0 = performance.now();
            for (const { o, t } of legs) fn(o, t);
            return (performance.now() - t0) / legs.length;
        };
        const before = msPerLeg((o, t) => { sweepAll(o, t, forest); });
        const after = msPerLeg((o, t) => { treeClearance(o, t, index, shot); });
        // eslint-disable-next-line no-console
        console.log(`tree sweep: before ${before.toFixed(3)} ms/leg, after (index) ${after.toFixed(3)} ms/leg`);
        expect(after).toBeLessThan(1);
        expect(after).toBeLessThan(before);
    });
});
