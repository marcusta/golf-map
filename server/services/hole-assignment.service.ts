// Drawn shapes onto their holes, from the holes' furniture (tees, aim points,
// green centre): the Draw mode's "Assign to holes" and `bun run holes:assign` are
// this service. A course drawn before its holes were laid out has every shape in
// Others, and the SVG then names them all others_<n> in one layer; on its holes
// they get hole_<n>_<id> names and the hole's layer. How a shape is matched:
// shared/features/hole-assignment.ts.
//
// Only shapes in Others (no hole, not in the Roughs group) are looked at; a shape
// already on a hole is the drawer's call and stays. Every hole on the course's
// site takes part, so a shape on a sibling course's hole (Landeryd Classic beside
// Masters) is reported as that course's and never put on this one. An ordinary
// rough goes into the Roughs group, whichever hole it lies on (Marcus,
// 2026-10-20): a hole's rough would otherwise lie over a lower hole's tees in the
// SVG, where a higher hole's layer is cut out of the lower ones. A rough island -
// a rough the semi (or fairway) encloses - belongs on its hole instead, above the
// semi; down in Roughs it would be covered. An island already in Roughs goes onto
// its hole, or (on another course's hole, or between holes) back to Others, on top.
//
// Accept keeps the order the shapes had in Others: on a hole (and in Roughs) the
// moved shapes go above what is there, in the order they were drawn - a semi
// drawn over a fairway stays over it, which the type-rank slot of a single move
// would undo.
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { NotFoundError } from '@basics/core/server/auth';
import { flattenRing, wgs84ToSweref99tm, sweref99tmToWgs84, type FeatureGeometry } from './geo';
import type { CourseFeaturesService } from './course-features.service';
import { ENCLOSING_TYPES, isIsland, matchHole, outerRing, playLine, type AssignHole, type Xy } from '../../shared/features/hole-assignment';
import { ROUGHS_LAYER } from '../../shared/render/stack-key';
import { ROAD_JUNCTIONS_SOURCE } from '../../shared/features/road-junctions';

/** Feature types accept puts into the Roughs group instead of on a hole. */
export const TO_ROUGHS_TYPES: readonly string[] = ['rough'];
/** move()'s target for Others (course level, no layer). */
const OTHERS = 'others';
/** The proposals accept writes. */
const isMove = (p: HoleProposal) => p.outcome === 'assign' || p.outcome === 'roughs' || p.outcome === 'others';

/** What one shape in Others would get. */
export interface HoleProposal {
    featureId: string;
    featureNo: number | null;
    type: string;
    /**
     * `assign`: onto `holeNumber` of this course (what accept writes);
     * `roughs`: an ordinary rough, into the Roughs group (accept writes it too);
     * `others`: a rough island in Roughs that is not on this course's hole, back to Others on top;
     * `other-course`: it lies on `courseName`'s hole `holeNumber`, left alone;
     * `ambiguous` / `none`: stays in Others, `reason` says why.
     */
    outcome: 'assign' | 'roughs' | 'others' | 'other-course' | 'ambiguous' | 'none';
    holeId: string | null;
    holeNumber: number | null;
    courseName: string | null;
    /** Share of the shape's points on that hole's play line, 0..1. */
    share: number | null;
    /** A rough island (enclosed by semi/fairway): accept puts it on top of its hole, over what encloses it. */
    island: boolean;
    reason: string | null;
}

/** A hole's play line, for the map: back tee -> aim points -> green centre. */
export interface HolePlayLine {
    holeId: string;
    courseId: string;
    number: number;
    /** [lon, lat] pairs. */
    line: [number, number][];
}

export interface HoleAssignmentProposal {
    courseId: string;
    proposals: HoleProposal[];
    lines: HolePlayLine[];
    counts: { assign: number; roughs: number; others: number; otherCourse: number; ambiguous: number; none: number };
}

export interface HoleAssignmentResult {
    assigned: number;
    /** Ordinary roughs put into the Roughs group. */
    roughs: number;
    /** Rough islands taken out of Roughs back to Others. */
    others: number;
    dryRun: boolean;
    /** featureId -> hole number written (or that would be). */
    holes: { featureId: string; featureNo: number | null; holeNumber: number }[];
}

/** Flattening tolerance for the vote: a metre is far below the 70 m corridor. */
const FLATTEN_M = 1;

export class HoleAssignmentService {
    constructor(private deps: { db: Kysely<Database>; courseFeatures: CourseFeaturesService }) {}

    /** What each shape in Others (and each rough island in Roughs) would get. Writes nothing. */
    async propose(courseId: string): Promise<HoleAssignmentProposal> {
        const { db } = this.deps;
        const course = await db.selectFrom('courses').select(['id', 'site_id']).where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        const courses = course.site_id
            ? await db.selectFrom('courses').select(['id', 'name']).where('site_id', '=', course.site_id).execute()
            : await db.selectFrom('courses').select(['id', 'name']).where('id', '=', courseId).execute();
        const courseName = new Map(courses.map((c) => [c.id, c.name]));
        const holes = await this.holes(courses.map((c) => c.id));
        const byId = new Map(holes.map((h) => [h.id, h]));

        const all = await db.selectFrom('course_features')
            .select(['id', 'type', 'geometry_json', 'feature_no', 'hole_id', 'layer'])
            .where('course_id', '=', courseId).orderBy('feature_no').execute();
        const ringsOf = (row: { geometry_json: string }): Xy[][] => {
            const geometry = JSON.parse(row.geometry_json) as FeatureGeometry;
            return geometry.crs === 'EPSG:3006' ? geometry.rings.map((r) => flattenRing(r, FLATTEN_M, geometry.curveType) as Xy[]) : [];
        };
        const enclosers = all.filter((r) => ENCLOSING_TYPES.includes(r.type))
            .map((r) => outerRing(ringsOf(r))).filter((r): r is Xy[] => !!r);
        const proposals: HoleProposal[] = [];
        for (const row of all) {
            if (row.hole_id !== null) continue;
            const inRoughs = row.layer === ROUGHS_LAYER;
            const toRoughs = TO_ROUGHS_TYPES.includes(row.type);
            if (inRoughs && !toRoughs) continue;
            const rings = ringsOf(row);
            const island = toRoughs && isIsland(rings, enclosers);
            // In Roughs only an island is looked at: onto its hole, else back to Others.
            if (inRoughs && !island) continue;
            const m = matchHole({ id: row.id, type: row.type, rings }, holes);
            const base = { featureId: row.id, featureNo: row.feature_no, type: row.type };
            if (inRoughs && !(m.kind === 'hole' && byId.get(m.holeId)!.courseId === courseId)) {
                proposals.push({ ...base, outcome: 'others', holeId: null, holeNumber: null, courseName: null, share: null, reason: null, island });
            } else if (toRoughs && !island) {
                proposals.push({ ...base, outcome: 'roughs', holeId: null, holeNumber: null, courseName: null, share: null, reason: null, island: false });
            } else if (m.kind === 'hole') {
                const hole = byId.get(m.holeId)!;
                const own = hole.courseId === courseId;
                proposals.push({
                    ...base, outcome: own ? 'assign' : 'other-course', holeId: hole.id, holeNumber: hole.number,
                    courseName: courseName.get(hole.courseId) ?? null, share: m.share, reason: null, island,
                });
            } else {
                const reason = m.kind === 'ambiguous'
                    ? `${m.reason}: ${m.holeIds.map((id) => byId.get(id)).filter(Boolean).map((h) => label(h!, courseId, courseName)).join(', ')}`
                    : m.reason;
                proposals.push({ ...base, outcome: m.kind, holeId: null, holeNumber: null, courseName: null, share: null, reason, island });
            }
        }
        const lines = holes.flatMap((h) => {
            const line = playLine(h);
            return line ? [{ holeId: h.id, courseId: h.courseId, number: h.number, line: line.map(toLonLat) }] : [];
        });
        const count = (o: HoleProposal['outcome']) => proposals.filter((p) => p.outcome === o).length;
        return {
            courseId, proposals, lines,
            counts: { assign: count('assign'), roughs: count('roughs'), others: count('others'), otherCourse: count('other-course'), ambiguous: count('ambiguous'), none: count('none') },
        };
    }

    /**
     * Put the proposed shapes on their holes and the ordinary roughs into Roughs:
     * every `assign`/`roughs` of a fresh proposal, or only those in `featureIds`.
     * One updateMany (history kept), then each group they went to is restacked so
     * they keep their order from Others, above what the group held.
     */
    async accept(courseId: string, opts: { featureIds?: string[]; dryRun?: boolean } = {}): Promise<HoleAssignmentResult> {
        const { proposals } = await this.propose(courseId);
        const wanted = opts.featureIds ? new Set(opts.featureIds) : null;
        const chosen = proposals.filter((p) => isMove(p) && (!wanted || wanted.has(p.featureId)));
        const toHoles = chosen.filter((p) => p.outcome === 'assign');
        const holes = toHoles.map((p) => ({ featureId: p.featureId, featureNo: p.featureNo, holeNumber: p.holeNumber! }));
        const result = {
            assigned: toHoles.length, roughs: chosen.filter((p) => p.outcome === 'roughs').length,
            others: chosen.filter((p) => p.outcome === 'others').length, dryRun: !!opts.dryRun, holes,
        };
        if (opts.dryRun || !chosen.length) return result;
        await this.move(courseId, chosen.map((p) => ({
            featureId: p.featureId, to: p.outcome === 'assign' ? p.holeId! : p.outcome === 'roughs' ? ROUGHS_LAYER : OTHERS, top: p.island,
        })));
        return result;
    }

    /**
     * Move shapes `to` a hole (its id), Roughs (ROUGHS_LAYER) or Others (OTHERS),
     * keeping their order: in each group they reach they go above what it held, in
     * the order they had; `top` ones (rough islands) above all of them, over the
     * semi that encloses them.
     */
    async move(courseId: string, moves: { featureId: string; to: string; top?: boolean }[]): Promise<void> {
        if (!moves.length) return;
        const { db, courseFeatures } = this.deps;
        const before = await db.selectFrom('course_features').select(['id', 'version', 'hole_id', 'layer', 'sort_order'])
            .where('id', 'in', moves.map((m) => m.featureId)).execute();
        const row = new Map(before.map((r) => [r.id, r]));
        // The order they had: by group (Roughs, holes, Others, bottom to top as the app stacks them), then sort order.
        const rank = (r: { hole_id: string | null; layer: string | null }) => (r.layer === ROUGHS_LAYER ? 0 : r.hole_id ? 1 : 2);
        const was = [...moves].sort((a, b) => {
            const ra = row.get(a.featureId)!, rb = row.get(b.featureId)!;
            return rank(ra) - rank(rb) || (ra.hole_id ?? '').localeCompare(rb.hole_id ?? '') || ra.sort_order - rb.sort_order;
        }).map((m) => m.featureId);
        const target = (to: string) => (to === ROUGHS_LAYER ? { holeId: null, layer: ROUGHS_LAYER } : to === OTHERS ? { holeId: null, layer: null } : { holeId: to, layer: null });
        await courseFeatures.updateMany(moves.map((m) => ({ id: m.featureId, version: row.get(m.featureId)!.version, ...target(m.to) })));
        for (const group of new Set(moves.map((m) => m.to))) {
            const { holeId, layer } = target(group);
            let q = db.selectFrom('course_features').select(['id', 'source', 'generated']).where('course_id', '=', courseId);
            q = holeId ? q.where('hole_id', '=', holeId) : q.where('hole_id', 'is', null);
            q = layer ? q.where('layer', '=', layer) : q.where('layer', 'is', null);
            // Stored kerb fillets ride along behind their road (CourseFeaturesService.reorder).
            const members = (await q.orderBy('sort_order').orderBy('id').execute())
                .filter((r) => !(r.source === ROAD_JUNCTIONS_SOURCE && r.generated)).map((r) => r.id);
            const moved = new Set(moves.filter((m) => m.to === group).map((m) => m.featureId));
            const top = new Set(moves.filter((m) => m.top).map((m) => m.featureId));
            await courseFeatures.reorder(courseId, holeId, [
                ...members.filter((id) => !moved.has(id)),
                ...was.filter((id) => moved.has(id) && !top.has(id)),
                ...was.filter((id) => moved.has(id) && top.has(id)),
            ], layer);
        }
    }

    /**
     * The hole each new shape (not drawn yet: a proposal) would go on, by the same rules as `propose`: one of this
     * course's holes, or null (another course's hole, ambiguous, none). Rings in EPSG:3006 metres.
     */
    async holesFor(courseId: string, shapes: { id: string; type: string; rings: Xy[][] }[]): Promise<Map<string, { holeId: string; holeNumber: number } | null>> {
        const { db } = this.deps;
        const course = await db.selectFrom('courses').select(['id', 'site_id']).where('id', '=', courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${courseId} not found`);
        const courseIds = course.site_id
            ? (await db.selectFrom('courses').select('id').where('site_id', '=', course.site_id).execute()).map((c) => c.id)
            : [courseId];
        const holes = await this.holes(courseIds);
        const byId = new Map(holes.map((h) => [h.id, h]));
        return new Map(shapes.map((s) => {
            const m = matchHole(s, holes);
            const hole = m.kind === 'hole' ? byId.get(m.holeId)! : null;
            return [s.id, hole && hole.courseId === courseId ? { holeId: hole.id, holeNumber: hole.number } : null];
        }));
    }

    private async holes(courseIds: string[]): Promise<AssignHole[]> {
        const { db } = this.deps;
        if (!courseIds.length) return [];
        // A drawing group is a hole row too (an SVG layer, no furniture): never a hole here.
        const holes = await db.selectFrom('holes').select(['id', 'course_id', 'number'])
            .where('course_id', 'in', courseIds).where('drawing_group_name', 'is', null).orderBy('number').execute();
        if (!holes.length) return [];
        const ids = holes.map((h) => h.id);
        const [tees, aims, greens] = await Promise.all([
            db.selectFrom('tees').select(['hole_id', 'lat', 'lon']).where('hole_id', 'in', ids).execute(),
            db.selectFrom('aim_points').select(['hole_id', 'lat', 'lon']).where('hole_id', 'in', ids).orderBy('sort_order').execute(),
            db.selectFrom('greens').select(['hole_id', 'center_lat', 'center_lon']).where('hole_id', 'in', ids).execute(),
        ]);
        return holes.map((h) => {
            const green = greens.find((g) => g.hole_id === h.id);
            return {
                id: h.id, courseId: h.course_id, number: h.number,
                tees: tees.filter((t) => t.hole_id === h.id).map((t) => toXy(t.lat, t.lon)),
                aims: aims.filter((a) => a.hole_id === h.id).map((a) => toXy(a.lat, a.lon)),
                green: green?.center_lat != null && green.center_lon != null ? toXy(green.center_lat, green.center_lon) : null,
            };
        });
    }
}

function toXy(lat: number, lon: number): Xy {
    const p = wgs84ToSweref99tm(lat, lon);
    return [p.x, p.y];
}

function toLonLat([x, y]: Xy): [number, number] {
    const p = sweref99tmToWgs84(x, y);
    return [p.lon, p.lat];
}

function label(hole: AssignHole, courseId: string, names: Map<string, string>): string {
    return hole.courseId === courseId ? `hole ${hole.number}` : `${names.get(hole.courseId) ?? 'another course'} ${hole.number}`;
}
