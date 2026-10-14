import { test, expect } from 'bun:test';
import { GsproSyncService, agoLabel, changedLabel, aboutLabel, rowStatusLabel } from '../src/export/gspro-sync.service';
import type {
    GsproSyncApi, GsproSyncStatus, GsproSyncJob, GsproTargetStatus, JobPhase,
} from '../../shared/api/gspro-sync.gen';
import { GSPRO_TARGETS } from '../../shared/gspro-targets';

// The GSPro status board's client service against a fake API object (plain
// functions, no mocking library — TESTING.md): what the board reads, what an
// Update does, and what is left on screen when one is refused or fails.

const NOW = Date.parse('2026-10-14T12:00:00.000Z');

function targetRow(patch: Partial<GsproTargetStatus> & { id: GsproTargetStatus['id'] }): GsproTargetStatus {
    const label = GSPRO_TARGETS.find(t => t.id === patch.id)?.label ?? patch.id;
    return {
        label,
        lastRun: null,
        seconds: null,
        changedSince: { count: 0, kinds: [] },
        stale: true,
        manual: null,
        blocked: null,
        ...patch,
    };
}

/** A board where trees and shapes are stale, photo is blocked and terrain is fresh. */
function boardTargets(): GsproTargetStatus[] {
    return [
        targetRow({ id: 'terrain', lastRun: '2026-10-14T10:00:00.000Z', seconds: 42, stale: false }),
        targetRow({ id: 'photo', lastRun: null, stale: true, blocked: 'Build the map first' }),
        targetRow({
            id: 'shapes', lastRun: '2026-10-12T09:00:00.000Z', seconds: 12, stale: true,
            changedSince: { count: 14, kinds: ['bunker', 'path', 'tee'] },
            manual: 'Build the SVG in Blender (OPCD), then Update meshes',
        }),
        targetRow({ id: 'meshes', lastRun: '2026-10-14T11:30:00.000Z', stale: false }),
        targetRow({ id: 'vegetation', lastRun: '2026-10-13T11:00:00.000Z', stale: false }),
        targetRow({ id: 'trees', lastRun: '2026-10-10T08:00:00.000Z', stale: true, changedSince: { count: 2, kinds: ['tree_area'] } }),
        targetRow({ id: 'buildings', lastRun: '2026-10-01T08:00:00.000Z', stale: false, manual: 'Run GolfMap › Buildings › Plant from assignments in Unity' }),
        targetRow({ id: 'creeks', lastRun: null, stale: true }),
        targetRow({ id: 'course-file', lastRun: '2026-10-14T09:00:00.000Z', stale: false }),
    ];
}

const PHASES = (statuses: JobPhase['status'][]): JobPhase[] => [
    { id: 'files', label: 'Files', status: statuses[0], detail: 'inner + outer', seconds: statuses[0] === 'done' ? 4 : null },
    { id: 'unity', label: 'Unity', status: statuses[1], detail: null, seconds: null },
];

function job(patch: Partial<GsproSyncJob> = {}): GsproSyncJob {
    return {
        id: 'job-1',
        courseId: 'course-1',
        request: 'trees',
        targets: ['trees'],
        status: 'queued',
        phase: null,
        step: 'Waiting',
        phases: PHASES(['pending', 'pending']),
        queuedAt: '2026-10-14T12:00:00.000Z',
        startedAt: null,
        finishedAt: null,
        seconds: 0,
        results: [],
        error: null,
        ...patch,
    };
}

/**
 * The server as a plain object: `status` serves whatever board the test set,
 * `update` hands out the first of `jobs` and `job` walks through the rest, so
 * a test pins the exact queued → running → finished sequence the poll sees.
 */
function fakeApi(opts: {
    targets?: GsproTargetStatus[];
    jobs?: GsproSyncJob[];
    updateFails?: Error;
    matched?: string | null;
} = {}) {
    const calls = { status: 0, update: [] as string[], job: 0 };
    const sequence = opts.jobs ?? [];
    let at = 0;
    const api: GsproSyncApi = {
        async status() {
            calls.status++;
            return {
                unity: {
                    editors: opts.matched === undefined || opts.matched
                        ? [{
                            projectName: opts.matched ?? 'vreta_v4_2025_12_02', projectPath: 'D:\\gspro_courses\\vreta_v4_2025_12_02',
                            activeCourse: 'Vreta', exportFolder: 'D:\\gspro_courses\\vreta-opcd', matches: true, error: null,
                        }]
                        : [{
                            projectName: 'other_course', projectPath: 'D:\\x', activeCourse: 'Other',
                            exportFolder: 'D:\\other', matches: false, error: null,
                        }],
                    matched: opts.matched === undefined ? 'vreta_v4_2025_12_02' : opts.matched,
                    exportDir: 'D:\\gspro_courses\\vreta-opcd',
                },
                worker: {
                    url: 'http://127.0.0.1:8777', reachable: true, state: 'loaded', phase: null,
                    blend: 'vreta.conformed.blend', conformed: null, layersDir: null,
                    appliedOps: null, lastRun: null, error: null, spawnedPid: null, job: null, log: null,
                },
                targets: opts.targets ?? boardTargets(),
                job: at > 0 ? sequence[Math.min(at - 1, sequence.length - 1)] : null,
                queue: [],
            } satisfies GsproSyncStatus;
        },
        async update({ target }) {
            calls.update.push(target);
            if (opts.updateFails) throw opts.updateFails;
            at = 1;
            return sequence[0];
        },
        async job() {
            calls.job++;
            at = Math.min(at + 1, sequence.length);
            return sequence[at - 1];
        },
        async editors() {
            throw new Error('not used by the board');
        },
    };
    return { api, calls };
}

/** A service with a tiny poll and no background refresh timer in the way. */
const service = (api: GsproSyncApi) => new GsproSyncService(api, 1, 60_000);

test('refresh fills the board, counts what is stale and runnable, and names the Unity editor', async () => {
    const { api, calls } = fakeApi();
    const svc = service(api);
    await svc.refresh('course-1');

    expect(calls.status).toBe(1);
    expect(svc.status.peek()?.targets).toHaveLength(9);
    // photo is stale but blocked, so it is not in the count a "Update all stale" would take.
    expect(svc.staleCount.peek()).toBe(3);
    expect(svc.target('shapes')?.manual).toContain('Build the SVG in Blender');
    expect(svc.target('photo')?.blocked).toBe('Build the map first');
    expect(svc.unityLabel()).toBe('Unity: vreta_v4_2025_12_02 · course Vreta');
    expect(svc.unityTitle()).toContain('D:\\gspro_courses\\vreta-opcd');
    expect(svc.error.peek()).toBe('');
    expect(svc.running.peek()).toBe(false);
    svc.close();
});

test('no Unity editor with this course active says so', async () => {
    const { api } = fakeApi({ matched: null });
    const svc = service(api);
    await svc.refresh('course-1');
    expect(svc.unityLabel()).toBe('Unity: not open for this course');
    expect(svc.unityTitle()).toContain('other_course');
    svc.close();
});

test('an update polls queued → running → succeeded, then re-reads the board', async () => {
    const { api, calls } = fakeApi({
        jobs: [
            job({ status: 'queued', phases: [{ id: 'wait', label: 'Waiting for the Blender shaping run', status: 'running', detail: null, seconds: null }] }),
            job({ status: 'running', step: 'inner trees', startedAt: '2026-10-14T12:00:01.000Z', phases: PHASES(['running', 'pending']), seconds: 3 }),
            job({
                status: 'succeeded', step: 'done', startedAt: '2026-10-14T12:00:01.000Z',
                finishedAt: '2026-10-14T12:00:40.000Z', seconds: 39, phases: PHASES(['done', 'done']),
                results: [{ target: 'trees', label: 'Trees', seconds: 39, report: ['inner: 4 120 stems', 'Unity: planted'], error: null }],
            }),
        ],
    });
    const svc = service(api);
    await svc.openFor('course-1');
    const statusReads = calls.status;

    const seen: string[] = [];
    const stop = trackRunning(svc, seen);
    const ok = await svc.update('course-1', 'trees');
    stop();

    expect(ok).toBe(true);
    expect(calls.update).toEqual(['trees']);
    expect(calls.job).toBeGreaterThanOrEqual(2);
    expect(seen).toContain('running');  // the board was busy while it polled
    expect(svc.running.peek()).toBe(false);
    expect(svc.job.peek()?.status).toBe('succeeded');
    expect(svc.job.peek()?.results[0].report).toEqual(['inner: 4 120 stems', 'Unity: planted']);
    expect(svc.error.peek()).toBe('');
    expect(svc.queuedBehind()).toBe('');
    // The board is read again once the job is done — what was stale has moved.
    expect(calls.status).toBe(statusReads + 1);
    svc.close();
});

test('a queued job says what it waits for', async () => {
    const { api } = fakeApi({
        jobs: [
            job({ status: 'queued', phases: [{ id: 'wait', label: 'Waiting for the inner orthophoto export', status: 'running', detail: null, seconds: null }] }),
            job({ status: 'succeeded', seconds: 2, results: [], phases: PHASES(['done', 'skipped']) }),
        ],
    });
    // A slow poll, so the queued job is what the board holds when we look.
    const svc = new GsproSyncService(api, 40, 60_000);
    const pending = svc.update('course-1', 'trees');
    await new Promise(r => setTimeout(r, 0));
    expect(svc.job.peek()?.status).toBe('queued');
    expect(svc.queuedBehind()).toBe('the inner orthophoto export');
    expect(svc.running.peek()).toBe(true);
    await pending;
    expect(svc.running.peek()).toBe(false);
    svc.close();
});

test('a refused update (409) becomes the error and starts nothing', async () => {
    const { api, calls } = fakeApi({ updateFails: new Error('Photo cannot be updated: Build the map first') });
    const svc = service(api);
    await svc.refresh('course-1');

    expect(await svc.update('course-1', 'photo')).toBe(false);
    expect(svc.error.peek()).toBe('Photo cannot be updated: Build the map first');
    expect(svc.job.peek()).toBeNull();
    expect(svc.running.peek()).toBe(false);
    expect(calls.update).toEqual(['photo']);
    svc.close();
});

test('a failed job keeps its phases and its targets\' reports, with the error', async () => {
    const failed = job({
        request: 'stale', targets: ['shapes', 'trees'], status: 'failed', step: 'trees',
        startedAt: '2026-10-14T12:00:01.000Z', finishedAt: '2026-10-14T12:00:20.000Z', seconds: 19,
        phase: 'trees-files',
        phases: [
            { id: 'shapes-svg', label: 'Course SVG', status: 'done', detail: '200 features', seconds: 6 },
            { id: 'trees-files', label: 'Tree files', status: 'failed', detail: null, seconds: 13 },
        ],
        results: [
            { target: 'shapes', label: 'Course shapes', seconds: 6, report: ['Wrote vreta.svg'], error: null },
            { target: 'trees', label: 'Trees', seconds: 13, report: [], error: 'no tree stems for this course' },
        ],
        error: 'Trees: no tree stems for this course',
    });
    const { api } = fakeApi({ jobs: [job({ status: 'running', phases: failed.phases }), failed] });
    const svc = service(api);

    expect(await svc.update('course-1', 'stale')).toBe(false);
    expect(svc.error.peek()).toBe('Trees: no tree stems for this course');
    const left = svc.job.peek()!;
    expect(left.status).toBe('failed');
    expect(left.phases.map(p => p.status)).toEqual(['done', 'failed']);
    expect(left.results.map(r => r.error)).toEqual([null, 'no tree stems for this course']);
    expect(svc.running.peek()).toBe(false);
    // The refresh that follows a failed job must not wipe its reason.
    expect(svc.error.peek()).toBe('Trees: no tree stems for this course');
    svc.close();
});

test('opening the board for a course loads it; closing stops the background refresh', async () => {
    const { api, calls } = fakeApi();
    const svc = new GsproSyncService(api, 1, 5);
    await svc.openFor('course-1');
    expect(svc.isOpen).toBe(true);
    expect(calls.status).toBe(1);

    await new Promise(r => setTimeout(r, 30));
    const refreshed = calls.status;
    expect(refreshed).toBeGreaterThan(1);  // the 30 s re-read, here 5 ms

    svc.close();
    expect(svc.isOpen).toBe(false);
    await new Promise(r => setTimeout(r, 30));
    expect(calls.status).toBe(refreshed);
});

// --- The words the rows are written in ---

test('relative times, change counts and the "about" time read as the board says them', () => {
    expect(agoLabel(null)).toBe('never');
    expect(agoLabel('2026-10-14T11:59:30.000Z', NOW)).toBe('just now');
    expect(agoLabel('2026-10-14T11:30:00.000Z', NOW)).toBe('30 min ago');
    expect(agoLabel('2026-10-14T10:00:00.000Z', NOW)).toBe('2 h ago');
    expect(agoLabel('2026-10-11T12:00:00.000Z', NOW)).toBe('3 days ago');
    expect(agoLabel('2026-10-13T12:00:00.000Z', NOW)).toBe('1 day ago');

    expect(changedLabel({ count: 0, kinds: [] })).toBe('up to date');
    expect(changedLabel({ count: 14, kinds: ['path', 'bunker', 'tee'] })).toBe('14 features changed (paths, bunkers, tees)');
    expect(changedLabel({ count: 1, kinds: ['water_creek'] })).toBe('1 feature changed (creeks)');
    // Non-feature kinds keep their own words.
    expect(changedLabel({ count: 3, kinds: ['terrain edits', 'unapplied edits'] })).toBe('3 changes (terrain edits, unapplied edits)');
    expect(changedLabel({ count: 1, kinds: ['cleaned photo'] })).toBe('1 change (cleaned photo)');
    expect(changedLabel({ count: 2, kinds: [] })).toBe('2 changes');

    expect(aboutLabel(40)).toBe('about 40 s');
    expect(aboutLabel(200)).toBe('about 3 min');
    expect(aboutLabel(null)).toBe('');

    expect(rowStatusLabel(targetRow({ id: 'trees', lastRun: null }), NOW)).toBe('never');
    expect(rowStatusLabel(targetRow({
        id: 'shapes', lastRun: '2026-10-14T10:00:00.000Z', changedSince: { count: 2, kinds: ['path'] },
    }), NOW)).toBe('2 h ago · 2 features changed (paths)');
    expect(rowStatusLabel(targetRow({ id: 'terrain', lastRun: '2026-10-14T10:00:00.000Z', stale: false }), NOW))
        .toBe('2 h ago · up to date');
});

/** Watch `running` while a job is followed, without a framework effect. */
function trackRunning(svc: GsproSyncService, into: string[]): () => void {
    const timer = setInterval(() => {
        const word = svc.running.peek() ? 'running' : 'idle';
        if (into.at(-1) !== word) into.push(word);
    }, 1);
    (timer as unknown as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
}
