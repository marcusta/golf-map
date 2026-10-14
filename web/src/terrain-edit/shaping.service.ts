// Shaping in Blender (blender/SHAPING-PLAN.md, "Terrain editor → Blender"):
// the recipe library the Terrain editor offers per feature, and the server's
// shaping apply job (regenerate the shaping layers → the headless Blender
// worker re-shapes the touched course meshes → Unity refreshes just those
// objects). The per-feature recipe choice itself is a terrain edit
// (`op: 'recipe'`, TerrainEditToolService.saveRecipe); this service only
// knows the library and the job.

import { Computed, Signal } from '@basics/core/client/core';
import { api, ApiError } from '../api';
import type { ShapingApi, ShapingJob, ShapingRecipe } from '../../../shared/api/shaping.gen';

export type { ShapingApi, ShapingJob, ShapingRecipe } from '../../../shared/api/shaping.gen';

/** The mesh kinds a recipe shapes. */
export type ShapingSurface = ShapingRecipe['surfaces'][number];

const SURFACES: readonly ShapingSurface[] = ['bunker', 'lake', 'creek', 'path'];

/** The recipe id that opts a feature out: no recipe at all, not even its surface's default. */
export const NO_RECIPE = 'none';

/** One knob a recipe declares (SHAPING-PLAN.md, "Composite and parameterised recipes"). */
export type RecipeParam = ShapingRecipe['params'][number];

/** The override key every recipe takes besides its params: the random seed (unset = the feature number). */
export const SEED = 'seed';

/**
 * The `overrides` a recipe edit saves from the working values: each param
 * set away from its default, and the seed when set. `params` null (a recipe
 * not in the library) keeps every value as it is.
 */
export function overridesToSave(params: readonly RecipeParam[] | null, values: Readonly<Record<string, number>>): Record<string, number> {
    if (!params) return { ...values };
    const out: Record<string, number> = {};
    for (const p of params) {
        const v = values[p.id];
        if (v !== undefined && v !== p.default) out[p.id] = v;
    }
    if (values[SEED] !== undefined) out[SEED] = values[SEED];
    return out;
}

/**
 * The working values a recipe with these params cannot take: keys it has no
 * param for, and values outside a param's range. The seed applies to every
 * recipe (`withSeed`), not to "no recipe".
 */
export function inapplicable(params: readonly RecipeParam[], values: Readonly<Record<string, number>>, withSeed = true): string[] {
    return Object.keys(values).filter(key => {
        if (key === SEED) return !withSeed;
        const p = params.find(q => q.id === key);
        const v = values[key]!;
        return !p || v < p.min || v > p.max;
    });
}

/** The course feature types a recipe applies to, and the surface each is shaped as. */
export const SHAPE_SURFACES: Readonly<Record<string, ShapingSurface>> = {
    bunker: 'bunker',
    water: 'lake',
    water_creek: 'creek',
    path: 'path',
};

/** The surface a feature type is shaped as in Blender, or null (not shaped per feature). */
export function surfaceOf(type: string): ShapingSurface | null {
    return SHAPE_SURFACES[type] ?? null;
}

const POLL_MS = 1500;
/** Failed polls in a row before the panel says it lost contact. */
const LOST_AFTER = 3;

/** What the job was started for: one feature, or the whole course (null). */
export type ShapingScope = string | null;

export class ShapingService {
    /** The library per surface, loaded once. */
    private readonly bySurface = new Signal<Partial<Record<ShapingSurface, ShapingRecipe[]>>>({});
    /** The whole library (every surface, each recipe once). */
    readonly recipes = new Computed<ShapingRecipe[]>(() => {
        const seen = new Map<string, ShapingRecipe>();
        for (const surface of SURFACES) for (const r of this.bySurface.get()[surface] ?? []) if (!seen.has(r.id)) seen.set(r.id, r);
        return [...seen.values()];
    });
    readonly recipesError = new Signal<string | null>(null);
    /** The job being followed (running, or the one that just finished). */
    readonly job = new Signal<ShapingJob | null>(null);
    /** The feature the job was started for; null = the whole course. */
    readonly jobScope = new Signal<ShapingScope>(null);
    /** Why the job could not start (the server's message). */
    readonly jobError = new Signal<string | null>(null);
    /** Set while polls of the running job keep failing (the job may still be running on the server). */
    readonly connection = new Signal<string | null>(null);
    /** True while the start request is in flight (before the job is known). */
    private readonly starting = new Signal(false);
    /**
     * True while a job is followed to its end. Its own signal, not derived from
     * `job`: a view of `job` that throws cuts that signal's notification short,
     * which must not leave the buttons disabled.
     */
    private readonly following = new Signal(false);
    readonly running = new Computed(() => this.starting.get() || this.following.get());

    private loaded: Promise<void> | null = null;

    constructor(
        private readonly client: ShapingApi = api.shaping,
        private readonly pollMs = POLL_MS,
    ) {}

    /**
     * Loads the library once (again after a failure), per surface: the
     * server marks `default` for the surface asked for, and a recipe made for
     * two surfaces may be the default of only one.
     */
    loadRecipes(): Promise<void> {
        this.loaded ??= (async () => {
            try {
                const lists = await Promise.all(SURFACES.map(surface => this.client.recipes({ surface })));
                this.bySurface.set(Object.fromEntries(SURFACES.map((surface, i) => [surface, lists[i]])));
                this.recipesError.set(null);
            } catch (e) {
                this.loaded = null;
                this.recipesError.set(`Loading the recipe library failed: ${message(e)}`);
            }
        })();
        return this.loaded;
    }

    /** The recipes for a surface, the course default first. */
    recipesFor(surface: ShapingSurface): ShapingRecipe[] {
        const list = this.bySurface.get()[surface] ?? [];
        return [...list.filter(r => r.default), ...list.filter(r => !r.default)];
    }

    /** The course default recipe for a surface (the library's `default` one). */
    defaultFor(surface: ShapingSurface): ShapingRecipe | null {
        return this.recipesFor(surface).find(r => r.default) ?? null;
    }

    recipe(id: string): ShapingRecipe | null {
        return this.recipes.get().find(r => r.id === id) ?? null;
    }

    /** The recipe a choice runs: '' = the surface's course default, `none` = none (null), else the library entry (null when not in it). */
    resolve(choice: string, surface: ShapingSurface): ShapingRecipe | null {
        if (choice === NO_RECIPE) return null;
        return choice ? this.recipe(choice) : this.defaultFor(surface);
    }

    /**
     * Start the apply job and follow it to the end. The server runs it for the
     * whole course (it re-shapes only the meshes whose ops changed); `scope`
     * is the feature it was started for, where the panel shows the outcome
     * (null = the course-wide button). A job already running for the course
     * (409) is followed instead. Resolves with the finished job, or null when
     * it could not start. `paths` (the Draw mode's "Update paths")
     * also takes the paths' surfaces through: the surfaces file before
     * Blender, the path materials in Unity after.
     */
    async apply(courseId: string, scope: ShapingScope = null, opts: { paths?: boolean } = {}): Promise<ShapingJob | null> {
        if (this.running.peek()) return null;
        this.starting.set(true);
        this.job.set(null);
        this.jobError.set(null);
        this.connection.set(null);
        this.jobScope.set(scope);
        let job: ShapingJob;
        try {
            job = await this.client.apply(opts.paths ? { courseId, paths: true } : { courseId });
        } catch (e) {
            const current = await this.client.status({ courseId }).then(s => s.job, () => null);
            if (current?.status !== 'running') {
                this.jobError.set(`Applying to the meshes failed: ${message(e)}`);
                this.starting.set(false);
                return null;
            }
            job = current;
        }
        const done = this.follow(job);
        this.starting.set(false);
        return done;
    }

    /**
     * Follow the course's running job, if any and none is followed yet (the
     * Terrain editor opened, or the page reloaded, while one runs); shown
     * under the course button. Resolves with the finished job, else null.
     */
    async resume(courseId: string): Promise<ShapingJob | null> {
        if (this.running.peek()) return null;
        const current = await this.client.status({ courseId }).then(s => s.job, () => null);
        if (current?.status !== 'running' || this.running.peek()) return null;
        this.jobError.set(null);
        this.jobScope.set(null);
        return this.follow(current);
    }

    /**
     * Poll the job to its end, showing each state. A poll that fails is
     * retried (after a few in a row `connection` says so); a job the server
     * no longer knows (404: it restarted, jobs live in its memory) ends as
     * failed with that explanation instead of polling forever.
     */
    private async follow(job: ShapingJob): Promise<ShapingJob> {
        this.following.set(true);
        try {
            return await this.poll(job);
        } finally {
            this.following.set(false);
        }
    }

    private async poll(job: ShapingJob): Promise<ShapingJob> {
        this.show(job);
        let failures = 0;
        while (job.status === 'running') {
            await new Promise(r => setTimeout(r, this.pollMs));
            let next: ShapingJob;
            try {
                next = await this.client.job({ jobId: job.id });
            } catch (e) {
                if (e instanceof ApiError && e.status === 404) {
                    job = {
                        ...job, status: 'failed', finishedAt: new Date().toISOString(),
                        error: 'the server no longer knows this job (it restarted?). Blender and Unity may still have finished it: check Unity, or apply again.',
                    };
                    break;
                }
                if (++failures >= LOST_AFTER) this.connection.set(`Lost contact with the server (${message(e)}) — still trying…`);
                continue;
            }
            failures = 0;
            this.connection.set(null);
            job = next;
            this.show(job);
        }
        this.connection.set(null);
        this.show(job);
        return job;
    }

    /**
     * The job to the panel. A view that throws while updating is logged, not
     * taken for a failed poll: the old loop swallowed both alike, so one bad
     * update left the panel on its last step while polling went on.
     */
    private show(job: ShapingJob): void {
        try {
            this.job.set(job);
        } catch (e) {
            console.error('Shaping: showing the job failed', e);
        }
    }
}

function message(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
