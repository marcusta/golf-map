import { test, expect, describe } from 'bun:test';
import {
    flattenRing,
    toGeoJson,
    wgs84ToSweref99tm,
    sweref99tmToWgs84,
    type PathRing,
    type FeatureGeometry,
} from './geo';

// ============================================================================
// SWEREF 99 TM <-> WGS84 transform accuracy
// ============================================================================

// Authoritative control points published by Lantmäteriet (the Swedish
// national land survey), "Kontrollpunkter för SWEREF 99 TM", 2007-11-20:
// https://www.lantmateriet.se/contentassets/a7ddfc3b7821498da8b55cd3f71b5150/kontrollpunkter_sweref99tm.pdf
// These are the same authority's own reference values for verifying that a
// software implementation projects to SWEREF 99 TM correctly.
const LANTMATERIET_CONTROL_POINTS = [
    { latDeg: 55, latMin: 0, lonDeg: 12, lonMin: 45, N: 6097106.672, E: 356083.438 },
    { latDeg: 55, latMin: 0, lonDeg: 14, lonMin: 15, N: 6095048.642, E: 452024.069 },
    { latDeg: 57, latMin: 0, lonDeg: 12, lonMin: 45, N: 6319636.937, E: 363331.554 },
    { latDeg: 57, latMin: 0, lonDeg: 19, lonMin: 30, N: 6326392.707, E: 773251.054 },
    { latDeg: 59, latMin: 0, lonDeg: 11, lonMin: 15, N: 6546096.724, E: 284626.066 },
    { latDeg: 59, latMin: 0, lonDeg: 19, lonMin: 30, N: 6548757.206, E: 758410.519 },
    { latDeg: 61, latMin: 0, lonDeg: 12, lonMin: 45, N: 6764877.311, E: 378323.44 },
    { latDeg: 61, latMin: 0, lonDeg: 18, lonMin: 45, N: 6768593.345, E: 702745.127 },
    { latDeg: 63, latMin: 0, lonDeg: 12, lonMin: 0, N: 6989134.048, E: 348083.148 },
    { latDeg: 63, latMin: 0, lonDeg: 19, lonMin: 30, N: 6993565.63, E: 727798.671 },
    { latDeg: 65, latMin: 0, lonDeg: 13, lonMin: 30, N: 7209293.753, E: 429270.201 },
    { latDeg: 65, latMin: 0, lonDeg: 21, lonMin: 45, N: 7225449.115, E: 817833.405 },
    { latDeg: 67, latMin: 0, lonDeg: 16, lonMin: 30, N: 7432168.174, E: 565398.458 },
    { latDeg: 67, latMin: 0, lonDeg: 24, lonMin: 0, N: 7459745.672, E: 891298.142 },
    { latDeg: 69, latMin: 0, lonDeg: 21, lonMin: 0, N: 7666089.698, E: 739639.195 },
];

describe('wgs84ToSweref99tm — Lantmäteriet control points (forward)', () => {
    for (const cp of LANTMATERIET_CONTROL_POINTS) {
        const lat = cp.latDeg + cp.latMin / 60;
        const lon = cp.lonDeg + cp.lonMin / 60;
        test(`lat=${cp.latDeg}°${cp.latMin}' lon=${cp.lonDeg}°${cp.lonMin}' -> N=${cp.N} E=${cp.E}`, () => {
            const { x, y } = wgs84ToSweref99tm(lat, lon);
            // Published control points are used by Lantmäteriet to verify
            // third-party software; require < 0.02 m error against them.
            expect(Math.abs(x - cp.E)).toBeLessThan(0.02);
            expect(Math.abs(y - cp.N)).toBeLessThan(0.02);
        });
    }
});

describe('sweref99tmToWgs84 — Lantmäteriet control points (inverse)', () => {
    for (const cp of LANTMATERIET_CONTROL_POINTS) {
        const lat = cp.latDeg + cp.latMin / 60;
        const lon = cp.lonDeg + cp.lonMin / 60;
        test(`N=${cp.N} E=${cp.E} -> lat=${cp.latDeg}°${cp.latMin}' lon=${cp.lonDeg}°${cp.lonMin}'`, () => {
            const { lat: latOut, lon: lonOut } = sweref99tmToWgs84(cp.E, cp.N);
            // 2e-5 deg ~= 1.5-2 m at these latitudes; well under golf-course scale.
            expect(Math.abs(latOut - lat)).toBeLessThan(2e-5);
            expect(Math.abs(lonOut - lon)).toBeLessThan(2e-5);
        });
    }
});

describe('SWEREF 99 TM projection sanity constraints', () => {
    test('central meridian (15°E) maps to false easting 500000', () => {
        for (const lat of [55, 58.4, 60, 65, 69]) {
            const { x } = wgs84ToSweref99tm(lat, 15.0);
            expect(Math.abs(x - 500000)).toBeLessThan(1e-6);
        }
    });

    test('northing increases monotonically with latitude along the central meridian', () => {
        const lats = [55, 57, 59, 61, 63, 65, 67, 69];
        const northings = lats.map((lat) => wgs84ToSweref99tm(lat, 15.0).y);
        for (let i = 1; i < northings.length; i++) {
            expect(northings[i]).toBeGreaterThan(northings[i - 1]);
        }
    });

    test('northing along central meridian approximates scale-factor-adjusted meridian arc length from equator', () => {
        // Independent check using the standard GRS80 meridian arc series
        // (Bowring), cross-checking the projection's own internal meridian
        // distance term isn't wildly off from a textbook formula.
        const a = 6378137.0;
        const f = 1 / 298.257222101;
        const e2 = f * (2 - f);
        const e4 = e2 * e2;
        const e6 = e4 * e2;
        const meridianArc = (latDeg: number) => {
            const phi = (latDeg * Math.PI) / 180;
            const A0 = 1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256;
            const A2 = (3 / 8) * (e2 + e4 / 4 + (15 * e6) / 128);
            const A4 = (15 / 256) * (e4 + (3 * e6) / 4);
            const A6 = (35 * e6) / 3072;
            return a * (A0 * phi - A2 * Math.sin(2 * phi) + A4 * Math.sin(4 * phi) - A6 * Math.sin(6 * phi));
        };
        for (const lat of [55, 60, 65, 69]) {
            const { y } = wgs84ToSweref99tm(lat, 15.0);
            const expected = 0.9996 * meridianArc(lat);
            expect(Math.abs(y - expected)).toBeLessThan(0.01);
        }
    });
});

describe('round-trip stability', () => {
    const points: Array<[number, number]> = [
        [55.5, 13.0],
        [58.4015, 15.5658], // golf-map test course location
        [59.33, 18.06], // Stockholm
        [63.8, 20.3], // Sundsvall
        [67.85, 20.2], // near Luleå
        [69.0, 23.0], // far north/east extreme
        [55.3, 12.5], // far south/west extreme
    ];

    for (const [lat, lon] of points) {
        test(`round trip at lat=${lat} lon=${lon} is stable to < 1e-4 deg`, () => {
            const { x, y } = wgs84ToSweref99tm(lat, lon);
            const back = sweref99tmToWgs84(x, y);
            expect(Math.abs(back.lat - lat)).toBeLessThan(1e-4);
            expect(Math.abs(back.lon - lon)).toBeLessThan(1e-4);
        });
    }
});

// ============================================================================
// flattenRing
// ============================================================================

describe('flattenRing', () => {
    test('straight-edged ring (no handles) returns just the anchor points', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        const flat = flattenRing(ring, 0.25);
        expect(flat).toEqual([
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
        ]);
    });

    test('bezier segment is subdivided into multiple points', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        const flat = flattenRing(ring, 0.25);
        // Straight edges contribute exactly their anchor point; the curved
        // edge should contribute intermediate points beyond the two anchors.
        expect(flat.length).toBeGreaterThan(4);
    });

    test('finer tolerance produces more subdivision points', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        const coarse = flattenRing(ring, 2.0);
        const fine = flattenRing(ring, 0.1);
        expect(fine.length).toBeGreaterThan(coarse.length);
    });

    test('single-point ring returns that point', () => {
        const ring: PathRing = { points: [{ x: 5, y: 5 }] };
        expect(flattenRing(ring, 0.25)).toEqual([[5, 5]]);
    });

    test('empty ring returns empty array', () => {
        expect(flattenRing({ points: [] }, 0.25)).toEqual([]);
    });

    test('curve endpoints match the anchor points exactly (bezier passes through anchors)', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
            ],
        };
        const flat = flattenRing(ring, 0.25);
        expect(flat[0]).toEqual([0, 0]);
        // second anchor point should appear somewhere in the sequence exactly
        expect(flat.some(([x, y]) => x === 10 && y === 0)).toBe(true);
    });
});

// ============================================================================
// toGeoJson
// ============================================================================

describe('toGeoJson', () => {
    // A small square near the test course's home coordinates, in EPSG:3006
    // meters (derived from wgs84ToSweref99tm(58.4015, 15.5658) plus a small
    // offset box) so the produced GeoJSON lands near the golf-map test data.
    const base = wgs84ToSweref99tm(58.4015, 15.5658);

    function squareRing(cx: number, cy: number, half: number): PathRing {
        return {
            points: [
                { x: cx - half, y: cy - half },
                { x: cx + half, y: cy - half },
                { x: cx + half, y: cy + half },
                { x: cx - half, y: cy + half },
            ],
        };
    }

    test('produces a closed Polygon with correct outer winding (CCW)', () => {
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [squareRing(base.x, base.y, 20)],
        };
        const gj = toGeoJson(geometry);
        expect(gj.type).toBe('Polygon');
        expect(gj.coordinates).toHaveLength(1);

        const ring = gj.coordinates[0];
        // Closed: first === last
        expect(ring[0]).toEqual(ring[ring.length - 1]);

        const area = shoelaceArea(ring);
        expect(area).toBeGreaterThan(0); // CCW in lon/lat
    });

    test('hole ring (second ring) is wound CW', () => {
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [squareRing(base.x, base.y, 20), squareRing(base.x, base.y, 5)],
        };
        const gj = toGeoJson(geometry);
        expect(gj.coordinates).toHaveLength(2);

        const outerArea = shoelaceArea(gj.coordinates[0]);
        const holeArea = shoelaceArea(gj.coordinates[1]);
        expect(outerArea).toBeGreaterThan(0); // CCW
        expect(holeArea).toBeLessThan(0); // CW
    });

    test('coordinates are in [lon, lat] order and land near the projected input', () => {
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            rings: [squareRing(base.x, base.y, 20)],
        };
        const gj = toGeoJson(geometry);
        const [lon, lat] = gj.coordinates[0][0];
        expect(lon).toBeGreaterThan(15);
        expect(lon).toBeLessThan(16);
        expect(lat).toBeGreaterThan(58);
        expect(lat).toBeLessThan(59);
    });

    test('a ring wound the "wrong" way in input is still normalized to correct output winding', () => {
        const forwardWinding = squareRing(base.x, base.y, 20);
        const reversedWinding: PathRing = { points: [...forwardWinding.points].reverse() };

        const gjForward = toGeoJson({ crs: 'EPSG:3006', rings: [forwardWinding] });
        const gjReversed = toGeoJson({ crs: 'EPSG:3006', rings: [reversedWinding] });

        expect(shoelaceArea(gjForward.coordinates[0])).toBeGreaterThan(0);
        expect(shoelaceArea(gjReversed.coordinates[0])).toBeGreaterThan(0);
    });
});

function shoelaceArea(ring: number[][]): number {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[i + 1];
        sum += x1 * y2 - x2 * y1;
    }
    return sum / 2;
}
