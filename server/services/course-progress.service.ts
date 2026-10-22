// How far a course has come on its way to GSPro: one checklist in the order of
// the course → GSPro chain (AGENTS.md), each step read from what it leaves
// behind. Nothing is run and nothing is written: the steps that are GSPro
// board rows come from the board (`GsproSyncService.status`), Check and Ready
// from their last reports (`CourseCheckService.status`, `MakeReadyService.status`),
// the rest from files.
//
// One implementation behind `bun run course:progress` (scripts/course-progress.ts)
// and the Claude status pane that reads its `--json`.
//
//   setup        the course's site, export folder, GSPro course folder, OPCD name, holes
//   map          the map build: the site's `sources/<site>/dem.tif`
//   photo-clean  the active ortho vintage has its `.cleaned.tif`
//   <board row>  terrain, photo, shapes, meshes, vegetation, trees, buildings,
//                props, creeks, roads, waterfalls, course-file (never = todo)
//   opcd         after shapes: the newest SVG snapshot's OPCD build (`opcd:build --status`)
//   check        the last course check (Unity's `course-check.json`), stale once the meshes changed
//   ready        the last make-ready run (`make-ready-summary.json`), stale once the meshes changed
//   build        the GSPro course build: the newest `.gspcrse` in the GSPro course folder,
//                stale once a row that changes the Unity scene was updated after it
//   perf         the GreenKeeper flyover: the `<scene>_benchmark.jpg` GreenKeeper writes beside
//                the course, with the scores of the bench run (`greenkeeper.ts bench`) that ended
//                when the card was written; the target is a score of 90 for the course and its
//                worst hole
import * as path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import type { CoursesService } from './courses.service';
import type { GsproExportService } from './gspro-export.service';
import type { GsproSyncService, GsproTargetStatus } from './gspro-sync.service';
import type { CourseCheckService } from './course-check.service';
import type { MakeReadyService } from './make-ready.service';

/**
 * done: nothing left; stale: done, then something changed; todo: not done yet;
 * failed: ran and found errors; blocked: cannot run now (`detail` says why).
 */
export type ProgressState = 'done' | 'stale' | 'todo' | 'failed' | 'blocked';

export interface ProgressStep {
    id: string;
    label: string;
    state: ProgressState;
    /** One short line: what changed, what is missing, a count, a score. */
    detail: string | null;
    /** What a person must do next by hand, when the board names it. */
    manual: string | null;
}

export interface CourseProgress {
    id: string;
    name: string;
    steps: ProgressStep[];
}

export interface CourseProgressDeps {
    db: Kysely<Database>;
    courses: Pick<CoursesService, 'get'>;
    exports: Pick<GsproExportService, 'settings' | 'orthoSources'>;
    sync: Pick<GsproSyncService, 'status'>;
    check: Pick<CourseCheckService, 'status'>;
    ready: Pick<MakeReadyService, 'status'>;
    dataDir: string;
    /** Where `greenkeeper.ts bench` writes its runs; the repo's `tree-export/perf/greenkeeper` by default. */
    benchDir?: string;
}

/** The GreenKeeper score a course and its worst hole should reach (Vreta's target, 2026-10-14). */
export const PERF_TARGET = 90;
/** The board rows whose update changes the Unity scene, so the GSPro build after it is stale. */
const SCENE_ROWS = new Set(['terrain', 'photo', 'meshes', 'vegetation', 'trees', 'buildings', 'props', 'creeks', 'roads', 'waterfalls']);
/** How far a bench run's end may lie from the benchmark card's mtime and still be its run (ms). */
const BENCH_MATCH_MS = 10 * 60_000;

const DEFAULT_BENCH_DIR = path.resolve(import.meta.dir, '../../tree-export/perf/greenkeeper');

const step = (id: string, label: string, state: ProgressState, detail: string | null = null, manual: string | null = null): ProgressStep =>
    ({ id, label, state, detail, manual });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Epoch ms -> `2026-10-14 09:12` in local time. */
function when(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function mtime(file: string): Promise<number | null> {
    return stat(file).then(s => s.mtimeMs, () => null);
}

/** The newest file in `dir` whose name passes `test`, with its mtime; null with none (or no folder). */
async function newest(dir: string, test: (name: string) => boolean): Promise<{ file: string; ms: number } | null> {
    const names = await readdir(dir).catch(() => [] as string[]);
    let best: { file: string; ms: number } | null = null;
    for (const name of names.filter(test)) {
        const ms = await mtime(path.join(dir, name));
        if (ms !== null && (!best || ms > best.ms)) best = { file: path.join(dir, name), ms };
    }
    return best;
}

function boardStep(row: GsproTargetStatus): ProgressStep {
    if (row.blocked) return step(row.id, row.label, 'blocked', row.blocked);
    if (row.lastRun === null) return step(row.id, row.label, 'todo', row.note, row.manual);
    if (row.stale) {
        const changed = `${plural(row.changedSince.count, 'change')} (${row.changedSince.kinds.join(', ')})`;
        return step(row.id, row.label, 'stale', row.note ?? changed, row.manual);
    }
    return step(row.id, row.label, 'done', row.note);
}

function opcdStep(shapes: GsproTargetStatus | undefined, course: string): ProgressStep {
    const label = 'OPCD build';
    const last = shapes?.builds[0];
    if (!last) return step('opcd', label, 'todo', 'no SVG export yet');
    if (last.outcome === 'ok') return step('opcd', label, 'done', last.snapshot);
    if (last.outcome === 'pending') return step('opcd', label, 'stale', `${last.snapshot} is building`);
    if (last.outcome === 'failed') {
        const good = shapes!.builds.find(b => b.lastGood);
        return step('opcd', label, 'failed', `${last.snapshot} failed${good ? `; last good ${good.snapshot}` : ''}`);
    }
    return step('opcd', label, 'stale', `${last.snapshot} not built (or opcd:build --status not run)`,
        `Build the SVG in OPCD: bun run opcd:build -- ${course}`);
}

export class CourseProgressService {
    private readonly benchDir: string;

    constructor(private readonly deps: CourseProgressDeps) {
        this.benchDir = deps.benchDir ?? DEFAULT_BENCH_DIR;
    }

    /** The courses on their way to GSPro: those with an export folder set, by name. */
    async courses(): Promise<Array<{ id: string; name: string }>> {
        return this.deps.db.selectFrom('courses').select(['id', 'name'])
            .where('gspro_export_dir', 'is not', null).orderBy('name').execute();
    }

    async progress(courseId: string): Promise<CourseProgress> {
        const course = await this.deps.courses.get(courseId);
        const settings = await this.deps.exports.settings(courseId);
        const [board, check, ready] = await Promise.all([
            this.deps.sync.status(courseId),
            this.deps.check.status(courseId),
            this.deps.ready.status(courseId),
        ]);
        const steps: ProgressStep[] = [];

        const holes = await this.deps.db.selectFrom('holes').select(({ fn }) => fn.countAll<number>().as('n'))
            .where('course_id', '=', courseId).executeTakeFirst();
        const missing = [
            !course.siteId && 'map area',
            settings.isDefault && 'export folder',
            !settings.courseDir && 'GSPro course folder',
            !settings.opcdCourseName && 'OPCD name',
        ].filter((m): m is string => !!m);
        steps.push(missing.length
            ? step('setup', 'Course set up', 'todo', `missing: ${missing.join(', ')}`)
            : step('setup', 'Course set up', 'done', plural(Number(holes?.n ?? 0), 'hole')));

        const dem = course.siteId ? await mtime(path.join(this.deps.dataDir, 'sources', course.siteId, 'dem.tif')) : null;
        steps.push(dem !== null ? step('map', 'Map built', 'done') : step('map', 'Map built', 'todo', 'no DEM yet'));

        const sources = await this.deps.exports.orthoSources(courseId);
        const active = sources.filter(s => s.active);
        steps.push(active.some(s => s.cleaned)
            ? step('photo-clean', 'Photo cleaned', 'done', active[0]!.collection)
            : step('photo-clean', 'Photo cleaned', 'todo', active.length ? `${active[0]!.collection} not cleaned` : 'no photo yet',
                'Clean the photo by hole: bun run photo -- clean'));

        for (const row of board.targets) {
            steps.push(boardStep(row));
            if (row.id === 'shapes') steps.push(opcdStep(row, course.name));
        }

        const meshesChangedAt = check.meshesChangedAt ? Date.parse(check.meshesChangedAt) : null;
        if (!check.unity) steps.push(step('check', 'Course check', 'todo', 'never run', `bun run course:check -- ${course.name}`));
        else if (!check.unity.ok) steps.push(step('check', 'Course check', 'failed', `${plural(check.unity.errors, 'error')}, ${plural(check.unity.warnings, 'warning')}`));
        else if (check.meshesChangedSince) steps.push(step('check', 'Course check', 'stale', 'the meshes changed since'));
        else steps.push(step('check', 'Course check', 'done', check.unity.warnings ? plural(check.unity.warnings, 'warning') : null));

        const last = ready.last;
        if (!last) steps.push(step('ready', 'Ready for GSPro', 'todo', 'never run', `bun run course:ready -- ${course.name}`));
        else if (!last.ready) steps.push(step('ready', 'Ready for GSPro', 'failed', last.blockers[0] ?? `${plural(last.errors, 'error')}`));
        else if (meshesChangedAt !== null && meshesChangedAt > Date.parse(last.at)) steps.push(step('ready', 'Ready for GSPro', 'stale', 'the meshes changed since'));
        else steps.push(step('ready', 'Ready for GSPro', 'done', last.warnings ? plural(last.warnings, 'warning') : null));

        const built = settings.courseDir ? await newest(settings.courseDir, n => n.toLowerCase().endsWith('.gspcrse')) : null;
        const sceneUpdates = board.targets
            .filter(r => SCENE_ROWS.has(r.id) && r.lastRun !== null && built !== null && Date.parse(r.lastRun) > built.ms);
        if (!built) steps.push(step('build', 'Built in GSPro', 'todo', settings.courseDir ? 'no .gspcrse yet' : 'no GSPro course folder'));
        else if (sceneUpdates.length) steps.push(step('build', 'Built in GSPro', 'stale', `${when(built.ms)}; since: ${sceneUpdates.map(r => r.id).join(', ')}`));
        else steps.push(step('build', 'Built in GSPro', 'done', when(built.ms)));

        steps.push(await this.perfStep(settings.courseDir, built?.ms ?? null));
        return { id: course.id, name: course.name, steps };
    }

    private async perfStep(courseDir: string | null, builtMs: number | null): Promise<ProgressStep> {
        const label = 'GreenKeeper score';
        const card = courseDir ? await newest(courseDir, n => n.toLowerCase().endsWith('_benchmark.jpg')) : null;
        if (!card) return step('perf', label, 'todo', 'no flyover benchmark yet');
        const run = await this.benchRun(card.ms);
        const score = run ? `score ${run.scoreAvg} · worst hole ${run.worstHoleScore}` : `benchmarked ${when(card.ms)}`;
        if (builtMs !== null && card.ms < builtMs) return step('perf', label, 'stale', `${score}; built again since`);
        if (run && (run.scoreAvg < PERF_TARGET || run.worstHoleScore < PERF_TARGET)) return step('perf', label, 'failed', `${score} (target ${PERF_TARGET})`);
        return step('perf', label, 'done', score);
    }

    /** The bench run that ended when GreenKeeper wrote the card at `cardMs`, else null. */
    private async benchRun(cardMs: number): Promise<{ scoreAvg: number; worstHoleScore: number } | null> {
        const names = await readdir(this.benchDir).catch(() => [] as string[]);
        for (const name of names) {
            const run = await readFile(path.join(this.benchDir, name, 'greenkeeper.json'), 'utf8').then(JSON.parse, () => null);
            if (!run || typeof run.started !== 'string') continue;
            const end = Date.parse(run.started) + Number(run.seconds ?? 0) * 1000;
            if (Math.abs(end - cardMs) <= BENCH_MATCH_MS) return { scoreAvg: Number(run.scoreAvg), worstHoleScore: Number(run.worstHoleScore) };
        }
        return null;
    }
}
