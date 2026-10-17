import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, HolesTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError, ConflictError } from '@basics/core/server/auth';
import { UniqueViolationError, parseUniqueViolation } from '@basics/core/server/unique-violation';
import { drawScopeRanks } from '../../shared/render/stack-key';

// --- Output types ---

export interface Hole {
    id: string;
    courseId: string;
    number: number;
    par: number;
    drawingGroupName?: string | null;
    drawingGroupAfter?: number | null;
    drawingGroupOrder?: number | null;
    drawingStackOrder?: number | null;
    strokeIndex: number | null;
    notes: string | null;
    savedRegionJson: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

// --- Row mapping ---

type HoleRow = Selectable<HolesTable>;

function toHole(row: HoleRow): Hole {
    return {
        id: row.id,
        courseId: row.course_id,
        number: row.number,
        par: row.par,
        drawingGroupName: row.drawing_group_name,
        drawingGroupAfter: row.drawing_group_after,
        drawingGroupOrder: row.drawing_group_order,
        drawingStackOrder: row.drawing_stack_order,
        strokeIndex: row.stroke_index,
        notes: row.notes,
        savedRegionJson: row.saved_region_json,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export class HolesService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private holes() {
        return this.db.selectFrom('holes').selectAll();
    }

    private byId(id: string) {
        return this.holes().where('id', '=', id);
    }

    private byCourseOrderedByNumber(courseId: string) {
        return this.holes().where('course_id', '=', courseId).orderBy('number');
    }

    // --- Queries (write) ---

    private insertHole(values: {
        id: string; course_id: string; number: number; par: number;
        notes: string | null; saved_region_json: string | null; version?: number;
        drawing_stack_order?: number | null;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('holes').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('holes').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('holes').where('id', '=', id);
    }

    // --- Methods ---

    async listByCourse(courseId: string, includeDrawingGroups = false): Promise<Hole[]> {
        let query = this.byCourseOrderedByNumber(courseId);
        if (!includeDrawingGroups) query = query.where('drawing_group_name', 'is', null);
        const rows = await query.execute();
        return rows.map(toHole);
    }

    async get(id: string): Promise<Hole> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Hole ${id} not found`);
        return toHole(row);
    }

    async create(input: {
        courseId: string;
        number: number;
        par: number;
        notes?: string;
        savedRegionJson?: string;
        drawingGroupName?: string;
    }): Promise<Hole> {
        if (input.drawingGroupName !== undefined) {
            const name = this.groupName(input.drawingGroupName);
            return this.db.transaction().execute(async trx => {
                const rows = await trx.selectFrom('holes').select('number').where('course_id', '=', input.courseId).execute();
                const number = Math.max(99, ...rows.map(r => r.number)) + 1;
                if (number >= 1023) throw new ConflictError('Too many drawing groups');
                const id = crypto.randomUUID();
                const order = await this.nextStackOrder(trx, input.courseId);
                await trx.insertInto('holes').values({ id, course_id: input.courseId, number, par: 0, drawing_group_name: name, drawing_stack_order: order, version: 1 }).execute();
                return toHole(await trx.selectFrom('holes').selectAll().where('id', '=', id).executeTakeFirstOrThrow());
            });
        }
        if (!Number.isInteger(input.number) || input.number < 1 || input.number >= 99) throw new ConflictError('Hole number must be between 1 and 98');
        const id = crypto.randomUUID();
        try {
            await this.db.transaction().execute(async trx => {
                await this.insertHole({
                    id,
                    course_id: input.courseId,
                    number: input.number,
                    par: input.par,
                    notes: input.notes ?? null,
                    saved_region_json: input.savedRegionJson ?? null,
                    drawing_stack_order: await this.nextStackOrder(trx, input.courseId),
                }, trx).execute();
            });
        } catch (err) {
            if (err instanceof UniqueViolationError) throw err;
            const uv = parseUniqueViolation(err);
            if (uv) throw uv;
            throw err;
        }
        return this.get(id);
    }

    async update(id: string, version: number, patch: {
        par?: number;
        strokeIndex?: number | null;
        notes?: string;
        savedRegionJson?: string;
        drawingGroupName?: string;
        drawingGroupAfter?: number | null;
        drawingGroupBeforeId?: string | null;
        layerBeforeId?: string | null;
    }): Promise<Hole> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Hole ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('holes', id);

        if (patch.layerBeforeId !== undefined) {
            if (Object.entries(patch).some(([key, value]) => value !== undefined && !['id', 'version', 'layerBeforeId'].includes(key))) {
                throw new ConflictError('Move a layer separately from changing its properties');
            }
            return this.reorderLayer(row, version, patch.layerBeforeId);
        }

        if (patch.drawingGroupBeforeId !== undefined) {
            if (Object.entries(patch).some(([key, value]) => value !== undefined && !['id', 'version', 'drawingGroupBeforeId'].includes(key))) {
                throw new ConflictError('Move a group separately from changing its properties');
            }
            return this.reorderDrawingGroup(row, version, patch.drawingGroupBeforeId);
        }

        const dbInput: Record<string, unknown> = {};
        if (patch.drawingGroupAfter !== undefined) {
            if (row.drawing_group_name === null) throw new ConflictError('Only drawing groups have a layer position');
            const after = patch.drawingGroupAfter;
            if (after !== null && (after !== 0 && !await this.holes().where('course_id', '=', row.course_id)
                .where('drawing_group_name', 'is', null).where('number', '=', after).executeTakeFirst())) {
                throw new ConflictError('Choose a playable hole on this course, or below all holes');
            }
            dbInput.drawing_group_after = after;
        }
        if (patch.drawingGroupName !== undefined) {
            if (row.drawing_group_name === null) throw new ConflictError('A playable hole cannot become a drawing group');
            dbInput.drawing_group_name = this.groupName(patch.drawingGroupName);
        }
        if (patch.par !== undefined) dbInput.par = patch.par;
        if (patch.strokeIndex !== undefined) dbInput.stroke_index = patch.strokeIndex;
        if (patch.notes !== undefined) dbInput.notes = patch.notes;
        if (patch.savedRegionJson !== undefined) dbInput.saved_region_json = patch.savedRegionJson;

        try {
            await this.updateById(id).set({
                ...dbInput,
                version: version + 1,
                updated_at: sql`(datetime('now'))`,
            }).execute();
        } catch (err) {
            if (err instanceof UniqueViolationError) throw err;
            const uv = parseUniqueViolation(err);
            if (uv) throw uv;
            throw err;
        }

        return this.get(id);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Hole ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('holes', id);
        await this.db.transaction().execute(async trx => {
            if (row.drawing_group_name !== null) {
                const feature = await trx.selectFrom('course_features').select('id').where('hole_id', '=', id).executeTakeFirst();
                if (feature) throw new ConflictError('Move the shapes to another group before deleting this drawing group');
                await this.deleteById(id, trx).execute();
                return;
            }
            const later = await trx
                .selectFrom('holes')
                .select(['id', 'number'])
                .where('course_id', '=', row.course_id)
                .where('number', '>', row.number)
                .where('drawing_group_name', 'is', null)
                .orderBy('number')
                .execute();

            await this.deleteById(id, trx).execute();

            // Keep a group in the same gap when playable holes are compacted.
            await trx.updateTable('holes').set({
                drawing_group_after: sql`drawing_group_after - 1`,
                version: sql`version + 1`, updated_at: sql`(datetime('now'))`,
            }).where('course_id', '=', row.course_id).where('drawing_group_name', 'is not', null)
                .where('drawing_group_after', '>=', row.number).execute();

            const remainingNumbers = (await trx
                .selectFrom('holes')
                .select('number')
                .where('course_id', '=', row.course_id)
                .where('drawing_group_name', 'is', null)
                .execute()).map(hole => hole.number);
            const planIds = (await trx
                .selectFrom('game_plans')
                .select('id')
                .where('course_id', '=', row.course_id)
                .execute()).map(plan => plan.id);
            if (planIds.length > 0) {
                let deletePlanRows = trx
                    .deleteFrom('game_plan_holes')
                    .where('game_plan_id', 'in', planIds);
                deletePlanRows = remainingNumbers.length === 0
                    ? deletePlanRows
                    : deletePlanRows.where('hole_number', 'not in', remainingNumbers);
                await deletePlanRows.execute();

                const laterNumbers = later.map(hole => hole.number);
                if (laterNumbers.length > 0) {
                    await trx
                        .updateTable('game_plan_holes')
                        .set({
                            hole_number: sql`hole_number - 1`,
                            version: sql`version + 1`,
                            updated_at: sql`(datetime('now'))`,
                        })
                        .where('game_plan_id', 'in', planIds)
                        .where('hole_number', 'in', laterNumbers)
                        .execute();
                }
            }

            for (const hole of later) {
                await this.updateById(hole.id, trx)
                    .set({ number: -hole.number })
                    .execute();
            }
            for (const hole of later) {
                await this.updateById(hole.id, trx)
                    .set({
                        number: hole.number - 1,
                        version: sql`version + 1`,
                        updated_at: sql`(datetime('now'))`,
                    })
                    .execute();
            }
        });
    }

    private groupName(value: string): string {
        const name = value.trim();
        if (!name || name.length > 80) throw new ConflictError('Drawing group name must be 1–80 characters');
        return name;
    }

    private async nextStackOrder(trx: Kysely<Database>, courseId: string): Promise<number | null> {
        const rows = await trx.selectFrom('holes').selectAll().where('course_id', '=', courseId).execute();
        if (rows.every(h => h.drawing_stack_order === null)) return null;
        const max = Math.max(0, ...rows.map(h => h.drawing_stack_order ?? 0));
        if (max < 1022) return max + 1;
        if (rows.length >= 1022) throw new ConflictError('Too many drawing layers');
        const ranks = drawScopeRanks(rows.map(toHole));
        rows.sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
        for (const [i, row] of rows.entries()) {
            await trx.updateTable('holes').set({ drawing_stack_order: i + 1, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                .where('id', '=', row.id).execute();
        }
        return rows.length + 1;
    }

    private async reorderLayer(layer: HoleRow, version: number, beforeId: string | null): Promise<Hole> {
        return this.db.transaction().execute(async trx => {
            const rows = await trx.selectFrom('holes').selectAll().where('course_id', '=', layer.course_id).execute();
            const fresh = rows.find(h => h.id === layer.id);
            if (!fresh) throw new NotFoundError(`Layer ${layer.id} not found`);
            if (fresh.version !== version) throw new VersionConflictError('holes', layer.id);
            if (beforeId === layer.id) return toHole(fresh);
            const ranks = drawScopeRanks(rows.map(toHole));
            const ordered = rows.filter(h => h.id !== layer.id).sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)!);
            const index = beforeId === null ? ordered.length : ordered.findIndex(h => h.id === beforeId);
            if (index < 0) throw new ConflictError('Choose a layer on the same course');
            ordered.splice(index, 0, fresh);
            for (const [i, row] of ordered.entries()) {
                if (row.drawing_stack_order === i + 1) continue;
                await trx.updateTable('holes').set({ drawing_stack_order: i + 1, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                    .where('id', '=', row.id).execute();
            }
            return toHole(await trx.selectFrom('holes').selectAll().where('id', '=', layer.id).executeTakeFirstOrThrow());
        });
    }

    private async reorderDrawingGroup(group: HoleRow, version: number, beforeId: string | null): Promise<Hole> {
        return this.db.transaction().execute(async trx => {
            const fresh = await trx.selectFrom('holes').selectAll().where('id', '=', group.id).executeTakeFirstOrThrow();
            if (fresh.version !== version) throw new VersionConflictError('holes', group.id);
            if (fresh.drawing_group_name === null) throw new ConflictError('Only drawing groups can be reordered');
            const peers = (await trx.selectFrom('holes').selectAll().where('course_id', '=', fresh.course_id)
                .where('drawing_group_name', 'is not', null).execute())
                .filter(h => (h.drawing_group_after ?? 98) === (fresh.drawing_group_after ?? 98))
                .sort((a, b) => (a.drawing_group_order ?? a.number) - (b.drawing_group_order ?? b.number) || a.number - b.number);
            if (beforeId === group.id) return toHole(fresh);
            const ordered = peers.filter(h => h.id !== group.id);
            const index = beforeId === null ? ordered.length : ordered.findIndex(h => h.id === beforeId);
            if (index < 0) throw new ConflictError('Choose a drawing group in the same layer position');
            ordered.splice(index, 0, fresh);
            for (const [i, peer] of ordered.entries()) {
                if (peer.drawing_group_order === i) continue;
                await trx.updateTable('holes').set({ drawing_group_order: i, version: sql`version + 1`, updated_at: sql`(datetime('now'))` })
                    .where('id', '=', peer.id).execute();
            }
            return toHole(await trx.selectFrom('holes').selectAll().where('id', '=', group.id).executeTakeFirstOrThrow());
        });
    }
}
