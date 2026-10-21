// Acceptance C4 (CLI half), zone palettes on the model library: lower-vegetation models join the library, a
// model's look is changed in one place, and a zone item's model is swapped, all from the command line with
// --dry-run (Unity's and the web's buttons run the same verbs).
//
//   bun run models -- add "<course>" arborist:<label> --species <species> --form plant|shrub [--dry-run] [--docs <root>]
//   bun run models -- look "<course>" <model id> --set <key>=<value>[,<key>=<value>...] [--dry-run] [--docs <root>]
//   bun run models -- zone "<course>" <palette key> "<item name>" --model <model id> [--dry-run] [--docs <root>]
//
// `look` sets keys of the model's look in the course's models.json (an override when the model is shared) and
// names the zone items that wear it; `zone` changes one zone item's model in grass-palette.json and says who
// draws it before and after (VSP / Arborist). Either refuses a model the course's library lacks. Lower-vegetation
// models have form grass | plant | shrub and need no kind.
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..');
const COURSE = 'Ombergs Golfklubb';

function models(...args: string[]) {
    const proc = Bun.spawnSync(['bun', 'run', 'models', '--', ...args], { cwd: REPO });
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

const MODELS = {
    format: 'golfmap-models-v1',
    models: [
        { id: 'vsp:texture:Rustic Grass_15', renderer: 'vsp', form: 'grass', unity: { path: 'Assets/RUSTIC Grass/Textures/Rustic Grass_15.psd' },
          look: { healthy: '#5e9154', dry: '#6d9058', randomDarkening: 0.3 } },
        { id: 'vsp:texture:Rustic Grass_15#blond', renderer: 'vsp', form: 'grass', unity: { path: 'Assets/RUSTIC Grass/Textures/Rustic Grass_15.psd' },
          look: { healthy: '#a39a6a', dry: '#b0a36e' } },
        { id: 'vsp:Prefab_heath_A_01', species: 'heather', renderer: 'vsp', form: 'plant',
          unity: { path: 'Assets/NatureManufacture Assets/Mountain Environment/0-Prefab-OPCD-Optimized/Foliage and Grass/Prefab_heath_A_01.prefab' },
          look: { healthy: '#8c9684', dry: '#868c7c', shadows: false, material: { _BackFaceMirrorNormal: 0 } } },
        { id: 'arborist:MountainEnv_heath_A_01', species: 'heather', renderer: 'arborist', form: 'plant', heightM: 0.197, crownWidthM: 0.302, look: { tint: '#8c9684' } },
    ],
};

const PALETTE = {
    format: 'golfmap-grass-v1',
    palettes: [
        { key: 'rough_tall', package: 'GolfMap lower vegetation', items: [
            { name: 'Tall rough - green base', model: 'vsp:texture:Rustic Grass_15', width: 0.9, height: 0.55, sampleDistance: 0.432 },
            { name: 'Tall rough - straw', model: 'vsp:texture:Rustic Grass_15#blond', width: 0.8, height: 0.6, sampleDistance: 0.9 },
        ] },
        { key: 'woodland_floor/heath', package: 'GolfMap lower vegetation', items: [
            { name: 'Woodland heath - heather', model: 'vsp:Prefab_heath_A_01', minScale: 1.3, maxScale: 2.2, sampleDistance: 2.7 },
        ] },
        { key: 'rock_shore/heath', package: 'GolfMap lower vegetation', items: [
            { name: 'Rock heath - heather', model: 'vsp:Prefab_heath_A_01', minScale: 1.2, maxScale: 2.0, sampleDistance: 2.2 },
        ] },
    ],
};

function docsRoot() {
    const docs = mkdtempSync(path.join(os.tmpdir(), 'zone-models-docs-'));
    mkdirSync(path.join(docs, 'ombergs-golfklubb'));
    writeFileSync(path.join(docs, 'ombergs-golfklubb', 'models.json'), JSON.stringify(MODELS, null, 2));
    writeFileSync(path.join(docs, 'ombergs-golfklubb', 'grass-palette.json'), JSON.stringify(PALETTE, null, 2));
    return { docs, models: path.join(docs, 'ombergs-golfklubb', 'models.json'), palette: path.join(docs, 'ombergs-golfklubb', 'grass-palette.json') };
}

test('adding an Arborist ground plant: --dry-run shows it, the real run writes it with the catalogue size and no kind', () => {
    const { docs, models: file } = docsRoot();
    const before = readFileSync(file, 'utf8');

    const dry = models('add', COURSE, 'arborist:MountainEnv_heath_A_02', '--species', 'heather', '--form', 'plant', '--dry-run', '--docs', docs);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('arborist:MountainEnv_heath_A_02');
    expect(readFileSync(file, 'utf8')).toBe(before);

    const real = models('add', COURSE, 'arborist:MountainEnv_heath_A_02', '--species', 'heather', '--form', 'plant', '--docs', docs);
    expect(real.code).toBe(0);
    const model = JSON.parse(readFileSync(file, 'utf8')).models.find((m: { id: string }) => m.id === 'arborist:MountainEnv_heath_A_02');
    expect(model).toMatchObject({ species: 'heather', renderer: 'arborist', form: 'plant' });
    expect(model.kind).toBeUndefined();
    expect(model.heightM).toBeCloseTo(0.18, 2);
});

test("a model's look is set once and names every zone item that wears it; --dry-run writes nothing", () => {
    const { docs, models: file, palette } = docsRoot();
    const before = readFileSync(file, 'utf8');
    const paletteBefore = readFileSync(palette, 'utf8');

    const dry = models('look', COURSE, 'vsp:Prefab_heath_A_01', '--set', 'healthy=#7a8a70', '--dry-run', '--docs', docs);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('Woodland heath - heather');
    expect(dry.out).toContain('Rock heath - heather');
    expect(dry.out).toContain('#7a8a70');
    expect(readFileSync(file, 'utf8')).toBe(before);

    const real = models('look', COURSE, 'vsp:Prefab_heath_A_01', '--set', 'healthy=#7a8a70', '--docs', docs);
    expect(real.code).toBe(0);
    const model = JSON.parse(readFileSync(file, 'utf8')).models.find((m: { id: string }) => m.id === 'vsp:Prefab_heath_A_01');
    expect(model.look).toEqual({ healthy: '#7a8a70', dry: '#868c7c', shadows: false, material: { _BackFaceMirrorNormal: 0 } });
    expect(readFileSync(palette, 'utf8')).toBe(paletteBefore);   // the zones only refer to the model

    const unknown = models('look', COURSE, 'vsp:Prefab_nothing', '--set', 'healthy=#7a8a70', '--docs', docs);
    expect(unknown.code).not.toBe(0);
    expect(unknown.out).toContain('vsp:Prefab_nothing');
});

test("swapping a zone item's model moves it from VSP to Arborist; --dry-run writes nothing; an unknown model is refused", () => {
    const { docs, palette } = docsRoot();
    const before = readFileSync(palette, 'utf8');

    const dry = models('zone', COURSE, 'woodland_floor/heath', 'Woodland heath - heather', '--model', 'arborist:MountainEnv_heath_A_01', '--dry-run', '--docs', docs);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('vsp:Prefab_heath_A_01');
    expect(dry.out).toContain('arborist:MountainEnv_heath_A_01');
    expect(dry.out).toContain('VSP');
    expect(dry.out).toContain('Arborist');
    expect(readFileSync(palette, 'utf8')).toBe(before);

    const real = models('zone', COURSE, 'woodland_floor/heath', 'Woodland heath - heather', '--model', 'arborist:MountainEnv_heath_A_01', '--docs', docs);
    expect(real.code).toBe(0);
    const doc = JSON.parse(readFileSync(palette, 'utf8')) as typeof PALETTE;
    const heath = doc.palettes.find((p) => p.key === 'woodland_floor/heath')!.items[0]!;
    expect(heath).toEqual({ name: 'Woodland heath - heather', model: 'arborist:MountainEnv_heath_A_01', minScale: 1.3, maxScale: 2.2, sampleDistance: 2.7 });
    expect(doc.palettes.find((p) => p.key === 'rock_shore/heath')!.items[0]!.model).toBe('vsp:Prefab_heath_A_01');

    const after = readFileSync(palette, 'utf8');
    const unknown = models('zone', COURSE, 'rock_shore/heath', 'Rock heath - heather', '--model', 'arborist:Nope', '--docs', docs);
    expect(unknown.code).not.toBe(0);
    expect(unknown.out).toContain('arborist:Nope');
    expect(readFileSync(palette, 'utf8')).toBe(after);
});
