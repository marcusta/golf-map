// Strokes-gained computation over a recorded round (shot-capture doc §5,
// verbatim formula). Pure fold over one hole's ordered stroke list — no I/O,
// no lat/lon, no feature-store access (same purity boundary as every other
// shared/strategy module: the CALLER projects positions to planar meters and
// classifies each stroke's lie; this file only does the arithmetic).
//
// Recording convention (shot-capture doc §2): a shot row is one stroke,
// recorded at the position it was played FROM. Stroke i's landing position
// is stroke i+1's position; the last stroke's "landing" is the hole itself
// (shotsToHoleOut(0, ·) = 0, decision D20). Penalties are not rows — stroke i
// carries penaltyStrokes >= 0 (added strokes from OB/water/unplayable at
// that stroke), per §2/§5.
//
// Formula (§5, exact):
//   d_i   = distance(p_i -> hole)
//   sg_i  = shotsToHoleOut(d_i, lie_i) - shotsToHoleOut(d_{i+1}, lie_{i+1})
//           - 1 - penaltyStrokes_i
// with shotsToHoleOut(0, ·) = 0 standing in for "holed" on the last stroke.
//
// Categories (§5, exact): off-tee (stroke 0, par 4/5), approach (full/partial,
// d_i >= 30 m), short (< 30 m, not a putt), putting. See categorize() below
// for the (documented) fallthrough this brief's edge case forced: a par-3
// tee shot is stroke 0 but NOT off-tee (that category is explicitly scoped
// to par 4/5 in the doc) — it falls through to approach/short by distance,
// same as any other full/partial swing.

import { shotsToHoleOut } from './expected-strokes';
import type { Lie } from './lie';

/** The shot-type taxonomy from the shot-capture schema (§3). */
export type RecordedShotType = 'full' | 'partial' | 'putt' | 'recovery';

/**
 * One recorded stroke, already reduced to the OWNED shape this module
 * consumes: position in projected meters (same {x,y} convention as the rest
 * of shared/strategy), a classified lie, and the capture-time metadata SG
 * needs. Callers build this from `Shot` rows (project lat/lon, classify lie
 * via `classifyLie`/`lieFromFeatureType` or the recorded `lie` override).
 */
export interface RecordedStroke {
    /** Position this stroke was played FROM, projected meters. */
    position: { x: number; y: number };
    /** Lie the stroke was played from. First stroke of a hole is 'tee'. */
    lie: Lie;
    /** Strokes added as a consequence of THIS stroke (OB/water/unplayable). */
    penaltyStrokes: number;
    /** Capture-time shot type; gates the short/approach split (not fitting — that's §6). */
    shotType: RecordedShotType;
}

/** Distance band for the headline analytics view (§5's "the headline view"). */
export type DistanceBand =
    | '0-30m'
    | '30-100m'
    | '100-150m'
    | '150-200m'
    | '200m+';

/** SG category taxonomy (§5, exact wording). */
export type SgCategory = 'off-tee' | 'approach' | 'short' | 'putting';

/** Per-shot SG result, one entry per recorded stroke on the hole. */
export interface ShotSg {
    /** Index into the input strokes array. */
    index: number;
    /** distance(p_i -> hole), meters. */
    distanceM: number;
    lie: Lie;
    category: SgCategory;
    /** Only defined for non-putting categories with distanceM available (always, here). */
    distanceBand: DistanceBand;
    /** shotsToHoleOut(d_i, lie_i) - shotsToHoleOut(d_{i+1}, lie_{i+1}) - 1 - penaltyStrokes_i. */
    strokesGained: number;
}

/** One hole's ordered strokes plus the hole (pin/green-centre) position. */
export interface HoleRound {
    /** Par, used only to decide the off-tee category (stroke 0, par 4/5). */
    par: number;
    /** Ordered strokes, stroke 0 first, last stroke holes out. */
    strokes: readonly RecordedStroke[];
    /** Hole position (pin, or green centre if no pin recorded), projected meters. */
    hole: { x: number; y: number };
}

/** A bucket of SG values with count + total + mean, used for every aggregate. */
export interface SgBucket {
    count: number;
    totalStrokesGained: number;
    meanStrokesGained: number;
}

function emptyBucket(): SgBucket {
    return { count: 0, totalStrokesGained: 0, meanStrokesGained: 0 };
}

function accumulate(bucket: SgBucket, sg: number): SgBucket {
    const count = bucket.count + 1;
    const totalStrokesGained = bucket.totalStrokesGained + sg;
    return { count, totalStrokesGained, meanStrokesGained: totalStrokesGained / count };
}

/** Distance-band boundaries (meters), the headline table's rows (§5). */
export function distanceBand(distanceM: number): DistanceBand {
    if (distanceM < 30) return '0-30m';
    if (distanceM < 100) return '30-100m';
    if (distanceM < 150) return '100-150m';
    if (distanceM < 200) return '150-200m';
    return '200m+';
}

/**
 * SG category for one stroke (§5, exact): off-tee is stroke 0 on a par 4/5;
 * putting is a recorded putt; short is any non-putt under 30 m; everything
 * else (including a par-3 tee shot — see file header) is approach.
 */
export function categorize(stroke: RecordedStroke, strokeIndex: number, par: number, distanceM: number): SgCategory {
    if (strokeIndex === 0 && par >= 4) return 'off-tee';
    if (stroke.shotType === 'putt') return 'putting';
    if (distanceM < 30) return 'short';
    return 'approach';
}

/**
 * Per-shot SG for one hole's ordered recorded strokes, per §5 EXACTLY. The
 * last stroke's "next" state is holed (shotsToHoleOut(0, ·) = 0, D20) —
 * modeled by treating the hole itself as a zero-distance, lie-irrelevant
 * landing spot (shotsToHoleOut ignores lie once distance is below
 * HOLED_DISTANCE_M, so the lie passed for that synthetic landing is unused).
 */
export function holeStrokesGained(round: HoleRound): ShotSg[] {
    const { strokes, hole, par } = round;
    const out: ShotSg[] = [];

    for (let i = 0; i < strokes.length; i++) {
        const stroke = strokes[i];
        const distanceM = Math.hypot(hole.x - stroke.position.x, hole.y - stroke.position.y);
        const next = strokes[i + 1];
        const nextDistanceM = next
            ? Math.hypot(hole.x - next.position.x, hole.y - next.position.y)
            : 0; // holed (D20: shotsToHoleOut(0, ·) = 0, lie irrelevant)
        const nextLie: Lie = next ? next.lie : stroke.lie; // unused when nextDistanceM is 0

        const sg = shotsToHoleOut(distanceM, stroke.lie)
            - shotsToHoleOut(nextDistanceM, nextLie)
            - 1
            - stroke.penaltyStrokes;

        out.push({
            index: i,
            distanceM,
            lie: stroke.lie,
            category: categorize(stroke, i, par, distanceM),
            distanceBand: distanceBand(distanceM),
            strokesGained: sg,
        });
    }

    return out;
}

/** Aggregate view over a round: one bucket total, one per category, one per distance band. */
export interface RoundSgSummary {
    total: SgBucket;
    byCategory: Record<SgCategory, SgBucket>;
    byDistanceBand: Record<DistanceBand, SgBucket>;
}

const SG_CATEGORIES: readonly SgCategory[] = ['off-tee', 'approach', 'short', 'putting'];
const DISTANCE_BANDS: readonly DistanceBand[] = ['0-30m', '30-100m', '100-150m', '150-200m', '200m+'];

function emptySummary(): RoundSgSummary {
    const byCategory = {} as Record<SgCategory, SgBucket>;
    for (const c of SG_CATEGORIES) byCategory[c] = emptyBucket();
    const byDistanceBand = {} as Record<DistanceBand, SgBucket>;
    for (const b of DISTANCE_BANDS) byDistanceBand[b] = emptyBucket();
    return { total: emptyBucket(), byCategory, byDistanceBand };
}

/**
 * Aggregate SG per round / per category / per distance band (§5: "Aggregate
 * per round / per category / per distance band"). Accepts one or many holes'
 * `holeStrokesGained` outputs (a round is many holes; the caller flat-maps).
 */
export function aggregateStrokesGained(shots: readonly ShotSg[]): RoundSgSummary {
    const summary = emptySummary();
    for (const shot of shots) {
        summary.total = accumulate(summary.total, shot.strokesGained);
        summary.byCategory[shot.category] = accumulate(summary.byCategory[shot.category], shot.strokesGained);
        summary.byDistanceBand[shot.distanceBand] = accumulate(summary.byDistanceBand[shot.distanceBand], shot.strokesGained);
    }
    return summary;
}

/** Convenience: per-hole SG for every hole in a round, then aggregated together. */
export function roundStrokesGained(holes: readonly HoleRound[]): { perHole: ShotSg[][]; summary: RoundSgSummary } {
    const perHole = holes.map(holeStrokesGained);
    const summary = aggregateStrokesGained(perHole.flat());
    return { perHole, summary };
}
