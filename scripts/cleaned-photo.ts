// The cleaned photo from the command line: the same CleanedPhotoService the
// Clean panel drives, without the browser (no upload, no download).
//
//   bun run photo -- info <course>
//   bun run photo -- export <course> [<out.png>]     the photo as a PNG (default: the service's kept copy)
//   bun run photo -- import <course> <image>         any PNG/JPEG/TIFF of 8192 x 8192 px becomes the photo
//   bun run photo -- undo <course>                   back to before the last bake or import
//
// <course> is a course id or a unique name substring ("vreta"). The first
// export or import on a site makes its cleaned photo (from the pristine
// photo, or from the old patch log's working raster when there is one). The
// image given to import is read, never changed or removed. After import or
// undo, press Refresh in the Clean panel to see it on the map.
//
// Reads data/app.sqlite (DB_PATH) and data/ (DATA_DIR) like the server. The
// server's one-change-at-a-time queue is per process: don't bake or import in
// the panel while this runs.
import '../server/env-paths';
import * as path from 'node:path';
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AssetsService } from '../server/services/assets.service';
import { CoursesService } from '../server/services/courses.service';
import { CleanedPhotoService } from '../server/services/cleaned-photo.service';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run photo -- info <course>',
        '       bun run photo -- export <course> [<out.png>]',
        '       bun run photo -- import <course> <image>',
        '       bun run photo -- undo <course>',
    ].join('\n'));
    process.exit(2);
}

const [command, ident, file] = process.argv.slice(2);
if (!command || !ident || !['info', 'export', 'import', 'undo'].includes(command)) usage();
if (command === 'import' && (!file || !existsSync(file))) usage(file ? `no such file: ${file}` : 'import needs an image');

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const svc = new CleanedPhotoService({
    db, assets: new AssetsService(db, dataDir), courses: new CoursesService(db), dataDir,
    pipelineDir: process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline'),
});

const seconds = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

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
    const t0 = Date.now();

    if (command === 'info') {
        const info = await svc.info(course.id);
        console.log(`${course.name}: ${info.exists ? `cleaned photo ${info.size} x ${info.size} px` : 'no cleaned photo yet (made on first use)'}, `
            + `${info.undoDepth} change(s) can be undone`);
        if (info.reason) console.log(`  ${info.reason}`);
    } else if (command === 'export') {
        const out = await svc.exportImage(course.id);
        const target = file ? path.resolve(file) : out.path;
        if (file) copyFileSync(out.path, target);
        console.log(`${course.name}: ${target} (${(out.bytes / 1e6).toFixed(1)} MB) in ${seconds(t0)}`);
    } else if (command === 'import') {
        // importImage deletes the file it is handed, so it gets a copy.
        const tmpPath = await svc.incomingImportPath(course.id);
        copyFileSync(file!, tmpPath);
        console.log(`${course.name}: importing ${path.resolve(file!)} (${(statSync(file!).size / 1e6).toFixed(1)} MB) ...`);
        const r = await svc.importImage(course.id, tmpPath);
        if (!r.changed) {
            console.log(`The image is the cleaned photo as it already was; nothing changed. ${seconds(t0)}`);
        } else {
            const b = r.bounds3006!;
            console.log(`Imported in ${seconds(t0)}: ${r.changedPixels.toLocaleString('en-US')} pixels changed, within `
                + `${(b.east - b.west).toFixed(0)} x ${(b.north - b.south).toFixed(0)} m. ${r.undoDepth} change(s) can be undone.`);
        }
    } else {
        const r = await svc.undo(course.id);
        console.log(`${course.name}: undone in ${seconds(t0)}; ${r.undoDepth} change(s) can still be undone.`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
} finally {
    await db.destroy();
}
