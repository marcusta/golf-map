import { describe, expect, test } from 'bun:test';
import { bearingDeg, envelope, frameHole } from '../src/mobile/course/hole-frame';

describe('hole-frame bearing', () => {
    test('cardinal directions read as compass degrees', () => {
        const o = { lng: 15, lat: 58 };
        expect(bearingDeg(o, { lng: 15, lat: 58.01 })).toBeCloseTo(0, 1); // north
        expect(bearingDeg(o, { lng: 15.01, lat: 58 })).toBeCloseTo(90, 1); // east
        expect(bearingDeg(o, { lng: 15, lat: 57.99 })).toBeCloseTo(180, 1); // south
        expect(bearingDeg(o, { lng: 14.99, lat: 58 })).toBeCloseTo(270, 1); // west
    });

    test('is always in [0, 360)', () => {
        const b = bearingDeg({ lng: 15, lat: 58 }, { lng: 14.99, lat: 57.99 });
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(360);
    });
});

describe('hole-frame envelope', () => {
    test('null on empty input', () => {
        expect(envelope([])).toBeNull();
    });

    test('bounds span all points as [w, s, e, n]', () => {
        expect(envelope([
            { lng: 15, lat: 58 },
            { lng: 15.02, lat: 58.03 },
            { lng: 14.99, lat: 57.98 },
        ])).toEqual([14.99, 57.98, 15.02, 58.03]);
    });
});

describe('frameHole', () => {
    const tee = { lng: 15, lat: 58 };
    const green = { lng: 15, lat: 58.02 };

    test('frames both endpoints with a tee→green bearing', () => {
        const frame = frameHole(tee, green);
        expect(frame.bbox).toEqual([15, 58, 15, 58.02]);
        expect(frame.bearingDeg).toBeCloseTo(0, 1);
    });

    test('extra points widen the box', () => {
        const frame = frameHole(tee, green, [{ lng: 15.05, lat: 58.01 }]);
        expect(frame.bbox).toEqual([15, 58, 15.05, 58.02]);
    });

    test('missing tee or green degrades: no bearing, box from what exists', () => {
        expect(frameHole(null, green).bearingDeg).toBeNull();
        expect(frameHole(null, green).bbox).toEqual([15, 58.02, 15, 58.02]);
        expect(frameHole(tee, null).bearingDeg).toBeNull();
        expect(frameHole(null, null).bbox).toBeNull();
    });
});
