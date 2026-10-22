import { describe, expect, test } from 'bun:test';
import { arcSpans, placeTee, teeLength, type PlacementHole, type PlacementShape, type Xy } from './tee-placement';

const box = (id: string, holeId: string | null, cx: number, cy: number, w = 10, h = 20): PlacementShape => ({
    id, holeId, ring: [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]],
});
const near = (p: Xy, x: number, y: number, tol = 0.01) => {
    expect(Math.abs(p[0] - x)).toBeLessThan(tol);
    expect(Math.abs(p[1] - y)).toBeLessThan(tol);
};

describe('the circle across a shape', () => {
    test('one span through a box, the whole circle inside a big one, none beside it', () => {
        const spans = arcSpans([0, 0], 100, box('a', null, 0, 100, 20, 20).ring);
        expect(spans).toHaveLength(1);
        // Centred on straight up (pi/2): the arc between x = -10 and x = 10 at radius 100.
        expect(spans[0]!.from + spans[0]!.sweep / 2).toBeCloseTo(Math.PI / 2, 6);
        expect(spans[0]!.sweep * 100).toBeCloseTo(200 * Math.asin(0.1), 6);
        expect(arcSpans([0, 0], 5, box('b', null, 0, 0, 50, 50).ring)).toEqual([{ from: 0, sweep: 2 * Math.PI }]);
        expect(arcSpans([0, 0], 100, box('c', null, 300, 0).ring)).toEqual([]);
    });
});

describe('placing a tee from its length', () => {
    // A dogleg: tees to the south, the corner at (0, 200), the green up and right at (100, 300).
    const hole: PlacementHole = { id: 'h1', aims: [[0, 200]], green: [100, 300], tees: [] };
    const rest = Math.hypot(100, 100);

    test('the length runs tee -> aim points -> green centre', () => {
        expect(teeLength(hole, [0, 0])).toBeCloseTo(200 + rest, 6);
        expect(teeLength({ ...hole, green: null }, [0, 0])).toBeNull();
    });

    test('on the tee shape the circle crosses, in the middle of the arc', () => {
        const res = placeTee(hole, 200 + rest, [box('t', 'h1', 0, 0)]);
        expect(res.kind).toBe('spot');
        if (res.kind !== 'spot') return;
        near(res.spot.xy, 0, 0);
        expect(res.spot.shapeId).toBe('t');
        expect(res.ambiguous).toBe(false);
    });

    test("another hole's tee shape on the circle never wins (Vreta hole 5)", () => {
        // Hole 4's tee box lies on the circle 12 degrees off; hole 5's own one is on the line.
        const own = box('own', 'h1', 0, 0);
        const theirs = box('theirs', 'h4', 200 * Math.sin(0.21), 200 - 200 * Math.cos(0.21));
        const res = placeTee({ ...hole, tees: [[0, -5]] }, 200 + rest, [theirs, own]);
        expect(res).toMatchObject({ kind: 'spot', spot: { shapeId: 'own' }, otherHole: null });
        // With no shape of its own or on no hole, another hole's on the line is the spot, marked for a look.
        expect(placeTee({ ...hole, tees: [[0, -5]] }, 200 + rest, [theirs])).toMatchObject({ kind: 'spot', spot: { shapeId: 'theirs' }, otherHole: 'h4' });
        // Without a line back it is not taken.
        expect(placeTee(hole, 200 + rest, [theirs]).kind).toBe('missed');
    });

    test("this hole's shape before one on no hole; one on no hole far off the line is not this hole's", () => {
        const own = box('own', 'h1', 200 * Math.sin(0.3), 200 - 200 * Math.cos(0.3));
        const loose = box('loose', null, 0, 0);
        const withTee = { ...hole, tees: [[0, -10] as Xy] };
        expect(placeTee(withTee, 200 + rest, [loose, own])).toMatchObject({ kind: 'spot', spot: { shapeId: 'own' }, ambiguous: false });
        // Only the loose one, 90 degrees round from the line back: not this hole's.
        const aside = box('aside', null, 200, 200);
        expect(placeTee(withTee, 200 + rest, [aside]).kind).toBe('missed');
    });

    test('two shapes of the hole nearly in line with it are a call for the user', () => {
        const a = box('a', 'h1', 200 * Math.sin(0.08), 200 - 200 * Math.cos(0.08));
        const b = box('b', 'h1', -200 * Math.sin(0.08), 200 - 200 * Math.cos(0.08));
        const res = placeTee({ ...hole, tees: [[0, -10]] }, 200 + rest, [a, b]);
        expect(res.kind).toBe('spot');
        if (res.kind !== 'spot') return;
        expect(res.ambiguous).toBe(true);
        expect(res.alternatives).toHaveLength(1);
    });

    test('a circle that crosses no shape: the spot on the line back, to draw a tee shape at', () => {
        const res = placeTee({ ...hole, tees: [[0, -30]] }, 200 + rest, [box('far', 'h1', 0, -60)]);
        expect(res.kind).toBe('missed');
        if (res.kind !== 'missed') return;
        near(res.spot!.xy, 0, 0);
        expect(res.spot!.shapeId).toBeNull();
        // No tees and no shapes on the hole: no line back, no spot.
        expect(placeTee(hole, 200 + rest, [])).toEqual({ kind: 'missed', spot: null });
    });

    test('a length shorter than the line from the corner, or no green', () => {
        expect(placeTee(hole, rest + 2, [box('t', 'h1', 0, 0)]).kind).toBe('too-short');
        expect(placeTee({ ...hole, green: null }, 300, []).kind).toBe('no-green');
    });
});
