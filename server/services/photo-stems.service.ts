// Photo stems: young trees on open ground (rough, semi rough, deep rough, fairway) that the lidar missed, found
// from their shadows in the summer photo by `golfpipe photo-stems` (pipeline/golfpipe/photo_stems.py, its rules in
// pipeline/vegetation-rules/photo-stems.json). A proposal until accepted; accepted ones are planted like lidar stems.
//
// One implementation for both ways in: the Vegetation mode's "Find trees in photo" (web/src/zones/photo-stems*.ts)
// and `bun run trees:photo` (scripts/trees-photo.ts).
//
// - propose: the site's summer photo (the newest leaf-on vintage of the tiles manifest), its leaf-off photo (the
//   newest leaf-off one, for the kind), the lidar stems and the course's features go to the pipeline; what comes back
//   leaves out the ids already accepted or skipped. A dry run writes nothing under the data folder; a real one keeps
//   the proposal (`tiles/<site>/photo-stems-proposal.json`) for accept to look the ids up in.
// - accept: the accepted stems go to their own asset next to the lidar stems, `tiles/<site>/tree-stems-photo.json`
//   (the tree-stems asset's shape plus `id` and `source` per row, and the `skipped` ids), so "Regenerate trees" never
//   wipes them; the GSPro trees export plants them with `src: "photo"` (GsproExportService.exportTrees).
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { AssetsService } from './assets.service';
import type { CoursesService } from './courses.service';
import type { CourseFeaturesService } from './course-features.service';
import { courseSlug, defaultRunner, ensureDir, failure, statOrNull, venvPython, type ExportRunner } from './gspro-export.service';
import { readJsonOrNull, writeAtomic } from './json-file';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { VEGETATION_RULES_FILE, readRuleDefaults, ruleOf } from './vegetation-generators';

export const PHOTO_STEMS_FORMAT = 'golfmap-photo-stems-v1';
/** The source tag of a photo stem: the same wire value as PHOTO_SOURCE in pipeline/golfpipe/stems_asset.py. */
export const PHOTO_STEM_SOURCE = 'ortho-shadow';
/** The accepted photo stems' asset: the tree-stems asset's fields plus `id` and `source`. */
export const PHOTO_STEMS_FIELDS = ['x', 'y', 'heightM', 'crownRadiusM', 'groundM', 'kind', 'id', 'source'] as const;
/** A stem's kind code (PhotoStemProposal.kind, the tree-stems asset's `kind`) by name: golfpipe/trees_stems.py KIND_*. */
export const PHOTO_STEM_KINDS = ['broadleaf', 'conifer', 'unknown'] as const;
export type PhotoStemKindName = (typeof PHOTO_STEM_KINDS)[number];
const PROPOSAL_FILE = 'photo-stems-proposal.json';
/** Leaf-off months when the rules file cannot be read (trees.json `leaf-off-months`). */
const LEAF_OFF_MONTHS = [10, 11, 12, 1, 2, 3, 4];

/** A kind code's name ('unknown' for a code outside the list). */
export function photoStemKindName(kind: number): PhotoStemKindName {
    return PHOTO_STEM_KINDS[kind] ?? 'unknown';
}

/** One young tree the photo shows and the lidar missed. */
export interface PhotoStemProposal {
    /** `epsg3006:<x>:<y>`, the id gspro.py trees gives a stem there. */
    id: string;
    x: number;
    y: number;
    heightM: number;
    crownRadiusM: number;
    /** From the site's DEM, when it has one. */
    groundM?: number;
    /** 0 broadleaf, 1 conifer, 2 unknown (from the leaf-off photo; PHOTO_STEM_KINDS). */
    kind: number;
    source: string;
    shadowLengthM?: number;
    shadowAreaM2?: number;
}

/** A lidar stem whose own shadow the calibration used, with its height read back from that shadow (left out). */
export interface PhotoStemMatch {
    x: number;
    y: number;
    heightM: number;
    crownRadiusM: number;
    heightFromShadowM: number;
}

/** How the photo was read: golfpipe photo_stems.run's `calibration` (Calibration.doc plus the sun and the counts). */
export interface PhotoStemsCalibration {
    /** Compass azimuth from a tree toward its shadow. */
    shadowAzimuthDeg: number;
    /** Lidar stems the shadow direction was read from (too few: the default direction). */
    directionFrom: number;
    /** Lidar stems matched to their own shadow. */
    matched: number;
    /** Too few matched: the default sun factor and sizes. */
    fallback: boolean;
    /** Shadow tip distance per metre of height. */
    sunFactor: number;
    radiusPerWidth: number;
    /** [a, b] of height = a + b x tip distance; null without enough matches. */
    heightLine: number[] | null;
    /** [a, b] of crown radius = a + b x shadow width; null without enough matches. */
    radiusLine: number[] | null;
    matchedOffsetM: number | null;
    /** Shadows on open ground, and photo tiles read. */
    shadows: number;
    tiles: number;
}

export interface PhotoStemsProposal {
    courseId: string;
    siteId: string;
    proposals: PhotoStemProposal[];
    calibration: PhotoStemsCalibration;
    matched: PhotoStemMatch[];
    /** The photos read: the summer one's collection and the leaf-off one's (null: none, every kind unknown). */
    summer: string;
    leafOff: string | null;
    /** Already accepted / skipped (left out of `proposals`). */
    accepted: number;
    skipped: number;
    dryRun: boolean;
}

export interface PhotoStemsAcceptResult {
    courseId: string;
    accepted: number;
    skipped: number;
    /** The asset the accepted stems are kept in. */
    path: string;
}

type AssetRow = (number | string | null)[];
type PhotoStemsField = (typeof PHOTO_STEMS_FIELDS)[number];

/** The accepted photo stems asset (tiles/<site>/tree-stems-photo.json). */
interface PhotoStemsAsset {
    version: 2;
    crs: 'EPSG:3006';
    source: string;
    fields: string[];
    trees: AssetRow[];
    skipped: string[];
}

/** What `golfpipe photo-stems` writes. */
interface PipelineDoc {
    format: string;
    calibration: PhotoStemsCalibration;
    matched: PhotoStemMatch[];
    proposals: PhotoStemProposal[];
}

/** What propose hands the pipeline: the site's files (the optional ones null when missing). */
interface PhotoStemsInputs {
    siteId: string;
    stems: string;
    summer: string;
    summerTif: string;
    leafOff: string | null;
    leafOffTif: string | null;
    dem: string | null;
    /** The accepted photo stems asset, and what it holds (null: none yet). */
    photoStems: string;
    known: PhotoStemsAsset | null;
}

interface OrthoVintage { collection: string; dates?: string[] }

export interface PhotoStemsDeps {
    courses: CoursesService;
    courseFeatures: Pick<CourseFeaturesService, 'listByCourse'>;
    assets: AssetsService;
    dataDir: string;
    pipelineDir?: string;
    runner?: ExportRunner;
    /** Where each course's docs folder lives (its vegetation-rules.json; default `<pipelineDir>/../docs/gspro`). */
    courseDocsRoot?: string;
}

export class PhotoStemsService {
    private readonly courses: CoursesService;
    private readonly courseFeatures: Pick<CourseFeaturesService, 'listByCourse'>;
    private readonly assets: AssetsService;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;
    private readonly courseDocsRoot: string;

    constructor(deps: PhotoStemsDeps) {
        this.courses = deps.courses;
        this.courseFeatures = deps.courseFeatures;
        this.assets = deps.assets;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        this.runner = deps.runner ?? defaultRunner(process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir));
        this.courseDocsRoot = deps.courseDocsRoot ?? path.join(this.pipelineDir, '..', 'docs', 'gspro');
    }

    /** The young trees the summer photo shows on the course's open ground and the lidar missed, less those already accepted or skipped. */
    async propose(courseId: string, opts: { dryRun?: boolean } = {}): Promise<PhotoStemsProposal> {
        const inputs = await this.inputsFor(courseId);
        const doc = await this.runPipeline(courseId, inputs);
        if (!opts.dryRun) await this.keepProposal(inputs.siteId, courseId, doc.proposals);
        return {
            courseId, siteId: inputs.siteId,
            proposals: doc.proposals,
            calibration: doc.calibration,
            matched: doc.matched.map(({ x, y, heightM, crownRadiusM, heightFromShadowM }) => ({ x, y, heightM, crownRadiusM, heightFromShadowM })),
            summer: inputs.summer, leafOff: inputs.leafOff,
            accepted: inputs.known?.trees.length ?? 0,
            skipped: inputs.known?.skipped.length ?? 0,
            dryRun: !!opts.dryRun,
        };
    }

    /**
     * Keep the `accept` ids of the last proposal as photo stems and remember the `skip` ids, so the next proposal
     * offers neither. An id already accepted can be skipped (it is taken out again) and the other way round.
     */
    async accept(courseId: string, input: { accept: string[]; skip: string[] }): Promise<PhotoStemsAcceptResult> {
        const siteId = await this.siteOf(courseId);
        const accept = [...new Set(input.accept)];
        const skip = [...new Set(input.skip)];
        const both = accept.filter((id) => skip.includes(id));
        if (both.length) throw new ConflictError(`Accept or skip, not both: ${both.join(', ')}`);
        const last = await readJsonOrNull<{ courseId: string; proposals: PhotoStemProposal[] }>(this.proposalFile(siteId));
        const byId = new Map((last?.proposals ?? []).map((p) => [p.id, p]));
        const missing = accept.filter((id) => !byId.has(id));
        if (missing.length) {
            throw new ConflictError(`Not in the last proposal: ${missing.join(', ')} — find the trees in the photo again first`);
        }
        const file = this.assets.resolvePhotoStemsPath(siteId);
        const asset = await readAsset(file) ?? emptyAsset();
        const idAt = asset.fields.indexOf('id');
        const rows = asset.trees.filter((r) => !skip.includes(String(r[idAt])) && !accept.includes(String(r[idAt])));
        for (const id of accept) rows.push(assetRow(byId.get(id)!));
        rows.sort((a, b) => String(a[idAt]).localeCompare(String(b[idAt])));
        const skipped = [...new Set([...asset.skipped.filter((id) => !accept.includes(id)), ...skip])].sort();
        await ensureDir(path.dirname(file));
        await writeAtomic(file, JSON.stringify({ ...emptyAsset(), trees: rows, skipped }) + '\n');
        return { courseId, accepted: rows.length, skipped: skipped.length, path: file };
    }

    /** The site's files the pipeline reads, checked: the lidar stems and the summer photo must be there. */
    private async inputsFor(courseId: string): Promise<PhotoStemsInputs> {
        const siteId = await this.siteOf(courseId);
        const stems = this.assets.resolveTreeStemsPath(siteId);
        if (!await statOrNull(stems)) throw new ConflictError('No tree stems for this course yet — run "Regenerate trees" on the map first');
        const { summer, leafOff } = await this.photos(siteId);
        const sources = path.join(this.dataDir, 'sources', siteId);
        const summerTif = path.join(sources, `ortho-${summer}.tif`);
        if (!await statOrNull(summerTif)) throw new ConflictError(`No summer photo (sources/ortho-${summer}.tif) for this course — build its map first`);
        const leafOffTif = leafOff ? path.join(sources, `ortho-${leafOff}.tif`) : null;
        const leafOffThere = !!leafOffTif && !!await statOrNull(leafOffTif);
        const dem = path.join(sources, 'dem.tif');
        const photoStems = this.assets.resolvePhotoStemsPath(siteId);
        return {
            siteId, stems, summer, summerTif,
            leafOff: leafOffThere ? leafOff : null,
            leafOffTif: leafOffThere ? leafOffTif : null,
            dem: await statOrNull(dem) ? dem : null,
            photoStems,
            known: await readAsset(photoStems),
        };
    }

    /** Run `golfpipe photo-stems` on the inputs and the course's features, in a work folder of its own. */
    private async runPipeline(courseId: string, inputs: PhotoStemsInputs): Promise<PipelineDoc> {
        const features = (await this.courseFeatures.listByCourse(courseId)).map((f) => ({
            type: f.type, source: f.source, attributes: f.attributes ?? null, geometry: f.geometry,
        }));
        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-photo-stems-'));
        try {
            const input = path.join(work, 'features.json');
            const output = path.join(work, 'photo-stems.json');
            await writeFile(input, JSON.stringify(features));
            const args = [
                '-m', 'golfpipe', 'photo-stems',
                '--summer-ortho', inputs.summerTif,
                ...(inputs.leafOffTif ? ['--leaf-off-ortho', inputs.leafOffTif] : []),
                '--stems', inputs.stems,
                '--features', input,
                '--out', output,
            ];
            if (await statOrNull(inputs.photoStems)) args.push('--known', inputs.photoStems);
            if (inputs.dem) args.push('--dem', inputs.dem);
            // The trees export plants the lidar stems this much larger (Omberg 1.15): calibrate against them at that size.
            const sizeFactor = await lidarSizeFactor(path.join(this.courseDocsRoot, courseSlug((await this.courses.get(courseId)).name)));
            if (sizeFactor !== 1) args.push('--lidar-size-factor', String(sizeFactor));
            const res = await this.runner(args, this.pipelineDir, { timeoutMs: 600_000 });
            if (res.code !== 0) {
                const msg = /error: (.*)$/m.exec(res.stderr.trim().split('\n').pop() ?? '')?.[1];
                if (msg) throw new ConflictError(`Find trees in photo: ${msg}`);
                throw failure('Find trees in photo', res.code, res.stdout, res.stderr);
            }
            const doc = JSON.parse(await readFile(output, 'utf8')) as PipelineDoc;
            if (doc.format !== PHOTO_STEMS_FORMAT) throw new ConflictError(`Find trees in photo: the pipeline wrote ${doc.format}, not ${PHOTO_STEMS_FORMAT}`);
            return doc;
        } finally {
            await rm(work, { recursive: true, force: true }).catch(() => {});
        }
    }

    /** Keep the proposal for accept to look its ids up in. */
    private async keepProposal(siteId: string, courseId: string, proposals: PhotoStemProposal[]): Promise<void> {
        await writeAtomic(this.proposalFile(siteId), JSON.stringify({ format: PHOTO_STEMS_FORMAT, courseId, proposals }) + '\n');
    }

    private proposalFile(siteId: string): string {
        return path.join(this.dataDir, 'tiles', siteId, PROPOSAL_FILE);
    }

    private async siteOf(courseId: string): Promise<string> {
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new NotFoundError('This course has no built map on this machine — build its map first');
        return course.siteId;
    }

    /** The summer photo (newest vintage not all leaf-off) and the leaf-off one (newest all leaf-off) of the site's tiles manifest. */
    private async photos(siteId: string): Promise<{ summer: string; leafOff: string | null }> {
        const asset = (await this.assets.listBySite(siteId)).find((a) => a.kind === 'tile_manifest');
        const manifest = asset?.metaJson
            ? JSON.parse(asset.metaJson) as { orthoVintages?: OrthoVintage[] }
            : await readJsonOrNull<{ orthoVintages?: OrthoVintage[] }>(path.join(this.dataDir, 'tiles', siteId, 'manifest.json'));
        const vintages = (manifest?.orthoVintages ?? []).filter((v) => v.collection && v.dates?.length);
        const rules = await readRuleDefaults(this.pipelineDir).catch(() => new Map());
        const months = (ruleOf(rules.get('trees'), 'leaf-off-months')?.value as number[] | undefined) ?? LEAF_OFF_MONTHS;
        const leafOffOf = (v: OrthoVintage) => v.dates!.every((d) => months.includes(Number(d.slice(5, 7))));
        const newest = (vs: OrthoVintage[]) => [...vs].sort((a, b) => maxDate(b).localeCompare(maxDate(a)))[0];
        const summer = newest(vintages.filter((v) => !leafOffOf(v)));
        if (!summer) throw new ConflictError('This course has no summer photo in its map (no leaf-on ortho vintage)');
        return { summer: summer.collection, leafOff: newest(vintages.filter(leafOffOf))?.collection ?? null };
    }
}

function maxDate(v: OrthoVintage): string {
    return [...(v.dates ?? [])].sort().pop() ?? '';
}

/** An accepted proposal as an asset row, in PHOTO_STEMS_FIELDS order (the one place that order is defined). */
function assetRow(p: PhotoStemProposal): AssetRow {
    const values: Record<PhotoStemsField, number | string | null> = {
        x: p.x, y: p.y, heightM: p.heightM, crownRadiusM: p.crownRadiusM, groundM: p.groundM ?? null,
        kind: p.kind, id: p.id, source: PHOTO_STEM_SOURCE,
    };
    return PHOTO_STEMS_FIELDS.map((f) => values[f]);
}

function emptyAsset(): PhotoStemsAsset {
    return { version: 2, crs: 'EPSG:3006', source: PHOTO_STEM_SOURCE, fields: [...PHOTO_STEMS_FIELDS], trees: [], skipped: [] };
}

async function readAsset(file: string): Promise<PhotoStemsAsset | null> {
    const doc = await readJsonOrNull<Partial<PhotoStemsAsset>>(file);
    if (!doc) return null;
    if (doc.crs !== 'EPSG:3006' || !Array.isArray(doc.trees) || !Array.isArray(doc.fields) || !doc.fields.includes('id')) {
        throw new ConflictError(`${file} is not a photo stems asset`);
    }
    // Rows in this service's field order, whatever order the file has them in.
    const at = PHOTO_STEMS_FIELDS.map((f) => doc.fields!.indexOf(f));
    const trees = doc.trees.map((r) => at.map((i) => (i < 0 ? null : r[i] ?? null)));
    return { ...emptyAsset(), trees, skipped: doc.skipped ?? [] };
}

/**
 * A course's `trees.lidarSizeFactor` (its docs folder's vegetation-rules.json; 1 without one): the factor the GSPro
 * trees export scales every lidar stem's height and crown radius by (gspro.py trees --size-factor).
 */
export async function lidarSizeFactor(courseDocsDir: string): Promise<number> {
    const file = path.join(courseDocsDir, VEGETATION_RULES_FILE);
    const doc = await readJsonOrNull<{ trees?: { lidarSizeFactor?: unknown } }>(file);
    const factor = doc?.trees?.lidarSizeFactor;
    if (factor === undefined) return 1;
    if (typeof factor !== 'number' || !(factor > 0)) throw new ConflictError(`${file}: trees.lidarSizeFactor must be a number above 0`);
    return factor;
}
