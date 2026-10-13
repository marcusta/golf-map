import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, CourseTeeSetsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { GKD_TEE_TYPES, gkdTeeType, type GkdTeeType, type TeeSetGender } from '../../shared/tee-sets';

// A course's tee sets: "Yellow" for the whole course, with its colour and
// the men's and women's course rating and slope. A hole's tee belongs to one
// (`tees.tee_set_id`) and carries the set's name and colour itself, so this
// service is what keeps the two in step: renaming or recolouring a set
// rewrites its tees, and a tee written without a set (the importer, a seed,
// an older client) is adopted into the set of its name the next time the
// course's sets are listed.
//
// What the club calls a set and what GSPro calls it are two things: `gsproTee`
// is the GreenKeeper tee type the set is exported as (at most one set of a
// course per type), and a `gsproOnly` set exists for GSPro alone and stays
// out of the course guide, which its tees say themselves (`tees.gspro_only`).

export interface TeeSet {
    id: string;
    courseId: string;
    name: string;
    color: string | null;
    sortOrder: number;
    ratingMen: number | null;
    slopeMen: number | null;
    ratingWomen: number | null;
    slopeWomen: number | null;
    /** Which of the two ratings GSPro shows for the set. */
    gsproRating: TeeSetGender;
    /** The GreenKeeper tee type the set is exported as; null = not in GSPro. */
    gsproTee: GkdTeeType | null;
    /** The set exists for GSPro alone: the course guide leaves it out. */
    gsproOnly: boolean;
    /** How many hole tees the set has. */
    teeCount: number;
    version: number;
}

export interface TeeSetPatch {
    name?: string;
    color?: string | null;
    ratingMen?: number | null;
    slopeMen?: number | null;
    ratingWomen?: number | null;
    slopeWomen?: number | null;
    gsproRating?: TeeSetGender;
    /** Taking a type another of the course's sets has moves it here. */
    gsproTee?: GkdTeeType | null;
    gsproOnly?: boolean;
}

type Row = Selectable<CourseTeeSetsTable>;

function toTeeSet(row: Row, teeCount: number): TeeSet {
    return {
        id: row.id,
        courseId: row.course_id,
        name: row.name,
        color: row.color,
        sortOrder: row.sort_order,
        ratingMen: row.rating_men,
        slopeMen: row.slope_men,
        ratingWomen: row.rating_women,
        slopeWomen: row.slope_women,
        gsproRating: row.gspro_rating === 'women' ? 'women' : 'men',
        gsproTee: GKD_TEE_TYPES.find(t => t === row.gspro_tee) ?? null,
        gsproOnly: row.gspro_only === 1,
        teeCount,
        version: row.version,
    };
}

export class TeeSetsService {
    constructor(private db: Kysely<Database>) {}

    /** The course's sets in order, after adopting any tee written without one. */
    async listByCourse(courseId: string): Promise<TeeSet[]> {
        await this.adoptOrphans(courseId);
        const rows = await this.db.selectFrom('course_tee_sets').selectAll()
            .where('course_id', '=', courseId).orderBy('sort_order').orderBy('name').execute();
        const counts = await this.db.selectFrom('tees')
            .select(['tee_set_id', eb => eb.fn.countAll<number>().as('n')])
            .where('tee_set_id', 'in', rows.length ? rows.map(r => r.id) : [''])
            .groupBy('tee_set_id').execute();
        const byId = new Map(counts.map(c => [c.tee_set_id, Number(c.n)]));
        return rows.map(r => toTeeSet(r, byId.get(r.id) ?? 0));
    }

    async get(id: string): Promise<TeeSet> {
        const row = await this.db.selectFrom('course_tee_sets').selectAll().where('id', '=', id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Tee set not found: ${id}`);
        const count = await this.db.selectFrom('tees').select(eb => eb.fn.countAll<number>().as('n'))
            .where('tee_set_id', '=', id).executeTakeFirstOrThrow();
        return toTeeSet(row, Number(count.n));
    }

    async create(input: { courseId: string; name: string; color?: string | null }): Promise<TeeSet> {
        const name = input.name.trim();
        if (!name) throw new ConflictError('A tee set needs a name');
        const course = await this.db.selectFrom('courses').select('id').where('id', '=', input.courseId).executeTakeFirst();
        if (!course) throw new NotFoundError(`Course ${input.courseId} not found`);
        await this.refuseTakenName(input.courseId, name, null);
        const last = await this.db.selectFrom('course_tee_sets').select(eb => eb.fn.max('sort_order').as('max'))
            .where('course_id', '=', input.courseId).executeTakeFirst();
        const id = crypto.randomUUID();
        await this.db.insertInto('course_tee_sets').values({
            id, course_id: input.courseId, name, color: input.color ?? null,
            sort_order: last?.max != null ? Number(last.max) + 1 : 0,
            rating_men: null, slope_men: null, rating_women: null, slope_women: null,
            gspro_rating: 'men', gspro_tee: await this.freeGsproTee(this.db, input.courseId, name, input.color ?? null),
            version: 1,
        }).execute();
        return this.get(id);
    }

    /** Change a set. A new name, colour or GSPro-only mark goes onto every tee of the set too. */
    async update(id: string, version: number, patch: TeeSetPatch): Promise<TeeSet> {
        const row = await this.db.selectFrom('course_tee_sets').selectAll().where('id', '=', id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Tee set not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('course_tee_sets', id);

        const set: Record<string, unknown> = {};
        if (patch.name !== undefined) {
            const name = patch.name.trim();
            if (!name) throw new ConflictError('A tee set needs a name');
            if (name !== row.name) await this.refuseTakenName(row.course_id, name, id);
            set.name = name;
        }
        if (patch.color !== undefined) set.color = patch.color;
        if (patch.ratingMen !== undefined) set.rating_men = patch.ratingMen;
        if (patch.slopeMen !== undefined) set.slope_men = patch.slopeMen;
        if (patch.ratingWomen !== undefined) set.rating_women = patch.ratingWomen;
        if (patch.slopeWomen !== undefined) set.slope_women = patch.slopeWomen;
        if (patch.gsproRating !== undefined) set.gspro_rating = patch.gsproRating;
        if (patch.gsproTee !== undefined) set.gspro_tee = patch.gsproTee;
        if (patch.gsproOnly !== undefined) set.gspro_only = patch.gsproOnly ? 1 : 0;

        await this.db.transaction().execute(async (trx) => {
            if (patch.gsproTee) {
                await trx.updateTable('course_tee_sets')
                    .set({ gspro_tee: null, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                    .where('course_id', '=', row.course_id).where('gspro_tee', '=', patch.gsproTee).where('id', '!=', id)
                    .execute();
            }
            await trx.updateTable('course_tee_sets')
                .set({ ...set, version: version + 1, updated_at: sql`(datetime('now'))` })
                .where('id', '=', id).execute();
            const onTees: Record<string, unknown> = {};
            if (set.name !== undefined && set.name !== row.name) onTees.name = set.name;
            if (set.color !== undefined && set.color !== row.color) onTees.color = set.color;
            if (set.gspro_only !== undefined && set.gspro_only !== row.gspro_only) onTees.gspro_only = set.gspro_only;
            if (Object.keys(onTees).length) {
                await trx.updateTable('tees')
                    .set({ ...onTees, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                    .where('tee_set_id', '=', id).execute();
            }
        });
        return this.get(id);
    }

    /** Remove a set no hole uses; 409 while tees still belong to it. */
    async remove(id: string, version: number): Promise<void> {
        const set = await this.get(id);
        if (set.version !== version) throw new VersionConflictError('course_tee_sets', id);
        if (set.teeCount > 0) {
            throw new ConflictError(`${set.name} still has ${set.teeCount} tee${set.teeCount === 1 ? '' : 's'} on the course — delete those first`);
        }
        await this.db.deleteFrom('course_tee_sets').where('id', '=', id).execute();
    }

    /**
     * Give every tee of the course that has no set the set of its name,
     * making the set (with the tee's colour) when the course has none by
     * that name.
     */
    private async adoptOrphans(courseId: string): Promise<void> {
        const orphans = await this.db.selectFrom('tees')
            .innerJoin('holes', 'holes.id', 'tees.hole_id')
            .select(['tees.id', 'tees.name', 'tees.color'])
            .where('holes.course_id', '=', courseId).where('tees.tee_set_id', 'is', null)
            .orderBy('tees.sort_order').orderBy('tees.name').execute();
        if (orphans.length === 0) return;
        await this.db.transaction().execute(async (trx) => {
            const sets = await trx.selectFrom('course_tee_sets').select(['id', 'name', 'sort_order', 'gspro_only'])
                .where('course_id', '=', courseId).execute();
            const byName = new Map(sets.map(s => [s.name, s.id]));
            const gsproOnly = new Map(sets.map(s => [s.id, s.gspro_only]));
            let next = sets.reduce((max, s) => Math.max(max, s.sort_order + 1), 0);
            for (const tee of orphans) {
                let setId = byName.get(tee.name);
                if (!setId) {
                    setId = crypto.randomUUID();
                    await trx.insertInto('course_tee_sets').values({
                        id: setId, course_id: courseId, name: tee.name, color: tee.color, sort_order: next++,
                        rating_men: null, slope_men: null, rating_women: null, slope_women: null,
                        gspro_rating: 'men', gspro_tee: await this.freeGsproTee(trx, courseId, tee.name, tee.color),
                        version: 1,
                    }).execute();
                    byName.set(tee.name, setId);
                }
                await trx.updateTable('tees').set({ tee_set_id: setId, gspro_only: gsproOnly.get(setId) ?? 0 })
                    .where('id', '=', tee.id).execute();
            }
        });
    }

    /**
     * The GSPro tee type a new set starts as: the one its name, then its
     * colour, says ("Yellow", "Ladies"), unless another of the course's sets
     * already is it.
     */
    private async freeGsproTee(db: Kysely<Database>, courseId: string, name: string, color: string | null): Promise<GkdTeeType | null> {
        const type = gkdTeeType(name, color);
        if (!type) return null;
        const taken = await db.selectFrom('course_tee_sets').select('id')
            .where('course_id', '=', courseId).where('gspro_tee', '=', type).executeTakeFirst();
        return taken ? null : type;
    }

    private async refuseTakenName(courseId: string, name: string, exceptId: string | null): Promise<void> {
        const rows = await this.db.selectFrom('course_tee_sets').select(['id', 'name'])
            .where('course_id', '=', courseId).execute();
        const taken = rows.find(r => r.id !== exceptId && r.name.trim().toLowerCase() === name.toLowerCase());
        if (taken) throw new ConflictError(`The course already has a tee set named ${taken.name}`);
    }
}
