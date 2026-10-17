// GsproSyncService against the real service graph (`GsproExportService`,
// `ShapingService`, `MapBuildService`, the real migrated DB) with the two
// seams the rest of the suite uses: an injected pipeline runner standing in
// for `gspro.py`/`golfpipe` (it records every invocation and writes the files
// those commands would) and a stand-in Unity editor on the bridge protocol.
// No Python, no Blender, no Unity.
import { test, expect, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { NotFoundError } from '@basics/core/server/auth';
import { sql } from 'kysely';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_COURSE_ID, TEST_GREEN_1_ID } from '../db/seeds/course';
import { CoursesService } from './courses.service';
import { HolesService } from './holes.service';
import { AssetsService } from './assets.service';
import { CourseFeaturesService } from './course-features.service';
import { PinsService } from './pins.service';
import { TerrainEditsService } from './terrain-edits.service';
import { FeatureHistoryService } from './feature-history.service';
import { MapBuildService, type PipelineRunner } from './map-build.service';
import { GsproExportService, OUTER_VEGETATION_IS_ARBORIST, type ExportRunner } from './gspro-export.service';
import { ShapingService } from './shaping.service';
import {
    GsproSyncService, SYNC_RECORD_FILE, SYNC_RECORD_FORMAT,
    type CommandRunner, type GsproSyncDeps, type GsproSyncRecord, type GsproSyncStatus,
} from './gspro-sync.service';
import { PROPS_PLACED, PROPS_PLACED_FORMAT } from './gspro-props';
import { defaultUnityBridge, unityEditorsFor } from './unity-bridge';
import { innerSquareFrom3006, terrainManifestField } from './terrain-square';
import { GSPRO_TARGET_IDS, type GsproTargetId } from '../../shared/gspro-targets';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const f of cleanup.splice(0)) await f();
});

const tmp = (prefix: string) => mkdtemp(path.join(os.tmpdir(), prefix));

/** The repo root, as the props chain's commands are run from. */
const REPO_DIR = path.resolve(import.meta.dir, '..', '..');

/** A georeferenced course, as in the export tests: its inner square is 2050 m. */
const GEOREF_BBOX: [number, number, number, number] = [529028, 6486667, 531082, 6488721];
const GEOREF_INNER = innerSquareFrom3006(GEOREF_BBOX);
const SITE_ID = 'site-sync';
const INNER_SIDECAR = 'linkan-inner-dem-2050m.tif.json';
/** What `golfmap.course` reports as the active course's folder (an asset path from the project root). */
const COURSE_FOLDER = 'Assets/GolfMap/Linkan/';

function flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
}

/** A promise a test resolves by hand, to hold a pipeline run open. */
function gate() {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => { open = resolve; });
    return { promise, open };
}

/**
 * The pipeline stand-in: records every invocation and writes what the real
 * commands write — `--out`, plus the `.raw` heightmap and the `.json` sidecar
 * `gspro.py dem` leaves next to it (which is what makes the chains'
 * prerequisites, and the exports' input fingerprints, real).
 */
function pipelineRunner(opts: { hold?: Promise<void>; holdFor?: string } = {}) {
    const calls: string[][] = [];
    /** `gspro.py` sub-commands in order, e.g. ['dem', 'dem', 'svg']. */
    const commands = () => calls.map(a => (a[1] === 'golfpipe' ? a[2]! : a[1]!));
    const runner: ExportRunner = async (args) => {
        calls.push(args);
        const command = args[1] === 'golfpipe' ? args[2]! : args[1]!;
        if (opts.hold && opts.holdFor === command) await opts.hold;
        const out = flag(args, '--out');
        // A vegetation generator (`<name>_zones.py`): its GeoJSON, with nothing in it.
        if (out && path.basename(args[0]!).endsWith('_zones.py')) {
            await writeFile(out, JSON.stringify({ type: 'FeatureCollection', features: [] }));
            return { code: 0, stdout: `${path.basename(args[0]!)}: 0 zones\n`, stderr: '' };
        }
        if (out) {
            await mkdir(path.dirname(out), { recursive: true });
            await writeFile(out, command === 'svg' ? '<svg/>' : '{}');
            if (command === 'dem') {
                await writeFile(`${out}.json`, JSON.stringify({ minM: 80, maxM: 140 }));
                await writeFile(out.replace(/\.tif$/, '.raw'), 'raw');
            }
            if (command === 'ortho') {
                // The darkened terrain twin and, with the tint, the -meshes file Unity takes.
                for (const name of ['--terrain-out', '--tint-out']) {
                    const twin = flag(args, name);
                    if (twin) await writeFile(twin, 'jpg');
                }
            }
        }
        const outDir = flag(args, '--out-dir');
        if (outDir) {
            // `gspro.py shaping-global` writes the layer files; `fetch-lidar` a .laz.
            await mkdir(outDir, { recursive: true });
            if (command === 'shaping-global') {
                for (const name of ['00-global.gen.json', '10-features.gen.json']) {
                    await writeFile(path.join(outDir, name), JSON.stringify({ format: 'golfmap-shaping-layer-v1', ops: [] }));
                }
            } else {
                await writeFile(path.join(outDir, 'item_648_52.copc.laz'), 'fake lidar');
            }
        }
        return { code: 0, stdout: `${command} done\n`, stderr: '' };
    };
    return { calls, commands, runner };
}

/**
 * The props chain's two commands (`CommandRunner`: the whole argv, so one seam
 * covers both). Each is recorded and writes what the real one writes — the
 * generator its `*-props.json`, `build_props.py` the `props.json` manifest in
 * `--out` — which is what makes the chain's input fingerprints real.
 */
function propsRunner(fails?: 'the spec' | 'the models' | 'the models, quietly') {
    const calls: string[][] = [];
    const runner: CommandRunner = async (command) => {
        calls.push(command);
        const spec = flag(command, '--spec');
        const out = flag(command, '--out');
        if (spec && out) {
            if (fails === 'the models') {
                return { code: 1, stdout: 'Blender 4.5\nreading clubhouse-props.json\n', stderr: 'Error: asset shed has no parts\n' };
            }
            // `blender -b --python` quits 0 after an unhandled Python exception: nothing written, code 0.
            if (fails === 'the models, quietly') {
                return {
                    code: 0, stdout: 'built shed 240 tris\nBlender quit\n',
                    stderr: 'KeyError: material concrete_weathered has no textures\n',
                };
            }
            await mkdir(out, { recursive: true });
            await writeFile(path.join(out, 'props.json'), JSON.stringify({ format: 'golfmap-props-v1' }));
            return { code: 0, stdout: 'wrote Models/shed.fbx\nwrote props.json\n', stderr: '' };
        }
        if (fails === 'the spec') {
            return { code: 1, stdout: '', stderr: 'Traceback (most recent call last)\nModuleNotFoundError: no rasterio\n' };
        }
        await writeFile(command[1]!.replace(/-props\.gen\.py$/, '-props.json'), JSON.stringify({ format: 'golfmap-props-spec-v1' }));
        return { code: 0, stdout: '7 assets, 48 instances\n', stderr: '' };
    };
    /** `python` / `blender` — which executable each recorded run used, in order. */
    const which = () => calls.map(c => path.basename(c[0]!).replace(/\.exe$/, ''));
    return { calls, runner, which };
}

/** The same shape for MapBuildService's runner: every `--out` written, exit 0. */
function mapBuildRunner() {
    const steps: string[][] = [];
    const runner: PipelineRunner = async (args) => {
        steps.push(args);
        const out = flag(args, '--out');
        if (out) {
            await mkdir(path.dirname(out), { recursive: true });
            await writeFile(out, 'tif');
        }
        return { code: 0, stdout: `${args[2]} done\n`, stderr: '' };
    };
    return { steps, runner };
}

/**
 * A Unity editor whose active GolfMap course exports to `exportFolder`, on the
 * bridge protocol. A command run with `save: true` answers with the
 * `saved: {scenes, seconds}` the real bridge puts in its result
 * (unity/README.md, "Saving what a command changed").
 */
function fakeEditor(exportFolder: string, projectName = 'linkan_v4', delayMs = 0) {
    const calls: Array<{ command: string; args: any }> = [];
    const server = Bun.serve({
        port: 0,
        async fetch(req) {
            if (req.headers.get('X-Bridge-Token') !== 'tok') return Response.json({ ok: false, error: 'token' }, { status: 403 });
            const command = decodeURIComponent(new URL(req.url).pathname.replace('/cmd/', ''));
            const args = await req.json();
            calls.push({ command, args });
            // An editor busy compiling takes its time to answer the course probe.
            if (delayMs) await Bun.sleep(delayMs);
            const saved = args?.save === true ? { saved: { scenes: ['Assets/Scenes/Linkan.unity'], seconds: 0.4 } } : {};
            if (command === 'golfmap.course') {
                return Response.json({ ok: true, result: { active: { name: 'Linkan', exportFolder, folder: COURSE_FOLDER } } });
            }
            if (command === 'golfmap.props.record') {
                return Response.json({ ok: true, result: {
                    pairing: { pairedByPosition: 12, indexStillRight: 9, unpairedInstances: 0, notInScene: 0 },
                    handPlaced: [{ asset: 'shed', name: 'shed#2' }, { asset: 'bench_stone', name: 'bench_stone#0' }],
                    note: 'Nothing in the scene was touched.',
                } });
            }
            if (command === 'golfmap.props.place') {
                return Response.json({ ok: true, result: {
                    placed: 48, kept: 1,
                    handPlaced: [{ asset: 'shed', name: 'shed#2', movedByHand: { m: 1.42, deg: 12.5 } }],
                    specWon: [{ asset: 'bench_stone', name: 'bench_stone#0' }],
                    handAdded: [{ asset: 'flag', name: 'flag#3 (1)' }],
                    droppedHand: [{ asset: 'shed', name: 'shed#7', why: 'hand-placed, but the spec no longer has this instance' }],
                    ...saved,
                } });
            }
            if (command === 'golfmap.terrain.update') {
                return Response.json({ ok: true, result: { terrains: [{ terrain: args.terrain, sidecar: INNER_SIDECAR, source: 'raw', movedM2: 0, maxMoveM: 0 }], ...saved } });
            }
            if (command === 'golfmap.orthos.apply') {
                return Response.json({ ok: true, result: { target: 'Assets/Terrain/x.jpg', renderers: 761, status: 'backup x.jpg', ...saved } });
            }
            if (command === 'golfmap.trees.plant') return Response.json({ ok: true, result: { terrain: args.terrain, status: `Planted the ${args.terrain} trees`, ...saved } });
            if (command === 'golfmap.creeks.import') return Response.json({ ok: true, result: { status: 'Imported 13 creeks', ...saved } });
            return Response.json({ ok: true, result: { status: `${command} ok`, ...saved } });
        },
    });
    cleanup.push(() => server.stop(true));
    return { calls, server, projectName };
}

interface SetupOptions {
    /** An open Unity editor on the course's export folder. */
    unity?: boolean;
    hold?: Promise<void>;
    holdFor?: string;
    /** Leave the course without a georeference (no map area at all). */
    georeference?: boolean;
    /** How long the `meshes` chain follows its shaping job (ms). */
    meshesTimeoutMs?: number;
    /** The real shaping service as the sync service sees it, with a method replaced. */
    shapingOver?: Partial<GsproSyncDeps['shaping']>;
    /** Which of the props chain's two commands refuses. */
    propsFails?: 'the spec' | 'the models' | 'the models, quietly';
}

/**
 * The real `ShapingService` behind the `shaping` dependency, with one or two of
 * its methods replaced — how a test puts the service in front of a shaping job
 * that has gone (a server restart, another apply of the course) without
 * standing in for the rest of it.
 */
function shapingView(s: ShapingService, over: Partial<GsproSyncDeps['shaping']>): GsproSyncDeps['shaping'] {
    return {
        apply: (courseId, opts) => s.apply(courseId, opts),
        job: id => s.job(id),
        status: courseId => s.status(courseId),
        layersDir: courseId => s.layersDir(courseId),
        whenIdle: () => s.whenIdle(),
        current: courseId => s.current(courseId),
        runningAnywhere: () => s.runningAnywhere(),
        waits: s.waits,
        ...over,
    };
}

async function setup(opts: SetupOptions = {}) {
    const ctx = await createTestDb(seedCourse);
    if (opts.georeference !== false) {
        await ctx.db.updateTable('courses').set({ georeference_json: JSON.stringify({ bbox: GEOREF_BBOX }) })
            .where('id', '=', TEST_COURSE_ID).execute();
    }
    const dataDir = await tmp('gspro-sync-data-');
    const exportDir = await tmp('gspro-sync-out-');
    const layersRoot = await tmp('gspro-sync-layers-');
    const discovery = await tmp('bridges-');
    const project = await tmp('unity-proj-');

    let editor: ReturnType<typeof fakeEditor> | null = null;
    if (opts.unity) {
        editor = fakeEditor(path.relative(path.join(project, 'Assets'), exportDir));
        writeFileSync(path.join(discovery, 'bridge-1.json'), JSON.stringify({
            pid: process.pid, port: editor.server.port, token: 'tok', projectPath: project,
            projectName: editor.projectName, unityVersion: '2018.2.8f1', started: '',
        }));
    }
    const bridge = defaultUnityBridge(discovery);

    const courses = new CoursesService(ctx.db);
    const assets = new AssetsService(ctx.db, dataDir);
    const terrainEdits = new TerrainEditsService(ctx.db);
    const pipeline = pipelineRunner({ hold: opts.hold, holdFor: opts.holdFor });
    const exports = new GsproExportService({
        db: ctx.db, courses, assets, dataDir, terrainEdits,
        pipelineDir: '/pipeline', runner: pipeline.runner, unityBridge: bridge,
    });
    await exports.setDir(TEST_COURSE_ID, exportDir);
    const shaping = new ShapingService({
        courses, exportSettings: exports, dataDir, pipelineDir: '/pipeline', runner: pipeline.runner,
        unityBridge: bridge, layersRoot,
        // Nothing answers on port 1, and the launcher can never start Blender from a test.
        workerUrl: 'http://127.0.0.1:1', workerLauncher: ['bun', '--version'],
    });
    const map = mapBuildRunner();
    const mapBuild = new MapBuildService({ db: ctx.db, assets, dataDir, pipelineDir: '/pipeline', runner: map.runner, terrainEdits });
    const props = propsRunner(opts.propsFails);
    const svc = new GsproSyncService({
        db: ctx.db, courses, exports, mapBuild, dataDir, terrainEdits, unityBridge: bridge, pollMs: 5,
        shaping: opts.shapingOver ? shapingView(shaping, opts.shapingOver) : shaping,
        meshesTimeoutMs: opts.meshesTimeoutMs,
        commandRunner: props.runner, propsPython: '/pipeline/.venv/python', blender: '/blender/blender.exe',
    });
    return {
        ctx, db: ctx.db, svc, exports, shaping, dataDir, exportDir, layersRoot, pipeline, map, props, editor,
        assets, project,
    };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A built site: the course points at it, `sources/<siteId>/` and the installed manifest exist. */
async function buildSite(t: Setup, sources: string[] = ['dem.tif']) {
    await t.db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await t.db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();
    const dir = path.join(t.dataDir, 'sources', SITE_ID);
    await mkdir(dir, { recursive: true });
    for (const name of sources) await writeFile(path.join(dir, name), '');
    const manifest = {
        bounds: { west: 15.49, south: 58.51, east: 15.53, north: 58.53 },
        elevation: { min: 80, max: 140 },
        terrain: terrainManifestField(GEOREF_INNER),
        generatedAt: '2026-01-01T00:00:00Z',
    };
    const tiles = path.join(t.dataDir, 'tiles', SITE_ID);
    await mkdir(tiles, { recursive: true });
    await writeFile(path.join(tiles, 'manifest.json'), JSON.stringify(manifest));
    await t.assets.register({
        siteId: SITE_ID, courseId: TEST_COURSE_ID, kind: 'tile_manifest',
        filename: `tiles/${SITE_ID}/manifest.json`, metaJson: JSON.stringify({ activeOrtho: 'orto-l2-2025', ...manifest }),
    });
    return dir;
}

const row = (s: GsproSyncStatus, id: GsproTargetId) => s.targets.find(t => t.id === id)!;

/**
 * A props spec in the course's docs folder — the same folder the shaping
 * layers hang off (`<layersRoot>/<course slug>/`), which is how the service
 * finds it.
 */
async function propsSpec(t: Setup, name = 'clubhouse') {
    const dir = path.join(t.layersRoot, 'linkan');
    await mkdir(dir, { recursive: true });
    const gen = path.join(dir, `${name}-props.gen.py`);
    await writeFile(gen, '# the spec generator\n');
    return { dir, gen, json: path.join(dir, `${name}-props.json`) };
}

/** `<project>/Assets/GolfMap/Linkan/Props` — where the models go and `placed.json` lives. */
const propsDir = (t: Setup) => path.join(t.project, 'Assets', 'GolfMap', 'Linkan', 'Props');

/** Unity's record of what the last place put where: `hand` marks the ones the user moved. */
async function placedRecord(t: Setup, hand: number, total = hand + 5) {
    const dir = propsDir(t);
    await mkdir(dir, { recursive: true });
    const instances = Array.from({ length: total }, (_, i) => ({
        asset: 'shed', index: i, name: `shed#${i}`, hand: i < hand,
        spec: { e: 0, n: 0, yawDeg: 0, dz: 0 }, placed: { pos: [0, 0, 0], euler: [0, 0, 0], scale: [1, 1, 1] },
    }));
    await writeFile(path.join(dir, PROPS_PLACED), JSON.stringify({ format: PROPS_PLACED_FORMAT, instances }));
    return dir;
}

/** A record in the export folder saying every target was updated at `lastRun`. */
async function writeRecord(exportDir: string, lastRun: string) {
    const record: GsproSyncRecord = { format: SYNC_RECORD_FORMAT, targets: {} };
    for (const id of GSPRO_TARGET_IDS) record.targets[id] = { lastRun, seconds: 1 };
    await writeFile(path.join(exportDir, SYNC_RECORD_FILE), JSON.stringify(record));
}

const mtimeIso = async (file: string) => new Date((await stat(file)).mtimeMs).toISOString();

const LONG_AGO = '2000-01-01 00:00:00';

/**
 * Everything the seed made, dated long ago (and the history its own writes
 * left), so only what a test does afterwards counts as a change since a
 * recorded run. The feature/edit updates fire the migration-025 triggers, so
 * the history tables are backdated last.
 */
async function backdate(t: Setup) {
    const tables = ['course_features', 'holes', 'tees', 'greens', 'pins', 'aim_points', 'course_tee_sets', 'course_zone_types', 'terrain_edits'];
    for (const table of tables) {
        await sql.raw(`UPDATE ${table} SET created_at = '${LONG_AGO}', updated_at = '${LONG_AGO}'`).execute(t.db);
    }
    for (const table of ['course_feature_history', 'terrain_edit_history']) {
        await sql.raw(`UPDATE ${table} SET changed_at = '${LONG_AGO}.000'`).execute(t.db);
    }
}

// --- Status ---

test('a fresh course: every target never updated and stale, with the reasons it cannot run', async () => {
    const t = await setup();
    const s = await t.svc.status(TEST_COURSE_ID);

    expect(s.targets.map(r => r.id)).toEqual([...GSPRO_TARGET_IDS]);
    for (const r of s.targets) {
        expect(r.lastRun).toBeNull();
        expect(r.seconds).toBeNull();
        expect(r.changedSince).toEqual({ count: 0, kinds: [] });   // no last run: nothing to count from
        expect(r.stale).toBe(true);
    }
    // Only the SVG can run: it needs the map area, which the georeference gives.
    expect(s.targets.filter(r => r.blocked === null).map(r => r.id)).toEqual(['shapes']);
    expect(row(s, 'terrain').blocked).toBe('Build the map first');
    expect(row(s, 'course-file').blocked).toBe('Set the GSPro course folder first');
    expect(row(s, 'meshes').blocked).toMatch(/^No \.blend in .* build the course's \.blend with OPCD first$/);
    expect(row(s, 'buildings').blocked).toBe('Build the map first');
    // The words come from the shared target list, so the web says the same.
    expect(row(s, 'shapes').manual).toBe('Build the SVG in Blender (OPCD), then Update meshes');
    expect(row(s, 'terrain').manual).toBeNull();

    expect(s.unity).toEqual({ editors: [], matched: null, exportDir: t.exportDir });
    expect(s.worker.reachable).toBe(false);
    expect(s.job).toBeNull();
    expect(s.queue).toEqual([]);
});

test('a course with no map area at all says so for the targets that need one', async () => {
    const t = await setup({ georeference: false });
    const s = await t.svc.status(TEST_COURSE_ID);
    expect(row(s, 'shapes').blocked).toMatch(/^Course has no map area to lay out the GSPro terrains for/);
    expect(s.targets.every(r => r.blocked !== null)).toBe(true);
});

test('with no record, "last updated" comes from the files each target writes', async () => {
    const t = await setup();
    await buildSite(t);
    const write = async (name: string) => {
        const file = path.join(t.exportDir, name);
        await writeFile(file, '{}');
        return file;
    };
    const sidecar = await write(INNER_SIDECAR);
    const photo = await write('linkan-orto-l2-2025-cleaned-clean-8192-meshes.jpg');
    await write('linkan-outer-orto-l2-2025-8192-meshes.jpg');   // the outer twin must not count as the inner's
    const zones = await write('linkan-inner-zones.json');
    const trees = await write('linkan-inner-trees.json');
    const buildings = await write('linkan-inner-buildings.json');
    const creeks = await write('linkan-inner-creeks.json');
    const layers = path.join(await t.shaping.layersDir(TEST_COURSE_ID), '00-global.gen.json');
    await mkdir(path.dirname(layers), { recursive: true });
    await writeFile(layers, '{}');
    const scene = path.join(await tmp('gspro-courses-'), 'Linkan_scene');
    await mkdir(scene, { recursive: true });
    const gkd = path.join(scene, 'Linkan_scene.GKD');
    await writeFile(gkd, '{}');
    await t.exports.setCourseDir(TEST_COURSE_ID, scene);
    // A real export snapshot, as a full SVG export keeps one.
    const svg = path.join(t.exportDir, 'linkan.svg');
    await writeFile(svg, '<svg/>');
    await new FeatureHistoryService(t.db).snapshot(TEST_COURSE_ID, t.exportDir, svg);
    const snapshot = (await FeatureHistoryService.latestSnapshot(t.exportDir))!;

    const s = await t.svc.status(TEST_COURSE_ID);
    expect(row(s, 'terrain').lastRun).toBe(await mtimeIso(sidecar));
    expect(row(s, 'photo').lastRun).toBe(await mtimeIso(photo));
    expect(row(s, 'shapes').lastRun).toBe(snapshot.exportedAt);
    expect(row(s, 'meshes').lastRun).toBe(await mtimeIso(layers));
    expect(row(s, 'vegetation').lastRun).toBe(await mtimeIso(zones));
    expect(row(s, 'trees').lastRun).toBe(await mtimeIso(trees));
    expect(row(s, 'buildings').lastRun).toBe(await mtimeIso(buildings));
    expect(row(s, 'creeks').lastRun).toBe(await mtimeIso(creeks));
    expect(row(s, 'course-file').lastRun).toBe(await mtimeIso(gkd));
    // The props manifest is in the Unity project, so without an editor there is nothing to read —
    // and this course has no props spec either, which is what blocks the row.
    expect(row(s, 'props').lastRun).toBeNull();
    expect(row(s, 'props').blocked).toMatch(/^No props spec in .*linkan\/$/);
    // Nothing was edited after those files were written, so nothing runnable is stale any more.
    expect(s.targets.filter(r => r.stale && r.blocked === null).map(r => r.id)).toEqual([]);
});

test('"changed since" counts the edits each target is made of', async () => {
    const t = await setup();
    await buildSite(t);
    await backdate(t);
    await writeRecord(t.exportDir, new Date(Date.now() - 3600_000).toISOString());

    const features = new CourseFeaturesService(t.db);
    const ring = { points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] };
    const bunker = await features.create({
        courseId: TEST_COURSE_ID, holeId: null, type: 'bunker', geometry: { crs: 'EPSG:3006', rings: [ring] },
    });
    await features.create({
        courseId: TEST_COURSE_ID, holeId: null, type: 'vegetation_zone', geometry: { crs: 'EPSG:3006', rings: [ring] },
        attributes: { zoneType: 'rough_tall', weight: 1, feather: 2, noise: 0 },
    });
    const edits = new TerrainEditsService(t.db);
    await edits.create({ siteId: SITE_ID, op: 'plane', params: { featherM: 2, flat: true }, rings: [[...ring.points]] });
    await edits.create({ siteId: SITE_ID, op: 'recipe', featureId: bunker.id, params: { recipe: 'none' } });
    const pins = new PinsService(t.db);
    const pin = (await pins.listByGreen(TEST_GREEN_1_ID))[0]!;
    await pins.update(pin.id, pin.version, { name: 'Sunday' });

    const s = await t.svc.status(TEST_COURSE_ID);
    // The SVG's types: the bunker (the zone is not drawn into the SVG).
    expect(row(s, 'shapes').changedSince).toEqual({ count: 1, kinds: ['bunker'] });
    // The meshes: the bunker's outline and its shaping recipe.
    expect(row(s, 'meshes').changedSince).toEqual({ count: 2, kinds: ['bunker', 'recipes'] });
    // The terrain: the DEM edit (not the recipe), plus the unapplied-edits check.
    expect(row(s, 'terrain').changedSince).toEqual({ count: 2, kinds: ['terrain edits', 'unapplied edits'] });
    expect(row(s, 'vegetation').changedSince).toEqual({ count: 1, kinds: ['vegetation_zone'] });
    expect(row(s, 'course-file').changedSince).toEqual({ count: 1, kinds: ['pins'] });
    // Nothing touched the creeks or the buildings.
    expect(row(s, 'creeks').changedSince).toEqual({ count: 0, kinds: [] });
    expect(row(s, 'buildings').changedSince).toEqual({ count: 0, kinds: [] });
    expect(s.targets.filter(r => r.stale).map(r => r.id)).toEqual(['terrain', 'shapes', 'meshes', 'vegetation', 'course-file']);
});

test('changing the layer list marks Shapes stale even when no geometry changed', async () => {
    const t = await setup();
    await buildSite(t);
    await backdate(t);
    await writeRecord(t.exportDir, new Date(Date.now() - 3600_000).toISOString());
    expect(row(await t.svc.status(TEST_COURSE_ID), 'shapes').changedSince.count).toBe(0);
    const holes = new HolesService(t.db);
    const first = (await holes.listByCourse(TEST_COURSE_ID))[0]!;
    await holes.update(first.id, first.version, { layerBeforeId: null });
    const shapes = row(await t.svc.status(TEST_COURSE_ID), 'shapes');
    expect(shapes.stale).toBe(true);
    expect(shapes.changedSince.kinds).toContain('layers');
    expect(shapes.changedSince.count).toBeGreaterThan(0);
});

test('a touched cleaned photo makes the Photo row stale', async () => {
    const t = await setup();
    const sources = await buildSite(t, ['dem.tif', 'ortho-orto-l2-2025.tif', 'ortho-orto-l2-2025.cleaned.tif']);
    await writeRecord(t.exportDir, new Date(Date.now() - 3600_000).toISOString());
    // The photo was last cleaned before that recorded run.
    const twoHoursAgo = new Date(Date.now() - 7200_000);
    await utimes(path.join(sources, 'ortho-orto-l2-2025.cleaned.tif'), twoHoursAgo, twoHoursAgo);

    expect(row(await t.svc.status(TEST_COURSE_ID), 'photo').changedSince).toEqual({ count: 0, kinds: [] });
    const now = new Date();
    await utimes(path.join(sources, 'ortho-orto-l2-2025.cleaned.tif'), now, now);
    expect(row(await t.svc.status(TEST_COURSE_ID), 'photo').changedSince).toEqual({ count: 1, kinds: ['cleaned photo'] });
});

// --- Update ---

test('the terrain chain: both heightmaps (the outer with the inner sidecar), then both Unity terrains', async () => {
    const t = await setup({ unity: true });
    await buildSite(t, ['dem.tif', 'dem-edited.tif', 'outer-dem.tif']);

    const started = await t.svc.update(TEST_COURSE_ID, 'terrain');
    expect(started.status).toBe('running');
    expect(started.targets).toEqual(['terrain']);
    expect(started.phases.map(p => p.id)).toEqual(['terrain:apply', 'terrain:dem', 'terrain:unity', 'terrain:dependents']);
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');

    // The pipeline: the inner heightmap, then the outer with the inner's sidecar.
    expect(t.pipeline.commands()).toEqual(['dem', 'dem']);
    expect(flag(t.pipeline.calls[0]!, '--terrain')).toBe('inner');
    expect(flag(t.pipeline.calls[1]!, '--terrain')).toBe('outer');
    expect(flag(t.pipeline.calls[1]!, '--inner-sidecar')).toBe(path.join(t.exportDir, INNER_SIDECAR));
    // Unity got both terrains (the course probe runs before each push, as the export service does it).
    const pushes = t.editor!.calls.filter(c => c.command !== 'golfmap.course');
    expect(pushes.map(c => c.command)).toEqual(['golfmap.terrain.update', 'golfmap.terrain.update']);
    expect(pushes.map(c => c.args.terrain)).toEqual(['inner', 'outer']);

    // The map already carried the edits, so no bake; nothing in the folder reads the heightmap yet.
    const phase = (id: string) => job.phases.find(p => p.id === id)!;
    expect(phase('terrain:apply').status).toBe('skipped');
    expect(phase('terrain:apply').detail).toBe('the map already carries every terrain edit');
    expect(phase('terrain:dem').status).toBe('done');
    expect(phase('terrain:unity').status).toBe('done');
    expect(phase('terrain:dependents').detail).toBe('no file in the folder reads the heightmap yet');
    expect(job.results.map(r => r.target)).toEqual(['terrain']);
    expect(job.results[0]!.report.at(-1)).toMatch(/Still manual in Unity: Terrain › Export To OBJ/);

    // The record was written with the job's START time, and the board reads it back.
    const record = JSON.parse(await readFile(path.join(t.exportDir, SYNC_RECORD_FILE), 'utf8')) as GsproSyncRecord;
    expect(record.format).toBe(SYNC_RECORD_FORMAT);
    expect(record.targets.terrain!.lastRun).toBe(job.startedAt!);
    const after = await t.svc.status(TEST_COURSE_ID);
    expect(row(after, 'terrain').lastRun).toBe(job.startedAt!);
    expect(row(after, 'terrain').seconds).toBe(record.targets.terrain!.seconds);
    expect(row(after, 'terrain').stale).toBe(false);
    expect(after.unity.matched).toBe('linkan_v4');
    expect(after.job!.id).toBe(started.id);
});

test('the terrain chain bakes unapplied edits first and re-exports only the files that are there', async () => {
    const t = await setup({ unity: true });
    await buildSite(t, ['dem.tif', 'outer-dem.tif']);
    await new TerrainEditsService(t.db).create({
        siteId: SITE_ID, op: 'plane', params: { featherM: 2, flat: true },
        rings: [[{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }]],
    });
    // Only the inner trees file is in the folder: the buildings and the zones are not re-exported.
    await writeFile(path.join(t.exportDir, 'linkan-inner-trees.json'), '{}');
    const stems = t.assets.resolveTreeStemsPath(SITE_ID);
    await mkdir(path.dirname(stems), { recursive: true });
    await writeFile(stems, '{"trees":[]}');

    const started = await t.svc.update(TEST_COURSE_ID, 'terrain');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.error).toBeNull();

    const phase = (id: string) => job.phases.find(p => p.id === id)!;
    expect(phase('terrain:apply').status).toBe('done');
    expect(t.map.steps.map(a => a[2])).toEqual(['apply-dem-edits', 'tile-terrain', 'tile-hillshade', 'install', 'manifest']);
    expect(job.results[0]!.report[0]).toBe('applied the terrain edits to the map (re-terrain)');
    // The outer heightmap replays the edits onto the outer DEM on its way out.
    expect(t.pipeline.commands()).toEqual(['dem', 'apply-dem-edits', 'dem', 'trees']);
    expect(phase('terrain:dependents').detail).toBe('inner trees re-exported');
});

test('without an open Unity editor the files are still written and the push is skipped, not failed', async () => {
    const t = await setup();
    await buildSite(t, ['dem.tif', 'dem-edited.tif', 'outer-dem.tif']);

    const started = await t.svc.update(TEST_COURSE_ID, 'terrain');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('succeeded');
    const unity = job.phases.find(p => p.id === 'terrain:unity')!;
    expect(unity.status).toBe('skipped');
    expect(unity.detail).toMatch(/^Not in Unity: no open Unity editor imports from .* \(none is open\)$/);
    expect(t.pipeline.commands()).toEqual(['dem', 'dem']);
});

test('the creeks chain writes the file and imports it in Unity', async () => {
    const t = await setup({ unity: true });
    await buildSite(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'creeks');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.error).toBeNull();
    // The heightmap sidecar the creeks need is exported first by the export service itself.
    expect(t.pipeline.commands()).toEqual(['dem', 'creeks']);
    expect(t.editor!.calls.map(c => c.command)).toEqual(['golfmap.course', 'golfmap.creeks.import']);
    expect(job.results[0]!.report).toContain('Unity (linkan_v4): golfmap.creeks.import — Imported 13 creeks');
    expect(job.phases.map(p => [p.id, p.status])).toEqual([['creeks:file', 'done'], ['creeks:unity', 'done']]);
});

test('the buildings chain exports both terrains and names the Unity menu, which no bridge command replaces', async () => {
    const t = await setup({ unity: true });
    const sources = await buildSite(t, ['dem.tif', 'outer-dem.tif']);
    await writeFile(path.join(sources, 'buildings.geojson'), '{}');

    const started = await t.svc.update(TEST_COURSE_ID, 'buildings');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.error).toBeNull();
    expect(t.pipeline.commands()).toEqual(['dem', 'buildings', 'dem', 'buildings']);
    const unity = job.phases.find(p => p.id === 'buildings:unity')!;
    expect(unity.status).toBe('skipped');
    expect(unity.detail).toBe('no bridge command plants buildings: Run GolfMap › Buildings › Plant from assignments in Unity');
    expect(job.results[0]!.report.at(-1)).toBe('Next in Unity: Run GolfMap › Buildings › Plant from assignments in Unity.');
});

test('a second update queues behind the first instead of being refused', async () => {
    const hold = gate();
    const t = await setup({ hold: hold.promise, holdFor: 'svg' });

    const first = await t.svc.update(TEST_COURSE_ID, 'shapes');
    expect(first.status).toBe('running');
    const second = await t.svc.update(TEST_COURSE_ID, 'shapes');
    expect(second.status).toBe('queued');
    expect(second.startedAt).toBeNull();
    expect(second.phases[0]!.id).toBe('wait');
    expect(second.phases[0]!.label).toBe('Waiting for the GSPro update already running for this course');

    const during = await t.svc.status(TEST_COURSE_ID);
    expect(during.job!.id).toBe(first.id);
    expect(during.queue).toEqual([{ id: second.id, target: 'shapes' }]);
    expect(t.pipeline.commands()).toEqual(['svg']);   // the second has written nothing yet

    hold.open();
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(first.id).status).toBe('succeeded');
    expect(t.svc.job(second.id).status).toBe('succeeded');
    expect(t.pipeline.commands()).toEqual(['svg', 'svg']);
    expect(t.svc.queue(TEST_COURSE_ID)).toEqual([]);
});

test("'stale' takes every stale target that is not blocked, in board order", async () => {
    const t = await setup();
    // Nothing is built: only the SVG can run, however stale the rest is.
    const fresh = await t.svc.update(TEST_COURSE_ID, 'stale');
    expect(fresh.targets).toEqual(['shapes']);
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(fresh.id).error).toBeNull();

    // With a built map and everything recorded as just updated, only what has been edited since is taken.
    await buildSite(t);
    await backdate(t);
    await writeRecord(t.exportDir, new Date(Date.now() - 3600_000).toISOString());
    const features = new CourseFeaturesService(t.db);
    const ring = { points: [{ x: 529400, y: 6487400 }, { x: 529420, y: 6487400 }, { x: 529420, y: 6487420 }] };
    await features.create({ courseId: TEST_COURSE_ID, holeId: null, type: 'water_creek', geometry: { crs: 'EPSG:3006', rings: [ring] } });

    const before = await t.svc.status(TEST_COURSE_ID);
    // The creek is in the SVG, the meshes and the creeks — but the meshes have no .blend to shape.
    expect(before.targets.filter(r => r.stale).map(r => r.id)).toEqual(['shapes', 'meshes', 'creeks']);
    expect(row(before, 'meshes').blocked).toMatch(/^No \.blend in /);

    t.pipeline.calls.length = 0;
    const stale = await t.svc.update(TEST_COURSE_ID, 'stale');
    expect(stale.targets).toEqual(['shapes', 'creeks']);
    expect(stale.phases.map(p => p.label)).toEqual([
        'Course shapes: Course SVG', 'Creeks: Creeks file', 'Creeks: Creeks into Unity',
    ]);
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(stale.id);
    expect(job.error).toBeNull();
    expect(job.results.map(r => r.target)).toEqual(['shapes', 'creeks']);
    expect(t.pipeline.commands()).toEqual(['svg', 'dem', 'creeks']);

    // Both rows are recorded, and nothing is stale any more.
    const record = JSON.parse(await readFile(path.join(t.exportDir, SYNC_RECORD_FILE), 'utf8')) as GsproSyncRecord;
    expect(record.targets.shapes!.lastRun).toBe(job.startedAt!);
    expect(record.targets.creeks!.lastRun).toBe(job.startedAt!);
    const after = await t.svc.status(TEST_COURSE_ID);
    expect(after.targets.filter(r => r.stale && r.blocked === null).map(r => r.id)).toEqual([]);
});

test('a target that cannot run is refused up front, and an unknown job is a 404', async () => {
    const t = await setup();
    await expect(t.svc.update(TEST_COURSE_ID, 'course-file')).rejects.toThrow('Course file cannot be updated: Set the GSPro course folder first');
    expect(() => t.svc.job('nope')).toThrow(/No GSPro sync job nope/);
    await expect(t.svc.status('no-such-course')).rejects.toThrow();
});

test('a failing chain fails the job at its phase and leaves the record alone', async () => {
    const t = await setup();
    await buildSite(t);
    // No tree stems: the trees export refuses, which is the chain's first step.
    const started = await t.svc.update(TEST_COURSE_ID, 'trees');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^Trees: .*Regenerate trees/);
    const files = job.phases.find(p => p.id === 'trees:files')!;
    expect(files.status).toBe('failed');
    expect(job.phases.find(p => p.id === 'trees:unity')!.status).toBe('skipped');
    expect(job.step).toMatch(/^failed \(tree files\)/);
    expect(await Bun.file(path.join(t.exportDir, SYNC_RECORD_FILE)).exists()).toBe(false);
});

test('every Unity push a chain makes runs with save: true, and the report names the scene it saved', async () => {
    const t = await setup({ unity: true });
    const sources = await buildSite(t, ['dem.tif', 'dem-edited.tif', 'outer-dem.tif', 'ortho-orto-l2-2025.tif']);
    // Tree stems for both terrains, so neither has to be detected here.
    for (const stems of [t.assets.resolveTreeStemsPath(SITE_ID), path.join(sources, 'outer-trees', 'tree-stems.json')]) {
        await mkdir(path.dirname(stems), { recursive: true });
        await writeFile(stems, '{"trees":[]}');
    }
    await writeFile(path.join(t.exportDir, 'linkan-inner-surfaces.json'), '{}');

    const reports: string[] = [];
    for (const target of ['terrain', 'photo', 'trees', 'creeks', 'vegetation'] as const) {
        const started = await t.svc.update(TEST_COURSE_ID, target);
        await t.svc.whenIdle(TEST_COURSE_ID);
        const job = t.svc.job(started.id);
        expect(job.error).toBeNull();
        reports.push(...job.results.flatMap(r => r.report));
    }
    const pushes = t.editor!.calls.filter(c => c.command !== 'golfmap.course');
    expect(pushes.map(c => c.command)).toEqual([
        'golfmap.terrain.update', 'golfmap.terrain.update', 'golfmap.orthos.apply',
        'golfmap.trees.plant', 'golfmap.trees.plant', 'golfmap.creeks.import',
        'golfmap.zones.import', 'golfmap.grass.apply',
    ]);
    expect(pushes.every(c => c.args.save === true)).toBe(true);
    // The report says what Unity saved instead of asking for it to be saved.
    const saved = 'Saved Assets/Scenes/Linkan.unity (0.4 s)';
    expect(reports.filter(l => l === saved || l === `inner: ${saved}`).length).toBeGreaterThanOrEqual(4);
    expect(reports.some(l => l.includes('Save the scene in Unity to keep it.'))).toBe(false);
    expect(reports.some(l => l.includes('Save the scene to keep it.'))).toBe(false);
});

test("the vegetation chain plants the inner terrain; the outer only gets its zones file, nothing into Unity (Arborist draws the outer)", async () => {
    const t = await setup({ unity: true });
    await buildSite(t, ['dem.tif', 'dem-edited.tif', 'outer-dem.tif']);
    await writeFile(path.join(t.exportDir, 'linkan-inner-surfaces.json'), '{}');
    // An outer zones export from earlier, which is what made the chain plant the outer.
    await writeFile(path.join(t.exportDir, 'linkan-outer-zones.json'), '{}');

    const started = await t.svc.update(TEST_COURSE_ID, 'vegetation');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.error).toBeNull();
    const pushes = t.editor!.calls.filter(c => c.command !== 'golfmap.course');
    expect(pushes.map(c => [c.command, c.args.terrain])).toEqual([['golfmap.zones.import', 'inner'], ['golfmap.grass.apply', 'inner']]);
    // The generators ran once, for the inner planting.
    expect(t.pipeline.calls.filter(a => path.basename(a[0]!) === 'grass_zones.py')).toHaveLength(1);
    expect(t.pipeline.calls.filter(a => a[1] === 'zones').map(a => flag(a, '--terrain'))).toEqual(['inner', 'outer']);
    const outer = job.phases.find(p => p.id === 'vegetation:outer')!;
    expect(outer.status).toBe('done');
    expect(outer.detail).toBe('outer zones file written; nothing planted in Unity (Arborist draws the outer)');
    expect(job.results.flatMap(r => r.report)).toContain(`outer: ${OUTER_VEGETATION_IS_ARBORIST}`);
});

test('a second update of the same target renders nothing again, and --force does', async () => {
    const t = await setup({ unity: true });
    await buildSite(t, ['dem.tif', 'dem-edited.tif', 'outer-dem.tif']);

    const first = await t.svc.update(TEST_COURSE_ID, 'terrain');
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(first.id).error).toBeNull();
    expect(t.pipeline.commands()).toEqual(['dem', 'dem']);

    // Nothing changed: no render, but both heightmaps still go into Unity.
    const again = await t.svc.update(TEST_COURSE_ID, 'terrain');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const second = t.svc.job(again.id);
    expect(second.error).toBeNull();
    expect(t.pipeline.commands()).toEqual(['dem', 'dem']);
    expect(second.results[0]!.report.filter(l => l.includes('unchanged: '))).toHaveLength(2);
    expect(t.editor!.calls.filter(c => c.command === 'golfmap.terrain.update')).toHaveLength(4);

    const forced = await t.svc.update(TEST_COURSE_ID, 'terrain', { force: true });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(forced.id).error).toBeNull();
    expect(t.pipeline.commands()).toEqual(['dem', 'dem', 'dem', 'dem']);
});

// --- The props row and its chain ---

test('the Props row: blocked without a spec, fresh from the manifest, stale when the spec is newer, and the note from placed.json', async () => {
    const t = await setup({ unity: true });
    expect(row(await t.svc.status(TEST_COURSE_ID), 'props').blocked).toMatch(/^No props spec in .*linkan\/$/);

    // A spec and a manifest Unity's Props folder already holds, both older than the spec's last build.
    const spec = await propsSpec(t);
    const dir = await placedRecord(t, 3);
    await writeFile(path.join(dir, 'props.json'), '{}');
    const anHourAgo = new Date(Date.now() - 3600_000);
    await utimes(spec.gen, anHourAgo, anHourAgo);

    const fresh = row(await t.svc.status(TEST_COURSE_ID), 'props');
    expect(fresh.blocked).toBeNull();
    expect(fresh.lastRun).toBe(await mtimeIso(path.join(dir, 'props.json')));
    expect(fresh.changedSince).toEqual({ count: 0, kinds: [] });
    expect(fresh.stale).toBe(false);
    expect(fresh.note).toBe('3 hand-placed props are kept on update');

    // Edit the generator: one spec changed.
    const now = new Date();
    await utimes(spec.gen, now, now);
    const stale = row(await t.svc.status(TEST_COURSE_ID), 'props');
    expect(stale.changedSince).toEqual({ count: 1, kinds: ['props spec'] });
    expect(stale.stale).toBe(true);

    // No record yet: the note says the first update records the scene before it places.
    await rm(path.join(dir, PROPS_PLACED));
    expect(row(await t.svc.status(TEST_COURSE_ID), 'props').note)
        .toBe('no placed.json yet: the first update records the scene before placing');
    // Every other row keeps `note` empty — it is the Props row's line.
    expect((await t.svc.status(TEST_COURSE_ID)).targets.filter(r => r.note !== null).map(r => r.id)).toEqual(['props']);
});

test('the props chain: the spec in Python, the models in Blender, then record and place in Unity', async () => {
    const t = await setup({ unity: true });
    const spec = await propsSpec(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'props');
    expect(started.phases.map(p => p.id)).toEqual(['props:spec', 'props:models', 'props:unity']);
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('succeeded');

    // Two runs: the generator under the pipeline venv's Python from the repo root, then Blender.
    expect(t.props.which()).toEqual(['python', 'blender']);
    expect(t.props.calls[0]).toEqual(['/pipeline/.venv/python', spec.gen]);
    const out = propsDir(t);
    expect(t.props.calls[1]!.slice(1, 5)).toEqual(['-b', '--factory-startup', '--python', path.join(REPO_DIR, 'blender', 'tools', 'build_props.py')]);
    expect(t.props.calls[1]!.slice(5)).toEqual(['--', '--spec', spec.json, '--out', out]);
    expect(await Bun.file(path.join(out, 'props.json')).exists()).toBe(true);

    // Unity: no placed.json, so the scene is recorded before anything is placed; then the place saves.
    const calls = t.editor!.calls.filter(c => c.command !== 'golfmap.course');
    expect(calls.map(c => c.command)).toEqual(['golfmap.props.record', 'golfmap.props.place']);
    expect(calls[1]!.args.save).toBe(true);

    const report = job.results[0]!.report;
    expect(report).toContain('spec: wrote clubhouse-props.json');
    expect(report).toContain('Unity (linkan_v4): golfmap.props.record — 12 paired by position, 9 still at their index, 2 hand-placed (nothing in the scene was touched)');
    expect(report).toContain('Unity (linkan_v4): golfmap.props.place — placed 48 prop(s), 1 kept where they were moved by hand');
    expect(report).toContain('kept: shed#2 moved by hand 1.42 m / 12.5°');
    expect(report).toContain('warning: the spec moved bench_stone#0 since it was placed by hand: it is back on the spec');
    expect(report).toContain('warning: flag#3 (1) was added by hand in Unity and is left standing');
    expect(report).toContain('warning: dropped the hand-placed shed#7 (hand-placed, but the spec no longer has this instance)');
    expect(report).toContain('Saved Assets/Scenes/Linkan.unity (0.4 s)');
    expect(report.at(-1)).toBe('A hand move becomes permanent only in clubhouse-props.gen.py (docs/workflows.md section 4).');
    expect(job.phases.map(p => [p.id, p.status])).toEqual([
        ['props:spec', 'done'], ['props:models', 'done'], ['props:unity', 'done'],
    ]);

    // Recorded like every other target, and the row is no longer stale.
    const record = JSON.parse(await readFile(path.join(t.exportDir, SYNC_RECORD_FILE), 'utf8')) as GsproSyncRecord;
    expect(record.targets.props!.lastRun).toBe(job.startedAt!);
    expect(typeof record.targets.props!.seconds).toBe('number');
    const after = row(await t.svc.status(TEST_COURSE_ID), 'props');
    expect(after.stale).toBe(false);
    expect(after.note).toBe('no placed.json yet: the first update records the scene before placing');
});

test('a second props update runs neither command again, and the place no longer records first', async () => {
    const t = await setup({ unity: true });
    await propsSpec(t);
    await t.svc.update(TEST_COURSE_ID, 'props');
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.props.calls).toHaveLength(2);
    // The place wrote the record Unity keeps (the fake editor does not, so stand it in).
    await placedRecord(t, 1);
    t.editor!.calls.length = 0;

    const again = await t.svc.update(TEST_COURSE_ID, 'props');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(again.id);
    expect(job.error).toBeNull();
    // Nothing changed: no Python, no Blender — but the props still go into the scene.
    expect(t.props.calls).toHaveLength(2);
    const skipped = job.results[0]!.report.filter(l => l.includes('unchanged: '));
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatch(/^spec: unchanged: clubhouse-props\.json \(inputs unchanged since .+\)$/);
    expect(skipped[1]).toMatch(/^models: unchanged: clubhouse-props\.json \(inputs unchanged since .+\)$/);
    expect(t.editor!.calls.filter(c => c.command !== 'golfmap.course').map(c => c.command)).toEqual(['golfmap.props.place']);

    // --force builds both again.
    const forced = await t.svc.update(TEST_COURSE_ID, 'props', { force: true });
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(forced.id).error).toBeNull();
    expect(t.props.which()).toEqual(['python', 'blender', 'python', 'blender']);
});

test('without Unity the props spec is still written and the models and the place wait for the editor', async () => {
    const t = await setup();
    const spec = await propsSpec(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'props');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('succeeded');
    expect(t.props.which()).toEqual(['python']);
    expect(await Bun.file(spec.json).exists()).toBe(true);

    const phase = (id: string) => job.phases.find(p => p.id === id)!;
    expect(phase('props:spec').status).toBe('done');
    for (const id of ['props:models', 'props:unity']) {
        expect(phase(id).status).toBe('skipped');
        expect(phase(id).detail).toMatch(/^Not in Unity: no open Unity editor imports from /);
    }
    expect(job.results[0]!.report.at(-1)).toMatch(/the spec is written; the models and the place wait for the editor$/);
});

test('a props generator that fails fails the job with the last of its output, and the models never run', async () => {
    const t = await setup({ unity: true, propsFails: 'the spec' });
    await propsSpec(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'props');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Props: The props spec (clubhouse-props.gen.py) failed:'
        + ' Traceback (most recent call last) ModuleNotFoundError: no rasterio');
    expect(job.phases.find(p => p.id === 'props:spec')!.status).toBe('failed');
    expect(job.phases.find(p => p.id === 'props:models')!.status).toBe('skipped');
    expect(t.editor!.calls.some(c => c.command.startsWith('golfmap.props'))).toBe(false);
});

test("Blender's last words land in the phase when building the props models fails", async () => {
    const t = await setup({ unity: true, propsFails: 'the models' });
    await propsSpec(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'props');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Props: Building the props (clubhouse-props.json) failed: Error: asset shed has no parts');
    expect(job.phases.find(p => p.id === 'props:models')!.detail).toBe('Building the props (clubhouse-props.json) failed: Error: asset shed has no parts');
    expect(job.phases.find(p => p.id === 'props:unity')!.status).toBe('skipped');
});

test('Blender quitting 0 without writing props.json is a failure, not a silent success', async () => {
    const t = await setup({ unity: true, propsFails: 'the models, quietly' });
    await propsSpec(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'props');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('Props: Building the props (clubhouse-props.json) wrote no props.json'
        + ' (Blender quit 0 — read the traceback) failed: KeyError: material concrete_weathered has no textures');
    // Nothing was placed in Unity off a manifest that was never written.
    expect(t.editor!.calls.some(c => c.command.startsWith('golfmap.props'))).toBe(false);
});

// --- The photo chain's vintage ---

test('the photo chain renders the ACTIVE vintage, its cleaned copy when there is one, never another vintage', async () => {
    const t = await setup({ unity: true });
    // The map shows orto-l2-2025 (buildSite's manifest); the cleaned file left over is 2023's.
    const sources = await buildSite(t, [
        'dem.tif', 'ortho-orto-l2-2025.tif', 'ortho-orto-l2-2023.tif', 'ortho-orto-l2-2023.cleaned.tif',
    ]);

    const first = await t.svc.update(TEST_COURSE_ID, 'photo');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const plain = t.svc.job(first.id);
    expect(plain.error).toBeNull();
    expect(plain.results[0]!.report[0]).toBe('photo: orto-l2-2025, no cleaned photo yet: the photo as built');
    expect(await Bun.file(path.join(t.exportDir, 'linkan-orto-l2-2025-clean-8192.jpg')).exists()).toBe(true);
    // The 2023 cleaned leftover is not rendered, and the outer square is the same vintage.
    const written = await readdir(t.exportDir);
    expect(written.filter(n => n.includes('orto-l2-2023'))).toEqual([]);
    expect(written).toContain('linkan-outer-orto-l2-2025-clean-8192.jpg');

    // Clean the active vintage: now that is what goes in, and the report says so.
    await writeFile(path.join(sources, 'ortho-orto-l2-2025.cleaned.tif'), '');
    const second = await t.svc.update(TEST_COURSE_ID, 'photo');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const cleaned = t.svc.job(second.id);
    expect(cleaned.error).toBeNull();
    expect(cleaned.results[0]!.report[0]).toBe('photo: orto-l2-2025, cleaned');
    expect(await Bun.file(path.join(t.exportDir, 'linkan-orto-l2-2025-cleaned-clean-8192.jpg')).exists()).toBe(true);
    expect(cleaned.phases.find(p => p.id === 'photo:inner')!.detail)
        .toBe('linkan-orto-l2-2025-cleaned-clean-8192.jpg (+ its -terrain and -meshes twins)');
});

// --- The meshes chain (the shaping job it mirrors) ---

/** A .blend in the export folder, so the Meshes row is not blocked. */
const blendFile = (t: Setup) => writeFile(path.join(t.exportDir, 'linkan_svg_1.blend'), '');

test("the meshes chain mirrors the shaping job's own phase statuses and seconds, not the poll interval", async () => {
    const hold = gate();
    const t = await setup({ hold: hold.promise, holdFor: 'shaping-global' });
    await blendFile(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'meshes');
    expect(started.phases.map(p => p.id)).toEqual(['meshes:layers', 'meshes:worker', 'meshes:blender', 'meshes:unity', 'meshes:vegetation']);
    // The shaping job sits in its layers phase while the pipeline is held: ours counts ITS seconds,
    // not the time since the last poll (which `begin()` on every poll would show, ~5 ms).
    await Bun.sleep(300);
    const during = t.svc.job(started.id);
    const layersNow = during.phases.find(p => p.id === 'meshes:layers')!;
    expect(layersNow.status).toBe('running');
    expect(layersNow.seconds).toBeGreaterThanOrEqual(0.25);
    expect(during.phase).toBe('meshes:layers');

    hold.open();
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    // The shaping run itself failed (no worker can start in a test), which is beside the point here:
    // every phase it reported is in ours with the status, detail and seconds IT measured.
    const shaped = t.shaping.current(TEST_COURSE_ID)!;
    const theirs = (id: string) => shaped.phases.find(p => p.id === id)!;
    const mine = (id: string) => job.phases.find(p => p.id === `meshes:${id}`)!;
    expect(mine('layers')).toMatchObject({ status: 'done', detail: theirs('layers').detail, seconds: theirs('layers').seconds });
    expect(mine('layers').seconds).toBeGreaterThanOrEqual(0.25);
    expect(mine('worker')).toMatchObject({ status: 'failed', detail: theirs('worker').detail, seconds: theirs('worker').seconds });
    // The phases the shaping job never reached are cut short by this job, as any failed chain's are.
    expect(mine('unity')).toMatchObject({ status: 'skipped', detail: 'Meshes failed' });
    expect(job.step).toMatch(/^failed \(starting the shaping worker\): Meshes: /);
    await t.shaping.whenIdle();
});

test('the meshes chain gives up on a shaping run that does not settle, and on one it can no longer follow', async () => {
    const hold = gate();
    const t = await setup({ hold: hold.promise, holdFor: 'shaping-global', meshesTimeoutMs: 120 });
    await blendFile(t);

    const started = await t.svc.update(TEST_COURSE_ID, 'meshes');
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/^Meshes: The shaping run \(job .*\) has not finished after 0\.1 s — it is on "Generating layers/);
    expect(job.error).toMatch(/run Update meshes again once the worker is free$/);
    // The phase it was mirroring is the one that failed, so the board points at it.
    expect(job.phases.find(p => p.id === 'meshes:layers')!.status).toBe('failed');
    hold.open();
    await t.shaping.whenIdle();

    // A shaping job this process no longer has (a restart, or another apply of the course forgot it).
    const gone = await setup({
        shapingOver: {
            job: (id: string) => { throw new NotFoundError(`No shaping job ${id} (the server may have restarted)`); },
        },
    });
    await blendFile(gone);
    const orphan = await gone.svc.update(TEST_COURSE_ID, 'meshes');
    await gone.svc.whenIdle(TEST_COURSE_ID);
    expect(gone.svc.job(orphan.id).error)
        .toMatch(/^Meshes: The shaping run \(job .*\) can no longer be followed: No shaping job /);
    await gone.shaping.whenIdle();
});

// --- Waiting for what is really in the way ---

test("a meshes update queues behind ANOTHER course's shaping run instead of failing on the one worker", async () => {
    const hold = gate();
    const t = await setup({ hold: hold.promise, holdFor: 'shaping-global' });
    await t.db.insertInto('courses')
        .values({ id: 'course-2', name: 'Vreta', status: 'draft', revision: 1, crs: 'EPSG:3006', version: 1 })
        .execute();
    await blendFile(t);

    // Vreta's apply takes the machine's one Blender worker (held in its layers phase).
    const other = await t.shaping.apply('course-2');
    expect(other.status).toBe('running');

    const started = await t.svc.update(TEST_COURSE_ID, 'meshes');
    expect(started.phases[0]).toMatchObject({ id: 'wait', label: 'Waiting for the shaping run for Vreta' });
    await Bun.sleep(20);
    expect(t.svc.job(started.id)).toMatchObject({ status: 'running', phase: 'wait' });
    expect(t.svc.job(started.id).phases[0]!.detail).toBe('the shaping run for Vreta');
    // Nothing of ours has started: no apply of this course was refused in the meantime.
    expect(t.shaping.current(TEST_COURSE_ID)).toBeNull();

    hold.open();
    await t.svc.whenIdle(TEST_COURSE_ID);
    const job = t.svc.job(started.id);
    expect(job.phases[0]).toMatchObject({ status: 'done', detail: 'waited for the shaping run for Vreta' });
    // It then ran its own apply (which fails for want of a worker here) — never a 409 from the queue.
    expect(t.shaping.current(TEST_COURSE_ID)).not.toBeNull();
    expect(job.error ?? '').not.toMatch(/already going/);
    await t.shaping.whenIdle();
});

test('a queued job whose blocker has finished says the way was clear instead of waiting for itself', async () => {
    const hold = gate();
    const t = await setup({ hold: hold.promise, holdFor: 'svg' });

    const first = await t.svc.update(TEST_COURSE_ID, 'shapes');
    const second = await t.svc.update(TEST_COURSE_ID, 'shapes');
    expect(second.phases[0]!.label).toBe('Waiting for the GSPro update already running for this course');

    hold.open();
    await t.svc.whenIdle(TEST_COURSE_ID);
    expect(t.svc.job(first.id).status).toBe('succeeded');
    const done = t.svc.job(second.id);
    expect(done.status).toBe('succeeded');
    // By its turn the first job was over: the phase is skipped, not a wait for the job itself.
    expect(done.phases[0]).toMatchObject({ id: 'wait', status: 'skipped', detail: 'nothing else was running' });
});

test('the Unity chip lists every open editor and which one works on the course', async () => {
    const t = await setup({ unity: true });
    const unity = await t.svc.unity(TEST_COURSE_ID);
    expect(unity.matched).toBe('linkan_v4');
    expect(unity.editors).toHaveLength(1);
    expect(unity.editors[0]).toMatchObject({ projectName: 'linkan_v4', activeCourse: 'Linkan', matches: true, error: null });
    expect(unity.editors[0]!.exportFolder).toBe(t.exportDir);
});

test('every open Unity editor is probed side by side, so the chip does not cost one round trip after another', async () => {
    const discovery = await tmp('bridges-');
    const dir = await tmp('gspro-sync-out-');
    const slow = 300;
    // Two editors, each taking its time over the course probe (the real one is capped at 30 s each).
    for (const [n, name] of [[1, 'alpha_v1'], [2, 'beta_v2']] as const) {
        const editor = fakeEditor(path.relative(path.join(await tmp('unity-proj-'), 'Assets'), dir), name, slow);
        writeFileSync(path.join(discovery, `bridge-${n}.json`), JSON.stringify({
            pid: process.pid, port: editor.server.port, token: 'tok', projectPath: await tmp('unity-proj-'),
            projectName: name, unityVersion: '2018.2.8f1', started: '',
        }));
    }

    const t0 = Date.now();
    const editors = await unityEditorsFor(defaultUnityBridge(discovery), dir);
    const elapsed = Date.now() - t0;

    expect(editors.map(e => e.projectName)).toEqual(['alpha_v1', 'beta_v2']);   // discovery order (by project name)
    expect(editors.every(e => e.activeCourse === 'Linkan')).toBe(true);
    expect(elapsed).toBeLessThan(2 * slow);
});
