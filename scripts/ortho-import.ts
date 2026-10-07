// Import an externally edited cleaned-photo export from a file on this
// machine: the same OrthoPatchesService.importEdited the Clean panel's
// "Import edited photo" calls, without the browser upload in between.
//
//   bun run ortho:import -- <course> <edited.png> [--export <n>] [--tolerance <0..254>]
//
// <course> is a course id or a unique name substring ("vreta"). The image is
// compared with the export it was edited from (--export, default the latest;
// the Clean panel lists them) and only the changed pixels are stored, as one
// raster entry in the patch log, baked into the cleaned photo and its map
// tiles. The file given is read, never changed or removed.
//
// Then press Refresh in the Clean panel: it shows the new patch count and
// refetches the cleaned photo. Revert last patch there undoes the import.
//
// Reads data/app.sqlite (DB_PATH) and data/ (DATA_DIR) like the server. The
// server's one-operation-per-site queue is per process: don't bake or import
// in the panel while this runs.
import '../server/env-paths';
import * as path from 'node:path';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AssetsService } from '../server/services/assets.service';
import { OrthoPatchesService } from '../server/services/ortho-patches.service';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run ortho:import -- <course> <edited.png> [--export <n>] [--tolerance <0..254>]');
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const value = argv[++i];
    if (value === undefined) usage(`${a} needs a value`);
    flags[a.slice(2)] = value;
}
const [ident, file] = positional;
if (!ident || !file) usage();
if (!existsSync(file)) usage(`no such file: ${file}`);

function whole(name: string): number | undefined {
    const v = flags[name];
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) usage(`--${name} must be a whole number`);
    return Number(v);
}
const exportSeq = whole('export');
const tolerance = whole('tolerance');

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const svc = new OrthoPatchesService({
    db, assets: new AssetsService(db, dataDir), dataDir,
    pipelineDir: process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline'),
});

try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const lower = ident.toLowerCase();
    const exact = rows.filter(r => r.id.toLowerCase() === lower || r.name.toLowerCase() === lower);
    const matches = exact.length === 1 ? exact : rows.filter(r => r.name.toLowerCase().includes(lower));
    if (matches.length !== 1) {
        usage(`${matches.length ? 'several' : 'no'} courses match '${ident}':\n`
            + (matches.length ? matches : rows).map(r => `  ${r.name} (${r.id})`).join('\n'));
    }
    const course = matches[0]!;

    // importEdited deletes the file it is handed, so it gets a copy.
    const tmpPath = await svc.incomingImportPath(course.id);
    copyFileSync(file, tmpPath);
    console.log(`${course.name}: importing ${path.resolve(file)} (${(statSync(file).size / 1e6).toFixed(1)} MB) ...`);
    const t0 = Date.now();
    const r = await svc.importEdited(course.id, { tmpPath, exportSeq, tolerance });
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.changed) {
        console.log(`No changes found against export ${r.exportSeq} (${r.reason ?? 'identical'}; tolerance ${r.tolerance}), nothing stored. ${seconds}s`);
    } else {
        const b = r.bounds3006!;
        console.log(`Imported as patch ${r.seq} against export ${r.exportSeq} in ${seconds}s: ${r.changedPixels.toLocaleString('en-US')} changed pixels`
            + ` in ${r.regions ?? '?'} region(s), box ${(b.east - b.west).toFixed(0)} x ${(b.north - b.south).toFixed(0)} m. ${r.count} patches in the log.`);
        console.log('Press Refresh in the Clean panel to see it on the map.');
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
