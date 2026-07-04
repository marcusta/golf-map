import { test, expect } from 'bun:test';
import {
    segmentStats,
    pathSegmentStats,
    pathTotals,
    MeasureState,
    type MeasurePoint,
} from '../src/measure/measure-state';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a MeasurePoint from EPSG:3006 easting/northing + elevation. lng/lat
 * are irrelevant to the stats math (all distances use e/n), so we leave them
 * at 0 for these pure tests.
 */
function pt(e: number, n: number, elevation: number | null): MeasurePoint {
    return { lng: 0, lat: 0, e, n, elevation };
}

const approx = (v: number, expected: number, eps = 1e-6) => expect(Math.abs(v - expected)).toBeLessThan(eps);

// ─── segmentStats — projected-meter distances vs known control values ───────

test('horizontal distance is planar EPSG:3006 Euclidean (3-4-5 triangle)', () => {
    const s = segmentStats(pt(0, 0, 10), pt(3, 4, 10));
    approx(s.horizontal, 5);
    approx(s.elevationDelta!, 0);
    approx(s.straightLine!, 5); // flat → equals horizontal
    approx(s.slopeDeg!, 0);
    approx(s.slopePct!, 0);
    approx(s.playsLikeSimple!, 5);
});

test('signed elevation delta, 3D straight line, slope %/° for an uphill segment', () => {
    // 100 m run, +10 m rise. straight = sqrt(100^2 + 10^2) = 100.4988…
    const s = segmentStats(pt(0, 0, 50), pt(100, 0, 60));
    approx(s.horizontal, 100);
    approx(s.elevationDelta!, 10);
    approx(s.straightLine!, Math.sqrt(100 * 100 + 10 * 10));
    approx(s.slopePct!, 10); // 10/100 * 100
    approx(s.slopeDeg!, (Math.atan2(10, 100) * 180) / Math.PI);
    approx(s.playsLikeSimple!, 110); // 100 + 10 (uphill plays longer)
});

test('downhill segment: negative elevation delta but positive slope magnitude, shorter plays-like', () => {
    const s = segmentStats(pt(0, 0, 60), pt(0, 100, 50));
    approx(s.elevationDelta!, -10);
    approx(s.slopePct!, 10); // magnitude
    approx(s.slopeDeg!, (Math.atan2(10, 100) * 180) / Math.PI);
    approx(s.playsLikeSimple!, 90); // 100 + (-10) downhill plays shorter
    approx(s.straightLine!, Math.sqrt(100 * 100 + 10 * 10));
});

test('slope is 0 (not NaN) when run is zero and elevations exist', () => {
    const s = segmentStats(pt(5, 5, 10), pt(5, 5, 12));
    approx(s.horizontal, 0);
    approx(s.slopePct!, 0);
    approx(s.elevationDelta!, 2);
});

test('a ~330m par-4-scale segment gives plausible few-hundred-metre readings', () => {
    // 300 m east, 120 m north → hypot ≈ 323.11 m, +2 m rise.
    const s = segmentStats(pt(0, 0, 55), pt(300, 120, 57));
    approx(s.horizontal, Math.hypot(300, 120), 1e-6);
    expect(s.horizontal).toBeGreaterThan(300);
    expect(s.horizontal).toBeLessThan(340);
    approx(s.elevationDelta!, 2);
    expect(s.slopePct!).toBeLessThan(1); // < 1% over 300 m
});

// ─── null-elevation handling ────────────────────────────────────────────────

test('null elevation on either endpoint → horizontal only, rest null', () => {
    const a = segmentStats(pt(0, 0, null), pt(100, 0, 60));
    approx(a.horizontal, 100);
    expect(a.elevationDelta).toBeNull();
    expect(a.straightLine).toBeNull();
    expect(a.slopeDeg).toBeNull();
    expect(a.slopePct).toBeNull();
    expect(a.playsLikeSimple).toBeNull();

    const b = segmentStats(pt(0, 0, 50), pt(100, 0, null));
    approx(b.horizontal, 100);
    expect(b.elevationDelta).toBeNull();
});

// ─── pathSegmentStats + pathTotals ──────────────────────────────────────────

test('pathSegmentStats yields one entry per segment (n-1)', () => {
    const path = [pt(0, 0, 10), pt(100, 0, 12), pt(100, 100, 15)];
    const segs = pathSegmentStats(path);
    expect(segs).toHaveLength(2);
    approx(segs[0].horizontal, 100);
    approx(segs[1].horizontal, 100);
});

test('pathTotals sums horizontal, elevation delta, draped 3D and plays-like', () => {
    const path = [pt(0, 0, 10), pt(100, 0, 20), pt(200, 0, 15)];
    const totals = pathTotals(pathSegmentStats(path));
    approx(totals.horizontal, 200);
    approx(totals.elevationDelta!, 5); // +10 then -5
    // draped = sqrt(100^2+10^2) + sqrt(100^2+5^2)
    approx(totals.straightLine!, Math.sqrt(100 * 100 + 100) + Math.sqrt(100 * 100 + 25));
    approx(totals.playsLikeSimple!, 205); // (100+10) + (100-5)
    expect(totals.measuredSegments).toBe(2);
    expect(totals.totalSegments).toBe(2);
});

test('pathTotals: horizontal counts all segments; elevation totals count only measured segments', () => {
    const path = [pt(0, 0, 10), pt(100, 0, null), pt(200, 0, 30)];
    const totals = pathTotals(pathSegmentStats(path));
    approx(totals.horizontal, 200); // both segments count for horizontal
    // Both segments touch the null-elevation middle point → no measured segments.
    expect(totals.measuredSegments).toBe(0);
    expect(totals.elevationDelta).toBeNull();
    expect(totals.straightLine).toBeNull();
    expect(totals.playsLikeSimple).toBeNull();
});

test('pathTotals aggregate slope uses only the measured run', () => {
    // Segment 1: 100 m, +5 m (measured). Segment 2: 100 m, null (unmeasured).
    const path = [pt(0, 0, 10), pt(100, 0, 15), pt(200, 0, null)];
    const totals = pathTotals(pathSegmentStats(path));
    expect(totals.measuredSegments).toBe(1);
    approx(totals.elevationDelta!, 5);
    approx(totals.slopePct!, 5); // 5 / 100 (measured run only), not 5/200
});

// ─── State machine: place / extend / end / restart / clear ──────────────────

test('place → extend builds A, B, C…; hasPath after two points', () => {
    const st = new MeasureState();
    expect(st.count.get()).toBe(0);
    expect(st.hasPath.get()).toBe(false);

    st.place(pt(0, 0, 10));
    expect(st.count.get()).toBe(1);
    expect(st.hasPath.get()).toBe(false);

    st.place(pt(100, 0, 12));
    expect(st.count.get()).toBe(2);
    expect(st.hasPath.get()).toBe(true);

    st.place(pt(100, 100, 14));
    expect(st.count.get()).toBe(3);
    expect(st.segments.get()).toHaveLength(2);
});

test('end() marks the path complete but keeps the points; next place() restarts', () => {
    const st = new MeasureState();
    st.place(pt(0, 0, 10));
    st.place(pt(100, 0, 12));
    st.end();
    expect(st.ended.get()).toBe(true);
    expect(st.count.get()).toBe(2); // still visible

    st.place(pt(500, 500, 20)); // starts fresh
    expect(st.ended.get()).toBe(false);
    expect(st.count.get()).toBe(1);
    expect(st.points.get()[0].e).toBe(500);
});

test('end() is a no-op with fewer than two points', () => {
    const st = new MeasureState();
    st.place(pt(0, 0, 10));
    st.end();
    expect(st.ended.get()).toBe(false);
    expect(st.count.get()).toBe(1);
});

test('clear() wipes points and the ended flag', () => {
    const st = new MeasureState();
    st.place(pt(0, 0, 10));
    st.place(pt(100, 0, 12));
    st.end();
    st.clear();
    expect(st.count.get()).toBe(0);
    expect(st.ended.get()).toBe(false);
    expect(st.hasPath.get()).toBe(false);
});

test('setElevation patches one point and flows into stats', () => {
    const st = new MeasureState();
    st.place(pt(0, 0, null));
    st.place(pt(100, 0, null));
    expect(st.segments.get()[0].elevationDelta).toBeNull();

    st.setElevation(0, 10);
    st.setElevation(1, 20);
    approx(st.segments.get()[0].elevationDelta!, 10);

    // Out-of-range index is ignored.
    st.setElevation(5, 999);
    expect(st.count.get()).toBe(2);
});
