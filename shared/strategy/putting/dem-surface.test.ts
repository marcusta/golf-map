// dem-surface.ts — Tier-2 bilinear DEM adapter.
// Ground truth is an analytic tilted plane h = A·e + B·n + C, which the
// bilinear patch reproduces EXACTLY (bilinear is linear when the samples
// come from a plane), so height and gradient are recovered to tight
// tolerance even between cell centers.

import { describe, expect, test } from 'bun:test';
import { demSurface, DEM_DEFAULT_CONFIDENCE, type DemGrid } from './dem-surface';

const ORIGIN = { e: 500_000, n: 6_400_000 };
const RES = 2;

/**
 * Build a grid whose heights sample the plane h = A·e + B·n + C at each
 * cell CENTER, matching dem-surface's own layout (row 0 = north).
 */
function planeGrid(
    width: number,
    height: number,
    A: number,
    B: number,
    C: number,
    overrides?: (row: number, col: number) => { height?: number | null; inside?: number } | undefined,
): DemGrid {
    const heights: (number | null)[] = [];
    const insideMask: number[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const e = ORIGIN.e + (col + 0.5) * RES;
            const n = ORIGIN.n - (row + 0.5) * RES;
            const o = overrides?.(row, col);
            if (o && 'height' in o && o.height === null) {
                heights.push(null);
            } else if (o && typeof o.height === 'number') {
                heights.push(o.height);
            } else {
                heights.push(A * e + B * n + C);
            }
            insideMask.push(o && o.inside !== undefined ? o.inside : 1);
        }
    }
    return { heights, insideMask, origin: ORIGIN, resolution: RES, width, height };
}

describe('demSurface — height + gradient recovery on a tilted plane', () => {
    // Slope: down toward the east and up toward the north.
    // ∇h points uphill, so a plane that falls off to the east has dh/de < 0.
    const A = -0.03; // dh/de: height decreases going east (downhill = east)
    const B = 0.02; // dh/dn: height increases going north
    const C = 12;
    const grid = planeGrid(6, 5, A, B, C);
    const surface = demSurface(grid);

    // A handful of interior points, deliberately off cell centers.
    const pts = [
        { x: ORIGIN.e + 3.0, y: ORIGIN.n - 3.0 },
        { x: ORIGIN.e + 5.5, y: ORIGIN.n - 4.25 },
        { x: ORIGIN.e + 7.1, y: ORIGIN.n - 6.9 },
        { x: ORIGIN.e + 4.0, y: ORIGIN.n - 5.0 }, // exactly on a cell center
    ];

    for (const p of pts) {
        test(`recovers plane at (${p.x - ORIGIN.e}, ${p.y - ORIGIN.n})`, () => {
            const s = surface.sampleAt(p);
            expect(s).not.toBeNull();
            const expectedH = A * p.x + B * p.y + C;
            expect(s!.height).toBeCloseTo(expectedH, 6);
            expect(s!.gradX).toBeCloseTo(A, 9);
            expect(s!.gradY).toBeCloseTo(B, 9);
            expect(s!.confidence).toBe(DEM_DEFAULT_CONFIDENCE);
        });
    }
});

describe('demSurface — downhill direction vs analytic fall line', () => {
    test('plane sloping down toward east has gradX < 0 (downhill = −∇h = +east)', () => {
        // Pure east slope: falls off going east, flat north/south.
        const A = -0.05; // dh/de < 0 ⇒ downhill points +east
        const surface = demSurface(planeGrid(5, 5, A, 0, 30));
        const s = surface.sampleAt({ x: ORIGIN.e + 4.3, y: ORIGIN.n - 4.3 })!;
        expect(s).not.toBeNull();
        expect(s.gradX).toBeCloseTo(A, 9);
        expect(s.gradY).toBeCloseTo(0, 9);

        // Downhill unit vector = −∇h/|∇h| must point due east (+x, 0y).
        const mag = Math.hypot(s.gradX, s.gradY);
        const downhillE = -s.gradX / mag;
        const downhillN = -s.gradY / mag;
        expect(downhillE).toBeCloseTo(1, 9);
        expect(downhillN).toBeCloseTo(0, 9);
    });

    test('plane sloping down toward south has gradY > 0 (downhill = −north)', () => {
        // dh/dn > 0 means height rises northward ⇒ falls off south ⇒
        // downhill points south (−y).
        const B = 0.04;
        const surface = demSurface(planeGrid(5, 5, 0, B, 20));
        const s = surface.sampleAt({ x: ORIGIN.e + 4.3, y: ORIGIN.n - 4.3 })!;
        const mag = Math.hypot(s.gradX, s.gradY);
        expect(-s.gradY / mag).toBeCloseTo(-1, 9); // downhill north-component = south
        expect(-s.gradX / mag).toBeCloseTo(0, 9);
    });
});

describe('demSurface — coverage / null policy', () => {
    const surface = demSurface(planeGrid(5, 5, -0.03, 0.02, 12));

    test('point outside the grid (west of origin) → null', () => {
        expect(surface.sampleAt({ x: ORIGIN.e - 10, y: ORIGIN.n - 4 })).toBeNull();
    });

    test('point outside the grid (north of origin) → null', () => {
        expect(surface.sampleAt({ x: ORIGIN.e + 4, y: ORIGIN.n + 10 })).toBeNull();
    });

    test('point beyond the far (south-east) edge of cell centers → null', () => {
        // Cell centers span col 0.5..4.5, row 0.5..4.5 → e up to +9, n down
        // to −9. Past the last center there is no 2×2 block.
        expect(surface.sampleAt({ x: ORIGIN.e + 9.5, y: ORIGIN.n - 9.5 })).toBeNull();
    });

    test('nodata (null height) in the surrounding 2×2 → null', () => {
        const g = planeGrid(5, 5, -0.03, 0.02, 12, (row, col) =>
            row === 2 && col === 2 ? { height: null } : undefined,
        );
        const s = demSurface(g);
        // Point whose surrounding block includes center (2,2).
        expect(s.sampleAt({ x: ORIGIN.e + 5.2, y: ORIGIN.n - 5.2 })).toBeNull();
        // A point far from the hole still reads fine.
        expect(s.sampleAt({ x: ORIGIN.e + 1.3, y: ORIGIN.n - 1.3 })).not.toBeNull();
    });

    test('insideMask 0 in the surrounding 2×2 → null', () => {
        const g = planeGrid(5, 5, -0.03, 0.02, 12, (row, col) =>
            row === 1 && col === 1 ? { inside: 0 } : undefined,
        );
        const s = demSurface(g);
        expect(s.sampleAt({ x: ORIGIN.e + 3.2, y: ORIGIN.n - 3.2 })).toBeNull();
    });
});

describe('demSurface — non-square grid catches row/col swaps', () => {
    // Wide + short: width 7, height 3. If rows/cols were swapped the plane
    // recovery would break because the axes carry different slopes.
    const A = -0.06; // strong east slope
    const B = 0.01; // gentle north slope
    const C = 5;
    const width = 7;
    const height = 3;
    const surface = demSurface(planeGrid(width, height, A, B, C));

    test('recovers distinct east/north slopes on a wide grid', () => {
        const p = { x: ORIGIN.e + 8.5, y: ORIGIN.n - 2.5 };
        const s = surface.sampleAt(p)!;
        expect(s).not.toBeNull();
        expect(s.height).toBeCloseTo(A * p.x + B * p.y + C, 6);
        expect(s.gradX).toBeCloseTo(A, 9);
        expect(s.gradY).toBeCloseTo(B, 9);
    });

    test('a point valid in a transposed grid but off this one is handled by bounds', () => {
        // col index 6.x exists (width 7) but row index 6.x does not (height 3).
        // A query at n = origin.n − 13 would be row ~6 → out of range → null.
        expect(surface.sampleAt({ x: ORIGIN.e + 3, y: ORIGIN.n - 13 })).toBeNull();
    });
});

describe('demSurface — confidence override', () => {
    test('honours an explicit confidence', () => {
        const s = demSurface(planeGrid(4, 4, -0.02, 0.01, 8), { confidence: 0.9 });
        const sample = s.sampleAt({ x: ORIGIN.e + 3, y: ORIGIN.n - 3 })!;
        expect(sample.confidence).toBe(0.9);
    });
});
