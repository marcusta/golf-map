import { test, expect, describe } from 'bun:test';
import {
    flattenRing,
    toGeoJson,
    wgs84ToSweref99tm,
    sweref99tmToWgs84,
    expandBsplineControls,
    bsplineRingToBezier,
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
// B-spline (curveType: 'bspline')
// ============================================================================

function cubicAt(
    p0: { x: number; y: number },
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
    t: number,
): [number, number] {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [
        a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    ];
}

describe('expandBsplineControls', () => {
    test('smooth points appear once, corner points are triplicated', () => {
        const out = expandBsplineControls([
            { x: 0, y: 0 },
            { x: 10, y: 0, corner: true },
            { x: 10, y: 10 },
        ]);
        expect(out).toEqual([
            { x: 0, y: 0 },
            { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 },
            { x: 10, y: 10 },
        ]);
    });
});

describe('bsplineRingToBezier', () => {
    // Reference fixture shared verbatim with the client parity tests
    // (web/tests/bspline.test.ts): a 10x10 square of 4 smooth controls.
    const square: PathRing = {
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    };

    test('exact conversion values for the 4-control square', () => {
        const bez = bsplineRingToBezier(square);
        expect(bez.points).toHaveLength(4);
        const [a0, a1, a2, a3] = bez.points;

        // start_i = (p_i + 4·p_{i+1} + p_{i+2}) / 6
        expect(a0.x).toBeCloseTo(50 / 6, 12);
        expect(a0.y).toBeCloseTo(10 / 6, 12);
        expect(a1.x).toBeCloseTo(50 / 6, 12);
        expect(a1.y).toBeCloseTo(50 / 6, 12);
        expect(a2.x).toBeCloseTo(10 / 6, 12);
        expect(a2.y).toBeCloseTo(50 / 6, 12);
        expect(a3.x).toBeCloseTo(10 / 6, 12);
        expect(a3.y).toBeCloseTo(10 / 6, 12);

        // cp1_0 = (2·p1 + p2)/3, cp2_0 = (p1 + 2·p2)/3
        expect(a0.hOut!.x).toBeCloseTo(10, 12);
        expect(a0.hOut!.y).toBeCloseTo(10 / 3, 12);
        expect(a1.hIn!.x).toBeCloseTo(10, 12);
        expect(a1.hIn!.y).toBeCloseTo(20 / 3, 12);
    });

    test('closed wrap: every segment ends exactly where the next begins', () => {
        const bez = bsplineRingToBezier(square);
        const n = bez.points.length;
        for (let i = 0; i < n; i++) {
            const a = bez.points[i];
            const b = bez.points[(i + 1) % n];
            const [ex, ey] = cubicAt({ x: a.x, y: a.y }, a.hOut!, b.hIn!, { x: b.x, y: b.y }, 1);
            expect(ex).toBeCloseTo(b.x, 12);
            expect(ey).toBeCloseTo(b.y, 12);
        }
    });

    test('4 controls in a square flatten to a near-circle', () => {
        const flat = flattenRing(square, 0.05, 'bspline');
        expect(flat.length).toBeGreaterThan(40);
        const cx = 5, cy = 5;
        const radii = flat.map(([x, y]) => Math.hypot(x - cx, y - cy));
        const rMin = Math.min(...radii);
        const rMax = Math.max(...radii);
        // Theoretical: r ranges 11s/12 .. (2√2/3)s for half-size s=5
        // (4.583..4.714) — a ~3% wobble. Anything under 5% is circle-like.
        expect(rMax / rMin).toBeLessThan(1.05);
        expect((rMax + rMin) / 2).toBeGreaterThan(4.3);
        expect((rMax + rMin) / 2).toBeLessThan(4.9);
    });

    test('corner triplication forces the curve through the point with a sharp vertex', () => {
        const withCorner: PathRing = {
            points: [
                { x: 0, y: 0 },
                { x: 10, y: 0, corner: true },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        const flat = flattenRing(withCorner, 0.1, 'bspline');

        // The corner control lies ON the curve, exactly.
        const idx = flat.findIndex(([x, y]) => x === 10 && y === 0);
        expect(idx).toBeGreaterThanOrEqual(0);

        // Sharp turn at the corner: direction change well above the smooth
        // flattening step (~few degrees).
        const prev = flat[(idx - 1 + flat.length) % flat.length];
        const next = flat[(idx + 1) % flat.length];
        const inAngle = Math.atan2(flat[idx][1] - prev[1], flat[idx][0] - prev[0]);
        const outAngle = Math.atan2(next[1] - flat[idx][1], next[0] - flat[idx][0]);
        let turn = Math.abs(outAngle - inAngle);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        expect(turn).toBeGreaterThan(Math.PI / 4); // > 45°

        // The all-smooth square never turns that hard anywhere.
        const smoothFlat = flattenRing(square, 0.1, 'bspline');
        let maxTurn = 0;
        for (let i = 0; i < smoothFlat.length; i++) {
            const a = smoothFlat[(i - 1 + smoothFlat.length) % smoothFlat.length];
            const b = smoothFlat[i];
            const c = smoothFlat[(i + 1) % smoothFlat.length];
            const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
            const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
            let d = Math.abs(t2 - t1);
            if (d > Math.PI) d = 2 * Math.PI - d;
            maxTurn = Math.max(maxTurn, d);
        }
        expect(maxTurn).toBeLessThan(Math.PI / 8); // < 22.5°
    });

    test('flattened b-spline is a continuous closed loop (no jumps at the wrap)', () => {
        const flat = flattenRing(square, 0.25, 'bspline');
        let maxStep = 0;
        for (let i = 0; i < flat.length; i++) {
            const [x1, y1] = flat[i];
            const [x2, y2] = flat[(i + 1) % flat.length]; // includes last→first
            maxStep = Math.max(maxStep, Math.hypot(x2 - x1, y2 - y1));
        }
        expect(maxStep).toBeLessThan(1.0); // tolerance-scale steps only
    });

    test('flattenRing without curveType (or explicit bezier) is unchanged bezier behavior', () => {
        const ring: PathRing = {
            points: [
                { x: 0, y: 0, hOut: { x: 3, y: 5 } },
                { x: 10, y: 0, hIn: { x: 7, y: 5 } },
                { x: 10, y: 10 },
                { x: 0, y: 10 },
            ],
        };
        expect(flattenRing(ring, 0.25, 'bezier')).toEqual(flattenRing(ring, 0.25));
    });
});

describe('toGeoJson with bspline geometry', () => {
    const base = wgs84ToSweref99tm(58.4015, 15.5658);

    test('produces a valid closed CCW polygon from spline controls', () => {
        const geometry: FeatureGeometry = {
            crs: 'EPSG:3006',
            curveType: 'bspline',
            rings: [{
                points: [
                    { x: base.x - 20, y: base.y - 20 },
                    { x: base.x + 20, y: base.y - 20 },
                    { x: base.x + 20, y: base.y + 20 },
                    { x: base.x - 20, y: base.y + 20 },
                ],
            }],
        };
        const gj = toGeoJson(geometry);
        expect(gj.type).toBe('Polygon');
        const ring = gj.coordinates[0];
        expect(ring[0]).toEqual(ring[ring.length - 1]); // closed
        expect(ring.length).toBeGreaterThan(20); // actually curved
        expect(shoelaceArea(ring)).toBeGreaterThan(0); // CCW
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
