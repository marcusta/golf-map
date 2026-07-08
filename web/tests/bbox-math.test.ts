import { test, expect } from 'bun:test';
import { bboxMetrics, formatBboxSize, squareBox } from '../src/map-build/bbox-math';

// A Swedish golf-course latitude for realistic lon/lat scaling.
const ANCHOR_LNG = 15.56;
const ANCHOR_LAT = 58.40;

test('squareBox produces an integer-metre square (width == height, both whole)', () => {
    // Drag roughly 800 m east, 500 m south — the larger side (≈800) drives it.
    const box = squareBox(ANCHOR_LNG, ANCHOR_LAT, ANCHOR_LNG + 0.014, ANCHOR_LAT - 0.0045);
    const m = bboxMetrics(box);

    expect(Math.round(m.widthM)).toBe(Math.round(m.heightM)); // square
    expect(m.widthM).toBeCloseTo(Math.round(m.widthM), 3);     // whole metres
    expect(m.heightM).toBeCloseTo(Math.round(m.heightM), 3);
});

test('squareBox side equals the rounded larger dragged dimension', () => {
    const cursorLng = ANCHOR_LNG + 0.02; // wide
    const cursorLat = ANCHOR_LAT - 0.001; // short
    const raw = bboxMetrics({
        west: Math.min(ANCHOR_LNG, cursorLng), east: Math.max(ANCHOR_LNG, cursorLng),
        south: Math.min(ANCHOR_LAT, cursorLat), north: Math.max(ANCHOR_LAT, cursorLat),
    });
    const expectedSide = Math.round(Math.max(raw.widthM, raw.heightM));

    const box = squareBox(ANCHOR_LNG, ANCHOR_LAT, cursorLng, cursorLat);
    expect(Math.round(bboxMetrics(box).widthM)).toBe(expectedSide);
});

test('anchor corner stays fixed; box extends toward the cursor', () => {
    // Drag toward the north-east: anchor is the SW corner.
    const ne = squareBox(ANCHOR_LNG, ANCHOR_LAT, ANCHOR_LNG + 0.01, ANCHOR_LAT + 0.008);
    expect(ne.west).toBeCloseTo(ANCHOR_LNG, 9);
    expect(ne.south).toBeCloseTo(ANCHOR_LAT, 9);
    expect(ne.east).toBeGreaterThan(ANCHOR_LNG);
    expect(ne.north).toBeGreaterThan(ANCHOR_LAT);

    // Drag toward the south-west: anchor is the NE corner.
    const sw = squareBox(ANCHOR_LNG, ANCHOR_LAT, ANCHOR_LNG - 0.01, ANCHOR_LAT - 0.008);
    expect(sw.east).toBeCloseTo(ANCHOR_LNG, 9);
    expect(sw.north).toBeCloseTo(ANCHOR_LAT, 9);
});

test('formatBboxSize renders whole metres and hectares', () => {
    const box = squareBox(ANCHOR_LNG, ANCHOR_LAT, ANCHOR_LNG + 0.02, ANCHOR_LAT + 0.011);
    // e.g. "1200 m × 1200 m · 144.0 ha" — no fractional metres.
    expect(formatBboxSize(box)).toMatch(/^\d+ m × \d+ m · [\d.]+ ha$/);
});

test('degenerate drag (no movement) yields a minimal 1 m square, not zero', () => {
    const box = squareBox(ANCHOR_LNG, ANCHOR_LAT, ANCHOR_LNG, ANCHOR_LAT);
    const m = bboxMetrics(box);
    expect(m.widthM).toBeCloseTo(1, 3);
    expect(m.heightM).toBeCloseTo(1, 3);
});
