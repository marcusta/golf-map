// Start the headless Blender shaping worker (blender/tools/shape_worker.py) by
// hand, detached: it is not a child of this shell, so closing Claude (or the
// terminal) does not kill it and its 40-60 min load (server/services/detached-process.ts).
// Starting it with a plain `blender.exe -b --python ...` from a Claude Bash
// call put it in the app's job, and quitting the app took it down.
//
//   bun run shaping:worker -- --blend <.blend> --layers <dir> [--fbx-folder <dir>] [--port 8766]
//
// Everything after the script name goes to shape_worker.py as it is; --port
// defaults to 8766 (GOLFMAP_SHAPING_PORT). Refuses when a worker already
// answers on the port. The log is data/shaping-worker/<when>-cli.log; the
// worker's own `/status` and `/load` are the way to follow it.
import '../server/env-paths';
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawnDetached } from '../server/services/detached-process';
import { blenderExecutable, logStamp } from '../server/services/shaping.service';

const ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
    console.error('usage: bun run shaping:worker -- --blend <.blend> --layers <dir> [--fbx-folder <dir>] [--port 8766]');
    process.exit(2);
}
const at = args.indexOf('--port');
const port = at >= 0 ? args[at + 1] : (process.env.GOLFMAP_SHAPING_PORT ?? '8766');
if (at < 0) args.unshift('--port', port!);

const url = `http://127.0.0.1:${port}/status`;
try {
    const st = await (await fetch(url, { signal: AbortSignal.timeout(3000) })).json() as { state?: string; pid?: number; blend?: string };
    console.error(`A worker already answers on ${port} (pid ${st.pid}, ${st.state}, ${st.blend ?? 'nothing loaded'}); not starting another.`);
    process.exit(1);
} catch {
    // Nothing on the port: start one.
}

const dir = path.join(process.env.DATA_DIR ?? path.join(ROOT, 'data'), 'shaping-worker');
mkdirSync(dir, { recursive: true });
const log = path.join(dir, `${logStamp(new Date())}-cli.log`);
const cmd = [blenderExecutable(), '-b', '--python', path.join(ROOT, 'blender', 'tools', 'shape_worker.py'), '--', ...args];
const proc = await spawnDetached(cmd, {
    cwd: ROOT,
    env: { ...process.env, GOLFMAP_SHAPING_PORT: port, PYTHONIOENCODING: 'utf-8' },
    log,
});
console.log(`Started the shaping worker detached (pid ${proc.pid}) on ${port}; log ${log}`);
console.log(`Follow it with: curl -s ${url}`);
process.exit(0);
