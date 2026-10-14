// Hand-written fake of the server's shaping endpoints (TESTING.md: stubs, no
// mocking library), shared by the shaping service, terrain-edit tool and
// terrain-edit panel tests.
import type { ShapingApi, ShapingJob, ShapingPhase, ShapingRecipe } from '../../shared/api/shaping.gen';
import type { ShapingSurface } from '../src/terrain-edit/shaping.service';

const LABELS: Record<ShapingPhase['id'], string> = {
    layers: 'Generating layers', worker: 'Starting the shaping worker', blender: 'Blender sync', unity: 'Unity refresh',
};

/**
 * The job's phases as the server reports them: `upTo` ran (done, the last
 * one `last`), the rest pending; `details` / `seconds` per phase.
 */
export function phases(upTo: ShapingPhase['id'] | null, opts: {
    last?: ShapingPhase['status']; details?: Partial<Record<ShapingPhase['id'], string>>; seconds?: Partial<Record<ShapingPhase['id'], number>>;
} = {}): ShapingPhase[] {
    const ids = Object.keys(LABELS) as ShapingPhase['id'][];
    const n = upTo === null ? -1 : ids.indexOf(upTo);
    return ids.map((id, i) => {
        const status: ShapingPhase['status'] = i < n ? 'done' : i === n ? (opts.last ?? 'running') : 'pending';
        return {
            id, label: LABELS[id], status, detail: status === 'pending' ? null : opts.details?.[id] ?? null,
            seconds: status === 'pending' || status === 'skipped' ? null : opts.seconds?.[id] ?? 1,
        };
    });
}

export function shapingJob(overrides: Partial<ShapingJob> = {}): ShapingJob {
    return {
        id: 'j1', courseId: 'course-1', status: 'running', phase: 'blender', step: 'Blender sync — re-shaping what changed (1 s)',
        phases: phases('blender'), dryRun: false,
        startedAt: '2026-09-28T10:00:00Z', finishedAt: null, seconds: 3, result: null, error: null,
        ...overrides,
    };
}

/** A succeeded job with these changed objects (and warnings / a Unity error). */
export function doneJob(changedObjects: string[], extra: {
    warnings?: string[]; unityError?: string; id?: string; phases?: ShapingPhase[]; seconds?: number;
    unitySteps?: Array<{ id: string; status: string; seconds: number | null }>;
} = {}): ShapingJob {
    return shapingJob({
        id: extra.id ?? 'j1',
        status: 'succeeded',
        phase: null,
        step: 'done',
        phases: extra.phases ?? phases('unity', { last: 'done' }),
        finishedAt: '2026-09-28T10:01:00Z',
        seconds: extra.seconds ?? 3,
        result: {
            changedObjects, exported: [], removed: [], warnings: extra.warnings ?? [], places: [], seams: null,
            unityReport: null, pathSurfaces: [], pathMaterials: null, unitySteps: extra.unitySteps ?? [], unityError: extra.unityError ?? null, layers: [], blend: 'course.blend', layersDir: 'shaping',
            fbxFolder: null, dryRun: false, seconds: extra.seconds ?? 3,
        },
    });
}

/**
 * A library entry; `defaultFor` = the surfaces it is the course default of
 * (the server marks `default` per surface asked); `params` [] when left out,
 * as the server serves it.
 */
export interface LibraryEntry extends Omit<ShapingRecipe, 'default' | 'file' | 'params'> {
    defaultFor?: ShapingSurface[];
    params?: ShapingRecipe['params'];
}

export interface FakeShapingApi extends ShapingApi {
    calls: { recipes: Array<ShapingSurface | undefined>; apply: Array<{ courseId: string; paths?: boolean }>; job: string[] };
    library: LibraryEntry[];
    /** Thrown by apply (e.g. the 409 while a job runs). */
    applyError: Error | null;
    /** What status reports as the course's job. */
    current: ShapingJob | null;
    /** Jobs the job endpoint returns, one per poll (the last one repeats); an Error is thrown instead. */
    polls: Array<ShapingJob | Error>;
}

export function fakeShapingApi(library: LibraryEntry[] = []): FakeShapingApi {
    const f: FakeShapingApi = {
        calls: { recipes: [], apply: [], job: [] },
        library,
        applyError: null,
        current: null,
        polls: [],
        async recipes(input) {
            f.calls.recipes.push(input.surface);
            return f.library
                .filter(r => !input.surface || r.surfaces.includes(input.surface))
                .map(({ defaultFor, params, ...r }) => ({
                    ...r, file: `${r.id}.json`, params: params ?? [],
                    ...(input.surface && defaultFor?.includes(input.surface) ? { default: true } : {}),
                }));
        },
        async apply(input) {
            f.calls.apply.push(input);
            if (f.applyError) throw f.applyError;
            return shapingJob({ courseId: input.courseId });
        },
        async status() {
            return { worker: { url: 'http://127.0.0.1:8766', reachable: true, state: 'ready', phase: null, blend: null, conformed: null,
                layersDir: null, appliedOps: null, lastRun: null, error: null, spawnedPid: null, job: null, log: null }, job: f.current };
        },
        async job(input) {
            f.calls.job.push(input.jobId);
            const next = (f.polls.length > 1 ? f.polls.shift() : f.polls[0]) ?? shapingJob({ id: input.jobId, status: 'failed', error: 'no such job' });
            if (next instanceof Error) throw next;
            return next;
        },
    };
    return f;
}
