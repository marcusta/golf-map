import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
    Database,
    GamePlansTable,
    GamePlanHolesTable,
    PlanShotsTable,
} from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';

// --- Output types ---

export interface PlanShot {
    id: string;
    gamePlanHoleId: string;
    sortOrder: number;
    lat: number;
    lon: number;
    elevation: number | null;
    clubId: string | null;
    version: number;
}

export interface GamePlanHole {
    id: string;
    gamePlanId: string;
    holeNumber: number;
    teeId: string | null;
    preferredClubId: string | null;
    plannedDirectionDeg: number | null;
    shots: PlanShot[];
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

function toPlanShot(row: PlanShotRow): PlanShot {
    return {
        id: row.id,
        gamePlanHoleId: row.game_plan_hole_id,
        sortOrder: row.sort_order,
        lat: row.lat,
        lon: row.lon,
        elevation: row.elevation,
        clubId: row.club_id,
        version: row.version,
    };
}

function toGamePlanHole(row: GamePlanHoleRow, shots: PlanShot[]): GamePlanHole {
    return {
        id: row.id,
        gamePlanId: row.game_plan_id,
        holeNumber: row.hole_number,
        teeId: row.tee_id,
        preferredClubId: row.preferred_club_id,
        plannedDirectionDeg: row.planned_direction_deg,
        shots,
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

    private shotsByHole(gamePlanHoleId: string) {
        return this.planShots().where('game_plan_hole_id', '=', gamePlanHoleId).orderBy('sort_order');
    }

    private maxShotSortOrder(gamePlanHoleId: string) {
        return this.db.selectFrom('plan_shots')
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
        sort_order: number;
        lat: number;
        lon: number;
        elevation: number | null;
        club_id: string | null;
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

    // --- Tree assembly ---

    private async loadTree(planRow: GamePlanRow): Promise<GamePlan> {
        const holeRows = await this.holesByPlan(planRow.id).execute();
        const holeIds = holeRows.map((h) => h.id);
        const shotRows = holeIds.length > 0
            ? await this.planShots().where('game_plan_hole_id', 'in', holeIds).orderBy('sort_order').execute()
            : [];

        const shotsByHole = new Map<string, PlanShot[]>();
        for (const shot of shotRows) {
            const list = shotsByHole.get(shot.game_plan_hole_id) ?? [];
            list.push(toPlanShot(shot));
            shotsByHole.set(shot.game_plan_hole_id, list);
        }

        const holes = holeRows.map((h) => toGamePlanHole(h, shotsByHole.get(h.id) ?? []));
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
            }).execute();
            const created = await this.holeById(id).executeTakeFirstOrThrow();
            return toGamePlanHole(created, []);
        }

        if (patch.version === undefined || existing.version !== patch.version) {
            throw new VersionConflictError('game_plan_holes', existing.id);
        }

        const dbInput: Record<string, unknown> = {};
        if (patch.teeId !== undefined) dbInput.tee_id = patch.teeId;
        if (patch.preferredClubId !== undefined) dbInput.preferred_club_id = patch.preferredClubId;
        if (patch.plannedDirectionDeg !== undefined) dbInput.planned_direction_deg = patch.plannedDirectionDeg;

        await this.updateHoleById(existing.id).set({
            ...dbInput,
            version: patch.version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.holeById(existing.id).executeTakeFirstOrThrow();
        const shots = await this.shotsByHole(existing.id).execute();
        return toGamePlanHole(updated, shots.map(toPlanShot));
    }

    // --- Methods: shots ---

    async addShot(gamePlanHoleId: string, input: {
        lat: number;
        lon: number;
        elevation?: number | null;
        clubId?: string | null;
    }): Promise<PlanShot> {
        const id = crypto.randomUUID();
        const maxRow = await this.maxShotSortOrder(gamePlanHoleId).executeTakeFirst();
        const sortOrder = (maxRow?.max_order != null ? Number(maxRow.max_order) : -1) + 1;

        await this.insertPlanShot({
            id,
            game_plan_hole_id: gamePlanHoleId,
            sort_order: sortOrder,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            club_id: input.clubId ?? null,
        }).execute();

        return {
            id,
            gamePlanHoleId,
            sortOrder,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            clubId: input.clubId ?? null,
            version: 1,
        };
    }

    async updateShot(id: string, version: number, patch: {
        lat?: number;
        lon?: number;
        elevation?: number | null;
        clubId?: string | null;
    }): Promise<PlanShot> {
        const row = await this.shotById(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('plan_shots', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.lat !== undefined) dbInput.lat = patch.lat;
        if (patch.lon !== undefined) dbInput.lon = patch.lon;
        if (patch.elevation !== undefined) dbInput.elevation = patch.elevation;
        if (patch.clubId !== undefined) dbInput.club_id = patch.clubId;

        await this.updateShotById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.shotById(id).executeTakeFirstOrThrow();
        return toPlanShot(updated);
    }

    async removeShot(id: string, version: number): Promise<void> {
        const row = await this.shotById(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('plan_shots', id);
        await this.deleteShotById(id).execute();
    }

    async reorderShots(gamePlanHoleId: string, orderedIds: string[]): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            for (let i = 0; i < orderedIds.length; i++) {
                await this.updateShotById(orderedIds[i], trx).set({
                    sort_order: i,
                    updated_at: sql`(datetime('now'))`,
                }).execute();
            }
        });
    }
}
