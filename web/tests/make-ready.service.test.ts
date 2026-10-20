import { test, expect } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { MakeReadyService, readyStatusLabel, readyStatusTitle } from '../src/export/make-ready.service';
import type {
    MakeReadyApi, MakeReadyJob, MakeReadyResult, MakeReadyStatus, MakeReadySummary,
} from '../../shared/api/make-ready.gen';

// The GSPro board's Ready row, client side, against a fake API object (plain
// functions, no mocking library — TESTING.md): what the row says, what Fix
// sends, and what a run leaves on screen when Unity was closed or the run was
// refused.

const NOW = Date.parse('2026-10-20T12:00:00.000Z');

function summary(patch: Partial<MakeReadySummary> = {}): MakeReadySummary {
    return {
        at: '2026-10-20T10:00:00.000Z', ready: false, blockers: [], errors: 3, warnings: 1, fixed: 0, fix: false, marginM: 40,
        categories: [
            { layer: 'unity', category: 'trees', objects: 120, near: 14, ok: 13, fixed: 0, findings: 1 },
            { layer: 'arborist', category: 'arborist-trees', objects: 6, near: 4, ok: 1, fixed: 0, findings: 2 },
        ],
        unity: { skipped: null, report: 'D:/x/make-ready.json', errors: 1, warnings: 0, fixed: 0 },
        arborist: { skipped: null, file: 'C:/gspro/arboristdata.dat', instances: 10, errors: 2, warnings: 1 },
        check: { skipped: null, source: 'report', at: '2026-10-20T09:00:00.000Z', report: 'D:/x/course-check.json', errors: 0, warnings: 0 },
        ...patch,
    };
}

function status(patch: Partial<MakeReadyStatus> = {}): MakeReadyStatus {
    return { last: summary(), job: null, ...patch };
}

function result(patch: Partial<MakeReadyResult> = {}): MakeReadyResult {
    return { ...summary(), findings: [], fixes: [], file: 'D:/x/make-ready-summary.json', ...patch };
}

function job(patch: Partial<MakeReadyJob> = {}): MakeReadyJob {
    return {
        id: 'ready-1', courseId: 'course-1', status: 'running', phase: 'unity', step: 'Unity scene (3 s)',
        phases: [{ id: 'unity', label: 'Unity scene', status: 'running', detail: null, seconds: 3 }],
        startedAt: '2026-10-20T12:00:00.000Z', finishedAt: null, seconds: 3, result: null, error: null, ...patch,
    };
}

/** `run` hands out the first job, `job` walks through the rest; `status` serves the boards in turn (the last repeats). */
function fakeApi(opts: { jobs?: MakeReadyJob[]; boards?: MakeReadyStatus[]; refuse?: string }) {
    const boards = [...(opts.boards ?? [status()])];
    const jobs = [...(opts.jobs ?? [])];
    const calls: Array<{ call: string; input?: unknown }> = [];
    const client: MakeReadyApi = {
        status: async () => { calls.push({ call: 'status' }); return boards.length > 1 ? boards.shift()! : boards[0]!; },
        run: async (input) => {
            calls.push({ call: 'run', input });
            if (opts.refuse) throw new ApiError(409, opts.refuse);
            return jobs.shift()!;
        },
        job: async () => { calls.push({ call: 'job' }); return jobs.length > 1 ? jobs.shift()! : jobs[0]!; },
    };
    return { client, calls };
}

test('the status line: ready, the counts, when, and never run', () => {
    expect(readyStatusLabel(null)).toBe('');
    expect(readyStatusLabel(status({ last: null }))).toBe('never run');
    expect(readyStatusLabel(status(), NOW)).toBe('3 errors · 1 warning · 2 h ago');
    expect(readyStatusLabel(status({ last: summary({ ready: true, errors: 0, warnings: 0, fixed: 4 }) }), NOW)).toBe('ready · 4 fixed · 2 h ago');
    expect(readyStatusLabel(status({ last: summary({ errors: 0, warnings: 0, unity: { ...summary().unity, skipped: 'Not in Unity' } }) }), NOW))
        .toBe('not ready: Unity not checked · 2 h ago');
    const title = readyStatusTitle(status());
    expect(title).toContain('Not ready');
    expect(title).toContain('Arborist file: 2 errors · 1 warning in 10 instances (report only)');
    expect(title).toContain('trees: 14/120 near, 13 ok, 1 found');
});

test('Fix runs with fix and is followed to its end; ready is what it returns', async () => {
    const done = job({ status: 'succeeded', phase: null, step: 'done', result: result({ ready: true, errors: 0, fix: true }) });
    const api = fakeApi({ jobs: [job(), done], boards: [status({ last: summary({ ready: true, errors: 0 }) })] });
    const svc = new MakeReadyService(api.client, 1);
    expect(await svc.run('course-1', true)).toBe(true);
    expect(api.calls.map(c => c.call)).toEqual(['run', 'job', 'status']);
    expect(api.calls[0]!.input).toEqual({ courseId: 'course-1', fix: true });
    expect(svc.running.peek()).toBe(false);
    expect(svc.error.peek()).toBe('');
    expect(svc.status.peek()!.last!.ready).toBe(true);
});

test('Unity closed: the run goes through, not ready, and the row says why', async () => {
    const why = 'Unity scene not checked: Not in Unity: no open Unity editor imports from D:/x (none is open)';
    const api = fakeApi({ jobs: [job({ status: 'succeeded', result: result({ blockers: [why] }) })] });
    const svc = new MakeReadyService(api.client, 1);
    expect(await svc.run('course-1')).toBe(false);
    expect(api.calls[0]!.input).toEqual({ courseId: 'course-1', fix: false });
    expect(svc.error.peek()).toBe(why);
});

test('a refused run (one is going already) leaves its reason and nothing running', async () => {
    const api = fakeApi({ refuse: 'Make ready is already running for this course' });
    const svc = new MakeReadyService(api.client, 1);
    expect(await svc.run('course-1')).toBe(false);
    expect(svc.error.peek()).toContain('already running');
    expect(svc.running.peek()).toBe(false);
});

test('a run already going on the server (the CLI) is followed from the board\'s read', async () => {
    const done = job({ status: 'succeeded', result: result() });
    const api = fakeApi({ jobs: [done], boards: [status({ job: job() }), status({ job: done })] });
    const svc = new MakeReadyService(api.client, 1);
    await svc.refresh('course-1');
    expect(svc.running.peek()).toBe(true);
    for (let i = 0; i < 50 && svc.running.peek(); i++) await new Promise(r => setTimeout(r, 2));
    expect(svc.job.peek()!.status).toBe('succeeded');
});
