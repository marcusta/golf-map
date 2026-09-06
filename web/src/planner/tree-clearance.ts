// Web planner glue for shared/strategy/tree-clearance.ts: course features →
// TreeFeatureInput[], per-leg clearance with the elevation service as the
// ground sampler, the legs-readout row text, and the coloured shot-line
// segments the plan overlay draws over blocked/marginal crossings.
//
// Frame: planar EPSG:3006 meters, the same frame lie-map / carry / corridor
// use (feature rings are stored in it; PlanNode carries x/y in it).

import type { CourseFeature } from '../../../shared/api/course-features.gen';
import {
    apexHeightM,
    bearingToUnitVector,
    treeClearance,
    type TreeClearanceCrossing,
    type TreeClearanceResult,
    type TreeClearanceStatus,
    type TreeFeatureInput,
    type TreeFeatureSource,
    type Vec2,
} from '../../../shared/strategy';
import { flattenRing } from '../geo/bezier';
import type { PlanLeg } from './plan-overlay';

/** Same flattening tolerance lie-map.ts uses, so a tree ring has one shape everywhere. */
const TREE_RING_TOLERANCE_M = 0.25;

/**
 * The 'trees' features as shared TreeFeatureInput (outer ring flattened to
 * planar points; attributes passed through — generated lidar-canopy trees
 * carry heightP90M/heightMaxM, hand-drawn ones carry null).
 */
export function treeFeatureInputs(features: readonly CourseFeature[]): TreeFeatureInput[] {
    const out: TreeFeatureInput[] = [];
    for (const feature of features) {
        if (feature.type !== 'trees') continue;
        if (feature.geometry.rings.length === 0) continue;
        const flat = flattenRing(feature.geometry.rings[0], TREE_RING_TOLERANCE_M, feature.geometry.curveType);
        if (flat.length < 3) continue;
        out.push({
            type: feature.type,
            points: flat.map(([x, y]) => ({ x, y })),
            // The generated FeatureAttributes is an open (empty) interface; the
            // server writes heightP90M/heightMaxM etc. as plain scalars.
            attributes: (feature.attributes ?? null) as Record<string, number | string | boolean> | null,
        });
    }
    return out;
}

/** Planar ground sampler; null when the elevation is not available (tile not cached). */
export type PlanarGroundSampler = (p: Vec2) => number | null;

/** Ground inputs for a leg's clearance/caddy call, resolved from a planar sampler. */
export interface LegGroundProfile {
    /** Ground at `leg.from`: sampled, else the node elevation, else 0. */
    originGroundM: number;
    originGroundKnown: boolean;
    /** Ground at distance d along the leg bearing; absent without a sampler (flat). */
    groundAt?: (distanceM: number) => number;
}

/**
 * Ground sampler along the leg bearing from `leg.from`. A missing sample
 * (tile not cached yet) falls back to the origin ground, i.e. flat there.
 */
export function legGroundProfile(leg: PlanLeg, groundAt?: PlanarGroundSampler): LegGroundProfile {
    const origin: Vec2 = { x: leg.from.x, y: leg.from.y };
    const sampledOrigin = groundAt?.(origin) ?? leg.from.elevation;
    const originGroundKnown = sampledOrigin !== null && sampledOrigin !== undefined && Number.isFinite(sampledOrigin);
    const originGroundM = originGroundKnown ? sampledOrigin! : 0;
    if (!groundAt) return { originGroundM, originGroundKnown };
    const dir = bearingToUnitVector(leg.bearingDeg);
    return {
        originGroundM,
        originGroundKnown,
        groundAt: (d: number): number =>
            groundAt({ x: origin.x + dir.x * d, y: origin.y + dir.y * d }) ?? originGroundM,
    };
}

/**
 * Tree clearance for one plan leg: carry = the club's wind-adjusted carry,
 * apex = the carry-table apex (shared/strategy/apex.ts), ground from
 * `legGroundProfile`. Null for a leg without a club (no carry → nothing to
 * fly over) or when there are no tree features. `trees` is a plain
 * TreeFeatureInput[] or a prebuilt shared TreeIndex (buildTreeIndex); the
 * planner service builds the index once per features change and reuses it
 * per leg.
 */
export function legTreeClearance(
    leg: PlanLeg,
    trees: TreeFeatureSource<TreeFeatureInput>,
    groundAt?: PlanarGroundSampler,
): TreeClearanceResult | null {
    const carryM = leg.adjustedCarryM;
    if (carryM === undefined || !(carryM > 0)) return null;
    if ((Array.isArray(trees) ? trees.length : trees.entries.length) === 0) return null;
    const origin: Vec2 = { x: leg.from.x, y: leg.from.y };
    const target: Vec2 = { x: leg.to.x, y: leg.to.y };
    const ground = legGroundProfile(leg, groundAt);
    return treeClearance(origin, target, trees, { carryM, apexM: apexHeightM(carryM) }, {
        originGroundM: ground.originGroundM,
        originGroundKnown: ground.originGroundKnown,
        ...(ground.groundAt ? { groundAt: ground.groundAt } : {}),
    });
}

/**
 * Readout row text for one crossing:
 *   "Trees 18 m · clears by 6 m" / "Trees 18 m · blocked (ball 12 m)" /
 *   "Trees 18 m · 1 m to spare" / "Trees · height unknown".
 * `ballM` is the ball height above the tree's ground at the worst point.
 */
export function treeRowText(crossing: TreeClearanceCrossing): string {
    const h = crossing.treeHeightM;
    if (h === null || crossing.minClearanceM === null) return 'Trees · height unknown';
    const height = Math.round(h);
    const clearance = crossing.minClearanceM;
    switch (crossing.status) {
        case 'blocked': {
            const ballM = Math.max(0, Math.round(h + clearance));
            return `Trees ${height} m · blocked (ball ${ballM} m)`;
        }
        case 'marginal':
            return `Trees ${height} m · ${Math.max(0, Math.round(clearance))} m to spare`;
        case 'clears':
            return `Trees ${height} m · clears by ${Math.round(clearance)} m`;
        default:
            return 'Trees · height unknown';
    }
}

/** CSS modifier (and data attribute) for a clearance status. */
export function treeStatusClass(status: TreeClearanceStatus): 'good' | 'risk' | 'bad' | 'neutral' {
    switch (status) {
        case 'clears': return 'good';
        case 'marginal': return 'risk';
        case 'blocked': return 'bad';
        default: return 'neutral';
    }
}

/** A piece of a leg's shot line over a tree crossing, for the overlay. */
export interface TreeSegment {
    legIndex: number;
    primary: boolean;
    status: TreeClearanceStatus;
    /** Planar endpoints along the leg bearing from `leg.from` (entry → min(exit, carry)). */
    from: Vec2;
    to: Vec2;
}

/**
 * Overlay segments for the leg's blocked and marginal crossings (clears /
 * unknown keep the plain leg colour; trees beyond carry are not flight
 * obstacles). Straight along the leg bearing — a routed green leg renders
 * its polyline elsewhere, the strategy itself works on the straight leg.
 */
export function treeSegmentsForLeg(leg: PlanLeg, result: TreeClearanceResult | null): TreeSegment[] {
    if (!result || leg.adjustedCarryM === undefined) return [];
    const carryM = leg.adjustedCarryM;
    const dir = bearingToUnitVector(leg.bearingDeg);
    const at = (d: number): Vec2 => ({ x: leg.from.x + dir.x * d, y: leg.from.y + dir.y * d });
    const out: TreeSegment[] = [];
    for (const c of result.crossings) {
        if (c.status !== 'blocked' && c.status !== 'marginal') continue;
        const end = Math.min(c.exitM, carryM);
        if (!(end > c.entryM)) continue;
        out.push({ legIndex: leg.index, primary: leg.primary, status: c.status, from: at(c.entryM), to: at(end) });
    }
    return out;
}
