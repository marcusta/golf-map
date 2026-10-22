// The tees placed from the scorecard's lengths (TeePlacementService; the same service as Furniture › Tee sets ›
// Place tees): each set's tee where its length, run back along the line of play (tee -> aim points -> green
// centre), crosses a drawn tee shape. The lengths come from `bun run scorecard`.
//
//   bun run tees:place -- <course> propose [--all]
//        one line per tee to place and per one that needs a look: off (not at its length), ambiguous (two tee
//        shapes nearly in line), missed (no tee shape at its length: the spot to draw one at); --all adds the
//        ok and skipped ones. Writes nothing.
//   bun run tees:place -- <course> accept [<hole>:<set>,...] [--dry-run]
//        write every new tee, or exactly the ones listed (`5:Yellow,12:Red`; an off tee moves, an ambiguous or
//        missed one goes where proposed).
//
// Spots are printed as EPSG:3006 x,y. <course> is a course id or a unique name substring. Exit 1 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AnalysisService } from '../server/services/analysis.service';
import { TeePlacementService, type TeeSpot } from '../server/services/tee-placement.service';
import { wgs84ToSweref99tm } from '../server/services/geo';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run tees:place -- <course> propose [--all]',
        '       bun run tees:place -- <course> accept [<hole>:<set>,...] [--dry-run]',
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
if (verb === 'propose' && list) usage('propose takes no tees');

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const service = new TeePlacementService({ db, analysis: new AnalysisService(db, dataDir) });

async function resolveCourse(arg: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = arg.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0]!;
    usage(`${partial.length ? 'several' : 'no'} courses match '${arg}'`);
}

const xy = (at: [number, number] | null) => {
    if (!at) return '';
    const p = wgs84ToSweref99tm(at[1], at[0]);
    return ` at ${p.x.toFixed(1)},${p.y.toFixed(1)}`;
};

function line(s: TeeSpot): string {
    const what = `  ${String(s.holeNumber).padStart(2)}:${s.setName.padEnd(10)} ${String(Math.round(s.lengthM)).padStart(4)} m`;
    if (s.outcome === 'place') return `${what}  place${xy(s.at)}`;
    if (s.outcome === 'ok') return `${what}  ok (${s.currentLengthM} m)`;
    if (s.outcome === 'off') return `${what}  OFF: ${s.reason}; accept by name moves it ${s.moveM} m${xy(s.at)}`;
    if (s.outcome === 'ambiguous') return `${what}  AMBIGUOUS: ${s.reason}; proposed${xy(s.at)}`;
    if (s.outcome === 'missed') return `${what}  MISSED: ${s.reason}${s.at ? `; draw a tee shape${xy(s.at)}` : ''}`;
    return `${what}  skipped: ${s.reason}`;
}

try {
    const course = await resolveCourse(ident);
    if (verb === 'propose') {
        const { spots, counts, sets } = await service.propose(course.id);
        if (!sets) {
            console.log(`${course.name}: no tee lengths yet (bun run scorecard -- "${course.name}" propose <card>)`);
        } else {
            console.log(`${course.name}: ${spots.length} tee(s) of ${sets} set(s) with lengths`);
            for (const s of spots) if (flags.has('--all') || (s.outcome !== 'ok' && s.outcome !== 'too-short' && s.outcome !== 'no-green')) console.log(line(s));
            console.log(`place: ${counts.place}; ok: ${counts.ok}; off: ${counts.off}; ambiguous: ${counts.ambiguous}; missed: ${counts.missed}; skipped: ${counts.skipped}`
                + (flags.has('--all') ? '' : ' (--all lists ok and skipped)'));
            if (counts.place) console.log(`accept the new ones with: bun run tees:place -- "${course.name}" accept`);
        }
    } else {
        let keys: string[] | undefined;
        if (list) {
            const { spots } = await service.propose(course.id);
            keys = list.split(',').map((s) => s.trim()).filter(Boolean).map((arg) => {
                const m = /^(\d+):(.+)$/.exec(arg);
                if (!m) usage(`'${arg}' is not <hole>:<set>`);
                const hit = spots.find((s) => s.holeNumber === Number(m[1]) && s.setName.toLowerCase() === m[2]!.toLowerCase());
                if (!hit) usage(`hole ${m[1]} has no ${m[2]} length`);
                return hit.key;
            });
        }
        const r = await service.accept(course.id, { keys, dryRun: flags.has('--dry-run') });
        for (const s of r.spots) console.log(`  ${String(s.holeNumber).padStart(2)}:${s.setName.padEnd(10)} ${s.action === 'move' ? `moved ${s.moveM} m` : 'placed'}`);
        console.log(`${course.name}: ${r.dryRun ? 'would place' : 'placed'} ${r.placed} tee(s), ${r.dryRun ? 'would move' : 'moved'} ${r.moved}`);
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
}
