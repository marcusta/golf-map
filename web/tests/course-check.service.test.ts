import { test, expect } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { CourseCheckService, checkStatusLabel, checkStatusTitle, countsLabel } from '../src/export/course-check.service';
import type {
    CourseCheckApi, CourseCheckJob, CourseCheckStatus, CourseCheckSummary, CourseCheckResult,
} from '../../shared/api/course-check.gen';

// The GSPro board's Check row, client side, against a fake API object (plain
// functions, no mocking library — TESTING.md): what the row says, and what a
// run leaves on screen when Unity was not there or the check was refused.

const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function summary(patch: Partial<CourseCheckSummary> = {}): CourseCheckSummary {
    return {
        layer: 'unity', report: 'D:/x/course-check.json', at: '2026-10-19T10:00:00.000Z', ok: false,
        errors: 13, warnings: 49, area: 'ombergs-golfklubb-oob.json + 50 m', hole: null, meshes: 900, seconds: 30.2,
        counts: [{ type: 'crack', findings: 13, severity: 'error', points: 40 }],
        ...patch,
    };
}

function status(patch: Partial<CourseCheckStatus> = {}): CourseCheckStatus {
    return {
        boundary: 'D:/x/ombergs-golfklubb-oob.json', unity: summary(), blender: null,
        meshesChangedAt: null, meshesChangedSince: false, job: null, ...patch,
    };
}

function result(patch: Partial<CourseCheckResult> = {}): CourseCheckResult {
    return {
        boundary: { path: 'D:/x/oob.json', rings: 1, points: 6000 },
        unity: { ...summary(), findings: [] }, unitySkipped: null, blender: null, blenderSkipped: 'not running', warnings: [],
        ...patch,
    };
}

function job(patch: Partial<CourseCheckJob> = {}): CourseCheckJob {
    return {
        id: 'check-1', courseId: 'course-1', status: 'running', phase: 'unity', step: 'Unity check (3 s)',
        phases: [{ id: 'unity', label: 'Unity check', status: 'running', detail: null, seconds: 3 }],
        startedAt: '2026-10-19T12:00:00.000Z', finishedAt: null, seconds: 3, result: null, error: null, ...patch,
    };
}

/** `run` hands out the first job, `job` walks through the rest; `status` serves the boards in turn (the last repeats). */
function fakeApi(opts: { jobs?: CourseCheckJob[]; boards?: CourseCheckStatus[]; refuse?: string }) {
    const boards = [...(opts.boards ?? [status()])];
    const jobs = [...(opts.jobs ?? [])];
    const calls: string[] = [];
    const client: CourseCheckApi = {
        status: async () => { calls.push('status'); return boards.length > 1 ? boards.shift()! : boards[0]!; },
        run: async () => {
            calls.push('run');
            if (opts.refuse) throw new ApiError(409, opts.refuse);
            return jobs.shift()!;
        },
        job: async () => { calls.push('job'); return jobs.length > 1 ? jobs.shift()! : jobs[0]!; },
    };
    return { client, calls };
}

test('the status line: counts, when, and what makes it stale', () => {
    expect(checkStatusLabel(null)).toBe('');
    expect(checkStatusLabel(status({ unity: null }))).toBe('never checked');
    expect(checkStatusLabel(status(), NOW)).toBe('13 errors · 49 warnings · 2 h ago');
    expect(checkStatusLabel(status({ unity: summary({ errors: 0, warnings: 0, ok: true }), meshesChangedSince: true }), NOW))
        .toBe('✓ · 2 h ago · meshes changed since');
    expect(checkStatusLabel(status({ unity: summary({ hole: '7' }), blender: summary({ layer: 'blender', errors: 1 }) }), NOW))
        .toBe('13 errors · 49 warnings · 2 h ago · hole 7 only · Blender 1 error');
    expect(countsLabel({ errors: 0, warnings: 1 })).toBe('✓ · 1 warning');
    const title = checkStatusTitle(status({ meshesChangedSince: true, meshesChangedAt: '2026-10-19T11:00:00.000Z' }));
    expect(title).toContain('Unity: 13 errors · 49 warnings — ombergs-golfklubb-oob.json + 50 m, 30 s');
    expect(title).toContain('Blender: no report yet');
    expect(title).toContain('check again');
});

test('a run is followed to its end and the reports are read again', async () => {
    const done = job({ status: 'succeeded', phase: null, step: 'done', result: result() });
    const api = fakeApi({ jobs: [job(), job({ seconds: 20 }), done] });
    const svc = new CourseCheckService(api.client, 1);
    expect(await svc.run('course-1')).toBe(true);
    expect(svc.job.peek()!.status).toBe('succeeded');
    expect(svc.running.peek()).toBe(false);
    expect(svc.error.peek()).toBe('');
    expect(api.calls).toEqual(['run', 'job', 'job', 'status']);
    expect(svc.status.peek()!.unity!.errors).toBe(13);
});

test('no Unity editor: the run goes through, and the row says why there is no check', async () => {
    const why = 'Not in Unity: no open Unity editor imports from D:/x (none is open)';
    const api = fakeApi({ jobs: [job({ status: 'succeeded', result: result({ unity: null, unitySkipped: why }) })] });
    const svc = new CourseCheckService(api.client, 1);
    expect(await svc.run('course-1')).toBe(false);
    expect(svc.error.peek()).toBe(why);
});

test('a refused run (one is going already) leaves its reason and nothing running', async () => {
    const api = fakeApi({ refuse: 'A course check is already running for this course' });
    const svc = new CourseCheckService(api.client, 1);
    expect(await svc.run('course-1')).toBe(false);
    expect(svc.error.peek()).toContain('already running');
    expect(svc.running.peek()).toBe(false);
});

test('a check already running on the server (the CLI) is followed from the board\'s read', async () => {
    const done = job({ status: 'succeeded', result: result() });
    const api = fakeApi({ jobs: [done], boards: [status({ job: job() }), status({ job: done })] });
    const svc = new CourseCheckService(api.client, 1);
    await svc.refresh('course-1');
    expect(svc.running.peek()).toBe(true);
    for (let i = 0; i < 50 && svc.running.peek(); i++) await new Promise(r => setTimeout(r, 2));
    expect(svc.job.peek()!.status).toBe('succeeded');
});
