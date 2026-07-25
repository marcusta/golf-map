import { describe, expect, test } from 'bun:test';
import type { SampleGrid } from '../../shared/api/analysis.gen';
import type { FeatureGeometry } from '../src/geo/bezier';
import { greenBounds, greenRingsWgs84 } from '../src/mobile/green/green-frame';
import {
    arrowLengthM,
    arrowsGeojson,
    boundaryGeojson,
    gridCorners,
} from '../src/mobile/green/green-overlay';
import { clampStimp } from '../src/mobile/green/stimp-session';
import { greenRoute, swapKey } from '../src/mobile/app/route-key';
import { sweref99tmToWgs84 } from '../src/geo/transform';

const E0 = 532_950;
const N0 = 6_473_700;

const square: FeatureGeometry = {
    crs: 'EPSG:3006',
    rings: [{
        points: [
            { x: E0, y: N0 },
            { x: E0 + 20, y: N0 },
            { x: E0 + 20, y: N0 + 20 },
            { x: E0, y: N0 + 20 },
        ],
    }],
};

describe('green-frame', () => {
    test('rings come back in WGS84 lng/lat, explicitly closed', () => {
        const rings = greenRingsWgs84(square);
        expect(rings).toHaveLength(1);
        const ring = rings[0]!;
        expect(ring.length).toBeGreaterThanOrEqual(5);
        expect(ring[0]).toEqual(ring[ring.length - 1]!);
        const [lng, lat] = ring[0]!;
        expect(lng!).toBeGreaterThan(15);
        expect(lng!).toBeLessThan(16);
        expect(lat!).toBeGreaterThan(58);
        expect(lat!).toBeLessThan(59);
    });

    test('bounds span the whole green as [w, s, e, n]', () => {
        const bbox = greenBounds(square)!;
        const sw = sweref99tmToWgs84(E0, N0);
        const ne = sweref99tmToWgs84(E0 + 20, N0 + 20);
        expect(bbox[0]).toBeLessThanOrEqual(sw.lon + 1e-9);
        expect(bbox[1]).toBeLessThanOrEqual(sw.lat + 1e-9);
        expect(bbox[2]).toBeGreaterThanOrEqual(ne.lon - 1e-9);
        expect(bbox[3]).toBeGreaterThanOrEqual(ne.lat - 1e-9);
        // A green frame is TIGHT — a 20 m box is a fraction of a degree.
        expect(bbox[2] - bbox[0]).toBeLessThan(0.001);
    });

    test('null bounds for an empty geometry', () => {
        expect(greenBounds({ crs: 'EPSG:3006', rings: [] })).toBeNull();
    });
});

describe('green-overlay geometry', () => {
    const grid: SampleGrid = {
        origin: { e: E0, n: N0 + 20 },
        resolution: 0.5,
        width: 40,
        height: 40,
        values: new Array(1600).fill(10),
    } as unknown as SampleGrid;

    test('grid corners run TL, TR, BR, BL (image-source order)', () => {
        const [tl, tr, br, bl] = gridCorners(grid);
        expect(tr[0]).toBeGreaterThan(tl[0]!); // east of top-left
        expect(bl[1]).toBeLessThan(tl[1]!);    // south of top-left
        // Same easting/northing edge — equal to within grid convergence
        // (a projected square is not a lng/lat rectangle).
        expect(br[0]).toBeCloseTo(tr[0]!, 4);
        expect(br[1]).toBeCloseTo(bl[1]!, 4);
    });

    test('boundary is one LineString per ring', () => {
        const fc = boundaryGeojson(square);
        expect(fc.features).toHaveLength(1);
        expect(fc.features[0]!.geometry.type).toBe('LineString');
    });

    test('each arrow renders as a shaft plus two head strokes', () => {
        const fc = arrowsGeojson(
            [{ e: E0 + 10, n: N0 + 10, dirE: 1, dirN: 0, slopePct: 3, labeled: false }],
            2,
        );
        expect(fc.features).toHaveLength(3);
        expect(fc.features[0]!.properties!.slope).toBe(3);
        const shaft = fc.features[0]!.geometry as { coordinates: number[][] };
        expect(shaft.coordinates[1]![0]).toBeGreaterThan(shaft.coordinates[0]![0]!); // points east
    });

    test('arrow length stays inside the legible band for any green size', () => {
        for (const [width, height] of [[20, 20], [200, 160], [8, 8]]) {
            const len = arrowLengthM({ ...grid, width: width!, height: height! });
            expect(len).toBeGreaterThanOrEqual(1.2);
            expect(len).toBeLessThanOrEqual(3.5);
        }
    });
});

describe('stimp clamping', () => {
    test('holds the desktop 4–16 ft range', () => {
        expect(clampStimp(10)).toBe(10);
        expect(clampStimp(3)).toBe(4);
        expect(clampStimp(99)).toBe(16);
    });

    test('garbage reads as the default, never NaN', () => {
        expect(clampStimp(Number.NaN)).toBe(10);
    });
});

describe('mobile swap key', () => {
    test('the green route gets its own prefix so $swap can reach it', () => {
        expect(swapKey('/m/course/c1/hole/7/green')).toBe('/m/green/c1/hole/7');
    });

    test('every other route passes through untouched', () => {
        for (const route of ['/m', '/m/login', '/m/course/c1/hole/7', '/m/course/c1']) {
            expect(swapKey(route)).toBe(route);
        }
    });

    test('greenRoute round-trips through swapKey', () => {
        expect(swapKey(greenRoute('c1', 3))).toBe('/m/green/c1/hole/3');
        // The screens parse the ORIGINAL route: [3] = course id, [5] = hole no.
        const parts = greenRoute('c1', 3).split('/');
        expect(parts[3]).toBe('c1');
        expect(parts[5]).toBe('3');
    });
});
