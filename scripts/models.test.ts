// `bun run models` as the command line and as Unity's Palette panel run it: the panel's Add Arborist model
// and Save are the same verbs (GolfMapModels.RunCli; the argument lists below are read from the C#), so the
// same action gives the same repo file, and the sync gives Unity's course folder that file byte for byte.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadModelLibrary, modelLibraryText } from '../shared/vegetation/tree-models';

const REPO = path.resolve(import.meta.dir, '..');
const COURSE = 'ombergs-golfklubb';
const ELM = 'arborist:S7_American_Elm';
const BEECH = 'arborist:CE_DA_Forest_Tree_16018';

function models(...args: string[]) {
    const proc = Bun.spawnSync(['bun', 'run', 'models', '--', ...args], { cwd: REPO });
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

/** A docs root with the course folder, and a Unity project's course folder. */
function fixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'models-cli-'));
    const docsRoot = path.join(root, 'docs');
    const docs = path.join(docsRoot, COURSE);
    const unity = path.join(root, 'proj', 'Assets', 'GolfMap', 'Omberg');
    mkdirSync(docs, { recursive: true });
    mkdirSync(unity, { recursive: true });
    return { root, docsRoot, docs, unity };
}

const read = (f: string) => readFileSync(f);
const same = (a: string, b: string) => read(a).equals(read(b));
/** Unity's models.json is the course's resolved library, as the repo's files give it. */
const resolvedIn = (f: { docs: string; unity: string }) =>
    readFileSync(path.join(f.unity, 'models.json'), 'utf8') === modelLibraryText(loadModelLibrary(f.docs));

/**
 * The arguments GolfMapModels.<method> passes to RunCli, with the C# identifiers filled in: the panel's
 * command line, read from the panel's own source so this test follows it.
 */
function panelArgs(method: 'AddArborist' | 'SavePalette', values: Record<string, string>): string[] {
    const cs = readFileSync(path.join(REPO, 'unity/Editor/GolfMap/GolfMapModels.cs'), 'utf8');
    const body = cs.slice(cs.indexOf(`public static ${method === 'AddArborist' ? 'GolfMapBiomeAsset' : 'string'} ${method}(`));
    const call = /RunCli\(repo, ([^;]*)\)\s*;/.exec(body)![1]!;
    return call.split(/,\s*/).map(token => {
        const literal = /^"(.*)"$/.exec(token);
        if (literal) return literal[1]!;
        const v = values[token];
        if (v === undefined) throw Error(`panelArgs: no value for ${token} in GolfMapModels.${method}`);
        return v;
    });
}

describe('add: the command line and the Palette panel', () => {
    test('give the same models.json, and the panel\'s run leaves Unity\'s copy byte-equal to it', () => {
        const cli = fixture(), panel = fixture();
        const a = models('add', COURSE, BEECH, '--species', 'beech', '--kind', 'broadleaf', '--form', 'tree', '--docs', cli.docsRoot);
        expect(a.code).toBe(0);
        const args = panelArgs('AddArborist', {
            course: COURSE, id: BEECH, species: 'beech', kind: 'broadleaf', form: 'tree',
            'UnityFolderOf(palettePath)': panel.unity,
        });
        expect(args).toContain('--unity');
        const b = models(...args, '--docs', panel.docsRoot);
        expect(b.code).toBe(0);
        expect(same(path.join(cli.docs, 'models.json'), path.join(panel.docs, 'models.json'))).toBe(true);
        expect(resolvedIn(panel)).toBe(true);
    });

    test('a Unity models.json changed by hand refuses the add; nothing is written; --force goes through', () => {
        const f = fixture();
        expect(models('add', COURSE, ELM, '--species', 'elm', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        const before = readFileSync(path.join(f.docs, 'models.json'), 'utf8');
        writeFileSync(path.join(f.unity, 'models.json'), before.replace('"elm"', '"oak"'));
        const r = models('add', COURSE, BEECH, '--species', 'beech', '--docs', f.docsRoot, '--unity', f.unity);
        expect(r.code).not.toBe(0);
        expect(r.out).toContain('DRIFT models.json');
        expect(r.out).toContain('"species": "oak"');
        expect(readFileSync(path.join(f.docs, 'models.json'), 'utf8')).toBe(before);

        expect(models('add', COURSE, BEECH, '--species', 'beech', '--docs', f.docsRoot, '--unity', f.unity, '--force').code).toBe(0);
        expect(resolvedIn(f)).toBe(true);
    });
});

describe('palette: the command line and the Palette panel', () => {
    const palette = (seed: string) => JSON.stringify({ format: 'golfmap-tree-palette-v1', seed, rules: {}, assets: [{ model: ELM, enabled: true }] }, null, 2) + '\n';

    test('give the same palette.json, the bytes given; the panel\'s run syncs it over Unity\'s copy', () => {
        const cli = fixture(), panel = fixture();
        for (const f of [cli, panel]) expect(models('add', COURSE, ELM, '--species', 'elm', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        const draft = path.join(cli.root, 'draft.json');
        writeFileSync(draft, palette('seed-1'));
        // Unity's copy was edited in the panel's old way: the panel's Save replaces it (its draft came from it).
        writeFileSync(path.join(panel.unity, 'palette.json'), palette('old-unity'));

        expect(models('palette', COURSE, '--from', draft, '--docs', cli.docsRoot).code).toBe(0);
        const args = panelArgs('SavePalette', { course: COURSE, temp: draft, 'UnityFolderOf(palettePath)': panel.unity });
        const b = models(...args, '--docs', panel.docsRoot);
        expect(b.code).toBe(0);
        expect(same(path.join(cli.docs, 'palette.json'), draft)).toBe(true);
        expect(same(path.join(cli.docs, 'palette.json'), path.join(panel.docs, 'palette.json'))).toBe(true);
        expect(same(path.join(panel.docs, 'palette.json'), path.join(panel.unity, 'palette.json'))).toBe(true);
    });

    test('a palette naming a model the library lacks is refused and nothing is written', () => {
        const f = fixture();
        expect(models('add', COURSE, ELM, '--species', 'elm', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        const draft = path.join(f.root, 'draft.json');
        writeFileSync(draft, palette('x').replace('S7_American_Elm', 'Nope'));
        const r = models('palette', COURSE, '--from', draft, '--docs', f.docsRoot, '--unity', f.unity, '--replace-unity');
        expect(r.code).not.toBe(0);
        expect(r.out).toContain('arborist:Nope');
        expect(existsSync(path.join(f.docs, 'palette.json'))).toBe(false);
        expect(existsSync(path.join(f.unity, 'palette.json'))).toBe(false);
    });

    test('repo changes Unity has not got refuse a palette made from Unity\'s copy, unless --force', () => {
        const f = fixture();
        expect(models('add', COURSE, ELM, '--species', 'elm', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        writeFileSync(path.join(f.docs, 'palette.json'), palette('synced'));
        expect(models('sync', COURSE, '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        writeFileSync(path.join(f.docs, 'palette.json'), palette('repo-moved-on'));
        const draft = path.join(f.root, 'draft.json');
        writeFileSync(draft, palette('from-unity'));
        const r = models('palette', COURSE, '--from', draft, '--replace-unity', '--docs', f.docsRoot, '--unity', f.unity);
        expect(r.code).not.toBe(0);
        expect(r.out).toContain('repo-moved-on');
        expect(readFileSync(path.join(f.docs, 'palette.json'), 'utf8')).toBe(palette('repo-moved-on'));
        expect(models('palette', COURSE, '--from', draft, '--replace-unity', '--force', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        expect(same(path.join(f.docs, 'palette.json'), draft)).toBe(true);
    });
});

describe('sync', () => {
    test('copies byte-equal; --dry-run writes nothing; drift is refused without --force', () => {
        const f = fixture();
        expect(models('add', COURSE, ELM, '--species', 'elm', '--docs', f.docsRoot).code).toBe(0);

        const dry = models('sync', COURSE, '--dry-run', '--docs', f.docsRoot, '--unity', f.unity);
        expect(dry.code).toBe(0);
        expect(dry.out).toContain('would copy');
        expect(existsSync(path.join(f.unity, 'models.json'))).toBe(false);
        expect(existsSync(path.join(f.root, 'proj', 'Library'))).toBe(false);

        expect(models('sync', COURSE, '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        expect(resolvedIn(f)).toBe(true);

        const hand = readFileSync(path.join(f.unity, 'models.json'), 'utf8').replace('"elm"', '"oak"');
        writeFileSync(path.join(f.unity, 'models.json'), hand);
        const refused = models('sync', COURSE, '--docs', f.docsRoot, '--unity', f.unity);
        expect(refused.code).not.toBe(0);
        expect(refused.out).toContain('DRIFT models.json');
        expect(refused.out).toContain('-      "species": "oak",');
        expect(readFileSync(path.join(f.unity, 'models.json'), 'utf8')).toBe(hand);

        expect(models('sync', COURSE, '--force', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        expect(resolvedIn(f)).toBe(true);
    });

    test('a trial --docs root is never synced into a project found by name', () => {
        const f = fixture();
        const r = models('sync', COURSE, '--docs', f.docsRoot);
        expect(r.code).not.toBe(0);
        expect(r.out).toContain('--unity');
    });
});

describe('the shared library', () => {
    test('add --shared puts the model in <docs root>/model-library.json; the course inherits it and refuses it again', () => {
        const f = fixture();
        const r = models('add', COURSE, BEECH, '--species', 'beech', '--shared', '--docs', f.docsRoot, '--unity', f.unity);
        expect(r.code).toBe(0);
        const shared = JSON.parse(readFileSync(path.join(f.docsRoot, 'model-library.json'), 'utf8'));
        expect(shared.format).toBe('golfmap-model-library-v1');
        expect(shared.models.map((m: { id: string }) => m.id)).toEqual([BEECH]);
        expect(existsSync(path.join(f.docs, 'models.json'))).toBe(false);
        expect(resolvedIn(f)).toBe(true);
        expect(JSON.parse(readFileSync(path.join(f.unity, 'models.json'), 'utf8')).models[0]).toMatchObject({ id: BEECH, species: 'beech', renderer: 'arborist' });

        const again = models('add', COURSE, BEECH, '--species', 'beech', '--docs', f.docsRoot);
        expect(again.code).not.toBe(0);
        expect(again.out).toContain('already in the model library');
    });

    test('promote moves a course-only model and an override into the shared library; the course resolves the same', () => {
        const f = fixture();
        expect(models('add', COURSE, BEECH, '--species', 'beech', '--shared', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        expect(models('add', COURSE, ELM, '--species', 'elm', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        // A look tuned to this course's light, as an override.
        const own = JSON.parse(readFileSync(path.join(f.docs, 'models.json'), 'utf8'));
        own.models.push({ id: BEECH, look: { hue: 0.02 } });
        writeFileSync(path.join(f.docs, 'models.json'), JSON.stringify(own, null, 2) + '\n');
        expect(models('sync', COURSE, '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        const before = readFileSync(path.join(f.unity, 'models.json'), 'utf8');

        const dry = models('promote', COURSE, BEECH, '--dry-run', '--docs', f.docsRoot, '--unity', f.unity);
        expect(dry.code).toBe(0);
        expect(readFileSync(path.join(f.docs, 'models.json'), 'utf8')).toBe(JSON.stringify(own, null, 2) + '\n');

        for (const id of [BEECH, ELM]) expect(models('promote', COURSE, id, '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        const shared = JSON.parse(readFileSync(path.join(f.docsRoot, 'model-library.json'), 'utf8'));
        expect(shared.models.map((m: { id: string }) => m.id)).toEqual([BEECH, ELM]);
        expect(shared.models[0].look).toEqual({ hue: 0.02 });
        expect(JSON.parse(readFileSync(path.join(f.docs, 'models.json'), 'utf8')).models).toEqual([]);
        expect(readFileSync(path.join(f.unity, 'models.json'), 'utf8')).toBe(before);
    });
});

describe("zone: a palette's own keys (Unity's vegetation palette editor saves its 'p:' entries this way)", () => {
    const PALETTES = {
        format: 'golfmap-grass-v1',
        palettes: [{ key: 'rough_tall', package: 'GolfMap lower vegetation', tintAreaScale: 30, distanceFalloff: 0.15, plantDistance: 300, items: [
            { name: 'Tall rough - green base', model: 'vsp:texture:Rustic Grass_15', sampleDistance: 0.4 },
        ] }],
    };
    const text = JSON.stringify(PALETTES, null, 2) + '\n';

    test('--dry-run writes nothing; the real run writes the repo and Unity gets it byte-equal; other keys are refused', () => {
        const f = fixture();
        const repoFile = path.join(f.docs, 'grass-palette.json'), unityFile = path.join(f.unity, 'grass-palette.json');
        writeFileSync(repoFile, text);
        expect(models('sync', COURSE, '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);

        const dry = models('zone', COURSE, 'rough_tall', '--set', 'tintAreaScale=42', '--dry-run', '--docs', f.docsRoot, '--unity', f.unity);
        expect(dry.code).toBe(0);
        expect(dry.out).toContain('tintAreaScale: 30 -> 42');
        expect(readFileSync(repoFile, 'utf8')).toBe(text);

        const real = models('zone', COURSE, 'rough_tall', '--set', 'tintAreaScale=42,distanceFalloff=0.2', '--docs', f.docsRoot, '--unity', f.unity);
        expect(real.code).toBe(0);
        const written = JSON.parse(readFileSync(repoFile, 'utf8')).palettes[0];
        expect(written).toMatchObject({ tintAreaScale: 42, distanceFalloff: 0.2, plantDistance: 300 });
        expect(written.items).toEqual(PALETTES.palettes[0]!.items);
        expect(same(repoFile, unityFile)).toBe(true);

        const after = readFileSync(repoFile, 'utf8');
        for (const set of ['sampleDistance=1', 'healthy=#ffffff', 'package=x']) {
            const refused = models('zone', COURSE, 'rough_tall', '--set', set, '--docs', f.docsRoot, '--unity', f.unity);
            expect(refused.code).not.toBe(0);
            expect(refused.out).toContain('a zone palette holds only');
        }
        expect(models('zone', COURSE, 'rough_tall', '--model', 'vsp:texture:Rustic Grass_15', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(2);
        expect(readFileSync(repoFile, 'utf8')).toBe(after);

        // Back to the start: the files are as they were, byte for byte.
        expect(models('zone', COURSE, 'rough_tall', '--set', 'tintAreaScale=30,distanceFalloff=0.15', '--docs', f.docsRoot, '--unity', f.unity).code).toBe(0);
        expect(readFileSync(repoFile, 'utf8')).toBe(text);
        expect(readFileSync(unityFile, 'utf8')).toBe(text);
    });
});
