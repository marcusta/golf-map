// The GeoJSON import's build, shared by the wizard (geojson-import.service.ts)
// and `bun run water:import`: source properties → provenance/attributes, a
// Hydrografi fetch → the typed collection, the bucket mapping → built
// features (each with a pick key), which of them a course already has, and
// which one a map click lands on. Pure: no API client, no DOM.

import type { HydroFetchResult } from '../../../shared/api/hydro.gen';
import type { BucketAssignment, BuiltFeature, BuildResult } from './svg-import.service';
import { PATH_SURFACE_ATTRIBUTE, isPathSurface } from '../../../shared/features/path-surface';
import { bufferPolyline } from '../geo/polyline-buffer';
import { pointInRing } from '../geo/bezier';
import {
    IMPORTED_CORNER_TURN_DEG,
    autoCorners,
    centerlineGeometry,
    type FeatureCenterline,
} from '../../../shared/features/centerline';
import { polygonToGeometry, type ParsedGeojson, type GeojsonBucket } from './geojson-parse';

/**
 * Durable provenance (T49): map a source feature's properties onto the
 * create API's provenance fields. fetch-osm output carries
 * `source: "osm"` + `osm_type`/`osm_id` (see pipeline/golfpipe/osm.py);
 * OSM data is ODbL, so when the file lacks an explicit `license` property
 * an `osm` source defaults to 'ODbL'. An explicit `source_ref` property
 * (T50: the Lantmäteriet fetch path stamps the OGC feature id) wins over
 * the OSM composite.
 */
export function provenanceFromProperties(
    props: Record<string, unknown>,
): { source?: string; sourceRef?: string; license?: string } {
    const source = typeof props['source'] === 'string' ? (props['source'] as string) : undefined;

    let sourceRef: string | undefined;
    if (typeof props['source_ref'] === 'string') {
        sourceRef = props['source_ref'] as string;
    } else {
        const osmId = props['osm_id'];
        if (typeof osmId === 'string' || typeof osmId === 'number') {
            const osmType = props['osm_type'];
            sourceRef = typeof osmType === 'string' ? `${osmType}/${osmId}` : String(osmId);
        }
    }

    let license = typeof props['license'] === 'string' ? (props['license'] as string) : undefined;
    if (license === undefined && source === 'osm') license = 'ODbL';

    const result: { source?: string; sourceRef?: string; license?: string } = {};
    if (source !== undefined) result.source = source;
    if (sourceRef !== undefined) result.sourceRef = sourceRef;
    if (license !== undefined) result.license = license;
    return result;
}

/**
 * The attributes a source feature brings along for the type it is imported
 * as: a `path` keeps a valid `surface` property (fetch-roads writes one from
 * NVDB / the OSM surface tag). Everything else stays a source property only.
 * Null when there is nothing to carry. Pure — exported for tests.
 */
export function attributesFromProperties(type: string, props: Record<string, unknown>): Record<string, string> | null {
    if (type === 'path' && isPathSurface(props[PATH_SURFACE_ATTRIBUTE])) {
        return { [PATH_SURFACE_ATTRIBUTE]: props[PATH_SURFACE_ATTRIBUTE] as string };
    }
    return null;
}

/**
 * A fetch-roads corridor that is ONE way's carries that way's clipped
 * `centerline` ([[x, y], …], EPSG:3006) and `widthM`; such a road is
 * imported as a centerline feature — the line is the shape, the corridor is
 * derived — so moving it later is moving one line. Bends of
 * IMPORTED_CORNER_TURN_DEG or more are corners (the pipeline's own rule).
 * Null when the properties carry no usable line (the polygon is imported
 * instead). Pure — exported for tests.
 */
export function centerlineFromProperties(props: Record<string, unknown>): FeatureCenterline | null {
    const line = props['centerline'];
    const widthM = props['widthM'];
    if (!Array.isArray(line) || typeof widthM !== 'number') return null;
    const points: Array<{ x: number; y: number }> = [];
    for (const c of line) {
        if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
        points.push({ x: c[0] as number, y: c[1] as number });
    }
    const centerline = { points: autoCorners(points, IMPORTED_CORNER_TURN_DEG), widthM };
    return centerlineGeometry('EPSG:3006', centerline) ? centerline : null;
}

/** Wizard-facing filename for the one-click Lantmäteriet fetch (T50). */
export const HYDRO_FETCH_FILENAME = 'lantmateriet-hydrografi.geojson';

/**
 * Per call, the next ref for a part: a ref that occurs once stays as it is,
 * one that occurs more often gets `#1`, `#2`… in order. Null stays null.
 */
function numberParts(refs: ReadonlyArray<string | null>): (ref: string | null) => string | null {
    const total = new Map<string, number>();
    for (const r of refs) if (r !== null) total.set(r, (total.get(r) ?? 0) + 1);
    const seen = new Map<string, number>();
    return ref => {
        if (ref === null || (total.get(ref) ?? 0) < 2) return ref;
        const n = (seen.get(ref) ?? 0) + 1;
        seen.set(ref, n);
        return `${ref}#${n}`;
    };
}

/**
 * Format a fetch-hydro response as the pipeline-shaped GeoJSON document the
 * wizard already understands (EPSG:3006 crs member, `properties.type` per
 * feature, provenance properties per T49): water polygons pass through,
 * creek centerlines are buffered into `water_creek` ribbons of the
 * suggested width. Pure — exported for tests.
 */
export function hydroToFeatureCollection(result: HydroFetchResult): {
    type: 'FeatureCollection';
    crs: { type: 'name'; properties: { name: string } };
    attribution: string;
    features: unknown[];
} {
    const features: unknown[] = [];
    // A source shape split into parts (a MultiPolygon, or cut by the map's
    // edge) numbers its parts `<ref>#1`, `#2`…, so each part is picked and
    // recognised as imported on its own.
    const partRef = numberParts([...result.water.map(w => w.sourceRef), ...result.creeks.map(c => c.sourceRef)]);
    const properties = (type: string, sourceRef: string | null) => ({
        type,
        source: result.source,
        ...(sourceRef !== null ? { source_ref: sourceRef } : {}),
    });

    for (const water of result.water) {
        features.push({
            type: 'Feature',
            properties: properties('water', partRef(water.sourceRef)),
            geometry: { type: 'Polygon', coordinates: water.rings },
        });
    }
    for (const creek of result.creeks) {
        const ring = bufferPolyline(creek.points, result.suggestedCreekWidthM);
        if (!ring) continue; // degenerate centerline run — nothing to import
        features.push({
            type: 'Feature',
            // The line rides along as `centerline` + `widthM`, so the wizard
            // imports the creek as a centerline feature (like a fetched road):
            // the creek digs and the R.A.M. export follow its line, and it
            // edits as one line with a width. The ribbon is the preview shape.
            properties: { ...properties('water_creek', partRef(creek.sourceRef)), centerline: creek.points, widthM: result.suggestedCreekWidthM },
            geometry: { type: 'Polygon', coordinates: [ring] },
        });
    }

    return {
        type: 'FeatureCollection',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
        attribution: result.attribution,
        features,
    };
}

/**
 * Build features from the bucket mapping: every polygon of every assigned
 * bucket, a road/creek with a `centerline` as a centerline feature. Each
 * gets `key` — `<feature index>` or `<feature index>.<polygon index>` in
 * the file — so a pick survives a re-build. Degenerate rings are dropped
 * with warnings; parse-time skips are carried into the warnings too.
 */
export function buildFeatures(
    parsed: ParsedGeojson,
    buckets: GeojsonBucket[],
    assignments: Record<string, BucketAssignment>,
): BuildResult {
    const features: BuiltFeature[] = [];
    const warnings: string[] = [...parsed.skipped];
    for (const bucket of buckets) {
        const type = assignments[bucket.key];
        if (!type || type === 'skip') continue;
        for (const feature of bucket.features) {
            const provenance = provenanceFromProperties(feature.properties);
            const attributes = attributesFromProperties(type, feature.properties);
            const centerline = centerlineFromProperties(feature.properties);
            const lineGeometry = centerline ? centerlineGeometry('EPSG:3006', centerline) : null;
            if (lineGeometry) {
                features.push({ key: `${feature.index}`, type, geometry: lineGeometry, ...provenance, ...(attributes ? { attributes } : {}) });
                continue;
            }
            feature.polygons.forEach((rings, polyIdx) => {
                const label = `${bucket.value} feature ${feature.index + 1}${feature.polygons.length > 1 ? `.${polyIdx + 1}` : ''}`;
                const { geometry, warnings: ringWarnings } = polygonToGeometry(rings, label, {
                    exact: feature.properties['exact'] === true,
                });
                warnings.push(...ringWarnings);
                if (geometry) {
                    features.push({ key: `${feature.index}.${polyIdx}`, type, geometry, ...provenance, ...(attributes ? { attributes } : {}) });
                }
            });
        }
    }
    return { features, warnings };
}

/** `source` + `sourceRef` as one set key. */
export function importedRefKey(source: string, sourceRef: string): string {
    return `${source}\u0000${sourceRef}`;
}

/** The (source, sourceRef) keys of a course's features — what is already imported. */
export function importedRefs(features: ReadonlyArray<{ source: string | null; sourceRef: string | null }>): Set<string> {
    const refs = new Set<string>();
    for (const f of features) if (f.source && f.sourceRef) refs.add(importedRefKey(f.source, f.sourceRef));
    return refs;
}

/**
 * True when the course already has this source shape. A part of a split
 * shape (`…#2`) also counts as imported when the whole ref is on the course:
 * imports from before the parts were numbered stored the bare ref.
 */
export function alreadyImported(f: { source?: string; sourceRef?: string }, refs: ReadonlySet<string>): boolean {
    if (!f.source || !f.sourceRef) return false;
    if (refs.has(importedRefKey(f.source, f.sourceRef))) return true;
    const hash = f.sourceRef.lastIndexOf('#');
    return hash > 0 && refs.has(importedRefKey(f.source, f.sourceRef.slice(0, hash)));
}

/** Shoelace area of a ring (any units, unsigned). */
function ringArea(ring: ReadonlyArray<readonly number[]>): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return Math.abs(a / 2);
}

/**
 * Index of the shape a click at `p` lands on: inside its outer ring and not
 * in one of its holes; of several, the smallest (a pond on an island of a
 * lake picks the pond). -1 for none. `shapes` are closed rings in the same
 * coordinates as `p`, outer ring first.
 */
export function shapeAt(shapes: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly number[]>>>, p: { x: number; y: number }): number {
    let best = -1;
    let bestArea = Infinity;
    shapes.forEach((rings, i) => {
        const [outer, ...holes] = rings;
        if (!outer || !pointInRing(p, outer as ReadonlyArray<readonly [number, number]>)) return;
        if (holes.some(h => pointInRing(p, h as ReadonlyArray<readonly [number, number]>))) return;
        const area = ringArea(outer);
        if (area < bestArea) { best = i; bestArea = area; }
    });
    return best;
}
