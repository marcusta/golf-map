// Acceptance A5 (CLI half): an Arborist model joins a course's model library from the command line,
// sized from Arborist's catalogue (data/arborist/catalog-sizes.json: CE_DA_Forest_Tree_16018 is
// 22.9 m tall with a 14.0 m crown in its first LOD), and --dry-run only shows the entry.
//
//   bun run models -- add "<course>" <model id> --species <species> [--dry-run] [--docs <course docs root>]
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = path.resolve(import.meta.dir, '..');

function models(...args: string[]) {
    const proc = Bun.spawnSync(['bun', 'run', 'models', '--', ...args], { cwd: REPO });
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

test('adding an Arborist beech: --dry-run shows it, the real run writes it with the catalogue size', () => {
    const docs = mkdtempSync(path.join(os.tmpdir(), 'models-docs-'));
    mkdirSync(path.join(docs, 'ombergs-golfklubb'));
    const file = path.join(docs, 'ombergs-golfklubb', 'models.json');

    const dry = models('add', 'Ombergs Golfklubb', 'arborist:CE_DA_Forest_Tree_16018', '--species', 'beech', '--dry-run', '--docs', docs);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('arborist:CE_DA_Forest_Tree_16018');
    expect(dry.out).toContain('22.9');
    expect(existsSync(file)).toBe(false);

    const real = models('add', 'Ombergs Golfklubb', 'arborist:CE_DA_Forest_Tree_16018', '--species', 'beech', '--docs', docs);
    expect(real.code).toBe(0);
    const library = JSON.parse(readFileSync(file, 'utf8'));
    expect(library.format).toBe('golfmap-models-v1');
    const model = library.models.find((m: { id: string }) => m.id === 'arborist:CE_DA_Forest_Tree_16018');
    expect(model).toMatchObject({ species: 'beech', renderer: 'arborist', kind: 'broadleaf', form: 'tree' });
    expect(model.heightM).toBeCloseTo(22.9, 1);
    expect(model.crownWidthM).toBeCloseTo(14.0, 1);
});

test('a model Arborist does not have is refused and nothing is written', () => {
    const docs = mkdtempSync(path.join(os.tmpdir(), 'models-docs-'));
    mkdirSync(path.join(docs, 'ombergs-golfklubb'));
    const r = models('add', 'Ombergs Golfklubb', 'arborist:CESimgolf_Elm4_Tall', '--species', 'elm', '--docs', docs);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('CESimgolf_Elm4_Tall');
    expect(existsSync(path.join(docs, 'ombergs-golfklubb', 'models.json'))).toBe(false);
});
