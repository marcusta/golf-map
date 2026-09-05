import { describe, expect, test } from 'bun:test';
import { distanceM, bearingDeg } from '../src/flyover/flyover-path';
import {
    WALK_EYE_HEIGHT_M,
    WALK_MAX_EYE_HEIGHT_M,
    WALK_MIN_EYE_HEIGHT_M,
    WALK_TILT_MAX,
    WALK_TILT_MIN,
    applyLook,
    clampEyeHeight,
    clampTilt,
    entryPose,
    fromTo,
    initialHeading,
    initialLookTarget,
    lerpHeading,
    lerpWalkPose,
    lookTarget,
    moveVector,
    offsetM,
    pitchFromTilt,
    tiltFromPitch,
    walkSpeed,
    wrapHeading,
    type WalkPose,
} from '../src/walk/walk-camera';

// Landeryd-ish latitude.
const ORIGIN = { lng: 15.72, lat: 58.36 };

describe('clamping', () => {
    test('tilt clamps to the MapLibre-imposed [-60, -5] range', () => {
        expect(clampTilt(0)).toBe(WALK_TILT_MAX);
        expect(clampTilt(10)).toBe(-5);
        expect(clampTilt(-90)).toBe(WALK_TILT_MIN);
        expect(clampTilt(-30)).toBe(-30);
    });

    test('eye height clamps to [1, 60] m', () => {
        expect(clampEyeHeight(0)).toBe(WALK_MIN_EYE_HEIGHT_M);
        expect(clampEyeHeight(100)).toBe(WALK_MAX_EYE_HEIGHT_M);
        expect(clampEyeHeight(2)).toBe(2);
    });

    test('wrapHeading normalises into [0, 360)', () => {
        expect(wrapHeading(370)).toBeCloseTo(10);
        expect(wrapHeading(-10)).toBeCloseTo(350);
        expect(wrapHeading(360)).toBe(0);
    });

    test('pitch <-> tilt: horizon-most tilt is MapLibre pitch 85', () => {
        expect(pitchFromTilt(WALK_TILT_MAX)).toBe(85);
        expect(pitchFromTilt(WALK_TILT_MIN)).toBe(30);
        expect(tiltFromPitch(0)).toBe(-90);
        expect(tiltFromPitch(pitchFromTilt(-20))).toBeCloseTo(-20);
    });
});

describe('lookTarget / fromTo', () => {
    const pose: WalkPose = { eye: ORIGIN, eyeAlt: 52, heading: 0, tilt: -5 };

    test('target lies 50 m along the heading, slightly below the eye', () => {
        const { to, altTo } = lookTarget(pose, 50);
        expect(distanceM(ORIGIN, to)).toBeCloseTo(50 * Math.cos((5 * Math.PI) / 180), 3);
        expect(bearingDeg(ORIGIN, to)).toBeCloseTo(0, 3);
        expect(altTo).toBeCloseTo(52 - 50 * Math.sin((5 * Math.PI) / 180), 6);
    });

    test('heading east moves the target east; steep tilt drops it further', () => {
        const east = lookTarget({ ...pose, heading: 90 }, 50);
        expect(bearingDeg(ORIGIN, east.to)).toBeCloseTo(90, 3);
        const steep = lookTarget({ ...pose, tilt: -60 }, 50);
        expect(distanceM(ORIGIN, steep.to)).toBeCloseTo(25, 3);
        expect(steep.altTo).toBeCloseTo(52 - 50 * Math.sin(Math.PI / 3), 6);
    });

    test('fromTo carries eye, altitude and heading through', () => {
        const ft = fromTo(pose);
        expect(ft.from).toEqual(ORIGIN);
        expect(ft.altFrom).toBe(52);
        expect(ft.heading).toBe(0);
        expect(ft.altTo).toBeLessThan(ft.altFrom);
    });
});

describe('moveVector', () => {
    test('W along heading 0 moves north by speed*dt', () => {
        const v = moveVector(0, { forward: true, back: false, left: false, right: false }, 3, 0.5);
        expect(v.east).toBeCloseTo(0, 9);
        expect(v.north).toBeCloseTo(1.5, 9);
    });

    test('S is the opposite of W; D strafes right of the heading', () => {
        const s = moveVector(90, { forward: false, back: true, left: false, right: false }, 3, 1);
        expect(s.east).toBeCloseTo(-3, 9);
        expect(s.north).toBeCloseTo(0, 9);
        const d = moveVector(90, { forward: false, back: false, left: false, right: true }, 3, 1);
        expect(d.east).toBeCloseTo(0, 9);
        expect(d.north).toBeCloseTo(-3, 9);
    });

    test('diagonals are normalised; opposing keys cancel; movement scales with dt', () => {
        const wd = moveVector(0, { forward: true, back: false, left: false, right: true }, 3, 1);
        expect(Math.hypot(wd.east, wd.north)).toBeCloseTo(3, 9);
        const ws = moveVector(0, { forward: true, back: true, left: false, right: false }, 3, 1);
        expect(ws).toEqual({ east: 0, north: 0 });
        const a = moveVector(45, { forward: true, back: false, left: false, right: false }, 3, 1 / 60);
        const b = moveVector(45, { forward: true, back: false, left: false, right: false }, 3, 1 / 30);
        expect(Math.hypot(b.east, b.north)).toBeCloseTo(2 * Math.hypot(a.east, a.north), 9);
    });

    test('base speed is 60 km/h; Shift is 3x (180 km/h)', () => {
        expect(walkSpeed(false)).toBeCloseTo(60 / 3.6, 9);
        expect(walkSpeed(true)).toBeCloseTo(180 / 3.6, 9);
    });

    test('offsetM round-trips through distance', () => {
        const p = offsetM(ORIGIN, 30, 40);
        expect(distanceM(ORIGIN, p)).toBeCloseTo(50, 3);
    });
});

describe('applyLook', () => {
    const pose: WalkPose = { eye: ORIGIN, eyeAlt: 52, heading: 350, tilt: -20 };

    test('dragging right yaws right and wraps; dragging up looks up (inverted tilt)', () => {
        const p = applyLook(pose, 80, -40, 0.25);
        expect(p.heading).toBeCloseTo(10);
        expect(p.tilt).toBeCloseTo(-10);
    });

    test('tilt saturates at the clamp', () => {
        expect(applyLook(pose, 0, -1000).tilt).toBe(WALK_TILT_MAX);
        expect(applyLook(pose, 0, 1000).tilt).toBe(WALK_TILT_MIN);
    });
});

describe('transition blend', () => {
    test('lerpHeading takes the shortest arc across north', () => {
        expect(lerpHeading(350, 10, 0.5)).toBeCloseTo(0);
        expect(lerpHeading(10, 350, 0.5)).toBeCloseTo(0);
        expect(lerpHeading(0, 180, 0.25)).toBeCloseTo(45);
    });

    test('lerpWalkPose hits the endpoints and blends the middle', () => {
        const a: WalkPose = { eye: ORIGIN, eyeAlt: 400, heading: 350, tilt: -90 };
        const b: WalkPose = { eye: offsetM(ORIGIN, 100, 0), eyeAlt: 52, heading: 20, tilt: -5 };
        expect(lerpWalkPose(a, b, 0)).toEqual(a);
        const end = lerpWalkPose(a, b, 1);
        expect(end.eye.lng).toBeCloseTo(b.eye.lng, 12);
        expect(end.eyeAlt).toBe(52);
        expect(end.heading).toBeCloseTo(20);
        const mid = lerpWalkPose(a, b, 0.5);
        expect(mid.eyeAlt).toBe(226);
        expect(mid.tilt).toBe(-47.5);
        expect(mid.heading).toBeCloseTo(5);
        expect(distanceM(ORIGIN, mid.eye)).toBeCloseTo(50, 2);
    });
});

describe('initial look target (100 m rule)', () => {
    const green = offsetM(ORIGIN, 0, 400);
    const aims = [offsetM(ORIGIN, 0, 60), offsetM(ORIGIN, 20, 180), offsetM(ORIGIN, 0, 300)];

    test('skips aims within 100 m and picks the first further one in hole order', () => {
        expect(initialLookTarget(ORIGIN, aims, green)).toBe(aims[1]);
    });

    test('falls back to the green when every aim is within 100 m', () => {
        expect(initialLookTarget(ORIGIN, [aims[0]], green)).toBe(green);
    });

    test('standing past the last aim: earlier aims behind the eye still count if far enough', () => {
        // Hole order wins over proximity: the caller asked for "nearest such along the hole order".
        const from = offsetM(ORIGIN, 0, 250);
        expect(initialLookTarget(from, aims, green)).toBe(aims[0]);
    });

    test('no aims, no green: null', () => {
        expect(initialLookTarget(ORIGIN, [], null)).toBeNull();
    });

    test('initialHeading points at the target, falls back to the map bearing without one', () => {
        expect(initialHeading(ORIGIN, offsetM(ORIGIN, 100, 100), 0)).toBeCloseTo(45, 3);
        expect(initialHeading(ORIGIN, null, 123)).toBe(123);
        expect(initialHeading(ORIGIN, ORIGIN, -30)).toBe(330);
    });

    test('entryPose stands 2 m above ground, horizon-level', () => {
        const p = entryPose(ORIGIN, 50, 370);
        expect(p.eyeAlt).toBe(50 + WALK_EYE_HEIGHT_M);
        expect(p.tilt).toBe(WALK_TILT_MAX);
        expect(p.heading).toBeCloseTo(10);
    });
});
