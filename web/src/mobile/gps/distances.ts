import {
    buildBrowseLadder,
    type BrowseLadderRow,
    type BrowseHazardTarget,
    type BrowsePointTarget,
} from '../../planner/browse-ladder';
import { featureDistances, type StrategyPoint, type ClubSpec } from '../../../../shared/strategy';

export interface Wind { speedMps: number; directionDeg: number }

export interface HoleReadoutInput {
    /** Ball position (GPS fix, projected + elevation-sampled). */
    origin: StrategyPoint;
    /** Green reference points that exist (front/center/back), roles preset. */
    greenTargets: readonly BrowsePointTarget[];
    /** Plan aim/layup nodes for the hole (already projected). */
    planTargets?: readonly BrowsePointTarget[];
    /** Hazard rings (front + carry edges). */
    hazards?: readonly BrowseHazardTarget[];
    /** Reference line, normally origin → green centre (compass degrees). */
    bearingDeg: number;
    clubs?: readonly ClubSpec[];
    wind?: Wind;
}

export interface HoleReadouts {
    /** The three green numbers, in front→centre→back order (missing omitted). */
    green: BrowseLadderRow[];
    /** Plan target rungs, nearest first. */
    targets: BrowseLadderRow[];
    /** Hazard front/carry rungs, nearest first. */
    hazards: BrowseLadderRow[];
}

const GREEN_KINDS = new Set(['green_front', 'green_center', 'green_back']);
const GREEN_ORDER: Record<string, number> = { green_front: 0, green_center: 1, green_back: 2 };

/**
 * Assemble the on-course distance readouts from a GPS origin: the big green
 * numbers (front/middle/back), plan targets and hazard carries. A thin
 * partition over `buildBrowseLadder` (the same engine the desktop browse mode
 * uses), so plays-like / wind handling stays identical.
 */
export function buildHoleReadouts(input: HoleReadoutInput): HoleReadouts {
    const rows = buildBrowseLadder({
        origin: input.origin,
        points: [...input.greenTargets, ...(input.planTargets ?? [])],
        hazards: input.hazards,
        bearingDeg: input.bearingDeg,
        ...(input.wind ? { wind: input.wind } : {}),
        ...(input.clubs ? { clubs: input.clubs } : {}),
    });

    const green: BrowseLadderRow[] = [];
    const targets: BrowseLadderRow[] = [];
    const hazards: BrowseLadderRow[] = [];
    for (const row of rows) {
        if (GREEN_KINDS.has(row.kind)) green.push(row);
        else if (row.kind === 'hazard_front' || row.kind === 'hazard_carry') hazards.push(row);
        else targets.push(row);
    }
    green.sort((a, b) => (GREEN_ORDER[a.kind] ?? 9) - (GREEN_ORDER[b.kind] ?? 9));
    return { green, targets, hazards };
}

export interface PointDistance {
    lineM: number;
    playsAsM: number | null;
}

/**
 * Distance from the ball to an arbitrary tapped point — the "tap-anywhere"
 * readout. Uses the shared engine so plays-like matches the green numbers.
 */
export function pointDistance(
    origin: StrategyPoint,
    at: StrategyPoint,
    bearingDeg: number,
    wind?: Wind,
): PointDistance {
    const [row] = featureDistances({
        origin,
        targets: [{ kind: 'point', label: 'point', role: 'aim', at }],
        bearingDeg,
        ...(wind ? { wind } : {}),
    });
    if (!row) return { lineM: 0, playsAsM: null };
    return {
        lineM: row.lineM,
        playsAsM: row.playsLikeM === null ? null : row.playsLikeM + (row.windDeltaM ?? 0),
    };
}
