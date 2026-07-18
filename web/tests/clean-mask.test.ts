import { describe, expect, test } from 'bun:test';
import { planCrop } from '../src/sam/sam-crop';
import { fractionalTile } from '../src/geo/webmercator-tiles';
import {
    EARTH_RADIUS_M,
    MERCATOR_ORIGIN_SHIFT,
    dilateMask,
    ellipseRingLngLat,
    fillEllipseMask,
    fillPolygonMask,
    groundMetersPerPixel,
    lngLatToMercator,
    maskArea,
    mercatorMetersPerPixel,
    mercatorToCropPixel,
    mercatorToLngLat,
    planBounds3857,
} from '../src/clean/clean-mask';

// T55 — pure mask + Web-Mercator math for the Clean-photo tool.

const CLICK = { lng: 15.5658, lat: 58.4015 };
const ZOOM = 20;

describe('mercator math', () => {
    test('lngLat ↔ mercator round trips', () => {
        for (const p of [CLICK, { lng: -0.1, lat: 51.5 }, { lng: 24.1, lat: 65.8 }]) {
            const m = lngLatToMercator(p);
            const back = mercatorToLngLat(m.x, m.y);
            expect(back.lng).toBeCloseTo(p.lng, 9);
            expect(back.lat).toBeCloseTo(p.lat, 9);
        }
    });

    test('known anchors: lng 180 → +origin shift; equator meter scale', () => {
        expect(lngLatToMercator({ lng: 180, lat: 0 }).x).toBeCloseTo(MERCATOR_ORIGIN_SHIFT, 6);
        expect(lngLatToMercator({ lng: 0, lat: 0 }).x).toBe(0);
        expect(lngLatToMercator({ lng: 0, lat: 0 }).y).toBeCloseTo(0, 6);
        // 1° of longitude at the equator ≈ 111.32 km in EPSG:3857.
        expect(lngLatToMercator({ lng: 1, lat: 0 }).x).toBeCloseTo((Math.PI * EARTH_RADIUS_M) / 180, 6);
    });

    test('meters per pixel: z0 world = one 256px tile; ground scale shrinks by cos(lat)', () => {
        expect(mercatorMetersPerPixel(0) * 256).toBeCloseTo(2 * MERCATOR_ORIGIN_SHIFT, 6);
        const merc = mercatorMetersPerPixel(ZOOM);
        const ground = groundMetersPerPixel(ZOOM, CLICK.lat);
        expect(ground).toBeCloseTo(merc * Math.cos((CLICK.lat * Math.PI) / 180), 12);
        // Sanity: z20 in mid-Sweden is ~8 cm ground pixels.
        expect(ground).toBeGreaterThan(0.07);
        expect(ground).toBeLessThan(0.09);
    });
});

describe('planBounds3857', () => {
    test('agrees with the independent fractional-tile forward path', () => {
        const plan = planCrop(CLICK.lng, CLICK.lat, ZOOM)!;
        const b = planBounds3857(plan);
        expect(b.west).toBeLessThan(b.east);
        expect(b.south).toBeLessThan(b.north);

        // The crop's top-left corner, mapped back to lng/lat and re-projected
        // through fractionalTile, must land exactly at originX/originY.
        const tl = mercatorToLngLat(b.west, b.north);
        const f = fractionalTile(tl.lng, tl.lat, plan.zoom);
        expect(f.x * plan.tileSize).toBeCloseTo(plan.originX, 6);
        expect(f.y * plan.tileSize).toBeCloseTo(plan.originY, 6);

        // Width/height are exactly size pixels of mercator meters.
        const mpp = mercatorMetersPerPixel(plan.zoom, plan.tileSize);
        expect(b.east - b.west).toBeCloseTo(plan.size * mpp, 9);
        expect(b.north - b.south).toBeCloseTo(plan.size * mpp, 9);

        // The click itself sits at the crop center (±0.5 px snap).
        const click = lngLatToMercator(CLICK);
        const c = mercatorToCropPixel(plan, click.x, click.y);
        expect(Math.abs(c.px - plan.size / 2)).toBeLessThanOrEqual(1);
        expect(Math.abs(c.py - plan.size / 2)).toBeLessThanOrEqual(1);
    });
});

describe('fillPolygonMask', () => {
    test('a rectangle fills exactly its pixel-center area', () => {
        // [10, 20) x [30, 50): pixel centers 10..19 / 30..49 inside.
        const mask = fillPolygonMask(64, [[10, 30], [20, 30], [20, 50], [10, 50]]);
        expect(maskArea(mask)).toBe(10 * 20);
        expect(mask[30 * 64 + 10]).toBe(1);
        expect(mask[49 * 64 + 19]).toBe(1);
        expect(mask[29 * 64 + 10]).toBe(0);
        expect(mask[30 * 64 + 20]).toBe(0);
    });

    test('a circle contour fills ≈ its analytic area; degenerate polygons are empty', () => {
        const n = 90;
        const circle = Array.from({ length: n }, (_, i) => {
            const t = (i / n) * 2 * Math.PI;
            return [32 + 20 * Math.cos(t), 32 + 20 * Math.sin(t)];
        });
        const area = maskArea(fillPolygonMask(64, circle));
        expect(Math.abs(area - Math.PI * 400) / (Math.PI * 400)).toBeLessThan(0.05);
        expect(maskArea(fillPolygonMask(64, [[1, 1], [2, 2]]))).toBe(0);
    });
});

describe('fillEllipseMask', () => {
    test('fills ≈ πab and stays inside the bounding box', () => {
        const mask = fillEllipseMask(128, 64, 64, 30, 18);
        const area = maskArea(mask);
        expect(Math.abs(area - Math.PI * 30 * 18) / (Math.PI * 30 * 18)).toBeLessThan(0.05);
        expect(mask[64 * 128 + 64]).toBe(1);
        expect(mask[64 * 128 + 95]).toBe(0); // beyond rx
        expect(mask[(64 - 19) * 128 + 64]).toBe(0); // beyond ry
    });

    test('clamps to the crop and zero radii are empty', () => {
        const clipped = fillEllipseMask(32, 0, 0, 10, 10);
        expect(maskArea(clipped)).toBeGreaterThan(0);
        expect(maskArea(clipped)).toBeLessThan(Math.PI * 100); // quarter visible
        expect(maskArea(fillEllipseMask(32, 16, 16, 0, 5))).toBe(0);
    });
});

describe('dilateMask', () => {
    test('grows a single pixel into a disc of the given radius', () => {
        const size = 32;
        const mask = new Uint8Array(size * size);
        mask[16 * size + 16] = 1;
        const grown = dilateMask(mask, size, 3);
        let expected = 0;
        for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 9) expected++;
        }
        expect(maskArea(grown)).toBe(expected);
        expect(grown[13 * size + 16]).toBe(1);
        expect(grown[12 * size + 16]).toBe(0);
    });

    test('radius 0 copies; original mask is never mutated', () => {
        const size = 8;
        const mask = new Uint8Array(size * size);
        mask[3 * size + 3] = 1;
        const copy = dilateMask(mask, size, 0);
        expect([...copy]).toEqual([...mask]);
        const grown = dilateMask(mask, size, 2);
        expect(maskArea(mask)).toBe(1);
        expect(maskArea(grown)).toBeGreaterThan(1);
    });
});

describe('ellipseRingLngLat', () => {
    test('ring spans the drag bbox and closes', () => {
        const a = CLICK;
        const b = { lng: CLICK.lng + 0.0004, lat: CLICK.lat + 0.0002 };
        const ring = ellipseRingLngLat(a, b, 32);
        expect(ring).toHaveLength(33);
        expect(ring[0]).toEqual(ring[32]);
        const lngs = ring.map(p => p[0]);
        const lats = ring.map(p => p[1]);
        expect(Math.min(...lngs)).toBeGreaterThanOrEqual(Math.min(a.lng, b.lng) - 1e-9);
        expect(Math.max(...lngs)).toBeLessThanOrEqual(Math.max(a.lng, b.lng) + 1e-9);
        expect(Math.min(...lats)).toBeGreaterThanOrEqual(Math.min(a.lat, b.lat) - 1e-9);
        expect(Math.max(...lats)).toBeLessThanOrEqual(Math.max(a.lat, b.lat) + 1e-9);
    });
});
