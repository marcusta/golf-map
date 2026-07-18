import { test, expect, describe } from 'bun:test';
import { GeojsonImportService, provenanceFromProperties } from '../src/import/geojson-import.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';

// Pipeline-shaped draft (fetch-water convention): EPSG:3006 crs member,
// properties.type per feature. Includes a lake with an island hole, a
// degenerate sliver, an unmappable land-cover value, and a skipped
// LineString.
function square(cx: number, cy: number, half: number): number[][] {
    return [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half],
    ];
}

const GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
    attribution: '© Lantmäteriet, Marktäcke (CC BY 4.0)',
    features: [
        {
            type: 'Feature',
            properties: { type: 'water', source: 'lantmateriet-marktacke' },
            geometry: {
                type: 'Polygon',
                coordinates: [square(531500, 6473000, 100), square(531500, 6473000, 20)],
            },
        },
        {
            type: 'Feature',
            properties: { type: 'water', source: 'lantmateriet-marktacke' },
            geometry: { type: 'Polygon', coordinates: [[[0 + 531000, 6473000], [531001, 6473001], [531000, 6473000]]] },
        },
        {
            type: 'Feature',
            properties: { type: 'water_creek', source: 'lantmateriet-marktacke' },
            geometry: { type: 'Polygon', coordinates: [square(532000, 6474000, 50)] },
        },
        {
            type: 'Feature',
            properties: { type: 'Skogsmark, barr' },
            geometry: { type: 'Polygon', coordinates: [square(533000, 6475000, 50)] },
        },
        {
            type: 'Feature',
            properties: { type: 'water_creek' },
            geometry: { type: 'LineString', coordinates: [[531000, 6473000], [531100, 6473000]] },
        },
    ],
});

function fakeApi(failAfter = Infinity) {
    const created: Array<{ courseId: string; type: string; geometry: unknown }> = [];
    const reject = () => Promise.reject(new Error('not under test'));
    const api: CourseFeaturesApi = {
        listByCourse: reject,
        listByHole: reject,
        geojsonByCourse: reject,
        create: async input => {
            if (created.length >= failAfter) throw new Error('boom');
            created.push(input as never);
            return { id: `f${created.length}`, version: 1, ...input, holeId: null, geojson: null } as CourseFeature;
        },
        update: reject,
        remove: reject,
        reorder: reject,
    };
    return { api, created };
}

function loadedService(failAfter = Infinity) {
    const { api, created } = fakeApi(failAfter);
    const svc = new GeojsonImportService(api);
    svc.openFor('course-1');
    svc.loadGeojsonText(GEOJSON, 'water.geojson');
    return { svc, created };
}

describe('GeojsonImportService', () => {
    test('openFor resets state', () => {
        const svc = new GeojsonImportService(fakeApi().api);
        svc.openFor('c1');
        expect(svc.open.get()).toBe(true);
        expect(svc.parsed.get()).toBeNull();
        expect(svc.propertyKey.get()).toBeNull();
    });

    test('loadGeojsonText parses, buckets by `type`, prefills assignments', () => {
        const { svc } = loadedService();
        expect(svc.parseError.get()).toBeNull();
        expect(svc.propertyKey.get()).toBe('type');
        const buckets = svc.buckets.get();
        expect(buckets.map(b => b.value)).toEqual(['water', 'water_creek', 'Skogsmark, barr']);
        const a = svc.assignments.get();
        expect(a['water']).toBe('water');
        expect(a['water_creek']).toBe('water_creek');
        expect(a['Skogsmark, barr']).toBe('skip'); // no suggestion → skip
        expect(svc.assignedFeatureCount.get()).toBe(3);
    });

    test('loadGeojsonText surfaces parse failures (wrong CRS)', () => {
        const svc = new GeojsonImportService(fakeApi().api);
        svc.openFor('c1');
        const wgs84 = GEOJSON.replace('urn:ogc:def:crs:EPSG::3006', 'urn:ogc:def:crs:OGC:1.3:CRS84');
        svc.loadGeojsonText(wgs84, 'bad.geojson');
        expect(svc.parsed.get()).toBeNull();
        expect(svc.parseError.get()).toMatch(/EPSG:3006/);
    });

    test('assign and setPropertyKey update mapping and invalidate the preview', () => {
        const { svc } = loadedService();
        svc.build();
        expect(svc.built.get()).not.toBeNull();

        svc.assign('Skogsmark, barr', 'trees');
        expect(svc.built.get()).toBeNull(); // stale preview dropped
        expect(svc.assignedFeatureCount.get()).toBe(4);

        svc.build();
        svc.setPropertyKey('source');
        expect(svc.built.get()).toBeNull();
        // Re-binned by source: one bucket, no suggestion → everything skip.
        expect(svc.buckets.get().map(b => b.value)).toEqual(['lantmateriet-marktacke', '(missing)']);
        expect(svc.assignedFeatureCount.get()).toBe(0);
    });

    test('build keeps holes, drops degenerate rings with warnings, carries parse skips', () => {
        const { svc } = loadedService();
        const built = svc.build()!;
        // water: lake (with hole) + degenerate sliver dropped; creek square.
        expect(built.features.length).toBe(2);
        const lake = built.features.find(f => f.type === 'water')!;
        expect(lake.geometry.rings.length).toBe(2); // island hole preserved
        expect(lake.geometry.rings[0].points.length).toBe(4);
        expect(lake.geometry.rings[0].points[0]).toEqual({ x: 531400, y: 6472900 });
        // Warnings: LineString parse skip + degenerate sliver.
        expect(built.warnings.some(w => /LineString/.test(w))).toBe(true);
        expect(built.warnings.some(w => /dropped ring/.test(w))).toBe(true);
    });

    test('confirmImport bulk-creates with per-type counts and clears the preview', async () => {
        const { svc, created } = loadedService();
        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBeNull();
        expect(summary.created).toEqual({ water: 1, water_creek: 1 });
        expect(created.length).toBe(2);
        expect(created.every(c => c.courseId === 'course-1')).toBe(true);
        expect(svc.built.get()).toBeNull();
        expect(svc.importing.get()).toBe(false);
        expect(svc.progress.get()).toEqual({ done: 2, total: 2 });
    });

    test('confirmImport aborts on failure, keeps partial counts, sets error', async () => {
        const { svc, created } = loadedService(1); // fail after 1 create
        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBe('boom');
        expect(Object.values(summary.created).reduce((a, b) => a + b, 0)).toBe(1);
        expect(created.length).toBe(1);
        expect(svc.importing.get()).toBe(false);
    });

    test('close hides the wizard and drops the preview', () => {
        const { svc } = loadedService();
        svc.build();
        svc.close();
        expect(svc.open.get()).toBe(false);
        expect(svc.built.get()).toBeNull();
    });
});

// T49 — durable provenance: the wizard forwards source/sourceRef/license to
// the create API so licensing survives past the import file (fetch-osm output
// is ODbL).
describe('GeojsonImportService provenance (T49)', () => {
    const OSM_GEOJSON = JSON.stringify({
        type: 'FeatureCollection',
        crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
        attribution: '© OpenStreetMap contributors, ODbL (opendatacommons.org/licenses/odbl)',
        features: [
            {
                type: 'Feature',
                // fetch-osm property shape (pipeline/golfpipe/osm.py): no
                // per-feature `license` — the wizard defaults osm → ODbL.
                properties: { type: 'green', source: 'osm', osm_type: 'way', osm_id: 123456, fetched: '2026-07-18' },
                geometry: { type: 'Polygon', coordinates: [square(531500, 6473000, 20)] },
            },
            {
                type: 'Feature',
                properties: { type: 'water', source: 'osm', osm_type: 'relation', osm_id: 42, fetched: '2026-07-18' },
                geometry: { type: 'Polygon', coordinates: [square(532000, 6474000, 50)] },
            },
        ],
    });

    test('provenanceFromProperties maps osm properties and defaults ODbL', () => {
        expect(provenanceFromProperties({ source: 'osm', osm_type: 'way', osm_id: 123456 }))
            .toEqual({ source: 'osm', sourceRef: 'way/123456', license: 'ODbL' });
        // Explicit license wins over the osm default.
        expect(provenanceFromProperties({ source: 'osm', osm_id: 7, license: 'CC0' }))
            .toEqual({ source: 'osm', sourceRef: '7', license: 'CC0' });
        // Non-osm sources get no license default.
        expect(provenanceFromProperties({ source: 'lantmateriet-marktacke' }))
            .toEqual({ source: 'lantmateriet-marktacke' });
        // Hand-shaped files without provenance stay clean.
        expect(provenanceFromProperties({ type: 'water' })).toEqual({});
    });

    test('confirmImport forwards osm provenance on every create', async () => {
        const { api, created } = fakeApi();
        const svc = new GeojsonImportService(api);
        svc.openFor('course-1');
        svc.loadGeojsonText(OSM_GEOJSON, 'osm.geojson');
        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBeNull();
        expect(created.length).toBe(2);
        const green = created.find(c => c.type === 'green') as Record<string, unknown>;
        expect(green.source).toBe('osm');
        expect(green.sourceRef).toBe('way/123456');
        expect(green.license).toBe('ODbL');
        const water = created.find(c => c.type === 'water') as Record<string, unknown>;
        expect(water.sourceRef).toBe('relation/42');
    });

    test('non-osm sources import without a license; missing provenance stays undefined', async () => {
        const { svc, created } = loadedService();
        await svc.confirmImport();
        // Fixture water features carry source but no license property.
        const water = created.find(c => c.type === 'water') as Record<string, unknown>;
        expect(water.source).toBe('lantmateriet-marktacke');
        expect(water.license).toBeUndefined();
        expect(water.sourceRef).toBeUndefined();
    });
});
