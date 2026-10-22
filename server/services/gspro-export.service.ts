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
//                    square left out). Reads that terrain's heightmap
//                    sidecar for the height range, exporting the heightmap
//                    first when the folder has none.
//   - `exportGkd`    GreenKeeper's course file (`<scene>.GKD`) — tee boxes,
//                    pins, green centres, aim points, water hazards and the
//                    OOB ring as Unity positions on the inner terrain —
//                    merged into the one in the course's GSPro folder
//                    (`courses.gspro_course_dir`), not the export folder.
//                    Reads the inner heightmap sidecar for the terrain's
//                    zero, exporting it first when there is none.
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
import { SCULPT_DIR, SCULPT_ORIGINS, TerrainEditsService, type TerrainEdit, type TerrainEditInput } from './terrain-edits.service';
import { defaultUnityBridge, editorForExportDir, type UnityBridge, type UnityEditor } from './unity-bridge';
import { terrainEditsGeojson, ROOFS_SOURCE, DIG_WATER_LEVELS_SOURCE } from './map-build.service';
import { resolveCourseMapBbox } from './course-bbox';
import {
    courseTerrainFor, innerSquareFrom3006, terrainArg, bboxArg,
    type CourseTerrain, type TerrainSquare,
} from './terrain-square';
import { DEFAULT_PIPELINE_DIR } from './pipeline-dir';
import {
    digest, fingerprint, mtimeMs, recordInputs, unchangedLine, type ExportInputs,
} from './export-fingerprint';
import { FeatureHistoryService, type CodeVersion } from './feature-history.service';
import { CourseFeaturesService } from './course-features.service';
import type { CourseFeature, FeatureAttributes } from './course-features.service';
import { PATH_RENDER_ATTRIBUTE, PATH_RENDERS, isPathRender, pathRenderError, type PathRender } from '../../shared/features/path-render';
import { ZoneTypesService } from './zone-types.service';
import {
    CREEK_BANKS, VEGETATION_GENERATORS, VEGETATION_RULES_FILE, generateVegetation, readRuleDefaults, vegetationRulesArgs,
    type GeneratorFingerprint, type VegetationGenerator, type VegetationInputs, type VegetationOptions, type VegetationRun,
} from './vegetation-generators';
import { CREEK_BANK_ZONE_TYPE } from '../../shared/features/creek-vegetation';
import { BUILDINGS_SURVEY, ROAD_CENTERLINES } from './terrain-generators.service';
import { GKD_KEYWORDS, metaFromGkd, type GsproCourseMeta } from '../../shared/gspro-course-meta';
import { gkdRating, gkdRatingKey, parseGkdRating } from '../../shared/tee-sets';
import { TeeSetsService } from './tee-sets.service';
import { ArboristService, type ArboristResult } from './arborist.service';

export type { CourseTerrain, TerrainSquare } from './terrain-square';
export type { GsproCourseMeta } from '../../shared/gspro-course-meta';

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
    /**
     * The course details kept with the course (name, location, designer,
     * description, keywords), which the `.GKD` export writes into
     * the file; null until set, and the export then keeps the file's own.
     */
    meta: GsproCourseMeta | null;
    /** The same details as the `.GKD` in `courseDir` has them now (null without a readable one). */
    gkdMeta: GsproCourseMeta | null;
    /**
     * What the course is called in OPCD's cloud course builder — the
     * `Course Name` of its row in the builder's "Course Workflow" list, which
     * `scripts/opcd-build.ts` opens the dashboard from. Not our course name
     * (`Vreta` here is `Vreta Kloster golfklubb` there); null until set.
     */
    opcdCourseName: string | null;
    /**
     * Tee sets whose rating in that `.GKD` is not the one the course keeps
     * for them (`Yellow 71.5/135`, as the file has it): edited in
     * GreenKeeper, and what `readGkdMeta` takes over. Empty when they agree.
     */
    gkdRatings: string[];
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
    /**
     * `vegetation-update` only: nothing was written, because the only way on
     * is the WHOLE planting (minutes: every generator runs again and the
     * Arborist file is rewritten) and nobody has agreed to that. `reason` says
     * why; `plantIfNeeded` on the request runs it.
     */
    needsPlanting?: boolean;
    /** Set exactly with `needsPlanting`: what a person has to decide about. */
    reason?: string;
}

/** What an export job produces. */
export type GsproExportKind = 'svg' | 'ortho' | 'outer-ortho' | 'dem' | 'unity-terrain' | 'unity-sculpt' | 'unity-ortho' | 'hillshade' | 'trees' | 'buildings' | 'zones' | 'vegetation' | 'vegetation-update' | 'arborist' | 'creeks' | 'ramroads' | 'waterfalls' | 'gkd';

/** A request to start one export; which fields matter depends on `kind`. */
export interface GsproExportRequest {
    kind: GsproExportKind;
    /** `ortho`, `unity-ortho`: a `source` file name from `orthoSources`. */
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
    /**
     * `vegetation-update`: run the whole planting when the zones cannot be
     * patched (no zones export yet, or the zone types' items have moved since
     * it). Default false — the job then succeeds with `needsPlanting` and
     * writes nothing, so the caller can ask first.
     */
    plantIfNeeded?: boolean;
    /**
     * Render even when the output's inputs are unchanged
     * (export-fingerprint.ts): `dem`, `ortho`, `outer-ortho`, `unity-terrain`,
     * `unity-ortho`, `trees`, `buildings`, `zones`, `creeks`, `ramroads`, `waterfalls`, `vegetation`.
     */
    force?: boolean;
}

/** Feature types the SVG draws as another OPCD surface than the pipeline's default (`gspro.py svg --map`): canopy as pine straw. */
export const SVG_TYPE_MAP: Record<string, string> = { trees: 'pinestraw' };

// --- SVG checks -------------------------------------------------------------
// `gspro.py svg` checks what OPCD will see before it writes the SVG (docs/gspro/export.md
// "SVG checks"): an unaccepted error stops the export (exit 3, nothing written, the
// findings in `<stem>.checks.json`), `checkSvg` runs the same checks writing nothing
// (the Draw mode's Check shapes overlay), and a known finding is accepted per course
// in docs/gspro/<course>/svg-checks.json, keyed so it survives re-exports.

/** `gspro.py svg` exit code: unaccepted check errors, nothing written. */
export const SVG_CHECK_ERRORS_EXIT = 3;
/** Per-course accepted findings (docs/gspro/<course>/). */
export const SVG_CHECKS_ACCEPTED_FILE = 'svg-checks.json';

/** One SVG shape a finding is about. */
export interface SvgCheckShape {
    /** SVG path id, `hole_8_253`. */
    name: string;
    type: string;
    /** The features behind it (a merged road has several). */
    featureIds: string[];
}

/** One check finding (gspro.py `golfmap-svg-checks-v1`). */
export interface SvgCheckFinding {
    /** `<code>:<ids>`: stable while the same features are involved; what accepting stores. */
    key: string;
    code: string;
    severity: 'error' | 'warning' | 'note';
    accepted: boolean;
    message: string;
    shapes: SvgCheckShape[];
    /** EPSG:3006 metres. */
    at: [number, number] | null;
    /** The problem itself (the strip, the neck, the hidden shape) as GeoJSON in EPSG:3006 metres. */
    geometry: { type: string; coordinates: unknown } | null;
}

export interface SvgCheckReport {
    courseId: string;
    checkedAt: string;
    errors: number;
    warnings: number;
    notes: number;
    accepted: number;
    findings: SvgCheckFinding[];
}

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
    /** True for the cleaned photo (`ortho-<collection>.cleaned.tif`, CleanedPhotoService): the vintage with the Clean tool's edits, 8192 px on the inner square. */
    cleaned: boolean;
    /** True for the vintage the map is currently showing. */
    active: boolean;
}

/** Which of the two GSPro terrains an export is for. */
export type TerrainKind = 'inner' | 'outer';

/**
 * Runs one `python …` invocation (gspro.py, arborist.py or `-m golfpipe`). Injected so tests need no venv.
 * `timeoutMs`: the process is killed after that long and the run fails saying so (default: none).
 */
export type ExportRunner = (args: string[], cwd: string, opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

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
 * linear light), for an outer terrain on the Built In Legacy Diffuse
 * material (the terrain importer sets it): the terrain shader lights a
 * texture differently from the course-mesh shaders, so the same colours on
 * both sides of the inner/outer seam LOOK different in game; the outer file
 * is graded by this so the terrain renders like the meshes next to it.
 * Measured as rendered-mesh / rendered-terrain on the same fields either
 * side of the seam in Vreta screenshots. The Standard terrain material
 * needed 0.46/0.70/0.21 and still had a pale sky sheen at low angles that no
 * texture can cancel; Legacy Diffuse has no sheen, and with that grade came
 * out too dark and too green (blue crushed to nothing), so ×1.8/1.4/3.6 on
 * top. Dark and light fields do not respond alike (the darkest values render
 * darker still), so this is a compromise between them. When the two still
 * differ in game: measure that ratio again and multiply (part of) it in here.
 */
export const OUTER_TERRAIN_GRADE: readonly [number, number, number] = [0.83, 0.98, 0.76];
/**
 * Edge of the `-meshes` file. The softened grass would fit in 4096 px, but
 * bunkers and paths stay sharp and a 2-3.5 m path is only 4-7 texels wide at
 * 4096 over a 2 km square: its diagonal edges stepped in 0.5 m blocks, which
 * Unity's BC1 compression turned into 2 m teeth. So the full size.
 */
export const MESH_TEXTURE_SIZE = 8192;
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
    return async (args, cwd, opts) => {
        // UTF-8 stdout: the exporters print '×' and '…', which a Windows
        // Python would otherwise emit in cp1252 and the report would mangle.
        const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
        const proc = Bun.spawn([python, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
        let timedOut = false;
        const timer = opts?.timeoutMs ? setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs) : null;
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ]);
        if (timer) clearTimeout(timer);
        if (timedOut) return { code: code || 124, stdout, stderr: `${stderr}
timed out after ${Math.round(opts!.timeoutMs! / 1000)} s` };
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
 * `Vreta`, orto-l2-2025 (cleaned) -> `vreta-orto-l2-2025-cleaned-8192.jpg`;
 * `clean` (buildings removed / forest floor painted) adds `-clean` before the size.
 */
export function orthoExportFileName(courseName: string, source: GsproOrthoSource, clean = false): string {
    const cleaned = source.cleaned ? '-cleaned' : '';
    return `${courseSlug(courseName)}-${source.collection}${cleaned}${clean ? '-clean' : ''}-${ORTHO_EXPORT_SIZE}.jpg`;
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

/** `Vreta`, inner -> `vreta-inner-placements.json` (golfmap-placements-v1): what Unity's planter planted, before any renderer. */
export function placementsExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-placements.json`;
}

/** `Vreta`, inner -> `vreta-inner-tree-edits.json` (golfmap-tree-edits-v1, beside the trees export). */
export function treeEditsFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-tree-edits.json`;
}

/**
 * `Omberg`, inner -> `ombergs-golfklubb-inner-routing.json` (golfmap-routing-v1, `arborist.py route`): each tree by id
 * routed before planting - own (its model's renderer), billboard (Arborist) or out. Unity's planter reads it.
 */
export function routingExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-routing.json`;
}

/** `Vreta`, outer -> `vreta-outer-buildings.json` (unity-buildings-v1). */
export function buildingsExportFileName(courseName: string, kind: TerrainKind): string {
    return `${courseSlug(courseName)}-${kind}-buildings.json`;
}

/** The building survey the terrain tool's "Generate building pads" writes under `sources/<siteId>/`. */
export const BUILDINGS_SURVEY_SOURCE = 'buildings.geojson';
/** The outer DEM with the site's terrain edits replayed onto it (derived, rebuilt per export). */
export const OUTER_DEM_EDITED_SOURCE = 'outer-dem-edited.tif';

/** `Vreta` -> `vreta-inner-water-levels.json`: the water planes' set surfaces (Unity Y), golfmap.waterplanes.build reads it. */
export function waterLevelsFileName(courseName: string): string {
    return `${courseSlug(courseName)}-inner-water-levels.json`;
}
/** A water-edge pond's water stands this far over its dig's level: it meets the bank just outside the outline. */
export const WATER_EDGE_SURFACE_M = 0.05;

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

/**
 * Why nothing of the OUTER terrain's vegetation goes into the course's own VSP (Marcus, 2026-10-14):
 * GSPro's Arborist draws all of it (the outer catalogue's trees as billboards, `arborist.py trees`),
 * and all VSP grass is on the inner terrain. Planting the outer is therefore its zones file only.
 */
export const OUTER_VEGETATION_IS_ARBORIST = "outer terrain: nothing planted into the course's VSP - its vegetation is Arborist's "
    + '(the outer trees as billboards; no grass out there), so only the outer zones file is written and the generators are not run for it';

/** The zones a terrain's masks were rendered from (`<zones>.json.index.json`), for Update vegetation's patch. */
export const ZONES_INDEX_FORMAT = 'golfmap-zones-index-v1';
/** More changed zones than this and Update vegetation rasterizes the whole terrain instead of patching. */
export const ZONES_PATCH_MAX = 200;

export function zonesIndexFile(zonesJson: string): string {
    return `${zonesJson}.index.json`;
}

/** What `recordZonesIndex` wrote, or null (none, unreadable, another format). */
async function readZonesIndex(zonesJson: string): Promise<{ zones: ZoneContent[]; unity: { project: string; palette: string } | null } | null> {
    try {
        const doc = JSON.parse(await readFile(zonesIndexFile(zonesJson), 'utf8')) as { format?: unknown; zones?: unknown; unity?: unknown };
        if (doc.format !== ZONES_INDEX_FORMAT || !Array.isArray(doc.zones)) return null;
        const u = doc.unity as { project?: unknown; palette?: unknown } | null | undefined;
        return {
            zones: (doc.zones as Partial<ZoneContent>[]).filter((z): z is ZoneContent => typeof z?.id === 'string' && typeof z.content === 'string'),
            unity: u && typeof u.project === 'string' && typeof u.palette === 'string' ? { project: u.project, palette: u.palette } : null,
        };
    } catch {
        return null;
    }
}

/** A vegetation zone by the digest of what decides its raster (no id, no stack slot), and its id. */
export interface ZoneContent {
    id: string;
    content: string;
}

/**
 * The zones as they are now against the ones the masks were rendered from,
 * both in stack order: the ids of the zones whose content the masks have not
 * seen (`changed`; `edited` of them were there under the same id), how many
 * rendered ones are gone that way and are not edited ones (`removed`), and
 * whether the zones both have are still in the same order. A zone matches by
 * content whatever its id (a generator's re-run renumbers them); identical
 * zones count by multiplicity. Pure + exported for tests.
 */
export function diffZoneContents(renderedZones: readonly ZoneContent[], now: readonly ZoneContent[]):
    { changed: string[]; edited: number; removed: number; sameOrder: boolean } {
    const rendered = renderedZones.map(z => z.content);
    const count = (list: readonly string[]) => {
        const m = new Map<string, number>();
        for (const c of list) m.set(c, (m.get(c) ?? 0) + 1);
        return m;
    };
    const left = count(rendered);
    const changed: string[] = [];
    const keptNow: string[] = [];
    for (const z of now) {
        const n = left.get(z.content) ?? 0;
        if (n > 0) {
            left.set(z.content, n - 1);
            keptNow.push(z.content);
        } else {
            changed.push(z.id);
        }
    }
    const gone = [...left.values()].reduce((a, b) => a + b, 0);
    const there = count(now.map(z => z.content));
    const keptRendered: string[] = [];
    for (const c of rendered) {
        const n = there.get(c) ?? 0;
        if (n > 0) {
            there.set(c, n - 1);
            keptRendered.push(c);
        }
    }
    const before = new Set(renderedZones.map(z => z.id));
    const edited = changed.filter(id => before.has(id)).length;
    return { changed, edited, removed: Math.max(0, gone - edited), sameOrder: keptNow.join() === keptRendered.join() };
}

/** A duration for the report's time line: "3.2 s". */
function seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)} s`;
}

/** `gspro.py zones-patch`'s exit code when the item bindings moved since the export (ZONES_LAYOUT_CHANGED_EXIT). */
export const ZONES_LAYOUT_CHANGED_EXIT = 3;

/** `Vreta` -> `vreta-inner-creeks.json` (unity-creeks-v1, R.A.M. splines; inner terrain only). */
export function creeksExportFileName(courseName: string): string {
    return `${courseSlug(courseName)}-inner-creeks.json`;
}

/** `Vreta` -> `vreta-inner-ramroads.json` (unity-ramroads-v1, the render=ram paths as R.A.M. splines; inner terrain only). */
export function ramRoadsExportFileName(courseName: string): string {
    return `${courseSlug(courseName)}-inner-ramroads.json`;
}

/**
 * How far past the inner square the R.A.M. roads run (`gspro.py ramroads --reach-m`), metres: on the outer
 * terrain they snap onto the Unity terrain; cut at the edge they would fade out right at the square's border.
 */
export const RAM_ROADS_REACH_M = 200;

/** One path `gspro.py ramroads-propose` suggests drawing as a R.A.M. spline. */
export interface RamRoadCandidate {
    featureId: string;
    /** Null for a feature without a number (a generated one). */
    featureNo: number | null;
    surface: string;
    widthM: number;
    lengthM: number;
    /** How far the road's corridor stays from play (greens, tees, fairways, semi rough, bunkers), metres; null with no play drawn. */
    distanceToPlayM: number | null;
    /** The roads it meets at its ends: their feature numbers (an id for one without a number). */
    touches: Array<number | string>;
    reason: string;
}

/** `gspro.py ramroads-propose`'s answer (golfmap-ramroads-proposal-v1): which paths could become R.A.M. roads. */
export interface RamRoadsProposal {
    format: string;
    course: { id: string; name: string };
    /** The rules the proposal went by (min distance to play, surfaces, play types, end join), as the pipeline reports them. */
    rules: Record<string, unknown>;
    candidates: RamRoadCandidate[];
    /** The paths already render=ram: feature numbers (an id for one without a number). */
    already: Array<number | string>;
    rejected: Array<{ featureNo: number | null; featureId: string; reason: string }>;
}

/** What `setRoadRender` did (or, with `dryRun`, would do), by feature id. */
export interface RoadRenderResult {
    render: PathRender;
    changed: string[];
    unchanged: string[];
    dryRun: boolean;
}

/**
 * One hazard of the GreenKeeper course file, as `gspro.py gkd-lines` reports it: the closed ring (first point
 * not repeated, EPSG:3006 metres, nodes every 3 m at most) exactly as it goes into the .GKD.
 */
export interface GkdHazardLine {
    /** `water`: staked round water bodies no drawn penalty area holds; `penalty`: a drawn penalty area; `inner_oob`: a drawn inner OOB. */
    kind: 'water' | 'penalty' | 'inner_oob';
    /** `water`: the water/creek features the line holds (merged bodies share one line). */
    waterIds?: string[];
    /** `penalty`, `inner_oob`: the drawn feature (one feature can give several lines where the course boundary cuts it). */
    featureId?: string;
    /** `penalty`: `penalty_red` or `penalty_yellow`. */
    type?: string;
    /** GSPro's noAIL: a ball inside must be dropped. False unless the feature's (a water line: any of its waters') `noAsItLies` attribute says true. */
    noAsItLies: boolean;
    points: [number, number][];
}

/** How the automatic water lines are staked (`gspro.py gkd-lines`' `rule`). */
export interface GkdLinesRule {
    /** Distance outside the water's shape, metres. */
    marginM: number;
    /** Furthest out the bank can take the line, metres. */
    bankMaxM: number;
    bankStartM: number;
    /** The bank has ended where the ground is flatter than this (percent slope) in deep rough or undrawn ground… */
    deepPct: number;
    /** …and than this elsewhere. */
    roughPct: number;
}

/** `gspro.py gkd-lines`' answer: every hazard the course file gets, one entry each. */
export interface GkdLines {
    courseId: string;
    crs: string;
    rule: GkdLinesRule;
    lines: GkdHazardLine[];
}

/** `gspro.py creek-depth`'s report format. */
export const CREEK_DEPTH_FORMAT = 'golfmap-creek-depth-v1';

/**
 * A creek's verdict: `ok` deep enough in the meshes, `shallow` banks under the water (+ freeboard near play) somewhere
 * or a bank left across its mouth, `not-dug` no `creek-digs` edit, `stale` its dig misses part of it or has another
 * depth, `off` `dig: false`, `on-lake` R.A.M. water on a lake (not measured).
 */
export type CreekDepthStatus = 'ok' | 'shallow' | 'not-dug' | 'stale' | 'off' | 'on-lake';

/** Depths below the water's banks along a creek, metres. */
export interface CreekDepthStats {
    median: number;
    p10: number;
}

/** A stretch of a creek too shallow in the meshes: metres along it, its middle (EPSG:3006), the depths there. */
export interface CreekDepthStretch {
    fromM: number;
    toM: number;
    x: number;
    y: number;
    meshDepthM: number;
    demDepthM: number;
}

/** A creek's mouth into a pond, measured from 3 m up the creek (EPSG:3006): how high a bank stands across it. */
export interface CreekDepthMouth {
    x: number;
    y: number;
    blockM: number;
    demBlockM: number;
    blocked: boolean;
}

/** One `water_creek` in the creek-depth report. The measured fields are missing for `on-lake`. */
export interface CreekDepthCreek {
    id: string;
    featureNo: number | null;
    hole: number | null;
    /** `hole 5 0bfe60f0`, or the id's start for a creek on no hole. */
    label: string;
    widthM: number;
    lengthM: number;
    farFromPlay?: boolean;
    status: CreekDepthStatus;
    dig: { state: 'dug' | 'none' | 'stale' | 'off' | 'on-lake'; depthM?: number | null; bankSlopeDeg?: number | null; outsideM?: number };
    /** The least depth that counts: the water over the bed, + the freeboard near play. */
    minDepthM?: number;
    demDepthM?: CreekDepthStats | null;
    meshDepthM?: CreekDepthStats | null;
    /** Metres of it in a creek bed a shaping layer cuts out in Blender. */
    bedM?: number;
    shallowM?: number;
    shallow?: CreekDepthStretch[];
    /** Shallow stretches under a `path` (a culvert or a bridge): listed, not counted as shallow. */
    crossings?: CreekDepthStretch[];
    mouths?: CreekDepthMouth[];
}

/**
 * `GsproExportService.creekDepth`: how deep each creek comes out in the course meshes (`gspro.py creek-depth`,
 * golfmap-creek-depth-v1), plus which DEM it was measured on and the pipeline's printed lines.
 */
export interface CreekDepthReport {
    format: string;
    course: { id: string; name: string };
    /** The DEM file measured; `replayedEdits` is the number of terrain edits replayed onto it first (null: none were). */
    dem: { file: string; replayedEdits: number | null };
    blenderBeds: { layers: string[]; beds: number; channels: number };
    model: {
        nodeSpacingM: number;
        terrainSmooth: number;
        meshEdgeM: number;
        phases: number;
        waterAboveBedM: number;
        minFreeboardM: number;
        bankBandM: number;
    };
    /**
     * `creeks` (how many were measured), then the count per CreekDepthStatus (`ok`, `shallow`, `not-dug`, …; a
     * status no creek has is left out). A plain record: the API generator cannot write the hyphenated keys.
     */
    summary: Record<string, number>;
    creeks: CreekDepthCreek[];
    skipped: string[];
    /**
     * `applied`: the edited DEM Apply to terrain last wrote (no enabled edit changed after it); `replayed`: the raw
     * DEM with the site's enabled edits replayed onto it in memory (edits not applied yet, or no edited DEM).
     */
    demSource: 'applied' | 'replayed';
    /** What the check printed: a heightmap export it had to run first, then the summary and one line per creek. */
    lines: string[];
}

/**
 * `--db <the server's own database>` (DB_PATH, absolute: the pipeline runs in pipeline/), so what gspro.py reads is
 * what the app just saved — the e2e and preview servers run on their own copies; empty = gspro.py's default.
 */
function serverDbArgs(): string[] {
    const db = process.env.DB_PATH;
    return db ? ['--db', path.resolve(db)] : [];
}

/** `Vreta` -> `vreta-inner-gkd-lines.json` (`gspro.py gkd-lines`: the course file's hazard lines in EPSG:3006). */
export function gkdLinesFileName(courseName: string): string {
    return `${courseSlug(courseName)}-inner-gkd-lines.json`;
}

/** `Vreta` -> `vreta-inner-waterfalls.json` (unity-waterfalls-v1, the falls' lips and levels; inner terrain only). */
export function waterfallsExportFileName(courseName: string): string {
    return `${courseSlug(courseName)}-inner-waterfalls.json`;
}

/** `Vreta` -> `vreta-holes.json` (golfmap-holes-v1: tees, aim points, green centres for Unity's hole navigator). */
export function holesExportFileName(courseName: string): string {
    return `${courseSlug(courseName)}-holes.json`;
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

/**
 * `ortho-orto-l2-2025.cleaned.tif` -> collection + cleaned flag; null for other
 * files, the retired patch-log model's `.patched.tif` among them.
 */
export function parseOrthoSourceName(name: string): { collection: string; cleaned: boolean } | null {
    if (/\.patched\.tif$/i.test(name)) return null;
    const m = /^ortho-(.+?)(\.cleaned)?\.tif$/i.exec(name);
    if (!m) return null;
    return { collection: m[1], cleaned: m[2] !== undefined };
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
    /**
     * Where the courses' hand-kept GSPro files live, `<root>/<course slug>/`
     * (default `<pipelineDir>/../docs/gspro`, as the shaping layers): the trees
     * export reads `stone-walls.json` there, the course's placed rocks.
     */
    courseDocsRoot?: string;
    runner?: ExportRunner;
    /** The site's terrain edits, replayed onto the outer DEM at export; defaults to a db-backed instance. */
    terrainEdits?: TerrainEditsService;
    /** The open Unity editors (`unity-terrain` puts the heightmap into the course's one); defaults to the real bridge. */
    unityBridge?: UnityBridge;
    /** Write the Arborist file here instead of into the course's GSPro folder (tests, trial runs). */
    arboristOutDir?: string;
}

export class GsproExportService {
    private readonly db: Kysely<Database>;
    private readonly courses: CoursesService;
    private readonly assets: AssetsService;
    private readonly terrainEdits: TerrainEditsService;
    private readonly unityBridge: UnityBridge;
    private readonly dataDir: string;
    private readonly pipelineDir: string;
    private readonly courseDocsRoot: string;
    private readonly runner: ExportRunner;
    private readonly history: FeatureHistoryService;
    private readonly arborist: ArboristService;
    private readonly arboristOutDir: string | undefined;
    /** Every job started in this process, by id (finished ones pruned per course as new ones start). */
    private readonly jobs = new Map<string, GsproExportJob>();
    /** The running job's completion, per course — what `start` refuses on and `whenIdle` awaits. */
    private readonly inflight = new Map<string, Promise<void>>();
    /** `gkdLines` runs per course, chained so they never overlap. */
    private readonly gkdLinesRuns = new Map<string, Promise<unknown>>();

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
        this.courseDocsRoot = deps.courseDocsRoot ?? path.join(this.pipelineDir, '..', 'docs', 'gspro');
        const python = deps.python ?? process.env.MAP_PIPELINE_PYTHON ?? venvPython(this.pipelineDir);
        this.runner = deps.runner ?? defaultRunner(python);
        this.history = new FeatureHistoryService(deps.db);
        this.arboristOutDir = deps.arboristOutDir;
        this.arborist = new ArboristService({
            dataDir: this.dataDir, pipelineDir: this.pipelineDir, courseDocsRoot: this.courseDocsRoot, runner: this.runner, outDir: deps.arboristOutDir,
        });
    }

    /** Where this course exports to, and what the default is. */
    async settings(courseId: string): Promise<GsproExportSettings> {
        const row = await this.db
            .selectFrom('courses').select(['gspro_export_dir', 'gspro_course_dir', 'gspro_meta_json', 'opcd_course_name'])
            .where('id', '=', courseId).executeTakeFirst();
        if (!row) throw new NotFoundError(`Course ${courseId} not found`);
        const defaultDir = defaultExportDir();
        const gkdFile = row.gspro_course_dir ? await gkdFileIn(row.gspro_course_dir) : null;
        const gkd = gkdFile ? await gkdIn(path.join(row.gspro_course_dir!, gkdFile)) : null;
        return {
            dir: row.gspro_export_dir ?? defaultDir,
            courseDir: row.gspro_course_dir,
            gkdFile,
            meta: row.gspro_meta_json ? JSON.parse(row.gspro_meta_json) as GsproCourseMeta : null,
            gkdMeta: gkd ? metaFromGkd(gkd) : null,
            gkdRatings: gkd ? (await this.gkdRatingEdits(courseId, gkd)).map(e => `${e.name} ${e.text}`) : [],
            opcdCourseName: row.opcd_course_name,
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
     * Keep the course details the `.GKD` export writes (null clears them, and
     * the export goes back to keeping whatever the file has).
     */
    async setMeta(courseId: string, meta: GsproCourseMeta | null): Promise<GsproExportSettings> {
        await this.settings(courseId);  // 404s for an unknown course
        await this.db
            .updateTable('courses').set({ gspro_meta_json: meta ? JSON.stringify(cleanMeta(meta)) : null })
            .where('id', '=', courseId).execute();
        return this.settings(courseId);
    }

    /**
     * Set (or clear, with null/empty) what the course is called in OPCD's
     * cloud course builder — the `Course Name` `scripts/opcd-build.ts` looks
     * for in the builder's "Course Workflow" list. Nothing is checked against
     * OPCD here: reaching it needs the operator's logged-in browser profile,
     * and the script itself prints the names the list offers when the one
     * stored matches no row.
     */
    async setOpcdCourseName(courseId: string, name: string | null): Promise<GsproExportSettings> {
        const trimmed = name?.trim() ?? '';
        if (trimmed.length > 200) {
            throw new ConflictError('the OPCD course name is at most 200 characters — copy it from the Course Workflow list');
        }
        await this.settings(courseId);  // 404s for an unknown course
        await this.db
            .updateTable('courses').set({ opcd_course_name: trimmed || null })
            .where('id', '=', courseId).execute();
        return this.settings(courseId);
    }

    /**
     * The tee sets a `.GKD` rates differently from the course: each set
     * that is exported as one of the GKD's eight (`gsproTee`) and whose
     * rating there is a real one other than the set's own GSPro rating.
     */
    private async gkdRatingEdits(courseId: string, gkd: Record<string, unknown>) {
        const edits: { id: string; version: number; name: string; text: string; rating: number; slope: number; women: boolean }[] = [];
        for (const set of await new TeeSetsService(this.db).listByCourse(courseId)) {
            const type = set.gsproTee;
            if (!type) continue;
            const inFile = parseGkdRating(gkd[gkdRatingKey(type)]);
            if (!inFile) continue;
            const women = set.gsproRating === 'women';
            const text = gkdRating(inFile.rating, inFile.slope)!;
            if (text !== gkdRating(women ? set.ratingWomen : set.ratingMen, women ? set.slopeWomen : set.slopeMen)) {
                edits.push({ id: set.id, version: set.version, name: set.name, text, ...inFile, women });
            }
        }
        return edits;
    }

    /**
     * Take the course details from the `.GKD` in the course's GSPro folder —
     * what was typed in GreenKeeper — and keep them with the course; its
     * ratings go onto the course's tee sets, as each set's GSPro rating.
     */
    async readGkdMeta(courseId: string): Promise<GsproExportSettings> {
        const { courseDir, gkdFile, gkdMeta } = await this.settings(courseId);
        if (!courseDir) throw new ConflictError('Set the GSPro course folder first — the course\'s folder under GSPro\'s Courses, where its .gspcrse is');
        if (!gkdMeta) throw new ConflictError(`No readable .GKD in ${courseDir} — save the course in GreenKeeper, or export the GreenKeeper course file, first`);
        const gkd = await gkdIn(path.join(courseDir, gkdFile!));
        if (gkd) await this.applyGkdRatings(courseId, gkd);
        return this.setMeta(courseId, gkdMeta);
    }

    /**
     * Take only the tee sets' ratings from that `.GKD` — each onto the set
     * exported as that GSPro tee, as the rating GSPro shows for it — and
     * leave the course details the app keeps alone.
     */
    async readGkdRatings(courseId: string): Promise<GsproExportSettings> {
        const { courseDir, gkdFile } = await this.settings(courseId);
        if (!courseDir) throw new ConflictError('Set the GSPro course folder first — the course\'s folder under GSPro\'s Courses, where its .gspcrse is');
        const gkd = gkdFile ? await gkdIn(path.join(courseDir, gkdFile)) : null;
        if (!gkd) throw new ConflictError(`No readable .GKD in ${courseDir} — save the course in GreenKeeper, or export the GreenKeeper course file, first`);
        await this.applyGkdRatings(courseId, gkd);
        return this.settings(courseId);
    }

    private async applyGkdRatings(courseId: string, gkd: Record<string, unknown>): Promise<void> {
        const teeSets = new TeeSetsService(this.db);
        for (const edit of await this.gkdRatingEdits(courseId, gkd)) {
            await teeSets.update(edit.id, edit.version, edit.women
                ? { ratingWomen: edit.rating, slopeWomen: edit.slope }
                : { ratingMen: edit.rating, slopeMen: edit.slope });
        }
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
     * The `gspro.py svg` command of the course's SVG export and the file it
     * writes. Also what the shaping service runs with `--paths-only`, to
     * rewrite that SVG's road-surface sidecar (`<stem>-paths.json`) alone.
     */
    async svgCommand(courseId: string, opts: Pick<SvgExportOptions, 'variant' | 'dbPath'> = {}): Promise<{ args: string[]; out: string }> {
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
        // The server's own database (DB_PATH: the e2e server's isolated one), else gspro.py's default.
        const db = opts.dbPath ?? process.env.DB_PATH;
        if (db) args.push('--db', db);
        return { args, out };
    }

    /**
     * Write the course's features to `<dir>/<course-name>.svg` over the
     * inner terrain square, so the SVG lines up with the inner rasters.
     * `excludeFeatureIds` leaves features out and `variant` names the file
     * `<course-name>-<variant>.svg` — test variants for the Blender build,
     * to find the shape it chokes on without touching the course.
     */
    async export(courseId: string, opts: SvgExportOptions = {}): Promise<GsproExportResult> {
        const command = await this.svgCommand(courseId, opts);
        const { out } = command;
        const ids = [...new Set(opts.excludeFeatureIds ?? [])];
        const full = ids.length === 0 && !opts.variant && !opts.dbPath;
        // The course's own export stops on check errors; a test variant is written anyway (it is for finding them).
        const checksOut = out.replace(/\.svg$/i, '.checks.json');
        const args = [...command.args, '--accepted', await this.svgChecksAcceptedFile(courseId), '--checks-out', checksOut,
            ...(full ? [] : ['--allow-errors'])];
        if (ids.length === 0) {
            // The code that runs, read as it starts (an edit during a long export must not count).
            const reading = full ? pipelineCodeVersion(this.pipelineDir) : null;
            const result = await this.runSvg(args, out, checksOut);
            const code = await reading;
            // A full export of the course as it is: keep it, so a later broken build can be bisected against it.
            if (full) {
                const kept = await this.history.snapshot(courseId, path.dirname(out), out, new Date(), { code, report: [...result.report] });
                result.report.push(`kept as ${path.relative(path.dirname(out), kept)}`);
            }
            return result;
        }
        // A file, not arguments: a variant can leave out thousands of canopy trees.
        const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-svg-'));
        try {
            const list = path.join(work, 'exclude-ids.json');
            await writeFile(list, JSON.stringify(ids));
            return await this.runSvg([...args, '--exclude-ids', list], out, checksOut);
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /** `run` for the SVG: check errors (exit 3) become one ConflictError naming them, from the checks file. */
    private async runSvg(args: string[], out: string, checksOut: string): Promise<GsproExportResult> {
        const { code, stdout, stderr } = await this.runner(args, this.pipelineDir);
        if (code === SVG_CHECK_ERRORS_EXIT) {
            const report = await readSvgChecks(checksOut).catch(() => null);
            const errors = report?.findings.filter((f) => f.severity === 'error' && !f.accepted) ?? [];
            const first = errors.slice(0, 3).map((f) => f.message).join('; ');
            throw new ConflictError(`SVG check: ${errors.length || 'some'} error(s), nothing written - open them in Draw › Check shapes`
                + (first ? `. ${first}${errors.length > 3 ? ' …' : ''}` : ''));
        }
        if (code !== 0) throw failure('GSPro SVG export', code, stdout, stderr);
        return { path: out, report: reportLines(stdout) };
    }

    /** docs/gspro/<course>/svg-checks.json: the findings accepted on this course. */
    async svgChecksAcceptedFile(courseId: string): Promise<string> {
        const course = await this.courses.get(courseId);
        return path.join(this.courseDocsRoot, courseSlug(course.name), SVG_CHECKS_ACCEPTED_FILE);
    }

    /**
     * The SVG export's checks of the course as it is now, writing nothing (`gspro.py svg
     * --check-only`): what Draw's Check shapes overlay lists, and its Run again.
     */
    async checkSvg(courseId: string): Promise<SvgCheckReport> {
        const { args } = await this.svgCommand(courseId);
        const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-svg-check-'));
        try {
            const checksOut = path.join(work, 'checks.json');
            const { code, stdout, stderr } = await this.runner(
                [...args, '--check-only', '--accepted', await this.svgChecksAcceptedFile(courseId), '--checks-out', checksOut],
                this.pipelineDir);
            if (code !== 0) throw failure('SVG check', code, stdout, stderr);
            return { ...(await readSvgChecks(checksOut)), courseId };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /**
     * Accept a finding (it no longer stops the export) or take that back, by its key;
     * `note` says why. The course's svg-checks.json is rewritten (2-space JSON).
     */
    async acceptSvgFinding(courseId: string, key: string, accepted: boolean, note?: string): Promise<{ file: string; keys: string[] }> {
        if (!key.trim()) throw new ConflictError('A finding key is needed');
        const file = await this.svgChecksAcceptedFile(courseId);
        const doc = await readAccepted(file);
        const rest = doc.accepted.filter((a) => a.key !== key);
        const next = accepted ? [...rest, { key, ...(note?.trim() ? { note: note.trim() } : {}), at: new Date().toISOString() }] : rest;
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, JSON.stringify({ format: 'golfmap-svg-checks-accepted-v1', accepted: next }, null, 2) + '\n');
        await rm(file, { force: true });
        await link(tmp, file).catch(async () => copyFile(tmp, file));
        await rm(tmp, { force: true });
        return { file, keys: next.map((a) => a.key) };
    }

    /**
     * The orthophoto GeoTIFFs the map build persisted for the course's site,
     * newest collection first, the cleaned photo right after its
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
                || Number(a.cleaned) - Number(b.cleaned));
    }

    /**
     * Render one persisted orthophoto as the square GSPro texture:
     * `<dir>/<course>-<collection>[-cleaned]-8192.jpg`, 8192×8192 px, JPEG
     * quality 80, over the inner terrain square. `source` is a file name
     * from `orthoSources` — anything else is refused, so the request can
     * never name a path outside the site's sources folder.
     */
    async exportOrtho(courseId: string, source: string, darken?: number, tint?: TerrainTintOptions,
                      floor?: ForestFloorOptions, removeBuildings = false,
                      opts: { force?: boolean } = {}): Promise<GsproExportResult> {
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
            courseId, darken, tint, floor, buildings, opts.force);
    }

    /**
     * The outer terrain's texture: `<dir>/<course>-outer-<collection>-8192.jpg`
     * over the 5 km outer square. The site's persisted orthos only cover the
     * inner area, so the vintage is fetched from Lantmäteriet for the outer
     * square the first time and kept as `sources/<siteId>/outer-ortho-
     * <collection>.tif`; later exports render from that copy.
     */
    async exportOuterOrtho(courseId: string, collection: string, darken?: number, tint?: TerrainTintOptions,
                           floor?: ForestFloorOptions, removeBuildings = false,
                           opts: { force?: boolean } = {}): Promise<GsproExportResult> {
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
            tint && { ...tint, darkenTint: true, grade: OUTER_TERRAIN_GRADE }, floor, buildings, opts.force);
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
     *
     * Skipped when nothing it reads has changed since the last one — the DEM
     * source files, the site's enabled terrain edits, the Unity sculpt layers
     * and (for the outer) the inner's sidecar — and the TIF, the RAW and the
     * sidecar are all still there; `force` renders anyway
     * (export-fingerprint.ts). The push into Unity does not go through here,
     * so a skipped render still ends up on the terrain.
     */
    async exportDem(courseId: string, kind: TerrainKind, opts: { force?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} DEM for`);
        const square = terrain[kind];

        const dir = await this.exportDir(courseId);
        const out = path.join(dir, demExportFileName(course.name, kind, square.sideM));
        // Before the source is resolved: an outer export otherwise grids, replays the
        // edits and exports the inner first, which is the work this skip is about.
        const sculptRasters = await this.sculptRasters(siteId);
        const innerSidecarFile = kind === 'outer'
            ? path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)))
            : null;
        const inputs: ExportInputs = {
            files: [
                ...(kind === 'inner' ? ['dem-edited.tif', 'dem.tif'] : [OUTER_DEM_SOURCE])
                    .map(name => path.join(this.sourcesDir(siteId), name)),
                ...sculptRasters,
                innerSidecarFile,
            ],
            values: {
                terrain: kind,
                square: terrainArg(square),
                resolution: DEM_EXPORT_RESOLUTION_M[kind],
                edits: await this.editsStamp(siteId),
                pipeline: await this.pipelineStamp(),
            },
            outputs: [out, out.replace(/\.tif$/i, '.raw'), demSidecarName(out)],
        };
        if (!opts.force) {
            const unchanged = await unchangedLine(await fingerprint(out, inputs));
            if (unchanged) return { path: out, report: [unchanged] };
        }

        const { src, fetched } = await this.demSource(siteId, kind, square);
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'dem',
            '--square-3006', terrainArg(square),
            '--dem', src,
            '--out', out,
            '--resolution', String(DEM_EXPORT_RESOLUTION_M[kind]),
            '--terrain', kind,
        ];
        const before: string[] = [];
        const notes: string[] = [];
        // The Unity sculpt layers this DEM contains: Unity subtracts them from
        // what it keeps, so its next capture is the whole layer.
        for (const raster of sculptRasters) args.push('--sculpt', raster);
        if (innerSidecarFile) {
            // The outer sidecar records the outer terrain's Unity position from
            // the inner's, so the inner has to be exported first: do it rather
            // than leave a note asking for it.
            if (!await statOrNull(innerSidecarFile)) {
                const inner = await this.exportDem(courseId, 'inner', opts);
                before.push(`exported the inner heightmap first, for the outer terrain's Unity position (${path.basename(inner.path)})`, ...inner.report);
            }
            if (await statOrNull(innerSidecarFile)) {
                args.push('--inner-sidecar', innerSidecarFile);
            } else {
                notes.push(`note: the inner heightmap export wrote no sidecar (${path.basename(innerSidecarFile)}), so the outer terrain's Unity position is not recorded`);
            }
        }
        const rendered = await this.run(`GSPro ${kind} DEM`, args, out);
        // Hashed again: an outer export may have written the inner sidecar it reads on its way here.
        await recordInputs(await fingerprint(out, inputs));
        return { path: rendered.path, report: [...before, ...fetched, ...rendered.report, ...notes] };
    }

    /**
     * The terrain's heightmap sidecar in the export folder, exported first
     * when it is not there: the files that read it (trees, buildings, zones,
     * creeks, the GKD) take their height range or the terrain's zero from it,
     * and refusing with "export the heightmap first" only made the operator
     * press one more button. Returns the report lines of an export that had
     * to happen (empty when the sidecar was already there).
     */
    private async ensureDemSidecar(courseId: string, kind: TerrainKind, sidecar: string): Promise<string[]> {
        if (await statOrNull(sidecar)) return [];
        const exported = await this.exportDem(courseId, kind);
        return [`exported the ${kind} heightmap first, for ${path.basename(sidecar)} (${path.basename(exported.path)})`, ...exported.report];
    }

    /**
     * Why the inner heightmap an export would write does not carry the site's
     * current terrain edits, or null when it does — what the sync board's
     * Terrain row shows as "unapplied edits" and what makes its update bake
     * the terrain first. 404 for a course with no built map.
     */
    async innerDemStale(courseId: string): Promise<string | null> {
        const siteId = this.builtSiteId(await this.courses.get(courseId));
        return this.staleInnerDem(siteId, await this.innerDem(siteId));
    }

    /** A terrain's exported heightmap sidecar `minM` (the terrain's zero); null without one. */
    /**
     * The water surfaces of the ponds whose outline is the water's edge (dug
     * with `bankAboveDeg`): each one's dig level, as apply-dem-edits found it
     * (`sources/<site>/dem-edited.water-levels.json`), + WATER_EDGE_SURFACE_M,
     * in the inner heightmap's Unity frame, keyed by the plane OPCD's lake mesh
     * gets (`Spline_<shape name>_WaterPlane`), into
     * `<export folder>/<slug>-inner-water-levels.json`. golfmap.waterplanes.build
     * puts those planes there, not at the lake mesh's lowest rim (which lies on
     * the dug bank under the water); a hand-set level in the course folder still
     * wins. No such pond: the file is removed.
     */
    async exportWaterLevels(courseId: string): Promise<{ file: string | null; report: string[] }> {
        const course = await this.courses.get(courseId);
        const out = path.join(await this.exportDir(courseId), waterLevelsFileName(course.name));
        const src = course.siteId ? path.join(this.sourcesDir(course.siteId), DIG_WATER_LEVELS_SOURCE) : null;
        const doc = src && await Bun.file(src).exists() ? JSON.parse(await readFile(src, 'utf8')) as { levels?: Record<string, number> } : null;
        const levels = Object.entries(doc?.levels ?? {}).filter(([ref]) => ref.startsWith('feature:'));
        const minM = levels.length ? await this.demSidecarMinM(courseId, 'inner') : null;
        if (!levels.length || minM === null) {
            await rm(out, { force: true });
            return { file: null, report: [levels.length ? 'water levels: no inner heightmap sidecar yet, nothing written' : "water levels: no pond has its outline at the water's edge"] };
        }
        const rows = await this.db.selectFrom('course_features')
            .leftJoin('holes', 'holes.id', 'course_features.hole_id')
            .select(['course_features.id as id', 'course_features.feature_no as no', 'holes.number as hole'])
            .where('course_features.course_id', '=', courseId)
            .execute();
        const byId = new Map(rows.map((r) => [r.id, r]));
        const planes: Record<string, { surfaceM: number; levelM: number; featureId: string }> = {};
        for (const [ref, level] of levels) {
            const f = byId.get(ref.slice('feature:'.length));
            if (!f || f.no === null) continue;   // another course's pond on the same site, or a generated feature
            const shape = `${f.hole !== null ? `hole_${f.hole}` : 'others'}_${f.no.toString(16)}`;
            planes[`Spline_${shape}_WaterPlane`] = { surfaceM: Math.round((level + WATER_EDGE_SURFACE_M - minM) * 1000) / 1000, levelM: level, featureId: f.id };
        }
        await writeFile(out, JSON.stringify({
            format: 'golfmap-water-levels-v1',
            source: "golf-map: each pond dug with its outline at the water's edge (bankAboveDeg), its dig level + 0.05 m, Unity Y",
            planes,
        }, null, 1) + '\n');
        return { file: out, report: [`water levels: ${Object.keys(planes).length} pond(s) set at their dig's level (${Object.keys(planes).join(', ')}) -> ${path.basename(out)}`] };
    }

    async demSidecarMinM(courseId: string, kind: TerrainKind): Promise<number | null> {
        const course = await this.courses.get(courseId);
        const terrain = await this.resolveTerrain(courseId, `read the GSPro ${kind} heightmap of`);
        const dir = await this.exportDir(courseId);
        return readSidecarMin(path.join(dir, demSidecarName(demExportFileName(course.name, kind, terrain[kind].sideM))));
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
        report.push(`Stored as the ${kind} Unity sculpt layer (one additive terrain edit, after all others). Next: Apply to terrain in the terrain tool, then Update terrain again.`);
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
    async exportUnityTerrain(courseId: string, kind: TerrainKind,
                             opts: { force?: boolean; save?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} DEM for`);
        const dir = await this.exportDir(courseId);
        const editor = await this.unityTerrainEditor(courseId, kind, dir);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, terrain[kind].sideM)));
        const before = await readSidecarMin(sidecar);
        // A skipped render (inputs unchanged) still goes into Unity: the push reads the files.
        const exported = await this.exportDem(courseId, kind, { force: opts.force });
        const pushed = await this.terrainIntoUnity(editor, kind, sidecar, before, opts.save);
        return { path: exported.path, report: [...exported.report, ...pushed.report] };
    }

    /**
     * The heightmap ALREADY in the export folder into Unity, without
     * rendering the DEM again — the sync board's terrain chain exports both
     * heightmaps in one phase and pushes them in the next, and a 4097² render
     * per terrain is not worth repeating. `minBefore`: the sidecar's `minM`
     * before that export, so the moved-zero warning can still be given.
     */
    async pushUnityTerrain(courseId: string, kind: TerrainKind,
                           opts: { minBefore?: number | null; save?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const terrain = await this.resolveTerrain(courseId, `put the GSPro ${kind} heightmap of`);
        const dir = await this.exportDir(courseId);
        const editor = await this.unityTerrainEditor(courseId, kind, dir);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, terrain[kind].sideM)));
        if (!await statOrNull(sidecar)) throw new ConflictError(`No ${kind} heightmap in ${dir} yet (${path.basename(sidecar)}): export it first`);
        return this.terrainIntoUnity(editor, kind, sidecar, opts.minBefore ?? null, opts.save);
    }

    /** The editor a heightmap push goes to; 409 when the inner is stale or no editor works on the course. */
    private async unityTerrainEditor(courseId: string, kind: TerrainKind, dir: string): Promise<UnityEditor> {
        if (kind === 'inner') {
            // A stale inner heightmap in Unity disagrees with the outer (which replays the edits fresh).
            const stale = await this.innerDemStale(courseId);
            if (stale) throw new ConflictError(`Not put into Unity: ${stale}`);
        }
        // Find the editor first: no point exporting for a Unity that is not open.
        const { editor, seen } = await editorForExportDir(this.unityBridge, dir);
        if (!editor) {
            throw new ConflictError(`No open Unity editor imports from ${dir}: open the course's Unity project (with the GolfMap scripts) and make its course the active one`
                + (seen.length ? ` — open: ${seen.join('; ')}` : ' — none is open'));
        }
        return editor;
    }

    /** `golfmap.terrain.update` in `editor` (with `save`, saving what it changed), and what it reports. */
    private async terrainIntoUnity(editor: UnityEditor, kind: TerrainKind, sidecar: string, before: number | null,
                                   save?: boolean): Promise<GsproExportResult> {
        const after = await readSidecarMin(sidecar);
        let result: any;
        try {
            result = await editor.run('golfmap.terrain.update', {
                terrain: kind, ...(save ? { save: true } : {}),
                // the outer plot keeps its sink when its zero moved (a deeper lake): Unity measures it from the old zero
                ...(kind === 'outer' && before !== null ? { outerMinBefore: before } : {}),
            }, 600);
        } catch (e) {
            throw new ConflictError(`The heightmap was exported, but Unity (${editor.projectName}) could not take it: ${(e as Error).message.split('\n')[0]}`);
        }
        const report: string[] = [];
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
                + 'it will show through the rebuilt meshes there — run Update terrain for the other terrain too, or lower the outer plot');
        }
        const saved = savedLine(result);
        report.push('Next: Terrain › Export To OBJ in Unity for Blender; re-run the terrain conform once the course meshes are rebuilt.'
            + (saved ? '' : ' Save the scene to keep it.'));
        if (saved) report.push(saved);
        return { path: sidecar, report };
    }

    /**
     * The inner orthophoto export, then straight onto the course meshes in
     * Unity: the open editor whose active GolfMap course imports from this
     * course's export folder runs `golfmap.orthos.apply` with the `-meshes`
     * file just written. That overwrites the texture the scene's meshes
     * sample as `_Satellite` in place (the old file backed up), so the
     * export's own name (`-cleaned`, `-clean`) does not have to match the
     * project's. The `-meshes` file is always written, whatever `tint` says:
     * it is the one the meshes use.
     */
    async exportUnityOrtho(courseId: string, source: string, darken?: number, tint?: TerrainTintOptions,
                           floor?: ForestFloorOptions, removeBuildings = false,
                           opts: { force?: boolean; save?: boolean } = {}): Promise<GsproExportResult> {
        const dir = await this.exportDir(courseId);
        // Find the editor first: no point rendering for a Unity that is not open.
        const editor = await this.unityOrthoEditor(dir);
        const exported = await this.exportOrtho(courseId, source, darken, tint ?? {}, floor, removeBuildings, { force: opts.force });
        const pushed = await this.orthoIntoUnity(editor, meshTextureFileName(path.basename(exported.path)), opts.save);
        return { path: exported.path, report: [...exported.report, ...pushed.report] };
    }

    /**
     * A `-meshes` file ALREADY in the export folder onto the course meshes in
     * Unity, without rendering the orthophoto again — the sync board's photo
     * chain writes the file in one phase and pushes it in the next, and an
     * 8192 px render is not worth repeating.
     */
    async pushUnityOrtho(courseId: string, file: string, opts: { save?: boolean } = {}): Promise<GsproExportResult> {
        const dir = await this.exportDir(courseId);
        if (!await statOrNull(path.join(dir, file))) throw new ConflictError(`No ${file} in ${dir} yet: export the orthophoto first`);
        return this.orthoIntoUnity(await this.unityOrthoEditor(dir), file, opts.save);
    }

    private async unityOrthoEditor(dir: string): Promise<UnityEditor> {
        const { editor, seen } = await editorForExportDir(this.unityBridge, dir);
        if (!editor) {
            throw new ConflictError(`No open Unity editor imports from ${dir}: open the course's Unity project (with the GolfMap scripts) and make its course the active one`
                + (seen.length ? ` — open: ${seen.join('; ')}` : ' — none is open'));
        }
        return editor;
    }

    /** `golfmap.orthos.apply file=<file>` in `editor` (with `save`, saving what it changed), and what it reports. */
    private async orthoIntoUnity(editor: UnityEditor, file: string, save?: boolean): Promise<GsproExportResult> {
        let result: any;
        try {
            result = await editor.run('golfmap.orthos.apply', { file, ...(save ? { save: true } : {}) }, 300);
        } catch (e) {
            throw new ConflictError(`The orthophoto was exported, but Unity (${editor.projectName}) could not take it: ${(e as Error).message.split('\n')[0]}`);
        }
        return {
            path: file,
            report: [
                `Unity (${editor.projectName}): ${file} put onto ${result?.target} (${result?.renderers ?? 0} renderers sample it; ${result?.status})`,
                savedLine(result) ?? 'Save the Unity project to keep it.',
            ],
        };
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
     * the folder; the heightmap is exported first when it is not there.
     */
    async exportTrees(courseId: string, kind: TerrainKind, opts: { force?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} trees for`);
        const square = terrain[kind];

        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, square.sideM)));

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
        // The file's height range comes from that terrain's heightmap sidecar.
        const prepared = await this.ensureDemSidecar(courseId, kind, sidecar);

        const out = path.join(dir, treesExportFileName(course.name, kind));
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'trees',
            '--square-3006', terrainArg(square),
            '--stems', stems,
            '--sidecar', sidecar,
            '--out', out,
            '--terrain', kind,
            // The course's tree species areas (shared/features/tree-areas.ts) go into the file with it.
            '--course', courseId,
        ];
        if (kind === 'outer') args.push('--exclude-square', terrainArg(terrain.inner));
        // The course's placed rocks (golfmap.walls.build's spec): the lidar reads a boulder as a low bush.
        const rocks = path.join(this.courseDocsRoot, courseSlug(course.name), 'stone-walls.json');
        if (await statOrNull(rocks)) args.push('--rocks', rocks);
        // The course's trees.lidarSizeFactor (its vegetation-rules.json): an old or leaf-off flight
        // measures the trees smaller than they stand now (Omberg: lidar March 2022 vs shadows June 2025).
        const rulesFile = path.join(this.courseDocsRoot, courseSlug(course.name), VEGETATION_RULES_FILE);
        const sizeFactor = await statOrNull(rulesFile)
            ? (JSON.parse(await readFile(rulesFile, 'utf8')) as { trees?: { lidarSizeFactor?: unknown } }).trees?.lidarSizeFactor
            : undefined;
        if (sizeFactor !== undefined) {
            if (typeof sizeFactor !== 'number' || !(sizeFactor > 0)) throw new ConflictError(`${rulesFile}: trees.lidarSizeFactor must be a number above 0`);
            args.push('--size-factor', String(sizeFactor));
        }
        // The accepted photo stems (PhotoStemsService): young trees the lidar missed, planted with src "photo".
        const photoStems = this.assets.resolvePhotoStemsPath(siteId);
        if (await statOrNull(photoStems)) args.push('--photo-stems', photoStems);
        const rendered = await this.runIfChanged(`GSPro ${kind} trees`, args, out, {
            // The file carries the course's tree species areas, so its feature stamp joins the hash.
            files: [stems, sidecar, rocks, photoStems],
            values: { features: await this.history.latestStamp(courseId), sizeFactor: sizeFactor ?? 1 },
        }, opts.force);
        // A routed course decides who draws each tree before planting: the trees just written are routed again.
        const routed = kind === 'inner' ? await this.arborist.routeIfRouted(await this.arboristCourse(courseId)) : [];
        return { path: rendered.path, report: [...prepared, ...fetched, ...rendered.report, ...routed] };
    }

    /**
     * A terrain's vegetation zones as VSPro texture masks + unity-zones-v2
     * JSON (what the Unity Vegetation Zones window imports):
     * `<dir>/<course>-<inner|outer>-zones.json` and `-zones-<n>.png` next to
     * it, rasterized from the app database by `gspro.py zones`. Like the
     * trees file it reads the height range from that terrain's heightmap
     * sidecar — exported first when the folder has none; the outer leaves
     * the inner square to the inner file.
     */
    async exportZones(courseId: string, kind: TerrainKind, opts: { force?: boolean } = {}): Promise<GsproExportResult> {
        const plan = await this.zonesPlan(courseId, kind);
        const rendered = await this.runIfChanged(`GSPro ${kind} vegetation zones`, plan.args, plan.out, await plan.inputs(), opts.force);
        // Rendered or unchanged, the masks are the zones as they are now: what the next patch diffs
        // against. Masks rendered again are not in Unity until it imports them.
        const unchanged = rendered.report.some(l => l.startsWith('unchanged: '));
        await this.recordZonesIndex(courseId, plan.out, { unity: unchanged ? 'keep' : null });
        return { path: rendered.path, report: [...plan.prepared, ...rendered.report] };
    }

    /** The course's zone mask edge in px (vegetation-rules.json `zoneMaskResolution`), null = gspro.py's default. */
    private async zoneMaskResolution(courseName: string): Promise<number | null> {
        const file = path.join(this.courseDocsRoot, courseSlug(courseName), VEGETATION_RULES_FILE);
        if (!await statOrNull(file)) return null;
        const v = (JSON.parse(await readFile(file, 'utf8')) as { zoneMaskResolution?: unknown }).zoneMaskResolution;
        if (v === undefined) return null;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 256 || v > 8192) {
            throw new ConflictError(`${file}: zoneMaskResolution must be a whole number of px from 256 to 8192`);
        }
        return v;
    }

    /** `gspro.py zones` for a terrain: its command, its output, and what its fingerprint is made of. */
    private async zonesPlan(courseId: string, kind: TerrainKind) {
        const course = await this.courses.get(courseId);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} vegetation zones for`);
        const square = terrain[kind];

        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, square.sideM)));
        // The masks' height range comes from that terrain's heightmap sidecar.
        const prepared = await this.ensureDemSidecar(courseId, kind, sidecar);
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
        // The course's mask edge (vegetation-rules.json zoneMaskResolution): each mask is an uncompressed RGBA
        // texture in the GSPro bundle, 64 MB at 4096, and Unity players load no serialized file over 4 GB.
        const resolution = await this.zoneMaskResolution(course.name);
        if (resolution !== null) args.push('--resolution', String(resolution));
        const inputs = async () => ({
            files: [sidecar],
            // The zones themselves by content (so a generator run that reproduced them counts as
            // unchanged), the zone types' bindings, and the rest of the course's features.
            values: { ...await this.zonesStamp(courseId), features: await this.history.latestStamp(courseId), resolution },
            // The masks are only known once it has run: recorded, so a hand-deleted one is noticed.
            outputsAfter: async () => [out, ...await this.zoneMasks(dir, out)],
        });
        return { dir, out, args, prepared, inputs };
    }

    /**
     * The zones a terrain's masks were rendered from, by content in stack
     * order (`<zones>.json.index.json`), and whether Unity took that export
     * with the grass palette as it was (`unity`): what lets Update
     * vegetation patch only the zones that changed (`patchPlantedZones`).
     * `unity: null` = not known to be in Unity; `'keep'` keeps the recorded one.
     */
    private async recordZonesIndex(courseId: string, zonesJson: string, opts: { unity: { project: string; palette: string } | null | 'keep' }) {
        const index = zonesIndexFile(zonesJson);
        let unity = opts.unity;
        if (unity === 'keep') unity = (await readZonesIndex(zonesJson))?.unity ?? null;
        try {
            await writeFile(index, `${JSON.stringify({
                format: ZONES_INDEX_FORMAT, at: new Date().toISOString(), unity, zones: await this.zoneContents(courseId),
            })}\n`);
        } catch {
            // never fatal: without the index the next Update vegetation takes the full path
        }
    }

    /** The course's vegetation zones in stack order, each with its content digest (what decides its raster: no id, no stack slot). */
    private async zoneContents(courseId: string): Promise<ZoneContent[]> {
        const rows = await this.db.selectFrom('course_features')
            .select(['id', 'layer', 'hole_id', 'geometry_json', 'attributes_json', 'generated'])
            .where('course_id', '=', courseId).where('type', '=', 'vegetation_zone')
            .orderBy('layer').orderBy('hole_id').orderBy('sort_order').orderBy('id').execute();
        return rows.map(r => ({
            id: r.id,
            content: digest([JSON.stringify([r.layer, r.hole_id, r.geometry_json, r.attributes_json, r.generated])]),
        }));
    }

    /** The grass palette Unity's golfmap.grass.apply builds from, by size and mtime ('none' without one). */
    private async paletteStamp(courseName: string): Promise<string> {
        const s = await statOrNull(path.join(this.courseDocsRoot, courseSlug(courseName), 'grass-palette.json'));
        return s ? `${s.size}:${Math.round(s.mtimeMs)}` : 'none';
    }

    /**
     * Update vegetation's fast path for the inner masks: when Unity took the
     * last export with this grass palette, and since then only some zones
     * changed by content (drawn ones edited, a generator's re-run moving a
     * few), `gspro.py zones-patch` re-rasterizes just their window and
     * `golfmap.zones.patch` respawns just that in Unity — seconds, where the
     * full rasterize and import take minutes. Returns why it cannot (the full
     * path follows: anything but the zones changed, the zone types, the
     * palette, the stack order, no index or masks yet), or the report.
     * Zones the patch does not get by id (re-inserted by a generator) it
     * matches by content itself.
     */
    private async patchPlantedZones(courseId: string, kind: TerrainKind, editor: UnityEditor, save: boolean,
                                    time: <T>(label: string, step: () => Promise<T>) => Promise<T>,
    ): Promise<{ full: string } | { report: string[]; unityError: string | null; saved: string | null; untouched?: boolean }> {
        const plan = await this.zonesPlan(courseId, kind);
        const inputs = await plan.inputs();
        const now = await this.exportFingerprint(plan.args, plan.out, inputs);
        const name = path.basename(plan.out);
        if (await unchangedLine(now)) return { full: `no zone changed since ${name}` };
        let doc: { hash?: unknown; files?: unknown; values?: Record<string, unknown>; outputs?: unknown };
        try {
            doc = JSON.parse(await readFile(now.sidecar, 'utf8'));
        } catch {
            return { full: `${name} has no record of what it was made from` };
        }
        // Everything but the zones and the other features must be as the masks were made.
        const same = (key: string) => JSON.stringify(doc.values?.[key] ?? null) === JSON.stringify(now.doc.values[key] ?? null);
        if (JSON.stringify(doc.files) !== JSON.stringify(now.doc.files) || !same('args') || !same('pipeline')) {
            return { full: `the heightmap sidecar, the export's arguments or the pipeline changed since ${name}` };
        }
        if (!same('zoneTypes')) return { full: `the zone types changed since ${name}` };
        const outputs = Array.isArray(doc.outputs) ? doc.outputs.filter((f): f is string => typeof f === 'string') : [];
        for (const f of outputs) if (!await statOrNull(f)) return { full: `${path.basename(f)} is missing` };
        const index = await readZonesIndex(plan.out);
        const course = await this.courses.get(courseId);
        if (!index) return { full: `${name} has no zone index yet (it comes with the next full export)` };
        if (!index.unity) return { full: `Unity has not taken ${name} yet` };
        if (index.unity.project !== editor.projectName || index.unity.palette !== await this.paletteStamp(course.name)) {
            return { full: `the grass palette or the Unity project changed since ${name} went into Unity` };
        }
        const zones = await this.zoneContents(courseId);
        const diff = diffZoneContents(index.zones, zones);
        if (!diff.sameOrder) return { full: `the zones' stack order changed since ${name}` };
        // A patch window the size of the square is no faster than the full rasterize (and the ids go on one command line).
        if (diff.changed.length > ZONES_PATCH_MAX) return { full: `${diff.changed.length} zones changed, more than a patch takes (${ZONES_PATCH_MAX})` };

        const record = plan.out.replace(/\.json$/, '-patch.json');
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'zones-patch',
            '--course', courseId,
            '--zones-json', plan.out,
            '--ids', diff.changed.join(','),
            '--result', record,
        ];
        const exclude = plan.args.indexOf('--exclude-square');
        if (exclude >= 0) args.push('--exclude-square', plan.args[exclude + 1]!);
        const { code, stdout, stderr } = await time('zones patch', () => this.runner(args, this.pipelineDir));
        if (code === ZONES_LAYOUT_CHANGED_EXIT) return { full: `${firstLine(stderr.replace(/^error: /, ''))}` };
        if (code !== 0) throw failure(`Patching the ${kind} zones`, code, stdout, stderr);
        const report = [`${kind}: ${diff.edited} zone(s) edited, ${diff.changed.length - diff.edited} new, ${diff.removed} removed `
            + `since ${name} - patched instead of rasterizing every mask`,
            ...reportLines(stdout).map(line => `${kind}: ${line}`)];
        // The masks are now what a full export of the zones as they are would be.
        const after = await this.exportFingerprint(plan.args, plan.out, inputs);
        after.doc.outputs = await inputs.outputsAfter();
        await recordInputs(after);
        const patched = JSON.parse(await readFile(record, 'utf8')) as { changed?: boolean };
        if (!patched.changed) {
            await this.recordZonesIndex(courseId, plan.out, { unity: 'keep' });
            report.push(`Unity (${editor.projectName}): nothing changed in the masks, nothing to take in`);
            return { report, unityError: null, saved: null, untouched: true };
        }
        try {
            const result = await time('Unity patch', () => editor.run('golfmap.zones.patch',
                { terrain: kind, patch: record, package: LOWER_VEGETATION_PACKAGE, ...(save ? { save: true } : {}) }, 300));
            report.push(`Unity (${editor.projectName}): ${firstLine(String(result?.status ?? `${kind} zones patched`))}`);
            await this.recordZonesIndex(courseId, plan.out, { unity: 'keep' });
            return { report, unityError: null, saved: savedLine(result) };
        } catch (e) {
            // The masks are patched, Unity is not: the next Update vegetation imports them whole.
            await this.recordZonesIndex(courseId, plan.out, { unity: null });
            return { report, saved: null, unityError: `The ${kind} masks are patched in ${plan.dir}, but Unity (${editor.projectName}) could not take them: `
                + `${firstLine((e as Error).message)}. Update vegetation again to import them whole` };
        }
    }

    /**
     * Plant the course's vegetation for GSPro, start to finish (the web's
     * "Update vegetation"): run the vegetation generators
     * (vegetation-generators.ts: tall rough, creek banks, ...) so their zones
     * follow the course as it is now, export the terrain's zones, and then
     * the two halves GSPro draws from:
     *
     *   - Unity (the course's own VSP): when the course's Unity project is
     *     open, import the zones and apply the grass palettes
     *     (`golfmap.zones.import`, `golfmap.grass.apply`). Unity not open is
     *     reported, not an error: the zones are exported for the next import.
     *   - The Arborist file (ArboristService; inner terrain, a course with a
     *     species file): the lower vegetation from the zones export, which
     *     needs no Unity, then the trees out of the Unity scene when it is
     *     open. `arborist: 'lower'` leaves the trees, `false` the whole half.
     *
     * The report says which ran. A half that fails fails the job, after the
     * other has run, with both outcomes in the message. The scene is left for
     * the operator to save unless `save` is passed, and then the report says
     * what was saved instead. `dryRun` only writes the generators' GeoJSON (the
     * CLI's --dry-run).
     *
     * A generator runs only when something it reads changed since its last
     * run (`generatorFingerprint`). When Unity has the last export and only
     * some zones changed by content, those are patched into the masks and
     * Unity (`patchPlantedZones`, seconds); otherwise the masks are
     * rasterized again when the zones, the zone types or the heightmap
     * sidecar moved, and imported whole. `force` runs and renders everything.
     * The report ends with the time each step took (docs D-VZ18).
     *
     * The OUTER terrain plants nothing (OUTER_VEGETATION_IS_ARBORIST): no
     * Unity import (the course's VSP has no lower-vegetation package there),
     * no Arborist half, and no generators — they are course-wide and plan from
     * the INNER surface map; run for the outer, which has none, the tall rough
     * replaced the inner's zones with the drawn features' few (Vreta,
     * 2026-10-14: 1616 -> 30). Only its zones file is written.
     */
    async plantVegetation(courseId: string, kind: TerrainKind,
                          opts: Omit<VegetationOptions, 'workDir'> & {
                              dbPath?: string; exportZones?: boolean; unity?: boolean;
                              arborist?: 'lower' | false; save?: boolean; force?: boolean;
                          } = {}): Promise<GsproExportResult> {
        const dir = await this.exportDir(courseId);
        if (kind === 'outer') {
            if (opts.dryRun || opts.exportZones === false) return { path: dir, report: [OUTER_VEGETATION_IS_ARBORIST] };
            const exported = await this.exportZones(courseId, 'outer', { force: opts.force });
            return { path: exported.path, report: [OUTER_VEGETATION_IS_ARBORIST, ...exported.report] };
        }
        // Where the time went, for the last line of the report.
        const started = Date.now();
        const steps: string[] = [];
        const time = async <T>(label: string, step: () => Promise<T>): Promise<T> => {
            const t0 = Date.now();
            try {
                return await step();
            } finally {
                steps.push(`${label} ${seconds(Date.now() - t0)}`);
            }
        };
        const timeLine = () => `Time: ${steps.join(', ')} - ${seconds(Date.now() - started)} in all`;

        const generated = await this.runGenerators(courseId, kind, opts);
        for (const run of generated.runs) {
            const label = VEGETATION_GENERATORS.find(g => g.source === run.source)?.label ?? run.source;
            steps.push(run.unchanged ? `${label} unchanged` : `${label} ${seconds(run.ms)}`);
        }
        const report = [...generated.report];
        if (opts.dryRun || opts.exportZones === false) return { path: dir, report };

        // Half one, Unity: the course's own VSP (grass, and what the palette keeps there).
        let editor: UnityEditor | null = null;
        let unityError: string | null = null;
        /** What `save` saved in Unity, when it was asked for: the line that replaces "Save the scene …". */
        let saved: string | null = null;
        /** Unity took nothing in (a patch that changed no mask): nothing to save there. */
        let untouched = false;
        const found = opts.unity !== false ? await editorForExportDir(this.unityBridge, dir) : null;
        // Only some zones changed and Unity has the rest: patch those (seconds) instead of the whole
        // rasterize and import (minutes). Anything else - or a patch that cannot - takes the full path.
        const patched = found?.editor && !opts.force
            ? await this.patchPlantedZones(courseId, kind, found.editor, opts.save === true, time)
            : { full: '' };
        const zonesJson = path.join(dir, zonesExportFileName((await this.courses.get(courseId)).name, kind));
        if (!('full' in patched)) {
            editor = found!.editor;
            report.push(...patched.report);
            unityError = patched.unityError;
            saved = patched.saved;
            untouched = patched.untouched === true;
        } else {
            if (patched.full) report.push(`${kind}: no patch - ${patched.full}`);
            const exported = await time('zones export', () => this.exportZones(courseId, kind, { force: opts.force }));
            report.push(...exported.report);
        }
        if ('full' in patched && found) {
            editor = found.editor;
            if (!editor) {
                report.push(`Unity: not open, zones exported only - no open Unity editor imports from ${dir}`
                    + (found.seen.length ? ` (open: ${found.seen.join('; ')})` : ' (none is open)')
                    + " - open the course's Unity project and plant again, or run golfmap.zones.import and golfmap.grass.apply there");
            } else {
                try {
                    // Import binds each item's mask and include rules; apply makes and styles the items and
                    // turns spawning on for those with rules. An item apply only now added (a new species in a
                    // palette) had no rules at the import: a second round binds it and lets it spawn.
                    const saving = opts.save ? { save: true } : {};
                    const t0 = Date.now();
                    for (let round = 1; round <= 2; round++) {
                        const imported = await editor.run('golfmap.zones.import', { terrain: kind, package: LOWER_VEGETATION_PACKAGE, ...saving }, 600);
                        report.push(`Unity (${editor.projectName}): imported ${path.basename(zonesJson)} into '${LOWER_VEGETATION_PACKAGE}'`
                            + (imported?.status ? ` - ${firstLine(String(imported.status))}` : ''));
                        const applied = await editor.run('golfmap.grass.apply', { terrain: kind, ...saving }, 600);
                        const items = Array.isArray(applied?.items) ? applied.items.length : 0;
                        report.push(`Unity (${editor.projectName}): grass palettes applied (${items} items on ${applied?.system ?? "the terrain's system"})`);
                        const log = (applied?.log ?? []) as string[];
                        for (const line of log) report.push(`  ${line}`);
                        saved = savedLine(applied) ?? saved;
                        if (!log.some(l => /^(added|replaced) item /.test(l))) break;
                    }
                    steps.push(`Unity import + apply ${seconds(Date.now() - t0)}`);
                    // Unity has this export with this palette: the next zone edit can be patched in.
                    await this.recordZonesIndex(courseId, zonesJson, {
                        unity: { project: editor.projectName, palette: await this.paletteStamp((await this.courses.get(courseId)).name) },
                    });
                } catch (e) {
                    unityError = `The zones were generated and exported, but Unity (${editor.projectName}) could not take them: ${firstLine((e as Error).message)}`;
                }
            }
        }

        // Half two, GSPro's Arborist file: the lower vegetation needs only the zones export, so it is
        // written whatever Unity did; the trees come out of the Unity scene. The masks are the inner terrain's.
        const arborist = kind === 'inner' && opts.arborist !== false
            ? await time('Arborist', async () => this.arborist.generate(await this.arboristCourse(courseId),
                { trees: opts.arborist !== 'lower', editor: unityError ? null : editor }))
            : null;
        if (arborist) report.push(...arborist.report);
        if (unityError) throw new ConflictError(unityError + arboristAfterFailure(arborist));
        if (arborist?.error) {
            throw new ConflictError((editor ? `Planted in Unity (${editor.projectName})` : 'The zones are exported')
                + (arborist.written.length ? ` and the Arborist ${arborist.written.join(' and ')} written` : '')
                + `, but: ${arborist.error}`);
        }
        if (editor && !untouched) report.push(saved ?? 'Save the scene in Unity to keep it.');
        report.push(timeLine());
        return { path: zonesJson, report };
    }

    /**
     * The course's Arborist file on its own (`arborist.py lower`, then
     * `trees` when the course's Unity project is open): what Update vegetation
     * does after the planting, for when only the species file or the looks
     * changed. 409 when the course has no species file or a step fails.
     */
    async exportArborist(courseId: string): Promise<GsproExportResult> {
        const course = await this.arboristCourse(courseId);
        const { editor } = await editorForExportDir(this.unityBridge, course.exportDir);
        const result = await this.arborist.generate(course, { trees: true, editor });
        if (!result.used) throw new ConflictError(result.report[0]!);
        if (result.error) {
            throw new ConflictError((result.written.length ? `The Arborist ${result.written.join(' and ')} was written, but: ` : '') + result.error);
        }
        return { path: path.join(this.arboristOutDir ?? course.courseDir!, 'arboristdata.dat'), report: result.report };
    }

    private async arboristCourse(courseId: string) {
        const course = await this.courses.get(courseId);
        const { dir, courseDir } = await this.settings(courseId);
        return { name: course.name, exportDir: dir, courseDir };
    }

    /**
     * The vegetation generators over the course as it is now (all, or `opts.from` on), with the
     * inputs they find. A generator whose inputs are unchanged since its last run is skipped
     * (`generatorFingerprint`) unless `force`.
     */
    private async runGenerators(courseId: string, kind: TerrainKind,
                                opts: Omit<VegetationOptions, 'workDir'> & { dbPath?: string }): Promise<{ report: string[]; runs: VegetationRun[] }> {
        const course = await this.courses.get(courseId);
        const dir = await this.exportDir(courseId);
        const sources = course.siteId ? this.sourcesDir(course.siteId) : null;
        const found = async (file: string | null) => file && await statOrNull(file) ? file : null;
        const surfaces = await found(path.join(dir, surfacesExportFileName(course.name, kind)));
        const inputs: VegetationInputs = {
            surfaces,
            buildings: await found(sources && path.join(sources, BUILDINGS_SURVEY)),
            roads: await found(sources && path.join(sources, ROAD_CENTERLINES)),
            demSidecar: surfaces ? await this.demBesideSurfaces(surfaces) : null,
        };
        // The course's own generator rules (e.g. Vreta's thinner tall rough from 10 m), if it has any.
        const rulesFile = path.join(this.courseDocsRoot, courseSlug(course.name), VEGETATION_RULES_FILE);
        const courseRules = await statOrNull(rulesFile)
            ? {
                file: rulesFile,
                args: vegetationRulesArgs(JSON.parse(await readFile(rulesFile, 'utf8')), rulesFile, undefined, await readRuleDefaults(this.pipelineDir)),
            }
            : null;
        const work = await mkdtemp(path.join(os.tmpdir(), 'vegetation-'));
        try {
            return await generateVegetation({
                features: new CourseFeaturesService(this.db), zoneTypes: new ZoneTypesService(this.db),
                pipelineDir: this.pipelineDir, dbPath: opts.dbPath,
                run: (what, args, out) => this.run(what, args, out),
                fingerprint: (g, args, ins) => this.generatorFingerprint(courseId, path.join(dir,
                    surfacesExportFileName(course.name, kind).replace(/-surfaces\.json$/, `-vegetation-${g.source}`)), g, args, ins),
            }, courseId, inputs, { ...opts, courseRules, workDir: work });
        } finally {
            if (!opts.dryRun) await rm(work, { recursive: true, force: true });
        }
    }

    /** The DEM sidecar the generator scripts take next to a surface map: `<prefix>-dem-*.tif.json`, the first by name. */
    private async demBesideSurfaces(surfaces: string): Promise<string | null> {
        const prefix = `${path.basename(surfaces).replace(/-surfaces\.json$/i, '')}-dem-`;
        try {
            const name = (await readdir(path.dirname(surfaces))).filter(n => n.startsWith(prefix) && n.endsWith('.tif.json')).sort()[0];
            return name ? path.join(path.dirname(surfaces), name) : null;
        } catch {
            return null;
        }
    }

    /**
     * What one generator run is made from (export-fingerprint.ts), kept in
     * `<stem>.inputs.json` next to the export (`<course>-inner-vegetation-<source>`):
     * its command (minus the throwaway --out), the files it reads, what it reads
     * from the database by CONTENT (GeneratorReads: the feature types, the drawn
     * creek sections, the zone types; ids and stack positions left out, since a
     * generator run renumbers the stack), its scripts' mtimes, and its own zones
     * as they are now, so zones deleted or edited since its run run it again.
     * A drawn zone of a type it does not read changes none of this.
     */
    private async generatorFingerprint(courseId: string, stem: string, g: VegetationGenerator,
                                       args: string[], inputs: VegetationInputs): Promise<GeneratorFingerprint> {
        const reads = g.reads(inputs);
        const command = args.map((a, i) => args[i - 1] === '--out' ? '<out>' : a);
        const db = this.db;
        const contentOf = async () => {
            const features = reads.features === 'all'
                ? await this.history.latestStamp(courseId)
                : reads.features.length === 0 ? 'none' : digest((await db.selectFrom('course_features')
                    .select(['type', 'hole_id', 'layer', 'geometry_json', 'attributes_json', 'generated'])
                    .where('course_id', '=', courseId).where('type', 'in', [...reads.features]).execute()).map(r => JSON.stringify(r)));
            const zoneTypeOf = (json: string | null) => {
                try { return (JSON.parse(json ?? '{}') as { zoneType?: unknown }).zoneType; } catch { return undefined; }
            };
            // The drawn zones in stack order (their order decides which section wins), by content.
            const drawn = reads.drawnZones.length === 0 ? [] : (await db.selectFrom('course_features')
                .select(['hole_id', 'layer', 'geometry_json', 'attributes_json'])
                .where('course_id', '=', courseId).where('type', '=', 'vegetation_zone').where('generated', '=', 0)
                .orderBy('sort_order').orderBy('id').execute())
                .filter(r => reads.drawnZones.includes(String(zoneTypeOf(r.attributes_json))));
            const zoneTypes = reads.zoneTypes.length === 0 ? [] : await db.selectFrom('course_zone_types')
                .select(['key', 'items_json', 'variants_json'])
                .where('course_id', '=', courseId).where('key', 'in', [...reads.zoneTypes]).orderBy('key').execute();
            const own = await db.selectFrom('course_features').select(['geometry_json', 'attributes_json'])
                .where('course_id', '=', courseId).where('source', '=', g.source).where('generated', '=', 1).execute();
            const scripts: Record<string, number | null> = {};
            for (const s of reads.scripts) scripts[s] = await mtimeMs(path.join(this.pipelineDir, s));
            return fingerprint(stem, {
                files: [inputs.surfaces, inputs.buildings, inputs.roads, ...reads.files],
                values: {
                    command, scripts, features,
                    drawnZones: digest([JSON.stringify(drawn)]),
                    zoneTypes: digest([JSON.stringify(zoneTypes)]),
                    zones: `${own.length}:${digest(own.map(r => JSON.stringify(r)))}`,
                },
                outputs: [],
            });
        };
        const before = await contentOf();
        const line = await unchangedLine(before);
        const zones = line ? (await db.selectFrom('course_features').select(({ fn }) => fn.countAll<number>().as('n'))
            .where('course_id', '=', courseId).where('source', '=', g.source).where('generated', '=', 1).executeTakeFirst())?.n ?? 0 : 0;
        return {
            unchanged: line && `not run - nothing it reads changed since its last run (${/since (.*)\)$/.exec(line)?.[1] ?? 'then'}); its ${Number(zones)} zones stay`,
            record: async () => recordInputs(await contentOf()),
        };
    }

    /**
     * Update some zones without planting everything (the Vegetation mode's
     * "Update N zones" on the selected zones): for each terrain that
     * has a zones export, `gspro.py zones-patch` re-rasterizes only the window
     * those zones cover, now and in that export (and any zone the export has
     * that the course no longer has), into the exported masks, and the open
     * Unity project takes just the changed textures and respawns just that
     * window (`golfmap.zones.patch`); when the inner masks changed, the
     * Arborist file's lower vegetation is written again from them (about 10 s;
     * the trees are left). Patched outer masks stay in the export: the outer
     * terrain's vegetation is Arborist's (OUTER_VEGETATION_IS_ARBORIST). The generators do not run. It needs Unity open up
     * front, since masks patched without Unity would leave the scene behind
     * the export with nothing to say so. With no zones export to patch at all
     * it runs the whole planting instead (`plantInsteadOfPatch`) rather than
     * ask for it. When the zone types' item bindings changed since a
     * terrain's export (and the zones reach that terrain), its channels may
     * have moved and only a full export can follow: that terrain is skipped
     * with a line in the report (the outer, which Update vegetation does not
     * refresh, often is). The pipeline refuses before writing anything, so a
     * skipped terrain is left as it was.
     *
     * When there is nothing to patch at all — no zones export, or every
     * terrain's channels may have moved — the only way on is the WHOLE
     * planting: every generator again, the masks, Unity and the Arborist file,
     * minutes of work. That is not done behind the operator's back: the result
     * comes back `needsPlanting` with the `reason`, having written nothing, so
     * the panel can offer Update vegetation. `plantIfNeeded` runs it here
     * instead (what the board's own vegetation chain passes).
     *
     * A hand-drawn creek_bank zone near water is a creek section: it picks the
     * palette the creek-bank generator plants on those banks, and plants
     * nothing itself. With one in the selection that generator runs first
     * (only it: it is the last in the stack), and the patch finds the zones
     * it changed by content (the rest come back under new ids, unchanged).
     */
    async updateZones(courseId: string, zoneIds: string[], opts: { plantIfNeeded?: boolean } = {}): Promise<GsproExportResult> {
        if (zoneIds.length === 0) throw new ConflictError('Select the vegetation zones to update');
        const course = await this.courses.get(courseId);
        const dir = await this.exportDir(courseId);
        const kinds: TerrainKind[] = [];
        for (const kind of ['inner', 'outer'] as const) {
            if (await statOrNull(path.join(dir, zonesExportFileName(course.name, kind)))) kinds.push(kind);
        }
        if (kinds.length === 0) {
            // Nothing to patch into: only the full planting makes the masks.
            return this.plantOrAsk(courseId, kinds, `There is no vegetation zones export in ${dir} yet to patch`, opts);
        }
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
            // Every terrain's channels may have moved, and only a full export can follow one.
            return this.plantOrAsk(courseId, kinds,
                `The zone types' item bindings changed since the last planting, so the ${stale.join(' and ')} masks' channels may have moved`,
                opts, report);
        }
        if (patches.length === 0) {
            report.push('Nothing changed in the masks, so nothing to take into Unity or the Arborist file');
            return { path: dir, report };
        }
        // The outer terrain's vegetation is Arborist's: its patched masks stay in the export.
        if (patches.some(p => p.kind === 'outer')) report.push('outer: the masks are patched in the export only - ' + OUTER_VEGETATION_IS_ARBORIST);
        const intoUnity = patches.filter(p => p.kind === 'inner');
        if (intoUnity.length === 0) {
            report.push('Nothing changed in the inner masks, so nothing to take into Unity or the Arborist file');
            return { path: dir, report };
        }
        for (const p of intoUnity) {
            try {
                const result = await editor.run('golfmap.zones.patch', { terrain: p.kind, patch: p.record, package: LOWER_VEGETATION_PACKAGE }, 300);
                report.push(`Unity (${editor.projectName}): ${firstLine(String(result?.status ?? `${p.kind} zones patched`))}`);
            } catch (e) {
                throw new ConflictError(`The ${p.kind} masks are updated in ${dir}, but Unity (${editor.projectName}) could not take them: `
                    + `${firstLine((e as Error).message)}. Update vegetation to bring Unity in step`);
            }
        }
        // The Arborist file carries the inner masks themselves: the same zones, its lower vegetation again.
        const arborist = await this.arborist.generate({ name: course.name, exportDir: dir, courseDir: (await this.settings(courseId)).courseDir }, { trees: false });
        report.push(...arborist.report);
        if (arborist.error) throw new ConflictError(`The zones are updated in Unity (${editor.projectName}), but: ${arborist.error}`);
        report.push('Save the scene in Unity to keep it.');
        return { path: dir, report };
    }

    /**
     * A patch that cannot be patched: either the whole planting runs
     * (`plantIfNeeded`) or the result says it is needed and WHY, having
     * written nothing — the panel then offers Update vegetation, which is the
     * same work with somebody behind it.
     */
    private async plantOrAsk(
        courseId: string, kinds: TerrainKind[], why: string,
        opts: { plantIfNeeded?: boolean }, sofar: string[] = [],
    ): Promise<GsproExportResult> {
        if (opts.plantIfNeeded !== true) {
            const reason = `${why}, so only the whole planting can follow: nothing was updated. `
                + 'Run Update vegetation — it plants every generator again and rewrites the Arborist file (minutes).';
            return { path: await this.exportDir(courseId), report: [...sofar, reason], needsPlanting: true, reason };
        }
        return this.plantInsteadOfPatch(courseId, kinds, `${why}: the whole planting ran instead of a patch`, sofar);
    }

    /**
     * What a zones patch falls back to when it cannot patch and the caller
     * asked for it: the whole planting (`plantVegetation`) for the inner
     * terrain — the generators, the masks, the Unity import and the Arborist
     * file — and the outer's zones file when it already has one. `why`
     * leads the report, so the panel says why the fast path was not taken.
     */
    private async plantInsteadOfPatch(courseId: string, kinds: TerrainKind[], why: string, sofar: string[] = []): Promise<GsproExportResult> {
        const report = [...sofar, why];
        // `force`: the masks are here because they are out of step with the zone types' bindings
        // (or not there at all), which is a reason to rasterize them however the fingerprint reads.
        let last = await this.plantVegetation(courseId, 'inner', { force: true });
        report.push(...last.report);
        if (kinds.includes('outer')) {
            last = await this.plantVegetation(courseId, 'outer', { force: true });
            report.push(...last.report);
        }
        return { path: last.path, report };
    }

    /**
     * The course's creeks as NatureManufacture R.A.M. splines for the inner
     * terrain (`<dir>/<course>-inner-creeks.json`, unity-creeks-v1, what
     * GolfMap › Creeks imports): each `water_creek` feature's line (drawn, or
     * the line down its polygon) with control points at the water surface,
     * falling downstream, written by `gspro.py creeks`. The surface comes
     * from the RAW lidar DEM: the edited one has the beds dug (`creek-digs`),
     * and the water belongs above them. Reads the inner heightmap sidecar for
     * the terrain's zero, exporting the inner heightmap first when there is none.
     */
    async exportCreeks(courseId: string, opts: { force?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new ConflictError('This course has no built map on this machine — build its map first');
        const terrain = await this.resolveTerrain(courseId, 'export the GSPro creeks for');
        const dir = await this.exportDir(courseId);
        const dem = path.join(this.sourcesDir(course.siteId), 'dem.tif');
        if (!await statOrNull(dem)) throw new ConflictError(`No raw DEM for this course's site (${dem}) — build its map first`);
        // The creek heights are measured from the terrain's zero in the inner heightmap sidecar.
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
        const prepared = await this.ensureDemSidecar(courseId, 'inner', sidecar);
        const out = path.join(dir, creeksExportFileName(course.name));
        const rendered = await this.runIfChanged('GSPro creeks', [
            path.join(this.pipelineDir, 'gspro.py'), 'creeks',
            '--square-3006', terrainArg(terrain.inner),
            '--course', courseId,
            '--dem', dem,
            '--sidecar', sidecar,
            '--out', out,
        ], out, {
            files: [dem, sidecar],
            values: { features: await this.history.latestStamp(courseId) },
        }, opts.force);
        return { path: rendered.path, report: [...prepared, ...rendered.report] };
    }

    /**
     * The course's R.A.M. roads for the inner terrain
     * (`<dir>/<course>-inner-ramroads.json`, unity-ramroads-v1, what
     * `golfmap.ramroads.build` builds the splines from): each `path` with
     * render=ram (shared/features/path-render.ts) as its centerline in the
     * creeks' plot frame, its width, surface and the colour the photo has
     * under it, written by `gspro.py ramroads`. The splines lie on the OPCD
     * ground meshes, so no heightmap is read. `--ortho` is the site's newest
     * raw orthophoto (not the cleaned one: that has the roads painted out);
     * without one the file has no photo colours.
     */
    async exportRamRoads(courseId: string, opts: { force?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new ConflictError('This course has no built map on this machine — build its map first');
        const terrain = await this.resolveTerrain(courseId, 'export the GSPro R.A.M. roads for');
        const dir = await this.exportDir(courseId);
        const raw = (await this.orthoSources(courseId)).find(s => !s.cleaned);
        const ortho = raw ? path.join(this.sourcesDir(course.siteId), raw.source) : null;
        const out = path.join(dir, ramRoadsExportFileName(course.name));
        return this.runIfChanged('GSPro R.A.M. roads', [
            path.join(this.pipelineDir, 'gspro.py'), 'ramroads',
            '--square-3006', terrainArg(terrain.inner),
            '--course', courseId,
            '--out', out,
            '--reach-m', String(RAM_ROADS_REACH_M),
            ...(ortho ? ['--ortho', ortho] : []),
        ], out, {
            files: [ortho],
            values: { features: await this.history.latestStamp(courseId) },
        }, opts.force);
    }

    /**
     * Which paths could be drawn as R.A.M. splines instead of OPCD meshes,
     * by the pipeline's rules (`gspro.py ramroads-propose`: far enough from
     * play, a surface R.A.M. draws, a centerline): the candidates, the ones
     * already render=ram and the rejected ones with why. Writes nothing;
     * `setRoadRender` takes the ones a person accepts.
     */
    async proposeRamRoads(courseId: string, opts: { minDistanceM?: number } = {}): Promise<RamRoadsProposal> {
        await this.courses.get(courseId);
        if (opts.minDistanceM !== undefined && !(Number.isFinite(opts.minDistanceM) && opts.minDistanceM >= 0)) {
            throw new ConflictError('minDistanceM must be a number of metres, 0 or more');
        }
        const work = await mkdtemp(path.join(os.tmpdir(), 'ramroads-propose-'));
        try {
            const out = path.join(work, 'proposal.json');
            const args = [
                path.join(this.pipelineDir, 'gspro.py'), 'ramroads-propose',
                '--course', courseId,
                '--out', out,
            ];
            if (opts.minDistanceM !== undefined) args.push('--min-distance-m', String(opts.minDistanceM));
            const { code, stdout, stderr } = await this.runner(args, this.pipelineDir);
            if (code !== 0) throw failure('Proposing R.A.M. roads', code, stdout, stderr);
            return JSON.parse(await readFile(out, 'utf8')) as RamRoadsProposal;
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    }

    /**
     * Sets the `render` attribute of these `path` features of the course:
     * `ram` (a R.A.M. spline in Unity, left out of the SVG) or `opcd` (the
     * key cleared: an OPCD mesh again). Every id must be a hand-drawn or
     * imported path of the course that can take it (pathRenderError) — one
     * that cannot fails the whole call and nothing is written. `dryRun`
     * says what would change. The SVG and the R.A.M. roads file pick the
     * change up on their next update (the board's Shapes and R.A.M. roads rows).
     */
    async setRoadRender(courseId: string, featureIds: readonly string[], render: PathRender, opts: { dryRun?: boolean } = {}): Promise<RoadRenderResult> {
        if (!isPathRender(render)) throw new ConflictError(`render must be one of ${PATH_RENDERS.join(', ')}`);
        await this.courses.get(courseId);
        const ids = [...new Set(featureIds)];
        if (ids.length === 0) throw new ConflictError('Name the roads to change');
        const features = new CourseFeaturesService(this.db);
        const byId = new Map((await features.listByCourse(courseId)).map(f => [f.id, f]));
        const missing = ids.filter(id => !byId.has(id));
        if (missing.length) throw new NotFoundError(`Not features of this course: ${missing.join(', ')}`);
        const changed: CourseFeature[] = [];
        const unchanged: string[] = [];
        for (const id of ids) {
            const f = byId.get(id)!;
            const name = f.no !== null ? `path_${f.no}` : id;
            if (f.type !== 'path') throw new ConflictError(`${name} is a ${f.type}, not a path`);
            if (f.generated) throw new ConflictError(`${name} is generated: the next pipeline run replaces it, and its render with it`);
            const problem = pathRenderError(render, f.type, f.geometry.centerline, f.attributes?.surface);
            if (problem) throw new ConflictError(`${name}: ${problem}`);
            const stored = f.attributes?.[PATH_RENDER_ATTRIBUTE];
            if (render === 'ram' ? stored === 'ram' : stored === undefined) unchanged.push(id);
            else changed.push(f);
        }
        if (!opts.dryRun && changed.length) {
            await features.updateMany(changed.map((f) => {
                const attributes: FeatureAttributes = { ...f.attributes };
                if (render === 'ram') attributes[PATH_RENDER_ATTRIBUTE] = 'ram';
                else delete attributes[PATH_RENDER_ATTRIBUTE];
                return { id: f.id, version: f.version, attributes: Object.keys(attributes).length ? attributes : null };
            }));
        }
        return { render, changed: changed.map(f => f.id), unchanged, dryRun: opts.dryRun === true };
    }

    /**
     * The course's waterfalls for the inner terrain
     * (`<dir>/<course>-inner-waterfalls.json`, unity-waterfalls-v1, what
     * `golfmap.waterfalls.build` builds the falling water from): each
     * `waterfall` feature's lip in the creeks' frame, the water above and
     * below and the way it falls, written by `gspro.py waterfalls`. Levels
     * and the bearing a fall does not set are read beside its lip on the RAW
     * lidar DEM (the edited one has the ponds dug). Reads the inner heightmap
     * sidecar for the terrain's zero, exporting the inner heightmap first when
     * there is none.
     */
    async exportWaterfalls(courseId: string, opts: { force?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        if (!course.siteId) throw new ConflictError('This course has no built map on this machine — build its map first');
        const terrain = await this.resolveTerrain(courseId, 'export the GSPro waterfalls for');
        const dir = await this.exportDir(courseId);
        const dem = path.join(this.sourcesDir(course.siteId), 'dem.tif');
        if (!await statOrNull(dem)) throw new ConflictError(`No raw DEM for this course's site (${dem}) — build its map first`);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
        const prepared = await this.ensureDemSidecar(courseId, 'inner', sidecar);
        const out = path.join(dir, waterfallsExportFileName(course.name));
        const rendered = await this.runIfChanged('GSPro waterfalls', [
            path.join(this.pipelineDir, 'gspro.py'), 'waterfalls',
            '--square-3006', terrainArg(terrain.inner),
            '--course', courseId,
            '--dem', dem,
            '--sidecar', sidecar,
            '--out', out,
        ], out, {
            files: [dem, sidecar],
            values: { features: await this.history.latestStamp(courseId) },
        }, opts.force);
        return { path: rendered.path, report: [...prepared, ...rendered.report] };
    }

    /**
     * GreenKeeper's course file for GSPro: tee boxes, pins, green centres,
     * aim points, water hazards and the OOB ring as Unity positions on the
     * INNER terrain, written by `gspro.py gkd` into the course's GSPro folder
     * (`<folder>/<scene>.GKD`, or the `.GKD` already there) and merged into
     * it, so what GreenKeeper owns — the range, wind, stimp — stays. The
     * course details kept with the course (`setMeta`) go into the header;
     * without any, the file's own stay too. Reads the inner heightmap sidecar (and the GeoTIFF next to it)
     * for the terrain's zero, exported first when the folder has none. The same tees, aim points and
     * green centres also go to Unity's hole navigator (`<export folder>/<slug>-holes.json`, `gspro.py holes`).
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
        // The GKD's heights come from the inner heightmap sidecar and the GeoTIFF next to it.
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
        const prepared = await this.ensureDemSidecar(courseId, 'inner', sidecar);
        const out = path.join(courseDir, gkdFile);
        const args = [
            path.join(this.pipelineDir, 'gspro.py'), 'gkd',
            '--square-3006', terrainArg(terrain.inner),
            '--course', courseId,
            '--sidecar', sidecar,
            '--out', out,
            ...serverDbArgs(),
        ];
        const rendered = await this.run('GreenKeeper course file', args, out);
        const holes = await this.run('Hole navigator', [
            path.join(this.pipelineDir, 'gspro.py'), 'holes',
            '--course', courseId,
            '--out', path.join(dir, holesExportFileName(course.name)),
        ], out);
        return { path: rendered.path, report: [...prepared, ...rendered.report, ...holes.report] };
    }

    /**
     * The hazard lines the GreenKeeper course file gets, one entry per GKD
     * hazard, in EPSG:3006 (`gspro.py gkd-lines`, the same rings `exportGkd`
     * writes): an automatic line round each water body no drawn penalty area
     * holds (1 m outside the water, out to where its bank ends, at most 3 m),
     * each drawn penalty area as drawn, and the inner OOB, with each one's
     * noAIL. What Furniture › Rules lines shows and `bun run gkd:lines` lists.
     * Reads the inner heightmap sidecar like `exportGkd`, but never exports
     * it (409 until it is there); needs no GSPro course folder. The file
     * (`<export folder>/<slug>-inner-gkd-lines.json`) is rendered again only
     * when the heightmap, the features or the pipeline changed.
     */
    async gkdLines(courseId: string): Promise<GkdLines> {
        // One run per course at a time: a second caller waits for the first and then finds the file current
        // (or runs again for what changed meanwhile), instead of two runs writing the same file.
        const before = this.gkdLinesRuns.get(courseId) ?? Promise.resolve();
        const run = before.catch(() => undefined).then(() => this.readGkdLines(courseId));
        const tail = run.catch(() => undefined);
        this.gkdLinesRuns.set(courseId, tail);
        void tail.then(() => { if (this.gkdLinesRuns.get(courseId) === tail) this.gkdLinesRuns.delete(courseId); });
        return run;
    }

    private async readGkdLines(courseId: string): Promise<GkdLines> {
        const course = await this.courses.get(courseId);
        const terrain = await this.resolveTerrain(courseId, 'find the course file\'s hazard lines for');
        const { dir, courseDir, gkdFile } = await this.settings(courseId);
        await ensureDir(dir);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
        // Opening Furniture must not start a heightmap export (minutes, and a folder the operator may not
        // have chosen yet): without one the lines wait for it.
        if (!await statOrNull(sidecar)) {
            this.builtSiteId(course); // 404 "no built map" first: then there is no heightmap to export either
            throw new ConflictError(`No inner heightmap in ${dir} yet — export it (GSPro › Terrain) to see the water lines`);
        }
        // A course with no drawn OOB ring keeps its lines inside the boundary of the .GKD already in its GSPro folder, as the export does.
        const gkd = courseDir && gkdFile ? path.join(courseDir, gkdFile) : null;
        const out = path.join(dir, gkdLinesFileName(course.name));
        await this.runIfChanged('GKD hazard lines', [
            path.join(this.pipelineDir, 'gspro.py'), 'gkd-lines',
            '--square-3006', terrainArg(terrain.inner),
            '--course', courseId,
            '--sidecar', sidecar,
            ...(gkd ? ['--gkd', gkd] : []),
            '--out', out,
            ...serverDbArgs(),
        ], out, {
            // The sidecar and the heightmap beside it (the banks), the .GKD (its boundary), and every feature (waters, penalty areas, surfaces, attributes).
            files: [sidecar, sidecar.replace(/\.json$/i, ''), gkd],
            values: { features: await this.history.latestStamp(courseId) },
        });
        const doc = JSON.parse(await readFile(out, 'utf8')) as GkdLines;
        if (!Array.isArray(doc.lines)) throw new ConflictError(`${path.basename(out)} has no hazard lines — export it again`);
        return doc;
    }

    /**
     * How deep each creek comes out in the course meshes, before the bake
     * (`gspro.py creek-depth`, golfmap-creek-depth-v1): every `water_creek`
     * measured across on the DEM its digs are in and on a model of the
     * meshes OPCD conforms onto terrain.obj, with what its dig is. The DEM is
     * the edited one when no enabled terrain edit changed after the last
     * Apply to terrain (`demSource: applied`), else the raw one with the
     * site's enabled edits replayed onto it in memory (`replayed`) — so a dig
     * stored but not applied yet is measured too. The terrain's zero comes
     * from the inner heightmap sidecar, exported first when the folder has
     * none (as the creeks export does). `only`: creek feature ids or their
     * starts. Writes nothing but temp files; 404 without a built map.
     */
    async creekDepth(courseId: string, opts: { only?: string[] } = {}): Promise<CreekDepthReport> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, 'check the creek depth of');
        const dir = await this.exportDir(courseId);
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, 'inner', terrain.inner.sideM)));
        const prepared = await this.ensureDemSidecar(courseId, 'inner', sidecar);

        const edited = path.join(this.sourcesDir(siteId), 'dem-edited.tif');
        const raw = path.join(this.sourcesDir(siteId), 'dem.tif');
        const appliedEdits = await statOrNull(edited) ? await this.innerDemEdits(siteId, edited) : null;
        const demSource: CreekDepthReport['demSource'] = appliedEdits && appliedEdits.changed.length === 0 ? 'applied' : 'replayed';
        if (demSource === 'replayed' && !await statOrNull(raw)) {
            throw new NotFoundError(`No raw DEM for this course's site (${raw}) — build its map first`);
        }
        const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-creek-depth-'));
        try {
            const out = path.join(work, 'creek-depth.json');
            const args = [
                path.join(this.pipelineDir, 'gspro.py'), 'creek-depth',
                '--course', courseId,
                '--sidecar', sidecar,
                '--out', out,
            ];
            if (demSource === 'applied') {
                args.push('--dem', edited);
            } else {
                const edits = appliedEdits?.edits ?? await this.terrainEdits.listDemEdits(siteId);
                const editsPath = path.join(work, 'terrain-edits.geojson');
                await writeFile(editsPath, JSON.stringify(terrainEditsGeojson(edits, { sculptDir: path.join(this.sourcesDir(siteId), SCULPT_DIR) })));
                args.push('--dem', raw, '--edits', editsPath);
            }
            const only = (opts.only ?? []).map(s => s.trim()).filter(Boolean);
            if (only.length > 0) args.push('--only', only.join(','));
            args.push(...serverDbArgs());

            const { code, stdout, stderr } = await this.runner(args, this.pipelineDir);
            if (code !== 0) throw failure('Creek depth check', code, stdout, stderr);
            const doc = JSON.parse(await readFile(out, 'utf8')) as Omit<CreekDepthReport, 'demSource' | 'lines'>;
            if (doc.format !== CREEK_DEPTH_FORMAT || !Array.isArray(doc.creeks)) {
                throw new ConflictError(`The creek depth check wrote no ${CREEK_DEPTH_FORMAT} report (${doc.format ?? 'no format'})`);
            }
            // As printed (the per-creek lines are indented under the summary), without the temp file it wrote.
            const printed = stdout.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim() !== '' && !l.trim().startsWith('wrote '));
            return { ...doc, demSource, lines: [...prepared, ...printed] };
        } finally {
            await rm(work, { recursive: true, force: true });
        }
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
        /** `--force`: render even when the fingerprint says the inputs are unchanged. */
        const force = { force: r.force === true };
        switch (r.kind) {
            case 'svg': return this.export(courseId, { excludeFeatureIds: r.excludeFeatureIds, variant: r.variant });
            case 'ortho': return this.exportOrtho(courseId, r.source!, r.darken, tintOptions(r), floorOptions(r), r.removeBuildings === true, force);
            case 'outer-ortho': return this.exportOuterOrtho(courseId, r.collection!, r.darken, tintOptions(r), floorOptions(r), r.removeBuildings === true, force);
            case 'dem': return this.exportDem(courseId, r.terrain!, force);
            case 'unity-terrain': return this.exportUnityTerrain(courseId, r.terrain!, force);
            case 'unity-sculpt': return this.exportUnitySculpt(courseId, r.terrain!);
            case 'unity-ortho': return this.exportUnityOrtho(courseId, r.source!, r.darken, tintOptions(r), floorOptions(r), r.removeBuildings === true, force);
            case 'hillshade': return this.exportHillshade(courseId, r.terrain!);
            case 'trees': return this.exportTrees(courseId, r.terrain!, force);
            case 'buildings': return this.exportBuildings(courseId, r.terrain!, force);
            case 'zones': return this.exportZones(courseId, r.terrain!, force);
            case 'vegetation': return this.plantVegetation(courseId, r.terrain!, force);
            case 'vegetation-update': return this.updateZones(courseId, r.zoneIds!, { plantIfNeeded: r.plantIfNeeded === true });
            case 'arborist': return this.exportArborist(courseId);
            case 'creeks': return this.exportCreeks(courseId, force);
            case 'ramroads': return this.exportRamRoads(courseId, force);
            case 'waterfalls': return this.exportWaterfalls(courseId, force);
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
        const { edits, applied, changed } = await this.innerDemEdits(siteId, src);
        if (edits.length === 0) return null;
        if (!applied) {
            return `the site has ${edits.length} enabled terrain edit(s) but no edited DEM, so this heightmap has none of them: press Apply to terrain in the terrain tool, then export again`;
        }
        if (changed.length === 0) return null;
        const origins = [...new Set(changed.map(e => e.origin ?? 'hand-drawn'))].join(', ');
        return `${changed.length} terrain edit(s) (${origins}) changed after the last Apply to terrain, so this heightmap lacks them: press Apply to terrain in the terrain tool, then export again`;
    }

    /**
     * The site's enabled DEM edits, and the ones the inner DEM `src` lacks:
     * all of them when `src` is not the edited DEM (`applied: false`), else
     * those created, changed or switched on after "Apply to terrain" last
     * wrote it. The one check behind the heightmap's warning
     * (`staleInnerDem`) and the creek-depth check's DEM choice.
     */
    private async innerDemEdits(siteId: string, src: string): Promise<{ edits: TerrainEdit[]; applied: boolean; changed: TerrainEdit[] }> {
        const edits = await this.terrainEdits.listDemEdits(siteId);
        if (path.basename(src) !== 'dem-edited.tif') return { edits, applied: false, changed: edits };
        if (edits.length === 0) return { edits, applied: true, changed: [] };
        const built = (await stat(src)).mtimeMs;
        const changed = edits.filter(e => Date.parse(`${e.updatedAt.replace(' ', 'T')}Z`) > built + 1000);
        return { edits, applied: true, changed };
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
        const edits = await this.terrainEdits.listDemEdits(siteId);
        if (edits.length === 0) return null;
        const out = path.join(this.sourcesDir(siteId), OUTER_DEM_EDITED_SOURCE);
        const work = await mkdtemp(path.join(os.tmpdir(), 'gspro-outer-edits-'));
        try {
            const editsPath = path.join(work, 'terrain-edits.geojson');
            await writeFile(editsPath, JSON.stringify(terrainEditsGeojson(edits, { sculptDir: path.join(this.sourcesDir(siteId), SCULPT_DIR) })));
            const r = await this.runner(['-m', 'golfpipe', 'apply-dem-edits', '--input', src, '--edits', editsPath, '--out', out, '--terrain', 'outer'], this.pipelineDir);
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
     * exported first when the folder has none — with the pads in it.
     */
    async exportBuildings(courseId: string, kind: TerrainKind, opts: { force?: boolean } = {}): Promise<GsproExportResult> {
        const course = await this.courses.get(courseId);
        const siteId = this.builtSiteId(course);
        const terrain = await this.resolveTerrain(courseId, `export the GSPro ${kind} buildings for`);
        const square = terrain[kind];

        const dir = await this.exportDir(courseId);
        const survey = path.join(this.sourcesDir(siteId), BUILDINGS_SURVEY_SOURCE);
        if (!await statOrNull(survey)) {
            throw new ConflictError('No building survey for this course yet — run "Generate building pads" in the terrain tool first');
        }
        // The pads' height range comes from that terrain's heightmap sidecar — with the pads in it.
        const sidecar = path.join(dir, demSidecarName(demExportFileName(course.name, kind, square.sideM)));
        const prepared = await this.ensureDemSidecar(courseId, kind, sidecar);

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
        const rendered = await this.runIfChanged(`GSPro ${kind} buildings`, args, out,
            { files: [survey, sidecar] }, opts.force);
        return { path: rendered.path, report: [...prepared, ...rendered.report] };
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
                              buildings?: BuildingSources, force?: boolean): Promise<GsproExportResult> {
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
        // The tint and the forest floor read the course's own features, so their stamps join the hash.
        const rendered = await this.runIfChanged(what, args, out, {
            files: [src, buildings?.roofs, buildings?.survey],
            values: {
                ...(tint || floor ? { features: await this.history.latestStamp(courseId) } : {}),
                ...(floor ? { zones: (await this.zonesStamp(courseId)).zones } : {}),
            },
            more: [terrainTextureFileName(out), ...(tint ? [meshTextureFileName(out)] : [])],
        }, force);
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

    /**
     * `run`, unless the output's inputs are unchanged (export-fingerprint.ts):
     * the source files it reads, the run's own arguments (so every option is
     * in the hash), the database stamps `inputs.values` carries and the
     * pipeline scripts' mtimes. Then the pipeline is not called at all and the
     * report says `unchanged: …`; after a real run the sidecar is rewritten.
     * `more` names output files besides `out` that have to be there for a skip
     * (the photo's twins), `outputsAfter` the ones only the run itself knows
     * (the zones export's masks).
     */
    private async runIfChanged(
        what: string, args: string[], out: string,
        inputs: {
            files: ReadonlyArray<string | null | undefined>;
            values?: Record<string, unknown>;
            more?: readonly string[];
            outputsAfter?: () => Promise<string[]>;
        },
        force?: boolean,
    ): Promise<GsproExportResult> {
        const fp = await this.exportFingerprint(args, out, inputs);
        if (!force) {
            const unchanged = await unchangedLine(fp);
            if (unchanged) return { path: out, report: [unchanged] };
        }
        const result = await this.run(what, args, out);
        if (inputs.outputsAfter) fp.doc.outputs = await inputs.outputsAfter();
        await recordInputs(fp);
        return result;
    }

    /** What `runIfChanged` hashes for an output: its files, its values, its arguments and the pipeline's mtimes. */
    private async exportFingerprint(args: string[], out: string,
                                    inputs: { files: ReadonlyArray<string | null | undefined>; values?: Record<string, unknown>; more?: readonly string[] }) {
        return fingerprint(out, {
            files: inputs.files,
            values: { ...inputs.values, args, pipeline: await this.pipelineStamp() },
            outputs: [out, ...(inputs.more ?? [])],
        });
    }

    /** The mtimes of the pipeline code an export runs through, so an edited exporter renders again. */
    private async pipelineStamp(): Promise<Record<string, number | null>> {
        return {
            'gspro.py': await mtimeMs(path.join(this.pipelineDir, 'gspro.py')),
            golfpipe: await mtimeMs(path.join(this.pipelineDir, 'golfpipe', '__init__.py')),
        };
    }

    /**
     * The site's enabled terrain edits as one opaque stamp: how many, the
     * newest `updated_at`, and the newest history row id — what a DEM export
     * carries. A created or deleted edit changes the count, an edited or
     * toggled one the time, and the history id catches an edit inside the same
     * second as the last export (`updated_at` has whole seconds only).
     */
    private async editsStamp(siteId: string): Promise<string> {
        const edits = (await this.terrainEdits.listBySite(siteId)).filter(e => e.enabled);
        const history = await this.db.selectFrom('terrain_edit_history')
            .select(({ fn }) => fn.max<number | null>('history_id').as('id'))
            .where('site_id', '=', siteId).executeTakeFirst();
        return `${edits.length}:${edits.map(e => e.updatedAt).sort().at(-1) ?? 'none'}:${history?.id ?? 0}`;
    }

    /**
     * What the vegetation masks are rasterized from: the course's
     * vegetation_zone features as CONTENT (the ids are left out — the
     * generators delete and re-insert their rows, so an id would never match
     * twice, while identical zones must count as unchanged), plus the zone
     * types by content, whose item bindings decide the channels (their
     * `updated_at` has whole seconds only: an edit in the same second as the
     * export went unseen).
     */
    private async zonesStamp(courseId: string): Promise<{ zones: string; zoneTypes: string }> {
        const rows = await this.db.selectFrom('course_features')
            .select(['layer', 'hole_id', 'sort_order', 'geometry_json', 'attributes_json', 'generated', 'source'])
            .where('course_id', '=', courseId).where('type', '=', 'vegetation_zone').execute();
        const types = await this.db.selectFrom('course_zone_types')
            .select(['key', 'name', 'texture_index', 'channel', 'sort_order', 'items_json', 'variants_json'])
            .where('course_id', '=', courseId).orderBy('key').execute();
        return { zones: `${rows.length}:${digest(rows.map(r => JSON.stringify(r)))}`, zoneTypes: digest([JSON.stringify(types)]) };
    }

    /** The mask PNGs `gspro.py zones` wrote next to a zones file, so a hand-deleted one is noticed. */
    private async zoneMasks(dir: string, zonesJson: string): Promise<string[]> {
        const prefix = `${path.basename(zonesJson).replace(/\.json$/i, '')}-`;
        try {
            return (await readdir(dir))
                .filter(n => n.startsWith(prefix) && n.toLowerCase().endsWith('.png'))
                .sort()
                .map(n => path.join(dir, n));
        } catch {
            return [];
        }
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
        case 'unity-ortho': need(r.source, 'a source'); return 'inner orthophoto onto the Unity course meshes';
        case 'hillshade': need(r.terrain, 'a terrain'); return `${r.terrain} hillshade`;
        case 'trees': need(r.terrain, 'a terrain'); return `${r.terrain} trees`;
        case 'buildings': need(r.terrain, 'a terrain'); return `${r.terrain} buildings`;
        case 'zones': need(r.terrain, 'a terrain'); return `${r.terrain} vegetation zones`;
        case 'vegetation': need(r.terrain, 'a terrain'); return `${r.terrain} vegetation, planted for GSPro`;
        case 'vegetation-update': need(r.zoneIds?.length, 'the zones to update'); return `${r.zoneIds!.length} vegetation zone(s) updated for GSPro`;
        case 'arborist': return 'Arborist file (lower vegetation and trees)';
        case 'creeks': return 'creeks (R.A.M. splines)';
        case 'ramroads': return 'R.A.M. roads';
        case 'waterfalls': return 'waterfalls (lips and water levels)';
        case 'gkd': return 'GreenKeeper course file';
        default: throw new ConflictError(`Unknown export kind '${String((r as { kind: unknown }).kind)}'`);
    }
}

/** What the Arborist half did, for the message of a planting whose Unity half failed. */
function arboristAfterFailure(arborist: ArboristResult | null): string {
    if (!arborist?.used) return '';
    if (arborist.error) return `. ${arborist.error}`;
    return `. The Arborist ${arborist.written.join(' and ')} was still written`;
}

function firstLine(text: string): string {
    return text.split('\n')[0] ?? '';
}

/**
 * The report line of a bridge command run with `save: true` — what replaces
 * "Save the scene in Unity to keep it." (unity/README.md, "Saving what a
 * command changed": the result carries `saved: {scenes, seconds}`, or
 * `saved.skipped` saying why it did not). Null when the command did not save,
 * so the caller keeps its own line.
 */
export function savedLine(result: unknown): string | null {
    const saved = (result as { saved?: Record<string, unknown> } | null | undefined)?.saved;
    if (!saved || typeof saved !== 'object') return null;
    const scenes = Array.isArray(saved.scenes) ? saved.scenes.filter((s): s is string => typeof s === 'string') : [];
    if (scenes.length > 0) {
        return `Saved ${scenes.join(', ')}${typeof saved.seconds === 'number' ? ` (${saved.seconds} s)` : ''}`;
    }
    return typeof saved.skipped === 'string' ? `Not saved: ${saved.skipped}` : null;
}

export function reportLines(stdout: string): string[] {
    return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

/** A 409 carrying the pipeline's last words. */
/** A `--checks-out` file as the service hands it on. */
export async function readSvgChecks(file: string): Promise<Omit<SvgCheckReport, 'courseId'>> {
    const doc = JSON.parse(await readFile(file, 'utf8')) as Partial<SvgCheckReport> & { format?: string };
    if (doc.format !== 'golfmap-svg-checks-v1') throw new ConflictError(`${file} is not an SVG checks file (${doc.format ?? 'no format'})`);
    return {
        checkedAt: doc.checkedAt ?? new Date().toISOString(),
        errors: doc.errors ?? 0, warnings: doc.warnings ?? 0, notes: doc.notes ?? 0, accepted: doc.accepted ?? 0,
        findings: doc.findings ?? [],
    };
}

async function readAccepted(file: string): Promise<{ accepted: { key: string; note?: string; at?: string }[] }> {
    try {
        const doc = JSON.parse(await readFile(file, 'utf8'));
        return { accepted: Array.isArray(doc?.accepted) ? doc.accepted.filter((a: { key?: unknown }) => typeof a?.key === 'string') : [] };
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { accepted: [] };
        throw new ConflictError(`${file}: ${(e as Error).message}`);
    }
}

export function failure(what: string, code: number, stdout: string, stderr: string): ConflictError {
    const detail = (stderr.trim() || stdout.trim() || `exit ${code}`).split('\n').slice(-4).join(' ');
    return new ConflictError(`${what} failed: ${detail}`);
}

/** What of the pipeline an SVG export runs: the files whose uncommitted edits `pipelineCodeVersion` hashes. */
export const SVG_CODE_PATHS = ['gspro.py', 'golfpipe'];

/**
 * The pipeline code an SVG export runs, for its export.json: the commit, plus a
 * hash of what is not committed in `SVG_CODE_PATHS` (the diff against HEAD and
 * the untracked files' contents) — two exports with the same sha and hash ran the
 * same code. Null where the pipeline is not a git checkout (or git is missing).
 */
export async function pipelineCodeVersion(pipelineDir: string): Promise<CodeVersion | null> {
    const git = async (args: string[]): Promise<string | null> => {
        try {
            const proc = Bun.spawn(['git', '-C', pipelineDir, ...args], { stdout: 'pipe', stderr: 'pipe' });
            const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
            return code === 0 ? out : null;
        } catch {
            return null;
        }
    };
    const sha = (await git(['rev-parse', 'HEAD']))?.trim();
    if (!sha) return null;
    const [diff, status, untracked] = await Promise.all([
        git(['diff', 'HEAD', '--', ...SVG_CODE_PATHS]),
        git(['status', '--porcelain', '--', ...SVG_CODE_PATHS]),
        git(['ls-files', '--others', '--exclude-standard', '--', ...SVG_CODE_PATHS]),
    ]);
    const dirtyFiles = (status ?? '').split('\n').map(l => l.slice(3).trim()).filter(Boolean);
    if (!dirtyFiles.length) return { sha, dirty: null, dirtyFiles };
    const hash = new Bun.CryptoHasher('sha256').update(diff ?? '');
    for (const file of (untracked ?? '').split('\n').map(l => l.trim()).filter(Boolean).sort()) {
        hash.update(`\0${file}\0`);
        hash.update(await readFile(path.join(pipelineDir, file)).catch(() => Buffer.alloc(0)));
    }
    return { sha, dirty: hash.digest('hex').slice(0, 16), dirtyFiles };
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

/** A `.GKD` file parsed; null when it is missing or not a JSON object. */
async function gkdIn(file: string): Promise<Record<string, unknown> | null> {
    try {
        const doc = JSON.parse(await readFile(file, 'utf8'));
        return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
    } catch {
        return null;
    }
}

/** Course details as stored: text trimmed, keywords in file order without repeats. */
function cleanMeta(meta: GsproCourseMeta): GsproCourseMeta {
    if (!Number.isFinite(meta.difficulty) || meta.difficulty < 0) throw new ConflictError('Difficulty must be a number, 0 or more');
    return {
        courseName: meta.courseName.trim(), city: meta.city.trim(), state: meta.state.trim(), country: meta.country.trim(),
        designer: meta.designer.trim(), homage: meta.homage.trim(), description: meta.description.trim(),
        difficulty: meta.difficulty,
        keywords: GKD_KEYWORDS.filter(k => meta.keywords.includes(k)),
    };
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
