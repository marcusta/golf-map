import { describe, expect, test } from 'bun:test';
import {
    FLYOVER_EASE_MS,
    FLYOVER_END_STANDOFF_M,
    FLYOVER_EYE_HEIGHT_M,
    FLYOVER_LOOK_AHEAD_M,
    FLYOVER_LOOK_HEIGHT_M,
    FLYOVER_MIN_FLIGHT_MS,
    FLYOVER_SPEED_M_S,
    backTee,
    bearingDeg,
    buildFlyoverPath,
    cameraPose,
    distanceM,
    easeInOutCubic,
    eyePathLength,
    fillGroundProfile,
    flightProgress,
    flyoverDurationMs,
    groundAt,
    groundSampleStations,
    lerpPose,
    pitchFor,
    pointAlong,
    type LngLat,
} from '../src/flyover/flyover-path';

// Landeryd-ish latitude; ~400 m of northing is ~0.0036°.
const TEE: LngLat = { lng: 15.7, lat: 58.4 };
const north = (m: number): LngLat => ({ lng: TEE.lng, lat: TEE.lat + m / 111_195 });

describe('distance / bearing', () => {
    test('distanceM matches metres of northing', () => {
        expect(distanceM(TEE, north(400))).toBeCloseTo(400, 0);
    });

    test('bearing reads as compass degrees in [0, 360)', () => {
        expect(bearingDeg(TEE, north(100))).toBeCloseTo(0, 3);
        expect(bearingDeg(TEE, { lng: TEE.lng + 0.01, lat: TEE.lat })).toBeCloseTo(90, 3);
        const west = bearingDeg(TEE, { lng: TEE.lng - 0.01, lat: TEE.lat });
        expect(west).toBeCloseTo(270, 3);
        expect(west).toBeLessThan(360);
    });
});

describe('backTee', () => {
    const green = { lat: TEE.lat + 0.004, lon: TEE.lng };
    test('picks the tee farthest from the green', () => {
        const tees = [
            { id: 'red', lat: TEE.lat + 0.001, lon: TEE.lng },
            { id: 'white', lat: TEE.lat, lon: TEE.lng },
            { id: 'yellow', lat: TEE.lat + 0.0005, lon: TEE.lng },
        ];
        expect(backTee(tees, green)?.id).toBe('white');
    });
    test('null for no tees', () => {
        expect(backTee([], green)).toBeNull();
    });
});

describe('buildFlyoverPath', () => {
    test('two waypoints give a straight line of the right length', () => {
        const path = buildFlyoverPath([TEE, north(400)], 5)!;
        expect(path.length).toBeCloseTo(400, 0);
        expect(path.points[0].s).toBe(0);
        expect(path.points[path.points.length - 1].s).toBeCloseTo(path.length, 9);
        // Every point stays on the meridian.
        for (const p of path.points) expect(p.lng).toBeCloseTo(TEE.lng, 9);
        // Roughly one sample per step.
        expect(path.points.length).toBeGreaterThanOrEqual(80);
        expect(path.points.length).toBeLessThanOrEqual(82);
    });

    test('s is monotonic and passes through every waypoint on a dogleg', () => {
        const dogleg: LngLat = { lng: TEE.lng + 0.002, lat: TEE.lat + 0.0025 };
        const green: LngLat = { lng: TEE.lng + 0.002, lat: TEE.lat + 0.005 };
        const path = buildFlyoverPath([TEE, dogleg, green], 5)!;
        for (let i = 1; i < path.points.length; i++) {
            expect(path.points[i].s).toBeGreaterThan(path.points[i - 1].s);
        }
        const nearest = (w: LngLat) => Math.min(...path.points.map(p => distanceM(p, w)));
        expect(nearest(TEE)).toBeLessThan(0.01);
        expect(nearest(dogleg)).toBeLessThan(0.01);
        expect(nearest(green)).toBeLessThan(0.01);
        // Smoothed: longer than the straight tee→green chord, shorter than the polyline.
        const chord = distanceM(TEE, green);
        const polyline = distanceM(TEE, dogleg) + distanceM(dogleg, green);
        expect(path.length).toBeGreaterThan(chord);
        expect(path.length).toBeLessThan(polyline * 1.1);
    });

    test('Catmull-Rom leaves the polyline at a corner but stays near it', () => {
        const corner: LngLat = { lng: TEE.lng, lat: TEE.lat + 0.002 };
        const green: LngLat = { lng: TEE.lng + 0.003, lat: TEE.lat + 0.002 };
        const path = buildFlyoverPath([TEE, corner, green], 5)!;
        // Distance from a point to the two-leg polyline (planar metres).
        const m = 111_195;
        const toPlane = (p: LngLat) => ({ x: (p.lng - TEE.lng) * m * Math.cos(TEE.lat * Math.PI / 180), y: (p.lat - TEE.lat) * m });
        const segDist = (p: LngLat, a: LngLat, b: LngLat) => {
            const P = toPlane(p), A = toPlane(a), B = toPlane(b);
            const abx = B.x - A.x, aby = B.y - A.y;
            const t = Math.max(0, Math.min(1, ((P.x - A.x) * abx + (P.y - A.y) * aby) / (abx * abx + aby * aby)));
            return Math.hypot(P.x - (A.x + abx * t), P.y - (A.y + aby * t));
        };
        const off = path.points.map(p => Math.min(segDist(p, TEE, corner), segDist(p, corner, green)));
        const maxOff = Math.max(...off);
        expect(maxOff).toBeGreaterThan(2); // smoothed, not the raw polyline
        expect(maxOff).toBeLessThan(60); // but hugs the hole's line
        expect(Math.min(...path.points.map(p => distanceM(p, corner)))).toBeLessThan(0.01);
    });

    test('collapses duplicates and refuses a degenerate path', () => {
        expect(buildFlyoverPath([TEE, TEE])).toBeNull();
        expect(buildFlyoverPath([TEE])).toBeNull();
        expect(buildFlyoverPath([])).toBeNull();
        const path = buildFlyoverPath([TEE, TEE, north(100), north(100)])!;
        expect(path.length).toBeCloseTo(100, 0);
    });
});

describe('pointAlong', () => {
    const path = buildFlyoverPath([TEE, north(400)], 5)!;

    test('interpolates inside the path', () => {
        const p = pointAlong(path, 200);
        expect(distanceM(TEE, p)).toBeCloseTo(200, 0);
        expect(p.lng).toBeCloseTo(TEE.lng, 9);
    });

    test('extrapolates linearly beyond both ends', () => {
        const behind = pointAlong(path, -80);
        expect(behind.lat).toBeLessThan(TEE.lat);
        expect(distanceM(TEE, behind)).toBeCloseTo(80, 0);
        const past = pointAlong(path, 520);
        expect(distanceM(TEE, past)).toBeCloseTo(520, 0);
    });
});

describe('ground profile', () => {
    test('stations cover camera-behind through look-ahead', () => {
        const path = buildFlyoverPath([TEE, north(400)], 5)!;
        const { s0, stations } = groundSampleStations(path, 80, 120, 5);
        expect(s0).toBe(-85);
        expect(stations[0]).toBe(-85);
        expect(stations[stations.length - 1]).toBeGreaterThanOrEqual(400 + 120);
    });

    test('fills gaps from the nearest known sample, flat zero when all unknown', () => {
        const p = fillGroundProfile(0, 10, [null, 50, null, null, 60, null]);
        expect(p.values).toEqual([50, 50, 50, 50, 60, 60]);
        expect(fillGroundProfile(0, 10, [null, null]).values).toEqual([0, 0]);
    });

    test('groundAt interpolates and clamps', () => {
        const p = fillGroundProfile(-10, 10, [10, 20, 40]);
        expect(groundAt(p, -10)).toBe(10);
        expect(groundAt(p, -5)).toBe(15);
        expect(groundAt(p, 5)).toBe(30);
        expect(groundAt(p, -100)).toBe(10);
        expect(groundAt(p, 100)).toBe(40);
    });
});

describe('cameraPose', () => {
    const path = buildFlyoverPath([TEE, north(400)], 5)!;
    const flat = () => 100;
    const opts = { eyeHeightM: 5, lookAheadM: 60, lookHeightM: 2, exaggeration: 1 };

    test('eye is on the path 5 m up, looking at the point 60 m ahead at ground + 2 m', () => {
        const pose = cameraPose(path, 200, flat, opts);
        expect(distanceM(pose.from, pointAlong(path, 200))).toBeLessThan(0.01);
        expect(distanceM(pose.to, pointAlong(path, 260))).toBeLessThan(0.01);
        expect(pose.altFrom).toBe(105);
        expect(pose.altTo).toBe(102);
        expect(pose.bearing).toBeCloseTo(0, 3);
        // 3 m down over 60 m: geometric pitch 90 - atan(3/60) ≈ 87.1°, past
        // MapLibre's 85° cap; the service lets the engine clamp it.
        expect(pose.pitch).toBeCloseTo(87.14, 1);
        expect(pose.pitch).toBeGreaterThan(85);
    });

    test('exaggeration scales ground and heights', () => {
        const pose = cameraPose(path, 200, flat, { ...opts, exaggeration: 2 });
        expect(pose.altFrom).toBe(210);
        expect(pose.altTo).toBe(204);
    });

    test('look-at clamps to the green; the eye stops at the standoff with a sub-cap pitch', () => {
        const end = eyePathLength(path);
        expect(end).toBeCloseTo(path.length - FLYOVER_END_STANDOFF_M, 9);
        const pose = cameraPose(path, end, flat, opts);
        expect(distanceM(pose.to, pointAlong(path, path.length))).toBeLessThan(0.01);
        expect(distanceM(pose.from, pose.to)).toBeCloseTo(FLYOVER_END_STANDOFF_M, 0);
        expect(pose.pitch).toBeCloseTo(pitchFor(15, 3), 3);
        expect(pose.pitch).toBeLessThan(85);
        // A path shorter than the standoff still has a non-negative eye range.
        expect(eyePathLength(buildFlyoverPath([TEE, north(10)], 5)!)).toBe(0);
    });

    test('at the start the eye sits on the tee', () => {
        const pose = cameraPose(path, 0, flat, opts);
        expect(distanceM(pose.from, TEE)).toBeLessThan(0.01);
    });

    test('follows ground height from the profile at both eye and look point', () => {
        const rising = (s: number) => 100 + s * 0.1;
        const pose = cameraPose(path, 200, rising, opts);
        expect(pose.altFrom).toBeCloseTo(100 + 20 + 5, 6);
        expect(pose.altTo).toBeCloseTo(100 + 26 + 2, 6);
    });

    test('default constants: 5 m eye, 120 m look-ahead, 2 m look height', () => {
        expect(FLYOVER_EYE_HEIGHT_M).toBe(5);
        expect(FLYOVER_LOOK_AHEAD_M).toBe(120);
        expect(FLYOVER_LOOK_HEIGHT_M).toBe(2);
    });
});

describe('heading along a dogleg', () => {
    // 200 m north, then 200 m east: a 90° corner at the aim point.
    const corner: LngLat = north(200);
    const green: LngLat = { lng: corner.lng + 200 / (111_195 * Math.cos(TEE.lat * Math.PI / 180)), lat: corner.lat };
    const path = buildFlyoverPath([TEE, corner, green], 5)!;
    const flat = () => 0;
    const opts = { eyeHeightM: 5, lookAheadM: 60, lookHeightM: 2, exaggeration: 1 };

    test('turns through ~90° without a step: per-5 m heading change stays small', () => {
        const end = eyePathLength(path);
        const headings: number[] = [];
        for (let s = 0; s <= end; s += 5) headings.push(cameraPose(path, s, flat, opts).bearing);
        // Catmull-Rom with duplicated end tangents bows both legs a little
        // (west before the corner, south after it), so the end headings are
        // near, not at, the leg bearings.
        expect(Math.abs(((headings[0] + 180) % 360) - 180)).toBeLessThan(15);
        expect(Math.abs(headings[headings.length - 1] - 90)).toBeLessThan(15);
        let maxStep = 0;
        for (let i = 1; i < headings.length; i++) {
            let d = headings[i] - headings[i - 1];
            if (d > 180) d -= 360;
            if (d < -180) d += 360;
            maxStep = Math.max(maxStep, Math.abs(d));
        }
        // 90° spread over the corner: no single 5 m step turns more than 8°
        // (a stepwise heading at the aim point would show as one 90° jump).
        expect(maxStep).toBeLessThan(8);
    });
});

describe('lerpPose', () => {
    const path = buildFlyoverPath([TEE, north(400)], 5)!;
    const flat = () => 50;
    const opts = { eyeHeightM: 5, lookAheadM: 60, lookHeightM: 2, exaggeration: 1 };

    test('hits the endpoints and recomputes angles', () => {
        const a = cameraPose(path, 0, flat, opts);
        const b = cameraPose(path, 300, flat, opts);
        expect(lerpPose(a, b, 0)).toEqual(a);
        expect(lerpPose(a, b, 1)).toEqual(b);
        const mid = lerpPose(a, b, 0.5);
        expect(mid.altFrom).toBeCloseTo((a.altFrom + b.altFrom) / 2, 9);
        expect(mid.pitch).toBeCloseTo(pitchFor(distanceM(mid.from, mid.to), mid.altFrom - mid.altTo), 9);
    });
});

describe('easing / duration / speed profile', () => {
    test('easeInOutCubic is monotonic, symmetric and clamped', () => {
        expect(easeInOutCubic(0)).toBe(0);
        expect(easeInOutCubic(1)).toBe(1);
        expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 9);
        expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 9);
        expect(easeInOutCubic(-1)).toBe(0);
        expect(easeInOutCubic(2)).toBe(1);
        let prev = 0;
        for (let i = 1; i <= 20; i++) {
            const v = easeInOutCubic(i / 20);
            expect(v).toBeGreaterThanOrEqual(prev);
            prev = v;
        }
    });

    test('speed is 225 km/h; duration is length / speed plus one ease, floored at 3 s', () => {
        expect(FLYOVER_SPEED_M_S).toBeCloseTo(62.5, 3);
        expect(flyoverDurationMs(400)).toBeCloseTo(6_400 + 1500, 0);
        expect(flyoverDurationMs(625)).toBeCloseTo(10_000 + 1500, 0);
        expect(flyoverDurationMs(5)).toBe(FLYOVER_MIN_FLIGHT_MS);
        // No upper clamp: a 1 km hole takes 17.5 s.
        expect(flyoverDurationMs(1000)).toBeCloseTo(16_000 + 1500, 0);
    });

    test('flightProgress: endpoints, monotonic, smooth start/stop', () => {
        const r = 0.2;
        expect(flightProgress(0, r)).toBe(0);
        expect(flightProgress(1, r)).toBeCloseTo(1, 12);
        expect(flightProgress(-1, r)).toBe(0);
        expect(flightProgress(2, r)).toBeCloseTo(1, 12);
        let prev = 0;
        for (let i = 1; i <= 100; i++) {
            const v = flightProgress(i / 100, r);
            expect(v).toBeGreaterThanOrEqual(prev);
            prev = v;
        }
        // Speed is ~0 at both ends and symmetric.
        const du = 1e-3;
        const speedAt = (u: number) => (flightProgress(u + du, r) - flightProgress(u, r)) / du;
        expect(speedAt(0)).toBeLessThan(0.01);
        expect(speedAt(1 - du)).toBeLessThan(0.01);
        expect(flightProgress(0.3, r) + flightProgress(0.7, r)).toBeCloseTo(1, 9);
        // Zero ramp degenerates to linear.
        expect(flightProgress(0.37, 0)).toBeCloseTo(0.37, 12);
    });

    test('cruise speed along the path equals FLYOVER_SPEED_M_S for the computed duration', () => {
        const length = 400;
        const ms = flyoverDurationMs(length);
        const ramp = FLYOVER_EASE_MS / ms;
        const sAt = (elapsedMs: number) => flightProgress(elapsedMs / ms, ramp) * length;
        // Mid-flight, well clear of both ramps.
        const v = (sAt(ms / 2 + 500) - sAt(ms / 2 - 500)) / 1;
        expect(v).toBeCloseTo(FLYOVER_SPEED_M_S, 6);
        // Just after the ease-in ends the speed is already the cruise speed.
        const v2 = (sAt(FLYOVER_EASE_MS + 100) - sAt(FLYOVER_EASE_MS)) / 0.1;
        expect(v2).toBeCloseTo(FLYOVER_SPEED_M_S, 6);
    });
});
