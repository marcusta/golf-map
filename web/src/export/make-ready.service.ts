// The GSPro board's Ready row, client side: is the course fit for a GSPro
// build? The server owns the run (`server/services/make-ready.service.ts`:
// `golfmap.course.ready` in Unity, the Arborist file near play, the course
// check); this holds what the row shows and drives it:
//
//   - `refresh(courseId)`    GET /courses/:id/make-ready/status (the last run's
//                            outcome, the running run)
//   - `run(courseId, fix)`   POST /courses/:id/make-ready/run, then poll
//                            GET .../job to the end and refresh
//
// `bun run course:ready` is the same run from the CLI. DI singleton; the
// constructor takes the API client so it is testable headlessly.

import { Computed, Signal } from '@basics/core/client/core';
import { api, ApiError } from '../api';
import type { MakeReadyApi, MakeReadyJob, MakeReadyStatus, MakeReadySummary } from '../../../shared/api/make-ready.gen';
import { agoLabel, whenLabel } from './gspro-sync.service';

/** How often a running run is polled (ms). */
export const READY_POLL_MS = 1500;

export class MakeReadyService {
    /** The last run's outcome, as the server read it; null before the first refresh. */
    readonly status = new Signal<MakeReadyStatus | null>(null);
    /** The run being followed (running, or the one that just finished). */
    readonly job = new Signal<MakeReadyJob | null>(null);
    /** A refused run, a failed run, a part that could not be checked, or a dead connection. */
    readonly error = new Signal<string>('');
    private readonly starting = new Signal(false);
    readonly running = new Computed<boolean>(() => this.starting.get() || this.job.get()?.status === 'running');
    /** Bumped on every poll so elapsed-time text re-renders. */
    readonly tick = new Signal<number>(0);
    private refreshSeq = 0;

    constructor(
        private readonly client: MakeReadyApi = api.makeReady,
        private readonly pollMs = READY_POLL_MS,
    ) {}

    /** Read the last outcome; a run going on the server (the CLI, another tab) is followed. */
    async refresh(courseId: string): Promise<void> {
        const seq = ++this.refreshSeq;
        try {
            const status = await this.client.status({ courseId });
            if (seq !== this.refreshSeq) return;
            this.status.set(status);
            const job = status.job;
            if (job && !this.starting.peek() && this.job.peek()?.status !== 'running') {
                this.job.set(job);
                if (job.status === 'running') void this.follow(courseId, job);
            }
        } catch (e) {
            if (seq === this.refreshSeq) this.error.set(messageOf(e));
        }
    }

    /** Run make ready (`fix`: let Unity add what is missing) and follow it to its end. True when the course is ready. */
    async run(courseId: string, fix = false): Promise<boolean> {
        if (this.running.peek()) return false;
        this.error.set('');
        this.starting.set(true);
        let job: MakeReadyJob;
        try {
            job = await this.client.run({ courseId, fix });
        } catch (e) {
            this.error.set(messageOf(e));
            this.starting.set(false);
            return false;
        }
        this.job.set(job);
        this.starting.set(false);
        return this.follow(courseId, job);
    }

    private async follow(courseId: string, job: MakeReadyJob): Promise<boolean> {
        let failures = 0;
        while (job.status === 'running') {
            await new Promise(r => setTimeout(r, this.pollMs));
            try {
                job = await this.client.job({ courseId, jobId: job.id });
                failures = 0;
            } catch (e) {
                if (e instanceof ApiError && e.status === 404) {
                    job = { ...job, status: 'failed', error: 'the server no longer knows this run (it may have restarted)' };
                } else if (++failures >= 3) {
                    this.error.set(`Lost contact with the server (${messageOf(e)}) — still trying…`);
                }
            }
            this.job.set(job);
            this.tick.set(this.tick.peek() + 1);
        }
        const result = job.result;
        this.error.set(job.status === 'failed' ? job.error ?? 'Make ready failed' : result?.blockers[0] ?? '');
        await this.refresh(courseId);
        return job.status === 'succeeded' && !!result?.ready;
    }
}

// --- The words the row uses ---

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The row's one line: `ready · 2 h ago`, `3 errors · 1 warning · 2 h ago`, `not ready: Unity closed`, `never run`. */
export function readyStatusLabel(status: MakeReadyStatus | null, now = Date.now()): string {
    const last = status?.last;
    if (!last) return status ? 'never run' : '';
    const parts: string[] = [];
    if (last.errors > 0) parts.push(plural(last.errors, 'error'));
    else if (last.ready) parts.push('ready');
    else parts.push(last.unity.skipped ? 'not ready: Unity not checked' : 'not ready');
    if (last.warnings) parts.push(plural(last.warnings, 'warning'));
    if (last.fixed) parts.push(`${last.fixed} fixed`);
    parts.push(agoLabel(last.at, now));
    return parts.join(' · ');
}

/** The status line's title: each part and category in full words. */
export function readyStatusTitle(status: MakeReadyStatus | null): string {
    const s: MakeReadySummary | null | undefined = status?.last;
    if (!s) return status ? 'Make ready has not run for this course.' : '';
    const counts = (p: { errors: number; warnings: number }) => `${plural(p.errors, 'error')} · ${plural(p.warnings, 'warning')}`;
    const lines = [
        `${s.ready ? 'Ready' : 'Not ready'} — ${whenLabel(s.at)}, within ${s.marginM} m of play${s.fix ? ', with fix' : ''}`,
        `Unity scene: ${s.unity.skipped ?? `${counts(s.unity)}${s.unity.fixed ? `, ${s.unity.fixed} fixed` : ''}`}`,
        `Arborist file: ${s.arborist.skipped ?? `${counts(s.arborist)} in ${s.arborist.instances} instances (report only)`}`,
        `Course check: ${s.check.skipped ?? `${counts(s.check)} (${s.check.source === 'run' ? 'checked then' : 'last report'})`}`,
    ];
    if (s.categories.length) {
        lines.push('', ...s.categories.map(c => `${c.category}: ${c.near}/${c.objects} near, ${c.ok} ok${c.fixed ? `, ${c.fixed} fixed` : ''}${c.findings ? `, ${c.findings} found` : ''}`));
    }
    return lines.join('\n');
}

function messageOf(e: unknown): string {
    return e instanceof Error && e.message ? e.message : 'Make ready failed';
}
