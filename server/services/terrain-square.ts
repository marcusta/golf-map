// GSPro terrains are SQUARES in SWEREF99 TM (EPSG:3006) metres, and a
// course is built as two of them:
//
//   - the INNER terrain: tight around the course (a square, so rarely tight
//     on every side). Its side is always a whole multiple of
//     TERRAIN_SIDE_STEP_M (10 m) — 2010 m, 1870 m, 2200 m, never 2009.37 m —
//     and its edges land on whole metres, so heightmaps and textures pixel-
//     align and the numbers typed into Unity are clean.
//   - the OUTER terrain: background scenery around the course, centred on the
//     inner square, OUTER_TERRAIN_SIDE_M (5 km) on a side.
//
// The map area the operator draws (a WGS84 lon/lat box) is the INPUT; the
// inner square is derived from it here, once, at build time, and persisted
// with the site (`terrain.inner` in the tile manifest). Everything downstream
// — grid-dem's crop, the map's bounds, the GSPro SVG/ortho/DEM exports —
// reads that one square, so nothing re-derives it with a slightly different
// rounding.

import { sweref99tmToWgs84, wgs84ToSweref99tm } from './geo';
import type { Bbox3006, BboxWgs84 } from './course-bbox';

/** Inner-terrain side lengths are multiples of this (metres). */
export const TERRAIN_SIDE_STEP_M = 10;
/** Outer terrain side (metres) — the usual 5 km background square. */
export const OUTER_TERRAIN_SIDE_M = 5000;
/**
 * The outer square must clear the inner one by at least this much on every
 * side; an unusually large inner terrain grows the outer instead of
 * swallowing it.
 */
export const OUTER_TERRAIN_MIN_MARGIN_M = 1000;

/** A square's EPSG:3006 extent as an object (the API shape; tuples don't codegen). */
export interface SquareBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** One terrain square: the exact EPSG:3006 extent plus what the UI shows. */
export interface TerrainSquare {
    /** The extent in EPSG:3006 metres, whole metres. */
    square: SquareBox;
    /** Side length in metres (a multiple of TERRAIN_SIDE_STEP_M). */
    sideM: number;
    /** Centre in EPSG:3006 metres. */
    centre: { x: number; y: number };
    /** WGS84 envelope of the square — what area-based fetches ask for. */
    wgs84: BboxWgs84;
}

export interface CourseTerrain {
    inner: TerrainSquare;
    outer: TerrainSquare;
}

/** Math.round without the -0 that `toEqual`/JSON would carry along. */
function wholeMetre(n: number): number {
    const r = Math.round(n);
    return r === 0 ? 0 : r;
}

/** Side of an EPSG:3006 square (or the longer side of a box). */
export function squareSideM(box: Bbox3006): number {
    return Math.max(box[2] - box[0], box[3] - box[1]);
}

/** `n` rounded to the nearest multiple of `step`, never below one step. */
export function snapSide(n: number, step = TERRAIN_SIDE_STEP_M): number {
    return Math.max(step, Math.round(n / step) * step);
}

/**
 * The square of side `sideM` centred where `box` is centred, edges on
 * whole metres. The centre is snapped to a half-metre grid so the whole-
 * metre edges stay a true square of exactly `sideM`.
 */
export function centredSquare(box: Bbox3006, sideM: number): Bbox3006 {
    const cx = (box[0] + box[2]) / 2;
    const cy = (box[1] + box[3]) / 2;
    const x0 = wholeMetre(cx - sideM / 2);
    const y0 = wholeMetre(cy - sideM / 2);
    return [x0, y0, x0 + sideM, y0 + sideM];
}

/**
 * The INNER terrain square for an EPSG:3006 box: the box's longer side
 * snapped to the 10 m step (so a drawn 2009.4 m area becomes 2010 m, not a
 * decimal), centred where the box is centred.
 */
export function innerSquareFrom3006(box: Bbox3006): Bbox3006 {
    return centredSquare(box, snapSide(squareSideM(box)));
}

/**
 * The INNER terrain square for a drawn WGS84 map area. The lon/lat box is
 * reprojected corner by corner (a lon/lat rectangle is a slightly rotated
 * quadrilateral in EPSG:3006) and its metre envelope squared and snapped.
 */
export function innerSquareFromWgs84(bbox: BboxWgs84): Bbox3006 {
    return innerSquareFrom3006(envelope3006(bbox));
}

/**
 * The OUTER terrain square around an inner one: same centre, 5 km on a side
 * — or, for an inner terrain too big for that, the inner side plus a 1 km
 * margin all round, still on the 10 m step.
 */
export function outerSquareFor(inner: Bbox3006, sideM = OUTER_TERRAIN_SIDE_M): Bbox3006 {
    const minSide = squareSideM(inner) + 2 * OUTER_TERRAIN_MIN_MARGIN_M;
    const side = Math.max(sideM, Math.ceil(minSide / TERRAIN_SIDE_STEP_M) * TERRAIN_SIDE_STEP_M);
    return centredSquare(inner, side);
}

/** Both terrains for a course, from its inner square. */
export function courseTerrainFor(inner: Bbox3006): CourseTerrain {
    return { inner: describeSquare(inner), outer: describeSquare(outerSquareFor(inner)) };
}

export function toSquareBox(b: Bbox3006): SquareBox {
    return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
}

export function squareTuple(s: SquareBox): Bbox3006 {
    return [s.minX, s.minY, s.maxX, s.maxY];
}

/** `x0,y0,x1,y1` for a described terrain — the pipeline's `--square-3006`. */
export function terrainArg(t: TerrainSquare): string {
    return squareArg(squareTuple(t.square));
}

export function describeSquare(square: Bbox3006): TerrainSquare {
    return {
        square: toSquareBox(square),
        sideM: squareSideM(square),
        centre: { x: (square[0] + square[2]) / 2, y: (square[1] + square[3]) / 2 },
        wgs84: envelopeWgs84(square),
    };
}

/** EPSG:3006 envelope of a WGS84 box's four corners. */
export function envelope3006(bbox: BboxWgs84): Bbox3006 {
    const corners = [
        wgs84ToSweref99tm(bbox.south, bbox.west),
        wgs84ToSweref99tm(bbox.south, bbox.east),
        wgs84ToSweref99tm(bbox.north, bbox.east),
        wgs84ToSweref99tm(bbox.north, bbox.west),
    ];
    return [
        Math.min(...corners.map(c => c.x)),
        Math.min(...corners.map(c => c.y)),
        Math.max(...corners.map(c => c.x)),
        Math.max(...corners.map(c => c.y)),
    ];
}

/** WGS84 envelope of an EPSG:3006 box's four corners. */
export function envelopeWgs84(box: Bbox3006): BboxWgs84 {
    const corners = [
        sweref99tmToWgs84(box[0], box[1]),
        sweref99tmToWgs84(box[2], box[1]),
        sweref99tmToWgs84(box[2], box[3]),
        sweref99tmToWgs84(box[0], box[3]),
    ];
    return {
        west: Math.min(...corners.map(c => c.lon)),
        south: Math.min(...corners.map(c => c.lat)),
        east: Math.max(...corners.map(c => c.lon)),
        north: Math.max(...corners.map(c => c.lat)),
    };
}

/** `x0,y0,x1,y1` — the form the pipeline's `--bbox-3006` / `--square-3006` take. */
export function squareArg(box: Bbox3006): string {
    return box.join(',');
}

/** `west,south,east,north` for the pipeline's `--bbox`. */
export function bboxArg(b: BboxWgs84): string {
    return [b.west, b.south, b.east, b.north].join(',');
}

/** Parse a manifest's `terrain.inner.square3006`, or null when absent/invalid. */
export function parseTerrainSquare(manifest: unknown): Bbox3006 | null {
    const terrain = (manifest as { terrain?: { inner?: { square3006?: unknown } } } | null)?.terrain;
    const sq = terrain?.inner?.square3006;
    if (Array.isArray(sq) && sq.length === 4 && sq.every(n => typeof n === 'number' && Number.isFinite(n))
        && sq[2] > sq[0] && sq[3] > sq[1]) {
        return [sq[0], sq[1], sq[2], sq[3]];
    }
    return null;
}

/** The manifest field a build writes for its inner terrain. */
export function terrainManifestField(inner: Bbox3006): { inner: { square3006: Bbox3006; sideM: number } } {
    return { inner: { square3006: inner, sideM: squareSideM(inner) } };
}
