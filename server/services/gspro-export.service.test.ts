import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readdir, readFile, utimes } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { AssetsService } from './assets.service';
import {
    GsproExportService, defaultExportDir, exportFileName, orthoExportFileName, parseOrthoSourceName,
    outerOrthoExportFileName, demExportFileName, demSidecarName, hillshadeExportFileName, outerOrthoSourceName,
    terrainTextureFileName, TERRAIN_TEXTURE_DARKEN, meshTextureFileName, TERRAIN_TINT_OPACITY, MESH_TEXTURE_SOFTEN_M, MESH_TEXTURE_SIZE, OUTER_TERRAIN_GRADE, treesExportFileName, OUTER_TREES_DIR, OUTER_TREES_RESOLUTION_M,
    ORTHO_EXPORT_SIZE, ORTHO_EXPORT_QUALITY, DEM_EXPORT_RESOLUTION_M, OUTER_DEM_SOURCE, OUTER_LIDAR_DIR, type ExportRunner,
    buildingsExportFileName, BUILDINGS_SURVEY_SOURCE, OUTER_DEM_EDITED_SOURCE, describeRequest, zonesExportFileName, creeksExportFileName,
} from './gspro-export.service';
import { TerrainEditsService } from './terrain-edits.service';
import { innerSquareFrom3006, outerSquareFor, squareArg, terrainManifestField, toSquareBox, OUTER_TERRAIN_SIDE_M } from './terrain-square';
import { defaultUnityBridge, type UnityBridge } from './unity-bridge';
import { NotFoundError, ConflictError } from '@basics/core/server/auth';
import { CourseFeaturesService } from './course-features.service';
import { generatorsFrom } from './vegetation-generators';

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

async function setup(runner: ExportRunner, opts: { georeference?: boolean; unityBridge?: UnityBridge } = {}) {
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
        pipelineDir: '/pipeline', runner, unityBridge: opts.unityBridge,
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

test('an SVG variant leaves the excluded features out, into its own file', async () => {
    // The ids go to the pipeline as a file (a variant can drop thousands of
    // canopy trees); read it while the pipeline "runs" — it is gone after.
    let passed: unknown = null;
    const runner: ExportRunner = async (args) => {
        passed = JSON.parse(await readFile(args[args.indexOf('--exclude-ids') + 1], 'utf-8'));
        return { code: 0, stdout: 'Wrote x.svg\n  excluded on request: 2 feature(s) - path 2\n', stderr: '' };
    };
    const { svc } = await setup(runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await svc.setDir(TEST_COURSE_ID, dir);

    const res = await svc.export(TEST_COURSE_ID, { excludeFeatureIds: ['a', 'b', 'a'], variant: 'No paths' });

    expect(res.path).toBe(path.join(dir, 'linkan-no-paths.svg'));
    expect(passed).toEqual(['a', 'b']);
    expect(res.report).toContain('excluded on request: 2 feature(s) - path 2');
});

test('a full SVG export is kept with the features it was made from; a variant is not', async () => {
    const runner: ExportRunner = async (args) => {
        await writeFile(args[args.indexOf('--out') + 1], '<svg/>');
        return { code: 0, stdout: 'Wrote out.svg\n', stderr: '' };
    };
    const { svc } = await setup(runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await svc.setDir(TEST_COURSE_ID, dir);

    const full = await svc.export(TEST_COURSE_ID);
    await svc.export(TEST_COURSE_ID, { variant: 'No paths', excludeFeatureIds: ['a'] });

    const kept = await readdir(path.join(dir, 'export-history'));
    expect(kept).toHaveLength(1);
    expect((await readdir(path.join(dir, 'export-history', kept[0]))).sort()).toEqual(['features.json', 'linkan.svg']);
    expect(full.report).toContain(`kept as ${path.join('export-history', kept[0])}`);
});

test('an SVG from a variant database reads its features from there and is not kept', async () => {
    const { calls, runner } = recordingRunner();
    const { svc } = await setup(runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await svc.setDir(TEST_COURSE_ID, dir);

    await svc.export(TEST_COURSE_ID, { variant: 'bisect 1', dbPath: '/tmp/variant.sqlite' });

    expect(flag(calls[0].args, '--db')).toBe('/tmp/variant.sqlite');
    expect(existsSync(path.join(dir, 'export-history'))).toBe(false);
});

test('an SVG export with nothing excluded passes no exclusion list', async () => {
    const { calls, runner } = recordingRunner();
    const { svc } = await setup(runner);
    await svc.setDir(TEST_COURSE_ID, await mkdtemp(path.join(os.tmpdir(), 'gspro-out-')));
    await svc.export(TEST_COURSE_ID, { excludeFeatureIds: [] });
    expect(calls[0].args).not.toContain('--exclude-ids');
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
    expect(res.report.slice(0, 3)).toEqual(['Wrote x.svg', '200 features in 19 layer(s)', 'warning: 5 outside']);
    expect(res.report[3]).toMatch(/^kept as export-history/);  // the full export's snapshot
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
    // The mesh texture is the soft one: photo at half strength, 1 m of detail, 8192 px (sharp paths).
    expect(TERRAIN_TINT_OPACITY).toBe(0.5);
    expect(flag(tinted, '--soften-m')).toBe(String(MESH_TEXTURE_SOFTEN_M));
    expect(flag(tinted, '--tint-size')).toBe(String(MESH_TEXTURE_SIZE));
    expect(MESH_TEXTURE_SIZE).toBe(8192);
    expect(args).not.toContain('--soften-m');
    // The inner's is for the course meshes: the tint colour goes on as it is.
    expect(tinted).not.toContain('--darken-tint');
    expect(tinted).not.toContain('--tint-grade');
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

    // The outer's tinted file is the terrain's floor: the twin's darkness with
    // the colouring on top, so the tint colour is darkened too. Never without the tint.
    expect(calls[2].args).not.toContain('--darken-tint');
    await t.svc.exportOuterOrtho(TEST_COURSE_ID, 'orto-l2-2025', undefined, {});
    expect(calls[3].args).toContain('--tint-out');
    expect(calls[3].args).toContain('--darken-tint');
    // …and graded so the terrain shader renders it like the course meshes next to it.
    expect(flag(calls[3].args, '--tint-grade')).toBe(OUTER_TERRAIN_GRADE.join(','));
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
    expect(describeRequest({ kind: 'svg' })).toBe('course SVG');
    expect(describeRequest({ kind: 'svg', excludeFeatureIds: ['a', 'b'], variant: 'No paths' })).toBe('course SVG (variant no-paths, 2 feature(s) excluded)');
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
    // The course's tree species areas travel with the stems.
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
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
    expect(done.result?.report.slice(0, 2)).toEqual(['Wrote out.svg', '200 features']);
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
    // The cleaned export (buildings removed / forest floor) never overwrites the plain files.
    expect(orthoExportFileName('Vreta', { ...src, patched: true }, true)).toBe('vreta-orto-l2-2025-patched-clean-8192.jpg');
    expect(outerOrthoExportFileName('Vreta', 'orto-l2-2025', true)).toBe('vreta-outer-orto-l2-2025-clean-8192.jpg');
});

test('the file name is a slug of the course name', () => {
    expect(exportFileName('Vreta')).toBe('vreta.svg');
    expect(exportFileName('Landeryd Masters')).toBe('landeryd-masters.svg');
    expect(exportFileName('Norrköping - Klinga')).toBe('norrkoping-klinga.svg');
    expect(exportFileName('  A6 golfklubb ')).toBe('a6-golfklubb.svg');
    expect(exportFileName('///')).toBe('course.svg');
    expect(exportFileName('Vreta', 'No paths #2')).toBe('vreta-no-paths-2.svg');
    expect(exportFileName('Vreta', '  ')).toBe('vreta.svg');
});

// --- Forest floor (D-VZ10) and vegetation zones ---

test('forest floor is opt-in on the orthophotos: the pipeline paints the course woodland_floor zones', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['dem.tif', 'ortho-orto-l2-2025.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif');
    expect(calls[0].args).not.toContain('--floor-course');

    const job = await t.svc.start(TEST_COURSE_ID, {
        kind: 'ortho', source: 'ortho-orto-l2-2025.tif', forestFloor: true, floorColor: '#585638', floorMix: 0.25,
    });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(job.id).status).toBe('succeeded');
    const args = calls[1].args;
    expect(flag(args, '--floor-course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--floor-color')).toBe('#585638');
    expect(flag(args, '--floor-mix')).toBe('0.25');

    // Defaults stay with the pipeline; nonsense is refused before anything runs.
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, undefined, {});
    expect(flag(calls[2].args, '--floor-course')).toBe(TEST_COURSE_ID);
    expect(calls[2].args).not.toContain('--floor-color');
    expect(calls[2].args).not.toContain('--floor-mix');
    await expect(t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, undefined, { color: 'brown' }))
        .rejects.toBeInstanceOf(ConflictError);
    await expect(t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, undefined, { mix: 2 }))
        .rejects.toBeInstanceOf(ConflictError);
    expect(calls).toHaveLength(3);
});

test('the outer orthophoto carries the forest floor too', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    await t.svc.exportOuterOrtho(TEST_COURSE_ID, 'orto-l2-2025', undefined, undefined, { mix: 0 });
    const render = calls.find((c) => c.args[1] === 'ortho')!.args;
    expect(flag(render, '--floor-course')).toBe(TEST_COURSE_ID);
    expect(flag(render, '--floor-mix')).toBe('0');
});

test('the zones export needs the heightmap sidecar, then rasterizes the course zones over the square', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'Wrote x.json\n  14 zones on the 2050 m inner square\n' });
    const t = await setup(runner);
    await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    await expect(t.svc.exportZones(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Export the inner heightmap first/);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');
    await writeFile(sidecar, '{}');

    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'zones', terrain: 'inner' });
    expect(job.label).toBe('inner vegetation zones');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const res = t.svc.job(job.id).result!;
    expect(res.path).toBe(path.join(dir, 'linkan-inner-zones.json'));
    expect(res.report).toEqual(['Wrote x.json', '14 zones on the 2050 m inner square']);
    const args = calls[0].args;
    expect(args[1]).toBe('zones');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--sidecar')).toBe(sidecar);
    expect(flag(args, '--out')).toBe(res.path);
    expect(flag(args, '--terrain')).toBe('inner');
    expect(args).not.toContain('--exclude-square');

    // The outer leaves the inner square to the inner file.
    await writeFile(path.join(dir, `linkan-outer-dem-${OUTER_TERRAIN_SIDE_M}m.tif.json`), '{}');
    await t.svc.exportZones(TEST_COURSE_ID, 'outer');
    expect(flag(calls[1].args, '--exclude-square')).toBe(squareArg(GEOREF_INNER));
    expect(zonesExportFileName('Vreta Kloster', 'outer')).toBe('vreta-kloster-outer-zones.json');
    expect(() => describeRequest({ kind: 'zones' })).toThrow(/needs a terrain/);
});

test('remove buildings passes the site roof heights and building survey that are on disk', async () => {
    const { calls, runner } = recordingRunner({ stdout: '  buildings: 12 roof(s) and their shadows removed\n' });
    const t = await setup(runner);
    const sources = await buildSite(t, ['dem.tif', 'ortho-orto-l2-2025.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    // Nothing on disk yet: the render goes ahead, and the report says what to run.
    const bare = await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, undefined, undefined, true);
    expect(calls[0].args).not.toContain('--remove-buildings');
    expect(bare.report[0]).toMatch(/Buildings not removed.*Regenerate trees/);
    expect(path.basename(bare.path)).toBe('linkan-orto-l2-2025-clean-8192.jpg');

    await writeFile(path.join(sources, 'roofs.tif'), '');
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, undefined, undefined, true);
    expect(calls[1].args).toContain('--remove-buildings');
    expect(flag(calls[1].args, '--roofs')).toBe(path.join(sources, 'roofs.tif'));
    expect(calls[1].args).not.toContain('--buildings-survey');

    await writeFile(path.join(sources, BUILDINGS_SURVEY_SOURCE), '{}');
    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'ortho', source: 'ortho-orto-l2-2025.tif', removeBuildings: true });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(job.id).result?.report).toEqual(['buildings: 12 roof(s) and their shadows removed']);
    expect(flag(calls[2].args, '--buildings-survey')).toBe(path.join(sources, BUILDINGS_SURVEY_SOURCE));

    // Off: nothing about buildings reaches the pipeline, and the plain file is written.
    const plain = await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif');
    expect(path.basename(plain.path)).toBe('linkan-orto-l2-2025-8192.jpg');
    expect(calls[3].args).not.toContain('--remove-buildings');
    expect(calls[3].args).not.toContain('--roofs');
});

// --- GreenKeeper course file ---

test('the GSPro course folder is unset until chosen, must exist, and names the GKD in it', async () => {
    const { svc } = await setup(recordingRunner().runner);
    expect((await svc.settings(TEST_COURSE_ID)).courseDir).toBeNull();
    expect((await svc.settings(TEST_COURSE_ID)).gkdFile).toBeNull();

    const courses = await mkdtemp(path.join(os.tmpdir(), 'gspro-courses-'));
    await expect(svc.setCourseDir(TEST_COURSE_ID, path.join(courses, 'Missing_scene'))).rejects.toThrow(ConflictError);

    // A fresh scene folder: the file gets the folder's name.
    const scene = path.join(courses, 'Vreta_lidar_scene');
    await mkdir(scene);
    const fresh = await svc.setCourseDir(TEST_COURSE_ID, scene);
    expect(fresh.courseDir).toBe(scene);
    expect(fresh.gkdFile).toBe('Vreta_lidar_scene.GKD');

    // GreenKeeper already wrote one: that file, whatever its case.
    await writeFile(path.join(scene, 'vreta_lidar_scene.gkd'), '{}');
    expect((await svc.settings(TEST_COURSE_ID)).gkdFile).toBe('vreta_lidar_scene.gkd');

    // The export folder is its own setting.
    expect((await svc.settings(TEST_COURSE_ID)).isDefault).toBe(true);
    const cleared = await svc.setCourseDir(TEST_COURSE_ID, '  ');
    expect(cleared.courseDir).toBeNull();
    await expect(svc.setCourseDir('nope', null)).rejects.toThrow(NotFoundError);
});

test('the GKD export needs the course folder and the inner heightmap, then writes into the course folder', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'Wrote x.GKD\n  18 holes, par 72\n' });
    const t = await setup(runner);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    await expect(t.svc.exportGkd(TEST_COURSE_ID)).rejects.toThrow(/Set the GSPro course folder first/);
    const scene = path.join(await mkdtemp(path.join(os.tmpdir(), 'gspro-courses-')), 'Linkan_scene');
    await mkdir(scene);
    await t.svc.setCourseDir(TEST_COURSE_ID, scene);

    await expect(t.svc.exportGkd(TEST_COURSE_ID)).rejects.toThrow(/Export the inner heightmap first/);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');
    await writeFile(sidecar, '{}');

    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'gkd' });
    expect(job.label).toBe('GreenKeeper course file');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const res = t.svc.job(job.id).result!;
    expect(res.path).toBe(path.join(scene, 'Linkan_scene.GKD'));
    expect(res.report).toEqual(['Wrote x.GKD', '18 holes, par 72']);
    const args = calls[0].args;
    expect(args[0]).toBe(path.join('/pipeline', 'gspro.py'));
    expect(args[1]).toBe('gkd');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--sidecar')).toBe(sidecar);
    expect(flag(args, '--out')).toBe(res.path);
});

test('the pipeline is found from the code, whatever folder the server was started in', async () => {
    const { DEFAULT_PIPELINE_DIR } = await import('./pipeline-dir');
    expect(existsSync(path.join(DEFAULT_PIPELINE_DIR, 'gspro.py'))).toBe(true);
    const cwd = process.cwd();
    try {
        process.chdir(path.resolve(import.meta.dir, '..', '..'));  // the repo root, as `bun run dev` starts it
        const svc = new GsproExportService({ db: undefined as never, courses: undefined as never, assets: undefined as never, dataDir: os.tmpdir() });
        expect((svc as unknown as { pipelineDir: string }).pipelineDir).toBe(process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR);
    } finally {
        process.chdir(cwd);
    }
});

test('the creeks export reads the raw DEM (not the dug one) and the inner sidecar, inner terrain only', async () => {
    const { calls, runner } = recordingRunner({ stdout: '  wrote x.json  (13 creek(s) for Linkan)\n' });
    const t = await setup(runner);
    const sourcesDir = await buildSite(t, ['dem.tif', 'dem-edited.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    await expect(t.svc.exportCreeks(TEST_COURSE_ID)).rejects.toThrow(/Export the inner heightmap first/);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');
    await writeFile(sidecar, '{}');

    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'creeks' });
    expect(job.label).toBe('creeks (R.A.M. splines)');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const res = t.svc.job(job.id).result!;
    expect(res.path).toBe(path.join(dir, 'linkan-inner-creeks.json'));
    const args = calls[0].args;
    expect(args[1]).toBe('creeks');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--dem')).toBe(path.join(sourcesDir, 'dem.tif'));
    expect(flag(args, '--sidecar')).toBe(sidecar);
    expect(creeksExportFileName('Vreta Kloster')).toBe('vreta-kloster-inner-creeks.json');
});


// --- Heightmap into Unity (a stand-in editor on the bridge protocol) ---

/** An editor whose active course exports to `exportFolder` (the test publishes its discovery file). */
function fakeEditor(name: string, exportFolder: string, update: Record<string, unknown>, replies: Record<string, unknown> = {}) {
    const calls: Array<{ command: string; args: any }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (req.headers.get('X-Bridge-Token') !== 'tok') return Response.json({ ok: false, error: 'token' }, { status: 403 });
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            calls.push({ command, args: await req.json() });
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name, exportFolder } } });
            if (command === 'golfmap.terrain.update') return Response.json({ ok: true, result: update });
            if (command in replies) return Response.json({ ok: true, result: replies[command] });
            return Response.json({ ok: false, error: `unknown ${command}` });
        },
    });
    return { calls, server };
}

test('unity-terrain exports the heightmap, then updates the terrain in the Unity project that imports from the folder', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const calls: string[][] = [];
    const runner: ExportRunner = async args => {
        calls.push(args);
        const out = args[args.indexOf('--out') + 1];
        await writeFile(out, 'tif');
        await writeFile(`${out}.json`, JSON.stringify({ minM: 64.8 }));   // the dug pond is the new low point
        return { code: 0, stdout: `  wrote ${out}
`, stderr: '' };
    };
    // Two editors: another course's project, and this one's (its folder relative to Assets).
    const project = await mkdtemp(path.join(os.tmpdir(), 'unity-proj-'));
    const other = fakeEditor('Other', 'D:/somewhere/else', {});
    const ours = fakeEditor('Linkan', path.relative(path.join(project, 'Assets'), exportDir), {
        terrains: [{ terrain: 'Terrain (Inner)', sidecar: 'linkan-inner-dem-2050m.tif.json', source: 'dem-edited.tif', movedM2: 38700, meanMoveM: 0.05, maxMoveM: -1.48, backup: 'Assets/GolfMap/Linkan/Backups/x.asset' }],
    });
    const publish = (file: string, port: number, projectPath: string, projectName: string) =>
        writeFileSync(path.join(discovery, file), JSON.stringify({ pid: process.pid, port, token: 'tok', projectPath, projectName, unityVersion: '2018.2.8f1', started: '' }));
    publish('bridge-1.json', other.server.port!, 'D:/unity/other', 'other');
    publish('bridge-2.json', ours.server.port!, project, 'linkan_v4');
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await buildSite(t, ['dem.tif']);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), JSON.stringify({ minM: 65.58 }));

        const job = await t.svc.start(TEST_COURSE_ID, { kind: 'unity-terrain', terrain: 'inner' });
        expect(job.label).toBe('inner heightmap into Unity');
        await t.svc.whenIdle(TEST_COURSE_ID);
        const res = t.svc.job(job.id);
        expect(res.error).toBeNull();
        expect(calls.map(a => a[1])).toEqual(['dem']);
        expect(ours.calls.map(c => c.command)).toEqual(['golfmap.course', 'golfmap.terrain.update']);
        expect(ours.calls[1]!.args).toEqual({ terrain: 'inner' });
        expect(other.calls.map(c => c.command)).not.toContain('golfmap.terrain.update');
        const report = res.result!.report;
        expect(report.some(l => l.startsWith("warning: the heightmap's zero moved -0.78 m"))).toBe(true);
        expect(report).toContain('Unity Terrain (Inner) (linkan_v4): heights from linkan-inner-dem-2050m.tif.json (dem-edited.tif); 3.9 ha moved more than 2 cm (mean 0.05 m, max -1.48 m); backup Assets/GolfMap/Linkan/Backups/x.asset');
    } finally {
        other.server.stop(true);
        ours.server.stop(true);
    }
});

test('unity-terrain with no Unity project on the folder says which ones are open and exports nothing', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const { calls, runner } = recordingRunner();
    const other = fakeEditor('Other', 'D:/somewhere/else', {});
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({ pid: process.pid, port: other.server.port!, token: 'tok', projectPath: 'D:/unity/other', projectName: 'other', unityVersion: '', started: '' }));
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await buildSite(t, ['dem.tif']);
        await t.svc.setDir(TEST_COURSE_ID, await mkdtemp(path.join(os.tmpdir(), 'gspro-out-')));
        await expect(t.svc.exportUnityTerrain(TEST_COURSE_ID, 'inner')).rejects.toThrow(/No open Unity editor imports from .*other: course Other exports to/);
        expect(calls).toHaveLength(0);
        expect(() => describeRequest({ kind: 'unity-terrain' })).toThrow(/needs a terrain/);
    } finally {
        other.server.stop(true);
    }
});

test('unity-ortho renders the picked photo, then puts its -meshes file onto the course meshes in Unity', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'unity-proj-'));
    const { calls, runner } = recordingRunner();
    const ours = fakeEditor('Linkan', path.relative(path.join(project, 'Assets'), exportDir), {}, {
        'golfmap.orthos.apply': { target: 'Assets/Terrain/linkan-orto-l2-2025-8192-meshes.jpg', renderers: 761, status: 'backup GolfMapSpelunk/ortho-backups/x.jpg' },
    });
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({ pid: process.pid, port: ours.server.port!, token: 'tok', projectPath: project, projectName: 'linkan_v4', unityVersion: '', started: '' }));
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await buildSite(t, ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.patched.tif']);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);

        expect(() => describeRequest({ kind: 'unity-ortho' })).toThrow(/needs a source/);
        // No tint asked for: the -meshes file is written anyway, it is the one Unity takes.
        const job = await t.svc.start(TEST_COURSE_ID, { kind: 'unity-ortho', source: 'ortho-orto-l2-2025.patched.tif', removeBuildings: true });
        expect(job.label).toBe('inner orthophoto onto the Unity course meshes');
        await t.svc.whenIdle(TEST_COURSE_ID);
        const res = t.svc.job(job.id);
        expect(res.error).toBeNull();
        expect(calls.map(c => c.args[1])).toEqual(['ortho']);
        const meshes = 'linkan-orto-l2-2025-patched-clean-8192-meshes.jpg';
        expect(flag(calls[0]!.args, '--tint-out')).toBe(path.join(exportDir, meshes));
        expect(ours.calls.map(c => c.command)).toEqual(['golfmap.course', 'golfmap.orthos.apply']);
        expect(ours.calls[1]!.args).toEqual({ file: meshes });
        expect(res.result!.report).toContain(
            `Unity (linkan_v4): ${meshes} put onto Assets/Terrain/linkan-orto-l2-2025-8192-meshes.jpg (761 renderers sample it; backup GolfMapSpelunk/ortho-backups/x.jpg)`);
    } finally {
        ours.server.stop(true);
    }
});

test('unity-ortho with no Unity project on the folder renders nothing', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
    await buildSite(t, ['ortho-orto-l2-2025.tif']);
    await t.svc.setDir(TEST_COURSE_ID, await mkdtemp(path.join(os.tmpdir(), 'gspro-out-')));
    await expect(t.svc.exportUnityOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif')).rejects.toThrow(/No open Unity editor imports from .*none is open/);
    expect(calls).toHaveLength(0);
});

test('a terrain edit newer than the last Apply to terrain: the inner heightmap warns, and is not put into Unity', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const { calls, runner } = recordingRunner({ stdout: '  wrote x\n' });
    const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
    const sources = await buildSite(t, ['dem.tif', 'dem-edited.tif']);
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, exportDir);
    // The edited DEM was written an hour before the pad was (re)generated.
    const anHourAgo = new Date(Date.now() - 3600_000);
    await utimes(path.join(sources, 'dem-edited.tif'), anHourAgo, anHourAgo);
    await new TerrainEditsService(t.db).create({
        siteId: SITE_ID, op: 'plane', params: { featherM: 4, flat: true }, origin: 'building-pads', originRef: 'osm:way/1',
        rings: [[{ x: 529500, y: 6486700 }, { x: 529530, y: 6486700 }, { x: 529530, y: 6486740 }]],
    });

    const dem = await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(dem.report[0]).toBe('warning: 1 terrain edit(s) (building-pads) changed after the last Apply to terrain, so this heightmap lacks them: press Apply to terrain in the terrain tool, then export again');
    await expect(t.svc.exportUnityTerrain(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Not put into Unity: 1 terrain edit\(s\) \(building-pads\) changed after the last Apply/);
    expect(calls.map(c => c.args[1])).toEqual(['dem']);   // the refused run exported nothing

    // Applied since: no warning.
    const now = new Date(Date.now() + 5000);
    await utimes(path.join(sources, 'dem-edited.tif'), now, now);
    expect((await t.svc.exportDem(TEST_COURSE_ID, 'inner')).report[0]).not.toMatch(/^warning/);
});

test('unity-sculpt captures in Unity, makes the GeoTIFF and stores it as the terrain\'s one delta layer; nothing sculpted removes it', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'unity-proj-'));
    let sculpted = true;
    const unityCalls: string[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            unityCalls.push(command);
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder: exportDir } } });
            // Like the real capture: the files in the export folder, the summary back.
            const file = path.join(exportDir, 'linkan-inner-sculpt.json');
            await writeFile(file, '{}');
            return Response.json({ ok: true, result: sculpted
                ? { terrain: 'Terrain (Inner)', file, cells: 480, areaM2: 120, maxRaiseM: 0.31, maxLowerM: -0.22, conformCellsLeftOut: 7 }
                : { terrain: 'Terrain (Inner)', file, cells: 0, areaM2: 0 } });
        },
    });
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({ pid: process.pid, port: server.port!, token: 'tok', projectPath: project, projectName: 'linkan_v4', unityVersion: '', started: '' }));
    const runs: string[][] = [];
    const runner: ExportRunner = async args => {
        runs.push(args);
        if (args[2] === 'sculpt-tif') {
            await writeFile(args[args.indexOf('--out') + 1]!, 'tif');
            return { code: 0, stdout: 'Sculpt layer: 480 cell(s)\nbounds3006 529500,6487500,529510,6487512\nWrote x\n', stderr: '' };
        }
        const out = args[args.indexOf('--out') + 1]!;
        await writeFile(out, 'tif');
        return { code: 0, stdout: '', stderr: '' };
    };
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        const sources = await buildSite(t, ['dem.tif']);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);

        const res = await t.svc.exportUnitySculpt(TEST_COURSE_ID, 'inner');
        expect(unityCalls).toEqual(['golfmap.course', 'golfmap.terrain.capture']);
        expect(runs[0]!.slice(0, 3)).toEqual(['-m', 'golfpipe', 'sculpt-tif']);
        const tif = path.join(sources, 'terrain-sculpt', 'inner-sculpt.tif');
        expect(res.path).toBe(tif);
        expect(res.report[0]).toBe('Unity Terrain (Inner) (linkan_v4): 0.01 ha sculpted (up to +0.31 m / -0.22 m); 7 conform-raised cell(s) left out');
        const [edit] = await new TerrainEditsService(t.db).listBySite(SITE_ID);
        expect(edit).toMatchObject({ op: 'delta', origin: 'unity-sculpt-inner', originRef: 'inner' });
        expect(edit!.params).toMatchObject({ featherM: 0, raster: 'inner-sculpt.tif', changedM2: 120, maxRaiseM: 0.31, maxLowerM: -0.22 });
        expect(edit!.rings[0]).toEqual([{ x: 529500, y: 6487500 }, { x: 529510, y: 6487500 }, { x: 529510, y: 6487512 }, { x: 529500, y: 6487512 }]);

        // The heightmap export now tells Unity about the layer it contains.
        await writeFile(path.join(sources, 'dem-edited.tif'), '');
        await t.svc.exportDem(TEST_COURSE_ID, 'inner');
        expect(flag(runs.at(-1)!, '--sculpt')).toBe(tif);

        // Everything undone in Unity: the layer goes.
        sculpted = false;
        const cleared = await t.svc.exportUnitySculpt(TEST_COURSE_ID, 'inner');
        expect(cleared.report[0]).toBe("Unity Terrain (Inner): nothing sculpted since golf-map's heights went in; the previous sculpt layer is removed");
        expect(await new TerrainEditsService(t.db).listBySite(SITE_ID)).toHaveLength(0);
        expect(existsSync(tif)).toBe(false);
    } finally {
        server.stop(true);
    }
});


// --- Plant vegetation (generators -> zones export -> Unity) ---

/** A runner standing in for the vegetation generators and `gspro.py zones`: each writes its --out. */
function vegetationRunner(zones: Record<string, Record<string, unknown>[]>) {
    const runs: string[][] = [];
    const runner: ExportRunner = async args => {
        runs.push(args);
        const out = args[args.indexOf('--out') + 1]!;
        const script = path.basename(args[0]!);
        if (script in zones) {
            const source = script === 'grass_zones.py' ? 'tall-grass' : 'creek-bank';
            await writeFile(out, JSON.stringify({
                type: 'FeatureCollection',
                features: zones[script]!.map((p, i) => ({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [[[529500 + i, 6487500], [529510 + i, 6487500], [529510 + i, 6487510], [529500 + i, 6487500]]] },
                    properties: { type: 'vegetation_zone', source, weight: 1, feather: 1, noise: 0, ...p },
                })),
            }));
            return { code: 0, stdout: `  ${script}: ${zones[script]!.length} zones\n`, stderr: '' };
        }
        await writeFile(out, '{}');
        return { code: 0, stdout: '  wrote zones\n', stderr: '' };
    };
    return { runs, runner };
}

test('vegetation: every generator in stack order, replacing only its own zones, then the zones export and the import in Unity', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const unity: Array<{ command: string; args: unknown }> = [];
    let applies = 0;
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            unity.push({ command, args: await req.json() });
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder: exportDir } } });
            if (command === 'golfmap.zones.import') return Response.json({ ok: true, result: { status: 'Imported 3 zone groups' } });
            // The first apply adds a new species (no mask rules yet at that import); later ones add nothing.
            const log = ++applies === 1 ? ["added item 'Creek vass - reed stand'"] : [];
            return Response.json({ ok: true, result: { system: 'Inner VSP', items: [{}, {}], log } });
        },
    });
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({ pid: process.pid, port: server.port!, token: 'tok', projectPath: 'D:/unity/linkan', projectName: 'linkan_v4', unityVersion: '', started: '' }));
    const { runs, runner } = vegetationRunner({
        'grass_zones.py': [{ zoneType: 'rough_tall' }, { zoneType: 'rough_tall', weight: 0.5 }],
        // A creek_bank section left on Default, which binds nothing.
        'creek_bank_zones.py': [{ zoneType: 'creek_bank', zoneVariant: '' }],
    });
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        const sources = await buildSite(t, []);
        await writeFile(path.join(sources, 'buildings.geojson'), '{}');
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-surfaces.json'), '{}');
        await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');
        const features = new CourseFeaturesService(t.db);
        const drawn = await features.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone',
            geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] }] },
            attributes: { zoneType: 'creek_bank', zoneVariant: '', weight: 1, feather: 2, noise: 0 },
        });

        for (const round of [1, 2]) {
            const job = await t.svc.start(TEST_COURSE_ID, { kind: 'vegetation', terrain: 'inner' });
            expect(job.label).toBe('inner vegetation, planted into Unity');
            await t.svc.whenIdle(TEST_COURSE_ID);
            const done = t.svc.job(job.id);
            expect(done.error).toBeNull();
            if (round === 1) {
                const report = done.result!.report;
                expect(report).toContain('tall rough: replaced 0 zones with 2');
                expect(report).toContain('creek banks: replaced 0 zones with 1');
                expect(report).toContain('warning: 1 creek_bank zones use its Default mix, which has no items: nothing grows there - pick a palette that has items');
                expect(report).toContain("Unity (linkan_v4): imported linkan-inner-zones.json into 'GolfMap lower vegetation' - Imported 3 zone groups");
                expect(report).toContain('Unity (linkan_v4): grass palettes applied (2 items on Inner VSP)');
                expect(report.at(-1)).toBe('Save the scene in Unity to keep it.');
            }
        }
        // Generators in stack order, then the zones export; each gets the course's inputs.
        expect(runs.map(a => path.basename(a[0]!) + (a[1] === 'zones' ? ' zones' : ''))).toEqual([
            'grass_zones.py', 'creek_bank_zones.py', 'gspro.py zones', 'grass_zones.py', 'creek_bank_zones.py', 'gspro.py zones',
        ]);
        expect(flag(runs[0]!, '--surfaces')).toBe(path.join(exportDir, 'linkan-inner-surfaces.json'));
        expect(flag(runs[0]!, '--buildings')).toBe(path.join(sources, 'buildings.geojson'));
        expect(flag(runs[1]!, '--course')).toBe(TEST_COURSE_ID);
        // Run 1: the new item gets a second import + apply round to bind and spawn; run 2: one round.
        const importAndApply = [
            { command: 'golfmap.zones.import', args: { terrain: 'inner', package: 'GolfMap lower vegetation' } },
            { command: 'golfmap.grass.apply', args: { terrain: 'inner' } },
        ];
        expect(unity.filter(c => c.command !== 'golfmap.course')).toEqual([...importAndApply, ...importAndApply, ...importAndApply]);
        // A re-run replaced its own zones; the hand-drawn one stays.
        const zones = (await features.listByCourse(TEST_COURSE_ID)).filter(f => f.type === 'vegetation_zone');
        expect(zones.filter(f => f.source === 'tall-grass')).toHaveLength(2);
        expect(zones.filter(f => f.source === 'creek-bank')).toHaveLength(1);
        expect(zones.some(f => f.id === drawn.id)).toBe(true);
    } finally {
        server.stop(true);
    }
});

test('vegetation without the surface map or an open Unity: what can run does, the rest is reported, the job still succeeds', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { runs, runner } = vegetationRunner({ 'grass_zones.py': [{ zoneType: 'rough_tall' }] });
    const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
    await buildSite(t, []);
    await t.svc.setDir(TEST_COURSE_ID, exportDir);
    await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');

    const res = await t.svc.plantVegetation(TEST_COURSE_ID, 'inner');
    expect(runs.map(a => path.basename(a[0]!))).toEqual(['grass_zones.py', 'gspro.py']);
    expect(flag(runs[0]!, '--surfaces')).toBeUndefined();
    expect(res.report).toContain("tall rough: warning: no surface map from Unity - run golfmap.surfaces.export in the course's Unity project; the drawn features stand in (they miss OPCD's Outer_Deep fill)");
    expect(res.report).toContain("creek banks: not planted (no surface map from Unity - run golfmap.surfaces.export in the course's Unity project)");
    expect(res.report.at(-1)).toMatch(/^Not in Unity yet: no open Unity editor imports from .* \(none is open\)/);
});

test('vegetation generators: a run from one generator re-runs every one after it (the zone stack order holds)', () => {
    expect(generatorsFrom(undefined).map(g => g.source)).toEqual(['tall-grass', 'creek-bank']);
    expect(generatorsFrom('creek-bank').map(g => g.source)).toEqual(['creek-bank']);
    expect(() => generatorsFrom('ferns')).toThrow("No vegetation generator 'ferns' (have: tall-grass, creek-bank)");
});


// --- Update zones in Unity (zones-patch -> golfmap.zones.patch) ---

/** A fake Unity editor for the course's export folder; records every command with its args. */
function fakeUnity(exportDir: string, discovery: string, patchResult: (args: Record<string, unknown>) => Response = () =>
    Response.json({ ok: true, result: { status: 'Patched 1 mask texture(s) for 1 zone(s), respawned 68 x 68 m in 640 ms. Save the scene.' } })) {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            const args = await req.json() as Record<string, unknown>;
            calls.push({ command, args });
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder: exportDir } } });
            return patchResult(args);
        },
    });
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({ pid: process.pid, port: server.port!, token: 'tok', projectPath: 'D:/unity/linkan', projectName: 'linkan_v4', unityVersion: '', started: '' }));
    return { calls, server };
}

/** A runner standing in for `gspro.py zones-patch`: writes the --result record with `changed`, or exits with `code` (for `codeFor` terrains only, when given). */
function patchRunner(changed: Record<string, boolean>, code = 0, codeFor?: string) {
    const runs: string[][] = [];
    const runner: ExportRunner = async args => {
        runs.push(args);
        const zonesJson = flag(args, '--zones-json')!;
        const kind = zonesJson.includes('-outer-') ? 'outer' : 'inner';
        if (code !== 0 && (!codeFor || codeFor === kind)) {
            return { code, stdout: '', stderr: `error: the zone types' item bindings changed since linkan-${kind}-zones.json was exported` };
        }
        await writeFile(flag(args, '--result')!, JSON.stringify({ format: 'unity-zones-patch-v1', changed: changed[kind] ?? false, textures: [] }));
        return { code: 0, stdout: `Patched ${path.basename(zonesJson)}: 2 zone(s)\n`, stderr: '' };
    };
    return { runs, runner };
}

test('vegetation-update patches each exported terrain for the zones and sends only the changed ones to Unity', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { calls, server } = fakeUnity(exportDir, discovery);
    const { runs, runner } = patchRunner({ inner: true, outer: false });
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
        await writeFile(path.join(exportDir, 'linkan-outer-zones.json'), '{}');

        const job = await t.svc.start(TEST_COURSE_ID, { kind: 'vegetation-update', zoneIds: ['z1', 'z2'] });
        expect(job.label).toBe('2 vegetation zone(s) updated in Unity');
        await t.svc.whenIdle(TEST_COURSE_ID);
        const done = t.svc.job(job.id);
        expect(done.error).toBeNull();

        // No generators: one zones-patch per terrain, the outer leaving the inner square out.
        expect(runs.map(a => [path.basename(a[0]!), a[1]])).toEqual([['gspro.py', 'zones-patch'], ['gspro.py', 'zones-patch']]);
        expect(flag(runs[0]!, '--ids')).toBe('z1,z2');
        expect(flag(runs[0]!, '--course')).toBe(TEST_COURSE_ID);
        expect(flag(runs[0]!, '--result')).toBe(path.join(exportDir, 'linkan-inner-zones-patch.json'));
        expect(flag(runs[0]!, '--exclude-square')).toBeUndefined();
        expect(flag(runs[1]!, '--exclude-square')).toBe(squareArg(GEOREF_INNER));
        // Only the inner masks changed: only they go to Unity.
        expect(calls.filter(c => c.command !== 'golfmap.course')).toEqual([{
            command: 'golfmap.zones.patch',
            args: { terrain: 'inner', patch: path.join(exportDir, 'linkan-inner-zones-patch.json'), package: 'GolfMap lower vegetation' },
        }]);
        expect(done.result!.report).toEqual([
            'inner: Patched linkan-inner-zones.json: 2 zone(s)',
            'outer: Patched linkan-outer-zones.json: 2 zone(s)',
            'Unity (linkan_v4): Patched 1 mask texture(s) for 1 zone(s), respawned 68 x 68 m in 640 ms. Save the scene.',
            'Save the scene in Unity to keep it.',
        ]);
    } finally {
        server.stop(true);
    }
});

test('vegetation-update: an outer export older than the bindings is skipped and the inner still goes into Unity', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { calls, server } = fakeUnity(exportDir, discovery);
    const { runner } = patchRunner({ inner: true }, 3, 'outer');
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
        await writeFile(path.join(exportDir, 'linkan-outer-zones.json'), '{}');
        const res = await t.svc.updateZones(TEST_COURSE_ID, ['z1']);
        expect(res.report).toContain("outer: skipped - linkan-outer-zones.json is older than the zone types' item bindings, so its channels may have moved; export the outer vegetation zones (or plant) to bring it in step");
        expect(calls.filter(c => c.command === 'golfmap.zones.patch').map(c => c.args.terrain)).toEqual(['inner']);
        expect(res.report.at(-1)).toBe('Save the scene in Unity to keep it.');
    } finally {
        server.stop(true);
    }
});

test('vegetation-update with nothing changed leaves Unity alone', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { calls, server } = fakeUnity(exportDir, discovery);
    const { runner } = patchRunner({ inner: false });
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
        const res = await t.svc.updateZones(TEST_COURSE_ID, ['z1']);
        expect(res.report.at(-1)).toBe('Nothing changed in the masks, so nothing to take into Unity');
        expect(calls.map(c => c.command)).toEqual(['golfmap.course']);
    } finally {
        server.stop(true);
    }
});

test('vegetation-update refuses before patching: no planting yet, Unity not open, or the item bindings moved', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const moved = patchRunner({}, 3);
    const t = await setup(moved.runner, { unityBridge: defaultUnityBridge(discovery) });
    await t.svc.setDir(TEST_COURSE_ID, exportDir);

    await expect(t.svc.updateZones(TEST_COURSE_ID, ['z1'])).rejects.toThrow(/No vegetation zones export in .* yet: plant vegetation once first/);
    await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
    await expect(t.svc.updateZones(TEST_COURSE_ID, ['z1'])).rejects.toThrow(/Open the course's Unity project first: no open Unity editor imports from/);
    expect(moved.runs).toHaveLength(0);   // masks patched without Unity would leave the scene behind

    const { calls, server } = fakeUnity(exportDir, discovery);
    try {
        await expect(t.svc.updateZones(TEST_COURSE_ID, ['z1'])).rejects.toThrow(
            "The zone types' item bindings changed since the last planting, so the inner masks' channels may have moved: use Plant vegetation this time");
        expect(calls.map(c => c.command)).toEqual(['golfmap.course']);
        await expect(t.svc.start(TEST_COURSE_ID, { kind: 'vegetation-update', zoneIds: [] })).rejects.toThrow('A vegetation-update export needs the zones to update');
    } finally {
        server.stop(true);
    }
});

test('vegetation-update: a Unity that cannot take the patch says how to catch up', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { server } = fakeUnity(exportDir, discovery, () =>
        Response.json({ ok: false, error: "The scene does not hold this zones export's import (no mask group for 'Reed'). Plant vegetation (a full import) instead." }));
    const { runner } = patchRunner({ inner: true });
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
        await expect(t.svc.updateZones(TEST_COURSE_ID, ['z1'])).rejects.toThrow(
            /The inner masks are updated in .*, but Unity \(linkan_v4\) could not take them: .*no mask group for 'Reed'.*Plant vegetation to bring Unity in step/);
    } finally {
        server.stop(true);
    }
});


test('vegetation-update with a drawn creek_bank zone (a creek section) re-runs only the creek-bank generator first', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { calls, server } = fakeUnity(exportDir, discovery);
    const patch = patchRunner({ inner: true });
    const runs: string[][] = [];
    const runner: ExportRunner = async (args, cwd) => {
        if (path.basename(args[0]!) === 'creek_bank_zones.py') {
            runs.push(args);
            await writeFile(args[args.indexOf('--out') + 1]!, JSON.stringify({ type: 'FeatureCollection', features: [{
                type: 'Feature',
                geometry: { type: 'Polygon', coordinates: [[[529500, 6487500], [529510, 6487500], [529510, 6487510], [529500, 6487500]]] },
                properties: { type: 'vegetation_zone', source: 'creek-bank', zoneType: 'creek_bank', zoneVariant: 'lush', weight: 1, feather: 1, noise: 0 },
            }] }));
            return { code: 0, stdout: '  creek_bank_zones.py: 1 zones\n', stderr: '' };
        }
        runs.push(args);
        return patch.runner(args, cwd);
    };
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await buildSite(t, []);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
        await writeFile(path.join(exportDir, 'linkan-inner-surfaces.json'), '{}');
        const features = new CourseFeaturesService(t.db);
        const ring = { points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] };
        const section = await features.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone', geometry: { crs: 'EPSG:3006', rings: [ring] },
            attributes: { zoneType: 'creek_bank', zoneVariant: 'lush', weight: 1, feather: 2, noise: 0 },
        });
        const shrub = await features.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone', geometry: { crs: 'EPSG:3006', rings: [ring] },
            attributes: { zoneType: 'shrub', weight: 1, feather: 2, noise: 0 },
        });

        // A plain zone: no generator.
        await t.svc.updateZones(TEST_COURSE_ID, [shrub.id]);
        expect(runs.map(a => path.basename(a[0]!) + (a[1] === 'zones-patch' ? ' zones-patch' : ''))).toEqual(['gspro.py zones-patch']);

        runs.length = 0;
        const res = await t.svc.updateZones(TEST_COURSE_ID, [section.id, shrub.id]);
        expect(runs.map(a => path.basename(a[0]!) + (a[1] === 'zones-patch' ? ' zones-patch' : ''))).toEqual(['creek_bank_zones.py', 'gspro.py zones-patch']);
        expect(flag(runs[0]!, '--surfaces')).toBe(path.join(exportDir, 'linkan-inner-surfaces.json'));
        expect(res.report).toContain('creek banks: replaced 0 zones with 1');
        expect((await features.listByCourse(TEST_COURSE_ID)).filter(f => f.source === 'creek-bank')).toHaveLength(1);
        expect(calls.filter(c => c.command === 'golfmap.zones.patch')).toHaveLength(2);
    } finally {
        server.stop(true);
    }
});
