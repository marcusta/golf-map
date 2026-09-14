// GSPro/OPCD export state (one course at a time): the course SVG, the
// square orthophoto JPEGs, the square DEM GeoTIFFs + Unity .raw heightmaps
// and the hillshade JPEGs for the two GSPro terrains — the INNER one the map
// was built over (side on a 10 m step) and the 5 km OUTER one centred on it.
//
// The exports themselves happen on the server (GsproExportService shells out
// to `pipeline/gspro.py svg` / `ortho` / `dem` / `hillshade` / `trees`) as JOBS:
// `start` returns at once and this service polls `job` until it finishes —
// an outer orthophoto or outer trees export runs for minutes, far past a
// request timeout, and the panel must say so rather than go quiet. Opening
// the panel resumes the course's running job (or shows its last result), and
// a start refused because one is already running re-attaches to that one.
// This holds the panel's state: which course is open, the folder it writes
// to, the two terrain squares, the picked orthophoto vintage, the job in
// flight and the last run's report or error.
//
// The folder is TYPED, not picked: the browser cannot show an OS folder
// chooser for a path the SERVER writes to, and the server is the one holding
// the pen. It is per course, persisted server-side; blank means the server
// default (the OS Downloads folder).
//
// DI singleton; the panel component is the only UI. Testable headlessly —
// the constructor takes the API client.

import { Signal } from '@basics/core/client/core';
import { api } from '../api';
import type {
    GsproExportApi, GsproExportSettings, GsproOrthoSource, CourseTerrain, TerrainSquare, GsproExportJob,
} from '../../../shared/api/gspro-export.gen';

/** What `start` takes besides the course: the kind and the fields it needs. */
type GsproExportRequest = Omit<Parameters<GsproExportApi['start']>[0], 'courseId'>;

export type TerrainKind = 'inner' | 'outer';
export type { GsproExportJob };

/** How often a running job is polled (ms); tests pass something tiny. */
export const DEFAULT_POLL_MS = 1500;

export class GsproExportService {
    /** Course the panel is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    readonly courseName = new Signal<string>('');
    /** Server-side settings for that course (null while loading). */
    readonly settings = new Signal<GsproExportSettings | null>(null);
    /** Folder text being edited; empty means "use the default". */
    readonly dirDraft = new Signal<string>('');
    readonly busy = new Signal<boolean>(false);
    /** Lines the exporter printed on the last successful run (SVG or ortho). */
    readonly report = new Signal<string[]>([]);
    /** Path written by the last successful run (SVG or ortho). */
    readonly lastPath = new Signal<string | null>(null);
    readonly error = new Signal<string>('');
    /**
     * Orthophoto GeoTIFFs the map build persisted for the course's site
     * (null while loading; empty when the course was never built here).
     */
    readonly orthoSources = new Signal<GsproOrthoSource[] | null>(null);
    /** `source` of the vintage picked for the JPEG export ('' = none). */
    readonly orthoSource = new Signal<string>('');
    /**
     * Brightness of the `-terrain` texture twin as typed: a light multiplier
     * in linear light, 1 = the photo as-is. Blank means the server default.
     */
    readonly terrainDarken = new Signal<string>('');
    /** The course's inner + outer terrain squares (null while loading or unavailable). */
    readonly terrain = new Signal<CourseTerrain | null>(null);
    /** Why the terrains are unavailable (no map area yet) — '' when they loaded. */
    readonly terrainNote = new Signal<string>('');
    /** The export job being followed (running, or the one that just finished); null when none. */
    readonly job = new Signal<GsproExportJob | null>(null);
    /** Bumped on every poll so elapsed-time text re-renders. */
    readonly tick = new Signal<number>(0);

    constructor(private readonly client: GsproExportApi = api.gsproExport, private readonly pollMs = DEFAULT_POLL_MS) {}

    get isOpen(): boolean {
        return this.courseId.peek() !== null;
    }

    /** Open the panel for a course and load its folder setting. */
    async openFor(courseId: string, courseName: string): Promise<void> {
        this.courseId.set(courseId);
        this.courseName.set(courseName);
        this.settings.set(null);
        this.report.set([]);
        this.lastPath.set(null);
        this.error.set('');
        this.orthoSources.set(null);
        this.orthoSource.set('');
        this.terrain.set(null);
        this.terrainNote.set('');
        this.job.set(null);
        await this.reload();
        await this.resume();
    }

    /**
     * Pick up the course's job: keep following a running one (the panel was
     * closed, or the page reloaded, while an export ran), or show the last
     * finished one's outcome so the operator sees what the folder holds.
     */
    private async resume(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId) return;
        let current: GsproExportJob | null;
        try {
            current = await this.client.current({ courseId });
        } catch {
            return;  // an older server without jobs: nothing to resume
        }
        if (!current || this.courseId.peek() !== courseId) return;
        if (current.status === 'running') {
            void this.follow(current);
        } else {
            this.showOutcome(current);
        }
    }

    /** The collection of the picked vintage — what the outer orthophoto is fetched as. */
    get pickedCollection(): string {
        const source = this.orthoSource.peek();
        return this.orthoSources.peek()?.find(s => s.source === source)?.collection ?? '';
    }

    close(): void {
        this.courseId.set(null);
        this.busy.set(false);
    }

    private async reload(): Promise<void> {
        const courseId = this.courseId.peek();
        if (!courseId) return;
        this.busy.set(true);
        // The terrains 409 for a course with no map area yet; that is a note
        // on the panel, not a failure of the whole panel.
        const terrain = this.client.terrain({ courseId }).then(
            t => { this.terrain.set(t); this.terrainNote.set(''); },
            e => { this.terrain.set(null); this.terrainNote.set(messageOf(e)); },
        );
        try {
            const [settings, sources] = await Promise.all([
                this.client.settings({ courseId }),
                this.client.orthoSources({ courseId }),
                terrain,
            ]);
            this.settings.set(settings);
            // Show the default as placeholder-ish emptiness rather than a
            // path the user did not choose — saving blank means "default".
            this.dirDraft.set(settings.isDefault ? '' : settings.dir);
            this.orthoSources.set(sources);
            // Preselect what the map is showing (the pristine copy), else the
            // newest vintage — the list is newest first.
            const preferred = sources.find(s => s.active && !s.patched) ?? sources[0];
            this.orthoSource.set(preferred?.source ?? '');
        } catch (e) {
            this.error.set(messageOf(e));
        } finally {
            this.busy.set(false);
        }
    }

    /** Persist the typed folder for this course (blank resets to default). */
    async saveDir(): Promise<boolean> {
        const courseId = this.courseId.peek();
        if (!courseId) return false;
        this.busy.set(true);
        this.error.set('');
        try {
            const dir = this.dirDraft.peek().trim();
            const settings = await this.client.setDir({ courseId, dir: dir || null });
            this.settings.set(settings);
            this.dirDraft.set(settings.isDefault ? '' : settings.dir);
            return true;
        } catch (e) {
            this.error.set(messageOf(e));
            return false;
        } finally {
            this.busy.set(false);
        }
    }

    /** Save the folder, then export the SVG. Reports where the file landed. */
    async run(): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'svg' });
    }

    /**
     * Save the folder, then render the picked orthophoto vintage as the
     * square 8192 px JPEG texture. Reports where the file landed.
     */
    async runOrtho(): Promise<boolean> {
        const courseId = this.courseId.peek();
        const source = this.orthoSource.peek();
        if (!courseId || !source) return false;
        const darken = this.darkenValue();
        if (darken === false) return false;
        return this.runExport({ kind: 'ortho', source, darken });
    }

    /** The typed brightness as a number, undefined when blank, false (with the error set) when not a usable number. */
    private darkenValue(): number | undefined | false {
        const text = this.terrainDarken.peek().trim().replace(',', '.');
        if (!text) return undefined;
        const n = Number(text);
        if (!Number.isFinite(n) || n < 0.05 || n > 1) {
            this.error.set('Terrain texture brightness must be a number between 0.05 and 1 (1 = the photo as-is)');
            return false;
        }
        return n;
    }

    /**
     * Save the folder, then fetch (once) and render the picked vintage over
     * the 5 km OUTER square as its 8192 px JPEG. The vintage is named by its
     * collection: the outer area is fetched fresh, not cut from the inner copy.
     */
    async runOuterOrtho(): Promise<boolean> {
        const courseId = this.courseId.peek();
        const collection = this.pickedCollection;
        if (!courseId || !collection) return false;
        const darken = this.darkenValue();
        if (darken === false) return false;
        return this.runExport({ kind: 'outer-ortho', collection, darken });
    }

    /**
     * Save the folder, then export one terrain's DEM as a square EPSG:3006
     * GeoTIFF, its Unity .raw heightmap and the .json sidecar (height range
     * + Unity settings) — OPCD's TIF→RAW step done.
     */
    async runDem(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'dem', terrain });
    }

    /**
     * Save the folder, then render one terrain's DEM as an 8192 px hillshade
     * JPEG — OPCD's aid for checking an overlay against the terrain.
     */
    async runHillshade(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'hillshade', terrain });
    }

    /**
     * Save the folder, then write one terrain's lidar tree stems as the
     * unity-trees-v1 file the Unity Tree Planter reads. Needs that
     * terrain's heightmap export in the folder (the height range).
     */
    async runTrees(terrain: TerrainKind): Promise<boolean> {
        if (!this.courseId.peek()) return false;
        return this.runExport({ kind: 'trees', terrain });
    }

    /**
     * Save the folder, start the export as a job and follow it to the end.
     * True when it succeeded. A start refused because a job is already
     * running for the course re-attaches to that job instead.
     */
    private async runExport(request: GsproExportRequest): Promise<boolean> {
        const courseId = this.courseId.peek();
        if (!courseId) return false;
        if (!(await this.saveDir())) return false;
        this.busy.set(true);
        this.error.set('');
        this.report.set([]);
        this.lastPath.set(null);
        let job: GsproExportJob;
        try {
            job = await this.client.start({ courseId, ...request });
        } catch (e) {
            const message = messageOf(e);
            if (/already running/i.test(message)) {
                const running = await this.client.current({ courseId }).catch(() => null);
                if (running && running.status === 'running') return this.follow(running);
            }
            this.error.set(message);
            this.busy.set(false);
            return false;
        }
        return this.follow(job);
    }

    /** Poll a job until it finishes, then show its outcome. True when it succeeded. */
    private async follow(job: GsproExportJob): Promise<boolean> {
        this.job.set(job);
        this.busy.set(true);
        this.error.set('');
        try {
            while (job.status === 'running') {
                await new Promise(r => setTimeout(r, this.pollMs));
                if (this.courseId.peek() !== job.courseId) return false;  // the panel moved on
                job = await this.client.job({ jobId: job.id });
                this.job.set(job);
                this.tick.set(this.tick.peek() + 1);
            }
            return this.showOutcome(job);
        } catch (e) {
            this.error.set(messageOf(e));
            return false;
        } finally {
            if (this.courseId.peek() === job.courseId) this.busy.set(false);
        }
    }

    /** Put a finished job's result or error on the panel. True when it succeeded. */
    private showOutcome(job: GsproExportJob): boolean {
        this.job.set(job);
        if (job.status === 'succeeded' && job.result) {
            this.lastPath.set(job.result.path);
            this.report.set(job.result.report);
            this.error.set('');
            return true;
        }
        this.lastPath.set(null);
        this.report.set([]);
        this.error.set(job.error || `${job.label} export failed`);
        return false;
    }
}

/** `Running: outer orthophoto — 1 min 12 s` / `Last export: inner heightmap, done in 8 s`. */
export function jobLabel(job: GsproExportJob | null, now = Date.now()): string {
    if (!job) return '';
    const started = Date.parse(job.startedAt);
    const end = job.finishedAt ? Date.parse(job.finishedAt) : now;
    const secs = Number.isFinite(started) && Number.isFinite(end) ? Math.max(0, Math.round((end - started) / 1000)) : 0;
    const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    if (job.status === 'running') return `Running: ${job.label} — ${elapsed}. The server keeps going if you close this panel.`;
    return job.status === 'succeeded' ? `Last export: ${job.label}, done in ${elapsed}` : `Last export: ${job.label} failed after ${elapsed}`;
}

/** Label for a vintage in the picker: `orto-l2-2025 (shown on map)`, `orto-l2-2025, patched`. */
export function orthoSourceLabel(s: GsproOrthoSource): string {
    const notes = [s.patched ? 'patched' : '', s.active && !s.patched ? 'shown on map' : ''].filter(Boolean);
    return notes.length ? `${s.collection} (${notes.join(', ')})` : s.collection;
}

/** `2010 m × 2010 m, centre 530 035 E 6 487 675 N (EPSG:3006)`. */
export function terrainLabel(t: TerrainSquare): string {
    const m = (n: number) => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
    return `${t.sideM} m × ${t.sideM} m, centre ${m(t.centre.x)} E ${m(t.centre.y)} N (EPSG:3006)`;
}

function messageOf(e: unknown): string {
    return e instanceof Error && e.message ? e.message : 'Export failed';
}
