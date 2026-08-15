import {
    clubAdvice,
    featureDistances,
    gatedForwardRoutePoints,
    hazardsNearLines,
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
    /**
     * Corridor half-width for this ring when `lines` are supplied (corridor
     * mode): the current hole's OWN hazards get the wide corridor, other
     * holes' the narrow one (iOS own/foreign split). Default 35.
     */
    corridorHalfWidthM?: number;
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
    /**
     * Play-line polylines (routed origin → aims → green, plus the direct
     * origin → green line). When supplied, hazards are measured with the
     * iOS-parity corridor projection (`hazardsNearLines`): a bunker BESIDE
     * the line still rungs, side-tagged ("L Bunker"), with front/carry as its
     * chainage window. Without it, the legacy thin-ray cast applies (only
     * rings the bearing line actually crosses).
     */
    lines?: readonly (readonly StrategyPoint[])[];
}

/**
 * Feature types shown as ladder carry rungs — the true carries a player reads
 * off the line (mirror of iOS `HazardCarries.displayedTypes`; ground types
 * like deep_rough/trees are omitted so the ladder stays about carries).
 */
export const LADDER_CARRY_TYPES: ReadonlySet<string> = new Set([
    'bunker', 'water', 'water_creek', 'penalty_yellow', 'penalty_red',
]);

/** Corridor half-width for the current hole's own hazards (iOS parity). */
export const OWN_HAZARD_CORRIDOR_HALF_WIDTH_M = 400;
/** Corridor half-width for other holes' hazards — only genuinely in-play ones. */
export const FOREIGN_HAZARD_CORRIDOR_HALF_WIDTH_M = 35;
/** How far past a line's end a hazard still counts (greenside bunkers). */
export const HAZARD_EXTRA_AHEAD_M = 40;
/** Max hazard rings per corridor group (iOS caps own 8 / foreign 4). */
const CORRIDOR_GROUP_CAP = 8;

export type BrowseTargetActivation = 'inspect' | 'promote-origin';

/**
 * Hazard rungs are capped at the furthest point target (normally green back)
 * plus this margin, so a behind-the-green bunker still shows but hazards on
 * far-away holes (whose rings the lie map also carries) never rank as
 * 900+ m "carries" that no shot from this hole could mean.
 */
export const HAZARD_LADDER_MARGIN_M = 20;

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

    const corridorLines = (input.lines ?? []).filter(line => line.length >= 2);
    if (corridorLines.length > 0) {
        rows.push(...corridorHazardRows(corridorLines, input.hazards ?? [], input.clubs));
        return rows.sort((a, b) => a.lineM - b.lineM || a.id.localeCompare(b.id));
    }

    // Ray fallback (no play lines supplied): cap hazard rungs at the furthest
    // point target (green back / last aim) — nothing farther than the hole
    // itself is a meaningful rung. Only applies when there IS a point target
    // to define the hole's reach. (Corridor mode is gated by the lines' own
    // length + HAZARD_EXTRA_AHEAD_M instead.)
    const pointCapM = rows.length > 0
        ? Math.max(...rows.map(r => r.lineM)) + HAZARD_LADDER_MARGIN_M
        : Infinity;

    for (const hazard of input.hazards ?? []) {
        const distances = featureDistances({
            origin: input.origin,
            targets: [{ kind: 'hazard', label: hazard.label, ring: hazard.ring }],
            bearingDeg: input.bearingDeg,
            wind: input.wind,
            clubs: input.clubs,
        });
        for (const distance of distances) {
            if (distance.lineM > pointCapM) continue;
            const position = projectAlong(input.origin, distance.bearingDeg, distance.lineM);
            rows.push(toRow(hazard.id, distance, position));
        }
    }

    return rows.sort((a, b) => a.lineM - b.lineM || a.id.localeCompare(b.id));
}

/**
 * Corridor-mode hazard rungs: group targets by their corridor half-width
 * (own vs foreign, iOS parity), project each group's rings onto the play
 * lines, and expand every hit into side-tagged front/carry rows. Hazard rows
 * carry no elevation/wind figures (the ring edges are not DEM-sampled —
 * same contract as the ray path); the club is priced on the raw line
 * distance, as `featureDistances` does when plays-like is unresolved.
 */
function corridorHazardRows(
    lines: readonly (readonly StrategyPoint[])[],
    hazards: readonly BrowseHazardTarget[],
    clubs: readonly ClubSpec[] | undefined,
): BrowseLadderRow[] {
    const groups = new Map<number, BrowseHazardTarget[]>();
    for (const hazard of hazards) {
        const width = hazard.corridorHalfWidthM ?? FOREIGN_HAZARD_CORRIDOR_HALF_WIDTH_M;
        const group = groups.get(width);
        if (group) group.push(hazard);
        else groups.set(width, [hazard]);
    }

    const rows: BrowseLadderRow[] = [];
    for (const [corridorHalfWidthM, group] of groups) {
        const targetByRing = new Map(group.map(h => [h.ring, h]));
        const hits = hazardsNearLines(lines, group.map(h => h.ring), {
            corridorHalfWidthM,
            extraAheadM: HAZARD_EXTRA_AHEAD_M,
            cap: CORRIDOR_GROUP_CAP,
        });
        for (const hit of hits) {
            const target = targetByRing.get(hit.ring);
            if (!target) continue;
            const prefix = hit.side === 'left' ? 'L ' : hit.side === 'right' ? 'R ' : '';
            rows.push(
                corridorRow(`${target.id}:hazard_front`, 'hazard_front',
                    `${prefix}${target.label} front`, hit.frontM, hit.frontPoint, clubs),
                corridorRow(`${target.id}:hazard_carry`, 'hazard_carry',
                    `${prefix}${target.label} carry`, hit.carryM, hit.carryPoint, clubs),
            );
        }
    }
    return rows;
}

function corridorRow(
    id: string,
    kind: BrowseLadderKind,
    label: string,
    lineM: number,
    position: StrategyPoint,
    clubs: readonly ClubSpec[] | undefined,
): BrowseLadderRow {
    const club = clubs && clubs.length > 0 ? clubAdvice(clubs, lineM).center : undefined;
    return {
        id,
        kind,
        label,
        lineM,
        playsAsM: null,
        elevationDeltaM: null,
        windDeltaM: null,
        clubName: club?.name ?? null,
        position,
    };
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
