/**
 * `bun run opcd:build` drives OPCD's cloud course builder — a stateful ZK web
 * UI behind a Discord login, which no test may touch (it is one shared account
 * and every run costs the server minutes of building). So what is pinned here
 * is everything that is NOT the browser:
 *
 *   - the output name: OPCD's own build number when the download carries one,
 *     else the highest `<prefix>_svg_<n>.blend` in the export folder plus one
 *     (and `.conformed.blend`, which `shape_prepare.py` writes next to it, is
 *     never a build);
 *   - the CLI: a build run, `--dry-run`, `--setup`, the value flags, the refusals;
 *   - the job table: one row of "SVG Jobs for this Course" out of its cells,
 *     "Processing Complete" with a Download vs a row left at "Draft", and the
 *     header row that is not a job — against fixtures written from the real
 *     table (Name | Status | Created | Actions);
 *   - which row is the job we just submitted, and the wait around it: 2 min
 *     before the first look, 45 s between them, the cap and what it says —
 *     on a fake look with a fake clock;
 *   - the recording writer, against a fake page: the log, the snapshots and
 *     `index.json`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    BUILD_FIRST_LOOK_MS, BUILD_POLL_MS, Recording, blendPrefix, buildOutcome, downloadFileName, electronCandidates, isDone, isDraft,
    jobDescription, jobFromCells, jobTableText, linkJobsToSnapshots, nextBlendName, nodeRuntime, opcdCreatedToUtc,
    parseArgs, pickNewJob, snapshotOfSvg, snapshotStampOf, splitJobName,
    usageText, waitForBuild, type BuildDeps, type SnapshotPage, type SvgJob,
} from './opcd-build';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'opcd-build-'));

describe('the .blend the build downloads', () => {
    const vreta = [
        'vreta.svg', 'vreta_svg_1984.blend', 'vreta_svg_1985.blend', 'vreta_svg_1985.conformed.blend',
        'vreta_svg_1987.blend', 'vreta_svg_1988.blend', 'vreta_svg_1988.conformed.blend',
    ];

    test('the highest number in the folder plus one when the download has no name of its own', () => {
        expect(nextBlendName(vreta, 'vreta')).toBe('vreta_svg_1989.blend');
        expect(nextBlendName(vreta, 'vreta', null)).toBe('vreta_svg_1989.blend');
        expect(nextBlendName(vreta, 'vreta', 'download.bin')).toBe('vreta_svg_1989.blend');
    });

    test('a .conformed.blend is not a build, and neither is another course', () => {
        expect(nextBlendName(['vreta_svg_1985.conformed.blend'], 'vreta')).toBe('vreta_svg_1.blend');
        expect(nextBlendName(['other_svg_9000.blend'], 'vreta')).toBe('vreta_svg_1.blend');
        expect(nextBlendName([], 'vreta')).toBe('vreta_svg_1.blend');
    });

    test("OPCD's own build number is kept when the download carries one", () => {
        expect(nextBlendName(vreta, 'vreta', 'vreta_svg_1991.blend')).toBe('vreta_svg_1991.blend');
        // The numbers run ahead of the folder (1986 is missing here): they are OPCD's, not ours.
        expect(nextBlendName(vreta, 'vreta', 'vreta_svg_1986.blend')).toBe('vreta_svg_1986.blend');
    });

    test('a file already in the folder is never overwritten', () => {
        expect(nextBlendName(vreta, 'vreta', 'vreta_svg_1988.blend')).toBe('vreta_svg_1989.blend');
        expect(nextBlendName(vreta, 'vreta', 'VRETA_SVG_1988.BLEND')).toBe('vreta_svg_1989.blend');
    });

    test('the prefix is the course slug, the SVG stem OPCD names its build after', async () => {
        expect(blendPrefix('Vreta')).toBe('vreta');
        expect(blendPrefix('Ombergs Golfklubb')).toBe('ombergs-golfklubb');
        expect(nextBlendName([], blendPrefix('Ombergs Golfklubb'), 'ombergs-golfklubb_svg_90.blend')).toBe('ombergs-golfklubb_svg_90.blend');
        // The script writes the rule out rather than importing `courseSlug` (that module is
        // Bun-only, and the browser half must not need it), so pin that they stay the same rule.
        const { courseSlug } = await import('../server/services/gspro-export.service');
        for (const name of ['Vreta', 'Vreta Kloster GK', 'Längbro Ängar', '  ', 'A/B 2']) {
            expect(blendPrefix(name)).toBe(courseSlug(name));
        }
    });
});

describe('the command line', () => {
    test('a build run: the course, headless, the 8 min cap', () => {
        expect(parseArgs(['vreta'])).toEqual({
            mode: 'build', course: 'vreta', svg: null, out: null, headless: true,
            opcdName: null, dryRun: false, attach: false, submitOnly: false, status: false, timeoutMs: 8 * 60_000, url: null,
        });
        expect(parseArgs(['vreta', '--submit-only'])).toMatchObject({ submitOnly: true, dryRun: false });
        expect(parseArgs(['vreta', '--status'])).toMatchObject({ status: true, submitOnly: false });
        expect(parseArgs(['vreta', '--headed'])).toMatchObject({ headless: false });
        expect(parseArgs(['vreta', '--headed', '--headless'])).toMatchObject({ headless: true });
        expect(parseArgs(['vreta', '--timeout', '20'])).toMatchObject({ timeoutMs: 20 * 60_000 });
        expect(parseArgs(['vreta', '--dry-run'])).toMatchObject({ dryRun: true });
    });

    test('--svg and --out are resolved to absolute paths', () => {
        expect(parseArgs(['vreta', '--svg', 'a/b.svg', '--out', 'c'])).toMatchObject({
            mode: 'build', svg: path.resolve('a/b.svg'), out: path.resolve('c'),
        });
    });

    test('--opcd-name and the hidden --url are kept as given', () => {
        expect(parseArgs(['vreta', '--opcd-name', 'Vreta Kloster golfklubb'])).toMatchObject({
            opcdName: 'Vreta Kloster golfklubb',
        });
        expect(parseArgs(['--setup', '--url', 'about:blank'])).toEqual({ mode: 'setup', course: null, url: 'about:blank' });
    });

    test('setup mode takes an optional course and nothing about the build', () => {
        expect(parseArgs(['--setup'])).toEqual({ mode: 'setup', course: null, url: null });
        expect(parseArgs(['--setup', 'vreta'])).toEqual({ mode: 'setup', course: 'vreta', url: null });
        expect(parseArgs(['--setup', 'vreta', '--svg', 'x.svg'])).toMatchObject({
            error: expect.stringContaining('--setup records a run done by hand'),
        });
        expect(parseArgs(['--setup', '--dry-run'])).toMatchObject({ error: expect.stringContaining('--dry-run') });
    });

    test('the refusals name what is wrong', () => {
        expect(parseArgs([])).toEqual({ error: 'name a course (or --setup to record a hand-run)' });
        expect(parseArgs(['vreta', 'bergs'])).toEqual({ error: "name one course, not 'vreta' and 'bergs'" });
        expect(parseArgs(['vreta', '--svg'])).toEqual({ error: '--svg needs a value' });
        expect(parseArgs(['vreta', '--timeout', 'soon'])).toEqual({ error: '--timeout needs minutes, e.g. --timeout 20' });
        expect(parseArgs(['vreta', '--fast'])).toEqual({ error: 'unknown option --fast' });
        expect(parseArgs(['vreta', '--status', '--submit-only'])).toEqual({ error: 'pick one of --dry-run, --status, --submit-only and --attach' });
        expect(parseArgs(['--setup', '--status'])).toMatchObject({ error: expect.stringContaining('--status') });
        // A flag's value is never read as the course.
        expect(parseArgs(['--svg', 'x.svg'])).toMatchObject({ error: expect.stringContaining('name a course') });
    });

    test('the usage names both modes', () => {
        expect(usageText()).toContain('--setup');
        expect(usageText()).toContain('--dry-run');
        expect(usageText()).toContain('--opcd-name');
        expect(usageText()).toContain('--status');
        expect(usageText()).toContain('--submit-only');
    });
});

describe('the SVG Jobs table', () => {
    // "SVG Jobs for this Course": Name | Status | Created | Actions. ZK draws
    // the table as divs, so a row reads either as cells or as text lines —
    // both land here as a string[].
    const header = ['Name', 'Status', 'Created', 'Actions'];
    const complete = ['vreta_svg_1990', 'Processing Complete', '2026-10-11 11:03'];
    const draft = ['vreta_svg_1989', 'Draft', '2026-10-10 20:41'];

    test('a finished job: name, status, created, and its two buttons', () => {
        const job = jobFromCells(0, complete, ['Download', 'Re-submit'])!;
        expect(job).toEqual({
            index: 0, name: 'vreta_svg_1990', status: 'Processing Complete',
            created: '2026-10-11 11:03', actions: ['Download', 'Re-submit'], file: null,
        });
        expect(isDone(job)).toBe(true);
        expect(isDraft(job)).toBe(false);
    });

    test('a job left at Draft has only Re-submit, and is not done', () => {
        const job = jobFromCells(1, draft, ['Re-submit'])!;
        expect(job.status).toBe('Draft');
        expect(isDone(job)).toBe(false);
        expect(isDraft(job)).toBe(true);
    });

    test('the header row and the surrounding boxes are not jobs', () => {
        expect(jobFromCells(0, header, [])).toBeNull();
        expect(jobFromCells(0, ['Submit New SVG Job', 'Choose SVG File...', 'No file selected'], ['Submit SVG Job'])).toBeNull();
        expect(jobFromCells(0, [], [])).toBeNull();
        // A timestamp with nothing before it is not a row either (no Name).
        expect(jobFromCells(0, ['2026-10-11 11:03'], ['Download'])).toBeNull();
    });

    test('blank cells and line noise from the div layout are dropped', () => {
        const job = jobFromCells(0, ['', ' vreta_svg_1990 ', '', 'Processing\n Complete', '2026-10-11 11:03', ''], [' Download ', ''])!;
        expect(job.name).toBe('vreta_svg_1990');
        expect(job.status).toBe('Processing Complete');
        expect(job.actions).toEqual(['Download']);
    });

    test('seconds in the Created column are allowed, as are the ISO T forms', () => {
        expect(jobFromCells(0, ['a', 'Draft', '2026-10-11 11:03:22'], [])!.created).toBe('2026-10-11 11:03:22');
        expect(jobFromCells(0, ['a', 'Draft', '2026-10-11T11:03'], [])!.created).toBe('2026-10-11T11:03');
    });

    test('the dry run prints the table, or says it is empty', () => {
        const jobs = [jobFromCells(0, complete, ['Download', 'Re-submit'])!, jobFromCells(1, draft, ['Re-submit'])!];
        expect(jobTableText(jobs)).toEqual([
            '  2026-10-11 11:03  Processing Complete   vreta_svg_1990  [Download, Re-submit]',
            '  2026-10-10 20:41  Draft                 vreta_svg_1989  [Re-submit]',
        ]);
        expect(jobTableText([])).toEqual(['  (no SVG jobs in the table)']);
    });

    test('the description written into the submit box traces a job back to a run', () => {
        expect(jobDescription('Vreta', new Date('2026-10-14T19:05:00Z'))).toBe('golf-map Vreta 2026-10-14 19:05');
        // An export snapshot's SVG names its snapshot instead, which --status reads back.
        const desc = jobDescription('Ombergs Golfklubb', new Date(), '2026-10-17_15-37-30');
        expect(desc).toBe('golf-map Ombergs Golfklubb export 2026-10-17_15-37-30');
        const job = jobFromCells(0, [`ombergs-golfklubb.svg - ${desc}`, 'Draft', '2026-10-17 09:38'], [])!;
        expect(snapshotStampOf(job)).toBe('2026-10-17_15-37-30');
        expect(splitJobName(job.name)).toEqual({ svg: 'ombergs-golfklubb.svg', description: desc });
        expect(splitJobName('ombergs-golfklubb.svg')).toEqual({ svg: 'ombergs-golfklubb.svg', description: null });
    });
});

describe('waiting the build out', () => {
    const job = (index: number, name: string, status: string, created: string, actions: string[] = []): SvgJob =>
        ({ index, name, status, created, actions });
    const older = job(0, 'vreta_svg_1988', 'Processing Complete', '2026-10-09 08:12', ['Download', 'Re-submit']);

    test('ours is the row that was not in the table before the submit', () => {
        const before = [older];
        const now = [job(0, 'vreta_svg_1990', 'Draft', '2026-10-11 11:03'), { ...older, index: 1 }];
        expect(pickNewJob(before, now)!.name).toBe('vreta_svg_1990');
        // An older job's Download is never ours.
        expect(pickNewJob(before, before)).toBeNull();
    });

    test('a table that only grew, with rows that read the same, gives the newest (top) row', () => {
        const same = job(0, 'vreta', 'Draft', '2026-10-11 11:03');
        expect(pickNewJob([same], [same, { ...same, index: 1 }])!.index).toBe(0);
    });

    test('an empty table before and after means our job has not appeared yet', () => {
        expect(pickNewJob([], [])).toBeNull();
    });

    test('parallel submits: ours is told apart by file and description, never as "the newest new row"', () => {
        // Three bisect variants submitted a minute apart; ours is the middle one, and the newest is another's.
        const a = job(0, 'omberg-bisect-k4.svg - golf-map Ombergs Golfklubb 2026-10-17 15:05', 'Waiting to be processed', '2026-10-17 11:05');
        const b = job(1, 'omberg-bisect-k3.svg - golf-map Ombergs Golfklubb 2026-10-17 15:02', 'Processing', '2026-10-17 11:02');
        const c = job(2, 'omberg-bisect-k1.svg - golf-map Ombergs Golfklubb 2026-10-17 15:01', 'Processing', '2026-10-17 11:01');
        const ours = { svg: 'omberg-bisect-k3.svg', description: 'golf-map Ombergs Golfklubb 2026-10-17 15:02' };
        expect(pickNewJob([older], [a, b, c, older], ours)).toBe(b);
        // Not in the table yet: nothing, rather than somebody else's job.
        expect(pickNewJob([older], [a, c, older], ours)).toBeNull();
        // The same file submitted again by another run: a different description, not ours.
        expect(pickNewJob([], [job(0, 'omberg-bisect-k3.svg - golf-map Ombergs Golfklubb 2026-10-17 15:09', 'Draft', '2026-10-17 11:09')], ours)).toBeNull();
        // No Description box found: the Name is the file alone.
        expect(pickNewJob([], [job(0, 'x.svg', 'Draft', '2026-10-17 11:09')], { svg: 'x.svg', description: null })!.name).toBe('x.svg');
    });

    test('waitForBuild follows our parallel job, not the one submitted after it', async () => {
        const mine = (status: string, actions: string[] = []) => job(1, 'v1.svg - d1', status, '2026-10-17 11:00', actions);
        const other = job(0, 'v2.svg - d2', 'Processing Complete', '2026-10-17 11:01', ['Download']);
        const states = [[other, mine('Processing')], [other, mine('Processing Complete', ['Download'])]];
        let looks = 0;
        const found = await waitForBuild(async () => states[Math.min(looks++, 1)]!, [], fakeDeps(), { ours: { svg: 'v1.svg', description: 'd1' } });
        expect(found.name).toBe('v1.svg - d1');
        expect(looks).toBe(2);
    });

    /** A job table that turns into the next state on each look. */
    function fakeLook(states: SvgJob[][]) {
        const state = { looks: 0 };
        return {
            state,
            look: async () => states[Math.min(state.looks++, states.length - 1)]!,
        };
    }

    function fakeDeps(): BuildDeps & { lines: string[]; slept: number[] } {
        const lines: string[] = [];
        const slept: number[] = [];
        let clock = 0;
        return {
            lines, slept,
            log: (line) => lines.push(line),
            now: () => clock,
            sleep: async (ms) => { slept.push(ms); clock += ms; },
        };
    }

    test('2 min before the first look, then every 45 s until our row offers a Download', async () => {
        const { look, state } = fakeLook([
            [job(0, 'vreta_svg_1990', 'Draft', '2026-10-11 11:03'), { ...older, index: 1 }],
            [job(0, 'vreta_svg_1990', 'Processing', '2026-10-11 11:03'), { ...older, index: 1 }],
            [job(0, 'vreta_svg_1990', 'Processing Complete', '2026-10-11 11:03', ['Download', 'Re-submit']), { ...older, index: 1 }],
        ]);
        const deps = fakeDeps();
        const mine = await waitForBuild(look, [older], deps);
        expect(mine.name).toBe('vreta_svg_1990');
        expect(state.looks).toBe(3);
        expect(deps.slept).toEqual([BUILD_FIRST_LOOK_MS, BUILD_POLL_MS, BUILD_POLL_MS]);
        expect(deps.lines.join('\n')).toContain('build finished after 3 min 30 s');
        // The state is printed when it changes, not once per look.
        expect(deps.lines.filter((l) => l.includes('Processing') && !l.includes('Complete'))).toHaveLength(1);
    });

    test('the row keeps being followed once found, even when it stops looking new', async () => {
        const mineNow = job(0, 'vreta_svg_1990', 'Processing', '2026-10-11 11:03');
        const { look } = fakeLook([
            [mineNow, { ...older, index: 1 }],
            // The same two rows: nothing is "new" any more, but ours is still there.
            [{ ...mineNow, status: 'Processing Complete', actions: ['Download'] }, { ...older, index: 1 }],
        ]);
        const found = await waitForBuild(look, [older], fakeDeps());
        expect(found.name).toBe('vreta_svg_1990');
    });

    test('a build with no Download at the cap fails with the job, its Created time and the Discord DM', async () => {
        const { look } = fakeLook([[job(0, 'vreta_svg_1990', 'Draft', '2026-10-11 11:03', ['Re-submit'])]]);
        const deps = fakeDeps();
        await expect(waitForBuild(look, [], deps, { timeoutMs: 4 * 60_000 })).rejects.toThrow(
            /no Download after 4 min.*vreta_svg_1990 — Draft, created 2026-10-11 11:03.*never completed.*Discord/s,
        );
    });

    test('our job never appearing is said in as many words', async () => {
        const { look } = fakeLook([[older]]);
        await expect(waitForBuild(look, [older], fakeDeps(), { timeoutMs: 3 * 60_000 }))
            .rejects.toThrow(/not in the table/);
    });
});

describe('the runtime that drives the browser', () => {
    // Playwright cannot drive Chromium under Bun on this machine (its CDP pipe
    // and its CDP WebSocket both go silent), so Bun resolves the course and
    // hands the run to a Node. There is no node on PATH here — but every
    // Electron app is one with ELECTRON_RUN_AS_NODE=1, and VS Code's is Node 24.
    test('node on PATH is used as itself', () => {
        const runtime = nodeRuntime('C:\\Program Files\\nodejs\\node.exe', { path: 'C:\\Code.exe', name: 'VS Code' })!;
        expect(runtime.command[0]).toBe('C:\\Program Files\\nodejs\\node.exe');
        expect(runtime.env).toEqual({});
        expect(runtime.name).toContain('node');
    });

    test('without one, an Electron app stands in for it', () => {
        const runtime = nodeRuntime(null, { path: 'C:\\Code.exe', name: 'VS Code' })!;
        expect(runtime.command[0]).toBe('C:\\Code.exe');
        expect(runtime.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
        expect(runtime.name).toContain('VS Code');
    });

    test('either way the package.json warning is turned off, and nothing else is passed', () => {
        for (const runtime of [nodeRuntime('node.exe', null)!, nodeRuntime(null, { path: 'C:\\Code.exe', name: 'VS Code' })!]) {
            expect(runtime.command.slice(1)).toEqual(['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']);
        }
    });

    test('neither means there is nothing to run the browser half in', () => {
        expect(nodeRuntime(null, null)).toBeNull();
    });

    test('the Electron candidates come from the environment, not a hardcoded user', () => {
        const paths = electronCandidates({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' })
            .map((c) => c.path);
        expect(paths).toContain('C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe');
        expect(paths).toContain('C:\\Program Files\\Unity Hub\\Unity Hub.exe');
        // An empty environment offers nothing rather than bare relative paths.
        expect(electronCandidates({})).toEqual([]);
    });
});

describe('the recording (--setup)', () => {
    /** Enough of a Page for the snapshot writer: the HTML, a URL and a file to write. */
    function fakePage(url: string, html: string): SnapshotPage & { shots: string[] } {
        const shots: string[] = [];
        return {
            shots,
            url: () => url,
            content: async () => html,
            screenshot: async ({ path: to }) => { shots.push(to); await Bun.write(to, 'png'); },
        };
    }

    test('log, snapshots and index.json land in one timestamped folder', async () => {
        const root = await tmp();
        try {
            const at = new Date('2026-10-14T19:05:33.123Z');
            const rec = await Recording.open(root, 'https://app.opcdgolf.com/webui/index.zul', 'Vreta', at);
            expect(path.basename(rec.dir)).toBe('2026-10-14T19-05-33');

            await rec.log('url', 'https://app.opcdgolf.com/webui/index.zul');
            await rec.log('post', 'https://app.opcdgolf.com/webui/zkau  body 412 bytes: cmd_0=onClick');
            const page = fakePage('https://app.opcdgolf.com/webui/index.zul', '<html><body>SVG Jobs for this Course</body></html>');
            const first = await rec.snapshot(page, 'the SVG Jobs tab');
            const second = await rec.snapshot(page, 'after the submit');
            expect(first.files).toEqual(['snapshot-01.html', 'snapshot-01.png']);
            expect(second.files).toEqual(['snapshot-02.html', 'snapshot-02.png']);
            rec.addFile('trace.zip');
            const index = await rec.finish('q typed');

            expect(index.course).toBe('Vreta');
            expect(index.startedAt).toBe(at.toISOString());
            expect(index.finishedAt).not.toBeNull();
            expect(index.steps.map((s) => s.kind)).toEqual(['start', 'url', 'post', 'snapshot', 'snapshot', 'finish']);
            expect(index.steps.at(-1)!.text).toBe('q typed');
            // Every file the session wrote is listed, once, sorted.
            expect(index.files).toEqual([
                'index.json', 'log.txt', 'snapshot-01.html', 'snapshot-01.png',
                'snapshot-02.html', 'snapshot-02.png', 'trace.zip',
            ]);
            expect((await readdir(rec.dir)).sort()).toEqual([
                'index.json', 'log.txt', 'snapshot-01.html', 'snapshot-01.png', 'snapshot-02.html', 'snapshot-02.png',
            ]);
            expect(await readFile(path.join(rec.dir, 'snapshot-01.html'), 'utf8')).toContain('SVG Jobs for this Course');

            const log = await readFile(path.join(rec.dir, 'log.txt'), 'utf8');
            expect(log.trim().split('\n')).toHaveLength(6);
            expect(log).toContain('cmd_0=onClick');
            // Each line carries a wall clock, because the Discord approval and the build are minutes apart.
            for (const line of log.trim().split('\n')) expect(line).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);

            expect(JSON.parse(await readFile(path.join(rec.dir, 'index.json'), 'utf8'))).toEqual(index);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

test("bun's own node shim on PATH is not a Node", async () => {
    const { isBunNodeShim } = await import('./opcd-build');
    expect(isBunNodeShim(String.raw`C:\Users\x\AppData\Local\Temp\bun-node-0d9b296af\node.exe`)).toBe(true);
    expect(isBunNodeShim('/tmp/bun-node-abc/node')).toBe(true);
    expect(isBunNodeShim(String.raw`C:\Program Files\nodejs\node.exe`)).toBe(false);
});

describe('which export a job built, and how it went (--status)', () => {
    // The Omberg table as it read on 2026-10-17 (OPCD's clock = US Eastern = local - 6 h).
    const row = (name: string, status: string, created: string, actions: string[] = []): SvgJob =>
        ({ index: 0, name, status, created, actions });
    const ok = ['Download', 'Re-submit'];
    const table = [
        row('omberg-bisect-k3-bad-without-16c.svg - golf-map Ombergs Golfklubb 2026-10-17 15:02', 'Processing', '2026-10-17 11:02', ['Re-submit']),
        row('ombergs-golfklubb.svg', 'Draft', '2026-10-17 09:38', ['Re-submit']),
        row('ombergs-golfklubb.svg', 'Processing Complete', '2026-10-17 07:17', ok),
        row('ombergs-golfklubb.svg', 'Draft', '2026-10-17 07:10', ['Re-submit']),
        row('ombergs-golfklubb.svg', 'Processing Complete', '2026-10-17 06:46', ok),
        row('ombergs-golfklubb.svg', 'Processing Complete', '2026-10-16 11:11', ok),
        row('ombergs-golfklubb.svg', 'Draft', '2026-10-15 16:52', ['Re-submit']),
    ];
    // Snapshot folders are local (CEST, UTC+2) times.
    const snap = (name: string, iso: string) => ({ name, exportedAt: new Date(iso).toISOString(), svg: 'ombergs-golfklubb.svg' });
    const snaps = [
        snap('2026-10-15_22-50-19', '2026-10-15T22:50:19+02:00'),
        snap('2026-10-16_17-11-34', '2026-10-16T17:11:34+02:00'),
        snap('2026-10-17_12-46-25', '2026-10-17T12:46:25+02:00'),
        snap('2026-10-17_13-10-26', '2026-10-17T13:10:26+02:00'),
        snap('2026-10-17_13-17-34', '2026-10-17T13:17:34+02:00'),
        snap('2026-10-17_15-37-30', '2026-10-17T15:37:30+02:00'),
    ];
    const now = new Date('2026-10-17T16:00:00+02:00');

    test("OPCD's Created column is US Eastern: local Swedish time minus 6 h in October", () => {
        expect(opcdCreatedToUtc('2026-10-17 09:38').toISOString()).toBe('2026-10-17T13:38:00.000Z');
        // After the US switch (1 Nov 2026) it is UTC-5.
        expect(opcdCreatedToUtc('2026-11-10 09:38').toISOString()).toBe('2026-11-10T14:38:00.000Z');
    });

    test('ok = a Download, failed = Draft or Processing past 8 min, else pending', () => {
        expect(buildOutcome(table[2]!, now)).toBe('ok');
        expect(buildOutcome(table[1]!, now)).toBe('failed');
        const created = '2026-10-17 09:55';   // 15:55 local
        expect(buildOutcome(row('a', 'Processing', created), new Date('2026-10-17T16:00:00+02:00'))).toBe('pending');
        expect(buildOutcome(row('a', 'Processing', created), new Date('2026-10-17T16:04:00+02:00'))).toBe('failed');
        expect(buildOutcome(row('a', 'Waiting to be processed', created), new Date('2026-10-17T16:30:00+02:00'))).toBe('pending');
    });

    test('a Download of a report (OPCD refused the SVG) is a failed build, not a .blend', () => {
        const done = (file: string | null) => jobFromCells(0, ['landeryd-masters.svg', 'Processing Complete', '2026-10-20 16:06'], ['Download', 'Re-submit'], file)!;
        expect(buildOutcome(done('narrow_neck_shapes.txt'), now)).toBe('failed');
        expect(buildOutcome(done('vreta_svg.zip'), now)).toBe('ok');
        expect(buildOutcome(done(null), now)).toBe('ok');
        expect(downloadFileName('https://app.opcdgolf.com/files/915bff?filename=narrow_neck_shapes.txt')).toBe('narrow_neck_shapes.txt');
        expect(downloadFileName('#')).toBeNull();
    });

    test("the day's four exports: matched by time, 12:46 ok, 13:10 failed, 13:17 ok, 15:37 failed", () => {
        const linked = linkJobsToSnapshots(table, snaps, now);
        expect([...linked].map(([name, b]) => `${name} ${b.outcome} ${b.opcdCreated}`).sort()).toEqual([
            '2026-10-15_22-50-19 failed 2026-10-15 16:52',
            '2026-10-16_17-11-34 ok 2026-10-16 11:11',
            '2026-10-17_12-46-25 ok 2026-10-17 06:46',
            '2026-10-17_13-10-26 failed 2026-10-17 07:10',
            '2026-10-17_13-17-34 ok 2026-10-17 07:17',
            '2026-10-17_15-37-30 failed 2026-10-17 09:38',
        ]);
        // A bisect variant's job belongs to no snapshot.
        expect([...linked.values()].some((b) => b.job.includes('bisect'))).toBe(false);
    });

    test('a stamped job names its snapshot, whatever the clock says, and beats a match by time', () => {
        const stamped = row('ombergs-golfklubb.svg - golf-map Ombergs Golfklubb export 2026-10-17_13-10-26', 'Processing Complete', '2026-10-17 10:30', ok);
        const linked = linkJobsToSnapshots([stamped, ...table], snaps, now);
        expect(linked.get('2026-10-17_13-10-26')!.outcome).toBe('ok');
        // The unstamped 09:38 job still goes to 15:37, the newest export before it.
        expect(linked.get('2026-10-17_15-37-30')!.opcdCreated).toBe('2026-10-17 09:38');
    });

    test('the SVG being uploaded is found among the snapshots by its bytes', async () => {
        const dir = await tmp();
        try {
            for (const [name, body] of [['2026-10-17_12-46-25', 'old'], ['2026-10-17_15-37-30', 'new']]) {
                await mkdir(path.join(dir, 'export-history', name!), { recursive: true });
                await writeFile(path.join(dir, 'export-history', name!, 'c.svg'), body!);
            }
            await writeFile(path.join(dir, 'c.svg'), 'old');
            expect(await snapshotOfSvg(path.join(dir, 'c.svg'), dir)).toBe('2026-10-17_12-46-25');
            await writeFile(path.join(dir, 'c.svg'), 'edited');
            expect(await snapshotOfSvg(path.join(dir, 'c.svg'), dir)).toBeNull();
            expect(await snapshotOfSvg(path.join(dir, 'c.svg'), path.join(dir, 'nowhere'))).toBeNull();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
