import { Signal } from '@basics/core/client/core';
import { api, API_BASE } from '../api';
import type { PhotoCleanupApi, PhotoCleanupJob } from '../../../shared/api/photo-cleanup.gen';
import type { ToolContext } from '../editor/tool';

type CleanupContext = Pick<ToolContext, 'courseId'>;

/** "1,3-5" -> [1, 3, 4, 5]; "" -> [] (every hole); null for anything else. */
export function parseHoles(spec: string): number[] | null {
    const out: number[] = [];
    for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!m || Number(m[2] ?? m[1]) < Number(m[1])) return null;
        for (let n = Number(m[1]); n <= Number(m[2] ?? m[1]); n++) out.push(n);
    }
    return out;
}

/**
 * Hole-by-hole cleanup in the Clean panel (docs/photo-cleanup.md): run it on
 * a copy of the photo, look at each hole before and after, untick the ones
 * with a defect, apply the rest as one undo step. The same PhotoCleanupService
 * as `bun run photo -- clean / accept`.
 */
export class PhotoCleanupController {
    readonly job = new Signal<PhotoCleanupJob | null>(null);
    /** Holes to run, as typed ("" = every hole). */
    readonly holes = new Signal('');
    /** Holes of the shown run the user unticked. */
    readonly skipped = new Signal<ReadonlySet<number>>(new Set());
    readonly busy = new Signal(false);
    readonly message = new Signal<{ kind: 'error' | 'info'; text: string } | null>(null);
    private ctx: CleanupContext | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        /** Called after an apply changed the photo: reload it and its tiles. */
        private onApplied: () => Promise<void> = async () => {},
        private client: PhotoCleanupApi = api.photoCleanup,
        private pollMs = 2000,
    ) {}

    activate(ctx: CleanupContext): void {
        this.ctx = ctx;
        this.job.set(null);
        this.skipped.set(new Set());
        this.message.set(null);
        void this.load(ctx);
    }

    deactivate(): void {
        this.ctx = null;
        this.stopPolling();
        this.busy.set(false);
    }

    /** The course's running or newest run. */
    private async load(ctx: CleanupContext): Promise<void> {
        try {
            const { job } = await this.client.currentPhotoCleanup({ courseId: ctx.courseId });
            if (this.ctx !== ctx) return;
            this.show(job);
        } catch {
            // The section just stays empty; Run says what is wrong.
        }
    }

    async start(): Promise<void> {
        const ctx = this.ctx;
        const holes = parseHoles(this.holes.peek());
        if (!ctx || this.busy.peek()) return;
        if (!holes) {
            this.message.set({ kind: 'error', text: 'Holes: numbers and ranges, e.g. 1-9 or 3,5' });
            return;
        }
        this.busy.set(true);
        this.message.set(null);
        try {
            const job = await this.client.startPhotoCleanup({ courseId: ctx.courseId, ...(holes.length ? { holes } : {}) });
            if (this.ctx !== ctx) return;
            this.skipped.set(new Set());
            this.show(job);
        } catch (e) {
            if (this.ctx === ctx) this.message.set({ kind: 'error', text: (e as Error).message });
        } finally {
            if (this.ctx === ctx) this.busy.set(false);
        }
    }

    toggle(hole: number, accepted: boolean): void {
        const next = new Set(this.skipped.peek());
        if (accepted) next.delete(hole); else next.add(hole);
        this.skipped.set(next);
    }

    /** The cleaned holes that changed something and are still ticked. */
    accepted(): number[] {
        const skipped = this.skipped.get();
        return (this.job.get()?.holes ?? []).filter(h => h.status === 'done' && h.changedPx > 0 && !skipped.has(h.hole)).map(h => h.hole);
    }

    canApply(): boolean {
        const job = this.job.get();
        return !this.busy.get() && job?.status === 'succeeded' && !job.applied && this.accepted().length > 0;
    }

    async apply(): Promise<void> {
        const ctx = this.ctx;
        const job = this.job.peek();
        if (!ctx || !job || !this.canApply()) return;
        const holes = this.accepted();
        this.busy.set(true);
        this.message.set({ kind: 'info', text: 'Writing the holes into the photo and its map tiles…' });
        try {
            const r = await this.client.applyPhotoCleanup({ courseId: ctx.courseId, jobId: job.id, holes });
            if (this.ctx !== ctx) return;
            this.show(r.job);
            this.message.set({ kind: 'info', text: r.import.changed
                ? `Applied: ${r.import.changedPixels.toLocaleString('en-US')} px changed. Update photo puts it on the meshes.`
                : 'Those holes changed no pixels.' });
            if (r.import.changed) await this.onApplied();
        } catch (e) {
            if (this.ctx === ctx) this.message.set({ kind: 'error', text: (e as Error).message });
        } finally {
            if (this.ctx === ctx) this.busy.set(false);
        }
    }

    /** One hole's before | after image of the shown run. */
    imageUrl(hole: number, kind: 'review' | 'detect' | 'overlay' = 'review'): string | null {
        const ctx = this.ctx;
        const job = this.job.peek();
        if (!ctx || !job) return null;
        return `${API_BASE}/photo-cleanup/${encodeURIComponent(ctx.courseId)}/${job.id}/${hole}/${kind}.png`;
    }

    private show(job: PhotoCleanupJob | null): void {
        this.job.set(job);
        this.stopPolling();
        if (job?.status === 'running') this.timer = setTimeout(() => void this.poll(), this.pollMs);
    }

    private async poll(): Promise<void> {
        const ctx = this.ctx;
        const job = this.job.peek();
        this.timer = null;
        if (!ctx || !job) return;
        try {
            const next = await this.client.photoCleanupJob({ courseId: ctx.courseId, jobId: job.id });
            if (this.ctx === ctx) this.show(next);
        } catch {
            if (this.ctx === ctx) this.timer = setTimeout(() => void this.poll(), this.pollMs * 2);
        }
    }

    private stopPolling(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }
}
