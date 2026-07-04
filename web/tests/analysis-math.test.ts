import { test, expect } from 'bun:test';
import type { SampleGrid } from '../../shared/api/analysis.gen';
import {
    computeSlopeGrid,
    computeStats,
    buildOverlayRgba,
    sampleFallLines,
    slopeColor,
    heightColor,
    relativeColor,
    SLOPE_BLUE,
    SLOPE_GREEN,
    SLOPE_ORANGE,
    SLOPE_MAGENTA,
    HEIGHT_STOPS,
    REL_NEUTRAL,
    REL_BELOW_STOPS,
    REL_ABOVE_STOPS,
    REL_SCALE_MIN_M,
    REL_SCALE_MAX_M,
    INSIDE_ALPHA,
    OUTSIDE_ALPHA,
    ARROW_MIN_SLOPE_PCT,
} from '../src/analysis/analysis-math';

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Grid with heights from z(e, n) and a rectangular inside region (cell indices). */
function makeGrid(opts: {
    width: number;
    height: number;
    resolution?: number;
    z: (e: number, n: number) => number | null;
    inside?: (row: number, col: number) => boolean;
}): SampleGrid {
    const resolution = opts.resolution ?? 0.5;
    const origin = { e: 1000, n: 2000 };
    const heights: (number | null)[] = [];
    const insideMask: number[] = [];
    for (let row = 0; row < opts.height; row++) {
        for (let col = 0; col < opts.width; col++) {
            const e = origin.e + (col + 0.5) * resolution;
            const n = origin.n - (row + 0.5) * resolution;
            heights.push(opts.z(e, n));
            insideMask.push(opts.inside ? (opts.inside(row, col) ? 1 : 0) : 1);
        }
    }
    return { origin, resolution, width: opts.width, height: opts.height, heights, insideMask };
}

/** Tilted plane: dz/de = 0.03, dz/dn = 0.04 → slope 5%, downhill (−0.6, −0.8). */
const planeGrid = () => makeGrid({
    width: 12,
    height: 10,
    z: (e, n) => 50 + 0.03 * (e - 1000) + 0.04 * (n - 1990),
});

// ─── computeSlopeGrid ─────────────────────────────────────────────────────

test('slope from central differences matches an analytic plane everywhere', () => {
    const grid = planeGrid();
    const slope = computeSlopeGrid(grid);
    // Central AND one-sided differences are exact on a plane — check all
    // cells including edges and corners.
    for (let i = 0; i < grid.heights.length; i++) {
        expect(slope.slopePct[i]).toBeCloseTo(5, 8);
        expect(slope.dirE[i]).toBeCloseTo(-0.6, 8);
        expect(slope.dirN[i]).toBeCloseTo(-0.8, 8);
    }
});

test('slope is 0 with zero direction on a flat grid', () => {
    const grid = makeGrid({ width: 5, height: 5, z: () => 42 });
    const slope = computeSlopeGrid(grid);
    for (let i = 0; i < 25; i++) {
        expect(slope.slopePct[i]).toBe(0);
        expect(slope.dirE[i]).toBe(0);
        expect(slope.dirN[i]).toBe(0);
    }
});

test('downhill direction points east when heights fall to the east', () => {
    // z decreases with e → gradient east-negative → downhill = +east.
    const grid = makeGrid({ width: 6, height: 4, z: e => 100 - 0.02 * (e - 1000) });
    const slope = computeSlopeGrid(grid);
    const i = 1 * grid.width + 2;
    expect(slope.slopePct[i]).toBeCloseTo(2, 8);
    expect(slope.dirE[i]).toBeCloseTo(1, 8);
    expect(slope.dirN[i]).toBeCloseTo(0, 8);
});

test('nodata cells get NaN slope; neighbors fall back to one-sided differences', () => {
    const grid = planeGrid();
    const hole = 4 * grid.width + 5;
    grid.heights[hole] = null;
    const slope = computeSlopeGrid(grid);
    expect(Number.isNaN(slope.slopePct[hole])).toBe(true);
    // West neighbor of the hole: one-sided in e, still exact on a plane.
    expect(slope.slopePct[hole - 1]).toBeCloseTo(5, 8);
});

// ─── Color ramps (exact reference stops) ──────────────────────────────────

test('slope ramp hits the exact reference colors at thresholds', () => {
    expect(slopeColor(0)).toEqual(SLOPE_BLUE);
    expect(slopeColor(0.99)).toEqual(SLOPE_BLUE);
    expect(slopeColor(1)).toEqual(SLOPE_BLUE);
    expect(slopeColor(2)).toEqual([51, 166, 153]); // blue→green midpoint
    expect(slopeColor(2.9999)).toEqual([51, 204, 51]);
    expect(slopeColor(3)).toEqual(SLOPE_GREEN);
    expect(slopeColor(5)).toEqual(SLOPE_ORANGE);
    expect(slopeColor(6)).toEqual([255, 90, 90]); // orange→magenta midpoint
    expect(slopeColor(7)).toEqual(SLOPE_MAGENTA);
    expect(slopeColor(19)).toEqual(SLOPE_MAGENTA); // clamped, no further gradation
    expect(slopeColor(NaN)).toEqual(SLOPE_BLUE);
});

test('height ramp hits the exact 5 reference stops', () => {
    expect(heightColor(0)).toEqual(HEIGHT_STOPS[0]); // blue (0, 102, 255)
    expect(heightColor(0.25)).toEqual(HEIGHT_STOPS[1]); // green (0, 204, 51)
    expect(heightColor(0.5)).toEqual(HEIGHT_STOPS[2]); // yellow
    expect(heightColor(0.75)).toEqual(HEIGHT_STOPS[3]); // orange (255, 136, 0)
    expect(heightColor(1)).toEqual(HEIGHT_STOPS[4]); // red
    expect(heightColor(0.125)).toEqual([0, 153, 153]); // blue→green midpoint
    expect(heightColor(-1)).toEqual(HEIGHT_STOPS[0]); // clamped
    expect(heightColor(2)).toEqual(HEIGHT_STOPS[4]); // clamped
});

test('relative ramp: neutral at green level, purple at deepest, red at highest', () => {
    const scale = 1.5;
    expect(relativeColor(0, scale)).toEqual(REL_NEUTRAL);
    expect(relativeColor(-scale, scale)).toEqual(REL_BELOW_STOPS[3]); // purple
    expect(relativeColor(-scale / 3, scale)).toEqual(REL_BELOW_STOPS[1]); // light blue
    expect(relativeColor(-2 * scale / 3, scale)).toEqual(REL_BELOW_STOPS[2]); // deep blue
    expect(relativeColor(scale, scale)).toEqual(REL_ABOVE_STOPS[3]); // red
    expect(relativeColor(scale / 3, scale)).toEqual(REL_ABOVE_STOPS[1]); // light warm
    expect(relativeColor(-10 * scale, scale)).toEqual(REL_BELOW_STOPS[3]); // clamped
    expect(relativeColor(10 * scale, scale)).toEqual(REL_ABOVE_STOPS[3]); // clamped
});

// ─── Stats + relative normalization ───────────────────────────────────────

test('computeStats separates green and surrounds and finds the deepest hollow', () => {
    // Inside cells at 76 m; one outside hollow cell at 74 m.
    const grid = makeGrid({
        width: 10,
        height: 10,
        z: () => 76,
        inside: (row, col) => row >= 3 && row <= 6 && col >= 3 && col <= 6,
    });
    grid.heights[1 * 10 + 1] = 74; // hollow in the surrounds
    const slope = computeSlopeGrid(grid);
    const stats = computeStats(grid, slope);

    expect(stats.green.minHeight).toBe(76);
    expect(stats.green.maxHeight).toBe(76);
    expect(stats.green.deltaHeight).toBe(0);
    expect(stats.green.meanHeight).toBeCloseTo(76, 10);
    expect(stats.surrounds.deepestHollowM).toBeCloseTo(2, 10);
    // Relative scale = max |h − mean| over ALL cells = the hollow's 2 m.
    expect(stats.relScaleM).toBeCloseTo(2, 10);
});

test('computeStats caps the relative scale so hills in the buffer do not wash out hollows', () => {
    const grid = makeGrid({
        width: 10,
        height: 10,
        z: () => 76,
        inside: (row, col) => row >= 3 && row <= 6 && col >= 3 && col <= 6,
    });
    grid.heights[0] = 86; // 10 m hill in the surrounds
    const stats = computeStats(grid, computeSlopeGrid(grid));
    expect(stats.relScaleM).toBe(REL_SCALE_MAX_M);
});

test('computeStats floors the relative scale on a dead-flat site', () => {
    const grid = makeGrid({ width: 6, height: 6, z: () => 50 });
    const stats = computeStats(grid, computeSlopeGrid(grid));
    expect(stats.relScaleM).toBe(REL_SCALE_MIN_M);
    expect(stats.surrounds.deepestHollowM).toBe(0);
});

test('computeStats slope stats come from inside cells only', () => {
    // Steep plane, but mark only a flat-ish region inside... use a plane and
    // verify avg == max == 5 inside; surrounds carry the same slope.
    const grid = makeGrid({
        width: 12,
        height: 10,
        z: (e, n) => 50 + 0.03 * (e - 1000) + 0.04 * (n - 1990),
        inside: (row, col) => row >= 2 && row <= 7 && col >= 2 && col <= 9,
    });
    const stats = computeStats(grid, computeSlopeGrid(grid));
    expect(stats.green.maxSlopePct).toBeCloseTo(5, 8);
    expect(stats.green.avgSlopePct).toBeCloseTo(5, 8);
    expect(stats.surrounds.maxSlopePct).toBeCloseTo(5, 8);
});

// ─── Grid → RGBA mapping ──────────────────────────────────────────────────

test('overlay image: inside full alpha, outside reduced, nodata transparent', () => {
    const grid = makeGrid({
        width: 3,
        height: 1,
        z: e => (e < 1000.5 ? null : 60),
        inside: (_row, col) => col === 1,
    });
    // cells: [null outside] [60 inside] [60 outside]
    const slope = computeSlopeGrid(grid);
    const stats = computeStats(grid, slope);
    const rgba = buildOverlayRgba(grid, 'height', slope, stats);
    expect(rgba[3]).toBe(0); // nodata → transparent
    expect(rgba[7]).toBe(INSIDE_ALPHA);
    expect(rgba[11]).toBe(OUTSIDE_ALPHA);
    expect(INSIDE_ALPHA).toBe(217); // 0.85 * 255
    expect(OUTSIDE_ALPHA).toBe(140); // 0.55 * 255
});

test('height mode normalizes colors to the INSIDE min/max', () => {
    // Inside spans 70..71; an outside cell at 80 must clamp to red, not
    // stretch the ramp.
    const grid = makeGrid({
        width: 4,
        height: 1,
        z: () => 0, // overwritten below
        inside: (_row, col) => col <= 2,
    });
    grid.heights = [70, 70.5, 71, 80];
    const slope = computeSlopeGrid(grid);
    const stats = computeStats(grid, slope);
    const rgba = buildOverlayRgba(grid, 'height', slope, stats);
    const px = (i: number) => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    expect(px(0)).toEqual(HEIGHT_STOPS[0]); // inside min → blue
    expect(px(1)).toEqual(HEIGHT_STOPS[2]); // inside middle → yellow
    expect(px(2)).toEqual(HEIGHT_STOPS[4]); // inside max → red
    expect(px(3)).toEqual(HEIGHT_STOPS[4]); // above-green surrounds clamp to red
});

test('relative mode paints hollows blue/purple and mounds warm', () => {
    const grid = makeGrid({
        width: 3,
        height: 1,
        z: () => 76,
        inside: (_row, col) => col === 1,
    });
    grid.heights = [74, 76, 78]; // hollow | green level | mound
    const slope = computeSlopeGrid(grid);
    const stats = computeStats(grid, slope); // mean 76, scale 2
    const rgba = buildOverlayRgba(grid, 'relative', slope, stats);
    const px = (i: number) => [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]];
    expect(px(0)).toEqual(REL_BELOW_STOPS[3]); // 2 m below → purple
    expect(px(1)).toEqual(REL_NEUTRAL); // green level
    expect(px(2)).toEqual(REL_ABOVE_STOPS[3]); // 2 m above → red
});

test('slope mode colors cells by the slope ramp', () => {
    const grid = planeGrid(); // 5% everywhere
    const slope = computeSlopeGrid(grid);
    const stats = computeStats(grid, slope);
    const rgba = buildOverlayRgba(grid, 'slope', slope, stats);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual(SLOPE_ORANGE); // 5% → orange stop
});

// ─── Fall-line arrows ─────────────────────────────────────────────────────

test('fall-line arrows: ~8×8 sampling, downhill direction, every 4th labeled', () => {
    // 40×40 cells @ 0.5 m = 20×20 m → spacing max(2, 20/8) = 2.5 m → 8×8.
    const grid = makeGrid({
        width: 40,
        height: 40,
        z: (e, n) => 50 + 0.03 * (e - 1000) + 0.04 * (n - 1980),
    });
    const arrows = sampleFallLines(grid, computeSlopeGrid(grid));
    expect(arrows.length).toBe(64);
    for (const a of arrows) {
        expect(a.slopePct).toBeCloseTo(5, 6);
        expect(a.dirE).toBeCloseTo(-0.6, 6);
        expect(a.dirN).toBeCloseTo(-0.8, 6);
        expect(a.slopePct).toBeGreaterThan(ARROW_MIN_SLOPE_PCT);
    }
    expect(arrows.filter(a => a.labeled).length).toBe(16); // every 4th
    expect(arrows[0].labeled).toBe(true);
    expect(arrows[1].labeled).toBe(false);
});

test('fall-line arrows skip near-flat cells', () => {
    const grid = makeGrid({ width: 40, height: 40, z: () => 50 });
    const arrows = sampleFallLines(grid, computeSlopeGrid(grid));
    expect(arrows).toHaveLength(0);
});

test('fall-line arrow spacing never drops below 2 m', () => {
    // Tiny 4×4 m green: min(w,h)/8 = 0.5 → clamped to 2 m → 2×2 samples.
    const grid = makeGrid({
        width: 8,
        height: 8,
        z: (e, n) => 50 + 0.05 * (e - 1000) + 0.05 * (n - 1996),
    });
    const arrows = sampleFallLines(grid, computeSlopeGrid(grid));
    expect(arrows.length).toBe(4);
});
