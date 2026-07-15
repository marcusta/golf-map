import {
    featureDistances,
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
