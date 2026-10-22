// A club's scorecard into the course: par, stroke index, each tee set's hole lengths, ratings and slopes
// (ScorecardService; the same service as Furniture › Tee sets › Scorecard). The lengths then place the tees:
// `bun run tees:place`.
//
//   bun run scorecard -- <course> show
//        the lengths the course's tee sets hold.
//   bun run scorecard -- <course> propose <file|-> [--yards|--metres] [--map <label>=<set|new>,...]
//        read the card (text: holes across or down, rating lines like `Gul herr 71,5/135 dam 77,5/139`; or JSON,
//        shared/scorecard.ts) and say where each of its sets goes and what would change. Writes nothing.
//   bun run scorecard -- <course> accept <file|-> [--yards|--metres] [--map ...] [--dry-run]
//        write it: new sets, par, stroke index, lengths, ratings (what the card does not say stays).
//
// A card set goes to the course's set of its name, else its colour (`Gul 57` -> Yellow), else - a set named by
// number only (`57`) - the set whose placed tees add up to its total; else a new set. --map overrides that
// (`--map "57=Yellow,37=new"`). `-` reads the card from stdin. <course> is a course id or a unique name
// substring. Exit 1 on failure.
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { AnalysisService } from '../server/services/analysis.service';
import { TeeSetsService } from '../server/services/tee-sets.service';
import { TeePlacementService } from '../server/services/tee-placement.service';
import { ScorecardService, type ScorecardProposal } from '../server/services/scorecard.service';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run scorecard -- <course> show',
        '       bun run scorecard -- <course> propose <file|-> [--yards|--metres] [--map <label>=<set|new>,...]',
        '       bun run scorecard -- <course> accept <file|-> [--yards|--metres] [--map ...] [--dry-run]',
    ].join('\n'));
    process.exit(2);
}

const positional: string[] = [];
const flags = new Set<string>();
let mapArg: string | null = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--yards' || a === '--metres' || a === '--meters' || a === '--dry-run') flags.add(a);
    else if (a === '--map') mapArg = argv[++i] ?? usage('--map needs <label>=<set|new>,...');
    else if (a.startsWith('--map=')) mapArg = a.slice('--map='.length);
    else if (a.startsWith('--')) usage(`unknown flag ${a}`);
    else positional.push(a);
}
const [ident, verb, file] = positional;
if (!ident || (verb !== 'show' && verb !== 'propose' && verb !== 'accept')) usage();
if (verb !== 'show' && !file) usage(`${verb} needs the card: a file, or - for stdin`);

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const teeSets = new TeeSetsService(db);
const teePlacement = new TeePlacementService({ db, analysis: new AnalysisService(db, dataDir) });
const service = new ScorecardService({ db, teeSets, teePlacement });

async function resolveCourse(arg: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = arg.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0]!;
    usage(`${partial.length ? 'several' : 'no'} courses match '${arg}'`);
}

async function readCard(arg: string): Promise<string> {
    if (arg === '-') return await new Response(Bun.stdin.stream()).text();
    if (!existsSync(arg)) usage(`no file ${arg}`);
    return readFileSync(arg, 'utf8');
}

async function setMap(courseId: string): Promise<{ label: string; teeSetId: string }[] | undefined> {
    if (!mapArg) return undefined;
    const sets = await teeSets.listByCourse(courseId);
    return mapArg.split(',').map((pair) => {
        const at = pair.lastIndexOf('=');
        if (at < 1) usage(`--map wants <label>=<set|new>, got '${pair}'`);
        const label = pair.slice(0, at).trim(), target = pair.slice(at + 1).trim();
        if (target.toLowerCase() === 'new') return { label, teeSetId: 'new' };
        const set = sets.find((s) => s.name.toLowerCase() === target.toLowerCase() || s.id === target);
        if (!set) usage(`--map: the course has no tee set '${target}' (${sets.map((s) => s.name).join(', ')})`);
        return { label, teeSetId: set.id };
    });
}

function printProposal(p: ScorecardProposal): void {
    console.log(`${p.holes.length} hole(s), lengths in ${p.unit === 'yd' ? 'yards (written as metres)' : 'metres'}`);
    for (const s of p.sets) {
        const to = s.teeSetId ? `${s.name} (${s.matchedBy})` : `new set ${s.name}`;
        const ratings = [
            s.ratingMen !== null ? `men ${s.ratingMen}/${s.slopeMen ?? '?'}` : '',
            s.ratingWomen !== null ? `women ${s.ratingWomen}/${s.slopeWomen ?? '?'}` : '',
        ].filter(Boolean).join(', ');
        console.log(`  ${s.label.padEnd(12)} -> ${to.padEnd(22)} ${String(s.totalM).padStart(5)} m on ${s.holes} hole(s), ${s.lengthsChanged} new or changed`
            + `${ratings ? `; ${ratings}${s.ratingsChanged ? '' : ' (as stored)'}` : ''}`);
    }
    const changed = p.holes.filter((h) => h.holeId && ((h.par !== null && h.par !== h.parWas) || (h.strokeIndex !== null && h.strokeIndex !== h.strokeIndexWas)));
    for (const h of changed) {
        const parts = [
            h.par !== null && h.par !== h.parWas ? `par ${h.parWas ?? '-'} -> ${h.par}` : '',
            h.strokeIndex !== null && h.strokeIndex !== h.strokeIndexWas ? `index ${h.strokeIndexWas ?? '-'} -> ${h.strokeIndex}` : '',
        ].filter(Boolean);
        console.log(`  hole ${h.number}: ${parts.join(', ')}`);
    }
    for (const w of p.warnings) console.log(`  warning: ${w}`);
    console.log(`new sets: ${p.counts.newSets}; lengths new or changed: ${p.counts.lengthsChanged}; par changed: ${p.counts.parChanged}; `
        + `index changed: ${p.counts.indexChanged}; ratings: ${p.counts.ratingsChanged}`);
}

try {
    const course = await resolveCourse(ident);
    if (verb === 'show') {
        const { sets } = await service.get(course.id);
        if (!sets.length) console.log(`${course.name}: no lengths yet (bun run scorecard -- "${course.name}" propose <card>)`);
        for (const s of sets) console.log(`${s.name.padEnd(12)} ${String(s.totalM).padStart(5)} m  ${s.lengths.map((l) => `${l.holeNumber}:${l.lengthM}`).join(' ')}`);
    } else {
        const unit = flags.has('--yards') ? 'yd' as const : flags.has('--metres') || flags.has('--meters') ? 'm' as const : undefined;
        const input = { text: await readCard(file!), unit, map: await setMap(course.id) };
        const proposal = await service.propose(course.id, input);
        console.log(`${course.name}:`);
        printProposal(proposal);
        if (verb === 'accept') {
            const r = await service.accept(course.id, { ...input, dryRun: flags.has('--dry-run') });
            console.log(`${r.dryRun ? 'would write' : 'wrote'}: ${r.setsCreated} new set(s), ${r.lengthsWritten} length(s), ${r.holesChanged} hole(s), ${r.ratingsWritten} set rating(s)`);
            if (!r.dryRun) console.log(`place the tees with: bun run tees:place -- "${course.name}" propose`);
        } else {
            console.log(`accept with: bun run scorecard -- "${course.name}" accept ${file}${mapArg ? ` --map "${mapArg}"` : ''}`);
        }
    }
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
}
