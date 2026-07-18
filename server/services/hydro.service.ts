// One-click water import proxy (T50): fetches Lantmäteriet Hydrografi
// Direkt features for a course's map area so the web GeoJSON import wizard
// can offer "Fetch from Lantmäteriet" without a manual file step.
//
// Fetch semantics are a port of pipeline/golfpipe/hydro.py (T48), verified
// live 2026-07-18:
//   - OGC API Features at HYDRO_API_URL; /collections all storageCrs
//     EPSG:3006. Consumed: StandingWater + WatercoursePolygon (water
//     surfaces, Polygon) and WatercourseLine (creek centerlines,
//     LineString).
//   - `?crs=<EPSG:3006 URI>` returns coordinates in the official EPSG:3006
//     axis order — (northing, easting) — swapAxes flips every position to
//     the (easting, northing) = (x, y) order the app uses.
//   - `bbox` is interpreted in CRS84 (lon/lat WGS84) by default, so the
//     course bbox is passed in WGS84 with no bbox-crs parameter.
//   - Paging via `rel: next` links; the landing page is anonymous but
//     /items requires basic auth (401).
//
// Unlike the pipeline command, geometries are returned PER SOURCE FEATURE
// (no union) so each import carries its own provenance (T49 sourceRef =
// OGC feature id), and creek centerlines are returned RAW — the client
// buffers them into ribbons (web/src/geo/polyline-buffer.ts).
//
// The course's WGS84 bbox authority chain ("site owns the map"):
//   1. course.georeference_json `{ bbox: [minX, minY, maxX, maxY] }`
//      (EPSG:3006, written by the tile pipeline / SVG import flow);
//   2. else the site's tile_manifest asset metaJson `bounds` (WGS84);
//   3. else a clear ConflictError — there is no map area to fetch for.
//
// HTTP goes through a fetch seam (deps.fetchImpl) so tests stay offline
// with fixture pages, mirroring the pipeline's session-parameter seam.

import polygonClipping from 'polygon-clipping';
import { ConflictError } from '@basics/core/server/auth';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveCourseMapBbox, type Bbox3006, type BboxWgs84 } from './course-bbox';
import type { CoursesService } from './courses.service';
import type { AssetsService } from './assets.service';

export const HYDRO_API_URL = 'https://api.lantmateriet.se/ogc-features/v1/hydrografi';
export const CRS_3006_URI = 'http://www.opengis.net/def/crs/EPSG/0/3006';

/** Collections whose features are standing/flowing water SURFACES (polygons). */
export const WATER_SURFACE_COLLECTIONS = ['StandingWater', 'WatercoursePolygon'] as const;
/** Collection carrying watercourse CENTERLINES (creeks/ditches too narrow to map as surfaces). */
export const WATERCOURSE_LINE_COLLECTION = 'WatercourseLine';

/** Items per page; a course-sized bbox stays on one page per collection. */
const DEFAULT_PAGE_LIMIT = 1000;
/** Hard stop against a next-link loop (per collection). */
const MAX_PAGES = 100;

/** Matches pipeline/golfpipe/hydro.py ATTRIBUTION / SOURCE (no license — the
 * Hydrografi Direkt output carries attribution only, unlike OSM's ODbL). */
export const HYDRO_ATTRIBUTION = '© Lantmäteriet, Hydrografi Direkt';
export const HYDRO_SOURCE = 'lantmateriet-hydrografi';

/** Matches pipeline/golfpipe/water.py DEFAULT_CREEK_WIDTH_M. */
export const SUGGESTED_CREEK_WIDTH_M = 2;

// --- Output types (serialized into shared/api/hydro.gen.ts) ---

export interface HydroBbox {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** One water-surface polygon, EPSG:3006, clipped to the course bbox.
 * rings[0] = outer, rest = holes; rings are explicitly closed. */
export interface HydroWaterPolygon {
    /** OGC feature id as `<Collection>/<id>`, or null when the API omits it. */
    sourceRef: string | null;
    rings: number[][][];
}

/** One RAW creek centerline run, EPSG:3006, clipped to the course bbox.
 * The client buffers these into `water_creek` ribbons. */
export interface HydroCreekLine {
    sourceRef: string | null;
    points: number[][];
}

export interface HydroFetchResult {
    /** WGS84 bbox the fetch covered (derived server-side, see courseBbox). */
    bbox: HydroBbox;
    source: string;
    attribution: string;
    suggestedCreekWidthM: number;
    water: HydroWaterPolygon[];
    creeks: HydroCreekLine[];
}

// --- Seams ---

/** Minimal structural fetch type — the seam server tests stub. */
export type HydroFetchImpl = (
    url: string,
    init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HydroCredentials {
    user: string;
    pass: string;
}

export interface HydroDeps {
    courses: CoursesService;
    assets: AssetsService;
    /** Injected in tests; defaults to global fetch. */
    fetchImpl?: HydroFetchImpl;
    /** Injected in tests; defaults to env vars with a repo .env fallback. */
    credentials?: () => HydroCredentials;
    baseUrl?: string;
    pageLimit?: number;
}

// --- Pure helpers (exported for tests) ---

type Coords = number | Coords[];

/**
 * EPSG:3006's official axis order is (northing, easting), and the OGC API
 * honors it when `crs` requests 3006 output. Recursively flips every
 * position to (easting, northing) = (x, y). Port of hydro.py _swap_axes.
 */
export function swapAxes(coords: Coords[]): Coords[] {
    if (coords.length > 0 && typeof coords[0] === 'number') {
        return [coords[1], coords[0]];
    }
    return (coords as Coords[][]).map(swapAxes);
}

/**
 * Parse KEY=VALUE lines the way pipeline/golfpipe/__main__.py _load_dotenv
 * does: blank/comment/`=`-less lines skipped, values stripped of quotes.
 */
export function parseDotenv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const idx = line.indexOf('=');
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key && value) out[key] = value;
    }
    return out;
}

/**
 * LANTMATERIET_USER/PASS from the process env, falling back to the nearest
 * .env walking up from cwd (the repo root's .env in dev — the same file the
 * pipeline loads). Throws ConflictError with a clear message when unset.
 */
export function defaultHydroCredentials(): HydroCredentials {
    let user = process.env.LANTMATERIET_USER;
    let pass = process.env.LANTMATERIET_PASS;
    if (!user || !pass) {
        let dir = process.cwd();
        for (let i = 0; i < 4; i++) {
            try {
                const parsed = parseDotenv(readFileSync(path.join(dir, '.env'), 'utf8'));
                user = user || parsed.LANTMATERIET_USER;
                pass = pass || parsed.LANTMATERIET_PASS;
                break;
            } catch {
                dir = path.dirname(dir);
            }
        }
    }
    if (!user || !pass) {
        throw new ConflictError(
            'Lantmäteriet credentials missing: set LANTMATERIET_USER and LANTMATERIET_PASS '
            + 'in the server environment or the repo .env.',
        );
    }
    return { user, pass };
}

/** Close a ring explicitly (GeoJSON convention) unless already closed. */
function closeRing(ring: number[][]): number[][] {
    if (ring.length === 0) return ring;
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx === lx && fy === ly) return ring;
    return [...ring, [fx, fy]];
}

/**
 * Clip a polygon (ring set, holes included) to the EPSG:3006 bbox. The
 * server's bbox filter is INTERSECTS, so features can extend well beyond
 * the requested area (a lake shore, a river crossing the course) — same
 * reason hydro.py clips. Returns zero or more polygons (a clip can split
 * one polygon into disjoint parts), rings explicitly closed.
 */
export function clipPolygonToBbox(rings: number[][][], bbox: Bbox3006): number[][][][] {
    const [minX, minY, maxX, maxY] = bbox;
    const clip: [number, number][][] = [[
        [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
    ]];
    const subject = rings.map(ring => ring.map(([x, y]) => [x, y] as [number, number]));
    let clipped: [number, number][][][];
    try {
        clipped = polygonClipping.intersection([subject], [clip]);
    } catch {
        return []; // degenerate source geometry — drop it, as shapely's empty intersection would
    }
    return clipped.map(poly => poly.map(ring => closeRing(ring.map(([x, y]) => [x, y]))));
}

/**
 * Clip a polyline to the EPSG:3006 bbox (Liang–Barsky per segment),
 * splitting it into the runs that lie inside. Degenerate runs (< 2 points)
 * are dropped.
 */
export function clipPolylineToBbox(points: number[][], bbox: Bbox3006): number[][][] {
    const [minX, minY, maxX, maxY] = bbox;
    const runs: number[][][] = [];
    let run: number[][] = [];
    const EPS = 1e-9;

    const flush = () => {
        if (run.length >= 2) runs.push(run);
        run = [];
    };

    for (let i = 0; i + 1 < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[i + 1];
        const dx = x1 - x0;
        const dy = y1 - y0;
        let t0 = 0;
        let t1 = 1;
        let inside = true;
        for (const [p, q] of [
            [-dx, x0 - minX], [dx, maxX - x0],
            [-dy, y0 - minY], [dy, maxY - y0],
        ]) {
            if (p === 0) {
                if (q < 0) { inside = false; break; } // parallel and outside
            } else {
                const r = q / p;
                if (p < 0) {
                    if (r > t1) { inside = false; break; }
                    if (r > t0) t0 = r;
                } else {
                    if (r < t0) { inside = false; break; }
                    if (r < t1) t1 = r;
                }
            }
        }
        if (!inside) {
            flush();
            continue;
        }
        const a = [x0 + t0 * dx, y0 + t0 * dy];
        const b = [x0 + t1 * dx, y0 + t1 * dy];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < EPS) {
            continue; // grazing contact — no usable run segment
        }
        const last = run[run.length - 1];
        if (!last || Math.hypot(last[0] - a[0], last[1] - a[1]) > EPS) {
            flush();
            run.push(a);
        }
        run.push(b);
    }
    flush();
    return runs;
}

// --- OGC API Features response shapes (structural, defensively read) ---

interface OgcFeature {
    id?: string | number;
    geometry?: { type?: string; coordinates?: Coords[] } | null;
}

interface OgcPage {
    features?: OgcFeature[];
    links?: Array<{ rel?: string; href?: string }>;
}

function nextLink(page: OgcPage): string | null {
    for (const link of page.links ?? []) {
        if (link.rel === 'next' && link.href) return link.href;
    }
    return null;
}

// --- Service ---

export class HydroService {
    private courses: CoursesService;
    private assets: AssetsService;
    private fetchImpl: HydroFetchImpl;
    private credentials: () => HydroCredentials;
    private baseUrl: string;
    private pageLimit: number;

    constructor(deps: HydroDeps) {
        this.courses = deps.courses;
        this.assets = deps.assets;
        this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
        this.credentials = deps.credentials ?? defaultHydroCredentials;
        this.baseUrl = deps.baseUrl ?? HYDRO_API_URL;
        this.pageLimit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
    }

    /**
     * Fetch water surfaces + creek centerlines intersecting the course's
     * map area. Water arrives as EPSG:3006 polygons; creeks as raw
     * centerlines with a suggested ribbon width — the client buffers them.
     */
    async fetchForCourse(courseId: string): Promise<HydroFetchResult> {
        const { wgs84, sweref } = await this.courseBbox(courseId);
        const creds = this.credentials();

        const water: HydroWaterPolygon[] = [];
        for (const collection of WATER_SURFACE_COLLECTIONS) {
            for (const feature of await this.fetchCollection(collection, wgs84, creds)) {
                const geometry = feature.geometry;
                if (!geometry?.type || !geometry.coordinates) continue;
                const sourceRef = feature.id !== undefined && feature.id !== null
                    ? `${collection}/${feature.id}` : null;
                const polygons: number[][][][] = geometry.type === 'Polygon'
                    ? [swapAxes(geometry.coordinates) as number[][][]]
                    : geometry.type === 'MultiPolygon'
                        ? (swapAxes(geometry.coordinates) as number[][][][])
                        : [];
                for (const rings of polygons) {
                    for (const clipped of clipPolygonToBbox(rings, sweref)) {
                        water.push({ sourceRef, rings: clipped });
                    }
                }
            }
        }

        const creeks: HydroCreekLine[] = [];
        for (const feature of await this.fetchCollection(WATERCOURSE_LINE_COLLECTION, wgs84, creds)) {
            const geometry = feature.geometry;
            if (!geometry?.type || !geometry.coordinates) continue;
            const sourceRef = feature.id !== undefined && feature.id !== null
                ? `${WATERCOURSE_LINE_COLLECTION}/${feature.id}` : null;
            const lines: number[][][] = geometry.type === 'LineString'
                ? [swapAxes(geometry.coordinates) as number[][]]
                : geometry.type === 'MultiLineString'
                    ? (swapAxes(geometry.coordinates) as number[][][])
                    : [];
            for (const line of lines) {
                for (const run of clipPolylineToBbox(line, sweref)) {
                    creeks.push({ sourceRef, points: run });
                }
            }
        }

        return {
            bbox: wgs84,
            source: HYDRO_SOURCE,
            attribution: HYDRO_ATTRIBUTION,
            suggestedCreekWidthM: SUGGESTED_CREEK_WIDTH_M,
            water,
            creeks,
        };
    }

    /**
     * The course's map-area bbox, WGS84 (for the API's default CRS84 bbox
     * filter) + EPSG:3006 (for clipping): course georeference_json when
     * present, else the site's tile-manifest bounds (site owns the map).
     * Shared with OsmService (T53) via course-bbox.ts.
     */
    private courseBbox(courseId: string): Promise<{ wgs84: BboxWgs84; sweref: Bbox3006 }> {
        return resolveCourseMapBbox(this.courses, this.assets, courseId, 'fetch water for');
    }

    /**
     * Every feature of `collection` intersecting the WGS84 bbox, paged via
     * `rel: next` links. `next` hrefs carry the full query string, so query
     * params go on page 1 only (port of hydro.py fetch_collection_geometries).
     */
    private async fetchCollection(
        collection: string,
        bbox: HydroBbox,
        creds: HydroCredentials,
    ): Promise<OgcFeature[]> {
        const params = new URLSearchParams({
            f: 'json',
            bbox: [bbox.west, bbox.south, bbox.east, bbox.north].join(','),
            crs: CRS_3006_URI,
            limit: String(this.pageLimit),
        });
        let url: string | null = `${this.baseUrl}/collections/${collection}/items?${params}`;
        const headers = {
            Authorization: `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')}`,
        };

        const features: OgcFeature[] = [];
        for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
            if (url === null) return features;
            const resp = await this.fetchImpl(url, { headers });
            if (!resp.ok) {
                if (resp.status === 401 || resp.status === 403) {
                    throw new ConflictError(
                        `Hydrografi Direkt returned ${resp.status} for ${collection}: the `
                        + "LANTMATERIET_USER account has not activated the 'Hydrografi "
                        + "Nedladdning, direkt' product in Geotorget.",
                    );
                }
                throw new ConflictError(`Hydrografi Direkt returned ${resp.status} for ${collection}`);
            }
            const page = await resp.json() as OgcPage;
            features.push(...(page.features ?? []));
            url = nextLink(page);
        }
        throw new ConflictError(
            `Hydrografi Direkt paging for ${collection} exceeded ${MAX_PAGES} pages — aborting `
            + '(next-link loop, or the bbox is far larger than a course)',
        );
    }
}
