// How far a course has come on its way to GSPro, as one checklist: the GSPro
// board's rows, the OPCD build, Check, Ready, the GSPro build and the
// GreenKeeper score, plus set-up, map and cleaned photo before them
// (`CourseProgressService`, the same list the Claude status pane shows).
//
//   bun run course:progress -- <course>... | all [--json]
//
// <course> is a course id or a unique name substring ("vreta"); `all` = every
// course with an export folder set. Reads only: nothing runs, nothing is
// written. About 5 s a course (the board asks each open Unity editor what
// course it has active).
import '../server/env-paths';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import type { Database } from '../server/db/schema';
import { createServices } from '../server/services/index';
import type { CourseProgress, ProgressState } from '../server/services/course-progress.service';

const ROOT = path.resolve(import.meta.dir, '..');

function usage(message?: string): never {
    if (message) console.error(`error: ${message}\n`);
    console.error('usage: bun run course:progress -- <course>... | all [--json]');
    process.exit(2);
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const idents = args.filter(a => a !== '--json');
for (const a of idents) if (a.startsWith('--')) usage(`unknown option ${a}`);
if (idents.length === 0) usage();

const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
const dbPath = process.env.DB_PATH ?? path.join(dataDir, 'app.sqlite');
if (!existsSync(dbPath)) usage(`no database at ${dbPath}`);
const db = createDb<Database>(dbPath);
const { courseProgressService: progress } = createServices(db, { dataDir });

async function resolveCourse(ident: string): Promise<{ id: string; name: string }> {
    const rows = await db.selectFrom('courses').select(['id', 'name']).execute();
    const exact = rows.filter((r) => r.id.toLowerCase() === ident.toLowerCase() || r.name.toLowerCase() === ident.toLowerCase());
    if (exact.length === 1) return exact[0]!;
    const partial = rows.filter((r) => r.name.toLowerCase().includes(ident.toLowerCase()));
    if (partial.length === 1) return partial[0]!;
    const names = (partial.length ? partial : rows).map((r) => `  ${r.name} (${r.id})`).join('\n');
    usage(`${partial.length ? 'several' : 'no'} courses match '${ident}':\n${names}`);
}

const MARK: Record<ProgressState, string> = { done: 'ok     ', stale: 'stale  ', todo: 'todo   ', failed: 'FAILED ', blocked: 'blocked' };

function print(course: CourseProgress) {
    const done = course.steps.filter(s => s.state === 'done').length;
    console.log(`${course.name}  ${done}/${course.steps.length} done`);
    for (const s of course.steps) {
        console.log(`  ${MARK[s.state]} ${s.label.padEnd(18)} ${s.detail ?? ''}`.trimEnd());
        if (s.manual && s.state !== 'done') console.log(`  ${''.padEnd(7)} ${''.padEnd(18)} then by hand: ${s.manual}`);
    }
}

try {
    const picked = idents.length === 1 && idents[0] === 'all' ? await progress.courses() : await Promise.all(idents.map(resolveCourse));
    const out: CourseProgress[] = [];
    for (const course of picked) {
        const one = await progress.progress(course.id);
        if (json) out.push(one);
        else print(one);
    }
    if (json) console.log(JSON.stringify({ courses: out }));
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
} finally {
    await db.destroy();
}
