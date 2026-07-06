// take-your-medicine — "when you're in jail, punch out" (the Tiger 5 #4,
// feature-smart-caddy.md §5). On a RECOVERY leg (trees / deep rough / a
// stymied lie — decision D1 maps deep_rough → recovery) the score-minimising
// play is almost never the hero shot that tries to advance the ball to the
// green; it is the sideways/short punch that gets the ball back onto short
// grass and turns the next shot into an ordinary one.
//
// The rule quantifies that with the expected-strokes table (no new math): it
// compares two return-to-play outcomes for a chosen escape distance —
//   • MEDICINE: advance the escape distance but land in the FAIRWAY (back in
//     play), then price the remaining shot from fairway; and
//   • HERO: try to advance much further while STILL in a recovery lie (the
//     ball rarely gets clean out of jail), priced from recovery.
// Both are `shotsToHoleOut` lookups over the remaining distance to the green;
// the recovery baseline being flat-and-expensive (D18) is exactly why the
// medicine line wins. When it does, the rule recommends the escape and vetoes
// any attack advice (§4.4).
//
// Pure/self-gating; zero-dep, Swift-mirrorable. Conventions: meters, planar
// {x, y}, compass bearings. Reads ctx.origin/target/clubs; no ring geometry.

import { shotsToHoleOut } from '../../expected-strokes';
import { maxCarryM, type ClubSpec } from '../../club';
import { type Vec2 } from '../../ellipse';
import { windEffect } from '../../wind';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

/** Ids of the aggressive-line advice this rule demotes from a recovery lie. */
export const MEDICINE_VETOES: readonly string[] = ['par5-attack', 'specific-target'];

/**
 * Fraction of the escape club's carry we assume a clean punch-out actually
 * advances the ball (a stymied swing loses distance). Kept modest so the
 * "medicine" outcome is honest about how far a jail escape really goes.
 */
export const ESCAPE_ADVANCE_FRACTION = 0.6;

/**
 * The extra distance a HERO recovery attempt tries to advance over the safe
 * escape — the ball rarely gets clean, so this outcome is priced as STILL in a
 * recovery lie at the closer remaining distance. Named for calibration.
 */
export const HERO_EXTRA_ADVANCE_M = 60;

/** Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters. */
function bearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

function distanceM(a: Vec2, b: Vec2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function clubName(club: ClubSpec): string {
    return club.name ?? `${club.carryM.toFixed(0)} m club`;
}

/** The shortest-carrying club in the bag — the natural punch-out escape. */
function escapeClub(clubs: readonly ClubSpec[]): ClubSpec | undefined {
    let best: ClubSpec | undefined;
    for (const club of clubs) {
        if (!best || club.carryM < best.carryM) best = club;
    }
    return best;
}

export const takeYourMedicineRule: CaddyRule = {
    id: 'take-your-medicine',

    // Cheap gate (§4.1): recovery legs only, and we need a club to escape with.
    appliesTo(ctx: CaddyContext): boolean {
        return ctx.leg === 'recovery' && ctx.clubs.length > 0;
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const origin: Vec2 = { x: ctx.origin.x, y: ctx.origin.y };
        const center = ctx.target.center;
        const remainingM = distanceM(origin, center);
        if (remainingM <= 0) return [];

        const escape = escapeClub(ctx.clubs);
        if (!escape) return [];

        const bearing = bearingDeg(origin, center);
        const effect = ctx.wind ? windEffect(ctx.wind.speedMps, ctx.wind.directionDeg, bearing) : 0;

        // MEDICINE: a controlled punch-out lands back in the fairway, having
        // advanced a modest fraction of the escape club's carry. Remaining is
        // then priced from the fairway (back in play).
        const escapeAdvanceM = Math.min(
            remainingM,
            maxCarryM(escape.carryM, effect) * ESCAPE_ADVANCE_FRACTION,
        );
        const medicineRemainingM = Math.max(0, remainingM - escapeAdvanceM);
        const medicineEv = 1 + shotsToHoleOut(medicineRemainingM, 'fairway');

        // HERO: try to advance much further but stay stuck in a recovery lie
        // (the ball seldom escapes clean). Priced from recovery at the closer
        // remaining distance — the flat, expensive recovery baseline (D18) is
        // what makes this lose.
        const heroAdvanceM = Math.min(remainingM, escapeAdvanceM + HERO_EXTRA_ADVANCE_M);
        const heroRemainingM = Math.max(0, remainingM - heroAdvanceM);
        const heroEv = 1 + shotsToHoleOut(heroRemainingM, 'recovery');

        // Only advise the medicine when it actually prices better than forcing
        // it — if the hero line somehow wins (rare), stay quiet rather than
        // preach.
        if (medicineEv >= heroEv) return [];

        const gap = heroEv - medicineEv;
        // Confidence scales with how much the punch-out saves, in [0.6, 0.9].
        const confidence = Math.max(0.6, Math.min(0.9, 0.6 + gap));
        const anchor: Vec2 = {
            x: origin.x + Math.sin((bearing * Math.PI) / 180) * escapeAdvanceM,
            y: origin.y + Math.cos((bearing * Math.PI) / 180) * escapeAdvanceM,
        };

        return [
            {
                ruleId: 'take-your-medicine',
                kind: 'layup',
                priority: 4,
                confidence,
                vetoes: MEDICINE_VETOES,
                anchor,
                headline: `Take your medicine — punch out with the ${clubName(escape)} and get back in play.`,
                detail:
                    `Escaping to the fairway (~${medicineRemainingM.toFixed(0)} m left) prices at `
                    + `${medicineEv.toFixed(2)} strokes; forcing it and staying stuck prices at `
                    + `${heroEv.toFixed(2)}. Give yourself a clean next shot.`,
            },
        ];
    },
};
