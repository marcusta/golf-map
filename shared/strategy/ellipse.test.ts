import { describe, expect, test } from 'bun:test';
import {
    bearingToUnitVector,
    dispersionEllipse,
    GREEN_RING_PAR5_EXTRA_M,
    GREEN_RING_RADII_M,
    greenRingRadiiM,
    ringPolygon,
    TEE_RING_RADII_M,
    type Vec2,
} from './ellipse';
import { mphToMps } from './units';
import { v1Club } from './fixtures/v1-clubs';

const ORIGIN: Vec2 = { x: 0, y: 0 };

describe('bearingToUnitVector — compass convention', () => {
    test('cardinal directions', () => {
        expect(bearingToUnitVector(0).x).toBeCloseTo(0, 12);
        expect(bearingToUnitVector(0).y).toBeCloseTo(1, 12); // north = +y
        expect(bearingToUnitVector(90).x).toBeCloseTo(1, 12); // east = +x
        expect(bearingToUnitVector(90).y).toBeCloseTo(0, 12);
        expect(bearingToUnitVector(180).y).toBeCloseTo(-1, 12);
        expect(bearingToUnitVector(270).x).toBeCloseTo(-1, 12);
    });
});

describe('dispersionEllipse — fixture E: 7i at bearing 45°, no wind', () => {
    const ellipse = dispersionEllipse({ origin: ORIGIN, bearingDeg: 45, club: v1Club('7i') });

    test('semi-axes are HALF the v1 full extents (12.4 × 32)', () => {
        expect(ellipse.semiLengthM).toBeCloseTo(6.2, 12);
        expect(ellipse.semiLateralM).toBeCloseTo(16, 12);
    });

    test('center = origin + nominal carry along bearing', () => {
        const expected = 155 * Math.SQRT1_2; // 109.60155…
        expect(ellipse.center.x).toBeCloseTo(expected, 9);
        expect(ellipse.center.y).toBeCloseTo(expected, 9);
        expect(ellipse.bearingDeg).toBe(45);
    });

    test('polygon is a closed ring of samples + 1 points', () => {
        expect(ellipse.polygon.length).toBe(49);
        expect(ellipse.polygon[48]).toEqual(ellipse.polygon[0]);
    });

    test('polygon starts at the down-range tip and hits the lateral extreme', () => {
        // t = 0 → center + semiLength along the bearing.
        const tip = ellipse.polygon[0];
        const along = bearingToUnitVector(45);
        expect(tip.x).toBeCloseTo(ellipse.center.x + 6.2 * along.x, 9);
        expect(tip.y).toBeCloseTo(ellipse.center.y + 6.2 * along.y, 9);
        // t = π/2 (sample 12 of 48) → center + semiLateral toward shot-right (bearing 135).
        const side = ellipse.polygon[12];
        const right = bearingToUnitVector(135);
        expect(side.x).toBeCloseTo(ellipse.center.x + 16 * right.x, 9);
        expect(side.y).toBeCloseTo(ellipse.center.y + 16 * right.y, 9);
    });

    test('every polygon point satisfies the ellipse equation in local axes', () => {
        const along = bearingToUnitVector(45);
        const right: Vec2 = { x: along.y, y: -along.x };
        for (const p of ellipse.polygon) {
            const dx = p.x - ellipse.center.x;
            const dy = p.y - ellipse.center.y;
            const u = dx * along.x + dy * along.y;
            const v = dx * right.x + dy * right.y;
            expect((u / 6.2) ** 2 + (v / 16) ** 2).toBeCloseTo(1, 9);
        }
    });
});

describe('dispersionEllipse — wind', () => {
    test('fixture A: Driver into 10 mph pure headwind → center at 218.7 m', () => {
        const e = dispersionEllipse({
            origin: ORIGIN,
            bearingDeg: 0,
            club: v1Club('Driver'),
            windSpeedMps: mphToMps(10),
            windDirectionDeg: 0,
        });
        expect(e.center.x).toBeCloseTo(0, 6);
        expect(e.center.y).toBeCloseTo(218.7, 6);
        // Axes are wind-independent.
        expect(e.semiLengthM).toBeCloseTo(19.44 / 2, 12);
        expect(e.semiLateralM).toBeCloseTo(32.5, 12);
    });

    test('pure crosswind from shot-left: center drifts right, carry unchanged', () => {
        const e = dispersionEllipse({
            origin: ORIGIN,
            bearingDeg: 0,
            club: v1Club('Driver'),
            windSpeedMps: mphToMps(10),
            windDirectionDeg: 270, // from due west; shot due north
        });
        expect(e.center.x).toBeCloseTo(12.15, 6); // 243 × 10 × 0.005, toward +x (right)
        expect(e.center.y).toBeCloseTo(243, 6); // headTail ≈ 0 → carry ≈ nominal
    });

    test('fixture C: quartering headwind shifts down-range AND drifts left', () => {
        const e = dispersionEllipse({
            origin: ORIGIN,
            bearingDeg: 0,
            club: v1Club('Driver'),
            windSpeedMps: mphToMps(15),
            windDirectionDeg: 45,
        });
        expect(e.center.y).toBeCloseTo(217.2259578, 6);
        // crosswind = −10.6066 mph → drift = 243 × −10.6066… × 0.005 (shot-left).
        expect(e.center.x).toBeCloseTo(243 * -10.606601717798213 * 0.005, 6);
    });

    test('no-wind call equals explicit zero wind', () => {
        const a = dispersionEllipse({ origin: ORIGIN, bearingDeg: 30, club: v1Club('PW') });
        const b = dispersionEllipse({
            origin: ORIGIN,
            bearingDeg: 30,
            club: v1Club('PW'),
            windSpeedMps: 0,
            windDirectionDeg: 0,
        });
        expect(a.center.x).toBeCloseTo(b.center.x, 9);
        expect(a.center.y).toBeCloseTo(b.center.y, 9);
    });
});

describe('distance rings', () => {
    test('v1 radii sets', () => {
        expect([...GREEN_RING_RADII_M]).toEqual([75, 100, 150]);
        expect(GREEN_RING_PAR5_EXTRA_M).toBe(200);
        expect([...TEE_RING_RADII_M]).toEqual([200, 250]);
        expect(greenRingRadiiM(4)).toEqual([75, 100, 150]);
        expect(greenRingRadiiM(5)).toEqual([75, 100, 150, 200]);
    });

    test('ringPolygon: closed ring of points at the exact radius', () => {
        const center: Vec2 = { x: 500, y: 1000 };
        const ring = ringPolygon(center, 150, 32);
        expect(ring.length).toBe(33);
        expect(ring[32]).toEqual(ring[0]);
        expect(ring[0].x).toBeCloseTo(500, 9); // starts due north
        expect(ring[0].y).toBeCloseTo(1150, 9);
        for (const p of ring) {
            expect(Math.hypot(p.x - center.x, p.y - center.y)).toBeCloseTo(150, 9);
        }
    });
});
