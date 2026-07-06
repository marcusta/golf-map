// specific-target — "commit to a specific target and the club to match it"
// (the Tiger 5 #5, feature-smart-caddy.md §5). On any approach it turns the
// aim optimiser's continuous output into the single sentence a caddy says: aim
// HERE, hit THIS club. It reads the recommended aim bearing
// (`aim.bestBearingDeg`, DECADE Phase B) and the plays-like distance to the
// green, then names the front/centre/back club fit via `clubAdvice`
// (club.ts) — the same front/centre/back the yardage panel shows, verbalised.
//
// This is the AGGRESSIVE-line advice in the catalogue: it commits to a target
// and a number. The safety rules (no-doubles, short-side-guard,
// take-your-medicine) carry vetoes against THIS rule's id, so when the tail is
// ugly or the short-side is in play the evaluator demotes this "fire at it"
// advice below the "aim safe" advice (§4.4) — the player still sees the
// committed line was considered, but the caution wins.
//
// Pure/self-gating; zero-dep, Swift-mirrorable. Conventions: meters, planar
// {x, y}, compass bearings. Requires ctx.aim; consults ctx.clubs for the fit.

import { type AimResult } from '../../aim';
import { clubAdvice, type ClubSpec } from '../../club';
import { bearingToUnitVector, type Vec2 } from '../../ellipse';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

function distanceM(a: Vec2, b: Vec2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function clubName(club: ClubSpec): string {
    return club.name ?? `${club.carryM.toFixed(0)} m club`;
}

/** How confident we are the recommended aim is worth committing to: the
 * cleaner the pattern holds the green, the surer the target. Reads the aim's
 * green-hit share; kept in [0.5, 0.9]. */
function confidenceFor(aim: AimResult): number {
    const held = aim.breakdown.green ?? 0;
    return 0.5 + 0.4 * Math.min(1, held);
}

export const specificTargetRule: CaddyRule = {
    id: 'specific-target',

    // Cheap gate (§4.1): approaches only, needs an aim result to name a target.
    appliesTo(ctx: CaddyContext): boolean {
        return ctx.leg === 'approach' && ctx.aim !== undefined;
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const aim = ctx.aim!;
        const origin: Vec2 = { x: ctx.origin.x, y: ctx.origin.y };
        const distToGreenM = distanceM(origin, ctx.target.center);

        // The committed landing point: project the recommended bearing forward
        // by the distance to the green centre (the target the aim was scored
        // against). This is the ghost-aim marker the overlay draws.
        const unit = bearingToUnitVector(aim.bestBearingDeg);
        const anchor: Vec2 = {
            x: origin.x + unit.x * distToGreenM,
            y: origin.y + unit.y * distToGreenM,
        };

        // Club fit for the number — front (shortest that reaches), centre
        // (nearest carry), back (longest that stays short). Speak the centre
        // club; note the front/back when the bag brackets the number.
        const fit = ctx.clubs.length > 0 ? clubAdvice(ctx.clubs, distToGreenM) : undefined;
        const centre = fit?.center;

        const headline = centre
            ? `Commit to a target — aim your ${clubName(centre)} at the recommended line.`
            : 'Commit to a target — aim at the recommended line and swing freely.';

        let detail = `The aim optimiser likes a ${aim.bestBearingDeg.toFixed(0)}° line to about `
            + `${distToGreenM.toFixed(0)} m.`;
        if (centre) {
            detail += ` The ${clubName(centre)} is the number`;
            if (fit?.front && fit?.back && fit.front !== fit.back) {
                detail += ` (${clubName(fit.back)} back, ${clubName(fit.front)} front)`;
            }
            detail += '. Pick the target, then swing.';
        }

        return [
            {
                ruleId: 'specific-target',
                kind: 'aim',
                priority: 2,
                confidence: confidenceFor(aim),
                anchor,
                headline,
                detail,
            },
        ];
    },
};
