// GSPro/OPCD exports (builder only): the course SVG, square orthophoto
// textures and square DEMs for the two GSPro terrains.
//
// A GSPro course is two square terrains in EPSG:3006 metres (see
// terrain-square.ts): the INNER one the map was built over — its exact
// square is persisted in the site's tile manifest at build time, side on the
// 10 m step — and the OUTER one, 5 km centred on it, for the background
// scenery. Every export here renders over one of those two squares, passed
// to the pipeline verbatim as `--square-3006`, so the SVG, the JPEGs and the
// DEMs drop onto each other with no re-derived rounding.
//
//   - `export`       the drawn features as a layered, fill-only OPCD SVG (inner)
//   - `exportOrtho`  a persisted orthophoto vintage as the 8192 px texture (inner)
//   - `exportOuterOrtho` the same texture for the outer square — the vintage
//                    is fetched from Lantmäteriet the first time and kept as
//                    `sources/<siteId>/outer-ortho-<collection>.tif`
//   - `exportDem`    the terrain as a square EPSG:3006 GeoTIFF plus the
//                    Unity `.raw` heightmap OPCD's TIF→RAW step would make
//                    of it (4097², 16-bit) and a JSON sidecar with the
//                    height range and Unity settings: the inner from the
//                    build's DEM (edited when terrain edits are applied —
//                    D-TE2), the outer gridded once from Laserdata Skog
//                    lidar — the same source the build uses, never the
//                    licensed DTM product — into `sources/<siteId>/outer-
//                    dem.tif`, with the lidar tiles kept in `sources/
//                    <siteId>/outer-lidar/`. An outer export finds the
//                    inner's sidecar in the folder (when exported) and
//                    records the outer terrain's Unity position from it.
//   - `exportHillshade` the same DEM as an 8192 px hillshade JPEG — OPCD's
//                    aid for checking an overlay against the terrain.
//   - `exportTrees`  the terrain's lidar tree stems as the `unity-trees-v1`
//                    file the Unity Tree Planter reads: the inner from the
//                    trees job's installed `tree-stems.json`, the outer
//                    detected once from the outer lidar + DEM into
//                    `sources/<siteId>/outer-trees/` (stems on the inner
//                    square left out). Needs that terrain's heightmap
//                    sidecar in the folder for the height range.
//
// The exporters live in the pipeline (`pipeline/gspro.py svg|ortho|dem|hillshade`) and
// the fetches are golfpipe's own `fetch-ortho`/`fetch-lidar`/`grid-dem`; this service only
// resolves the squares, finds or fetches the sources, decides where the
// files go, and runs the pipeline — same shape as MapBuildService's pipeline
// runner (a `runner` dep so tests drive it without a Python venv).
//
// The output folder is per course (`courses.gspro_export_dir`); NULL means the
// OS Downloads folder. Writing to an operator-chosen path is why this is
// builder-only: on the VPS there is no operator and no pipeline.
//
// Every export runs as a JOB (`start` → `job`/`current`): the exports that
// have to fetch first (an outer orthophoto is nine 700 MB tiles, an outer
// DEM a lidar download and gridding, outer trees a 5 km detection) run for
// minutes, far past any HTTP client's patience, and a request that timed
// out in the browser used to leave the operator guessing whether the
// server was still at it. Jobs are in memory (one builder process, no
// restart survival needed), one at a time per course — a second start
// while one runs is a 409 that names the running one, so a double-click
// re-attaches instead of starting a duplicate fetch.

import type { Kysely } from 'kysely';
import * as path from 'node:path';
import * as os from 'node:os';
import { stat, mkdir, mkdtemp, readdir, rm, link, copyFile, writeFile } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import type { CoursesService } from './courses.service';
import type { AssetsService } from './assets.service';
import { TerrainEditsService } from './terrain-edits.service';
import { terrainEditsGeojson } from './map-build.service';
import { resolveCourseMapBbox } from './course-bbox';
import {
    courseTerrainFor, innerSquareFrom3006, terrainArg, bboxArg,
    type CourseTerrain, type TerrainSquare,
} from './terrain-square';

export type { CourseTerrain, TerrainSquare } from './terrain-square';

// --- Public types ---

export interface GsproExportSettings {
    /** Folder the next export writes into (always absolute). */
    dir: string;
    /** True when `dir` is the server default rather than a per-course choice. */
    isDefault: boolean;
    /** The server default, so the UI can offer "reset". */
    defaultDir: string;
}

export interface GsproExportResult {
    /** Absolute path of the written file (.svg, .jpg or .tif). */
    path: string;
    /** Human-readable lines from the exporter (counts, warnings). */
    report: string[];
}

/** What an export job produces. */
export type GsproExportKind = 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'hillshade' | 'trees' | 'buildings';

/** A request to start one export; which fields matter depends on `kind`. */
export interface GsproExportRequest {
    kind: GsproExportKind;
    /** `ortho`: a `source` file name from `orthoSources`. */
    source?: string;
    /** `outer-ortho`: the Lantmäteriet collection to fetch, e.g. `orto-l2-2025`. */
    collection?: string;
    /** `dem`, `hillshade`, `trees`, `buildings`: which terrain. */
    terrain?: TerrainKind;
    /** `ortho`, `outer-ortho`: light multiplier for the terrain texture twin. */
    darken?: number;
    /** `ortho`, `outer-ortho`: also write the `-meshes` variant for the course meshes (the course's grass surfaces tinted). */
    tint?: boolean;
    /** With `tint`: the tint layer's opacity 0..1; omitted = the server default. */
    tintOpacity?: number;
}

/** How the `-meshes` variant is made; `opacity` omitted = `TERRAIN_TINT_OPACITY`. */
export interface TerrainTintOptions {
    opacity?: number;
}

export type GsproExportJobStatus = 'running' | 'succeeded' | 'failed';

/** One export in flight or finished; what the panel polls. */
export interface GsproExportJob {
    id: string;
    courseId: string;
    kind: GsproExportKind;
    /** Human label, e.g. `outer orthophoto`, `inner heightmap`. */
    label: string;
    status: GsproExportJobStatus;
    /** ISO timestamps. */
    startedAt: string;
    finishedAt: string | null;
    /** Set when `status` is `succeeded`. */
    result: GsproExportResult | null;
    /** Set when `status` is `failed`. */
    error: string | null;
}

/** One orthophoto GeoTIFF persisted for the course's site, exportable as a JPEG. */
export interface GsproOrthoSource {
    /** File name under `sources/<siteId>/` — the handle `exportOrtho` takes. */
    source: string;
    /** Lantmäteriet collection, e.g. `orto-l2-2025`. */
    collection: string;
    /** True for the working copy with ortho patches baked in (`.patched.tif`). */
    patched: boolean;
    /** True for the vintage the map is currently showing. */
    active: boolean;
}

/** Which of the two GSPro terrains an export is for. */
export type TerrainKind = 'inner' | 'outer';

/** Runs one `python …` invocation (gspro.py or `-m golfpipe`). Injected so tests need no venv. */
export type ExportRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Edge of the exported orthophoto texture — GSPro wants a square power of two. */
export const ORTHO_EXPORT_SIZE = 8192;
/** JPEG quality for the texture — OPCD's TIFtoJPG step uses 95; Unity recompresses anyway. */
export const ORTHO_EXPORT_QUALITY = 92;
/**
 * Default light multiplier for the `-terrain` variant of every orthophoto
 * export, applied in LINEAR light by the pipeline. Unity's terrain shader
 * lights the texture on top of the sunlight already in the photo, so the
 * untouched image renders washed out; this one is what goes on the terrain,
 * the plain one is for reference/tracing. ×0.4 brings a sun-lit photo
 * (~0.5 reflectance) down to about the albedo of real grass (~0.25) so the
 * shader's own light does the rest — the earlier ×0.25 on the sRGB bytes
 * was ×0.05 in linear light and rendered dull and muddy. The panel can pass
 * its own factor per export (`darken`). The pipeline encodes the twin
 * near-losslessly (q97, 4:4:4) since the reduced range makes ordinary JPEG
 * quantisation show as blocking on the terrain.
 */
export const TERRAIN_TEXTURE_DARKEN = 0.4;
/** Bounds for a caller-supplied factor: 1 = untouched, 0.05 = nearly black. */
export const TERRAIN_TEXTURE_DARKEN_RANGE: readonly [number, number] = [0.05, 1];
/**
 * Opacity of the surface tint on the `-meshes` variant — the texture the
 * course meshes (Blender-cut fairways, greens, …) get: the Photoshop
 * step OPCD builders do by hand (a dark-green layer at ~30 % over the turf,
 * masked by the SVG's shapes), done by the pipeline from the course's own
 * drawn features — fairway/green/tee/rough get the tint, bunkers, water and
 * paths cut it out, undrawn ground is untouched. The colour is the
 * pipeline's default (`--tint-color`); the panel only sets the opacity.
 */
export const TERRAIN_TINT_OPACITY = 0.3;
/** Bounds for a caller-supplied tint opacity: 0 = no visible tint, 1 = flat colour. */
export const TERRAIN_TINT_OPACITY_RANGE: readonly [number, number] = [0, 1];
/**
 * DEM export cell size per terrain (metres). The inner keeps the build's
 * 0.5 m lidar grid; the outer is background scenery gridded at 1 m.
 */
export const DEM_EXPORT_RESOLUTION_M: Record<TerrainKind, number> = { inner: 0.5, outer: 1 };
/** The outer terrain's DEM, gridded once per site from Laserdata Skog lidar. */
export const OUTER_DEM_SOURCE = 'outer-dem.tif';
/** Where the outer square's tree-stems detection lives (`tree-stems.json` inside). */
export const OUTER_TREES_DIR = 'outer-trees';
/** Outer stems are detected on this cell size (m): background trees seen from 2 km away; the inner keeps 1 m. */
export const OUTER_TREES_RESOLUTION_M = 2;
/** Where the outer square's lidar tiles are kept (next to the build's `lidar/`). */
export const OUTER_LIDAR_DIR = 'outer-lidar';

export function defaultRunner(python: string): ExportRunner {
    return async (args, cwd) => {
        // UTF-8 stdout: the exporters print '×' and '…', which a Windows
        // Python would otherwise emit in cp1252 and the report would mangle.
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
        const proc = Bun.spawn([python, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        return { code, stdout, stderr };
    };
}

/**
 * The OS Downloads folder — `%USERPROFILE%\Downloads` on Windows, `~/Downloads`
 * elsewhere. GSPRO_EXPORT_DIR overrides it for the whole server.
 */
export function defaultExportDir(): string {
    const override = process.env.GSPRO_EXPORT_DIR;
    if (override) return path.resolve(override);
    return path.join(os.homedir(), 'Downloads');
}

/** `Vreta Kloster GK` -> `vreta-kloster-gk`. */
export function courseSlug(courseName: string): string {
    const slug = courseName
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'course';
}

/** `Vreta Kloster GK` -> `vreta-kloster-gk.svg`. */
export function exportFileName(courseName: string): string {
    return `${courseSlug(courseName)}.svg`;
}

/** `Vreta`, orto-l2-2025 (patched) -> `vreta-orto-l2-2025-patched-8192.jpg`. */
export function orthoExportFileName(courseName: string, source: GsproOrthoSource): string {
    const patched = source.patched ? '-patched' : '';
    return `${courseSlug(courseName)}-${source.collection}${patched}-${ORTHO_EXPORT_SIZE}.jpg`;
}

/** `Vreta`, orto-l2-2025 -> `vreta-outer-orto-l2-2025-8192.jpg`. */
export function outerOrthoExportFileName(courseName: string, collection: string): string {
    return `${courseSlug(courseName)}-outer-${collection}-${ORTHO_EXPORT_SIZE}.jpg`;
}

/** `Vreta`, inner, 2010 -> `vreta-inner-dem-2010m.tif` (the `.raw` and `.tif.json` sit next to it). */
export function demExportFileName(courseName: string, kind: TerrainKind, sideM: number): string {
    return `${courseSlug(courseName)}-${kind}-dem-${sideM}m.tif`;
}

/** The `.json` sidecar `gspro.py dem` writes next to a DEM export. */
export function demSidecarName(demFileName: string): string {
    return `${demFileName}.json`;
}

/** `Vreta`, inner -> `vreta-inner-hillshade-8192.jpg`. */
export function hillshadeExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-hillshade-${ORTHO_EXPORT_SIZE}.jpg`;
}

/** `Vreta`, outer -> `vreta-outer-trees.json` (unity-trees-v1). */
export function treesExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-trees.json`;
}

/** `Vreta`, outer -> `vreta-outer-buildings.json` (unity-buildings-v1). */
export function buildingsExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-buildings.json`;
}

/** The building survey the terrain tool's "Generate building pads" writes under `sources/<siteId>/`. */
export const BUILDINGS_SURVEY_SOURCE = 'buildings.geojson';
/** The outer DEM with the site's terrain edits replayed onto it (derived, rebuilt per export). */
export const OUTER_DEM_EDITED_SOURCE = 'outer-dem-edited.tif';

/** `vreta-orto-l2-2025-8192.jpg` -> `vreta-orto-l2-2025-8192-terrain.jpg`: the darkened terrain-texture twin. */
export function terrainTextureFileName(orthoFileName: string): string {
    return orthoFileName.replace(/\.jpg$/i, '-terrain.jpg');
}

/** The request's tint fields as `renderOrtho` options; undefined when no tint was asked for. */
function tintOptions(r: GsproExportRequest): TerrainTintOptions | undefined {
    return r.tint ? { opacity: r.tintOpacity } : undefined;
}

/** `vreta-orto-l2-2025-8192.jpg` -> `vreta-orto-l2-2025-8192-meshes.jpg`: the darkened twin with the surface tint, for the course meshes. */
export function meshTextureFileName(orthoFileName: string): string {
    return orthoFileName.replace(/\.jpg$/i, '-meshes.jpg');
}

/** `orto-l2-2025` -> `outer-ortho-orto-l2-2025.tif` (under `sources/<siteId>/`). */
export function outerOrthoSourceName(collection: string): string {
    return `outer-ortho-${collection}.tif`;
}

/** `ortho-orto-l2-2025.patched.tif` -> collection + patched flag; null for other files. */
export function parseOrthoSourceName(name: string): { collection: string; patched: boolean } | null {
    const m = /^ortho-(.+?)(\.patched)?\.tif$/i.exec(name);
    if (!m) return null;
    return { collection: m[1], patched: m[2] !== undefined };
}

/** A Lantmäteriet collection id as it appears in file names: `orto-l2-2025`. */
const COLLECTION_RE = /^[a-z0-9][a-z0-9-]*$/i;

export interface GsproExportDeps {
    db: Kysely<Database>;
    courses: CoursesService;
    assets: AssetsService;
    /** Root of `sources/<siteId>/` — where the map build persisted the ortho GeoTIFFs. */
    dataDir: string;
    /** gspro.py's directory; defaults to `<cwd>/../pipeline` (MAP_PIPELINE_DIR overrides). */
    pipelineDir?: string;
    /** Python interpreter; defaults to the pipeline venv (MAP_PIPELINE_PYTHON overrides). */
    python?: string;
    runner?: ExportRunner;
    /** The site's terrain edits, replayed onto the outer DEM at export; defaults to a db-backed instance. */
    terrainEdits?: TerrainEditsService;
}

export class GsproExportService {
    private readonly db: Kysely<Database>;
    private readonly courses: CoursesService;
    private readonly assets: AssetsService;
    private readonly terrainEdits: TerrainEditsService;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;
    /** Every job started in this process, by id (finished ones pruned per course as new ones start). */
    private readonly jobs = new Map<string, GsproExportJob>();
    /** The running job's completion, per course — what `start` refuses on and `whenIdle` awaits. */
    private readonly inflight = new Map<string, Promise<void>>();

    constructor(deps: GsproExportDeps) {
        this.db = deps.db;
        this.courses = deps.courses;
        this.assets = deps.assets;
        this.terrainEdits = deps.terrainEdits ?? new TerrainEditsService(deps.db);
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir
            ?? process.env.MAP_PIPELINE_DIR
            ?? path.resolve(process.cwd(), '..', 'pipeline');
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
    }

    /** Where this course exports to, and what the default is. */
    async settings(courseId: string): Promise<GsproExportSettings> {
        const row = await this.db
            .selectFrom('courses').select(['gspro_export_dir'])
            .where('id', '=', courseId).executeTakeFirst();
        if (!row) throw new NotFoundError(`Course ${courseId} not found`);
        const defaultDir = defaultExportDir();
        return {
            dir: row.gspro_export_dir ?? defaultDir,
            isDefault: row.gspro_export_dir === null,
            defaultDir,
        };
    }

    /**
     * Set (or clear, with null/empty) the course's export folder. The path is
     * stored absolute so a later cwd change can't move where exports land.
     */
    async setDir(courseId: string, dir: string | null): Promise<GsproExportSettings> {
        const trimmed = dir?.trim() ?? '';
        let stored: string | null = null;
        if (trimmed) {
            stored = path.resolve(trimmed);
            const existing = await statOrNull(stored);
            if (existing && !existing.isDirectory()) {
                throw new ConflictError(`${stored} exists but is not a folder`);
            }
        }
        await this.settings(courseId);  // 404s for an unknown course
        await this.db
            .updateTable('courses').set({ gspro_export_dir: stored })
            .where('id', '=', courseId).execute();
        return this.settings(courseId);
    }

    /**
     * The course's two GSPro terrain squares. The inner is the exact square
     * the map build cut the DEM to (from the site's manifest); a course
     * whose map predates that, or whose area comes from a georeference
     * bbox, gets that area squared and snapped the same way. The outer is
     * derived (5 km centred on the inner). 409 when the course has no map
     * area at all.
     */
    async terrain(courseId: string): Promise<CourseTerrain> {
        return this.resolveTerrain(courseId, 'lay out the GSPro terrains for');
    }

    /**
     * Write the course's features to `<dir>/<course-name>.svg` over the
     * inner terrain square, so the SVG lines up with the inner rasters.
     */
    async export(courseId: string): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const { inner } = await this.resolveTerrain(courseId, 'export a GSPro SVG for');

        const out = path.join(await this.exportDir(courseId), exportFileName(course.name));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'svg',
            '--square-3006', terrainArg(inner),
            '--course', courseId,
            '--out', out,
            '--map', 'trees=pinestraw',
        ];
        return this.run('GSPro SVG', args, out);
    }

    /**
     * The orthophoto GeoTIFFs the map build persisted for the course's site,
     * newest collection first, the patched working copy right after its
     * pristine original. Empty when the course has never been built here —
     * the sources live on the build machine, not in the DB.
     */
    async orthoSources(courseId: string): Promise<GsproOrthoSource[]> {
        const course = await this.courses.get(courseId);
        if (!course.siteId) return [];
        let names: string[];
        try {
            names = await readdir(this.sourcesDir(course.siteId));
        } catch {
            return [];
        }
        const active = await this.activeOrtho(course.siteId);
        return names
            .flatMap((source) => {
                const parsed = parseOrthoSourceName(source);
                return parsed ? [{ source, ...parsed, active: parsed.collection === active }] : [];
            })
            .sort((a, b) => b.collection.localeCompare(a.collection)
                || Number(a.patched) - Number(b.patched));
    }

    /**
     * Render one persisted orthophoto as the square GSPro texture:
     * `<dir>/<course>-<collection>[-patched]-8192.jpg`, 8192×8192 px, JPEG
     * quality 80, over the inner terrain square. `source` is a file name
     * from `orthoSources` — anything else is refused, so the request can
     * never name a path outside the site's sources folder.
     */
    async exportOrtho(courseId: string, source: string, darken?: number, tint?: TerrainTintOptions): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const chosen = (await this.orthoSources(courseId)).find(s => s.source === source);
        if (!chosen) {
            throw new NotFoundError(`No orthophoto '${source}' is persisted for this course — build its map first`);
        }
        const { inner } = await this.resolveTerrain(courseId, 'export a GSPro orthophoto for');

        const out = path.join(await this.exportDir(courseId), orthoExportFileName(course.name, chosen));
        return this.renderOrtho('GSPro orthophoto', inner, path.join(this.sourcesDir(course.siteId!), chosen.source), out,
            courseId, darken, tint);
    }

    /**
     * The outer terrain's texture: `<dir>/<course>-outer-<collection>-8192.jpg`
     * over the 5 km outer square. The site's persisted orthos only cover the
     * inner area, so the vintage is fetched from Lantmäteriet for the outer
     * square the first time and kept as `sources/<siteId>/outer-ortho-
     * <collection>.tif`; later exports render from that copy.
     */
    async exportOuterOrtho(courseId: string, collection: string, darken?: number, tint?: TerrainTintOptions): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        if (!COLLECTION_RE.test(collection)) {
            throw new ConflictError(`'${collection}' is not an orthophoto collection id (expected e.g. orto-l2-2025)`);
        }
        const siteId = this.builtSiteId(course);
        const { outer } = await this.resolveTerrain(courseId, 'export the GSPro outer orthophoto for');

        const src = path.join(this.sourcesDir(siteId), outerOrthoSourceName(collection));
        const fetched = await this.ensureSource(src, 'GSPro outer orthophoto fetch', [
            '-m', 'golfpipe', 'fetch-ortho',
            '--bbox', bboxArg(outer.wgs84),
            '--collection', collection,
            '--out', src,
        ]);

        const out = path.join(await this.exportDir(courseId), outerOrthoExportFileName(course.name, collection));
        const rendered = await this.renderOrtho('GSPro outer orthophoto', outer, src, out, courseId, darken, tint);
        return { path: rendered.path, report: [...fetched, ...rendered.report] };
    }

    /**
     * A terrain's DEM as a square EPSG:3006 GeoTIFF (float32 metres),
     * the Unity `.raw` heightmap OPCD's TIF→RAW step makes of it, and a
     * `.json` sidecar with the height range and Unity settings:
     * `<dir>/<course>-<inner|outer>-dem-<side>m.tif` (+ `.raw`, `.tif.json`).
     * The inner comes from the build's DEM — the edited one when terrain
     * edits are applied, so the export shows what the map shows (D-TE2) —
     * at 0.5 m; the outer is gridded once from Laserdata Skog lidar (see
     * `ensureOuterDem`) into `sources/<siteId>/outer-dem.tif` at 1 m. An
     * outer export is handed the inner's sidecar when it is in the folder,
     * so its sidecar carries the outer terrain's Unity position.
     */
    async exportDem(courseId: string, kind: TerrainKind): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} DEM for`);
        const square = terrain[kind];
        const { src, fetched } = await this.demSource(siteId, kind, square);

        const dir = await this.exportDir(courseId);
        const out = path.join(dir, demExportFileName(course.name, kind, square.sideM));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'dem',
            '--square-3006', terrainArg(square),
            '--dem', src,
            '--out', out,
            '--resolution', String(DEM_EXPORT_RESOLUTION_M[kind]),
            '--terrain', kind,
        ];
        const notes: string[] = [];
        if (kind === 'outer') {
            const innerSidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
            if (await statOrNull(innerSidecar)) {
                args.push('--inner-sidecar', innerSidecar);
            } else {
                notes.push('note: export the inner DEM first (into this folder) to get the outer terrain\'s Unity position');
            }
        }
        const rendered = await this.run(`GSPro ${kind} DEM`, args, out);
        return { path: rendered.path, report: [...fetched, ...rendered.report, ...notes] };
    }

    /**
     * A terrain's DEM as a square 8192 px hillshade JPEG over its square:
     * `<dir>/<course>-<inner|outer>-hillshade-8192.jpg`. OPCD uses one to
     * check an overlay against the terrain (bunkers and tees show as
     * relief); same DEM source rules as `exportDem`.
     */
    async exportHillshade(courseId: string, kind: TerrainKind): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} hillshade for`);
        const square = terrain[kind];
        const { src, fetched } = await this.demSource(siteId, kind, square);

        const out = path.join(await this.exportDir(courseId), hillshadeExportFileName(course.name, kind));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'hillshade',
            '--square-3006', terrainArg(square),
            '--dem', src,
            '--out', out,
            '--size', String(ORTHO_EXPORT_SIZE),
        ];
        const rendered = await this.run(`GSPro ${kind} hillshade`, args, out);
        return { path: rendered.path, report: [...fetched, ...rendered.report] };
    }

    /**
     * A terrain's lidar tree stems as `<dir>/<course>-<inner|outer>-trees.json`
     * (unity-trees-v1, what the Unity Tree Planter reads). The inner comes
     * from the trees job's installed `tiles/<siteId>/tree-stems.json` (409
     * until that job has run); the outer is detected once from the outer
     * lidar + DEM (gridded first if need be) into `sources/<siteId>/outer-
     * trees/`, and its file leaves out the stems on the inner square. The
     * plot's height range is read from that terrain's heightmap sidecar in
     * the folder, so the heightmap must be exported first.
     */
    async exportTrees(courseId: string, kind: TerrainKind): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} trees for`);
        const square = terrain[kind];

        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, square.sideM)));
        if (!await statOrNull(sidecar)) {
            throw new ConflictError(`Export the ${kind} heightmap first — its sidecar (${path.basename(sidecar)}) carries the height range the trees file needs`);
        }

        let stems: string;
        let fetched: string[] = [];
        if (kind === 'inner') {
            stems = this.assets.resolveTreeStemsPath(siteId);
            if (!await statOrNull(stems)) {
                throw new ConflictError('No tree stems for this course yet — run "Regenerate trees" on the map first');
            }
        } else {
            stems = path.join(this.sourcesDir(siteId), OUTER_TREES_DIR, 'tree-stems.json');
            fetched = await this.ensureOuterTrees(siteId, square, stems);
        }

        const out = path.join(dir, treesExportFileName(course.name, kind));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'trees',
            '--square-3006', terrainArg(square),
            '--stems', stems,
            '--sidecar', sidecar,
            '--out', out,
            '--terrain', kind,
        ];
        if (kind === 'outer') args.push('--exclude-square', terrainArg(terrain.inner));
        const rendered = await this.run(`GSPro ${kind} trees`, args, out);
        return { path: rendered.path, report: [...fetched, ...rendered.report] };
    }

    // --- Jobs ---

    /**
     * Start one export as a job and return it at once (`status: running`).
     * 409 while another export runs for the course (the message names it)
     * or when the request lacks what its kind needs; 404 for an unknown
     * course. Poll `job(id)` or `current(courseId)` for the outcome.
     */
    async start(courseId: string, request: GsproExportRequest): Promise<GsproExportJob> {
        await this.settings(courseId);  // 404s for an unknown course
        const running = this.current(courseId);
        if (running && running.status === 'running') {
            throw new ConflictError(`An export is already running for this course: ${running.label} (job ${running.id}) — wait for it to finish`);
        }
        const label = describeRequest(request);

        // One live job per course: forget the finished ones.
        for (const [id, job] of this.jobs) {
            if (job.courseId === courseId && job.status !== 'running') this.jobs.delete(id);
        }
        const job: GsproExportJob = {
            id: crypto.randomUUID(), courseId, kind: request.kind, label,
            status: 'running', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
        };
        this.jobs.set(job.id, job);
        const done = this.perform(courseId, request).then(
            (result) => { job.status = 'succeeded'; job.result = result; },
            (err) => { job.status = 'failed'; job.error = err instanceof Error ? err.message : String(err); },
        ).finally(() => {
            job.finishedAt = new Date().toISOString();
            if (this.inflight.get(courseId) === done) this.inflight.delete(courseId);
        });
        this.inflight.set(courseId, done);
        return { ...job };
    }

    /** A job by id; 404 when this process never started it. */
    job(jobId: string): GsproExportJob {
        const job = this.jobs.get(jobId);
        if (!job) throw new NotFoundError(`No export job ${jobId} (the server may have restarted)`);
        return { ...job };
    }

    /** The course's running job, else its most recent finished one, else null. */
    current(courseId: string): GsproExportJob | null {
        let latest: GsproExportJob | null = null;
        for (const job of this.jobs.values()) {
            if (job.courseId !== courseId) continue;
            if (job.status === 'running') return { ...job };
            if (!latest || job.startedAt > latest.startedAt) latest = job;
        }
        return latest ? { ...latest } : null;
    }

    /** Resolves when the course has no export running (tests, shutdown). */
    async whenIdle(courseId: string): Promise<void> {
        await this.inflight.get(courseId);
    }

    /** The synchronous export behind a job request. */
    private perform(courseId: string, r: GsproExportRequest): Promise<GsproExportResult> {
        switch (r.kind) {
            case 'svg': return this.export(courseId);
            case 'ortho': return this.exportOrtho(courseId, r.source!, r.darken, tintOptions(r));
            case 'outer-ortho': return this.exportOuterOrtho(courseId, r.collection!, r.darken, tintOptions(r));
            case 'dem': return this.exportDem(courseId, r.terrain!);
            case 'hillshade': return this.exportHillshade(courseId, r.terrain!);
            case 'trees': return this.exportTrees(courseId, r.terrain!);
            case 'buildings': return this.exportBuildings(courseId, r.terrain!);
        }
    }

    // --- Internals ---

    private async resolveTerrain(courseId: string, purpose: string): Promise<CourseTerrain> {
        const { sweref, terrainSquare } = await resolveCourseMapBbox(this.courses, this.assets, courseId, purpose);
        return courseTerrainFor(terrainSquare ?? innerSquareFrom3006(sweref));
    }

    private async exportDir(courseId: string): Promise<string> {
        const { dir } = await this.settings(courseId);
        await ensureDir(dir);
        return dir;
    }

    private sourcesDir(siteId: string): string {
        return path.join(this.dataDir, 'sources', siteId);
    }

    /** The site the course's map lives under; 404 when it was never built. */
    private builtSiteId(course: { siteId: string | null }): string {
        if (!course.siteId) {
            throw new NotFoundError('This course has no built map on this machine — build its map first');
        }
        return course.siteId;
    }

    /**
     * The DEM a terrain's exports render from: the build's (edited) DEM for
     * the inner, the once-gridded outer DEM for the outer — plus the report
     * lines of a gridding that had to happen first.
     */
    private async demSource(siteId: string, kind: TerrainKind, square: TerrainSquare): Promise<{ src: string; fetched: string[] }> {
        if (kind === 'inner') return { src: await this.innerDem(siteId), fetched: [] };
        const src = path.join(this.sourcesDir(siteId), OUTER_DEM_SOURCE);
        const fetched = await this.ensureOuterDem(siteId, square, src);
        const edited = await this.outerDemWithEdits(siteId, src);
        return edited ? { src: edited.path, fetched: [...fetched, ...edited.report] } : { src, fetched };
    }

    /**
     * The outer DEM with the site's enabled terrain edits replayed onto it
     * (`apply-dem-edits`, as the map build does for the inner): the
     * generated building pads and road grades cover the outer square too,
     * and the outer heightmap must carry them or the planted buildings
     * stand on slopes. Null when the site has no enabled edits — the raw
     * outer DEM is then the right source.
     */
    private async outerDemWithEdits(siteId: string, src: string): Promise<{ path: string; report: string[] } | null> {
        const edits = (await this.terrainEdits.listBySite(siteId)).filter(e => e.enabled);
        if (edits.length === 0) return null;
        const out = path.join(this.sourcesDir(siteId), OUTER_DEM_EDITED_SOURCE);
        const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-outer-edits-'));
        try {
            const editsPath = path.join(work, 'terrain-edits.geojson');
            await writeFile(editsPath, JSON.stringify(terrainEditsGeojson(edits)));
            const r = await this.runner(['-m', 'golfpipe', 'apply-dem-edits', '--input', src, '--edits', editsPath, '--out', out], this.pipelineDir);
            if (r.code !== 0) throw failure('GSPro outer DEM terrain edits', r.code, r.stdout, r.stderr);
            return { path: out, report: [`replayed ${edits.length} terrain edit(s) onto the outer DEM`] };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /**
     * A terrain's buildings as `<dir>/<course>-<inner|outer>-buildings.json`
     * (unity-buildings-v1, what the Unity building planter reads), from the
     * survey the terrain tool's "Generate building pads" wrote for the site.
     * The plot's height range comes from the terrain's heightmap sidecar,
     * so the heightmap must be exported first — with the pads in it.
     */
    async exportBuildings(courseId: string, kind: TerrainKind): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} buildings for`);
        const square = terrain[kind];

        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, square.sideM)));
        if (!await statOrNull(sidecar)) {
            throw new ConflictError(`Export the ${kind} heightmap first — its sidecar (${path.basename(sidecar)}) carries the height range the buildings file needs`);
        }
        const survey = path.join(this.sourcesDir(siteId), BUILDINGS_SURVEY_SOURCE);
        if (!await statOrNull(survey)) {
            throw new ConflictError('No building survey for this course yet — run "Generate building pads" in the terrain tool first');
        }

        const out = path.join(dir, buildingsExportFileName(course.name, kind));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'buildings',
            '--square-3006', terrainArg(square),
            '--survey', survey,
            '--sidecar', sidecar,
            '--out', out,
            '--terrain', kind,
        ];
        if (kind === 'outer') args.push('--exclude-square', terrainArg(terrain.inner));
        return this.run(`GSPro ${kind} buildings`, args, out);
    }

    /** The build's DEM: edited when terrain edits are applied, else raw; 404 when neither exists. */
    private async innerDem(siteId: string): Promise<string> {
        for (const name of ['dem-edited.tif', 'dem.tif']) {
            const candidate = path.join(this.sourcesDir(siteId), name);
            if (await statOrNull(candidate)) return candidate;
        }
        throw new NotFoundError('No DEM is persisted for this course — build its map first');
    }

    /**
     * Grid the outer terrain's DEM from Laserdata Skog lidar unless it is
     * already there — the same lidar → `grid-dem` route the map build takes
     * for the inner, over the outer square instead. The tiles go to
     * `sources/<siteId>/outer-lidar/` (kept, like the build's `lidar/`, so a
     * re-export needs no download); the inner tiles are hard-linked in first
     * so `fetch-lidar` skips them instead of downloading them again. Returns
     * the report lines (empty when the DEM was already there).
     */
    private async ensureOuterDem(siteId: string, outer: TerrainSquare, dem: string): Promise<string[]> {
        if (await statOrNull(dem)) return [];
        const lidarDir = path.join(this.sourcesDir(siteId), OUTER_LIDAR_DIR);
        await ensureDir(lidarDir);
        await linkLidar(path.join(this.sourcesDir(siteId), 'lidar'), lidarDir);

        // --skip-forbidden: Lantmäteriet withholds some tiles (HTTP 403,
        // restricted areas) and a 5 km square can straddle one; for
        // scenery a flat patch there beats no outer terrain at all. The
        // pipeline's warning comes back in the report.
        const fetch = await this.runner([
            '-m', 'golfpipe', 'fetch-lidar', '--bbox', bboxArg(outer.wgs84), '--out-dir', lidarDir, '--skip-forbidden',
        ], this.pipelineDir);
        if (fetch.code !== 0) throw failure('GSPro outer lidar fetch', fetch.code, fetch.stdout, fetch.stderr);

        const laz = (await readdir(lidarDir)).filter(n => n.toLowerCase().endsWith('.laz')).sort()
            .map(n => path.join(lidarDir, n));
        if (laz.length === 0) {
            throw new ConflictError('fetch-lidar downloaded no .laz files for the outer square — it may be outside Laserdata Skog coverage.');
        }
        const grid = await this.runner([
            '-m', 'golfpipe', 'grid-dem', '--lidar', ...laz,
            '--bbox-3006', terrainArg(outer),
            '--resolution', String(DEM_EXPORT_RESOLUTION_M.outer),
            '--out', dem,
        ], this.pipelineDir);
        if (grid.code !== 0) throw failure('GSPro outer DEM gridding', grid.code, grid.stdout, grid.stderr);

        return [
            `fetched ${laz.length} lidar tile(s) for the outer square`,
            ...reportLines(fetch.stdout),
            ...reportLines(fetch.stderr).filter(l => l.startsWith('warning:')),
            `gridded ${OUTER_DEM_SOURCE}`,
            ...reportLines(grid.stdout),
        ];
    }

    /**
     * Detect the outer square's tree stems once — golfpipe `trees-stems`
     * over the outer lidar + DEM (the same inputs the build's trees job
     * uses for the inner), written into `sources/<siteId>/outer-trees/`.
     * `--no-kind`: the leaf-off orthophoto that classifies crowns only
     * covers the inner square, so outer stems stay kind unknown and the
     * planter's fallback list dresses them. Returns the report lines.
     */
    private async ensureOuterTrees(siteId: string, outer: TerrainSquare, stems: string): Promise<string[]> {
        if (await statOrNull(stems)) return [];
        const dem = path.join(this.sourcesDir(siteId), OUTER_DEM_SOURCE);
        const gridded = await this.ensureOuterDem(siteId, outer, dem);
        const lidarDir = path.join(this.sourcesDir(siteId), OUTER_LIDAR_DIR);
        const laz = (await readdir(lidarDir)).filter(n => n.toLowerCase().endsWith('.laz')).sort()
            .map(n => path.join(lidarDir, n));
        const treesDir = path.dirname(stems);
        await ensureDir(treesDir);
        const detect = await this.runner([
            '-m', 'golfpipe', 'trees-stems', ...laz.flatMap(f => ['--lidar', f]),
            '--dem', dem, '--bbox', terrainArg(outer),
            '--resolution', String(OUTER_TREES_RESOLUTION_M),
            '--out', path.join(treesDir, 'tree-stems.geojson'),
            '--tiles-dir', treesDir, '--course-id', siteId, '--no-kind',
        ], this.pipelineDir);
        if (detect.code !== 0) throw failure('GSPro outer tree detection', detect.code, detect.stdout, detect.stderr);
        return [...gridded, `detected outer tree stems into ${OUTER_TREES_DIR}/`, ...reportLines(detect.stdout)];
    }

    /**
     * Fetch a source GeoTIFF into place unless it is already there. `args`
     * is the golfpipe fetch command without its `--workdir`, which is a
     * temp dir cleaned up afterwards. Returns the fetch's report lines
     * (empty when nothing had to be fetched).
     */
    private async ensureSource(src: string, what: string, args: string[]): Promise<string[]> {
        if (await statOrNull(src)) return [];
        await ensureDir(path.dirname(src));
        const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-fetch-'));
        try {
            const { code, stdout, stderr } = await this.runner([...args, '--workdir', work], this.pipelineDir);
            if (code !== 0) throw failure(what, code, stdout, stderr);
            return [`fetched ${path.basename(src)}`, ...reportLines(stdout)];
        } finally {
            await rm(work, { recursive: true, force: true }).catch(() => {});
        }
    }

    /**
     * One render, two JPEGs: `out` as-is and its `-terrain` twin darkened
     * (in linear light, by `darken` or the default) for the Unity terrain.
     * With `tint`, a third: the `-meshes` variant, the darkened one
     * with the course's grass surfaces tinted by its own drawn features
     * (the pipeline reads them from the app database by course id).
     */
    private async renderOrtho(what: string, square: TerrainSquare, src: string, out: string, courseId: string,
                              darken?: number, tint?: TerrainTintOptions): Promise<GsproExportResult> {
        const factor = darken ?? TERRAIN_TEXTURE_DARKEN;
        const [lo, hi] = TERRAIN_TEXTURE_DARKEN_RANGE;
        if (!Number.isFinite(factor) || factor < lo || factor > hi) {
            throw new ConflictError(`Terrain texture brightness must be between ${lo} and ${hi} (1 = the photo as-is)`);
        }
        const tintArgs: string[] = [];
        if (tint) {
            const opacity = tint.opacity ?? TERRAIN_TINT_OPACITY;
            const [tlo, thi] = TERRAIN_TINT_OPACITY_RANGE;
            if (!Number.isFinite(opacity) || opacity < tlo || opacity > thi) {
                throw new ConflictError(`Surface tint opacity must be between ${tlo} and ${thi} (0.3 = the usual Photoshop layer)`);
            }
            tintArgs.push(
                '--tint-out', meshTextureFileName(out),
                '--tint-course', courseId,
                '--tint-opacity', String(opacity),
            );
        }
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'ortho',
            '--square-3006', terrainArg(square),
            '--ortho', src,
            '--out', out,
            '--terrain-out', terrainTextureFileName(out),
            '--darken', String(factor),
            '--darken-space', 'linear',
            '--size', String(ORTHO_EXPORT_SIZE),
            '--quality', String(ORTHO_EXPORT_QUALITY),
            ...tintArgs,
        ];
        return this.run(what, args, out);
    }

    private async run(what: string, args: string[], out: string): Promise<GsproExportResult> {
        const { code, stdout, stderr } = await this.runner(args, this.pipelineDir);
        if (code !== 0) throw failure(`${what} export`, code, stdout, stderr);
        return { path: out, report: reportLines(stdout) };
    }

    /** The vintage the map serves, from the site's tile-manifest registration. */
    private async activeOrtho(siteId: string): Promise<string | null> {
        const manifest = (await this.assets.listBySite(siteId)).find(a => a.kind === 'tile_manifest');
        if (!manifest?.metaJson) return null;
        try {
            const parsed = JSON.parse(manifest.metaJson) as { activeOrtho?: unknown };
            return typeof parsed.activeOrtho === 'string' ? parsed.activeOrtho : null;
        } catch {
            return null;
        }
    }
}

/** The job's label, checking the request carries what its kind needs (409 otherwise). */
export function describeRequest(r: GsproExportRequest): string {
    const need = (ok: unknown, what: string) => {
        if (!ok) throw new ConflictError(`A ${r.kind} export needs ${what}`);
    };
    switch (r.kind) {
        case 'svg': return 'course SVG';
        case 'ortho': need(r.source, 'a source'); return 'inner orthophoto';
        case 'outer-ortho': need(r.collection, 'a collection'); return 'outer orthophoto';
        case 'dem': need(r.terrain, 'a terrain'); return `${r.terrain} heightmap`;
        case 'hillshade': need(r.terrain, 'a terrain'); return `${r.terrain} hillshade`;
        case 'trees': need(r.terrain, 'a terrain'); return `${r.terrain} trees`;
        case 'buildings': need(r.terrain, 'a terrain'); return `${r.terrain} buildings`;
        default: throw new ConflictError(`Unknown export kind '${String((r as { kind: unknown }).kind)}'`);
    }
}

export function reportLines(stdout: string): string[] {
    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

/** A 409 carrying the pipeline's last words. */
export function failure(what: string, code: number, stdout: string, stderr: string): ConflictError {
    const detail = (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n').slice(-4).join(' ');
    return new ConflictError(`${what} failed: ${detail}`);
}

/** Windows puts the venv interpreter in Scripts\, POSIX in bin/. */
export function venvPython(pipelineDir: string): string {
    return process.platform === 'win32'
        ? path.join(pipelineDir, '.venv', 'Scripts', 'python.exe')
        : path.join(pipelineDir, '.venv', 'bin', 'python');
}

/**
 * mkdir -p that tolerates the folder already being there. Bun on Windows
 * throws EEXIST from a recursive mkdir on an existing path (the same quirk
 * env-paths.ts works around), so "already exists" is success, not failure.
 */
export async function ensureDir(dir: string): Promise<void> {
    try {
        await mkdir(dir, { recursive: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return;
        throw error;
    }
}

/**
 * Hard-link every `.laz` in `from` into `to` (copy where linking is not
 * possible), skipping names already there. Nothing to do when `from` is
 * missing — the build's lidar may have been deleted from the editor.
 */
async function linkLidar(from: string, to: string): Promise<void> {
    let names: string[];
    try {
        names = await readdir(from);
    } catch {
        return;
    }
    for (const name of names) {
        if (!name.toLowerCase().endsWith('.laz')) continue;
        const dest = path.join(to, name);
        if (await statOrNull(dest)) continue;
        try {
            await link(path.join(from, name), dest);
        } catch {
            await copyFile(path.join(from, name), dest);
        }
    }
}

export async function statOrNull(p: string) {
    try {
        return await stat(p);
    } catch {
        return null;
    }
}
