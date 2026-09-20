import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readdir } from 'node:fs/promises';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { AssetsService } from './assets.service';
import {
    GsproExportService, defaultExportDir, exportFileName, orthoExportFileName, parseOrthoSourceName,
    outerOrthoExportFileName, demExportFileName, demSidecarName, hillshadeExportFileName, outerOrthoSourceName,
    terrainTextureFileName, TERRAIN_TEXTURE_DARKEN, meshTextureFileName, TERRAIN_TINT_OPACITY, treesExportFileName, OUTER_TREES_DIR, OUTER_TREES_RESOLUTION_M,
    ORTHO_EXPORT_SIZE, ORTHO_EXPORT_QUALITY, DEM_EXPORT_RESOLUTION_M, OUTER_DEM_SOURCE, OUTER_LIDAR_DIR, type ExportRunner,
    buildingsExportFileName, BUILDINGS_SURVEY_SOURCE, OUTER_DEM_EDITED_SOURCE, describeRequest,
} from './gspro-export.service';
import { TerrainEditsService } from './terrain-edits.service';
import { innerSquareFrom3006, outerSquareFor, squareArg, terrainManifestField, toSquareBox, OUTER_TERRAIN_SIDE_M } from './terrain-square';
import { NotFoundError, ConflictError } from '@basics/core/server/auth';

/**
 * The real exporter is pinned by pipeline/tests/test_gspro_svg.py; here the
 * runner is the seam (same shape as MapBuildService's) so these tests cover
 * what the SERVER decides: where the file goes, which bbox, and how failures
 * surface — without needing a Python venv on the box running `bun test`.
 */
function recordingRunner(result: Partial<{ code: number; stdout: string; stderr: string }> = {}) {
    const calls: { args: string[]; cwd: string }[] = [];
    const runner: ExportRunner = async (args, cwd) => {
        calls.push({ args, cwd });
        // golfpipe fetches write their --out (or a .laz into --out-dir) so
        // the export finds the source; grid-dem writes its --out.
        if (args[1] === 'golfpipe' && (args[2].startsWith('fetch-') || args[2] === 'grid-dem' || args[2] === 'trees-stems')) {
            if (result.code) return { code: result.code, stdout: '', stderr: result.stderr ?? '' };
            if (args[2] === 'fetch-lidar') {
                const dir = args[args.indexOf('--out-dir') + 1];
                await mkdir(dir, { recursive: true });
                await writeFile(path.join(dir, 'item_648_52.copc.laz'), 'fake lidar');
                return { code: 0, stdout: 'downloaded 1 item(s)\n', stderr: '' };
            }
            const out = args[args.indexOf('--out') + 1];
            await mkdir(path.dirname(out), { recursive: true });
            await writeFile(out, `fake ${args[2]}`);
            if (args[2] === 'trees-stems') {  // writes the compact asset next to the GeoJSON, in --tiles-dir
                await writeFile(path.join(args[args.indexOf('--tiles-dir') + 1], 'tree-stems.json'), '{"trees":[]}');
            }
            return { code: 0, stdout: `${args[2]} done\n`, stderr: '' };
        }
        return { code: result.code ?? 0, stdout: result.stdout ?? 'Wrote out.svg\n  200 features\n', stderr: result.stderr ?? '' };
    };
    return { calls, runner };
}

/** A georeferenced course: the bbox authority chain reads this first. */
const GEOREF_BBOX: [number, number, number, number] = [529028, 6486667, 531082, 6488721];
const GEOREF = JSON.stringify({ bbox: GEOREF_BBOX });
/** …which the exports square and snap to the 10 m step: 2054 m -> 2050 m. */
const GEOREF_INNER = innerSquareFrom3006(GEOREF_BBOX);

async function setup(runner: ExportRunner, opts: { georeference?: boolean } = {}) {
    const ctx = await createTestDb(seedCourse);
    if (opts.georeference !== false) {
        await ctx.db.updateTable('courses').set({ georeference_json: GEOREF })
            .where('id', '=', TEST_COURSE_ID).execute();
    }
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-data-'));
    const courses = new CoursesService(ctx.db);
    const assets = new AssetsService(ctx.db, dataDir);
    const svc = new GsproExportService({
        db: ctx.db, courses, assets, dataDir,
        pipelineDir: '/pipeline', runner,
    });
    return { ctx, svc, db: ctx.db, dataDir, assets };
}

const SITE_ID = 'site-gspro';

/**
 * A built site: the course points at it, and `sources/<siteId>/` holds the
 * ortho GeoTIFFs the map build persists (empty stand-ins — the runner is
 * recorded, not run). The tile manifest names the vintage the map shows.
 */
async function buildSite(
    t: Awaited<ReturnType<typeof setup>>,
    sources: string[],
    active = 'orto-l2-2025',
    manifest: Record<string, unknown> = {},
) {
    await t.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await t.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    const dir = path.join(t.dataDir, 'sources', SITE_ID);
    await mkdir(dir, { recursive: true });
    for (const name of sources) await writeFile(path.join(dir, name), '');
    await t.assets.register({
        siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
        filename: `tiles/${SITE_ID}/manifest.json`,
        metaJson: JSON.stringify({ activeOrtho: active, ...manifest }),
    });
    return dir;
}

/** The exact inner square a build persisted (side 2010 m), and its WGS84 bounds. */
const BUILT_INNER: [number, number, number, number] = [529030, 6486670, 531040, 6488680];
const BUILT_MANIFEST = {
    bounds: { west: 15.49, south: 58.51, east: 15.53, north: 58.53 },
    terrain: terrainManifestField(BUILT_INNER),
};

function bboxArgOf(b: { west: number; south: number; east: number; north: number }): string {
    return [b.west, b.south, b.east, b.north].join(',');
}

function flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
}

// --- Settings ---

test('a course with no folder set reports the server default', async () => {
    const { svc } = await setup(recordingRunner().runner);
    const s = await svc.settings(TEST_COURSE_ID);
    expect(s.isDefault).toBe(true);
    expect(s.dir).toBe(defaultExportDir());
    expect(s.defaultDir).toBe(defaultExportDir());
});

test('the default folder is Downloads under the home directory', () => {
    const prev = process.env.GSPRO_EXPORT_DIR;
    delete process.env.GSPRO_EXPORT_DIR;
    try {
        expect(defaultExportDir()).toBe(path.join(os.homedir(), 'Downloads'));
    } finally {
        if (prev !== undefined) process.env.GSPRO_EXPORT_DIR = prev;
    }
});

test('setDir stores an absolute path and survives a read back', async () => {
    const { svc } = await setup(recordingRunner().runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));

    const after = await svc.setDir(TEST_COURSE_ID, dir);
    expect(after.dir).toBe(dir);
    expect(after.isDefault).toBe(false);
    expect(after.defaultDir).toBe(defaultExportDir());
    expect((await svc.settings(TEST_COURSE_ID)).dir).toBe(dir);
});

test('a relative folder is resolved before it is stored', async () => {
    const { svc } = await setup(recordingRunner().runner);
    const s = await svc.setDir(TEST_COURSE_ID, 'exports/gspro');
    expect(path.isAbsolute(s.dir)).toBe(true);
    expect(s.dir).toBe(path.resolve('exports/gspro'));
});

test('clearing the folder falls back to the default', async () => {
    const { svc } = await setup(recordingRunner().runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await svc.setDir(TEST_COURSE_ID, dir);

    for (const cleared of [null, '', '   ']) {
        await svc.setDir(TEST_COURSE_ID, dir);
        const s = await svc.setDir(TEST_COURSE_ID, cleared);
        expect(s.isDefault).toBe(true);
        expect(s.dir).toBe(defaultExportDir());
    }
});

test('pointing the folder at an existing file is refused', async () => {
    const { svc } = await setup(recordingRunner().runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const file = path.join(dir, 'not-a-folder.txt');
    await writeFile(file, 'x');
    expect(svc.setDir(TEST_COURSE_ID, file)).rejects.toThrow(ConflictError);
});

test('settings and setDir 404 for an unknown course', async () => {
    const { svc } = await setup(recordingRunner().runner);
    expect(svc.settings('nope')).rejects.toThrow(NotFoundError);
    expect(svc.setDir('nope', null)).rejects.toThrow(NotFoundError);
});

// --- Export ---

test('export writes into the course folder, named after the course', async () => {
    const { calls, runner } = recordingRunner();
    const { svc } = await setup(runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await svc.setDir(TEST_COURSE_ID, dir);

    const res = await svc.export(TEST_COURSE_ID);

    expect(res.path).toBe(path.join(dir, 'linkan.svg'));  // seed course is 'Linkan'
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[0]).toBe(path.join('/pipeline', 'gspro.py'));
    expect(args[1]).toBe('svg');
    expect(args[args.indexOf('--out') + 1]).toBe(res.path);
    expect(args[args.indexOf('--course') + 1]).toBe(TEST_COURSE_ID);
});

test('export creates the folder if it does not exist yet', async () => {
    const { svc } = await setup(recordingRunner().runner);
    const parent = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const dir = path.join(parent, 'nested', 'gspro');
    await svc.setDir(TEST_COURSE_ID, dir);

    await svc.export(TEST_COURSE_ID);
    expect(await readdir(parent)).toContain('nested');
});

test('export renders over the inner terrain square: the map area squared and snapped to 10 m', async () => {
    const { calls, runner } = recordingRunner();
    const { svc } = await setup(runner);
    await svc.export(TEST_COURSE_ID);

    const args = calls[0].args;
    expect(args).not.toContain('--bbox');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    // The georeference is a 2054 m box; the inner terrain is 2050 m, centred, whole metres.
    expect(flag(args, '--square-3006')).toBe('529030,6486669,531080,6488719');
});

test('a built site exports over the exact square its DEM was cut to', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    await buildSite(t, ['ortho-orto-l2-2025.tif'], 'orto-l2-2025', BUILT_MANIFEST);

    await t.svc.export(TEST_COURSE_ID);
    expect(flag(calls[0].args, '--square-3006')).toBe(squareArg(BUILT_INNER));
});

test('a site built before terrains were snapped gets its bounds squared and snapped', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    await buildSite(t, ['ortho-orto-l2-2025.tif'], 'orto-l2-2025', { bounds: BUILT_MANIFEST.bounds });

    await t.svc.export(TEST_COURSE_ID);
    const [x0, y0, x1, y1] = flag(calls[0].args, '--square-3006')!.split(',').map(Number);
    expect(x1 - x0).toBe(y1 - y0);
    expect((x1 - x0) % 10).toBe(0);
    for (const v of [x0, y0, x1, y1]) expect(Number.isInteger(v)).toBe(true);
});

// --- Terrain ---

test('terrain describes the inner square and the 5 km outer square centred on it', async () => {
    const { svc } = await setup(recordingRunner().runner);
    const t = await svc.terrain(TEST_COURSE_ID);
    expect(t.inner.square).toEqual(toSquareBox(GEOREF_INNER));
    expect(t.inner.sideM).toBe(2050);
    expect(t.outer.square).toEqual(toSquareBox(outerSquareFor(GEOREF_INNER)));
    expect(t.outer.sideM).toBe(OUTER_TERRAIN_SIDE_M);
    expect(t.outer.centre).toEqual(t.inner.centre);
    expect(t.outer.wgs84.west).toBeLessThan(t.inner.wgs84.west);
    expect(t.inner.wgs84.west).toBeCloseTo(15.49, 1);
});

test('terrain for a course with no map area explains itself', async () => {
    const { svc } = await setup(recordingRunner().runner, { georeference: false });
    expect(svc.terrain(TEST_COURSE_ID)).rejects.toThrow(/GSPro terrains/);
});

test('trees are exported as pine straw, the only OPCD surface that fits them', async () => {
    const { calls, runner } = recordingRunner();
    const { svc } = await setup(runner);
    await svc.export(TEST_COURSE_ID);
    expect(calls[0].args).toContain('--map');
    expect(calls[0].args).toContain('trees=pinestraw');
});

test('a course with no map area explains itself instead of exporting', async () => {
    const { svc } = await setup(recordingRunner().runner, { georeference: false });
    expect(svc.export(TEST_COURSE_ID)).rejects.toThrow(/GSPro SVG/i);
});

test('a failing exporter surfaces its own last words', async () => {
    const { runner } = recordingRunner({ code: 2, stderr: 'error: no course matching\nKnown courses: Vreta' });
    const { svc } = await setup(runner);
    expect(svc.export(TEST_COURSE_ID)).rejects.toThrow(/Known courses: Vreta/);
});

test('the exporter report comes back for the operator to read', async () => {
    const { runner } = recordingRunner({ stdout: 'Wrote x.svg\n  200 features in 19 layer(s)\n  warning: 5 outside\n' });
    const { svc } = await setup(runner);
    const res = await svc.export(TEST_COURSE_ID);
    expect(res.report).toEqual(['Wrote x.svg', '200 features in 19 layer(s)', 'warning: 5 outside']);
});

// --- Orthophoto sources ---

test('a course that has never been built here has no orthophotos to export', async () => {
    const { svc } = await setup(recordingRunner().runner);
    expect(await svc.orthoSources(TEST_COURSE_ID)).toEqual([]);
});

test('a built site with no sources folder yet also lists nothing', async () => {
    const t = await setup(recordingRunner().runner);
    await t.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await t.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    expect(await t.svc.orthoSources(TEST_COURSE_ID)).toEqual([]);
});

test('the persisted ortho GeoTIFFs are listed newest first, patched copies after their original', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t, [
        'ortho-orto-l2-2023.tif', 'dem.tif', 'ortho-orto-l2-2025.patched.tif',
        'ortho-orto-l2-2025.tif', 'trees.geojson', 'dem-edited.tif',
    ]);

    const sources = await t.svc.orthoSources(TEST_COURSE_ID);
    expect(sources).toEqual([
        { source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', patched: false, active: true },
        { source: 'ortho-orto-l2-2025.patched.tif', collection: 'orto-l2-2025', patched: true, active: true },
        { source: 'ortho-orto-l2-2023.tif', collection: 'orto-l2-2023', patched: false, active: false },
    ]);
});

test('parseOrthoSourceName reads the collection and the patched flag', () => {
    expect(parseOrthoSourceName('ortho-orto-l2-2025.tif')).toEqual({ collection: 'orto-l2-2025', patched: false });
    expect(parseOrthoSourceName('ortho-orto-i2-2023.patched.tif')).toEqual({ collection: 'orto-i2-2023', patched: true });
    expect(parseOrthoSourceName('dem.tif')).toBeNull();
    expect(parseOrthoSourceName('ortho-orto-l2-2025.tif.bak')).toBeNull();
});

// --- Orthophoto export ---

test('exportOrtho renders the chosen source as an 8192px quality-92 JPEG over the course square', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'rendering ortho-orto-l2-2025.tif\n  wrote x.jpg\n\nDone (from local sources).\n' });
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['ortho-orto-l2-2023.tif', 'ortho-orto-l2-2025.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    const res = await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif');

    expect(res.path).toBe(path.join(dir, 'linkan-orto-l2-2025-8192.jpg'));
    expect(res.report).toEqual(['rendering ortho-orto-l2-2025.tif', 'wrote x.jpg', 'Done (from local sources).']);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[0]).toBe(path.join('/pipeline', 'gspro.py'));
    expect(args[1]).toBe('ortho');
    expect(args[args.indexOf('--ortho') + 1]).toBe(path.join(sourcesDir, 'ortho-orto-l2-2025.tif'));
    expect(args[args.indexOf('--out') + 1]).toBe(res.path);
    expect(args[args.indexOf('--size') + 1]).toBe('8192');
    expect(args[args.indexOf('--quality') + 1]).toBe('92');
    expect(ORTHO_EXPORT_QUALITY).toBe(92);
    expect(ORTHO_EXPORT_SIZE).toBe(8192);
    // The darkened twin for the Unity terrain rides along in the same render, in linear light.
    expect(flag(args, '--terrain-out')).toBe(path.join(dir, 'linkan-orto-l2-2025-8192-terrain.jpg'));
    expect(flag(args, '--darken')).toBe(String(TERRAIN_TEXTURE_DARKEN));
    expect(flag(args, '--darken-space')).toBe('linear');
    expect(TERRAIN_TEXTURE_DARKEN).toBeGreaterThan(0);
    expect(TERRAIN_TEXTURE_DARKEN).toBeLessThan(1);

    // A caller's own factor is passed through; nonsense is refused before the pipeline runs.
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', 0.6);
    expect(flag(calls[1].args, '--darken')).toBe('0.6');
    await expect(t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', 0)).rejects.toBeInstanceOf(ConflictError);
    await expect(t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', 1.5)).rejects.toBeInstanceOf(ConflictError);
    expect(calls).toHaveLength(2);

    // The surface tint is opt-in: a third file next to the twin, masked by the
    // course's own features (the pipeline reads them by course id), at the
    // default opacity or the caller's; nonsense is refused before the run.
    expect(args).not.toContain('--tint-out');
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, {});
    const tinted = calls[2].args;
    expect(flag(tinted, '--tint-out')).toBe(path.join(dir, 'linkan-orto-l2-2025-8192-meshes.jpg'));
    expect(flag(tinted, '--tint-course')).toBe(TEST_COURSE_ID);
    expect(flag(tinted, '--tint-opacity')).toBe(String(TERRAIN_TINT_OPACITY));
    expect(flag(tinted, '--terrain-out')).toBe(path.join(dir, 'linkan-orto-l2-2025-8192-terrain.jpg'));
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, { opacity: 0.2 });
    expect(flag(calls[3].args, '--tint-opacity')).toBe('0.2');
    await expect(t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, { opacity: 2 })).rejects.toBeInstanceOf(ConflictError);
    expect(calls).toHaveLength(4);
    // Same square as the SVG export, so the two overlay in GSPro.
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
});

test('a patched source is named so it cannot be mistaken for the pristine one', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.patched.tif']);
    const res = await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.patched.tif');
    expect(path.basename(res.path)).toBe('linkan-orto-l2-2025-patched-8192.jpg');
    expect(calls[0].args[calls[0].args.indexOf('--ortho') + 1]).toEndWith('ortho-orto-l2-2025.patched.tif');
});

test('exportOrtho refuses a source that is not one of the listed files', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['ortho-orto-l2-2025.tif']);
    for (const bad of ['ortho-orto-l2-2019.tif', '../../app.sqlite', 'dem.tif', '']) {
        expect(t.svc.exportOrtho(TEST_COURSE_ID, bad)).rejects.toThrow(NotFoundError);
    }
    expect(calls).toHaveLength(0);
});

test('exportOrtho on a never-built course explains that the map must be built first', async () => {
    const { svc } = await setup(recordingRunner().runner);
    expect(svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif')).rejects.toThrow(/build its map first/);
});

test('a failing ortho render surfaces the pipeline error', async () => {
    const { runner } = recordingRunner({ code: 1, stderr: 'rasterio.errors.RasterioIOError: not a TIFF' });
    const t = await setup(runner);
    await buildSite(t, ['ortho-orto-l2-2025.tif']);
    expect(t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif'))
        .rejects.toThrow(/GSPro orthophoto export failed: .*not a TIFF/);
});

// --- Outer orthophoto ---

test('the outer orthophoto is fetched for the outer square once, kept with the site, then rendered', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'rendering outer-ortho-orto-l2-2025.tif\n  wrote x.jpg\n' });
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['ortho-orto-l2-2025.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    const outer = outerSquareFor(GEOREF_INNER);

    const res = await t.svc.exportOuterOrtho(TEST_COURSE_ID, 'orto-l2-2025');

    expect(res.path).toBe(path.join(dir, 'linkan-outer-orto-l2-2025-8192.jpg'));
    expect(calls).toHaveLength(2);
    // 1. golfpipe fetch-ortho over the OUTER square's WGS84 envelope, into sources/<site>/.
    const fetch = calls[0].args;
    expect(fetch.slice(0, 3)).toEqual(['-m', 'golfpipe', 'fetch-ortho']);
    expect(flag(fetch, '--collection')).toBe('orto-l2-2025');
    expect(flag(fetch, '--out')).toBe(path.join(sourcesDir, outerOrthoSourceName('orto-l2-2025')));
    expect(flag(fetch, '--workdir')).toBeTruthy();
    const [west, south, east, north] = flag(fetch, '--bbox')!.split(',').map(Number);
    const inner = (await t.svc.terrain(TEST_COURSE_ID)).inner.wgs84;
    expect(west).toBeLessThan(inner.west);
    expect(south).toBeLessThan(inner.south);
    expect(east).toBeGreaterThan(inner.east);
    expect(north).toBeGreaterThan(inner.north);
    // 2. gspro.py ortho from that copy over the outer square.
    const render = calls[1].args;
    expect(render[1]).toBe('ortho');
    expect(flag(render, '--square-3006')).toBe(squareArg(outer));
    expect(flag(render, '--ortho')).toBe(flag(fetch, '--out'));
    expect(flag(render, '--size')).toBe('8192');
    expect(res.report[0]).toBe('fetched outer-ortho-orto-l2-2025.tif');
    expect(res.report).toContain('wrote x.jpg');

    // The fetched copy is reused: a second export only renders.
    await t.svc.exportOuterOrtho(TEST_COURSE_ID, 'orto-l2-2025');
    expect(calls).toHaveLength(3);
    expect(calls[2].args[1]).toBe('ortho');
    expect(await readdir(sourcesDir)).toContain('outer-ortho-orto-l2-2025.tif');
});

test('the outer sources do not show up in the inner vintage list', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t, ['ortho-orto-l2-2025.tif', 'outer-ortho-orto-l2-2025.tif', OUTER_DEM_SOURCE]);
    expect((await t.svc.orthoSources(TEST_COURSE_ID)).map(s => s.source)).toEqual(['ortho-orto-l2-2025.tif']);
});

test('exportOuterOrtho refuses a collection that is not a collection id', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['ortho-orto-l2-2025.tif']);
    for (const bad of ['../x', 'orto l2', '', '.hidden']) {
        expect(t.svc.exportOuterOrtho(TEST_COURSE_ID, bad)).rejects.toThrow(ConflictError);
    }
    expect(calls).toHaveLength(0);
});

test('exportOuterOrtho on a never-built course explains that the map must be built first', async () => {
    const { svc } = await setup(recordingRunner().runner);
    expect(svc.exportOuterOrtho(TEST_COURSE_ID, 'orto-l2-2025')).rejects.toThrow(/build its map first/);
});

test('a failing outer fetch surfaces the pipeline error and leaves no half source', async () => {
    const { runner } = recordingRunner({ code: 1, stderr: 'No orthophoto items found' });
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['ortho-orto-l2-2025.tif']);
    expect(t.svc.exportOuterOrtho(TEST_COURSE_ID, 'orto-l2-2025'))
        .rejects.toThrow(/GSPro outer orthophoto fetch failed: .*No orthophoto items/);
    expect(await readdir(sourcesDir)).not.toContain('outer-ortho-orto-l2-2025.tif');
});

// --- DEM ---

test('the inner DEM export clips the build DEM to the inner square at 0.5 m, with the side in the name', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'Wrote x.tif  (4100x4100)\nWrote x.tif.json\n' });
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    const res = await t.svc.exportDem(TEST_COURSE_ID, 'inner');

    expect(res.path).toBe(path.join(dir, 'linkan-inner-dem-2050m.tif'));
    expect(res.report).toEqual(['Wrote x.tif  (4100x4100)', 'Wrote x.tif.json']);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[0]).toBe(path.join('/pipeline', 'gspro.py'));
    expect(args[1]).toBe('dem');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--dem')).toBe(path.join(sourcesDir, 'dem.tif'));
    expect(flag(args, '--out')).toBe(res.path);
    expect(flag(args, '--resolution')).toBe('0.5');
    expect(flag(args, '--terrain')).toBe('inner');
    expect(args).not.toContain('--inner-sidecar');
    expect(DEM_EXPORT_RESOLUTION_M).toEqual({ inner: 0.5, outer: 1 });
});

test('the outer DEM export hands the pipeline the inner sidecar when it is in the folder, for the Unity position', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['dem.tif', OUTER_DEM_SOURCE]);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    // Outer first: no inner sidecar yet, so the report says to export the inner.
    const first = await t.svc.exportDem(TEST_COURSE_ID, 'outer');
    expect(flag(calls[0].args, '--terrain')).toBe('outer');
    expect(calls[0].args).not.toContain('--inner-sidecar');
    expect(first.report.at(-1)).toMatch(/export the inner DEM first/);

    // With the inner's sidecar there (side 2050 m for the georeferenced course), it is passed.
    const innerSidecar = path.join(dir, demSidecarName(demExportFileName('Linkan', 'inner', 2050)));
    expect(path.basename(innerSidecar)).toBe('linkan-inner-dem-2050m.tif.json');
    await writeFile(innerSidecar, '{}');
    const second = await t.svc.exportDem(TEST_COURSE_ID, 'outer');
    expect(flag(calls[1].args, '--inner-sidecar')).toBe(innerSidecar);
    expect(second.report.join('\n')).not.toMatch(/export the inner DEM first/);
});

test('the outer DEM export replays the site\'s enabled terrain edits onto the outer DEM first', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const srcDir = await buildSite(t, ['dem.tif', OUTER_DEM_SOURCE]);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    // No enabled edits: the raw outer DEM is the source, no replay call.
    const edits = new TerrainEditsService(t.db);
    const off = await edits.create({ siteId: SITE_ID, op: 'plane', params: { featherM: 2, flat: true }, enabled: false,
        rings: [[{ x: 530000, y: 6487000 }, { x: 530010, y: 6487000 }, { x: 530010, y: 6487010 }]] });
    const command = (c: { args: string[] }) => (c.args[1] === 'golfpipe' ? c.args[2] : c.args[1]);
    await t.svc.exportDem(TEST_COURSE_ID, 'outer');
    expect(calls.map(command)).toEqual(['dem']);
    expect(flag(calls[0].args, '--dem')).toBe(path.join(srcDir, OUTER_DEM_SOURCE));

    // An enabled one (a generated pad, say): apply-dem-edits onto the outer
    // DEM, and the export renders from the edited copy.
    await edits.update(off.id, off.version, { enabled: true });
    calls.length = 0;
    const result = await t.svc.exportDem(TEST_COURSE_ID, 'outer');
    expect(calls.map(command)).toEqual(['apply-dem-edits', 'dem']);
    expect(flag(calls[0].args, '--input')).toBe(path.join(srcDir, OUTER_DEM_SOURCE));
    expect(flag(calls[0].args, '--out')).toBe(path.join(srcDir, OUTER_DEM_EDITED_SOURCE));
    expect(flag(calls[0].args, '--edits')).toMatch(/terrain-edits\.geojson$/);
    expect(flag(calls[1].args, '--dem')).toBe(path.join(srcDir, OUTER_DEM_EDITED_SOURCE));
    expect(result.report).toContain('replayed 1 terrain edit(s) onto the outer DEM');
});

test('the buildings export needs the heightmap sidecar and the survey, then writes unity-buildings over the square', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    const srcDir = await buildSite(t, ['dem.tif'], 'orto-l2-2025', BUILT_MANIFEST);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    await expect(t.svc.exportBuildings(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Export the inner heightmap first/);
    const sidecar = path.join(dir, demSidecarName(demExportFileName('Linkan', 'inner', 2010)));
    await writeFile(sidecar, '{}');
    await expect(t.svc.exportBuildings(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Generate building pads/);
    await writeFile(path.join(srcDir, BUILDINGS_SURVEY_SOURCE), '{}');

    const result = await t.svc.exportBuildings(TEST_COURSE_ID, 'inner');
    expect(result.path).toBe(path.join(dir, buildingsExportFileName('Linkan', 'inner')));
    expect(path.basename(result.path)).toBe('linkan-inner-buildings.json');
    const args = calls.at(-1)!.args;
    expect(args[1]).toBe('buildings');
    expect(flag(args, '--square-3006')).toBe(squareArg(BUILT_INNER));
    expect(flag(args, '--survey')).toBe(path.join(srcDir, BUILDINGS_SURVEY_SOURCE));
    expect(flag(args, '--sidecar')).toBe(sidecar);
    expect(flag(args, '--terrain')).toBe('inner');
    expect(args).not.toContain('--exclude-square');

    // The outer leaves the inner square out, like the trees.
    await writeFile(path.join(dir, demSidecarName(demExportFileName('Linkan', 'outer', OUTER_TERRAIN_SIDE_M))), '{}');
    await t.svc.exportBuildings(TEST_COURSE_ID, 'outer');
    const outerArgs = calls.at(-1)!.args;
    expect(flag(outerArgs, '--terrain')).toBe('outer');
    expect(flag(outerArgs, '--exclude-square')).toBe(squareArg(BUILT_INNER));
    expect(describeRequest({ kind: 'buildings', terrain: 'outer' })).toBe('outer buildings');
    expect(() => describeRequest({ kind: 'buildings' })).toThrow(ConflictError);
});

test('the hillshade export renders the terrain\'s DEM as an 8192 px JPEG over its square', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'Wrote x.jpg  (8192×8192)\n' });
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif', 'dem-edited.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    const res = await t.svc.exportHillshade(TEST_COURSE_ID, 'inner');

    expect(res.path).toBe(path.join(dir, 'linkan-inner-hillshade-8192.jpg'));
    expect(res.report).toEqual(['Wrote x.jpg  (8192×8192)']);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[0]).toBe(path.join('/pipeline', 'gspro.py'));
    expect(args[1]).toBe('hillshade');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--dem')).toBe(path.join(sourcesDir, 'dem-edited.tif'));  // same DEM rule as the DEM export
    expect(flag(args, '--out')).toBe(res.path);
    expect(flag(args, '--size')).toBe(String(ORTHO_EXPORT_SIZE));
});

test('the outer hillshade grids the outer DEM first, like the outer DEM export', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif']);

    const res = await t.svc.exportHillshade(TEST_COURSE_ID, 'outer');

    expect(path.basename(res.path)).toBe('linkan-outer-hillshade-8192.jpg');
    expect(calls.map(c => (c.args[1] === 'golfpipe' ? c.args[2] : c.args[1]))).toEqual(['fetch-lidar', 'grid-dem', 'hillshade']);
    expect(flag(calls[2].args, '--dem')).toBe(path.join(sourcesDir, OUTER_DEM_SOURCE));
    expect(flag(calls[2].args, '--square-3006')).toBe(squareArg(outerSquareFor(GEOREF_INNER)));
    expect(res.report[0]).toBe('fetched 1 lidar tile(s) for the outer square');
});

test('a hillshade export on a never-built course explains that the map must be built first', async () => {
    const { runner } = recordingRunner();
    const t = await setup(runner);
    await expect(t.svc.exportHillshade(TEST_COURSE_ID, 'inner')).rejects.toBeInstanceOf(NotFoundError);
});

test('the inner DEM export prefers the edited DEM, so it shows what the map shows', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif', 'dem-edited.tif']);
    await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(flag(calls[0].args, '--dem')).toBe(path.join(sourcesDir, 'dem-edited.tif'));
});

test('the outer DEM is gridded from Laserdata Skog lidar over the outer square once, then clipped at 1 m', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif']);
    const outer = outerSquareFor(GEOREF_INNER);
    const outerLidar = path.join(sourcesDir, OUTER_LIDAR_DIR);

    const res = await t.svc.exportDem(TEST_COURSE_ID, 'outer');

    expect(path.basename(res.path)).toBe(`linkan-outer-dem-${OUTER_TERRAIN_SIDE_M}m.tif`);
    expect(calls).toHaveLength(3);
    // 1. the lidar tiles for the OUTER square's WGS84 envelope, kept next to the build's lidar/.
    const fetch = calls[0].args;
    expect(fetch.slice(0, 3)).toEqual(['-m', 'golfpipe', 'fetch-lidar']);
    expect(flag(fetch, '--out-dir')).toBe(outerLidar);
    expect(flag(fetch, '--bbox')).toBe(bboxArgOf((await t.svc.terrain(TEST_COURSE_ID)).outer.wgs84));
    expect(fetch).not.toContain('fetch-dem');
    expect(fetch).toContain('--skip-forbidden');  // a withheld tile (403) must not sink the scenery
    // 2. grid-dem over the exact outer square at 1 m, same route as the build's inner DEM.
    const grid = calls[1].args;
    expect(grid.slice(0, 3)).toEqual(['-m', 'golfpipe', 'grid-dem']);
    expect(grid[grid.indexOf('--lidar') + 1]).toBe(path.join(outerLidar, 'item_648_52.copc.laz'));
    expect(flag(grid, '--bbox-3006')).toBe(squareArg(outer));
    expect(flag(grid, '--resolution')).toBe('1');
    expect(flag(grid, '--out')).toBe(path.join(sourcesDir, OUTER_DEM_SOURCE));
    // 3. gspro.py dem clips that DEM to the square.
    const clip = calls[2].args;
    expect(clip[1]).toBe('dem');
    expect(flag(clip, '--square-3006')).toBe(squareArg(outer));
    expect(flag(clip, '--dem')).toBe(path.join(sourcesDir, OUTER_DEM_SOURCE));
    expect(flag(clip, '--resolution')).toBe('1');
    expect(res.report[0]).toBe('fetched 1 lidar tile(s) for the outer square');
    expect(res.report).toContain(`gridded ${OUTER_DEM_SOURCE}`);

    await t.svc.exportDem(TEST_COURSE_ID, 'outer');
    expect(calls).toHaveLength(4);  // no second fetch or gridding
});

test('the build\'s own lidar tiles are linked into the outer set so they are not downloaded twice', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif']);
    await mkdir(path.join(sourcesDir, 'lidar'), { recursive: true });
    await writeFile(path.join(sourcesDir, 'lidar', 'item_647_52.copc.laz'), 'inner tile');
    await writeFile(path.join(sourcesDir, 'lidar', 'notes.txt'), 'not lidar');

    await t.svc.exportDem(TEST_COURSE_ID, 'outer');

    const outerLidar = path.join(sourcesDir, OUTER_LIDAR_DIR);
    expect((await readdir(outerLidar)).sort()).toEqual(['item_647_52.copc.laz', 'item_648_52.copc.laz']);
    expect(await Bun.file(path.join(outerLidar, 'item_647_52.copc.laz')).text()).toBe('inner tile');
    const grid = calls[1].args;
    const lidarArgs = grid.slice(grid.indexOf('--lidar') + 1, grid.indexOf('--bbox-3006'));
    expect(lidarArgs).toEqual([
        path.join(outerLidar, 'item_647_52.copc.laz'), path.join(outerLidar, 'item_648_52.copc.laz'),
    ]);
});

test('a failing outer lidar fetch surfaces the pipeline error and leaves no outer DEM', async () => {
    const { runner } = recordingRunner({ code: 1, stderr: '403 Client Error: Forbidden' });
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif']);
    expect(t.svc.exportDem(TEST_COURSE_ID, 'outer')).rejects.toThrow(/GSPro outer lidar fetch failed: .*403/);
    expect(await readdir(sourcesDir)).not.toContain(OUTER_DEM_SOURCE);
});

test('a DEM export on a course with no persisted DEM explains that the map must be built first', async () => {
    const t = await setup(recordingRunner().runner);
    expect(t.svc.exportDem(TEST_COURSE_ID, 'inner')).rejects.toThrow(/build its map first/);
    await buildSite(t, ['ortho-orto-l2-2025.tif']);  // a site, but no dem.tif
    expect(t.svc.exportDem(TEST_COURSE_ID, 'inner')).rejects.toThrow(/build its map first/);
});

test('a failing DEM clip surfaces the pipeline error', async () => {
    const { runner } = recordingRunner({ code: 1, stderr: 'error: the 2050 m square is not a whole number of 0.3 m cells' });
    const t = await setup(runner);
    await buildSite(t, ['dem.tif']);
    expect(t.svc.exportDem(TEST_COURSE_ID, 'inner')).rejects.toThrow(/GSPro inner DEM export failed: .*whole number/);
});

// --- Naming ---

test('the inner trees export converts the installed tree-stems asset over the inner square', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'Wrote x.json\n  120 trees on the 2050 m inner square\n' });
    const t = await setup(runner);
    await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');

    // Heightmap first: the trees file takes its height range from the sidecar.
    await expect(t.svc.exportTrees(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Export the inner heightmap first/);
    await writeFile(sidecar, '{}');
    // …and the trees job must have run.
    await expect(t.svc.exportTrees(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Regenerate trees/);
    const stems = t.assets.resolveTreeStemsPath(SITE_ID);
    await mkdir(path.dirname(stems), { recursive: true });
    await writeFile(stems, '{"trees":[]}');

    const res = await t.svc.exportTrees(TEST_COURSE_ID, 'inner');

    expect(res.path).toBe(path.join(dir, 'linkan-inner-trees.json'));
    expect(res.report).toEqual(['Wrote x.json', '120 trees on the 2050 m inner square']);
    expect(calls).toHaveLength(1);
    const args = calls[0].args;
    expect(args[1]).toBe('trees');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--stems')).toBe(stems);
    expect(flag(args, '--sidecar')).toBe(sidecar);
    expect(flag(args, '--out')).toBe(res.path);
    expect(flag(args, '--terrain')).toBe('inner');
    expect(args).not.toContain('--exclude-square');
});

test('the outer trees are detected once from the outer lidar + DEM, then written without the inner square', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    const outer = outerSquareFor(GEOREF_INNER);
    await writeFile(path.join(dir, `linkan-outer-dem-${OUTER_TERRAIN_SIDE_M}m.tif.json`), '{}');

    const res = await t.svc.exportTrees(TEST_COURSE_ID, 'outer');

    expect(res.path).toBe(path.join(dir, 'linkan-outer-trees.json'));
    // lidar fetch + grid-dem (the outer DEM did not exist), then detection, then the conversion.
    const cmds = calls.map(c => (c.args[1] === 'golfpipe' ? c.args[2] : c.args[1]));
    expect(cmds).toEqual(['fetch-lidar', 'grid-dem', 'trees-stems', 'trees']);
    const detect = calls[2].args;
    const treesDir = path.join(sourcesDir, OUTER_TREES_DIR);
    expect(detect[detect.indexOf('--lidar') + 1]).toBe(path.join(sourcesDir, OUTER_LIDAR_DIR, 'item_648_52.copc.laz'));
    expect(flag(detect, '--dem')).toBe(path.join(sourcesDir, OUTER_DEM_SOURCE));
    expect(flag(detect, '--bbox')).toBe(squareArg(outer));
    expect(flag(detect, '--tiles-dir')).toBe(treesDir);
    expect(detect).toContain('--no-kind');
    expect(flag(detect, '--resolution')).toBe(String(OUTER_TREES_RESOLUTION_M));  // background trees: 2 m cells
    const conv = calls[3].args;
    expect(flag(conv, '--stems')).toBe(path.join(treesDir, 'tree-stems.json'));
    expect(flag(conv, '--square-3006')).toBe(squareArg(outer));
    expect(flag(conv, '--exclude-square')).toBe(squareArg(GEOREF_INNER));
    expect(flag(conv, '--terrain')).toBe('outer');
    expect(res.report).toContain(`detected outer tree stems into ${OUTER_TREES_DIR}/`);

    await t.svc.exportTrees(TEST_COURSE_ID, 'outer');
    expect(calls).toHaveLength(5);  // detection kept; only the conversion reruns
});

test('trees file names carry course and terrain', () => {
    expect(treesExportFileName('Vreta Kloster GK', 'inner')).toBe('vreta-kloster-gk-inner-trees.json');
    expect(treesExportFileName('Vreta', 'outer')).toBe('vreta-outer-trees.json');
});

// --- Jobs ---

test('start runs an export as a job the panel polls, one at a time per course', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const runner: ExportRunner = async () => { await gate; return { code: 0, stdout: 'Wrote out.svg\n  200 features\n', stderr: '' }; };
    const t = await setup(runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'svg' });
    expect(job.status).toBe('running');
    expect(job.label).toBe('course SVG');
    expect(job.result).toBeNull();
    expect(t.svc.job(job.id).status).toBe('running');
    expect(t.svc.current(TEST_COURSE_ID)?.id).toBe(job.id);
    // A second start while one runs is refused, naming the running job.
    await expect(t.svc.start(TEST_COURSE_ID, { kind: 'dem', terrain: 'inner' })).rejects.toThrow(/already running.*course SVG/);

    release();
    await t.svc.whenIdle(TEST_COURSE_ID);
    const done = t.svc.job(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.result?.path).toBe(path.join(dir, 'linkan.svg'));
    expect(done.result?.report).toEqual(['Wrote out.svg', '200 features']);
    expect(done.finishedAt).not.toBeNull();
    expect(t.svc.current(TEST_COURSE_ID)?.status).toBe('succeeded');
    // Returned jobs are snapshots: the caller cannot mutate the service's copy.
    done.status = 'running';
    expect(t.svc.job(job.id).status).toBe('succeeded');
});

test('a failing export ends its job as failed with the reason; the next start forgets it', async () => {
    const { runner } = recordingRunner({ code: 2, stderr: 'boom: no such vintage' });
    const t = await setup(runner);
    const failed = await t.svc.start(TEST_COURSE_ID, { kind: 'svg' });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(failed.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/boom: no such vintage/) });
    expect(t.svc.current(TEST_COURSE_ID)?.id).toBe(failed.id);

    const next = await t.svc.start(TEST_COURSE_ID, { kind: 'svg' });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.current(TEST_COURSE_ID)?.id).toBe(next.id);
    expect(() => t.svc.job(failed.id)).toThrow(NotFoundError);
});

test('start checks the request carries what its kind needs, and the course exists', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await expect(t.svc.start(TEST_COURSE_ID, { kind: 'ortho' })).rejects.toThrow(/needs a source/);
    await expect(t.svc.start(TEST_COURSE_ID, { kind: 'outer-ortho' })).rejects.toThrow(/needs a collection/);
    await expect(t.svc.start(TEST_COURSE_ID, { kind: 'trees' })).rejects.toThrow(/needs a terrain/);
    await expect(t.svc.start(TEST_COURSE_ID, { kind: 'bogus' as never })).rejects.toThrow(/Unknown export kind/);
    await expect(t.svc.start('nope', { kind: 'svg' })).rejects.toBeInstanceOf(NotFoundError);
    expect(calls).toHaveLength(0);
    expect(t.svc.current(TEST_COURSE_ID)).toBeNull();
    expect(() => t.svc.job('missing')).toThrow(NotFoundError);
});

test('a job carries the request through to the export it names', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['dem.tif', 'ortho-orto-l2-2025.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    const ortho = await t.svc.start(TEST_COURSE_ID, { kind: 'ortho', source: 'ortho-orto-l2-2025.tif', darken: 0.5, tint: true, tintOpacity: 0.4 });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(ortho.label).toBe('inner orthophoto');
    expect(t.svc.job(ortho.id).result?.path).toBe(path.join(dir, 'linkan-orto-l2-2025-8192.jpg'));
    expect(flag(calls[0].args, '--darken')).toBe('0.5');
    expect(flag(calls[0].args, '--tint-opacity')).toBe('0.4');
    expect(flag(calls[0].args, '--tint-course')).toBe(TEST_COURSE_ID);

    const dem = await t.svc.start(TEST_COURSE_ID, { kind: 'dem', terrain: 'outer' });
    expect(dem.label).toBe('outer heightmap');
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(dem.id).result?.path).toBe(path.join(dir, `linkan-outer-dem-${OUTER_TERRAIN_SIDE_M}m.tif`));
});

test('the terrain texture twins are named after their orthophoto', () => {
    expect(terrainTextureFileName('vreta-orto-l2-2025-8192.jpg')).toBe('vreta-orto-l2-2025-8192-terrain.jpg');
    expect(terrainTextureFileName('vreta-outer-orto-l2-2025-8192.JPG')).toBe('vreta-outer-orto-l2-2025-8192-terrain.jpg');
    expect(meshTextureFileName('vreta-orto-l2-2025-8192.jpg')).toBe('vreta-orto-l2-2025-8192-meshes.jpg');
});

test('hillshade file names carry course, terrain and size', () => {
    expect(hillshadeExportFileName('Vreta Kloster GK', 'inner')).toBe('vreta-kloster-gk-inner-hillshade-8192.jpg');
    expect(hillshadeExportFileName('Vreta', 'outer')).toBe('vreta-outer-hillshade-8192.jpg');
    expect(demSidecarName('vreta-inner-dem-2010m.tif')).toBe('vreta-inner-dem-2010m.tif.json');
});

test('outer and DEM file names carry course, terrain, vintage and side', () => {
    expect(outerOrthoExportFileName('Vreta', 'orto-l2-2025')).toBe('vreta-outer-orto-l2-2025-8192.jpg');
    expect(demExportFileName('Vreta', 'inner', 2010)).toBe('vreta-inner-dem-2010m.tif');
    expect(demExportFileName('Norrköping - Klinga', 'outer', 5000)).toBe('norrkoping-klinga-outer-dem-5000m.tif');
    expect(outerOrthoSourceName('orto-l2-2025')).toBe('outer-ortho-orto-l2-2025.tif');
});

test('the ortho file name carries course, vintage, patched flag and size', () => {
    const src = { source: 'x', collection: 'orto-l2-2025', patched: false, active: false };
    expect(orthoExportFileName('Vreta', src)).toBe('vreta-orto-l2-2025-8192.jpg');
    expect(orthoExportFileName('Norrköping - Klinga', { ...src, patched: true })).toBe('norrkoping-klinga-orto-l2-2025-patched-8192.jpg');
});

test('the file name is a slug of the course name', () => {
    expect(exportFileName('Vreta')).toBe('vreta.svg');
    expect(exportFileName('Landeryd Masters')).toBe('landeryd-masters.svg');
    expect(exportFileName('Norrköping - Klinga')).toBe('norrkoping-klinga.svg');
    expect(exportFileName('  A6 golfklubb ')).toBe('a6-golfklubb.svg');
    expect(exportFileName('///')).toBe('course.svg');
});
