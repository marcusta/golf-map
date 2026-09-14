import { test, expect } from 'bun:test';
import {
    innerSquareFromWgs84, innerSquareFrom3006, outerSquareFor, courseTerrainFor, snapSide,
    envelope3006, envelopeWgs84, parseTerrainSquare, terrainManifestField, squareSideM, toSquareBox, squareTuple, terrainArg,
    TERRAIN_SIDE_STEP_M, OUTER_TERRAIN_SIDE_M, OUTER_TERRAIN_MIN_MARGIN_M,
} from './terrain-square';
import { wgs84ToSweref99tm } from './geo';

// Vreta's drawn map area (WGS84), as its last build stored it.
const VRETA = { west: 15.498596210445248, south: 58.5195998096979, east: 15.533599547796717, north: 58.53787640512029 };

const side = (sq: [number, number, number, number]) => [sq[2] - sq[0], sq[3] - sq[1]];

test('the inner terrain is a true square on whole metres with a side on the 10 m step', () => {
    const inner = innerSquareFromWgs84(VRETA);
    const [w, h] = side(inner);
    expect(w).toBe(h);
    expect(w % TERRAIN_SIDE_STEP_M).toBe(0);
    for (const v of inner) expect(Number.isInteger(v)).toBe(true);
});

test('the inner square is centred on the drawn area and is as big as its longer side', () => {
    const env = envelope3006(VRETA);
    const inner = innerSquareFromWgs84(VRETA);
    const cx = (env[0] + env[2]) / 2;
    const cy = (env[1] + env[3]) / 2;
    expect((inner[0] + inner[2]) / 2).toBeCloseTo(cx, 0);
    expect((inner[1] + inner[3]) / 2).toBeCloseTo(cy, 0);
    expect(Math.abs(side(inner)[0] - squareSideM(env))).toBeLessThanOrEqual(TERRAIN_SIDE_STEP_M / 2);
});

test('the side rounds to the NEAREST ten, never a decimal', () => {
    expect(snapSide(2009.37)).toBe(2010);
    expect(snapSide(1874.9)).toBe(1870);
    expect(snapSide(1875)).toBe(1880);
    expect(snapSide(2200)).toBe(2200);
    expect(snapSide(3)).toBe(10);           // never smaller than one step
    expect(innerSquareFrom3006([0, 0, 2009.37, 1500])).toEqual([0, -255, 2010, 1755]);
});

test('an EPSG:3006 box that is already a snapped square is kept as it is', () => {
    const sq: [number, number, number, number] = [529030, 6486670, 531070, 6488710];
    expect(innerSquareFrom3006(sq)).toEqual(sq);
});

test('the outer terrain is 5 km, centred on the inner', () => {
    const inner = innerSquareFromWgs84(VRETA);
    const outer = outerSquareFor(inner);
    expect(side(outer)).toEqual([OUTER_TERRAIN_SIDE_M, OUTER_TERRAIN_SIDE_M]);
    expect((outer[0] + outer[2]) / 2).toBe((inner[0] + inner[2]) / 2);
    expect((outer[1] + outer[3]) / 2).toBe((inner[1] + inner[3]) / 2);
    // Fully contains the inner with room to spare on every side.
    expect(outer[0]).toBeLessThan(inner[0] - OUTER_TERRAIN_MIN_MARGIN_M);
    expect(outer[3]).toBeGreaterThan(inner[3] + OUTER_TERRAIN_MIN_MARGIN_M);
});

test('an inner terrain too big for 5 km grows the outer by a 1 km margin all round', () => {
    const inner: [number, number, number, number] = [500000, 6480000, 504000, 6484000]; // 4 km
    const outer = outerSquareFor(inner);
    expect(side(outer)).toEqual([6000, 6000]);
    expect(outer).toEqual([499000, 6479000, 505000, 6485000]);
});

test('courseTerrainFor describes both squares with side, centre and WGS84 envelope', () => {
    const inner = innerSquareFromWgs84(VRETA);
    const t = courseTerrainFor(inner);
    expect(t.inner.square).toEqual(toSquareBox(inner));
    expect(squareTuple(t.inner.square)).toEqual(inner);
    expect(terrainArg(t.inner)).toBe(inner.join(','));
    expect(t.inner.sideM).toBe(side(inner)[0]);
    expect(t.outer.sideM).toBe(OUTER_TERRAIN_SIDE_M);
    expect(t.inner.centre).toEqual(t.outer.centre);
    // The WGS84 envelope round-trips back over the square.
    const back = envelope3006(t.inner.wgs84);
    expect(back[0]).toBeLessThanOrEqual(inner[0] + 0.01);
    expect(back[2]).toBeGreaterThanOrEqual(inner[2] - 0.01);
    expect(t.outer.wgs84.west).toBeLessThan(t.inner.wgs84.west);
    expect(t.outer.wgs84.north).toBeGreaterThan(t.inner.wgs84.north);
});

test('envelopes reproject corner by corner, not just two opposite corners', () => {
    // A lon/lat box is a rotated quadrilateral in TM: its metre envelope is
    // wider than the two opposite corners alone would say.
    const env = envelope3006(VRETA);
    const sw = wgs84ToSweref99tm(VRETA.south, VRETA.west);
    const ne = wgs84ToSweref99tm(VRETA.north, VRETA.east);
    expect(env[0]).toBeLessThanOrEqual(sw.x);
    expect(env[2]).toBeGreaterThanOrEqual(ne.x);
    const w = envelopeWgs84(env);
    expect(w.west).toBeLessThanOrEqual(VRETA.west + 1e-9);
    expect(w.east).toBeGreaterThanOrEqual(VRETA.east - 1e-9);
});

test('the manifest field round-trips through parseTerrainSquare', () => {
    const inner = innerSquareFromWgs84(VRETA);
    const manifest = { bounds: VRETA, terrain: terrainManifestField(inner) };
    expect(parseTerrainSquare(manifest)).toEqual(inner);
    expect(manifest.terrain.inner.sideM).toBe(side(inner)[0]);
    expect(parseTerrainSquare({ bounds: VRETA })).toBeNull();
    expect(parseTerrainSquare(null)).toBeNull();
    expect(parseTerrainSquare({ terrain: { inner: { square3006: [1, 2, 3] } } })).toBeNull();
    expect(parseTerrainSquare({ terrain: { inner: { square3006: [3, 2, 1, 0] } } })).toBeNull();
});
