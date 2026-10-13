// The phase bookkeeping of a long job the web polls: an ordered list of
// phases, each with its own status, live detail and elapsed seconds, plus the
// one-line `step` a panel shows while it runs.
//
// Shared by `ShapingService` (a fixed five-phase apply) and
// `GsproSyncService` (a chain built per target, phases added as the job is
// planned), so both report in the same shape and the web can render one
// component for either.

export type JobPhaseStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface JobPhase<Id extends string = string> {
    id: Id;
    /** "Generating layers", "Heightmaps", "Unity terrain". */
    label: string;
    status: JobPhaseStatus;
    /** What it is doing now, or what it did / why it was skipped or failed. */
    detail: string | null;
    /** Seconds so far (running) or taken (done, failed); null while pending or skipped. */
    seconds: number | null;
}

/** Tenths of a second, as every job in the server reports its timings. */
export function secs(ms: number): number {
    return Math.round(ms / 100) / 10;
}

/** The statuses a job itself can be in, as `step()` phrases them. */
export type JobRunStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * One job's phases. Mutated by the job as it runs; `snapshot()` is what goes
 * out over the API (a copy, with the running phase's seconds counted up to
 * now).
 */
export class JobPhases<Id extends string = string> {
    private readonly list: JobPhase<Id>[] = [];
    private readonly startedAt = new Map<Id, number>();
    /** The running phase (the failed one once it failed); null before the first and once done. */
    current: Id | null = null;

    constructor(defs: ReadonlyArray<readonly [Id, string]> = []) {
        for (const [id, label] of defs) this.add(id, label);
    }

    /** Append a phase (a chain planned at enqueue time). */
    add(id: Id, label: string): void {
        this.list.push({ id, label, status: 'pending', detail: null, seconds: null });
    }

    has(id: Id): boolean {
        return this.list.some(p => p.id === id);
    }

    private phase(id: Id): JobPhase<Id> {
        const p = this.list.find(q => q.id === id);
        if (!p) throw new Error(`No job phase '${String(id)}'`);
        return p;
    }

    begin(id: Id, detail: string): void {
        const p = this.phase(id);
        p.status = 'running';
        p.detail = detail;
        this.startedAt.set(id, Date.now());
        this.current = id;
    }

    /** The running phase's detail (what it is doing now). */
    note(detail: string): void {
        const p = this.list.find(q => q.id === this.current);
        if (p?.status === 'running') p.detail = detail;
    }

    end(id: Id, status: 'done' | 'failed', detail: string | null): void {
        const p = this.phase(id);
        p.status = status;
        p.detail = detail;
        const t0 = this.startedAt.get(id);
        if (t0 !== undefined) p.seconds = secs(Date.now() - t0);
    }

    skip(id: Id, why: string): void {
        const p = this.phase(id);
        p.status = 'skipped';
        p.detail = why;
    }

    /** Every phase still pending skipped with the same reason (a chain cut short). */
    skipPending(why: string): void {
        for (const p of this.list) if (p.status === 'pending') this.skip(p.id, why);
    }

    /** The running phase failed with `error` — what a job's catch does before it rethrows. */
    failCurrent(error: string): void {
        const p = this.list.find(q => q.id === this.current);
        if (p?.status === 'running') this.end(p.id, 'failed', error);
    }

    /** A copy, the running phase's seconds counted up to now. */
    snapshot(): JobPhase<Id>[] {
        const now = Date.now();
        return this.list.map((p) => {
            const t0 = this.startedAt.get(p.id);
            return p.status === 'running' && t0 !== undefined ? { ...p, seconds: secs(now - t0) } : { ...p };
        });
    }

    /** One line: what the job is doing now (with the phase's elapsed seconds), or did last. */
    step(status: JobRunStatus, error: string | null): string {
        const phase = this.snapshot().find(p => p.id === this.current);
        if (status === 'succeeded') return 'done';
        if (status === 'failed') return `failed${phase ? ` (${phase.label.toLowerCase()})` : ''}: ${error ?? 'unknown error'}`;
        if (status === 'queued') return 'queued';
        if (phase) return `${phase.label}${phase.detail ? ` — ${phase.detail}` : ''} (${phase.seconds ?? 0} s)`;
        return 'starting';
    }
}
