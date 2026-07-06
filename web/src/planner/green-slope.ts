// GreenSlopeSummary adapter — the web SEAM between the analysis slope engine
// and the pure green-slope caddy rule (feature-smart-caddy.md §4.6, decision
// D10). computeSlopeGrid produces a per-cell slope% + downhill vector over the
// green's sampled DEM; the pure rule wants only a compact summary (a dominant
// fall-line bearing + magnitude, plus a front-half / back-half split so it can
// say WHICH half to favour). This module derives that summary. The rule NEVER
// imports analysis-math.ts — the platform runs this adapter and passes the
// summary in via CaddyContext.greenSlope.
//
// iOS mirrors this same reduction (§4.6). Coordinates here are EPSG:3006
// {e, n}; the resulting bearing is compass degrees (0 = north, clockwise) so
// it lines up with shared/strategy's convention, which the rule assumes.

import type { SampleGrid } from '../../../shared/api/analysis.gen';
import type { GreenSlopeSummary } from '../../../shared/strategy';
import { computeSlopeGrid, type SlopeGrid } from '../analysis/analysis-math';

/** A reference point on the green, EPSG:3006 easting/northing. */
export interface GreenRefPoint {
    e: number;
    n: number;
}

/**
 * Derive the D10 GreenSlopeSummary from a sampled green grid and the green's
 * front/back reference points.
 *
 * Dominant fall line: the slope-magnitude-weighted sum of every inside-green
 * cell's downhill unit vector. Weighting by magnitude lets a few steep cells
 * dominate a mostly-flat green (the tilt a player actually feels), and lets
 * opposing slopes on a saddle cancel toward "no dominant fall line" (low
 * magnitude → the rule won't fire). `fallLinePct` is the magnitude of that
 * mean vector — a green whose slopes all agree keeps its full steepness; a
 * green pulling different ways reports a smaller net tilt.
 *
 * Front/back split: cells are projected onto the front→back axis and split at
 * the midpoint; each half reports its mean slope%. This is the "which half"
 * signal (unused by the v1 rule's fire decision but part of the D10 contract
 * and surfaced in the panel).
 *
 * Returns null when the green has no usable slope cells (all nodata / dead
 * flat) — the caller then omits `greenSlope` and the rule simply won't fire.
 */
export function summarizeGreenSlope(
    grid: SampleGrid,
    front: GreenRefPoint,
    back: GreenRefPoint,
    slope: SlopeGrid = computeSlopeGrid(grid),
): GreenSlopeSummary | null {
    const { width, height, resolution, origin, insideMask } = grid;

    // Front→back axis, for the half split. Unit vector; degenerate if front
    // and back coincide (then everything lands in one half — harmless).
    const axE = back.e - front.e;
    const axN = back.n - front.n;
    const axLen = Math.hypot(axE, axN) || 1;
    const uAxE = axE / axLen;
    const uAxN = axN / axLen;
    // Project the front point itself; the split plane is halfway to back.
    const frontProj = front.e * uAxE + front.n * uAxN;
    const midProj = frontProj + axLen / 2;

    let sumE = 0; // slope-weighted downhill vector
    let sumN = 0;
    let frontSum = 0, frontCount = 0;
    let backSum = 0, backCount = 0;
    let anyInside = false;

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const i = row * width + col;
            if (!insideMask[i]) continue;
            const pct = slope.slopePct[i];
            if (Number.isNaN(pct)) continue;
            anyInside = true;

            // Cell centre, EPSG:3006 (row 0 = north; analysis-math convention).
            const e = origin.e + (col + 0.5) * resolution;
            const n = origin.n - (row + 0.5) * resolution;

            // Slope-magnitude-weighted downhill direction (dirE/dirN are unit).
            sumE += slope.dirE[i] * pct;
            sumN += slope.dirN[i] * pct;

            const proj = e * uAxE + n * uAxN;
            if (proj <= midProj) {
                frontSum += pct;
                frontCount++;
            } else {
                backSum += pct;
                backCount++;
            }
        }
    }

    if (!anyInside) return null;

    const fallLinePct = Math.hypot(sumE, sumN) / countInside(insideMask, slope);
    // Compass bearing of the mean downhill vector: atan2(east, north).
    let fallLineBearingDeg = (Math.atan2(sumE, sumN) * 180) / Math.PI;
    fallLineBearingDeg = (fallLineBearingDeg + 360) % 360;

    return {
        fallLineBearingDeg,
        fallLinePct,
        frontHalfPct: frontCount > 0 ? frontSum / frontCount : 0,
        backHalfPct: backCount > 0 ? backSum / backCount : 0,
    };
}

/** Count of inside-green cells with a defined slope (the mean-vector divisor). */
function countInside(insideMask: number[], slope: SlopeGrid): number {
    let n = 0;
    for (let i = 0; i < insideMask.length; i++) {
        if (insideMask[i] && !Number.isNaN(slope.slopePct[i])) n++;
    }
    return n;
}
