// The course's Arborist file, written from golf-map: `arboristdata.dat` in the
// GSPro course folder, which GSPro draws most of the vegetation from (trees
// but the course's own near the play, bushes, the woodland floor's plants,
// the far billboards; docs/gspro/arborist.md). `pipeline/arborist.py` writes
// it, one package per command; this service finds the command's inputs from
// the course and runs it through the export runner:
//
//   - `lower`  the palette's prefab items spread by the inner zones export's
//              masks. Needs no Unity.
//   - `trees`  the planted trees. Their positions and ground heights are the
//              Unity scene's (`golfmap.trees.dump`, hand edits included), so
//              it runs only with the course's Unity project open.
//
// Nothing is configured per course beyond what the course already has:
//
//   GSPro course folder   courses.gspro_course_dir (the export panel's
//                         "GSPro course folder"); its arboristdata.dat is the
//                         document the packages go into, its .GKD the boundary
//   species, palettes     <courseDocsRoot>/<slug>/arborist-species.json,
//                         grass-palette.json and palette.json (the trees'
//                         rules; docs/gspro/<slug>/). A course without the
//                         species file is not an Arborist course.
//   zones, surface map,   the course's export folder (<slug>-inner-zones.json,
//   stems, terrains       <slug>-inner-surfaces.json, <slug>-inner-trees.json,
//   square                the heightmap sidecars: the square is the union of
//                         the terrains they place)
//   library, model sizes, <dataDir>/arborist/ (machine-wide, from a running
//   planted trees         Arborist; <slug>-planted-trees.json from Unity)
//   wrapper key           <dataDir>/arborist-wrapper.key, never in the repo
//                         (GOLFMAP_ARBORIST_KEY overrides)
import * as path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { courseSlug, placementsExportFileName, statOrNull, surfacesExportFileName, treesExportFileName, zonesExportFileName, type ExportRunner } from './gspro-export.service';
import type { UnityEditor } from './unity-bridge';

/** `arborist.py lower` on Vreta takes 10 s, `trees` 5 s plus the dump; a 5 km outer square with the far rule is the slow case. */
export const ARBORIST_LOWER_TIMEOUT_MS = 5 * 60_000;
export const ARBORIST_TREES_TIMEOUT_MS = 15 * 60_000;
/** `golfmap.trees.dump` writes every stored tree (Vreta: 144 000, 10 MB). */
export const TREES_DUMP_TIMEOUT_SEC = 300;

export interface ArboristDeps {
    dataDir: string;
    pipelineDir: string;
    /** `<root>/<course slug>/` holds the course's arborist-species.json and grass-palette.json. */
    courseDocsRoot: string;
    runner: ExportRunner;
    /** Write here instead of into the GSPro course folder (tests, trial runs); the course folder's file is still the base. */
    outDir?: string;
}

/** What the service needs to know of a course (GsproExportService.settings has it). */
export interface ArboristCourse {
    name: string;
    /** The course's GSPro export folder. */
    exportDir: string;
    /** The course's folder under GSPro's Courses; null = not set. */
    courseDir: string | null;
}

/** What a run did. `error` is the first step that could not run or failed; the steps before it are in `report`. */
export interface ArboristResult {
    /** False when the course has no species file: nothing was attempted. */
    used: boolean;
    report: string[];
    /** The parts written, for a one-line summary: 'lower vegetation', 'trees'. */
    written: string[];
    error: string | null;
}

export class ArboristService {
    constructor(private readonly deps: ArboristDeps) {}

    private docs(course: ArboristCourse, file: string): string {
        return path.join(this.deps.courseDocsRoot, courseSlug(course.name), file);
    }

    /** A course is an Arborist course when it has a species file. */
    async used(course: ArboristCourse): Promise<boolean> {
        return !!await statOrNull(this.docs(course, 'arborist-species.json'));
    }

    /**
     * Write the course's Arborist file: the lower vegetation, then (with
     * `trees`) the planted trees out of `editor`'s scene. Never throws for a
     * step that cannot run: the result says what was written and what was not.
     */
    async generate(course: ArboristCourse, opts: { trees: boolean; editor?: UnityEditor | null }): Promise<ArboristResult> {
        const result: ArboristResult = { used: await this.used(course), report: [], written: [], error: null };
        if (!result.used) {
            result.report.push(`Arborist: not used by this course (no ${this.docs(course, 'arborist-species.json')})`);
            return result;
        }
        try {
            result.report.push(...await this.lower(course));
            result.written.push('lower vegetation');
            if (!opts.trees) return result;
            if (!opts.editor) {
                result.report.push("Arborist trees: skipped, Unity is not open (the trees' positions and ground heights come from its scene); "
                    + 'the file keeps the trees as last generated');
                return result;
            }
            result.report.push(...await this.trees(course, opts.editor));
            result.written.push('trees');
        } catch (e) {
            result.error = (e as Error).message.split('\n')[0]!;
        }
        return result;
    }

    /** `arborist.py lower`: the palette's prefab items on the inner zones export's masks. Throws what is missing. */
    async lower(course: ArboristCourse): Promise<string[]> {
        const common = await this.common(course);
        const palette = this.docs(course, 'grass-palette.json');
        if (!await statOrNull(palette)) throw new Error(`Arborist lower vegetation not written: no palette at ${palette}`);
        const zones = path.join(course.exportDir, zonesExportFileName(course.name, 'inner'));
        if (!await statOrNull(zones)) throw new Error(`Arborist lower vegetation not written: no zones export yet (${zones}) - plant once first`);
        const stdout = await this.run('Arborist lower vegetation', [
            'lower', ...common.args, '--palette', palette, '--zones', zones,
        ], ARBORIST_LOWER_TIMEOUT_MS);
        const counts = /(\d+) item\(s\), (\d+) mask texture\(s\)/.exec(stdout);
        return [
            `Arborist lower vegetation written: ${counts?.[1] ?? '?'} items, ${counts?.[2] ?? '?'} mask textures (${common.out})`,
            ...notes(stdout),
        ];
    }

    /**
     * The planted trees: `golfmap.trees.dump` in the open editor (read-only
     * there), then `arborist.py trees`, with the far and ring rules when the
     * course has a surface map and a boundary. Throws what is missing.
     */
    async trees(course: ArboristCourse, editor: UnityEditor): Promise<string[]> {
        const common = await this.common(course);
        const slug = courseSlug(course.name);
        const sizes = path.join(this.deps.dataDir, 'arborist', 'catalog-sizes.json');
        if (!await statOrNull(sizes)) {
            throw new Error(`Arborist trees not written: no model sizes at ${sizes} (the mod's arb.catalog with sizes, docs/gspro/arborist.md)`);
        }
        const square = await terrainsSquare(course.exportDir, slug);
        if (!square) {
            throw new Error(`Arborist trees not written: no inner heightmap sidecar in ${course.exportDir} - export the inner heightmap first (it places the terrains)`);
        }
        const planted = path.join(this.deps.dataDir, 'arborist', `${slug}-planted-trees.json`);
        let dumped: { catalogues?: { trees?: number }[] } | null;
        try {
            dumped = await editor.run('golfmap.trees.dump', { file: planted }, TREES_DUMP_TIMEOUT_SEC);
        } catch (e) {
            throw new Error(`Arborist trees not written: Unity (${editor.projectName}) could not write the planted trees: ${(e as Error).message.split('\n')[0]}`);
        }
        const count = (dumped?.catalogues ?? []).reduce((n, c) => n + (c.trees ?? 0), 0);

        const args = ['trees', ...common.args, '--planted', planted, '--sizes', sizes, '--terrains-square', ...square.map(String)];
        const report: string[] = [];
        const surfaces = path.join(course.exportDir, surfacesExportFileName(course.name, 'inner'));
        const boundary = (await readdir(course.courseDir!)).some(n => n.toLowerCase().endsWith('.gkd'));
        if (await statOrNull(surfaces) && boundary) args.push('--surfaces', surfaces);
        else {
            report.push(`Arborist trees: no ${boundary ? 'surface map (golfmap.surfaces.export in Unity)' : '.GKD with the course boundary in the GSPro course folder'}, `
                + 'so no far rule or ring: only the outer terrain\'s trees are billboards');
        }
        // A tree whose Arborist model is another shape than its Unity prefab is sized to its lidar stem by the
        // palette's rules (SizeFit), not to the prefab's height.
        const stems = path.join(course.exportDir, treesExportFileName(course.name, 'inner'));
        const palette = this.docs(course, 'palette.json');
        if (await statOrNull(stems) && await statOrNull(palette)) args.push('--stems', stems, '--palette', palette);
        // The trees of Arborist models are not in the course's VSP, so not in the dump: Unity's planter hands them
        // over as placements (<slug>-<terrain>-placements.json), in the look the model library gives them.
        const placements: string[] = [];
        for (const terrain of ['inner', 'outer'] as const) {
            const file = path.join(course.exportDir, placementsExportFileName(course.name, terrain));
            if (await statOrNull(file)) placements.push(file);
        }
        if (placements.length) args.push('--placements', ...placements);
        const models = this.docs(course, 'models.json');
        if (await statOrNull(models)) args.push('--models', models);
        // The trees the course's own VSP must stop drawing: arborist.py writes the list beside the planted trees.
        const farFile = path.join(path.dirname(planted), `${slug}-vsp-far.json`);
        const before = await positionsIn(farFile);
        const stdout = await this.run('Arborist trees', args, ARBORIST_TREES_TIMEOUT_MS);
        const counts = /: (\d+) trees of (\d+) Arborist species/.exec(stdout);
        report.unshift(`Arborist trees written: ${counts?.[1] ?? '?'} trees of ${counts?.[2] ?? '?'} species, from ${count} planted in Unity (${editor.projectName})`);
        report.push(...notes(stdout).filter(l => !/tree\(s\) of the course's VSP are now Arborist's/.test(l)));
        if (await positionsIn(farFile) !== before) {
            report.push(`warning: the trees Arborist draws in place of the course's own changed. In Unity: golfmap.vsp.trees.trim restore=true, `
                + `then golfmap.vsp.trees.trim file=${farFile}, save the scene and build the course - until then those trees are drawn twice or not at all`);
        }
        return report;
    }

    /** What both commands take, checked: the course folder and its file, the key, the library, the species file. */
    private async common(course: ArboristCourse): Promise<{ args: string[]; out: string }> {
        if (!course.courseDir) {
            throw new Error("Arborist file not written: set the GSPro course folder first (export panel, GreenKeeper course file) - the course's folder under GSPro's Courses");
        }
        if (!(await statOrNull(course.courseDir))?.isDirectory()) throw new Error(`Arborist file not written: the GSPro course folder ${course.courseDir} is gone`);
        const outDir = this.deps.outDir ?? course.courseDir;
        const out = path.join(outDir, 'arboristdata.dat');
        // A run into another folder builds on what it wrote there before; else on the course's own file.
        const base = this.deps.outDir && await statOrNull(out) ? out : path.join(course.courseDir, 'arboristdata.dat');
        if (!await statOrNull(base)) {
            throw new Error(`Arborist file not written: no arboristdata.dat in ${course.courseDir} yet. golf-map only replaces its own packages in it; `
                + 'the first file is made by hand (docs/gspro/arborist.md)');
        }
        const key = process.env.GOLFMAP_ARBORIST_KEY ?? path.join(this.deps.dataDir, 'arborist-wrapper.key');
        if (!await statOrNull(key)) {
            throw new Error(`Arborist file not written: no wrapper key at ${key} (16 bytes, kept out of the repo; docs/gspro/arborist.md, "What GSPro reads")`);
        }
        const library = path.join(this.deps.dataDir, 'arborist', 'GolfMap library.biome');
        if (!await statOrNull(library)) {
            throw new Error(`Arborist file not written: no species library at ${library} (exported from a running Arborist: bun unity/ArboristMod/library.ts)`);
        }
        const args = ['--course-dir', course.courseDir, '--species', this.docs(course, 'arborist-species.json'), '--library', library, '--key-file', key];
        if (base !== path.join(course.courseDir, 'arboristdata.dat')) args.push('--base', base);
        if (this.deps.outDir) args.push('--out-dir', outDir);
        return { args, out };
    }

    private async run(what: string, args: string[], timeoutMs: number): Promise<string> {
        const { code, stdout, stderr } = await this.deps.runner([path.join(this.deps.pipelineDir, 'arborist.py'), ...args], this.deps.pipelineDir, { timeoutMs });
        if (code !== 0) {
            // arborist.py's own refusals are one line; a crash ends in the exception's line.
            const last = (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n').filter(l => l.trim()).at(-1)!.trim();
            throw new Error(`${what} not written: ${last}`);
        }
        return stdout;
    }
}

/**
 * arborist.py's output without its per-item lists: the lines that say what
 * was left out, thinned or kept elsewhere. The indented list under "no
 * Arborist species for" stays, since those names are what to act on.
 */
function notes(stdout: string): string[] {
    const kept: string[] = [];
    let list = false;
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        if (/^\s/.test(line)) {
            if (list) kept.push(`  ${line.trim()}`);
            continue;
        }
        list = line.startsWith('no Arborist species for');
        if (!line.startsWith('wrote ')) kept.push(list ? `warning: ${line.trim()}` : line.trim());
    }
    return kept;
}

/** The `positions` of a golfmap-vsp-far-v1 file as text, for comparing two runs; no file = no positions. */
async function positionsIn(file: string): Promise<string> {
    try {
        return JSON.stringify(JSON.parse(await readFile(file, 'utf8')).positions ?? []);
    } catch {
        return '[]';
    }
}

/**
 * The Unity world square of the course's terrains together (x0, z0, x1, z1),
 * which GSPro lays its Arborist cells over: from the heightmap sidecars in
 * the export folder (`unity.position` and `sideM`; the inner stands at the
 * origin, the outer's sidecar carries its place). Null without the inner's.
 */
export async function terrainsSquare(exportDir: string, slug: string): Promise<[number, number, number, number] | null> {
    let names: string[] = [];
    try {
        names = await readdir(exportDir);
    } catch {
        return null;
    }
    const squares: [number, number, number, number][] = [];
    for (const kind of ['inner', 'outer'] as const) {
        // A terrain whose side changed leaves its old sidecar behind: the newest one is the terrain's.
        let name: string | null = null, newest = -1;
        for (const n of names.filter(n => n.startsWith(`${slug}-${kind}-dem-`) && n.endsWith('m.tif.json'))) {
            const modified = (await statOrNull(path.join(exportDir, n)))?.mtimeMs ?? 0;
            if (modified > newest) { name = n; newest = modified; }
        }
        if (!name) {
            if (kind === 'inner') return null;
            continue;
        }
        try {
            const sidecar = JSON.parse(await readFile(path.join(exportDir, name), 'utf8')) as { sideM?: number; unity?: { position?: { x?: number; z?: number } } };
            const x = sidecar.unity?.position?.x ?? 0, z = sidecar.unity?.position?.z ?? 0, side = sidecar.sideM;
            if (typeof side !== 'number') throw new Error('no sideM');
            squares.push([x, z, x + side, z + side]);
        } catch {
            if (kind === 'inner') return null;
        }
    }
    return [
        Math.min(...squares.map(s => s[0])), Math.min(...squares.map(s => s[1])),
        Math.max(...squares.map(s => s[2])), Math.max(...squares.map(s => s[3])),
    ];
}
