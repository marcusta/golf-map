import { test, expect, describe } from 'bun:test';
import {
    fractionalTile,
    fractionalTileToLonLat,
    tileAt,
    tilePixelAt,
    tileBoundingBox,
} from '../src/geo/webmercator-tiles';
import { lngLatToTilePixel } from '../src/map/elevation.service';
import { sweref99tmToWgs84, lngLatToSweref99tm } from '../src/geo/transform';

// Pure Web-Mercator XYZ tile math (T45) — the module mirrors
// ios/GolfMap/Geo/WebMercatorTiles.swift, which itself was ported from
// elevation.service.ts's lngLatToTilePixel, so all three must agree.

const MERCATOR_LAT_LIMIT = 85.05112877980659;

describe('fractionalTile / tileAt', () => {
    test('the null island sits at the exact center of the pyramid', () => {
        const f = fractionalTile(0, 0, 1);
        expect(f.x).toBeCloseTo(1, 12);
        expect(f.y).toBeCloseTo(1, 12);
        expect(tileAt(0, 0, 1)).toEqual({ z: 1, x: 1, y: 1 });
    });

    test('pinned tiles for known Swedish locations at z16', () => {
        // Landeryd (the test course) and central Stockholm.
        expect(tileAt(15.5658, 58.4015, 16)).toEqual({ z: 16, x: 35601, y: 19600 });
        expect(tileAt(18.0686, 59.3293, 16)).toEqual({ z: 16, x: 36057, y: 19273 });
    });

    test('the mercator latitude limit maps to the pyramid edge', () => {
        expect(fractionalTile(0, MERCATOR_LAT_LIMIT, 0).y).toBeCloseTo(0, 9);
        expect(fractionalTile(0, -MERCATOR_LAT_LIMIT, 0).y).toBeCloseTo(1, 9);
    });
});

describe('tilePixelAt', () => {
    test('agrees with elevation.service.ts lngLatToTilePixel (the original port source)', () => {
        for (const [lng, lat, z] of [[15.5658, 58.4015, 16], [18.0686, 59.3293, 14], [12.5, 55.3, 19]] as const) {
            expect(tilePixelAt(lng, lat, z)).toEqual(lngLatToTilePixel(lng, lat, z));
        }
    });

    test('tile + pixel recompose to the fractional tile coordinate', () => {
        const { x, y } = fractionalTile(15.5658, 58.4015, 19);
        const tp = tilePixelAt(15.5658, 58.4015, 19);
        expect(tp.tileX + tp.px / 256).toBeCloseTo(x, 9);
        expect(tp.tileY + tp.py / 256).toBeCloseTo(y, 9);
        expect(tp.px).toBeGreaterThanOrEqual(0);
        expect(tp.px).toBeLessThan(256);
        expect(tp.py).toBeGreaterThanOrEqual(0);
        expect(tp.py).toBeLessThan(256);
    });

    test('honors a non-default tile size', () => {
        const tp256 = tilePixelAt(15.5658, 58.4015, 16, 256);
        const tp512 = tilePixelAt(15.5658, 58.4015, 16, 512);
        expect(tp512.tileX).toBe(tp256.tileX);
        expect(tp512.px).toBeCloseTo(tp256.px * 2, 9);
    });
});

describe('fractionalTileToLonLat (inverse)', () => {
    test('round trips fractionalTile at several positions and zooms', () => {
        for (const [lon, lat] of [[15.5658, 58.4015], [12.5, 55.3], [23.0, 69.0], [-71.06, 42.36]] as const) {
            for (const z of [10, 16, 19, 22]) {
                const f = fractionalTile(lon, lat, z);
                const back = fractionalTileToLonLat(f.x, f.y, z);
                expect(back.lon).toBeCloseTo(lon, 9);
                expect(back.lat).toBeCloseTo(lat, 9);
            }
        }
    });
});

describe('tileBoundingBox', () => {
    test('the z0 root tile spans the whole mercator world', () => {
        const bb = tileBoundingBox(0, 0, 0);
        expect(bb.west).toBeCloseTo(-180, 9);
        expect(bb.east).toBeCloseTo(180, 9);
        expect(bb.north).toBeCloseTo(MERCATOR_LAT_LIMIT, 9);
        expect(bb.south).toBeCloseTo(-MERCATOR_LAT_LIMIT, 9);
    });

    test('a position falls inside its own tile bounds', () => {
        const t = tileAt(15.5658, 58.4015, 16);
        const bb = tileBoundingBox(t.z, t.x, t.y);
        expect(15.5658).toBeGreaterThanOrEqual(bb.west);
        expect(15.5658).toBeLessThan(bb.east);
        expect(58.4015).toBeGreaterThan(bb.south);
        expect(58.4015).toBeLessThanOrEqual(bb.north);
    });
});

describe('trap-free out-of-domain guard (iOS parity)', () => {
    test('lat 553.9 (the live iOS crash value) degrades to an off-pyramid address, never NaN', () => {
        const t = tileAt(15.5658, 553.9, 17);
        expect(Number.isFinite(t.x)).toBe(true);
        expect(Number.isFinite(t.y)).toBe(true);
        const tp = tilePixelAt(15.5658, 553.9, 17);
        expect(tp.py).toBe(0);
        expect(Number.isFinite(tp.tileY)).toBe(true);
    });

    test('poles and NaN inputs degrade to off-pyramid addresses', () => {
        // lat 90 is finite in floating point (tan(π/2) ≈ 1.6e16) — a huge
        // negative but finite Y no pyramid contains; a NaN input hits the
        // non-finite sentinel. Either way: off-pyramid, never NaN.
        expect(tileAt(0, 90, 15).y).toBeLessThan(0);
        expect(Number.isFinite(tileAt(0, 90, 15).y)).toBe(true);
        expect(tileAt(Number.NaN, 58, 15).x).toBe(-1);
        expect(tilePixelAt(Number.NaN, 58, 15).px).toBe(0);
    });
});

describe('tile-pixel ↔ EPSG:3006 round trip (Lantmäteriet control points)', () => {
    // Same authoritative control points as transform.test.ts ("Kontrollpunkter
    // för SWEREF 99 TM", 2007-11-20) — the SAM assist georeferences ortho-crop
    // pixels through exactly this chain, so it must be metrically stable:
    // EPSG:3006 → WGS84 → tile pixel → (inverse) → WGS84 → EPSG:3006.
    const CONTROL_POINTS: Array<{ N: number; E: number }> = [
        { N: 6097106.672, E: 356083.438 }, // lat 55°, lon 12°45'
        { N: 6548757.206, E: 758410.519 }, // lat 59°, lon 19°30'
        { N: 7666089.698, E: 739639.195 }, // lat 69°, lon 21°
    ];

    for (const cp of CONTROL_POINTS) {
        test(`N=${cp.N} E=${cp.E} survives the pixel round trip at z19 to < 5 cm`, () => {
            const g = sweref99tmToWgs84(cp.E, cp.N);
            const tp = tilePixelAt(g.lon, g.lat, 19);
            const back = fractionalTileToLonLat(tp.tileX + tp.px / 256, tp.tileY + tp.py / 256, 19);
            const s = lngLatToSweref99tm({ lng: back.lon, lat: back.lat });
            // The tile math is an exact analytic inverse; the residual is the
            // (tiny) transform round-trip error, ≤ ~4 cm at Sweden's far north.
            expect(Math.abs(s.x - cp.E)).toBeLessThan(0.05);
            expect(Math.abs(s.y - cp.N)).toBeLessThan(0.05);
        });
    }
});
