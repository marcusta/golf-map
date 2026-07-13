import { test, expect } from 'bun:test';
import { wgs84ToSweref99tm } from '../src/geo/transform';
import {
    MAX_SAMPLES_PER_LEG,
    profileSeries,
    smoothProfile,
    vertexDistances,
    type LatLon,
    type ProfileSample,
} from '../src/profile/elevation-profile';
import { ElevationProfileService } from '../src/profile/elevation-profile.service';

// Port of the iOS ElevationProfileTests (ios/GolfMapTests/Profile/
// ElevationProfileTests.swift): cumulative EPSG:3006 distances, shared-vertex
// dedupe, null-elevation passthrough, per-leg sample clamps, presentation
// smoothing, and the service's seq-guarded async refresh.

// ─── Fixtures ─────────────────────────────────────────────────────────────

const tee: LatLon = { lat: 58.36, lon: 15.71 };
const aim: LatLon = { lat: 58.362, lon: 15.712 };
const green: LatLon = { lat: 58.364, lon: 15.711 };

/** EPSG:3006 planar leg length (the module's own distance definition). */
function planarMeters(a: LatLon, b: LatLon): number {
    const pa = wgs84ToSweref99tm(a.lat, a.lon);
    const pb = wgs84ToSweref99tm(b.lat, b.lon);
    return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

/** Deterministic terrain: an east-tilted plane in projected meters. */
function plane(p: LatLon): number {
    const { x } = wgs84ToSweref99tm(p.lat, p.lon);
    return 40 + 0.05 * (x - 541_000);
}
const planeSampler = async (p: LatLon) => plane(p);

// ─── Vertex distances ─────────────────────────────────────────────────────

test('vertexDistances are cumulative planar meters', () => {
    const distances = vertexDistances([tee, aim, green]);
    expect(distances.length).toBe(3);
    expect(distances[0]).toBe(0);
    expect(distances[1]).toBeCloseTo(planarMeters(tee, aim), 9);
    expect(distances[2]).toBeCloseTo(planarMeters(tee, aim) + planarMeters(aim, green), 9);
    expect(vertexDistances([])).toEqual([]);
    expect(vertexDistances([tee])).toEqual([0]);
});

// ─── Series ───────────────────────────────────────────────────────────────

test('series: cumulative distance and shared-vertex dedupe', async () => {
    const samples = await profileSeries([tee, aim, green], planeSampler);

    const leg1 = planarMeters(tee, aim);
    const leg2 = planarMeters(aim, green);
    const n1 = Math.max(2, Math.min(200, Math.ceil(leg1 / 2) + 1));
    const n2 = Math.max(2, Math.min(200, Math.ceil(leg2 / 2) + 1));
    // Second leg skips its start sample (shared vertex with leg 1).
    expect(samples.length).toBe(n1 + n2 - 1);

    expect(samples[0].distance).toBe(0);
    expect(samples[samples.length - 1].distance).toBeCloseTo(leg1 + leg2, 6);

    // Strictly increasing distances — the dedupe leaves no duplicate x.
    for (let i = 1; i < samples.length; i++) {
        expect(samples[i].distance).toBeGreaterThan(samples[i - 1].distance);
    }

    // Elevations match the plane (lat/lon lerp ≙ projected lerp to well
    // under a millimeter at this scale).
    expect(samples[0].elevation!).toBeCloseTo(plane(tee), 3);
    expect(samples[samples.length - 1].elevation!).toBeCloseTo(plane(green), 3);
    const vertexSample = samples[n1 - 1];
    expect(vertexSample.distance).toBeCloseTo(leg1, 6);
    expect(vertexSample.elevation!).toBeCloseTo(plane(aim), 3);
});

test('series: short paths and null elevations', async () => {
    expect(await profileSeries([tee], planeSampler)).toEqual([]);

    // Coverage hole: null beyond half the leg → nulls pass through as gaps.
    const leg = planarMeters(tee, aim);
    const samples = await profileSeries([tee, aim], async p =>
        planarMeters(tee, p) > leg / 2 ? null : 10);
    expect(samples.some(s => s.elevation === null)).toBe(true);
    expect(samples.some(s => s.elevation !== null)).toBe(true);
    expect(samples[0].elevation).toBe(10);
    expect(samples[samples.length - 1].elevation).toBeNull();
});

test('series: clamps samples per leg', async () => {
    // ~1.1 km leg at 2 m interval would be ~560 samples — clamped to 200.
    const far: LatLon = { lat: 58.37, lon: 15.71 };
    const samples = await profileSeries([tee, far], planeSampler);
    expect(samples.length).toBe(MAX_SAMPLES_PER_LEG);
    expect(samples[samples.length - 1].distance).toBeCloseTo(planarMeters(tee, far), 6);
});

// ─── Smoothing ────────────────────────────────────────────────────────────

test('smoothing flattens stair-steps but keeps gaps and count', () => {
    // 0.1 m quantized stair-step series.
    const samples: ProfileSample[] = Array.from({ length: 20 }, (_, i) => ({
        distance: i * 2,
        elevation: i % 2 === 0 ? 50.0 : 50.1,
    }));
    samples[10].elevation = null; // coverage gap must survive
    const smoothed = smoothProfile(samples);
    expect(smoothed.length).toBe(samples.length);
    expect(smoothed[10].elevation).toBeNull();
    // Interior smoothed values sit strictly between the raw extremes.
    for (const sample of smoothed.slice(2, 8)) {
        expect(sample.elevation!).toBeGreaterThan(50.0);
        expect(sample.elevation!).toBeLessThan(50.1);
    }
    // Distances untouched.
    expect(smoothed.map(s => s.distance)).toEqual(samples.map(s => s.distance));
});

// ─── Service (seq guard + markers) ────────────────────────────────────────

test('service resolves markers and deltas', async () => {
    const svc = new ElevationProfileService();
    svc.useSampler(planeSampler);
    await svc.update([tee, aim, green], ['Tee', 'S1', 'Green']);

    expect(svc.loading.get()).toBe(false);
    expect(svc.samples.get().length).toBeGreaterThan(0);
    expect(svc.markers.get().map(m => m.label)).toEqual(['Tee', 'S1', 'Green']);

    expect(svc.markers.get()[0].elevation!).toBeCloseTo(plane(tee), 3);
    expect(svc.markers.get()[2].elevation!).toBeCloseTo(plane(green), 3);
    expect(svc.totalDelta.get()!).toBeCloseTo(plane(green) - plane(tee), 2);
    expect(svc.legDeltas.get().map(l => l.label)).toEqual(['Tee→S1', 'S1→Green']);
    expect(svc.totalDistance.get()).toBeCloseTo(
        planarMeters(tee, aim) + planarMeters(aim, green), 6);
});

test('service drops a superseded batch', async () => {
    // Path 1's samples (lat < 58.38) block until released; path 2's resolve
    // immediately with a distinct value.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const svc = new ElevationProfileService();
    svc.useSampler(async p => {
        if (p.lat < 58.38) {
            await gate;
            return 10;
        }
        return 20;
    });

    const first = svc.update([tee, aim], ['Tee', 'Green']); // batch 1, blocked
    const path2: LatLon[] = [{ lat: 58.39, lon: 15.71 }, { lat: 58.391, lon: 15.711 }];
    await svc.update(path2, ['A', 'B']); // batch 2, fast

    expect(svc.path.get()).toEqual(path2);
    expect(svc.markers.get().map(m => m.label)).toEqual(['A', 'B']);
    expect(svc.samples.get().every(s => s.elevation === 20)).toBe(true);
    const count = svc.samples.get().length;

    release(); // stale batch 1 lands now — must be dropped
    await first;
    expect(svc.samples.get().length).toBe(count);
    expect(svc.samples.get().every(s => s.elevation === 20)).toBe(true);
});

test('service clear and short path', async () => {
    const svc = new ElevationProfileService();
    svc.useSampler(planeSampler);
    await svc.update([tee], ['Tee']);
    expect(svc.markers.get().length).toBe(1);
    expect(svc.samples.get()).toEqual([]);
    expect(svc.loading.get()).toBe(false);
    expect(svc.totalDelta.get()).toBeNull();

    svc.clear();
    expect(svc.markers.get()).toEqual([]);
    expect(svc.path.get()).toEqual([]);
});
