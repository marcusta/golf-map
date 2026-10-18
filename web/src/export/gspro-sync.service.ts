// The GSPro status board, client side: one row per TARGET (the thing you
// changed in the editor — terrain, photo, shapes, meshes, vegetation, trees,
// buildings, props, creeks, waterfalls, course file) with "last updated / what
// changed since / Update", the open Unity editor, the shaping worker and the
// update job in flight.
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
// 409s that remain (a blocked target asked for by name) land in `error`. A
// poll that fails is retried (the job runs in the server either way) and only
// a job the server has forgotten (404, it restarted) ends the follow.
//
// The board is re-fetched every 30 s while the dialog is open: edits are made
// in the other modes (Draw, Terrain editor, Vegetation), so what is stale
// changes under it without anything happening here.
//
// DI singleton; `GsproExportPanelComponent` is the UI and the command bar
// reads `staleCount` for its menu row. Testable headlessly — the constructor
// takes the API client.

import { Computed, Signal } from '@basics/core/client/core';
import { api, ApiError } from '../api';
import type {
    GsproSyncApi, GsproSyncStatus, GsproSyncJob, GsproTargetStatus, ChangeCount, ExportBuild,
} from '../../../shared/api/gspro-sync.gen';
import type { GsproTargetId } from '../../../shared/gspro-targets';

/** How often a running or queued update job is polled (ms); tests pass something tiny. */
export const DEFAULT_POLL_MS = 1500;

/** How often the board re-reads the status while the dialog is open (ms). */
export const DEFAULT_REFRESH_MS = 30_000;

/** Failed polls in a row before the board says it lost contact. */
const LOST_AFTER = 3;

/** How a poll that found no job explains itself (the server keeps jobs in memory). */
const FORGOTTEN = 'the server no longer knows this job (the server may have restarted). '
    + 'What it had already written is in the export folder: re-read the board and update again if a row is still stale.';

/** The "still trying" line, so a successful poll can tell it from a real failure. */
const lostLine = (why: string) => `Lost contact with the server (${why}) — still trying…`;

export class GsproSyncService {
    /** Course the board is open for; null = closed. */
    readonly courseId = new Signal<string | null>(null);
    /** The whole board as the server sees it; null before the first refresh. */
    readonly status = new Signal<GsproSyncStatus | null>(null);
    /** The update job being followed (running, queued, or the one that just finished). */
    readonly job = new Signal<GsproSyncJob | null>(null);
    /** True between the update request and the job's end, before the first poll answers. */
    private readonly starting = new Signal(false);
    /**
     * An update is on its way, waiting in the queue or running — derived, so a
     * poll that never answers cannot leave the board busy for the session.
     */
    readonly running = new Computed<boolean>(() => {
        const status = this.job.get()?.status;
        return this.starting.get() || status === 'queued' || status === 'running';
    });
    /** Targets that are stale and runnable — what "Update all stale" would take. */
    readonly staleCount = new Signal<number>(0);
    /** The last failure: a refused update (409), a failed job or a dead connection. */
    readonly error = new Signal<string>('');
    /** True while the status is being fetched. */
    readonly loading = new Signal<boolean>(false);
    /** Bumped on every poll so elapsed-time text re-renders. */
    readonly tick = new Signal<number>(0);

    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    /** Bumped per `refresh`; only the newest read's answer is applied. */
    private refreshSeq = 0;
    /** A job we gave up on (404); a later status read must not put it back as running. */
    private forgotten: string | null = null;

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
     *
     * Two reads can be in flight at once (a course switch, or the run's own
     * re-read against the 30 s tick), so each takes a sequence number and
     * only the newest one's answer is applied: an older one landing last
     * would show another course's rows or put back the stale count the run
     * just cleared.
     */
    async refresh(courseId: string): Promise<void> {
        const seq = ++this.refreshSeq;
        const newest = () => seq === this.refreshSeq;
        this.loading.set(true);
        try {
            const status = await this.client.status({ courseId });
            if (!newest()) return;
            // The board moved to another course (or closed) while this was in flight.
            const open = this.courseId.peek();
            if (open !== null && open !== courseId) return;
            this.status.set(status);
            this.staleCount.set(status.targets.filter(t => t.stale && t.blocked === null).length);
            if (!this.starting.peek() && status.job && status.job.id !== this.forgotten) this.job.set(status.job);
        } catch (e) {
            if (newest()) this.error.set(messageOf(e));
        } finally {
            // A newer read is still working: it owns `loading` now.
            if (newest()) this.loading.set(false);
        }
    }

    /**
     * Run one target's whole chain — or `'stale'` for every stale, runnable
     * target in board order — and follow the job to its end, then re-read the
     * board. False when the update was refused or the job failed.
     */
    async update(courseId: string, target: GsproTargetId | 'stale'): Promise<boolean> {
        if (this.running.peek()) {
            // Say which run holds the board: the caller's dialog has nothing else to show.
            const step = this.job.peek()?.step?.trim();
            this.error.set(`A GSPro update is already running${step ? `: ${step}` : ''}`);
            return false;
        }
        this.error.set('');
        this.starting.set(true);
        this.forgotten = null;
        let job: GsproSyncJob;
        try {
            job = await this.client.update({ courseId, target });
        } catch (e) {
            // A blocked target asked for by name comes back 409 with its reason.
            this.error.set(messageOf(e));
            this.starting.set(false);
            return false;
        }
        const ok = await this.follow(job);
        this.starting.set(false);
        await this.refresh(courseId);
        return ok;
    }

    /**
     * Poll a job through queued → running to its end. True when it succeeded.
     *
     * A poll that fails is retried — the job goes on in the server either way
     * — and after a few in a row `error` says contact was lost (cleared again
     * by the next poll that answers). A job the server no longer knows (404:
     * it restarted, jobs live in its memory) ends as failed with that
     * explanation instead of being polled forever. The same hardening as
     * `ShapingService.poll`; it is mirrored rather than shared because the
     * two loops differ in nearly everything around the retry (job states,
     * where the lost-contact line goes, what they resolve with) and
     * shaping.service.ts is outside this change's files.
     */
    private async follow(job: GsproSyncJob): Promise<boolean> {
        this.show(job);
        let failures = 0;
        let lost = false;
        while (job.status === 'queued' || job.status === 'running') {
            await new Promise(r => setTimeout(r, this.pollMs));
            let next: GsproSyncJob;
            try {
                next = await this.client.job({ jobId: job.id });
            } catch (e) {
                if (e instanceof ApiError && e.status === 404) {
                    this.forgotten = job.id;
                    job = { ...job, status: 'failed', finishedAt: new Date().toISOString(), error: FORGOTTEN };
                    this.show(job);
                    break;
                }
                if (++failures >= LOST_AFTER) {
                    lost = true;
                    this.error.set(lostLine(messageOf(e)));
                }
                continue;
            }
            failures = 0;
            if (lost) {
                lost = false;
                if (this.error.peek().startsWith('Lost contact with the server')) this.error.set('');
            }
            job = next;
            this.show(job);
            this.tick.set(this.tick.peek() + 1);
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

    /**
     * The job to the board. A view that throws while updating is logged, not
     * taken for a failed poll: it must not stop the follow, or the board would
     * stay busy for the rest of the session.
     */
    private show(job: GsproSyncJob): void {
        try {
            this.job.set(job);
        } catch (e) {
            console.error('GSPro board: showing the job failed', e);
        }
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
    tree_area: 'tree areas', power_line: 'power lines', waterfall: 'waterfalls',
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

const BUILD_MARK: Record<string, string> = { ok: '✓', failed: '✗', pending: '…' };
const BUILD_WORD: Record<string, string> = { ok: 'built', failed: 'failed', pending: 'building' };

/** One SVG export on the Shapes row's OPCD line. */
export interface BuildMark {
    /** `13:17 ✓` (today) or `16/10 17:11 ✓`. */
    text: string;
    title: string;
    outcome: 'ok' | 'failed' | 'pending' | 'unknown';
    lastGood: boolean;
}

/**
 * The Shapes row's OPCD line, newest export first: ✓ built, ✗ failed, … still
 * building, ? not checked yet (`opcd:build -- <course> --status` fills it in).
 * The details go in the title; the last good export is marked.
 */
export function buildMarks(builds: ExportBuild[], now = new Date()): BuildMark[] {
    return builds.map(b => {
        const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})/.exec(b.snapshot);
        const today = !!m && +m[1] === now.getFullYear() && +m[2] === now.getMonth() + 1 && +m[3] === now.getDate();
        const time = m ? `${today ? '' : `${+m[3]}/${+m[2]} `}${m[4]}:${m[5]}` : b.snapshot;
        const what = b.outcome
            ? `OPCD ${BUILD_WORD[b.outcome]} (${b.status ?? ''}, created ${b.opcdCreated ?? '?'} OPCD time)`
            : 'no OPCD build recorded';
        return {
            text: `${time} ${b.outcome ? BUILD_MARK[b.outcome] : '?'}`,
            title: `Export ${b.snapshot}: ${what}${b.lastGood ? ' — last good' : ''}`,
            outcome: b.outcome ?? 'unknown',
            lastGood: b.lastGood,
        };
    });
}

function messageOf(e: unknown): string {
    return e instanceof Error && e.message ? e.message : 'The GSPro update failed';
}
