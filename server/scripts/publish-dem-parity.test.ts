/**
 * The W4 claim, end to end and across the language boundary: what the VPS
 * answers on a green must be what the builder answers on the same green.
 *
 * So this test builds a real GeoTIFF, runs the *real* `golfpipe dem-analysis`
 * through the *real* publish path, and then runs the *real* AnalysisService
 * over both rasters — the full builder DEM and the published mosaic — and
 * compares `/analysis/sample-grid` cell for cell. Nothing here is stubbed.
 *
 * It needs the pipeline venv (`pipeline/setup.sh`), which the server suite
 * otherwise does not, so it skips itself when Python is absent rather than
 * failing a Python-less checkout. There is no CI (see TESTING.md), so this
 * runs on the builder Mac, which is exactly the box the feature targets.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { writeArrayBuffer } from 'geotiff';
import { createTestDb as createRawDb } from '@basics/core/server/testing';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_1_ID } from '../db/seeds/course';
import { buildBundle } from './publish';
import { AnalysisService } from '../services/analysis.service';
import type { FeatureGeometry } from '../services/geo';

const migrationFolder = path.join(import.meta.dir, '../db/migrations');
const SITE_ID = 'site-1';
const DEM_REL = `sources/${SITE_ID}/dem.tif`;

const PIPELINE_DIR = process.env.MAP_PIPELINE_DIR ?? path.resolve(import.meta.dir, '../../pipeline');
const PYTHON = process.env.MAP_PIPELINE_PYTHON ?? path.join(PIPELINE_DIR, '.venv', 'bin', 'python');
const HAVE_PIPELINE = existsSync(PYTHON);

// ─── Fixture raster: 200 m square at 0.5 m, SWEREF99 TM ───────────────────

const E0 = 540000; // west edge
const N0 = 6470000; // north edge
const PX = 0.5;
const DEM_W = 400;
const DEM_H = 400;
const NODATA = -9999;

/** Green: a 30 m square 40 m in from the NW corner, buffer clear of the edges. */
const GREEN_E = E0 + 40;
const GREEN_N = N0 - 70; // south edge of the green
const GREEN_SIDE = 30;

/**
 * Broad terrain waves plus deterministic cell-level roughness. The roughness
 * is the point: it is what a 1 m block mean destroys, so a green sampled off
 * the coarse background would be visibly wrong and this test would catch it.
 */
function height(e: number, n: number): number {
    const de = e - E0;
    const dn = N0 - n;
    const wave = 50 + 0.02 * de + 0.01 * dn
        + 1.5 * Math.sin((de * 2 * Math.PI) / 120)
        + 1.1 * Math.cos((dn * 2 * Math.PI) / 90);
    // Cheap deterministic hash → ±3 cm, uncorrelated between neighbours.
    const h = Math.sin(de * 12.9898 + dn * 78.233) * 43758.5453;
    return wave + (h - Math.floor(h) - 0.5) * 0.06;
}

function buildDemPixels(): Float32Array {
    const vals = new Float32Array(DEM_W * DEM_H);
    for (let row = 0; row < DEM_H; row++) {
        const n = N0 - (row + 0.5) * PX;
        for (let col = 0; col < DEM_W; col++) {
            vals[row * DEM_W + col] = height(E0 + (col + 0.5) * PX, n);
        }
    }
    return vals;
}

async function writeDem(absPath: string): Promise<void> {
    mkdirSync(path.dirname(absPath), { recursive: true });
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
    const buffer = writeArrayBuffer(buildDemPixels() as never, metadata as never);
    await Bun.write(absPath, buffer as ArrayBuffer);
}

function greenGeometry(): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: GREEN_E, y: GREEN_N },
                { x: GREEN_E + GREEN_SIDE, y: GREEN_N },
                { x: GREEN_E + GREEN_SIDE, y: GREEN_N + GREEN_SIDE },
                { x: GREEN_E, y: GREEN_N + GREEN_SIDE },
            ],
        }],
    };
}

/** A geometry the same size, 70 m further east — outside the 30 m green buffer. */
function offGreenGeometry(): FeatureGeometry {
    const shift = 70;
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: greenGeometry().rings[0].points.map((p) => ({ x: p.x + shift, y: p.y })),
        }],
    };
}

function tmp(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `golf-${prefix}-`));
}

async function seedBuilder(dataDir: string): Promise<Kysely<Database>> {
    const db = await createRawDb<Database>(migrationFolder);
    await db.insertInto('sites').values({ id: SITE_ID, name: 'Parity', version: 1 }).execute();
    await seedCourse({ db } as never);
    await db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();

    // Replace the seed's placeholder green with one that sits on the fixture DEM.
    await db
        .updateTable('course_features')
        .set({ geometry_json: JSON.stringify(greenGeometry()) })
        .where('hole_id', '=', TEST_HOLE_1_ID)
        .where('type', '=', 'green')
        .execute();

    const tilesRoot = path.join(dataDir, 'tiles', SITE_ID);
    mkdirSync(path.join(tilesRoot, 'terrain', '14', '1'), { recursive: true });
    writeFileSync(path.join(tilesRoot, 'terrain', '14', '1', '1.png'), 'x');
    writeFileSync(path.join(tilesRoot, 'manifest.json'), JSON.stringify({ layers: { terrain: { minzoom: 14, maxzoom: 14 } } }));

    await writeDem(path.join(dataDir, DEM_REL));
    await db
        .insertInto('course_assets')
        .values({ id: 'asset-dem', course_id: TEST_COURSE_ID, site_id: SITE_ID, kind: 'dem_cog', filename: DEM_REL })
        .execute();
    return db;
}

/** Publishes for real and returns the two data dirs to compare through. */
async function publishAndSplit(): Promise<{ db: Kysely<Database>; builderDir: string; vpsDir: string; bytes: { source: number; mosaic: number } }> {
    const builderDir = tmp('builder');
    const db = await seedBuilder(builderDir);

    const { stagingDir, analysisDem, warnings } = await buildBundle(
        { db, dataDir: builderDir, pipelineDir: PIPELINE_DIR, python: PYTHON },
        { siteId: SITE_ID, outDir: tmp('stage') },
    );
    expect(warnings).toEqual([]);
    expect(analysisDem).toBe('mosaic');

    // The VPS unpacks the bundle's DEM under the same relative path the asset
    // row names, so pointing a second AnalysisService at it is exactly the
    // serve-mode read path.
    const vpsDir = tmp('vps');
    const mosaic = path.join(stagingDir, 'dem', 'dem-analysis.tif');
    mkdirSync(path.dirname(path.join(vpsDir, DEM_REL)), { recursive: true });
    copyFileSync(mosaic, path.join(vpsDir, DEM_REL));

    return {
        db,
        builderDir,
        vpsDir,
        bytes: {
            source: Bun.file(path.join(builderDir, DEM_REL)).size,
            mosaic: Bun.file(mosaic).size,
        },
    };
}

describe.skipIf(!HAVE_PIPELINE)('published analysis DEM parity (W4)', () => {
    test('sample-grid over the published mosaic matches the builder DEM on a green', async () => {
        const { db, builderDir, vpsDir, bytes } = await publishAndSplit();

        const builder = new AnalysisService(db, builderDir);
        const vps = new AnalysisService(db, vpsDir);
        const geometry = greenGeometry();

        const a = await builder.sampleGrid(TEST_COURSE_ID, geometry);
        const b = await vps.sampleGrid(TEST_COURSE_ID, geometry);

        expect(b.width).toBe(a.width);
        expect(b.height).toBe(a.height);
        expect(b.origin).toEqual(a.origin);
        expect(b.resolution).toBe(a.resolution);
        expect(b.insideMask).toEqual(a.insideMask);

        // The green + the default sampling buffer both sit inside the 30 m
        // full-resolution margin, so every cell must agree — to float32, not
        // to a fudge factor. (Both sides read float32 rasters and blur in
        // float64; 1e-4 m is float32 noise, not a tolerance for being wrong.)
        let compared = 0;
        let worst = 0;
        for (let i = 0; i < a.heights.length; i++) {
            const ha = a.heights[i];
            const hb = b.heights[i];
            expect(hb === null).toBe(ha === null);
            if (ha === null || hb === null) continue;
            worst = Math.max(worst, Math.abs(hb - ha));
            compared++;
        }
        expect(compared).toBeGreaterThan(1000);
        expect(worst).toBeLessThan(1e-4);

        // NB the source here is written by geotiff.js and is uncompressed, so
        // this ratio is mosaic-vs-raw. The like-for-like deflate comparison
        // lives in pipeline/tests/test_dem_analysis.py.
        console.log(
            `  parity: ${compared} cells, max |Δz| = ${worst.toExponential(2)} m; `
            + `mosaic ${bytes.mosaic.toLocaleString()} B vs uncompressed source ${bytes.source.toLocaleString()} B`,
        );
    });

    test('away from the greens the mosaic really is coarser — the test above is not vacuous', async () => {
        const { db, builderDir, vpsDir } = await publishAndSplit();

        const geometry = offGreenGeometry();
        const a = await new AnalysisService(db, builderDir).sampleGrid(TEST_COURSE_ID, geometry);
        const b = await new AnalysisService(db, vpsDir).sampleGrid(TEST_COURSE_ID, geometry);

        let worst = 0;
        for (let i = 0; i < a.heights.length; i++) {
            const ha = a.heights[i];
            const hb = b.heights[i];
            if (ha === null || hb === null) continue;
            worst = Math.max(worst, Math.abs(hb - ha));
        }
        // Cell-level roughness is ±3 cm and the analysis blur damps it, so the
        // residual is small in absolute terms — but it is orders of magnitude
        // above the on-green agreement, which is the point.
        expect(worst).toBeGreaterThan(1e-3);
    });
});
