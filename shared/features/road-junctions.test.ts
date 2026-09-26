import { describe, expect, test } from 'bun:test';
import { junctionFillets, kerbFilletsOn, type JunctionRoad } from './road-junctions';
import { corridorRings, flattenCenterline } from './centerline';

const X = 538_000, Y = 6_398_000;
const road = (id: string, pts: Array<[number, number]>, widthM = 4): JunctionRoad => ({
    id, centerline: { points: pts.map(([x, y]) => ({ x: X + x, y: Y + y })), widthM },
});

function inside(q: { x: number; y: number }, ring: Array<{ x: number; y: number }>): boolean {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
}
const covered = (q: { x: number; y: number }, fillets: ReturnType<typeof junctionFillets>) =>
    fillets.some(f => inside(q, f.rings[0].points));
const at = (x: number, y: number) => ({ x: X + x, y: Y + y });

describe('junction fillets', () => {
    test('a branch teeing into a road rounds both inside corners, radius twice the half width', () => {
        const main = road('main', [[-50, 0], [50, 0]]);
        const branch = road('branch', [[0, 0], [0, 40]]);
        const fillets = junctionFillets([main, branch]);
        expect(fillets).toHaveLength(2); // one per inside corner
        expect(fillets[0].roadIds).toEqual(['branch', 'main']);
        // Kerbs at y = 2 and x = ±2; radius 4: the corners (±2, 2) are filled,
        // the arc's middle sits at (2 + 4 − 4/√2, 2 + 4 − 4/√2) ≈ (3.17, 3.17).
        expect(covered(at(2.3, 2.3), fillets)).toBe(true);
        expect(covered(at(-2.3, 2.3), fillets)).toBe(true);
        expect(covered(at(3.0, 3.0), fillets)).toBe(true);
        expect(covered(at(3.4, 3.4), fillets)).toBe(false);
        // Nothing on the far side of the main road.
        expect(covered(at(2.3, -2.3), fillets)).toBe(false);
        // Nothing far down the kerbs.
        expect(covered(at(15, 2.3), fillets)).toBe(false);
    });

    test('a branch stopping just short of the road (inside its corridor) still joins it', () => {
        const fillets = junctionFillets([road('main', [[-50, 0], [50, 0]]), road('branch', [[0, 1.5], [0, 40]])]);
        expect(fillets).toHaveLength(2);
        expect(covered(at(2.3, 2.3), fillets)).toBe(true);
    });

    test('two roads crossing round all four corners', () => {
        const fillets = junctionFillets([road('a', [[-50, 0], [50, 0]]), road('b', [[0, -50], [0, 50]])]);
        expect(fillets).toHaveLength(4);
        for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) expect(covered(at(2.3 * sx, 2.3 * sy), fillets)).toBe(true);
    });

    test('three ways meeting end to end at a node round the corners between them', () => {
        const fillets = junctionFillets([
            road('w', [[-50, 0], [0, 0]]),
            road('e', [[0, 0], [50, 0]]),
            road('n', [[0, 0], [0, 50]]),
        ]);
        expect(fillets).toHaveLength(2);
        expect(covered(at(2.3, 2.3), fillets)).toBe(true);
        expect(covered(at(-2.3, 2.3), fillets)).toBe(true);
    });

    test('a road continuing as another way, apart roads and a lone road: no fillets', () => {
        expect(junctionFillets([road('a', [[-50, 0], [0, 0]]), road('b', [[0, 0], [40, 30]])])).toEqual([]);
        expect(junctionFillets([road('a', [[-50, 0], [50, 0]]), road('b', [[0, 10], [0, 40]])])).toEqual([]);
        expect(junctionFillets([road('a', [[-50, 0], [50, 0]])])).toEqual([]);
    });

    test('an acute tee keeps its fillet close to the junction', () => {
        const main = road('main', [[-60, 0], [60, 0]]);
        const branch = road('branch', [[0, 0], [40, 12]]); // ~17° off the main road
        const fillets = junctionFillets([main, branch]);
        expect(fillets).toHaveLength(2);
        const xs = fillets.flatMap(f => f.rings[0].points).map(q => q.x - X);
        expect(Math.max(...xs.map(Math.abs))).toBeLessThan(4 * 3 + 20);
    });

    test('a road with rounding off gets no rounded corner beside it; the others at its junction still do', () => {
        const main = road('main', [[-50, 0], [50, 0]]);
        const branch = road('branch', [[0, 0], [0, 40]]);
        expect(junctionFillets([main, { ...branch, fillets: false }])).toEqual([]);
        expect(junctionFillets([{ ...main, fillets: false }, branch])).toEqual([]);
        // Three ways at a node, the west one off: only the corner between east and north.
        const fillets = junctionFillets([
            { ...road('w', [[-50, 0], [0, 0]]), fillets: false },
            road('e', [[0, 0], [50, 0]]),
            road('n', [[0, 0], [0, 50]]),
        ]);
        expect(fillets).toHaveLength(1);
        expect(covered(at(2.3, 2.3), fillets)).toBe(true);
        expect(covered(at(-2.3, 2.3), fillets)).toBe(false);
    });

    test('a fillet on a road curving away ends on its kerb, not on straight past it', () => {
        // The main road bends down and away on both sides of the branch (a
        // 20 m circle through the junction); a straight kerb line from the
        // corner would leave the fillet's far end hanging off the road.
        const arc = [135, 120, 105, 90, 75, 60, 45].map(d => [20 * Math.cos((d * Math.PI) / 180), 20 * Math.sin((d * Math.PI) / 180) - 20] as [number, number]);
        const main = road('main', arc);
        const fillets = junctionFillets([main, road('branch', [[0, 0], [0, 30]])]);
        expect(fillets).toHaveLength(2);
        const line = flattenCenterline(main.centerline.points);
        const offMain = (q: { x: number; y: number }) => Math.min(...line.slice(1).map((b, i) => {
            const a = line[i], dx = b.x - a.x, dy = b.y - a.y;
            const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy)));
            return Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy);
        }));
        // Each fillet's outermost point along the main road sits on its kerb (2 m out).
        for (const f of fillets) {
            const pts = f.rings[0].points;
            const far = pts.reduce((m, q) => (Math.abs(q.x - X) > Math.abs(m.x - X) ? q : m));
            expect(offMain(far)).toBeLessThan(2 + 0.02);
        }
        expect(covered(at(2.3, 2.3), fillets)).toBe(true);
        expect(covered(at(-2.3, 2.3), fillets)).toBe(true);
    });

    test('a wide road ending in a narrower one tapers down to it instead of stepping', () => {
        const wide = road('wide', [[-40, 0], [0, 0]], 6);
        const narrow = road('narrow', [[0, 0], [40, 0]], 3);
        const tapers = junctionFillets([wide, narrow]);
        expect(tapers).toHaveLength(1);
        expect(tapers[0].roadIds).toEqual(['narrow', 'wide']);
        // Full width at the joint, easing down: half way (9 m) is half way between.
        for (const sy of [1, -1]) {
            expect(covered(at(1, 2.8 * sy), tapers)).toBe(true);
            expect(covered(at(9, 2.2 * sy), tapers)).toBe(true);
            expect(covered(at(9, 2.4 * sy), tapers)).toBe(false);
        }
        // Down to the narrow road's own width by the end, and nothing on the wide side.
        expect(covered(at(18.5, 1.6), tapers)).toBe(false);
        expect(covered(at(-3, 2.8), tapers)).toBe(false);
        // Either way round.
        const back = junctionFillets([road('narrow', [[-40, 0], [0, 0]], 3), road('wide', [[0, 0], [40, 0]], 6)]);
        expect(covered(at(-9, 2.2), back)).toBe(true);
        expect(covered(at(9, 2.2), back)).toBe(false);
    });

    test('tapers are made with rounding off too, never between roads meeting at a corner', () => {
        const wide = road('wide', [[-40, 0], [0, 0]], 6);
        const off = junctionFillets([wide, { ...road('narrow', [[0, 0], [40, 0]], 3), fillets: false }]);
        expect(covered(at(9, 2.2), off)).toBe(true);
        expect(junctionFillets([wide, road('narrow', [[0, 0], [0, 40]], 3)])).toEqual([]);
    });

    test('a taper between ends meeting a little to one side starts on the wide road and ends on the narrow one', () => {
        // The narrow road starts 0.8 m left of the wide road's line.
        const tapers = junctionFillets([road('wide', [[-40, 0], [0, 0]], 6), road('narrow', [[0, 0.8], [40, 0.8]], 3)]);
        expect(covered(at(0.5, -2.8), tapers)).toBe(true); // the wide road's right kerb carries on
        expect(covered(at(0.5, 3.4), tapers)).toBe(false);
        expect(covered(at(17, 0.8 + 1.4), tapers)).toBe(true);
        expect(covered(at(17, 0.8 - 1.4), tapers)).toBe(true);
        expect(covered(at(17, 0.8 + 1.7), tapers)).toBe(false);
    });

    test('kerbFilletsOn: on unless the attribute is false', () => {
        expect(kerbFilletsOn(null)).toBe(true);
        expect(kerbFilletsOn({ surface: 'asphalt' })).toBe(true);
        expect(kerbFilletsOn({ kerbFillets: true })).toBe(true);
        expect(kerbFilletsOn({ kerbFillets: false })).toBe(false);
    });

    test('fillets sit outside the corridors they round, apart from their overlap', () => {
        const main = road('main', [[-50, 0], [50, 0]]);
        const branch = road('branch', [[0, 0], [0, 40]]);
        const fillets = junctionFillets([main, branch]);
        const corridors = [main, branch].map(r => corridorRings(r.centerline)![0].points);
        // Every fillet vertex is within the overlap (0.5 m) of a kerb or outside the roads.
        for (const q of fillets.flatMap(f => f.rings[0].points)) {
            const inRoad = corridors.some(c => inside(q, c));
            const depth = Math.min(Math.abs(q.y - Y) <= 2 ? 2 - Math.abs(q.y - Y) : Infinity, Math.abs(q.x - X) <= 2 ? 2 - Math.abs(q.x - X) : Infinity);
            if (inRoad) expect(depth).toBeLessThanOrEqual(0.5 + 1e-6);
        }
    });
});
