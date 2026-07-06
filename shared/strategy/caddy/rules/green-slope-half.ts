// green-slope-half — the marquee caddy rule (feature-smart-caddy.md §5, the
// "Tiger 5" #3/#5 territory verbalised). On an approach to a green that falls
// back-to-front steeply enough, and where the front approach is clean, it
// tells the player to favour the SHORT half: a short miss feeds back toward
// the pin, a long miss leaves a slippery downhiller. This is the rule that
// ships on data that exists today — it needs only a GreenSlopeSummary (the
// web adapter over computeSlopeGrid) and the hole's hazard rings; no DECADE
// phase, no EV engine.
//
// Pure and self-gating like every rule (§4.1). It NEVER touches
// analysis-math.ts: the platform derives the compact GreenSlopeSummary and
// hands it in via the context (§4.6). "Front approach clean" is decision D9:
// reuse hazardsAlongLine on the origin → green-front line and flag unclean if
// any hazard ring intersects the final FRONT_CLEAN_WINDOW_M before the front
// edge. All three thresholds below are named constants to calibrate.
//
// Conventions (mirrors the whole library): meters; planar {x, y} (+x east,
// +y north); compass bearings (0 = north, clockwise). Swift-mirrorable.

import { hazardsAlongLine } from '../../carry';
import { type Vec2 } from '../../ellipse';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

/**
 * Minimum dominant fall-line magnitude (%) for the rule to fire. Below this a
 * back-to-front tilt is not decisive enough to change where you aim — the
 * short-half advice would be noise. ~3% is the low end of a green a player
 * visibly reads as "running away" (the slope ramp turns green→orange at 3%,
 * analysis-math.ts). Named for calibration (caddy §9 / §8 "front-clean
 * heuristic to calibrate").
 */
export const MIN_FALL_LINE_PCT = 3;

/**
 * How closely the fall line must point back toward the player for the green
 * to count as "back-to-front for THIS shot". We compare the fall-line bearing
 * to the reverse shot bearing (green-front → origin); within this many degrees
 * counts as aligned. 45° is a generous quarter-compass cone: the fall line may
 * be diagonal and still make the short half the safe half, but a cross-slope
 * (≈90° off) or a front-to-back green (≈180° off) correctly does NOT fire.
 */
export const FALL_LINE_ALIGN_TOLERANCE_DEG = 45;

/**
 * Decision D9: the final window before the front edge that must be
 * hazard-free for the short-miss advice to be safe. If a bunker or water sits
 * in the last 30 m of the approach, "a short miss is fine" is wrong — a short
 * miss is in the sand. Named constant, calibratable.
 */
export const FRONT_CLEAN_WINDOW_M = 30;

/** Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters. */
function bearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

/** Smallest absolute angle between two compass bearings, 0..180°. */
function angleBetween(aDeg: number, bDeg: number): number {
    const d = Math.abs(((aDeg - bDeg) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
}

/**
 * Is the approach to the green front clean (decision D9)? Cast the shot line
 * origin → green-front and look for any hazard ring whose near edge lies
 * within the final FRONT_CLEAN_WINDOW_M before the front, capped at the front
 * distance so we never count a ring BEHIND the green. A ring the origin sits
 * inside (frontM 0) counts as unclean if the front itself is within the
 * window — you are already in trouble short.
 */
function frontApproachClean(ctx: CaddyContext): boolean {
    const origin = { x: ctx.origin.x, y: ctx.origin.y };
    const front = ctx.target.front;
    const frontDistM = Math.hypot(front.x - origin.x, front.y - origin.y);
    if (frontDistM <= 0) return true; // degenerate — already at the front
    const toFrontDeg = bearingDeg(origin, front);
    const windowStart = frontDistM - FRONT_CLEAN_WINDOW_M;

    const hits = hazardsAlongLine(origin, toFrontDeg, ctx.hazards, frontDistM);
    for (const hit of hits) {
        // A hazard is "in the front window" if its near edge is inside the
        // last 30 m stretch (frontM ≥ windowStart) up to the front edge.
        if (hit.frontM >= windowStart) return false;
    }
    return true;
}

export const greenSlopeHalfRule: CaddyRule = {
    id: 'green-slope-half',

    // Cheap gate (§4.1): only approaches, only when the slope summary is
    // present. Everything expensive (geometry, hazard casting) is deferred to
    // evaluate.
    appliesTo(ctx: CaddyContext): boolean {
        return ctx.leg === 'approach' && ctx.greenSlope !== undefined;
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const slope = ctx.greenSlope!;

        // 1. Steep enough to matter.
        if (slope.fallLinePct < MIN_FALL_LINE_PCT) return [];

        // 2. Fall line points back toward the player (back-to-front for THIS
        //    shot). The reverse shot bearing is green-front → origin; a
        //    back-to-front green's downhill fall line runs the same way.
        const reverseBearingDeg = bearingDeg(ctx.target.front, {
            x: ctx.origin.x,
            y: ctx.origin.y,
        });
        if (angleBetween(slope.fallLineBearingDeg, reverseBearingDeg) > FALL_LINE_ALIGN_TOLERANCE_DEG) {
            return [];
        }

        // 3. The front approach must be clean (D9) — else a short miss is in a
        //    hazard, not safe.
        if (!frontApproachClean(ctx)) return [];

        // Confidence scales with how steep and how well-aligned the fall line
        // is: a dead-on 6% green is a high-confidence "favour short"; a
        // just-over-threshold, 40°-off green is weaker. Kept in [0.5, 1].
        const steepBonus = Math.min(1, (slope.fallLinePct - MIN_FALL_LINE_PCT) / MIN_FALL_LINE_PCT);
        const alignBonus =
            1 - angleBetween(slope.fallLineBearingDeg, reverseBearingDeg) / FALL_LINE_ALIGN_TOLERANCE_DEG;
        const confidence = 0.5 + 0.5 * Math.min(steepBonus, alignBonus);

        return [
            {
                ruleId: 'green-slope-half',
                kind: 'target-half',
                priority: 3,
                confidence,
                headline: 'Favour the short half — the green runs away from you.',
                detail:
                    `The green falls about ${slope.fallLinePct.toFixed(0)}% back-to-front, so a short `
                    + 'miss feeds toward the pin while anything long leaves a slippery downhiller — '
                    + 'aim for the front half of the green.',
                anchor: ctx.target.front,
            },
        ];
    },
};
