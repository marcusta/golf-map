// Photo stems: young trees on the course's open ground (rough, semi rough, deep rough, fairway) that the lidar
// missed, found from their shadows in the summer photo (PhotoStemsService -> pipeline golfpipe photo-stems). The
// same service as the Vegetation mode's "Find trees in photo".
//
//   bun run trees:photo -- <course> [--dry-run] [--accept <id,...>|all] [--skip <id,...>]
//
// Prints one line per proposed tree (its id, height, crown radius and kind) and how the photo was read. Without
// --accept/--skip the proposal is kept for a later accept; --accept plants those ids (all = every one proposed but
// the skipped) as photo stems in tiles/<site>/tree-stems-photo.json, --skip leaves them out of every later proposal.
// Then update the trees (`bun run gspro:update -- <course> trees`). --dry-run writes nothing. Exit 1 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AssetsService } from '../server/services/assets.service';
import { CoursesService } from '../server/services/courses.service';
import { CourseFeaturesService } from '../server/services/course-features.service';
import { PhotoStemsService, photoStemKindName, type PhotoStemProposal } from '../server/services/photo-stems.service';

const ROOT = path.resolve(import.meta.dir, '..');
const USAGE = 'usage: bun run trees:photo -- <course> [--dry-run] [--accept <id,...>|all] [--skip <id,...>]';

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error(USAGE);
    process.exit(2);
}

const positional: string[] = [];
let dryRun = false;
let accept: string[] | 'all' | null = null;
let skip: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--accept' || a === '--skip') {
        const v = process.argv[++i];
        if (v === undefined) usage(`${a} needs ids (comma-separated)${a === '--accept' ? ' or all' : ''}`);
        const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
        if (a === '--skip') skip = ids;
        else accept = v.trim() === 'all' ? 'all' : ids;
        continue;
    }
    if (a.startsWith('--')) usage(`unknown flag ${a}`);
    positional.push(a);
}
const ident = positional[0] ?? usage();

const line = (p: PhotoStemProposal) =>
    `${p.id}  ${p.heightM.toFixed(1)} m  r ${p.crownRadiusM.toFixed(1)} m  ${photoStemKindName(p.kind)}`;

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const db = createDb<Database>(process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite'));
let code = 0;
try {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = ident.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    const pick = exact.length === 1 ? exact : rows.filter((r) => r.name.toLowerCase().includes(q));
    if (pick.length !== 1) usage(`${pick.length ? 'several' : 'no'} courses match '${ident}'`);
    const course = pick[0]!;
    const svc = new PhotoStemsService({
        courses: new CoursesService(db), courseFeatures: new CourseFeaturesService(db), assets: new AssetsService(db, dataDir), dataDir,
    });

    const res = await svc.propose(course.id, { dryRun });
    const c = res.calibration;
    console.log(`${course.name}: ${res.proposals.length} young tree(s) in the ${res.summer} photo the lidar missed`
        + (res.accepted || res.skipped ? ` (${res.accepted} accepted and ${res.skipped} skipped before left out)` : ''));
    console.log(`  calibration: ${c.matched} lidar stem(s) matched their shadow${c.fallback ? ' (too few: the default sizes)' : ''}, `
        + `shadow azimuth ${c.shadowAzimuthDeg} deg, sun factor ${c.sunFactor}; kind from ${res.leafOff ?? 'no leaf-off photo (unknown)'}`);
    for (const p of res.proposals) console.log(`  ${line(p)}`);

    if (accept !== null || skip.length) {
        const proposed = new Set(res.proposals.map((p) => p.id));
        const ids = accept === 'all' ? res.proposals.map((p) => p.id).filter((id) => !skip.includes(id)) : (accept ?? []);
        const unknown = [...ids, ...skip].filter((id) => !proposed.has(id));
        if (unknown.length) throw new Error(`not proposed now: ${unknown.join(', ')}`);
        if (dryRun) {
            console.log(`dry run: would accept ${ids.length} and skip ${skip.length}; nothing written`);
        } else {
            const done = await svc.accept(course.id, { accept: ids, skip });
            console.log(`accepted ${ids.length} and skipped ${skip.length}: ${done.accepted} photo stem(s) and ${done.skipped} skipped in ${done.path}`);
            console.log(`next: bun run gspro:update -- "${course.name}" trees`);
        }
    } else if (dryRun) {
        console.log('dry run: nothing written');
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    code = 1;
} finally {
    await db.destroy();
}
process.exit(code);
