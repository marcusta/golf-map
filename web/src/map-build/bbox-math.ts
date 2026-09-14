import type { Bbox } from '../../../shared/api/map-build.gen';

export type { Bbox };

const R = 6371000; // mean earth radius, m
export const M_PER_DEG_LAT = (R * Math.PI) / 180; // ≈ 111195 m per degree latitude

/**
 * The drawn square's side snaps to this step (metres). A GSPro inner terrain
 * is 2010 m or 1870 m or 2200 m on a side, never 2009.37 m — the server
 * snaps the built terrain to the same step in EPSG:3006 (its
 * terrain-square.ts), so what the picker shows is what gets built.
 */
export const SIDE_STEP_M = 10;

export interface BboxMetrics {
    widthM: number;
    heightM: number;
    hectares: number;
    km2: number;
}

/** Equirectangular size of a bbox — good enough for a size readout. */
export function bboxMetrics(bbox: Bbox): BboxMetrics {
    const midLat = ((bbox.south + bbox.north) / 2) * (Math.PI / 180);
    const widthM = Math.abs(bbox.east - bbox.west) * (Math.PI / 180) * R * Math.cos(midLat);
    const heightM = Math.abs(bbox.north - bbox.south) * (Math.PI / 180) * R;
    const m2 = widthM * heightM;
    return { widthM, heightM, hectares: m2 / 10_000, km2: m2 / 1_000_000 };
}

/** Whole-metre dimensions (the box is snapped square, so width == height). */
export function formatBboxSize(bbox: Bbox): string {
    const m = bboxMetrics(bbox);
    return `${Math.round(m.widthM)} m × ${Math.round(m.heightM)} m · ${m.hectares.toFixed(1)} ha`;
}

export function normalize(aLng: number, aLat: number, bLng: number, bLat: number): Bbox {
    return {
        west: Math.min(aLng, bLng),
        east: Math.max(aLng, bLng),
        south: Math.min(aLat, bLat),
        north: Math.max(aLat, bLat),
    };
}

/** `n` metres snapped to the nearest SIDE_STEP_M, never below one step. */
export function snapSide(n: number): number {
    return Math.max(SIDE_STEP_M, Math.round(n / SIDE_STEP_M) * SIDE_STEP_M);
}

/**
 * Build a bbox from a fixed `anchor` corner toward a `cursor`, forced to a
 * SQUARE whose side is a whole number of tens of metres (GSPro courses
 * require square areas, and a side like 2010 m keeps the exported material
 * clean). The side is the larger of the dragged width/height, snapped; the
 * opposite corner is derived so width == height == side exactly — measured
 * the same way `bboxMetrics` measures, via the box's mid-latitude.
 */
export function squareBox(anchorLng: number, anchorLat: number, cursorLng: number, cursorLat: number): Bbox {
    const sx = cursorLng >= anchorLng ? 1 : -1;
    const sy = cursorLat >= anchorLat ? 1 : -1;
    const m = bboxMetrics(normalize(anchorLng, anchorLat, cursorLng, cursorLat));
    const side = snapSide(Math.max(m.widthM, m.heightM));

    const dLat = side / M_PER_DEG_LAT;
    const midLat = (anchorLat + (sy * dLat) / 2) * (Math.PI / 180);
    const dLon = side / (R * Math.cos(midLat) * (Math.PI / 180));

    return normalize(anchorLng, anchorLat, anchorLng + sx * dLon, anchorLat + sy * dLat);
}
