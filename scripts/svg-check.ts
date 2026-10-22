// The SVG export's checks of a course as it is now (GsproExportService.checkSvg -> `gspro.py svg --check-only`),
// the same as the Draw mode's Check shapes overlay: errors stop the export (a sliver of overlap or a neck under
// OPCD's 0.24 m blend, a shape hidden under the ones above, a green on rough or nothing), warnings and notes don't.
//
//   bun run svg:check -- <course> [--all] [--json]
//        the findings: errors and warnings one per line with their key, notes and accepted ones counted (--all
//        lists them). Writes nothing. Exit 1 while there are unaccepted errors.
//   bun run svg:check -- <course> accept <key> [--note <why>]
//   bun run svg:check -- <course> unaccept <key>
//        a finding that is meant (a sibling course's tee under this course's semi) no longer stops the export, or
//        does again; kept in docs/gspro/<course>/svg-checks.json by key (code + feature ids, so it survives exports).
//   bun run svg:check -- <course> lift <key>
//        lift a hidden shape (a hidden-shape finding) just above the shapes covering it, into their hole or group
//        when they are higher (CourseFeaturesService.raiseAbove; Check shapes' arrow button).
//
// <course> is a course id or a unique name substring. docs/gspro/export.md "SVG checks".
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { GsproExportService, type SvgCheckFinding } from '../server/services/gspro-export.service';
import { CourseFeaturesService } from '../server/services/course-features.service';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run svg:check -- <course> [--all] [--json]',
        '       bun run svg:check -- <course> accept <key> [--note <why>]',
        '       bun run svg:check -- <course> unaccept <key>',
        '       bun run svg:check -- <course> lift <key>',
    ].join('\n'));
    process.exit(2);
}

const positional: string[] = [];
const flags: Record<string, string | true> = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a === '--all' || a === '--json') { flags[a.slice(2)] = true; continue; }
    if (a === '--note') {
        const v = process.argv[++i];
        if (v === undefined) usage('--note needs a text');
        flags.note = v;
        continue;
    }
    if (a.startsWith('--')) usage(`unknown flag ${a}`);
    positional.push(a);
}
const [ident, verb, key] = positional;
if (!ident) usage();
if (verb && verb !== 'accept' && verb !== 'unaccept' && verb !== 'lift') usage(`unknown verb '${verb}'`);
if (verb && !key) usage(`${verb} needs the finding's key`);

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const courses = new CoursesService(db);
const exporter = new GsproExportService({ db, courses, assets: new AssetsService(db, dataDir), dataDir });

async function resolveCourse(arg: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const q = arg.toLowerCase();
    const exact = rows.filter((r) => r.id.toLowerCase() === q || r.name.toLowerCase() === q);
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(q));
    if (partial.length === 1) return partial[0]!;
    usage(`${partial.length ? 'several' : 'no'} courses match '${arg}'`);
}

function line(f: SvgCheckFinding): string {
    const at = f.at ? ` @ ${f.at.map((v) => v.toFixed(0)).join(',')}` : '';
    return `  ${f.severity.padEnd(7)} ${f.message}${at}\n          key ${f.key}`;
}

try {
    const course = await resolveCourse(ident);
    if (verb === 'lift') {
        const finding = (await exporter.checkSvg(course.id)).findings.find((f) => f.key === key);
        if (!finding) usage(`no finding '${key}' on ${course.name} now (fixed already?)`);
        if (finding.code !== 'hidden-shape') usage(`${key} is not a hidden shape; only those can be lifted`);
        const [hidden, ...covers] = finding.shapes;
        const res = await new CourseFeaturesService(db).raiseAbove(course.id, hidden!.featureIds[0]!, covers.flatMap((s) => s.featureIds));
        const over = covers.map((s) => s.name).join(', ');
        console.log(res.moved
            ? `${course.name}: ${hidden!.name} lifted above ${over} (${res.holeId ? `hole id ${res.holeId}` : res.layer ?? 'course level'})`
            : `${course.name}: ${hidden!.name} is not under ${over} in the stack (a road, or its shape, covers it): reshape it instead`);
        process.exit(res.moved ? 0 : 1);
    }
    if (verb) {
        const { file, keys } = await exporter.acceptSvgFinding(course.id, key!, verb === 'accept', typeof flags.note === 'string' ? flags.note : undefined);
        console.log(`${course.name}: ${verb === 'accept' ? 'accepted' : 'no longer accepted'}: ${key} (${keys.length} accepted in ${file})`);
        process.exit(0);
    }
    const report = await exporter.checkSvg(course.id);
    if (flags.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        const open = report.findings.filter((f) => !f.accepted);
        const shown = flags.all ? report.findings : open.filter((f) => f.severity !== 'note');
        console.log(`${course.name}: ${report.errors} error(s), ${report.warnings} warning(s), ${report.notes} note(s), ${report.accepted} accepted`);
        for (const f of shown) console.log(line(f) + (f.accepted ? '  (accepted)' : ''));
        if (!flags.all && shown.length < report.findings.length) console.log(`(--all lists the notes and accepted ones too)`);
        if (report.errors) console.log(`the export stops on these; fix the shapes, or: bun run svg:check -- "${course.name}" accept <key> --note <why>`);
    }
    process.exit(report.errors ? 1 : 0);
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
}
