import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
    Database,
    GamePlansTable,
    GamePlanHolesTable,
    PlanShotsTable,
    PlanGatesTable,
} from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export type GateSource = 'manual' | 'computed';

export interface PlanShot {
    id: string;
    gamePlanHoleId: string;
    parentShotId: string | null;
    sortOrder: number;
    lat: number;
    lon: number;
    elevation: number | null;
    clubId: string | null;
    label: string | null;
    version: number;
}

export interface PlanGate {
    id: string;
    gamePlanHoleId: string;
    lat: number;
    lon: number;
    directionDeg: number;
    halfWidthLeftM: number;
    halfWidthRightM: number;
    source: GateSource;
    sortOrder: number;
    version: number;
}

export interface GamePlanHole {
    id: string;
    gamePlanId: string;
    holeNumber: number;
    teeId: string | null;
    preferredClubId: string | null;
    plannedDirectionDeg: number | null;
    windSpeedMps: number | null;
    windDirectionDeg: number | null;
    notes: string | null;
    shots: PlanShot[];
    gates: PlanGate[];
    version: number;
}

export interface GamePlan {
    id: string;
    courseId: string;
    userId: string | null;
    windSpeedMps: number | null;
    windDirectionDeg: number | null;
    holes: GamePlanHole[];
    version: number;
}

// --- Row mapping ---

type GamePlanRow = Selectable<GamePlansTable>;
type GamePlanHoleRow = Selectable<GamePlanHolesTable>;
type PlanShotRow = Selectable<PlanShotsTable>;
type PlanGateRow = Selectable<PlanGatesTable>;

function toPlanShot(row: PlanShotRow): PlanShot {
    return {
        id: row.id,
        gamePlanHoleId: row.game_plan_hole_id,
        parentShotId: row.parent_shot_id,
        sortOrder: row.sort_order,
        lat: row.lat,
        lon: row.lon,
        elevation: row.elevation,
        clubId: row.club_id,
        label: row.label,
        version: row.version,
    };
}

/**
 * O6 keeps the wire shape flat. Pre-ordering the flat rows makes the rank-0
 * primary chain retain the old list order while clients remain responsible
 * for assembling parent/child relationships.
 */
function orderPlanShotRows(rows: readonly PlanShotRow[]): PlanShotRow[] {
    const byParent = new Map<string | null, PlanShotRow[]>();
    for (const row of rows) {
        const siblings = byParent.get(row.parent_shot_id) ?? [];
        siblings.push(row);
        byParent.set(row.parent_shot_id, siblings);
    }
    for (const siblings of byParent.values()) {
        siblings.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
    }

    const ordered: PlanShotRow[] = [];
    const visited = new Set<string>();
    const visit = (row: PlanShotRow) => {
        if (visited.has(row.id)) return;
        visited.add(row.id);
        ordered.push(row);
        for (const child of byParent.get(row.id) ?? []) visit(child);
    };
    for (const root of byParent.get(null) ?? []) visit(root);

    // A valid service-produced tree reaches every row from a root. Keeping a
    // deterministic fallback makes reads lossless if legacy/corrupt data has
    // an orphan or cycle.
    for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) visit(row);
    return ordered;
}

function primaryLineTail(rows: readonly PlanShotRow[]): PlanShotRow | null {
    const byParent = new Map<string | null, PlanShotRow[]>();
    for (const row of rows) {
        const siblings = byParent.get(row.parent_shot_id) ?? [];
        siblings.push(row);
        byParent.set(row.parent_shot_id, siblings);
    }
    for (const siblings of byParent.values()) {
        siblings.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
    }

    let tail: PlanShotRow | null = null;
    let parentId: string | null = null;
    const visited = new Set<string>();
    while (true) {
        const primary: PlanShotRow | undefined = byParent.get(parentId)?.[0];
        if (!primary || visited.has(primary.id)) return tail;
        visited.add(primary.id);
        tail = primary;
        parentId = primary.id;
    }
}

function toPlanGate(row: PlanGateRow): PlanGate {
    return {
        id: row.id,
        gamePlanHoleId: row.game_plan_hole_id,
        lat: row.lat,
        lon: row.lon,
        directionDeg: row.direction_deg,
        halfWidthLeftM: row.half_width_left_m,
        halfWidthRightM: row.half_width_right_m,
        source: row.source as GateSource,
        sortOrder: row.sort_order,
        version: row.version,
    };
}

function toGamePlanHole(row: GamePlanHoleRow, shots: PlanShot[], gates: PlanGate[]): GamePlanHole {
    return {
        id: row.id,
        gamePlanId: row.game_plan_id,
        holeNumber: row.hole_number,
        teeId: row.tee_id,
        preferredClubId: row.preferred_club_id,
        plannedDirectionDeg: row.planned_direction_deg,
        windSpeedMps: row.wind_speed_mps,
        windDirectionDeg: row.wind_direction_deg,
        notes: row.notes,
        shots,
        gates,
        version: row.version,
    };
}

function toGamePlan(row: GamePlanRow, holes: GamePlanHole[]): GamePlan {
    return {
        id: row.id,
        courseId: row.course_id,
        userId: row.user_id,
        windSpeedMps: row.wind_speed_mps,
        windDirectionDeg: row.wind_direction_deg,
        holes,
        version: row.version,
    };
}

export class GamePlansService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private gamePlans() {
        return this.db.selectFrom('game_plans').selectAll();
    }

    private planById(id: string) {
        return this.gamePlans().where('id', '=', id);
    }

    private planByCourse(courseId: string, userId: string | undefined) {
        let query = this.gamePlans().where('course_id', '=', courseId);
        query = userId === undefined
            ? query.where('user_id', 'is', null)
            : query.where('user_id', '=', userId);
        return query;
    }

    private planHoles() {
        return this.db.selectFrom('game_plan_holes').selectAll();
    }

    private holeById(id: string) {
        return this.planHoles().where('id', '=', id);
    }

    private holesByPlan(gamePlanId: string) {
        return this.planHoles().where('game_plan_id', '=', gamePlanId).orderBy('hole_number');
    }

    private holeByPlanAndNumber(gamePlanId: string, holeNumber: number) {
        return this.planHoles()
            .where('game_plan_id', '=', gamePlanId)
            .where('hole_number', '=', holeNumber);
    }

    private planShots() {
        return this.db.selectFrom('plan_shots').selectAll();
    }

    private shotById(id: string) {
        return this.planShots().where('id', '=', id);
    }

    private shotsByHole(gamePlanHoleId: string, trx: Kysely<Database> = this.db) {
        return trx.selectFrom('plan_shots')
            .selectAll()
            .where('game_plan_hole_id', '=', gamePlanHoleId)
            .orderBy('sort_order')
            .orderBy('id');
    }

    private shotsByParent(
        gamePlanHoleId: string,
        parentShotId: string | null,
        trx: Kysely<Database> = this.db,
    ) {
        let query = trx.selectFrom('plan_shots')
            .selectAll()
            .where('game_plan_hole_id', '=', gamePlanHoleId);
        query = parentShotId === null
            ? query.where('parent_shot_id', 'is', null)
            : query.where('parent_shot_id', '=', parentShotId);
        return query.orderBy('sort_order').orderBy('id');
    }

    private maxShotSortOrder(
        gamePlanHoleId: string,
        parentShotId: string | null,
        trx: Kysely<Database> = this.db,
    ) {
        let query = trx.selectFrom('plan_shots')
            .select((eb) => eb.fn.max('sort_order').as('max_order'))
            .where('game_plan_hole_id', '=', gamePlanHoleId);
        query = parentShotId === null
            ? query.where('parent_shot_id', 'is', null)
            : query.where('parent_shot_id', '=', parentShotId);
        return query;
    }

    private planGates() {
        return this.db.selectFrom('plan_gates').selectAll();
    }

    private gateById(id: string) {
        return this.planGates().where('id', '=', id);
    }

    private gatesByHole(gamePlanHoleId: string) {
        return this.planGates().where('game_plan_hole_id', '=', gamePlanHoleId).orderBy('sort_order');
    }

    private maxGateSortOrder(gamePlanHoleId: string) {
        return this.db.selectFrom('plan_gates')
            .select((eb) => eb.fn.max('sort_order').as('max_order'))
            .where('game_plan_hole_id', '=', gamePlanHoleId);
    }

    // --- Queries (write) ---

    private insertGamePlan(values: {
        id: string;
        course_id: string;
        user_id: string | null;
        wind_speed_mps: number | null;
        wind_direction_deg: number | null;
        version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('game_plans').values({ ...values, version: values.version ?? 1 });
    }

    private updatePlanById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('game_plans').where('id', '=', id);
    }

    private deletePlanById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('game_plans').where('id', '=', id);
    }

    private insertGamePlanHole(values: {
        id: string;
        game_plan_id: string;
        hole_number: number;
        tee_id: string | null;
        preferred_club_id: string | null;
        planned_direction_deg: number | null;
        wind_speed_mps: number | null;
        wind_direction_deg: number | null;
        notes: string | null;
        version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('game_plan_holes').values({ ...values, version: values.version ?? 1 });
    }

    private updateHoleById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('game_plan_holes').where('id', '=', id);
    }

    private insertPlanShot(values: {
        id: string;
        game_plan_hole_id: string;
        parent_shot_id: string | null;
        sort_order: number;
        lat: number;
        lon: number;
        elevation: number | null;
        club_id: string | null;
        label: string | null;
        version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('plan_shots').values({ ...values, version: values.version ?? 1 });
    }

    private updateShotById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('plan_shots').where('id', '=', id);
    }

    private deleteShotById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('plan_shots').where('id', '=', id);
    }

    private insertPlanGate(values: {
        id: string;
        game_plan_hole_id: string;
        lat: number;
        lon: number;
        direction_deg: number;
        half_width_left_m: number;
        half_width_right_m: number;
        source: string;
        sort_order: number;
        version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('plan_gates').values({ ...values, version: values.version ?? 1 });
    }

    private updateGateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('plan_gates').where('id', '=', id);
    }

    private deleteGateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('plan_gates').where('id', '=', id);
    }

    // --- Tree assembly ---

    private async loadTree(planRow: GamePlanRow): Promise<GamePlan> {
        const holeRows = await this.holesByPlan(planRow.id).execute();
        const holeIds = holeRows.map((h) => h.id);
        const shotRows = holeIds.length > 0
            ? await this.planShots().where('game_plan_hole_id', 'in', holeIds).orderBy('sort_order').execute()
            : [];
        const gateRows = holeIds.length > 0
            ? await this.planGates().where('game_plan_hole_id', 'in', holeIds).orderBy('sort_order').execute()
            : [];

        const shotsByHole = new Map<string, PlanShotRow[]>();
        for (const shot of shotRows) {
            const list = shotsByHole.get(shot.game_plan_hole_id) ?? [];
            list.push(shot);
            shotsByHole.set(shot.game_plan_hole_id, list);
        }

        const gatesByHole = new Map<string, PlanGate[]>();
        for (const gate of gateRows) {
            const list = gatesByHole.get(gate.game_plan_hole_id) ?? [];
            list.push(toPlanGate(gate));
            gatesByHole.set(gate.game_plan_hole_id, list);
        }

        const holes = holeRows.map((h) => {
            const shots = shotsByHole.get(h.id) ?? [];
            return toGamePlanHole(h, orderPlanShotRows(shots).map(toPlanShot), gatesByHole.get(h.id) ?? []);
        });
        return toGamePlan(planRow, holes);
    }

    // --- Methods: game plan ---

    async getByCourse(courseId: string, userId?: string): Promise<GamePlan | null> {
        const row = await this.planByCourse(courseId, userId).executeTakeFirst();
        if (!row) return null;
        return this.loadTree(row);
    }

    async upsertByCourse(courseId: string, input: {
        userId?: string | null;
        version?: number;
        windSpeedMps?: number | null;
        windDirectionDeg?: number | null;
    }): Promise<GamePlan> {
        const userId = input.userId ?? null;
        const existing = await this.planByCourse(courseId, userId ?? undefined).executeTakeFirst();

        if (!existing) {
            const id = crypto.randomUUID();
            await this.insertGamePlan({
                id,
                course_id: courseId,
                user_id: userId,
                wind_speed_mps: input.windSpeedMps ?? null,
                wind_direction_deg: input.windDirectionDeg ?? null,
            }).execute();
            const created = await this.planById(id).executeTakeFirstOrThrow();
            return this.loadTree(created);
        }

        if (input.version === undefined || existing.version !== input.version) {
            throw new VersionConflictError('game_plans', existing.id);
        }

        const dbInput: Record<string, unknown> = {};
        if (input.windSpeedMps !== undefined) dbInput.wind_speed_mps = input.windSpeedMps;
        if (input.windDirectionDeg !== undefined) dbInput.wind_direction_deg = input.windDirectionDeg;

        await this.updatePlanById(existing.id).set({
            ...dbInput,
            version: input.version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.planById(existing.id).executeTakeFirstOrThrow();
        return this.loadTree(updated);
    }

    async removeByCourse(courseId: string, version: number, userId?: string): Promise<void> {
        const row = await this.planByCourse(courseId, userId).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('game_plans', row?.id ?? courseId);
        // Cascade (game_plan_holes -> plan_shots) relies on FK ON DELETE CASCADE in schema.
        await this.deletePlanById(row.id).execute();
    }

    // --- Methods: hole ---

    async setHole(planId: string, holeNumber: number, patch: {
        version?: number;
        teeId?: string | null;
        preferredClubId?: string | null;
        plannedDirectionDeg?: number | null;
        windSpeedMps?: number | null;
        windDirectionDeg?: number | null;
        notes?: string | null;
    }): Promise<GamePlanHole> {
        const existing = await this.holeByPlanAndNumber(planId, holeNumber).executeTakeFirst();

        if (!existing) {
            const id = crypto.randomUUID();
            await this.insertGamePlanHole({
                id,
                game_plan_id: planId,
                hole_number: holeNumber,
                tee_id: patch.teeId ?? null,
                preferred_club_id: patch.preferredClubId ?? null,
                planned_direction_deg: patch.plannedDirectionDeg ?? null,
                wind_speed_mps: patch.windSpeedMps ?? null,
                wind_direction_deg: patch.windDirectionDeg ?? null,
                notes: patch.notes ?? null,
            }).execute();
            const created = await this.holeById(id).executeTakeFirstOrThrow();
            return toGamePlanHole(created, [], []);
        }

        if (patch.version === undefined || existing.version !== patch.version) {
            throw new VersionConflictError('game_plan_holes', existing.id);
        }

        const dbInput: Record<string, unknown> = {};
        if (patch.teeId !== undefined) dbInput.tee_id = patch.teeId;
        if (patch.preferredClubId !== undefined) dbInput.preferred_club_id = patch.preferredClubId;
        if (patch.plannedDirectionDeg !== undefined) dbInput.planned_direction_deg = patch.plannedDirectionDeg;
        if (patch.windSpeedMps !== undefined) dbInput.wind_speed_mps = patch.windSpeedMps;
        if (patch.windDirectionDeg !== undefined) dbInput.wind_direction_deg = patch.windDirectionDeg;
        if (patch.notes !== undefined) dbInput.notes = patch.notes;

        await this.updateHoleById(existing.id).set({
            ...dbInput,
            version: patch.version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.holeById(existing.id).executeTakeFirstOrThrow();
        const shots = await this.shotsByHole(existing.id).execute();
        const gates = await this.gatesByHole(existing.id).execute();
        return toGamePlanHole(updated, orderPlanShotRows(shots).map(toPlanShot), gates.map(toPlanGate));
    }

    // --- Methods: shots ---

    async addShot(gamePlanHoleId: string, input: {
        lat: number;
        lon: number;
        elevation?: number | null;
        clubId?: string | null;
        label?: string | null;
        parentShotId?: string | null;
    }): Promise<PlanShot> {
        return this.db.transaction().execute(async (trx) => {
            const holeShots = await this.shotsByHole(gamePlanHoleId, trx).execute();
            let parentShotId: string | null;
            if (input.parentShotId !== undefined) {
                parentShotId = input.parentShotId;
                if (parentShotId !== null) {
                    const parent = holeShots.find((shot) => shot.id === parentShotId);
                    if (!parent) {
                        throw new ConflictError(
                            `parentShotId must belong to game_plan_hole ${gamePlanHoleId}`,
                        );
                    }
                }
            } else {
                parentShotId = primaryLineTail(holeShots)?.id ?? null;
            }

            const id = crypto.randomUUID();
            const maxRow = await this.maxShotSortOrder(gamePlanHoleId, parentShotId, trx).executeTakeFirst();
            const sortOrder = (maxRow?.max_order != null ? Number(maxRow.max_order) : -1) + 1;

            await this.insertPlanShot({
                id,
                game_plan_hole_id: gamePlanHoleId,
                parent_shot_id: parentShotId,
                sort_order: sortOrder,
                lat: input.lat,
                lon: input.lon,
                elevation: input.elevation ?? null,
                club_id: input.clubId ?? null,
                label: input.label ?? null,
            }, trx).execute();

            const created = await trx.selectFrom('plan_shots')
                .selectAll()
                .where('id', '=', id)
                .executeTakeFirstOrThrow();
            return toPlanShot(created);
        });
    }

    async updateShot(id: string, version: number, patch: {
        lat?: number;
        lon?: number;
        elevation?: number | null;
        clubId?: string | null;
        label?: string | null;
    }): Promise<PlanShot> {
        const row = await this.shotById(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('plan_shots', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.lat !== undefined) dbInput.lat = patch.lat;
        if (patch.lon !== undefined) dbInput.lon = patch.lon;
        if (patch.elevation !== undefined) dbInput.elevation = patch.elevation;
        if (patch.clubId !== undefined) dbInput.club_id = patch.clubId;
        if (patch.label !== undefined) dbInput.label = patch.label;

        await this.updateShotById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.shotById(id).executeTakeFirstOrThrow();
        return toPlanShot(updated);
    }

    async removeShot(id: string, version: number, mode: 'splice' | 'cascade' = 'splice'): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            const row = await trx.selectFrom('plan_shots').selectAll().where('id', '=', id).executeTakeFirst();
            if (!row || row.version !== version) throw new VersionConflictError('plan_shots', id);

            const siblings = await this.shotsByParent(
                row.game_plan_hole_id,
                row.parent_shot_id,
                trx,
            ).execute();
            const siblingIndex = siblings.findIndex((sibling) => sibling.id === id);
            const remainingBefore = siblings.slice(0, siblingIndex);
            const remainingAfter = siblings.slice(siblingIndex + 1);

            let replacement: PlanShotRow[] = [];
            if (mode === 'splice') {
                replacement = await this.shotsByParent(row.game_plan_hole_id, row.id, trx).execute();
                for (const child of replacement) {
                    await this.updateShotById(child.id, trx)
                        .set({ parent_shot_id: row.parent_shot_id, updated_at: sql`(datetime('now'))` })
                        .execute();
                }
            }

            // Cascade mode leaves descendants attached so the self-FK removes
            // the complete branch. Splice mode moved direct children first.
            await this.deleteShotById(id, trx).execute();

            const nextSiblings = [...remainingBefore, ...replacement, ...remainingAfter];
            for (let i = 0; i < nextSiblings.length; i++) {
                await this.updateShotById(nextSiblings[i].id, trx)
                    .set({ sort_order: i, updated_at: sql`(datetime('now'))` })
                    .execute();
            }
        });
    }

    async reorderShots(gamePlanHoleId: string, orderedIds: string[]): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            const existing = await trx.selectFrom('plan_shots')
                .selectAll()
                .where('game_plan_hole_id', '=', gamePlanHoleId)
                .execute();

            const first = existing.find((row) => row.id === orderedIds[0]);
            const siblings = first
                ? existing.filter((row) => row.parent_shot_id === first.parent_shot_id)
                : [];
            const existingIds = new Set(siblings.map((row) => row.id));
            const incomingIds = new Set(orderedIds);
            const sameSize = existingIds.size === incomingIds.size
                && incomingIds.size === orderedIds.length;
            const sameMembers = sameSize && orderedIds.every((id) => existingIds.has(id));
            if (!first || !sameSize || !sameMembers) {
                throw new ConflictError(
                    `orderedIds must exactly match one sibling group in game_plan_hole ${gamePlanHoleId}`,
                );
            }

            for (let i = 0; i < orderedIds.length; i++) {
                await this.updateShotById(orderedIds[i], trx).set({
                    sort_order: i,
                    updated_at: sql`(datetime('now'))`,
                }).execute();
            }
        });
    }

    async setPrimary(id: string): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            const row = await trx.selectFrom('plan_shots').selectAll().where('id', '=', id).executeTakeFirst();
            if (!row) throw new NotFoundError(`Plan shot ${id} not found`);

            const siblings = await this.shotsByParent(
                row.game_plan_hole_id,
                row.parent_shot_id,
                trx,
            ).execute();
            if (siblings[0]?.id === id) return;

            const ordered = [row, ...siblings.filter((sibling) => sibling.id !== id)];
            for (let i = 0; i < ordered.length; i++) {
                await this.updateShotById(ordered[i].id, trx)
                    .set({ sort_order: i, updated_at: sql`(datetime('now'))` })
                    .execute();
            }
        });
    }

    // --- Methods: gates ---

    async addGate(gamePlanHoleId: string, input: {
        lat: number;
        lon: number;
        directionDeg: number;
        halfWidthLeftM: number;
        halfWidthRightM: number;
        source?: GateSource;
    }): Promise<PlanGate> {
        const id = crypto.randomUUID();
        const maxRow = await this.maxGateSortOrder(gamePlanHoleId).executeTakeFirst();
        const sortOrder = (maxRow?.max_order != null ? Number(maxRow.max_order) : -1) + 1;
        const source = input.source ?? 'manual';

        await this.insertPlanGate({
            id,
            game_plan_hole_id: gamePlanHoleId,
            lat: input.lat,
            lon: input.lon,
            direction_deg: input.directionDeg,
            half_width_left_m: input.halfWidthLeftM,
            half_width_right_m: input.halfWidthRightM,
            source,
            sort_order: sortOrder,
        }).execute();

        return {
            id,
            gamePlanHoleId,
            lat: input.lat,
            lon: input.lon,
            directionDeg: input.directionDeg,
            halfWidthLeftM: input.halfWidthLeftM,
            halfWidthRightM: input.halfWidthRightM,
            source,
            sortOrder,
            version: 1,
        };
    }

    async updateGate(id: string, version: number, patch: {
        lat?: number;
        lon?: number;
        directionDeg?: number;
        halfWidthLeftM?: number;
        halfWidthRightM?: number;
        source?: GateSource;
    }): Promise<PlanGate> {
        const row = await this.gateById(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('plan_gates', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.lat !== undefined) dbInput.lat = patch.lat;
        if (patch.lon !== undefined) dbInput.lon = patch.lon;
        if (patch.directionDeg !== undefined) dbInput.direction_deg = patch.directionDeg;
        if (patch.halfWidthLeftM !== undefined) dbInput.half_width_left_m = patch.halfWidthLeftM;
        if (patch.halfWidthRightM !== undefined) dbInput.half_width_right_m = patch.halfWidthRightM;
        if (patch.source !== undefined) dbInput.source = patch.source;

        await this.updateGateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.gateById(id).executeTakeFirstOrThrow();
        return toPlanGate(updated);
    }

    async removeGate(id: string, version: number): Promise<void> {
        const row = await this.gateById(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('plan_gates', id);
        await this.deleteGateById(id).execute();
    }
}
