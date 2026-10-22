// OPCD's cloud course builder from the command line — stage 4 of the course →
// GSPro chain (AGENTS.md), the board's one manual gate: `shapes` says "Build
// the SVG in Blender (OPCD), then Update meshes". A human uploads
// `<course>.svg` in the builder, waits out the build and downloads the flat
// `.blend` into the course's export folder next to the SVG it came from. This
// does that run.
//
//   bun run opcd:build -- <course> [options]      upload, build, download
//   bun run opcd:build -- <course> --dry-run      open the SVG Jobs tab, print the jobs, submit nothing
//   bun run opcd:build -- <course> --status       the same, and write each export snapshot's OPCD outcome
//                                                 into its export.json (see "Which export a job built")
//   bun run opcd:build -- <course> --submit-only  upload and submit, exit 0 without waiting (parallel bisects)
//   bun run opcd:build -- --setup [<course>]      record a hand-run (debugging aid)
//
// THE FLOW, as the builder has it (every step is one function below):
//
//   1. `https://app.opcdgolf.com/webui/index.zul`, the app's start page behind
//      the Discord login. Left "Menu" panel → the item "Course Workflow"
//      (its siblings read "OPCD Course Details", "OPCD Course SVG Job" …, so
//      the match is exact).
//   2. The "Course Workflow v1.1.7" tab: a table of Course Name | Designer |
//      Location | Terrain Jobs | SVG Jobs | Beta Status | a button. The row
//      whose Course Name is the course's OPCD name → its "Open Dashboard".
//      That name is NOT ours (`Vreta` here is `Vreta Kloster golfklubb`
//      there), so it is kept per course as `courses.opcd_course_name`
//      (`--opcd-name` for one run).
//   3. The dashboard: "Course: <name>" and the tabs "Course Details" |
//      "Terrain / LiDAR" | "SVG Jobs" | "Beta Release" → "SVG Jobs".
//   4. "Submit New SVG Job": "Choose SVG File..." (a file chooser), a
//      Description field, a "Use Unstable (may have bugs)" checkbox left
//      alone, and the green "Submit SVG Job". The upload has to finish first —
//      "No file selected" turns into the file's name.
//   5. "SVG Jobs for this Course": Name | Status | Created | Actions, newest
//      first. "Processing Complete" carries a green "Download" and an orange
//      "Re-submit"; a row that stays "Draft" with only "Re-submit" never
//      completed. The page does NOT refresh itself, so every look means
//      walking 1 → 3 again.
//
// A build never finishes in under 2 min and usually takes 5-6, so the wait
// sleeps 2 min, then looks every 45 s, and gives up after `--timeout` (8 min
// from the submit). A broken build shows nothing in the tool at all: OPCD DMs
// it in Discord 15-20 min later, which is why the failure message hands over
// the job's own Created time.
//
// Nothing is selected by id. OPCD's UI is ZK (iDempiere): component ids
// (`zk_comp_42`) are generated per session and change on every visit, and the
// tables and menus are divs, not `<table>`/`<ul>`. What stays is what a human
// reads, so every locator here is `getByRole`/`getByText`/row-text filtering.
//
// Options:
//
//   --svg <file>        the SVG to upload (default `<export dir>/<course slug>.svg`,
//                       what `bun run gspro:export -- <course> svg` writes)
//   --out <folder>      where the .blend goes (default the course's export folder)
//   --opcd-name <name>  the course's Course Name in OPCD, for this run
//   --dry-run           walk to the SVG Jobs tab, print the job table, submit nothing
//   --attach            submit nothing: wait for the newest job already in the table (with --svg:
//                       the newest job of that file) and download it
//   --submit-only       upload and submit, then exit 0 (OPCD builds up to 3 at once; --status reads them)
//   --status            print the job table and record every export snapshot's build outcome
//   --timeout <min>     cap on the build wait (default 8)
//   --headed            show the browser (a real run is headless)
//   --url <url>         override the start page (the launch proof uses `about:blank`)
//
// WHICH EXPORT A JOB BUILT. The table's Name is `<svg file> - <description>`, and
// the description names the export snapshot when the SVG is one
// (`golf-map Ombergs Golfklubb export 2026-10-17_15-37-30`: the folder under
// `<export dir>/export-history/`, local time). Jobs from before that carry no stamp
// and are matched by time: OPCD's Created column is US Eastern (America/New_York,
// local Swedish time minus 6 h), and the job is the newest snapshot of that SVG
// exported before it. `--status` writes `build: {opcdCreated, status, outcome}` into
// the snapshot's `export.json`, which is what `gspro:bisect -- <course> snapshots`,
// its `--from last-good` and the GSPro sync board read. Outcome: ok = a Download;
// failed = Draft (where a failed build ends up), or still Processing 8 min after it
// was created; pending = anything else (waiting for a builder slot, processing).
// The Bun parent writes the records (the database half), from the table the Node
// child leaves in `OPCD_JOBS_OUT`.
//
// `--svg --out --opcd-name` together say everything a run needs, and then the
// database is never opened — and nothing of the server is even imported, since
// those imports are inside `resolveCourse`. That is the way to run the browser
// half under another runtime (see the note at the end), or to build an SVG
// that is not the course's own.
//
// `--setup` is the debugging aid: a headed browser on the kept profile, a
// Playwright trace, every URL change with a timestamp, every POST, every
// download, every dialog, and a DOM snapshot + screenshot each time you press
// Enter in the terminal — into `data/opcd-recording/<timestamp>/`. It is what
// to run when the words below stop matching the page.
//
// The browser profile is `data/opcd-profile/` (gitignored with the rest of
// `data/`), so the Discord session survives between runs; when it has lapsed
// the site shows its login instead of the app, the run reopens the browser
// with a window and waits up to 5 min for the approval in Discord.
//
// Reads data/app.sqlite (DB_PATH) and data/ (DATA_DIR) like the server, and
// takes the export folder from the course's own settings
// (`GsproExportService.settings`) exactly as scripts/gspro-export.ts does.
//
// ON THIS MACHINE Playwright cannot drive a browser under Bun at all: it
// speaks to Chromium over `--remote-debugging-pipe` (extra stdio fds) or a CDP
// WebSocket, and Bun on Windows carries the bytes of neither. So Bun does what
// only Bun can — read the database — and then hands the whole run to a **Node**
// with the resolved course in `OPCD_RESOLVED` (`relaunchUnderNode`). There is
// no `node` on PATH here, but every Electron app is one with
// `ELECTRON_RUN_AS_NODE=1`, and VS Code's is Node 24, which also runs this
// TypeScript file as it stands (type stripping — hence no `enum`, no
// constructor parameter properties, and no `Bun.*` outside `resolveCourse`).
// `browserDiagnosis()` is what is printed when no such runtime is found at all.
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Download, type Locator, type Page } from '@playwright/test';

// Everything the server brings along — the database, `GsproExportService` —
// is imported INSIDE `resolveCourse`, not here: `bun:sqlite` is Bun's own, and
// the browser half has to stay runnable where Playwright works (see the note
// at the end of this comment block).

// Not `import.meta.dir` (Bun's own): this file also runs under Node.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The app's start page. Everything else is reached by clicking, not by URL (ZK). */
export const OPCD_START_URL = 'https://app.opcdgolf.com/webui/index.zul';
/** The menu item that opens the course list. Its siblings start with "OPCD", so the match is exact. */
export const MENU_ITEM = 'Course Workflow';
/** The dashboard tab the SVG build lives on. */
export const SVG_JOBS_TAB = 'SVG Jobs';
/** The browser profile the Discord login lives in (gitignored, like the rest of `data/`). */
export const PROFILE_DIR = 'opcd-profile';
/** One folder per recorded session: `data/opcd-recording/<timestamp>/`. */
export const RECORDING_DIR = 'opcd-recording';
/** No build has ever finished faster, so the first look waits this long. */
export const BUILD_FIRST_LOOK_MS = 2 * 60_000;
/** Then one look every 45 s. Each look walks the menu again — the page does not refresh itself. */
export const BUILD_POLL_MS = 45_000;
/** Default cap from the submit (`--timeout`). A good build takes 5-6 min. */
export const BUILD_TIMEOUT_MS = 8 * 60_000;
/** The `.blend` is ~190 MB, so the download gets its own, longer cap. */
export const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** How long the headed relaunch waits for the user to approve the login in Discord. */
export const LOGIN_WAIT_MS = 5 * 60_000;
/**
 * A launch that does not answer in this long is this machine's Bun/Playwright
 * problem, not a slow disk (Playwright's own default is 180 s of waiting).
 */
export const LAUNCH_TIMEOUT_MS = 30_000;
/** How long a click may take to settle a ZK page (an AJAX round trip, not a page load). */
export const STEP_TIMEOUT_MS = 30_000;

// ───────────────────────────── the output name ─────────────────────────────

/**
 * OPCD names its builds `<prefix>_svg_<n>.blend` (`vreta_svg_1988.blend`), and
 * the numbers in the export folder have gaps (1984, 1985, 1987, 1988) — they
 * are OPCD's own build numbers, not a per-course counter. So: keep the number
 * the download already carries when it is one of those names, and fall back to
 * "the highest in the folder plus one" when the download has no useful name.
 *
 * `existing` is a plain file listing; `.conformed.blend` (what
 * `shape_prepare.py` writes next to the build) is not a build and never
 * counts.
 */
export function nextBlendName(existing: string[], prefix: string, suggested?: string | null): string {
    const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_svg_(\\d+)\\.blend$`, 'i');
    const numbers = existing.map((f) => pattern.exec(f)).filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]));
    const highest = numbers.length ? Math.max(...numbers) : 0;
    const fromOpcd = suggested ? pattern.exec(suggested.trim()) : null;
    // OPCD's own number wins, as long as it is not one we already have (a
    // re-download of an old build must not overwrite the file in place).
    if (fromOpcd && !existing.some((f) => f.toLowerCase() === suggested!.trim().toLowerCase())) {
        return `${prefix}_svg_${Number(fromOpcd[1])}.blend`;
    }
    return `${prefix}_svg_${highest + 1}.blend`;
}

/**
 * `Vreta Kloster GK` -> `vreta-kloster-gk`: the course's slug, the stem of the
 * SVG `gspro:export` writes (`<slug>.svg`), which OPCD names its build after
 * (`ombergs-golfklubb.svg` -> `ombergs-golfklubb_svg_90.blend`; Vreta's has no
 * hyphen to tell). Written out rather than taken from `courseSlug` so this half
 * of the script imports nothing of the server's (which is Bun-only, through
 * `bun:sqlite`); the test pins it to `courseSlug`.
 */
export const blendPrefix = (courseName: string) => (courseName
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'course');

// ──────────────────────────────── the CLI ────────────────────────────────

export interface SetupArgs {
    mode: 'setup';
    /** Optional: only to print which SVG to upload and where the .blend belongs. */
    course: string | null;
    /** Start page override (`about:blank` for the launch proof). */
    url: string | null;
}

export interface BuildArgs {
    mode: 'build';
    course: string;
    /** `--svg`, absolute; null = the course's own `<export dir>/<slug>.svg`. */
    svg: string | null;
    /** `--out`, absolute; null = the course's export folder. */
    out: string | null;
    headless: boolean;
    /** `--opcd-name`: the course's Course Name in OPCD; null = `courses.opcd_course_name`. */
    opcdName: string | null;
    /** `--dry-run`: walk to the SVG Jobs tab and print the jobs, submit nothing. */
    dryRun: boolean;
    /** `--attach`: submit nothing; wait for the newest job already in the table and download it. */
    attach: boolean;
    /** `--submit-only`: upload and submit, then exit without waiting. */
    submitOnly: boolean;
    /** `--status`: print the job table and record each export snapshot's build outcome. */
    status: boolean;
    /** `--timeout` in ms (from the submit). */
    timeoutMs: number;
    url: string | null;
}

export type Args = SetupArgs | BuildArgs;

export function usageText(): string {
    return [
        'usage: bun run opcd:build -- <course> [--svg <file>] [--out <folder>] [--opcd-name <name>]',
        '                                      [--dry-run | --status | --submit-only] [--timeout <min>] [--headed]',
        '       bun run opcd:build -- --setup [<course>]',
        '',
        '<course>          course id, slug or a unique name substring ("vreta")',
        '--svg <file>      the SVG to upload (default: the course export folder\'s <slug>.svg)',
        '--out <folder>    where the .blend lands (default: the course\'s export folder)',
        '--opcd-name       the course\'s Course Name in OPCD\'s Course Workflow list, for this run',
        '                  (kept per course as courses.opcd_course_name)',
        '--dry-run         walk to the SVG Jobs tab and print its job table; submit nothing',
        '--status          the same, and record each export snapshot\'s OPCD outcome in its export.json',
        '--submit-only     upload and submit, then exit 0 without waiting (up to 3 builds run at once)',
        '--timeout <min>   give up on the build after this long (default 8; a good one takes 5-6)',
        '--headed          show the browser (a real run is headless)',
        '--setup           record a hand-run for debugging: a headed browser on the kept profile,',
        '                  a trace, the POSTs, the downloads, and a DOM snapshot every time you',
        '                  press Enter in the terminal',
    ].join('\n');
}

/** The flags that take a value, so the token after one is never read as the course. */
const VALUE_FLAGS = new Set(['--svg', '--out', '--url', '--opcd-name', '--timeout']);

export function parseArgs(argv: string[]): Args | { error: string } {
    let setup = false;
    let course: string | null = null;
    let svg: string | null = null;
    let out: string | null = null;
    let url: string | null = null;
    let opcdName: string | null = null;
    let headless: boolean | null = null;
    let dryRun = false;
    let attach = false;
    let submitOnly = false;
    let status = false;
    let timeoutMs = BUILD_TIMEOUT_MS;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        const value = () => {
            const v = argv[i + 1];
            if (v === undefined || v.startsWith('--')) return null;
            i++;
            return v;
        };
        if (!a.startsWith('--')) {
            if (course !== null) return { error: `name one course, not '${course}' and '${a}'` };
            course = a;
        } else if (a === '--setup') setup = true;
        else if (a === '--headless') headless = true;
        else if (a === '--headed') headless = false;
        else if (a === '--dry-run') dryRun = true;
        else if (a === '--attach') attach = true;
        else if (a === '--submit-only') submitOnly = true;
        else if (a === '--status') status = true;
        else if (VALUE_FLAGS.has(a)) {
            const v = value();
            if (v === null) return { error: `${a} needs a value` };
            if (a === '--svg') svg = path.resolve(v);
            else if (a === '--out') out = path.resolve(v);
            else if (a === '--url') url = v;
            else if (a === '--opcd-name') opcdName = v;
            else {
                const minutes = Number(v);
                if (!Number.isFinite(minutes) || minutes <= 0) return { error: '--timeout needs minutes, e.g. --timeout 20' };
                timeoutMs = Math.round(minutes * 60_000);
            }
        } else return { error: `unknown option ${a}` };
    }
    if (setup) {
        if (svg || out || opcdName || dryRun || status || submitOnly) {
            return { error: '--setup records a run done by hand: --svg, --out, --opcd-name, --dry-run, --status and --submit-only do not apply' };
        }
        return { mode: 'setup', course, url };
    }
    if (!course) return { error: 'name a course (or --setup to record a hand-run)' };
    if ([dryRun, status, submitOnly, attach].filter(Boolean).length > 1) {
        return { error: 'pick one of --dry-run, --status, --submit-only and --attach' };
    }
    return { mode: 'build', course, svg, out, headless: headless ?? true, opcdName, dryRun, attach, submitOnly, status, timeoutMs, url };
}

// ───────────────────────────── the recording ─────────────────────────────

export interface RecordedStep {
    /** Seconds since the recording started, so the trace and the log line up. */
    at: number;
    /** Wall clock, because the Discord approval and the build wait are minutes long. */
    time: string;
    kind: 'start' | 'url' | 'post' | 'download' | 'dialog' | 'snapshot' | 'note' | 'finish';
    text: string;
    /** Files this step wrote, relative to the recording folder. */
    files?: string[];
}

export interface RecordingIndex {
    startedAt: string;
    finishedAt: string | null;
    /** The page the recording opened. */
    url: string;
    /** The course it was about, when one was named. */
    course: string | null;
    steps: RecordedStep[];
    /** Everything in the folder the recording wrote, relative to it. */
    files: string[];
}

/** The little of `Page` a snapshot needs — so the writer can be tested with a fake page. */
export interface SnapshotPage {
    url(): string;
    content(): Promise<string>;
    screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
}

/**
 * One recorded session on disk: the log as it happens (so a crash still leaves
 * something), the snapshots, and `index.json` at the end.
 */
export class Recording {
    private readonly steps: RecordedStep[] = [];
    private readonly files: string[] = [];
    private snapshots = 0;

    readonly dir: string;
    readonly url: string;
    readonly course: string | null;
    readonly startedAt: Date;

    // Written out rather than as constructor parameter properties: this file is
    // also run by Node's own type stripping, which cannot compile those away.
    constructor(dir: string, url: string, course: string | null, startedAt: Date = new Date()) {
        this.dir = dir;
        this.url = url;
        this.course = course;
        this.startedAt = startedAt;
    }

    static async open(root: string, url: string, course: string | null, now = new Date()): Promise<Recording> {
        const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dir = path.join(root, stamp);
        await mkdir(dir, { recursive: true });
        const rec = new Recording(dir, url, course, now);
        await rec.log('start', `recording ${url}${course ? ` for ${course}` : ''}`);
        return rec;
    }

    /** Append one line to `log.txt` and keep it for `index.json`. */
    async log(kind: RecordedStep['kind'], text: string, files?: string[]): Promise<RecordedStep> {
        const now = new Date();
        const step: RecordedStep = {
            at: Math.round((now.getTime() - this.startedAt.getTime()) / 100) / 10,
            time: now.toISOString(), kind, text, ...(files ? { files } : {}),
        };
        this.steps.push(step);
        if (files) this.files.push(...files);
        await writeFile(path.join(this.dir, 'log.txt'),
            `${String(step.at).padStart(7)}s  ${step.time}  ${kind.padEnd(8)}  ${text}\n`, { flag: 'a' });
        return step;
    }

    /** Note a file the session produced (a download, the trace) without a log line of its own. */
    addFile(name: string): void {
        this.files.push(name);
    }

    /**
     * The page as it stands: `page.content()` and a full-page screenshot. The
     * HTML is the only thing that shows which words the locators can use, so
     * it is taken whole, not as a selector guess.
     */
    async snapshot(page: SnapshotPage, label: string): Promise<RecordedStep> {
        const n = String(++this.snapshots).padStart(2, '0');
        const html = `snapshot-${n}.html`;
        const png = `snapshot-${n}.png`;
        await writeFile(path.join(this.dir, html), await page.content());
        await page.screenshot({ path: path.join(this.dir, png), fullPage: true });
        return this.log('snapshot', `${label} — ${page.url()}`, [html, png]);
    }

    /** `index.json`: the steps and every file, so a hand-run can be read back without the browser. */
    async finish(note = 'closed'): Promise<RecordingIndex> {
        await this.log('finish', note);
        const index: RecordingIndex = {
            startedAt: this.startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            url: this.url,
            course: this.course,
            steps: this.steps,
            files: [...new Set(['log.txt', 'index.json', ...this.files])].sort(),
        };
        await writeFile(path.join(this.dir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
        return index;
    }
}

/**
 * Everything the recording watches on a page (and on any window the site
 * opens): URL changes with a timestamp — ZK keeps the whole app on
 * `index.zul`, and this is how we would see it if that ever changed — plus the
 * POSTs that carry the upload and the build command, the downloads, and the
 * dialogs.
 */
export function watchPage(page: Page, rec: Recording, origin: string, downloadsTo: string): void {
    page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) void rec.log('url', frame.url());
    });
    page.on('request', (req) => {
        if (req.method() !== 'POST') return;
        if (!req.url().startsWith(origin)) return;
        const body = req.postData();
        void rec.log('post', `${req.url()}${body ? `  body ${body.length} bytes: ${body.slice(0, 300).replace(/\s+/g, ' ')}` : ''}`);
    });
    page.on('response', (res) => {
        const disposition = res.headers()['content-disposition'];
        if (disposition && res.url().startsWith(origin)) {
            void rec.log('download', `response ${res.status()} ${res.url()}  ${disposition}`);
        }
    });
    page.on('download', (download) => { void saveDownload(download, rec, downloadsTo); });
    page.on('dialog', (dialog) => {
        // Nothing is answered on the user's behalf: the dialog stays for them.
        void rec.log('dialog', `${dialog.type()}: ${dialog.message()}`);
    });
    page.on('popup', (popup) => watchPage(popup, rec, origin, downloadsTo));
}

/** A download into the recording folder, under the name the site suggested. */
export async function saveDownload(download: Download, rec: Recording, dir: string): Promise<void> {
    const name = download.suggestedFilename() || 'download.bin';
    const to = path.join(dir, name);
    try {
        await download.saveAs(to);
        await rec.log('download', `saved ${name} (from ${download.url()})`, [name]);
    } catch (e) {
        await rec.log('download', `FAILED to save ${name}: ${(e as Error).message}`);
    }
}

// ───────────────────── the browser (persistent profile) ─────────────────────

export interface LaunchOptions {
    /** `data/opcd-profile/` — the Discord session lives here between runs. */
    profileDir: string;
    headless: boolean;
    /** Where downloads go when nothing else is said. */
    downloadsTo: string;
    timeoutMs?: number;
}

/**
 * The browser the whole script uses: one persistent context, so the Discord
 * OAuth session (and its cookies) survive between runs and the user is asked
 * to approve in Discord only now and then rather than every time.
 */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserContext> {
    await mkdir(opts.profileDir, { recursive: true });
    await mkdir(opts.downloadsTo, { recursive: true });
    try {
        const context = await chromium.launchPersistentContext(opts.profileDir, {
            headless: opts.headless,
            acceptDownloads: true,
            downloadsPath: opts.downloadsTo,
            viewport: { width: 1600, height: 1000 },
            timeout: opts.timeoutMs ?? LAUNCH_TIMEOUT_MS,
        });
        // Playwright's actions wait for an element to be stable and to receive pointer
        // events with NO time limit by default: a click under a ZK overlay would hang the
        // run forever. With a limit the error says what intercepted the click.
        context.setDefaultTimeout(STEP_TIMEOUT_MS);
        context.setDefaultNavigationTimeout(STEP_TIMEOUT_MS * 2);
        return context;
    } catch (e) {
        const first = (e as Error).message.split('\n')[0] ?? '';
        // A second Chromium on a profile another one holds hands itself over to that one and
        // quits, which Playwright reports as the browser having closed: not a runtime problem.
        if (/has been closed/i.test(first)) {
            throw new Error(`${first}\nThe profile ${opts.profileDir} is in use: a Chromium from an earlier run is still open `
                + '(the headed window of a --setup or --headed run). Close it and run again.');
        }
        throw new Error(`${first}\n${browserDiagnosis()}`);
    }
}

/**
 * Why the launch above fails on this box, since the message Playwright gives
 * ("Timeout 30000ms exceeded") says nothing. Measured here on 2026-10-14 with
 * Playwright 1.61.1 and Bun 1.3.14 on Windows 11:
 *
 *   - the Chromium IS installed (`bunx playwright install --dry-run chromium`
 *     lists chromium-1228) and it DOES start — the launch log shows
 *     `<launched> pid=…` — but no CDP message ever arrives;
 *   - Playwright talks to it over `--remote-debugging-pipe`, fds 3 and 4. Bun
 *     hands the parent two Sockets for them, but nothing comes through;
 *   - the way round (`--remote-debugging-port` + `connectOverCDP`) dies one
 *     step further on: Bun's `node:http` answers a `101 Switching Protocols`
 *     with a plain `response` event instead of `upgrade`, so the bundled `ws`
 *     client never finishes the handshake. Bun's own `WebSocket` speaks to the
 *     same port fine, which is the proof it is the client, not the browser.
 *
 * So Playwright needs a Node here — which `relaunchUnderNode` finds, since
 * every installed Electron app is one. This text is for the case where it
 * finds none. It is also the long-standing "Playwright e2e can't launch Chrome
 * here" (AGENTS.md "This machine").
 */
export function browserDiagnosis(): string {
    return [
        'No runtime on this machine can drive a browser, and that is Bun, not Playwright or a missing Chromium:',
        '  - Playwright drives Chromium over --remote-debugging-pipe (stdio fds 3/4), and Bun on Windows',
        '    does not carry those bytes; the CDP-over-WebSocket way round fails too, because Bun\'s node:http',
        '    never emits the `upgrade` event for the 101 handshake.',
        '  - Chromium itself is fine: `bunx playwright install --dry-run chromium` lists it, and it starts.',
        '  - A Node would do, and so would any Electron app as one (ELECTRON_RUN_AS_NODE=1) — none was found',
        `    (looked for node on PATH, then: ${electronCandidates(process.env).map((c) => c.path).join(', ')}).`,
        'Fix: winget install OpenJS.NodeJS.LTS (then `node` is on PATH and this finds it by itself).',
        '`bunx playwright install chromium` is NOT the problem.',
    ].join('\n');
}

// ───────────────────────────── the steps ─────────────────────────────

export interface BuildDeps {
    log(line: string): void;
    now(): number;
    sleep(ms: number): Promise<void>;
}

export const realBuildDeps = (): BuildDeps => ({
    log: (line) => console.log(line),
    now: () => Date.now(),
    // Not Bun.sleep: the browser half of this script runs under Node (see `nodeRuntime`).
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
});

/** A step that cannot find its words on the page: the page changed, or the login lapsed. */
export class PageChanged extends Error {
    constructor(step: string, what: string) {
        super(`${step}: ${what}\n`
            + 'If OPCD has renamed something, record a hand-run and read the new words off it: '
            + 'bun run opcd:build -- --setup <course>');
        this.name = 'PageChanged';
    }
}

/**
 * Step 1 — the app, logged in. The profile normally still has the Discord
 * session; when it does not, the site shows its login instead of the app, and
 * a headless browser can do nothing about it: Discord asks the user to approve
 * in their own Discord. So we relaunch HEADED and wait for them.
 */
export async function openSite(
    opts: { profileDir: string; headless: boolean; downloadsTo: string; url: string; rec?: Recording },
    deps: BuildDeps,
): Promise<{ context: BrowserContext; page: Page }> {
    const origin = new URL(opts.url).origin;
    let context = await launchBrowser(opts);
    let page = context.pages()[0] ?? await context.newPage();
    if (opts.rec) watchPage(page, opts.rec, origin, opts.downloadsTo);
    deps.log(`open ${opts.url}${opts.headless ? ' (headless)' : ''}`);
    await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    if (await finishLogin(page, deps) === 'app') return { context, page };

    // Only a Discord login FORM gets this far: there is no Discord web session
    // in the profile, and typing a password is not ours to do.
    if (opts.headless) {
        deps.log('Discord wants a login, which only a human can give: reopening the browser with a window');
        await context.close();
        context = await launchBrowser({ ...opts, headless: false });
        page = context.pages()[0] ?? await context.newPage();
        if (opts.rec) watchPage(page, opts.rec, origin, opts.downloadsTo);
        await page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    }
    for (const line of LOGIN_BY_HAND) deps.log(line);
    // The second tab saves a step: Discord is where the session has to be made.
    await context.newPage().then((tab) => tab.goto('https://discord.com/login', { waitUntil: 'domcontentloaded' }))
        .catch(() => deps.log('  (could not open discord.com in a second tab — open it yourself)'));
    const t0 = deps.now();
    while (deps.now() - t0 < LOGIN_WAIT_MS) {
        await deps.sleep(3_000);
        await page.bringToFront().catch(() => undefined);
        if (await finishLogin(page, deps) === 'app') {
            deps.log(`logged in after ${Math.round((deps.now() - t0) / 1000)} s`);
            return { context, page };
        }
    }
    await context.close();
    throw new Error('the OPCD app never appeared: the Discord login was not done within 5 min');
}

/** What the user has to do when the profile has no Discord web session. */
export const LOGIN_BY_HAND = [
    'The login needs you, in the window that just opened:',
    '  1) open https://discord.com in it and log in there first (a second tab is open on it);',
    '  2) then go back to OPCD and use "Login with Discord" — with a Discord web session in this',
    '     profile the authorization is one click here, not a push to the Discord app.',
    'Waiting up to 5 min; the profile keeps the session, so this is a one-off.',
];

/** Discord's consent page. The button follows the Discord UI language — Swedish here. */
export const AUTHORIZE_BUTTON = /^(Auktorisera|Authorize)$/i;
/** iDempiere's Select Role dialog: everything is prefilled, the label carries a check icon. */
export const SELECT_ROLE_OK = /^.?\s*OK$/;

/**
 * Carry the login as far as a script can, and say whether it got there:
 *
 *   - Discord's consent page ("OPCD Golf vill ha åtkomst till ditt
 *     Discord-konto", Avbryt | Auktorisera) → Auktorisera. With a Discord web
 *     session in the profile this is the whole re-login, and it works headless;
 *   - iDempiere's "Select Role" dialog that OPCD shows next (Tenant opcd, Role
 *     RegisteredUser, prefilled) → OK;
 *   - a Discord login FORM means the profile has no session at all, and only a
 *     human can fix that: `needs-human`.
 */
export async function finishLogin(page: Page, deps: BuildDeps): Promise<'app' | 'needs-human'> {
    const until = deps.now() + 90_000;
    for (;;) {
        if (await isAppReady(page)) return 'app';
        if (await isDiscordLoginForm(page)) return 'needs-human';
        const authorize = page.getByRole('button', { name: AUTHORIZE_BUTTON }).first();
        if (await visible(authorize, 1_000)) {
            deps.log('Discord asks whether OPCD Golf may use the account: Auktorisera');
            await authorize.click().catch(() => undefined);
            await page.waitForLoadState('domcontentloaded').catch(() => undefined);
            continue;
        }
        const ok = page.getByRole('button', { name: SELECT_ROLE_OK }).first();
        if (await visible(ok, 1_000)) {
            deps.log('OPCD asks for the role (Tenant opcd, RegisteredUser): OK');
            await ok.click().catch(() => undefined);
            continue;
        }
        if (deps.now() > until) return 'needs-human';
        await deps.sleep(1_500);
    }
}

/** A Discord login form — an e-mail and a password to type, which is the human's part. */
export async function isDiscordLoginForm(page: Page): Promise<boolean> {
    if (!/discord\.com/i.test(page.url())) return false;
    return visible(page.locator('input[type=password]').first(), 1_000);
}

/**
 * Is this the app, or still the login flow? ZK renders the whole app into
 * `index.zul`, so the URL alone does not say — what does is the Menu panel's
 * own item, the first thing the run clicks anyway.
 */
export async function isAppReady(page: Page): Promise<boolean> {
    if (/discord\.com/i.test(page.url())) return false;
    return visible(menuItem(page), 5_000);
}

/**
 * `locator.isVisible()` answers at once and ignores its `timeout` (Playwright documents it
 * as deprecated there): right after a click the next page has not rendered yet and it says
 * "not visible". This waits, like every other check in this file must.
 */
export async function visible(locator: Locator, timeoutMs: number): Promise<boolean> {
    return locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);
}

/** ZK keeps hidden copies of the menu words (the Alt+G search list), so only a VISIBLE match counts. */
export const visibleText = (page: Page, text: string | RegExp, exact = true) =>
    page.getByText(text, { exact }).filter({ visible: true }).first();
export const menuItem = (page: Page) => visibleText(page, MENU_ITEM);

/**
 * Steps 1-3 — from wherever we are to the course's SVG Jobs tab: Menu →
 * "Course Workflow" → the course's row → "Open Dashboard" → the "SVG Jobs"
 * tab. The whole walk is one function because the job table does not refresh
 * itself: every look at the build's progress means doing it again.
 */
export async function openSvgJobsTab(page: Page, opcdName: string, deps: BuildDeps): Promise<void> {
    const menu = menuItem(page);
    if (!await visible(menu, STEP_TIMEOUT_MS)) {
        throw new PageChanged('menu', `the Menu panel has no item that reads exactly '${MENU_ITEM}'`);
    }
    await menu.click();
    const row = await courseRow(page, opcdName);
    await row.getByText(OPEN_DASHBOARD).first().click();
    const tab = visibleText(page, SVG_JOBS_TAB);
    if (!await visible(tab, STEP_TIMEOUT_MS)) {
        throw new PageChanged('dashboard', `the course dashboard has no '${SVG_JOBS_TAB}' tab `
            + `(is '${opcdName}' the right course? its dashboard should read "Course: ${opcdName}")`);
    }
    // The submit box is what says the tab is really open, not just clicked: ZK sometimes
    // takes the first click as a focus only, so the tab is clicked once more when the box
    // does not come, and a tab that never opens is an error, not a shrug.
    let opened = false;
    for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
        await tab.click();
        opened = await visible(visibleText(page, /submit new svg job/i, false), STEP_TIMEOUT_MS / 2);
        if (!opened) deps.log(`the '${SVG_JOBS_TAB}' tab did not open on click ${attempt}`);
    }
    if (!opened) throw new PageChanged('dashboard', `the '${SVG_JOBS_TAB}' tab was clicked twice and never showed "Submit New SVG Job"`);
    deps.log(`SVG Jobs tab of '${opcdName}'`);
}

/**
 * The Course Workflow list's row for a course. ZK draws the table as divs, so
 * the row is "the element that contains the name and an Open Dashboard
 * button": `tr` when the markup happens to be a table, the ARIA row
 * otherwise. When nothing matches, the error lists the names the table does
 * offer — the OPCD name is rarely ours (`Vreta Kloster golfklubb`).
 */
export async function courseRow(page: Page, opcdName: string): Promise<Locator> {
    // ZK's "button" may be a <button>, an <a> or a styled div: match the words, not the role.
    for (const rows of [page.locator('tr'), page.getByRole('row')]) {
        const row = rows.filter({ hasText: opcdName }).filter({ has: page.getByText(OPEN_DASHBOARD) }).first();
        if (await visible(row, STEP_TIMEOUT_MS / 2)) return row;
    }
    const sample = await page.locator('tr').filter({ hasText: opcdName }).first().evaluate((el) => el.outerHTML.slice(0, 1500)).catch(() => '(no tr holds the name)');
    throw new PageChanged('course list', `no row of the '${MENU_ITEM}' list has Course Name '${opcdName}' `
        + `and an Open Dashboard button. The names it offers: ${(await courseNames(page)).join(' | ') || '(none read)'}. `
        + 'Set the right one with --opcd-name <name> (and keep it: courses.opcd_course_name). '
        + `The first row holding the name reads: ${sample}`);
}

/** The words on the course row's button; matched as text since ZK may not render a <button>. */
export const OPEN_DASHBOARD = /open dashboard/i;
/** The job table's action words (Download, Re-submit), matched as text for the same reason. */
export const ACTION_WORDS = /^ *(download|re-submit) *$/i;

/** The Course Names the workflow list shows, for the error above. First cell of each row. */
export async function courseNames(page: Page): Promise<string[]> {
    const rows = await page.locator('tr').all();
    const names: string[] = [];
    for (const row of rows.slice(0, 60)) {
        const cells = await rowCells(row);
        const first = cells[0]?.trim();
        if (first && !/^course name$/i.test(first)) names.push(first);
    }
    return names;
}

/** A row's cells: `td`/ARIA cells when they exist, else the row's text by lines (what ZK's divs give). */
export async function rowCells(row: Locator): Promise<string[]> {
    const cells = await row.locator('td').allTextContents();
    if (cells.length) return cells.map((c) => c.replace(/\s+/g, ' ').trim());
    const text = (await row.innerText().catch(() => '')) ?? '';
    return text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * Step 4a — the SVG into "Submit New SVG Job". The "Choose SVG File..." button
 * opens the OS file dialog, which Playwright takes either by setting the
 * hidden `input[type=file]` or through the `filechooser` event; the upload
 * then runs on its own, and "No file selected" turns into the file's name when
 * it is done. Submitting before that loses the file.
 */
export async function uploadSvg(page: Page, svgPath: string, deps: BuildDeps): Promise<void> {
    const name = path.basename(svgPath);
    const input = page.locator('input[type=file]').first();
    if (await input.count() > 0) {
        await input.setInputFiles(svgPath);
    } else {
        const choose = page.getByRole('button', { name: /choose svg file/i }).first();
        if (!await visible(choose, STEP_TIMEOUT_MS)) {
            throw new PageChanged('upload', 'the SVG Jobs tab has no file input and no "Choose SVG File..." button');
        }
        const [chooser] = await Promise.all([page.waitForEvent('filechooser'), choose.click()]);
        await chooser.setFiles(svgPath);
    }
    // The upload is done when the box names the file instead of "No file selected".
    await visibleText(page, name, false)
        .waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS * 4 })
        .catch(() => { throw new PageChanged('upload', `the page never showed '${name}' after the upload — it may still read "No file selected"`); });
    deps.log(`uploaded ${name}`);
}

/**
 * Step 4b — the description and the green "Submit SVG Job". "Use Unstable (may
 * have bugs)" is left alone on purpose. Returns the jobs as they were just
 * BEFORE the submit, which is how the wait tells our job from the older ones
 * (they keep their own Download buttons).
 */
export async function startBuild(page: Page, description: string, deps: BuildDeps): Promise<{ before: SvgJob[]; described: boolean }> {
    const before = await readJobs(page);
    let described = false;
    // The Description box is known by its placeholder: the page's FIRST text box is the
    // global search (Alt+G), and typing there opens a popup that then covers the Submit
    // button. No placeholder, no description — never "the first input".
    const field = page.getByPlaceholder(/optional description/i).first();
    if (await visible(field, STEP_TIMEOUT_MS / 2)) {
        await field.fill(description);
        described = true;
    } else {
        deps.log('  (no Description field found — submitting without one)');
    }
    const submit = page.getByRole('button', { name: /submit svg job/i }).first();
    if (!await visible(submit, STEP_TIMEOUT_MS)) {
        throw new PageChanged('submit', 'no button reads "Submit SVG Job"');
    }
    // Any open ZK popup (the search bandbox, a dropdown) would intercept the click.
    await page.keyboard.press('Escape').catch(() => undefined);
    await submit.click();
    deps.log(`submitted '${description}' (${before.length} job(s) in the table before it)`);
    return { before, described };
}

// ───────────────────────── the job table ─────────────────────────

/** One row of "SVG Jobs for this Course": Name | Status | Created | Actions. */
export interface SvgJob {
    /** Position in the table as read, 0 = newest. */
    index: number;
    name: string;
    /** `Processing Complete`, `Draft`, … as the page writes it. */
    status: string;
    /** OPCD's own local timestamp, `2026-10-11 11:03`. */
    created: string;
    /** The row's buttons: `Download`, `Re-submit`. */
    actions: string[];
    /** The Download link's `?filename=` (`vreta_svg.zip`), when the row has one. */
    file?: string | null;
}

/** A finished build has a Download: the built course, or the report of why it was not built. */
export const isDone = (job: SvgJob) => job.actions.some((a) => /^download$/i.test(a.trim()));
/**
 * OPCD's validation refusal is a "Processing Complete" row too, but its Download is a text
 * report (`narrow_neck_shapes.txt`, Landeryd 2026-10-20), not the zip with the .blend.
 */
export const isReport = (file: string | null | undefined) => !!file && !/\.(zip|blend)$/i.test(file);
/** A row that never got past Draft never completed (OPCD DMs the reason in Discord). */
export const isDraft = (job: SvgJob) => /^draft$/i.test(job.status.trim());
/** `Name|Created` — what tells one job from another across a re-navigation. */
export const jobKey = (job: SvgJob) => `${job.name}|${job.created}`;

/** OPCD's Created column: a local timestamp, `2026-10-11 11:03`. */
export const CREATED_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;

/**
 * One row of the job table out of its cells (or, for ZK's divs, its text
 * lines) and its buttons. The header row and anything else without a Created
 * timestamp is not a job and comes back null, which is what keeps the table's
 * own headings out of the list.
 */
export function jobFromCells(index: number, cells: string[], buttons: string[], file: string | null = null): SvgJob | null {
    const clean = cells.map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const createdAt = clean.findIndex((c) => CREATED_PATTERN.test(c));
    if (createdAt < 1) return null;  // no timestamp, or nothing before it: a header, or not a job row
    return {
        index,
        name: clean[0]!,
        status: clean.slice(1, createdAt).join(' '),
        created: clean[createdAt]!,
        actions: buttons.map((b) => b.replace(/\s+/g, ' ').trim()).filter(Boolean),
        file,
    };
}

/** `?filename=` of a Download link (`https://app.opcdgolf.com/files/<hash>?filename=vreta_svg.zip`), or null. */
export function downloadFileName(href: string | null | undefined): string | null {
    if (!href || !/\/files\//.test(href)) return null;
    try { return new URL(href).searchParams.get('filename'); } catch { return null; }
}

/** The job table as it stands. Newest first, as OPCD lists it. */
export async function readJobs(page: Page): Promise<SvgJob[]> {
    // Visible rows only: ZK keeps every tab it ever opened in the page, hidden, and an earlier
    // look's table (its jobs still 'Processing') must not be read as this one.
    const rows = await page.locator('tr').filter({ visible: true }).all();
    const candidates = rows.length ? rows : await page.getByRole('row').filter({ visible: true }).all();
    const jobs: SvgJob[] = [];
    for (const row of candidates) {
        const cells = await rowCells(row);
        // Download is a link and Re-submit a button (ZK): take both roles and the words, once each.
        const byRole = [...await row.getByRole('button').allTextContents().catch(() => [] as string[]), ...await row.getByRole('link').allTextContents().catch(() => [] as string[])];
        // ZK's job-table buttons are not <button>s: read the words in the Actions cell instead.
        const byText = await row.getByText(ACTION_WORDS).allTextContents().catch(() => [] as string[]);
        const buttons = [...new Set([...byRole, ...byText].map((b) => b.trim()).filter(Boolean))];
        const hrefs = await row.locator('a', { hasText: /download/i }).evaluateAll((as) => as.map((a) => a.getAttribute('href'))).catch(() => [] as (string | null)[]);
        const file = hrefs.map(downloadFileName).find(Boolean) ?? null;
        const job = jobFromCells(jobs.length, cells, buttons, file);
        if (job) jobs.push(job);
    }
    return jobs;
}

/** What the submit wrote, so its row can be told from other jobs submitted at the same time. */
export interface OurJob {
    /** The uploaded file's name: the Name column starts with it. */
    svg: string;
    /** The description typed into the box; null when the box was not found (the Name is then the file alone). */
    description: string | null;
}

/** The Name column is `<svg file> - <description>`, or the file alone when no description was given. */
export function splitJobName(name: string): { svg: string; description: string | null } {
    const at = name.indexOf(' - ');
    return at < 0 ? { svg: name.trim(), description: null } : { svg: name.slice(0, at).trim(), description: name.slice(at + 3).trim() };
}

/**
 * Which row is the job we just submitted. With `ours` (a submit of this run): a
 * row that was not in the table before and whose Name is our file and our
 * description — never just "the newest new row", which with parallel bisect
 * builds is another variant's job. Without (`--attach`, following a job somebody
 * else submitted): the first row that was not there before, else the top row of a
 * table that only grew (rows that read the same).
 */
export function pickNewJob(before: SvgJob[], now: SvgJob[], ours?: OurJob): SvgJob | null {
    const seen = new Set(before.map(jobKey));
    const unseen = now.filter((job) => !seen.has(jobKey(job)));
    if (ours) {
        return unseen.find((job) => {
            const name = splitJobName(job.name);
            return name.svg === ours.svg && name.description === ours.description;
        }) ?? null;
    }
    if (unseen[0]) return unseen[0];
    if (now.length > before.length) return now[0] ?? null;
    return null;
}

/** The job table as the `--dry-run` prints it. */
export function jobTableText(jobs: SvgJob[]): string[] {
    if (!jobs.length) return ['  (no SVG jobs in the table)'];
    return jobs.map((j) => `  ${j.created}  ${j.status.padEnd(20)}  ${j.name}  [${j.actions.join(', ') || 'no buttons'}]`
        + (isReport(j.file) ? `  -> ${j.file} (OPCD refused it)` : ''));
}

/**
 * Step 5 — wait the build out. The page does not refresh itself, so `look` is
 * the whole walk — Menu → Course Workflow → Open Dashboard → SVG Jobs — read
 * again (`svgJobsLook`). Nothing finishes inside 2 min, so the first look
 * waits that long; then every 45 s, up to the cap.
 */
export async function waitForBuild(
    look: () => Promise<SvgJob[]>, before: SvgJob[], deps: BuildDeps,
    opts: { timeoutMs?: number; pollMs?: number; firstLookMs?: number; ours?: OurJob } = {},
): Promise<SvgJob> {
    const timeoutMs = opts.timeoutMs ?? BUILD_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? BUILD_POLL_MS;
    const firstLookMs = Math.min(opts.firstLookMs ?? BUILD_FIRST_LOOK_MS, timeoutMs);
    const t0 = deps.now();
    const elapsed = () => Math.round((deps.now() - t0) / 1000);
    const mins = () => `${Math.floor(elapsed() / 60)} min ${String(elapsed() % 60).padStart(2, '0')} s`;
    deps.log(`waiting ${Math.round(firstLookMs / 1000)} s before the first look (no build has finished faster)`);
    await deps.sleep(firstLookMs);
    let mine: SvgJob | null = null;
    let said = '';
    for (;;) {
        const jobs = await look();
        // Annotated: `mine` is read inside its own assignment, which TS cannot infer (TS7022).
        const row: SvgJob | null = pickNewJob(before, jobs, opts.ours)
            ?? (mine ? jobs.find((j) => jobKey(j) === jobKey(mine!)) ?? null : null);
        if (row) mine = row;
        if (mine && isDone(mine)) {
            deps.log(`build finished after ${mins()}: ${mine.name} — ${mine.status}`);
            return mine;
        }
        const state = mine ? `${mine.name} — ${mine.status || '(no status)'}` : 'our job row has not appeared yet';
        if (state !== said) deps.log(`  ${mins()}: ${state}`);
        said = state;
        if (deps.now() - t0 > timeoutMs) {
            // A broken build shows nothing here; OPCD sends a Discord DM 15-20 min on.
            const draft = mine && isDraft(mine) ? ' The row still reads Draft, which means it never completed.' : '';
            throw new Error(`no Download after ${Math.round(timeoutMs / 60_000)} min: the job is `
                + `'${mine ? `${mine.name} — ${mine.status}, created ${mine.created}` : 'not in the table'}'.${draft} `
                + 'OPCD usually DMs a failure in Discord after 15-20 min; the job is still there to Re-submit '
                + '(--timeout <min> waits longer).');
        }
        await deps.sleep(pollMs);
    }
}

/** One look at the job table: the walk through the menu, then the table. What `waitForBuild` polls. */
export const svgJobsLook = (page: Page, opcdName: string, deps: BuildDeps) => async (): Promise<SvgJob[]> => {
    // A fresh page for every look: walking the menu again opens one more "Course Workflow" tab
    // each time (eight after a 20-minute wait), and the SVG Jobs click then lands on the wrong one.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openSvgJobsTab(page, opcdName, deps);
    return readJobs(page);
};

/**
 * Step 6 — the flat `.blend` into the course's export folder, next to the SVG
 * it was built from and named the way the ones already there are
 * (`vreta_svg_1991.blend`).
 */
export async function downloadBlend(
    page: Page, job: SvgJob, opts: { outDir: string; prefix: string }, deps: BuildDeps,
): Promise<{ file: string; megabytes: number; seconds: number }> {
    await mkdir(opts.outDir, { recursive: true });
    const t0 = deps.now();
    // "Download" is a plain link (`<a class="z-a" target="_blank" href="https://app.opcdgolf.com/
    // files/<hash>?filename=vreta_svg.zip">`), and the first row holding the job's time can be a
    // hidden copy, so nothing is clicked: the href is read off any such row and fetched with the
    // browser's own session. The file is a zip with the .blend inside.
    const links = await page.locator('tr').filter({ hasText: job.created }).locator('a', { hasText: /download/i }).all();
    let href: string | null = null;
    for (const link of links) {
        const h = await link.getAttribute('href').catch(() => null);
        if (h && /\/files\//.test(h)) { href = h; break; }
    }
    if (!href) throw new PageChanged('download', `the row of ${job.created} has no Download link with a /files/ address`);
    const fileName = new URL(href).searchParams.get('filename') || 'opcd-download.zip';
    const zipPath = path.join(opts.outDir, `.opcd-${Date.now()}-${fileName}`);
    deps.log(`downloading ${fileName} (${href})`);
    const res = await page.request.get(href, { timeout: DOWNLOAD_TIMEOUT_MS });
    if (!res.ok()) throw new PageChanged('download', `${href} answered ${res.status()} ${res.statusText()}`);
    await writeFile(zipPath, await res.body());
    const existing = await readdir(opts.outDir);
    let to: string;
    if (/\.zip$/i.test(fileName)) {
        const unzipDir = path.join(opts.outDir, `.opcd-unzip-${Date.now()}`);
        await unzip(zipPath, unzipDir);
        const blends = (await readdir(unzipDir)).filter((f) => /\.blend$/i.test(f));
        if (!blends.length) throw new PageChanged('download', `${fileName} holds no .blend (${(await readdir(unzipDir)).join(', ') || 'empty'})`);
        const inner = blends[0]!;
        to = path.join(opts.outDir, nextBlendName(existing, opts.prefix, inner));
        await rename(path.join(unzipDir, inner), to);
        // OPCD's build log rides along as <blend>.opcd-log.txt (what it cut, warnings).
        const logs = (await readdir(unzipDir)).filter((f) => /log.*\.txt$/i.test(f));
        if (logs[0]) await rename(path.join(unzipDir, logs[0]), to.replace(/\.blend$/i, '.opcd-log.txt'));
        await rm(unzipDir, { recursive: true, force: true });
        await rm(zipPath, { force: true });
        deps.log(`${fileName} -> ${inner} -> ${to}`);
    } else if (/\.blend$/i.test(fileName)) {
        to = path.join(opts.outDir, nextBlendName(existing, opts.prefix, fileName));
        await rename(zipPath, to);
    } else {
        // OPCD refused the SVG and the Download is its report: keep it beside the SVG, never as a .blend.
        const report = path.join(opts.outDir, `${opts.prefix}.opcd-${fileName}`);
        await rename(zipPath, report);
        const text = (await readFile(report, 'utf8').catch(() => '')).trim();
        throw new Error(`OPCD did not build the course: its Download is a report, ${report}`
            + (text ? `

${text}` : ''));
    }
    const size = await stat(to);
    return {
        file: to,
        megabytes: Math.round(size.size / 1e6),
        seconds: Math.round((deps.now() - t0) / 1000),
    };
}

/**
 * Expand a zip with `tar`: Windows 10+ ships bsdtar, which reads zip files, and PowerShell 5's
 * Expand-Archive module does not load on every box (it did not here).
 */
export async function unzip(zipPath: string, toDir: string): Promise<void> {
    await mkdir(toDir, { recursive: true });
    // Windows: its own bsdtar (System32), not the GNU tar Git puts first on PATH, which cannot read zip.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe') : 'tar';
    const command = [tar, '-xf', zipPath, '-C', toDir];
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command[0]!, command.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command[0]} exited with ${code}`))));
    });
}

/**
 * The description the submit writes, so a job in the table can be traced back to
 * a run: the export snapshot when the SVG is one (`export 2026-10-17_15-37-30`),
 * else the UTC minute of the submit.
 */
export const jobDescription = (courseName: string, now = new Date(), snapshot: string | null = null) =>
    snapshot ? `golf-map ${courseName} export ${snapshot}` : `golf-map ${courseName} ${now.toISOString().slice(0, 16).replace('T', ' ')}`;

// ─────────────────── which export a job built, and how it went ───────────────────

/** OPCD's clock: the Created column is US Eastern (local Swedish time minus 6 h in October 2026). */
export const OPCD_TIME_ZONE = 'America/New_York';
/** No Download this long after Created, still Processing: failed (Marcus' rule; a good build takes 5-6 min). */
export const BUILD_FAILED_AFTER_MS = BUILD_TIMEOUT_MS;
/** An export snapshot folder name: local time `2026-10-17_15-37-30`. */
export const SNAPSHOT_STAMP = /\b(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\b/;

export type BuildOutcome = 'ok' | 'failed' | 'pending';

/** What `--status` writes into a snapshot's export.json (`FeatureHistoryService.recordBuild`). */
export interface BuildRecord {
    opcdCreated: string;
    job: string;
    status: string;
    outcome: BuildOutcome;
    checkedAt: string;
}

/** The little of an export snapshot the linking needs (`FeatureHistoryService.listSnapshots` gives more). */
export interface SnapshotRef {
    name: string;
    /** ISO (UTC). */
    exportedAt: string;
    svg: string | null;
}

/** A wall-clock time in `timeZone` -> the instant. Two passes, so a time next to a DST switch lands right. */
export function zonedToUtc(local: string, timeZone: string): Date {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
    if (!m) throw new Error(`not a time: '${local}'`);
    const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
    const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const offset = (t: number) => {
        const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
        return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
    };
    let t = wall - offset(wall);
    t = wall - offset(t);
    return new Date(t);
}

/** OPCD's Created column -> the instant. */
export const opcdCreatedToUtc = (created: string) => zonedToUtc(created, OPCD_TIME_ZONE);

/** ok = a Download of the built course; failed = a Download of a report, Draft, or Processing 8 min after Created; else pending (queued, processing). */
export function buildOutcome(job: SvgJob, now: Date): BuildOutcome {
    if (isDone(job)) return isReport(job.file) ? 'failed' : 'ok';
    if (isDraft(job)) return 'failed';
    const age = now.getTime() - opcdCreatedToUtc(job.created).getTime();
    if (/^processing$/i.test(job.status.trim()) && age > BUILD_FAILED_AFTER_MS) return 'failed';
    return 'pending';
}

/** The export snapshot a job's description names, or null. */
export const snapshotStampOf = (job: SvgJob): string | null => SNAPSHOT_STAMP.exec(splitJobName(job.name).description ?? '')?.[1] ?? null;

/**
 * Which export snapshot each job built: the one its description names, else —
 * for jobs from before the stamp, with the plain file name — the newest snapshot
 * of that SVG exported before the job was created (Created has whole minutes, so
 * a job submitted in the export's own minute still counts). A snapshot built more
 * than once takes its newest job; a stamped job beats a matched-by-time one.
 */
export function linkJobsToSnapshots(jobs: SvgJob[], snapshots: SnapshotRef[], now: Date): Map<string, BuildRecord> {
    const out = new Map<string, BuildRecord>();
    const byName = new Map(snapshots.map((s) => [s.name, s]));
    const record = (job: SvgJob): BuildRecord => ({
        opcdCreated: job.created, job: job.name, status: job.status, outcome: buildOutcome(job, now), checkedAt: now.toISOString(),
    });
    const newestFirst = [...jobs].sort((a, b) => opcdCreatedToUtc(b.created).getTime() - opcdCreatedToUtc(a.created).getTime());
    for (const job of newestFirst) {
        const stamp = snapshotStampOf(job);
        if (stamp && byName.has(stamp) && !out.has(stamp)) out.set(stamp, record(job));
    }
    const oldestFirst = [...snapshots].sort((a, b) => a.exportedAt.localeCompare(b.exportedAt));
    for (const job of newestFirst) {
        // Only the course's own file with no description (or an unstamped golf-map one) is matched by time.
        const name = splitJobName(job.name);
        if (snapshotStampOf(job) || (name.description && !name.description.startsWith('golf-map '))) continue;
        const created = opcdCreatedToUtc(job.created).getTime() + 60_000;
        const snap = oldestFirst.filter((s) => s.svg === name.svg && Date.parse(s.exportedAt) <= created).pop();
        if (snap && !out.has(snap.name)) out.set(snap.name, record(job));
    }
    return out;
}

/** The outcome column the CLI prints for a snapshot. */
export const outcomeText = (build: BuildRecord | null | undefined) =>
    (build ? `${build.outcome.padEnd(7)} (OPCD ${build.opcdCreated}, ${build.status})` : '-');

/**
 * The export snapshot an SVG is, by content: the newest `<dir>/export-history/<stamp>/`
 * holding a file of the same name and bytes, or null (a bisect variant, an edited file).
 */
export async function snapshotOfSvg(svgPath: string, exportDir: string): Promise<string | null> {
    const root = path.join(exportDir, 'export-history');
    let names: string[];
    let bytes: Buffer;
    try {
        names = (await readdir(root)).filter((n) => SNAPSHOT_STAMP.test(n)).sort().reverse();
        bytes = await readFile(svgPath);
    } catch {
        return null;
    }
    for (const name of names) {
        const kept = path.join(root, name, path.basename(svgPath));
        const size = await stat(kept).then((s) => s.size, () => -1);
        if (size !== bytes.length) continue;
        if ((await readFile(kept)).equals(bytes)) return name;
    }
    return null;
}

/** The env var the Node child writes the last job table it read to, for the Bun parent's `--status`. */
export const JOBS_OUT_ENV = 'OPCD_JOBS_OUT';

// ──────────────────────────────── setup mode ────────────────────────────────

/** Lines read from the terminal while the user works: Enter = snapshot, `q` = finish. */
export async function* terminalLines(): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';
    // `process.stdin`, not `Bun.stdin`: this runs under Node too (see `nodeRuntime`).
    for await (const chunk of process.stdin) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
            yield buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf('\n');
        }
    }
    if (buffer.trim()) yield buffer.trim();
}

export const SETUP_PROMPT = [
    '',
    'Recording. Do the build in the browser window as you always do.',
    '  press Enter here in the terminal to snapshot the page (DOM + screenshot)',
    '  type q + Enter to finish',
    '',
    'Please press Enter at least:',
    '  1. on the Course Workflow list',
    '  2. on the dashboard\'s SVG Jobs tab, with the job table in view',
    '  3. right after you have submitted the build (the new job row)',
    '  4. when that row shows its Download button',
].join('\n');

/**
 * The recording session: a headed browser on the kept profile, a Playwright
 * trace, and a snapshot whenever the user presses Enter. Everything lands in
 * `data/opcd-recording/<timestamp>/`. This is the debugging aid for when the
 * words the steps look for stop matching the page.
 */
export async function recordSession(
    opts: { profileDir: string; recordingRoot: string; url: string; course: string | null; svg?: string | null; outDir?: string | null },
    deps: BuildDeps,
    lines: AsyncIterable<string> = terminalLines(),
): Promise<{ dir: string; index: RecordingIndex }> {
    const rec = await Recording.open(opts.recordingRoot, opts.url, opts.course);
    deps.log(`recording into ${rec.dir}`);
    if (opts.svg) await rec.log('note', `the SVG to upload: ${opts.svg}${existsSync(opts.svg) ? '' : ' (NOT THERE — export it first)'}`);
    if (opts.outDir) await rec.log('note', `the .blend belongs in: ${opts.outDir}`);
    let context: BrowserContext;
    try {
        context = await launchBrowser({ profileDir: opts.profileDir, headless: false, downloadsTo: rec.dir });
    } catch (e) {
        // The folder still gets its index: what was asked for, and why nothing came of it.
        await rec.log('note', `the browser did not launch: ${(e as Error).message}`);
        await rec.finish('the browser did not launch');
        throw e;
    }
    const page = context.pages()[0] ?? await context.newPage();
    watchPage(page, rec, new URL(opts.url).origin, rec.dir);
    context.on('page', (p) => watchPage(p, rec, new URL(opts.url).origin, rec.dir));
    await context.tracing.start({ screenshots: true, snapshots: true, title: `OPCD build ${opts.course ?? ''}`.trim() });
    try {
        await page.goto(opts.url, { waitUntil: 'domcontentloaded' }).catch(async (e) => {
            await rec.log('note', `the first navigation failed: ${(e as Error).message.split('\n')[0]}`);
        });
        deps.log(SETUP_PROMPT);
        for await (const line of lines) {
            if (/^q(uit)?$/i.test(line)) break;
            const live = context.pages().filter((p) => !p.isClosed());
            const front = live[live.length - 1] ?? page;
            const step = await rec.snapshot(front, line || 'snapshot');
            deps.log(`snapshot ${step.files?.join(', ')} of ${front.url()}`);
        }
    } finally {
        const trace = path.join(rec.dir, 'trace.zip');
        await context.tracing.stop({ path: trace }).catch(() => undefined);
        rec.addFile('trace.zip');
        await context.close().catch(() => undefined);
    }
    const index = await rec.finish();
    return { dir: rec.dir, index };
}

// ──────────── the runtime: Bun resolves, Node drives the browser ────────────

/** The resolved course handed to the Node child as JSON, so it needs no database. */
export const RESOLVED_ENV = 'OPCD_RESOLVED';
/** Set on the child, so it never hands the run on again. */
export const NO_RELAUNCH_ENV = 'OPCD_NO_RELAUNCH';

/** Everything a run needs about the course; the browser half takes only this. */
export interface ResolvedCourse {
    id: string;
    name: string;
    exportDir: string;
    svg: string;
    opcdName: string | null;
}

/** A runtime that can drive Playwright: `node`, or an Electron app standing in for it. */
export interface NodeRuntime {
    /** For the log line. */
    name: string;
    /** argv[0] and any arguments before the script. */
    command: string[];
    env: Record<string, string>;
}

/**
 * Where a Node comes from on a box without one on PATH: any Electron app
 * already installed is a full Node when `ELECTRON_RUN_AS_NODE=1` is set — VS
 * Code ships Node 24 this way. The warning about this repo's package.json
 * having no `"type"` is turned off; the file is read as ESM either way.
 */
export function nodeRuntime(onPath: string | null, electron: { path: string; name: string } | null): NodeRuntime | null {
    const quiet = '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON';
    if (onPath) return { name: `node (${onPath})`, command: [onPath, quiet], env: {} };
    if (electron) {
        return {
            name: `${electron.name} as Node (ELECTRON_RUN_AS_NODE)`,
            command: [electron.path, quiet],
            env: { ELECTRON_RUN_AS_NODE: '1' },
        };
    }
    return null;
}

/** The Electron apps worth trying, in order, from the environment's own folders. */
export function electronCandidates(env: Record<string, string | undefined>): { path: string; name: string }[] {
    const local = env.LOCALAPPDATA ?? '';
    const programs = env.ProgramFiles ?? '';
    return [
        { path: path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), name: 'VS Code' },
        { path: path.join(programs, 'Microsoft VS Code', 'Code.exe'), name: 'VS Code' },
        { path: path.join(local, 'Programs', 'cursor', 'Cursor.exe'), name: 'Cursor' },
        { path: path.join(programs, 'Unity Hub', 'Unity Hub.exe'), name: 'Unity Hub' },
    ].filter((c) => c.path.startsWith(path.sep) || /^[a-z]:/i.test(c.path));
}

/** `node` on PATH, or null. (`Bun.which` is not used: this also runs under Node.) */
export function findOnPath(binary: string): string | null {
    const names = process.platform === 'win32' ? [`${binary}.exe`, `${binary}.cmd`] : [binary];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        for (const name of names) {
            const full = path.join(dir, name);
            if (existsSync(full)) return full;
        }
    }
    return null;
}

/**
 * `bun run <script>` puts a `node.exe` of its own first on PATH (`%TEMP%/bun-node-<hash>/`),
 * which is Bun again, not a Node: it must not count, or the relaunch lands back in Bun.
 */
export function isBunNodeShim(nodePath: string): boolean {
    // A plain substring test: the folder is always named bun-node-<hash>, whatever the separators.
    return nodePath.toLowerCase().includes("bun-node-");
}

/** The first runtime on this machine that can drive a browser. */
export function findNodeRuntime(): NodeRuntime | null {
    const onPath = findOnPath('node');
    const real = onPath && !isBunNodeShim(onPath) ? onPath : null;
    return nodeRuntime(real, electronCandidates(process.env).find((c) => existsSync(c.path)) ?? null);
}

/** Run this same script under `runtime`, with the course already resolved, and return its exit code. */
export async function relaunchUnderNode(
    runtime: NodeRuntime, argv: string[], resolved: ResolvedCourse | null, extraEnv: Record<string, string> = {},
): Promise<number> {
    const script = fileURLToPath(import.meta.url);
    const [command, ...head] = runtime.command;
    const child = spawn(command!, [...head, script, ...argv], {
        // Inherited, so `--setup` can read the terminal and the run prints as it goes.
        stdio: 'inherit',
        env: {
            ...process.env, ...runtime.env, ...extraEnv, [NO_RELAUNCH_ENV]: '1',
            ...(resolved ? { [RESOLVED_ENV]: JSON.stringify(resolved) } : {}),
        },
    });
    return new Promise<number>((resolve) => {
        child.on('error', (e) => { console.error(`error: ${runtime.name} would not start: ${e.message}`); resolve(1); });
        child.on('exit', (code) => resolve(code ?? 1));
    });
}

// ─────────────────────────────────── main ───────────────────────────────────

/** The course, its export folder, its SVG and its OPCD name — resolved the way gspro-export.ts does it. */
async function resolveCourse(ident: string): Promise<ResolvedCourse> {
    // Bun-only from here on: `server/env-paths` reads the repo's own env, and
    // the services reach the database through `bun:sqlite`.
    await import('../server/env-paths');
    const { createDb } = await import('@basics/core/server/db');
    const { CoursesService } = await import('../server/services/courses.service');
    const { AssetsService } = await import('../server/services/assets.service');
    const { TerrainEditsService } = await import('../server/services/terrain-edits.service');
    const { GsproExportService, courseSlug, exportFileName, venvPython } =
        await import('../server/services/gspro-export.service');
    type Database = import('../server/db/schema').Database;

    const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
    const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
    const pipelineDir = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');
    if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
    const db = createDb<Database>(dbPath);
    try {
        const courses = new CoursesService(db);
        const exporter = new GsproExportService({
            db, courses, assets: new AssetsService(db, dataDir), dataDir,
            terrainEdits: new TerrainEditsService(db), pipelineDir,
            python: process.env.MAP_PIPELINE_PYTHON ?? venvPython(pipelineDir),
        });
        const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
        const q = ident.toLowerCase();
        const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q || courseSlug(r.name) === q);
        const picked = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
        if (picked.length !== 1) {
            const names = (picked.length ? picked : rows).map((r) => `  ${r.name} (${r.id})`).join('\n');
            throw new Error(`${picked.length ? 'several' : 'no'} courses match '${ident}':\n${names}`);
        }
        const row = picked[0]!;
        const settings = await exporter.settings(row.id);
        return {
            id: row.id, name: row.name, exportDir: settings.dir,
            svg: path.join(settings.dir, exportFileName(row.name)),
            opcdName: settings.opcdCourseName,
        };
    } finally {
        await db.destroy();
    }
}

/**
 * The course this run is about: the JSON the Bun parent handed over, else the
 * three flags that say everything themselves, else the database (which is
 * Bun's). Null is `--setup` with no course named — a recording needs none.
 */
async function resolveFor(parsed: Args): Promise<ResolvedCourse | null> {
    const handedOver = process.env[RESOLVED_ENV];
    if (handedOver) return JSON.parse(handedOver) as ResolvedCourse;
    if (parsed.mode === 'build' && parsed.svg && parsed.out && parsed.opcdName) {
        return {
            id: parsed.course, name: path.basename(parsed.svg).replace(/\.svg$/i, ''),
            exportDir: parsed.out, svg: parsed.svg, opcdName: parsed.opcdName,
        };
    }
    if (!parsed.course) return null;
    if (!process.versions.bun) {
        throw new Error('the course can only be looked up by Bun (the database is bun:sqlite). Start the run with '
            + '`bun run opcd:build -- …` — it hands the browser half over itself — or name everything: '
            + '--svg, --out and --opcd-name.');
    }
    return resolveCourse(parsed.course);
}

async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if ('error' in parsed) {
        console.error(`error: ${parsed.error}\n\n${usageText()}`);
        process.exit(2);
    }
    const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
    const profileDir = path.join(dataDir, PROFILE_DIR);
    const recordingRoot = path.join(dataDir, RECORDING_DIR);
    const deps = realBuildDeps();
    const course = await resolveFor(parsed);

    // Bun cannot drive a browser here (see `browserDiagnosis()`), but it is
    // what reads the database — so it resolves the course, then hands the whole
    // run to a Node with the answer in its environment.
    if (process.versions.bun && !process.env[NO_RELAUNCH_ENV]) {
        const runtime = findNodeRuntime();
        if (!runtime) {
            console.error(`error: ${browserDiagnosis()}`);
            process.exit(1);
        }
        deps.log(`Playwright cannot drive Chromium under Bun here, so the run goes to ${runtime.name}`);
        // The child leaves the last job table it read here; the outcomes go into export.json from this side.
        const records = parsed.mode === 'build' && !parsed.dryRun && course !== null;
        const jobsOut = path.join(os.tmpdir(), `opcd-jobs-${process.pid}-${Date.now()}.json`);
        const code = await relaunchUnderNode(runtime, process.argv.slice(2), course, records ? { [JOBS_OUT_ENV]: jobsOut } : {});
        if (records && existsSync(jobsOut)) {
            try {
                await recordOutcomes(course.exportDir, JSON.parse(await readFile(jobsOut, 'utf8')) as SvgJob[], parsed.status);
            } finally {
                await rm(jobsOut, { force: true });
            }
        }
        process.exit(code);
    }

    if (parsed.mode === 'setup') {
        if (course) {
            console.log(`${course.name} (${course.id})`);
            console.log(`export folder:     ${course.exportDir}`);
            console.log(`the SVG to upload: ${course.svg}`);
            console.log(`OPCD course name:  ${course.opcdName ?? '(not set — read it off the Course Workflow list)'}`);
        }
        const { dir, index } = await recordSession({
            profileDir, recordingRoot, url: parsed.url ?? OPCD_START_URL,
            course: course?.name ?? null, svg: course?.svg, outDir: course?.exportDir,
        }, deps);
        const counts = new Map<string, number>();
        for (const s of index.steps) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
        console.log(`\n${index.steps.length} step(s): ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}`);
        console.log(`${index.files.length} file(s): ${index.files.join(', ')}`);
        console.log(`\nrecording: ${dir}`);
        return;
    }

    if (!course) throw new Error('no course was resolved (a bug in this script)');
    if (parsed.status && !process.env[JOBS_OUT_ENV]) console.log('(run under Bun to record the outcomes in export.json; this prints the table only)');
    const svg = parsed.svg ?? course.svg;
    const outDir = parsed.out ?? course.exportDir;
    const opcdName = parsed.opcdName ?? course.opcdName;
    if (!opcdName) {
        throw new Error(`${course.name} has no OPCD course name: it is called something else in the builder `
            + '(Vreta is "Vreta Kloster golfklubb" there). Pass --opcd-name "<Course Name>" — the names the '
            + 'Course Workflow list offers are printed when none matches — and keep it on the course '
            + '(GsproExportService.setOpcdCourseName).');
    }
    if (!parsed.dryRun && !existsSync(svg)) {
        throw new Error(`no SVG at ${svg} — export it first: bun run gspro:export -- ${course.id} svg`);
    }
    console.log(`${course.name} (${course.id}) -> OPCD '${opcdName}'`);
    if (!parsed.dryRun) console.log(`svg:   ${svg}`);
    console.log(`out:   ${outDir}`);
    const { context, page } = await openSite({
        profileDir, headless: parsed.headless, downloadsTo: outDir, url: parsed.url ?? OPCD_START_URL,
    }, deps);
    const t0 = Date.now();
    // The last job table read, for the Bun parent's records (`--status`, and after a submit or a build).
    let lastJobs: SvgJob[] | null = null;
    const look = svgJobsLook(page, opcdName, deps);
    const lookAndKeep = async () => (lastJobs = await look());
    try {
        await openSvgJobsTab(page, opcdName, deps);
        if (parsed.dryRun || parsed.status) {
            const jobs = lastJobs = await readJobs(page);
            console.log(`\nSVG Jobs for '${opcdName}' (newest first):`);
            for (const line of jobTableText(jobs)) console.log(line);
            if (parsed.dryRun) console.log('\ndry run: nothing was submitted');
            return;
        }
        let before: SvgJob[];
        let firstLookMs: number | undefined;
        let ours: OurJob | undefined;
        if (parsed.attach) {
            // The newest row is the job to follow - with --svg, the newest row of that file, so a
            // bisect variant submitted later does not stand in for it. Every other row is "before".
            const jobs = await readJobs(page);
            if (!jobs.length) throw new PageChanged('attach', 'the job table is empty: nothing to attach to');
            const file = parsed.svg ? path.basename(parsed.svg) : null;
            // An export snapshot's SVG (export-history/<stamp>/…) picks the job whose description
            // names that snapshot, so a later export of the same file does not stand in for it.
            const snapshot = parsed.svg ? await snapshotOfSvg(svg, course.exportDir) : null;
            const ofFile = (j: SvgJob) => splitJobName(j.name).svg === file;
            const ofSnapshot = (j: SvgJob) => ofFile(j) && (splitJobName(j.name).description ?? '').includes(`export ${snapshot}`);
            let at = !file ? 0 : snapshot ? jobs.findIndex(ofSnapshot) : -1;
            if (file && at < 0) at = jobs.findIndex(ofFile);
            if (at < 0) throw new PageChanged('attach', `no job of ${file} in the table`);
            const job = jobs[at]!;
            console.log(`attached to ${job.created}  ${job.status}  ${job.name}`);
            before = jobs.filter((_, i) => i !== at);
            if (file) ours = { svg: file, description: splitJobName(job.name).description };
            firstLookMs = 0;
        } else {
            // The export snapshot this SVG is (byte for byte), so the job names it and --status can find it.
            const snapshot = await snapshotOfSvg(svg, course.exportDir);
            console.log(`snapshot: ${snapshot ?? '(none: not a kept export)'}`);
            const description = jobDescription(course.name, new Date(), snapshot);
            await uploadSvg(page, svg, deps);
            const submitted = await startBuild(page, description, deps);
            before = submitted.before;
            ours = { svg: path.basename(svg), description: submitted.described ? description : null };
            if (parsed.submitOnly) {
                const mine = pickNewJob(before, await lookAndKeep(), ours);
                console.log(mine
                    ? `submitted: ${mine.created}  ${mine.status}  ${mine.name}`
                    : `submitted '${ours.svg}', but its row is not in the table yet`);
                console.log('not waiting (--submit-only): follow it with --status');
                return;
            }
        }
        const job = await waitForBuild(lookAndKeep, before, deps, { timeoutMs: parsed.timeoutMs, firstLookMs, ours });
        const got = await downloadBlend(page, job, { outDir, prefix: blendPrefix(course.name) }, deps);
        const seconds = Math.round((Date.now() - t0) / 1000);
        console.log(`\ndone in ${Math.floor(seconds / 60)} min ${seconds % 60} s: ${got.file} `
            + `(${got.megabytes} MB in ${got.seconds} s)`);
        console.log('next, by hand: open it in Blender (the shaping replay), then '
            + `bun run gspro:update -- ${course.id} meshes`);
    } catch (e) {
        // What the page looked like when it went wrong, next to the recordings.
        const dir = path.join(ROOT, 'data', RECORDING_DIR, `fail-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await mkdir(dir, { recursive: true }).catch(() => undefined);
        await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true }).catch(() => undefined);
        await writeFile(path.join(dir, 'page.html'), await page.content().catch(() => ''), 'utf8').catch(() => undefined);
        console.error(`the page at the failure: ${dir} (page.png, page.html)`);
        throw e;
    } finally {
        const jobsOut = process.env[JOBS_OUT_ENV];
        if (jobsOut && lastJobs) await writeFile(jobsOut, JSON.stringify(lastJobs)).catch(() => undefined);
        await context.close().catch(() => undefined);
    }
}

/**
 * The Bun parent's half of `--status` (and of a submit or a build): link the job
 * table the Node child read to the course's export snapshots and write each
 * outcome into the snapshot's export.json. `all` prints every snapshot (--status),
 * else only those whose job is in the table.
 */
async function recordOutcomes(exportDir: string, jobs: SvgJob[], all: boolean): Promise<void> {
    const { FeatureHistoryService } = await import('../server/services/feature-history.service');
    const snaps = await FeatureHistoryService.listSnapshots(exportDir);
    const linked = linkJobsToSnapshots(jobs, snaps, new Date());
    for (const [name, build] of linked) await FeatureHistoryService.recordBuild(path.join(exportDir, 'export-history', name), build);
    if (!snaps.length) {
        console.log(`\nno export snapshots in ${exportDir} to record builds for`);
        return;
    }
    console.log(`\nexport snapshots (${linked.size} build(s) recorded in export.json):`);
    for (const s of snaps) {
        const build = linked.get(s.name) ?? s.build;
        if (all || linked.has(s.name)) console.log(`  ${s.name}  ${outcomeText(build)}`);
    }
    const good = FeatureHistoryService.lastGood(snaps.map((s) => ({ ...s, build: linked.get(s.name) ?? s.build })));
    console.log(`last good: ${good?.name ?? '(none recorded)'}`);
}

// `import.meta.main` is Bun's; under Node the script's own path in argv says it.
const runDirectly = (import.meta as { main?: boolean }).main
    ?? (process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false);
if (runDirectly) {
    try {
        await main();
    } catch (e) {
        console.error(`error: ${(e as Error).message}`);
        process.exit(1);
    }
}
