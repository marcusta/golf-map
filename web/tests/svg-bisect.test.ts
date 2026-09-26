import { test, expect } from 'bun:test';
import {
    startBisect, answerBisect, undoBisect, bisectExclusions, bisectTesting, bisectVariant, bisectBuildsLeft,
    spatialOrder, parseBisect, type SvgBisect,
} from '../src/export/svg-bisect';
import type { CourseFeature } from '../../shared/api/course-features.gen';

// The bisect over SVG features (svg-bisect.ts), driven by a simulated Blender
// build: `builds(excluded)` says whether the SVG without those features builds.

const ids = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

/** Run a bisect to its end; returns the final state and how many builds it took. */
function run(suspects: string[], builds: (excluded: Set<string>) => boolean, base = new Set<string>()) {
    let b: SvgBisect = startBisect(suspects, base);
    let count = 0;
    while (!b.result) {
        count++;
        b = answerBisect({ ...b, exported: true }, builds(bisectExclusions(b)));
    }
    return { b, count };
}

test('every single culprit is found and confirmed in log2(n) + 1 builds', () => {
    for (const n of [2, 3, 13, 95]) {
        for (let c = 0; c < n; c++) {
            const culprit = `f${c}`;
            const { b, count } = run(ids(n), ex => ex.has(culprit));
            expect(b.candidates).toEqual([culprit]);
            expect(b.result).toBe('confirmed');
            expect(count).toBeLessThanOrEqual(Math.ceil(Math.log2(n)) + 1);
        }
    }
});

test('two features that each break the build end as "not alone"', () => {
    // Builds only once both are out: leaving out the one found still fails.
    const { b } = run(ids(16), ex => ex.has('f3') && ex.has('f11'));
    expect(b.candidates).toHaveLength(1);
    expect(b.result).toBe('not-alone');
});

test('exclusions outside the suspects stay out at every step', () => {
    let b = startBisect(ids(8), new Set(['tree-1', 'f2']));
    expect(b.base).toEqual(['tree-1']);  // a suspect is never part of the base
    expect([...bisectExclusions(b)].sort()).toEqual(['f0', 'f1', 'f2', 'f3', 'tree-1']);
    b = answerBisect({ ...b, exported: true }, false);
    expect(bisectExclusions(b).has('tree-1')).toBe(true);
    expect(bisectTesting(b)).toEqual(['f4', 'f5']);
    expect(bisectVariant(b)).toBe('bisect-2');
});

test('undo steps back through the answers, the confirming one included', () => {
    let b = startBisect(ids(4), new Set());
    b = answerBisect({ ...b, exported: true }, true);   // f0, f1
    b = answerBisect({ ...b, exported: true }, false);  // f1
    b = answerBisect({ ...b, exported: true }, true);   // confirmed
    expect(b.result).toBe('confirmed');
    b = undoBisect(b);
    expect(b.result).toBeNull();
    expect(b.candidates).toEqual(['f1']);
    b = undoBisect(undoBisect(b));
    expect(b.candidates).toEqual(ids(4));
    expect(b.step).toBe(1);
    expect(undoBisect(b)).toBe(b);
});

test('builds left counts the halvings and the confirming build', () => {
    expect(bisectBuildsLeft(startBisect(ids(95), new Set()))).toBe(8);
    expect(bisectBuildsLeft(startBisect(ids(1), new Set()))).toBe(1);
});

test('the spatial order keeps each half a compact patch', () => {
    const at = (id: string, x: number, y: number) => ({
        id, geometry: { crs: 'EPSG:3006', rings: [{ points: [{ x, y }, { x: x + 4, y }, { x, y: y + 4 }] }] },
    }) as CourseFeature;
    // Two clusters a kilometre apart, interleaved in store order.
    const features = [at('w1', 0, 0), at('e1', 1000, 0), at('w2', 10, 5), at('e2', 1010, 5), at('w3', 5, 12), at('e3', 1005, 12)];
    const order = spatialOrder(features);
    expect(new Set(order.slice(0, 3))).toEqual(new Set(['w1', 'w2', 'w3']));
});

test('a stored bisect round-trips and junk reads as none', () => {
    const b = answerBisect({ ...startBisect(ids(6), new Set(['x'])), exported: true }, true);
    expect(parseBisect(JSON.parse(JSON.stringify(b)))).toEqual(b);
    expect(parseBisect(null)).toBeNull();
    expect(parseBisect({ base: [], candidates: [], step: 1, history: [] })).toBeNull();
    expect(parseBisect({ base: [1], candidates: ['a'], step: 1, history: [] })).toBeNull();
});
