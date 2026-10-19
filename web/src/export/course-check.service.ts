// The GSPro board's Check row, client side: is the built course whole, as the
// ball meets it? The server owns the check (`server/services/course-check.service.ts`:
// the boundary file, `golfmap.course.check` in Unity, the Review window, the
// shaping worker's `/check`); this holds what the row shows and drives it:
//
//   - `refresh(courseId)`  GET /course-check/status (the last reports' summaries,
//                          whether the meshes changed since, the running check)
//   - `run(courseId)`      POST /course-check/run, then poll GET /course-check/job
//                          to the end and refresh
//
// `bun run course:check` is the same check from the CLI. DI singleton; the
// constructor takes the API client so it is testable headlessly.

import { Computed, Signal } from '@basics/core/client/core';
import { api, ApiError } from '../api';
import type {
    CourseCheckApi, CourseCheckJob, CourseCheckStatus, CourseCheckSummary,
} from '../../../shared/api/course-check.gen';
import { agoLabel, whenLabel } from './gspro-sync.service';

/** How often a running check is polled (ms). */
export const CHECK_POLL_MS = 1500;

export class CourseCheckService {
    /** The last reports, as the server read them; null before the first refresh. */
    readonly status = new Signal<CourseCheckStatus | null>(null);
    /** The check being followed (running, or the one that just finished). */
    readonly job = new Signal<CourseCheckJob | null>(null);
    /** A refused run, a failed check, a layer that could not run, or a dead connection. */
    readonly error = new Signal<string>('');
    private readonly starting = new Signal(false);
    readonly running = new Computed<boolean>(() => this.starting.get() || this.job.get()?.status === 'running');
    /** Bumped on every poll so elapsed-time text re-renders. */
    readonly tick = new Signal<number>(0);
    private refreshSeq = 0;

    constructor(
        private readonly client: CourseCheckApi = api.courseCheck,
        private readonly pollMs = CHECK_POLL_MS,
    ) {}

    /** Read the last reports; a check running on the server (started from the CLI, another tab) is followed. */
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

    /** Run the check and follow it to its end. True when it ran in Unity and went through. */
    async run(courseId: string): Promise<boolean> {
        if (this.running.peek()) return false;
        this.error.set('');
        this.starting.set(true);
        let job: CourseCheckJob;
        try {
            job = await this.client.run({ courseId });
        } catch (e) {
            this.error.set(messageOf(e));
            this.starting.set(false);
            return false;
        }
        this.job.set(job);
        this.starting.set(false);
        return this.follow(courseId, job);
    }

    private async follow(courseId: string, job: CourseCheckJob): Promise<boolean> {
        let failures = 0;
        while (job.status === 'running') {
            await new Promise(r => setTimeout(r, this.pollMs));
            try {
                job = await this.client.job({ jobId: job.id });
                failures = 0;
            } catch (e) {
                if (e instanceof ApiError && e.status === 404) {
                    job = { ...job, status: 'failed', error: 'the server no longer knows this check (it may have restarted)' };
                } else if (++failures >= 3) {
                    this.error.set(`Lost contact with the server (${messageOf(e)}) — still trying…`);
                }
            }
            this.job.set(job);
            this.tick.set(this.tick.peek() + 1);
        }
        const result = job.result;
        const problem = job.status === 'failed' ? job.error ?? 'The course check failed'
            : !result?.unity ? result?.unitySkipped ?? 'The Unity check did not run'
                : result.warnings[0] ?? '';
        this.error.set(problem);
        await this.refresh(courseId);
        return job.status === 'succeeded' && !!result?.unity;
    }
}

// --- The words the row uses ---

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `✓` / `13 errors · 49 warnings` for one layer's report. */
export function countsLabel(s: Pick<CourseCheckSummary, 'errors' | 'warnings'>): string {
    if (s.errors === 0) return s.warnings ? `✓ · ${plural(s.warnings, 'warning')}` : '✓';
    return `${plural(s.errors, 'error')} · ${plural(s.warnings, 'warning')}`;
}

/** The row's one line: `13 errors · 49 warnings · 2 h ago · meshes changed since`, or `never checked`. */
export function checkStatusLabel(status: CourseCheckStatus | null, now = Date.now()): string {
    const unity = status?.unity;
    if (!unity) return status ? 'never checked' : '';
    const parts = [countsLabel(unity), agoLabel(unity.at, now)];
    if (unity.hole) parts.push(`hole ${unity.hole} only`);
    if (status.blender && status.blender.errors > 0) parts.push(`Blender ${plural(status.blender.errors, 'error')}`);
    if (status.meshesChangedSince) parts.push('meshes changed since');
    return parts.join(' · ');
}

/** The status line's title: each layer's report in full words. */
export function checkStatusTitle(status: CourseCheckStatus | null): string {
    if (!status) return '';
    const layer = (name: string, s: CourseCheckSummary | null) => (s
        ? `${name}: ${countsLabel(s)} — ${s.area ?? '?'}${s.hole ? `, hole ${s.hole}` : ''}${s.seconds !== null ? `, ${Math.round(s.seconds)} s` : ''}`
            + `, ${whenLabel(s.at)}\n  ${s.report}${s.counts.length ? `\n  ${s.counts.map(c => `${c.type} ${c.findings}`).join(', ')}` : ''}`
        : `${name}: no report yet`);
    const lines = [layer('Unity', status.unity), layer('Blender', status.blender)];
    if (status.meshesChangedSince) lines.push(`The meshes changed since the Unity check (${whenLabel(status.meshesChangedAt)}): check again.`);
    return lines.join('\n');
}

function messageOf(e: unknown): string {
    return e instanceof Error && e.message ? e.message : 'The course check failed';
}
