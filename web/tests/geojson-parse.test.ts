import { test, expect, describe } from 'bun:test';
import {
    parseGeojsonDocument,
    bucketByProperty,
    polygonToGeometry,
    crsEpsgCode,
    MISSING_VALUE,
} from '../src/import/geojson-parse';

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

describe('polygonToGeometry', () => {
    test('drops the closing vertex, holes become extra rings', () => {
        const { geometry, warnings } = polygonToGeometry(
            [square(0, 0, 100), square(0, 0, 20)],
            'water feature 1',
        );
        expect(warnings).toEqual([]);
        expect(geometry!.crs).toBe('EPSG:3006');
        expect(geometry!.curveType).toBeUndefined(); // bezier default
        expect(geometry!.rings.length).toBe(2);
        expect(geometry!.rings[0].points.length).toBe(4); // closure dropped
        // Straight segments: corner anchors, no handles.
        for (const p of geometry!.rings[0].points) {
            expect(p.hIn).toBeUndefined();
            expect(p.hOut).toBeUndefined();
        }
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
