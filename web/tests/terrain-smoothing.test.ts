import { expect, test } from 'bun:test';
import { smoothElevations, smoothingSigmaPixels } from '../src/map/terrain-smoothing';

function sample(size: number, sigma: number, fn: (x: number, y: number) => number): Float32Array {
    const r = Math.ceil(3 * sigma), w = size + 2 * r;
    return Float32Array.from({ length: w * w }, (_, i) => fn(i % w - r, Math.floor(i / w) - r));
}

test('smoothing preserves constant elevations and steady slopes, including tile edges', () => {
    for (const fn of [() => 73.2, (x: number, y: number) => 60 + x * 0.15 - y * 0.08]) {
        const input = sample(32, 1.3, fn);
        const original = input.slice();
        const output = smoothElevations(input, 32, 1.3);
        for (let y = 0; y < 32; y++) {
            for (let x = 0; x < 32; x++) expect(output[y * 32 + x]).toBeCloseTo(fn(x, y), 4);
        }
        expect(input).toEqual(original);
    }
});

test('smoothing suppresses a small spike without changing distant terrain', () => {
    const output = smoothElevations(sample(32, 1.5, (x, y) => 50 + (x === 16 && y === 16 ? 2 : 0)), 32, 1.5);
    expect(output[16 * 32 + 16]).toBeGreaterThan(50);
    expect(output[16 * 32 + 16]).toBeLessThan(50.2);
    expect(output[0]).toBe(50);
    expect(output.reduce((sum, h) => sum + h - 50, 0)).toBeCloseTo(2, 3);
});

test('separate tiles match a single continuous grid across a bump on their boundary', () => {
    const fn = (x: number, y: number) => 60 + Math.sin(x / 4) + Math.cos(y / 7) + (x === 31 ? 2 : 0);
    const whole = smoothElevations(sample(64, 1.5, fn), 64, 1.5);
    for (const offset of [0, 32]) {
        const tile = smoothElevations(sample(32, 1.5, (x, y) => fn(x + offset, y)), 32, 1.5);
        for (let y = 0; y < 32; y++) {
            for (let x = 0; x < 32; x++) expect(tile[y * 32 + x]).toBe(whole[y * 64 + x + offset]);
        }
    }
});

test('ground-metre smoothing scales with zoom and latitude', () => {
    expect(smoothingSigmaPixels(17, 0.5 * 2 ** 17 - 0.5)).toBeCloseTo(2 * smoothingSigmaPixels(16, 0.5 * 2 ** 16 - 0.5), 8);
    expect(smoothingSigmaPixels(16, 19615)).toBeGreaterThan(smoothingSigmaPixels(16, 32768));
});
