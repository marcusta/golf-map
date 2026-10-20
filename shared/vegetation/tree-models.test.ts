// The shared model library with a course's overrides over it (loadModelLibrary), and promote.
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deepMerge, loadModelLibrary, promoteModel, resolveModelLibrary, type CourseModels, type ModelLibrary } from './tree-models';

const REPO = path.resolve(import.meta.dir, '../..');

const BEECH = { id: 'arborist:CE_DA_Forest_Tree_16018', species: 'beech', renderer: 'arborist' as const, heightM: 22.9, crownWidthM: 14, kind: 'broadleaf', form: 'tree', look: { hue: 0, brightness: 1 } };
const ELM = { id: 'arborist:S7_American_Elm', species: 'elm', renderer: 'arborist' as const, heightM: 18, crownWidthM: 12, kind: 'broadleaf', form: 'tree' };
const DEAD = { id: 'arborist:S7_AmurCork_Winter', species: 'deadoak', renderer: 'arborist' as const, heightM: 20, crownWidthM: 25, kind: 'broadleaf', form: 'tree' };
const shared: ModelLibrary = { format: 'golfmap-model-library-v1', models: [BEECH, ELM] };

/** The library as a set: top-level keys sorted, models by id, every object's keys sorted. */
function canonical(lib: { models: { id: string }[] }): string {
    const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
        : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
    return JSON.stringify(sortKeys({ ...lib, models: [...lib.models].sort((a, b) => (a.id < b.id ? -1 : 1)) }));
}

test('a course without models.json inherits the whole shared library', () => {
    expect(resolveModelLibrary(shared, { format: 'golfmap-models-v1', models: [] }).models).toEqual([BEECH, ELM]);
});

test('an override is deep-merged onto its shared model; disabled leaves it out; course-only models come last', () => {
    const course: CourseModels = { format: 'golfmap-models-v1', comment: 'c', models: [
        DEAD, { id: BEECH.id, look: { brightness: 0.8 } }, { id: ELM.id, disabled: true },
    ] };
    const lib = resolveModelLibrary(shared, course);
    expect(lib.format).toBe('golfmap-models-v1');
    expect(lib.comment).toBe('c');
    expect(lib.models).toEqual([{ ...BEECH, look: { hue: 0, brightness: 0.8 } }, DEAD]);
});

test('deepMerge: objects merge, values replace, null removes', () => {
    expect(deepMerge({ a: 1, o: { x: 1, y: 2 }, l: [1, 2] }, { o: { y: 3 }, l: [9], a: null })).toEqual({ o: { x: 1, y: 3 }, l: [9] });
});

test('disabling a model the shared library lacks is refused', () => {
    expect(() => resolveModelLibrary(shared, { format: 'golfmap-models-v1', models: [{ id: 'arborist:Nope', disabled: true }] })).toThrow(/arborist:Nope/);
});

test('loadModelLibrary finds the shared library in the course docs root', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tree-models-'));
    mkdirSync(path.join(root, 'banan'));
    writeFileSync(path.join(root, 'model-library.json'), JSON.stringify(shared));
    writeFileSync(path.join(root, 'banan', 'models.json'), JSON.stringify({ format: 'golfmap-models-v1', models: [{ id: ELM.id, heightM: 19 }] }));
    expect(loadModelLibrary(path.join(root, 'banan')).models).toEqual([BEECH, { ...ELM, heightM: 19 }]);
});

test('promote: an override goes into the shared model, a course-only model joins; the course resolves the same', () => {
    const course: CourseModels = { format: 'golfmap-models-v1', models: [{ id: BEECH.id, look: { brightness: 0.8 } }, DEAD] };
    const before = resolveModelLibrary(shared, course);

    const a = promoteModel(shared, course, BEECH.id);
    expect(a.joined).toBe(false);
    expect(a.shared.models[0]).toEqual({ ...BEECH, look: { hue: 0, brightness: 0.8 } });
    expect(a.course.models.map(m => m.id)).toEqual([DEAD.id]);
    expect(canonical(resolveModelLibrary(a.shared, a.course))).toBe(canonical(before));

    const b = promoteModel(a.shared, a.course, DEAD.id);
    expect(b.joined).toBe(true);
    expect(b.shared.models.map(m => m.id)).toEqual([BEECH.id, ELM.id, DEAD.id]);
    expect(b.course.models).toEqual([]);
    expect(canonical(resolveModelLibrary(b.shared, b.course))).toBe(canonical(before));

    expect(() => promoteModel(shared, course, ELM.id)).toThrow(/not in the course/);
    expect(() => promoteModel(shared, { format: 'golfmap-models-v1', models: [{ id: ELM.id, disabled: true }] }, ELM.id)).toThrow(/disabled/);
});

test("Omberg's resolved library is its models.json of 2026-10-21 before the shared library (same models, same fields)", () => {
    // sha1 of canonical() of docs/gspro/ombergs-golfklubb/models.json as it was before the split (66 models).
    const omberg = loadModelLibrary(path.join(REPO, 'docs/gspro/ombergs-golfklubb'));
    expect(omberg.models.length).toBe(66);
    expect(createHash('sha1').update(canonical(omberg)).digest('hex')).toBe('11477f68f2bfe461496ca0f35076acebe1b2e342');
});
