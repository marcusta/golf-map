import { test, expect, describe } from 'bun:test';
import {
    wgs84ToSweref99tm,
    sweref99tmToWgs84,
    sweref99tmToLngLat,
    lngLatToSweref99tm,
} from '../src/geo/transform';

// Authoritative control points published by Lantmäteriet, "Kontrollpunkter
// för SWEREF 99 TM" (2007-11-20) — the SAME reference values the server's
// transform is verified against (server/services/geo.test.ts). The client
// port must reproduce them identically: geometry is authored client-side in
// EPSG:3006 meters and independently re-projected by the server.
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
            // 2e-5 deg ~= 1.5-2 m at these latitudes.
            expect(Math.abs(latOut - lat)).toBeLessThan(2e-5);
            expect(Math.abs(lonOut - lon)).toBeLessThan(2e-5);
        });
    }
});

describe('sanity + round trips', () => {
    test('central meridian (15°E) maps to false easting 500000', () => {
        for (const lat of [55, 58.4, 60, 65, 69]) {
            const { x } = wgs84ToSweref99tm(lat, 15.0);
            expect(Math.abs(x - 500000)).toBeLessThan(1e-6);
        }
    });

    const points: Array<[number, number]> = [
        [55.5, 13.0],
        [58.4015, 15.5658], // golf-map test course location (Landeryd)
        [59.33, 18.06],
        [63.8, 20.3],
        [67.85, 20.2],
        [69.0, 23.0],
        [55.3, 12.5],
    ];
    for (const [lat, lon] of points) {
        test(`round trip at lat=${lat} lon=${lon} is stable to < 1e-4 deg`, () => {
            const { x, y } = wgs84ToSweref99tm(lat, lon);
            const back = sweref99tmToWgs84(x, y);
            expect(Math.abs(back.lat - lat)).toBeLessThan(1e-4);
            expect(Math.abs(back.lon - lon)).toBeLessThan(1e-4);
        });
    }

    test('lngLat convenience wrappers agree with the raw functions', () => {
        const { x, y } = lngLatToSweref99tm({ lng: 15.5658, lat: 58.4015 });
        const raw = wgs84ToSweref99tm(58.4015, 15.5658);
        expect(x).toBe(raw.x);
        expect(y).toBe(raw.y);

        const ll = sweref99tmToLngLat(x, y);
        const rawInv = sweref99tmToWgs84(x, y);
        expect(ll.lng).toBe(rawInv.lon);
        expect(ll.lat).toBe(rawInv.lat);
    });
});
