// Acceptance B4 (CLI half): `bun run arborist -- route <course> [--dry-run]` routes a course's trees by its
// rules without Unity: one line of counts, and --dry-run writes nothing. Run on Omberg's real export
// (D:/gspro_courses/omberg-opcd): machine data is required, not optional.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..');
const EXPORT = 'D:/gspro_courses/omberg-opcd';
const ROUTING = path.join(EXPORT, 'ombergs-golfklubb-inner-routing.json');
const TREES = path.join(EXPORT, 'ombergs-golfklubb-inner-trees.json');
const EDITS = path.join(EXPORT, 'ombergs-golfklubb-inner-tree-edits.json');

function route(...args: string[]) {
    const p = Bun.spawnSync(['bun', 'run', 'arborist', '--', 'route', 'Ombergs Golfklubb', ...args], { cwd: REPO });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}
const hash = (f: string) => (existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : null);
const COUNTS = /own (\d+), billboard (\d+), left out (\d+)/;

test('route --dry-run says how many trees go where and writes nothing; the real run writes the same counts', () => {
    // The trees the routing sees: the export's stems, less the deleted ones, plus the added ones.
    const stems = new Set((JSON.parse(readFileSync(TREES, 'utf8')) as { trees: { id: string }[] }).trees.map(t => t.id));
    const edits = existsSync(EDITS) ? (JSON.parse(readFileSync(EDITS, 'utf8')) as { edits: { id: string; op: string }[] }).edits : [];
    for (const e of edits) {
        if (e.op === 'delete') stems.delete(e.id);
        if (e.op === 'add') stems.add(e.id);
    }

    const before = hash(ROUTING);
    const dry = route('--dry-run');
    expect(dry.code).toBe(0);
    const m = COUNTS.exec(dry.out);
    expect(m).not.toBeNull();
    const [own, billboard, out] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(own + billboard + out).toBe(stems.size);
    expect(billboard).toBeGreaterThan(0);                    // Omberg has trees far outside its boundary
    expect(hash(ROUTING)).toBe(before);

    const real = route();
    expect(real.code).toBe(0);
    expect(COUNTS.exec(real.out)?.slice(1).map(Number)).toEqual([own, billboard, out]);
    const doc = JSON.parse(readFileSync(ROUTING, 'utf8')) as { format: string; routes: Record<string, string> };
    expect(doc.format).toBe('golfmap-routing-v1');
    expect(Object.keys(doc.routes).sort()).toEqual([...stems].sort());
    const values = Object.values(doc.routes);
    expect([values.filter(v => v === 'own').length, values.filter(v => v === 'billboard').length, values.filter(v => v === 'out').length]).toEqual([own, billboard, out]);
});

test('a course without routing rules is refused by name, nothing written', () => {
    const p = Bun.spawnSync(['bun', 'run', 'arborist', '--', 'route', 'no such course'], { cwd: REPO });
    expect(p.exitCode).not.toBe(0);
    expect(p.stdout.toString() + p.stderr.toString()).toContain('no such course');
});
