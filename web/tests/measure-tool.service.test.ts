import { test, expect } from 'bun:test';
import {
    MeasureToolService,
    PROFILE_SAMPLES_PER_SEGMENT,
    pointLabel,
    type MeasureElevationSampler,
} from '../src/measure/measure-tool.service';
import type { MeasurePoint } from '../src/measure/measure-state';

// ─── Fake elevation sampler ─────────────────────────────────────────────────

interface SampleLineCall {
    a: { lng: number; lat: number };
    b: { lng: number; lat: number };
    n: number;
}

/**
 * Fake ElevationService: `elevationAt` returns a height derived from lng (so
 * each point gets a deterministic, distinct value), or null for lngs marked
 * as "no coverage". `sampleLine` records its call shape and linearly ramps.
 */
function fakeSampler(opts: { nullFor?: (lng: number) => boolean } = {}): MeasureElevationSampler & {
    elevationCalls: Array<{ lng: number; lat: number }>;
    sampleLineCalls: SampleLineCall[];
} {
    const nullFor = opts.nullFor ?? (() => false);
    const s = {
        elevationCalls: [] as Array<{ lng: number; lat: number }>,
        sampleLineCalls: [] as SampleLineCall[],
        async elevationAt(lngLat: { lng: number; lat: number }) {
            s.elevationCalls.push(lngLat);
            return nullFor(lngLat.lng) ? null : 50 + lngLat.lng;
        },
        async sampleLine(a: { lng: number; lat: number }, b: { lng: number; lat: number }, n: number) {
            s.sampleLineCalls.push({ a, b, n });
            const count = Math.max(2, Math.floor(n));
            return Array.from({ length: count }, (_, i) => {
                const t = i / (count - 1);
                const lng = a.lng + (b.lng - a.lng) * t;
                const lat = a.lat + (b.lat - a.lat) * t;
                return { lng, lat, elevation: nullFor(lng) ? null : 50 + lng };
            });
        },
    };
    return s;
}

/** Directly place a point on the state (bypasses map events, which need maplibre). */
function place(svc: MeasureToolService, e: number, n: number, elevation: number | null, lng = 0, lat = 0): void {
    const p: MeasurePoint = { lng, lat, e, n, elevation };
    svc.state.place(p);
}

// ─── pointLabel ─────────────────────────────────────────────────────────────

test('pointLabel yields A, B, C, …', () => {
    expect(pointLabel(0)).toBe('A');
    expect(pointLabel(1)).toBe('B');
    expect(pointLabel(2)).toBe('C');
    expect(pointLabel(25)).toBe('Z');
});

// ─── onEscape / clear ───────────────────────────────────────────────────────

test('onEscape clears a visible path, then lets the toolbar deactivate', () => {
    const svc = new MeasureToolService();
    expect(svc.onEscape()).toBe(false); // empty → deactivate

    place(svc, 0, 0, 10);
    place(svc, 100, 0, 12);
    expect(svc.onEscape()).toBe(true); // consumed: cleared
    expect(svc.state.count.get()).toBe(0);
    expect(svc.onEscape()).toBe(false);
});

test('clear resets the path and profile', () => {
    const svc = new MeasureToolService();
    place(svc, 0, 0, 10);
    place(svc, 100, 0, 12);
    svc.profile.set([{ distance: 0, elevation: 50 }]);
    svc.clear();
    expect(svc.state.count.get()).toBe(0);
    expect(svc.profile.get()).toHaveLength(0);
});

// ─── profile sampling request shape ─────────────────────────────────────────

test('refreshProfile requests PROFILE_SAMPLES_PER_SEGMENT samples per segment with the right endpoints', async () => {
    const sampler = fakeSampler();
    const svc = new MeasureToolService();
    svc.useElevation(sampler);

    // Two segments: A(lng 1) → B(lng 2) → C(lng 3).
    place(svc, 0, 0, null, 1, 60);
    place(svc, 100, 0, null, 2, 60);
    place(svc, 200, 0, null, 3, 60);

    await (svc as unknown as { refreshProfile(): Promise<void> }).refreshProfile();

    expect(sampler.sampleLineCalls).toHaveLength(2);
    expect(sampler.sampleLineCalls[0]).toEqual({ a: { lng: 1, lat: 60 }, b: { lng: 2, lat: 60 }, n: PROFILE_SAMPLES_PER_SEGMENT });
    expect(sampler.sampleLineCalls[1]).toEqual({ a: { lng: 2, lat: 60 }, b: { lng: 3, lat: 60 }, n: PROFILE_SAMPLES_PER_SEGMENT });

    // Profile is populated with monotonically increasing cumulative distance,
    // no duplicated shared vertex (first segment full, later segments skip
    // their first sample).
    const profile = svc.profile.get();
    // 50 samples + (50-1) = 99 total.
    expect(profile.length).toBe(PROFILE_SAMPLES_PER_SEGMENT * 2 - 1);
    expect(profile[0].distance).toBe(0);
    expect(profile[profile.length - 1].distance).toBeCloseTo(200, 5);
    for (let i = 1; i < profile.length; i++) {
        expect(profile[i].distance).toBeGreaterThanOrEqual(profile[i - 1].distance);
    }
});

test('refreshProfile clears the profile for a path with fewer than two points', async () => {
    const svc = new MeasureToolService();
    svc.useElevation(fakeSampler());
    place(svc, 0, 0, 10, 1, 60);
    await (svc as unknown as { refreshProfile(): Promise<void> }).refreshProfile();
    expect(svc.profile.get()).toHaveLength(0);
});

test('profileRange reports min/max over non-null samples; null when no data', async () => {
    const svc = new MeasureToolService();
    svc.useElevation(fakeSampler());
    expect(svc.profileRange.get()).toBeNull();

    // lng ramps 10 → 20 over the segment → elevation 60 → 70.
    place(svc, 0, 0, null, 10, 60);
    place(svc, 100, 0, null, 20, 60);
    await (svc as unknown as { refreshProfile(): Promise<void> }).refreshProfile();

    const range = svc.profileRange.get();
    expect(range).not.toBeNull();
    expect(range!.min).toBeCloseTo(60, 5);
    expect(range!.max).toBeCloseTo(70, 5);
});

test('missing terrain coverage produces null samples (sparkline gaps) without throwing', async () => {
    // Second half of the segment (lng > 15) has no coverage.
    const svc = new MeasureToolService();
    svc.useElevation(fakeSampler({ nullFor: lng => lng > 15 }));
    place(svc, 0, 0, null, 10, 60);
    place(svc, 100, 0, null, 20, 60);
    await (svc as unknown as { refreshProfile(): Promise<void> }).refreshProfile();

    const profile = svc.profile.get();
    expect(profile.some(s => s.elevation === null)).toBe(true);
    expect(profile.some(s => s.elevation !== null)).toBe(true);
    // Range is computed only over the measurable half.
    const range = svc.profileRange.get();
    expect(range!.max).toBeLessThanOrEqual(50 + 15);
});
