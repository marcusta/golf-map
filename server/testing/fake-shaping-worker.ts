// A stand-in for blender/tools/shape_worker.py on its HTTP contract
// (blender/SHAPING-PLAN.md, "Shaping worker"): `GET /status`, `POST /load`,
// `POST /sync`. No Blender: `/load` applies the layers, `/sync` re-reads them
// and reports every op whose content differs from what the FBX folder holds
// (added, edited or removed since the last export; everything after a load
// into a new folder, as fbx_sync's manifest would) as one changed object
// `Spline_<op id>`, whose (empty) FBX it writes into the FBX folder. Used in-process by the shaping service tests, and as a real process
// (`bun fake-shaping-worker.ts -- --port <p> --blend <b> --layers <dir>
// --fbx-folder <dir>`, the worker's own command line; FAKE_SHAPING_LOAD_MS = its load time) for the on-demand start.
import * as path from 'node:path';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export interface FakeShapingWorkerOptions {
    port?: number;
    blend?: string;
    layersDir?: string;
    fbxFolder?: string;
    /** How long a load takes (the state is `starting`/`busy` meanwhile). */
    loadMs?: number;
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
    };
    const status = () => ({
        state, phase, blend, layersDir,
        conformed: blend ? blend.replace(/(\.conformed)?\.blend$/i, '.conformed.blend') : null,
        appliedOps: applied.size, lastRun, argv: opts.argv ?? [],
    });

    const server = Bun.serve({
        port: opts.port ?? 0,
        async fetch(req) {
            const route = new URL(req.url).pathname;
            const body = req.method === 'POST' ? await req.json().catch(() => ({})) : null;
            calls.push({ route, body });
            if (route === '/status') return Response.json(status());
            if (route === '/load' && req.method === 'POST') {
                if (!body.blend || !body.layersDir) return Response.json({ error: 'blend and layersDir are required' }, { status: 400 });
                await load(body.blend, body.layersDir, body.fbxFolder ?? null);
                return Response.json(status());
            }
            if (route === '/sync' && req.method === 'POST') {
                if (!blend) return Response.json({ error: 'nothing loaded: POST /load first' }, { status: 409 });
                const now = readOps();
                const ids = new Set([...now.keys(), ...exportedOps.keys()]);
                const changedIds = [...ids].filter(id => now.get(id) !== exportedOps.get(id)).sort();
                const changed = changedIds.map(id => `Spline_${id}`);
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
                const run = {
                    changedObjects: changed, exported, removed, seconds: 0.1,
                    report: { warnings: ['1 seam gap under 1 mm'], seams: { gaps: 1 }, changedPlaces: changed.map(object => ({ object, hole: 1 })) },
                };
                lastRun = run;
                return Response.json(run);
            }
            return Response.json({ error: `no route ${route}` }, { status: 404 });
        },
    });
    if (opts.blend && opts.layersDir) void load(opts.blend, opts.layersDir, opts.fbxFolder ?? null);
    return { url: `http://127.0.0.1:${server.port}`, port: server.port!, calls, stop: () => server.stop(true) };
}

if (import.meta.main) {
    const argv = process.argv.slice(2);
    const rest = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : argv;
    const flag = (name: string) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
    };
    startFakeShapingWorker({
        port: Number(flag('--port')), blend: flag('--blend'), layersDir: flag('--layers'), fbxFolder: flag('--fbx-folder'),
        loadMs: Number(process.env.FAKE_SHAPING_LOAD_MS ?? 200), argv: rest,
    });
    console.log(`fake shaping worker on ${flag('--port')}`);
}
