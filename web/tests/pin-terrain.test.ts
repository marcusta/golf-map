import { describe, expect, test } from 'bun:test';
import { Signal } from '@basics/core/client/core';
import type { AnalysisApi, SampleGrid } from '../../shared/api/analysis.gen';
import type { CourseFeature } from '../../shared/api/course-features.gen';
import { PinTerrain, PIN_RING_RADIUS_M, holeGreenFeature, pinRingsGeojson } from '../src/furniture/pin-terrain';
import { sweref99tmToWgs84, wgs84ToSweref99tm } from '../src/geo/transform';

const E0 = 536000, N0 = 6474000;

/** 40 x 40 m of ground at 0.5 m cells: 2 % up to the east, and 6 % from 30 m east on. */
function grid(): SampleGrid {
    const width = 80, height = 80, resolution = 0.5;
    const heights: number[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const x = (col + 0.5) * resolution;
            heights.push(50 + (x < 30 ? 0.02 * x : 0.6 + 0.06 * (x - 30)));
        }
    }
    return { heights, insideMask: heights.map(() => 1), origin: { e: E0, n: N0 }, resolution, width, height };
}

const square = (x0: number, y0: number, side: number) => ({
    crs: 'EPSG:3006',
    rings: [{ points: [{ x: x0, y: y0 }, { x: x0 + side, y: y0 }, { x: x0 + side, y: y0 + side }, { x: x0, y: y0 + side }] }],
});
const green = (id: string, holeId: string | null, x0: number): CourseFeature =>
    ({ id, courseId: 'c1', holeId, type: 'green', version: 1, geometry: square(x0, N0 - 40, 40) }) as unknown as CourseFeature;

function reading() {
    const calls: string[] = [];
    const api = { async sampleGrid(input) { calls.push(input.featureId!); return grid(); } } as AnalysisApi;
    const terrain = new PinTerrain(api);
    const placing = new Signal<CourseFeature | null | undefined>(null);
    const ctx = { map: { ready: new Signal(false) } } as never;
    const renderer = { render() {}, reset() {}, clear() {} };
    const dispose = terrain.attach(ctx, renderer, () => placing.get());
    return { terrain, placing, calls, dispose };
}
const at = (x: number, y: number) => sweref99tmToWgs84(E0 + x, N0 - y);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the slope at a pin', () => {
    test('is read off the green being placed on: at the hole, and the steepest within the ring', async () => {
        const { terrain, placing, calls, dispose } = reading();
        expect(terrain.slopeAt(at(10, 20).lat, at(10, 20).lon)).toBeNull();

        placing.set(green('g1', 'h1', E0));
        await settle();
        // Well inside the 2 % part: the same all round.
        const flat = terrain.slopeAt(at(10, 20).lat, at(10, 20).lon)!;
        expect(flat.atPin).toBeCloseTo(2, 1);
        expect(flat.maxInRing).toBeCloseTo(2, 1);
        // 1 m short of the break: 2 % at the hole, 6 % inside the ring.
        const edge = terrain.slopeAt(at(29, 20).lat, at(29, 20).lon)!;
        expect(edge.atPin).toBeCloseTo(2, 0);
        expect(edge.maxInRing).toBeCloseTo(6, 0);
        // Off the sampled ground.
        expect(terrain.slopeAt(at(-5, 20).lat, at(-5, 20).lon)).toBeNull();

        // The shading can be off and the slope still read; the same green is not fetched twice.
        terrain.mode.set('off');
        expect(terrain.view.get()).toBeNull();
        expect(terrain.slopeAt(at(10, 20).lat, at(10, 20).lon)).not.toBeNull();
        placing.set(null);
        await settle();
        placing.set(green('g1', 'h1', E0));
        await settle();
        expect(calls).toEqual(['g1']);

        // A hole without a drawn green says so.
        placing.set(undefined);
        await settle();
        expect(terrain.note.get()).toMatch(/No drawn green/);
        dispose();
        expect(terrain.note.get()).toBe('');
    });

    test('the ring round a pin is 2 m in radius', () => {
        const pin = at(10, 20);
        const [ring] = pinRingsGeojson([pin]).features;
        const c = wgs84ToSweref99tm(pin.lat, pin.lon);
        const coords = (ring.geometry as unknown as { coordinates: [number, number][] }).coordinates;
        expect(coords[0]).toEqual(coords[coords.length - 1]);
        for (const [lon, lat] of coords) {
            const p = wgs84ToSweref99tm(lat, lon);
            expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeCloseTo(PIN_RING_RADIUS_M, 2);
        }
    });

    test("a hole's green is the drawn one holding its green centre", () => {
        const a = green('a', 'h1', E0), b = green('b', null, E0 + 100);
        expect(holeGreenFeature([a, b], 'h1', null)?.id).toBe('a');
        expect(holeGreenFeature([a, b], 'h2', sweref99tmToWgs84(E0 + 120, N0 - 20))?.id).toBe('b');
        expect(holeGreenFeature([a, b], 'h2', null)).toBeUndefined();
    });
});
