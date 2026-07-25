// Variant discovery v1 (feature-hole-sim-and-variants.md, decision V5) — the
// "show me the ways to play this hole" engine. It enumerates paths through a
// candidate-landing GRAPH, prices each with scoreOptionChain, and dedupes by
// a topological SIGNATURE (which hazards each line carries / passes and on
// which side, plus shot count) so the output reads as "the 3–4 real ways to
// play this hole" instead of ten near-identical drives (§2.2).
//
// THE GRAPH (§V5):
//   Nodes  — tee (origin), green center (terminal), and candidate landings:
//            the hole's aim points; layup bands (full-number wedge distance,
//            back-of-pinch, club-carry spots); and LATERAL TRIPLES at each
//            band (left / center / right, offset within the containing fairway
//            ring and clamped to it with a margin). Capped at ~30 nodes.
//   Edges  — A→B when some club's WIND-ADJUSTED carry covers |AB| within
//            LAYUP_TARGET_TOLERANCE_M, AND chainage(B) > chainage(A) along the
//            browse route (forward-progress only — no backtracking edges).
//   Paths  — DFS tee→green, ≤ 4 legs. Each priced with scoreOptionChain
//            (depth-n EV, CVaR₈₀ tail, penalty aggregation).
//
// SIGNATURE DEDUPE (§V5): for every in-play hazard, the relation of the path
// to it — carried / passed-left / passed-right (— 'short-of' is reserved; see
// the note on computeSignature) — plus the shot count. Two paths with the same
// signature are the same strategy with jiggled points; discovery keeps the
// best (lowest EV) path per signature and returns the top 5 by EV.
//
// PERF: each EDGE is priced once (its scoreOptionChain per-leg score is
// independent of the rest of the path) and paths compose those cached leg
// scores with the exact scoreOptionChain telescope — so enumeration costs no
// extra optimizeAim sweeps.
//
// Conventions match the rest of shared/strategy: pure, zero-dep, projected
// meters, compass bearings (0 = north, cw), surfaces topmost-first (D23).
// Derived, never persisted (O4/V7).

import { adjustedCarryM } from './wind';
import { type ClubSpec } from './club';
import { pointInRing, type FlatRing } from './corridor';
import { bearingToUnitVector, type Vec2 } from './ellipse';
import { lieFromFeatureType, type Lie } from './lie';
import {
    LAY_BACK_OF_PINCH_BUFFER_M,
    LAYUP_TARGET_TOLERANCE_M,
    FULL_NUMBER_LAYUP_M,
} from './caddy/rules/par5-attack';
import {
    type ChainLeg,
    type ChainLegScore,
    type ChainScore,
    type ChainScoreContext,
    scoreOptionChain,
} from './option-chain';
import { rayRingIntersections } from './ray';
import { windEffect } from './wind';

// ── Tunables (§V5 / open questions §8.3) ─────────────────────────────────────

/** Hard cap on graph nodes per hole (§V5). */
export const MAX_VARIANT_NODES = 30;
/** DFS depth cap in legs (§V5). */
export const MAX_VARIANT_LEGS = 4;
/** Desired lateral offset for the left/right triple, meters. */
export const LATERAL_OFFSET_M = 15;
/** Keep a lateral node this far inside the fairway boundary, meters. */
export const LATERAL_MARGIN_M = 5;
/** Drop a lateral side whose clamped offset falls below this (narrow fairway). */
export const MIN_LATERAL_OFFSET_M = 4;
/** A hazard counts toward the signature only if within this of the route. */
export const SIGNATURE_CORRIDOR_M = 50;
/** How many ranked variants discoverVariants returns. */
export const TOP_VARIANTS = 5;
/** Safety bound on enumerated paths (pathological fan-out guard). */
export const MAX_ENUMERATED_PATHS = 20000;

// ── Public types ─────────────────────────────────────────────────────────────

/** A hazard ring carrying a stable id (used in signatures). */
export interface HoleHazard extends FlatRing {
    /** Stable identity for the signature relation list. */
    id: string;
}

export interface VariantHoleContext {
    /** Tee / decision origin, planar meters. */
    tee: Vec2;
    /** Green center — the terminal node and the remaining-distance anchor. */
    greenCenter: Vec2;
    /** Authored aim points, tee→green order. Optional. */
    aimPoints?: readonly Vec2[];
    /** ALL classified surface rings, topmost-first (D23) — for pricing + fairway lookup. */
    surfaces: readonly FlatRing[];
    /** Hazard rings with ids — the signature's alphabet. */
    hazards: readonly HoleHazard[];
    /** The bag. */
    clubs: readonly ClubSpec[];
    /** Wind: speed m/s, direction FROM in compass degrees. Omit for calm. */
    wind?: { speedMps: number; directionDeg: number };
    /** Lie for points in no ring. Default 'rough'. */
    fallbackLie?: Lie;
}

export type HazardRelation = 'carried' | 'passed-left' | 'passed-right' | 'short-of';

export interface HazardEngagement {
    hazardId: string;
    relation: HazardRelation;
}

export interface VariantSignature {
    /** Number of legs (shots) from the decision point. */
    shotCount: number;
    /** Ordered (by hazard id) engagements of every in-play hazard. */
    hazards: HazardEngagement[];
    /** Canonical key: `${shotCount}|id:relation,id:relation,…`. */
    key: string;
}

export interface GraphNode {
    id: string;
    point: Vec2;
    /** Arc-length along the browse route from the tee, meters. */
    chainage: number;
    kind: 'tee' | 'green' | 'aim' | 'layup';
}

export interface GraphEdge {
    from: string;
    to: string;
    distanceM: number;
    /** The club whose wind-adjusted carry best covers this edge. */
    club: ClubSpec;
}

export interface VariantGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export interface ScoredVariant {
    /** Node sequence tee→…→green. */
    nodes: GraphNode[];
    /** The priced legs (origin/landing/club per edge). */
    legs: ChainLeg[];
    /** scoreOptionChain triple + per-leg build-up for this path. */
    score: ChainScore;
    /** Topological signature (dedupe key). */
    signature: VariantSignature;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────

function dist(a: Vec2, b: Vec2): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function bearingDeg(a: Vec2, b: Vec2): number {
    return (Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI + 360) % 360;
}

function centroid(ring: FlatRing): Vec2 {
    let x = 0, y = 0;
    for (const p of ring.points) { x += p.x; y += p.y; }
    const n = ring.points.length || 1;
    return { x: x / n, y: y / n };
}

/** Cumulative chainage (arc length from vertex 0) for each route vertex. */
function routeChainages(route: readonly Vec2[]): number[] {
    const out = [0];
    for (let i = 1; i < route.length; i++) out.push(out[i - 1]! + dist(route[i - 1]!, route[i]!));
    return out;
}

/** Point on the route polyline at arc-length `s`. */
function pointAtChainage(route: readonly Vec2[], cum: readonly number[], s: number): Vec2 {
    if (s <= 0) return route[0]!;
    const total = cum[cum.length - 1]!;
    if (s >= total) return route[route.length - 1]!;
    for (let i = 1; i < route.length; i++) {
        if (s <= cum[i]!) {
            const segLen = cum[i]! - cum[i - 1]!;
            const t = segLen === 0 ? 0 : (s - cum[i - 1]!) / segLen;
            const a = route[i - 1]!, b = route[i]!;
            return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
        }
    }
    return route[route.length - 1]!;
}

/** Unit tangent of the route at arc-length `s` (direction of travel). */
function tangentAtChainage(route: readonly Vec2[], cum: readonly number[], s: number): Vec2 {
    for (let i = 1; i < route.length; i++) {
        if (s <= cum[i]! + 1e-9) {
            const a = route[i - 1]!, b = route[i]!;
            const d = dist(a, b) || 1;
            return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
        }
    }
    const a = route[route.length - 2]!, b = route[route.length - 1]!;
    const d = dist(a, b) || 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}

/** Min perpendicular distance from `p` to the route polyline. */
function distanceToRoute(route: readonly Vec2[], p: Vec2): number {
    let best = Infinity;
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]!, b = route[i]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        const cx = a.x + t * dx, cy = a.y + t * dy;
        best = Math.min(best, Math.hypot(p.x - cx, p.y - cy));
    }
    return best;
}

/** Does the segment A→B enter/cross `ring` (or start/end inside it)? */
function segmentHitsRing(a: Vec2, b: Vec2, ring: readonly Vec2[]): boolean {
    if (ring.length < 3) return false;
    if (pointInRing(a, ring) || pointInRing(b, ring)) return true;
    const d = dist(a, b);
    if (d === 0) return false;
    const dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    return rayRingIntersections(a, dir, ring, d).length > 0;
}

/** First fairway-lie ring in `surfaces` that contains `p`, if any. */
function containingFairway(p: Vec2, surfaces: readonly FlatRing[]): FlatRing | undefined {
    for (const ring of surfaces) {
        if (ring.points.length < 3) continue;
        if (lieFromFeatureType(ring.kind) !== 'fairway') continue;
        if (pointInRing(p, ring.points)) return ring;
    }
    return undefined;
}

/** Distance from `origin` along unit `dir` to the fairway ring boundary. */
function roomToBoundary(origin: Vec2, dir: Vec2, ring: readonly Vec2[]): number {
    const hits = rayRingIntersections(origin, dir, ring);
    return hits.length > 0 ? hits[0]! : Infinity;
}

// ── Reachability (§V5): some club's wind-adjusted carry covers |AB| ± tol ─────
//
// The par-5 rule's bestReachClub/closestClubWithin are private to that module;
// this reimplements the same reachability from the same primitives
// (adjustedCarryM ∘ windEffect), keyed on the edge bearing.
function reachClub(
    clubs: readonly ClubSpec[],
    distanceM: number,
    bearing: number,
    wind: VariantHoleContext['wind'],
): ClubSpec | undefined {
    let best: ClubSpec | undefined;
    let bestDiff = Infinity;
    for (const club of clubs) {
        const effect = wind ? windEffect(wind.speedMps, wind.directionDeg, bearing, club.carryM) : 0;
        const adjusted = adjustedCarryM(club.carryM, effect);
        const diff = Math.abs(adjusted - distanceM);
        if (diff <= LAYUP_TARGET_TOLERANCE_M && diff < bestDiff) {
            best = club;
            bestDiff = diff;
        }
    }
    return best;
}

// ── Node generation ──────────────────────────────────────────────────────────

interface Band {
    /** Arc-length along the route. */
    chainage: number;
    /** Priority: lower is kept first when capping. */
    priority: number;
    kind: 'aim' | 'layup';
}

/** Collect candidate bands (route chainages), prioritized and deduped. */
function candidateBands(ctx: VariantHoleContext, route: Vec2[], cum: number[]): Band[] {
    const greenChain = cum[cum.length - 1]!;
    const raw: Band[] = [];

    // Aim points (highest priority) — their route-vertex chainage.
    const aims = ctx.aimPoints ?? [];
    for (let i = 0; i < aims.length; i++) {
        raw.push({ chainage: cum[i + 1]!, priority: 0, kind: 'aim' });
    }

    // Full-number wedge layup: leaves FULL_NUMBER_LAYUP_M to the green.
    const fullNumber = greenChain - FULL_NUMBER_LAYUP_M;
    if (fullNumber > 0) raw.push({ chainage: fullNumber, priority: 1, kind: 'layup' });

    // Back-of-pinch: short of every hazard the route runs through.
    for (const hz of ctx.hazards) {
        const c = centroid(hz);
        if (distanceToRoute(route, c) > SIGNATURE_CORRIDOR_M) continue;
        if (!routeCrossesHazard(route, hz.points)) continue;
        const pinchChain = projectChainage(route, cum, c) - LAY_BACK_OF_PINCH_BUFFER_M;
        if (pinchChain > 0) raw.push({ chainage: pinchChain, priority: 2, kind: 'layup' });
    }

    // Club-carry landing spots from the tee (fill).
    for (const club of ctx.clubs) {
        if (club.carryM > 0 && club.carryM < greenChain - 2) {
            raw.push({ chainage: club.carryM, priority: 3, kind: 'layup' });
        }
    }

    // Dedupe within 8 m keeping the best priority, sort by chainage, cap.
    raw.sort((a, b) => a.chainage - b.chainage || a.priority - b.priority);
    const deduped: Band[] = [];
    for (const band of raw) {
        const prev = deduped[deduped.length - 1];
        if (prev && Math.abs(prev.chainage - band.chainage) < 8) continue;
        if (band.chainage <= 0 || band.chainage >= greenChain - 2) continue;
        deduped.push(band);
    }
    const maxBands = Math.floor((MAX_VARIANT_NODES - 2) / 3);
    // Keep the highest-priority bands, then restore chainage order.
    return deduped
        .slice()
        .sort((a, b) => a.priority - b.priority || a.chainage - b.chainage)
        .slice(0, maxBands)
        .sort((a, b) => a.chainage - b.chainage);
}

/** Does the route polyline pass through the hazard ring (a "pinch")? */
function routeCrossesHazard(route: readonly Vec2[], ring: readonly Vec2[]): boolean {
    for (let i = 1; i < route.length; i++) {
        if (segmentHitsRing(route[i - 1]!, route[i]!, ring)) return true;
    }
    return false;
}

/** Chainage of the point on the route nearest `p`. */
function projectChainage(route: readonly Vec2[], cum: readonly number[], p: Vec2): number {
    let best = Infinity;
    let bestChain = 0;
    for (let i = 1; i < route.length; i++) {
        const a = route[i - 1]!, b = route[i]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        const cx = a.x + t * dx, cy = a.y + t * dy;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < best) { best = d; bestChain = cum[i - 1]! + t * Math.sqrt(len2); }
    }
    return bestChain;
}

/** Build the candidate-landing graph (§V5) — pure geometry, no pricing. */
export function buildVariantGraph(ctx: VariantHoleContext): VariantGraph {
    const route: Vec2[] = [ctx.tee, ...(ctx.aimPoints ?? []), ctx.greenCenter];
    const cum = routeChainages(route);
    const greenChain = cum[cum.length - 1]!;

    const nodes: GraphNode[] = [
        { id: 'tee', point: ctx.tee, chainage: 0, kind: 'tee' },
    ];

    const bands = candidateBands(ctx, route, cum);
    let bandIdx = 0;
    for (const band of bands) {
        if (nodes.length + 1 >= MAX_VARIANT_NODES) break; // reserve green slot
        const center = pointAtChainage(route, cum, band.chainage);
        const tangent = tangentAtChainage(route, cum, band.chainage);
        const right: Vec2 = { x: tangent.y, y: -tangent.x }; // shot-right
        const tag = `${band.kind}${bandIdx}`;

        nodes.push({ id: `${tag}-C`, point: center, chainage: band.chainage, kind: band.kind });

        // Lateral triple: clamp each side inside the containing fairway ring.
        const fw = containingFairway(center, ctx.surfaces);
        if (fw) {
            for (const [sign, suffix] of [[1, 'R'], [-1, 'L']] as const) {
                if (nodes.length + 1 >= MAX_VARIANT_NODES) break;
                const dir: Vec2 = { x: right.x * sign, y: right.y * sign };
                const room = roomToBoundary(center, dir, fw.points) - LATERAL_MARGIN_M;
                const off = Math.min(LATERAL_OFFSET_M, room);
                if (off >= MIN_LATERAL_OFFSET_M) {
                    nodes.push({
                        id: `${tag}-${suffix}`,
                        point: { x: center.x + dir.x * off, y: center.y + dir.y * off },
                        chainage: band.chainage,
                        kind: band.kind,
                    });
                }
            }
        }
        bandIdx++;
    }

    nodes.push({ id: 'green', point: ctx.greenCenter, chainage: greenChain, kind: 'green' });

    // Edges: forward-progress + club reachability.
    const edges: GraphEdge[] = [];
    for (const from of nodes) {
        for (const to of nodes) {
            if (to.chainage <= from.chainage + 1e-6) continue; // forward only
            const d = dist(from.point, to.point);
            const club = reachClub(ctx.clubs, d, bearingDeg(from.point, to.point), ctx.wind);
            if (club) edges.push({ from: from.id, to: to.id, distanceM: d, club });
        }
    }

    return { nodes, edges };
}

// ── Signature (§V5) ──────────────────────────────────────────────────────────

/**
 * Topological signature of a path: shot count + each in-play hazard's relation
 * to the line. Coarse by design — it only needs to separate lines a golfer
 * would call different (left of the bunker ≠ right of it; jiggled same-side
 * lines are the same).
 *
 * RELATIONS: 'carried' when a leg segment enters/crosses the hazard; else the
 * lateral side of the hazard vs the leg that spans its chainage. 'short-of' is
 * RESERVED: a tee→green path always holes out, so no in-play hazard is ever
 * left unresolved — it is emitted only by continuations that stop short of the
 * green (the Phase-D value-map generator), never here.
 */
export function computeSignature(
    pathNodes: readonly GraphNode[],
    ctx: VariantHoleContext,
): VariantSignature {
    const route: Vec2[] = [ctx.tee, ...(ctx.aimPoints ?? []), ctx.greenCenter];
    const cum = routeChainages(route);
    const shotCount = pathNodes.length - 1;
    const chains = pathNodes.map((n) => n.chainage);

    const engagements: HazardEngagement[] = [];
    for (const hz of ctx.hazards) {
        const c = centroid(hz);
        if (distanceToRoute(route, c) > SIGNATURE_CORRIDOR_M) continue; // not in play
        // Hazard position measured as ROUTE chainage — the same frame the node
        // chainages live in, so the spanning-leg lookup is consistent.
        const hazardChain = projectChainage(route, cum, c);
        const relation = hazardRelation(pathNodes, chains, hz, c, hazardChain);
        if (relation) engagements.push({ hazardId: hz.id, relation });
    }
    engagements.sort((a, b) => (a.hazardId < b.hazardId ? -1 : a.hazardId > b.hazardId ? 1 : 0));

    const key = `${shotCount}|${engagements.map((e) => `${e.hazardId}:${e.relation}`).join(',')}`;
    return { shotCount, hazards: engagements, key };
}

function hazardRelation(
    pathNodes: readonly GraphNode[],
    chains: readonly number[],
    hz: HoleHazard,
    c: Vec2,
    hazardChain: number,
): HazardRelation | undefined {
    // Find the leg (A→B) whose route-chainage span contains the hazard. The
    // hazardChain is measured on the ROUTE — the same frame `chains` (node
    // chainages) live in — so the spanning-leg lookup is unit-consistent.
    for (let i = 1; i < pathNodes.length; i++) {
        const aChain = chains[i - 1]!, bChain = chains[i]!;
        if (hazardChain < aChain - 1e-6 || hazardChain > bChain + 1e-6) continue;
        const a = pathNodes[i - 1]!.point, b = pathNodes[i]!.point;
        if (segmentHitsRing(a, b, hz.points)) return 'carried';
        // Cross sign of (A→B) × (A→hazard): in +x-east/+y-north coords, <0 means
        // the hazard is on the shot's RIGHT ⇒ the ball passed on its LEFT.
        const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        return cross < 0 ? 'passed-left' : 'passed-right';
    }

    // No spanning leg found (hazard beyond the last real landing): the path
    // holes out short of it (rare — near/behind-green hazards).
    return 'short-of';
}

// ── Path enumeration + pricing (§V5) ─────────────────────────────────────────

function chainScoreContext(ctx: VariantHoleContext): ChainScoreContext {
    return {
        surfaces: ctx.surfaces,
        greenCenter: ctx.greenCenter,
        ...(ctx.wind !== undefined ? { wind: ctx.wind } : {}),
        ...(ctx.fallbackLie !== undefined ? { fallbackLie: ctx.fallbackLie } : {}),
    };
}

/** Compose a path's ChainScore from cached per-edge leg scores (the exact
 *  scoreOptionChain telescope — see option-chain.ts). */
function composeScore(legScores: readonly ChainLegScore[]): ChainScore {
    if (legScores.length === 0) return { expectedStrokes: 0, tailStrokes: 0, penaltyProb: 0, perLeg: [] };
    let expected = legScores[legScores.length - 1]!.baselineStrokes;
    let spreadSq = 0;
    let clean = 1;
    for (const ls of legScores) {
        expected += ls.expectedStrokes - ls.baselineStrokes;
        const spread = ls.tailStrokes - ls.expectedStrokes;
        spreadSq += spread * spread;
        clean *= 1 - ls.penaltyProb;
    }
    return {
        expectedStrokes: expected,
        tailStrokes: expected + Math.sqrt(spreadSq),
        penaltyProb: 1 - clean,
        perLeg: [...legScores],
    };
}

/**
 * Discover the distinct ways to play the hole (§V5): enumerate tee→green paths
 * (≤ MAX_VARIANT_LEGS legs), price each, dedupe by signature keeping the best
 * EV per signature, and return the top TOP_VARIANTS ranked by EV.
 */
export function discoverVariants(ctx: VariantHoleContext): ScoredVariant[] {
    const graph = buildVariantGraph(ctx);
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const adj = new Map<string, GraphEdge[]>();
    for (const e of graph.edges) {
        const list = adj.get(e.from);
        if (list) list.push(e);
        else adj.set(e.from, [e]);
    }

    const chainCtx = chainScoreContext(ctx);
    // Per-edge leg score, priced once (independent of the rest of the path).
    const edgeScore = new Map<string, ChainLegScore>();
    const legScoreFor = (e: GraphEdge): ChainLegScore => {
        const key = `${e.from}->${e.to}`;
        let s = edgeScore.get(key);
        if (!s) {
            const from = nodeById.get(e.from)!.point;
            const to = nodeById.get(e.to)!.point;
            const leg: ChainLeg = { origin: from, landing: to, club: e.club };
            s = scoreOptionChain([leg], chainCtx).perLeg[0]!;
            edgeScore.set(key, s);
        }
        return s;
    };

    const best = new Map<string, ScoredVariant>();
    let enumerated = 0;

    const dfs = (nodeId: string, path: GraphNode[], legs: ChainLeg[], legScores: ChainLegScore[]) => {
        if (enumerated >= MAX_ENUMERATED_PATHS) return;
        if (nodeId === 'green') {
            if (legs.length === 0) return;
            enumerated++;
            const score = composeScore(legScores);
            const signature = computeSignature(path, ctx);
            const prior = best.get(signature.key);
            if (!prior || score.expectedStrokes < prior.score.expectedStrokes) {
                best.set(signature.key, { nodes: [...path], legs: [...legs], score, signature });
            }
            return;
        }
        if (legs.length >= MAX_VARIANT_LEGS) return;
        for (const e of adj.get(nodeId) ?? []) {
            const to = nodeById.get(e.to)!;
            if (path.some((n) => n.id === to.id)) continue; // simple paths
            path.push(to);
            legs.push({ origin: nodeById.get(e.from)!.point, landing: to.point, club: e.club });
            legScores.push(legScoreFor(e));
            dfs(e.to, path, legs, legScores);
            path.pop();
            legs.pop();
            legScores.pop();
        }
    };

    const tee = nodeById.get('tee')!;
    dfs('tee', [tee], [], []);

    return [...best.values()]
        .sort((a, b) => a.score.expectedStrokes - b.score.expectedStrokes)
        .slice(0, TOP_VARIANTS);
}
