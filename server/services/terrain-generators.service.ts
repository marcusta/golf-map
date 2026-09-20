// Terrain generators (roads + buildings, T-roads): the one-click side of
// the pipeline's `fetch-roads` / `fetch-buildings` / `building-pads` /
// `road-grades` commands, so the roads and the flat ground under buildings
// never need the command line.
//
//   - `fetchRoads`  → the OSM road network as `path` corridor polygons for
//                     the GeoJSON import wizard (next to Fetch OSM), and the
//                     centerlines persisted under `sources/<siteId>/` for
//                     the grading.
//   - `generate('building-pads')` → building survey (footprints + lidar roof
//                     heights, persisted — the GSPro buildings export reads
//                     it) → one flat `plane` edit per footprint, imported
//                     into the site's terrain_edits under origin
//                     `building-pads`.
//   - `generate('road-grades')`   → one `corridor` edit per road centerline,
//                     origin `road-grades`.
//
// Generated edits replace their previous generation only (a disabled pad
// stays disabled) and replay before every hand-drawn edit; "Apply to
// terrain" then bakes them into the DEM every terrain export derives from.
// The pipeline runs through the same runner seam as the GSPro exports, so
// tests need no venv.
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { CoursesService } from './courses.service';
import type { AssetsService } from './assets.service';
import { parseEditsGeojson, type TerrainEditsService } from './terrain-edits.service';
import { resolveCourseMapBbox, type BboxWgs84 } from './course-bbox';
import { bboxArg, courseTerrainFor, innerSquareFrom3006 } from './terrain-square';
import {
    OUTER_LIDAR_DIR, defaultRunner, ensureDir, failure, reportLines, statOrNull, venvPython,
    type ExportRunner,
} from './gspro-export.service';

/** What a generator writes into `terrain_edits` (its `origin`). */
export type TerrainGeneratorKind = 'building-pads' | 'road-grades';
export const TERRAIN_GENERATOR_KINDS: readonly TerrainGeneratorKind[] = ['building-pads', 'road-grades'];

/** The building survey (`fetch-buildings` output) under `sources/<siteId>/`. */
export const BUILDINGS_SURVEY = 'buildings.geojson';
/** The road centerlines with widths (`fetch-roads --centerlines-out`) under `sources/<siteId>/`. */
export const ROAD_CENTERLINES = 'roads-centerlines.geojson';
/** The map build's persisted lidar for the inner square. */
export const LIDAR_DIR = 'lidar';

export interface RoadsFetchResult {
    /** The area fetched (WGS84 west, south, east, north). */
    bbox: BboxWgs84;
    /** The EPSG:3006 typed FeatureCollection (`path` features, `road_class`), as the wizard loads it. */
    geojson: unknown;
    /** Where the centerlines were persisted, null for a course with no built site. */
    centerlines: string | null;
    report: string[];
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
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;

    constructor(deps: TerrainGeneratorsDeps) {
        this.courses = deps.courses;
        this.assets = deps.assets;
        this.terrainEdits = deps.terrainEdits;
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir
            ?? process.env.MAP_PIPELINE_DIR
            ?? path.resolve(process.cwd(), '..', 'pipeline');
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
    }

    /**
     * The OSM road network of the inner GSPro square as corridor polygons
     * (`golfpipe fetch-roads`), ready for the import wizard — roads are
     * playing-area surfaces; the outer terrain is scenery and gets none.
     * Overpass is a shared public service; each call spends its quota, like
     * Fetch OSM.
     */
    async fetchRoads(courseId: string): Promise<RoadsFetchResult> {
        const course = await this.courses.get(courseId);
        const bbox = await this.area(courseId, 'fetch roads for', 'inner');
        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-roads-'));
        try {
            const out = path.join(work, 'roads.geojson');
            const centerlines = course.siteId
                ? path.join(this.sourcesDir(course.siteId), ROAD_CENTERLINES)
                : path.join(work, ROAD_CENTERLINES);
            await ensureDir(path.dirname(centerlines));
            const r = await this.runner([
                '-m', 'golfpipe', 'fetch-roads', '--bbox', bboxArg(bbox), '--out', out, '--centerlines-out', centerlines,
            ], this.pipelineDir);
            if (r.code !== 0) throw failure('Road fetch', r.code, r.stdout, r.stderr);
            const geojson = JSON.parse(await readFile(out, 'utf8')) as unknown;
            return { bbox, geojson, centerlines: course.siteId ? centerlines : null, report: reportLines(r.stdout) };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /** Run one generator and import its edits under its origin. */
    async generate(courseId: string, kind: TerrainGeneratorKind): Promise<TerrainGenerateResult> {
        switch (kind) {
            case 'building-pads': return this.generateBuildingPads(courseId);
            case 'road-grades': return this.generateRoadGrades(courseId);
            default: throw new ConflictError(`Unknown terrain generator '${String(kind)}'`);
        }
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
        const bbox = await this.area(courseId, 'generate building pads for', 'outer');
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
            const gen = await this.runner(['-m', 'golfpipe', 'building-pads', '--survey', survey, '--out', pads], this.pipelineDir);
            if (gen.code !== 0) throw failure('Building pads', gen.code, gen.stdout, gen.stderr);
            const imported = await this.importEdits(siteId, 'building-pads', pads);
            return { kind: 'building-pads', ...imported, report: [...reportLines(fetch.stdout), ...reportLines(gen.stdout)] };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /**
     * Road centerlines → corridor grades. Uses the centerlines a road fetch
     * persisted; fetches them first when there are none yet.
     */
    private async generateRoadGrades(courseId: string): Promise<TerrainGenerateResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const centerlines = path.join(this.sourcesDir(siteId), ROAD_CENTERLINES);
        const report: string[] = [];
        if (!await statOrNull(centerlines)) {
            const fetched = await this.fetchRoads(courseId);
            report.push(...fetched.report);
        }
        const work = await mkdtemp(path.join(os.tmpdir(), 'golfmap-grades-'));
        try {
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

    private async importEdits(siteId: string, origin: TerrainGeneratorKind, file: string): Promise<{ imported: number; skipped: string[] }> {
        const doc = JSON.parse(await readFile(file, 'utf8')) as unknown;
        const { edits, skipped } = parseEditsGeojson(doc);
        const rows = await this.terrainEdits.replaceByOrigin(siteId, origin, edits);
        return { imported: rows.length, skipped };
    }

    /**
     * A GSPro square's envelope — the built terrain's, else the one the
     * georeference implies (the same resolution the GSPro exports use).
     * Roads are only wanted on the inner terrain; buildings cover the outer
     * too (pads under the outer heightmap, the outer buildings export).
     */
    private async area(courseId: string, purpose: string, which: 'inner' | 'outer'): Promise<BboxWgs84> {
        const { sweref, terrainSquare } = await resolveCourseMapBbox(this.courses, this.assets, courseId, purpose);
        return courseTerrainFor(terrainSquare ?? innerSquareFrom3006(sweref))[which].wgs84;
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
