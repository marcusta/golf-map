import { test, expect } from 'bun:test';
import { measureRange, pointAtDistance } from '../src/profile/profile-measure';
import { measureHtml } from '../src/profile/elevation-profile.component';
import { playsAsM, windEffect } from '../../shared/strategy';
import type { LatLon, ProfileSample } from '../src/profile/elevation-profile';

// Straight-north path on the SWEREF99TM central meridian (15°E), so the
// planar chord bearing is ~0° and wind-from-north is a dead headwind.
const path: LatLon[] = [
    { lat: 57.0, lon: 15.0 },
    { lat: 57.004, lon: 15.0 },
];

// Linear 1% uphill: elevation 50 m at the tee, +0.01 per meter.
function uphillSamples(totalM: number): ProfileSample[] {
    const samples: ProfileSample[] = [];
    for (let d = 0; d <= totalM; d += 5) {
        samples.push({ distance: d, elevation: 50 + d * 0.01 });
    }
    return samples;
}

test('measureRange: distance, raw Δelev, and plays-like without wind', () => {
    const m = measureRange(uphillSamples(440), path, null, 100, 300);
    expect(m.distanceM).toBe(200);
    expect(m.elevationDeltaM).toBeCloseTo(2, 5);
    expect(m.playsLikeM).toBeCloseTo(202, 5); // horizontal + Δelev
    expect(m.windAdjM).toBeNull();
    expect(Math.abs(m.bearingDeg!)).toBeLessThan(1.5); // ~due north
});

test('measureRange: order-agnostic and headwind lengthens plays-like', () => {
    const samples = uphillSamples(440);
    const wind = { speedMps: 6, directionDeg: 0 }; // from the north = headwind
    const m = measureRange(samples, path, wind, 300, 100); // reversed drag
    expect(m.distanceM).toBe(200);

    // Wind composes exactly like the iOS card: playsAs over the
    // elevation-adjusted base, with the effect evaluated at that base.
    const base = 202;
    const expected = playsAsM(base, windEffect(6, 0, m.bearingDeg!, base));
    expect(m.playsLikeM).toBeCloseTo(expected, 5);
    expect(m.playsLikeM).toBeGreaterThan(base);
    expect(m.windAdjM!).toBeCloseTo(m.playsLikeM - base, 5);
});

test('measureRange: tailwind shortens; coverage gap makes Δelev null', () => {
    const samples = uphillSamples(440);
    const tail = measureRange(samples, path, { speedMps: 6, directionDeg: 180 }, 100, 300);
    expect(tail.playsLikeM).toBeLessThan(202);
    expect(tail.windAdjM!).toBeLessThan(0);

    // Kill coverage around 300 m (> 5 m tolerance on both sides).
    const gappy = samples.map(s =>
        s.distance > 290 && s.distance < 312 ? { ...s, elevation: null } : s);
    const m = measureRange(gappy, path, null, 100, 300);
    expect(m.elevationDeltaM).toBeNull();
    expect(m.playsLikeM).toBeCloseTo(200, 5); // falls back to horizontal
});

test('pointAtDistance interpolates within legs and clamps at the ends', () => {
    const mid = pointAtDistance(path, 222.5)!; // ~half of ~445 m
    expect(mid.lat).toBeCloseTo(57.002, 3);
    expect(pointAtDistance(path, -50)!.lat).toBe(57.0);
    expect(pointAtDistance(path, 10_000)!.lat).toBe(57.004);
});

test('measureHtml renders distance, plays-like, and contribution chips', () => {
    const html = measureHtml({
        distanceM: 200, elevationDeltaM: 2, playsLikeM: 213.6,
        windAdjM: 11.6, bearingDeg: 0,
    }, true);
    expect(html).toContain('Distance <b>200 m</b>');
    expect(html).toContain('Plays like <b>214 m</b>');
    expect(html).toContain('Δ elev <b>+2.0 m</b>');
    expect(html).toContain('wind <b>+11.6 m</b>');

    expect(measureHtml(null, false)).toContain('Drag on the chart');
});
