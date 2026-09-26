// Terrain generators (roads + buildings, T-roads): the one-click side of
// the pipeline's `fetch-roads` / `fetch-buildings` / `building-pads` /
// `road-grades` commands, so the roads and the flat ground under buildings
// never need the command line.
//
//   - `fetchRoads`  → the road network (OSM, with NVDB widths/surfaces
//                     and missing roads when TRAFIKVERKET_API_KEY is set)
//                     within ROADS_NEAR_M of the course's features, as
//                     `path` corridor polygons for the GeoJSON import wizard
//                     (next to Fetch OSM), and the centerlines persisted
//                     under `sources/<siteId>/` for the grading.
//   - `generate('building-pads')` → building survey (footprints + lidar roof
//                     heights, persisted — the GSPro buildings export reads
//                     it) → one flat `plane` edit per footprint, imported
//                     into the site's terrain_edits under origin
//                     `building-pads`.
//   - `generate('road-grades')`   → one `corridor` edit per road centerline,
//                     origin `road-grades`, and one tilted `plane` per paved
//                     area. The roads are the course's own `path` features
//                     (a road moved in the editor is graded where it now is,
//                     a drawn yard or lot as a plane); only a course with none
//                     falls back to the fetched centerlines.
//
// Generated edits replace their previous generation only (a disabled pad
// stays disabled) and replay before every hand-drawn edit; "Apply to
// terrain" then bakes them into the DEM every terrain export derives from.
// The pipeline runs through the same runner seam as the GSPro exports, so
// tests need no venv.
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { CoursesService } from './courses.service';
import type { AssetsService } from './assets.service';
import type { CourseFeaturesService } from './course-features.service';
import { parseEditsGeojson, type TerrainEditInput, type TerrainEditParams, type TerrainEditsService } from './terrain-edits.service';
import { resolveCourseMapBbox, type BboxWgs84 } from './course-bbox';
import { bboxArg, courseTerrainFor, innerSquareFrom3006, terrainArg, type TerrainSquare } from './terrain-square';
import {
    OUTER_LIDAR_DIR, defaultRunner, ensureDir, failure, reportLines, statOrNull, venvPython,
    type ExportRunner,
} from './gspro-export.service';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { flattenCenterline } from '../../shared/features/centerline';
import { pathSurfaceOf } from '../../shared/features/path-surface';
import { flattenRing } from './geo';

/** What a generator writes into `terrain_edits` (its `origin`). */
export type TerrainGeneratorKind = 'building-pads' | 'road-grades' | 'water-digs' | 'bunker-digs' | 'creek-digs';
export const TERRAIN_GENERATOR_KINDS: readonly TerrainGeneratorKind[] = ['building-pads', 'road-grades', 'water-digs', 'bunker-digs', 'creek-digs'];

/**
 * Creek bed profiles for `creek-digs`, a creek feature's `digPreset`: bank
 * slope and depth below the water surface from Shoreline Studio's creek
 * presets (its channel shape recipe — meander, pools — is not ours).
 */
export const CREEK_DIG_PRESETS = {
    maintained_drain: { label: 'Maintained Drain', bankSlopeDeg: 18, depthM: 0.35 },
    meadow_brook: { label: 'Meadow Brook', bankSlopeDeg: 10, depthM: 0.28 },
    estate_stream: { label: 'Estate Stream', bankSlopeDeg: 22, depthM: 0.42 },
    pool_riffle: { label: 'Pool & Riffle', bankSlopeDeg: 25, depthM: 0.55 },
    rocky_runnel: { label: 'Rocky Runnel', bankSlopeDeg: 31, depthM: 0.32 },
    eroded_gully: { label: 'Eroded Gully', bankSlopeDeg: 38, depthM: 0.70 },
} as const;
export type CreekDigPreset = keyof typeof CREEK_DIG_PRESETS;
export const DEFAULT_CREEK_DIG_PRESET: CreekDigPreset = 'maintained_drain';
/** The band over which bank inside a creek's outline comes down to its surface. */
export const CREEK_DIG_RIM_M = 1;

/**
 * Pond profiles for `water-digs`, a feature's `digPreset`. Bank slope and
 * depth are Shoreline Studio's lake presets; shelf and perimeter variation
 * are ours (its shelf/edge shape recipe does not map onto a DEM profile).
 */
export const WATER_DIG_PRESETS = {
    parkland_shelf: { label: 'Parkland Shelf', bankSlopeDeg: 10, depthM: 1.2, shelfM: 2.0, shelfDepthM: 0.25, variation: 0.1 },
    natural_pond: { label: 'Natural Pond', bankSlopeDeg: 11, depthM: 1.0, shelfM: 1.5, shelfDepthM: 0.2, variation: 0.5 },
    cove_point: { label: 'Cove & Point', bankSlopeDeg: 14, depthM: 1.4, shelfM: 1.0, shelfDepthM: 0.2, variation: 0.45 },
    deep_water: { label: 'Deep Water', bankSlopeDeg: 34, depthM: 2.0, shelfM: 0.5, shelfDepthM: 0.15, variation: 0.06 },
} as const;
export type WaterDigPreset = keyof typeof WATER_DIG_PRESETS;
export const DEFAULT_WATER_DIG_PRESET: WaterDigPreset = 'natural_pond';

/**
 * Bunker profile for `bunker-digs`: the floor this far below a plane fitted to
 * the ground around it, a steep face towards the hole's green and a gentle
 * entry opposite. A feature's `digDepthM` / `digBankSlopeDeg` /
 * `digFaceSlopeDeg` override these.
 */
export const BUNKER_DIG = { depthM: 0.45, bankSlopeDeg: 18, faceSlopeDeg: 40, rimM: 2.5, variation: 0.25 } as const;

/** The building survey (`fetch-buildings` output) under `sources/<siteId>/`. */
export const BUILDINGS_SURVEY = 'buildings.geojson';
/** The road centerlines with widths (`fetch-roads --centerlines-out`) under `sources/<siteId>/`. */
export const ROAD_CENTERLINES = 'roads-centerlines.geojson';
/** The map build's persisted lidar for the inner square. */
export const LIDAR_DIR = 'lidar';
/**
 * Roads farther than this from every mapped course feature are scenery and
 * not fetched (golfpipe `fetch-roads --near`; which feature types count is
 * the pipeline's NEAR_TYPES).
 */
export const ROADS_NEAR_M = 200;

export interface RoadsFetchResult {
    /** The area fetched (WGS84 west, south, east, north). */
    bbox: BboxWgs84;
    /** The EPSG:3006 typed FeatureCollection (`path` features, `road_class`), as the wizard loads it. */
    geojson: unknown;
    /** Where the centerlines were persisted, null for a course with no built site. */
    centerlines: string | null;
    report: string[];
}

export type RoadsFetchJobStatus = 'running' | 'succeeded' | 'failed';

/**
 * One road fetch in flight or finished; what the import wizard polls. A job
 * because the public services behind it (Overpass, retried while busy, and
 * NVDB) can take a minute — longer than a request should be held open.
 */
export interface RoadsFetchJob {
    id: string;
    courseId: string;
    status: RoadsFetchJobStatus;
    /** ISO timestamps. */
    startedAt: string;
    finishedAt: string | null;
    /** Set when `status` is `succeeded`. */
    result: RoadsFetchResult | null;
    /** Set when `status` is `failed`. */
    error: string | null;
}

export interface TerrainGenerateResult {
    kind: TerrainGeneratorKind;
    /** Edits now in the site's terrain_edits under this origin. */
    imported: number;
    /** Features the import could not read (never fatal). */
    skipped: string[];
    report: string[];
}

export interface TerrainGeneratorsDeps {
    courses: CoursesService;
    assets: AssetsService;
    terrainEdits: TerrainEditsService;
    /** The course's features — what "near the course" is measured from, and the road lines graded. */
    courseFeatures: Pick<CourseFeaturesService, 'geojsonByCourse' | 'listByCourse'>;
    /** Root of `sources/<siteId>/`. */
    dataDir: string;
    /** golfpipe's directory; defaults to `<cwd>/../pipeline` (MAP_PIPELINE_DIR overrides). */
    pipelineDir?: string;
    /** Python interpreter; defaults to the pipeline venv (MAP_PIPELINE_PYTHON overrides). */
    python?: string;
    runner?: ExportRunner;
}

export class TerrainGeneratorsService {
    private readonly courses: CoursesService;
    private readonly assets: AssetsService;
    private readonly terrainEdits: TerrainEditsService;
    private readonly courseFeatures: Pick<CourseFeaturesService, 'geojsonByCourse' | 'listByCourse'>;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;
    /**
     * Road fetch jobs started in this process, by id — in memory like the
     * GSPro export jobs (a restart loses them; the wizard just fetches
     * again). Finished ones are pruned per course as new ones start.
     */
    private readonly roadJobs = new Map<string, RoadsFetchJob>();
    /** The running road fetch's completion, per course. */
    private readonly roadInflight = new Map<string, Promise<void>>();

    constructor(deps: TerrainGeneratorsDeps) {
        this.courses = deps.courses;
        this.assets = deps.assets;
        this.terrainEdits = deps.terrainEdits;
        this.courseFeatures = deps.courseFeatures;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir
            ?? process.env.MAP_PIPELINE_DIR
            ?? DEFAULT_PIPELINE_DIR;
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
    }

    /**
     * The road network of the inner GSPro square, within ROADS_NEAR_M of the
     * course's features, as corridor polygons (`golfpipe fetch-roads`),
     * ready for the import wizard — roads are playing-area surfaces; the
     * outer terrain and the far side of the inner square are scenery and get
     * none. OSM, refined by NVDB when the pipeline finds a
     * TRAFIKVERKET_API_KEY. Overpass is a shared public service; each call
     * spends its quota, like Fetch OSM.
     */
    async fetchRoads(courseId: string): Promise<RoadsFetchResult> {
        const course = await this.courses.get(courseId);
        const square = await this.area(courseId, 'fetch roads for', 'inner');
        const bbox = square.wgs84;
        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-roads-'));
        try {
            const out = path.join(work, 'roads.geojson');
            const near = path.join(work, 'course-features.geojson');
            await writeFile(near, JSON.stringify(await this.courseFeatures.geojsonByCourse(courseId)));
            const centerlines = course.siteId
                ? path.join(this.sourcesDir(course.siteId), ROAD_CENTERLINES)
                : path.join(work, ROAD_CENTERLINES);
            await ensureDir(path.dirname(centerlines));
            const r = await this.runner([
                '-m', 'golfpipe', 'fetch-roads', '--bbox', bboxArg(bbox), '--out', out, '--centerlines-out', centerlines,
                '--square-3006', terrainArg(square), '--near', near, '--near-m', String(ROADS_NEAR_M),
            ], this.pipelineDir);
            if (r.code !== 0) throw failure('Road fetch', r.code, r.stdout, r.stderr);
            const geojson = JSON.parse(await readFile(out, 'utf8')) as unknown;
            return { bbox, geojson, centerlines: course.siteId ? centerlines : null, report: reportLines(r.stdout) };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /**
     * Start `fetchRoads` as a job and return it at once (`status: running`).
     * 409 while a road fetch runs for the course, 404 for an unknown course;
     * poll `roadsFetchJob(id)` or `currentRoadsFetch(courseId)`.
     */
    async startRoadsFetch(courseId: string): Promise<RoadsFetchJob> {
        await this.courses.get(courseId);  // 404s for an unknown course
        const running = this.currentRoadsFetch(courseId);
        if (running && running.status === 'running') {
            throw new ConflictError(`A road fetch is already running for this course (job ${running.id}) — wait for it to finish`);
        }
        for (const [id, job] of this.roadJobs) {
            if (job.courseId === courseId && job.status !== 'running') this.roadJobs.delete(id);
        }
        const job: RoadsFetchJob = {
            id: crypto.randomUUID(), courseId, status: 'running',
            startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
        };
        this.roadJobs.set(job.id, job);
        const done = this.fetchRoads(courseId).then(
            (result) => { job.status = 'succeeded'; job.result = result; },
            (err) => { job.status = 'failed'; job.error = err instanceof Error ? err.message : String(err); },
        ).finally(() => {
            job.finishedAt = new Date().toISOString();
            if (this.roadInflight.get(courseId) === done) this.roadInflight.delete(courseId);
        });
        this.roadInflight.set(courseId, done);
        return { ...job };
    }

    /** A road fetch job by id; 404 when this process never started it. */
    roadsFetchJob(jobId: string): RoadsFetchJob {
        const job = this.roadJobs.get(jobId);
        if (!job) throw new NotFoundError(`No road fetch job ${jobId} (the server may have restarted)`);
        return { ...job };
    }

    /** The course's running road fetch, else its most recent finished one, else null. */
    currentRoadsFetch(courseId: string): RoadsFetchJob | null {
        let latest: RoadsFetchJob | null = null;
        for (const job of this.roadJobs.values()) {
            if (job.courseId !== courseId) continue;
            if (job.status === 'running') return { ...job };
            if (!latest || job.startedAt > latest.startedAt) latest = job;
        }
        return latest ? { ...latest } : null;
    }

    /** Resolves when the course has no road fetch running (tests). */
    async whenRoadsIdle(courseId: string): Promise<void> {
        await this.roadInflight.get(courseId);
    }

    /** Run one generator and import its edits under its origin. */
    async generate(courseId: string, kind: TerrainGeneratorKind): Promise<TerrainGenerateResult> {
        switch (kind) {
            case 'building-pads': return this.generateBuildingPads(courseId);
            case 'road-grades': return this.generateRoadGrades(courseId);
            case 'water-digs': return this.generateDigs(courseId, 'water-digs');
            case 'bunker-digs': return this.generateDigs(courseId, 'bunker-digs');
            case 'creek-digs': return this.generateCreekDigs(courseId);
            default: throw new ConflictError(`Unknown terrain generator '${String(kind)}'`);
        }
    }

    /**
     * One `dig` per water or bunker feature (a feature with `dig: false` is
     * left alone). Ponds dig below their water level with the feature's
     * `digPreset` (default Natural Pond) — the outline stays at the level, so
     * OPCD's water plane (the lowest rim vertex) still lands on it. Bunkers dig
     * below the ground around them, the face towards their hole's green (else
     * the nearest green). Creeks are not dug here: their surface falls
     * downstream.
     */
    private async generateDigs(courseId: string, kind: 'water-digs' | 'bunker-digs'): Promise<TerrainGenerateResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const features = await this.courseFeatures.listByCourse(courseId);
        const type = kind === 'water-digs' ? 'water' : 'bunker';
        const greens = features.filter(f => f.type === 'green').map(f => ({ holeId: f.holeId, centre: featureCentroid(f) }))
            .filter((g): g is { holeId: string | null; centre: { x: number; y: number } } => g.centre !== null);
        const inputs: TerrainEditInput[] = [];
        const report: string[] = [];
        let optedOut = 0, noGreen = 0;
        const presets = new Map<string, number>();
        for (const f of features.filter(f => f.type === type)) {
            const attrs = (f.attributes ?? {}) as Record<string, unknown>;
            if (attrs.dig === false) { optedOut++; continue; }
            const rings = f.geometry.rings.map(ring => flattenRing(ring, 0.1, f.geometry.curveType).map(([x, y]) => ({ x, y })))
                .filter(ring => ring.length >= 3);
            if (rings.length === 0) continue;
            const num = (key: string) => typeof attrs[key] === 'number' && Number.isFinite(attrs[key]) ? attrs[key] as number : undefined;
            let params: TerrainEditParams;
            if (kind === 'water-digs') {
                const key = (typeof attrs.digPreset === 'string' && attrs.digPreset in WATER_DIG_PRESETS ? attrs.digPreset : DEFAULT_WATER_DIG_PRESET) as WaterDigPreset;
                const p = WATER_DIG_PRESETS[key];
                presets.set(p.label, (presets.get(p.label) ?? 0) + 1);
                const depthM = num('digDepthM') ?? p.depthM;
                params = {
                    featherM: 0, reference: 'level', depthM,
                    bankSlopeDeg: num('digBankSlopeDeg') ?? p.bankSlopeDeg,
                    shelfM: p.shelfM, shelfDepthM: Math.min(p.shelfDepthM, depthM / 2),
                    variation: p.variation, seed: seedOf(f.id),
                };
            } else {
                params = {
                    featherM: 0, reference: 'plane', rimM: BUNKER_DIG.rimM,
                    depthM: num('digDepthM') ?? BUNKER_DIG.depthM,
                    bankSlopeDeg: num('digBankSlopeDeg') ?? BUNKER_DIG.bankSlopeDeg,
                    variation: BUNKER_DIG.variation, seed: seedOf(f.id),
                };
                const centre = featureCentroid(f);
                const own = greens.filter(g => f.holeId !== null && g.holeId === f.holeId);
                const green = centre ? nearest(centre, own.length > 0 ? own : greens) : null;
                if (centre && green) {
                    params.faceSlopeDeg = num('digFaceSlopeDeg') ?? BUNKER_DIG.faceSlopeDeg;
                    params.faceBearingDeg = Math.round(bearingDeg(centre, green.centre) * 10) / 10;
                } else {
                    noGreen++;
                }
            }
            inputs.push({ op: 'dig', params, rings, originRef: `feature:${f.id}` });
        }
        const rows = await this.terrainEdits.replaceByOrigin(siteId, kind, inputs);
        if (kind === 'water-digs') {
            report.push(`${rows.length} pond(s) dug below their water level` + (presets.size ? ` (${[...presets].map(([l, n]) => `${l} ${n}`).join(', ')})` : ''));
        } else {
            report.push(`${rows.length} bunker(s) dug below the ground around them, face towards the green`
                + (noGreen ? `; ${noGreen} with no green to face (even banks)` : ''));
        }
        if (optedOut) report.push(`${optedOut} ${type} feature(s) marked dig: false left alone`);
        return { kind, imported: rows.length, skipped: [], report };
    }

    /**
     * One `dig` per creek below its water surface (`reference: stream`: the
     * pipeline samples the surface along the creek's line and makes it only
     * fall downstream — the same profile `gspro.py creeks` puts the R.A.M.
     * water on). A creek drawn as a centerline sends its line and width; one
     * stored as a polygon (a Hydrografi ribbon) lets the pipeline find the
     * line down it. `digPreset` picks the bed profile, `digDepthM` /
     * `digBankSlopeDeg` override it, `dig: false` skips the creek.
     */
    private async generateCreekDigs(courseId: string): Promise<TerrainGenerateResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const creeks = (await this.courseFeatures.listByCourse(courseId)).filter(f => f.type === 'water_creek');
        const inputs: TerrainEditInput[] = [];
        let optedOut = 0, lines = 0;
        const presets = new Map<string, number>();
        for (const f of creeks) {
            const attrs = (f.attributes ?? {}) as Record<string, unknown>;
            if (attrs.dig === false) { optedOut++; continue; }
            const rings = f.geometry.rings.map(ring => flattenRing(ring, 0.1, f.geometry.curveType).map(([x, y]) => ({ x, y })))
                .filter(ring => ring.length >= 3);
            if (rings.length === 0) continue;
            const num = (key: string) => typeof attrs[key] === 'number' && Number.isFinite(attrs[key]) ? attrs[key] as number : undefined;
            const key = (typeof attrs.digPreset === 'string' && attrs.digPreset in CREEK_DIG_PRESETS ? attrs.digPreset : DEFAULT_CREEK_DIG_PRESET) as CreekDigPreset;
            const p = CREEK_DIG_PRESETS[key];
            presets.set(p.label, (presets.get(p.label) ?? 0) + 1);
            const params: TerrainEditParams = {
                featherM: 0, reference: 'stream', rimM: CREEK_DIG_RIM_M,
                depthM: num('digDepthM') ?? p.depthM,
                bankSlopeDeg: num('digBankSlopeDeg') ?? p.bankSlopeDeg,
            };
            if (f.geometry.centerline) {
                params.centerline = flattenCenterline(f.geometry.centerline.points, 0.25).map(q => ({ x: q.x, y: q.y }));
                params.widthM = f.geometry.centerline.widthM;
                lines++;
            }
            inputs.push({ op: 'dig', params, rings, originRef: `feature:${f.id}` });
        }
        const rows = await this.terrainEdits.replaceByOrigin(siteId, 'creek-digs', inputs);
        const report = [`${rows.length} creek bed(s) dug below their falling water surface`
            + (presets.size ? ` (${[...presets].map(([l, n]) => `${l} ${n}`).join(', ')})` : '')
            + (rows.length ? `; ${lines} along a drawn centerline, ${rows.length - lines} along the line found down their polygon` : '')];
        if (optedOut) report.push(`${optedOut} creek(s) marked dig: false left alone`);
        return { kind: 'creek-digs', imported: rows.length, skipped: [], report };
    }

    /**
     * Building survey → pads. The survey (footprints, rectangles, lidar
     * eave/ridge from every persisted lidar tile: the build's `lidar/` and,
     * once an outer export fetched it, `outer-lidar/`) is written to
     * `sources/<siteId>/buildings.geojson` — the GSPro buildings export
     * reads it — then `building-pads` turns it into the edits.
     */
    private async generateBuildingPads(courseId: string): Promise<TerrainGenerateResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const bbox = (await this.area(courseId, 'generate building pads for', 'outer')).wgs84;
        // Pads only on the inner terrain: the outer is scenery, and a pad there
        // only cuts and fills ground nobody plays on. The survey still covers
        // the outer square, for the outer buildings export.
        const inner = await this.area(courseId, 'generate building pads for', 'inner');
        const lidar = await this.lidarFiles(siteId);
        if (lidar.length === 0) {
            throw new ConflictError('No lidar is persisted for this course\'s site — build its map first (the build keeps its lidar tiles)');
        }
        const survey = path.join(this.sourcesDir(siteId), BUILDINGS_SURVEY);
        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-pads-'));
        try {
            const fetch = await this.runner([
                '-m', 'golfpipe', 'fetch-buildings', '--bbox', bboxArg(bbox), '--lidar', ...lidar, '--out', survey,
            ], this.pipelineDir);
            if (fetch.code !== 0) throw failure('Building survey', fetch.code, fetch.stdout, fetch.stderr);
            const pads = path.join(work, 'building-pads.geojson');
            const gen = await this.runner(['-m', 'golfpipe', 'building-pads', '--survey', survey, '--out', pads, '--square-3006', terrainArg(inner)], this.pipelineDir);
            if (gen.code !== 0) throw failure('Building pads', gen.code, gen.stdout, gen.stderr);
            const imported = await this.importEdits(siteId, 'building-pads', pads);
            return { kind: 'building-pads', ...imported, report: [...reportLines(fetch.stdout), ...reportLines(gen.stdout)] };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /**
     * Road centerlines → corridor grades, paved areas → planes. The course's
     * own `path` features are the roads: a centerline path is graded along
     * its line, a hand-drawn or imported paved polygon (a parking lot, a yard
     * at a junction) as one tilted plane like a fetched parking lot. A course
     * with no paths of its own uses the centerlines a road fetch persisted,
     * fetching them first when there are none yet.
     */
    private async generateRoadGrades(courseId: string): Promise<TerrainGenerateResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const fetchedLines = path.join(this.sourcesDir(siteId), ROAD_CENTERLINES);
        const report: string[] = [];
        const own = await this.featureRoads(courseId);
        const hasOwn = own.lines.length + own.areas.length > 0;
        if (!hasOwn && !await statOrNull(fetchedLines)) {
            const fetched = await this.fetchRoads(courseId);
            report.push(...fetched.report);
        }
        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-grades-'));
        try {
            let centerlines = fetchedLines;
            if (hasOwn) {
                centerlines = path.join(work, ROAD_CENTERLINES);
                await writeFile(centerlines, JSON.stringify({
                    type: 'FeatureCollection',
                    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
                    features: [...own.lines, ...own.areas],
                }));
                report.push(`From the course's paths: ${own.lines.length} road centerline(s), ${own.areas.length} paved area(s) as planes`
                    + (own.skipped ? `; ${own.skipped} long thin path polygon(s) skipped (draw roads as centerlines to grade them)` : ''));
            }
            const grades = path.join(work, 'road-grades.geojson');
            const gen = await this.runner(['-m', 'golfpipe', 'road-grades', '--centerlines', centerlines, '--out', grades], this.pipelineDir);
            if (gen.code !== 0) throw failure('Road grades', gen.code, gen.stdout, gen.stderr);
            const imported = await this.importEdits(siteId, 'road-grades', grades);
            return { kind: 'road-grades', ...imported, report: [...report, ...reportLines(gen.stdout)] };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    // --- Internals ---

    /**
     * The course's hand-made `path` features (not the generated junction
     * fillets) in fetch-roads `--centerlines-out` form (EPSG:3006): each
     * centerline path a LineString with its `widthM`, flattened the way the
     * editor draws it; each paved polygon a `road_class: parking` Polygon,
     * which road-grades fits one plane. A polygon too long and thin to be an
     * area (an old road corridor drawn or imported as an outline) is skipped
     * and counted: a plane down a winding road would cut and fill it.
     */
    private async featureRoads(courseId: string): Promise<{ lines: object[]; areas: object[]; skipped: number }> {
        const features = (await this.courseFeatures.listByCourse(courseId)).filter(f => f.type === 'path' && !f.generated);
        const lines: object[] = [];
        const areas: object[] = [];
        let skipped = 0;
        const r2 = (v: number) => Math.round(v * 100) / 100;
        for (const f of features) {
            if (f.geometry.centerline) {
                const line = flattenCenterline(f.geometry.centerline.points, 0.1);
                let lengthM = 0;
                for (let i = 1; i < line.length; i++) lengthM += Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y);
                lines.push({
                    type: 'Feature',
                    properties: { id: `feature:${f.id}`, highway: '', road_class: 'road', widthM: f.geometry.centerline.widthM, lengthM: Math.round(lengthM * 10) / 10 },
                    geometry: { type: 'LineString', coordinates: line.map(q => [r2(q.x), r2(q.y)]) },
                });
                continue;
            }
            const rings = f.geometry.rings.map(ring => flattenRing(ring, 0.1, f.geometry.curveType));
            if (rings.length === 0 || rings[0].length < 3) continue;
            if (compactness(rings[0]) < MIN_PLANE_COMPACTNESS) {
                skipped++;
                continue;
            }
            areas.push({
                type: 'Feature',
                properties: { id: `feature:${f.id}`, road_class: 'parking', surface: pathSurfaceOf(f.attributes) },
                geometry: { type: 'Polygon', coordinates: rings.map(ring => [...ring, ring[0]].map(([x, y]) => [r2(x), r2(y)])) },
            });
        }
        return { lines, areas, skipped };
    }

    private async importEdits(siteId: string, origin: TerrainGeneratorKind, file: string): Promise<{ imported: number; skipped: string[] }> {
        const doc = JSON.parse(await readFile(file, 'utf8')) as unknown;
        const { edits, skipped } = parseEditsGeojson(doc);
        const rows = await this.terrainEdits.replaceByOrigin(siteId, origin, edits);
        return { imported: rows.length, skipped };
    }

    /**
     * A GSPro square (and its WGS84 envelope) — the built terrain's, else the one the
     * georeference implies (the same resolution the GSPro exports use).
     * Roads are only wanted on the inner terrain; buildings cover the outer
     * too (pads under the outer heightmap, the outer buildings export).
     */
    private async area(courseId: string, purpose: string, which: 'inner' | 'outer'): Promise<TerrainSquare> {
        const { sweref, terrainSquare } = await resolveCourseMapBbox(this.courses, this.assets, courseId, purpose);
        return courseTerrainFor(terrainSquare ?? innerSquareFrom3006(sweref))[which];
    }

    /** Every persisted lidar tile for the site, the inner build's and the outer export's, once each. */
    private async lidarFiles(siteId: string): Promise<string[]> {
        const seen = new Map<string, string>();
        for (const dir of [LIDAR_DIR, OUTER_LIDAR_DIR]) {
            const full = path.join(this.sourcesDir(siteId), dir);
            if (!await statOrNull(full)) continue;
            for (const name of (await readdir(full)).sort()) {
                if (name.toLowerCase().endsWith('.laz') && !seen.has(name)) seen.set(name, path.join(full, name));
            }
        }
        return [...seen.values()];
    }

    private sourcesDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId);
    }

    private builtSiteId(course: { siteId: string | null }): string {
        if (!course.siteId) {
            throw new NotFoundError('This course has no built map on this machine — build its map first');
        }
        return course.siteId;
    }
}

/**
 * A paved polygon less compact than this (4πA/P²: 1 for a disc, ~0.7 for a
 * 2:1 parking lot, ~0.05 for a 5 m × 300 m road) is a road outline, not an
 * area one plane can grade.
 */
const MIN_PLANE_COMPACTNESS = 0.15;

/** Area centroid of a feature's outer ring (EPSG:3006), null when degenerate. */
function featureCentroid(f: { geometry: { rings: Parameters<typeof flattenRing>[0][]; curveType?: Parameters<typeof flattenRing>[2] } }): { x: number; y: number } | null {
    const ring = f.geometry.rings[0] ? flattenRing(f.geometry.rings[0], 0.25, f.geometry.curveType) : [];
    if (ring.length < 3) return null;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
        const cross = x1 * y2 - x2 * y1;
        a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
    }
    if (Math.abs(a) < 1e-9) return null;
    return { x: cx / (3 * a), y: cy / (3 * a) };
}

function nearest<T extends { centre: { x: number; y: number } }>(p: { x: number; y: number }, items: T[]): T | null {
    let best: T | null = null, bestD = Infinity;
    for (const item of items) {
        const d = Math.hypot(item.centre.x - p.x, item.centre.y - p.y);
        if (d < bestD) { best = item; bestD = d; }
    }
    return best;
}

/** Compass bearing (0 = north, clockwise) from a to b in EPSG:3006 (x east, y north). */
function bearingDeg(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
}

/** A stable small seed per feature, so a regeneration digs the same shape. */
function seedOf(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return (h >>> 0) % 100000;
}

function compactness(ring: Array<[number, number]>): number {
    let area = 0, perimeter = 0;
    for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
        area += x1 * y2 - x2 * y1;
        perimeter += Math.hypot(x2 - x1, y2 - y1);
    }
    return perimeter > 0 ? (4 * Math.PI * Math.abs(area / 2)) / (perimeter * perimeter) : 0;
}
