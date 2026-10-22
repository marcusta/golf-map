// Bunker proposals: the bunkers the course-surface model finds on the course's photo, their edges redrawn from the
// photo's NIR band, each on its hole (BunkerProposalsService -> pipeline golfpipe propose-bunkers). The same service
// and the same outline fit (web/src/geo/outline-fit.ts) as the Draw mode's "Find bunkers".
//
//   bun run bunkers -- <course> [--dry-run]                          propose; keeps the proposal unless --dry-run
//   bun run bunkers -- <course> add <id,...>|all [--skip <id,...>]   add from the last proposal as bunkers
//   bun run bunkers -- <course> skip <id,...>                        never offer those again
//   bun run bunkers -- <course> nir [--tile-dir <dir>]...            the photo's NIR band, for a map built before
//                                                                    the map build kept it (downloads ~0.7 GB per item)
//
// propose prints one line per bunker: its id, hole, area, the model's confidence and where its edge came from (nir:
// the sand line in the NIR band; model: no clear sand there, the model's outline). add makes each one a B-spline
// bunker on its hole (source `surface-model`; undo: `bun run gspro:bisect -- <course> changes`). Exit 1 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AssetsService } from '../server/services/assets.service';
import { CoursesService } from '../server/services/courses.service';
import { CourseFeaturesService } from '../server/services/course-features.service';
import { HoleAssignmentService } from '../server/services/hole-assignment.service';
import { BUNKER_PROPOSAL_SOURCE, BunkerProposalsService, type BunkerProposal } from '../server/services/bunker-proposals.service';
import { outlineToBspline } from '../web/src/geo/outline-fit';

const ROOT = path.resolve(import.meta.dir, '..');
const USAGE = 'usage: bun run bunkers -- <course> [--dry-run] | add <id,...>|all [--skip <id,...>] | skip <id,...> | nir [--tile-dir <dir>]...';

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error(USAGE);
    process.exit(2);
}

const positional: string[] = [];
let dryRun = false;
let skipIds: string[] = [];
const tileDirs: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--skip' || a === '--tile-dir') {
        const v = process.argv[++i];
        if (v === undefined) usage(`${a} needs a value`);
        if (a === '--skip') skipIds = v.split(',').map((s) => s.trim()).filter(Boolean);
        else tileDirs.push(v);
        continue;
    }
    if (a.startsWith('--')) usage(`unknown flag ${a}`);
    positional.push(a);
}
const [ident, verb, arg] = positional;
if (!ident) usage();
if (verb && !['add', 'skip', 'nir'].includes(verb)) usage(`unknown verb ${verb}`);
const ids = (arg ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if ((verb === 'add' || verb === 'skip') && !ids.length) usage(`${verb} needs ids (comma-separated)${verb === 'add' ? ' or all' : ''}`);

const line = (p: BunkerProposal) =>
    `${p.id}  ${p.holeNumber ? `hole ${String(p.holeNumber).padStart(2)}` : 'no hole'}  ${p.areaM2.toFixed(0).padStart(4)} m²  `
    + `${Math.round(p.confidence * 100)} %  ${p.edge}`;

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
    const features = new CourseFeaturesService(db);
    const svc = new BunkerProposalsService({
        db, courses: new CoursesService(db), assets: new AssetsService(db, dataDir),
        holeAssignment: new HoleAssignmentService({ db, courseFeatures: features }), dataDir,
    });

    if (verb === 'nir') {
        const res = await svc.fetchNir(course.id, { tileDirs });
        console.log(`${course.name}: NIR band in ${res.path} (${res.downloaded} item(s) downloaded, RGB check ${res.rgbCheck?.toFixed(2) ?? '-'})`);
    } else if (verb === 'add' || verb === 'skip') {
        const last = await svc.lastProposal(course.id);
        if (!last) throw new Error('no proposal kept for this course — run without a verb first');
        const byId = new Map(last.proposals.map((p) => [p.id, p]));
        const wanted = verb === 'add' && ids[0] === 'all'
            ? last.proposals.map((p) => p.id).filter((id) => !skipIds.includes(id)) : verb === 'add' ? ids : [];
        const skip = verb === 'skip' ? ids : skipIds;
        const unknown = [...wanted, ...skip].filter((id) => !byId.has(id));
        if (unknown.length) throw new Error(`not in the last proposal: ${unknown.join(', ')}`);
        const items = wanted.flatMap((id) => {
            const p = byId.get(id)!;
            const geometry = outlineToBspline(p.ring.map(([x, y]) => ({ x, y })));
            return geometry ? [{ id, item: { type: 'bunker', holeId: p.holeId, geometry, source: BUNKER_PROPOSAL_SOURCE } }] : [];
        });
        if (dryRun) {
            console.log(`dry run: would add ${items.length} bunker(s) and skip ${skip.length}; nothing written`);
        } else {
            const created = items.length ? await features.createMany(course.id, items.map((i) => i.item)) : [];
            if (skip.length) await svc.skip(course.id, { ids: skip });
            console.log(`added ${created.length} bunker(s)${created.length ? ` (#${created.map((f) => f.no).join(', #')})` : ''}, skipped ${skip.length}`);
        }
    } else {
        const res = await svc.propose(course.id, { dryRun });
        const l = res.left;
        console.log(`${course.name}: ${res.proposals.length} bunker(s) in the ${res.collection} photo not drawn yet `
            + `(left out: ${l.drawn} drawn, ${l.notCourse} outside the course, ${l.small} small, ${l.skipped} skipped; `
            + `${res.predicted ? 'model run' : 'model raster reused'}, ${res.seconds} s)`);
        for (const p of res.proposals) console.log(`  ${line(p)}`);
        if (dryRun) console.log('dry run: nothing kept');
        else if (res.proposals.length) console.log(`next: bun run bunkers -- "${course.name}" add all   (or add <id,...> / skip <id,...>)`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    code = 1;
} finally {
    await db.destroy();
}
process.exit(code);
