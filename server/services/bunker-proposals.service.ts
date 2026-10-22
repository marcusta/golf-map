// Bunker proposals: the bunkers the course-surface model finds on a course's photo, their edges redrawn from the
// photo's NIR band, by `golfpipe propose-bunkers` (pipeline/golfpipe/bunker_proposals.py, surface_model.py). Each
// comes with the hole it lies on (HoleAssignmentService's rules). Proposals until added.
//
// One implementation for both ways in: the Draw mode's "Find bunkers" (web/src/draw/bunker-proposals*.ts) and
// `bun run bunkers` (scripts/bunkers.ts). Both add the ones kept themselves, fitted by the same outline fit
// (web/src/geo/outline-fit.ts), so the editor gets the new bunkers as one undo step.
//
// - propose: the site's photo (the tiles manifest's activeOrtho), its NIR band beside it, the raw lidar DEM and the
//   model (`data/models/surfaces-unet-r34-rgbnd-bg.pt` or GOLFMAP_SURFACE_MODEL) go to the pipeline with every bunker
//   drawn on the site's courses, which it leaves out; the skipped ones are left out here. The model's raster is
//   kept (`sources/<site>/surfaces-<collection>.tif`) and reused while the photo, DEM and model are unchanged. A real
//   run keeps the proposal (`sources/<site>/bunker-proposals-<course id>.json`) for the CLI to add by id.
// - skip: proposals turned down, by place (`sources/<site>/bunker-proposals-skipped.json`), never offered again.
// - fetchNir: the NIR band for a site whose map was built before the map build kept it (golfpipe fetch-nir; the
//   vintage's photo items are downloaded again, ~0.7 GB per 2.5 km square, and deleted afterwards).
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import type { AssetsService } from './assets.service';
import type { CoursesService } from './courses.service';
import type { HoleAssignmentService } from './hole-assignment.service';
import { defaultRunner, ensureDir, failure, statOrNull, venvPython, type ExportRunner } from './gspro-export.service';
import { flattenRing, sweref99tmToWgs84, type FeatureGeometry } from './geo';
import { readJsonOrNull, writeAtomic } from './json-file';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';

/** The source of a bunker added from a proposal (course_features.source). */
export const BUNKER_PROPOSAL_SOURCE = 'surface-model';
/** The model file when GOLFMAP_SURFACE_MODEL does not name one (its card .json beside it). */
export const DEFAULT_SURFACE_MODEL = 'surfaces-unet-r34-rgbnd-bg.pt';
/** A proposal this close (m) to a skipped one is the same bunker found again. */
const SKIP_MATCH_M = 2;
const SKIPPED_FILE = 'bunker-proposals-skipped.json';
const PROPOSAL_PREFIX = 'bunker-proposals-';

/** One bunker the model found that is not drawn yet. */
export interface BunkerProposal {
    /** `bk-<x>-<y>` from its centre, stable between runs. */
    id: string;
    /** The outline, EPSG:3006 [x, y], the first point not repeated. */
    ring: [number, number][];
    /** The same outline as [lon, lat], for the map. */
    lonLat: [number, number][];
    areaM2: number;
    /** The model's mean confidence over it, 0..1. */
    confidence: number;
    /** Where the edge comes from: the NIR band's sand line, or the model's own outline (no clear sand). */
    edge: 'nir' | 'model';
    /** The hole it lies on (this course's), or null. */
    holeId: string | null;
    holeNumber: number | null;
}

export interface BunkerProposalsResult {
    courseId: string;
    siteId: string;
    /** The photo read (its vintage). */
    collection: string;
    proposals: BunkerProposal[];
    /** What was left out: already drawn, outside the course, too small, skipped earlier. */
    left: { drawn: number; notCourse: number; small: number; skipped: number };
    /** The model ran (false: its raster was current). */
    predicted: boolean;
    seconds: number;
    dryRun: boolean;
}

interface SkippedBunker { id: string; x: number; y: number }

interface PipelineDoc {
    skipped: { drawn: number; notCourse: number; small: number };
    features: { geometry: { type: string; coordinates: number[][][] }; properties: { id: string; areaM2: number; confidence: number; edge: 'nir' | 'model' } }[];
}

export interface BunkerProposalsDeps {
    db: Kysely<Database>;
    courses: CoursesService;
    assets: AssetsService;
    holeAssignment: Pick<HoleAssignmentService, 'holesFor'>;
    dataDir: string;
    pipelineDir?: string;
    runner?: ExportRunner;
    /** The surface model .pt (default GOLFMAP_SURFACE_MODEL, else `<dataDir>/models/surfaces-unet-r34-rgbnd-bg.pt`). */
    modelPath?: string;
}

export class BunkerProposalsService {
    private readonly db: Kysely<Database>;
    private readonly courses: CoursesService;
    private readonly assets: AssetsService;
    private readonly holeAssignment: Pick<HoleAssignmentService, 'holesFor'>;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;
    private readonly modelPath: string;

    constructor(deps: BunkerProposalsDeps) {
        this.db = deps.db;
        this.courses = deps.courses;
        this.assets = deps.assets;
        this.holeAssignment = deps.holeAssignment;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        this.runner = deps.runner ?? defaultRunner(process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir));
        this.modelPath = deps.modelPath ?? process.env.GOLFMAP_SURFACE_MODEL ?? path.join(this.dataDir, 'models', DEFAULT_SURFACE_MODEL);
    }

    /** The bunkers the model finds on the course's photo that are neither drawn on the site nor skipped. */
    async propose(courseId: string, opts: { dryRun?: boolean } = {}): Promise<BunkerProposalsResult> {
        const t0 = Date.now();
        const siteId = await this.siteOf(courseId);
        const collection = await this.activeOrtho(siteId);
        const sources = path.join(this.dataDir, 'sources', siteId);
        const ortho = path.join(sources, `ortho-${collection}.tif`);
        if (!await statOrNull(ortho)) throw new ConflictError(`No photo (sources/ortho-${collection}.tif) for this course — build its map first`);
        const nir = path.join(sources, `ortho-${collection}.nir.tif`);
        if (!await statOrNull(nir)) {
            throw new ConflictError(`The photo's NIR band is missing (built before it was kept) — fetch it: bun run bunkers -- "${(await this.courses.get(courseId)).name}" nir`);
        }
        const dem = path.join(sources, 'dem.tif');
        if (!await statOrNull(dem)) throw new ConflictError('No lidar DEM (sources/dem.tif) for this course — build its map first');
        if (!await statOrNull(this.modelPath)) throw new ConflictError(`No surface model at ${this.modelPath} (tools/surface-lab/pilot/train.py --holdout none makes it)`);

        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-bunkers-'));
        let doc: PipelineDoc;
        let predicted: boolean;
        try {
            const known = path.join(work, 'known.geojson');
            await writeFile(known, JSON.stringify(await this.drawnBunkers(siteId)));
            const out = path.join(work, 'bunkers.geojson');
            const res = await this.runner([
                '-m', 'golfpipe', 'propose-bunkers',
                '--ortho', ortho, '--nir', nir, '--dem', dem, '--model', this.modelPath,
                '--surfaces', path.join(sources, `surfaces-${collection}.tif`),
                '--known', known, '--out', out,
            ], this.pipelineDir, { timeoutMs: 900_000 });
            if (res.code !== 0) {
                const msg = /error: (.*)$/m.exec(res.stderr.trim().split('\n').pop() ?? '')?.[1];
                if (msg) throw new ConflictError(`Find bunkers: ${msg}`);
                throw failure('Find bunkers', res.code, res.stdout, res.stderr);
            }
            predicted = !/is current/.test(res.stdout);
            doc = JSON.parse(await readFile(out, 'utf8')) as PipelineDoc;
        } finally {
            await rm(work, { recursive: true, force: true }).catch(() => {});
        }

        const skipped = await this.skipped(siteId);
        const isSkipped = (x: number, y: number) => skipped.some((s) => Math.hypot(s.x - x, s.y - y) <= SKIP_MATCH_M);
        const found = doc.features.map((f) => {
            const outer = f.geometry.coordinates[0]!;
            const ring = outer.slice(0, -1).map(([x, y]) => [x!, y!] as [number, number]);
            return { f, ring, centre: centroid(ring) };
        });
        const kept = found.filter((p) => !isSkipped(...p.centre));
        const holes = await this.holeAssignment.holesFor(courseId, kept.map((p) => ({ id: p.f.properties.id, type: 'bunker', rings: [p.ring] })));
        const proposals: BunkerProposal[] = kept.map(({ f, ring }) => {
            const hole = holes.get(f.properties.id) ?? null;
            return {
                id: f.properties.id, ring,
                lonLat: ring.map(([x, y]) => { const p = sweref99tmToWgs84(x, y); return [p.lon, p.lat] as [number, number]; }),
                areaM2: f.properties.areaM2, confidence: f.properties.confidence, edge: f.properties.edge,
                holeId: hole?.holeId ?? null, holeNumber: hole?.holeNumber ?? null,
            };
        });
        if (!opts.dryRun) {
            await writeAtomic(this.proposalFile(siteId, courseId), JSON.stringify({ courseId, collection, proposals }) + '\n');
        }
        return {
            courseId, siteId, collection, proposals,
            left: { ...doc.skipped, skipped: found.length - kept.length },
            predicted, seconds: Math.round((Date.now() - t0) / 100) / 10, dryRun: !!opts.dryRun,
        };
    }

    /** The last proposal kept for the course (the CLI adds from it by id); null when there is none. */
    async lastProposal(courseId: string): Promise<{ collection: string; proposals: BunkerProposal[] } | null> {
        return readJsonOrNull(this.proposalFile(await this.siteOf(courseId), courseId));
    }

    /** Turn proposals down for good: no later proposal offers a bunker there again. Unknown ids are refused. */
    async skip(courseId: string, input: { ids: string[] }): Promise<{ skipped: number; skippedNow: number }> {
        const siteId = await this.siteOf(courseId);
        const ids = [...new Set(input.ids)];
        const byId = new Map(((await this.lastProposal(courseId))?.proposals ?? []).map((p) => [p.id, p]));
        const missing = ids.filter((id) => !byId.has(id));
        if (missing.length) throw new ConflictError(`Not in the last proposal: ${missing.join(', ')} — find the bunkers again first`);
        const list = await this.skipped(siteId);
        for (const id of ids) {
            const [x, y] = centroid(byId.get(id)!.ring);
            if (!list.some((s) => s.id === id)) list.push({ id, x: round(x), y: round(y) });
        }
        await ensureDir(path.join(this.dataDir, 'sources', siteId));
        await writeAtomic(path.join(this.dataDir, 'sources', siteId, SKIPPED_FILE), JSON.stringify({ skipped: list }, null, 1) + '\n');
        return { skipped: list.length, skippedNow: ids.length };
    }

    /** The NIR band beside the course's photo (golfpipe fetch-nir): items already on disk under `tileDirs` are used, the rest downloaded. */
    async fetchNir(courseId: string, opts: { tileDirs?: string[] } = {}): Promise<{ path: string; downloaded: number; rgbCheck: number | null }> {
        const siteId = await this.siteOf(courseId);
        const collection = await this.activeOrtho(siteId);
        const sources = path.join(this.dataDir, 'sources', siteId);
        const ortho = path.join(sources, `ortho-${collection}.tif`);
        if (!await statOrNull(ortho)) throw new ConflictError(`No photo (sources/ortho-${collection}.tif) for this course — build its map first`);
        const res = await this.runner([
            '-m', 'golfpipe', 'fetch-nir', '--ortho', ortho, '--collection', collection,
            '--workdir', path.join(sources, 'nir-work'),
            // Absolute: the pipeline runs in pipeline/, a relative folder would be read from there.
            ...(opts.tileDirs ?? []).flatMap((d) => ['--tile-dir', path.resolve(d)]),
        ], this.pipelineDir, { timeoutMs: 3_600_000 });
        if (res.code !== 0) throw failure('Fetch the NIR band', res.code, res.stdout, res.stderr);
        const report = JSON.parse(res.stdout.trim().split('\n').pop()!) as { out: string; downloaded: number; rgbCheck: number | null };
        return { path: report.out, downloaded: report.downloaded, rgbCheck: report.rgbCheck };
    }

    /** Every bunker drawn on the site's courses, as EPSG:3006 polygons (the pipeline leaves them out). */
    private async drawnBunkers(siteId: string) {
        const rows = await this.db.selectFrom('course_features')
            .innerJoin('courses', 'courses.id', 'course_features.course_id')
            .select(['course_features.geometry_json'])
            .where('courses.site_id', '=', siteId).where('course_features.type', '=', 'bunker').execute();
        const features = rows.flatMap((r) => {
            const g = JSON.parse(r.geometry_json) as FeatureGeometry;
            if (g.crs !== 'EPSG:3006') return [];
            const rings = g.rings.map((ring) => {
                const pts = flattenRing(ring, 0.05, g.curveType);
                return [...pts, pts[0]!];
            }).filter((r) => r.length >= 4);
            return rings.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } }] : [];
        });
        return { type: 'FeatureCollection', features };
    }

    private async skipped(siteId: string): Promise<SkippedBunker[]> {
        return (await readJsonOrNull<{ skipped?: SkippedBunker[] }>(path.join(this.dataDir, 'sources', siteId, SKIPPED_FILE)))?.skipped ?? [];
    }

    private proposalFile(siteId: string, courseId: string): string {
        return path.join(this.dataDir, 'sources', siteId, `${PROPOSAL_PREFIX}${courseId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
    }

    private async siteOf(courseId: string): Promise<string> {
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new NotFoundError('This course has no built map on this machine — build its map first');
        return course.siteId;
    }

    /** The photo the editor shows: the tiles manifest's activeOrtho, else its newest vintage. */
    private async activeOrtho(siteId: string): Promise<string> {
        const asset = (await this.assets.listBySite(siteId)).find((a) => a.kind === 'tile_manifest');
        const manifest = asset?.metaJson
            ? JSON.parse(asset.metaJson) as { activeOrtho?: string; orthoVintages?: { collection: string }[] }
            : await readJsonOrNull<{ activeOrtho?: string; orthoVintages?: { collection: string }[] }>(path.join(this.dataDir, 'tiles', siteId, 'manifest.json'));
        const collection = manifest?.activeOrtho ?? manifest?.orthoVintages?.[0]?.collection;
        if (!collection) throw new ConflictError('This course has no photo in its map yet — build its map first');
        return collection;
    }
}

/** Area centroid of a ring. Taken about its first point: on raw SWEREF coordinates (6.5 million) the shoelace terms
 * cancel badly enough to put a 50 m² bunker's centre 25 m off. */
function centroid(ring: [number, number][]): [number, number] {
    const [ox, oy] = ring[0]!;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i]!, [x1, y1] = ring[(i + 1) % ring.length]!;
        const ax = x0 - ox, ay = y0 - oy, bx = x1 - ox, by = y1 - oy;
        const c = ax * by - bx * ay;
        a += c;
        cx += (ax + bx) * c;
        cy += (ay + by) * c;
    }
    if (Math.abs(a) < 1e-9) return [ox, oy];
    return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

function round(v: number): number {
    return Math.round(v * 100) / 100;
}
