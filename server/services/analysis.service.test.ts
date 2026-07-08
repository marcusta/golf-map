import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { writeArrayBuffer } from 'geotiff';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { NotFoundError } from '@basics/core/server/auth';
import {
    AnalysisService,
    InvalidAnalysisRequestError,
    computeGridSpec,
    computePointsGridSpec,
    pointsBbox,
    geometryBbox,
    gaussianBlurGrid,
    buildInsideMask,
    bilinearSample,
    pointInRing,
    BUFFER_MAX_M,
    MAX_CELLS_PER_AXIS,
    RESOLUTION_MIN_M,
    DEFAULT_RESOLUTION_M,
} from './analysis.service';
import type { FeatureGeometry } from './geo';

// ─── Synthetic DEM fixture ────────────────────────────────────────────────
//
// A small in-test GeoTIFF with a known linear gradient:
//   z(e, n) = BASE + GX * (e - E0) + GY * (N0 - n)
// (heights rise to the east and to the south). Written with geotiff's own
// writer, so the test exercises the service's real read path hermetically.

const E0 = 540000; // west edge (EPSG:3006 easting)
const N0 = 6470000; // north edge (EPSG:3006 northing)
const PX = 0.5; // pixel size, m
const DEM_W = 200;
const DEM_H = 200;
const BASE = 50;
const GX = 0.02; // m height per m east
const GY = 0.01; // m height per m south
const NODATA = -9999;

function planeHeight(e: number, n: number): number {
    return BASE + GX * (e - E0) + GY * (N0 - n);
}

function buildDemPixels(): Float32Array {
    const vals = new Float32Array(DEM_W * DEM_H);
    for (let row = 0; row < DEM_H; row++) {
        const n = N0 - (row + 0.5) * PX;
        for (let col = 0; col < DEM_W; col++) {
            const e = E0 + (col + 0.5) * PX;
            vals[row * DEM_W + col] = planeHeight(e, n);
        }
    }
    return vals;
}

let fixtureCounter = 0;

async function writeDemFixture(pixels: Float32Array): Promise<{ dataDir: string }> {
    const dataDir = path.join('/tmp', `golf-map-analysis-test-${process.pid}-${fixtureCounter++}`);
    fs.mkdirSync(path.join(dataDir, 'dem'), { recursive: true });
    const metadata = {
        height: DEM_H,
        width: DEM_W,
        ModelPixelScale: [PX, PX, 0],
        ModelTiepoint: [0, 0, 0, E0, N0, 0],
        ProjectedCSTypeGeoKey: 3006,
        GDAL_NODATA: `${NODATA} `,
        SampleFormat: [3],
        BitsPerSample: [32],
    };
    const buffer = writeArrayBuffer(pixels as never, metadata as never);
    await Bun.write(path.join(dataDir, 'dem', 'test-dem.tif'), buffer as ArrayBuffer);
    return { dataDir };
}

/**
 * Give the test course a site (id == course id, mirroring the 1:1 migration
 * backfill) and register the DEM against that site — analysis resolves the DEM
 * via course → site now.
 */
async function linkSiteWithDem(ctx: Awaited<ReturnType<typeof createTestDb>>, filename: string) {
    await ctx.db.insertInto('sites').values({ id: TEST_COURSE_ID, name: 'Test Site', version: 1 }).execute();
    await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: TEST_COURSE_ID }).execute();
    await ctx.assetsService.register({ siteId: TEST_COURSE_ID, courseId: TEST_COURSE_ID, kind: 'dem_cog', filename });
}

async function setup(pixels: Float32Array = buildDemPixels()) {
    const ctx = await createTestDb(seedCourse);
    const { dataDir } = await writeDemFixture(pixels);
    await linkSiteWithDem(ctx, 'dem/test-dem.tif');
    const svc = new AnalysisService(ctx.db, dataDir);
    return { ctx, svc, dataDir };
}

/** Square polygon ring (straight segments) centered in the fixture DEM. */
function squareGeometry(minE: number, minN: number, size: number): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: minE, y: minN },
                { x: minE + size, y: minN },
                { x: minE + size, y: minN + size },
                { x: minE, y: minN + size },
            ],
        }],
    };
}

// ─── gaussianBlurGrid ─────────────────────────────────────────────────────

test('gaussian blur leaves a constant grid unchanged', () => {
    const w = 12, h = 10;
    const grid = new Float64Array(w * h).fill(7.5);
    const out = gaussianBlurGrid(grid, w, h, 3);
    for (const v of out) expect(v).toBeCloseTo(7.5, 10);
});

test('gaussian blur spreads an impulse symmetrically and conserves ordering', () => {
    const w = 11, h = 11;
    const grid = new Float64Array(w * h);
    grid[5 * w + 5] = 1;
    const out = gaussianBlurGrid(grid, w, h, 3);
    // Center keeps the max, symmetric neighbors match.
    expect(out[5 * w + 5]).toBeGreaterThan(out[5 * w + 6]);
    expect(out[5 * w + 4]).toBeCloseTo(out[5 * w + 6], 12);
    expect(out[4 * w + 5]).toBeCloseTo(out[6 * w + 5], 12);
    expect(out[4 * w + 4]).toBeCloseTo(out[6 * w + 6], 12);
    // Blur is a weighted average: everything stays within [0, 1].
    for (const v of out) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
    }
});

test('gaussian blur preserves a linear ramp away from the edges', () => {
    const w = 20, h = 20;
    const grid = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) grid[y * w + x] = 2 * x + 3 * y;
    }
    const out = gaussianBlurGrid(grid, w, h, 3);
    for (let y = 3; y < h - 3; y++) {
        for (let x = 3; x < w - 3; x++) {
            expect(out[y * w + x]).toBeCloseTo(2 * x + 3 * y, 8);
        }
    }
});

test('gaussian blur keeps NaN cells NaN and does not bleed nodata into valid cells', () => {
    const w = 9, h = 9;
    const grid = new Float64Array(w * h).fill(4);
    grid[4 * w + 4] = NaN;
    const out = gaussianBlurGrid(grid, w, h, 3);
    expect(Number.isNaN(out[4 * w + 4])).toBe(true);
    // Neighbors of the hole: kernel renormalized over valid cells → still 4.
    expect(out[4 * w + 3]).toBeCloseTo(4, 10);
    expect(out[3 * w + 4]).toBeCloseTo(4, 10);
    expect(out[0]).toBeCloseTo(4, 10);
});

test('gaussian blur with radius 0 is the identity', () => {
    const grid = Float64Array.from([1, 2, 3, 4]);
    const out = gaussianBlurGrid(grid, 2, 2, 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
});

// ─── computeGridSpec ──────────────────────────────────────────────────────

const BBOX = { minX: 100, minY: 200, maxX: 130, maxY: 220 }; // 30 × 20 m

test('computeGridSpec places the origin at the buffered NW corner', () => {
    const spec = computeGridSpec(BBOX, 10, 0.5);
    expect(spec.origin).toEqual({ e: 90, n: 230 });
    expect(spec.resolution).toBe(0.5);
    expect(spec.width).toBe(100); // (30 + 20) / 0.5
    expect(spec.height).toBe(80); // (20 + 20) / 0.5
});

test('computeGridSpec clamps the buffer to the allowed range', () => {
    const over = computeGridSpec(BBOX, 500, 0.5);
    expect(over.origin.e).toBe(BBOX.minX - BUFFER_MAX_M);
    const negative = computeGridSpec(BBOX, -10, 0.5);
    expect(negative.origin.e).toBe(BBOX.minX);
});

test('computeGridSpec clamps too-fine resolutions up to the minimum', () => {
    const spec = computeGridSpec(BBOX, 10, 0.01);
    expect(spec.resolution).toBe(RESOLUTION_MIN_M);
});

test('computeGridSpec coarsens resolution to respect the per-axis cell cap', () => {
    const bigBbox = { minX: 0, minY: 0, maxX: 380, maxY: 380 };
    const spec = computeGridSpec(bigBbox, 10, 0.5); // 400 m extent → 800 cells at 0.5
    expect(spec.width).toBeLessThanOrEqual(MAX_CELLS_PER_AXIS);
    expect(spec.height).toBeLessThanOrEqual(MAX_CELLS_PER_AXIS);
    expect(spec.resolution).toBeCloseTo(1.0, 10);
});

test('computeGridSpec falls back to defaults for non-finite inputs', () => {
    const spec = computeGridSpec(BBOX, Number.NaN, Number.NaN);
    expect(spec.origin.e).toBe(BBOX.minX - 20); // default buffer
    expect(spec.resolution).toBe(0.5); // default resolution
});

// ─── geometryBbox ─────────────────────────────────────────────────────────

test('geometryBbox covers all rings and rejects degenerate geometry', () => {
    const geom = squareGeometry(100, 200, 30);
    expect(geometryBbox(geom)).toEqual({ minX: 100, minY: 200, maxX: 130, maxY: 230 });
    const degenerate: FeatureGeometry = {
        crs: 'EPSG:3006',
        rings: [{ points: [{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 1 }] }],
    };
    expect(() => geometryBbox(degenerate)).toThrow(InvalidAnalysisRequestError);
});

// ─── pointInRing / buildInsideMask ────────────────────────────────────────

test('pointInRing basic containment', () => {
    const square: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(pointInRing(5, 5, square)).toBe(true);
    expect(pointInRing(-1, 5, square)).toBe(false);
    expect(pointInRing(5, 11, square)).toBe(false);
});

test('buildInsideMask marks green cells 1 and buffer cells 0', () => {
    const geom = squareGeometry(100, 200, 20);
    const spec = computeGridSpec(geometryBbox(geom), 10, 0.5);
    const mask = buildInsideMask(spec, geom);
    expect(mask).toHaveLength(spec.width * spec.height);

    const at = (e: number, n: number) => {
        const col = Math.floor((e - spec.origin.e) / spec.resolution);
        const row = Math.floor((spec.origin.n - n) / spec.resolution);
        return mask[row * spec.width + col];
    };
    expect(at(110, 210)).toBe(1); // green center
    expect(at(101, 201)).toBe(1); // just inside the corner
    expect(at(95, 210)).toBe(0); // west buffer
    expect(at(110, 225)).toBe(0); // north buffer
    // Exactly (20 / 0.5)^2 = 1600 cell centers land inside the square.
    expect(mask.reduce((a, b) => a + b, 0)).toBe(1600);
});

test('buildInsideMask excludes hole rings', () => {
    const geom = squareGeometry(100, 200, 20);
    geom.rings.push({
        points: [
            { x: 108, y: 208 },
            { x: 112, y: 208 },
            { x: 112, y: 212 },
            { x: 108, y: 212 },
        ],
    });
    const spec = computeGridSpec(geometryBbox(geom), 10, 0.5);
    const mask = buildInsideMask(spec, geom);
    const col = Math.floor((110 - spec.origin.e) / spec.resolution);
    const row = Math.floor((spec.origin.n - 210) / spec.resolution);
    expect(mask[row * spec.width + col]).toBe(0); // inside the hole
});

// ─── bilinearSample ───────────────────────────────────────────────────────

test('bilinearSample interpolates a gradient plane exactly', () => {
    const w = 10, h = 10;
    const values = new Float64Array(w * h);
    for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) values[row * w + col] = col * 2 + row * 3;
    }
    const win = { values, width: w, height: h, originE: 0, originN: 0, pixelX: 1, pixelY: 1 };
    // Pixel centers are at (col + 0.5, -(row + 0.5)).
    expect(bilinearSample(win, 0.5, -0.5)).toBeCloseTo(0, 10);
    expect(bilinearSample(win, 1.5, -0.5)).toBeCloseTo(2, 10);
    expect(bilinearSample(win, 1.0, -0.5)).toBeCloseTo(1, 10); // halfway between cols 0 and 1
    expect(bilinearSample(win, 2.5, -3.0)).toBeCloseTo(2 * 2 + 3 * 2.5, 10);
    expect(Number.isNaN(bilinearSample(win, -5, -0.5))).toBe(true); // outside window
});

// ─── sampleGrid end-to-end against the synthetic GeoTIFF ──────────────────

test('sampleGrid returns the DEM plane (blur-invariant) with correct layout', async () => {
    const { svc } = await setup();
    // 20 m square in the middle of the 100 m fixture.
    const geom = squareGeometry(E0 + 40, N0 - 60, 20);
    const grid = await svc.sampleGrid(TEST_COURSE_ID, geom, 10, 0.5);

    expect(grid.resolution).toBe(0.5);
    expect(grid.origin).toEqual({ e: E0 + 30, n: N0 - 30 });
    expect(grid.width).toBe(80);
    expect(grid.height).toBe(80);
    expect(grid.heights).toHaveLength(6400);
    expect(grid.insideMask).toHaveLength(6400);

    // Interior cells (≥ blur radius from the grid edge) must match the
    // plane: bilinear + gaussian blur both preserve linear gradients.
    for (const [row, col] of [[10, 10], [40, 40], [40, 20], [65, 70]] as const) {
        const e = grid.origin.e + (col + 0.5) * grid.resolution;
        const n = grid.origin.n - (row + 0.5) * grid.resolution;
        const v = grid.heights[row * grid.width + col];
        expect(v).not.toBeNull();
        expect(v!).toBeCloseTo(planeHeight(e, n), 2);
    }

    // Mask: green occupies the central 40×40 cells.
    const inside = grid.insideMask.reduce((a, b) => a + b, 0);
    expect(inside).toBe(1600);
    expect(grid.insideMask[40 * grid.width + 40]).toBe(1);
    expect(grid.insideMask[0]).toBe(0);
});

test('sampleGrid clamps the buffer end-to-end', async () => {
    const { svc } = await setup();
    const geom = squareGeometry(E0 + 40, N0 - 60, 20);
    const grid = await svc.sampleGrid(TEST_COURSE_ID, geom, 5000, 0.5);
    expect(grid.origin.e).toBe(E0 + 40 - BUFFER_MAX_M);
});

test('sampleGrid maps nodata pixels to null heights', async () => {
    const pixels = buildDemPixels();
    // Kill a 10×10 px block in the NW of the green area (rows/cols 80–89 → 40–45 m).
    for (let row = 80; row < 90; row++) {
        for (let col = 80; col < 90; col++) pixels[row * DEM_W + col] = NODATA;
    }
    const { svc } = await setup(pixels);
    const geom = squareGeometry(E0 + 40, N0 - 60, 20);
    const grid = await svc.sampleGrid(TEST_COURSE_ID, geom, 10, 0.5);

    // Center of the killed block: e = E0 + 42.25, n = N0 - 42.25.
    const col = Math.round((E0 + 42.25 - grid.origin.e) / grid.resolution - 0.5);
    const row = Math.round((grid.origin.n - (N0 - 42.25)) / grid.resolution - 0.5);
    expect(grid.heights[row * grid.width + col]).toBeNull();
    // Far corner is still valid.
    expect(grid.heights[70 * grid.width + 70]).not.toBeNull();
});

test('sampleGrid throws NotFoundError when the course has no DEM asset', async () => {
    const ctx = await createTestDb(seedCourse);
    const svc = new AnalysisService(ctx.db, '/tmp/does-not-matter');
    const geom = squareGeometry(E0 + 40, N0 - 60, 20);
    await expect(svc.sampleGrid(TEST_COURSE_ID, geom)).rejects.toBeInstanceOf(NotFoundError);
});

test('sampleGrid throws NotFoundError when the DEM file is missing on disk', async () => {
    const ctx = await createTestDb(seedCourse);
    await linkSiteWithDem(ctx, 'dem/absent.tif');
    const svc = new AnalysisService(ctx.db, '/tmp/golf-map-analysis-missing-dem');
    const geom = squareGeometry(E0 + 40, N0 - 60, 20);
    await expect(svc.sampleGrid(TEST_COURSE_ID, geom)).rejects.toBeInstanceOf(NotFoundError);
});

test('sampleGrid rejects geometry entirely outside DEM coverage', async () => {
    const { svc } = await setup();
    const geom = squareGeometry(E0 + 10000, N0 - 10000, 20);
    await expect(svc.sampleGrid(TEST_COURSE_ID, geom, 10, 0.5))
        .rejects.toBeInstanceOf(InvalidAnalysisRequestError);
});

test('sampleGrid rejects empty geometry', async () => {
    const { svc } = await setup();
    const geom = { crs: 'EPSG:3006', rings: [] } as FeatureGeometry;
    await expect(svc.sampleGrid(TEST_COURSE_ID, geom)).rejects.toBeInstanceOf(InvalidAnalysisRequestError);
});

// ─── pointsBbox / computePointsGridSpec ────────────────────────────────────

test('pointsBbox covers all points and pads a degenerate (single-point) extent', () => {
    const bbox = pointsBbox([{ e: 100, n: 200 }, { e: 130, n: 180 }, { e: 110, n: 220 }]);
    expect(bbox).toEqual({ minX: 100, minY: 180, maxX: 130, maxY: 220 });

    const single = pointsBbox([{ e: 50, n: 60 }]);
    expect(single.minX).toBeCloseTo(50 - RESOLUTION_MIN_M, 10);
    expect(single.maxX).toBeCloseTo(50 + RESOLUTION_MIN_M, 10);
    expect(single.minY).toBeCloseTo(60 - RESOLUTION_MIN_M, 10);
    expect(single.maxY).toBeCloseTo(60 + RESOLUTION_MIN_M, 10);
});

test('pointsBbox rejects an empty point list', () => {
    expect(() => pointsBbox([])).toThrow(InvalidAnalysisRequestError);
});

test('computePointsGridSpec synthesizes a DEM-native-resolution window over the points bbox', () => {
    const spec = computePointsGridSpec([{ e: 100, n: 200 }, { e: 130, n: 220 }]);
    expect(spec.origin).toEqual({ e: 100, n: 220 });
    expect(spec.resolution).toBe(DEFAULT_RESOLUTION_M);
    expect(spec.width).toBe(Math.ceil(30 / DEFAULT_RESOLUTION_M));
    expect(spec.height).toBe(Math.ceil(20 / DEFAULT_RESOLUTION_M));
});

// ─── sampleElevations ───────────────────────────────────────────────────────

test('sampleElevations returns [] for empty input without touching the DEM', async () => {
    // dataDir points nowhere; if the DEM were opened this would reject instead of resolving.
    const ctx = await createTestDb(seedCourse);
    const svc = new AnalysisService(ctx.db, '/tmp/does-not-matter');
    expect(await svc.sampleElevations(TEST_COURSE_ID, [])).toEqual([]);
});

test('sampleElevations matches sampleGrid\'s pre-blur (raw bilinear) value at the same coordinate', async () => {
    const { svc } = await setup();
    // A point well inside the fixture DEM, away from any edge effects.
    const e = E0 + 42.37;
    const n = N0 - 58.11;

    const [elevation] = await svc.sampleElevations(TEST_COURSE_ID, [{ e, n }]);
    expect(elevation).not.toBeNull();
    // Ground truth: sampleElevations does no blur, so it must equal the
    // exact bilinear interpolation of the known plane (not just sampleGrid's
    // blurred output, which only agrees away from edges).
    expect(elevation!).toBeCloseTo(planeHeight(e, n), 2);
});

test('sampleElevations samples multiple points independently, preserving order', async () => {
    const { svc } = await setup();
    const points = [
        { e: E0 + 10, n: N0 - 10 },
        { e: E0 + 90, n: N0 - 90 },
        { e: E0 + 50, n: N0 - 50 },
    ];
    const elevations = await svc.sampleElevations(TEST_COURSE_ID, points);
    expect(elevations).toHaveLength(3);
    points.forEach((p, i) => {
        expect(elevations[i]).not.toBeNull();
        expect(elevations[i]!).toBeCloseTo(planeHeight(p.e, p.n), 2);
    });
});

test('sampleElevations maps an off-DEM (nodata) point to null without affecting others', async () => {
    const pixels = buildDemPixels();
    // Kill a small block near the fixture's NW corner (rows/cols 10-19 → 5-9.5 m).
    for (let row = 10; row < 20; row++) {
        for (let col = 10; col < 20; col++) pixels[row * DEM_W + col] = NODATA;
    }
    const { svc } = await setup(pixels);
    const offDem = { e: E0 + 7, n: N0 - 7 };
    const onDem = { e: E0 + 70, n: N0 - 70 };

    const [offValue, onValue] = await svc.sampleElevations(TEST_COURSE_ID, [offDem, onDem]);
    expect(offValue).toBeNull();
    expect(onValue).not.toBeNull();
    expect(onValue!).toBeCloseTo(planeHeight(onDem.e, onDem.n), 2);
});

test('sampleElevations throws NotFoundError when the course has no DEM asset', async () => {
    const ctx = await createTestDb(seedCourse);
    const svc = new AnalysisService(ctx.db, '/tmp/does-not-matter');
    await expect(svc.sampleElevations(TEST_COURSE_ID, [{ e: E0 + 10, n: N0 - 10 }]))
        .rejects.toBeInstanceOf(NotFoundError);
});

test('sampleElevations rejects points entirely outside DEM coverage', async () => {
    const { svc } = await setup();
    await expect(svc.sampleElevations(TEST_COURSE_ID, [{ e: E0 + 100000, n: N0 - 100000 }]))
        .rejects.toBeInstanceOf(InvalidAnalysisRequestError);
});
