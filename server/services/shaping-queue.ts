// The shaping queue (docs/shaping-queue.md): one Blender run serves every
// request that came in before it started, because the run regenerates the
// layers from the database and so covers every change saved by then.
//
// State is files under one folder, so the web server and every
// `bun run shaping` process (which runs without the server) share it:
//
//   requests/<id>.json  one per call: course, note, region / featureIds, flags,
//                       state queued → running (runId) → done (ok | error)
//   lease.json          the process that runs batches now: token, pid, heartbeat
//   runs/<id>.json      a run: its requests, the job snapshot (rewritten while it
//                       runs), then the result and one slice per request
//
// Only the lease holder changes a request's state or writes a run; anyone may
// add a request. A lease whose heartbeat is older than `staleMs`, or whose pid
// is gone, is taken over, and the requests it left `running` are queued again.
// Every write is a temp file renamed into place, so a reader never sees half a
// file (it may see none: reads that fail to parse count as missing).
import * as path from 'node:path';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';

/** What a request asks of the run that serves it. */
export interface QueueFlags {
    dryRun: boolean;
    paths: boolean;
    save: boolean;
    skipUnity: boolean;
}

/** An EPSG:3006 box: east min, north min, east max, north max. */
export type Region3006 = [number, number, number, number];

export type QueueRequestState = 'queued' | 'running' | 'done';

export interface QueueRequest {
    id: string;
    courseId: string;
    /** One line: what the caller changed (a bead id, "hole 7 tee"). */
    note: string | null;
    region: Region3006 | null;
    featureIds: string[];
    flags: QueueFlags;
    /** ISO. */
    createdAt: string;
    pid: number;
    state: QueueRequestState;
    runId: string | null;
    /** Set when done: did the run succeed. */
    ok: boolean | null;
    error: string | null;
}

export type NewQueueRequest = Pick<QueueRequest, 'courseId' | 'note' | 'region' | 'featureIds' | 'flags'>;

/** One request's part of a run's result. */
export interface RequestSlice {
    /** No region and no features: the whole result. */
    whole: boolean;
    changedObjects: string[];
    places: unknown[];
    warnings: string[];
    /** "also changed here in this run: <note>", one per other request whose region meets this one. */
    overlaps: string[];
}

export interface QueueRun<Job = unknown, Result = unknown> {
    id: string;
    courseId: string;
    requestIds: string[];
    startedAt: string;
    finishedAt: string | null;
    job: Job;
    result: Result | null;
    error: string | null;
    slices: Record<string, RequestSlice>;
}

export interface QueueLease {
    token: string;
    pid: number;
}

interface LeaseFile extends QueueLease {
    since: string;
    /** ms since epoch. */
    heartbeat: number;
}

export interface ShapingQueueOptions {
    /** A lease with no heartbeat for this long is taken over (default 2 min). */
    staleMs?: number;
    /** Whether the process holding a lease is still there (default: `process.kill(pid, 0)`). */
    alive?: (pid: number) => boolean;
}

/** A place within this of a request's region belongs to it (m). */
export const REGION_GROW_M = 5;
/** Done requests and runs older than this are pruned when a lease is taken. */
export const QUEUE_KEEP_DAYS = 7;

export class ShapingQueue {
    readonly dir: string;
    private readonly staleMs: number;
    private readonly alive: (pid: number) => boolean;

    constructor(dir: string, opts: ShapingQueueOptions = {}) {
        this.dir = dir;
        this.staleMs = opts.staleMs ?? 120_000;
        this.alive = opts.alive ?? pidAlive;
    }

    private get requestsDir() { return path.join(this.dir, 'requests'); }
    private get runsDir() { return path.join(this.dir, 'runs'); }
    private get leaseFile() { return path.join(this.dir, 'lease.json'); }

    async submit(input: NewQueueRequest): Promise<QueueRequest> {
        const req: QueueRequest = {
            id: newId(), ...input, createdAt: new Date().toISOString(), pid: process.pid,
            state: 'queued', runId: null, ok: null, error: null,
        };
        await this.writeRequest(req);
        return req;
    }

    async get(id: string): Promise<QueueRequest | null> {
        return readJson<QueueRequest>(path.join(this.requestsDir, `${safeId(id)}.json`));
    }

    /** Every request, oldest first. */
    async list(): Promise<QueueRequest[]> {
        const names = await readdirOrEmpty(this.requestsDir);
        const all = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => readJson<QueueRequest>(path.join(this.requestsDir, n))));
        return all.filter((r): r is QueueRequest => r !== null).sort(byCreated);
    }

    async readRun<Job, Result>(id: string): Promise<QueueRun<Job, Result> | null> {
        return readJson<QueueRun<Job, Result>>(path.join(this.runsDir, `${safeId(id)}.json`));
    }

    /** The newest run of a course, else null. */
    async latestRun<Job, Result>(courseId: string): Promise<QueueRun<Job, Result> | null> {
        const names = await readdirOrEmpty(this.runsDir);
        const runs = await Promise.all(names.filter(n => n.endsWith('.json')).map(n => readJson<QueueRun<Job, Result>>(path.join(this.runsDir, n))));
        return runs.filter((r): r is QueueRun<Job, Result> => r !== null && r.courseId === courseId)
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) ?? null;
    }

    /** The lease as it is on disk and whether it is live; null when nobody holds it. */
    async holder(): Promise<(LeaseFile & { live: boolean }) | null> {
        const lease = await readJson<LeaseFile>(this.leaseFile);
        return lease ? { ...lease, live: this.live(lease) } : null;
    }

    /**
     * Take the lease, or null when a live holder has it. A stale lease is taken
     * over. Whoever takes it puts the requests a previous holder left `running`
     * back in the queue (only the holder runs them, so they are orphans).
     */
    async tryLease(): Promise<QueueLease | null> {
        await mkdir(this.dir, { recursive: true });
        const lease: LeaseFile = { token: newId(), pid: process.pid, since: new Date().toISOString(), heartbeat: Date.now() };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await writeFile(this.leaseFile, JSON.stringify(lease), { flag: 'wx' });
                await this.requeueOrphans();
                await this.prune();
                return { token: lease.token, pid: lease.pid };
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            }
            const current = await readJson<LeaseFile>(this.leaseFile);
            if (current && this.live(current)) return null;
            if (!current) continue;  // gone, or mid-write: try once more
            // Stale: move it aside, then check we moved that one and not a fresh lease taken meanwhile.
            const aside = path.join(this.dir, `lease.stale-${newId()}.json`);
            try {
                await rename(this.leaseFile, aside);
            } catch {
                continue;
            }
            const moved = await readJson<LeaseFile>(aside);
            if (moved && moved.token !== current.token && this.live(moved)) {
                await rename(aside, this.leaseFile).catch(() => undefined);
                return null;
            }
            await unlink(aside).catch(() => undefined);
        }
        return null;
    }

    /** Keep the lease live. False when it is no longer ours (taken over after going stale). */
    async beat(lease: QueueLease): Promise<boolean> {
        const current = await readJson<LeaseFile>(this.leaseFile);
        if (!current || current.token !== lease.token) return false;
        await writeAtomic(this.leaseFile, { ...current, heartbeat: Date.now() });
        return true;
    }

    async release(lease: QueueLease): Promise<void> {
        const current = await readJson<LeaseFile>(this.leaseFile);
        if (current?.token === lease.token) await unlink(this.leaseFile).catch(() => undefined);
    }

    /**
     * The next batch, marked running under a new run id; null when nothing is
     * queued. A batch is every queued request of one course with the same
     * `dryRun`: the course `prefer` names when it has one queued (the worker
     * holds it: no reload), else the oldest request's.
     */
    async takeBatch(lease: QueueLease, prefer: string | null = null): Promise<{ runId: string; requests: QueueRequest[] } | null> {
        if (!await this.beat(lease)) return null;
        const queued = (await this.list()).filter(r => r.state === 'queued');
        if (queued.length === 0) return null;
        const first = queued.find(r => r.courseId === prefer) ?? queued[0]!;
        const requests = queued.filter(r => r.courseId === first.courseId && r.flags.dryRun === first.flags.dryRun);
        const runId = newId();
        for (const r of requests) await this.writeRequest({ ...r, state: 'running', runId });
        return { runId, requests: requests.map(r => ({ ...r, state: 'running', runId })) };
    }

    async writeRun(run: QueueRun): Promise<void> {
        await mkdir(this.runsDir, { recursive: true });
        await writeAtomic(path.join(this.runsDir, `${safeId(run.id)}.json`), run);
    }

    /** The batch's requests done, with how the run went. */
    async finish(requests: QueueRequest[], ok: boolean, error: string | null): Promise<void> {
        for (const r of requests) await this.writeRequest({ ...r, state: 'done', ok, error });
    }

    private live(lease: LeaseFile): boolean {
        return Date.now() - lease.heartbeat < this.staleMs && this.alive(lease.pid);
    }

    private async requeueOrphans(): Promise<void> {
        for (const r of await this.list()) {
            if (r.state === 'running') await this.writeRequest({ ...r, state: 'queued', runId: null });
        }
    }

    private async prune(): Promise<void> {
        const cutoff = Date.now() - QUEUE_KEEP_DAYS * 86_400_000;
        for (const r of await this.list()) {
            if (r.state === 'done' && Date.parse(r.createdAt) < cutoff) await rm(path.join(this.requestsDir, `${r.id}.json`), { force: true });
        }
        for (const name of await readdirOrEmpty(this.runsDir)) {
            const file = path.join(this.runsDir, name);
            const st = await stat(file).catch(() => null);
            if (st && st.mtimeMs < cutoff) await rm(file, { force: true });
        }
    }

    private async writeRequest(req: QueueRequest): Promise<void> {
        await mkdir(this.requestsDir, { recursive: true });
        await writeAtomic(path.join(this.requestsDir, `${safeId(req.id)}.json`), req);
    }
}

// --- Slices ---

interface SliceInput {
    changedObjects: string[];
    warnings: string[];
    places: unknown[];
}

/**
 * A request's part of a run: the places that meet its region (grown by
 * REGION_GROW_M) or name one of its features, their objects, the warnings that
 * name one of those objects plus the ones that name no changed object at all
 * (they concern everyone), and one line per other request of the batch whose
 * region meets this one's. A request with no region and no features gets it all.
 */
export function sliceFor(req: QueueRequest, result: SliceInput, batch: QueueRequest[]): RequestSlice {
    const overlaps = req.region
        ? batch.filter(o => o.id !== req.id && o.region && boxesMeet(grow(req.region!, 0), o.region))
            .map(o => `also changed here in this run: ${o.note ?? `request ${o.id}`}`)
        : [];
    if (!req.region && req.featureIds.length === 0) {
        return { whole: true, changedObjects: result.changedObjects, places: result.places, warnings: result.warnings, overlaps };
    }
    const area = req.region ? grow(req.region, REGION_GROW_M) : null;
    const features = new Set(req.featureIds);
    const places = result.places.filter(p => {
        const place = p as { featureIds?: unknown; bounds?: { epsg3006?: unknown } } | null;
        const ids = Array.isArray(place?.featureIds) ? place!.featureIds as unknown[] : [];
        if (ids.some(id => typeof id === 'string' && features.has(id))) return true;
        const b = place?.bounds?.epsg3006;
        return area !== null && isBox(b) && boxesMeet(area, normalise(b));
    });
    const mine = new Set(places.flatMap(objectsOf));
    const changed = new Set(result.changedObjects);
    const warnings = result.warnings.filter(w => {
        const named = [...changed].filter(o => w.includes(o));
        return named.length === 0 || named.some(o => mine.has(o));
    });
    return { whole: false, changedObjects: result.changedObjects.filter(o => mine.has(o)), places, warnings, overlaps };
}

function objectsOf(place: unknown): string[] {
    const p = place as { object?: unknown; objects?: unknown } | null;
    const out = Array.isArray(p?.objects) ? (p!.objects as unknown[]).filter((o): o is string => typeof o === 'string') : [];
    if (typeof p?.object === 'string') out.push(p.object);
    return out;
}

function isBox(v: unknown): v is Region3006 {
    return Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n));
}

function normalise(b: Region3006): Region3006 {
    return [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
}

function grow(b: Region3006, m: number): Region3006 {
    const n = normalise(b);
    return [n[0] - m, n[1] - m, n[2] + m, n[3] + m];
}

function boxesMeet(a: Region3006, b: Region3006): boolean {
    const [ax0, ay0, ax1, ay1] = normalise(a), [bx0, by0, bx1, by1] = normalise(b);
    return ax0 <= bx1 && bx0 <= ax1 && ay0 <= by1 && by0 <= ay1;
}

/** `x0,y0,x1,y1` (EPSG:3006) as a region; null when it is not four numbers. */
export function parseRegion(text: string): Region3006 | null {
    const parts = text.split(',').map(s => Number(s.trim()));
    return isBox(parts) ? normalise(parts) : null;
}

/**
 * The box around features (EPSG:3006): their rings' points, a centerline's
 * points grown by half its width. Null when they have no points.
 */
export function featuresRegion(features: Array<{ geometry: { rings: Array<{ points: Array<{ x: number; y: number }> }>; centerline?: { points: Array<{ x: number; y: number }>; widthM: number } | null } }>): Region3006 | null {
    let box: Region3006 | null = null;
    const add = (x: number, y: number, r: number) => {
        box = box ? [Math.min(box[0], x - r), Math.min(box[1], y - r), Math.max(box[2], x + r), Math.max(box[3], y + r)] : [x - r, y - r, x + r, y + r];
    };
    for (const f of features) {
        for (const ring of f.geometry.rings) for (const p of ring.points) add(p.x, p.y, 0);
        const c = f.geometry.centerline;
        if (c) for (const p of c.points) add(p.x, p.y, c.widthM / 2);
    }
    return box;
}

/** The flags of one run serving `requests`: `paths` and `save` when any asks, `skipUnity` only when all do. */
export function batchFlags(requests: QueueRequest[]): QueueFlags {
    return {
        dryRun: requests[0]?.flags.dryRun ?? false,
        paths: requests.some(r => r.flags.paths),
        save: requests.some(r => r.flags.save),
        skipUnity: requests.length > 0 && requests.every(r => r.flags.skipUnity),
    };
}

// --- Files ---

function newId(): string {
    // Time first, so ids sort by when they were made; random after, so two processes never collide.
    return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** An id as a file name: nothing that could leave the folder. */
function safeId(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Not a queue id: ${id}`);
    return id;
}

const byCreated = (a: QueueRequest, b: QueueRequest) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

async function writeAtomic(file: string, value: unknown): Promise<void> {
    const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    try {
        await rename(tmp, file);
    } catch (e) {
        // Windows refuses a rename onto a file another process has open for a moment: try again once.
        await Bun.sleep(20);
        try {
            await rename(tmp, file);
        } catch {
            await unlink(tmp).catch(() => undefined);
            throw e;
        }
    }
}

async function readJson<T>(file: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch {
        return null;
    }
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
    try {
        return await readdir(dir);
    } catch {
        return [];
    }
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}
