// Whole-hole Monte Carlo simulator (feature-hole-sim-and-variants.md,
// decisions V1/V3/V4) — turns one authored option branch into a SCORE
// DISTRIBUTION instead of a single EV. Same `ChainLeg[]`/`ChainScoreContext`
// input as scoreOptionChain, so every call site that can price a branch can
// simulate it.
//
// THE MODEL (V1 — hybrid rollout, never an autonomous golfer):
//   1. Sample the current leg's landing from the club's dispersion pattern
//      (same σ semantics as optimizeAim: ellipse semi-axes are sigmaScale·σ,
//      D13), aimed at the leg's recommendedBearingDeg when enriched, else the
//      authored origin→landing bearing.
//   2. Classify the landing lie (D23 topmost-first — first containing ring).
//   3. ON-SCRIPT (§V4): play the next authored leg FROM the sampled landing,
//      keeping the next leg's club and aiming at its authored TARGET point
//      (the target is the invariant; the bearing shifts with the miss).
//   4. OFF-SCRIPT or chain exhausted: draw strokes-to-hole-out from the
//      closeout pmf (§V2, score-distribution.ts) at the sample's
//      (distance-to-green, lie) and terminate the rollout.
//   5. PENALTY lie (D4): the closeout is the penalty pmf (1 + rough) at the
//      entry distance — no drop geometry in v1.
//   Rollout score = strokes played in-sim + closeout draw (all integers).
//
// RANDOMNESS (V3 — counter-based, NOT a nested Halton stream): a splitmix64
// hash of (seed, rolloutIndex, depth, drawIndex) → uniforms → Box–Muller
// standard normals. Indexing by (rollout, depth) de-correlates the tee miss
// from the approach miss (a shared Halton stream would bias the tails);
// shots stay independent across legs (D21). Fixed default seed ⇒ identical
// histogram for identical inputs, no ordering sensitivity, trivially portable
// to Swift. NO Date.now()/Math.random() anywhere.
//
// ON-SCRIPT RULE (§V4): a sample continues to the next authored leg iff ALL
// of — landing lie ∈ {fairway, rough} (green/sand/recovery/penalty
// terminate); the next leg exists and has a club; the sampled landing is
// within the club's wind-adjusted max carry + LAYUP_TARGET_TOLERANCE_M of the
// next target (can't reach ⇒ the plan is broken for this sample ⇒ the table
// absorbs it, the sim never invents a layup). Rough stays on script because
// playing the planned next shot from light rough is what players do and the
// lie penalty is already priced by the following landing distribution and
// closeout; sand/trees/water are where real re-planning happens — exactly
// what we refuse to model (§2.1).
//
// Conventions match the rest of shared/strategy: pure, zero-dep, projected
// meters, compass bearings (0 = north, cw), surfaces topmost-first (D23).
// Derived, never persisted (O4/V8).

import { maxCarryM, type ClubSpec } from './club';
import { pointInRing, type FlatRing } from './corridor';
import { bearingToUnitVector, dispersionEllipse, type Vec2 } from './ellipse';
import { lieFromFeatureType, type Lie } from './lie';
import type { ChainLeg, ChainScoreContext } from './option-chain';
import { LAYUP_TARGET_TOLERANCE_M } from './caddy/rules/par5-attack';
import { strokesDistribution } from './score-distribution';
import { windEffect } from './wind';

/** Fixed default seed for the counter-based RNG (V3). Any 32-bit value. */
export const DEFAULT_SIM_SEED = 0x5f3759df;

/** Default rollout count (§V1; tunable, determinism is not). */
export const DEFAULT_ROLLOUTS = 800;

export interface SimulateChainOptions {
    /** Rollouts per branch. Default DEFAULT_ROLLOUTS. */
    rollouts?: number;
    /** RNG seed (V3). Default DEFAULT_SIM_SEED. */
    seed?: number;
    /** How many σ the ellipse SEMI-axes represent (D13). Default 2. */
    sigmaScale?: number;
    /**
     * Cap on landing samples retained per leg for the scatter overlay. The
     * pmf/mean always use every rollout; only `perLegLandings` is subsampled.
     * Default: keep all.
     */
    maxLandingsPerLeg?: number;
}

export interface SimulateChainResult {
    /**
     * pmf over integer hole scores from the decision point. Index k =
     * P(branch holes out in exactly k strokes); dense from 0 to the max
     * observed score. Sums to 1 (empty chain ⇒ [1]).
     */
    pmf: ReadonlyArray<number>;
    /** Mean hole score = Σ k·pmf[k]. */
    mean: number;
    /**
     * Sampled landing points per authored leg (index = leg depth), for the
     * scatter overlay. Subsampled to `maxLandingsPerLeg` when set. A leg only
     * accrues landings for rollouts that actually played it.
     */
    perLegLandings: Vec2[][];
    /**
     * Fraction of rollouts that played EVERY authored leg on script (the plan
     * "survived" as drawn — §5). Rollouts that closed out early (bad lie, out
     * of reach, or landed on the green before the last leg) are off-script.
     */
    onScriptRate: number;
    /** Rollouts run (echoes the effective N). */
    rollouts: number;
}

// ── Counter-based RNG (V3): splitmix64 over (seed, rollout, depth, draw) ──────

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const MIX_A = 0xbf58476d1ce4e5b9n;
const MIX_B = 0x94d049bb133111ebn;

function splitmix64(x: bigint): bigint {
    let z = (x + GOLDEN) & MASK64;
    z = ((z ^ (z >> 30n)) * MIX_A) & MASK64;
    z = ((z ^ (z >> 27n)) * MIX_B) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
}

/** 64-bit hash of the four counters, folded via successive splitmix. */
function hashCounters(seed: number, rollout: number, depth: number, draw: number): bigint {
    let h = BigInt(seed >>> 0) & MASK64;
    h = splitmix64(h ^ (BigInt(rollout >>> 0) * GOLDEN & MASK64));
    h = splitmix64(h ^ (BigInt(depth >>> 0) * MIX_A & MASK64));
    h = splitmix64(h ^ (BigInt(draw >>> 0) * MIX_B & MASK64));
    return h;
}

/** Uniform in (0, 1) from a counter tuple (top 53 bits, shifted off 0). */
function uniform(seed: number, rollout: number, depth: number, draw: number): number {
    const bits = Number(hashCounters(seed, rollout, depth, draw) >> 11n);
    // (bits + 0.5) / 2^53 ∈ (0, 1) — never exactly 0 (log-safe) nor 1.
    return (bits + 0.5) / 9007199254740992;
}

/** A standard-normal (along, across) pair for the landing sample at a depth. */
function normalPair(seed: number, rollout: number, depth: number): readonly [number, number] {
    const u1 = uniform(seed, rollout, depth, 0);
    const u2 = uniform(seed, rollout, depth, 1);
    const r = Math.sqrt(-2 * Math.log(u1));
    return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

// ── Geometry helpers (mirror aim.ts / option-chain.ts) ───────────────────────

function bearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

function classifyLie(p: Vec2, surfaces: readonly FlatRing[], fallback: Lie): Lie {
    for (const ring of surfaces) {
        if (ring.points.length < 3) continue;
        if (pointInRing(p, ring.points)) return lieFromFeatureType(ring.kind);
    }
    return fallback;
}

/** Inverse-cdf draw of an integer stroke count from a pmf, given a uniform. */
function sampleFromPmf(pmf: ReadonlyArray<number>, u: number): number {
    let acc = 0;
    for (let k = 0; k < pmf.length; k++) {
        acc += pmf[k]!;
        if (u <= acc) return k;
    }
    return pmf.length - 1; // float slack: return the top support point
}

const ON_SCRIPT_LIES: ReadonlySet<Lie> = new Set<Lie>(['fairway', 'rough']);

/**
 * Simulate one authored option branch to a score distribution (§V1). `legs`
 * run root-first from the decision point (same shape as scoreOptionChain).
 * Pure and deterministic: identical inputs ⇒ identical result (V3).
 */
export function simulateChain(
    legs: readonly ChainLeg[],
    ctx: ChainScoreContext,
    opts: SimulateChainOptions = {},
): SimulateChainResult {
    const N = Math.max(1, opts.rollouts ?? DEFAULT_ROLLOUTS);
    const seed = (opts.seed ?? DEFAULT_SIM_SEED) >>> 0;
    const sigmaScale = opts.sigmaScale ?? 2;
    const fallbackLie = ctx.fallbackLie ?? 'rough';
    const maxLandings = opts.maxLandingsPerLeg ?? Infinity;
    const greenCenter = ctx.greenCenter;

    // Empty chain: nothing to play (mirrors scoreOptionChain's zero case).
    if (legs.length === 0) {
        return { pmf: [1], mean: 0, perLegLandings: [], onScriptRate: 1, rollouts: N };
    }

    const perLegLandings: Vec2[][] = legs.map(() => []);
    const scoreCounts = new Map<number, number>();
    let scoreSum = 0;
    let maxScore = 0;
    let onScriptCount = 0;

    for (let r = 0; r < N; r++) {
        let strokes = 0;
        let origin: Vec2 = legs[0]!.origin;
        let onScript = true;

        for (let depth = 0; depth < legs.length; depth++) {
            const leg = legs[depth]!;
            strokes += 1; // playing this leg

            // Aim: enriched recommended bearing on the FIRST leg (origin is the
            // authored one), else aim at the authored target from wherever we
            // actually stand (the target is the invariant, §V1 step 3).
            const aimBearing = depth === 0 && leg.recommendedBearingDeg !== undefined
                ? leg.recommendedBearingDeg
                : bearingDeg(origin, leg.landing);

            // Landing sample: reuse the ellipse for the wind/slope-adjusted
            // center and σ semi-axes (semi = full/2 = sigmaScale·σ, D13).
            const club = leg.club;
            let landing: Vec2;
            if (club) {
                const ellipse = dispersionEllipse({
                    origin,
                    bearingDeg: aimBearing,
                    club,
                    ...(ctx.wind !== undefined
                        ? { windSpeedMps: ctx.wind.speedMps, windDirectionDeg: ctx.wind.directionDeg }
                        : {}),
                    ...(leg.groundSlope !== undefined ? { groundSlope: leg.groundSlope } : {}),
                    samples: 4,
                });
                const along = bearingToUnitVector(aimBearing);
                const right: Vec2 = { x: along.y, y: -along.x };
                const [zAlong, zAcross] = normalPair(seed, r, depth);
                const u = zAlong * (ellipse.semiLengthM / sigmaScale);
                const v = zAcross * (ellipse.semiLateralM / sigmaScale);
                landing = {
                    x: ellipse.center.x + u * along.x + v * right.x,
                    y: ellipse.center.y + u * along.y + v * right.y,
                };
            } else {
                // Clubless leg: deterministic point estimate at the authored
                // landing (no dispersion — mirrors scoreOptionChain).
                landing = leg.landing;
            }

            if (perLegLandings[depth]!.length < maxLandings) {
                perLegLandings[depth]!.push(landing);
            }

            const lie = classifyLie(landing, ctx.surfaces, fallbackLie);
            const remainingM = Math.hypot(greenCenter.x - landing.x, greenCenter.y - landing.y);
            const nextLeg = legs[depth + 1];

            // On-script test (§V4).
            const canContinue = ON_SCRIPT_LIES.has(lie)
                && nextLeg !== undefined
                && !!nextLeg.club
                && reachable(landing, nextLeg, ctx);

            if (canContinue) {
                origin = landing;
                continue; // play the next authored leg from here
            }

            // Terminate: draw the closeout (V1 step 4/5). Green→putting row,
            // penalty→1+rough (D4), else the lie's own row.
            const closeoutLie: Lie = lie;
            const pmf = strokesDistribution(remainingM, closeoutLie);
            const u = uniform(seed, r, depth, 2);
            strokes += sampleFromPmf(pmf, u);
            // Off-script iff we terminated before playing every authored leg.
            if (depth < legs.length - 1) onScript = false;
            break;
        }

        if (onScript) onScriptCount += 1;
        scoreSum += strokes;
        if (strokes > maxScore) maxScore = strokes;
        scoreCounts.set(strokes, (scoreCounts.get(strokes) ?? 0) + 1);
    }

    const pmf = new Array<number>(maxScore + 1).fill(0);
    for (const [score, count] of scoreCounts) pmf[score] = count / N;

    return {
        pmf,
        mean: scoreSum / N,
        perLegLandings,
        onScriptRate: onScriptCount / N,
        rollouts: N,
    };
}

/**
 * Can the sampled landing reach the next leg's authored target within the
 * club's wind-adjusted max carry + LAYUP_TARGET_TOLERANCE_M (§V4)? The wind
 * effect is keyed on the aim toward the next target.
 */
function reachable(
    landing: Vec2,
    nextLeg: ChainLeg,
    ctx: ChainScoreContext,
): boolean {
    const club = nextLeg.club as ClubSpec;
    const targetBearing = bearingDeg(landing, nextLeg.landing);
    const effect = ctx.wind
        ? windEffect(ctx.wind.speedMps, ctx.wind.directionDeg, targetBearing, club.carryM)
        : 0;
    const reach = maxCarryM(club.carryM, effect) + LAYUP_TARGET_TOLERANCE_M;
    const distToTarget = Math.hypot(nextLeg.landing.x - landing.x, nextLeg.landing.y - landing.y);
    return distToTarget <= reach;
}
