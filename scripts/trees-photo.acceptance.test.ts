// Acceptance A4 (CLI half) on the real Omberg data: a dry run over the whole course lists the young trees of
// the rough between greens 1 and 10 that the lidar missed (the hand-marked M1..M22 of
// pipeline/tests/fixtures/photo-stems-omberg/rough-1-10/truth.json), sized like the lidar-matched ones there,
// and changes no file of the site's.
//
//   bun run trees:photo -- <course> [--dry-run] [--accept <id,...>|all] [--skip <id,...>]
//
// Each proposal is printed on a line of its own starting with its id (epsg3006:<E>:<N>) and carrying its
// height as "<h> m".
import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..');
const SITE = '317d1f83-3ade-431c-8201-605ac0bd2871';
const DIRS = [path.join(REPO, 'data', 'tiles', SITE), path.join(REPO, 'data', 'sources', SITE)];
const TRUTH = JSON.parse(readFileSync(path.join(REPO, 'pipeline', 'tests', 'fixtures', 'photo-stems-omberg', 'rough-1-10', 'truth.json'), 'utf8')) as {
    missing: { id: string; e: number; n: number }[];
    matched: { heightM: number }[];
};
const HERE = DIRS.every((d) => existsSync(d)) ? '' : `Omberg's site data (${DIRS.join(', ')})`;
if (HERE) console.warn(`trees-photo.acceptance.test: skipped, it needs ${HERE}`);

function files(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const dir of DIRS) {
        for (const name of readdirSync(dir)) {
            const s = statSync(path.join(dir, name));
            if (s.isFile()) out[path.join(dir, name)] = `${s.size}:${s.mtimeMs}`;
        }
    }
    return out;
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

test.skipIf(!!HERE)("a dry run lists Omberg's missing young trees by hole 1 and 10, sized like the lidar ones, and writes nothing", () => {
    const before = files();
    const proc = Bun.spawnSync(['bun', 'run', 'trees:photo', '--', 'Ombergs Golfklubb', '--dry-run'], { cwd: REPO });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(proc.exitCode, out).toBe(0);
    expect(files()).toEqual(before);

    const proposals = [...out.matchAll(/^\s*epsg3006:(\d+\.\d{2}):(\d+\.\d{2})\b.*?(\d+(?:\.\d+)?) m\b/gm)]
        .map((m) => ({ x: Number(m[1]), y: Number(m[2]), h: Number(m[3]) }));
    const found: number[] = [];
    const missed: string[] = [];
    for (const t of TRUTH.missing) {
        const near = proposals.filter((p) => Math.hypot(p.x - t.e, p.y - t.n) <= 1.5);
        if (near.length) found.push(near[0]!.h); else missed.push(t.id);
    }
    expect(found.length, `missed ${missed.join(', ')}`).toBeGreaterThanOrEqual(Math.ceil(0.9 * TRUTH.missing.length));
    expect(Math.abs(median(found) - median(TRUTH.matched.map((m) => m.heightM)))).toBeLessThanOrEqual(1.0);
}, 900_000);
