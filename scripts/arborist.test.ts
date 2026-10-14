/**
 * `bun run arborist -- <course>` is the Arborist iteration loop (docs/gspro/arborist.md):
 * regenerate the course's Arborist file, reload it in the running Arborist, take the
 * screenshots. Everything it drives lives outside the repo — Python with the wrapper key,
 * a modded Arborist with 11 GB of vegetation loaded, an open Unity editor — so the loop
 * takes them as deps and this pins what it does with them:
 *
 *   - the step order, and that the first failure stops the rest;
 *   - the --lower / --trees / --no-reload variants (which Python command runs, whether
 *     Arborist is touched at all);
 *   - the load-done signal: `veg.systems` polled until the stored-instance count stops
 *     changing, with the documented 85 s only as the cap;
 *   - the "no bridge answered" diagnosis, which is the one thing a bare timeout never says
 *     (Arborist dying of out-of-memory beside Unity looks exactly like a closed app);
 *   - the trees coming out of the dump on disk when Unity is closed.
 *
 * The real ArboristService writes the file (same inputs, same arguments as the web's Plant
 * for GSPro); only the Python process and the two apps are in-process fakes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArboristService, type ArboristCourse } from '../server/services/arborist.service';
import type { ExportRunner } from '../server/services/gspro-export.service';
import type { UnityEditor } from '../server/services/unity-bridge';
import {
    DEFAULT_WAIT_SEC, defaultOptions, dumpOnDisk, parseArgs, runArboristLoop,
    type LoopDeps, type LoopOptions, type PlayerBridgeLike,
} from './arborist';

const LOWER_OUT = "wrote C:/GSProV1/Core/GSP/Courses/Vreta_lidar_scene/arboristdata.dat (4.4 MB): 46 item(s), 13 mask texture(s) in package 'GolfMap lower vegetation'\n"
    + '  Bilberry x12\n';
const TREES_OUT = "wrote C:/GSProV1/Core/GSP/Courses/Vreta_lidar_scene/arboristdata.dat (12.5 MB): 144475 trees of 24 Arborist species in 1850 cells, package 'GolfMap trees'\n"
    + '  Pine_03: PF_Pine_03 x9000\n';

let root = '';
let course: ArboristCourse = { name: 'Vreta', exportDir: '', courseDir: null };
let dataDir = '';
let pipelineDir = '';
let courseDocsRoot = '';

const VIEWS = [
    { name: 'tee 1', position: [1100, 16, 953], rotation: [0, 279, 0] },
    { name: 'hole 6 water hazard', position: [823, 10.8, 1800], rotation: [1.7, 135, 0] },
    { name: 'woods right of hole 4', position: [703, 0, 1317], eye: 1.7, rotation: [2, 327, 0] },
];

beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'arborist-loop-'));
    const courseDir = path.join(root, 'Vreta_lidar_scene');
    const exportDir = path.join(root, 'export');
    dataDir = path.join(root, 'data');
    pipelineDir = path.join(root, 'pipeline');
    courseDocsRoot = path.join(root, 'docs', 'gspro');
    for (const dir of [courseDir, exportDir, path.join(dataDir, 'arborist'), pipelineDir, path.join(courseDocsRoot, 'vreta')]) {
        await mkdir(dir, { recursive: true });
    }
    // What the service checks for before it runs anything (contents only matter for the two it reads).
    await writeFile(path.join(courseDir, 'arboristdata.dat'), 'the course\'s own file');
    await writeFile(path.join(courseDir, 'Vreta.GKD'), '{}');
    await writeFile(path.join(exportDir, 'vreta-inner-zones.json'), '{}');
    await writeFile(path.join(exportDir, 'vreta-inner-surfaces.json'), '{}');
    await writeFile(path.join(exportDir, 'vreta-inner-dem-0.5m.tif.json'),
        JSON.stringify({ sideM: 2000, unity: { position: { x: -1475, z: -1475 } } }));
    await writeFile(path.join(dataDir, 'arborist-wrapper.key'), '0123456789abcdef');
    await writeFile(path.join(dataDir, 'arborist', 'GolfMap library.biome'), '{}');
    await writeFile(path.join(dataDir, 'arborist', 'catalog-sizes.json'), '{}');
    await writeFile(path.join(dataDir, 'arborist', 'vreta-planted-trees.json'), JSON.stringify({
        format: 'golfmap-planted-trees-v1',
        items: [{ catalogue: 'GolfMap imported trees', name: 'Pine_03', prefab: 'p', widthM: 3, heightM: 12, instances: [[0, 0, 0], [1, 0, 1], [2, 0, 2]] }],
    }));
    await writeFile(path.join(courseDocsRoot, 'vreta', 'arborist-species.json'), '{}');
    await writeFile(path.join(courseDocsRoot, 'vreta', 'grass-palette.json'), '{}');
    course = { name: 'Vreta', exportDir, courseDir };
});

afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

/** The Python runs, in order: the arborist.py sub-command and its arguments. */
interface PythonRun { command: string; args: string[] }

function service(runs: PythonRun[]): ArboristService {
    const runner: ExportRunner = async (args) => {
        const command = args[1] ?? '';
        runs.push({ command, args });
        return { code: 0, stdout: command === 'lower' ? LOWER_OUT : TREES_OUT, stderr: '' };
    };
    return new ArboristService({ dataDir, pipelineDir, courseDocsRoot, runner });
}

interface Fakes {
    runs: PythonRun[];
    calls: { command: string; args: Record<string, unknown> }[];
    log: string[];
    deps: LoopDeps;
    arborist: ArboristService;
    /** How often the loop asked for the bridge / the editor / a close. */
    asked: { player: number; editor: number; closed: number };
}

interface FakeSetup {
    /** null = nothing answered. */
    player?: PlayerBridgeLike | null;
    /** The stored-instance counts `veg.systems` reports, one per poll (the last repeats). */
    counts?: number[];
    /** `veg.systems` throws this instead of answering. */
    vegSystemsError?: string;
    editor?: UnityEditor | null;
    apps?: string[];
    views?: typeof VIEWS;
}

function fakes(setup: FakeSetup = {}): Fakes {
    const runs: PythonRun[] = [];
    const calls: Fakes['calls'] = [];
    const log: string[] = [];
    const asked = { player: 0, editor: 0, closed: 0 };
    let clock = 0;
    let poll = 0;
    const counts = setup.counts ?? [0, 90_000, 144_475, 144_475];

    const player: PlayerBridgeLike = {
        name: 'Arborist (pid 1, port 8790)',
        async call(command, args = {}) {
            calls.push({ command, args });
            if (command === 'veg.systems') {
                if (setup.vegSystemsError) throw new Error(setup.vegSystemsError);
                const stored = counts[Math.min(poll++, counts.length - 1)]!;
                return { systems: [{ storedInstances: stored, packages: [{ name: 'GolfMap trees' }, { name: 'GolfMap lower vegetation' }] }] };
            }
            if (command === 'screenshot') return { file: `C:/Temp/shot-${calls.length}.png` };
            if (command === 'fps') return { fps: 86.4, onePercentLowFps: 61.2, resolution: '1920x1440', quality: 'Medium' };
            if (command === 'veg.at') return { instances: [{ item: 'Oak__big', distance: 34.2 }] };
            return {};
        },
    };

    const deps: LoopDeps = {
        player: async () => {
            asked.player++;
            return setup.player === undefined ? player : setup.player;
        },
        unityEditor: async () => {
            asked.editor++;
            return setup.editor ?? null;
        },
        runningApps: async () => setup.apps ?? [],
        closeOthers: async () => {
            asked.closed++;
            return 'Unity and GreenKeeper are closed.';
        },
        views: () => setup.views ?? VIEWS,
        memoryGb: () => ({ free: 6.2, total: 47.9 }),
        log: (line) => log.push(line),
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
    };
    return { runs, calls, log, deps, asked, arborist: service(runs) };
}

const opts = (over: Partial<LoopOptions> = {}): LoopOptions => ({ ...defaultOptions(), ...over });
const ids = (result: { steps: { id: string }[] }) => result.steps.map((s) => s.id);
const lines = (result: { steps: { id: string; lines: string[] }[] }, id: string) =>
    result.steps.find((s) => s.id === id)?.lines.join('\n') ?? '';

describe('the Arborist loop, step by step', () => {
    test('the whole file, then the reload: lower, trees, bridge, reload', async () => {
        const f = fakes();
        const result = await runArboristLoop(f.arborist, course, opts(), f.deps);

        expect(result.failed).toBeNull();
        expect(ids(result)).toEqual(['lower', 'trees', 'bridge', 'reload']);
        expect(f.runs.map((r) => r.command)).toEqual(['lower', 'trees']);
        // The same file as Update vegetation: arborist.py out of the pipeline folder, into the course folder.
        expect(f.runs[0]!.args[0]).toBe(path.join(pipelineDir, 'arborist.py'));
        expect(f.runs[0]!.args).toContain(course.courseDir!);
        expect(f.runs[0]!.args).toContain(path.join(courseDocsRoot, 'vreta', 'grass-palette.json'));
        expect(f.runs[1]!.args).toContain(path.join(dataDir, 'arborist', 'vreta-planted-trees.json'));
        expect(f.runs[1]!.args).toContain(path.join(course.exportDir, 'vreta-inner-surfaces.json'));
        // ResetVSPro empties Arborist's system, LoadData reads our file, then the wait.
        expect(f.calls.map((c) => c.command)).toEqual(['call', 'call', 'veg.systems', 'veg.systems', 'veg.systems', 'veg.systems']);
        expect(f.calls[0]!.args).toEqual({ type: 'AAT.ExportVSPro', method: 'ResetVSPro', args: ['Vreta_lidar_scene'] });
        expect(f.calls[1]!.args).toEqual({ type: 'AAT.ExportVSPro', instance: 0, method: 'LoadData' });
        expect(lines(result, 'lower')).toContain('46 items, 13 mask textures');
        expect(lines(result, 'trees')).toContain('144475 trees of 24 species');
        // One status line per step, with its elapsed seconds.
        expect(f.log.filter((l) => l.startsWith('ok     '))).toHaveLength(4);
    });

    test('--no-reload writes the file and never touches Arborist', async () => {
        const f = fakes();
        const result = await runArboristLoop(f.arborist, course, opts({ reload: false }), f.deps);

        expect(ids(result)).toEqual(['lower', 'trees']);
        expect(f.asked.player).toBe(0);
        expect(f.calls).toEqual([]);
    });

    test('--lower leaves the trees out: no Unity, one Python run', async () => {
        const f = fakes();
        const result = await runArboristLoop(f.arborist, course, opts({ trees: false }), f.deps);

        expect(ids(result)).toEqual(['lower', 'bridge', 'reload']);
        expect(f.runs.map((r) => r.command)).toEqual(['lower']);
        expect(f.asked.editor).toBe(0);
    });

    test('--trees leaves the lower vegetation out', async () => {
        const f = fakes();
        const result = await runArboristLoop(f.arborist, course, opts({ lower: false }), f.deps);

        expect(ids(result)).toEqual(['trees', 'bridge', 'reload']);
        expect(f.runs.map((r) => r.command)).toEqual(['trees']);
    });

    test('--close-others closes Unity first and then keeps the dump on disk', async () => {
        const f = fakes({ editor: null });
        const result = await runArboristLoop(f.arborist, course, opts({ closeOthers: true }), f.deps);

        expect(ids(result)).toEqual(['close-others', 'lower', 'trees', 'bridge', 'reload']);
        expect(f.asked.closed).toBe(1);
        expect(f.asked.editor).toBe(0);  // Unity was just closed; asking would only find it gone
    });

    test('a failing step stops the rest and is the one named', async () => {
        const f = fakes();
        const broken = new ArboristService({
            dataDir, pipelineDir, courseDocsRoot,
            runner: async () => ({ code: 1, stdout: '', stderr: 'no mask PNG beside the zones export\n' }),
        });
        const result = await runArboristLoop(broken, course, opts(), f.deps);

        expect(ids(result)).toEqual(['lower']);
        expect(result.failed?.id).toBe('lower');
        expect(result.failed?.lines[0]).toContain('no mask PNG beside the zones export');
        expect(f.calls).toEqual([]);
    });
});

describe('the trees when Unity is closed', () => {
    test('the dump on disk is kept, with its tree count and age', async () => {
        const f = fakes({ editor: null });
        const result = await runArboristLoop(f.arborist, course, opts({ lower: false, reload: false }), f.deps);

        expect(result.failed).toBeNull();
        expect(lines(result, 'trees')).toContain('the trees are the dump on disk — 3 trees');
        expect(lines(result, 'trees')).toContain("the positions are the last plant's");
    });

    test('the open editor writes a fresh one instead', async () => {
        const dumped: string[] = [];
        const editor: UnityEditor = {
            projectPath: 'D:/gspro_courses/vreta_v4',
            projectName: 'vreta_v4',
            run: async (command, args = {}) => {
                dumped.push(command);
                return { file: args.file, catalogues: [{ catalogue: 'GolfMap imported trees', trees: 144_475 }] };
            },
        };
        const f = fakes({ editor });
        const result = await runArboristLoop(f.arborist, course, opts({ lower: false, reload: false }), f.deps);

        expect(result.failed).toBeNull();
        expect(dumped).toEqual(['golfmap.trees.dump']);
        expect(lines(result, 'trees')).toContain('from 144475 planted in Unity (vreta_v4)');
        expect(lines(result, 'trees')).not.toContain('the dump on disk');
    });

    test('no dump at all: the stand-in says how to make one', async () => {
        const stand = dumpOnDisk();
        const missing = path.join(dataDir, 'arborist', 'never-planted-trees.json');
        await expect(stand.run('golfmap.trees.dump', { file: missing })).rejects.toThrow(/planted-trees dump .* is not there yet/);
        await expect(stand.run('golfmap.zones.import', {})).rejects.toThrow(/Unity is not open/);
    });
});

describe('the load-done signal', () => {
    test('the stored-instance count twice the same ends the wait early', async () => {
        const f = fakes({ counts: [0, 90_000, 144_475, 144_475] });
        const result = await runArboristLoop(f.arborist, course, opts({ lower: false, trees: false }), f.deps);

        const reload = lines(result, 'reload');
        expect(reload).toContain('144475 stored instances in 2 package(s)');
        expect(reload).toContain('unchanged over two polls of veg.systems');
        expect(reload).toMatch(/load done after 1[0-9](\.\d)? s/);   // four 3 s polls, not the 85 s wait
        expect(f.calls.filter((c) => c.command === 'veg.systems')).toHaveLength(4);
    });

    test('a count that never settles falls back on the documented cap', async () => {
        const f = fakes({ counts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] });
        const result = await runArboristLoop(f.arborist, course, opts({ lower: false, trees: false }), f.deps);

        expect(lines(result, 'reload')).toContain(`no steady vegetation count within the ${DEFAULT_WAIT_SEC} s cap`);
        expect(result.failed).toBeNull();   // the picture may still be filling in; not a failure
    });

    test('a build without veg.systems waits the documented 85 s', async () => {
        const f = fakes({ vegSystemsError: "Unknown command 'veg.systems'." });
        const result = await runArboristLoop(f.arborist, course, opts({ lower: false, trees: false }), f.deps);

        expect(lines(result, 'reload')).toContain(`waited the documented ${DEFAULT_WAIT_SEC} s instead`);
        expect(result.steps.find((s) => s.id === 'reload')!.seconds).toBeGreaterThanOrEqual(DEFAULT_WAIT_SEC);
    });
});

describe('no bridge answered', () => {
    test('Arborist up but silent: the mod, not the app', async () => {
        const f = fakes({ player: null, apps: ['Arborist'] });
        const result = await runArboristLoop(f.arborist, course, opts(), f.deps);

        expect(ids(result)).toEqual(['lower', 'trees', 'bridge']);
        expect(result.failed?.id).toBe('bridge');
        const why = result.failed!.lines[0]!;
        expect(why).toContain('no bridge answered');
        expect(why).toContain('Arborist is running');
        expect(why).toContain('BepInEx');
        expect(why).toContain('free RAM 6.2 of 47.9 GB');
        // The file was still written, so a --no-reload run is not needed to get it.
        expect(f.runs.map((r) => r.command)).toEqual(['lower', 'trees']);
    });

    test('Arborist gone while Unity holds the memory: the out-of-memory case', async () => {
        const f = fakes({ player: null, apps: ['Unity', 'GreenKeeper'] });
        const result = await runArboristLoop(f.arborist, course, opts({ lower: false, trees: false }), f.deps);

        const why = result.failed!.lines[0]!;
        expect(why).toContain('Arborist is not running');
        expect(why).toContain('out-of-memory');
        expect(why).toContain('--close-others');
        expect(why).toContain('Unity, GreenKeeper');
    });

    test('a bridge that answers is checked once, before the reload', async () => {
        const f = fakes();
        await runArboristLoop(f.arborist, course, opts({ lower: false, trees: false }), f.deps);
        expect(f.asked.player).toBe(1);
    });
});

describe('the screenshots', () => {
    test('a named viewpoint: pose, settle, picture, frame rate, what stands in the middle', async () => {
        const f = fakes();
        const result = await runArboristLoop(f.arborist, course,
            opts({ lower: false, trees: false, reload: false, screenshot: ['hole 6'], settleSec: 4 }), f.deps);

        expect(ids(result)).toEqual(['bridge', 'screenshots']);
        expect(f.calls.map((c) => c.command)).toEqual(['camera', 'screenshot', 'fps', 'veg.at']);
        expect(f.calls[0]!.args).toEqual({ position: [823, 10.8, 1800], rotation: [1.7, 135, 0] });
        const shot = lines(result, 'screenshots');
        expect(shot).toContain('hole 6 water hazard: C:/Temp/shot-');
        expect(shot).toContain('86.4 fps, 1 % low 61.2');
        expect(shot).toContain('Oak__big at 34 m');
    });

    test('no name takes every viewpoint, and `eye` goes over the ground', async () => {
        const f = fakes();
        const result = await runArboristLoop(f.arborist, course,
            opts({ lower: false, trees: false, reload: false, screenshot: [] }), f.deps);

        expect(lines(result, 'screenshots').split('\n')).toHaveLength(VIEWS.length);
        expect(f.calls.filter((c) => c.command === 'screenshot')).toHaveLength(VIEWS.length);
        expect(f.calls.find((c) => c.command === 'camera' && 'eye' in c.args)!.args.eye).toBe(1.7);
    });

    test('a name that matches nothing lists the ones there are', async () => {
        const f = fakes();
        const result = await runArboristLoop(f.arborist, course,
            opts({ lower: false, trees: false, reload: false, screenshot: ['hole 17'] }), f.deps);

        expect(result.failed?.id).toBe('screenshots');
        expect(result.failed?.lines[0]).toContain('tee 1');
        expect(f.calls.filter((c) => c.command === 'screenshot')).toEqual([]);
    });
});

describe('the command line', () => {
    const parsed = (line: string) => {
        const r = parseArgs(line.split(' ').filter(Boolean));
        if ('error' in r) throw new Error(r.error);
        return r;
    };

    test('a course alone is the whole file and a reload', () => {
        const { course: name, opts: o } = parsed('vreta');
        expect(name).toBe('vreta');
        expect([o.lower, o.trees, o.reload]).toEqual([true, true, true]);
        expect(o.screenshot).toBeNull();
        expect(o.waitSec).toBe(DEFAULT_WAIT_SEC);
    });

    test('--lower, --trees and --all pick the halves', () => {
        expect(parsed('vreta --lower').opts).toMatchObject({ lower: true, trees: false });
        expect(parsed('vreta --trees').opts).toMatchObject({ lower: false, trees: true });
        expect(parsed('vreta --lower --trees').opts).toMatchObject({ lower: true, trees: true });
        expect(parsed('vreta --all').opts).toMatchObject({ lower: true, trees: true });
    });

    test('--screenshot takes the names after it, and none means every one', () => {
        expect(parsed('vreta --screenshot').opts.screenshot).toEqual([]);
        expect(parseArgs(['vreta', '--screenshot', 'tee 1', 'hole 6', '--no-reload'])).toMatchObject({
            opts: { screenshot: ['tee 1', 'hole 6'], reload: false },
        });
    });

    test('--screenshot never swallows the course, wherever the course stands', () => {
        // The first positional is the course, so this is "every view of vreta".
        expect(parseArgs(['--screenshot', 'vreta'])).toMatchObject({ course: 'vreta', opts: { screenshot: [] } });
        expect(parseArgs(['--close-others', '--screenshot', 'vreta'])).toMatchObject({ course: 'vreta', opts: { screenshot: [], closeOthers: true } });
        // A flag's own value is not the course either.
        expect(parseArgs(['--wait', '90', '--screenshot', 'vreta'])).toMatchObject({
            course: 'vreta', opts: { screenshot: [], waitSec: 90 },
        });
        // With the course first, the names after --screenshot are still its views.
        expect(parsed('vreta --screenshot --no-reload').opts).toMatchObject({ screenshot: [], reload: false });
    });

    test('--wait, --settle, --size and --frames', () => {
        expect(parsed('vreta --wait 120 --settle 25 --size 1920x1440 --frames 40').opts)
            .toMatchObject({ waitSec: 120, settleSec: 25, width: 1920, height: 1440, frames: 40 });
    });

    test('what it refuses', () => {
        expect(parseArgs([])).toEqual({ error: 'name a course' });
        expect(parseArgs(['vreta', 'kloster'])).toMatchObject({ error: expect.stringContaining('name one course') });
        expect(parseArgs(['vreta', '--lowr'])).toEqual({ error: 'unknown option --lowr' });
        expect(parseArgs(['vreta', '--wait'])).toEqual({ error: '--wait needs a number' });
        expect(parseArgs(['vreta', '--size', '1920'])).toMatchObject({ error: expect.stringContaining('--size needs') });
    });
});
