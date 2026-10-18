// Water steps ("Find falls"): where a creek or a chain of ponds drops from one level to the next, found on the lidar
// (pipeline/golfpipe/water_steps.py), and how to split the water there. Each selected body (a `water_creek` polygon or
// centerline's corridor, or a `water` polygon) is read along its line; a flat run is a pond at its level, a falling
// run a creek, and each step between them is a `sill` fall (a strip `sillM` wide left out as the weir's crest). Two
// bodies drawn apart within `gapM` at levels far enough apart get an `outlet` fall (water out from under a crossing),
// further apart (some metres) a `cascade` (water running down over rocks along the lowest ground between them). A fall
// the course already has a `waterfall` for (its line midpoint within WATERFALL_SAME_M) is marked `exists`: Accept
// adds none for it.
//
// One implementation for both ways in: the terrain editor's "Find falls" (the web shows the pieces and falls on the
// map, re-proposes with the cuts and skips clicked there, and Accept turns the proposal into feature edits with the
// shared planner web/src/terrain-edit/water-steps-apply.ts, one undo step) and `bun run water:steps` (the same
// planner, then the same feature calls). A proposal changes nothing.
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import type { CoursesService } from './courses.service';
import type { CourseFeaturesService } from './course-features.service';
import { defaultRunner, failure, venvPython, type ExportRunner } from './gspro-export.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { flattenRing } from './geo';
import { featureShapeName, pondEdgeOrthos } from './pond-edge.service';
import { WATERFALL_SAME_M, WATERFALL_TYPE, lineMidpoint, waterfallStyleOf } from '../../shared/features/waterfall';

/** The feature types Find falls reads. */
export const WATER_STEPS_TYPES: readonly string[] = ['water', 'water_creek'];

export interface WaterStepsPoint { x: number; y: number }

/** One selected feature as the pipeline read it. */
export interface WaterStepsBody {
    featureId: string;
    /** The feature's GSPro shape name (`hole_3_23e`). */
    shape: string;
    type: string;
    /** The feature's version the proposal was made from: Accept updates that version. */
    version: number;
    /** The line the water was read along, upstream first (null: a round pond, read as one). */
    line: WaterStepsPoint[] | null;
    /** Its profile: distance along the line (m) and the water surface there (m). */
    profile: { s: number[]; z: number[] } | null;
    steps: number;
}

/** One run of water between steps: a pond (flat, at `levelM`) or a creek (falling from `topM` to `bottomM`). */
export interface WaterStepsPiece {
    /** The feature it was cut from. */
    bodyId: string;
    shape: string;
    /** Its place along the body, upstream first (0, 1, ...). */
    index: number;
    kind: 'pond' | 'creek';
    /** The outline, EPSG:3006, a closed polygon (fit it as a B-spline before storing). */
    ring: WaterStepsPoint[];
    levelM: number | null;
    /** The water at its upstream and downstream ends (null: no lidar on it). */
    topM: number | null;
    bottomM: number | null;
    areaM2: number;
    /** Ponds: what their `water-digs` edit needs as digLevelOffsetM to hold the water at `levelM`. */
    digLevelOffsetM: number | null;
}

/** The styles Find falls proposes (shared/features/waterfall.ts WATERFALL_STYLES, without the hand-placed fountain). */
export type WaterStepsFallStyle = 'sill' | 'outlet' | 'cascade';

/** Where the water drops from one piece to the next. */
export interface WaterStepsFall {
    style: WaterStepsFallStyle;
    fromBodyId: string;
    toBodyId: string;
    fromPiece: number | null;
    toPiece: number | null;
    /** The lip, EPSG:3006 (the downstream edge of a sill; across an outlet's spout); a cascade's path along the flow, upstream first. */
    line: WaterStepsPoint[];
    /** Its middle. */
    at: WaterStepsPoint;
    /** The way the water falls (unit vector, x east, y north). */
    flow: WaterStepsPoint;
    topM: number;
    bottomM: number;
    dropM: number;
    /** How wide the water goes over (m); a cascade's stream width. */
    widthM: number;
    /** Sills: the crest's width upstream of the lip (m). */
    sillM: number | null;
    /** A cut asked for where the lidar shows no sharp step. */
    forced: boolean;
    /** Outlets and cascades: how far apart the two waters are drawn (m). */
    gapM: number | null;
    /** The course already has a waterfall here (its line midpoint within WATERFALL_SAME_M m of `at`, a cascade's line midpoint). */
    exists: boolean;
    /** That waterfall's feature id, null when none. */
    existingId: string | null;
}

export interface WaterStepsProposal {
    courseId: string;
    bodies: WaterStepsBody[];
    pieces: WaterStepsPiece[];
    falls: WaterStepsFall[];
    /** The cuts and skips the proposal was made with (EPSG:3006). */
    cuts: WaterStepsPoint[];
    skips: WaterStepsPoint[];
    /** The check picture (photo, drawn bodies, pieces, falls), when one was asked for. */
    image: string | null;
}

export interface WaterStepsOptions {
    /** Points on the water (EPSG:3006) where a step is wanted though the lidar shows none sharply (a sill under plants). */
    cuts?: WaterStepsPoint[];
    /** Points near a found step that is no step. */
    skips?: WaterStepsPoint[];
    /** The least drop that is a fall (m, default 0.3). */
    minDropM?: number;
    /** A sill's crest width left out between two waters (m, default 1). */
    sillM?: number;
    /** Bodies drawn this close (m, default 12) at different levels get an outlet fall. */
    gapM?: number;
    /** Write the check picture here. */
    image?: string;
}

export interface WaterStepsDeps {
    db: Kysely<Database>;
    courses: CoursesService;
    courseFeatures: Pick<CourseFeaturesService, 'listByCourse'>;
    dataDir: string;
    pipelineDir?: string;
    runner?: ExportRunner;
}

type Pair = [number, number];

export class WaterStepsService {
    private readonly db: Kysely<Database>;
    private readonly courses: CoursesService;
    private readonly courseFeatures: Pick<CourseFeaturesService, 'listByCourse'>;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;

    constructor(deps: WaterStepsDeps) {
        this.db = deps.db;
        this.courses = deps.courses;
        this.courseFeatures = deps.courseFeatures;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir ?? process.env.MAP_PIPELINE_DIR ?? DEFAULT_PIPELINE_DIR;
        this.runner = deps.runner ?? defaultRunner(process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir));
    }

    /** The pieces and falls of these water features (water / water_creek of this course), read on the raw lidar. Changes nothing. */
    async propose(courseId: string, featureIds: string[], opts: WaterStepsOptions = {}): Promise<WaterStepsProposal> {
        const ids = [...new Set(featureIds)];
        if (ids.length === 0) throw new ConflictError('Pick at least one pond or creek');
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new NotFoundError('This course has no built map on this machine — build its map first');
        const sources = path.join(this.dataDir, 'sources', course.siteId);
        const files = await readdir(sources).catch(() => [] as string[]);
        // The raw lidar, never dem-edited: the digs are what the levels found here set.
        if (!files.includes('dem.tif')) throw new ConflictError('No lidar DEM (sources/dem.tif) for this course — build its map first');
        const ortho = pondEdgeOrthos(files)[0];

        const all = new Map((await this.courseFeatures.listByCourse(courseId)).map((f) => [f.id, f]));
        const features = ids.map((id) => {
            const f = all.get(id);
            if (!f) throw new NotFoundError(`Feature ${id} is not on this course`);
            if (!WATER_STEPS_TYPES.includes(f.type)) throw new ConflictError(`${f.type} is no water: Find falls reads ponds (water) and creeks (water_creek)`);
            return f;
        });
        const shapes = await Promise.all(features.map((f) => featureShapeName(this.db, courseId, f)));
        // A centerline creek's rings are its corridor (derived from the line on every write): the polygon read here.
        const bodies = features.map((f, i) => ({
            id: f.id, shape: shapes[i], type: f.type,
            ring: flattenRing(f.geometry.rings[0], 0.05, f.geometry.curveType),
        }));
        const pair = (p: WaterStepsPoint): Pair => [p.x, p.y];

        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-water-steps-'));
        try {
            const input = path.join(work, 'request.json');
            const output = path.join(work, 'answer.json');
            await writeFile(input, JSON.stringify({
                dem: path.join(sources, 'dem.tif'), bodies,
                ...(opts.cuts?.length ? { cuts: opts.cuts.map(pair) } : {}),
                ...(opts.skips?.length ? { skips: opts.skips.map(pair) } : {}),
                ...(opts.minDropM !== undefined ? { minDropM: opts.minDropM } : {}),
                ...(opts.sillM !== undefined ? { sillM: opts.sillM } : {}),
                ...(opts.gapM !== undefined ? { gapM: opts.gapM } : {}),
                // The pipeline runs in pipeline/: a relative picture path is the caller's.
                ...(opts.image ? { image: path.resolve(opts.image), ...(ortho ? { ortho: path.join(sources, ortho) } : {}) } : {}),
            }));
            const res = await this.runner(['-m', 'golfpipe.water_steps', '--input', input, '--out', output], this.pipelineDir, { timeoutMs: 300_000 });
            if (res.code !== 0) {
                const last = res.stderr.trim().split('\n').filter(Boolean).pop() ?? '';
                const msg = /ValueError: (.*)$/.exec(last)?.[1];
                if (msg) throw new ConflictError(msg);
                throw failure('Find falls', res.code, res.stdout, res.stderr);
            }
            const r = JSON.parse(await readFile(output, 'utf8')) as RawAnswer;
            const pts = (xs: Pair[]) => xs.map(([x, y]) => ({ x, y }));
            const pt = ([x, y]: Pair) => ({ x, y });
            const byId = new Map(features.map((f, i) => [f.id, { f, shape: shapes[i] }]));
            // The waterfalls the course has (a fountain is none): a fall found where one is already drawn is that one.
            const drawn = [...all.values()].filter((f) => f.type === WATERFALL_TYPE
                && waterfallStyleOf(f.attributes as Record<string, unknown> | null) !== 'fountain').flatMap((f) => {
                const mid = lineMidpoint(f.geometry.centerline?.points ?? f.geometry.rings[0]?.points ?? []);
                return mid ? [{ id: f.id, mid }] : [];
            });
            const existing = (style: string, line: Pair[], at: Pair): string | null => {
                const p = style === 'cascade' ? lineMidpoint(pts(line)) ?? pt(at) : pt(at);
                let best: { id: string; d: number } | null = null;
                for (const w of drawn) {
                    const d = Math.hypot(w.mid.x - p.x, w.mid.y - p.y);
                    if (d <= WATERFALL_SAME_M && (!best || d < best.d)) best = { id: w.id, d };
                }
                return best?.id ?? null;
            };
            return {
                courseId,
                bodies: r.bodies.map((b) => ({
                    featureId: b.id, shape: byId.get(b.id)!.shape, type: byId.get(b.id)!.f.type, version: byId.get(b.id)!.f.version,
                    line: b.line ? pts(b.line) : null, profile: b.profile, steps: b.steps,
                })),
                pieces: r.pieces.map((p) => ({
                    bodyId: p.bodyId, shape: byId.get(p.bodyId)!.shape, index: p.index, kind: p.kind, ring: pts(p.ring),
                    levelM: p.levelM, topM: p.topM, bottomM: p.bottomM, areaM2: p.areaM2, digLevelOffsetM: p.digLevelOffsetM,
                })),
                falls: r.falls.map((f) => {
                    const existingId = existing(f.style, f.line, f.at);
                    return {
                        style: f.style, fromBodyId: f.fromBodyId, toBodyId: f.toBodyId, fromPiece: f.fromPiece, toPiece: f.toPiece,
                        line: pts(f.line), at: pt(f.at), flow: pt(f.flow), topM: f.topM, bottomM: f.bottomM, dropM: f.dropM,
                        widthM: f.widthM, sillM: f.sillM ?? null, forced: f.forced === true, gapM: f.gapM ?? null,
                        exists: existingId !== null, existingId,
                    };
                }),
                cuts: opts.cuts ?? [],
                skips: opts.skips ?? [],
                image: r.image,
            };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }
}

/** golfpipe.water_steps' answer as it is written. */
interface RawAnswer {
    bodies: { id: string; line: Pair[] | null; profile: { s: number[]; z: number[] } | null; steps: number }[];
    pieces: { bodyId: string; index: number; kind: 'pond' | 'creek'; ring: Pair[]; levelM: number | null; topM: number | null; bottomM: number | null; areaM2: number; digLevelOffsetM: number | null }[];
    falls: {
        style: WaterStepsFallStyle; fromBodyId: string; toBodyId: string; fromPiece: number | null; toPiece: number | null;
        line: Pair[]; at: Pair; flow: Pair; topM: number; bottomM: number; dropM: number; widthM: number;
        sillM?: number; forced?: boolean; gapM?: number;
    }[];
    image: string | null;
}
