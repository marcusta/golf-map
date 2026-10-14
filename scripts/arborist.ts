// The Arborist iteration loop as one command — what docs/gspro/arborist.md's
// "the loop by hand" lists as four commands (regenerate, ResetVSPro, LoadData,
// wait, screenshot), in one go and with a real signal for when the load is
// done:
//
//   bun run arborist -- <course> [--trees|--lower|--all] [--no-reload]
//                      [--screenshot [<view>...]] [--close-others]
//                      [--wait <s>] [--settle <s>] [--size <w>x<h>] [--frames <n>]
//
// <course> is a course id, slug or a unique name substring ("vreta"). Its
// GSPro course folder and export folder come from the course's own settings
// (the export panel's; `GsproExportService.settings`), nothing is configured
// here.
//
//   (no part flag) | --all   the lower vegetation, then the planted trees
//   --lower                  only `arborist.py lower` (about 10 s on Vreta; needs no Unity)
//   --trees                  only `arborist.py trees`
//   --no-reload              write the file and stop (the same as `bun run gspro:export -- <course> arborist`)
//   --screenshot [<view>...] after the reload, a picture (plus fps and what stands in the middle)
//                            at the course's judged viewpoints (docs/gspro/<slug>/perf-views.json);
//                            no name = every one, a name = a part of one
//   --close-others           close Unity and GreenKeeper first: Arborist with a course takes 11-12 GB
//                            and dies at start beside them, and the death shows up only as
//                            "no bridge answered" (docs/gspro/arborist.md, "Memory")
//   --wait <s>               cap for the wait after LoadData (default 85, the documented wait)
//   --settle <s>             seconds the camera stands still before each screenshot (default 6;
//                            25 for frame rates worth quoting, as unity/ArboristMod/perf.ts does)
//   --out <folder>           a trial: write the file there instead of into the GSPro course folder
//                            (the course's own file is still the base). Arborist reloads its own,
//                            so pair it with --no-reload
//
// The file itself is written by the server's own ArboristService — the service
// the web command bar's "Update vegetation" runs after it has planted
// (server/services/arborist.service.ts): same inputs, same arguments, same
// report lines. The trees normally come out of the open Unity editor's scene
// (`golfmap.trees.dump`); with Unity closed (or --close-others) the dump the
// last run wrote is kept, which is what an iteration over looks and species
// wants — the planting has not changed.
//
// The reload goes through the GolfMap mod in the running Arborist
// (unity/ArboristMod/call.ts: ResetVSPro, LoadData). Nothing here starts
// Arborist or loads a course in it.
//
// Reads data/app.sqlite (DB_PATH) and data/ (DATA_DIR) like the server.
import '../server/env-paths';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import {
    GsproExportService, courseSlug, defaultRunner, statOrNull, venvPython,
} from '../server/services/gspro-export.service';
import { ArboristService, type ArboristCourse } from '../server/services/arborist.service';
import { defaultUnityBridge, editorForExportDir, type UnityEditor } from '../server/services/unity-bridge';
import { loadViews, type Viewpoint } from '../unity/perf-rank';
import { player as playerBridge } from '../unity/ArboristMod/call';
import { run as bridgeRun } from '../unity/mcp/bridge';

/** Arborist's own vegetation system: the type and methods the reload goes through. */
export const VSPRO_TYPE = 'AAT.ExportVSPro';
/** docs/gspro/arborist.md's documented wait after LoadData, and the cap on the real signal. */
export const DEFAULT_WAIT_SEC = 85;
/** `veg.systems` is polled this often while the vegetation loads. */
export const LOAD_POLL_MS = 3000;
/** Seconds the camera stands still before a screenshot (a moved camera loads cells for a while). */
export const DEFAULT_SETTLE_SEC = 6;
const RESET_TIMEOUT_SEC = 60;
const LOAD_TIMEOUT_SEC = 180;
const SHOT_TIMEOUT_SEC = 180;
const SMALL_CALL_SEC = 30;
/** Arborist with a course loaded takes this much (docs/gspro/arborist.md, "Memory"). */
const ARBORIST_GB = 11;

export interface PlayerBridgeLike {
    /** What answered, for the log line. */
    name: string;
    call(command: string, args?: Record<string, unknown>, timeoutSec?: number): Promise<any>;
}

/** Everything outside this script: the two apps, the processes and the clock. Injected so the loop is testable. */
export interface LoopDeps {
    /** The Arborist bridge, or null when nothing answered (then the step says why). */
    player(): Promise<PlayerBridgeLike | null>;
    /** The open Unity editor whose active course exports to `exportDir`, or null — a fresh trees dump. */
    unityEditor(exportDir: string): Promise<UnityEditor | null>;
    /** The heavy apps running right now, by process name, for the no-bridge diagnosis. */
    runningApps(): Promise<string[]>;
    /** Close Unity and GreenKeeper, as `unity/ArboristMod/apps.ps1 close` does (that one also stops Arborist). */
    closeOthers(): Promise<string>;
    /** The course's judged viewpoints; throws when the course has no perf-views.json. */
    views(slug: string): Viewpoint[];
    /** Free and total RAM in GB, for the diagnosis. */
    memoryGb(): { free: number; total: number };
    log(line: string): void;
    now(): number;
    sleep(ms: number): Promise<void>;
}

export interface LoopOptions {
    lower: boolean;
    trees: boolean;
    reload: boolean;
    /** null = no screenshots; [] = every viewpoint; else parts of viewpoint names. */
    screenshot: string[] | null;
    closeOthers: boolean;
    waitSec: number;
    settleSec: number;
    width: number;
    height: number;
    frames: number;
}

export interface LoopStep {
    id: 'close-others' | 'lower' | 'trees' | 'bridge' | 'reload' | 'screenshots';
    label: string;
    status: 'done' | 'failed';
    seconds: number;
    lines: string[];
}

export interface LoopResult {
    /** The steps that ran, in order. */
    steps: LoopStep[];
    /** The step that failed, if one did — nothing after it ran. */
    failed: LoopStep | null;
}

export const defaultOptions = (): LoopOptions => ({
    lower: true, trees: true, reload: true, screenshot: null, closeOthers: false,
    waitSec: DEFAULT_WAIT_SEC, settleSec: DEFAULT_SETTLE_SEC, width: 1280, height: 720, frames: 20,
});

const MARK: Record<LoopStep['status'], string> = { done: 'ok     ', failed: 'FAILED ' };

/**
 * One pass of the loop: write the course's Arborist file (the server's own
 * service), reload it in the running Arborist, take the screenshots. Each step
 * prints one status line with its elapsed seconds and its report lines under
 * it; the first failure stops the rest.
 */
export async function runArboristLoop(
    arborist: ArboristService, course: ArboristCourse, opts: LoopOptions, deps: LoopDeps,
): Promise<LoopResult> {
    const result: LoopResult = { steps: [], failed: null };
    const slug = courseSlug(course.name);
    // Assigned by the 'bridge' step; read by the ones after it (a closure, so no narrowing).
    const bridge: { player: PlayerBridgeLike | null } = { player: null };

    async function step(id: LoopStep['id'], label: string, body: () => Promise<string[]>): Promise<void> {
        if (result.failed) return;
        const t0 = deps.now();
        deps.log(`...     ${label}`);
        const entry: LoopStep = { id, label, status: 'done', seconds: 0, lines: [] };
        try {
            entry.lines = await body();
        } catch (e) {
            entry.status = 'failed';
            entry.lines = [(e as Error).message];
            result.failed = entry;
        }
        entry.seconds = Math.round((deps.now() - t0) / 100) / 10;
        result.steps.push(entry);
        deps.log(`${MARK[entry.status]} ${label} (${entry.seconds} s)`);
        // A report line may itself be several (the no-bridge diagnosis is two): indent them all.
        for (const line of entry.lines) for (const part of line.split('\n')) deps.log(`        ${part}`);
    }

    function answered(): PlayerBridgeLike {
        if (!bridge.player) throw new Error('the Arborist bridge was not checked (a bug in this script)');
        return bridge.player;
    }

    if (opts.closeOthers) {
        await step('close-others', 'close Unity and GreenKeeper (memory for Arborist)', async () => [await deps.closeOthers()]);
    }
    if (opts.lower) {
        await step('lower', 'arborist.py lower — the lower vegetation', () => arborist.lower(course));
    }
    if (opts.trees) {
        await step('trees', 'arborist.py trees — the planted trees', async () => {
            // Unity's scene is where the trees' positions and ground heights are, but it and Arborist
            // do not fit in memory together: with it closed the dump of the last plant is kept.
            const editor = opts.closeOthers ? null : await deps.unityEditor(course.exportDir);
            const stand = editor ? null : dumpOnDisk();
            const lines = await arborist.trees(course, editor ?? stand!);
            if (stand?.read) {
                lines.push(`the trees are the dump on disk — ${stand.read.trees} trees, written ${stand.read.written} `
                    + `(${stand.read.file}); Unity is not open, so the positions are the last plant's`);
            }
            return lines;
        });
    }
    if (opts.reload || opts.screenshot) {
        await step('bridge', 'the Arborist bridge', async () => {
            bridge.player = await deps.player();
            if (!bridge.player) throw new Error(await noBridge(deps, opts));
            return [`${bridge.player.name} answered`];
        });
    }
    if (opts.reload) {
        await step('reload', 'reload in Arborist (ResetVSPro, LoadData)', async () => {
            const player = answered();
            if (!course.courseDir) {
                throw new Error("the GSPro course folder is not set, so there is no scene to reset: set it in the export panel "
                    + '(or bun run gspro:export -- <course> gkd --course-dir <folder>)');
            }
            // Arborist names its vegetation system by the course's scene, which is the folder's name.
            const scene = path.basename(course.courseDir);
            const lines: string[] = [];
            const t0 = deps.now();
            await player.call('call', { type: VSPRO_TYPE, method: 'ResetVSPro', args: [scene] }, RESET_TIMEOUT_SEC);
            lines.push(`ResetVSPro('${scene}') after ${seconds(deps, t0)} s`);
            const t1 = deps.now();
            await player.call('call', { type: VSPRO_TYPE, instance: 0, method: 'LoadData' }, LOAD_TIMEOUT_SEC);
            lines.push(`LoadData returned after ${seconds(deps, t1)} s`);
            lines.push(await waitForLoad(player, opts.waitSec, deps));
            return lines;
        });
    }
    if (opts.screenshot) {
        await step('screenshots', 'screenshots at the course\'s viewpoints', async () => {
            const player = answered();
            const views = pickViews(deps.views(slug), opts.screenshot!, slug);
            const lines: string[] = [];
            for (const view of views) lines.push(await shoot(player, view, opts, deps));
            return lines;
        });
    }
    return result;
}

const seconds = (deps: LoopDeps, from: number) => Math.round((deps.now() - from) / 100) / 10;

/**
 * Stands in for the open Unity editor when it is closed: `golfmap.trees.dump`
 * keeps the dump the last run wrote instead of writing a new one. The service
 * asks for the dump by path, so the path stays its own.
 */
export function dumpOnDisk(): UnityEditor & { read: { file: string; trees: number; written: string } | null } {
    const stand = {
        projectPath: '',
        projectName: 'no Unity open',
        read: null as { file: string; trees: number; written: string } | null,
        async run(command: string, args: Record<string, unknown> = {}): Promise<any> {
            if (command !== 'golfmap.trees.dump') throw new Error(`Unity is not open, so '${command}' cannot run`);
            const file = String(args.file ?? '');
            const stat = await statOrNull(file);
            if (!stat) {
                throw new Error(`the planted-trees dump ${file} is not there yet. Open the course's Unity project and plant once `
                    + '(web command bar "Update vegetation", or bun run gspro:export -- <course> arborist), which writes it');
            }
            const doc = JSON.parse(await readFile(file, 'utf8')) as { items?: { instances?: unknown[] }[] };
            const trees = (doc.items ?? []).reduce((n, i) => n + (i.instances?.length ?? 0), 0);
            stand.read = { file, trees, written: stat.mtime.toISOString().slice(0, 16).replace('T', ' ') };
            return { file, bytes: stat.size, catalogues: [{ catalogue: 'the dump on disk', trees }] };
        },
    };
    return stand;
}

/**
 * Wait out the vegetation load with a real signal instead of the documented 85
 * s: ResetVSPro empties the system, so `veg.systems` counts the stored
 * instances back up as the file loads. Done when the count is above zero and
 * the same twice in a row. `waitSec` is the cap, and all there is when the
 * build has no `veg.systems`.
 */
export async function waitForLoad(player: PlayerBridgeLike, waitSec: number, deps: LoopDeps): Promise<string> {
    const t0 = deps.now();
    const left = () => waitSec * 1000 - (deps.now() - t0);
    let last = '';
    let polls = 0;
    for (;;) {
        if (left() <= 0) {
            return `no steady vegetation count within the ${waitSec} s cap (last: ${last || 'nothing counted'}) — carried on, `
                + 'the picture may still be filling in';
        }
        await deps.sleep(Math.min(LOAD_POLL_MS, left()));
        let systems: { storedInstances?: number; packages?: unknown[] }[];
        try {
            systems = ((await player.call('veg.systems', { items: false }, SMALL_CALL_SEC))?.systems ?? []) as typeof systems;
        } catch (e) {
            await deps.sleep(Math.max(0, left()));
            return `veg.systems did not answer (${(e as Error).message.split('\n')[0]}), so no signal: `
                + `waited the documented ${waitSec} s instead`;
        }
        polls++;
        const stored = systems.reduce((n, s) => n + (s.storedInstances ?? 0), 0);
        const packages = systems.reduce((n, s) => n + (s.packages?.length ?? 0), 0);
        const now = `${stored} stored instances in ${packages} package(s)`;
        if (stored > 0 && now === last) {
            return `load done after ${seconds(deps, t0)} s: ${now}, unchanged over two polls of veg.systems (${polls} polls)`;
        }
        last = now;
    }
}

/** The named viewpoints, or every one; throws with the file's names when nothing matches. */
export function pickViews(views: Viewpoint[], wanted: string[], slug: string): Viewpoint[] {
    if (!wanted.length) {
        if (!views.length) throw new Error(`docs/gspro/${slug}/perf-views.json holds no viewpoints`);
        return views;
    }
    const picked = views.filter((v) => wanted.some((q) => v.name.toLowerCase().includes(q.toLowerCase())));
    if (!picked.length) {
        throw new Error(`no viewpoint of ${slug} matches ${wanted.map((q) => `'${q}'`).join(' or ')}; the file has: `
            + views.map((v) => v.name).join(', '));
    }
    return picked;
}

/** One viewpoint: pose the camera (the app's own keys keep working), let it settle, picture, frame rate, what stands in the middle. */
async function shoot(player: PlayerBridgeLike, view: Viewpoint, opts: LoopOptions, deps: LoopDeps): Promise<string> {
    const pose: Record<string, unknown> = { position: view.position, rotation: view.rotation };
    if (view.eye != null) pose.eye = view.eye;
    await player.call('camera', pose, SMALL_CALL_SEC);
    await deps.sleep(opts.settleSec * 1000);
    const shot = await player.call('screenshot', { width: opts.width, height: opts.height, frames: opts.frames }, SHOT_TIMEOUT_SEC);
    const fps = await player.call('fps', { seconds: 2 }, SMALL_CALL_SEC).catch(() => null);
    const at = await player.call('veg.at', { u: 0.5, v: 0.5 }, SMALL_CALL_SEC).catch(() => null);
    const centre = at?.instances?.[0];
    return `${view.name}: ${shot?.file ?? '(no file)'}`
        + (fps ? ` | ${fps.fps} fps, 1 % low ${fps.onePercentLowFps} (${fps.resolution} ${fps.quality})` : '')
        + (centre ? ` | middle of the picture: ${centre.item} at ${Math.round(Number(centre.distance))} m` : ' | middle of the picture: nothing placed');
}

/**
 * Why no bridge answered — the one thing a bare timeout never says. Arborist
 * dying of out-of-memory at start looks exactly like this.
 */
export async function noBridge(deps: LoopDeps, opts: LoopOptions): Promise<string> {
    const apps = await deps.runningApps();
    const arborist = apps.some((a) => /arborist/i.test(a));
    const { free, total } = deps.memoryGb();
    const others = apps.filter((a) => /unity|greenkeeper/i.test(a));
    const first = arborist
        ? 'Arborist is running but its GolfMap bridge did not answer: the mod is not loaded (BepInEx — see BepInEx/LogOutput.log '
          + 'next to Arborist.exe, build with unity/ArboristMod/build.ps1), or it is busy loading a course — try again in a minute'
        : 'Arborist is not running: start it and open the course (pwsh unity/ArboristMod/apps.ps1 start), then run this again. '
          + `It also dies of out-of-memory at start without leaving a window: it needs about ${ARBORIST_GB} GB with a course loaded`;
    const second = `free RAM ${free.toFixed(1)} of ${total.toFixed(1)} GB; running: ${apps.length ? apps.join(', ') : 'none of Arborist, Unity, GreenKeeper, GSPro'}`
        + (others.length && !opts.closeOthers ? ' — --close-others closes Unity and GreenKeeper first' : '');
    return `no bridge answered. ${first}\n${second}`;
}

// ───────────────────────────── the real deps ─────────────────────────────

/** The GolfMap mod in the running Arborist (GOLFMAP_PLAYER picks another player). */
async function realPlayer(): Promise<PlayerBridgeLike | null> {
    let info;
    try {
        info = playerBridge(process.env.GOLFMAP_PLAYER || 'arborist');
    } catch {
        return null; // no discovery file: not running, or the mod is not loaded
    }
    try {
        // A cheap command, to be sure the listener is really there.
        await bridgeRun(info, 'scene', {}, SMALL_CALL_SEC);
    } catch {
        return null;
    }
    return {
        name: `${info.projectPath} (pid ${info.pid}, port ${info.port})`,
        call: (command, args = {}, timeoutSec = SMALL_CALL_SEC) => bridgeRun(info, command, args, timeoutSec),
    };
}

/** The heavy apps, by process name. Empty when `tasklist` is not there (not Windows). */
async function realRunningApps(): Promise<string[]> {
    const names = ['Arborist', 'Unity', 'GreenKeeper', 'GSPro'];
    try {
        const proc = Bun.spawn(['tasklist', '/fo', 'csv', '/nh'], { stdout: 'pipe', stderr: 'ignore' });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return names.filter((n) => new RegExp(`^"${n}\\.exe"`, 'im').test(out));
    } catch {
        return [];
    }
}

/**
 * Unity and GreenKeeper closed, the way `unity/ArboristMod/apps.ps1 close`
 * does it (a window-close request, then wait). That script is not used because
 * it stops Arborist too, and this loop needs it up with the course loaded.
 */
async function realCloseOthers(): Promise<string> {
    const list = "Get-Process Unity,GreenKeeper -ErrorAction SilentlyContinue";
    const script = `${list} | Where-Object { $_.MainWindowTitle } | ForEach-Object { [void]$_.CloseMainWindow() }; `
        + `for ($i = 0; $i -lt 60 -and (${list}); $i++) { Start-Sleep 2 }; `
        + `$left = (${list}).ProcessName; `
        + "if ($left) { 'still open: ' + ($left -join ', ') + ' (a dialog? an unsaved scene?)' } else { 'Unity and GreenKeeper are closed.' }";
    const proc = Bun.spawn(['pwsh', '-NoProfile', '-Command', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    const text = out.trim() || err.trim();
    if (code !== 0) throw new Error(`could not close Unity and GreenKeeper: ${text || `pwsh exited ${code}`}`);
    if (/still open/.test(text)) throw new Error(text);
    return text;
}

export function realDeps(unityDiscoveryDir?: string): LoopDeps {
    const unity = defaultUnityBridge(unityDiscoveryDir);
    return {
        player: realPlayer,
        unityEditor: async (exportDir) => (await editorForExportDir(unity, exportDir)).editor,
        runningApps: realRunningApps,
        closeOthers: realCloseOthers,
        views: (slug) => loadViews(slug),
        memoryGb: () => ({ free: os.freemem() / 1e9, total: os.totalmem() / 1e9 }),
        log: (line) => console.log(line),
        now: () => Date.now(),
        sleep: (ms) => Bun.sleep(ms),
    };
}

// ───────────────────────────────── the CLI ─────────────────────────────────

const ROOT = path.resolve(import.meta.dir, '..');

export function usageText(): string {
    return [
        'usage: bun run arborist -- <course> [--trees|--lower|--all] [--no-reload] [--screenshot [<view>...]] [--close-others]',
        '                            [--wait <s>] [--settle <s>] [--size <w>x<h>] [--frames <n>] [--out <folder>]',
        '',
        '<course>          course id, slug or a unique name substring',
        '--lower|--trees   only that half of the file (default: both, as --all)',
        '--no-reload       write the file only, no Arborist',
        '--screenshot      after the reload, at the viewpoints of docs/gspro/<slug>/perf-views.json',
        '--close-others    close Unity and GreenKeeper first (Arborist needs 11-12 GB)',
        "--out <folder>    a trial: write the file there, leave the course folder's alone",
    ].join('\n');
}

/** The command line, or an error to print with the usage. `out` is the trial folder of --out. */
export function parseArgs(argv: string[]): { course: string; opts: LoopOptions; out: string | null } | { error: string } {
    const opts = defaultOptions();
    let course: string | null = null;
    let out: string | null = null;
    const parts = new Set<'lower' | 'trees'>();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const value = () => {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) return null;
            i++;
            return v;
        };
        if (!a.startsWith('--')) {
            if (course) return { error: `name one course, not '${course}' and '${a}'` };
            course = a;
        } else if (a === '--all') { parts.add('lower'); parts.add('trees'); }
        else if (a === '--lower') parts.add('lower');
        else if (a === '--trees') parts.add('trees');
        else if (a === '--no-reload') opts.reload = false;
        else if (a === '--close-others') opts.closeOthers = true;
        else if (a === '--screenshot') {
            opts.screenshot = [];
            for (let v = value(); v !== null; v = value()) opts.screenshot.push(v);
        } else if (a === '--wait' || a === '--settle' || a === '--frames') {
            const v = value();
            if (v === null || !Number.isFinite(Number(v))) return { error: `${a} needs a number` };
            if (a === '--wait') opts.waitSec = Number(v);
            else if (a === '--settle') opts.settleSec = Number(v);
            else opts.frames = Number(v);
        } else if (a === '--out') {
            const v = value();
            if (v === null) return { error: '--out needs a folder' };
            out = path.resolve(v);
        } else if (a === '--size') {
            const v = value();
            const m = /^(\d+)x(\d+)$/.exec(v ?? '');
            if (!m) return { error: '--size needs <width>x<height>, e.g. 1920x1080' };
            opts.width = Number(m[1]);
            opts.height = Number(m[2]);
        } else return { error: `unknown option ${a}` };
    }
    if (!course) return { error: 'name a course' };
    // No part flag means the whole file, the same as --all.
    opts.lower = parts.size === 0 || parts.has('lower');
    opts.trees = parts.size === 0 || parts.has('trees');
    return { course, opts, out };
}

async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if ('error' in parsed) {
        console.error(`error: ${parsed.error}\n\n${usageText()}`);
        process.exit(2);
    }
    const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
    const dbPath = process.env.DB_PATH ?? path.join(ROOT, 'data', 'app.sqlite');
    const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
    const courseDocsRoot = path.join(ROOT, 'docs', 'gspro');
    if (!await statOrNull(dbPath)) {
        console.error(`error: no database at ${dbPath}`);
        process.exit(2);
    }
    const db = createDb<Database>(dbPath);
    const courses = new CoursesService(db);
    const exporter = new GsproExportService({
        db, courses, assets: new AssetsService(db, dataDir), dataDir,
        terrainEdits: new TerrainEditsService(db), pipelineDir, courseDocsRoot,
    });
    const arborist = new ArboristService({
        dataDir, pipelineDir, courseDocsRoot,
        runner: defaultRunner(process.env.MAP_PIPELINE_PYTHON ?? venvPython(pipelineDir)),
        outDir: parsed.out ?? undefined,
    });
    try {
        // The same resolution as scripts/gspro-export.ts: id, name, slug or a unique name substring.
        const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
        const q = parsed.course.toLowerCase();
        const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q || courseSlug(r.name) === q);
        const picked = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
        if (picked.length !== 1) {
            const names = (picked.length ? picked : rows).map((r) => `  ${r.name} (${r.id})`).join('\n');
            console.error(`error: ${picked.length ? 'several' : 'no'} courses match '${parsed.course}':\n${names}`);
            process.exit(2);
        }
        const row = picked[0]!;
        const settings = await exporter.settings(row.id);
        const course: ArboristCourse = { name: row.name, exportDir: settings.dir, courseDir: settings.courseDir };
        if (!await arborist.used(course)) {
            console.error(`error: ${row.name} is not an Arborist course: no docs/gspro/${courseSlug(row.name)}/arborist-species.json`);
            process.exit(2);
        }
        console.log(`${row.name} (${row.id})`);
        console.log(`GSPro course folder: ${course.courseDir ?? '(not set — bun run gspro:export -- <course> gkd --course-dir <folder>)'}`);
        console.log(`export folder:       ${course.exportDir}`);
        if (parsed.out) console.log(`trial: the file goes to ${parsed.out}, the course folder's is left alone (Arborist still reloads its own)`);
        const t0 = Date.now();
        const result = await runArboristLoop(arborist, course, parsed.opts, realDeps());
        const total = ((Date.now() - t0) / 1000).toFixed(1);
        if (result.failed) {
            const why = (result.failed.lines[0] ?? 'no reason given').split('\n').join('\n  ');
            console.error(`\nFAILED in ${total} s at '${result.failed.label}':\n  ${why}`);
            process.exit(1);
        }
        console.log(`\ndone in ${total} s: ${result.steps.map((s) => s.id).join(', ')}`);
    } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
    } finally {
        await db.destroy();
    }
}

if (import.meta.main) await main();
