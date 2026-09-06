// over-the-trees — "trees 18 m high at 140 m, ball at about 12 m: blocked".
// Height-aware tree clearance (tree-clearance.ts) for the intended shot:
// does the planned flight clear the canopy of every 'trees' ring the line
// crosses before the ball lands? A blocked crossing is a warning to aim
// away or lay up; a marginal one (clears by less than the default margin)
// is a softer note. Hand-drawn trees without height data, trees the ball
// never reaches (past the carry) and clean clearances stay silent — the
// planner's per-shot readout already lists those.
//
// Inputs (all optional on the context; any missing → the rule is silent):
// ctx.trees (TreeFeatureInput rings), ctx.apexM (◄ apex.ts), ctx.groundAt
// (DEM sampler along the line). The carry is ctx.shotCarryM when the caller
// knows the assigned club; otherwise the club nearest the remaining
// distance, wind applied, as can-you-carry-it does. The shot line is the
// recommended aim when an AimResult is present, else straight at the target
// centre.
//
// Pure/self-gating; zero-dep, Swift-mirrorable. Meters, planar {x, y},
// compass bearings.

import { adjustedCarryM } from '../../wind';
import { bearingToUnitVector, type Vec2 } from '../../ellipse';
import { closestClub } from '../../club';
import { windEffect } from '../../wind';
import { treeClearance } from '../../tree-clearance';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

/** Base priority of a blocked crossing (a penalty-hazard-class concern). */
export const TREES_BLOCKED_PRIORITY = 4;
/** Base priority of a marginal crossing (a soft note). */
export const TREES_MARGINAL_PRIORITY = 2;

function bearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

export const overTheTreesRule: CaddyRule = {
    id: 'over-the-trees',

    appliesTo(ctx: CaddyContext): boolean {
        return (ctx.trees ? ('kind' in ctx.trees ? ctx.trees.entries.length : ctx.trees.length) : 0) > 0
            && typeof ctx.apexM === 'number' && ctx.apexM > 0
            && (ctx.shotCarryM !== undefined || ctx.clubs.length > 0);
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const trees = ctx.trees ?? [];
        const apexM = ctx.apexM ?? 0;
        const origin: Vec2 = { x: ctx.origin.x, y: ctx.origin.y };
        const center = ctx.target.center;
        const remainingM = Math.hypot(center.x - origin.x, center.y - origin.y);
        if (remainingM <= 0) return [];
        const bearing = ctx.aim?.bestBearingDeg ?? bearingDeg(origin, center);

        let carryM = ctx.shotCarryM;
        if (carryM === undefined) {
            let longestM = 0;
            for (const club of ctx.clubs) longestM = Math.max(longestM, club.carryM);
            const club = closestClub(ctx.clubs, Math.min(remainingM, longestM));
            if (!club) return [];
            const effect = ctx.wind
                ? windEffect(ctx.wind.speedMps, ctx.wind.directionDeg, bearing, club.carryM)
                : 0;
            carryM = adjustedCarryM(club.carryM, effect);
        }
        if (!(carryM > 0)) return [];

        const along = bearingToUnitVector(bearing);
        const target = { x: origin.x + along.x * carryM, y: origin.y + along.y * carryM };
        const result = treeClearance(origin, target, trees, { carryM, apexM }, {
            originGroundM: ctx.originGroundM,
            originGroundKnown: ctx.originGroundKnown,
            ...(ctx.groundAt ? { groundAt: ctx.groundAt } : {}),
        });
        const worst = result.summary.worst;
        const status = result.summary.status;
        if (!worst || worst.minClearanceM === null || worst.worstAtM === null) return [];
        if (status !== 'blocked' && status !== 'marginal') return [];

        const atM = worst.worstAtM;
        const heightM = worst.treeHeightM ?? 0;
        const ballM = Math.max(0, heightM + worst.minClearanceM);
        const anchor = { x: origin.x + along.x * atM, y: origin.y + along.y * atM };
        const where = `Trees ${heightM.toFixed(0)} m high at ${atM.toFixed(0)} m, `
            + `ball at about ${ballM.toFixed(0)} m`;

        if (status === 'blocked') {
            return [{
                ruleId: 'over-the-trees',
                kind: 'warning',
                priority: TREES_BLOCKED_PRIORITY,
                confidence: 0.8,
                riskWeighted: true,
                anchor,
                headline: `${where}: blocked, aim left/right or lay up.`,
                detail: `The flight is ${Math.abs(worst.minClearanceM).toFixed(0)} m short of the `
                    + `canopy top between ${worst.entryM.toFixed(0)} and `
                    + `${Math.min(worst.exitM, carryM).toFixed(0)} m on this line.`,
            }];
        }
        return [{
            ruleId: 'over-the-trees',
            kind: 'warning',
            priority: TREES_MARGINAL_PRIORITY,
            confidence: 0.6,
            riskWeighted: true,
            anchor,
            headline: `${where}: only ${worst.minClearanceM.toFixed(0)} m to spare over the trees.`,
            detail: 'A thin strike or a lower flight catches the canopy; take one more club or aim away from the trees.',
        }];
    },
};
