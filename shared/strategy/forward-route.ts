// Forward-route aim filter — which of a hole's aim points are still AHEAD
// of an arbitrary origin (browse tap, GPS fix), so the distance line routes
// origin → remaining aims → green instead of snaking back through corners
// already passed. Replaces the v1 iOS radial rule ("keep an aim iff it is
// closer to the green than the origin"), which retained a dogleg corner
// when the player was past the corner laterally but still radially farther
// from the green than the aim — the line doubled back through the elbow.
//
// Method: route-chainage projection. Project the origin onto the full hole
// route polyline (tee → aims → green) and take the chainage (meters along
// the route from its first vertex) of the nearest point. An aim is "passed"
// when its own chainage is at or behind that projection (+ a small margin);
// the kept aims are the suffix strictly ahead. At the tee the projection is
// chainage 0, so every aim is kept and real doglegs keep their full routed
// line; standing past the corner the projection lands on the final leg and
// the corner drops. Chainage is monotonic over the ordered aim vertices, so
// the result is always an in-order suffix of `aims`.
//
// The route START is open-ended: an origin may legitimately be behind the
// first vertex (no tee supplied, or standing behind the tee), so the first
// leg projects with t in (-inf, 1] and yields NEGATIVE chainage there —
// every aim stays ahead. Interior vertices are real waypoints and keep the
// closed [0, 1] clamp.
//
// Units & conventions: points are projected planar meters (EPSG:3006-style
// {x, y}, +x east, +y north); elevations are ignored — routing is planar.
// Pure functions, deterministic; the iOS Swift port mirrors this file
// function-for-function and is pinned by the `forwardRoute` section of the
// Swift goldens (generate-swift-fixtures.ts).

import { type StrategyPoint } from './plays-like';

/**
 * Chainage (meters along `route` from its first vertex) of the point on
 * `route` nearest to `p`. Routes with fewer than 2 points have no legs and
 * yield 0. Zero-length legs (duplicate vertices) are skipped for projection
 * but contribute their (zero) length to chainage identically. The FIRST
 * non-zero-length leg clamps t to (-inf, 1] — an origin behind the route
 * start projects onto the leg's backward extension and yields negative
 * chainage; all later legs clamp to [0, 1].
 */
export function projectedRouteChainage(route: readonly StrategyPoint[], p: StrategyPoint): number {
    if (route.length < 2) return 0;
    let bestDist = Infinity;
    let bestChainage = 0;
    let cum = 0;
    let firstLeg = true;
    for (let i = 0; i < route.length - 1; i++) {
        const a = route[i]!;
        const b = route[i + 1]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) continue; // zero-length leg: nothing to project onto, adds no chainage
        const len = Math.sqrt(len2);
        const tRaw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        // First leg is open-ended behind the route start (see header): an
        // origin behind it projects to negative chainage instead of pinning
        // to vertex 0. Interior legs clamp to the segment.
        const t = firstLeg ? Math.min(1, tRaw) : Math.min(1, Math.max(0, tRaw));
        firstLeg = false;
        const cx = a.x + t * dx;
        const cy = a.y + t * dy;
        const dist = Math.sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy));
        // `<=`, not `<`: exact ties resolve to the LATER leg. In the interior
        // of a dogleg elbow the origin can be equidistant from both legs;
        // biasing to the later leg deliberately favors "straight at the
        // green" (higher chainage → the corner aim reads as passed).
        if (dist <= bestDist) {
            bestDist = dist;
            bestChainage = cum + t * len;
        }
        cum += len;
    }
    return bestChainage;
}

export interface ForwardAimsInput {
    origin: StrategyPoint;
    /** Tee position — the hole route's first vertex. Optional: without it the chainage route starts at the first aim. */
    tee?: StrategyPoint;
    /** Hole aim points in tee→green order (override-resolved positions). */
    aims: readonly StrategyPoint[];
    green: StrategyPoint;
    /** An aim must be at least this far ahead (chainage) of the origin's projection to be kept. Default 5. */
    marginM?: number;
}

/** The aims still ahead of `origin` along the hole's routing (suffix of `aims`). */
export function forwardAims(input: ForwardAimsInput): StrategyPoint[] {
    const { origin, tee, aims, green, marginM = 5 } = input;
    if (aims.length === 0) return [];
    const chainageRoute: StrategyPoint[] = tee ? [tee, ...aims, green] : [...aims, green];
    if (chainageRoute.length < 2) return [];
    const s = projectedRouteChainage(chainageRoute, origin);
    // Cumulative chainage of every route vertex. Zero-length legs add 0 —
    // identical accumulation to projectedRouteChainage's skip.
    const vertexChainage: number[] = [0];
    let cum = 0;
    for (let i = 1; i < chainageRoute.length; i++) {
        const a = chainageRoute[i - 1]!;
        const b = chainageRoute[i]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        cum += Math.sqrt(dx * dx + dy * dy);
        vertexChainage.push(cum);
    }
    const firstAimVertex = tee ? 1 : 0;
    // Chainage is monotonic over the ordered aims → this is an in-order suffix.
    return aims.filter((_, i) => vertexChainage[firstAimVertex + i]! > s + marginM);
}

/** Full forward play-line: [origin, ...forwardAims(input), green]. */
export function forwardRoutePoints(input: ForwardAimsInput): StrategyPoint[] {
    return [input.origin, ...forwardAims(input), input.green];
}

/**
 * Origin-to-green distance at or below which the DRAWN play-line goes
 * straight at the green instead of routing through forward aims. Within one
 * full shot of the green the next swing targets the green itself, so an aim
 * a few meters ahead (still kept by the chainage filter) is not a shot
 * target and only adds a meaningless kink to the line. Matches iOS's
 * `defaultAimRoutingThresholdMeters` (the GPS-mode TO AIM gate) — the two
 * are pinned equal by the Swift goldens.
 */
export const AIM_ROUTING_THRESHOLD_M = 230;

export interface GatedForwardRouteInput extends ForwardAimsInput {
    /** Gate distance, meters. Default AIM_ROUTING_THRESHOLD_M (iOS lets the user tune it). */
    thresholdM?: number;
}

/**
 * The drawn play-line policy shared by GPS and browse modes: within
 * `thresholdM` of the green the line is the straight [origin, green]
 * (aims are no longer shot targets — see AIM_ROUTING_THRESHOLD_M); beyond
 * it, the chainage-filtered forwardRoutePoints. NOT for the layup spine —
 * layup landing points always follow the full routed line, gate or not
 * (a layup exists precisely because the green is out of reach).
 */
export function gatedForwardRoutePoints(input: GatedForwardRouteInput): StrategyPoint[] {
    const thresholdM = input.thresholdM ?? AIM_ROUTING_THRESHOLD_M;
    const dx = input.green.x - input.origin.x;
    const dy = input.green.y - input.origin.y;
    if (Math.sqrt(dx * dx + dy * dy) <= thresholdM) return [input.origin, input.green];
    return forwardRoutePoints(input);
}
