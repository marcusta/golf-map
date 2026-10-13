// The GSPro status board, client side: one row per TARGET (the thing you
// changed in the editor — terrain, photo, shapes, meshes, vegetation, trees,
// buildings, creeks, course file) with "last updated / what changed since /
// Update", the open Unity editor, the shaping worker and the update job in
// flight.
//
// The server owns the knowledge (`server/services/gspro-sync.service.ts`,
// docs/gspro/export.md "The GSPro status board"): what is stale, what blocks
// a target, what an update's chain is. This service only holds what the board
// shows and drives the one verb:
//
//   - `refresh(courseId)`            GET /gspro-sync/status
//   - `update(courseId, target)`     POST /gspro-sync/update, then poll
//                                    GET /gspro-sync/job to the end and
//                                    refresh the board
//
// Updates QUEUE per course on the server, so a job comes back `queued` rather
// than refused; the poll follows it through queued → running → succeeded. The
// 409s that remain (a blocked target asked for by name) land in `error`.
//
// The board is re-fetched every 30 s while the dialog is open: edits are made
// in the other modes (Draw, Terrain editor, Vegetation), so what is stale
// changes under it without anything happening here.
//
// DI singleton; `GsproExportPanelComponent` is the UI and the command bar
// reads `staleCount` for its menu row. Testable headlessly — the constructor
// takes the API client.

import { Signal } from '@basics/core/client/core';
import { api } from '../api';
import type {
    GsproSyncApi, GsproSyncStatus, GsproSyncJob, GsproTargetStatus, ChangeCount,
} from '../../../shared/api/gspro-sync.gen';
import type { GsproTargetId } from '../../../shared/gspro-targets';

/** How often a running or queued update job is polled (ms); tests pass something tiny. */
export const DEFAULT_POLL_MS = 1500;

/** How often the board re-reads the status while the dialog is open (ms). */
export const DEFAULT_REFRESH_MS = 30_000;

export class GsproSyncService {
    /** Course the board is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    /** The whole board as the server sees it; null before the first refresh. */
    readonly status = new Signal<GsproSyncStatus | null>(null);
    /** The update job being followed (running, queued, or the one that just finished). */
    readonly job = new Signal<GsproSyncJob | null>(null);
    /** An update is on its way, waiting in the queue or running. */
    readonly running = new Signal<boolean>(false);
    /** Targets that are stale and runnable — what "Update all stale" would take. */
    readonly staleCount = new Signal<number>(0);
    /** The last failure: a refused update (409), a failed job or a dead connection. */
    readonly error = new Signal<string>('');
    /** True while the status is being fetched. */
    readonly loading = new Signal<boolean>(false);
    /** Bumped on every poll so elapsed-time text re-renders. */
    readonly tick = new Signal<number>(0);

    /** True between the update request and the job's end, before the first poll answers. */
    private starting = false;
    private refreshTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly client: GsproSyncApi = api.gsproSync,
        private readonly pollMs = DEFAULT_POLL_MS,
        private readonly refreshMs = DEFAULT_REFRESH_MS,
    ) {}

    get isOpen(): boolean {
        return this.courseId.peek() !== null;
    }

    /**
     * Open the board for a course: read the status now, then keep it fresh
     * while it stays open (edits happen in the other modes).
     */
    async openFor(courseId: string): Promise<void> {
        const same = this.courseId.peek() === courseId;
        this.courseId.set(courseId);
        this.error.set('');
        if (!same) {
            this.status.set(null);
            this.job.set(null);
            this.staleCount.set(0);
            this.recompute();
        }
        this.startRefreshing(courseId);
        await this.refresh(courseId);
    }

    /** Close the board; a job the server is running keeps going. */
    close(): void {
        this.courseId.set(null);
        this.stopRefreshing();
    }

    private startRefreshing(courseId: string): void {
        this.stopRefreshing();
        const timer = setInterval(() => {
            if (this.courseId.peek() !== courseId || this.running.peek()) return;
            void this.refresh(courseId);
        }, this.refreshMs);
        // A background re-read must not hold the process (tests, a closed tab).
        (timer as unknown as { unref?: () => void }).unref?.();
        this.refreshTimer = timer;
    }

    private stopRefreshing(): void {
        if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    /**
     * Read the board. Keeps the job we are following (the server's `job` is
     * the same one while it runs, and its last one after), and leaves `error`
     * alone so a failed job's reason survives the refresh that follows it.
     */
    async refresh(courseId: string): Promise<void> {
        this.loading.set(true);
        try {
            const status = await this.client.status({ courseId });
            // The board moved to another course (or closed) while this was in flight.
            const open = this.courseId.peek();
            if (open !== null && open !== courseId) return;
            this.status.set(status);
            this.staleCount.set(status.targets.filter(t => t.stale && t.blocked === null).length);
            if (!this.starting && status.job) this.job.set(status.job);
            this.recompute();
        } catch (e) {
            this.error.set(messageOf(e));
        } finally {
            this.loading.set(false);
        }
    }

    /**
     * Run one target's whole chain — or `'stale'` for every stale, runnable
     * target in board order — and follow the job to its end, then re-read the
     * board. False when the update was refused or the job failed.
     */
    async update(courseId: string, target: GsproTargetId | 'stale'): Promise<boolean> {
        if (this.running.peek()) return false;
        this.error.set('');
        this.starting = true;
        this.recompute();
        let job: GsproSyncJob;
        try {
            job = await this.client.update({ courseId, target });
        } catch (e) {
            // A blocked target asked for by name comes back 409 with its reason.
            this.error.set(messageOf(e));
            this.starting = false;
            this.recompute();
            return false;
        }
        const ok = await this.follow(job);
        this.starting = false;
        this.recompute();
        await this.refresh(courseId);
        return ok;
    }

    /** Poll a job through queued → running to its end. True when it succeeded. */
    private async follow(job: GsproSyncJob): Promise<boolean> {
        this.job.set(job);
        this.recompute();
        try {
            while (job.status === 'queued' || job.status === 'running') {
                await new Promise(r => setTimeout(r, this.pollMs));
                job = await this.client.job({ jobId: job.id });
                this.job.set(job);
                this.recompute();
                this.tick.set(this.tick.peek() + 1);
            }
        } catch (e) {
            this.error.set(messageOf(e));
            return false;
        }
        if (job.status !== 'succeeded') {
            this.error.set(job.error || 'The GSPro update failed');
            return false;
        }
        const failed = job.results.find(r => r.error);
        if (failed) {
            this.error.set(`${failed.label}: ${failed.error}`);
            return false;
        }
        return true;
    }

    private recompute(): void {
        const job = this.job.peek();
        this.running.set(this.starting || job?.status === 'queued' || job?.status === 'running');
    }

    /** One target's row, or null before the first refresh. */
    target(id: GsproTargetId): GsproTargetStatus | null {
        return this.status.peek()?.targets.find(t => t.id === id) ?? null;
    }

    /** The targets in board order, empty before the first refresh. */
    get targets(): GsproTargetStatus[] {
        return this.status.get()?.targets ?? [];
    }

    /** `Unity: vreta_v4_2025_12_02 · course Vreta`, or that it is not open for this course. */
    unityLabel(): string {
        const unity = this.status.get()?.unity;
        if (!unity) return 'Unity: …';
        if (!unity.matched) return 'Unity: not open for this course';
        const editor = unity.editors.find(e => e.matches);
        const course = editor?.activeCourse;
        return `Unity: ${unity.matched}${course ? ` · course ${course}` : ''}`;
    }

    /** What the chip's title says: every open editor, what it has active, and why one does not answer. */
    unityTitle(): string {
        const unity = this.status.get()?.unity;
        if (!unity) return '';
        const lines = unity.editors.map(e => {
            if (e.error) return `${e.projectName}: ${e.error}`;
            const course = e.activeCourse ?? 'no course';
            return `${e.projectName}: ${course}${e.exportFolder ? ` → ${e.exportFolder}` : ''}`;
        });
        if (lines.length === 0) lines.push('No Unity editor is open.');
        return [...lines, `This course exports to ${unity.exportDir}`].join('\n');
    }

    /** The running job's wait reason — what it is queued behind — or ''. */
    queuedBehind(): string {
        const job = this.job.get();
        if (job?.status !== 'queued') return '';
        const wait = job.phases.find(p => p.id === 'wait');
        return wait ? wait.label.replace(/^Waiting for /, '') : '';
    }
}

// --- The words the board uses ---

/** `2 h ago` / `3 days ago` / `never`. */
export function agoLabel(iso: string | null, now = Date.now()): string {
    if (!iso) return 'never';
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return 'never';
    const secs = Math.max(0, Math.round((now - then) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** The absolute time behind that, for the row's title. */
export function whenLabel(iso: string | null): string {
    if (!iso) return 'Never updated from here';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'Never updated from here' : d.toLocaleString();
}

/** `about 40 s` / `about 3 min` — how long the last update of a target took. */
export function aboutLabel(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 90) return `about ${Math.round(seconds)} s`;
    return `about ${Math.round(seconds / 60)} min`;
}

/** `8 s` / `2 min 5 s` — a job's or phase's own time. */
export function secsLabel(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

/**
 * The feature types the server counts, in the plural the board says them in.
 * Anything else (the non-feature kinds — `terrain edits`, `cleaned photo`,
 * `unapplied edits`, `recipes`, `building pads`, `holes`, …) is already a
 * word of its own and goes through as it is.
 */
const FEATURE_KINDS: Record<string, string> = {
    green: 'greens', tee: 'tees', fairway: 'fairways', bunker: 'bunkers',
    semi_rough: 'semi rough', rough: 'rough', deep_rough: 'deep rough',
    water: 'water', water_creek: 'creeks', path: 'paths', trees: 'trees',
    rock_slab: 'rock slabs', vegetation_zone: 'vegetation zones',
    tree_area: 'tree areas', power_line: 'power lines',
};

export function kindLabel(kind: string): string {
    return FEATURE_KINDS[kind] ?? kind.replace(/_/g, ' ');
}

/**
 * `14 features changed (9 paths, 3 bunkers, 2 tees)` is what the server can
 * tell us without per-kind counts: `14 features changed (paths, bunkers,
 * tees)` when every kind is a drawn feature type, `2 changes (terrain edits)`
 * when they are not, and `up to date` when nothing moved.
 */
export function changedLabel(changed: ChangeCount): string {
    if (changed.count === 0) return 'up to date';
    const features = changed.kinds.length > 0 && changed.kinds.every(k => k in FEATURE_KINDS);
    const noun = features
        ? (changed.count === 1 ? 'feature changed' : 'features changed')
        : (changed.count === 1 ? 'change' : 'changes');
    const kinds = changed.kinds.map(kindLabel).join(', ');
    return kinds ? `${changed.count} ${noun} (${kinds})` : `${changed.count} ${noun}`;
}

/** The row's one line: when it last ran, and what has changed since. */
export function rowStatusLabel(row: GsproTargetStatus, now = Date.now()): string {
    const ago = agoLabel(row.lastRun, now);
    if (row.lastRun === null) return 'never';
    return `${ago} · ${changedLabel(row.changedSince)}`;
}

function messageOf(e: unknown): string {
    return e instanceof Error && e.message ? e.message : 'The GSPro update failed';
}
