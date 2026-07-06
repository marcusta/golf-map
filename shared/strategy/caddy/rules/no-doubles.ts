// no-doubles — the "bogey is fine, doubles kill you" safety rule (the Tiger 5
// #1, feature-smart-caddy.md §5). It NEVER invents its own risk math: per
// decision D16 the aim optimiser already computes, for the recommended aim,
// both the mean (`expectedStrokes`) and the CVaR₈₀ tail (`tailStrokes` — the
// mean of the worst 20% of the dispersion samples). This rule reads that tail
// directly. When the tail runs a long way past the mean — i.e. the bad-miss
// outcome of the current aim is a lot more expensive than its average outcome
// — the aggressive line is carrying a blow-up you should not accept, so the
// rule emits a warning that VETOES the aggressive attack/aim advice (§4.4).
//
// The threshold is a stroke gap, not a probability: `tailStrokes − mean` is
// already in the units a player cares about (extra strokes the disaster tail
// costs). Above TAIL_GAP_WARN we speak up; the gap scales the priority so a
// truly ugly tail vetoes harder than a marginal one. Risk-weighted so a
// cautious player (high riskAversion) floats this above attack advice while a
// pure-EV player still sees it, quieter (evaluator's effectivePriority).
//
// Pure/self-gating like every rule; zero-dep, Swift-mirrorable. Conventions:
// meters, planar {x, y}, compass bearings. Reads only ctx.aim — no geometry.

import { type AimResult } from '../../aim';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

/**
 * Ids of the aggressive-line advice this rule demotes when the tail is ugly.
 * A veto against a rule that did not fire is a harmless no-op (the evaluator
 * only demotes advice that was actually emitted), so listing all of them is
 * safe.
 */
export const NO_DOUBLES_VETOES: readonly string[] = ['par5-attack', 'specific-target'];

/**
 * Tail gap (strokes) above which the disaster miss is worth a warning. The gap
 * is `tailStrokes − expectedStrokes`: how much more than the mean the worst
 * 20% of shots cost. ~0.5 strokes is a meaningful blow-up share (a double
 * looming on a fifth of your patterns). Named for calibration.
 */
export const TAIL_GAP_WARN = 0.5;

/**
 * Tail gap at which the concern is at full strength (priority saturates).
 * Between TAIL_GAP_WARN and here the priority ramps; a ~1.5-stroke gap is a
 * genuine card-wrecker.
 */
export const TAIL_GAP_SEVERE = 1.5;

/** The recommended aim's tail gap (tail − mean), or null when unavailable. */
function tailGap(aim: AimResult): number | null {
    const best = aim.best;
    if (best === undefined) return null;
    const gap = best.tailStrokes - best.expectedStrokes;
    return Number.isFinite(gap) ? gap : null;
}

export const noDoublesRule: CaddyRule = {
    id: 'no-doubles',

    // Cheap gate (§4.1): needs a full-shot aim result to read the tail from.
    // Any non-recovery leg with an AimResult qualifies — recovery is the
    // take-your-medicine rule's territory, and its "shot" is a punch-out, not
    // a full swing whose dispersion tail this rule reasons about.
    appliesTo(ctx: CaddyContext): boolean {
        return ctx.leg !== 'recovery' && ctx.aim !== undefined;
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const gap = tailGap(ctx.aim!);
        if (gap === null || gap < TAIL_GAP_WARN) return [];

        // Ramp priority from ~2 (marginal) to ~4 (severe) across the gap band.
        const t = Math.min(1, (gap - TAIL_GAP_WARN) / (TAIL_GAP_SEVERE - TAIL_GAP_WARN));
        const priority = 2 + 2 * t;
        // Confidence grows with the gap too: a barely-over-threshold tail is a
        // soft suggestion, a huge one is near-certain. Kept in [0.6, 0.95].
        const confidence = 0.6 + 0.35 * t;

        return [
            {
                ruleId: 'no-doubles',
                kind: 'warning',
                priority,
                confidence,
                riskWeighted: true,
                vetoes: NO_DOUBLES_VETOES,
                headline: 'Protect against the big number — take the safe line.',
                detail:
                    `The aggressive aim's bad-miss tail costs about ${gap.toFixed(1)} strokes more `
                    + 'than its average — a bogey here is fine, a double is not. Favour the fat, '
                    + 'trouble-free side.',
            },
        ];
    },
};
