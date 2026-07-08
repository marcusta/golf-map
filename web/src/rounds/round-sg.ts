// Web adapter: RoundWithShots -> shared/strategy's strokes-gained core
// (shot-capture doc §5, T14). This is the purity-boundary seam every other
// planner adapter follows (lie-map.ts, green-slope.ts): shared/strategy
// never touches lat/lon or the feature store, so THIS module projects
// (geo/transform.ts) and classifies (the recorded `lie` override, or the
// same lieFromFeatureType/point-in-ring classification the aim engine uses)
// before handing an owned RecordedStroke[] to the pure core.
//
// Scope note: the shot-capture doc's hole position is "pin if a pin is
// recorded for the round's date, else green centre" (§5). Per-round pin
// history isn't wired yet (no round-dated pin lookup exists) — this adapter
// uses the green centre only. Revisit once round-dated pins exist; the pure
// core is agnostic to how the hole position was chosen.

import type { CourseFeature } from '../../../shared/api/course-features.gen';
import type { Green } from '../../../shared/api/greens.gen';
import type { Hole } from '../../../shared/api/holes.gen';
import type { RoundWithShots, Shot } from '../../../shared/api/rounds.gen';
import {
    lieFromFeatureType,
    type HoleRound,
    type Lie,
    type RecordedShotType,
    type RecordedStroke,
} from '../../../shared/strategy';
import { wgs84ToSweref99tm } from '../geo/transform';
import { buildLieMap, type LieMap } from '../planner/lie-map';

/** Per-hole context an adapter needs to classify a round's shots for SG. */
export interface RoundSgHoleContext {
    hole: Hole;
    /** The hole's green (for center position); null if unmapped. */
    green: Green | null;
    /** All course features (any hole) — buildLieMap resolves containment itself. */
    features: readonly CourseFeature[];
    /**
     * Hole id → number for the D24 stack rank (buildLieMap). Optional: omit
     * when features are single-group / course-level, in which case `sortOrder`
     * alone resolves the stack (see buildLieMap).
     */
    holeNumberById?: ReadonlyMap<string, number>;
}

/** shot_type as recorded in the schema (§3) narrowed to the core's taxonomy. */
function toRecordedShotType(shotType: string): RecordedShotType {
    return shotType === 'partial' || shotType === 'putt' || shotType === 'recovery'
        ? shotType
        : 'full';
}

/**
 * Classify one shot's lie: the recorded `lie` override wins (§3: "`lie`
 * stays the existing nullable column = user override"); the FIRST stroke of
 * a hole with no override is 'tee' (§5); otherwise fall back to the
 * geometry classification via the hole's lie map.
 */
function classifyShotLie(shot: Shot, isFirstOfHole: boolean, lieMap: LieMap | null, point: { x: number; y: number }): Lie {
    if (shot.lie) return lieFromFeatureType(shot.lie);
    if (isFirstOfHole) return 'tee';
    return lieMap ? lieMap.classifyLie(point) : 'rough';
}

/**
 * Build one hole's `HoleRound` (shared/strategy's owned input shape) from a
 * round's shots for that hole number + the hole's course-feature context.
 * Shots are taken in `sortOrder` order (the recording convention, §2) —
 * caller is responsible for having fetched shots for the right hole number.
 */
export function buildHoleRoundForSg(
    holeShots: readonly Shot[],
    ctx: RoundSgHoleContext,
): HoleRound | null {
    if (holeShots.length === 0 || !ctx.green) return null;

    const ordered = [...holeShots].sort((a, b) => a.sortOrder - b.sortOrder);
    const lieMap = buildLieMap(ctx.features, ctx.holeNumberById);
    const holeXy = wgs84ToSweref99tm(ctx.green.centerLat, ctx.green.centerLon);

    const strokes: RecordedStroke[] = ordered.map((shot, i) => {
        const xy = wgs84ToSweref99tm(shot.lat, shot.lon);
        const lie = classifyShotLie(shot, i === 0, lieMap, xy);
        return {
            position: xy,
            lie,
            penaltyStrokes: shot.penaltyStrokes,
            shotType: toRecordedShotType(shot.shotType),
        };
    });

    return { par: ctx.hole.par, hole: holeXy, strokes };
}

/** Group a round's shots by hole number, preserving each group's recorded order. */
export function groupShotsByHole(round: RoundWithShots): Map<number, Shot[]> {
    const byHole = new Map<number, Shot[]>();
    for (const shot of round.shots) {
        const list = byHole.get(shot.holeNumber);
        if (list) list.push(shot);
        else byHole.set(shot.holeNumber, [shot]);
    }
    for (const list of byHole.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    return byHole;
}

/**
 * Build every hole's `HoleRound` for a round, given the course's holes/
 * greens/features. Holes with no shots, or no mapped green, are omitted
 * (SG needs a hole position; there is nothing to compute without one).
 */
export function buildRoundForSg(
    round: RoundWithShots,
    holesByNumber: ReadonlyMap<number, Hole>,
    greenByHoleId: ReadonlyMap<string, Green>,
    features: readonly CourseFeature[],
): HoleRound[] {
    const byHole = groupShotsByHole(round);
    const holeNumberById = new Map<string, number>();
    for (const [number, hole] of holesByNumber) holeNumberById.set(hole.id, number);
    const out: HoleRound[] = [];
    for (const [holeNumber, shots] of byHole) {
        const hole = holesByNumber.get(holeNumber);
        if (!hole) continue;
        const green = greenByHoleId.get(hole.id) ?? null;
        const holeRound = buildHoleRoundForSg(shots, { hole, green, features, holeNumberById });
        if (holeRound) out.push(holeRound);
    }
    return out;
}
