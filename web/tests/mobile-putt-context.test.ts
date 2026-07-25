import { describe, expect, test } from 'bun:test';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import { buildPuttContext, ringCentroid } from '../src/mobile/green/putt-context';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';

/** A 20 m square green in EPSG:3006, anchored near the e2e course. */
const E0 = 532_950;
const N0 = 6_473_700;

function feature(over: Partial<CourseFeature> = {}): CourseFeature {
    return {
        id: 'feat-green-1',
        courseId: 'course-1',
        holeId: 'hole-1',
        type: 'green',
        geometry: {
            crs: 'EPSG:3006',
            rings: [{
                points: [
                    { x: E0, y: N0 },
                    { x: E0 + 20, y: N0 },
                    { x: E0 + 20, y: N0 + 20 },
                    { x: E0, y: N0 + 20 },
                ],
            }],
        },
        geojson: null,
        sortOrder: 0,
        source: null,
        sourceRef: null,
        license: null,
        version: 1,
        ...over,
    };
}

const greenRow = (over: Partial<{ id: string; holeId: string; centerLat: number; centerLon: number }> = {}) => {
    const c = sweref99tmToWgs84(E0 + 10, N0 + 10);
    return { id: 'green-1', holeId: 'hole-1', centerLat: c.lat, centerLon: c.lon, ...over };
};

describe('ringCentroid', () => {
    test('averages the anchor points', () => {
        expect(ringCentroid([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]))
            .toEqual({ x: 5, y: 5 });
    });

    test('is the origin for an empty ring (never NaN)', () => {
        expect(ringCentroid([])).toEqual({ x: 0, y: 0 });
    });
});

describe('buildPuttContext', () => {
    test('null when the hole has no green feature (nothing to read)', () => {
        expect(buildPuttContext({
            holeId: 'hole-1', features: [], greens: [greenRow()], pins: [],
        })).toBeNull();

        // A green drawn on a DIFFERENT hole must not be adopted.
        expect(buildPuttContext({
            holeId: 'hole-2', features: [feature()], greens: [], pins: [],
        })).toBeNull();
    });

    test('carries the feature id + geometry the sample grid is keyed by', () => {
        const ctx = buildPuttContext({
            holeId: 'hole-1', features: [feature()], greens: [greenRow()], pins: [],
        })!;
        expect(ctx.courseId).toBe('course-1');
        expect(ctx.greenFeatureId).toBe('feat-green-1');
        expect(ctx.greenId).toBe('green-1');
        expect(ctx.geometry.rings[0]!.points).toHaveLength(4);
    });

    test('default hole = the ACTIVE pin when one exists', () => {
        const pinPos = sweref99tmToWgs84(E0 + 4, N0 + 16);
        const ctx = buildPuttContext({
            holeId: 'hole-1',
            features: [feature()],
            greens: [greenRow()],
            pins: [
                { greenId: 'green-1', lat: pinPos.lat, lon: pinPos.lon, active: true },
                { greenId: 'green-1', lat: 58.4, lon: 15.5, active: false },
            ],
        })!;
        const expected = wgs84ToSweref99tm(pinPos.lat, pinPos.lon);
        expect(ctx.defaultHole.x).toBeCloseTo(expected.x, 3);
        expect(ctx.defaultHole.y).toBeCloseTo(expected.y, 3);
    });

    test('a pin on ANOTHER green is ignored', () => {
        const other = sweref99tmToWgs84(E0 + 4, N0 + 16);
        const ctx = buildPuttContext({
            holeId: 'hole-1',
            features: [feature()],
            greens: [greenRow()],
            pins: [{ greenId: 'green-99', lat: other.lat, lon: other.lon, active: true }],
        })!;
        expect(ctx.defaultHole.x).toBeCloseTo(E0 + 10, 1); // green centre, not the pin
        expect(ctx.defaultHole.y).toBeCloseTo(N0 + 10, 1);
    });

    test('falls back to the furniture green centre, then the ring centroid', () => {
        const centre = buildPuttContext({
            holeId: 'hole-1', features: [feature()], greens: [greenRow()], pins: [],
        })!;
        expect(centre.defaultHole.x).toBeCloseTo(E0 + 10, 1);
        expect(centre.defaultHole.y).toBeCloseTo(N0 + 10, 1);

        const centroid = buildPuttContext({
            holeId: 'hole-1', features: [feature()], greens: [], pins: [],
        })!;
        expect(centroid.greenId).toBeNull();
        expect(centroid.defaultHole).toEqual({ x: E0 + 10, y: N0 + 10 });
    });

    test('an inactive-only pin set falls through to the centre', () => {
        const pinPos = sweref99tmToWgs84(E0 + 4, N0 + 16);
        const ctx = buildPuttContext({
            holeId: 'hole-1',
            features: [feature()],
            greens: [greenRow()],
            pins: [{ greenId: 'green-1', lat: pinPos.lat, lon: pinPos.lon, active: false }],
        })!;
        expect(ctx.defaultHole.x).toBeCloseTo(E0 + 10, 1);
    });
});
