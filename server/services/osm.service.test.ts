// OsmService tests — fully offline. Overpass is stubbed behind the
// fetchImpl seam with hand-built `out geom;` fixture JSON (mirroring
// pipeline/tests/test_fetch_osm.py: ways carry an inline `geometry` list
// of {lat, lon}, relations carry `members` with per-way geometry + role),
// including the multipolygon-with-holes case.

import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import {
    OsmService,
    classifyOsmTags,
    buildOverpassQuery,
    stitchRings,
    assignHoles,
    assembleOsmPolygons,
    OSM_SOURCE,
    OSM_LICENSE,
    OSM_ATTRIBUTION,
    OSM_USER_AGENT,
    type OsmFetchImpl,
} from './osm.service';

// EPSG:3006 bbox around the Linköping test spot (matches the hydro tests);
// its WGS84 footprint is roughly lon 15.51–15.57, lat 58.38–58.41.
const BBOX_3006: [number, number, number, number] = [531000, 6472000, 534000, 6475000];
const GEOREF_JSON = JSON.stringify({ bbox: BBOX_3006 });

// WGS84 bounds as a tile manifest stores them (site-owned map).
const MANIFEST_BOUNDS = { west: 15.53, south: 58.39, east: 15.58, north: 58.42 };

// Small closed squares (lon/lat) inside the bbox — same fixtures as
// pipeline/tests/test_fetch_osm.py.
const GREEN: [number, number][] = [
    [15.53, 58.39], [15.532, 58.39], [15.532, 58.391], [15.53, 58.391], [15.53, 58.39],
];
const LAKE_OUTER: [number, number][] = [
    [15.54, 58.395], [15.544, 58.395], [15.544, 58.399], [15.54, 58.399], [15.54, 58.395],
];
const LAKE_INNER: [number, number][] = [
    [15.541, 58.396], [15.543, 58.396], [15.543, 58.398], [15.541, 58.398], [15.541, 58.396],
];

/** (lon, lat) pairs → Overpass `out geom` [{lat, lon}, …]. */
function geom(points: [number, number][]): Array<{ lat: number; lon: number }> {
    return points.map(([lon, lat]) => ({ lat, lon }));
}

function stubFetch(payload: unknown, status = 200) {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
    const fetchImpl: OsmFetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { ok: status < 400, status, json: async () => payload };
    };
    return { fetchImpl, calls };
}

async function setupCourse(input: { georeferenceJson?: string; withManifest?: boolean }) {
    const ctx = await createTestDb();
    let siteId: string | undefined;
    if (input.withManifest) {
        const site = await ctx.sitesService.create({ name: 'Test site' });
        siteId = site.id;
    }
    const course = await ctx.coursesService.create({
        name: 'OSM course',
        georeferenceJson: input.georeferenceJson,
        siteId,
    });
    if (siteId) {
        await ctx.assetsService.register({
            siteId,
            courseId: course.id,
            kind: 'tile_manifest',
            filename: 'manifest.json',
            metaJson: JSON.stringify({ bounds: MANIFEST_BOUNDS }),
        });
    }
    return { ctx, course };
}

function service(ctx: Awaited<ReturnType<typeof createTestDb>>, fetchImpl: OsmFetchImpl) {
    return new OsmService({
        courses: ctx.coursesService,
        assets: ctx.assetsService,
        fetchImpl,
        today: () => '2026-07-18',
    });
}

// ─── pure helpers ────────────────────────────────────────────────────────────

describe('classifyOsmTags', () => {
    test('covers golf, water and tree tags; golf wins; linear/unknown dropped', () => {
        expect(classifyOsmTags({ golf: 'green' })).toBe('green');
        expect(classifyOsmTags({ golf: 'tee' })).toBe('tee');
        expect(classifyOsmTags({ golf: 'fairway' })).toBe('fairway');
        expect(classifyOsmTags({ golf: 'bunker' })).toBe('bunker');
        expect(classifyOsmTags({ golf: 'rough' })).toBe('rough');
        expect(classifyOsmTags({ golf: 'water_hazard' })).toBe('water');
        expect(classifyOsmTags({ golf: 'lateral_water_hazard' })).toBe('water');
        expect(classifyOsmTags({ natural: 'water' })).toBe('water');
        expect(classifyOsmTags({ landuse: 'forest' })).toBe('trees');
        expect(classifyOsmTags({ natural: 'wood' })).toBe('trees');
        // Golf tags win over land cover; unknown/linear tags are dropped.
        expect(classifyOsmTags({ golf: 'green', natural: 'water' })).toBe('green');
        expect(classifyOsmTags({ golf: 'cartpath' })).toBeNull();
        expect(classifyOsmTags({ highway: 'path' })).toBeNull();
        expect(classifyOsmTags({})).toBeNull();
        expect(classifyOsmTags(undefined)).toBeNull();
    });
});

describe('buildOverpassQuery', () => {
    test('uses S,W,N,E bbox order and out geom', () => {
        const q = buildOverpassQuery({ west: 15.53, south: 58.39, east: 15.58, north: 58.42 });
        expect(q).toContain('(58.39,15.53,58.42,15.58)');
        expect(q).toContain('way["golf"]');
        expect(q).toContain('relation["natural"="water"]');
        expect(q.trim().endsWith('out geom;')).toBe(true);
    });
});

describe('stitchRings', () => {
    test('joins split ways regardless of direction; drops dangling chains', () => {
        // Two half-loops of a square, second one reversed — must stitch.
        const a: [number, number][] = [[0, 0], [1, 0], [1, 1]];
        const b: [number, number][] = [[0, 0], [0, 1], [1, 1]];
        const rings = stitchRings([a, b]);
        expect(rings.length).toBe(1);
        expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
        // An unclosable dangling way yields no ring.
        expect(stitchRings([[[0, 0], [1, 0]]])).toEqual([]);
    });
});

describe('assignHoles', () => {
    test('assigns each inner to the containing outer; unmatched inners dropped', () => {
        const outerA: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
        const outerB: [number, number][] = [[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]];
        const innerA: [number, number][] = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];
        const far: [number, number][] = [[100, 100], [101, 100], [101, 101], [100, 101], [100, 100]];
        const sets = assignHoles([outerA, outerB], [innerA, far]);
        expect(sets.length).toBe(2);
        expect(sets[0]).toEqual([outerA, innerA]);
        expect(sets[1]).toEqual([outerB]);
    });
});

describe('assembleOsmPolygons', () => {
    test('closed way becomes one polygon with provenance', () => {
        const { polygons, skipped } = assembleOsmPolygons({ elements: [
            { type: 'way', id: 111, tags: { golf: 'green' }, geometry: geom(GREEN) },
        ] });
        expect(skipped).toEqual([]);
        expect(polygons.length).toBe(1);
        expect(polygons[0].type).toBe('green');
        expect(polygons[0].sourceRef).toBe('way/111');
        expect(polygons[0].rings.length).toBe(1);
    });

    test('multipolygon relation keeps its hole', () => {
        const { polygons, skipped } = assembleOsmPolygons({ elements: [
            {
                type: 'relation', id: 222, tags: { type: 'multipolygon', natural: 'water' },
                members: [
                    { type: 'way', role: 'outer', geometry: geom(LAKE_OUTER) },
                    { type: 'way', role: 'inner', geometry: geom(LAKE_INNER) },
                ],
            },
        ] });
        expect(skipped).toEqual([]);
        expect(polygons.length).toBe(1);
        expect(polygons[0].type).toBe('water');
        expect(polygons[0].sourceRef).toBe('relation/222');
        expect(polygons[0].rings.length).toBe(2); // outer + island hole
    });

    test('stitches split relation member ways into one outer ring', () => {
        // Two open halves of the LAKE_OUTER square, the second reversed —
        // ways arrive split and in arbitrary direction.
        const half1 = LAKE_OUTER.slice(0, 3); // p0 → p1 → p2
        const half2 = [LAKE_OUTER[4], LAKE_OUTER[3], LAKE_OUTER[2]]; // p0 ← p3 ← p2 reversed
        const { polygons, skipped } = assembleOsmPolygons({ elements: [
            {
                type: 'relation', id: 5, tags: { natural: 'water' },
                members: [
                    { type: 'way', role: 'outer', geometry: geom(half1) },
                    { type: 'way', role: 'outer', geometry: geom(half2) },
                ],
            },
        ] });
        expect(skipped).toEqual([]);
        expect(polygons.length).toBe(1);
        const ring = polygons[0].rings[0];
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(ring.length).toBe(5);
    });

    test('skips-and-logs an open classified way; ignores unclassified silently', () => {
        const { polygons, skipped } = assembleOsmPolygons({ elements: [
            { type: 'way', id: 1, tags: { golf: 'fairway' }, geometry: geom(GREEN.slice(0, 2)) },
            { type: 'way', id: 2, tags: { highway: 'path' }, geometry: geom(GREEN) },
        ] });
        expect(polygons).toEqual([]);
        expect(skipped.length).toBe(1);
        expect(skipped[0]).toContain('way/1');
    });

    test('relation with no closed outer ring is skipped with a note', () => {
        const { polygons, skipped } = assembleOsmPolygons({ elements: [
            {
                type: 'relation', id: 9, tags: { natural: 'water' },
                members: [{ type: 'way', role: 'outer', geometry: geom(GREEN.slice(0, 2)) }],
            },
        ] });
        expect(polygons).toEqual([]);
        expect(skipped[0]).toContain('relation/9');
    });
});

// ─── fetchForCourse ──────────────────────────────────────────────────────────

const FULL_PAYLOAD = { elements: [
    { type: 'way', id: 111, tags: { golf: 'green' }, geometry: geom(GREEN) },
    {
        type: 'relation', id: 222, tags: { type: 'multipolygon', natural: 'water' },
        members: [
            { type: 'way', role: 'outer', geometry: geom(LAKE_OUTER) },
            { type: 'way', role: 'inner', geometry: geom(LAKE_INNER) },
        ],
    },
    { type: 'way', id: 333, tags: { landuse: 'forest' }, geometry: geom(GREEN) },
] };

describe('OsmService.fetchForCourse', () => {
    test('returns typed EPSG:3006 polygons with ODbL provenance', async () => {
        const { fetchImpl, calls } = stubFetch(FULL_PAYLOAD);
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);

        expect(result.source).toBe(OSM_SOURCE);
        expect(result.license).toBe(OSM_LICENSE);
        expect(result.attribution).toBe(OSM_ATTRIBUTION);
        expect(result.fetched).toBe('2026-07-18');
        expect(result.skipped).toEqual([]);

        const types = result.features.map(f => f.type).sort();
        expect(types).toEqual(['green', 'trees', 'water']);
        const green = result.features.find(f => f.type === 'green')!;
        expect(green.sourceRef).toBe('way/111');
        const water = result.features.find(f => f.type === 'water')!;
        expect(water.sourceRef).toBe('relation/222');
        expect(water.rings.length).toBe(2); // island hole survives reprojection + clip

        // Reprojected into EPSG:3006 metres (SWEREF99 TM ranges) and
        // explicitly closed rings.
        for (const feature of result.features) {
            for (const ring of feature.rings) {
                expect(ring[0]).toEqual(ring[ring.length - 1]);
                for (const [x, y] of ring) {
                    expect(x).toBeGreaterThan(400000);
                    expect(x).toBeLessThan(700000);
                    expect(y).toBeGreaterThan(6.3e6);
                    expect(y).toBeLessThan(6.6e6);
                }
            }
        }

        // Fetch mechanics: one POST to Overpass, descriptive UA, form body
        // carrying the bbox-scoped QL query.
        expect(calls.length).toBe(1);
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.headers['User-Agent']).toBe(OSM_USER_AGENT);
        const query = decodeURIComponent(calls[0].init.body.replace(/^data=/, ''));
        expect(query).toContain('out geom;');
        expect(query).toContain('way["golf"]');
        // Overpass bbox is (S,W,N,E) WGS84 derived from the 3006 georeference.
        const m = query.match(/\((\d+\.\d+),(\d+\.\d+),(\d+\.\d+),(\d+\.\d+)\)/)!;
        const [s, w, n, e] = m.slice(1).map(Number);
        expect(s).toBeGreaterThan(58.3);
        expect(s).toBeLessThan(58.5);
        expect(w).toBeGreaterThan(15.4);
        expect(w).toBeLessThan(15.6);
        expect(n).toBeGreaterThan(s);
        expect(e).toBeGreaterThan(w);
    });

    test('clips polygons to the course bbox; provenance survives the clip', async () => {
        // A forest way straddling the bbox's west edge (x = 531000 is
        // lon ≈ 15.53 at this latitude): half in, half out.
        const straddling: [number, number][] = [
            [15.50, 58.39], [15.56, 58.39], [15.56, 58.40], [15.50, 58.40], [15.50, 58.39],
        ];
        const { fetchImpl } = stubFetch({ elements: [
            { type: 'way', id: 7, tags: { landuse: 'forest' }, geometry: geom(straddling) },
        ] });
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);

        expect(result.features.length).toBe(1);
        expect(result.features[0].sourceRef).toBe('way/7');
        for (const [x] of result.features[0].rings[0]) {
            expect(x).toBeGreaterThanOrEqual(BBOX_3006[0] - 0.01);
        }
    });

    test('drops polygons entirely outside the course bbox', async () => {
        const far: [number, number][] = [
            [16.5, 59.0], [16.51, 59.0], [16.51, 59.01], [16.5, 59.01], [16.5, 59.0],
        ];
        const { fetchImpl } = stubFetch({ elements: [
            { type: 'way', id: 8, tags: { natural: 'water' }, geometry: geom(far) },
        ] });
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);
        expect(result.features).toEqual([]);
    });

    test('falls back to the site tile-manifest bounds when the course has no georeference', async () => {
        const { fetchImpl, calls } = stubFetch({ elements: [] });
        const { ctx, course } = await setupCourse({ withManifest: true });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);

        expect(result.bbox).toEqual(MANIFEST_BOUNDS);
        const query = decodeURIComponent(calls[0].init.body.replace(/^data=/, ''));
        expect(query).toContain('(58.39,15.53,58.42,15.58)');
        expect(result.features).toEqual([]);
    });

    test('rejects clearly when there is no georeference and no tile manifest', async () => {
        const { fetchImpl, calls } = stubFetch({ elements: [] });
        const { ctx, course } = await setupCourse({});

        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toThrow(/no map area/i);
        expect(calls.length).toBe(0); // failed before any external request
    });

    test('404s for an unknown course', async () => {
        const { fetchImpl } = stubFetch({ elements: [] });
        const ctx = await createTestDb();

        await expect(service(ctx, fetchImpl).fetchForCourse('nope'))
            .rejects.toBeInstanceOf(NotFoundError);
    });

    test('maps Overpass 429 to a clear rate-limit message', async () => {
        const { fetchImpl } = stubFetch({}, 429);
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toThrow(/rate-limiting.*429/);
    });

    test('maps Overpass 504 to a clear busy message', async () => {
        const { fetchImpl } = stubFetch({}, 504);
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toThrow(/timed out.*504/);
    });

    test('wraps network failures as a ConflictError', async () => {
        const fetchImpl: OsmFetchImpl = async () => {
            throw new Error('getaddrinfo ENOTFOUND overpass-api.de');
        };
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toBeInstanceOf(ConflictError);
        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toThrow(/Overpass request failed/);
    });
});
