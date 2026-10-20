// A stand-in for blender/tools/shape_worker.py on its HTTP contract
// (blender/README.md, "Shaping worker"): `GET /status`, `GET /job/<id>`,
// `POST /load`, `POST /sync`, `POST /check`. No Blender: `/check` reports one
// seam step per applied op (course-check.service.test.ts), `/load` applies the layers, `/sync`
// re-reads them and reports every op whose content differs from what the FBX
// folder holds (added, edited or removed since the last export; everything
// after a load into a new folder, as fbx_sync's manifest would) as one changed
// object `Spline_<op id>`, whose (empty) FBX it writes into the FBX folder.
// The run's `report.seams` and `report.gates` have the real worker's shapes;
// with `gaps` every sync that changes something opens a 2.5 cm seam gap at its
// first changed object, and its gates fail it as the real worker's do (422,
// the message naming the objects and the EPSG:3006 spot, nothing applied or
// exported) unless the body says `allowGaps`, which exports with warnings.
//
// Both POSTs are JOBS, as the worker's: they answer `{job, kind, state:
// 'running'}` with 202 and the work goes on in the background (`/status`
// carries the running or last job, `/job/<id>` one by id), and `?wait=1` holds
// the connection until it is done and answers its result, as the worker's
// blocking calls did. With a token (option, `--token` or
// GOLFMAP_SHAPING_TOKEN) every request must carry it as `X-Golfmap-Token`.
//
// Used in-process by the shaping service tests, and as a real process (`bun
// fake-shaping-worker.ts -- --port <p> --blend <b> --layers <dir>
// --fbx-folder <dir>`, the worker's own command line;
// FAKE_SHAPING_LOAD_MS = its load time) for the on-demand start.
import * as path from 'node:path';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export interface FakeShapingWorkerOptions {
    port?: number;
    /** Interface to listen on (the worker's `--host`); default 127.0.0.1. */
    host?: string;
    blend?: string;
    layersDir?: string;
    fbxFolder?: string;
    /** How long a load takes (the state is `starting`/`busy` meanwhile). */
    loadMs?: number;
    /** How long a sync takes, so a test can look at (or disturb) the worker while one runs. */
    syncMs?: number;
    /**
     * The first N `GET /status` calls made while a SYNC job runs answer 503
     * with no body — the real worker's blips while bpy holds the GIL. The sync
     * itself goes on; the service is expected to keep waiting.
     */
    statusOutages?: number;
    /** When set, every request must carry it as `X-Golfmap-Token` (401 otherwise). */
    token?: string;
    /** Every sync that changes something opens a seam gap: its gates fail it unless the body has `allowGaps`. */
    gaps?: boolean;
    /** The command line it was started with (reported in /status). */
    argv?: string[];
}

export interface FakeShapingWorker {
    url: string;
    port: number;
    calls: Array<{ route: string; body: any }>;
    stop(): void;
}

const LAYER_FILE = /^\d\d-[\w.-]+\.json$/;
export const TOKEN_HEADER = 'X-Golfmap-Token';

/** One /load or /sync run, as /status and /job/<id> report it. */
interface FakeJob {
    id: string;
    kind: 'load' | 'sync' | 'check';
    state: 'running' | 'succeeded' | 'failed';
    t0: number;
    t1: number | null;
    /** The body the blocking (`?wait=1`) answer carries, and its HTTP code. */
    body: unknown;
    code: number;
    error: string | null;
    done: Promise<void>;
}

class HttpError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
    }
}

export function startFakeShapingWorker(opts: FakeShapingWorkerOptions = {}): FakeShapingWorker {
    const calls: Array<{ route: string; body: any }> = [];
    let state = 'ready';
    let phase: string | null = null;
    let blend: string | null = null;
    let layersDir: string | null = null;
    let fbxFolder: string | null = null;
    let applied = new Map<string, string>();
    let exportedOps = new Map<string, string>();
    let lastRun: unknown = null;
    let seq = 0;
    let current: FakeJob | null = null;
    /** `/status` answers left to drop while a sync runs. */
    let outages = opts.statusOutages ?? 0;
    const byId = new Map<string, FakeJob>();

    const readOps = (): Map<string, string> => {
        const ops = new Map<string, string>();
        if (!layersDir) return ops;
        for (const name of readdirSync(layersDir).filter(n => LAYER_FILE.test(n)).sort()) {
            const layer = JSON.parse(readFileSync(path.join(layersDir, name), 'utf8'));
            for (const op of layer.ops ?? []) ops.set(String(op.id), JSON.stringify(op));
        }
        return ops;
    };
    const load = async (b: string, l: string, f: string | null) => {
        state = blend ? 'busy' : 'starting';
        phase = `opening ${path.basename(b)}`;
        await Bun.sleep(opts.loadMs ?? 0);
        phase = null;
        blend = b;
        layersDir = l;
        if (f !== fbxFolder) exportedOps = new Map();
        fbxFolder = f;
        applied = readOps();
        state = 'ready';
        const { job: _running, ...loaded } = status();
        return loaded;
    };
    const sync = async (body: any) => {
        if (!blend) throw new HttpError(409, 'nothing loaded: POST /load first');
        state = 'busy';
        phase = 'sync';
        try {
            if (opts.syncMs) await Bun.sleep(opts.syncMs);
            const now = readOps();
            const ids = new Set([...now.keys(), ...exportedOps.keys()]);
            const changedIds = [...ids].filter(id => now.get(id) !== exportedOps.get(id)).sort();
            const changed = changedIds.map(id => `Spline_${id}`);
            const gap = opts.gaps && changed.length > 0 && !body.dryRun ? {
                type: 'seamGap', objects: [changed[0]!, 'Spline_neighbour'], maxAbsDz: 0.025, points: 3,
                blend: [-12.5, 40.25], epsg3006: [530110.5, 6487074.6],
            } : null;
            const gapLine = gap ? `seam gap 2.5 cm between ${gap.objects[0]} and ${gap.objects[1]} at EPSG:3006 530110.50, 6487074.60` : '';
            if (gap && !body.allowGaps) {
                // the real worker puts the objects back and exports nothing: the next sync sees the same change
                throw new HttpError(422, `1 gap check(s) failed, so nothing was exported and the objects are back as they were before this sync: ${gapLine}. `
                    + 'Fix the layer, or sync with {"allowGaps": true} to export anyway');
            }
            const exported = body.dryRun ? [] : changed.map(n => `${n}.fbx`);
            // An op may name objects it merges away (`removesFbx`, like a permanent-join recipe's blends): their FBX goes.
            const removed = changedIds.flatMap(id => (JSON.parse(now.get(id) ?? '{}').removesFbx ?? []) as string[]).map(n => `${n}.fbx`);
            if (!body.dryRun) {
                applied = now;
                exportedOps = now;
                if (fbxFolder) {
                    mkdirSync(fbxFolder, { recursive: true });
                    for (const f of exported) writeFileSync(path.join(fbxFolder, f), '');
                }
            }
            const seams = {
                toleranceXY: 1e-4, gapDz: 1e-3, pairsChecked: changed.length, newGaps: gap ? 1 : 0, unmatchedBoundaryChanged: {},
                gaps: gap ? [{ objects: gap.objects, vertices: 9, gaps: 3, maxAbsDz: 0.025, at: gap.blend, new: true, gapsBefore: 0 }] : [],
            };
            const gates = {
                ok: !gap, allowGaps: body.allowGaps === true, limits: { gapM: 0.01, tJunctionM: 0.01 },
                failures: gap ? [gap] : [], preExisting: [], warnings: gap ? [`allowGaps: exported anyway: ${gapLine}`] : [],
            };
            const run = {
                changedObjects: changed, exported, removed, seconds: 0.1, errors: [],
                report: { warnings: ['1 seam gap under 1 mm'], seams, gates, changedPlaces: changed.map(object => ({ object, hole: 1 })) },
            };
            lastRun = run;
            return run;
        } finally {
            phase = null;
            state = 'ready';
        }
    };

    /**
     * `/check`: course_check.check()'s report (golfmap-course-check-v1, layer
     * blender) — one seam step per applied op, an error — written to `out`
     * (default beside the conformed .blend) and answered with `report` set.
     */
    const check = async (body: any) => {
        if (!blend) throw new HttpError(409, 'nothing loaded (or the last sync failed): POST /load first');
        state = 'busy';
        phase = 'check';
        try {
            if (opts.syncMs) await Bun.sleep(opts.syncMs);
            const findings = [...applied.keys()].sort().map(id => ({
                type: 'seam-step', severity: 'error', note: `7 cm step at op ${id}`, objects: [`Spline_${id}`], hole: '1',
                blend: [1, 2, 3], unity: [-1, 3, -2], epsg3006: [529500, 6487500],
            }));
            const report = {
                format: 'golfmap-course-check-v1', layer: 'blender', blend,
                ok: findings.length === 0, errors: findings.length, warnings: 0,
                area: body.boundary ? `${path.basename(body.boundary)} + ${body.marginM ?? 50} m` : 'no boundary: every course mesh',
                meshes: applied.size, counts: findings.length ? { 'seam-step': { findings: findings.length, severity: 'error' } } : {},
                seconds: { objects: 0.1, seams: 0.2 }, findings,
            };
            const out = body.out ?? path.join(path.dirname(blend), 'course-check-blender.json');
            writeFileSync(out, JSON.stringify(report));
            return { ...report, report: out };
        } finally {
            phase = null;
            state = 'ready';
        }
    };

    const publicJob = (job: FakeJob) => ({
        id: job.id,
        kind: job.kind,
        state: job.state,
        phase: job.state === 'running' ? phase : null,
        startedAt: new Date(job.t0).toISOString(),
        seconds: Math.round(((job.t1 ?? Date.now()) - job.t0) / 100) / 10,
        result: job.state === 'succeeded' ? job.body : null,
        error: job.error,
    });
    const status = () => ({
        state, phase, blend, layersDir,
        conformed: blend ? blend.replace(/(\.conformed)?\.blend$/i, '.conformed.blend') : null,
        appliedOps: applied.size, lastRun, argv: opts.argv ?? [],
        host: opts.host ?? '127.0.0.1',
        job: current ? publicJob(current) : null,
    });

    /** Queue a job, or null when one is already going (the caller answers 409). */
    const start = (kind: 'load' | 'sync' | 'check', body: any): FakeJob | null => {
        if (current?.state === 'running') return null;
        const job: FakeJob = {
            id: String(++seq), kind, state: 'running', t0: Date.now(), t1: null,
            body: null, code: 200, error: null, done: Promise.resolve(),
        };
        current = job;
        byId.set(job.id, job);
        job.done = (kind === 'load'
            ? load(body.blend, body.layersDir, body.fbxFolder ?? null)
            : kind === 'check' ? check(body) : sync(body)
        ).then(
            (result) => { job.body = result; job.state = 'succeeded'; },
            (e: unknown) => {
                job.code = e instanceof HttpError ? e.code : 500;
                job.error = (e as Error).message;
                job.body = { error: job.error };
                job.state = 'failed';
            },
        ).finally(() => { job.t1 = Date.now(); });
        return job;
    };

    const server = Bun.serve({
        port: opts.port ?? 0,
        hostname: opts.host,
        async fetch(req) {
            const url = new URL(req.url);
            const route = url.pathname;
            const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null;
            calls.push({ route, body });
            if (opts.token && req.headers.get(TOKEN_HEADER) !== opts.token) {
                return Response.json({ error: `${TOKEN_HEADER} is missing or wrong` }, { status: 401 });
            }
            if (route === '/status') {
                if (outages > 0 && current?.kind === 'sync' && current.state === 'running') {
                    outages--;
                    return new Response('', { status: 503 });
                }
                return Response.json(status());
            }
            if (route.startsWith('/job/')) {
                const job = byId.get(route.slice('/job/'.length));
                return job ? Response.json(publicJob(job)) : Response.json({ error: `no job ${route.slice(5)}` }, { status: 404 });
            }
            const kind = route === '/load' ? 'load' : route === '/sync' ? 'sync' : route === '/check' ? 'check' : null;
            if (kind && req.method === 'POST') {
                if (kind === 'load' && (!body.blend || !body.layersDir)) {
                    return Response.json({ error: 'blend and layersDir are required' }, { status: 400 });
                }
                const job = start(kind, body);
                if (!job) {
                    return Response.json({ error: `a ${current!.kind} job is already going (job ${current!.id}): wait for it`, job: current!.id, state: 'running' }, { status: 409 });
                }
                if (!wanted(url.searchParams.get('wait'))) {
                    return Response.json({ job: job.id, kind, state: 'running' }, { status: 202 });
                }
                await job.done;
                return Response.json(job.body, { status: job.code });
            }
            return Response.json({ error: `no route ${route}` }, { status: 404 });
        },
    });
    if (opts.blend && opts.layersDir) start('load', { blend: opts.blend, layersDir: opts.layersDir, fbxFolder: opts.fbxFolder ?? null });
    return { url: `http://127.0.0.1:${server.port}`, port: server.port!, calls, stop: () => server.stop(true) };
}

const wanted = (value: string | null) => value !== null && !['0', 'false', 'no', ''].includes(value.toLowerCase());

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const rest = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : argv;
    const flag = (name: string) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
    };
    startFakeShapingWorker({
        port: Number(flag('--port')), host: flag('--host'), blend: flag('--blend'), layersDir: flag('--layers'),
        fbxFolder: flag('--fbx-folder'), token: flag('--token') ?? process.env.GOLFMAP_SHAPING_TOKEN,
        loadMs: Number(process.env.FAKE_SHAPING_LOAD_MS ?? 200), argv: rest,
    });
    console.log(`fake shaping worker on ${flag('--port')}`);
}
