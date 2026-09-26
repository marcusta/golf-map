// Local development: the server and the web client together, both following
// the code as it changes.
//
//   bun run dev
//
// - server: `bun --watch server/main.ts` from the repo root — the same process
//   `bun run start` runs (same cwd, so the same data/ paths and .env), restarted
//   by Bun whenever a file it imports changes (server/, shared/, the API
//   descriptors). An export or map-build job running in memory dies with the
//   restart; start it again afterwards.
// - web: Vite (`web`'s `dev` script) with hot reload, proxying /api and /tiles
//   to that server.
//
// Ports: PORT is the server's (default 3000), WEB_PORT Vite's (default 5173).
// Both tools read PORT, so the web process gets WEB_PORT under that name and
// its proxy pointed at the server's port.
//
// Output is prefixed per process. Ctrl+C stops both, and if either exits on its
// own the other is stopped too, so nothing is left holding a port.
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SERVER_PORT = process.env.PORT || '3000';
// The one-click fetches (roads, OSM, buildings) wait on public services that
// can take a minute when busy (golfpipe retries Overpass for up to 60 s); the
// server's 30 s default would cut them off. The VPS runs with 900 s.
const serverEnv: Record<string, string | undefined> = {
    ...process.env,
    REQUEST_TIMEOUT: process.env.REQUEST_TIMEOUT || '300000',
};
const webEnv: Record<string, string | undefined> = {
    ...process.env,
    PORT: process.env.WEB_PORT || '5173',
    API_PROXY_TARGET: process.env.API_PROXY_TARGET || `http://localhost:${SERVER_PORT}`,
};

type Proc = { name: string; color: string; proc: ReturnType<typeof Bun.spawn> };

const RESET = '\x1b[0m';
const procs: Proc[] = [
    start('server', '\x1b[36m', ['bun', '--watch', 'server/main.ts'], ROOT, serverEnv),
    start('web', '\x1b[35m', ['bun', 'run', 'dev'], path.join(ROOT, 'web'), webEnv),
];

function start(name: string, color: string, cmd: string[], cwd: string, env: Record<string, string | undefined>): Proc {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', env });
    const entry = { name, color, proc };
    void pipe(entry, proc.stdout as ReadableStream<Uint8Array>, process.stdout);
    void pipe(entry, proc.stderr as ReadableStream<Uint8Array>, process.stderr);
    return entry;
}

/** Copy a child's output line by line, each line tagged with the process name. */
async function pipe(p: Proc, stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    const tag = `${p.color}[${p.name}]${RESET} `;
    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) out.write(`${tag}${line}\n`);
    }
    if (pending) out.write(`${tag}${pending}\n`);
}

let stopping = false;
function stopAll(code: number): void {
    if (stopping) return;
    stopping = true;
    for (const p of procs) {
        try { p.proc.kill(); } catch { /* already gone */ }
    }
    process.exit(code);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

// Whichever stops first takes the other with it.
const first = await Promise.race(procs.map(async (p) => ({ p, code: await p.proc.exited })));
console.error(`${first.p.color}[${first.p.name}]${RESET} exited with code ${first.code}; stopping the rest`);
stopAll(first.code ?? 1);
