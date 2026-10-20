// Tree edits applied twice must agree: Unity's planter applies <prefix>-<terrain>-tree-edits.json to the trees
// export (GolfMapTreeEdits.Apply), and arborist.py's routing applies the same file itself (edited_stems) to route
// each tree where it will stand. Run against the open Omberg editor and Omberg's real export (its edits file has
// adds, moves, deletes and modifies of trees the survey lost):
//
//   bun test unity/tests/tree-edits-parity.test.ts      (Unity open on Omberg_lidar_scene)
import { beforeAll, expect, test } from 'bun:test';
import * as path from 'node:path';
import { pickBridge, run, type BridgeInfo } from '../mcp/bridge';

const REPO = path.resolve(import.meta.dir, '..', '..');
const PIPELINE = path.join(REPO, 'pipeline');
const PYTHON = path.join(PIPELINE, '.venv', 'Scripts', 'python.exe');

interface Stem { id: string; x: number; z: number }
interface Applied { trees: string; edits: string; stems: Stem[]; warnings: string[] }

let unity: BridgeInfo;

beforeAll(() => {
    unity = pickBridge('omberg');   // throws when no Omberg editor answers: this test needs the real one
});

/** arborist.py's edited_stems over the same two files. */
function python(trees: string, edits: string): { stems: Stem[]; warnings: string[] } {
    const code = 'import json, sys; from arborist import edited_stems\n'
        + 'load = lambda p: json.load(open(p, encoding="utf-8-sig"))\n'
        + 'stems, warnings = edited_stems(load(sys.argv[1]), load(sys.argv[2]))\n'
        + 'print(json.dumps({"stems": stems, "warnings": warnings}))';
    const p = Bun.spawnSync([PYTHON, '-c', code, trees, edits], { cwd: PIPELINE });
    expect(p.stderr.toString()).toBe('');
    return JSON.parse(p.stdout.toString());
}

test("arborist.py's edited_stems and Unity's GolfMapTreeEdits.Apply give the same trees in the same places on Omberg", async () => {
    const course = await run(unity, 'golfmap.course', {});
    const exports = course.active.exports as Record<string, { path: string }>;
    const trees = exports['inner-trees']!.path, edits = exports['inner-tree-edits']?.path ?? path.join(path.dirname(trees), path.basename(trees).replace('-trees.json', '-tree-edits.json'));
    const unityApplied = await run(unity, 'golfmap.trees.edits.applied', { terrain: 'inner' }, 120) as Applied;
    expect(unityApplied.edits).toBe(path.basename(edits));
    const doc = await Bun.file(edits).json() as { edits: { op: string }[] };
    expect(doc.edits.some(e => e.op === 'add') && doc.edits.some(e => e.op === 'modify') && doc.edits.some(e => e.op === 'delete')).toBe(true);

    const ours = python(trees, edits);
    const byId = (stems: Stem[]) => new Map(stems.map(s => [s.id, s]));
    const theirs = byId(unityApplied.stems), mine = byId(ours.stems);
    expect([...mine.keys()].sort()).toEqual([...theirs.keys()].sort());
    // Unity holds positions as 32-bit floats.
    const apart = [...mine.values()].filter(s => Math.hypot(s.x - theirs.get(s.id)!.x, s.z - theirs.get(s.id)!.z) > 0.001).map(s => s.id);
    expect(apart).toEqual([]);
    expect(ours.warnings.length).toBe(unityApplied.warnings.filter(w => !w.includes('planted from the edit')).length);
}, 180_000);
