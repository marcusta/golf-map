import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, utimes } from 'node:fs/promises';
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
    buildingsExportFileName, BUILDINGS_SURVEY_SOURCE, OUTER_DEM_EDITED_SOURCE, describeRequest, zonesExportFileName, creeksExportFileName, waterfallsExportFileName,
    ramRoadsExportFileName, RAM_ROADS_REACH_M, gkdLinesFileName,
    ZONES_LAYOUT_CHANGED_EXIT, OUTER_VEGETATION_IS_ARBORIST, diffZoneContents, defaultRunner, venvPython,
} from './gspro-export.service';
import { sql } from 'kysely';
import { TerrainEditsService } from './terrain-edits.service';
import { digest } from './export-fingerprint';
import { innerSquareFrom3006, outerSquareFor, squareArg, terrainManifestField, toSquareBox, OUTER_TERRAIN_SIDE_M } from './terrain-square';
import { defaultUnityBridge, type UnityBridge } from './unity-bridge';
import { NotFoundError, ConflictError } from '@basics/core/server/auth';
import { CourseFeaturesService } from './course-features.service';
import { generatorsFrom } from './vegetation-generators';
import { ZoneTypesService } from './zone-types.service';
import { courseMetaDiff, emptyCourseMeta } from '../../shared/gspro-course-meta';
import { TeeSetsService } from './tee-sets.service';

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

async function setup(runner: ExportRunner, opts: { georeference?: boolean; unityBridge?: UnityBridge; courseDocsRoot?: string; dataDir?: string } = {}) {
    const ctx = await createTestDb(seedCourse);
    if (opts.georeference !== false) {
        await ctx.db.updateTable('courses').set({ georeference_json: GEOREF })
            .where('id', '=', TEST_COURSE_ID).execute();
    }
    const dataDir = opts.dataDir ?? await mkdtemp(path.join(os.tmpdir(), 'gspro-data-'));
    const courses = new CoursesService(ctx.db);
    const assets = new AssetsService(ctx.db, dataDir);
    const svc = new GsproExportService({
        db: ctx.db, courses, assets, dataDir,
        pipelineDir: '/pipeline', runner, unityBridge: opts.unityBridge, courseDocsRoot: opts.courseDocsRoot,
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
    expect((await readdir(path.join(dir, 'export-history', kept[0]))).sort()).toEqual(['export.json', 'features.json', 'linkan.svg']);
    expect(full.report).toContain(`kept as ${path.join('export-history', kept[0])}`);
    // export.json: the export's report and an empty slot for the OPCD build (opcd:build --status fills it).
    const record = JSON.parse(await readFile(path.join(dir, 'export-history', kept[0], 'export.json'), 'utf-8'));
    expect(record.report).toEqual(full.report.filter(l => !l.startsWith('kept as ')));
    expect(record.build).toBeNull();
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

test('the persisted ortho GeoTIFFs are listed newest first, the cleaned photo after its original', async () => {
    const t = await setup(recordingRunner().runner);
    await buildSite(t, [
        'ortho-orto-l2-2023.tif', 'dem.tif', 'ortho-orto-l2-2025.cleaned.tif',
        'ortho-orto-l2-2025.tif', 'trees.geojson', 'dem-edited.tif',
    ]);

    const sources = await t.svc.orthoSources(TEST_COURSE_ID);
    expect(sources).toEqual([
        { source: 'ortho-orto-l2-2025.tif', collection: 'orto-l2-2025', cleaned: false, active: true },
        { source: 'ortho-orto-l2-2025.cleaned.tif', collection: 'orto-l2-2025', cleaned: true, active: true },
        { source: 'ortho-orto-l2-2023.tif', collection: 'orto-l2-2023', cleaned: false, active: false },
    ]);
});

test('parseOrthoSourceName reads the collection and the cleaned flag', () => {
    expect(parseOrthoSourceName('ortho-orto-l2-2025.tif')).toEqual({ collection: 'orto-l2-2025', cleaned: false });
    expect(parseOrthoSourceName('ortho-orto-i2-2023.cleaned.tif')).toEqual({ collection: 'orto-i2-2023', cleaned: true });
    expect(parseOrthoSourceName('dem.tif')).toBeNull();
    // The retired patch-log model's working raster is not a source any more.
    expect(parseOrthoSourceName('ortho-orto-l2-2025.patched.tif')).toBeNull();
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

test('the cleaned photo is named so it cannot be mistaken for the pristine one', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.cleaned.tif']);
    const res = await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.cleaned.tif');
    expect(path.basename(res.path)).toBe('linkan-orto-l2-2025-cleaned-8192.jpg');
    expect(calls[0].args[calls[0].args.indexOf('--ortho') + 1]).toEndWith('ortho-orto-l2-2025.cleaned.tif');
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

test('the outer DEM export exports the inner heightmap first when the folder has none, for the Unity position', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    await buildSite(t, ['dem.tif', OUTER_DEM_SOURCE]);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    // Outer first: no inner sidecar yet, so the inner heightmap goes out before it.
    const first = await t.svc.exportDem(TEST_COURSE_ID, 'outer');
    expect(calls.map(c => flag(c.args, '--terrain'))).toEqual(['inner', 'outer']);
    expect(first.report[0]).toMatch(/^exported the inner heightmap first, for the outer terrain's Unity position/);
    // The stand-in pipeline writes no sidecar, so the position still could not be recorded — and that is said.
    expect(calls[1].args).not.toContain('--inner-sidecar');
    expect(first.report.at(-1)).toMatch(/Unity position is not recorded/);

    // With the inner's sidecar there (side 2050 m for the georeferenced course), it is passed and nothing runs first.
    const innerSidecar = path.join(dir, demSidecarName(demExportFileName('Linkan', 'inner', 2050)));
    expect(path.basename(innerSidecar)).toBe('linkan-inner-dem-2050m.tif.json');
    await writeFile(innerSidecar, '{}');
    calls.length = 0;
    const second = await t.svc.exportDem(TEST_COURSE_ID, 'outer');
    expect(calls).toHaveLength(1);
    expect(flag(calls[0].args, '--inner-sidecar')).toBe(innerSidecar);
    expect(second.report.join('\n')).not.toMatch(/exported the inner heightmap first/);
});

test('the outer DEM export replays the site\'s enabled terrain edits onto the outer DEM first', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner);
    const srcDir = await buildSite(t, ['dem.tif', OUTER_DEM_SOURCE]);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    // The inner heightmap is already in the folder, so only the outer export runs here.
    await writeFile(path.join(dir, demSidecarName(demExportFileName('Linkan', 'inner', 2050))), '{}');

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

test('the buildings export exports the heightmap itself, needs the survey, then writes unity-buildings over the square', async () => {
    const { calls, runner } = recordingRunner();
    const t = await setup(runner, { georeference: false });
    const srcDir = await buildSite(t, ['dem.tif'], 'orto-l2-2025', BUILT_MANIFEST);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    // The survey is the server's to refuse: it comes from the terrain tool, not from here.
    await expect(t.svc.exportBuildings(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Generate building pads/);
    await writeFile(path.join(srcDir, BUILDINGS_SURVEY_SOURCE), '{}');

    // The heightmap sidecar it needs is not there: it is exported first instead of refused.
    const first = await t.svc.exportBuildings(TEST_COURSE_ID, 'inner');
    expect(calls.map(c => c.args[1])).toEqual(['dem', 'buildings']);
    expect(first.report[0]).toMatch(/^exported the inner heightmap first, for linkan-inner-dem-2010m\.tif\.json/);

    const sidecar = path.join(dir, demSidecarName(demExportFileName('Linkan', 'inner', 2010)));
    await writeFile(sidecar, '{}');
    calls.length = 0;
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
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    // The inner heightmap is already in the folder, so only the outer export runs here.
    await writeFile(path.join(dir, demSidecarName(demExportFileName('Linkan', 'inner', 2050))), '{}');

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

    // The trees job must have run — that is not the export's to do.
    await expect(t.svc.exportTrees(TEST_COURSE_ID, 'inner')).rejects.toThrow(/Regenerate trees/);
    const stems = t.assets.resolveTreeStemsPath(SITE_ID);
    await mkdir(path.dirname(stems), { recursive: true });
    await writeFile(stems, '{"trees":[]}');

    // The heightmap sidecar the file takes its height range from is exported first when it is missing.
    const first = await t.svc.exportTrees(TEST_COURSE_ID, 'inner');
    expect(calls.map(c => c.args[1])).toEqual(['dem', 'trees']);
    expect(first.report[0]).toMatch(/^exported the inner heightmap first, for linkan-inner-dem-2050m\.tif\.json/);
    await writeFile(sidecar, '{}');
    calls.length = 0;

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
    // No placed rocks for this course: nothing to keep the stems off.
    expect(args).not.toContain('--rocks');
});

test("the trees export keeps the stems off the course's placed rocks when it has a stone-walls.json", async () => {
    const { calls, runner } = recordingRunner({ stdout: 'Wrote x.json\n' });
    const docs = await mkdtemp(path.join(os.tmpdir(), 'gspro-docs-'));
    const rocks = path.join(docs, 'linkan', 'stone-walls.json');
    await mkdir(path.dirname(rocks), { recursive: true });
    await writeFile(rocks, '{"boulders":[]}');
    const t = await setup(runner, { courseDocsRoot: docs });
    await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    await writeFile(path.join(dir, 'linkan-inner-dem-2050m.tif.json'), '{}');
    const stems = t.assets.resolveTreeStemsPath(SITE_ID);
    await mkdir(path.dirname(stems), { recursive: true });
    await writeFile(stems, '{"trees":[]}');

    await t.svc.exportTrees(TEST_COURSE_ID, 'inner');

    expect(flag(calls[0].args, '--rocks')).toBe(rocks);
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

test('the ortho file name carries course, vintage, cleaned flag and size', () => {
    const src = { source: 'x', collection: 'orto-l2-2025', cleaned: false, active: false };
    expect(orthoExportFileName('Vreta', src)).toBe('vreta-orto-l2-2025-8192.jpg');
    expect(orthoExportFileName('Norrköping - Klinga', { ...src, cleaned: true })).toBe('norrkoping-klinga-orto-l2-2025-cleaned-8192.jpg');
    // The cleaned export (buildings removed / forest floor) never overwrites the plain files.
    expect(orthoExportFileName('Vreta', { ...src, cleaned: true }, true)).toBe('vreta-orto-l2-2025-cleaned-clean-8192.jpg');
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

    // No heightmap sidecar in the folder: the zones export writes one first instead of refusing.
    const first = await t.svc.exportZones(TEST_COURSE_ID, 'inner');
    expect(calls.map(c => c.args[1])).toEqual(['dem', 'zones']);
    expect(first.report[0]).toMatch(/^exported the inner heightmap first, for linkan-inner-dem-2050m\.tif\.json/);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');
    await writeFile(sidecar, '{}');
    calls.length = 0;

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

test("the course's name in OPCD's cloud builder is kept with the course", async () => {
    // What the course is called in OPCD's "Course Workflow" list is not our course name
    // (Vreta is "Vreta Kloster golfklubb" there), and `bun run opcd:build` has no other
    // handle on it: the builder is a ZK UI with no per-course address.
    const { svc } = await setup(recordingRunner().runner);
    expect((await svc.settings(TEST_COURSE_ID)).opcdCourseName).toBeNull();

    const set = await svc.setOpcdCourseName(TEST_COURSE_ID, '  Vreta Kloster golfklubb  ');
    expect(set.opcdCourseName).toBe('Vreta Kloster golfklubb');
    expect((await svc.settings(TEST_COURSE_ID)).opcdCourseName).toBe('Vreta Kloster golfklubb');

    // Blank clears it; nothing else about the course's export settings moves.
    const cleared = await svc.setOpcdCourseName(TEST_COURSE_ID, '   ');
    expect(cleared.opcdCourseName).toBeNull();
    expect(cleared.isDefault).toBe(true);
    expect((await svc.setOpcdCourseName(TEST_COURSE_ID, null)).opcdCourseName).toBeNull();

    await expect(svc.setOpcdCourseName(TEST_COURSE_ID, 'x'.repeat(201))).rejects.toThrow(ConflictError);
    await expect(svc.setOpcdCourseName('nope', 'Vreta')).rejects.toThrow(NotFoundError);
});

test('course details are kept with the course, and read back from a .GKD edited in GreenKeeper', async () => {
    const t = await setup(recordingRunner().runner);
    const { svc } = t;
    const none = await svc.settings(TEST_COURSE_ID);
    expect(none.meta).toBeNull();
    expect(none.gkdMeta).toBeNull();
    await expect(svc.readGkdMeta(TEST_COURSE_ID)).rejects.toThrow(/Set the GSPro course folder first/);

    const scene = path.join(await mkdtemp(path.join(os.tmpdir(), 'gspro-courses-')), 'Vreta_lidar_scene');
    await mkdir(scene);
    await svc.setCourseDir(TEST_COURSE_ID, scene);
    await expect(svc.readGkdMeta(TEST_COURSE_ID)).rejects.toThrow(/No readable \.GKD/);

    // Typed in the app: stored trimmed, keywords in the file's order.
    const typed = await svc.setMeta(TEST_COURSE_ID, {
        ...emptyCourseMeta('Linkan'), designer: ' Marcus ', keywords: ['Parkland', 'Historic'],
    });
    expect(typed.meta).toMatchObject({ courseName: 'Linkan', designer: 'Marcus', keywords: ['Historic', 'Parkland'] });
    expect(typed.gkdRatings).toEqual([]);

    // Saved in GreenKeeper since: the file's details show next to the app's, and can be taken over.
    await writeFile(path.join(scene, 'Vreta_lidar_scene.GKD'), JSON.stringify({
        CourseName: 'Vreta', CityTown: 'Linköping', StateCountyProvince: '', Country: 'Sweden', Designer: 'Fandorm',
        CourseInfo: 'Oak parkland.', DifficultyRating: 4.9, KeywordParkland: true, KeywordLinks: false,
        WhiteSR: '73.4/139', YellowSR: '71.5/135', BlueSR: '0.0/0', Holes: [],
    }));
    const edited = await svc.settings(TEST_COURSE_ID);
    expect(edited.meta?.designer).toBe('Marcus');
    expect(edited.gkdMeta).toMatchObject({ courseName: 'Vreta', city: 'Linköping', designer: 'Fandorm', keywords: ['Parkland'] });
    expect(courseMetaDiff(edited.meta!, edited.gkdMeta!)).toEqual(
        ['name', 'city', 'country', 'designer', 'description', 'difficulty', 'keywords']);
    // The course's tee sets (yellow, blue) are unrated; the file rates Yellow (and White, which the course has no set for).
    expect(edited.gkdRatings).toEqual(['yellow 71.5/135']);

    // The ratings alone can be taken: the course details the app keeps stay.
    const rated = await svc.readGkdRatings(TEST_COURSE_ID);
    expect(rated.gkdRatings).toEqual([]);
    expect(rated.meta?.designer).toBe('Marcus');
    const [yellow] = await new TeeSetsService(t.db).listByCourse(TEST_COURSE_ID);
    expect([yellow.ratingMen, yellow.slopeMen]).toEqual([71.5, 135]);
    await new TeeSetsService(t.db).update(yellow.id, yellow.version, { ratingMen: null, slopeMen: null });

    const read = await svc.readGkdMeta(TEST_COURSE_ID);
    expect(read.meta).toEqual(read.gkdMeta);
    expect(read.meta).toMatchObject({ description: 'Oak parkland.', difficulty: 4.9 });
    // The file's rating went onto the tee set, as the rating GSPro shows for it.
    expect(read.gkdRatings).toEqual([]);
    const sets = await new TeeSetsService(t.db).listByCourse(TEST_COURSE_ID);
    expect(sets.map(s => [s.name, s.ratingMen, s.slopeMen])).toEqual([['yellow', 71.5, 135], ['blue', null, null]]);

    expect((await svc.setMeta(TEST_COURSE_ID, null)).meta).toBeNull();
});

test('the GKD export needs the course folder, exports the inner heightmap itself, then writes into the course folder', async () => {
    const { calls, runner } = recordingRunner({ stdout: 'Wrote x.GKD\n  18 holes, par 72\n' });
    const t = await setup(runner);
    await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    await expect(t.svc.exportGkd(TEST_COURSE_ID)).rejects.toThrow(/Set the GSPro course folder first/);
    const scene = path.join(await mkdtemp(path.join(os.tmpdir(), 'gspro-courses-')), 'Linkan_scene');
    await mkdir(scene);
    await t.svc.setCourseDir(TEST_COURSE_ID, scene);

    // No inner heightmap sidecar in the folder: it is exported first instead of refused.
    const first = await t.svc.exportGkd(TEST_COURSE_ID);
    expect(calls.map(c => c.args[1])).toEqual(['dem', 'gkd', 'holes']);
    expect(first.report[0]).toMatch(/^exported the inner heightmap first, for linkan-inner-dem-2050m\.tif\.json/);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');
    await writeFile(sidecar, '{}');
    calls.length = 0;

    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'gkd' });
    expect(job.label).toBe('GreenKeeper course file');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const res = t.svc.job(job.id).result!;
    expect(res.path).toBe(path.join(scene, 'Linkan_scene.GKD'));
    expect(res.report).toEqual(['Wrote x.GKD', '18 holes, par 72', 'Wrote x.GKD', '18 holes, par 72']);  // the runner answers both runs alike
    const args = calls[0].args;
    expect(args[0]).toBe(path.join('/pipeline', 'gspro.py'));
    expect(args[1]).toBe('gkd');
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--sidecar')).toBe(sidecar);
    expect(flag(args, '--out')).toBe(res.path);
    // The hole navigator's file goes to the export folder, from the same tees, aims and greens.
    const holes = calls[1].args;
    expect(holes[1]).toBe('holes');
    expect(flag(holes, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(holes, '--out')).toBe(path.join(dir, 'linkan-holes.json'));
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

    // No inner heightmap sidecar in the folder: it is exported first instead of refused.
    const first = await t.svc.exportCreeks(TEST_COURSE_ID);
    expect(calls.map(c => c.args[1])).toEqual(['dem', 'creeks']);
    expect(first.report[0]).toMatch(/^exported the inner heightmap first, for linkan-inner-dem-2050m\.tif\.json/);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');
    await writeFile(sidecar, '{}');
    calls.length = 0;

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

test('the waterfalls export reads the raw DEM and the inner sidecar, and is skipped until a feature changes', async () => {
    const w = writingRunner();
    const t = await setup(w.runner);
    const sourcesDir = await buildSite(t, ['dem.tif', 'dem-edited.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    // No inner heightmap sidecar in the folder: it is exported first instead of refused.
    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'waterfalls' });
    expect(job.label).toBe('waterfalls (lips and water levels)');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const res = t.svc.job(job.id).result!;
    expect(res.path).toBe(path.join(dir, 'linkan-inner-waterfalls.json'));
    expect(res.report[0]).toMatch(/^exported the inner heightmap first, for linkan-inner-dem-2050m\.tif\.json/);
    expect(w.commands()).toEqual(['dem', 'waterfalls']);
    const args = w.calls[1]!;
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--dem')).toBe(path.join(sourcesDir, 'dem.tif'));
    expect(flag(args, '--sidecar')).toBe(path.join(dir, 'linkan-inner-dem-2050m.tif.json'));
    expect(waterfallsExportFileName('Vreta Kloster')).toBe('vreta-kloster-inner-waterfalls.json');

    // Nothing it reads has changed: skipped. A drawn fall renders it again.
    w.calls.length = 0;
    expect((await t.svc.exportWaterfalls(TEST_COURSE_ID)).report[0]).toMatch(/^unchanged: /);
    const features = new CourseFeaturesService(t.db);
    await features.create({
        courseId: TEST_COURSE_ID, holeId: null, type: 'waterfall',
        geometry: { crs: 'EPSG:3006', rings: [], centerline: { points: [{ x: 529400, y: 6487400 }, { x: 529402, y: 6487400 }], widthM: 2 } },
        attributes: { style: 'outlet' },
    });
    await t.svc.exportWaterfalls(TEST_COURSE_ID);
    expect(w.commands()).toEqual(['waterfalls']);
});

test('the GKD hazard lines need no GSPro course folder, wait for the inner heightmap rather than export it, and are read again only when a feature changes', async () => {
    const doc = {
        courseId: TEST_COURSE_ID, crs: 'EPSG:3006',
        rule: { marginM: 1, bankMaxM: 3, bankStartM: 2, deepPct: 15, roughPct: 20 },
        lines: [
            { kind: 'water', waterIds: ['w1', 'w2'], noAsItLies: false, points: [[529400, 6487400], [529403, 6487400], [529403, 6487403]] },
            { kind: 'penalty', featureId: 'p1', type: 'penalty_yellow', noAsItLies: true, points: [[529500, 6487500], [529503, 6487500], [529503, 6487503]] },
        ],
    };
    const w = writingRunner();
    let running = 0, overlapped = false;
    const runner: ExportRunner = async (args, cwd, opts) => {
        overlapped ||= running > 0;
        running++;
        try {
            const done = await w.runner(args, cwd, opts);
            await Bun.sleep(5);
            if (args[1] === 'gkd-lines') await writeFile(flag(args, '--out')!, JSON.stringify(doc));
            return done;
        } finally {
            running--;
        }
    };
    const t = await setup(runner);
    await expect(t.svc.gkdLines(TEST_COURSE_ID)).rejects.toThrow(/no built map/);
    await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    // No inner heightmap yet: opening Furniture must not start that export, so the lines wait for it.
    await expect(t.svc.gkdLines(TEST_COURSE_ID)).rejects.toThrow(/No inner heightmap/);
    expect(w.commands()).toEqual([]);
    // No GSPro course folder set, the heightmap exported: the lines.
    await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(await t.svc.gkdLines(TEST_COURSE_ID)).toEqual(doc as never);
    expect(w.commands()).toEqual(['dem', 'gkd-lines']);
    const args = w.calls[1]!;
    expect(args[0]).toBe(path.join('/pipeline', 'gspro.py'));
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--sidecar')).toBe(path.join(dir, 'linkan-inner-dem-2050m.tif.json'));
    expect(flag(args, '--out')).toBe(path.join(dir, 'linkan-inner-gkd-lines.json'));
    expect(gkdLinesFileName('Vreta Kloster')).toBe('vreta-kloster-inner-gkd-lines.json');

    // Nothing it reads has changed: the file is read as it is. A changed attribute runs the pipeline again.
    w.calls.length = 0;
    expect((await t.svc.gkdLines(TEST_COURSE_ID)).lines).toHaveLength(2);
    expect(w.commands()).toEqual([]);
    const features = new CourseFeaturesService(t.db);
    const pond = await features.create({
        courseId: TEST_COURSE_ID, holeId: null, type: 'water',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] }] },
    });
    await t.svc.gkdLines(TEST_COURSE_ID);
    expect(w.commands()).toEqual(['gkd-lines']);
    // Two callers at once (Furniture opened twice): one run, the second finds its file current.
    await features.update(pond.id, pond.version, { attributes: { noAsItLies: true } });
    await Promise.all([t.svc.gkdLines(TEST_COURSE_ID), t.svc.gkdLines(TEST_COURSE_ID)]);
    expect(w.commands()).toEqual(['gkd-lines', 'gkd-lines']);
    expect(overlapped).toBe(false);
    expect(w.calls[1]).not.toContain('--gkd');

    // With a GSPro course folder holding a .GKD, its boundary is passed along (for a course with no drawn OOB ring).
    const scene = path.join(await mkdtemp(path.join(os.tmpdir(), 'gspro-courses-')), 'Linkan_scene');
    await mkdir(scene);
    await writeFile(path.join(scene, 'Linkan_scene.GKD'), '{}');
    await t.svc.setCourseDir(TEST_COURSE_ID, scene);
    await t.svc.gkdLines(TEST_COURSE_ID);
    expect(flag(w.calls[2]!, '--gkd')).toBe(path.join(scene, 'Linkan_scene.GKD'));
});

const PIPELINE = path.resolve(import.meta.dir, '..', '..', 'pipeline');
const PIPELINE_PYTHON = venvPython(PIPELINE);
const NO_VENV = !existsSync(PIPELINE_PYTHON);
if (NO_VENV) console.warn(`gspro-export.service.test: the gkd-lines run on real ground is skipped, it needs the pipeline venv (${PIPELINE_PYTHON})`);

/** A 200 m inner square: flat ground at 10 m, two ponds dug 1 m into it. */
const LINES_E0 = 500000, LINES_N0 = 6500000;
const LINES_DEM = `
import sys, numpy as np, rasterio
from rasterio.transform import from_origin
E0, N0, RES, SIDE = ${LINES_E0}.0, ${LINES_N0}.0, 0.5, 200.0
n = int(SIDE / RES)
X, Y = np.meshgrid(E0 + (np.arange(n) + 0.5) * RES, N0 + SIDE - (np.arange(n) + 0.5) * RES)
z = np.full((n, n), 10.0)
z[(X > E0 + 40) & (X < E0 + 60) & (Y > N0 + 40) & (Y < N0 + 60)] = 9.0
z[(X > E0 + 130) & (X < E0 + 150) & (Y > N0 + 130) & (Y < N0 + 150)] = 9.0
with rasterio.open(sys.argv[1], "w", driver="GTiff", width=n, height=n, count=1, dtype="float32", crs="EPSG:3006",
                   transform=from_origin(E0, N0 + SIDE, RES, RES), nodata=-9999) as dst:
    dst.write(z.astype(np.float32), 1)
`;

const rect = (x0: number, y0: number, x1: number, y1: number) => ({ crs: 'EPSG:3006', rings: [{ points: [
    { x: LINES_E0 + x0, y: LINES_N0 + y0 }, { x: LINES_E0 + x1, y: LINES_N0 + y0 }, { x: LINES_E0 + x1, y: LINES_N0 + y1 }, { x: LINES_E0 + x0, y: LINES_N0 + y1 },
] }] });

test.skipIf(NO_VENV)('the GKD hazard lines for real: a line staked round the pond no drawn line holds, the drawn one as drawn, noAIL off unless set', async () => {
    const ctx = await createTestDb(seedCourse);
    const square = [LINES_E0, LINES_N0, LINES_E0 + 200, LINES_N0 + 200];
    await ctx.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: square }) }).where('id', '=', TEST_COURSE_ID).execute();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'gkd-lines-data-'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gkd-lines-out-'));
    // The inner heightmap as the DEM export leaves it: the GeoTIFF and its sidecar (the terrain's zero).
    const script = path.join(dataDir, 'write_dem.py');
    await writeFile(script, LINES_DEM);
    const tif = path.join(dir, 'linkan-inner-dem-200m.tif');
    const made = Bun.spawnSync([PIPELINE_PYTHON, script, tif], { stderr: 'pipe' });
    if (made.exitCode !== 0) throw new Error(`writing the DEM failed: ${made.stderr.toString()}`);
    await writeFile(`${tif}.json`, JSON.stringify({ crs: 'EPSG:3006', terrain: 'inner', square3006: square, sideM: 200, resolution: 0.5, minM: 9, maxM: 10 }));

    const features = new CourseFeaturesService(ctx.db);
    const pond = await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: rect(40, 40, 60, 60) });
    const held = await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water', geometry: rect(130, 130, 150, 150) });
    const drawn = await features.create({
        courseId: TEST_COURSE_ID, holeId: null, type: 'penalty_yellow', geometry: rect(125, 125, 155, 155), attributes: { noAsItLies: true },
    });

    // gspro.py reads the app database: hand it a snapshot of the in-memory one, as it reads data/app.sqlite in the app.
    const real = defaultRunner(PIPELINE_PYTHON);
    const snapshot = path.join(dataDir, 'app-snapshot.sqlite');
    const svc = new GsproExportService({
        db: ctx.db, courses: new CoursesService(ctx.db), assets: new AssetsService(ctx.db, dataDir), dataDir, pipelineDir: PIPELINE,
        runner: async (args, cwd, opts) => {
            await rm(snapshot, { force: true });
            await sql`VACUUM INTO ${snapshot}`.execute(ctx.db);
            return real([...args, '--db', snapshot], cwd, opts);
        },
    });
    await svc.setDir(TEST_COURSE_ID, dir);

    const doc = await svc.gkdLines(TEST_COURSE_ID);
    expect(doc.courseId).toBe(TEST_COURSE_ID);
    expect(doc.rule).toMatchObject({ marginM: 1, bankMaxM: 3 });
    const water = doc.lines.filter(l => l.kind === 'water');
    expect(water.map(l => [l.waterIds, l.noAsItLies])).toEqual([[[pond.id], false]]);
    // Staked outside the pond: at least the margin out, no further than the bank's limit.
    const outside = (x: number, y: number) => Math.hypot(Math.max(LINES_E0 + 40 - x, 0, x - LINES_E0 - 60), Math.max(LINES_N0 + 40 - y, 0, y - LINES_N0 - 60));
    for (const [x, y] of water[0]!.points) {
        expect(outside(x, y)).toBeGreaterThanOrEqual(0.99);
        expect(outside(x, y)).toBeLessThanOrEqual(3.01);
    }
    const penalty = doc.lines.filter(l => l.kind === 'penalty');
    expect(penalty.map(l => [l.featureId, l.type, l.noAsItLies])).toEqual([[drawn.id, 'penalty_yellow', true]]);
    expect(doc.lines.some(l => l.waterIds?.includes(held.id))).toBe(false);

    // "No as it lies" on the pond turns its automatic line's on.
    await features.update(pond.id, pond.version, { attributes: { noAsItLies: true } });
    expect((await svc.gkdLines(TEST_COURSE_ID)).lines.find(l => l.kind === 'water')!.noAsItLies).toBe(true);
}, 60_000);

/** A creek dig as the creek-digs generator stores it (reference: stream), for the creek along y = n0 + `y`. */
function creekDig(siteId: string, featureId: string, e0: number, n0: number, y: number, widthM: number, depthM: number) {
    return {
        siteId, op: 'dig' as const, origin: 'creek-digs', originRef: `feature:${featureId}`,
        params: {
            featherM: 0, reference: 'stream' as const, rimM: 1, depthM, bankSlopeDeg: 60, widthM,
            centerline: [{ x: e0 + 50, y: n0 + y }, { x: e0 + 150, y: n0 + y }],
        },
        rings: [[{ x: e0 + 50, y: n0 + y - widthM / 2 }, { x: e0 + 150, y: n0 + y - widthM / 2 }, { x: e0 + 150, y: n0 + y + widthM / 2 }, { x: e0 + 50, y: n0 + y + widthM / 2 }]],
    };
}

test('the creek depth check measures the applied DEM, or the raw one with the site\'s edits replayed while some are not applied; it leaves no files', async () => {
    let fail = false;
    const seen: Array<{ args: string[]; edits: { features: Array<{ properties: Record<string, unknown> }> } | null }> = [];
    const report = {
        format: 'golfmap-creek-depth-v1', course: { id: TEST_COURSE_ID, name: 'Linkan' },
        dem: { file: 'x', replayedEdits: null }, blenderBeds: { layers: [], beds: 0, channels: 0 },
        model: { nodeSpacingM: 1, terrainSmooth: 1.5, meshEdgeM: 1.2, phases: 4, waterAboveBedM: 0.15, minFreeboardM: 0.1, bankBandM: 1 },
        summary: { creeks: 1, shallow: 1 },
        creeks: [{
            id: 'k1', featureNo: 3, hole: null, label: 'k1', widthM: 1, lengthM: 61, farFromPlay: false, status: 'shallow',
            dig: { state: 'dug', depthM: 0.35, bankSlopeDeg: 40, outsideM: 0 }, minDepthM: 0.25,
            demDepthM: { median: 0.3, p10: 0.2 }, meshDepthM: { median: 0.15, p10: 0.1 }, bedM: 0, shallowM: 35,
            shallow: [{ fromM: 0, toM: 35, x: 530438, y: 6487145, meshDepthM: 0.1, demDepthM: 0.3 }], mouths: [],
        }],
        skipped: [],
    };
    const runner: ExportRunner = async (args) => {
        const editsFile = flag(args, '--edits');
        seen.push({ args, edits: editsFile ? JSON.parse(await readFile(editsFile, 'utf8')) : null });
        if (fail) return { code: 1, stdout: '', stderr: 'Traceback …\nerror: no such heightmap sidecar' };
        await writeFile(flag(args, '--out')!, JSON.stringify(report));
        return {
            code: 0,
            stdout: 'Creek depth in the meshes: Linkan, 1 creek(s) - 1 shallow (DEM: dem-edited.tif)\n'
                + '  shallow  k1               1.0 m wide, 61 m: meshes 0.15 m (DEM 0.30 m, dug 0.35 m)\n'
                + `  wrote ${flag(args, '--out')}\n`,
            stderr: '',
        };
    };
    const t = await setup(runner);
    await expect(t.svc.creekDepth(TEST_COURSE_ID)).rejects.toThrow(/no built map/);
    const sources = await buildSite(t, ['dem.tif', 'dem-edited.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    const sidecar = path.join(dir, 'linkan-inner-dem-2050m.tif.json');
    await writeFile(sidecar, '{}');

    // No terrain edits: the DEM Apply to terrain wrote, as it is.
    const applied = await t.svc.creekDepth(TEST_COURSE_ID);
    expect(applied.demSource).toBe('applied');
    expect(applied.creeks[0]!.shallow![0]).toMatchObject({ x: 530438, y: 6487145 });
    expect(applied.summary).toEqual({ creeks: 1, shallow: 1 });
    // The printed lines as printed (indented per creek), without the temp file it wrote.
    expect(applied.lines).toEqual([
        'Creek depth in the meshes: Linkan, 1 creek(s) - 1 shallow (DEM: dem-edited.tif)',
        '  shallow  k1               1.0 m wide, 61 m: meshes 0.15 m (DEM 0.30 m, dug 0.35 m)',
    ]);
    let args = seen[0]!.args;
    expect(args.slice(0, 2)).toEqual([path.join('/pipeline', 'gspro.py'), 'creek-depth']);
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--sidecar')).toBe(sidecar);
    expect(flag(args, '--dem')).toBe(path.join(sources, 'dem-edited.tif'));
    expect(args).not.toContain('--edits');
    expect(args).not.toContain('--only');
    expect(existsSync(path.dirname(flag(args, '--out')!))).toBe(false);   // read-only: the temp report is gone

    // A creek dug after the last Apply to terrain: the raw DEM, every enabled edit replayed onto it.
    const anHourAgo = new Date(Date.now() - 3600_000);
    await utimes(path.join(sources, 'dem-edited.tif'), anHourAgo, anHourAgo);
    const edits = new TerrainEditsService(t.db);
    await edits.create(creekDig(SITE_ID, 'k1', 529400, 6487000, 100, 1, 0.35));
    await edits.create({
        siteId: SITE_ID, op: 'plane', params: { featherM: 4, flat: true }, origin: 'building-pads', originRef: 'osm:way/1',
        rings: [[{ x: 529500, y: 6486700 }, { x: 529530, y: 6486700 }, { x: 529530, y: 6486740 }]],
    });
    seen.length = 0;
    const replayed = await t.svc.creekDepth(TEST_COURSE_ID, { only: [' k1', '', '4a8c'] });
    expect(replayed.demSource).toBe('replayed');
    args = seen[0]!.args;
    expect(flag(args, '--dem')).toBe(path.join(sources, 'dem.tif'));
    expect(seen[0]!.edits!.features.map(f => `${f.properties.op} ${f.properties.reference ?? ''}`.trim()).sort()).toEqual(['dig stream', 'plane']);
    expect(flag(args, '--only')).toBe('k1,4a8c');
    expect(existsSync(path.dirname(flag(args, '--edits')!))).toBe(false);

    // Applied since: the edited DEM again.
    const soon = new Date(Date.now() + 5000);
    await utimes(path.join(sources, 'dem-edited.tif'), soon, soon);
    expect((await t.svc.creekDepth(TEST_COURSE_ID)).demSource).toBe('applied');

    // No edited DEM at all: the edits replayed onto the raw one.
    await rm(path.join(sources, 'dem-edited.tif'));
    seen.length = 0;
    expect((await t.svc.creekDepth(TEST_COURSE_ID)).demSource).toBe('replayed');
    expect(seen[0]!.edits!.features).toHaveLength(2);

    // A failed run says so with the pipeline's last words, and still cleans up.
    fail = true;
    seen.length = 0;
    await expect(t.svc.creekDepth(TEST_COURSE_ID)).rejects.toThrow(/Creek depth check failed: .*no such heightmap sidecar/);
    expect(existsSync(path.dirname(flag(seen[0]!.args, '--out')!))).toBe(false);
});

/** A 200 m inner square: flat ground at 20 m; `dug` adds a 4 m wide creek bed 0.6 m deep along y = 100. */
const DEPTH_E0 = 510000, DEPTH_N0 = 6510000;
const DEPTH_DEM = `
import sys, numpy as np, rasterio
from rasterio.transform import from_origin
E0, N0, RES, SIDE = ${DEPTH_E0}.0, ${DEPTH_N0}.0, 0.5, 200.0
n = int(SIDE / RES)
rows, cols = np.mgrid[0:n, 0:n]
x, y = (cols + 0.5) * RES, SIDE - (rows + 0.5) * RES
z = np.full((n, n), 20.0)
if sys.argv[2] == "dug":
    d_in = 2.0 - np.abs(y - 100.0)
    z -= np.where((d_in > 0) & (x >= 50) & (x <= 150), np.clip(d_in * np.tan(np.radians(60.0)), 0.0, 0.6), 0.0)
with rasterio.open(sys.argv[1], "w", driver="GTiff", width=n, height=n, count=1, dtype="float32", crs="EPSG:3006",
                   transform=from_origin(E0, N0 + SIDE, RES, RES), nodata=-9999) as dst:
    dst.write(z.astype(np.float32), 1)
`;

test.skipIf(NO_VENV)('the creek depth check for real: a dug creek deep enough, one drawn after the digs not dug; an unapplied dig is replayed', async () => {
    const ctx = await createTestDb(seedCourse);
    const square = [DEPTH_E0, DEPTH_N0, DEPTH_E0 + 200, DEPTH_N0 + 200];
    await ctx.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: square }) }).where('id', '=', TEST_COURSE_ID).execute();
    await ctx.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await ctx.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'creek-depth-data-'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'creek-depth-out-'));
    const sources = path.join(dataDir, 'sources', SITE_ID);
    await mkdir(sources, { recursive: true });
    const script = path.join(dataDir, 'write_dem.py');
    await writeFile(script, DEPTH_DEM);
    const writeDem = (file: string, kind: 'flat' | 'dug') => {
        const made = Bun.spawnSync([PIPELINE_PYTHON, script, path.join(sources, file), kind], { stderr: 'pipe' });
        if (made.exitCode !== 0) throw new Error(`writing ${file} failed: ${made.stderr.toString()}`);
    };
    // The inner heightmap's sidecar as the DEM export leaves it: its square, grid and the terrain's zero.
    await writeFile(path.join(dir, 'linkan-inner-dem-200m.tif.json'),
        JSON.stringify({ crs: 'EPSG:3006', terrain: 'inner', square3006: square, sideM: 200, resolution: 0.5, minM: 10, maxM: 20, raw: { size: 401 } }));

    const features = new CourseFeaturesService(ctx.db);
    const line = (y: number, widthM: number) => ({ crs: 'EPSG:3006', rings: [], centerline: {
        points: [{ x: DEPTH_E0 + 50, y: DEPTH_N0 + y }, { x: DEPTH_E0 + 150, y: DEPTH_N0 + y }], widthM } });
    const dug = await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water_creek', geometry: line(100, 4) });
    const undug = await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water_creek', geometry: line(150, 1.5) });
    // The dig stored first, then Apply to terrain wrote the edited DEM with it.
    await new TerrainEditsService(ctx.db).create(creekDig(SITE_ID, dug.id, DEPTH_E0, DEPTH_N0, 100, 4, 0.6));
    writeDem('dem.tif', 'flat');
    writeDem('dem-edited.tif', 'dug');

    const real = defaultRunner(PIPELINE_PYTHON);
    const snapshot = path.join(dataDir, 'app-snapshot.sqlite');
    const svc = new GsproExportService({
        db: ctx.db, courses: new CoursesService(ctx.db), assets: new AssetsService(ctx.db, dataDir), dataDir, pipelineDir: PIPELINE,
        runner: async (args, cwd, opts) => {
            await rm(snapshot, { force: true });
            await sql`VACUUM INTO ${snapshot}`.execute(ctx.db);
            return real([...args, '--db', snapshot], cwd, opts);
        },
    });
    await svc.setDir(TEST_COURSE_ID, dir);

    const report = await svc.creekDepth(TEST_COURSE_ID);
    expect(report.format).toBe('golfmap-creek-depth-v1');
    expect(report.demSource).toBe('applied');
    expect(report.dem).toEqual({ file: path.join(sources, 'dem-edited.tif'), replayedEdits: null });
    expect(report.summary).toEqual({ creeks: 2, ok: 1, 'not-dug': 1 });
    const byId = new Map(report.creeks.map(c => [c.id, c]));
    expect(byId.get(dug.id)).toMatchObject({ status: 'ok', dig: { state: 'dug', depthM: 0.6 }, shallow: [] });
    expect(byId.get(dug.id)!.meshDepthM!.median).toBeGreaterThan(byId.get(dug.id)!.minDepthM!);
    expect(byId.get(undug.id)).toMatchObject({ status: 'not-dug', dig: { state: 'none' } });
    expect(byId.get(undug.id)!.shallow!.length).toBeGreaterThan(0);
    expect(report.lines[0]).toMatch(/^Creek depth in the meshes: Linkan, 2 creek\(s\) - 1 ok, 1 not dug/);
    expect(report.lines.some(l => /^ {2}not-dug /.test(l))).toBe(true);

    // The edited DEM older than the dig: the raw DEM, the dig replayed onto it, measured the same way.
    const anHourAgo = new Date(Date.now() - 3600_000);
    await utimes(path.join(sources, 'dem-edited.tif'), anHourAgo, anHourAgo);
    const again = await svc.creekDepth(TEST_COURSE_ID, { only: [dug.id.slice(0, 8)] });
    expect(again.demSource).toBe('replayed');
    expect(again.dem).toEqual({ file: path.join(sources, 'dem.tif'), replayedEdits: 1 });
    expect(again.creeks.map(c => c.id)).toEqual([dug.id]);
    expect(again.creeks[0]!.demDepthM!.median).toBeGreaterThan(0.3);
}, 60_000);

/** A drawn road: a centerline `path` of the test course. */
function centerlineRoad(features: CourseFeaturesService, attributes: Record<string, string> = { surface: 'gravel' }) {
    return features.create({
        courseId: TEST_COURSE_ID, holeId: null, type: 'path', attributes,
        geometry: { crs: 'EPSG:3006', rings: [], centerline: { points: [{ x: 529400, y: 6487400 }, { x: 529460, y: 6487400 }], widthM: 3 } },
    });
}

test('the R.A.M. roads export takes the newest raw photo (never the cleaned one), no heightmap, and is skipped until a feature changes', async () => {
    const w = writingRunner();
    const t = await setup(w.runner);
    const sourcesDir = await buildSite(t, ['ortho-orto-l2-2023.tif', 'ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.cleaned.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'ramroads' });
    expect(job.label).toBe('R.A.M. roads');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const res = t.svc.job(job.id).result!;
    expect(res.path).toBe(path.join(dir, 'linkan-inner-ramroads.json'));
    expect(w.commands()).toEqual(['ramroads']);
    const args = w.calls[0]!;
    expect(flag(args, '--square-3006')).toBe(squareArg(GEOREF_INNER));
    expect(flag(args, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(args, '--ortho')).toBe(path.join(sourcesDir, 'ortho-orto-l2-2025.tif'));
    expect(args).not.toContain('--dem');
    // The roads run on past the inner square onto the outer terrain instead of fading out at its border.
    expect(flag(args, '--reach-m')).toBe(String(RAM_ROADS_REACH_M));
    expect(ramRoadsExportFileName('Vreta Kloster')).toBe('vreta-kloster-inner-ramroads.json');

    // Nothing it reads has changed: skipped. A road set to R.A.M. renders it again.
    w.calls.length = 0;
    expect((await t.svc.exportRamRoads(TEST_COURSE_ID)).report[0]).toMatch(/^unchanged: /);
    await centerlineRoad(new CourseFeaturesService(t.db), { surface: 'gravel', render: 'ram' });
    await t.svc.exportRamRoads(TEST_COURSE_ID);
    expect(w.commands()).toEqual(['ramroads']);
});

test('the R.A.M. roads export without a raw photo passes no --ortho; without a built map it is refused', async () => {
    const w = writingRunner();
    const t = await setup(w.runner);
    await expect(t.svc.exportRamRoads(TEST_COURSE_ID)).rejects.toThrow(/no built map/);
    await buildSite(t, ['ortho-orto-l2-2025.cleaned.tif']);
    await t.svc.setDir(TEST_COURSE_ID, await mkdtemp(path.join(os.tmpdir(), 'gspro-out-')));
    await t.svc.exportRamRoads(TEST_COURSE_ID);
    expect(w.calls[0]).not.toContain('--ortho');
});

test('the R.A.M. roads proposal runs gspro.py ramroads-propose and returns its JSON; a failing run is a 409', async () => {
    const proposal = {
        format: 'golfmap-ramroads-proposal-v1', course: { id: TEST_COURSE_ID, name: 'Linkan' }, rules: { minDistanceM: 45 },
        candidates: [{ featureId: 'f1', featureNo: 12, surface: 'gravel', widthM: 3, lengthM: 220, distanceToPlayM: 61, touches: [14], reason: 'gravel, 61 m from play, meets path 14 at its ends' }],
        already: [7], rejected: [{ featureNo: 3, featureId: 'f3', reason: '4 m from play (tee 9)' }],
    };
    const calls: string[][] = [];
    let code = 0;
    const t = await setup(async (args) => {
        calls.push(args);
        if (code === 0) await writeFile(flag(args, '--out')!, JSON.stringify(proposal));
        return { code, stdout: '', stderr: code ? 'Traceback: boom' : '' };
    });
    expect(await t.svc.proposeRamRoads(TEST_COURSE_ID, { minDistanceM: 45 })).toEqual(proposal);
    expect(calls[0]![1]).toBe('ramroads-propose');
    expect(flag(calls[0]!, '--course')).toBe(TEST_COURSE_ID);
    expect(flag(calls[0]!, '--min-distance-m')).toBe('45');
    // The temporary answer file is gone again.
    expect(existsSync(flag(calls[0]!, '--out')!)).toBe(false);
    await t.svc.proposeRamRoads(TEST_COURSE_ID);
    expect(calls[1]).not.toContain('--min-distance-m');
    code = 1;
    await expect(t.svc.proposeRamRoads(TEST_COURSE_ID)).rejects.toBeInstanceOf(ConflictError);
    await expect(t.svc.proposeRamRoads(TEST_COURSE_ID, { minDistanceM: -1 })).rejects.toBeInstanceOf(ConflictError);
});

test('setRoadRender sets and clears render on the course\'s centerline paths; a dry run writes nothing, one bad id writes nothing', async () => {
    const t = await setup(recordingRunner().runner);
    const features = new CourseFeaturesService(t.db);
    const a = await centerlineRoad(features);
    const b = await centerlineRoad(features, { surface: 'asphalt', render: 'ram' });
    const ring = { points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] };
    const polygonPath = await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'path', geometry: { crs: 'EPSG:3006', rings: [ring] } });
    const bunker = await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'bunker', geometry: { crs: 'EPSG:3006', rings: [ring] } });

    const dry = await t.svc.setRoadRender(TEST_COURSE_ID, [a.id, b.id], 'ram', { dryRun: true });
    expect(dry).toEqual({ render: 'ram', changed: [a.id], unchanged: [b.id], dryRun: true });
    expect((await features.findById(a.id)).attributes).toEqual({ surface: 'gravel' });

    expect((await t.svc.setRoadRender(TEST_COURSE_ID, [a.id, b.id], 'ram')).changed).toEqual([a.id]);
    expect((await features.findById(a.id)).attributes).toEqual({ surface: 'gravel', render: 'ram' });

    // Back to OPCD clears the key.
    expect((await t.svc.setRoadRender(TEST_COURSE_ID, [b.id], 'opcd')).changed).toEqual([b.id]);
    expect((await features.findById(b.id)).attributes).toEqual({ surface: 'asphalt' });

    // A path with no centerline, a bunker or another course's id fails the whole call.
    await expect(t.svc.setRoadRender(TEST_COURSE_ID, [b.id, polygonPath.id], 'ram')).rejects.toThrow(/centerline/);
    await expect(t.svc.setRoadRender(TEST_COURSE_ID, [bunker.id], 'ram')).rejects.toThrow(/not a path/);
    await expect(t.svc.setRoadRender(TEST_COURSE_ID, ['nope'], 'ram')).rejects.toBeInstanceOf(NotFoundError);
    expect((await features.findById(b.id)).attributes).toEqual({ surface: 'asphalt' });
});


// --- Update terrain's push into Unity (a stand-in editor on the bridge protocol) ---

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
        await buildSite(t, ['ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.cleaned.tif']);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);

        expect(() => describeRequest({ kind: 'unity-ortho' })).toThrow(/needs a source/);
        // No tint asked for: the -meshes file is written anyway, it is the one Unity takes.
        const job = await t.svc.start(TEST_COURSE_ID, { kind: 'unity-ortho', source: 'ortho-orto-l2-2025.cleaned.tif', removeBuildings: true });
        expect(job.label).toBe('inner orthophoto onto the Unity course meshes');
        await t.svc.whenIdle(TEST_COURSE_ID);
        const res = t.svc.job(job.id);
        expect(res.error).toBeNull();
        expect(calls.map(c => c.args[1])).toEqual(['ortho']);
        const meshes = 'linkan-orto-l2-2025-cleaned-clean-8192-meshes.jpg';
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


// --- Update vegetation (generators -> zones export -> Unity, the Arborist file) ---

/** The test course has no Arborist species file under the docs root: the Arborist half says so in one line. */
const NOT_ARBORIST = `Arborist: not used by this course (no ${path.join('/pipeline', '..', 'docs', 'gspro', 'linkan', 'arborist-species.json')})`;

/** A runner standing in for the vegetation generators, `gspro.py zones` and `zones-patch`: each writes its --out (the patch its --result). */
function vegetationRunner(zones: Record<string, Record<string, unknown>[]>) {
    const runs: string[][] = [];
    const runner: ExportRunner = async args => {
        runs.push(args);
        if (args[1] === 'zones-patch') {
            await writeFile(flag(args, '--result')!, JSON.stringify({ format: 'unity-zones-patch-v1', changed: true, textures: ['linkan-inner-zones-0.png'] }));
            return { code: 0, stdout: 'Patched linkan-inner-zones.json: 1 zone(s), window 40x40 px (20 x 20 m)\n', stderr: '' };
        }
        const out = args[args.indexOf('--out') + 1]!;
        const script = path.basename(args[0]!);
        const sources: Record<string, string> = { 'grass_zones.py': 'tall-grass', 'woodland_floor_zones.py': 'woodland-floor', 'rock_shore_zones.py': 'rock-shore', 'creek_bank_zones.py': 'creek-bank' };
        if (script in sources) {
            const source = sources[script]!;
            zones[script] ??= [];   // a generator the test says nothing about finds nothing to plant
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
            expect(job.label).toBe('inner vegetation, planted for GSPro');
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
                expect(report.at(-3)).toBe(NOT_ARBORIST);
                expect(report.at(-2)).toBe('Save the scene in Unity to keep it.');
                // Where the time went: every step, then the whole.
                expect(report.at(-1)).toMatch(/^Time: tall rough \d+\.\d s, woodland floor \d+\.\d s, rock shore \d+\.\d s, creek banks \d+\.\d s, zones export \d+\.\d s, Unity import \+ apply \d+\.\d s, Arborist \d+\.\d s - \d+\.\d s in all$/);
            } else {
                // Nothing they read changed: no generator runs, the zones stay as they were, and so do the masks.
                const report = done.result!.report;
                expect(report).toContainEqual(expect.stringMatching(/^tall rough: not run - nothing it reads changed since its last run \(.+\); its 2 zones stay$/));
                expect(report).toContainEqual(expect.stringMatching(/^creek banks: not run - .*; its 1 zones stay$/));
                expect(report).toContain('inner: no patch - no zone changed since linkan-inner-zones.json');
                expect(report.at(-1)).toMatch(/^Time: tall rough unchanged, woodland floor unchanged, rock shore unchanged, creek banks unchanged, zones export/);
            }
        }
        // Generators in stack order, then the zones export; each gets the course's inputs. The second
        // round runs nothing: the generators' inputs and the zones are as the first left them.
        expect(runs.map(a => path.basename(a[0]!) + (a[1] === 'zones' ? ' zones' : ''))).toEqual([
            'grass_zones.py', 'woodland_floor_zones.py', 'rock_shore_zones.py', 'creek_bank_zones.py', 'gspro.py zones',
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

test('vegetation after a few zone edits: no generator whose inputs are unchanged runs, only the changed zones are patched into Unity; changed zone types take the full path', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { calls, server } = fakeUnity(exportDir, discovery, () => Response.json({ ok: true, result: {
        status: 'Patched 1 mask texture(s) for 1 zone(s), respawned 20 x 20 m in 300 ms. Save the scene.', system: 'Inner VSP', items: [{}], log: [],
    } }));
    const planted: Record<string, Record<string, unknown>[]> = {
        'grass_zones.py': [{ zoneType: 'rough_tall' }, { zoneType: 'rough_tall', weight: 0.5 }],
        'woodland_floor_zones.py': [{ zoneType: 'woodland_floor' }],
        'rock_shore_zones.py': [{ zoneType: 'rock_shore', zoneVariant: 'scrub' }],
        'creek_bank_zones.py': [{ zoneType: 'creek_bank', zoneVariant: 'lush' }],
    };
    const { runs, runner } = vegetationRunner(planted);
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await buildSite(t, []);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-surfaces.json'), '{}');
        await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');
        const features = new CourseFeaturesService(t.db);
        const ring = (dx: number) => ({ crs: 'EPSG:3006' as const, rings: [{ points: [{ x: 529400, y: 6487400 }, { x: 529420 + dx, y: 6487400 }, { x: 529420, y: 6487420 }] }] });
        let drawn = await features.create({
            courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone', geometry: ring(0),
            attributes: { zoneType: 'rough_tall', zoneVariant: '', weight: 1, feather: 2, noise: 0 },
        });
        const plant = async () => {
            runs.length = 0;
            calls.length = 0;
            const job = await t.svc.start(TEST_COURSE_ID, { kind: 'vegetation', terrain: 'inner' });
            await t.svc.whenIdle(TEST_COURSE_ID);
            const done = t.svc.job(job.id);
            expect(done.error).toBeNull();
            return done.result!.report;
        };
        const ran = () => runs.map(a => a[1] === 'zones' || a[1] === 'zones-patch' ? `gspro.py ${a[1]}` : path.basename(a[0]!));
        const intoUnity = () => calls.map(c => c.command).filter(c => c !== 'golfmap.course');
        // The first planting: everything, the whole masks, the whole import.
        await plant();
        expect(ran()).toEqual(['grass_zones.py', 'woodland_floor_zones.py', 'rock_shore_zones.py', 'creek_bank_zones.py', 'gspro.py zones']);
        expect(intoUnity()).toEqual(['golfmap.zones.import', 'golfmap.grass.apply']);

        // A drawn tall rough zone reshaped: no generator reads it, and only it is patched.
        drawn = await features.update(drawn.id, drawn.version, { geometry: ring(5) });
        let report = await plant();
        expect(ran()).toEqual(['gspro.py zones-patch']);
        expect(flag(runs[0]!, '--ids')).toBe(drawn.id);
        expect(flag(runs[0]!, '--zones-json')).toBe(path.join(exportDir, 'linkan-inner-zones.json'));
        expect(calls.filter(c => c.command !== 'golfmap.course')).toEqual([{
            command: 'golfmap.zones.patch',
            args: { terrain: 'inner', patch: path.join(exportDir, 'linkan-inner-zones-patch.json'), package: 'GolfMap lower vegetation' },
        }]);
        expect(report).toContain('inner: 1 zone(s) edited, 0 new, 0 removed since linkan-inner-zones.json - patched instead of rasterizing every mask');
        expect(report).toContain('Unity (linkan_v4): Patched 1 mask texture(s) for 1 zone(s), respawned 20 x 20 m in 300 ms. Save the scene.');
        expect(report.at(-2)).toBe('Save the scene in Unity to keep it.');
        expect(report.at(-1)).toMatch(/^Time: tall rough unchanged, woodland floor unchanged, rock shore unchanged, creek banks unchanged, zones patch \d+\.\d s, Unity patch \d+\.\d s, Arborist \d+\.\d s - \d+\.\d s in all$/);

        // Switched to a creek section: the tall rough and the creek banks read those, the woodland
        // floor does not. The banks come out different; the tall rough the same, under new ids.
        planted['creek_bank_zones.py'] = [{ zoneType: 'creek_bank', zoneVariant: 'lush', weight: 0.5 }];
        drawn = await features.update(drawn.id, drawn.version, { attributes: { zoneType: 'creek_bank', zoneVariant: 'lush', weight: 1, feather: 2, noise: 0 } });
        report = await plant();
        expect(ran()).toEqual(['grass_zones.py', 'creek_bank_zones.py', 'gspro.py zones-patch']);
        expect(report).toContainEqual(expect.stringMatching(/^woodland floor: not run - nothing it reads changed since its last run/));
        expect(report).toContainEqual(expect.stringMatching(/^rock shore: not run - nothing it reads changed since its last run/));
        // The skipped woodland floor and rock shore went back above the new tall rough: the stack is as a full run leaves it.
        const generated = (await features.listByCourse(TEST_COURSE_ID)).filter(f => f.generated).sort((a, b) => a.sortOrder - b.sortOrder);
        expect(generated.map(f => f.source)).toEqual(['tall-grass', 'tall-grass', 'woodland-floor', 'rock-shore', 'creek-bank']);
        // Patched: the drawn zone and the new banks; the tall rough the patch matches by content itself.
        expect(flag(runs[2]!, '--ids')!.split(',').sort()).toEqual([drawn.id, generated[4]!.id].sort());
        expect(report).toContain('inner: 1 zone(s) edited, 1 new, 1 removed since linkan-inner-zones.json - patched instead of rasterizing every mask');
        expect(intoUnity()).toEqual(['golfmap.zones.patch']);

        // A zone type's items changed: the channels may move, so the whole masks and the whole import.
        const types = new ZoneTypesService(t.db);
        const floor = (await types.listByCourse(TEST_COURSE_ID)).find(z => z.key === 'woodland_floor')!;
        await types.update(floor.id, { items: [{ item: 'Bilberry', minDensity: 0, maxDensity: 1 }] });
        drawn = await features.update(drawn.id, drawn.version, { geometry: ring(8) });
        report = await plant();
        expect(ran()).toEqual(['grass_zones.py', 'creek_bank_zones.py', 'gspro.py zones']);
        expect(report).toContain('inner: no patch - the zone types changed since linkan-inner-zones.json');
        expect(intoUnity()).toEqual(['golfmap.zones.import', 'golfmap.grass.apply']);
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
    expect(res.report).toContain("woodland floor: not planted (no surface map from Unity - run golfmap.surfaces.export in the course's Unity project)");
    expect(res.report).toContain("creek banks: not planted (no surface map from Unity - run golfmap.surfaces.export in the course's Unity project)");
    expect(res.report.at(-3)).toMatch(/^Unity: not open, zones exported only - no open Unity editor imports from .* \(none is open\)/);
    expect(res.report.at(-2)).toBe(NOT_ARBORIST);
    expect(res.report.at(-1)).toMatch(/^Time: /);
});

test("vegetation for the outer terrain: its zones file only - no generators to undo the inner's zones, nothing into the course's VSP", async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const unity: string[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            unity.push(command);
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder: exportDir } } });
            return Response.json({ ok: true, result: { status: 'Imported 3 zone groups', system: 'Inner VSP', items: [{}], log: [] } });
        },
    });
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({ pid: process.pid, port: server.port!, token: 'tok', projectPath: 'D:/unity/linkan', projectName: 'linkan_v4', unityVersion: '', started: '' }));
    const { runs, runner } = vegetationRunner({ 'grass_zones.py': [{ zoneType: 'rough_tall' }, { zoneType: 'rough_tall' }, { zoneType: 'rough_tall' }] });
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await buildSite(t, []);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-surfaces.json'), '{}');
        await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');
        await writeFile(path.join(exportDir, `linkan-outer-dem-${OUTER_TERRAIN_SIDE_M}m.tif.json`), '{}');
        await t.svc.plantVegetation(TEST_COURSE_ID, 'inner', { arborist: false });
        const tallRough = async () => (await new CourseFeaturesService(t.db).listByCourse(TEST_COURSE_ID)).filter(f => f.source === 'tall-grass').length;
        expect(await tallRough()).toBe(3);
        runs.length = 0;
        unity.length = 0;

        // The outer has no surface map: a generator run for it would replace the inner's tall rough.
        const res = await t.svc.plantVegetation(TEST_COURSE_ID, 'outer', { save: true });
        expect(runs.map(a => [path.basename(a[0]!), a[1]])).toEqual([['gspro.py', 'zones']]);
        expect(flag(runs[0]!, '--terrain')).toBe('outer');
        expect(res.path).toBe(path.join(exportDir, 'linkan-outer-zones.json'));
        expect(res.report[0]).toBe(OUTER_VEGETATION_IS_ARBORIST);
        expect(unity).toEqual([]);
        expect(await tallRough()).toBe(3);
        // A dry run (the CLI's) writes nothing for it.
        runs.length = 0;
        expect((await t.svc.plantVegetation(TEST_COURSE_ID, 'outer', { dryRun: true })).report).toEqual([OUTER_VEGETATION_IS_ARBORIST]);
        expect(runs).toHaveLength(0);
    } finally {
        server.stop(true);
    }
});

test("vegetation: the course's own rules file gives its generators their flags, the CLI's tuning comes after and wins, a typo stops the run", async () => {
    const docs = await mkdtemp(path.join(os.tmpdir(), 'gspro-docs-'));
    const rules = path.join(docs, 'linkan', 'vegetation-rules.json');
    await mkdir(path.dirname(rules), { recursive: true });
    await writeFile(rules, JSON.stringify({
        format: 'golfmap-vegetation-rules-v1', _comment: 'half as thick beyond 10 m',
        generators: { 'tall-grass': { 'far-start': 8, 'far-ramp': 4, 'far-weight': 0.5, _why: 'frame time' } },
    }));
    const { runs, runner } = vegetationRunner({ 'grass_zones.py': [{ zoneType: 'rough_tall' }] });
    const t = await setup(runner, { courseDocsRoot: docs });
    await t.svc.setDir(TEST_COURSE_ID, await mkdtemp(path.join(os.tmpdir(), 'gspro-out-')));

    const res = await t.svc.plantVegetation(TEST_COURSE_ID, 'inner', {
        exportZones: false, extraArgs: { 'tall-grass': ['--far-weight', '0.6'] },
    });
    const tall = runs.find(a => path.basename(a[0]!) === 'grass_zones.py')!;
    expect(tall.slice(tall.indexOf('--far-start'))).toEqual(['--far-start', '8', '--far-ramp', '4', '--far-weight', '0.5', '--far-weight', '0.6']);
    expect(res.report).toContain(`tall rough: the course's rules (${rules}): --far-start 8 --far-ramp 4 --far-weight 0.5`);
    expect(runs.some(a => path.basename(a[0]!) === 'creek_bank_zones.py' && a.includes('--far-start'))).toBe(false);

    await writeFile(rules, JSON.stringify({ format: 'golfmap-vegetation-rules-v1', generators: { 'tall-gras': { 'far-start': 8 } } }));
    await expect(t.svc.plantVegetation(TEST_COURSE_ID, 'inner', { exportZones: false }))
        .rejects.toThrow(`${rules}: no vegetation generator 'tall-gras' (have: tall-grass, woodland-floor, rock-shore, creek-bank)`);
});

test('the zones against the masks: changed by content whatever the id, an edit under its own id, removed ones, and the stack order', () => {
    const rendered = [{ id: 'a', content: 'A' }, { id: 'b', content: 'B' }, { id: 'c', content: 'C' }, { id: 'd', content: 'D' }];
    // A generator re-run: the same zones under new ids. Nothing to patch.
    expect(diffZoneContents(rendered, [{ id: 'a2', content: 'A' }, { id: 'b2', content: 'B' }, { id: 'c', content: 'C' }, { id: 'd', content: 'D' }]))
        .toEqual({ changed: [], edited: 0, removed: 0, sameOrder: true });
    // b edited, d deleted, e drawn.
    expect(diffZoneContents(rendered, [{ id: 'a', content: 'A' }, { id: 'b', content: 'B2' }, { id: 'c', content: 'C' }, { id: 'e', content: 'E' }]))
        .toEqual({ changed: ['b', 'e'], edited: 1, removed: 1, sameOrder: true });
    // c moved below a: the zones both have are in another order.
    expect(diffZoneContents(rendered, [{ id: 'c', content: 'C' }, { id: 'a', content: 'A' }, { id: 'b', content: 'B' }, { id: 'd', content: 'D' }]).sameOrder).toBe(false);
    // Two identical zones count as two.
    expect(diffZoneContents([{ id: 'a', content: 'A' }], [{ id: 'a', content: 'A' }, { id: 'x', content: 'A' }]).changed).toEqual(['x']);
});

test('vegetation generators: a run from one generator re-runs every one after it (the zone stack order holds)', () => {
    expect(generatorsFrom(undefined).map(g => g.source)).toEqual(['tall-grass', 'woodland-floor', 'rock-shore', 'creek-bank']);
    expect(generatorsFrom('woodland-floor').map(g => g.source)).toEqual(['woodland-floor', 'rock-shore', 'creek-bank']);
    expect(generatorsFrom('rock-shore').map(g => g.source)).toEqual(['rock-shore', 'creek-bank']);
    expect(generatorsFrom('creek-bank').map(g => g.source)).toEqual(['creek-bank']);
    expect(() => generatorsFrom('ferns')).toThrow("No vegetation generator 'ferns' (have: tall-grass, woodland-floor, rock-shore, creek-bank)");
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
        expect(job.label).toBe('2 vegetation zone(s) updated for GSPro');
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
            NOT_ARBORIST,
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
        expect(res.report.at(-1)).toBe('Nothing changed in the masks, so nothing to take into Unity or the Arborist file');
        expect(calls.map(c => c.command)).toEqual(['golfmap.course']);
    } finally {
        server.stop(true);
    }
});

test('vegetation-update: changed outer masks stay in the export (the outer is Arborist\'s); only the inner go to Unity', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { calls, server } = fakeUnity(exportDir, discovery);
    try {
        const outerOnly = patchRunner({ inner: false, outer: true });
        const t = await setup(outerOnly.runner, { unityBridge: defaultUnityBridge(discovery) });
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
        await writeFile(path.join(exportDir, 'linkan-outer-zones.json'), '{}');
        const res = await t.svc.updateZones(TEST_COURSE_ID, ['z1']);
        expect(res.report.slice(-2)).toEqual([
            `outer: the masks are patched in the export only - ${OUTER_VEGETATION_IS_ARBORIST}`,
            'Nothing changed in the inner masks, so nothing to take into Unity or the Arborist file',
        ]);
        expect(calls.map(c => c.command)).toEqual(['golfmap.course']);

        const both = await setup(patchRunner({ inner: true, outer: true }).runner, { unityBridge: defaultUnityBridge(discovery) });
        await both.svc.setDir(TEST_COURSE_ID, exportDir);
        await both.svc.updateZones(TEST_COURSE_ID, ['z1']);
        expect(calls.filter(c => c.command === 'golfmap.zones.patch').map(c => c.args.terrain)).toEqual(['inner']);
    } finally {
        server.stop(true);
    }
});

test('vegetation-update asks before it plants the whole course; plantIfNeeded is the yes', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    // One runner for both halves: the generators and `gspro.py zones` of a planting, and a
    // `zones-patch` whose channels have moved (ZONES_LAYOUT_CHANGED_EXIT).
    const veg = vegetationRunner({ 'grass_zones.py': [{ zoneType: 'rough_tall' }] });
    const moved = patchRunner({}, ZONES_LAYOUT_CHANGED_EXIT);
    const runner: ExportRunner = (args, cwd, opts) => (args[1] === 'zones-patch' ? moved.runner : veg.runner)(args, cwd, opts);
    const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
    await buildSite(t, []);
    await t.svc.setDir(TEST_COURSE_ID, exportDir);
    await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');
    // The generators that need a surface map from Unity are reported, not run: the tall rough and the zones export are.
    const planting = ['grass_zones.py', 'gspro.py'];

    // No zones export to patch: the only way on is the whole planting (minutes), so it asks — and writes nothing.
    const asked = await t.svc.updateZones(TEST_COURSE_ID, ['z1']);
    expect(asked.needsPlanting).toBe(true);
    expect(asked.reason).toMatch(/^There is no vegetation zones export in .* yet to patch, so only the whole planting can follow: nothing was updated\. Run Update vegetation — it plants every generator again and rewrites the Arborist file \(minutes\)\.$/);
    expect(asked.report).toEqual([asked.reason!]);
    expect(veg.runs).toHaveLength(0);
    expect(moved.runs).toHaveLength(0);
    expect(existsSync(path.join(exportDir, 'linkan-inner-zones.json'))).toBe(false);
    // The same through a job, which is what the panel polls.
    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'vegetation-update', zoneIds: ['z1'] });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(job.id)).toMatchObject({ status: 'succeeded', error: null });
    expect(t.svc.job(job.id).result!.needsPlanting).toBe(true);
    expect(veg.runs).toHaveLength(0);

    // With the yes, the planting that makes the masks runs, Unity open or not.
    const planted = await t.svc.updateZones(TEST_COURSE_ID, ['z1'], { plantIfNeeded: true });
    expect(planted.needsPlanting).toBeUndefined();
    expect(planted.report[0]).toMatch(/^There is no vegetation zones export in .* yet to patch: the whole planting ran instead of a patch$/);
    expect(veg.runs.map(a => path.basename(a[0]!))).toEqual(planting);
    expect(moved.runs).toHaveLength(0);
    expect(existsSync(path.join(exportDir, 'linkan-inner-zones.json'))).toBe(true);

    // With masks there, Unity has to be open: patching them without it would leave the scene behind.
    veg.runs.length = 0;
    await expect(t.svc.updateZones(TEST_COURSE_ID, ['z1'])).rejects.toThrow(/Open the course's Unity project first: no open Unity editor imports from/);
    expect(moved.runs).toHaveLength(0);
    expect(veg.runs).toHaveLength(0);

    const { calls, server } = fakeUnity(exportDir, discovery);
    try {
        // Every terrain's channels may have moved: again it asks, with the terrain's own line kept.
        const stale = await t.svc.updateZones(TEST_COURSE_ID, ['z1']);
        expect(moved.runs).toHaveLength(1);
        expect(stale.needsPlanting).toBe(true);
        expect(stale.reason).toBe("The zone types' item bindings changed since the last planting, so the inner masks' channels may have moved, "
            + 'so only the whole planting can follow: nothing was updated. '
            + 'Run Update vegetation — it plants every generator again and rewrites the Arborist file (minutes).');
        expect(stale.report[0]).toMatch(/^inner: skipped - /);
        expect(veg.runs).toHaveLength(0);
        expect(calls.map(c => c.command)).not.toContain('golfmap.zones.import');

        const again = await t.svc.updateZones(TEST_COURSE_ID, ['z1'], { plantIfNeeded: true });
        expect(moved.runs).toHaveLength(2);
        expect(again.report[1]).toBe("The zone types' item bindings changed since the last planting, so the inner masks' channels may have moved: "
            + 'the whole planting ran instead of a patch');
        expect(veg.runs.map(a => path.basename(a[0]!))).toEqual(planting);
        // The patch itself never reached Unity; the planting's import did.
        expect(calls.map(c => c.command)).not.toContain('golfmap.zones.patch');
        expect(calls.map(c => c.command)).toContain('golfmap.zones.import');
        await expect(t.svc.start(TEST_COURSE_ID, { kind: 'vegetation-update', zoneIds: [] })).rejects.toThrow('A vegetation-update export needs the zones to update');
    } finally {
        server.stop(true);
    }
});

test('vegetation-update: a Unity that cannot take the patch says how to catch up', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { server } = fakeUnity(exportDir, discovery, () =>
        Response.json({ ok: false, error: "The scene does not hold this zones export's import (no mask group for 'Reed'). Update vegetation (a full import) instead." }));
    const { runner } = patchRunner({ inner: true });
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');
        await expect(t.svc.updateZones(TEST_COURSE_ID, ['z1'])).rejects.toThrow(
            /The inner masks are updated in .*, but Unity \(linkan_v4\) could not take them: .*no mask group for 'Reed'.*Update vegetation to bring Unity in step/);
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

// --- The Arborist half (what the server decides; arborist.py itself runs in arborist.service.test.ts) ---

/** An Arborist course: a species file and palette under a docs root, the machine's library and key under the data dir, a GSPro course folder with its file. */
async function arboristCourse(opts: { courseDir?: boolean } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'arborist-course-'));
    const docs = path.join(root, 'docs'), dataDir = path.join(root, 'data'), courseDir = path.join(root, 'Courses', 'Linkan_scene');
    for (const dir of [path.join(docs, 'linkan'), path.join(dataDir, 'arborist'), courseDir]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(docs, 'linkan', 'arborist-species.json'), '{}');
    await writeFile(path.join(docs, 'linkan', 'grass-palette.json'), '{}');
    await writeFile(path.join(dataDir, 'arborist', 'GolfMap library.biome'), '{}');
    await writeFile(path.join(dataDir, 'arborist-wrapper.key'), '0123456789abcdef');
    if (opts.courseDir !== false) await writeFile(path.join(courseDir, 'arboristdata.dat'), 'dat');
    return { docs, dataDir, courseDir };
}

/** `arborist.py lower` as it reports; any other script goes to `rest`. */
function arboristRunner(rest: ExportRunner) {
    const runs: { args: string[]; timeoutMs?: number }[] = [];
    const runner: ExportRunner = async (args, cwd, opts) => {
        if (path.basename(args[0]!) !== 'arborist.py') return rest(args, cwd, opts);
        runs.push({ args, timeoutMs: opts?.timeoutMs });
        return { code: 0, stdout: "wrote arboristdata.dat (4.4 MB): 38 item(s), 13 mask texture(s) in package 'GolfMap lower vegetation'\n  Shrub - willow = MeadowEnv_bush_grey_willow_02 (mask 6, channel 0)\n", stderr: '' };
    };
    return { runs, runner };
}

test('vegetation-update on an Arborist course: after Unity took the patch the Arborist lower vegetation is written from the same masks', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const { calls, server } = fakeUnity(exportDir, discovery);
    const a = await arboristCourse();
    const { runs, runner } = arboristRunner(patchRunner({ inner: true }).runner);
    try {
        const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery), courseDocsRoot: a.docs, dataDir: a.dataDir });
        await t.svc.setDir(TEST_COURSE_ID, exportDir);
        await t.svc.setCourseDir(TEST_COURSE_ID, a.courseDir);
        await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');

        const res = await t.svc.updateZones(TEST_COURSE_ID, ['z1']);
        expect(res.report).toEqual([
            'inner: Patched linkan-inner-zones.json: 2 zone(s)',
            'Unity (linkan_v4): Patched 1 mask texture(s) for 1 zone(s), respawned 68 x 68 m in 640 ms. Save the scene.',
            `Arborist lower vegetation written: 38 items, 13 mask textures (${path.join(a.courseDir, 'arboristdata.dat')})`,
            'Save the scene in Unity to keep it.',
        ]);
        // Only the lower vegetation (fast); the trees and their dump are Update vegetation's.
        expect(runs).toHaveLength(1);
        expect(runs[0]!.args.slice(0, 2)).toEqual([path.join('/pipeline', 'arborist.py'), 'lower']);
        expect(flag(runs[0]!.args, '--course-dir')).toBe(a.courseDir);
        expect(flag(runs[0]!.args, '--zones')).toBe(path.join(exportDir, 'linkan-inner-zones.json'));
        expect(flag(runs[0]!.args, '--palette')).toBe(path.join(a.docs, 'linkan', 'grass-palette.json'));
        expect(flag(runs[0]!.args, '--species')).toBe(path.join(a.docs, 'linkan', 'arborist-species.json'));
        expect(flag(runs[0]!.args, '--library')).toBe(path.join(a.dataDir, 'arborist', 'GolfMap library.biome'));
        expect(flag(runs[0]!.args, '--key-file')).toBe(path.join(a.dataDir, 'arborist-wrapper.key'));
        expect(flag(runs[0]!.args, '--out-dir')).toBeUndefined();
        expect(runs[0]!.timeoutMs).toBe(5 * 60_000);
        expect(calls.map(c => c.command)).toEqual(['golfmap.course', 'golfmap.zones.patch']);
    } finally {
        server.stop(true);
    }
});

test('vegetation: a half that fails fails the job after the other has run, and the message carries both', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));

    // Unity closed, an Arborist course with no GSPro course folder set: the zones are out, the file is not.
    const unset = await arboristCourse();
    const first = arboristRunner(vegetationRunner({}).runner);
    const t = await setup(first.runner, { unityBridge: defaultUnityBridge(discovery), courseDocsRoot: unset.docs, dataDir: unset.dataDir });
    await t.svc.setDir(TEST_COURSE_ID, exportDir);
    await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), '{}');
    await expect(t.svc.plantVegetation(TEST_COURSE_ID, 'inner')).rejects.toThrow(
        "The zones are exported, but: Arborist file not written: set the GSPro course folder first (export panel, GreenKeeper course file) - the course's folder under GSPro's Courses");
    expect(first.runs).toHaveLength(0);
    // The shaping run and the CLI can leave the half out.
    const without = await t.svc.plantVegetation(TEST_COURSE_ID, 'inner', { arborist: false });
    expect(without.report.some(l => l.startsWith('Arborist'))).toBe(false);

    // Unity open but refusing the import: the Arborist lower vegetation is still written, the trees are not asked for.
    const unity: string[] = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            unity.push(command);
            if (command === 'golfmap.course') return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder: exportDir } } });
            return Response.json({ ok: false, error: 'No VegetationSystemPro on Terrain (Inner)' });
        },
    });
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({ pid: process.pid, port: server.port!, token: 'tok', projectPath: 'D:/unity/linkan', projectName: 'linkan_v4', unityVersion: '', started: '' }));
    try {
        await t.svc.setCourseDir(TEST_COURSE_ID, unset.courseDir);
        await expect(t.svc.plantVegetation(TEST_COURSE_ID, 'inner')).rejects.toThrow(
            'The zones were generated and exported, but Unity (linkan_v4) could not take them: No VegetationSystemPro on Terrain (Inner). The Arborist lower vegetation was still written');
        expect(first.runs.map(r => r.args[1])).toEqual(['lower']);
        expect(unity).toEqual(['golfmap.course', 'golfmap.zones.import']);
    } finally {
        server.stop(true);
    }
});

test('arborist: the file alone, as a job; a course without a species file is refused', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const a = await arboristCourse();
    const { runs, runner } = arboristRunner(recordingRunner().runner);
    const t = await setup(runner, { unityBridge: defaultUnityBridge(discovery), courseDocsRoot: a.docs, dataDir: a.dataDir });
    await t.svc.setDir(TEST_COURSE_ID, exportDir);
    await t.svc.setCourseDir(TEST_COURSE_ID, a.courseDir);
    await writeFile(path.join(exportDir, 'linkan-inner-zones.json'), '{}');

    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'arborist' });
    expect(job.label).toBe('Arborist file (lower vegetation and trees)');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const done = t.svc.job(job.id);
    expect(done.error).toBeNull();
    expect(done.result!.path).toBe(path.join(a.courseDir, 'arboristdata.dat'));
    expect(done.result!.report).toEqual([
        `Arborist lower vegetation written: 38 items, 13 mask textures (${path.join(a.courseDir, 'arboristdata.dat')})`,
        "Arborist trees: skipped, Unity is not open (the trees' positions and ground heights come from its scene); the file keeps the trees as last generated",
    ]);
    expect(runs.map(r => r.args[1])).toEqual(['lower']);

    const plain = await setup(runner, { unityBridge: defaultUnityBridge(discovery) });
    await expect(plain.svc.exportArborist(TEST_COURSE_ID)).rejects.toThrow(NOT_ARBORIST);
});

// --- Unchanged inputs: an export that would write the same file again is skipped (proposal 8) ---

/**
 * The pipeline stand-in that WRITES what each command writes (the DEM's RAW and
 * sidecar, the photo's twins, a zones mask), so an export finds its own output
 * and the input fingerprint next to it on the next run.
 */
function writingRunner() {
    const calls: string[][] = [];
    const commands = () => calls.map(a => (a[1] === 'golfpipe' ? a[2]! : a[1]!));
    const runner: ExportRunner = async (args) => {
        calls.push(args);
        const command = args[1] === 'golfpipe' ? args[2]! : args[1]!;
        const out = flag(args, '--out');
        if (out) {
            await mkdir(path.dirname(out), { recursive: true });
            await writeFile(out, '{}');
            if (command === 'dem') {
                await writeFile(`${out}.json`, JSON.stringify({ minM: 80, maxM: 140 }));
                await writeFile(out.replace(/\.tif$/, '.raw'), 'raw');
            }
            if (command === 'ortho') {
                await writeFile(terrainTextureFileName(out), 'jpg');
                const tinted = flag(args, '--tint-out');
                if (tinted) await writeFile(tinted, 'jpg');
            }
            if (command === 'zones') await writeFile(out.replace(/\.json$/, '-0.png'), 'png');
        }
        return { code: 0, stdout: `${command} done\n`, stderr: '' };
    };
    return { calls, commands, runner };
}

/** A timestamp a touched file gets, far enough from the last write to be another mtime. */
const later = () => new Date(Date.now() + 60_000);

test('a second heightmap export with the same inputs is skipped; a touched DEM, a terrain edit, a missing output or force render it again', async () => {
    const w = writingRunner();
    const t = await setup(w.runner);
    const sources = await buildSite(t, ['dem.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);

    const first = await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(w.commands()).toEqual(['dem']);
    // The sidecar next to the output says what it was made from.
    const inputs = JSON.parse(await readFile(`${first.path}.inputs.json`, 'utf8'));
    expect(inputs.format).toBe('golfmap-export-inputs-v1');
    expect(inputs.files.map((f: any) => path.basename(f.path))).toEqual(['dem-edited.tif', 'dem.tif']);
    expect(inputs.files[0]).toMatchObject({ missing: true });   // no edits applied: the raw DEM is the source
    expect(inputs.values.terrain).toBe('inner');
    expect(inputs.outputs.map((f: string) => path.basename(f)))
        .toEqual(['linkan-inner-dem-2050m.tif', 'linkan-inner-dem-2050m.raw', 'linkan-inner-dem-2050m.tif.json']);

    // Nothing moved: no pipeline call at all, and the report says why.
    const again = await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(w.commands()).toEqual(['dem']);
    expect(again.path).toBe(first.path);
    expect(again.report).toHaveLength(1);
    expect(again.report[0]).toMatch(/^unchanged: linkan-inner-dem-2050m\.tif \(inputs unchanged since \d{4}-\d\d-\d\dT/);

    // The map build wrote a new DEM: rendered again.
    await utimes(path.join(sources, 'dem.tif'), later(), later());
    await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(w.commands()).toEqual(['dem', 'dem']);
    expect((await t.svc.exportDem(TEST_COURSE_ID, 'inner')).report[0]).toMatch(/^unchanged: /);

    // A terrain edit is part of what the heightmap carries, so it counts as a change.
    await new TerrainEditsService(t.db).create({
        siteId: SITE_ID, op: 'plane', params: { featherM: 2, flat: true },
        rings: [[{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }]],
    });
    await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(w.commands()).toEqual(['dem', 'dem', 'dem']);

    // An output file that is gone (the .raw deleted by hand): rendered again.
    await rm(first.path.replace(/\.tif$/, '.raw'));
    await t.svc.exportDem(TEST_COURSE_ID, 'inner');
    expect(w.commands()).toEqual(['dem', 'dem', 'dem', 'dem']);

    // force renders whatever the fingerprint says — the option and the request field.
    await t.svc.exportDem(TEST_COURSE_ID, 'inner', { force: true });
    expect(w.commands()).toHaveLength(5);
    const job = await t.svc.start(TEST_COURSE_ID, { kind: 'dem', terrain: 'inner', force: true });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(job.id).error).toBeNull();
    expect(w.commands()).toHaveLength(6);
});

test('the photo, the masks, the trees and the creeks are skipped when their inputs are unchanged; a feature edit renders them again', async () => {
    const w = writingRunner();
    const t = await setup(w.runner);
    const sources = await buildSite(t, ['dem.tif', 'ortho-orto-l2-2025.tif']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await t.svc.setDir(TEST_COURSE_ID, dir);
    const stems = t.assets.resolveTreeStemsPath(SITE_ID);
    await mkdir(path.dirname(stems), { recursive: true });
    await writeFile(stems, '{"trees":[]}');

    // The photo with the surface tint (the panel's default), the masks, the trees and the creeks.
    const photo = await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, {});
    const zones = await t.svc.exportZones(TEST_COURSE_ID, 'inner');
    await t.svc.exportTrees(TEST_COURSE_ID, 'inner');
    await t.svc.exportCreeks(TEST_COURSE_ID);
    expect(w.commands()).toEqual(['ortho', 'dem', 'zones', 'trees', 'creeks']);
    // The zones sidecar records the masks that run wrote, so a hand-deleted one is noticed.
    const zoneInputs = JSON.parse(await readFile(`${zones.path}.inputs.json`, 'utf8'));
    expect(zoneInputs.outputs.map((f: string) => path.basename(f))).toEqual(['linkan-inner-zones.json', 'linkan-inner-zones-0.png']);

    w.calls.length = 0;
    for (const line of [
        (await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, {})).report[0],
        (await t.svc.exportZones(TEST_COURSE_ID, 'inner')).report[0],
        (await t.svc.exportTrees(TEST_COURSE_ID, 'inner')).report[0],
        (await t.svc.exportCreeks(TEST_COURSE_ID)).report[0],
    ]) expect(line).toMatch(/^unchanged: /);
    expect(w.commands()).toEqual([]);

    // A drawn feature: the tint reads the course's surfaces, the masks its zones, the trees its species areas.
    const features = new CourseFeaturesService(t.db);
    const ring = { points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] };
    await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'fairway', geometry: { crs: 'EPSG:3006', rings: [ring] } });
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, {});
    await t.svc.exportZones(TEST_COURSE_ID, 'inner');
    await t.svc.exportTrees(TEST_COURSE_ID, 'inner');
    await t.svc.exportCreeks(TEST_COURSE_ID);
    expect(w.commands()).toEqual(['ortho', 'zones', 'trees', 'creeks']);

    // A deleted mask: the zones export runs again even though nothing else moved.
    w.calls.length = 0;
    await rm(path.join(dir, 'linkan-inner-zones-0.png'));
    await t.svc.exportZones(TEST_COURSE_ID, 'inner');
    expect(w.commands()).toEqual(['zones']);

    // A touched source photo, and a changed option (another brightness), each render again.
    w.calls.length = 0;
    await utimes(path.join(sources, 'ortho-orto-l2-2025.tif'), later(), later());
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', undefined, {});
    await t.svc.exportOrtho(TEST_COURSE_ID, 'ortho-orto-l2-2025.tif', 0.6, {});
    expect(w.commands()).toEqual(['ortho', 'ortho']);
    expect(path.basename(photo.path)).toBe('linkan-orto-l2-2025-8192.jpg');
});

test('the input digest is order-independent and unchanged: the sidecars already on disk stay valid', async () => {
    // Pinned from before the separator was written as the escape `'\0'` (a raw NUL byte in the
    // source makes git treat export-fingerprint.ts as binary): the same bytes are hashed, so an
    // export whose sidecar holds one of these hashes must still read as unchanged.
    expect(digest(['a', 'b', 'c'])).toBe('13e228567e8249fc');
    expect(digest(['c', 'a', 'b'])).toBe('13e228567e8249fc');
    expect(digest([])).toBe('e3b0c44298fc1c14');
    expect(digest(['zone-1', 'zone-2'])).toBe('f2c5a36110daf821');
    // The separator keeps two different splits of the same text apart.
    expect(digest(['ab', 'c'])).not.toBe(digest(['a', 'bc']));
});

test('a skipped heightmap render still goes into Unity: the push reads the files in the folder, and save keeps them', async () => {
    const discovery = await mkdtemp(path.join(os.tmpdir(), 'bridges-'));
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const project = await mkdtemp(path.join(os.tmpdir(), 'unity-proj-'));
    const w = writingRunner();
    const ours = fakeEditor('Linkan', path.relative(path.join(project, 'Assets'), exportDir), {
        terrains: [{ terrain: 'Terrain (Inner)', sidecar: 'linkan-inner-dem-2050m.tif.json', source: 'dem.tif', movedM2: 0, maxMoveM: 0 }],
        saved: { scenes: ['Assets/Scenes/Linkan.unity'], seconds: 1.2 },
    });
    writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({
        pid: process.pid, port: ours.server.port!, token: 'tok', projectPath: project, projectName: 'linkan_v4', unityVersion: '', started: '',
    }));
    try {
        const t = await setup(w.runner, { unityBridge: defaultUnityBridge(discovery) });
        await buildSite(t, ['dem.tif']);
        await t.svc.setDir(TEST_COURSE_ID, exportDir);

        await t.svc.exportUnityTerrain(TEST_COURSE_ID, 'inner');
        const again = await t.svc.exportUnityTerrain(TEST_COURSE_ID, 'inner', { save: true });
        // Rendered once, pushed twice.
        expect(w.commands()).toEqual(['dem']);
        expect(again.report[0]).toMatch(/^unchanged: /);
        expect(ours.calls.filter(c => c.command === 'golfmap.terrain.update').map(c => c.args))
            .toEqual([{ terrain: 'inner' }, { terrain: 'inner', save: true }]);
        // With `save` the report names what Unity saved instead of asking for it.
        expect(again.report).toContain('Saved Assets/Scenes/Linkan.unity (1.2 s)');
        expect(again.report.some(l => l.includes('Save the scene to keep it.'))).toBe(false);
    } finally {
        ours.server.stop(true);
    }
});

test("exportWaterLevels: a water-edge pond's dig level + 5 cm in the heightmap's frame, keyed by its plane; none -> no file", async () => {
    const exportDir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    const t = await setup(async () => ({ code: 0, stdout: '', stderr: '' }));
    const sources = await buildSite(t, ['dem.tif']);
    await t.svc.setDir(TEST_COURSE_ID, exportDir);
    await writeFile(path.join(exportDir, 'linkan-inner-dem-2050m.tif.json'), JSON.stringify({ minM: 80.762 }));
    const features = new CourseFeaturesService(t.db);
    const pond = await features.create({
        courseId: TEST_COURSE_ID, holeId: null, type: 'water',
        geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] }] },
    });
    const file = path.join(exportDir, 'linkan-inner-water-levels.json');

    expect((await t.svc.exportWaterLevels(TEST_COURSE_ID)).file).toBeNull();
    await writeFile(path.join(sources, 'dem-edited.water-levels.json'), JSON.stringify({
        format: 'golfmap-dig-levels-v1', levels: { [`feature:${pond.id}`]: 103.431, 'feature:elsewhere': 90, 'edit:3': 50 },
    }));
    const res = await t.svc.exportWaterLevels(TEST_COURSE_ID);
    expect(res.file).toBe(file);
    const doc = JSON.parse(await readFile(file, 'utf8'));
    expect(doc.format).toBe('golfmap-water-levels-v1');
    expect(doc.planes).toEqual({ [`Spline_others_${pond.no!.toString(16)}_WaterPlane`]: { surfaceM: 22.719, levelM: 103.431, featureId: pond.id } });

    await rm(path.join(sources, 'dem-edited.water-levels.json'));
    await t.svc.exportWaterLevels(TEST_COURSE_ID);
    expect(existsSync(file)).toBe(false);
});

// --- SVG checks (the pipeline side: pipeline/tests/test_gspro_svg_checks.py) ---

const SLIVER = {
    key: 'overlap-sliver:semi-1+bunker-1', code: 'overlap-sliver', severity: 'error', accepted: false,
    message: 'hole_8_253 reaches 0.07 m into hole_8_233 over 1.5 m',
    shapes: [{ name: 'hole_8_233', type: 'semi_rough', featureIds: ['semi-1'] }, { name: 'hole_8_253', type: 'bunker', featureIds: ['bunker-1'] }],
    at: [541000, 6468000], geometry: null,
};

/** A runner that writes `findings` to --checks-out and exits 3 when an unaccepted error is among them (as gspro.py does). */
function checkingRunner(findings: object[]) {
    const calls: string[][] = [];
    const runner: ExportRunner = async (args) => {
        calls.push(args);
        const errors = findings.filter((f: any) => f.severity === 'error' && !f.accepted).length;
        await writeFile(flag(args, '--checks-out')!, JSON.stringify({
            format: 'golfmap-svg-checks-v1', checkedAt: '2026-10-21T00:00:00Z', errors, warnings: 0, notes: 0, accepted: 0, findings,
        }));
        if (errors && !args.includes('--allow-errors') && !args.includes('--check-only')) return { code: 3, stdout: '', stderr: 'error: 1 SVG check error(s)' };
        if (!args.includes('--check-only')) await writeFile(flag(args, '--out')!, '<svg/>');
        return { code: 0, stdout: 'Wrote out.svg\n', stderr: '' };
    };
    return { calls, runner };
}

test('an SVG export with check errors fails naming them, writes nothing and keeps no snapshot; a variant is written anyway', async () => {
    const { calls, runner } = checkingRunner([SLIVER]);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'gspro-docs-'));
    const { svc } = await setup(runner, { courseDocsRoot: docs });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await svc.setDir(TEST_COURSE_ID, dir);

    const failed = await svc.export(TEST_COURSE_ID).catch((e) => e);
    expect(failed).toBeInstanceOf(ConflictError);
    expect(failed.message).toBe('SVG check: 1 error(s), nothing written - open them in Draw › Check shapes. hole_8_253 reaches 0.07 m into hole_8_233 over 1.5 m');
    expect(flag(calls[0], '--accepted')).toBe(path.join(docs, 'linkan', 'svg-checks.json'));
    expect(flag(calls[0], '--checks-out')).toBe(path.join(dir, 'linkan.checks.json'));
    expect(calls[0]).not.toContain('--allow-errors');
    expect(existsSync(path.join(dir, 'export-history'))).toBe(false);

    const variant = await svc.export(TEST_COURSE_ID, { variant: 'bisect a' });
    expect(calls[1]).toContain('--allow-errors');
    expect(existsSync(variant.path)).toBe(true);
});

test('checkSvg runs the checks writing nothing; an accepted finding is passed on by key', async () => {
    const { calls, runner } = checkingRunner([SLIVER]);
    const docs = await mkdtemp(path.join(os.tmpdir(), 'gspro-docs-'));
    const { svc } = await setup(runner, { courseDocsRoot: docs });
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gspro-out-'));
    await svc.setDir(TEST_COURSE_ID, dir);

    const report = await svc.checkSvg(TEST_COURSE_ID);
    expect(calls[0]).toContain('--check-only');
    expect(report).toMatchObject({ courseId: TEST_COURSE_ID, errors: 1, findings: [{ key: SLIVER.key, code: 'overlap-sliver' }] });
    expect(await readdir(dir)).toEqual([]);

    const file = path.join(docs, 'linkan', 'svg-checks.json');
    expect(await svc.acceptSvgFinding(TEST_COURSE_ID, SLIVER.key, true, 'Classic tee, on purpose')).toEqual({ file, keys: [SLIVER.key] });
    const doc = JSON.parse(await readFile(file, 'utf-8'));
    expect(doc.format).toBe('golfmap-svg-checks-accepted-v1');
    expect(doc.accepted).toMatchObject([{ key: SLIVER.key, note: 'Classic tee, on purpose' }]);
    // Accepting twice keeps one entry; taking it back empties the list.
    await svc.acceptSvgFinding(TEST_COURSE_ID, SLIVER.key, true);
    expect((await svc.acceptSvgFinding(TEST_COURSE_ID, 'other:x', true)).keys).toEqual([SLIVER.key, 'other:x']);
    expect((await svc.acceptSvgFinding(TEST_COURSE_ID, SLIVER.key, false)).keys).toEqual(['other:x']);
});
