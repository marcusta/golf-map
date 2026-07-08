// Green surface abstraction for the putting core
// (docs/feature-putting-green-reading.md §2.1, §4, §6).
//
// One physics core, three data tiers: the integrator (putt.ts) and the
// closed form (tour-read.ts) are written against this interface only, so
// a phone LiDAR corridor scan, the Lantmäteriet DEM slope grid, and a
// manual slope estimate are interchangeable inputs. Adapters:
//  - planeSurface (below)  — Tier 3 manual estimate; also the analytic
//    fixture for golden-putt tests.
//  - dem-surface.ts        — Tier 2, bilinear patch over a SampleGrid.
//  - LiDAR scan adapter    — Tier 1, iOS Phase E (not built yet).
//
// Units & conventions (match shared/strategy):
//  - Coordinates: projected meters, {x east, y north} (EPSG:3006 in
//    practice). Bearings compass degrees, 0 = north, clockwise.
//  - Heights: meters in any consistent datum (RH2000 in practice) — the
//    physics only uses differences and gradients.
//  - Gradients are dimensionless rise/run: gradX = dh/dx, gradY = dh/dy.
//    Slope fraction = |∇h|; slope percent = fraction × 100. Downhill unit
//    vector = −∇h / |∇h| (matches computeSlopeGrid's dirE/dirN).
//  - confidence: 0..1 — how confident the data tier is that the local
//    slope is within the read precision budget (~0.2–0.5% slope, doc §4).
//    Consumers gate/soften reads on it; they must never sharpen it.

import { bearingToUnitVector, type Vec2 } from '../ellipse';

export interface SurfaceSample {
    /** Surface height at the sampled point, meters. */
    height: number;
    /** dh/dx (east), rise/run fraction. */
    gradX: number;
    /** dh/dy (north), rise/run fraction. */
    gradY: number;
    /** 0..1 confidence in the local slope (see header). */
    confidence: number;
}

export interface GreenSurface {
    /**
     * Sample the surface at a projected point. Returns null outside the
     * data's coverage (off the scanned corridor / grid / green) — callers
     * must treat null as "no read here", not as flat.
     */
    sampleAt(p: Vec2): SurfaceSample | null;
}

/**
 * Tier-3 adapter: an infinite tilted plane from a human slope estimate
 * ("2% down-slope toward 240°"). Also the analytic ground truth for
 * golden-putt tests — every first-order formula in doc §3 is exact on it.
 *
 * `fallLineBearingDeg` is the DOWNHILL direction (where a ball released at
 * rest would roll), compass degrees.
 */
export function planeSurface(options: {
    slopePct: number;
    fallLineBearingDeg: number;
    /** Height at the origin, meters. Default 0. */
    originHeight?: number;
    /** Default 1 (tests). Real manual estimates should pass their own. */
    confidence?: number;
}): GreenSurface {
    const fraction = options.slopePct / 100;
    const downhill = bearingToUnitVector(options.fallLineBearingDeg);
    // ∇h points uphill: opposite the downhill unit vector, scaled by slope.
    const gradX = -downhill.x * fraction;
    const gradY = -downhill.y * fraction;
    const h0 = options.originHeight ?? 0;
    const confidence = options.confidence ?? 1;
    return {
        sampleAt(p: Vec2): SurfaceSample {
            return {
                height: h0 + gradX * p.x + gradY * p.y,
                gradX,
                gradY,
                confidence,
            };
        },
    };
}
