// Pond edges: a pond's outline found on the orthophoto between the lidar's open water and the drawn (or
// Hydrografi) line (pipeline/golfpipe/water_edge.py). The lidar's 0.5 m grid smears a steep bank a metre or two out
// over the water, and a drawn or Hydrografi line follows the visible shore or the reed line; each outline point walks
// in from the drawn line to where the photo turns from land to water, and keeps the drawn line where the photo shows
// no clear turn (reeds, lily pads, shade).
//
// One implementation for both ways in: the terrain editor's "Fit edge to water" (the web fits the proposal as a
// B-spline with the draw tool's fitter, shows it on the map, and Accept stores it as an ordinary feature edit, undo
// included) and `bun run water:edge` (the same fit, then the feature update). A proposal changes nothing.
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import type { CoursesService } from './courses.service';
import type { CourseFeature, CourseFeaturesService } from './course-features.service';
import { defaultRunner, failure, venvPython, type ExportRunner } from './gspro-export.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { flattenRing } from './geo';

export interface PondEdgePoint { x: number; y: number }

/** One stretch of the outline that kept the drawn line, as distances along it from its first point. */
export interface PondEdgeKept { fromM: number; toM: number; why: string }

export interface PondEdgeProposal {
    featureId: string;
    /** The feature's GSPro shape name (`hole_14_53`, `others_12`), as Blender and Unity name its meshes. */
    shape: string;
    /** The feature's version the proposal was made from: Accept updates that version. */
    version: number;
    /** The proposed edge, EPSG:3006, a closed polyline every 0.25 m (fit it as a B-spline before storing). */
    ring: PondEdgePoint[];
    /** The lidar's open water inside the drawn line (the inner bound). */
    lidarRing: PondEdgePoint[];
    /** The water surface the lidar sees (m). */
    level: number;
    areaM2: { drawn: number; lidar: number; new: number };
    /** How far the drawn line lies outside the lidar's water. */
    outsideLidarM: { p50: number; p90: number; max: number };
    /** How far the proposal moved the line. */
    movedM: { p50: number; p90: number; max: number };
    kept: PondEdgeKept[];
    /** The photos that could tell this pond's water from its land, and how well (Fisher separation; >= 1.5 used). */
    photos: { separation: number }[];
    /** `toward` set: every point moved that share of the way to the lidar edge instead of being found on the photo. */
    toward: number | null;
    /** The check picture (photo + drawn, lidar and new lines), when one was asked for. */
    image: string | null;
}

export interface PondEdgeOptions {
    /** 0-1: move each point that share of the way to the lidar's edge instead of reading the photo. */
    toward?: number;
    /** Points less than this outside the lidar's water stay (m, default 0.2). */
    minM?: number;
    /** Write the check picture here. */
    image?: string;
}

export interface PondEdgeDeps {
    db: Kysely<Database>;
    courses: CoursesService;
    courseFeatures: Pick<CourseFeaturesService, 'listByCourse'>;
    dataDir: string;
    pipelineDir?: string;
    runner?: ExportRunner;
}

/** Orthophotos the map build persisted for the inner square, newest first (`ortho-orto-l2-2025.tif`, ...). */
export function pondEdgeOrthos(files: string[]): string[] {
    return files.filter((f) => /^ortho-.*\.tif$/i.test(f) && !/\.cleaned\./i.test(f)).sort().reverse();
}

/** A feature's GSPro shape name (`hole_14_53`, `others_12`), as Blender and Unity name its meshes; an unnumbered one its id prefix. */
export async function featureShapeName(db: Kysely<Database>, courseId: string, f: Pick<CourseFeature, 'id' | 'no' | 'holeId'>): Promise<string> {
    if (f.no === null) return f.id.slice(0, 8);
    const hole = f.holeId
        ? await db.selectFrom('holes').select('number').where('id', '=', f.holeId).where('course_id', '=', courseId).executeTakeFirst()
        : undefined;
    return `${hole ? `hole_${hole.number}` : 'others'}_${f.no.toString(16)}`;
}

export class PondEdgeService {
    private readonly db: Kysely<Database>;
    private readonly courses: CoursesService;
    private readonly courseFeatures: Pick<CourseFeaturesService, 'listByCourse'>;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;

    constructor(deps: PondEdgeDeps) {
        this.db = deps.db;
        this.courses = deps.courses;
        this.courseFeatures = deps.courseFeatures;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        this.runner = deps.runner ?? defaultRunner(process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir));
    }

    /** The proposed water edge of one pond (a `water` feature). Changes nothing. */
    async propose(courseId: string, featureId: string, opts: PondEdgeOptions = {}): Promise<PondEdgeProposal> {
        const { siteId, sources, orthos } = await this.site(courseId, opts);
        void siteId;
        const features = await this.courseFeatures.listByCourse(courseId);
        const f = features.find((x) => x.id === featureId);
        if (!f) throw new NotFoundError(`Feature ${featureId} is not on this course`);
        if (f.type !== 'water') throw new ConflictError(`${f.type} is not a pond: the water edge is for water features`);
        return this.run(f, await this.shapeOf(courseId, f), sources, orthos, opts);
    }

    /** Every pond's proposal; a pond the photos or the lidar cannot read comes back with its error instead. */
    async proposeAll(courseId: string, opts: Omit<PondEdgeOptions, 'image'> = {}): Promise<{ proposals: PondEdgeProposal[]; failed: { featureId: string; shape: string; error: string }[] }> {
        const { sources, orthos } = await this.site(courseId, opts);
        // A lake marked dig: false (Vattern) has the shore tool's edge, not a pond's.
        const ponds = (await this.courseFeatures.listByCourse(courseId))
            .filter((f) => f.type === 'water' && !f.generated && (f.attributes as Record<string, unknown> | null)?.dig !== false);
        const proposals: PondEdgeProposal[] = [];
        const failed: { featureId: string; shape: string; error: string }[] = [];
        for (const f of ponds) {
            const shape = await this.shapeOf(courseId, f);
            try {
                proposals.push(await this.run(f, shape, sources, orthos, opts));
            } catch (e) {
                failed.push({ featureId: f.id, shape, error: (e as Error).message });
            }
        }
        return { proposals, failed };
    }

    private async site(courseId: string, opts: PondEdgeOptions) {
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new NotFoundError('This course has no built map on this machine — build its map first');
        const sources = path.join(this.dataDir, 'sources', course.siteId);
        const files = await readdir(sources).catch(() => [] as string[]);
        if (!files.includes('dem.tif')) throw new ConflictError('No lidar DEM (sources/dem.tif) for this course — build its map first');
        const orthos = pondEdgeOrthos(files).map((f) => path.join(sources, f));
        if (opts.toward === undefined && orthos.length === 0) throw new ConflictError('No orthophoto persisted for this course — build its map first');
        return { siteId: course.siteId, sources, orthos };
    }

    private shapeOf(courseId: string, f: CourseFeature): Promise<string> {
        return featureShapeName(this.db, courseId, f);
    }

    private async run(f: CourseFeature, shape: string, sources: string, orthos: string[], opts: PondEdgeOptions): Promise<PondEdgeProposal> {
        const ring = flattenRing(f.geometry.rings[0], 0.05, f.geometry.curveType);
        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-pond-edge-'));
        try {
            const input = path.join(work, 'request.json');
            const output = path.join(work, 'answer.json');
            await writeFile(input, JSON.stringify({
                dem: path.join(sources, 'dem.tif'), orthos, ring,
                ...(opts.toward !== undefined ? { toward: opts.toward } : {}),
                ...(opts.minM !== undefined ? { minM: opts.minM } : {}),
                ...(opts.image ? { image: opts.image } : {}),
            }));
            const res = await this.runner(['-m', 'golfpipe.water_edge', '--input', input, '--out', output], this.pipelineDir, { timeoutMs: 300_000 });
            if (res.code !== 0) {
                const last = res.stderr.trim().split('\n').filter(Boolean).pop() ?? '';
                const msg = /ValueError: (.*)$/.exec(last)?.[1];
                if (msg) throw new ConflictError(`${shape}: ${msg}`);
                throw failure('Water edge', res.code, res.stdout, res.stderr);
            }
            const r = JSON.parse(await readFile(output, 'utf8')) as {
                ring: [number, number][]; lidarRing: [number, number][]; level: number;
                areaM2: PondEdgeProposal['areaM2']; outsideLidarM: PondEdgeProposal['outsideLidarM']; movedM: PondEdgeProposal['movedM'];
                kept: PondEdgeKept[]; photos: { separation: number }[]; image: string | null;
            };
            const pts = (xs: [number, number][]) => xs.map(([x, y]) => ({ x, y }));
            return {
                featureId: f.id, shape, version: f.version,
                ring: pts(r.ring), lidarRing: pts(r.lidarRing), level: r.level,
                areaM2: r.areaM2, outsideLidarM: r.outsideLidarM, movedM: r.movedM, kept: r.kept, photos: r.photos,
                toward: opts.toward ?? null, image: r.image,
            };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }
}
