// Find the edit that broke a GSPro/OPCD build: compare the course's features at
// two moments and export SVG variants with some of the changes applied, without
// touching the course (each variant is exported from a copy of the database).
//
//   bun run gspro:bisect -- <course> snapshots
//   bun run gspro:bisect -- <course> changes --from <when> [--to <when>]
//   bun run gspro:bisect -- <course> svg --from <when> [--to <when>] (--apply <list> | --without <list>) [--name <variant>]
//
// <when> is one of
//   a snapshot   2026-09-26_18-32-04 (or a unique prefix): what a full SVG export kept in <export dir>/export-history/
//   a time       "2026-09-26 13:04" (local time): rebuilt from the edit history (migration 025)
//   db:<file>    the course in another database, e.g. db:data/app.pre-renumber-2026-09-26.sqlite
//   now          the course as it is (the default for --to)
// <list> names changes by their number in `changes`: "1,3-5", "all" or "none".
// --apply takes those changes from --to onto --from; --without applies all but those.
// Only changes to feature types the SVG draws are listed (--all-types yes lists all).
// The SVG goes to the export folder as <course>-<variant>.svg (default variant
// bisect-<list>), next to the real one, which is never overwritten.
import '../server/env-paths';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { CoursesService } from '../server/services/courses.service';
import { AssetsService } from '../server/services/assets.service';
import { TerrainEditsService } from '../server/services/terrain-edits.service';
import { GsproExportService, SVG_TYPE_MAP, venvPython } from '../server/services/gspro-export.service';
import { FeatureHistoryService, type FeatureChange, type FeatureState } from '../server/services/feature-history.service';

const ROOT = path.resolve(import.meta.dir, '..');
const PIPELINE_DIR = process.env.MAP_PIPELINE_DIR ?? path.join(ROOT, 'pipeline');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error([
        'usage: bun run gspro:bisect -- <course> snapshots',
        '       bun run gspro:bisect -- <course> changes --from <when> [--to <when>]',
        '       bun run gspro:bisect -- <course> svg --from <when> [--to <when>] (--apply <list> | --without <list>) [--name <variant>]',
        '<when>: snapshot name | "YYYY-MM-DD HH:MM" (local) | db:<sqlite file> | now',
        '<list>: numbers from `changes`, e.g. 1,3-5 | all | none',
    ].join('\n'));
    process.exit(2);
}

const argv = process.argv.slice(2);
const positional: string[] = [];
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
    const value = argv[i + 1];
    if (value === undefined) usage(`${argv[i]} needs a value`);
    flags[argv[i].slice(2)] = value;
    i++;
}

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const history = new FeatureHistoryService(db);
const courses = new CoursesService(db);
const exporter = new GsproExportService({
    db, courses, assets: new AssetsService(db, dataDir), dataDir,
    terrainEdits: new TerrainEditsService(db),
    pipelineDir: PIPELINE_DIR,
});

/** The feature types the SVG draws (gspro.py's TYPE_SURFACE plus the export's --map); changes to others cannot matter. */
async function svgTypes(): Promise<Set<string>> {
    const python = process.env.MAP_PIPELINE_PYTHON ?? venvPython(PIPELINE_DIR);
    const proc = Bun.spawn([python, '-c', 'import json, gspro; print(json.dumps(sorted(gspro.TYPE_SURFACE)))'],
        { cwd: PIPELINE_DIR, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`could not read the SVG's feature types from gspro.py: ${err.trim()}`);
    return new Set([...JSON.parse(out) as string[], ...Object.keys(SVG_TYPE_MAP)]);
}

async function resolveCourse(ident: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const exact = rows.filter(r => r.id.toLowerCase() === ident.toLowerCase() || r.name.toLowerCase() === ident.toLowerCase());
    if (exact.length === 1) return exact[0];
    const partial = rows.filter(r => r.name.toLowerCase().includes(ident.toLowerCase()));
    if (partial.length === 1) return partial[0];
    usage(`${partial.length ? 'several' : 'no'} courses match '${ident}'`);
}

/** Local "YYYY-MM-DD HH:MM[:SS]" -> the database's UTC 'YYYY-MM-DD HH:MM:SS'. */
function utcOf(local: string): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
    return d.toISOString().replace('T', ' ').slice(0, 19);
}

interface State { state: FeatureState; label: string; unknown?: string[] }

async function stateOf(courseId: string, when: string, exportDir: string): Promise<State> {
    if (when === 'now') return { state: await history.current(courseId), label: 'now' };
    if (when.startsWith('db:')) {
        const file = path.resolve(when.slice(3));
        if (!existsSync(file)) usage(`no database at ${file}`);
        const other = createDb<Database>(file);
        try {
            return { state: await new FeatureHistoryService(other).current(courseId), label: path.basename(file) };
        } finally {
            await other.destroy();
        }
    }
    const utc = utcOf(when);
    if (utc) {
        const { state, unknown } = await history.stateAt(courseId, utc);
        return { state, label: when, unknown };
    }
    const snaps = (await FeatureHistoryService.listSnapshots(exportDir)).filter(s => s.name.startsWith(when));
    if (snaps.length !== 1) usage(`${snaps.length ? 'several' : 'no'} snapshots match '${when}' (see: snapshots)`);
    return { state: await FeatureHistoryService.readSnapshot(snaps[0].dir), label: `export ${snaps[0].name}` };
}

function parseList(text: string, changes: FeatureChange[]): Set<number> {
    if (text === 'all') return new Set(changes.map(c => c.n));
    if (text === 'none') return new Set();
    const out = new Set<number>();
    for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!m) usage(`bad list item '${part}'`);
        for (let n = +m[1]; n <= +(m[2] ?? m[1]); n++) {
            if (!changes.some(c => c.n === n)) usage(`there is no change ${n} (1-${changes.length})`);
            out.add(n);
        }
    }
    return out;
}

function show(c: FeatureChange, mark = ''): string {
    const where = c.layer ? c.layer : c.hole !== null ? `hole ${c.hole}` : 'course';
    return `${mark}${String(c.n).padStart(3)}  ${c.kind.padEnd(9)} ${c.type.padEnd(16)} ${where.padEnd(8)} ${(c.source ?? 'hand').padEnd(24)} ${c.id}${c.detail ? `  (${c.detail})` : ''}`;
}

async function main() {
    const [ident, command] = positional;
    if (!ident || !command) usage();
    const course = await resolveCourse(ident);
    const { dir } = await exporter.settings(course.id);

    if (command === 'snapshots') {
        const snaps = await FeatureHistoryService.listSnapshots(dir);
        if (!snaps.length) console.log(`no export snapshots in ${dir} yet (every full SVG export keeps one)`);
        for (const s of snaps) console.log(`${s.name}  ${s.features} features  ${s.svg ?? '(no svg)'}`);
        return;
    }
    if (command !== 'changes' && command !== 'svg') usage(`unknown command '${command}'`);
    if (!flags.from) usage('--from is required');
    const from = await stateOf(course.id, flags.from, dir);
    const to = await stateOf(course.id, flags.to ?? 'now', dir);
    // Only what can change the SVG, renumbered: every command sees the same numbers.
    const drawn = flags['all-types'] === 'yes' ? null : await svgTypes();
    const every = await history.changes(course.id, from.state, to.state);
    const changes = (drawn ? every.filter(c => drawn.has(c.type)) : every).map((c, i) => ({ ...c, n: i + 1 }));
    console.log(`${course.name}: ${changes.length} change(s) from ${from.label} to ${to.label}`);
    for (const s of [from, to]) {
        const unknown = (s.unknown ?? []).filter(id => !drawn || drawn.has(String(s.state.get(id)!.type)));
        if (!unknown.length) continue;
        const byType = new Map<string, number>();
        for (const id of unknown) byType.set(String(s.state.get(id)!.type), (byType.get(String(s.state.get(id)!.type)) ?? 0) + 1);
        console.log(`note: ${unknown.length} feature(s) changed after ${s.label} before the edit history was kept, so they stay as they are now `
            + `(a change of stacking only is harmless): ${[...byType].map(([t, n]) => `${t} ${n}`).join(', ')}`);
        if (unknown.length <= 12 || flags['list-unknown'] === 'yes') for (const id of unknown) console.log(`  ${id}  ${s.state.get(id)!.type}`);
    }
    if (drawn && changes.length < every.length) {
        const hidden = new Map<string, number>();
        for (const c of every) if (!drawn.has(c.type)) hidden.set(c.type, (hidden.get(c.type) ?? 0) + 1);
        console.log(`(not in the SVG, left out: ${[...hidden].map(([t, n]) => `${t} ${n}`).join(', ')}; --all-types yes lists them)`);
    }

    if (command === 'changes') {
        for (const c of changes) console.log(show(c));
        return;
    }
    if (!!flags.apply === !!flags.without) usage('svg needs --apply <list> or --without <list>');
    const picked = parseList(flags.apply ?? flags.without, changes);
    const apply = flags.apply ? picked : new Set(changes.map(c => c.n).filter(n => !picked.has(n)));
    for (const c of changes) console.log(show(c, apply.has(c.n) ? '+ ' : '  '));
    const label = flags.apply ? flags.apply : `all-but-${flags.without}`;
    const variant = flags.name ?? `bisect-${label.replace(/,/g, '_')}`;

    const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-bisect-'));
    try {
        const variantDb = path.join(work, 'variant.sqlite');
        const ids = new Set(changes.filter(c => apply.has(c.n)).map(c => c.id));
        await history.writeVariantDb(course.id, FeatureHistoryService.mix(from.state, to.state, ids), variantDb);
        const result = await exporter.export(course.id, { variant, dbPath: variantDb });
        console.log(`\n${apply.size} of ${changes.length} change(s) applied (+) -> ${result.path}`);
        for (const line of result.report) console.log(`  ${line}`);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}

try {
    await main();
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
} finally {
    await db.destroy();
}
