import { test, expect, describe } from 'bun:test';
import {
    GeojsonImportService,
    provenanceFromProperties,
    hydroToFeatureCollection,
    osmToFeatureCollection,
    HYDRO_FETCH_FILENAME,
    OSM_FETCH_FILENAME,
    ROADS_FETCH_FILENAME,
    importGroups,
    attributesFromProperties,
    centerlineFromProperties,
} from '../src/import/geojson-import.service';
import { alreadyImported, importedRefs, shapeAt } from '../src/import/geojson-build';
import type { HydroApi, HydroFetchResult } from '../../shared/api/hydro.gen';
import type { OsmApi, OsmFetchResult } from '../../shared/api/osm.gen';
import type { TerrainGeneratorsApi, RoadsFetchResult, RoadsFetchJob } from '../../shared/api/terrain-generators.gen';
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
            return { id: `f${created.length}`, version: 1, ...input, holeId: null } as CourseFeature;
        },
        update: reject,
        remove: reject,
        reorder: reject,
        imported: async () => [],
        removeImported: async () => ({ removed: 0 }),
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

    test('assign and setPropertyKey update mapping and rebuild the preview', () => {
        const { svc } = loadedService();
        expect(svc.built.get()!.features.length).toBe(2); // built on load, no button

        svc.assign('Skogsmark, barr', 'trees');
        expect(svc.built.get()!.features.map(f => f.type)).toContain('trees');
        expect(svc.assignedFeatureCount.get()).toBe(4);

        svc.setPropertyKey('source');
        expect(svc.built.get()!.features.length).toBe(0);
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
        // T52: imported rings are fitted b-splines, not straight polygons.
        expect(lake.geometry.curveType).toBe('bspline');
        expect(lake.geometry.rings.length).toBe(2); // island hole preserved
        expect(lake.geometry.rings[0].points.length).toBeGreaterThanOrEqual(8);
        // Fitted controls stay near the 100 m source square.
        for (const p of lake.geometry.rings[0].points) {
            expect(Math.abs(p.x - 531500)).toBeLessThan(110);
            expect(Math.abs(p.y - 6473000)).toBeLessThan(110);
        }
        // Warnings: LineString parse skip + degenerate sliver.
        expect(built.warnings.some(w => /LineString/.test(w))).toBe(true);
        expect(built.warnings.some(w => /dropped ring/.test(w))).toBe(true);
    });

    test('confirmImport bulk-creates with per-type counts; the preview stays with them on the course', async () => {
        const { svc, created } = loadedService();
        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBeNull();
        expect(summary.created).toEqual({ water: 1, water_creek: 1 });
        expect(created.length).toBe(2);
        expect(created.every(c => c.courseId === 'course-1')).toBe(true);
        expect(svc.importing.get()).toBe(false);
        expect(svc.progress.get()).toEqual({ done: 2, total: 2 });
        // No provenance in this file, yet a second Import cannot duplicate them.
        expect(svc.onCourseCount.get()).toBe(2);
        expect(svc.pickedFeatures.get()).toEqual([]);
        expect(await svc.confirmImport()).toBeNull();
        expect(created.length).toBe(2);
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

// T50 — one-click Lantmäteriet fetch: the wizard's second source variant
// calls the server's Hydrografi Direkt proxy, buffers creek centerlines
// into ribbons client-side, and feeds the SAME mapping/preview/accept flow.
describe('GeojsonImportService.fetchFromLantmateriet (T50)', () => {
    const HYDRO_RESULT: HydroFetchResult = {
        bbox: { west: 15.53, south: 58.39, east: 15.58, north: 58.42 },
        source: 'lantmateriet-hydrografi',
        attribution: '© Lantmäteriet, Hydrografi Direkt',
        suggestedCreekWidthM: 2,
        water: [
            // Pond with an island hole, per-feature OGC provenance.
            { sourceRef: 'StandingWater/123', rings: [square(531500, 6473000, 100), square(531500, 6473000, 20)] },
            // The API can omit feature ids — no source_ref then.
            { sourceRef: null, rings: [square(532500, 6473500, 80)] },
        ],
        creeks: [
            { sourceRef: 'WatercourseLine/9', points: [[531200, 6473200], [531200, 6474200]] },
        ],
    };

    function fakeHydroApi(result: HydroFetchResult | Error = HYDRO_RESULT) {
        const calls: Array<{ courseId: string }> = [];
        const hydro: HydroApi = {
            fetchHydro: async input => {
                calls.push(input);
                if (result instanceof Error) throw result;
                return result;
            },
        };
        return { hydro, calls };
    }

    test('hydroToFeatureCollection formats water + buffered creek ribbons with provenance', () => {
        const fc = hydroToFeatureCollection(HYDRO_RESULT);
        expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::3006');
        expect(fc.attribution).toBe('© Lantmäteriet, Hydrografi Direkt');
        expect(fc.features.length).toBe(3);

        const [pond, unref, creek] = fc.features as Array<{
            properties: Record<string, unknown>;
            geometry: { type: string; coordinates: number[][][] };
        }>;
        expect(pond.properties).toEqual({ type: 'water', source: 'lantmateriet-hydrografi', source_ref: 'StandingWater/123' });
        expect(pond.geometry.coordinates.length).toBe(2); // island hole preserved
        expect(unref.properties).toEqual({ type: 'water', source: 'lantmateriet-hydrografi' });

        // 1 km straight creek × 2 m suggested width → closed 2 m ribbon.
        expect(creek.properties['type']).toBe('water_creek');
        expect(creek.properties['source_ref']).toBe('WatercourseLine/9');
        const ring = creek.geometry.coordinates[0];
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        for (const [x] of ring) expect(Math.abs(x - 531200)).toBeCloseTo(1, 6);
        // The line rides along, so the wizard imports a centerline creek.
        expect(creek.properties['centerline']).toEqual(HYDRO_RESULT.creeks[0]!.points);
        expect(creek.properties['widthM']).toBe(HYDRO_RESULT.suggestedCreekWidthM);
    });

    test('degenerate creek runs are dropped, not imported', () => {
        const fc = hydroToFeatureCollection({
            ...HYDRO_RESULT,
            water: [],
            creeks: [{ sourceRef: 'WatercourseLine/1', points: [[531200, 6473200]] }],
        });
        expect(fc.features.length).toBe(0);
    });

    test('fetch feeds the normal mapping flow: buckets, prefill, provenance on create', async () => {
        const { api, created } = fakeApi();
        const { hydro, calls } = fakeHydroApi();
        const svc = new GeojsonImportService(api, hydro);
        svc.openFor('course-1');

        await svc.fetchFromLantmateriet();

        expect(calls).toEqual([{ courseId: 'course-1' }]);
        expect(svc.fetching.get()).toBe(false);
        expect(svc.fetchError.get()).toBeNull();
        expect(svc.parseError.get()).toBeNull();
        expect(svc.fileName.get()).toBe(HYDRO_FETCH_FILENAME);
        expect(svc.propertyKey.get()).toBe('type');
        const buckets = svc.buckets.get();
        expect(buckets.map(b => b.value).sort()).toEqual(['water', 'water_creek']);
        const a = svc.assignments.get();
        expect(a['water']).toBe('water');
        expect(a['water_creek']).toBe('water_creek');
        expect(svc.assignedFeatureCount.get()).toBe(3);

        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBeNull();
        expect(summary.created).toEqual({ water: 2, water_creek: 1 });
        const pond = created.find(c => (c as Record<string, unknown>).sourceRef === 'StandingWater/123') as Record<string, unknown>;
        expect(pond.source).toBe('lantmateriet-hydrografi');
        expect(pond.license).toBeUndefined(); // Hydrografi Direkt is not ODbL
        const creek = created.find(c => c.type === 'water_creek') as Record<string, any>;
        expect(creek.sourceRef).toBe('WatercourseLine/9');
        expect(creek.geometry.centerline.widthM).toBe(HYDRO_RESULT.suggestedCreekWidthM);
        expect(creek.geometry.centerline.points.length).toBeGreaterThanOrEqual(2);
    });

    test('fetch failure surfaces fetchError and leaves the wizard usable', async () => {
        const { api } = fakeApi();
        const { hydro } = fakeHydroApi(new Error('Hydrografi Direkt returned 401 for StandingWater: …Geotorget.'));
        const svc = new GeojsonImportService(api, hydro);
        svc.openFor('course-1');

        await svc.fetchFromLantmateriet();

        expect(svc.fetching.get()).toBe(false);
        expect(svc.fetchError.get()).toMatch(/401/);
        expect(svc.parsed.get()).toBeNull();

        // A later file pick clears the stale fetch error.
        svc.loadGeojsonText(GEOJSON, 'water.geojson');
        expect(svc.fetchError.get()).toBeNull();
        expect(svc.parsed.get()).not.toBeNull();
    });

    test('empty fetch result explains itself instead of a parse error', async () => {
        const { api } = fakeApi();
        const { hydro } = fakeHydroApi({ ...HYDRO_RESULT, water: [], creeks: [] });
        const svc = new GeojsonImportService(api, hydro);
        svc.openFor('course-1');

        await svc.fetchFromLantmateriet();

        expect(svc.fetchError.get()).toMatch(/No water or creeks/);
        expect(svc.parseError.get()).toBeNull();
        expect(svc.parsed.get()).toBeNull();
    });

    test('provenanceFromProperties: explicit source_ref wins over the osm composite', () => {
        expect(provenanceFromProperties({ source: 'lantmateriet-hydrografi', source_ref: 'StandingWater/123' }))
            .toEqual({ source: 'lantmateriet-hydrografi', sourceRef: 'StandingWater/123' });
        expect(provenanceFromProperties({ source: 'osm', source_ref: 'explicit/1', osm_type: 'way', osm_id: 2 }))
            .toEqual({ source: 'osm', sourceRef: 'explicit/1', license: 'ODbL' });
    });
});

// T53 — one-click OSM fetch: the wizard's third source variant calls the
// server's Overpass proxy and feeds the SAME mapping/preview/accept flow;
// every created feature carries ODbL provenance (T49).
describe('GeojsonImportService.fetchFromOsm (T53)', () => {
    const OSM_RESULT: OsmFetchResult = {
        bbox: { west: 15.70, south: 58.34, east: 15.75, north: 58.37 },
        source: 'osm',
        license: 'ODbL',
        attribution: '© OpenStreetMap contributors, ODbL (opendatacommons.org/licenses/odbl)',
        fetched: '2026-07-18',
        features: [
            { type: 'green', sourceRef: 'way/111', rings: [square(531500, 6473000, 20)] },
            // Multipolygon relation with an island hole.
            {
                type: 'water',
                sourceRef: 'relation/222',
                rings: [square(532000, 6474000, 100), square(532000, 6474000, 20)],
            },
            { type: 'trees', sourceRef: 'way/333', rings: [square(533000, 6475000, 50)] },
        ],
        skipped: [],
    };

    function fakeOsmApi(result: OsmFetchResult | Error = OSM_RESULT) {
        const calls: Array<{ courseId: string }> = [];
        const osm: OsmApi = {
            fetchOsm: async input => {
                calls.push(input);
                if (result instanceof Error) throw result;
                return result;
            },
        };
        return { osm, calls };
    }

    function osmService(result: OsmFetchResult | Error = OSM_RESULT) {
        const { api, created } = fakeApi();
        const { osm, calls } = fakeOsmApi(result);
        const hydro: HydroApi = { fetchHydro: () => Promise.reject(new Error('not under test')) };
        const svc = new GeojsonImportService(api, hydro, osm);
        svc.openFor('course-1');
        return { svc, created, calls };
    }

    test('osmToFeatureCollection formats typed polygons with ODbL provenance', () => {
        const fc = osmToFeatureCollection(OSM_RESULT);
        expect(fc.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::3006');
        expect(fc.attribution).toContain('OpenStreetMap');
        expect(fc.features.length).toBe(3);

        const [green, water] = fc.features as Array<{
            properties: Record<string, unknown>;
            geometry: { type: string; coordinates: number[][][] };
        }>;
        expect(green.properties).toEqual({
            type: 'green', source: 'osm', source_ref: 'way/111', license: 'ODbL', fetched: '2026-07-18',
        });
        expect(green.geometry.type).toBe('Polygon');
        expect(water.properties['source_ref']).toBe('relation/222');
        expect(water.geometry.coordinates.length).toBe(2); // island hole preserved
    });

    test('fetch feeds the normal mapping flow: buckets, prefill, ODbL provenance on create', async () => {
        const { svc, created, calls } = osmService();

        await svc.fetchFromOsm();

        expect(calls).toEqual([{ courseId: 'course-1' }]);
        expect(svc.fetching.get()).toBe(false);
        expect(svc.fetchSource.get()).toBeNull();
        expect(svc.fetchError.get()).toBeNull();
        expect(svc.parseError.get()).toBeNull();
        expect(svc.fileName.get()).toBe(OSM_FETCH_FILENAME);
        expect(svc.propertyKey.get()).toBe('type');
        const buckets = svc.buckets.get();
        expect(buckets.map(b => b.value).sort()).toEqual(['green', 'trees', 'water']);
        const a = svc.assignments.get();
        expect(a['green']).toBe('green');
        expect(a['water']).toBe('water');
        expect(a['trees']).toBe('trees');
        expect(svc.assignedFeatureCount.get()).toBe(3);

        const summary = (await svc.confirmImport())!;
        expect(summary.error).toBeNull();
        expect(summary.created).toEqual({ green: 1, water: 1, trees: 1 });
        // The fetch path's source_ref matches what provenanceFromProperties
        // composes from a fetch-osm FILE's osm_type/osm_id — same values
        // land on the create either way.
        for (const c of created as Array<Record<string, unknown>>) {
            expect(c.source).toBe('osm');
            expect(c.license).toBe('ODbL');
        }
        const green = created.find(c => c.type === 'green') as Record<string, unknown>;
        expect(green.sourceRef).toBe('way/111');
        const water = created.find(c => c.type === 'water') as Record<string, unknown>;
        expect(water.sourceRef).toBe('relation/222');
    });

    test('fetch failure (Overpass rate limit) surfaces fetchError, wizard stays usable', async () => {
        const { svc } = osmService(new Error('Overpass is rate-limiting requests (HTTP 429) — …'));

        await svc.fetchFromOsm();

        expect(svc.fetching.get()).toBe(false);
        expect(svc.fetchError.get()).toMatch(/429/);
        expect(svc.parsed.get()).toBeNull();

        // A later file pick clears the stale fetch error.
        svc.loadGeojsonText(GEOJSON, 'water.geojson');
        expect(svc.fetchError.get()).toBeNull();
        expect(svc.parsed.get()).not.toBeNull();
    });

    test('empty fetch result explains itself instead of a parse error', async () => {
        const { svc } = osmService({ ...OSM_RESULT, features: [] });

        await svc.fetchFromOsm();

        expect(svc.fetchError.get()).toMatch(/No OSM golf or terrain features/);
        expect(svc.parseError.get()).toBeNull();
        expect(svc.parsed.get()).toBeNull();
    });

    test('fetchSource labels the in-flight variant', async () => {
        let resolveFetch: (r: OsmFetchResult) => void;
        const osm: OsmApi = {
            fetchOsm: () => new Promise(resolve => { resolveFetch = resolve; }),
        };
        const hydro: HydroApi = { fetchHydro: () => Promise.reject(new Error('not under test')) };
        const svc = new GeojsonImportService(fakeApi().api, hydro, osm);
        svc.openFor('course-1');

        const pending = svc.fetchFromOsm();
        expect(svc.fetching.get()).toBe(true);
        expect(svc.fetchSource.get()).toBe('osm');
        resolveFetch!(OSM_RESULT);
        await pending;
        expect(svc.fetching.get()).toBe(false);
        expect(svc.fetchSource.get()).toBeNull();
    });
});

describe('GeojsonImportService.fetchFromRoads (T-roads)', () => {
    const ROADS: RoadsFetchResult = {
        bbox: { west: 15.70, south: 58.34, east: 15.75, north: 58.37 },
        centerlines: '/data/sources/site-1/roads-centerlines.geojson',
        report: ['Road polygons: 2 (path=1, road=1)'],
        geojson: {
            type: 'FeatureCollection',
            crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
            attribution: '© OpenStreetMap contributors, ODbL (opendatacommons.org/licenses/odbl)',
            features: [
                { type: 'Feature', properties: { type: 'path', road_class: 'road', source: 'osm', osm_ids: [1, 2] },
                    geometry: { type: 'Polygon', coordinates: [square(531500, 6473000, 20)] } },
                { type: 'Feature', properties: { type: 'path', road_class: 'path', source: 'osm', osm_ids: [3] },
                    geometry: { type: 'Polygon', coordinates: [square(532000, 6474000, 10)] } },
            ],
        },
    };

    /** A fake job API: the job runs for `polls` polls, then ends with `outcome`. */
    function roadsService(outcome: RoadsFetchResult | Error = ROADS, opts: { polls?: number; alreadyRunning?: boolean } = {}) {
        const { api, created } = fakeApi();
        const calls: string[] = [];
        let polls = opts.polls ?? 2;
        const job = (status: RoadsFetchJob['status']): RoadsFetchJob => ({
            id: 'job-1', courseId: 'course-1', status, startedAt: '2026-09-24T10:00:00Z', finishedAt: null,
            result: status === 'succeeded' && !(outcome instanceof Error) ? outcome : null,
            error: status === 'failed' && outcome instanceof Error ? outcome.message : null,
        });
        const generators: TerrainGeneratorsApi = {
            startRoadsFetch: async input => {
                calls.push(`start ${input.courseId}`);
                if (opts.alreadyRunning) throw new Error('A road fetch is already running for this course (job job-1) — wait for it to finish');
                return job('running');
            },
            roadsFetchJob: async input => {
                calls.push(`poll ${input.jobId}`);
                polls -= 1;
                return job(polls > 0 ? 'running' : outcome instanceof Error ? 'failed' : 'succeeded');
            },
            currentRoadsFetch: async input => {
                calls.push(`current ${input.courseId}`);
                return job('running');
            },
            generate: () => Promise.reject(new Error('not under test')),
        };
        const hydro: HydroApi = { fetchHydro: () => Promise.reject(new Error('not under test')) };
        const osm: OsmApi = { fetchOsm: () => Promise.reject(new Error('not under test')) };
        const svc = new GeojsonImportService(api, hydro, osm, generators, 1);
        svc.openFor('course-1');
        return { svc, created, calls };
    }

    test('the fetch runs as a job; its road polygons load into the wizard as path features, bucketable by road_class', async () => {
        const { svc, calls } = roadsService();
        await svc.fetchFromRoads();
        expect(calls).toEqual(['start course-1', 'poll job-1', 'poll job-1']);
        expect(svc.fileName.get()).toBe(ROADS_FETCH_FILENAME);
        expect(svc.fetchError.get()).toBeNull();
        const parsed = svc.parsed.get()!;
        expect(parsed.features).toHaveLength(2);
        expect(svc.buckets.get().map(b => [b.value, b.suggestedType])).toEqual([['path', 'path']]);
        svc.setPropertyKey('road_class');
        expect(svc.buckets.get().map(b => b.value).sort()).toEqual(['path', 'road']);
    });

    test('a fetch already running for the course is followed instead of refused', async () => {
        const { svc, calls } = roadsService(ROADS, { alreadyRunning: true, polls: 1 });
        await svc.fetchFromRoads();
        expect(calls).toEqual(['start course-1', 'current course-1', 'poll job-1']);
        expect(svc.fetchError.get()).toBeNull();
        expect(svc.parsed.get()!.features).toHaveLength(2);
    });

    test('no roads and a failed job both surface as the wizard\'s fetch error', async () => {
        const empty = roadsService({ ...ROADS, geojson: { type: 'FeatureCollection', features: [] } });
        await empty.svc.fetchFromRoads();
        expect(empty.svc.fetchError.get()).toMatch(/No roads found near the course/);
        expect(empty.svc.fileName.get()).toBeNull();

        const failed = roadsService(new Error('Road fetch failed: Overpass 504'));
        await failed.svc.fetchFromRoads();
        expect(failed.svc.fetchError.get()).toBe('Road fetch failed: Overpass 504');
        expect(failed.svc.fetching.get()).toBe(false);
        expect(failed.svc.fetchSource.get()).toBeNull();
    });
});

describe('clearing earlier imports', () => {
    const COUNTS = [
        { source: 'lantmateriet-hydrografi', type: 'water', count: 13 },
        { source: 'nvdb', type: 'path', count: 1 },
        { source: 'osm', type: 'fairway', count: 4 },
        { source: 'osm', type: 'path', count: 57 },
    ];

    test('roads get their own group, so clearing them never takes the OSM fairways (and vice versa)', () => {
        expect(importGroups(COUNTS)).toEqual([
            { key: 'roads', label: 'Roads & parking (OSM + NVDB)', count: 58, types: [{ type: 'path', count: 58 }],
                sources: ['nvdb', 'osm'], onlyTypes: ['path'] },
            { key: 'source:lantmateriet-hydrografi', label: 'Lantmäteriet water', count: 13,
                types: [{ type: 'water', count: 13 }], sources: ['lantmateriet-hydrografi'] },
            { key: 'source:osm', label: 'OpenStreetMap features', count: 4,
                types: [{ type: 'fairway', count: 4 }], sources: ['osm'], onlyTypes: ['fairway'] },
        ]);
        expect(importGroups([])).toEqual([]);
        expect(importGroups([{ source: 'my-file', type: 'bunker', count: 2 }])[0]).toEqual(
            { key: 'source:my-file', label: 'my-file', count: 2, types: [{ type: 'bunker', count: 2 }], sources: ['my-file'] });
    });

    test('opening the wizard lists the imports; removing a group sends its sources and types and refreshes the list', async () => {
        let counts = [...COUNTS];
        const removals: unknown[] = [];
        const { api } = fakeApi();
        api.imported = async () => counts;
        api.removeImported = async input => {
            removals.push(input);
            counts = counts.filter(c => !(input.sources.includes(c.source) && (!input.types || input.types.includes(c.type))));
            return { removed: 58 };
        };
        const svc = new GeojsonImportService(api);
        svc.openFor('course-1');
        await svc.loadImported();
        expect(svc.imported.get().map(g => g.key)).toEqual(['roads', 'source:lantmateriet-hydrografi', 'source:osm']);

        const removed = await svc.clearImported(svc.imported.get()[0]!);
        expect(removed).toBe(58);
        expect(removals).toEqual([{ courseId: 'course-1', sources: ['nvdb', 'osm'], types: ['path'] }]);
        expect(svc.imported.get().map(g => g.key)).toEqual(['source:lantmateriet-hydrografi', 'source:osm']);
        expect(svc.clearing.get()).toBeNull();
    });

    test('a failed removal is reported and leaves the list as it was', async () => {
        const { api } = fakeApi();
        api.imported = async () => COUNTS;
        api.removeImported = () => Promise.reject(new Error('Course features: forbidden'));
        const svc = new GeojsonImportService(api);
        svc.openFor('course-1');
        await svc.loadImported();
        expect(await svc.clearImported(svc.imported.get()[0]!)).toBeNull();
        expect(svc.clearError.get()).toBe('Course features: forbidden');
        expect(svc.imported.get()).toHaveLength(3);
    });
});

describe('path surfaces on import', () => {
    test('a path keeps a valid surface property as its attribute; nothing else carries over', () => {
        expect(attributesFromProperties('path', { surface: 'gravel', road_class: 'road' })).toEqual({ surface: 'gravel' });
        expect(attributesFromProperties('path', { surface: 'mixed' })).toBeNull();
        expect(attributesFromProperties('path', {})).toBeNull();
        expect(attributesFromProperties('bunker', { surface: 'gravel' })).toBeNull();
    });

    test('imported road corridors are created with their surface', async () => {
        const { api, created } = fakeApi();
        const svc = new GeojsonImportService(api);
        svc.openFor('course-1');
        svc.loadGeojsonText(JSON.stringify({
            type: 'FeatureCollection',
            crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
            features: [
                { type: 'Feature', properties: { type: 'path', surface: 'asphalt', exact: true, source: 'osm' },
                    geometry: { type: 'Polygon', coordinates: [square(531500, 6473000, 20)] } },
                { type: 'Feature', properties: { type: 'path', exact: true, source: 'osm' },
                    geometry: { type: 'Polygon', coordinates: [square(531600, 6473000, 20)] } },
            ],
        }), 'osm-roads.geojson');
        await svc.confirmImport();
        const attrs = created.map(c => (c as { attributes?: unknown }).attributes);
        expect(attrs).toEqual([{ surface: 'asphalt' }, undefined]);
    });
});

describe('road centerlines (fetch-roads `centerline` + `widthM`)', () => {
    const road = (props: Record<string, unknown>) => ({
        type: 'Feature',
        properties: { type: 'path', road_class: 'road', source: 'osm', osm_ids: [7], surface: 'gravel', ...props },
        geometry: { type: 'Polygon', coordinates: [square(530050, 6487000, 3)] },
    });

    test('centerlineFromProperties reads the line, flags the pipeline corners, rejects junk', () => {
        const line = [[530000, 6487000], [530060, 6487000], [530060, 6487050], [530070, 6487090]];
        const c = centerlineFromProperties({ centerline: line, widthM: 5 })!;
        expect(c.widthM).toBe(5);
        expect(c.points.map(q => q.corner === true)).toEqual([false, true, false, false]); // 90° ≥ 70°, 11° not
        expect(centerlineFromProperties({ centerline: line })).toBeNull();
        expect(centerlineFromProperties({ centerline: [[530000, 6487000]], widthM: 5 })).toBeNull();
        expect(centerlineFromProperties({ centerline: [[530000, 'x'], [1, 2]], widthM: 5 })).toBeNull();
        expect(centerlineFromProperties({ widthM: 5 })).toBeNull();
    });

    test('a road with a centerline imports as a centerline path; one without keeps its polygon', async () => {
        const { api, created } = fakeApi();
        const svc = new GeojsonImportService(api);
        svc.openFor('course-1');
        svc.loadGeojsonText(JSON.stringify({
            type: 'FeatureCollection',
            crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
            features: [
                road({ centerline: [[530000, 6487000], [530100, 6487000]], widthM: 6 }),
                road({ exact: true }),
            ],
        }), ROADS_FETCH_FILENAME);
        await svc.confirmImport();
        expect(created).toHaveLength(2);
        const [line, polygon] = created as Array<{ geometry: { centerline?: { widthM: number }; rings: Array<{ points: Array<{ x: number; y: number }> }> }; attributes?: unknown; source?: string }>;
        expect(line.geometry.centerline).toEqual({ points: [{ x: 530000, y: 6487000 }, { x: 530100, y: 6487000 }], widthM: 6 });
        // Its corridor rides along (the server re-derives the same one).
        const xs = line.geometry.rings[0].points.map(q => q.x);
        expect(Math.min(...xs)).toBeCloseTo(529997, 3);
        expect(Math.max(...xs)).toBeCloseTo(530103, 3);
        expect(line.attributes).toEqual({ surface: 'gravel' });
        expect(line.source).toBe('osm');
        expect(polygon.geometry.centerline).toBeUndefined();
    });
});

// Importing a fetch a few shapes at a time: click shapes on the map to pick
// or drop them; what the course already has stays out.
describe('picking shapes to import', () => {
    const HYDRO: HydroFetchResult = {
        bbox: { west: 15.53, south: 58.39, east: 15.58, north: 58.42 },
        source: 'lantmateriet-hydrografi',
        attribution: '© Lantmäteriet, Hydrografi Direkt',
        suggestedCreekWidthM: 2,
        water: [
            { sourceRef: 'StandingWater/1', rings: [square(531500, 6473000, 50)] },
            { sourceRef: 'StandingWater/2', rings: [square(532500, 6473000, 50)] },
            { sourceRef: 'StandingWater/3', rings: [square(533500, 6473000, 50)] },
        ],
        creeks: [],
    };

    function pickingService(onCourse: Array<{ source: string; sourceRef: string }> = []) {
        const { api, created } = fakeApi();
        api.listByCourse = async () => onCourse.map((f, i) => ({ id: `e${i}`, ...f }) as unknown as CourseFeature);
        const hydro: HydroApi = { fetchHydro: async () => HYDRO };
        const svc = new GeojsonImportService(api, hydro);
        svc.openFor('course-1');
        return { svc, created };
    }
    const refsOf = (created: unknown[]) => (created as Array<{ sourceRef?: string }>).map(c => c.sourceRef);

    test('the shapes are on the map as soon as they are fetched, all picked', async () => {
        const { svc } = pickingService();
        await svc.fetchFromLantmateriet();
        expect(svc.built.get()!.features.length).toBe(3);
        expect(svc.pickedFeatures.get().length).toBe(3);
    });

    test('None, then a click on one shape, imports just that shape', async () => {
        const { svc, created } = pickingService();
        await svc.fetchFromLantmateriet();
        svc.pickAll(false);
        expect(svc.pickedFeatures.get()).toEqual([]);
        const second = svc.built.get()!.features.find(f => f.sourceRef === 'StandingWater/2')!;
        svc.togglePick(second.key!);
        await svc.confirmImport();
        expect(refsOf(created)).toEqual(['StandingWater/2']);
    });

    test('a click drops a picked shape; a second click picks it again', async () => {
        const { svc } = pickingService();
        await svc.fetchFromLantmateriet();
        const key = svc.built.get()!.features[0].key!;
        svc.togglePick(key);
        expect(svc.pickedFeatures.get().length).toBe(2);
        svc.togglePick(key);
        expect(svc.pickedFeatures.get().length).toBe(3);
    });

    test('shapes the course already has start out and cannot be picked; the rest import', async () => {
        const { svc, created } = pickingService([{ source: 'lantmateriet-hydrografi', sourceRef: 'StandingWater/1' }]);
        await svc.loadImported();
        await svc.fetchFromLantmateriet();
        expect(svc.onCourseCount.get()).toBe(1);
        const first = svc.built.get()!.features.find(f => f.sourceRef === 'StandingWater/1')!;
        svc.togglePick(first.key!);
        svc.pickAll(true);
        await svc.confirmImport();
        expect(refsOf(created)).toEqual(['StandingWater/2', 'StandingWater/3']);
    });

    test('after an import the next shapes are picked from the same fetch, without fetching again', async () => {
        const { svc, created } = pickingService();
        await svc.fetchFromLantmateriet();
        const [a, b] = svc.built.get()!.features;
        svc.pickAll(false);
        svc.togglePick(a.key!);
        await svc.confirmImport();
        svc.togglePick(b.key!);
        svc.togglePick(a.key!); // already on the course: stays out
        await svc.confirmImport();
        expect(refsOf(created)).toEqual(['StandingWater/1', 'StandingWater/2']);
    });

    test('picks survive a mapping change', async () => {
        const { svc } = pickingService();
        await svc.fetchFromLantmateriet();
        const key = svc.built.get()!.features[0].key!;
        svc.togglePick(key);
        svc.assign('water', 'skip');
        svc.assign('water', 'water');
        expect(svc.pickedFeatures.get().map(f => f.key)).not.toContain(key);
    });
});

describe('split source shapes and the map click', () => {
    test('a shape split in parts numbers its refs, and an older bare-ref import covers every part', () => {
        const fc = hydroToFeatureCollection({
            bbox: { west: 0, south: 0, east: 1, north: 1 },
            source: 'lantmateriet-hydrografi',
            attribution: '',
            suggestedCreekWidthM: 2,
            water: [
                { sourceRef: 'StandingWater/7', rings: [square(531500, 6473000, 50)] },
                { sourceRef: 'StandingWater/7', rings: [square(531700, 6473000, 50)] },
                { sourceRef: 'StandingWater/8', rings: [square(531900, 6473000, 50)] },
            ],
            creeks: [],
        });
        const refs = (fc.features as Array<{ properties: { source_ref?: string } }>).map(f => f.properties.source_ref);
        expect(refs).toEqual(['StandingWater/7#1', 'StandingWater/7#2', 'StandingWater/8']);

        const src = 'lantmateriet-hydrografi';
        expect(alreadyImported({ source: src, sourceRef: 'StandingWater/7#2' }, importedRefs([{ source: src, sourceRef: 'StandingWater/7#1' }]))).toBe(false);
        expect(alreadyImported({ source: src, sourceRef: 'StandingWater/7#2' }, importedRefs([{ source: src, sourceRef: 'StandingWater/7' }]))).toBe(true);
        expect(alreadyImported({ source: 'osm', sourceRef: 'StandingWater/7' }, importedRefs([{ source: src, sourceRef: 'StandingWater/7' }]))).toBe(false);
    });

    test('a click lands on the smallest shape under it, not in a hole, and misses outside', () => {
        const lake = [square(0, 0, 100), square(50, 50, 20)];
        const pond = [square(-50, -50, 10)];
        expect(shapeAt([lake, pond], { x: -50, y: -50 })).toBe(1);
        expect(shapeAt([lake, pond], { x: 0, y: 0 })).toBe(0);
        expect(shapeAt([lake, pond], { x: 50, y: 50 })).toBe(-1); // the island
        expect(shapeAt([lake, pond], { x: 500, y: 0 })).toBe(-1);
    });
});
