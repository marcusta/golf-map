import {
    featureDistances,
    gatedForwardRoutePoints,
    type ClubSpec,
    type FlatRing,
    type PointRole,
    type StrategyPoint,
} from '../../../shared/strategy';

export type BrowseLadderKind = PointRole | 'hazard_front' | 'hazard_carry';

export interface BrowsePointTarget {
    id: string;
    label: string;
    role: PointRole;
    point: StrategyPoint;
}

export interface BrowseHazardTarget {
    id: string;
    label: string;
    ring: FlatRing;
}

export interface BrowseLadderRow {
    id: string;
    kind: BrowseLadderKind;
    label: string;
    lineM: number;
    playsAsM: number | null;
    elevationDeltaM: number | null;
    windDeltaM: number | null;
    clubName: string | null;
    /** Projected EPSG:3006 point; every rung can become the next origin. */
    position: StrategyPoint;
    /**
     * Far-edge ("carry") distance along the play line, meters — only on the
     * tap-a-shape inspection row, where `lineM` is the near ("front") edge.
     */
    farM?: number;
}

export interface BrowseLadderInput {
    origin: StrategyPoint;
    points: readonly BrowsePointTarget[];
    hazards?: readonly BrowseHazardTarget[];
    /** Reference line for front/carry intersections, normally origin → green. */
    bearingDeg: number;
    wind?: { speedMps: number; directionDeg: number };
    clubs?: readonly ClubSpec[];
}

export type BrowseTargetActivation = 'inspect' | 'promote-origin';

/**
 * Interaction policy shared by map targets and ladder rungs. Kept pure so a
 * regression test can lock the distinction between inspecting a target and
 * explicitly promoting it to the current origin.
 */
export function browseTargetActivation(
    _source: 'map' | 'ladder',
): BrowseTargetActivation {
    return 'inspect';
}

/**
 * Planner-side adapter over the shared feature-distance engine. It retains a
 * stable source id and a concrete position for every output row so the UI can
 * promote any ladder rung into the next transient browse origin.
 */
export function buildBrowseLadder(input: BrowseLadderInput): BrowseLadderRow[] {
    const rows: BrowseLadderRow[] = [];

    for (const target of input.points) {
        const [distance] = featureDistances({
            origin: input.origin,
            targets: [{ kind: 'point', label: target.label, role: target.role, at: target.point }],
            bearingDeg: input.bearingDeg,
            wind: input.wind,
            clubs: input.clubs,
        });
        if (!distance || distance.lineM < 0.5) continue;
        rows.push(toRow(target.id, distance, target.point));
    }

    for (const hazard of input.hazards ?? []) {
        const distances = featureDistances({
            origin: input.origin,
            targets: [{ kind: 'hazard', label: hazard.label, ring: hazard.ring }],
            bearingDeg: input.bearingDeg,
            wind: input.wind,
            clubs: input.clubs,
        });
        for (const distance of distances) {
            const position = projectAlong(input.origin, distance.bearingDeg, distance.lineM);
            rows.push(toRow(hazard.id, distance, position));
        }
    }

    return rows.sort((a, b) => a.lineM - b.lineM || a.id.localeCompare(b.id));
}

/**
 * The routed browse play-line — `[origin, ...forward aims, green]` — as
 * projected points, mirroring iOS's `browseForwardRoute`. A thin adapter over
 * the shared `gatedForwardRoutePoints`: within `AIM_ROUTING_THRESHOLD_M`
 * (planar origin→green, default 230 m; override via `thresholdM`) the drawn
 * line is gated STRAIGHT `[origin, green]` — near the green an aim a few
 * meters ahead is not a shot target, so kinking the line through it is noise.
 * Beyond the threshold the route-chainage aim filter applies: aims already
 * passed relative to `origin` along the hole's routing (tee → aims → green)
 * are dropped, so the line no longer doubles back through a dogleg corner the
 * player is past. The result is `origin`, an in-order suffix of `aims`, then
 * `green`, so `route.length - 2` is the count of aims kept — still correct in
 * the gated case (0 kept) — and callers that need the source aim objects use
 * `aims.slice(aims.length - kept)`.
 */
export function browseForwardRoute(
    origin: StrategyPoint,
    tee: StrategyPoint | undefined,
    aims: readonly StrategyPoint[],
    green: StrategyPoint,
    marginM?: number,
    thresholdM?: number,
): StrategyPoint[] {
    return gatedForwardRoutePoints({
        origin,
        aims,
        green,
        ...(tee ? { tee } : {}),
        ...(marginM !== undefined ? { marginM } : {}),
        ...(thresholdM !== undefined ? { thresholdM } : {}),
    });
}

export function bearingBetween(from: StrategyPoint, to: StrategyPoint): number {
    const degrees = Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI;
    return degrees < 0 ? degrees + 360 : degrees;
}

function projectAlong(origin: StrategyPoint, bearingDeg: number, distanceM: number): StrategyPoint {
    const radians = bearingDeg * Math.PI / 180;
    return {
        x: origin.x + Math.sin(radians) * distanceM,
        y: origin.y + Math.cos(radians) * distanceM,
    };
}

function toRow(
    sourceId: string,
    distance: ReturnType<typeof featureDistances>[number],
    position: StrategyPoint,
): BrowseLadderRow {
    return {
        id: `${sourceId}:${distance.kind}`,
        kind: distance.kind,
        label: distance.label,
        lineM: distance.lineM,
        playsAsM: distance.playsLikeM === null
            ? null
            : distance.playsLikeM + (distance.windDeltaM ?? 0),
        elevationDeltaM: distance.elevationDeltaM,
        windDeltaM: distance.windDeltaM,
        clubName: distance.club?.name ?? null,
        position,
    };
}
