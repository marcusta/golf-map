import { describe, expect, test } from 'bun:test';
import { effect } from '@basics/core/client/core';
import { ApiError } from '../src/api';
import { ShapingService, surfaceOf } from '../src/terrain-edit/shaping.service';
import { doneJob, fakeShapingApi, phases, shapingJob, type LibraryEntry } from './shaping-fakes';

// The Terrain editor's side of Blender shaping: the recipe library per
// surface, and the apply job followed to its end, over a hand-written fake
// of the server's shaping endpoints (TESTING.md: stubs, no mocking library).

const library: LibraryEntry[] = [
    { id: 'pot', name: 'Pot bunker', author: 'golfmap', surfaces: ['bunker'] },
    { id: 'conway', name: 'Conway Standard', author: 'cesimgolf', surfaces: ['bunker'], defaultFor: ['bunker'] },
    { id: 'edge', name: 'Soft edge', author: 'afrod', surfaces: ['lake', 'creek'], defaultFor: ['lake'] },
];

test('feature types map to the surfaces their recipes shape', () => {
    expect(['bunker', 'water', 'water_creek', 'path', 'fairway'].map(surfaceOf)).toEqual(['bunker', 'lake', 'creek', 'path', null]);
});

describe('recipe library', () => {
    test('loads once, per surface, with the course default first', async () => {
        const client = fakeShapingApi(library);
        const svc = new ShapingService(client, 0);
        await svc.loadRecipes();
        await svc.loadRecipes();
        expect(client.calls.recipes).toEqual(['bunker', 'lake', 'creek', 'path']);
        expect(svc.recipesFor('bunker').map(r => r.id)).toEqual(['conway', 'pot']);
        expect(svc.recipesFor('creek').map(r => r.id)).toEqual(['edge']);
        expect(svc.recipesFor('path')).toEqual([]);
        expect(svc.defaultFor('bunker')?.name).toBe('Conway Standard');
        // A recipe for two surfaces can be the default of only one.
        expect(svc.defaultFor('lake')?.id).toBe('edge');
        expect(svc.defaultFor('creek')).toBeNull();
        expect(svc.recipes.get().map(r => r.id)).toEqual(['pot', 'conway', 'edge']);
        expect(svc.recipe('pot')?.author).toBe('golfmap');
    });

    test('a failed load says so and is retried next time', async () => {
        const client = fakeShapingApi(library);
        const recipes = client.recipes;
        client.recipes = async () => { throw new Error('offline'); };
        const svc = new ShapingService(client, 0);
        await svc.loadRecipes();
        expect(svc.recipesError.get()).toBe('Loading the recipe library failed: offline');
        client.recipes = recipes;
        await svc.loadRecipes();
        expect(svc.recipesError.get()).toBeNull();
        expect(svc.recipes.get()).toHaveLength(3);
    });
});

describe('apply job', () => {
    test('starts the course job and polls it to success', async () => {
        const client = fakeShapingApi();
        client.polls = [shapingJob({ step: 'worker sync' }), doneJob(['A', 'B'], { warnings: ['seam gap'] })];
        const svc = new ShapingService(client, 0);
        const done = svc.apply('course-1');
        expect(svc.running.get()).toBe(true); // already while the start request is in flight
        const job = await done;
        expect(client.calls.apply).toEqual([{ courseId: 'course-1' }]);
        expect(client.calls.job).toEqual(['j1', 'j1']);
        expect(job?.status).toBe('succeeded');
        expect(svc.running.get()).toBe(false);
        expect(svc.jobScope.get()).toBeNull();
        expect(svc.job.get()?.result?.changedObjects).toEqual(['A', 'B']);
        expect(svc.job.get()?.result?.warnings).toEqual(['seam gap']);
    });

    test('paths: asks the server to take the path surfaces through as well', async () => {
        const client = fakeShapingApi();
        client.polls = [doneJob([])];
        const svc = new ShapingService(client, 0);
        const job = await svc.apply('course-1', null, { paths: true });
        expect(job?.status).toBe('succeeded');
        expect(client.calls.apply).toEqual([{ courseId: 'course-1', paths: true }]);
    });

    test("a feature's apply is scoped to it for the panel; a second apply while running is refused", async () => {
        const client = fakeShapingApi();
        let finish!: () => void;
        client.job = () => new Promise(resolve => {
            finish = () => resolve(shapingJob({ status: 'failed', error: 'worker down' }));
        });
        const svc = new ShapingService(client, 0);
        const first = svc.apply('course-1', 'b1');
        await new Promise(r => setTimeout(r, 5));
        expect(svc.jobScope.get()).toBe('b1');
        expect(await svc.apply('course-1')).toBeNull();
        finish();
        expect((await first)?.error).toBe('worker down');
        expect(client.calls.apply).toEqual([{ courseId: 'course-1', featureIds: ['b1'] }]); // the server runs the whole course; the selection is the job's slice
    });

    test('a refused start (409) follows the job already running for the course, else reports why', async () => {
        const client = fakeShapingApi();
        client.applyError = new Error('A shaping run is already going');
        client.current = shapingJob({ id: 'j0' });
        client.polls = [doneJob([], { id: 'j0' })];
        const svc = new ShapingService(client, 0);
        expect((await svc.apply('course-1'))?.id).toBe('j0');
        expect(svc.jobError.get()).toBeNull();

        client.current = doneJob([], { id: 'j0' });
        expect(await svc.apply('course-1')).toBeNull();
        expect(svc.jobError.get()).toBe('Applying to the meshes failed: A shaping run is already going');
    });

    test('every phase change reaches the job signal; failed polls are retried and, after a few, reported as lost contact', async () => {
        const client = fakeShapingApi();
        const worker = (sec: number) => shapingJob({ phase: 'worker', phases: phases('worker', { details: { worker: 'cold start: Blender loading course.blend' }, seconds: { worker: sec } }) });
        client.polls = [
            worker(12), new Error('offline'), new Error('offline'), new Error('offline'), worker(53),
            shapingJob({ phase: 'unity', phases: phases('unity') }), doneJob(['A']),
        ];
        const svc = new ShapingService(client, 0);
        const seen: string[] = [];
        const lost: Array<string | null> = [];
        effect(() => {
            const job = svc.job.get();
            if (job) seen.push(`${job.status} ${job.phase} ${job.phases.find(p => p.id === job.phase)?.seconds ?? ''}`.trim());
        });
        effect(() => { lost.push(svc.connection.get()); });
        const job = await svc.apply('course-1');
        expect(job?.status).toBe('succeeded');
        expect(seen).toEqual(['running blender 1', 'running worker 12', 'running worker 53', 'running unity 1', 'succeeded null']);
        expect(lost.filter(Boolean)).toEqual(['Lost contact with the server (offline) — still trying…']);
        expect(svc.connection.get()).toBeNull();
        expect(svc.running.get()).toBe(false);
    });

    test('a job the server no longer knows (404: it restarted) ends as failed, not polled forever', async () => {
        const client = fakeShapingApi();
        client.polls = [shapingJob({ phase: 'worker', phases: phases('worker') }), new ApiError(404, 'No shaping job j1 (the server may have restarted)')];
        const svc = new ShapingService(client, 0);
        const job = await svc.apply('course-1');
        expect(job?.status).toBe('failed');
        expect(job?.error).toMatch(/^the server no longer knows this job/);
        expect(job?.phase).toBe('worker'); // where it was when contact ended
        expect(client.calls.job).toEqual(['j1', 'j1']);
        expect(svc.running.get()).toBe(false);
    });

    test('a view that throws on an update does not stall the job: the finished job still lands and the buttons come back', async () => {
        const client = fakeShapingApi();
        client.polls = [shapingJob({ phase: 'blender' }), doneJob(['A'])];
        const svc = new ShapingService(client, 0);
        const errors: unknown[] = [];
        const log = console.error;
        console.error = (...args: unknown[]) => { errors.push(args[0]); };
        try {
            effect(() => {
                if (svc.job.get()?.phase === 'blender') throw new Error('view broke');
            });
            const job = await svc.apply('course-1');
            expect(job?.status).toBe('succeeded');
        } finally {
            console.error = log;
        }
        expect(svc.job.get()?.status).toBe('succeeded');
        expect(svc.running.get()).toBe(false);
        expect(errors).toContain('Shaping: showing the job failed');
    });

    test("resume follows the course's running job (the page reloaded meanwhile); nothing running, nothing to follow", async () => {
        const client = fakeShapingApi();
        const svc = new ShapingService(client, 0);
        expect(await svc.resume('course-1')).toBeNull();
        expect(client.calls.job).toEqual([]);

        client.current = shapingJob({ id: 'j7', phase: 'unity', phases: phases('unity') });
        client.polls = [doneJob(['A'], { id: 'j7' })];
        let wasRunning = false;
        effect(() => { wasRunning ||= svc.running.get(); });
        expect((await svc.resume('course-1'))?.status).toBe('succeeded');
        expect(wasRunning).toBe(true);
        expect(svc.running.get()).toBe(false);
        expect(svc.jobScope.get()).toBeNull();
        expect(client.calls.apply).toEqual([]);
    });
});
