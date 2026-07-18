// One-click OSM import proxy (T53): fetches OpenStreetMap golf + terrain
// polygons for a course's map area so the web GeoJSON import wizard can
// offer "Fetch from OpenStreetMap" without running the pipeline's
// fetch-osm command by hand.
//
// A TypeScript port of pipeline/golfpipe/osm.py (T44) mirroring
// HydroService (T50) architecturally:
//   - Overpass QL query over the course's WGS84 bbox (bbox authority chain
//     shared with HydroService via course-bbox.ts: georeference_json else
//     the site's tile-manifest bounds else 409). `out geom;` inlines member
//     coordinates so no separate node resolution is needed.
//   - Tag→type mapping (classifyOsmTags), closed-way ring assembly and
//     `type=multipolygon` relation stitching with holes (stitchRings +
//     assignHoles — a hand-rolled point-in-ring test replaces shapely's
//     representative_point/covers).
//   - WGS84→EPSG:3006 via services/geo.ts (no rasterio), coordinates
//     rounded to cm like osm.py's ndigits=2.
//   - Unlike osm.py, output polygons are CLIPPED to the course's EPSG:3006
//     bbox (hydro.service.ts clipPolygonToBbox): Overpass returns the full
//     geometry of anything touching the bbox, and `landuse=forest` polygons
//     can be enormous. Provenance survives clipping (clip splits keep the
//     same sourceRef).
//
// LICENSING — OSM is ODbL: attribution + share-alike. Every returned
// feature carries T49 provenance (source 'osm', sourceRef 'way/<id>' /
// 'relation/<id>', license 'ODbL'); the result carries the attribution
// string. A course containing any ODbL feature surfaces as ODbL per T49.
//
// Overpass is public (no credentials) but rate-limited: a descriptive
// User-Agent is sent per its usage policy, and 429/504 map to clear
// user-facing errors. HTTP goes through a fetch seam (deps.fetchImpl) so
// tests stay offline with fixture JSON.

import { ConflictError } from '@basics/core/server/auth';
import { wgs84ToSweref99tm } from './geo';
import { resolveCourseMapBbox } from './course-bbox';
import { clipPolygonToBbox } from './hydro.service';
import type { CoursesService } from './courses.service';
import type { AssetsService } from './assets.service';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Sent as User-Agent so Overpass can identify the client (its usage policy
 * asks for a descriptive UA). Matches the pipeline's naming convention. */
export const OSM_USER_AGENT = 'golf-map-server/1.0 (fetch-osm)';

/** Matches pipeline/golfpipe/osm.py ATTRIBUTION. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL (opendatacommons.org/licenses/odbl)';
export const OSM_SOURCE = 'osm';
/** T49 license marker — drives the course-level ODbL posture. */
export const OSM_LICENSE = 'ODbL';

// --- Output types (serialized into shared/api/osm.gen.ts) ---

export interface OsmBbox {
    west: number;
    south: number;
    east: number;
    north: number;
}

/** One typed polygon, EPSG:3006, clipped to the course bbox.
 * rings[0] = outer, rest = holes; rings are explicitly closed. */
export interface OsmFeaturePolygon {
    /** App feature type (green/tee/fairway/bunker/rough/water/trees). */
    type: string;
    /** T49 sourceRef: `way/<osm_id>` or `relation/<osm_id>`. */
    sourceRef: string;
    rings: number[][][];
}

export interface OsmFetchResult {
    /** WGS84 bbox the fetch covered (derived server-side, see course-bbox.ts). */
    bbox: OsmBbox;
    source: string;
    license: string;
    attribution: string;
    /** Fetch date (YYYY-MM-DD) — osm.py stamps the same on its files. */
    fetched: string;
    features: OsmFeaturePolygon[];
    /** Human-readable notes for skipped elements (non-closed rings, …). */
    skipped: string[];
}

// --- Seams ---

/** Minimal structural fetch type — the seam server tests stub. */
export type OsmFetchImpl = (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OsmDeps {
    courses: CoursesService;
    assets: AssetsService;
    /** Injected in tests; defaults to global fetch. */
    fetchImpl?: OsmFetchImpl;
    overpassUrl?: string;
    /** Injected in tests; defaults to today (fetch-date provenance stamp). */
    today?: () => string;
}

// --- Pure helpers (exported for tests; ports of osm.py) ---

/**
 * Maps an OSM element's tags to an app FEATURE_TYPE, or null when the
 * element is not a golf/terrain polygon we import (linear ways, cartpaths,
 * clubhouses, …). Golf tags win over land-cover tags. Port of
 * osm.py classify_osm_tags — keep the two tables in sync.
 */
export function classifyOsmTags(tags: Record<string, string> | undefined): string | null {
    if (!tags) return null;
    const golf = tags['golf'];
    if (golf !== undefined) {
        return {
            green: 'green',
            tee: 'tee',
            fairway: 'fairway',
            bunker: 'bunker',
            rough: 'rough',
            water_hazard: 'water',
            lateral_water_hazard: 'water',
        }[golf] ?? null;
    }
    if (tags['natural'] === 'water') return 'water';
    if (tags['natural'] === 'wood' || tags['landuse'] === 'forest') return 'trees';
    return null;
}

/**
 * Overpass QL for golf + land-cover features in the WGS84 bbox. Overpass
 * bbox order is (S,W,N,E); `out geom;` inlines way/member coordinates.
 * Port of osm.py build_overpass_query.
 */
export function buildOverpassQuery(bbox: OsmBbox): string {
    const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
    const selectors = [
        'way["golf"]',
        'relation["golf"]',
        'way["natural"="water"]',
        'relation["natural"="water"]',
        'way["natural"="wood"]',
        'relation["natural"="wood"]',
        'way["landuse"="forest"]',
        'relation["landuse"="forest"]',
    ];
    const body = selectors.map(sel => `  ${sel}(${b});\n`).join('');
    return `[out:json][timeout:180];\n(\n${body});\nout geom;`;
}

type Pt = [number, number];

/** Overpass `out geom` way geometry ([{lat, lon}, …]) → [(lon, lat), …]. */
function wayPoints(geometry: Array<{ lat?: number; lon?: number }> | undefined): Pt[] {
    return (geometry ?? [])
        .filter(pt => typeof pt.lon === 'number' && typeof pt.lat === 'number')
        .map(pt => [pt.lon as number, pt.lat as number]);
}

/** Endpoint equality at ~1 cm (7 decimals of a degree), as osm.py rounds. */
function ptEq(a: Pt, b: Pt): boolean {
    return Math.abs(a[0] - b[0]) < 5e-8 && Math.abs(a[1] - b[1]) < 5e-8;
}

function isClosed(ring: Pt[]): boolean {
    return ring.length >= 4 && ptEq(ring[0], ring[ring.length - 1]);
}

/** Closed ring (first == last, ≥ 4 points), auto-closing an open one, or
 * null if there aren't enough distinct points for a polygon. */
function closeWayRing(ring: Pt[]): Pt[] | null {
    if (ring.length < 3) return null;
    const closed = ptEq(ring[0], ring[ring.length - 1]) ? ring : [...ring, ring[0]];
    return closed.length >= 4 ? closed : null;
}

/**
 * Stitches multipolygon member ways (each a run of (lon, lat) points) into
 * closed rings by matching shared endpoints. Ways may arrive split and in
 * any direction; dangling chains that never close are dropped. Port of
 * osm.py stitch_rings.
 */
export function stitchRings(ways: Pt[][]): Pt[][] {
    const segments = ways.filter(w => w.length >= 2).map(w => [...w]);
    const rings: Pt[][] = [];
    while (segments.length > 0) {
        let chain = segments.shift() as Pt[];
        let extended = true;
        while (extended && !ptEq(chain[0], chain[chain.length - 1])) {
            extended = false;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                if (ptEq(chain[chain.length - 1], seg[0])) {
                    chain = [...chain, ...seg.slice(1)];
                } else if (ptEq(chain[chain.length - 1], seg[seg.length - 1])) {
                    chain = [...chain, ...[...seg].reverse().slice(1)];
                } else if (ptEq(chain[0], seg[seg.length - 1])) {
                    chain = [...seg.slice(0, -1), ...chain];
                } else if (ptEq(chain[0], seg[0])) {
                    chain = [...[...seg].reverse().slice(0, -1), ...chain];
                } else {
                    continue;
                }
                segments.splice(i, 1);
                extended = true;
                break;
            }
        }
        if (isClosed(chain)) rings.push(chain);
    }
    return rings;
}

/** Even-odd ray cast: is `pt` strictly inside the (closed) ring? */
function pointInRing(pt: Pt, ring: Pt[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > pt[1]) !== (yj > pt[1])
            && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Assign each inner ring as a hole of the outer ring containing it — one
 * ring set [outer, ...holes] per outer ring. Replaces shapely's
 * representative_point/covers: an inner ring's vertex centroid is tested
 * first, its first vertex as a fallback (a vertex of a hole lies strictly
 * inside its outer ring). Unmatched inners are dropped, as osm.py's
 * containment loop drops them. Exported for tests.
 */
export function assignHoles(outerRings: Pt[][], innerRings: Pt[][]): Pt[][][] {
    const out: Pt[][][] = outerRings.map(r => [r]);
    for (const inner of innerRings) {
        const n = inner.length - 1; // closed ring: skip the duplicate endpoint
        if (n < 3) continue;
        const centroid: Pt = [
            inner.slice(0, n).reduce((s, p) => s + p[0], 0) / n,
            inner.slice(0, n).reduce((s, p) => s + p[1], 0) / n,
        ];
        for (const candidate of [centroid, inner[0]]) {
            const i = outerRings.findIndex(outer => pointInRing(candidate, outer));
            if (i >= 0) {
                out[i].push(inner);
                break;
            }
        }
    }
    return out;
}

// --- Overpass response shapes (structural, defensively read) ---

interface OverpassElement {
    type?: string;
    id?: number | string;
    tags?: Record<string, string>;
    geometry?: Array<{ lat?: number; lon?: number }>;
    members?: Array<{
        type?: string;
        role?: string;
        geometry?: Array<{ lat?: number; lon?: number }>;
    }>;
}

/** One assembled polygon still in (lon, lat): type + provenance + rings. */
export interface AssembledOsmPolygon {
    type: string;
    sourceRef: string;
    rings: Pt[][];
}

/**
 * Turns Overpass `out geom` JSON into (polygons, skipped): closed ways
 * whose tags classify → one polygon (no holes); `type=multipolygon`
 * relations → member ways stitched into outer/inner rings, one polygon per
 * outer ring, inners as holes. Rings stay in WGS84 (lon, lat) — the
 * service reprojects. Port of osm.py assemble_features.
 */
export function assembleOsmPolygons(
    overpassJson: { elements?: OverpassElement[] },
): { polygons: AssembledOsmPolygon[]; skipped: string[] } {
    const polygons: AssembledOsmPolygon[] = [];
    const skipped: string[] = [];

    for (const element of overpassJson.elements ?? []) {
        const etype = element.type;
        const eid = element.id;
        const ftype = classifyOsmTags(element.tags);
        if (ftype === null) continue; // unclassified — silently common, not logged

        if (etype === 'way') {
            const ring = closeWayRing(wayPoints(element.geometry));
            if (ring === null) {
                skipped.push(`way/${eid}: ${ftype} way is not a closed ring`);
                continue;
            }
            polygons.push({ type: ftype, sourceRef: `way/${eid}`, rings: [ring] });
        } else if (etype === 'relation') {
            const outerWays: Pt[][] = [];
            const innerWays: Pt[][] = [];
            for (const member of element.members ?? []) {
                if (member.type !== 'way' || !member.geometry) continue;
                const pts = wayPoints(member.geometry);
                if (member.role === 'inner') innerWays.push(pts);
                else outerWays.push(pts); // "outer" or unrolled
            }
            const outerRings = stitchRings(outerWays);
            if (outerRings.length === 0) {
                skipped.push(`relation/${eid}: ${ftype} relation has no closed outer ring`);
                continue;
            }
            for (const rings of assignHoles(outerRings, stitchRings(innerWays))) {
                polygons.push({ type: ftype, sourceRef: `relation/${eid}`, rings });
            }
        }
    }

    return { polygons, skipped };
}

// --- Service ---

export class OsmService {
    private courses: CoursesService;
    private assets: AssetsService;
    private fetchImpl: OsmFetchImpl;
    private overpassUrl: string;
    private today: () => string;

    constructor(deps: OsmDeps) {
        this.courses = deps.courses;
        this.assets = deps.assets;
        this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
        this.overpassUrl = deps.overpassUrl ?? OVERPASS_URL;
        this.today = deps.today ?? (() => new Date().toISOString().slice(0, 10));
    }

    /**
     * Fetch OSM golf + terrain polygons intersecting the course's map
     * area, typed, reprojected to EPSG:3006 and clipped to the course
     * bbox, each carrying ODbL provenance.
     */
    async fetchForCourse(courseId: string): Promise<OsmFetchResult> {
        const { wgs84, sweref } = await resolveCourseMapBbox(
            this.courses, this.assets, courseId, 'fetch OSM features for',
        );

        const overpassJson = await this.queryOverpass(buildOverpassQuery(wgs84));
        const { polygons, skipped } = assembleOsmPolygons(overpassJson);

        const features: OsmFeaturePolygon[] = [];
        for (const polygon of polygons) {
            const rings3006 = polygon.rings.map(ring => ring.map(([lon, lat]) => {
                const { x, y } = wgs84ToSweref99tm(lat, lon);
                return [x, y];
            }));
            for (const clipped of clipPolygonToBbox(rings3006, sweref)) {
                features.push({
                    type: polygon.type,
                    sourceRef: polygon.sourceRef,
                    // cm precision, as osm.py rounds its output.
                    rings: clipped.map(ring => ring.map(([x, y]) => [
                        Math.round(x * 100) / 100,
                        Math.round(y * 100) / 100,
                    ])),
                });
            }
        }

        return {
            bbox: wgs84,
            source: OSM_SOURCE,
            license: OSM_LICENSE,
            attribution: OSM_ATTRIBUTION,
            fetched: this.today(),
            features,
            skipped,
        };
    }

    /** POST the Overpass QL query; map rate-limit statuses to clear errors. */
    private async queryOverpass(query: string): Promise<{ elements?: OverpassElement[] }> {
        let resp: Awaited<ReturnType<OsmFetchImpl>>;
        try {
            resp = await this.fetchImpl(this.overpassUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': OSM_USER_AGENT,
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `data=${encodeURIComponent(query)}`,
            });
        } catch (e) {
            throw new ConflictError(
                `Overpass request failed: ${e instanceof Error ? e.message : String(e)}. `
                + 'Check the server\'s network connection and try again.',
            );
        }
        if (resp.status === 429) {
            throw new ConflictError(
                'Overpass is rate-limiting requests (HTTP 429) — the public OpenStreetMap '
                + 'API allows only a couple of queries per minute. Wait a minute and try again.',
            );
        }
        if (resp.status === 504) {
            throw new ConflictError(
                'Overpass timed out (HTTP 504) — the public OpenStreetMap API is busy. '
                + 'Try again in a few minutes.',
            );
        }
        if (!resp.ok) {
            throw new ConflictError(`Overpass returned HTTP ${resp.status}`);
        }
        return await resp.json() as { elements?: OverpassElement[] };
    }
}
