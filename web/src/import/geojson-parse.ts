// GeoJSON parsing for the draft-import wizard (T43). Source-agnostic
// plumbing shared by every pipeline draft generator (fetch-water, fetch-osm,
// detect-trees) — anything that emits an EPSG:3006 FeatureCollection of
// typed polygons can be imported through it.
//
// Pure functions, no app state. The pipeline is:
//
//   1. `parseGeojsonDocument(text)` — JSON.parse + structure/CRS validation.
//      Only EPSG:3006 (SWEREF99 TM) is accepted: a `crs` member naming any
//      other CRS is rejected, and when the member is absent the coordinates
//      themselves are sanity-checked (lon/lat-degree-looking files and
//      out-of-range projected files are rejected with a clear message).
//      Polygon/MultiPolygon features are kept (MultiPolygons exploded into
//      per-polygon ring sets, holes preserved); other geometry types are
//      skipped with a note.
//   2. `bucketByProperty(parsed, key)` — bins features by the value of a
//      chosen property (the wizard default is `type`, the pipeline output
//      convention). Buckets carry a `suggestedType` when the value matches
//      a FEATURE_TYPE (exactly, or via the svg-import name tokens).
//   3. `polygonToGeometry(rings)` — one polygon's rings → a straight-
//      segment bezier FeatureGeometry (corner anchors, no handles; lines
//      arrive pre-buffered from the pipeline, so no buffering here).

import type { AnchorPoint, FeatureGeometry } from '../geo/bezier';
import { FEATURE_TYPES, type FeatureType } from '../draw/feature-palette';
import { suggestType } from './svg-parse';

/** One importable source feature (Polygon or exploded MultiPolygon part). */
export interface GeojsonImportFeature {
    /** Index in the source FeatureCollection (for warnings). */
    index: number;
    properties: Record<string, unknown>;
    /** Polygon ring sets: [polygon][ring][vertex][x, y]. rings[0] = outer. */
    polygons: number[][][][];
}

export interface ParsedGeojson {
    features: GeojsonImportFeature[];
    /** Candidate bucketing keys (primitive-valued), 'type' first. */
    propertyKeys: string[];
    /** Feature count in the source collection (incl. skipped ones). */
    totalFeatures: number;
    /** Parse-time skips (unsupported geometry types etc.), human-readable. */
    skipped: string[];
}

/** One import-mapping row: all features sharing a property value. */
export interface GeojsonBucket {
    /** Stable key for assignment maps: the property value (or sentinel). */
    key: string;
    /** Display value ('(missing)' when the property is absent). */
    value: string;
    suggestedType: FeatureType | null;
    features: GeojsonImportFeature[];
    /** Total polygons across the bucket = features `build()` would create. */
    polygonCount: number;
}

/** Bucket key/value used for features missing the chosen property. */
export const MISSING_VALUE = '(missing)';

// Generous EPSG:3006 (SWEREF99 TM) coordinate sanity bounds, metres. The
// official extent is E ~181k–925k, N ~6.09M–7.69M; the slack tolerates
// buffered geometry poking past it without accepting lon/lat degrees.
const SWEREF_X_MIN = -100_000;
const SWEREF_X_MAX = 1_500_000;
const SWEREF_Y_MIN = 5_500_000;
const SWEREF_Y_MAX = 8_000_000;

function crsName(data: Record<string, unknown>): string | null {
    const crs = data['crs'];
    if (!crs || typeof crs !== 'object') return null;
    const props = (crs as { properties?: unknown }).properties;
    if (!props || typeof props !== 'object') return null;
    const name = (props as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
}

/** Extract the EPSG code from a `crs` member name (urn or `EPSG:nnnn`). */
export function crsEpsgCode(name: string): number | null {
    const match = /(?:EPSG|epsg)\s*:*\s*(\d+)\s*$/.exec(name.trim());
    return match ? parseInt(match[1], 10) : null;
}

function firstPosition(polygons: number[][][][]): number[] | null {
    return polygons[0]?.[0]?.[0] ?? null;
}

/**
 * Parse a GeoJSON FeatureCollection (or single Feature) into importable
 * polygon features. Throws with a clear message when the text is not
 * GeoJSON or is not in EPSG:3006.
 */
export function parseGeojsonDocument(text: string): ParsedGeojson {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('Not valid JSON');
    }
    if (!data || typeof data !== 'object') throw new Error('Not a GeoJSON object');
    const root = data as Record<string, unknown>;

    let rawFeatures: unknown[];
    if (root['type'] === 'FeatureCollection') {
        if (!Array.isArray(root['features'])) throw new Error('FeatureCollection has no features array');
        rawFeatures = root['features'];
    } else if (root['type'] === 'Feature') {
        rawFeatures = [root];
    } else {
        throw new Error(`Unsupported GeoJSON type: ${String(root['type'])} (expected FeatureCollection)`);
    }

    const declaredCrs = crsName(root);
    if (declaredCrs !== null) {
        const code = crsEpsgCode(declaredCrs);
        if (code !== 3006) {
            throw new Error(`GeoJSON CRS is ${declaredCrs} — EPSG:3006 (SWEREF99 TM) required`);
        }
    }

    const features: GeojsonImportFeature[] = [];
    const skipped: string[] = [];
    const skippedTypeCounts = new Map<string, number>();

    rawFeatures.forEach((raw, index) => {
        if (!raw || typeof raw !== 'object') return;
        const feature = raw as { geometry?: { type?: string; coordinates?: unknown } | null; properties?: unknown };
        const geometry = feature.geometry;
        const gtype = geometry?.type;
        const properties =
            feature.properties && typeof feature.properties === 'object'
                ? (feature.properties as Record<string, unknown>)
                : {};

        let polygons: number[][][][];
        if (gtype === 'Polygon') {
            polygons = [geometry!.coordinates as number[][][]];
        } else if (gtype === 'MultiPolygon') {
            polygons = geometry!.coordinates as number[][][][];
        } else {
            const label = gtype ?? 'no geometry';
            skippedTypeCounts.set(label, (skippedTypeCounts.get(label) ?? 0) + 1);
            return;
        }
        polygons = polygons.filter(rings => Array.isArray(rings) && rings.length > 0);
        if (polygons.length === 0) return;
        features.push({ index, properties, polygons });
    });

    for (const [gtype, count] of skippedTypeCounts) {
        skipped.push(`${count} ${gtype} feature(s) skipped — only Polygon/MultiPolygon import`);
    }
    if (features.length === 0) throw new Error('No Polygon/MultiPolygon features found');

    // Without a crs member, sanity-check the coordinates themselves.
    if (declaredCrs === null) {
        const sample = firstPosition(features[0].polygons);
        if (sample) {
            const [x, y] = sample;
            if (Math.abs(x) <= 180 && Math.abs(y) <= 90) {
                throw new Error('Coordinates look like WGS84 lon/lat degrees — EPSG:3006 (SWEREF99 TM) metres required');
            }
            if (x < SWEREF_X_MIN || x > SWEREF_X_MAX || y < SWEREF_Y_MIN || y > SWEREF_Y_MAX) {
                throw new Error(`Coordinates (${x}, ${y}) are outside the EPSG:3006 (SWEREF99 TM) range`);
            }
        }
    }

    // Candidate bucketing keys: primitive-valued property keys by frequency,
    // with the pipeline convention `type` always first when present.
    const keyCounts = new Map<string, number>();
    for (const feature of features) {
        for (const [key, value] of Object.entries(feature.properties)) {
            const t = typeof value;
            if (t === 'string' || t === 'number' || t === 'boolean') {
                keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
            }
        }
    }
    const propertyKeys = Array.from(keyCounts.keys()).sort((a, b) => {
        if (a === 'type') return -1;
        if (b === 'type') return 1;
        return (keyCounts.get(b) ?? 0) - (keyCounts.get(a) ?? 0);
    });

    return { features, propertyKeys, totalFeatures: rawFeatures.length, skipped };
}

/** Suggested feature type for a bucket value (exact match, then tokens). */
function suggestBucketType(value: string): FeatureType | null {
    if ((FEATURE_TYPES as readonly string[]).includes(value)) return value as FeatureType;
    return suggestType(null, value, null);
}

/**
 * Bin parsed features by a property value. `property` null (no usable
 * keys) puts everything in one unsuggested bucket.
 */
export function bucketByProperty(parsed: ParsedGeojson, property: string | null): GeojsonBucket[] {
    const buckets = new Map<string, GeojsonBucket>();
    for (const feature of parsed.features) {
        const raw = property === null ? undefined : feature.properties[property];
        const value = raw === undefined || raw === null ? MISSING_VALUE : String(raw);
        let bucket = buckets.get(value);
        if (!bucket) {
            bucket = {
                key: value,
                value,
                suggestedType: property === null || value === MISSING_VALUE ? null : suggestBucketType(value),
                features: [],
                polygonCount: 0,
            };
            buckets.set(value, bucket);
        }
        bucket.features.push(feature);
        bucket.polygonCount += feature.polygons.length;
    }
    return Array.from(buckets.values());
}

/** Positions closer than this (metres) are treated as the same vertex. */
const CLOSE_EPS_M = 1e-6;

/**
 * One polygon's rings → a straight-segment bezier FeatureGeometry: every
 * vertex becomes a plain corner anchor (no handles), the GeoJSON closing
 * vertex is dropped (the draw model's rings are implicitly closed).
 * Degenerate rings (< 3 distinct vertices) are dropped with a warning; a
 * degenerate OUTER ring drops the whole polygon (geometry = null).
 */
export function polygonToGeometry(
    rings: number[][][],
    label: string,
): { geometry: FeatureGeometry | null; warnings: string[] } {
    const warnings: string[] = [];
    const outRings: Array<{ points: AnchorPoint[] }> = [];

    rings.forEach((ring, ringIdx) => {
        const points: AnchorPoint[] = ring.map(([x, y]) => ({ x, y }));
        const first = points[0];
        const last = points[points.length - 1];
        if (points.length >= 2 && Math.hypot(last.x - first.x, last.y - first.y) < CLOSE_EPS_M) {
            points.pop(); // GeoJSON explicit closure
        }
        if (points.length < 3) {
            warnings.push(`${label}${ringIdx > 0 ? ` hole ${ringIdx}` : ''}: dropped ring with ${points.length} point(s)`);
            return;
        }
        if (ringIdx > 0 && outRings.length === 0) return; // outer already dropped
        outRings.push({ points });
    });

    if (outRings.length === 0) return { geometry: null, warnings };
    return { geometry: { crs: 'EPSG:3006', rings: outRings }, warnings };
}
