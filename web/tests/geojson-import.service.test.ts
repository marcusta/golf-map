import { test, expect, describe } from 'bun:test';
import {
    GeojsonImportService,
    provenanceFromProperties,
    hydroToFeatureCollection,
    osmToFeatureCollection,
    HYDRO_FETCH_FILENAME,
    OSM_FETCH_FILENAME,
} from '../src/import/geojson-import.service';
import type { HydroApi, HydroFetchResult } from '../../shared/api/hydro.gen';
import type { OsmApi, OsmFetchResult } from '../../shared/api/osm.gen';
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
        const creek = created.find(c => c.type === 'water_creek') as Record<string, unknown>;
        expect(creek.sourceRef).toBe('WatercourseLine/9');
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
