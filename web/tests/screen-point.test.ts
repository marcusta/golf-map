import { describe, expect, test } from 'bun:test';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { flatProjector, screenDistLngLat, screenDistSweref, screenPointOf } from '../src/editor/screen-point';
import { wgs84ToSweref99tm } from '../src/geo/transform';

// editor/screen-point.ts: hit tests project with the flat transform and
// fall back to map.project only when the transform lacks
// locationToScreenPoint.

/** Linear flat transform: 1e5 px per degree around (15, 58). */
function flatMap(opts: { withTransform: boolean }): { map: MaplibreMap; projectCalls: () => number } {
    let calls = 0;
    const flat = (lng: number, lat: number) => ({ x: (lng - 15) * 1e5, y: (58 - lat) * 1e5 });
    const map = {
        transform: opts.withTransform
            ? { locationToScreenPoint: (l: { lng: number; lat: number }) => flat(l.lng, l.lat) }
            : {},
        project: ([lng, lat]: [number, number]) => {
            calls++;
            if (opts.withTransform) throw new Error('terrain-aware project must not be called');
            return flat(lng, lat);
        },
    } as unknown as MaplibreMap;
    return { map, projectCalls: () => calls };
}

describe('screen point', () => {
    test('projects through transform.locationToScreenPoint, never map.project', () => {
        const { map, projectCalls } = flatMap({ withTransform: true });
        const project = flatProjector(map);
        expect(project(15.001, 58)).toEqual({ x: expect.closeTo(100, 6), y: 0 });
        expect(screenPointOf(map, 15, 57.999)).toEqual({ x: 0, y: expect.closeTo(100, 6) });
        expect(projectCalls()).toBe(0);
    });

    test('falls back to map.project when the transform has no flat projection', () => {
        const { map, projectCalls } = flatMap({ withTransform: false });
        expect(screenPointOf(map, 15.001, 58).x).toBeCloseTo(100, 6);
        expect(projectCalls()).toBe(1);
    });

    test('screenDistLngLat is the pixel hypot', () => {
        const { map } = flatMap({ withTransform: true });
        expect(screenDistLngLat(map, { lng: 15.0003, lat: 57.9996 }, { x: 0, y: 0 })).toBeCloseTo(50, 6);
    });

    test('screenDistSweref converts EPSG:3006 before projecting', () => {
        const { map } = flatMap({ withTransform: true });
        const p = wgs84ToSweref99tm(58, 15.0003);
        // Round trip SWEREF 99 TM -> WGS84 is sub-millimetre, so 30 px holds to 1e-3.
        expect(screenDistSweref(map, p, { x: 0, y: 0 })).toBeCloseTo(30, 3);
    });
});
