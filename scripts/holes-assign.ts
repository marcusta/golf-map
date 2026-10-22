// Shapes in Others onto their holes, from the holes' tees, aim points and green centre (HoleAssignmentService;
// the same service as the Draw mode's "Assign to holes"). Every hole on the course's site takes part, so a
// shape on a sibling course's hole is reported as that course's and left alone.
//
//   bun run holes:assign -- <course> propose [--all]
//        what each shape in Others would get: one line per shape put on a hole or (an ordinary rough) into the
//        Roughs group, and (with --all, else counted)
//        the ones that stay: on another course's hole, split between holes, or near no hole. Writes nothing.
//   bun run holes:assign -- <course> accept [<featureNo|id>,...] [--dry-run]
//        put the proposed shapes on their holes and the roughs into Roughs (all of them, or only those listed),
//        keeping the order they had in Others. Undo is the feature history (`bun run gspro:bisect -- <course> changes`).
//
// A shape on a hole is written into that hole's SVG layer as hole_<n>_<id> on the next shapes export.
// <course> is a course id or a unique name substring. Exit 1 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CourseFeaturesService } from '../server/services/course-features.service';
import { HoleAssignmentService, type HoleProposal } from '../server/services/hole-assignment.service';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run holes:assign -- <course> propose [--all]',
        '       bun run holes:assign -- <course> accept [<featureNo|id>,...] [--dry-run]',
    ].join('\n'));
    process.exit(2);
}

const positional: string[] = [];
const flags = new Set<string>();
for (const a of process.argv.slice(2)) {
    if (a === '--all' || a === '--dry-run') flags.add(a);
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else positional.push(a);
}
const [ident, verb, list] = positional;
if (!ident || (verb !== 'propose' && verb !== 'accept')) usage();
if (verb === 'propose' && list) usage('propose takes no shapes');

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const service = new HoleAssignmentService({ db, courseFeatures: new CourseFeaturesService(db) });

async function resolveCourse(arg: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = arg.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0]!;
    usage(`${partial.length ? 'several' : 'no'} courses match '${arg}'`);
}

const shape = (p: { featureNo: number | null; featureId: string }) => (p.featureNo !== null ? `#${p.featureNo}` : p.featureId);
function line(p: HoleProposal): string {
    const what = `${shape(p).padEnd(6)} ${p.type.padEnd(12)}`;
    if (p.outcome === 'assign') return `  ${what} -> hole ${p.holeNumber}${p.share !== null && p.share < 1 ? ` (${Math.round(p.share * 100)}%)` : ''}`;
    if (p.outcome === 'roughs') return `  ${what} -> Roughs`;
    if (p.outcome === 'others') return `  ${what} -> Others, on top (a rough island off this course's holes)`;
    if (p.outcome === 'other-course') return `  ${what} on ${p.courseName} hole ${p.holeNumber}: left alone`;
    return `  ${what} stays in Others: ${p.reason}`;
}

try {
    const course = await resolveCourse(ident);
    if (verb === 'propose') {
        const { proposals, counts } = await service.propose(course.id);
        console.log(`${course.name}: ${proposals.length} shape(s) in Others`);
        for (const p of proposals) if (p.outcome === 'assign' || p.outcome === 'roughs' || p.outcome === 'others' || flags.has('--all')) console.log(line(p));
        console.log(`onto a hole: ${counts.assign}; into Roughs: ${counts.roughs}; out of Roughs: ${counts.others}; on another course's hole: ${counts.otherCourse}; `
            + `split between holes: ${counts.ambiguous}; near no hole: ${counts.none}`
            + (flags.has('--all') ? '' : ' (--all lists them)'));
        if (counts.assign || counts.roughs || counts.others) console.log(`accept with: bun run holes:assign -- "${course.name}" accept`);
    } else {
        let featureIds: string[] | undefined;
        if (list) {
            const { proposals } = await service.propose(course.id);
            featureIds = list.split(',').map((s) => s.trim()).filter(Boolean).map((arg) => {
                const no = /^#?(\d+)$/.exec(arg);
                const hit = proposals.find((p) => (no ? p.featureNo === Number(no[1]) : p.featureId === arg));
                if (!hit) usage(`'${arg}' is not a shape in Others`);
                if (hit.outcome !== 'assign' && hit.outcome !== 'roughs' && hit.outcome !== 'others') usage(`${shape(hit)} is not proposed onto a hole (${line(hit).trim()})`);
                return hit.featureId;
            });
        }
        const result = await service.accept(course.id, { featureIds, dryRun: flags.has('--dry-run') });
        const byHole = new Map<number, number>();
        for (const h of result.holes) byHole.set(h.holeNumber, (byHole.get(h.holeNumber) ?? 0) + 1);
        const detail = [...byHole.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}: ${c}`).join(', ');
        console.log(`${course.name}: ${result.dryRun ? 'would put' : 'put'} ${result.assigned} shape(s) on their holes${detail ? ` (${detail})` : ''}`
            + `${result.roughs ? `, ${result.roughs} rough(s) into Roughs` : ''}${result.others ? `, ${result.others} rough island(s) back to Others` : ''}`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
}
