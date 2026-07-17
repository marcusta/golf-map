// can-you-carry-it — "can't carry the bunker under a 6i — lay up / club up"
// (feature-smart-caddy.md §5). For any hazard the shot line crosses, compare
// where the intended club actually lands against the hazard's near/far edges
// (carry.ts `hazardsAlongLine` vs the club.ts carry band). When the club's
// landing window overlaps the hazard, the shot is flirting with it and the
// rule names the fix: CLUB UP to the shortest club whose short miss still
// clears the far edge, or LAY UP with the longest club whose long miss still
// stays short of the near edge.
//
// No new math: the landing window is the same ±5%-banded, wind-adjusted
// carry the distances feature uses (minCarryM/maxCarryM, forward application
// of windEffect on the club's own nominal carry), and the hazard interval is
// carry.ts geometry. The shot line is the recommended aim when an AimResult
// is present, else straight at the target centre.
//
// Pure/self-gating; zero-dep, Swift-mirrorable. Conventions: meters, planar
// {x, y}, compass bearings. Reads ctx.origin/target/clubs/hazards/wind/aim.

import { hazardsAlongLine, type CarryOverHazard } from '../../carry';
import { maxCarryM, minCarryM, type ClubSpec } from '../../club';
import { type Vec2 } from '../../ellipse';
import { lieFromFeatureType } from '../../lie';
import { windEffect } from '../../wind';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

/**
 * How far past the target a club-up club may land before "club up" stops
 * being the fix (a carrying club that flies 40 m over the green is not
 * advice). Within this the classic "take one more club over the front
 * bunker" holds; beyond it the rule recommends laying up instead.
 */
export const CLUB_UP_MAX_PAST_TARGET_M = 20;

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

/** The club nearest `distanceM` by nominal carry (earlier club wins ties). */
function closestClub(clubs: readonly ClubSpec[], distanceM: number): ClubSpec | undefined {
    let best: ClubSpec | undefined;
    let bestDiff = Infinity;
    for (const club of clubs) {
        const diff = Math.abs(club.carryM - distanceM);
        if (diff < bestDiff) {
            best = club;
            bestDiff = diff;
        }
    }
    return best;
}

export const canYouCarryItRule: CaddyRule = {
    id: 'can-you-carry-it',

    // Cheap gate (§4.1): needs a club to fly and a hazard to cross.
    appliesTo(ctx: CaddyContext): boolean {
        return ctx.clubs.length > 0 && ctx.hazards.length > 0;
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const origin: Vec2 = { x: ctx.origin.x, y: ctx.origin.y };
        const center = ctx.target.center;
        const remainingM = distanceM(origin, center);
        if (remainingM <= 0) return [];

        // The shot line: the recommended aim when priced, else straight at
        // the target centre.
        const bearing = ctx.aim?.bestBearingDeg ?? bearingDeg(origin, center);

        // The club being hit: nearest nominal carry to the intended shot
        // distance (the remaining distance, capped at the longest club).
        let longestM = 0;
        for (const club of ctx.clubs) longestM = Math.max(longestM, club.carryM);
        const shotClub = closestClub(ctx.clubs, Math.min(remainingM, longestM));
        if (!shotClub) return [];

        // Wind is a forward application on each club's own nominal carry
        // (same convention as par5-attack / take-your-medicine).
        const bandFor = (club: ClubSpec): { minM: number; maxM: number } => {
            const effect = ctx.wind
                ? windEffect(ctx.wind.speedMps, ctx.wind.directionDeg, bearing, club.carryM)
                : 0;
            return { minM: minCarryM(club.carryM, effect), maxM: maxCarryM(club.carryM, effect) };
        };

        const band = bandFor(shotClub);
        if (band.maxM <= band.minM) return [];

        // The hazard the shot flirts with most: the crossed ring whose
        // [front, carry] interval overlaps the largest share of the club's
        // landing window. Strictly-greater keeps ties on the earlier ring
        // (deterministic — hazardsAlongLine preserves input order).
        const hits = hazardsAlongLine(origin, bearing, ctx.hazards);
        let threatened: CarryOverHazard | undefined;
        let bestShare = 0;
        for (const hit of hits) {
            const overlapM = Math.min(band.maxM, hit.carryM) - Math.max(band.minM, hit.frontM);
            const share = overlapM / (band.maxM - band.minM);
            if (share > bestShare) {
                bestShare = share;
                threatened = hit;
            }
        }
        if (!threatened) return [];
        const share = Math.min(1, bestShare);

        // Remedies, each judged on its own wind-adjusted band.
        let clubUp: ClubSpec | undefined;
        let layUp: ClubSpec | undefined;
        for (const club of ctx.clubs) {
            const b = bandFor(club);
            if (b.minM > threatened.carryM && (!clubUp || club.carryM < clubUp.carryM)) clubUp = club;
            if (b.maxM < threatened.frontM && (!layUp || club.carryM > layUp.carryM)) layUp = club;
        }
        const canClubUp = clubUp !== undefined
            && clubUp.carryM - remainingM <= CLUB_UP_MAX_PAST_TARGET_M;

        const label = threatened.ring.kind;
        const along = { x: Math.sin((bearing * Math.PI) / 180), y: Math.cos((bearing * Math.PI) / 180) };

        let kind: CaddyAdvice['kind'];
        let headline: string;
        let anchorM: number;
        if (canClubUp) {
            kind = 'club';
            headline = `Can't carry the ${label} with the ${clubName(shotClub)} — `
                + `club up to the ${clubName(clubUp!)}.`;
            anchorM = threatened.carryM;
        } else if (layUp) {
            kind = 'layup';
            headline = `Can't carry the ${label} with the ${clubName(shotClub)} — `
                + `lay up short with the ${clubName(layUp)}.`;
            anchorM = threatened.frontM;
        } else {
            kind = 'warning';
            headline = `The ${label} at ${threatened.carryM.toFixed(0)} m is in play `
                + `with the ${clubName(shotClub)}.`;
            anchorM = threatened.carryM;
        }

        // Priority: a penalty hazard (water/OOB) outranks sand/rough trouble.
        const priority = lieFromFeatureType(threatened.ring.kind) === 'penalty' ? 4 : 3;
        // Confidence grows with how much of the landing window the hazard
        // eats — a sliver is a soft note, half the pattern is near-certain.
        const confidence = Math.min(0.9, 0.55 + 0.35 * share);

        return [
            {
                ruleId: 'can-you-carry-it',
                kind,
                priority,
                confidence,
                riskWeighted: true,
                anchor: { x: origin.x + along.x * anchorM, y: origin.y + along.y * anchorM },
                headline,
                detail:
                    `The ${label} runs ${threatened.frontM.toFixed(0)}–${threatened.carryM.toFixed(0)} m `
                    + `on this line; the ${clubName(shotClub)} lands ${band.minM.toFixed(0)}–`
                    + `${band.maxM.toFixed(0)} m.`,
            },
        ];
    },
};
