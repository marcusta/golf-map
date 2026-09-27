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
//   - `exportGkd`    GreenKeeper's course file (`<scene>.GKD`) — tee boxes,
//                    pins, green centres, aim points, water hazards and the
//                    OOB ring as Unity positions on the inner terrain —
//                    merged into the one in the course's GSPro folder
//                    (`courses.gspro_course_dir`), not the export folder.
//                    Needs the inner heightmap sidecar for the terrain's zero.
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
import { stat, mkdir, mkdtemp, readdir, readFile, rm, link, copyFile, writeFile } from 'node:fs/promises';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import type { Database } from '../db/schema';
import type { CoursesService } from './courses.service';
import type { AssetsService } from './assets.service';
import { SCULPT_DIR, SCULPT_ORIGINS, TerrainEditsService, type TerrainEditInput } from './terrain-edits.service';
import { defaultUnityBridge, editorForExportDir, type UnityBridge } from './unity-bridge';
import { terrainEditsGeojson, ROOFS_SOURCE } from './map-build.service';
import { resolveCourseMapBbox } from './course-bbox';
import {
    courseTerrainFor, innerSquareFrom3006, terrainArg, bboxArg,
    type CourseTerrain, type TerrainSquare,
} from './terrain-square';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import { FeatureHistoryService } from './feature-history.service';
import { CourseFeaturesService } from './course-features.service';
import { ZoneTypesService } from './zone-types.service';
import { CREEK_BANKS, generateVegetation, type VegetationOptions } from './vegetation-generators';
import { CREEK_BANK_ZONE_TYPE } from '../../shared/features/creek-vegetation';
import { BUILDINGS_SURVEY, ROAD_CENTERLINES } from './terrain-generators.service';

export type { CourseTerrain, TerrainSquare } from './terrain-square';

// --- Public types ---

export interface GsproExportSettings {
    /** Folder the next export writes into (always absolute). */
    dir: string;
    /**
     * The course's folder under GSPro's `Courses` (absolute), where the
     * GreenKeeper `.GKD` export writes; null until set.
     */
    courseDir: string | null;
    /** The `.GKD` the GreenKeeper export writes in `courseDir` (null without one). */
    gkdFile: string | null;
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
export type GsproExportKind = 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'unity-terrain' | 'unity-sculpt' | 'hillshade' | 'trees' | 'buildings' | 'zones' | 'vegetation' | 'vegetation-update' | 'creeks' | 'gkd';

/** A request to start one export; which fields matter depends on `kind`. */
export interface GsproExportRequest {
    kind: GsproExportKind;
    /** `ortho`: a `source` file name from `orthoSources`. */
    source?: string;
    /** `outer-ortho`: the Lantmäteriet collection to fetch, e.g. `orto-l2-2025`. */
    collection?: string;
    /** `dem`, `hillshade`, `trees`, `buildings`, `zones`, `vegetation`: which terrain. */
    terrain?: TerrainKind;
    /** `ortho`, `outer-ortho`: light multiplier for the terrain texture twin. */
    darken?: number;
    /** `ortho`, `outer-ortho`: also write the `-meshes` variant for the course meshes (the course's grass surfaces tinted). */
    tint?: boolean;
    /** With `tint`: the tint layer's opacity 0..1; omitted = the server default. */
    tintOpacity?: number;
    /** `ortho`, `outer-ortho`: paint the course's `woodland_floor` zones as forest floor on every file (D-VZ10). */
    forestFloor?: boolean;
    /** With `forestFloor`: the palette floor colour `#rrggbb`; omitted = the pipeline default. */
    floorColor?: string;
    /** With `forestFloor`: how much of each zone's sampled `floorColor` goes in, 0..1; omitted = 0.5. */
    floorMix?: number;
    /** `ortho`, `outer-ortho`: fill the roofs and their shadows from the ground round them on every file. */
    removeBuildings?: boolean;
    /** `svg`: features to leave out (test variants for the Blender build); a road's kerb fillets go with it. */
    excludeFeatureIds?: string[];
    /** `svg`: variant name — the file becomes `<course>-<variant>.svg` so the full SVG is not overwritten. */
    variant?: string;
    /** `vegetation-update`: the vegetation_zone features to update in Unity. */
    zoneIds?: string[];
}

/** Feature types the SVG draws as another OPCD surface than the pipeline's default (`gspro.py svg --map`): canopy as pine straw. */
export const SVG_TYPE_MAP: Record<string, string> = { trees: 'pinestraw' };

/** What `export` (the SVG) takes besides the course. */
export interface SvgExportOptions {
    excludeFeatureIds?: string[];
    variant?: string;
    /** Read the features from this database instead of the app's (a bisect variant, FeatureHistoryService.writeVariantDb). */
    dbPath?: string;
}

/** Where the building removal finds its roofs: either file may be missing, not both. */
interface BuildingSources {
    roofs: string | null;
    survey: string | null;
}

/** The forest-floor fields of a request as `renderOrtho` takes them. */
export interface ForestFloorOptions {
    color?: string;
    mix?: number;
}

/**
 * How the `-meshes` variant is made; `opacity` omitted = `TERRAIN_TINT_OPACITY`.
 * `darkenTint` puts the tint colour under the texture's light multiplier
 * too, so the file is as dark as the `-terrain` twin with the colouring on
 * top: the service sets it for the OUTER terrain. Without it the sun-lit
 * tint lifts the file, which is what looks right on the course meshes.
 */
export interface TerrainTintOptions {
    darkenTint?: boolean;
    /** Per-channel linear-light multipliers on the finished file (`--tint-grade`); the service sets `OUTER_TERRAIN_GRADE` for the outer. */
    grade?: readonly [number, number, number];
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
 * step OPCD builders do by hand (a dark-green layer over the turf, masked
 * by the SVG's shapes), done by the pipeline from the course's own drawn
 * features — fairway/green/tee/rough and whatever isn't drawn get the
 * tint, bunkers, water and paths cut it out. 0.5 is the GSPro
 * colourists' "satellite at 50 % over green": very green as a file, a
 * believable floor under Unity's lighting. The colour is the pipeline's
 * default (`--tint-color`); the panel only sets the opacity.
 */
export const TERRAIN_TINT_OPACITY = 0.5;
/** Bounds for a caller-supplied tint opacity: 0 = no visible tint, 1 = flat colour. */
export const TERRAIN_TINT_OPACITY_RANGE: readonly [number, number] = [0, 1];
/**
 * The `-meshes` variant loses photo detail finer than this (metres on the
 * ground) everywhere but on bunkers and paths: sharp mower stripes and
 * shadows are what make the floor read as a satellite photo in game, and
 * the grass shaders supply the close-up detail there. 1 m is what a 2048 px
 * texture of the 2 km square would hold.
 */
export const MESH_TEXTURE_SOFTEN_M = 1;
/**
 * Colour grade of the OUTER terrain's `-meshes` file (R, G, B multipliers in
 * linear light). Unity's terrain shader renders a texture about twice as
 * bright as the course-mesh shaders, and greyer, so the same colours on both
 * sides of the inner/outer seam LOOK different in game; the outer file is
 * pulled down and towards green by this so the terrain renders like the
 * meshes next to it. Measured as rendered-mesh / rendered-terrain on the
 * same field either side of the seam in Vreta screenshots: 0.57/0.67/0.37
 * from above, ×1.07/1.22/0.96 for the green it still lacked (= 0.61/0.82/0.35,
 * a match from above), then ×0.75/0.85/0.60 towards player height. The
 * terrain shader ADDS a sky sheen at low angles that no texture can cancel
 * — a full match there (0.34/0.59/0.13) is a dark hole from above — so the
 * last step is half of that gap: a compromise weighted to the view you play
 * from. When the two still differ in game: measure that ratio again and
 * multiply (part of) it in here.
 */
export const OUTER_TERRAIN_GRADE: readonly [number, number, number] = [0.46, 0.70, 0.21];
/** Edge of the `-meshes` file: once softened, nothing in it needs the full `ORTHO_EXPORT_SIZE`. */
export const MESH_TEXTURE_SIZE = 4096;
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

/** `Vreta Kloster GK` -> `vreta-kloster-gk.svg`; variant `No paths` -> `vreta-kloster-gk-no-paths.svg`. */
export function exportFileName(courseName: string, variant?: string): string {
    const suffix = variant?.trim() ? `-${courseSlug(variant)}` : '';
    return `${courseSlug(courseName)}${suffix}.svg`;
}

/**
 * `Vreta`, orto-l2-2025 (patched) -> `vreta-orto-l2-2025-patched-8192.jpg`;
 * `clean` (buildings removed / forest floor painted) adds `-clean` before the size.
 */
export function orthoExportFileName(courseName: string, source: GsproOrthoSource, clean = false): string {
    const patched = source.patched ? '-patched' : '';
    return `${courseSlug(courseName)}-${source.collection}${patched}${clean ? '-clean' : ''}-${ORTHO_EXPORT_SIZE}.jpg`;
}

/** `Vreta`, orto-l2-2025 -> `vreta-outer-orto-l2-2025-8192.jpg` (`-clean-8192.jpg` when cleaned). */
export function outerOrthoExportFileName(courseName: string, collection: string, clean = false): string {
    return `${courseSlug(courseName)}-outer-${collection}${clean ? '-clean' : ''}-${ORTHO_EXPORT_SIZE}.jpg`;
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

/** `Vreta`, outer -> `vreta-outer-zones.json` (unity-zones-v2; the masks sit next to it as `-<n>.png`). */
export function zonesExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-zones.json`;
}

/** `Vreta`, inner -> `vreta-inner-surfaces.json`: the surface map the Unity bridge's `golfmap.surfaces.export` writes into the export folder. */
export function surfacesExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-surfaces.json`;
}

/** The VSP package the grass palettes plant into (grass-palette.json's default `package`). */
export const LOWER_VEGETATION_PACKAGE = 'GolfMap lower vegetation';

/** `gspro.py zones-patch`'s exit code when the item bindings moved since the export (ZONES_LAYOUT_CHANGED_EXIT). */
export const ZONES_LAYOUT_CHANGED_EXIT = 3;

/** `Vreta` -> `vreta-inner-creeks.json` (unity-creeks-v1, R.A.M. splines; inner terrain only). */
export function creeksExportFileName(courseName: string): string {
    return `${courseSlug(courseName)}-inner-creeks.json`;
}

/** The request's forest-floor fields as `renderOrtho` options; undefined when not asked for. */
function floorOptions(r: GsproExportRequest): ForestFloorOptions | undefined {
    return r.forestFloor ? { color: r.floorColor, mix: r.floorMix } : undefined;
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
    /** The open Unity editors (`unity-terrain` puts the heightmap into the course's one); defaults to the real bridge. */
    unityBridge?: UnityBridge;
}

export class GsproExportService {
    private readonly db: Kysely<Database>;
    private readonly courses: CoursesService;
    private readonly assets: AssetsService;
    private readonly terrainEdits: TerrainEditsService;
    private readonly unityBridge: UnityBridge;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly runner: ExportRunner;
    private readonly history: FeatureHistoryService;
    /** Every job started in this process, by id (finished ones pruned per course as new ones start). */
    private readonly jobs = new Map<string, GsproExportJob>();
    /** The running job's completion, per course — what `start` refuses on and `whenIdle` awaits. */
    private readonly inflight = new Map<string, Promise<void>>();

    constructor(deps: GsproExportDeps) {
        this.db = deps.db;
        this.courses = deps.courses;
        this.assets = deps.assets;
        this.terrainEdits = deps.terrainEdits ?? new TerrainEditsService(deps.db);
        this.unityBridge = deps.unityBridge ?? defaultUnityBridge();
        this.dataDir = deps.dataDir;
        this.pipelineDir = deps.pipelineDir
            ?? process.env.MAP_PIPELINE_DIR
            ?? DEFAULT_PIPELINE_DIR;
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
        this.history = new FeatureHistoryService(deps.db);
    }

    /** Where this course exports to, and what the default is. */
    async settings(courseId: string): Promise<GsproExportSettings> {
        const row = await this.db
            .selectFrom('courses').select(['gspro_export_dir', 'gspro_course_dir'])
            .where('id', '=', courseId).executeTakeFirst();
        if (!row) throw new NotFoundError(`Course ${courseId} not found`);
        const defaultDir = defaultExportDir();
        return {
            dir: row.gspro_export_dir ?? defaultDir,
            courseDir: row.gspro_course_dir,
            gkdFile: row.gspro_course_dir ? await gkdFileIn(row.gspro_course_dir) : null,
            isDefault: row.gspro_export_dir === null,
            defaultDir,
        };
    }

    /**
     * Set (or clear, with null/empty) the course's GSPro course folder — the
     * scene folder under GSPro's `Courses`, where the `.GKD` goes. It must
     * already exist: building the course in Unity is what makes it.
     */
    async setCourseDir(courseId: string, dir: string | null): Promise<GsproExportSettings> {
        const trimmed = dir?.trim() ?? '';
        let stored: string | null = null;
        if (trimmed) {
            stored = path.resolve(trimmed);
            const existing = await statOrNull(stored);
            if (!existing?.isDirectory()) {
                throw new ConflictError(`${stored} is not a folder — pick the course's folder under GSPro's Courses (it holds the .gspcrse)`);
            }
        }
        await this.settings(courseId);  // 404s for an unknown course
        await this.db
            .updateTable('courses').set({ gspro_course_dir: stored })
            .where('id', '=', courseId).execute();
        return this.settings(courseId);
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
     * `excludeFeatureIds` leaves features out and `variant` names the file
     * `<course-name>-<variant>.svg` — test variants for the Blender build,
     * to find the shape it chokes on without touching the course.
     */
    async export(courseId: string, opts: SvgExportOptions = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const { inner } = await this.resolveTerrain(courseId, 'export a GSPro SVG for');

        const out = path.join(await this.exportDir(courseId), exportFileName(course.name, opts.variant));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'svg',
            '--square-3006', terrainArg(inner),
            '--course', courseId,
            '--out', out,
            ...Object.entries(SVG_TYPE_MAP).flatMap(([type, surface]) => ['--map', `${type}=${surface}`]),
        ];
        if (opts.dbPath) args.push('--db', opts.dbPath);
        const ids = [...new Set(opts.excludeFeatureIds ?? [])];
        if (ids.length === 0) {
            const result = await this.run('GSPro SVG', args, out);
            // A full export of the course as it is: keep it, so a later broken build can be bisected against it.
            if (!opts.variant && !opts.dbPath) {
                const kept = await this.history.snapshot(courseId, path.dirname(out), out);
                result.report.push(`kept as ${path.relative(path.dirname(out), kept)}`);
            }
            return result;
        }
        // A file, not arguments: a variant can leave out thousands of canopy trees.
        const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-svg-'));
        try {
            const list = path.join(work, 'exclude-ids.json');
            await writeFile(list, JSON.stringify(ids));
            return await this.run('GSPro SVG', [...args, '--exclude-ids', list], out);
        } finally {
            await rm(work, { recursive: true, force: true });
        }
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
    async exportOrtho(courseId: string, source: string, darken?: number, tint?: TerrainTintOptions,
                      floor?: ForestFloorOptions, removeBuildings = false): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const chosen = (await this.orthoSources(courseId)).find(s => s.source === source);
        if (!chosen) {
            throw new NotFoundError(`No orthophoto '${source}' is persisted for this course — build its map first`);
        }
        const { inner } = await this.resolveTerrain(courseId, 'export a GSPro orthophoto for');

        const clean = removeBuildings || floor !== undefined;
        const out = path.join(await this.exportDir(courseId), orthoExportFileName(course.name, chosen, clean));
        const buildings = removeBuildings ? await this.buildingSources(course.siteId!) : undefined;
        return this.renderOrtho('GSPro orthophoto', inner, path.join(this.sourcesDir(course.siteId!), chosen.source), out,
            courseId, darken, tint, floor, buildings);
    }

    /**
     * The outer terrain's texture: `<dir>/<course>-outer-<collection>-8192.jpg`
     * over the 5 km outer square. The site's persisted orthos only cover the
     * inner area, so the vintage is fetched from Lantmäteriet for the outer
     * square the first time and kept as `sources/<siteId>/outer-ortho-
     * <collection>.tif`; later exports render from that copy.
     */
    async exportOuterOrtho(courseId: string, collection: string, darken?: number, tint?: TerrainTintOptions,
                           floor?: ForestFloorOptions, removeBuildings = false): Promise<GsproExportResult> {
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

        const clean = removeBuildings || floor !== undefined;
        const out = path.join(await this.exportDir(courseId), outerOrthoExportFileName(course.name, collection, clean));
        const buildings = removeBuildings ? await this.buildingSources(siteId) : undefined;
        const rendered = await this.renderOrtho('GSPro outer orthophoto', outer, src, out, courseId, darken,
            tint && { ...tint, darkenTint: true, grade: OUTER_TERRAIN_GRADE }, floor, buildings);
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
        // The Unity sculpt layers this DEM contains: Unity subtracts them from
        // what it keeps, so its next capture is the whole layer.
        for (const raster of await this.sculptRasters(siteId)) args.push('--sculpt', raster);
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
     * A Unity sculpt, carried back: the open editor on this course's export
     * folder captures what was sculpted on the terrain since golf-map last
     * put its heights there (`golfmap.terrain.capture`: the whole sculpt
     * layer, conform left out, as a float grid on the heightmap's pixels in
     * the export folder); the pipeline makes it a GeoTIFF in
     * `sources/<siteId>/terrain-sculpt/`, and it becomes that terrain's one
     * `delta` edit (origin `unity-sculpt-<terrain>`, replayed after every
     * other edit), replacing the previous capture. A capture with nothing
     * sculpted removes the layer. Apply to terrain then bakes it in.
     */
    async exportUnitySculpt(courseId: string, kind: TerrainKind): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const dir = await this.exportDir(courseId);
        const { editor, seen } = await editorForExportDir(this.unityBridge, dir);
        if (!editor) {
            throw new ConflictError(`No open Unity editor imports from ${dir}: open the course's Unity project (with the GolfMap scripts) and make its course the active one`
                + (seen.length ? ` — open: ${seen.join('; ')}` : ' — none is open'));
        }
        let captured: any;
        try {
            captured = await editor.run('golfmap.terrain.capture', { terrain: kind }, 300);
        } catch (e) {
            throw new ConflictError(`Unity (${editor.projectName}) could not capture the ${kind} sculpt: ${(e as Error).message.split('\n')[0]}`);
        }
        const origin = SCULPT_ORIGINS[kind];
        const raster = `${kind}-sculpt.tif`;
        const tif = path.join(this.sourcesDir(siteId), SCULPT_DIR, raster);
        const report: string[] = [];
        if (!captured?.cells) {
            const removed = (await this.terrainEdits.listBySite(siteId)).some(e => e.origin === origin);
            await this.terrainEdits.replaceByOrigin(siteId, origin, []);
            await rm(tif, { force: true });
            report.push(`Unity ${captured?.terrain ?? kind}: nothing sculpted since golf-map's heights went in` + (removed ? '; the previous sculpt layer is removed' : ''));
            return { path: dir, report };
        }
        const meta = path.resolve(String(captured.file));
        if (path.dirname(meta).toLowerCase() !== path.resolve(dir).toLowerCase()) {
            throw new ConflictError(`Unity wrote the capture to ${meta}, outside the export folder ${dir}`);
        }
        await ensureDir(path.dirname(tif));
        const conv = await this.runner(['-m', 'golfpipe', 'sculpt-tif', '--capture', meta, '--out', tif], this.pipelineDir);
        if (conv.code !== 0) throw failure('Unity sculpt layer', conv.code, conv.stdout, conv.stderr);
        const boundsLine = reportLines(conv.stdout).find(l => l.startsWith('bounds3006 '));
        const b = boundsLine?.slice('bounds3006 '.length).split(',').map(Number);
        if (!b || b.length !== 4 || b.some(v => !Number.isFinite(v))) throw new ConflictError('The sculpt layer came back without its bounds');
        const edit: TerrainEditInput = {
            op: 'delta',
            params: { featherM: 0, raster, changedM2: captured.areaM2, maxRaiseM: captured.maxRaiseM, maxLowerM: captured.maxLowerM },
            rings: [[{ x: b[0]!, y: b[1]! }, { x: b[2]!, y: b[1]! }, { x: b[2]!, y: b[3]! }, { x: b[0]!, y: b[3]! }]],
            originRef: kind,
        };
        await this.terrainEdits.replaceByOrigin(siteId, origin, [edit]);
        report.push(`Unity ${captured.terrain} (${editor.projectName}): ${(captured.areaM2 / 10000).toFixed(2)} ha sculpted (up to +${captured.maxRaiseM} m / ${captured.maxLowerM} m)`
            + (captured.conformCellsLeftOut ? `; ${captured.conformCellsLeftOut} conform-raised cell(s) left out` : ''));
        report.push(`Stored as the ${kind} Unity sculpt layer (one additive terrain edit, after all others). Next: Apply to terrain in the terrain tool, then the heightmap → Unity again.`);
        return { path: tif, report };
    }

    /** The GeoTIFFs of the site's enabled Unity sculpt layers. */
    private async sculptRasters(siteId: string): Promise<string[]> {
        const out: string[] = [];
        for (const e of await this.terrainEdits.listBySite(siteId)) {
            if (!e.enabled || e.op !== 'delta' || !e.params.raster) continue;
            const file = path.join(this.sourcesDir(siteId), SCULPT_DIR, e.params.raster);
            if (await statOrNull(file)) out.push(file);
        }
        return out;
    }

    /**
     * The heightmap export, then straight into Unity: the open editor whose
     * active GolfMap course imports from this course's export folder runs
     * `golfmap.terrain.update` (the heights, size and — outer — position put
     * onto its existing terrain in place, the TerrainData backed up first).
     * What stays manual is Terrain › Export To OBJ for Blender. A heightmap
     * whose zero (the sidecar's `minM`) moved is reported: everything placed
     * at a world height from the old one — trees, buildings, creeks, the
     * course meshes — is that much off until it is placed again.
     */
    async exportUnityTerrain(courseId: string, kind: TerrainKind): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} DEM for`);
        const dir = await this.exportDir(courseId);
        if (kind === 'inner') {
            // A stale inner heightmap in Unity disagrees with the outer (which replays the edits fresh).
            const stale = await this.staleInnerDem(this.builtSiteId(course), await this.innerDem(this.builtSiteId(course)));
            if (stale) throw new ConflictError(`Not put into Unity: ${stale}`);
        }
        // Find the editor first: no point exporting for a Unity that is not open.
        const { editor, seen } = await editorForExportDir(this.unityBridge, dir);
        if (!editor) {
            throw new ConflictError(`No open Unity editor imports from ${dir}: open the course's Unity project (with the GolfMap scripts) and make its course the active one`
                + (seen.length ? ` — open: ${seen.join('; ')}` : ' — none is open'));
        }
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, terrain[kind].sideM)));
        const before = await readSidecarMin(sidecar);
        const exported = await this.exportDem(courseId, kind);
        const after = await readSidecarMin(sidecar);

        let result: any;
        try {
            result = await editor.run('golfmap.terrain.update', { terrain: kind }, 600);
        } catch (e) {
            throw new ConflictError(`The heightmap was exported, but Unity (${editor.projectName}) could not take it: ${(e as Error).message.split('\n')[0]}`);
        }
        const report = [...exported.report];
        if (before !== null && after !== null && Math.abs(after - before) > 0.005) {
            report.push(`warning: the heightmap's zero moved ${(after - before).toFixed(2)} m (minM ${before.toFixed(2)} → ${after.toFixed(2)}): `
                + 'trees, buildings, creeks and the course meshes placed from the old one are that much off until placed again');
        }
        for (const t of (result?.terrains ?? []) as Array<Record<string, any>>) {
            if (t.skipped) { report.push(`Unity ${t.terrain}: skipped (${t.skipped})`); continue; }
            const moved = t.movedM2 != null ? `${(t.movedM2 / 10000).toFixed(1)} ha moved more than 2 cm (mean ${t.meanMoveM ?? 0} m, max ${t.maxMoveM} m)` : 'resolution changed';
            report.push(`Unity ${t.terrain} (${editor.projectName}): heights from ${t.sidecar} (${t.source}); ${moved}`
                + (t.sinkM != null ? `; placed ${t.sinkM} m below its sidecar position, as before` : '')
                + (t.backup ? `; backup ${t.backup}` : ''));
            if (t.warning) report.push(`warning: ${t.warning}`);
        }
        const through = result?.outerShowsThrough as { areaM2: number; worstM: number; worstAt: number[] } | null | undefined;
        if (through && through.areaM2 > 0) {
            report.push(`warning: the outer plot is at or above the inner ground on ${through.areaM2} m² (up to ${through.worstM} m, at x ${through.worstAt[0]}, z ${through.worstAt[1]}): `
                + 'it will show through the rebuilt meshes there — put the other terrain\'s heightmap into Unity too, or lower the outer plot');
        }
        report.push('Next: Terrain › Export To OBJ in Unity for Blender; re-run the terrain conform once the course meshes are rebuilt. Save the scene to keep it.');
        return { path: exported.path, report };
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

    /**
     * A terrain's vegetation zones as VSPro texture masks + unity-zones-v2
     * JSON (what the Unity Vegetation Zones window imports):
     * `<dir>/<course>-<inner|outer>-zones.json` and `-zones-<n>.png` next to
     * it, rasterized from the app database by `gspro.py zones`. Like the
     * trees file it reads the height range from that terrain's heightmap
     * sidecar, so the heightmap must be exported first; the outer leaves the
     * inner square to the inner file.
     */
    async exportZones(courseId: string, kind: TerrainKind): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} vegetation zones for`);
        const square = terrain[kind];

        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, square.sideM)));
        if (!await statOrNull(sidecar)) {
            throw new ConflictError(`Export the ${kind} heightmap first — its sidecar (${path.basename(sidecar)}) carries the height range the zones file needs`);
        }
        const out = path.join(dir, zonesExportFileName(course.name, kind));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'zones',
            '--square-3006', terrainArg(square),
            '--course', courseId,
            '--sidecar', sidecar,
            '--out', out,
            '--terrain', kind,
        ];
        if (kind === 'outer') args.push('--exclude-square', terrainArg(terrain.inner));
        return this.run(`GSPro ${kind} vegetation zones`, args, out);
    }

    /**
     * Plant the course's lower vegetation, start to finish: run the vegetation
     * generators (vegetation-generators.ts: tall rough, creek banks, ...) so
     * their zones follow the course as it is now, export the terrain's zones,
     * and, when the course's Unity project is open, import them into VSP and
     * apply the grass palettes (`golfmap.zones.import`, `golfmap.grass.apply`).
     * Unity not open is reported, not an error: the zones are exported for the
     * next import. The scene is left for the operator to save. `dryRun` only
     * writes the generators' GeoJSON (the CLI's --dry-run).
     */
    async plantVegetation(courseId: string, kind: TerrainKind,
                          opts: Omit<VegetationOptions, 'workDir'> & { dbPath?: string; exportZones?: boolean; unity?: boolean } = {}): Promise<GsproExportResult> {
        const dir = await this.exportDir(courseId);
        const generated = await this.runGenerators(courseId, kind, opts);
        const report = [...generated.report];
        if (opts.dryRun || opts.exportZones === false) return { path: dir, report };

        const exported = await this.exportZones(courseId, kind);
        report.push(...exported.report);
        if (opts.unity === false) return { path: exported.path, report };

        const { editor, seen } = await editorForExportDir(this.unityBridge, dir);
        if (!editor) {
            report.push(`Not in Unity yet: no open Unity editor imports from ${dir}`
                + (seen.length ? ` (open: ${seen.join('; ')})` : ' (none is open)')
                + " - open the course's Unity project and plant again, or run golfmap.zones.import and golfmap.grass.apply there");
            return { path: exported.path, report };
        }
        try {
            // Import binds each item's mask and include rules; apply makes and styles the items and
            // turns spawning on for those with rules. An item apply only now added (a new species in a
            // palette) had no rules at the import: a second round binds it and lets it spawn.
            for (let round = 1; round <= 2; round++) {
                const imported = await editor.run('golfmap.zones.import', { terrain: kind, package: LOWER_VEGETATION_PACKAGE }, 600);
                report.push(`Unity (${editor.projectName}): imported ${path.basename(exported.path)} into '${LOWER_VEGETATION_PACKAGE}'`
                    + (imported?.status ? ` - ${firstLine(String(imported.status))}` : ''));
                const applied = await editor.run('golfmap.grass.apply', { terrain: kind }, 600);
                const items = Array.isArray(applied?.items) ? applied.items.length : 0;
                report.push(`Unity (${editor.projectName}): grass palettes applied (${items} items on ${applied?.system ?? "the terrain's system"})`);
                const log = (applied?.log ?? []) as string[];
                for (const line of log) report.push(`  ${line}`);
                if (!log.some(l => /^(added|replaced) item /.test(l))) break;
            }
        } catch (e) {
            throw new ConflictError(`The zones were generated and exported, but Unity (${editor.projectName}) could not take them: ${firstLine((e as Error).message)}`);
        }
        report.push('Save the scene in Unity to keep it.');
        return { path: exported.path, report };
    }

    /** The vegetation generators over the course as it is now (all, or `opts.from` on), with the inputs they find. */
    private async runGenerators(courseId: string, kind: TerrainKind,
                                opts: Omit<VegetationOptions, 'workDir'> & { dbPath?: string }): Promise<{ report: string[] }> {
        const course = await this.courses.get(courseId);
        const dir = await this.exportDir(courseId);
        const sources = course.siteId ? this.sourcesDir(course.siteId) : null;
        const found = async (file: string | null) => file && await statOrNull(file) ? file : null;
        const inputs = {
            surfaces: await found(path.join(dir, surfacesExportFileName(course.name, kind))),
            buildings: await found(sources && path.join(sources, BUILDINGS_SURVEY)),
            roads: await found(sources && path.join(sources, ROAD_CENTERLINES)),
        };
        const work = await mkdtemp(path.join(os.tmpdir(), 'vegetation-'));
        try {
            return await generateVegetation({
                features: new CourseFeaturesService(this.db), zoneTypes: new ZoneTypesService(this.db),
                pipelineDir: this.pipelineDir, dbPath: opts.dbPath,
                run: (what, args, out) => this.run(what, args, out),
            }, courseId, inputs, { ...opts, workDir: work });
        } finally {
            if (!opts.dryRun) await rm(work, { recursive: true, force: true });
        }
    }

    /**
     * Update some zones in Unity without planting everything (the Vegetation
     * mode's "Update in Unity" on the selected zones): for each terrain that
     * has a zones export, `gspro.py zones-patch` re-rasterizes only the window
     * those zones cover, now and in that export (and any zone the export has
     * that the course no longer has), into the exported masks, and the open
     * Unity project takes just the changed textures and respawns just that
     * window (`golfmap.zones.patch`). The generators do not run. It needs a
     * planting first (the masks and their import), and Unity open up front,
     * since masks patched without Unity would leave the scene behind the
     * export with nothing to say so. When the zone types' item bindings
     * changed since a terrain's export (and the zones reach that terrain),
     * its channels may have moved and only a full export can follow: that
     * terrain is skipped with a line in the report (the outer, which Plant
     * vegetation does not refresh, often is), and when every terrain is, the
     * job fails asking for Plant vegetation. The pipeline refuses before
     * writing anything, so a skipped terrain is left as it was.
     *
     * A hand-drawn creek_bank zone near water is a creek section: it picks the
     * palette the creek-bank generator plants on those banks, and plants
     * nothing itself. With one in the selection that generator runs first
     * (only it: it is the last in the stack), and the patch finds the zones
     * it changed by content (the rest come back under new ids, unchanged).
     */
    async updateZones(courseId: string, zoneIds: string[]): Promise<GsproExportResult> {
        if (zoneIds.length === 0) throw new ConflictError('Select the vegetation zones to update');
        const course = await this.courses.get(courseId);
        const dir = await this.exportDir(courseId);
        const kinds: TerrainKind[] = [];
        for (const kind of ['inner', 'outer'] as const) {
            if (await statOrNull(path.join(dir, zonesExportFileName(course.name, kind)))) kinds.push(kind);
        }
        if (kinds.length === 0) throw new ConflictError(`No vegetation zones export in ${dir} yet: plant vegetation once first`);
        const { editor, seen } = await editorForExportDir(this.unityBridge, dir);
        if (!editor) {
            throw new ConflictError(`Open the course's Unity project first: no open Unity editor imports from ${dir}`
                + (seen.length ? ` (open: ${seen.join('; ')})` : ''));
        }

        const report: string[] = [];
        const drawn = await this.db.selectFrom('course_features').select('attributes_json')
            .where('course_id', '=', courseId).where('id', 'in', zoneIds)
            .where('type', '=', 'vegetation_zone').where('generated', '=', 0)
            .execute();
        const zoneTypeOf = (json: string | null) => {
            try { return (JSON.parse(json ?? '{}') as { zoneType?: unknown }).zoneType; } catch { return undefined; }
        };
        if (drawn.some(r => zoneTypeOf(r.attributes_json) === CREEK_BANK_ZONE_TYPE)) {
            const regenerated = await this.runGenerators(courseId, 'inner', { from: CREEK_BANKS.source });
            report.push(...regenerated.report);
        }
        const patches: { kind: TerrainKind; record: string }[] = [];
        const stale: TerrainKind[] = [];
        for (const kind of kinds) {
            const zonesJson = path.join(dir, zonesExportFileName(course.name, kind));
            const record = zonesJson.replace(/\.json$/, '-patch.json');
            const args = [
                path.join(this.pipelineDir, 'gspro.py'), 'zones-patch',
                '--course', courseId,
                '--zones-json', zonesJson,
                '--ids', zoneIds.join(','),
                '--result', record,
            ];
            if (kind === 'outer') {
                const terrain = await this.resolveTerrain(courseId, 'update the outer vegetation zones of');
                args.push('--exclude-square', terrainArg(terrain.inner));
            }
            const { code, stdout, stderr } = await this.runner(args, this.pipelineDir);
            if (code === ZONES_LAYOUT_CHANGED_EXIT) {
                // Planting refreshes the inner export only, so an outer one is often older than the
                // bindings: the other terrain still updates, and the report says what was left.
                stale.push(kind);
                report.push(`${kind}: skipped - ${path.basename(zonesJson)} is older than the zone types' item bindings, so its channels may have moved; `
                    + `export the ${kind} vegetation zones (or plant) to bring it in step`);
                continue;
            }
            if (code !== 0) throw failure(`Updating the ${kind} zones`, code, stdout, stderr);
            report.push(...reportLines(stdout).map(line => `${kind}: ${line}`));
            const patched = JSON.parse(await readFile(record, 'utf8')) as { changed?: boolean };
            if (patched.changed) patches.push({ kind, record });
        }
        if (stale.length === kinds.length) {
            throw new ConflictError(`The zone types' item bindings changed since the last planting, so the ${stale.join(' and ')} masks' channels may have moved: `
                + 'use Plant vegetation this time');
        }
        if (patches.length === 0) {
            report.push('Nothing changed in the masks, so nothing to take into Unity');
            return { path: dir, report };
        }
        for (const p of patches) {
            try {
                const result = await editor.run('golfmap.zones.patch', { terrain: p.kind, patch: p.record, package: LOWER_VEGETATION_PACKAGE }, 300);
                report.push(`Unity (${editor.projectName}): ${firstLine(String(result?.status ?? `${p.kind} zones patched`))}`);
            } catch (e) {
                throw new ConflictError(`The ${p.kind} masks are updated in ${dir}, but Unity (${editor.projectName}) could not take them: `
                    + `${firstLine((e as Error).message)}. Plant vegetation to bring Unity in step`);
            }
        }
        report.push('Save the scene in Unity to keep it.');
        return { path: dir, report };
    }

    /**
     * The course's creeks as NatureManufacture R.A.M. splines for the inner
     * terrain (`<dir>/<course>-inner-creeks.json`, unity-creeks-v1, what
     * GolfMap › Creeks imports): each `water_creek` feature's line (drawn, or
     * the line down its polygon) with control points at the water surface,
     * falling downstream, written by `gspro.py creeks`. The surface comes
     * from the RAW lidar DEM: the edited one has the beds dug (`creek-digs`),
     * and the water belongs above them. Reads the inner heightmap sidecar for
     * the terrain's zero, so the inner heightmap must be exported first.
     */
    async exportCreeks(courseId: string): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new ConflictError('This course has no built map on this machine — build its map first');
        const terrain = await this.resolveTerrain(courseId, 'export the GSPro creeks for');
        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
        if (!await statOrNull(sidecar)) {
            throw new ConflictError(`Export the inner heightmap first — its sidecar (${path.basename(sidecar)}) carries the terrain's zero the creek heights are measured from`);
        }
        const dem = path.join(this.sourcesDir(course.siteId), 'dem.tif');
        if (!await statOrNull(dem)) throw new ConflictError(`No raw DEM for this course's site (${dem}) — build its map first`);
        const out = path.join(dir, creeksExportFileName(course.name));
        return this.run('GSPro creeks', [
            path.join(this.pipelineDir, 'gspro.py'), 'creeks',
            '--square-3006', terrainArg(terrain.inner),
            '--course', courseId,
            '--dem', dem,
            '--sidecar', sidecar,
            '--out', out,
        ], out);
    }

    /**
     * GreenKeeper's course file for GSPro: tee boxes, pins, green centres,
     * aim points, water hazards and the OOB ring as Unity positions on the
     * INNER terrain, written by `gspro.py gkd` into the course's GSPro folder
     * (`<folder>/<scene>.GKD`, or the `.GKD` already there) and merged into
     * it, so what GreenKeeper owns — name, location, ratings, the range —
     * stays. Reads the inner heightmap sidecar (and the GeoTIFF next to it)
     * for the terrain's zero, so that must be exported first.
     */
    async exportGkd(courseId: string): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const { courseDir, gkdFile } = await this.settings(courseId);
        if (!courseDir || !gkdFile) {
            throw new ConflictError('Set the GSPro course folder first — the course\'s folder under GSPro\'s Courses, where its .gspcrse is');
        }
        if (!await statOrNull(courseDir)) throw new ConflictError(`The GSPro course folder ${courseDir} is gone`);
        const terrain = await this.resolveTerrain(courseId, 'export the GreenKeeper course file for');
        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
        if (!await statOrNull(sidecar)) {
            throw new ConflictError(`Export the inner heightmap first — its sidecar (${path.basename(sidecar)}) and GeoTIFF give the GKD its heights`);
        }
        const out = path.join(courseDir, gkdFile);
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'gkd',
            '--square-3006', terrainArg(terrain.inner),
            '--course', courseId,
            '--sidecar', sidecar,
            '--out', out,
        ];
        return this.run('GreenKeeper course file', args, out);
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
            case 'svg': return this.export(courseId, { excludeFeatureIds: r.excludeFeatureIds, variant: r.variant });
            case 'ortho': return this.exportOrtho(courseId, r.source!, r.darken, tintOptions(r), floorOptions(r), r.removeBuildings === true);
            case 'outer-ortho': return this.exportOuterOrtho(courseId, r.collection!, r.darken, tintOptions(r), floorOptions(r), r.removeBuildings === true);
            case 'dem': return this.exportDem(courseId, r.terrain!);
            case 'unity-terrain': return this.exportUnityTerrain(courseId, r.terrain!);
            case 'unity-sculpt': return this.exportUnitySculpt(courseId, r.terrain!);
            case 'hillshade': return this.exportHillshade(courseId, r.terrain!);
            case 'trees': return this.exportTrees(courseId, r.terrain!);
            case 'buildings': return this.exportBuildings(courseId, r.terrain!);
            case 'zones': return this.exportZones(courseId, r.terrain!);
            case 'vegetation': return this.plantVegetation(courseId, r.terrain!);
            case 'vegetation-update': return this.updateZones(courseId, r.zoneIds!);
            case 'creeks': return this.exportCreeks(courseId);
            case 'gkd': return this.exportGkd(courseId);
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
        if (kind === 'inner') {
            const src = await this.innerDem(siteId);
            const stale = await this.staleInnerDem(siteId, src);
            return { src, fetched: stale ? [`warning: ${stale}`] : [] };
        }
        const src = path.join(this.sourcesDir(siteId), OUTER_DEM_SOURCE);
        const fetched = await this.ensureOuterDem(siteId, square, src);
        const edited = await this.outerDemWithEdits(siteId, src);
        return edited ? { src: edited.path, fetched: [...fetched, ...edited.report] } : { src, fetched };
    }

    /**
     * Why the inner DEM an export would use does not carry the site's
     * current terrain edits, or null when it does. The inner exports read
     * what "Apply to terrain" last wrote (D-TE2: the export shows what the
     * map shows), so an edit generated, changed or switched after that — or
     * edits never applied at all — is missing from them, while the outer
     * export replays the edits fresh and has it: the two heightmaps then
     * disagree under it. (A deleted edit leaves no trace to compare.)
     */
    private async staleInnerDem(siteId: string, src: string): Promise<string | null> {
        const edits = (await this.terrainEdits.listBySite(siteId)).filter(e => e.enabled);
        if (edits.length === 0) return null;
        if (path.basename(src) !== 'dem-edited.tif') {
            return `the site has ${edits.length} enabled terrain edit(s) but no edited DEM, so this heightmap has none of them: press Apply to terrain in the terrain tool, then export again`;
        }
        const built = (await stat(src)).mtimeMs;
        const changed = edits.filter(e => Date.parse(`${e.updatedAt.replace(' ', 'T')}Z`) > built + 1000);
        if (changed.length === 0) return null;
        const origins = [...new Set(changed.map(e => e.origin ?? 'hand-drawn'))].join(', ');
        return `${changed.length} terrain edit(s) (${origins}) changed after the last Apply to terrain, so this heightmap lacks them: press Apply to terrain in the terrain tool, then export again`;
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
            await writeFile(editsPath, JSON.stringify(terrainEditsGeojson(edits, { sculptDir: path.join(this.sourcesDir(siteId), SCULPT_DIR) })));
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
     * softened and with the course's grass surfaces tinted by its own drawn
     * features (the pipeline reads them from the app database by course
     * id), at `MESH_TEXTURE_SIZE`. With `floor`, the course's woodland_floor
     * zones are painted as forest floor on the render first, so all the
     * files carry it. With `buildings`, the roofs (lidar `roofs.tif` and/or
     * the building survey's footprints) and their shadows are filled from
     * the ground round them before that; with neither file on disk the
     * render goes ahead and the report says what to run.
     */
    private async renderOrtho(what: string, square: TerrainSquare, src: string, out: string, courseId: string,
                              darken?: number, tint?: TerrainTintOptions, floor?: ForestFloorOptions,
                              buildings?: BuildingSources): Promise<GsproExportResult> {
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
                throw new ConflictError(`Surface tint opacity must be between ${tlo} and ${thi} (${TERRAIN_TINT_OPACITY} = the photo at half strength over green)`);
            }
            tintArgs.push(
                '--tint-out', meshTextureFileName(out),
                '--tint-course', courseId,
                '--tint-opacity', String(opacity),
                '--soften-m', String(MESH_TEXTURE_SOFTEN_M),
                '--tint-size', String(MESH_TEXTURE_SIZE),
            );
            if (tint.darkenTint) tintArgs.push('--darken-tint');
            if (tint.grade) tintArgs.push('--tint-grade', tint.grade.join(','));
        }
        const floorArgs: string[] = [];
        if (floor) {
            if (floor.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(floor.color)) {
                throw new ConflictError(`Forest floor colour must be #rrggbb (got ${floor.color})`);
            }
            if (floor.mix !== undefined && (!Number.isFinite(floor.mix) || floor.mix < 0 || floor.mix > 1)) {
                throw new ConflictError('Forest floor photo mix must be between 0 and 1');
            }
            floorArgs.push('--floor-course', courseId);
            if (floor.color !== undefined) floorArgs.push('--floor-color', floor.color);
            if (floor.mix !== undefined) floorArgs.push('--floor-mix', String(floor.mix));
        }
        const buildingArgs: string[] = [];
        const notes: string[] = [];
        if (buildings) {
            if (!buildings.roofs && !buildings.survey) {
                notes.push('Buildings not removed: no roof heights for this course yet — run "Regenerate trees" on the map (and "Generate building pads" for buildings newer than the lidar)');
            } else {
                buildingArgs.push('--remove-buildings');
                if (buildings.roofs) buildingArgs.push('--roofs', buildings.roofs);
                if (buildings.survey) buildingArgs.push('--buildings-survey', buildings.survey);
            }
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
            ...floorArgs,
            ...buildingArgs,
        ];
        const rendered = await this.run(what, args, out);
        return notes.length ? { path: rendered.path, report: [...notes, ...rendered.report] } : rendered;
    }

    /** The site's roof heights and building survey, each null when not on disk. */
    private async buildingSources(siteId: string): Promise<BuildingSources> {
        const roofs = path.join(this.sourcesDir(siteId), ROOFS_SOURCE);
        const survey = path.join(this.sourcesDir(siteId), BUILDINGS_SURVEY_SOURCE);
        return {
            roofs: await statOrNull(roofs) ? roofs : null,
            survey: await statOrNull(survey) ? survey : null,
        };
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
        case 'svg': {
            const notes = [
                r.variant?.trim() ? `variant ${courseSlug(r.variant)}` : '',
                r.excludeFeatureIds?.length ? `${r.excludeFeatureIds.length} feature(s) excluded` : '',
            ].filter(Boolean);
            return notes.length ? `course SVG (${notes.join(', ')})` : 'course SVG';
        }
        case 'ortho': need(r.source, 'a source'); return 'inner orthophoto';
        case 'outer-ortho': need(r.collection, 'a collection'); return 'outer orthophoto';
        case 'dem': need(r.terrain, 'a terrain'); return `${r.terrain} heightmap`;
        case 'unity-terrain': need(r.terrain, 'a terrain'); return `${r.terrain} heightmap into Unity`;
        case 'unity-sculpt': need(r.terrain, 'a terrain'); return `${r.terrain} Unity sculpt into golf-map`;
        case 'hillshade': need(r.terrain, 'a terrain'); return `${r.terrain} hillshade`;
        case 'trees': need(r.terrain, 'a terrain'); return `${r.terrain} trees`;
        case 'buildings': need(r.terrain, 'a terrain'); return `${r.terrain} buildings`;
        case 'zones': need(r.terrain, 'a terrain'); return `${r.terrain} vegetation zones`;
        case 'vegetation': need(r.terrain, 'a terrain'); return `${r.terrain} vegetation, planted into Unity`;
        case 'vegetation-update': need(r.zoneIds?.length, 'the zones to update'); return `${r.zoneIds!.length} vegetation zone(s) updated in Unity`;
        case 'creeks': return 'creeks (R.A.M. splines)';
        case 'gkd': return 'GreenKeeper course file';
        default: throw new ConflictError(`Unknown export kind '${String((r as { kind: unknown }).kind)}'`);
    }
}

function firstLine(text: string): string {
    return text.split('\n')[0] ?? '';
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

/**
 * The `.GKD` in a GSPro course folder: the one already there (GreenKeeper
 * names it after the scene, whatever its case), else `<folder name>.GKD`.
 */
export async function gkdFileIn(courseDir: string): Promise<string> {
    let names: string[] = [];
    try {
        names = await readdir(courseDir);
    } catch {
        // not there (yet): the name it will get
    }
    return names.find(n => n.toLowerCase().endsWith('.gkd')) ?? `${path.basename(courseDir)}.GKD`;
}

export async function statOrNull(p: string) {
    try {
        return await stat(p);
    } catch {
        return null;
    }
}

/** A heightmap sidecar's `minM` (the terrain's zero), null when there is none. */
async function readSidecarMin(file: string): Promise<number | null> {
    try {
        const min = JSON.parse(await readFile(file, 'utf8')).minM;
        return typeof min === 'number' ? min : null;
    } catch {
        return null;
    }
}
