// The tees placed from the scorecard's lengths (`tee_set_lengths`, ScorecardService):
// Furniture mode's "Place tees" and `bun run tees:place` are this service. Each
// set's tee goes where its length, run back along the line of play (tee -> aim
// points -> green centre), crosses a drawn tee shape; the geometry and which shape
// wins: shared/features/tee-placement.ts.
//
// Propose writes nothing. A hole's set without a tee is `place` (accept writes it
// by default); a tee within OK_M of its length is `ok`; the rest need a look and
// are written only when asked for by key: `off` (a tee that is not at its length),
// `ambiguous` (two tee shapes nearly in line, or the only one is another hole's),
// `missed` (no tee shape at the length: the spot on the line back, to draw one at). The hole's line back comes
// from its back tee, else its tee shapes, so a course with one tee per hole (the
// v1 import's "default") already has one.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/schema';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { flattenRing, wgs84ToSweref99tm, sweref99tmToWgs84, type FeatureGeometry } from './geo';
import type { AnalysisService } from './analysis.service';
import {
    OK_M, arcPoints, lineFromFirst, placeTee, teeLength,
    type PlacementHole, type PlacementShape, type Xy,
} from '../../shared/features/tee-placement';

export type TeeSpotOutcome = 'place' | 'ok' | 'off' | 'ambiguous' | 'missed' | 'too-short' | 'no-green';

/** One hole's tee of one set. */
export interface TeeSpot {
    /** `<holeId>:<teeSetId>`: what accept takes. */
    key: string;
    holeId: string;
    holeNumber: number;
    teeSetId: string;
    setName: string;
    color: string | null;
    /** The scorecard's length, metres. */
    lengthM: number;
    outcome: TeeSpotOutcome;
    /** The set's tee on the hole now, and its length as the card measures it. */
    teeId: string | null;
    currentLengthM: number | null;
    /** The proposed spot, [lon, lat]; null when there is none. */
    at: [number, number] | null;
    /** Where the tee is now, [lon, lat]. */
    from: [number, number] | null;
    /** How far accept would move the tee there now. */
    moveM: number | null;
    /** The tee shape the spot is on. */
    shapeId: string | null;
    /** For a spot that needs a look: the circle of its length near it, [lon, lat][]. */
    arc: [number, number][] | null;
    /** What needs a look, in a few words. */
    reason: string | null;
}

export interface TeePlacementProposal {
    courseId: string;
    spots: TeeSpot[];
    counts: { place: number; ok: number; off: number; ambiguous: number; missed: number; skipped: number };
    /** Tee sets with lengths on the course. */
    sets: number;
}

export interface TeePlacementResult {
    placed: number;
    moved: number;
    dryRun: boolean;
    spots: { key: string; holeNumber: number; setName: string; action: 'place' | 'move'; moveM: number | null }[];
}

/** Outcomes accept can write when asked for by key. */
const WRITABLE: readonly TeeSpotOutcome[] = ['place', 'off', 'ambiguous', 'missed'];
/** Flattening tolerance for the tee shapes: a tee box is a few metres across. */
const FLATTEN_M = 0.1;
/** Half the arc drawn round a spot that needs a look, radians. */
const ARC_HALF = (20 * Math.PI) / 180;

/** A course's holes, tees, tee shapes and lengths, as the placement reads them. */
export interface PlacementCourse {
    holes: { id: string; number: number; geo: PlacementHole; tees: { id: string; teeSetId: string | null; xy: Xy; version: number }[] }[];
    shapes: PlacementShape[];
    sets: { id: string; name: string; color: string | null; sortOrder: number; lengths: Map<string, number> }[];
}

export class TeePlacementService {
    constructor(private deps: { db: Kysely<Database>; analysis?: AnalysisService }) {}

    /** Every hole's tee of every set with a length: where it goes and what needs a look. Writes nothing. */
    async propose(courseId: string): Promise<TeePlacementProposal> {
        const course = await this.load(courseId);
        const numberOf = new Map(course.holes.map((h) => [h.id, h.number]));
        const spots: TeeSpot[] = [];
        for (const set of course.sets) {
            for (const hole of course.holes) {
                const lengthM = set.lengths.get(hole.id);
                if (lengthM === undefined) continue;
                spots.push(this.spot(hole, set, lengthM, course.shapes, numberOf));
            }
        }
        spots.sort((a, b) => a.holeNumber - b.holeNumber || order(course, a.teeSetId) - order(course, b.teeSetId));
        const count = (o: TeeSpotOutcome) => spots.filter((s) => s.outcome === o).length;
        return {
            courseId, spots, sets: course.sets.filter((s) => s.lengths.size).length,
            counts: {
                place: count('place'), ok: count('ok'), off: count('off'), ambiguous: count('ambiguous'),
                missed: count('missed'), skipped: count('too-short') + count('no-green'),
            },
        };
    }

    /**
     * Write the tees: every `place` of a fresh proposal, or exactly the spots in `keys` (any with a spot: an `off`
     * tee moves, an `ambiguous` or `missed` one is placed where proposed). One transaction; each hole's tees then
     * sort in set order. Heights from the DEM when the course has one.
     */
    async accept(courseId: string, opts: { keys?: string[]; dryRun?: boolean } = {}): Promise<TeePlacementResult> {
        const { spots } = await this.propose(courseId);
        let chosen: TeeSpot[];
        if (opts.keys) {
            const byKey = new Map(spots.map((s) => [s.key, s]));
            chosen = opts.keys.map((key) => {
                const spot = byKey.get(key);
                if (!spot) throw new ConflictError(`${key} is not a hole and tee set with a length`);
                if (!spot.at || !WRITABLE.includes(spot.outcome)) {
                    throw new ConflictError(`Hole ${spot.holeNumber} ${spot.setName}: ${spot.outcome}${spot.reason ? ` (${spot.reason})` : ''}, nothing to write`);
                }
                return spot;
            });
        } else {
            chosen = spots.filter((s) => s.outcome === 'place');
        }
        const result: TeePlacementResult = {
            placed: chosen.filter((s) => !s.teeId).length,
            moved: chosen.filter((s) => s.teeId).length,
            dryRun: !!opts.dryRun,
            spots: chosen.map((s) => ({ key: s.key, holeNumber: s.holeNumber, setName: s.setName, action: s.teeId ? 'move' : 'place', moveM: s.moveM })),
        };
        if (opts.dryRun || !chosen.length) return result;

        const heights = await this.heights(courseId, chosen.map((s) => s.at!));
        const { db } = this.deps;
        const sets = await db.selectFrom('course_tee_sets').select(['id', 'name', 'color', 'gspro_only', 'sort_order'])
            .where('course_id', '=', courseId).execute();
        const setById = new Map(sets.map((s) => [s.id, s]));
        await db.transaction().execute(async (trx) => {
            for (const [i, spot] of chosen.entries()) {
                const [lon, lat] = spot.at!;
                const elevation = heights[i] ?? null;
                if (spot.teeId) {
                    await trx.updateTable('tees')
                        .set({ lat, lon, elevation, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                        .where('id', '=', spot.teeId).execute();
                } else {
                    const set = setById.get(spot.teeSetId)!;
                    await trx.insertInto('tees').values({
                        id: crypto.randomUUID(), hole_id: spot.holeId, tee_set_id: set.id, name: set.name, color: set.color,
                        gspro_only: set.gspro_only, lat, lon, elevation, sort_order: 0, version: 1,
                    }).execute();
                }
            }
            // Each touched hole's tees in set order (White before Yellow …), tees without a set last.
            for (const holeId of new Set(chosen.map((s) => s.holeId))) {
                const tees = await trx.selectFrom('tees').select(['id', 'tee_set_id', 'sort_order']).where('hole_id', '=', holeId).execute();
                const rank = (t: { tee_set_id: string | null }) => setById.get(t.tee_set_id ?? '')?.sort_order ?? Number.MAX_SAFE_INTEGER;
                const sorted = [...tees].sort((a, b) => rank(a) - rank(b) || a.sort_order - b.sort_order);
                for (const [k, t] of sorted.entries()) {
                    if (t.sort_order !== k) await trx.updateTable('tees').set({ sort_order: k }).where('id', '=', t.id).execute();
                }
            }
        });
        return result;
    }

    /** The course as the placement reads it: holes with their line and tees, the tee shapes, the sets' lengths. */
    async load(courseId: string): Promise<PlacementCourse> {
        const { db } = this.deps;
        const course = await db.selectFrom('courses').select('id').where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        // A drawing group is a hole row too (an SVG layer, no furniture): never a hole here.
        const holeRows = await db.selectFrom('holes').select(['id', 'number'])
            .where('course_id', '=', courseId).where('drawing_group_name', 'is', null).orderBy('number').execute();
        const ids = holeRows.length ? holeRows.map((h) => h.id) : [''];
        const [tees, aims, greens, shapeRows, setRows, lengthRows] = await Promise.all([
            db.selectFrom('tees').select(['id', 'hole_id', 'tee_set_id', 'lat', 'lon', 'version']).where('hole_id', 'in', ids).orderBy('sort_order').execute(),
            db.selectFrom('aim_points').select(['hole_id', 'lat', 'lon']).where('hole_id', 'in', ids).orderBy('sort_order').execute(),
            db.selectFrom('greens').select(['hole_id', 'center_lat', 'center_lon']).where('hole_id', 'in', ids).execute(),
            db.selectFrom('course_features').select(['id', 'hole_id', 'geometry_json']).where('course_id', '=', courseId).where('type', '=', 'tee').execute(),
            db.selectFrom('course_tee_sets').select(['id', 'name', 'color', 'sort_order']).where('course_id', '=', courseId).orderBy('sort_order').orderBy('name').execute(),
            db.selectFrom('tee_set_lengths').innerJoin('course_tee_sets', 'course_tee_sets.id', 'tee_set_lengths.tee_set_id')
                .select(['tee_set_lengths.tee_set_id', 'tee_set_lengths.hole_id', 'tee_set_lengths.length_m'])
                .where('course_tee_sets.course_id', '=', courseId).execute(),
        ]);
        const holes = holeRows.map((h) => {
            const green = greens.find((g) => g.hole_id === h.id);
            const own = tees.filter((t) => t.hole_id === h.id).map((t) => ({ id: t.id, teeSetId: t.tee_set_id, xy: toXy(t.lat, t.lon), version: t.version }));
            const geo: PlacementHole = {
                id: h.id,
                aims: aims.filter((a) => a.hole_id === h.id).map((a) => toXy(a.lat, a.lon)),
                green: green?.center_lat != null && green.center_lon != null ? toXy(green.center_lat, green.center_lon) : null,
                tees: own.map((t) => t.xy),
            };
            return { id: h.id, number: h.number, geo, tees: own };
        });
        const shapes = shapeRows.flatMap((row): PlacementShape[] => {
            const geometry = JSON.parse(row.geometry_json) as FeatureGeometry;
            const outer = geometry.crs === 'EPSG:3006' ? geometry.rings[0] : undefined;
            return outer ? [{ id: row.id, holeId: row.hole_id, ring: flattenRing(outer, FLATTEN_M, geometry.curveType) as Xy[] }] : [];
        });
        const sets = setRows.map((s) => ({
            id: s.id, name: s.name, color: s.color, sortOrder: s.sort_order,
            lengths: new Map(lengthRows.filter((l) => l.tee_set_id === s.id).map((l) => [l.hole_id, l.length_m])),
        }));
        return { holes, shapes, sets };
    }

    private spot(
        hole: PlacementCourse['holes'][number], set: PlacementCourse['sets'][number], lengthM: number,
        shapes: PlacementShape[], numberOf: Map<string, number>,
    ): TeeSpot {
        const tee = hole.tees.find((t) => t.teeSetId === set.id) ?? null;
        const current = tee ? teeLength(hole.geo, tee.xy) : null;
        const base = {
            key: `${hole.id}:${set.id}`, holeId: hole.id, holeNumber: hole.number, teeSetId: set.id, setName: set.name, color: set.color,
            lengthM, teeId: tee?.id ?? null, currentLengthM: current === null ? null : round1(current),
            from: tee ? toLonLat(tee.xy) : null, at: null, moveM: null, shapeId: null, arc: null, reason: null,
        };
        const placement = placeTee(hole.geo, lengthM, shapes);
        if (placement.kind === 'no-green') return { ...base, outcome: 'no-green', reason: 'No green centre' };
        if (placement.kind === 'too-short') {
            const rest = lineFromFirst(hole.geo)!.rest;
            return { ...base, outcome: 'too-short', reason: `${Math.round(lengthM)} m is shorter than the line from the first aim point (${Math.round(rest)} m)` };
        }
        if (tee && current !== null && Math.abs(current - lengthM) <= OK_M) return { ...base, outcome: 'ok' };
        const spot = placement.spot;
        const at = spot ? spot.xy : null;
        const moveM = tee && at ? round1(Math.hypot(at[0] - tee.xy[0], at[1] - tee.xy[1])) : null;
        const otherHole = placement.kind === 'spot' ? placement.otherHole : null;
        const outcome: TeeSpotOutcome = placement.kind === 'missed' ? 'missed' : placement.ambiguous || otherHole ? 'ambiguous' : tee ? 'off' : 'place';
        const reason = outcome === 'missed'
            ? (at ? `No tee shape at ${Math.round(lengthM)} m` : `No tee shape at ${Math.round(lengthM)} m, and no tee or tee shape on the hole to say where`)
            : otherHole ? `On hole ${numberOf.get(otherHole) ?? '?'}'s tee shape`
                : outcome === 'ambiguous' ? `${placement.kind === 'spot' ? placement.alternatives.length + 1 : 2} tee shapes nearly in line at ${Math.round(lengthM)} m`
                    : outcome === 'off' ? `Is ${Math.round(current!)} m, the card says ${Math.round(lengthM)} m` : null;
        const needsLook = outcome === 'missed' || outcome === 'ambiguous' || outcome === 'off';
        return {
            ...base, outcome, at: at ? toLonLat(at) : null, moveM, shapeId: spot?.shapeId ?? null, reason,
            arc: needsLook && at ? this.arc(hole.geo, lengthM, at) : null,
        };
    }

    /** The circle of the length near the spot, for the map. */
    private arc(hole: PlacementHole, lengthM: number, at: Xy): [number, number][] | null {
        const line = lineFromFirst(hole);
        if (!line) return null;
        const mid = Math.atan2(at[1] - line.first[1], at[0] - line.first[0]);
        return arcPoints(line.first, lengthM - line.rest, mid - ARC_HALF, 2 * ARC_HALF).map(toLonLat);
    }

    private async heights(courseId: string, at: [number, number][]): Promise<(number | null)[]> {
        if (!this.deps.analysis) return at.map(() => null);
        try {
            return await this.deps.analysis.sampleElevations(courseId, at.map(([lon, lat]) => {
                const p = wgs84ToSweref99tm(lat, lon);
                return { e: p.x, n: p.y };
            }));
        } catch {
            // No DEM for the course yet: the tees go in without a height, as a hand-placed one off the map does.
            return at.map(() => null);
        }
    }
}

function order(course: PlacementCourse, setId: string): number {
    return course.sets.findIndex((s) => s.id === setId);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function toXy(lat: number, lon: number): Xy {
    const p = wgs84ToSweref99tm(lat, lon);
    return [p.x, p.y];
}

function toLonLat([x, y]: Xy): [number, number] {
    const p = sweref99tmToWgs84(x, y);
    return [p.lon, p.lat];
}
