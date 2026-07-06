// par5-attack — the smart-caddy par-5 decision rule. It compares the
// available attack/lay-up choices with the locked two-shot EV chain from the
// strategy decision register §5: run optimizeAim for THIS shot only, and
// price each sampled outcome with shotsToHoleOut(remaining-to-green, lie).
// No nested sampling; shot 2+ is the existing expected-strokes table.
//
// Conventions match the rest of shared/strategy: pure/zero-dep,
// Swift-mirrorable, projected meters, compass bearings (0 = north,
// clockwise). The caller supplies a finished CaddyContext; this rule does no
// I/O and reads no planner state outside the context.

import { optimizeAim, type AimResult } from '../../aim';
import { hazardsAlongLine } from '../../carry';
import { maxCarryM, type ClubSpec } from '../../club';
import { type Vec2 } from '../../ellipse';
import { windEffect } from '../../wind';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

export const FULL_NUMBER_LAYUP_M = 100;
export const LAY_BACK_OF_PINCH_BUFFER_M = 10;
export const LAYUP_TARGET_TOLERANCE_M = 18;

type Par5StrategyKind = 'go-in-2' | 'lay-up-to-full-number' | 'lay-back-of-pinch';

interface Par5Strategy {
    kind: Par5StrategyKind;
    club: ClubSpec;
    targetBearingDeg: number;
    targetDistanceM: number;
    plannedRemainingM: number;
    fullNumberM?: number;
}

interface ScoredPar5Strategy extends Par5Strategy {
    aim: AimResult;
    ev: number;
}

/** Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters. */
function bearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

function distanceM(a: Vec2, b: Vec2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function windEffectFor(ctx: CaddyContext, bearing: number): number {
    return ctx.wind ? windEffect(ctx.wind.speedMps, ctx.wind.directionDeg, bearing) : 0;
}

function clubMaxCarryM(club: ClubSpec, ctx: CaddyContext, bearing: number): number {
    return maxCarryM(club.carryM, windEffectFor(ctx, bearing));
}

function clubName(club: ClubSpec): string {
    return club.name ?? `${club.carryM.toFixed(0)} m club`;
}

function closestClub(clubs: readonly ClubSpec[], targetDistanceM: number): ClubSpec | undefined {
    let best: ClubSpec | undefined;
    let bestDiff = Infinity;
    for (const club of clubs) {
        const diff = Math.abs(club.carryM - targetDistanceM);
        if (diff < bestDiff) {
            best = club;
            bestDiff = diff;
        }
    }
    return best;
}

function closestClubWithin(
    clubs: readonly ClubSpec[],
    targetDistanceM: number,
    toleranceM: number,
): ClubSpec | undefined {
    const club = closestClub(clubs, targetDistanceM);
    if (!club) return undefined;
    return Math.abs(club.carryM - targetDistanceM) <= toleranceM ? club : undefined;
}

function bestReachClub(ctx: CaddyContext, remainingM: number, bearing: number): ClubSpec | undefined {
    let best: ClubSpec | undefined;
    let bestDiff = Infinity;
    for (const club of ctx.clubs) {
        if (clubMaxCarryM(club, ctx, bearing) < remainingM) continue;
        const diff = Math.abs(club.carryM - remainingM);
        if (diff < bestDiff) {
            best = club;
            bestDiff = diff;
        }
    }
    return best;
}

function greenCarryClear(ctx: CaddyContext, club: ClubSpec, bearing: number, remainingM: number): boolean {
    const maxCarry = clubMaxCarryM(club, ctx, bearing);
    const hits = hazardsAlongLine(
        { x: ctx.origin.x, y: ctx.origin.y },
        bearing,
        ctx.hazards,
    );
    for (const hit of hits) {
        if (hit.frontM > remainingM) continue;
        if (hit.carryM > maxCarry) return false;
    }
    return true;
}

function enumerateStrategies(ctx: CaddyContext): Par5Strategy[] {
    const origin = { x: ctx.origin.x, y: ctx.origin.y };
    const remainingM = distanceM(origin, ctx.target.center);
    const toGreenDeg = bearingDeg(origin, ctx.target.center);
    const strategies: Par5Strategy[] = [];

    const goClub = bestReachClub(ctx, remainingM, toGreenDeg);
    if (goClub && greenCarryClear(ctx, goClub, toGreenDeg, remainingM)) {
        strategies.push({
            kind: 'go-in-2',
            club: goClub,
            targetBearingDeg: toGreenDeg,
            targetDistanceM: remainingM,
            plannedRemainingM: 0,
        });
    }

    const fullTargetDistanceM = remainingM - FULL_NUMBER_LAYUP_M;
    if (fullTargetDistanceM > 0) {
        const fullClub = closestClubWithin(ctx.clubs, fullTargetDistanceM, LAYUP_TARGET_TOLERANCE_M);
        if (fullClub) {
            strategies.push({
                kind: 'lay-up-to-full-number',
                club: fullClub,
                targetBearingDeg: toGreenDeg,
                targetDistanceM: fullTargetDistanceM,
                plannedRemainingM: Math.max(0, remainingM - fullClub.carryM),
                fullNumberM: FULL_NUMBER_LAYUP_M,
            });
        }
    }

    const pinches = hazardsAlongLine(origin, toGreenDeg, ctx.hazards, remainingM)
        .filter((hit) => hit.frontM > LAY_BACK_OF_PINCH_BUFFER_M)
        .sort((a, b) => a.frontM - b.frontM);
    const firstPinch = pinches[0];
    if (firstPinch) {
        const layBackDistanceM = firstPinch.frontM - LAY_BACK_OF_PINCH_BUFFER_M;
        const layBackClub = closestClubWithin(ctx.clubs, layBackDistanceM, LAYUP_TARGET_TOLERANCE_M);
        if (layBackClub) {
            strategies.push({
                kind: 'lay-back-of-pinch',
                club: layBackClub,
                targetBearingDeg: toGreenDeg,
                targetDistanceM: layBackDistanceM,
                plannedRemainingM: Math.max(0, remainingM - layBackClub.carryM),
            });
        }
    }

    return strategies;
}

function scoreStrategies(ctx: CaddyContext): ScoredPar5Strategy[] {
    const surfaces = [ctx.target.greenPoly, ...ctx.hazards];
    return enumerateStrategies(ctx).map((strategy) => {
        const aim = optimizeAim({
            origin: { x: ctx.origin.x, y: ctx.origin.y },
            club: strategy.club,
            targetBearingDeg: strategy.targetBearingDeg,
            surfaces,
            greenCenter: ctx.target.center,
            windSpeedMps: ctx.wind?.speedMps,
            windDirectionDeg: ctx.wind?.directionDeg,
            riskAversion: ctx.risk.riskAversion,
            fallbackLie: 'fairway',
        });
        return { ...strategy, aim, ev: aim.best.score };
    }).sort((a, b) => a.ev - b.ev);
}

function confidenceFromGap(best: ScoredPar5Strategy, next: ScoredPar5Strategy | undefined): number {
    if (!next) return 0.6;
    const gap = next.ev - best.ev;
    return Math.max(0.55, Math.min(0.95, 0.55 + gap));
}

function fullNumberHeadline(best: ScoredPar5Strategy, others: readonly ScoredPar5Strategy[]): string {
    const awkward = others
        .filter((s) => s.plannedRemainingM > 0 && s.plannedRemainingM < FULL_NUMBER_LAYUP_M)
        .sort((a, b) => a.plannedRemainingM - b.plannedRemainingM)[0];
    if (awkward) {
        return `Lay up to a full ${best.fullNumberM?.toFixed(0) ?? FULL_NUMBER_LAYUP_M} m wedge — `
            + `a ${awkward.plannedRemainingM.toFixed(0)} m leftover prices worse.`;
    }
    return `Lay up to a full ${best.fullNumberM?.toFixed(0) ?? FULL_NUMBER_LAYUP_M} m wedge.`;
}

function headlineFor(best: ScoredPar5Strategy, others: readonly ScoredPar5Strategy[]): string {
    if (best.kind === 'go-in-2') {
        return `Attack the green in two — ${clubName(best.club)} reaches and the carry is clear.`;
    }
    if (best.kind === 'lay-up-to-full-number') {
        return fullNumberHeadline(best, others);
    }
    return `Lay back of the pinch — ${clubName(best.club)} leaves about ${best.plannedRemainingM.toFixed(0)} m.`;
}

function detailFor(best: ScoredPar5Strategy, next: ScoredPar5Strategy | undefined): string {
    const base = `${clubName(best.club)} at ${best.targetDistanceM.toFixed(0)} m prices at `
        + `${best.ev.toFixed(2)} expected strokes.`;
    if (!next) return base;
    return `${base} Next best was ${next.kind} at ${next.ev.toFixed(2)}.`;
}

export const par5AttackRule: CaddyRule = {
    id: 'par5-attack',

    appliesTo(ctx: CaddyContext): boolean {
        return ctx.hole.par === 5 && (ctx.leg === 'tee' || ctx.leg === 'layup');
    },

    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        const ranked = scoreStrategies(ctx);
        const best = ranked[0];
        if (!best) return [];

        const next = ranked[1];
        return [
            {
                ruleId: 'par5-attack',
                kind: best.kind === 'go-in-2' ? 'aim' : 'layup',
                priority: 3,
                confidence: confidenceFromGap(best, next),
                headline: headlineFor(best, ranked.slice(1)),
                detail: detailFor(best, next),
                anchor: best.kind === 'go-in-2' ? ctx.target.center : {
                    x: ctx.origin.x + Math.sin((best.targetBearingDeg * Math.PI) / 180) * best.targetDistanceM,
                    y: ctx.origin.y + Math.cos((best.targetBearingDeg * Math.PI) / 180) * best.targetDistanceM,
                },
            },
        ];
    },
};
