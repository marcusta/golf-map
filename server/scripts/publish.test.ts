import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createTestDb as createRawDb } from '@basics/core/server/testing';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { seedCourse, TEST_COURSE_ID, TEST_HOLE_2_ID } from '../db/seeds/course';
import { buildBundle, parseArgs } from './publish';
import { preflight } from './publish';
import type { PipelineRunner } from '../services/map-build.service';
import { CONTENT_HASH_FILES, CONTENT_TABLES, contentHash } from '../services/bundle';

const migrationFolder = path.join(import.meta.dir, '../db/migrations');
const SITE_ID = 'site-1';

function tmp(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `golf-${prefix}-`));
}

async function seedBuilder(dataDir: string): Promise<Kysely<Database>> {
    const db = await createRawDb<Database>(migrationFolder);
    await db.insertInto('sites').values({ id: SITE_ID, name: 'Linkan', version: 1 }).execute();
    await seedCourse({ db } as never);
    await db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();

    const tilesRoot = path.join(dataDir, 'tiles', SITE_ID);
    const writeTile = (rel: string) => {
        const p = path.join(tilesRoot, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, 'x');
    };
    for (const z of [14, 17, 19, 20, 21]) writeTile(`ortho/${z}/1/1.jpg`);
    writeTile('ortho/vintage-2023/19/1/1.jpg'); // collection subdir — must be skipped
    writeTile('terrain/14/1/1.png');
    writeTile('hillshade/14/1/1.png');
    writeFileSync(
        path.join(tilesRoot, 'manifest.json'),
        JSON.stringify({ layers: { ortho: { minzoom: 14, maxzoom: 21 }, terrain: { minzoom: 14, maxzoom: 14 } } }),
    );
    return db;
}

describe('publish buildBundle (W2)', () => {
    test('caps ortho at z19 by default, excludes higher zooms and collection subdirs', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const outDir = tmp('stage');

        const { stagingDir, meta } = await buildBundle({ db, dataDir }, { siteId: SITE_ID, outDir });

        const orthoDir = path.join(stagingDir, 'tiles', 'ortho');
        expect(existsSync(path.join(orthoDir, '14/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(orthoDir, '17/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(orthoDir, '19/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(orthoDir, '20/1/1.jpg'))).toBe(false);
        expect(existsSync(path.join(orthoDir, '21/1/1.jpg'))).toBe(false);
        expect(existsSync(path.join(orthoDir, 'vintage-2023'))).toBe(false);

        // Other layers travel uncapped.
        expect(existsSync(path.join(stagingDir, 'tiles', 'terrain', '14/1/1.png'))).toBe(true);
        expect(existsSync(path.join(stagingDir, 'tiles', 'hillshade', '14/1/1.png'))).toBe(true);

        // Manifest ortho maxzoom rewritten to the cap.
        const manifest = JSON.parse(await Bun.file(path.join(stagingDir, 'tiles', 'manifest.json')).text());
        expect(manifest.layers.ortho.maxzoom).toBe(19);

        expect(meta.orthoMaxzoom).toBe(19);
        expect(meta.layerZoomRanges.ortho).toEqual({ minzoom: 14, maxzoom: 19 });
        expect(meta.courseIds).toEqual([TEST_COURSE_ID]);
    });

    test('a custom ortho cap is honored', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const { stagingDir, meta } = await buildBundle({ db, dataDir }, { siteId: SITE_ID, outDir: tmp('stage'), orthoMaxzoom: 17 });
        expect(meta.orthoMaxzoom).toBe(17);
        expect(existsSync(path.join(stagingDir, 'tiles', 'ortho', '17/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(stagingDir, 'tiles', 'ortho', '19/1/1.jpg'))).toBe(false);
        const manifest = JSON.parse(await Bun.file(path.join(stagingDir, 'tiles', 'manifest.json')).text());
        expect(manifest.layers.ortho.maxzoom).toBe(17);
    });

    test('writes a content jsonl for every table and a matching content hash', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const { stagingDir, meta } = await buildBundle({ db, dataDir }, { siteId: SITE_ID, outDir: tmp('stage') });

        for (const table of CONTENT_TABLES) {
            expect(existsSync(path.join(stagingDir, 'content', `${table}.jsonl`))).toBe(true);
        }
        const courses = (await Bun.file(path.join(stagingDir, 'content', 'courses.jsonl')).text()).trim().split('\n');
        expect(courses.length).toBe(1);
        expect(JSON.parse(courses[0]).id).toBe(TEST_COURSE_ID);

        // Recompute the hash over the fixed file set — must match meta.
        const parts: Buffer[] = [];
        for (const rel of CONTENT_HASH_FILES) {
            const f = Bun.file(path.join(stagingDir, rel));
            parts.push((await f.exists()) ? Buffer.from(await f.arrayBuffer()) : Buffer.alloc(0));
        }
        expect(contentHash(parts)).toBe(meta.contentHash);
    });

    test('preflight rejects a running map build', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await db
            .insertInto('map_build_jobs')
            .values({ id: 'job-1', course_id: TEST_COURSE_ID, site_id: SITE_ID, status: 'running', step: null, bbox_json: '{}', log: '', error: null })
            .execute();
        await expect(preflight({ db, dataDir }, SITE_ID)).rejects.toThrow(/map build is in progress/);
    });

    test('preflight rejects an unknown site', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await expect(preflight({ db, dataDir }, 'nope')).rejects.toThrow(/not found/);
    });
});

// ─── Analysis DEM wiring (W4) ─────────────────────────────────────────────
//
// These cover *which* DEM publish derives from, when it rebuilds, and what it
// does when the pipeline is unavailable. The pipeline is exercised through the
// same injected-runner seam MapBuildService uses (a real function in an
// isolated environment, not a mocking library); the raster maths itself is
// pinned by pipeline/tests/test_dem_analysis.py, and the end-to-end parity of
// the two together by publish-dem-parity.test.ts.

interface RunnerLog {
    args: string[][];
    runner: PipelineRunner;
}

/** A runner that records its invocations and writes a marker mosaic. */
function recordingRunner(opts: { fail?: boolean } = {}): RunnerLog {
    const args: string[][] = [];
    const runner: PipelineRunner = async (argv) => {
        args.push(argv);
        if (opts.fail) return { code: 1, stdout: '', stderr: 'golfpipe: no such command\n' };
        const outIdx = argv.indexOf('--out');
        writeFileSync(argv[outIdx + 1], 'MOSAIC');
        return { code: 0, stdout: '', stderr: '' };
    };
    return { args, runner };
}

async function registerDem(db: Kysely<Database>, dataDir: string, filename: string, body = 'FULL-DEM'): Promise<string> {
    const abs = path.join(dataDir, filename);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    await db
        .insertInto('course_assets')
        .values({ id: `asset-${filename.replace(/\W/g, '-')}`, course_id: TEST_COURSE_ID, site_id: SITE_ID, kind: 'dem_cog', filename })
        .execute();
    return abs;
}

function shippedDem(stagingDir: string): string {
    return readFileSync(path.join(stagingDir, 'dem', 'dem-analysis.tif'), 'utf8');
}

describe('publish analysis DEM (W4)', () => {
    test('derives the mosaic from the registered DEM and hands greens over as WGS84 GeoJSON', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await registerDem(db, dataDir, `sources/${SITE_ID}/dem.tif`);
        const { runner, args } = recordingRunner();

        const { stagingDir, analysisDem, warnings } = await buildBundle(
            { db, dataDir, runner, pipelineDir: dataDir, python: 'python3' },
            { siteId: SITE_ID, outDir: tmp('stage') },
        );

        expect(analysisDem).toBe('mosaic');
        expect(shippedDem(stagingDir)).toBe('MOSAIC');
        expect(warnings).toEqual([]);

        expect(args.length).toBe(1);
        const argv = args[0];
        expect(argv.slice(0, 3)).toEqual(['-m', 'golfpipe', 'dem-analysis']);
        expect(argv[argv.indexOf('--input') + 1]).toBe(path.join(dataDir, 'sources', SITE_ID, 'dem.tif'));

        // The greens handoff: a WGS84 FeatureCollection of the site's green
        // polygons (D-TE5 shape), which is what golfpipe dem-analysis parses.
        const greens = JSON.parse(readFileSync(argv[argv.indexOf('--greens') + 1], 'utf8'));
        expect(greens.type).toBe('FeatureCollection');
        expect(greens.features.length).toBe(1);
        expect(greens.features[0].geometry.type).toBe('Polygon');
        const [lon, lat] = greens.features[0].geometry.coordinates[0][0];
        expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    });

    test('prefers the edited DEM over a stale dem_cog registration, and says so', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await registerDem(db, dataDir, `sources/${SITE_ID}/dem.tif`);
        writeFileSync(path.join(dataDir, 'sources', SITE_ID, 'dem-edited.tif'), 'EDITED');
        const { runner, args } = recordingRunner();

        const { warnings } = await buildBundle(
            { db, dataDir, runner },
            { siteId: SITE_ID, outDir: tmp('stage') },
        );

        const argv = args[0];
        expect(argv[argv.indexOf('--input') + 1]).toBe(path.join(dataDir, 'sources', SITE_ID, 'dem-edited.tif'));
        expect(warnings.join(' ')).toMatch(/dem-edited\.tif exists/);
    });

    test('--full-dem ships the builder DEM untouched and never calls the pipeline', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await registerDem(db, dataDir, `sources/${SITE_ID}/dem.tif`);
        const { runner, args } = recordingRunner();

        const { stagingDir, analysisDem } = await buildBundle(
            { db, dataDir, runner },
            { siteId: SITE_ID, outDir: tmp('stage'), fullDem: true },
        );

        expect(analysisDem).toBe('full');
        expect(shippedDem(stagingDir)).toBe('FULL-DEM');
        expect(args.length).toBe(0);
    });

    test('a fresh cache is reused, but a newer source DEM or a changed green rebuilds it', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const demPath = await registerDem(db, dataDir, `sources/${SITE_ID}/dem.tif`);
        const { runner, args } = recordingRunner();
        const deps = { db, dataDir, runner };

        const first = await buildBundle(deps, { siteId: SITE_ID, outDir: tmp('stage') });
        expect(first.analysisDem).toBe('mosaic');

        // Nothing changed → the cached mosaic ships without re-running golfpipe.
        const second = await buildBundle(deps, { siteId: SITE_ID, outDir: tmp('stage') });
        expect(second.analysisDem).toBe('mosaic-cached');
        expect(shippedDem(second.stagingDir)).toBe('MOSAIC');
        expect(args.length).toBe(1);

        // Terrain edit / rebuild touches the source DEM → stale.
        const future = new Date(Date.now() + 60_000);
        utimesSync(demPath, future, future);
        expect((await buildBundle(deps, { siteId: SITE_ID, outDir: tmp('stage') })).analysisDem).toBe('mosaic');
        expect(args.length).toBe(2);

        // Drawing another green changes the mask → stale, even though the DEM did not move.
        await db
            .insertInto('course_features')
            .values({
                id: 'feature-green-2',
                course_id: TEST_COURSE_ID,
                hole_id: TEST_HOLE_2_ID,
                type: 'green',
                geometry_json: JSON.stringify({ crs: 'EPSG:3006', rings: [{ points: [{ x: 40, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 50 }, { x: 40, y: 50 }] }] }),
                geojson: null,
                sort_order: 0,
                version: 1,
            })
            .execute();
        expect((await buildBundle(deps, { siteId: SITE_ID, outDir: tmp('stage') })).analysisDem).toBe('mosaic');
        expect(args.length).toBe(3);
    });

    test('a pipeline failure falls back to the full DEM with a warning, and does not poison the cache', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await registerDem(db, dataDir, `sources/${SITE_ID}/dem.tif`);
        const failing = recordingRunner({ fail: true });

        const { stagingDir, analysisDem, warnings } = await buildBundle(
            { db, dataDir, runner: failing.runner },
            { siteId: SITE_ID, outDir: tmp('stage') },
        );

        expect(analysisDem).toBe('full');
        expect(shippedDem(stagingDir)).toBe('FULL-DEM');
        expect(warnings.join(' ')).toMatch(/dem-analysis failed \(exit 1\)/);
        expect(existsSync(path.join(dataDir, 'sources', SITE_ID, 'dem-analysis.tif'))).toBe(false);

        // The next publish must try again rather than trusting a half-state.
        const ok = recordingRunner();
        const retry = await buildBundle({ db, dataDir, runner: ok.runner }, { siteId: SITE_ID, outDir: tmp('stage') });
        expect(retry.analysisDem).toBe('mosaic');
    });

    test('no dem_cog asset ships no DEM and warns', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const { runner } = recordingRunner();
        const { stagingDir, analysisDem, warnings } = await buildBundle(
            { db, dataDir, runner },
            { siteId: SITE_ID, outDir: tmp('stage') },
        );
        expect(analysisDem).toBe('none');
        expect(existsSync(path.join(stagingDir, 'dem'))).toBe(false);
        expect(warnings.join(' ')).toMatch(/green reading unavailable/);
    });

    test('--full-dem parses', () => {
        expect(parseArgs(['site-1', '--full-dem']).fullDem).toBe(true);
        expect(parseArgs(['site-1']).fullDem).toBe(false);
    });
});
