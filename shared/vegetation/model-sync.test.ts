// The repo's models.json / palette.json / grass-palette.json into Unity's course folder: byte-equal, a Unity copy changed by
// hand refused (with its diff) unless forced, a dry run writes nothing.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findUnityCourseFolders, formatSync, lineDiff, syncCourseModels, writeCoursePalette } from './model-sync';
import { loadModelLibrary, modelLibraryText } from './tree-models';

const MODELS = '{\r\n  "format": "golfmap-models-v1",\r\n  "models": [\r\n    {"id": "arborist:S7_American_Elm", "species": "elm", "renderer": "arborist", "heightM": 18, "crownWidthM": 12, "kind": "broadleaf", "form": "tree"}\r\n  ]\r\n}\r\n';
const PALETTE = JSON.stringify({ format: 'golfmap-tree-palette-v1', seed: 's', rules: {}, assets: [{ model: 'arborist:S7_American_Elm', enabled: true }] }, null, 2) + '\n';
const GRASS = JSON.stringify({ format: 'golfmap-grass-v1', palettes: [{ key: 'rough_tall', items: [{ name: 'Tall rough', model: 'arborist:S7_American_Elm', sampleDistance: 1 }] }] }, null, 2) + '\n';
const SHARED = { format: 'golfmap-model-library-v1', models: [
    { id: 'arborist:CE_DA_Forest_Tree_16018', species: 'beech', renderer: 'arborist', heightM: 22.9, crownWidthM: 14, kind: 'broadleaf', form: 'tree', look: { hue: 0, brightness: 1 } },
] };

function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'model-sync-'));
    const docs = path.join(root, 'docs', 'testbana');
    const unity = path.join(root, 'proj', 'Assets', 'GolfMap', 'Testbana');
    mkdirSync(docs, { recursive: true });
    mkdirSync(unity, { recursive: true });
    writeFileSync(path.join(docs, 'models.json'), MODELS);
    writeFileSync(path.join(docs, 'palette.json'), PALETTE);
    writeFileSync(path.join(docs, 'grass-palette.json'), GRASS);
    return { root, docs, unity, base: path.join(root, 'proj', 'Library', 'GolfMapBridge', 'course-docs-sync.json') };
}

const bytes = (f: string) => readFileSync(f);

describe('syncCourseModels', () => {
    test('Unity gets the resolved library and the palette byte for byte (CRLF kept), then finds them the same', () => {
        const f = fixture();
        writeFileSync(path.join(f.docs, 'palette.json'), PALETTE.replace(/\n/g, '\r\n'));
        const first = syncCourseModels({ docsDir: f.docs, unityDir: f.unity });
        expect(first.map(r => [r.file, r.state, r.action])).toEqual([['models.json', 'new', 'copied'], ['palette.json', 'new', 'copied'], ['grass-palette.json', 'new', 'copied']]);
        expect(readFileSync(path.join(f.unity, 'models.json'), 'utf8')).toBe(modelLibraryText(loadModelLibrary(f.docs)));
        expect(bytes(path.join(f.unity, 'palette.json')).equals(bytes(path.join(f.docs, 'palette.json')))).toBe(true);
        expect(existsSync(f.base)).toBe(true);
        expect(bytes(path.join(f.unity, 'grass-palette.json')).equals(bytes(path.join(f.docs, 'grass-palette.json')))).toBe(true);
        expect(syncCourseModels({ docsDir: f.docs, unityDir: f.unity }).map(r => r.state)).toEqual(['same', 'same', 'same']);
    });

    test('a repo change since the last sync is copied without --force', () => {
        const f = fixture();
        syncCourseModels({ docsDir: f.docs, unityDir: f.unity });
        writeFileSync(path.join(f.docs, 'palette.json'), PALETTE.replace('"s"', '"s-2"'));
        const [r] = syncCourseModels({ docsDir: f.docs, unityDir: f.unity, files: ['palette.json'] });
        expect([r!.state, r!.action]).toEqual(['repo-changed', 'copied']);
        expect(bytes(path.join(f.unity, 'palette.json')).equals(bytes(path.join(f.docs, 'palette.json')))).toBe(true);
    });

    test('a Unity copy changed by hand is refused with its diff, and overwritten only with force', () => {
        const f = fixture();
        syncCourseModels({ docsDir: f.docs, unityDir: f.unity });
        const edited = PALETTE.replace('"s"', '"hand-edit"');
        writeFileSync(path.join(f.unity, 'palette.json'), edited);
        const refused = syncCourseModels({ docsDir: f.docs, unityDir: f.unity });
        const r = refused.find(x => x.file === 'palette.json')!;
        expect([r.state, r.action]).toEqual(['drift', 'refused']);
        expect(r.diff).toContain('-  "seed": "hand-edit",');
        expect(r.diff).toContain('+  "seed": "s",');
        expect(formatSync(refused)).toContain('DRIFT palette.json');
        expect(readFileSync(path.join(f.unity, 'palette.json'), 'utf8')).toBe(edited);

        const forced = syncCourseModels({ docsDir: f.docs, unityDir: f.unity, force: true }).find(x => x.file === 'palette.json')!;
        expect([forced.state, forced.action]).toEqual(['drift', 'copied']);
        expect(bytes(path.join(f.unity, 'palette.json')).equals(bytes(path.join(f.docs, 'palette.json')))).toBe(true);
    });

    test('with no base yet, a Unity copy that differs is drift (never synced: whose is newer is unknown)', () => {
        const f = fixture();
        writeFileSync(path.join(f.unity, 'models.json'), MODELS.replace('"heightM": 18', '"heightM": 19'));
        const [r] = syncCourseModels({ docsDir: f.docs, unityDir: f.unity, files: ['models.json'] });
        expect([r!.state, r!.action]).toEqual(['drift', 'refused']);
    });

    test('line endings alone are no drift', () => {
        const f = fixture();
        writeFileSync(path.join(f.docs, 'palette.json'), PALETTE.replace(/\n/g, '\r\n'));
        writeFileSync(path.join(f.unity, 'palette.json'), PALETTE);
        const [r] = syncCourseModels({ docsDir: f.docs, unityDir: f.unity, files: ['palette.json'] });
        expect([r!.state, r!.action]).toEqual(['repo-changed', 'copied']);
        expect(bytes(path.join(f.unity, 'palette.json')).equals(bytes(path.join(f.docs, 'palette.json')))).toBe(true);
    });

    test('the same library written another way (models in another order) is no drift', () => {
        const f = fixture();
        writeFileSync(path.join(f.root, 'docs', 'model-library.json'), JSON.stringify(SHARED));
        const resolved = loadModelLibrary(f.docs);
        writeFileSync(path.join(f.unity, 'models.json'), JSON.stringify({ ...resolved, models: [...resolved.models].reverse() }));
        const [r] = syncCourseModels({ docsDir: f.docs, unityDir: f.unity, files: ['models.json'] });
        expect([r!.state, r!.action]).toEqual(['repo-changed', 'copied']);
    });

    test("Unity's models.json follows the shared library: a shared change since the last sync is copied, an override applies", () => {
        const f = fixture();
        const shared = path.join(f.root, 'docs', 'model-library.json');
        writeFileSync(shared, JSON.stringify(SHARED));
        writeFileSync(path.join(f.docs, 'models.json'), JSON.stringify({ format: 'golfmap-models-v1', models: [
            { id: 'arborist:CE_DA_Forest_Tree_16018', look: { brightness: 0.8 } },
            JSON.parse(MODELS).models[0],
        ] }));
        syncCourseModels({ docsDir: f.docs, unityDir: f.unity });
        const unity = () => JSON.parse(readFileSync(path.join(f.unity, 'models.json'), 'utf8'));
        expect(unity().models.map((m: { id: string }) => m.id)).toEqual(['arborist:CE_DA_Forest_Tree_16018', 'arborist:S7_American_Elm']);
        expect(unity().models[0].look).toEqual({ hue: 0, brightness: 0.8 });

        writeFileSync(shared, JSON.stringify({ ...SHARED, models: [{ ...SHARED.models[0], heightM: 23.5 }] }));
        const [r] = syncCourseModels({ docsDir: f.docs, unityDir: f.unity, files: ['models.json'] });
        expect([r!.state, r!.action]).toEqual(['repo-changed', 'copied']);
        expect(unity().models[0]).toMatchObject({ heightM: 23.5, look: { hue: 0, brightness: 0.8 } });
    });

    test('a dry run writes nothing, not even the base', () => {
        const f = fixture();
        const report = syncCourseModels({ docsDir: f.docs, unityDir: f.unity, dryRun: true });
        expect(report.map(r => r.action)).toEqual(['would-copy', 'would-copy', 'would-copy']);
        expect(existsSync(path.join(f.unity, 'models.json'))).toBe(false);
        expect(existsSync(path.join(f.unity, 'palette.json'))).toBe(false);
        expect(existsSync(f.base)).toBe(false);
    });

    test('a file only Unity has is reported, never deleted', () => {
        const f = fixture();
        const docs = path.join(f.root, 'docs', 'empty');
        mkdirSync(docs);
        writeFileSync(path.join(f.unity, 'palette.json'), PALETTE);
        const report = syncCourseModels({ docsDir: docs, unityDir: f.unity });
        expect(report.map(r => r.state)).toEqual(['absent', 'unity-only', 'absent']);
        expect(existsSync(path.join(f.unity, 'palette.json'))).toBe(true);
    });
});

test('findUnityCourseFolders finds a course by its Course.asset exportPrefix', () => {
    const f = fixture();
    writeFileSync(path.join(f.unity, 'Course.asset'), 'MonoBehaviour:\n  courseName: Testbana\n  exportPrefix: testbana\n');
    expect(findUnityCourseFolders('testbana', { roots: [f.root] })).toEqual([f.unity]);
    expect(findUnityCourseFolders('testbana', { projects: [path.join(f.root, 'proj')] })).toEqual([f.unity]);
    expect(findUnityCourseFolders('other', { roots: [f.root] })).toEqual([]);
});

test('writeCoursePalette refuses a palette referring to a model the library lacks', () => {
    const f = fixture();
    const bad = PALETTE.replace('S7_American_Elm', 'Nope');
    expect(() => writeCoursePalette(f.docs, Buffer.from(bad))).toThrow(/arborist:Nope/);
    expect(readFileSync(path.join(f.docs, 'palette.json'), 'utf8')).toBe(PALETTE);
});

test('lineDiff marks only the changed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toBe('@@ line 1 @@\n a\n-b\n+B\n c');
});
