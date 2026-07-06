// Aim optimiser — the DECADE plan's Phase-B move: sweep candidate aim
// bearings, push the club's dispersion pattern through the course surfaces,
// price every sampled outcome with the expected-strokes baseline, and pick
// the aim with the lowest score. This is where geometry becomes a decision.
//
// Pure planar math in projected meters (EPSG:3006-style {x, y}); bearings
// compass degrees (0 = north, clockwise); wind per wind.ts (m/s, FROM).
// The caller pre-flattens all classified surface rings (fairway, green,
// bunkers, water, …) and passes them in — same purity contract as
// corridor.ts. Ring kinds are feature-type strings mapped via
// lieFromFeatureType(); no containing ring → 'rough' (decision D17).
//
// Model decisions this file implements (see docs/decisions-strategy-*.md):
//  - D13 σ semantics: ellipse semi-axes are sigmaScale·σ, default 2
//    (the drawn ellipse ≈ 95% containment).
//  - D14 deterministic sampling: Halton(2,3) → Box–Muller standard-normal
//    pairs. Same inputs → same EV, no flicker, Swift-fixture-comparable.
//  - D15 sweep default ≈ 1.5 lateral semi-axes each side, clamped 4°–15°;
//    score ties prefer the candidate nearest the target bearing.
//  - D16 risk: per candidate both mean (expectedStrokes) and CVaR₈₀
//    (tailStrokes); score = mean + riskAversion·(tail − mean),
//    riskAversion default 0 (pure EV).
//
// Compute cadence is the CALLER's contract (DECADE §4.5): run on
// shot-place / drag-release, never per drag frame.

import { type ClubSpec } from './club';
import { pointInRing, type FlatRing } from './corridor';
import { bearingToUnitVector, dispersionEllipse, type Vec2 } from './ellipse';
import { shotsToHoleOut } from './expected-strokes';
import { lieFromFeatureType, type Lie } from './lie';

export interface AimOptions {
    /** Shot origin, planar meters. */
    origin: Vec2;
    club: ClubSpec;
    /** Bearing of the naive target line (e.g. straight at the pin). */
    targetBearingDeg: number;
    /**
     * ALL classified surface rings for the hole (fairway, green, rough,
     * bunkers, water, outside …), pre-flattened by the caller. Nesting is
     * resolved smallest-area-wins (D17); points in no ring lie as 'rough'.
     */
    surfaces: readonly FlatRing[];
    /** Remaining distance for each outcome is measured to this point. */
    greenCenter: Vec2;
    /** Wind speed in m/s. Omit both wind fields for a no-wind shot. */
    windSpeedMps?: number;
    /** Direction the wind comes FROM, compass degrees. */
    windDirectionDeg?: number;
    /** Ground slope along the shot line (see ellipse.ts groundSlope). */
    groundSlope?: number;
    /** Half-sweep around the target bearing, degrees. Default per D15. */
    sweepDeg?: number;
    /** Number of candidate bearings across the sweep. Default 13. */
    candidates?: number;
    /** Dispersion samples per candidate. Default 128. */
    samples?: number;
    /** How many σ the ellipse SEMI-axes represent. Default 2 (D13). */
    sigmaScale?: number;
    /** 0..1 weight on the tail term (D16). Default 0 = pure expected value. */
    riskAversion?: number;
    /** Lie for sample points contained by no surface ring. Default 'rough'. */
    fallbackLie?: Lie;
}

export interface AimCandidate {
    bearingDeg: number;
    /** Mean strokes-to-hole-out over the dispersion samples. */
    expectedStrokes: number;
    /** CVaR₈₀ — mean of the worst 20% of samples (D16). ≥ expectedStrokes. */
    tailStrokes: number;
    /** expectedStrokes + riskAversion · (tailStrokes − expectedStrokes). */
    score: number;
    /** Fraction of samples per lie (sums to 1) — drives the pin lights. */
    breakdown: Partial<Record<Lie, number>>;
}

export interface AimResult {
    /** Bearing of the winning candidate (lowest score, ties → straightest). */
    bestBearingDeg: number;
    best: AimCandidate;
    /** Every candidate, ordered left-to-right across the sweep. */
    perCandidate: AimCandidate[];
    /** The winning candidate's lie breakdown (convenience alias). */
    breakdown: Partial<Record<Lie, number>>;
}

/** Default half-sweep per D15: ~1.5 lateral semi-axes, clamped 4°–15°. */
export function defaultSweepDeg(club: ClubSpec): number {
    const deg = (Math.atan2(0.75 * club.dispersionM, club.carryM) * 180) / Math.PI;
    return Math.min(15, Math.max(4, deg));
}

/**
 * Sweep candidate aims and pick the one whose dispersion pattern prices
 * lowest against the expected-strokes baseline. Deterministic: identical
 * inputs always return identical results (D14).
 */
export function optimizeAim(options: AimOptions): AimResult {
    const {
        origin, club, targetBearingDeg, surfaces, greenCenter,
        windSpeedMps, windDirectionDeg, groundSlope,
    } = options;
    const candidateCount = Math.max(1, options.candidates ?? 13);
    const sampleCount = Math.max(1, options.samples ?? 128);
    const sigmaScale = options.sigmaScale ?? 2;
    const riskAversion = options.riskAversion ?? 0;
    const fallbackLie = options.fallbackLie ?? 'rough';
    const sweepDeg = options.sweepDeg ?? defaultSweepDeg(club);

    const classified = surfaces
        .filter((ring) => ring.points.length >= 3)
        .map((ring) => classifiable(ring));
    // Smallest-area-first so the FIRST containing ring wins nesting (D17).
    classified.sort((a, b) => a.areaM2 - b.areaM2);

    const normals = standardNormalPairs(sampleCount);
    const tailCount = Math.max(1, Math.ceil(sampleCount * 0.2));

    const perCandidate: AimCandidate[] = [];
    let best: AimCandidate | undefined;
    let bestOffset = Infinity;

    for (let c = 0; c < candidateCount; c++) {
        const offsetDeg = candidateCount === 1
            ? 0
            : -sweepDeg + (2 * sweepDeg * c) / (candidateCount - 1);
        const bearingDeg = targetBearingDeg + offsetDeg;

        const ellipse = dispersionEllipse({
            origin, bearingDeg, club, windSpeedMps, windDirectionDeg, groundSlope,
            samples: 4, // polygon unused here; keep its construction trivial
        });
        const along = bearingToUnitVector(bearingDeg);
        const right: Vec2 = { x: along.y, y: -along.x };
        const sigmaLengthM = ellipse.semiLengthM / sigmaScale;
        const sigmaLateralM = ellipse.semiLateralM / sigmaScale;

        const strokes: number[] = new Array(sampleCount);
        const lieCounts: Partial<Record<Lie, number>> = {};
        let sum = 0;

        for (let s = 0; s < sampleCount; s++) {
            const [zAlong, zAcross] = normals[s];
            const u = zAlong * sigmaLengthM;
            const v = zAcross * sigmaLateralM;
            const pt: Vec2 = {
                x: ellipse.center.x + u * along.x + v * right.x,
                y: ellipse.center.y + u * along.y + v * right.y,
            };
            const lie = classifyLie(pt, classified, fallbackLie);
            const remainingM = Math.hypot(greenCenter.x - pt.x, greenCenter.y - pt.y);
            const value = shotsToHoleOut(remainingM, lie);
            strokes[s] = value;
            sum += value;
            lieCounts[lie] = (lieCounts[lie] ?? 0) + 1;
        }

        const expectedStrokes = sum / sampleCount;
        strokes.sort((a, b) => b - a);
        let tailSum = 0;
        for (let i = 0; i < tailCount; i++) tailSum += strokes[i];
        const tailStrokes = tailSum / tailCount;
        const score = expectedStrokes + riskAversion * (tailStrokes - expectedStrokes);

        const breakdown: Partial<Record<Lie, number>> = {};
        for (const key of Object.keys(lieCounts) as Lie[]) {
            breakdown[key] = lieCounts[key]! / sampleCount;
        }

        const candidate: AimCandidate = { bearingDeg, expectedStrokes, tailStrokes, score, breakdown };
        perCandidate.push(candidate);

        // Ties prefer the straighter aim (D15): don't aim off-line for free.
        const offsetAbs = Math.abs(offsetDeg);
        if (!best || candidate.score < best.score - 1e-12 ||
            (Math.abs(candidate.score - best.score) <= 1e-12 && offsetAbs < bestOffset)) {
            best = candidate;
            bestOffset = offsetAbs;
        }
    }

    return {
        bestBearingDeg: best!.bearingDeg,
        best: best!,
        perCandidate,
        breakdown: best!.breakdown,
    };
}

// ---------------------------------------------------------------------------
// Lie classification (D17): bbox pre-reject, then smallest containing ring.
// ---------------------------------------------------------------------------

interface ClassifiedRing {
    ring: FlatRing;
    lie: Lie;
    areaM2: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

function classifiable(ring: FlatRing): ClassifiedRing {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let twiceArea = 0;
    const pts = ring.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const p = pts[i];
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
        twiceArea += (pts[j].x + p.x) * (pts[j].y - p.y);
    }
    return {
        ring,
        lie: lieFromFeatureType(ring.kind),
        areaM2: Math.abs(twiceArea) / 2,
        minX, maxX, minY, maxY,
    };
}

/** Rings are pre-sorted smallest-area-first, so first hit = smallest. */
function classifyLie(p: Vec2, rings: readonly ClassifiedRing[], fallback: Lie): Lie {
    for (const r of rings) {
        if (p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY) continue;
        if (pointInRing(p, r.ring.points)) return r.lie;
    }
    return fallback;
}

// ---------------------------------------------------------------------------
// Deterministic standard-normal pairs (D14): Halton(2,3) → Box–Muller.
// ---------------------------------------------------------------------------

function halton(index: number, base: number): number {
    let f = 1;
    let r = 0;
    let i = index;
    while (i > 0) {
        f /= base;
        r += f * (i % base);
        i = Math.floor(i / base);
    }
    return r;
}

/**
 * `count` deterministic standard-normal (z1, z2) pairs. Halton indices
 * start at 1 so u1 is never 0 (log-safe). Low-discrepancy: 128 points
 * cover the distribution like thousands of pseudo-random ones.
 */
export function standardNormalPairs(count: number): ReadonlyArray<readonly [number, number]> {
    const out: (readonly [number, number])[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const u1 = halton(i + 1, 2);
        const u2 = halton(i + 1, 3);
        const r = Math.sqrt(-2 * Math.log(u1));
        out[i] = [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)] as const;
    }
    return out;
}
