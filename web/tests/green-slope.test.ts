import { describe, expect, test } from 'bun:test';
import type { SampleGrid } from '../../shared/api/analysis.gen';
import { summarizeGreenSlope, type GreenRefPoint } from '../src/planner/green-slope';

// Synthetic grids in EPSG:3006. Row 0 is the NORTHERNMOST row (analysis-math
// convention), origin = the grid's NW corner. A green whose heights rise to
// the north falls downhill to the SOUTH → compass bearing 180°.

const RES = 5;
const ORIGIN = { e: 1000, n: 2000 };

/**
 * Build a WxH grid from a height function of (col, row). insideMask can be
 * narrowed to a sub-window; defaults to all-inside.
 */
function grid(
    width: number,
    height: number,
    heightAt: (col: number, row: number) => number,
    inside: (col: number, row: number) => boolean = () => true,
): SampleGrid {
    const heights: (number | null)[] = [];
    const insideMask: number[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            heights.push(heightAt(col, row));
            insideMask.push(inside(col, row) ? 1 : 0);
        }
    }
    return { heights, insideMask, origin: ORIGIN, resolution: RES, width, height };
}

// Front (south) and back (north) reference points spanning the grid.
const front: GreenRefPoint = { e: ORIGIN.e + 10, n: ORIGIN.n - 20 }; // south edge
const back: GreenRefPoint = { e: ORIGIN.e + 10, n: ORIGIN.n }; // north edge

describe('summarizeGreenSlope', () => {
    test('a green rising to the north reports a due-south (≈180°) fall line', () => {
        // Height rises 0.5 m per 5 m cell going north (row shrinks north) →
        // ~10% downhill toward the south.
        const g = grid(5, 5, (_col, row) => (4 - row) * 0.5);
        const s = summarizeGreenSlope(g, front, back)!;
        expect(s).not.toBeNull();
        expect(s.fallLineBearingDeg).toBeCloseTo(180, 0);
        expect(s.fallLinePct).toBeGreaterThan(9);
        expect(s.fallLinePct).toBeLessThan(11);
    });

    test('a green rising to the east reports a due-west (≈270°) fall line', () => {
        const g = grid(5, 5, (col) => col * 0.5); // rises east → falls west
        const s = summarizeGreenSlope(g, front, back)!;
        expect(s.fallLineBearingDeg).toBeCloseTo(270, 0);
    });

    test('front/back split reports each half mean slope', () => {
        // South (front) half flat, north (back) half steep. front = south.
        const g = grid(5, 6, (_col, row) => (row < 3 ? (2 - row) * 0.6 : 0));
        const s = summarizeGreenSlope(g, front, { e: ORIGIN.e + 10, n: ORIGIN.n - 5 })!;
        // The steep cells sit to the north (rows 0..2) = the back half.
        expect(s.backHalfPct).toBeGreaterThan(s.frontHalfPct);
    });

    test('a dead-flat green reports a near-zero fall line', () => {
        const g = grid(4, 4, () => 10);
        const s = summarizeGreenSlope(g, front, back)!;
        // computeSlopeGrid yields 0% everywhere → zero-magnitude mean vector.
        expect(s.fallLinePct).toBeCloseTo(0, 5);
    });

    test('a saddle (opposing tilts) cancels to a small net fall line', () => {
        // North half falls south, south half falls north → they oppose. The
        // per-cell magnitudes are large but the mean vector is small.
        const g = grid(5, 6, (_col, row) => -Math.abs(row - 2.5) * 0.5);
        const s = summarizeGreenSlope(g, front, back)!;
        expect(s.fallLinePct).toBeLessThan(3);
    });

    test('returns null when no cells are inside the green', () => {
        const g = grid(3, 3, () => 5, () => false);
        expect(summarizeGreenSlope(g, front, back)).toBeNull();
    });

    test('nodata cells are skipped, not counted as flat', () => {
        const g = grid(5, 5, (_col, row) => (4 - row) * 0.5);
        // Punch a hole: one nodata cell should not crash or skew badly.
        (g.heights as (number | null)[])[12] = null;
        const s = summarizeGreenSlope(g, front, back)!;
        expect(s.fallLineBearingDeg).toBeCloseTo(180, 0);
    });
});
