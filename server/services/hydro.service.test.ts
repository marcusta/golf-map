// HydroService tests — fully offline. The Hydrografi Direkt OGC API is
// stubbed behind the fetchImpl seam (mirroring pipeline/tests/
// test_fetch_hydro.py): fixture pages hand-build OGC API Features
// responses including the service's live-verified quirks — EPSG:3006
// output arrives in the official (northing, easting) axis order, and
// paging is driven by `rel: next` links.

import { test, expect, describe } from 'bun:test';
import { createTestDb } from '../testing/db';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import {
    HydroService,
    swapAxes,
    parseDotenv,
    clipPolygonToBbox,
    clipPolylineToBbox,
    HYDRO_SOURCE,
    HYDRO_ATTRIBUTION,
    SUGGESTED_CREEK_WIDTH_M,
    CRS_3006_URI,
    type HydroFetchImpl,
} from './hydro.service';

// EPSG:3006 bbox around the Linköping test spot; georeference convention
// `{ bbox: [minX, minY, maxX, maxY] }` as written by the tile pipeline.
const BBOX_3006: [number, number, number, number] = [531000, 6472000, 534000, 6475000];
const GEOREF_JSON = JSON.stringify({ bbox: BBOX_3006 });

// WGS84 bounds as a tile manifest stores them (site-owned map).
const MANIFEST_BOUNDS = { west: 15.53, south: 58.39, east: 15.58, north: 58.42 };

/** Square ring centered inside BBOX_3006, in (easting, northing) = (x, y). */
function squareRing(cx: number, cy: number, half: number): number[][] {
    return [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half],
    ];
}

/** Encode coordinates the way the live service serves EPSG:3006 — (northing, easting). */
function ne(coords: number[][]): number[][] {
    return coords.map(([x, y]) => [y, x]);
}

function polygonFeature(id: string | number | undefined, ring: number[][]): Record<string, unknown> {
    return {
        type: 'Feature',
        ...(id !== undefined ? { id } : {}),
        geometry: { type: 'Polygon', coordinates: [ne(ring)] },
        properties: {},
    };
}

function lineFeature(id: string | number | undefined, points: number[][]): Record<string, unknown> {
    return {
        type: 'Feature',
        ...(id !== undefined ? { id } : {}),
        geometry: { type: 'LineString', coordinates: ne(points) },
        properties: {},
    };
}

function page(features: unknown[], nextHref?: string): Record<string, unknown> {
    const links: Array<Record<string, string>> = [{ rel: 'self', href: 'https://example.test/self' }];
    if (nextHref) links.push({ rel: 'next', href: nextHref });
    return { type: 'FeatureCollection', features, links };
}

/** Routes first pages by collection id in the URL, follow-ups by exact href. */
function stubFetch(
    firstPages: Record<string, unknown>,
    nextPages: Record<string, unknown> = {},
    status = 200,
) {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: HydroFetchImpl = async (url, init) => {
        calls.push({ url, headers: init.headers });
        const respond = (payload: unknown) => ({
            ok: status < 400,
            status,
            json: async () => payload,
        });
        if (url in nextPages) return respond(nextPages[url]);
        for (const [collection, payload] of Object.entries(firstPages)) {
            if (url.includes(`/collections/${collection}/items`)) return respond(payload);
        }
        throw new Error(`unexpected URL ${url}`);
    };
    return { fetchImpl, calls };
}

const CREDS = { user: 'someuser', pass: 'somepass' };

async function setupCourse(input: { georeferenceJson?: string; withManifest?: boolean; manifestMetaJson?: string }) {
    const ctx = await createTestDb();
    let siteId: string | undefined;
    if (input.withManifest) {
        const site = await ctx.sitesService.create({ name: 'Test site' });
        siteId = site.id;
    }
    const course = await ctx.coursesService.create({
        name: 'Hydro course',
        georeferenceJson: input.georeferenceJson,
        siteId,
    });
    if (siteId) {
        await ctx.assetsService.register({
            siteId,
            courseId: course.id, // course_assets.course_id FKs courses.id
            kind: 'tile_manifest',
            filename: 'manifest.json',
            metaJson: input.manifestMetaJson ?? JSON.stringify({ bounds: MANIFEST_BOUNDS }),
        });
    }
    return { ctx, course };
}

function service(
    ctx: Awaited<ReturnType<typeof createTestDb>>,
    fetchImpl: HydroFetchImpl,
    credentials: () => { user: string; pass: string } = () => CREDS,
) {
    return new HydroService({
        courses: ctx.coursesService,
        assets: ctx.assetsService,
        fetchImpl,
        credentials,
    });
}

const EMPTY_PAGES = {
    StandingWater: page([]),
    WatercoursePolygon: page([]),
    WatercourseLine: page([]),
};

// ─── pure helpers ────────────────────────────────────────────────────────────

describe('swapAxes', () => {
    test('flips positions at any nesting depth', () => {
        expect(swapAxes([6473000, 531500])).toEqual([531500, 6473000]);
        expect(swapAxes([[1, 2], [3, 4]])).toEqual([[2, 1], [4, 3]]);
        expect(swapAxes([[[6472900, 531400], [6473100, 531600]]]))
            .toEqual([[[531400, 6472900], [531600, 6473100]]]);
    });
});

describe('parseDotenv', () => {
    test('parses KEY=VALUE lines, strips quotes, skips comments/blank lines', () => {
        const parsed = parseDotenv('# comment\n\nLANTMATERIET_USER=alice\nLANTMATERIET_PASS="s3cret=x"\nBROKEN\n');
        expect(parsed).toEqual({ LANTMATERIET_USER: 'alice', LANTMATERIET_PASS: 's3cret=x' });
    });
});

describe('clipPolygonToBbox', () => {
    test('keeps an inside polygon (closed rings, holes preserved)', () => {
        const rings = [squareRing(532000, 6473500, 200), squareRing(532000, 6473500, 50)];
        const clipped = clipPolygonToBbox(rings, BBOX_3006);
        expect(clipped.length).toBe(1);
        expect(clipped[0].length).toBe(2); // hole survived
        const outer = clipped[0][0];
        expect(outer[0]).toEqual(outer[outer.length - 1]); // explicitly closed
    });

    test('clips a straddling polygon to the bbox edge', () => {
        // Pond straddling the east edge (x = 534000).
        const clipped = clipPolygonToBbox([squareRing(534000, 6473500, 100)], BBOX_3006);
        expect(clipped.length).toBe(1);
        for (const [x] of clipped[0][0]) expect(x).toBeLessThanOrEqual(534000);
        const xs = clipped[0][0].map(([x]) => x);
        expect(Math.min(...xs)).toBeCloseTo(533900, 5);
    });

    test('drops a polygon entirely outside the bbox', () => {
        expect(clipPolygonToBbox([squareRing(600000, 6600000, 100)], BBOX_3006)).toEqual([]);
    });
});

describe('clipPolylineToBbox', () => {
    test('clips a crossing line to the inside portion', () => {
        const runs = clipPolylineToBbox([[530000, 6473000], [532000, 6473000]], BBOX_3006);
        expect(runs).toEqual([[[531000, 6473000], [532000, 6473000]]]);
    });

    test('splits a line that exits and re-enters into two runs', () => {
        // Dips south of the bbox (y < 6472000) mid-line.
        const runs = clipPolylineToBbox(
            [[531500, 6472100], [532000, 6471000], [532500, 6472100]],
            BBOX_3006,
        );
        expect(runs.length).toBe(2);
        for (const run of runs) {
            expect(run.length).toBeGreaterThanOrEqual(2);
            for (const [, y] of run) expect(y).toBeGreaterThanOrEqual(6472000 - 1e-6);
        }
    });

    test('drops a line entirely outside', () => {
        expect(clipPolylineToBbox([[600000, 6600000], [600100, 6600100]], BBOX_3006)).toEqual([]);
    });
});

// ─── fetchForCourse ──────────────────────────────────────────────────────────

describe('HydroService.fetchForCourse', () => {
    test('returns swapped-axis water polygons and raw creek lines with provenance', async () => {
        const pond = squareRing(531500, 6473000, 100);
        const wide = squareRing(532500, 6473500, 80);
        const creek = [[531200, 6473200], [531200, 6474200]];
        const { fetchImpl, calls } = stubFetch({
            StandingWater: page([polygonFeature(123, pond)]),
            WatercoursePolygon: page([polygonFeature('wp-1', wide)]),
            WatercourseLine: page([lineFeature(9, creek)]),
        });
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);

        expect(result.source).toBe(HYDRO_SOURCE);
        expect(result.attribution).toBe(HYDRO_ATTRIBUTION);
        expect(result.suggestedCreekWidthM).toBe(SUGGESTED_CREEK_WIDTH_M);

        expect(result.water.length).toBe(2);
        expect(result.water[0].sourceRef).toBe('StandingWater/123');
        expect(result.water[1].sourceRef).toBe('WatercoursePolygon/wp-1');
        // (n, e) fixture came back as (e, n): every vertex of the original ring present.
        const ring = result.water[0].rings[0];
        for (const v of pond.slice(0, 4)) {
            expect(ring.some(([x, y]) => x === v[0] && y === v[1])).toBe(true);
        }

        expect(result.creeks.length).toBe(1);
        expect(result.creeks[0].sourceRef).toBe('WatercourseLine/9');
        expect(result.creeks[0].points).toEqual(creek);

        // Fetch mechanics: 3 collections, WGS84 bbox + 3006 output CRS + basic auth.
        expect(calls.length).toBe(3);
        const url = new URL(calls[0].url);
        expect(url.searchParams.get('crs')).toBe(CRS_3006_URI);
        expect(url.searchParams.get('limit')).toBe('1000');
        const bbox = url.searchParams.get('bbox')!.split(',').map(Number);
        // Georeference is EPSG:3006 → the API bbox must be WGS84 near Linköping.
        expect(bbox[0]).toBeGreaterThan(15.4); // west lon
        expect(bbox[0]).toBeLessThan(15.6);
        expect(bbox[1]).toBeGreaterThan(58.3); // south lat
        expect(bbox[1]).toBeLessThan(58.5);
        expect(bbox[2]).toBeGreaterThan(bbox[0]);
        expect(bbox[3]).toBeGreaterThan(bbox[1]);
        expect(calls[0].headers.Authorization)
            .toBe(`Basic ${Buffer.from('someuser:somepass').toString('base64')}`);
    });

    test('clips water and creeks to the course bbox (server bbox filter is intersects)', async () => {
        const straddling = squareRing(534000, 6473500, 100); // half outside east edge
        const farPond = squareRing(600000, 6600000, 100);
        const crossingCreek = [[530000, 6473000], [532000, 6473000]]; // enters from the west
        const { fetchImpl } = stubFetch({
            StandingWater: page([polygonFeature(1, straddling), polygonFeature(2, farPond)]),
            WatercoursePolygon: page([]),
            WatercourseLine: page([lineFeature(3, crossingCreek)]),
        });
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);

        expect(result.water.length).toBe(1); // far pond dropped
        for (const [x] of result.water[0].rings[0]) expect(x).toBeLessThanOrEqual(534000);
        expect(result.creeks.length).toBe(1);
        expect(result.creeks[0].points[0][0]).toBeCloseTo(531000, 6); // clipped at west edge
    });

    test('follows next links; params only on page 1', async () => {
        const nextUrl = 'https://api.lantmateriet.se/ogc-features/v1/hydrografi/collections/WatercourseLine/items?f=json&startindex=1';
        const creek1 = [[531200, 6473200], [531200, 6474200]];
        const creek2 = [[532000, 6473000], [532000, 6473500]];
        const { fetchImpl, calls } = stubFetch(
            {
                StandingWater: page([]),
                WatercoursePolygon: page([]),
                WatercourseLine: page([lineFeature(1, creek1)], nextUrl),
            },
            { [nextUrl]: page([lineFeature(2, creek2)]) },
        );
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);

        expect(result.creeks.map(c => c.sourceRef)).toEqual(['WatercourseLine/1', 'WatercourseLine/2']);
        // The next href is used verbatim (it carries the full query string).
        expect(calls.some(c => c.url === nextUrl)).toBe(true);
    });

    test('falls back to the site tile-manifest bounds when the course has no georeference', async () => {
        const { fetchImpl, calls } = stubFetch(EMPTY_PAGES);
        const { ctx, course } = await setupCourse({ withManifest: true });

        const result = await service(ctx, fetchImpl).fetchForCourse(course.id);

        expect(result.bbox).toEqual(MANIFEST_BOUNDS);
        const bbox = new URL(calls[0].url).searchParams.get('bbox');
        expect(bbox).toBe('15.53,58.39,15.58,58.42');
        expect(result.water).toEqual([]);
        expect(result.creeks).toEqual([]);
    });

    test('georeference wins over the site manifest when both exist', async () => {
        const { fetchImpl, calls } = stubFetch(EMPTY_PAGES);
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON, withManifest: true });

        await service(ctx, fetchImpl).fetchForCourse(course.id);

        const bbox = new URL(calls[0].url).searchParams.get('bbox')!.split(',').map(Number);
        expect(bbox[0]).toBeGreaterThan(15.4); // derived from the 3006 georeference,
        expect(bbox[0]).not.toBe(15.53); // not the manifest's west edge
    });

    test('rejects clearly when there is no georeference and no tile manifest', async () => {
        const { fetchImpl, calls } = stubFetch(EMPTY_PAGES);
        const { ctx, course } = await setupCourse({});

        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toThrow(/no map area/i);
        expect(calls.length).toBe(0); // failed before any external request
    });

    test('rejects clearly when the site manifest has no usable bounds', async () => {
        const { fetchImpl } = stubFetch(EMPTY_PAGES);
        const { ctx, course } = await setupCourse({ withManifest: true, manifestMetaJson: '{"nope":1}' });

        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toBeInstanceOf(ConflictError);
    });

    test('404s for an unknown course', async () => {
        const { fetchImpl } = stubFetch(EMPTY_PAGES);
        const ctx = await createTestDb();

        await expect(service(ctx, fetchImpl).fetchForCourse('nope'))
            .rejects.toBeInstanceOf(NotFoundError);
    });

    test('maps upstream 401/403 to the Geotorget entitlement message', async () => {
        const { fetchImpl } = stubFetch({ StandingWater: page([]) }, {}, 401);
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });

        await expect(service(ctx, fetchImpl).fetchForCourse(course.id))
            .rejects.toThrow(/Geotorget/);
    });

    test('surfaces credential errors before any request', async () => {
        let fetched = false;
        const fetchImpl: HydroFetchImpl = async () => {
            fetched = true;
            throw new Error('should not fetch');
        };
        const { ctx, course } = await setupCourse({ georeferenceJson: GEOREF_JSON });
        const svc = service(ctx, fetchImpl, () => {
            throw new ConflictError('Lantmäteriet credentials missing');
        });

        await expect(svc.fetchForCourse(course.id)).rejects.toThrow(/credentials missing/);
        expect(fetched).toBe(false);
    });
});
