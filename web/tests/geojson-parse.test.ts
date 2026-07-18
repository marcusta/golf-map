import { test, expect, describe } from 'bun:test';
import {
    parseGeojsonDocument,
    bucketByProperty,
    polygonToGeometry,
    importControlCap,
    IMPORT_FIT_TOLERANCE_M,
    IMPORT_MIN_CONTROLS,
    IMPORT_MAX_CONTROLS,
    crsEpsgCode,
    MISSING_VALUE,
} from '../src/import/geojson-parse';
import { flattenRing, type PathRing, type Point } from '../src/geo/bezier';

const CRS_3006 = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } };

// A ~course-sized square near Linköping, EPSG:3006 metres.
function square(cx: number, cy: number, half: number): number[][] {
    return [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half], // GeoJSON explicit closure
    ];
}

function fc(features: unknown[], extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ type: 'FeatureCollection', crs: CRS_3006, ...extra, features });
}

const WATER = {
    type: 'Feature',
    properties: { type: 'water', source: 'lantmateriet-marktacke' },
    geometry: { type: 'Polygon', coordinates: [square(531500, 6473000, 100)] },
};
const CREEK = {
    type: 'Feature',
    properties: { type: 'water_creek', source: 'lantmateriet-marktacke' },
    geometry: { type: 'Polygon', coordinates: [square(532000, 6474000, 50)] },
};
const LINE = {
    type: 'Feature',
    properties: { type: 'water_creek' },
    geometry: { type: 'LineString', coordinates: [[531000, 6473000], [531100, 6473000]] },
};

describe('parseGeojsonDocument', () => {
    test('parses features, explodes MultiPolygons, skips non-polygons with a note', () => {
        const multi = {
            type: 'Feature',
            properties: { type: 'water' },
            geometry: {
                type: 'MultiPolygon',
                coordinates: [[square(531000, 6473000, 50)], [square(533000, 6475000, 50)]],
            },
        };
        const parsed = parseGeojsonDocument(fc([WATER, CREEK, LINE, multi]));
        expect(parsed.totalFeatures).toBe(4);
        expect(parsed.features.length).toBe(3); // LINE skipped
        expect(parsed.features[2].polygons.length).toBe(2); // exploded
        expect(parsed.skipped).toEqual(['1 LineString feature(s) skipped — only Polygon/MultiPolygon import']);
    });

    test('property keys are primitive-valued, type first', () => {
        const parsed = parseGeojsonDocument(fc([WATER, CREEK]));
        expect(parsed.propertyKeys).toEqual(['type', 'source']);
    });

    test('rejects non-3006 crs member with a clear message', () => {
        const wgs84 = { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } };
        expect(() => parseGeojsonDocument(fc([WATER], { crs: wgs84 }))).toThrow(/EPSG:3006/);
    });

    test('accepts EPSG:3006 declared in plain form', () => {
        const plain = { type: 'name', properties: { name: 'EPSG:3006' } };
        expect(parseGeojsonDocument(fc([WATER], { crs: plain })).features.length).toBe(1);
    });

    test('without crs member: rejects lon/lat-looking and out-of-range coords', () => {
        const lonlat = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[15.5, 58.4], [15.6, 58.4], [15.6, 58.5], [15.5, 58.4]]] },
        };
        expect(() => parseGeojsonDocument(JSON.stringify({ type: 'FeatureCollection', features: [lonlat] })))
            .toThrow(/lon\/lat/);

        const mercator = {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[1730000, 8100000], [1730100, 8100000], [1730100, 8100100], [1730000, 8100000]]] },
        };
        expect(() => parseGeojsonDocument(JSON.stringify({ type: 'FeatureCollection', features: [mercator] })))
            .toThrow(/outside the EPSG:3006/);
    });

    test('without crs member: accepts plausible SWEREF99 TM coords', () => {
        const bare = JSON.stringify({ type: 'FeatureCollection', features: [WATER] });
        expect(parseGeojsonDocument(bare).features.length).toBe(1);
    });

    test('rejects junk: invalid JSON, wrong root type, no polygons', () => {
        expect(() => parseGeojsonDocument('nope{')).toThrow(/valid JSON/);
        expect(() => parseGeojsonDocument('{"type":"GeometryCollection"}')).toThrow(/Unsupported GeoJSON type/);
        expect(() => parseGeojsonDocument(fc([LINE]))).toThrow(/No Polygon/);
    });

    test('accepts a single bare Feature', () => {
        expect(parseGeojsonDocument(JSON.stringify({ ...WATER, crs: CRS_3006 })).features.length).toBe(1);
    });
});

describe('bucketByProperty', () => {
    test('bins by value with polygon counts and suggestions', () => {
        const parsed = parseGeojsonDocument(fc([WATER, WATER, CREEK]));
        const buckets = bucketByProperty(parsed, 'type');
        expect(buckets.map(b => [b.value, b.polygonCount, b.suggestedType])).toEqual([
            ['water', 2, 'water'],
            ['water_creek', 1, 'water_creek'],
        ]);
    });

    test('suggests via svg-import name tokens when not an exact type', () => {
        const pond = { ...WATER, properties: { type: 'pond' } };
        const parsed = parseGeojsonDocument(fc([pond]));
        expect(bucketByProperty(parsed, 'type')[0].suggestedType).toBe('water');
    });

    test('missing property → sentinel bucket without suggestion; null property → one bucket', () => {
        const untyped = { ...WATER, properties: {} };
        const parsed = parseGeojsonDocument(fc([WATER, untyped]));
        const buckets = bucketByProperty(parsed, 'type');
        expect(buckets.map(b => b.value).sort()).toEqual([MISSING_VALUE, 'water'].sort());
        expect(buckets.find(b => b.value === MISSING_VALUE)!.suggestedType).toBeNull();

        const all = bucketByProperty(parsed, null);
        expect(all.length).toBe(1);
        expect(all[0].polygonCount).toBe(2);
        expect(all[0].suggestedType).toBeNull();
    });
});

// --- T52: imported rings land as smooth b-splines -----------------------

/** Closed angular ring from a polar radius function (GeoJSON closure appended). */
function polarRing(
    r: (theta: number) => number,
    n: number,
    cx = 531500,
    cy = 6473000,
): number[][] {
    const ring: number[][] = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI;
        ring.push([cx + r(t) * Math.cos(t), cy + r(t) * Math.sin(t)]);
    }
    ring.push([...ring[0]]); // explicit GeoJSON closure
    return ring;
}

/** Max distance from each source vertex to the flattened fitted ring. */
function maxVertexDeviation(source: number[][], fitted: PathRing): number {
    const flat = flattenRing({ points: fitted.points.map(p => ({ ...p })) }, 0.02, 'bspline');
    let worst = 0;
    for (const [x, y] of source.slice(0, -1)) {
        worst = Math.max(worst, distToClosed({ x, y }, flat));
    }
    return worst;
}

function distToClosed(p: Point, poly: Array<[number, number]>): number {
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % poly.length];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy)));
    }
    return best;
}

describe('polygonToGeometry (T52: fitted b-splines)', () => {
    test('an angular pond lands as a smooth bspline within tolerance of its vertices', () => {
        // Generalized-shoreline stand-in: a 12-gon, radius 40 m.
        const source = polarRing(() => 40, 12);
        const { geometry, warnings } = polygonToGeometry([source], 'water feature 1');
        expect(warnings).toEqual([]);
        expect(geometry!.crs).toBe('EPSG:3006');
        expect(geometry!.curveType).toBe('bspline');
        // Smooth controls: no handles, no corner flags.
        for (const p of geometry!.rings[0].points) {
            expect(p.hIn).toBeUndefined();
            expect(p.hOut).toBeUndefined();
            expect(p.corner).toBeUndefined();
        }
        expect(maxVertexDeviation(source, geometry!.rings[0])).toBeLessThanOrEqual(IMPORT_FIT_TOLERANCE_M);
    });

    test('holes are fitted too and preserved (closing vertex dropped)', () => {
        const outer = square(0, 0, 100);
        const hole = polarRing(() => 20, 10, 0, 0);
        const { geometry, warnings } = polygonToGeometry([outer, hole], 'water feature 1');
        expect(warnings).toEqual([]);
        expect(geometry!.rings.length).toBe(2);
        for (const ring of geometry!.rings) {
            expect(ring.points.length).toBeGreaterThanOrEqual(8);
            for (const p of ring.points) expect(p.corner).toBeUndefined();
        }
        expect(maxVertexDeviation(hole, geometry!.rings[1])).toBeLessThanOrEqual(IMPORT_FIT_TOLERANCE_M);
    });

    test('importControlCap scales with perimeter, clamped', () => {
        expect(importControlCap(50)).toBe(IMPORT_MIN_CONTROLS);
        expect(importControlCap(100)).toBe(10);
        expect(importControlCap(1000)).toBe(100);
        expect(importControlCap(1e6)).toBe(IMPORT_MAX_CONTROLS);
    });

    test('a long wiggly shoreline gets more controls than the trace cap of 20', () => {
        // ~950 m shoreline with 10 m lobes — needs the perimeter-scaled cap.
        const long = polarRing(t => 150 + 10 * Math.sin(12 * t), 240);
        const small = polarRing(() => 25, 10);
        const longGeom = polygonToGeometry([long], 'creek').geometry!;
        const smallGeom = polygonToGeometry([small], 'pond').geometry!;
        expect(longGeom.rings[0].points.length).toBeGreaterThan(20);
        expect(smallGeom.rings[0].points.length).toBeLessThanOrEqual(20);
        expect(maxVertexDeviation(long, longGeom.rings[0])).toBeLessThanOrEqual(IMPORT_FIT_TOLERANCE_M);
    });

    test('a ring the fitter cannot use falls back to exact corner controls', () => {
        // 3 points, two coincident: survives the <3-point drop, but the
        // fitter dedupes to 2 distinct points and reports an unusable fit.
        const sliver = [[531000, 6473000], [531000, 6473000], [531002, 6473001], [531000, 6473000]];
        const { geometry, warnings } = polygonToGeometry([sliver], 'water feature 2');
        expect(warnings).toEqual([]);
        expect(geometry).not.toBeNull(); // never dropped for fit reasons
        expect(geometry!.curveType).toBe('bspline');
        const points = geometry!.rings[0].points;
        expect(points.map(p => [p.x, p.y])).toEqual(sliver.slice(0, -1));
        // All-corner controls render exactly the source polygon.
        for (const p of points) expect(p.corner).toBe(true);
    });

    test('degenerate hole is dropped with a warning, outer survives', () => {
        const { geometry, warnings } = polygonToGeometry(
            [square(0, 0, 100), [[0, 0], [1, 1], [0, 0]]],
            'water feature 2',
        );
        expect(geometry!.rings.length).toBe(1);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toMatch(/hole 1/);
    });

    test('degenerate outer ring drops the whole polygon', () => {
        const { geometry, warnings } = polygonToGeometry([[[0, 0], [1, 1], [0, 0]]], 'water feature 3');
        expect(geometry).toBeNull();
        expect(warnings.length).toBe(1);
    });
});

describe('crsEpsgCode', () => {
    test('urn and plain forms', () => {
        expect(crsEpsgCode('urn:ogc:def:crs:EPSG::3006')).toBe(3006);
        expect(crsEpsgCode('EPSG:3006')).toBe(3006);
        expect(crsEpsgCode('urn:ogc:def:crs:OGC:1.3:CRS84')).toBeNull();
    });
});
