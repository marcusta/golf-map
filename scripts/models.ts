// A course's model library (docs/gspro/<course>/models.json, golfmap-models-v1) from the command line.
//
//   bun run models -- add "<course>" arborist:<label> --species <species> [--kind broadleaf|conifer]
//                     [--form tree|shrub] [--dry-run] [--docs <course docs root>]
//   bun run models -- list "<course>" [--docs <course docs root>]
//
// `add` sizes an Arborist model from Arborist's catalogue (data/arborist/catalog-sizes.json, first LOD)
// and refuses a label Arborist does not have. --dry-run prints the entry and writes nothing. The
// palette is not touched: the course plants a model once its palette refers to it (Unity's Palette
// panel, "Add Arborist model", does both, on Unity's own copy).
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { courseSlug } from '../server/services/gspro-export.service';
import { addArboristModel, loadArboristCatalogue, loadModelLibrary, writeModelLibrary } from '../shared/vegetation/tree-models';

const ROOT = path.resolve(import.meta.dir, '..');
const USAGE = 'usage: bun run models -- add "<course>" arborist:<label> --species <species> [--kind broadleaf|conifer] [--form tree|shrub] [--dry-run] [--docs <root>]\n'
    + '       bun run models -- list "<course>" [--docs <root>]';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
};
const VALUED = new Set(['--species', '--kind', '--form', '--docs']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1] ?? ''));
const [verb, course, id] = positional;

function fail(message: string): never {
    console.error(`error: ${message}`);
    process.exit(1);
}

if (!verb || !course || (verb === 'add' && !id) || !['add', 'list'].includes(verb)) {
    console.error(USAGE);
    process.exit(2);
}

const docsRoot = path.resolve(flag('--docs') ?? path.join(ROOT, 'docs', 'gspro'));
const docs = path.join(docsRoot, courseSlug(course));
if (!existsSync(docs)) fail(`no course docs folder ${docs} for '${course}'`);

try {
    const library = loadModelLibrary(docs);
    if (verb === 'list') {
        for (const m of library.models) console.log(`${m.id}  ${m.species ?? m.kind}  ${m.renderer}  ${m.heightM.toFixed(1)} m x ${m.crownWidthM.toFixed(1)} m`);
        if (!library.models.length) console.log(`no models in ${path.join(docs, 'models.json')}`);
    } else {
        const dataDir = process.env.DATA_DIR ?? path.join(ROOT, 'data');
        const catalogueFile = path.join(dataDir, 'arborist', 'catalog-sizes.json');
        if (!existsSync(catalogueFile)) fail(`no Arborist catalogue sizes at ${catalogueFile} (the mod's arb.catalog with sizes, docs/gspro/arborist.md)`);
        const { library: next, model } = addArboristModel(library, {
            id: id!, species: flag('--species')!, kind: flag('--kind') ?? 'broadleaf', form: flag('--form') ?? 'tree',
        }, loadArboristCatalogue(catalogueFile));
        const line = `${model.id}: ${model.species}, ${model.renderer}, ${model.heightM.toFixed(1)} m tall, ${model.crownWidthM.toFixed(1)} m crown (${model.kind} ${model.form})`;
        if (args.includes('--dry-run')) {
            console.log(`would add to ${path.join(docs, 'models.json')}:\n  ${line}\n${JSON.stringify(model, null, 2)}`);
        } else {
            writeModelLibrary(docs, next);
            console.log(`added to ${path.join(docs, 'models.json')}:\n  ${line}\n`
                + `The course plants it once its palette refers to it: {"model": "${model.id}", "enabled": true} under assets (Unity's Palette panel).`);
        }
    }
} catch (e) {
    fail((e as Error).message);
}
