// Tier-2 green-surface adapter: a bilinear patch over a sampled DEM grid
// (the Lantmäteriet slope grid the server returns as SampleGrid).
// Implements GreenSurface (green-surface.ts) so the putting physics core
// (putt.ts / tour-read.ts) reads a national DEM exactly like a plane
// estimate or a phone LiDAR scan. See docs/feature-putting-green-reading.md
// §4 (data tiers), §4.2 (confidence).
//
// Decoupling: strategy/ must not import the wire layer, so the grid input
// is a STRUCTURAL type declared locally. The generated SampleGrid
// (shared/api/analysis.gen.ts) satisfies it structurally — callers pass a
// SampleGrid straight through — but this module has zero dependency on the
// API package. Pure, zero-dep.
//
// Grid layout (must match web/src/analysis/analysis-math.ts):
//  - heights are row-major from the NW corner: index = row·width + col.
//  - origin {e, n} is the EPSG:3006 top-left OUTER corner of the grid.
//    Cell (row, col) CENTER is at
//        e = origin.e + (col + 0.5)·resolution   (east grows with col)
//        n = origin.n − (row + 0.5)·resolution   (north shrinks with row;
//                                                  row 0 is the NORTHERNMOST)
//  - resolution is the cell size in meters (square cells).
//  - insideMask is 1 inside the analysed polygon, 0 outside.
//  - a null height is nodata.
//
// Sampling: bilinear interpolation over the four cell CENTERS surrounding
// the query point. heightAt is C0-continuous; the gradient is the analytic
// derivative of that bilinear patch, so it is PIECEWISE per cell (constant
// along each axis within a cell, discontinuous across cell-center lines).
// This matches computeSlopeGrid's convention: downhill = −∇h.
//
// Coverage / null policy: sampleAt returns null when the point is outside
// the grid OR any of the four surrounding cell centers is nodata (null
// height) or outside the polygon (insideMask 0). Off-green / no-data means
// "no read", never flat (green-surface.ts contract).
//
// Confidence: a single per-sample constant from options (default 0.6 — a
// deliberately conservative value for an uncalibrated national DEM, doc
// §4). The real per-green confidence map (derived from the server's
// calibration store) replaces this constant later; doc §4.2. Consumers
// gate/soften on it and must never sharpen it.

import type { Vec2 } from '../ellipse';
import type { GreenSurface, SurfaceSample } from './green-surface';

/** Conservative default confidence for an uncalibrated DEM (doc §4.2). */
export const DEM_DEFAULT_CONFIDENCE = 0.6;

/**
 * Structural view of a sampled DEM grid. The generated SampleGrid
 * (shared/api/analysis.gen.ts) satisfies this — kept local so strategy/
 * never imports the wire layer.
 */
export interface DemGrid {
    /** Row-major from NW, index = row·width + col. null = nodata. */
    heights: (number | null)[];
    /** Row-major, same indexing. 1 = inside polygon, 0 = outside. */
    insideMask: number[];
    /** EPSG:3006 top-left OUTER corner of the grid. */
    origin: { e: number; n: number };
    /** Cell size, meters (square cells). */
    resolution: number;
    /** Cells across (east). */
    width: number;
    /** Cells down (south). */
    height: number;
}

/**
 * Tier-2 adapter: sample a DEM SampleGrid as a bilinear surface.
 * `confidence` (default DEM_DEFAULT_CONFIDENCE) is emitted on every sample.
 */
export function demSurface(grid: DemGrid, options?: { confidence?: number }): GreenSurface {
    const { heights, insideMask, origin, resolution, width, height } = grid;
    const confidence = options?.confidence ?? DEM_DEFAULT_CONFIDENCE;

    // A cell center is usable only if it has a height and is inside.
    const usable = (row: number, col: number): boolean => {
        const i = row * width + col;
        return heights[i] !== null && insideMask[i] === 1;
    };
    const h = (row: number, col: number): number => heights[row * width + col] as number;

    return {
        sampleAt(p: Vec2): SurfaceSample | null {
            // Fractional cell-center coordinates. Cell centers live at
            // integer (row, col); col grows east with p.x, row grows south
            // as p.y (north) decreases.
            const fc = (p.x - origin.e) / resolution - 0.5;
            const fr = (origin.n - p.y) / resolution - 0.5;

            // Surrounding centers: (r0..r0+1, c0..c0+1).
            const c0 = Math.floor(fc);
            const r0 = Math.floor(fr);
            // Need the full 2×2 block of centers in range.
            if (c0 < 0 || r0 < 0 || c0 + 1 >= width || r0 + 1 >= height) return null;
            if (
                !usable(r0, c0) ||
                !usable(r0, c0 + 1) ||
                !usable(r0 + 1, c0) ||
                !usable(r0 + 1, c0 + 1)
            ) {
                return null;
            }

            const tx = fc - c0; // 0..1 east weight
            const ty = fr - r0; // 0..1 south weight

            const h00 = h(r0, c0); // NW
            const h01 = h(r0, c0 + 1); // NE
            const h10 = h(r0 + 1, c0); // SW
            const h11 = h(r0 + 1, c0 + 1); // SE

            // Bilinear height.
            const top = h00 + (h01 - h00) * tx;
            const bot = h10 + (h11 - h10) * tx;
            const surfaceHeight = top + (bot - top) * ty;

            // Analytic derivative of the bilinear patch.
            // dh/de (east): difference across columns per meter.
            const dhde = ((h01 - h00) * (1 - ty) + (h11 - h10) * ty) / resolution;
            // dh/drow (southward): difference across rows per meter.
            const dhdrow = ((h10 - h00) * (1 - tx) + (h11 - h01) * tx) / resolution;
            // p.y = north grows as row shrinks, so dh/dn = −dh/drow.
            const dhdn = -dhdrow;

            // Vec2 {x east, y north} → gradX = dh/dx = dh/de, gradY = dh/dn.
            return {
                height: surfaceHeight,
                gradX: dhde,
                gradY: dhdn,
                confidence,
            };
        },
    };
}
