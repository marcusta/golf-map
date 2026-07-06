// short-side-guard — "never short-side yourself" (the Tiger 5 #3,
// feature-smart-caddy.md §5). On an approach whose dispersion pattern spills a
// meaningful share into trouble (sand / water / recovery — the lies that leave
// a hard up-and-down), firing straight at the pin risks the short-side miss:
// the ball ends in the bunker on the tight side with the pin cut right behind
// it. The fix is not "don't attack" in the abstract — it is aim at the FAT
// side of the pin, where the same miss lands in the middle of the green.
//
// It reads the recommended aim's lie breakdown (`aim.breakdown` — the fraction
// of dispersion samples per lie, decision D16 / DECADE Phase B), NOT new
// geometry: the trouble share IS the short-side risk proxy. The plan model
// carries the green centre, not pin-relative geometry, so "fat side" is
// expressed as advice + anchored at the green centre (the safe aim), which is
// the honest thing this context supports. When the trouble share is high it
// VETOES the aggressive attack/aim advice (§4.4) so the caddy surfaces "aim
// safe" over "fire at it".
//
// Pure/self-gating; zero-dep, Swift-mirrorable. Conventions: meters, planar
// {x, y}, compass bearings. Requires ctx.aim; consults ctx.hazards only to
// gate on there actually BEING trouble near this green.

import { type AimResult } from '../../aim';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

/** Ids of the aggressive-line advice this rule demotes on a short-side risk. */
export const SHORT_SIDE_VETOES: readonly string[] = ['par5-attack', 'specific-target'];

/**
 * Trouble share (sand + water/penalty + recovery fraction of the dispersion
 * pattern) above which the short-side risk is real enough to speak up. Below
 * this a stray sample or two into a greenside bunker is just noise. ~8% is a
 * roughly one-in-twelve miss into a hard lie — enough to change where you aim.
 */
export const SHORT_SIDE_TROUBLE_SHARE = 0.08;

/**
 * Trouble share at which the concern saturates (priority + confidence max
 * out). A quarter of the pattern in trouble is a clear "aim to the fat side".
 */
export const SHORT_SIDE_TROUBLE_SEVERE = 0.25;

/** Combined trouble share of an aim's lie breakdown (sand+penalty+recovery). */
function troubleShare(aim: AimResult): number {
    const b = aim.breakdown;
    return (b.sand ?? 0) + (b.penalty ?? 0) + (b.recovery ?? 0);
}

export const shortSideGuardRule: CaddyRule = {
    id: 'short-side-guard',

    // Cheap gate (§4.1): approaches only, needs an aim result, and there must
    // be at least one hazard on the hole for a short-side to exist at all.
    appliesTo(ctx: CaddyContext): boolean {
        return ctx.leg === 'approach' && ctx.aim !== undefined && ctx.hazards.length > 0;
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const share = troubleShare(ctx.aim!);
        if (share < SHORT_SIDE_TROUBLE_SHARE) return [];

        const t = Math.min(
            1,
            (share - SHORT_SIDE_TROUBLE_SHARE) / (SHORT_SIDE_TROUBLE_SEVERE - SHORT_SIDE_TROUBLE_SHARE),
        );
        const priority = 2.5 + 1.5 * t; // ramps 2.5 → 4
        const confidence = 0.6 + 0.3 * t; // ramps 0.6 → 0.9
        const pct = Math.round(share * 100);

        return [
            {
                ruleId: 'short-side-guard',
                kind: 'aim',
                priority,
                confidence,
                riskWeighted: true,
                vetoes: SHORT_SIDE_VETOES,
                anchor: ctx.target.center,
                headline: 'Aim to the fat side of the pin — don’t short-side yourself.',
                detail:
                    `About ${pct}% of this shot's pattern finds sand, water, or a recovery lie around `
                    + 'the green. Favour the side with the most green to work with, so the same miss '
                    + 'still leaves a straightforward up-and-down.',
            },
        ];
    },
};
