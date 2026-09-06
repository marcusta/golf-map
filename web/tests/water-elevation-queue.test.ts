import { expect, test } from 'bun:test';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { WaterElevationQueue } from '../src/map/water-elevation-queue';

function surface(triangles: number): BufferGeometry {
    const positions = new Float32Array(triangles * 9);
    for (let i = 0; i < triangles; i++) positions.set([0, 0, 0, 10, 0, 0, 0, 10, 0], i * 9);
    return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3));
}

test('course-scale terrain updates yield between bounded batches and share repeated vertex samples', () => {
    const geometries = Array.from({ length: 40 }, () => surface(1500));
    const queue = new WaterElevationQueue(geometries);
    queue.start((x, y) => 100 + x * 0.1 + y * 0.2);
    let total = 0, samples = 0, completions = 0, frames = 0;
    while (queue.pending) {
        const result = queue.step();
        expect(result.processed).toBeLessThanOrEqual(512);
        total += result.processed;
        samples += result.sampled;
        completions += result.completed.length;
        frames++;
        expect(frames).toBeLessThan(10000);
    }
    expect(total).toBe(180000);
    expect(frames).toBeGreaterThan(1);
    expect(samples).toBe(3);
    expect(completions).toBe(40);
    for (const geometry of geometries) {
        const positions = geometry.getAttribute('position');
        expect(positions.getZ(0)).toBe(100);
        expect(positions.getZ(1)).toBe(101);
        expect(positions.getZ(2)).toBe(102);
        geometry.dispose();
    }
});

test('a terrain replacement discards partial work and cached heights', () => {
    const geometry = surface(1000);
    const queue = new WaterElevationQueue([geometry]);
    queue.start(() => 50);
    queue.step();
    expect(queue.pending).toBe(true);
    queue.start(() => 200);
    while (queue.pending) queue.step();
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) expect(positions.getZ(i)).toBe(200);
    geometry.dispose();
});
