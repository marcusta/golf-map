import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, RoundsTable, ShotsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface Shot {
    id: string;
    roundId: string;
    holeNumber: number;
    sortOrder: number;
    lat: number;
    lon: number;
    clubId: string | null;
    lie: string | null;
    recordedAt: string;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface Round {
    id: string;
    courseId: string;
    userId: string | null;
    startedAt: string;
    endedAt: string | null;
    notes: string | null;
    version: number;
    createdAt: string;
    updatedAt: string;
}

export interface RoundWithShots extends Round {
    shots: Shot[];
}

// --- Row mapping ---

type RoundRow = Selectable<RoundsTable>;
type ShotRow = Selectable<ShotsTable>;

function toRound(row: RoundRow): Round {
    return {
        id: row.id,
        courseId: row.course_id,
        userId: row.user_id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        notes: row.notes,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toShot(row: ShotRow): Shot {
    return {
        id: row.id,
        roundId: row.round_id,
        holeNumber: row.hole_number,
        sortOrder: row.sort_order,
        lat: row.lat,
        lon: row.lon,
        clubId: row.club_id,
        lie: row.lie,
        recordedAt: row.recorded_at,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export class RoundsService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private rounds() {
        return this.db.selectFrom('rounds').selectAll();
    }

    private roundById(id: string) {
        return this.rounds().where('id', '=', id);
    }

    private roundsByCourse(courseId: string) {
        return this.rounds().where('course_id', '=', courseId).orderBy('started_at', 'desc');
    }

    private shots() {
        return this.db.selectFrom('shots').selectAll();
    }

    private shotById(id: string) {
        return this.shots().where('id', '=', id);
    }

    private shotsByRoundOrdered(roundId: string) {
        return this.shots()
            .where('round_id', '=', roundId)
            .orderBy('hole_number')
            .orderBy('sort_order');
    }

    private maxSortOrderForHole(roundId: string, holeNumber: number) {
        return this.db
            .selectFrom('shots')
            .where('round_id', '=', roundId)
            .where('hole_number', '=', holeNumber)
            .select((eb) => eb.fn.max('sort_order').as('maxSortOrder'));
    }

    // --- Queries (write) ---

    private insertRound(values: {
        id: string; course_id: string; user_id: string | null;
        started_at: string; ended_at: string | null; notes: string | null; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('rounds').values({ ...values, version: values.version ?? 1 });
    }

    private updateRoundById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('rounds').where('id', '=', id);
    }

    private deleteRoundById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('rounds').where('id', '=', id);
    }

    private insertShot(values: {
        id: string; round_id: string; hole_number: number; sort_order: number;
        lat: number; lon: number; club_id: string | null; lie: string | null;
        recorded_at: string; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('shots').values({ ...values, version: values.version ?? 1 });
    }

    private updateShotById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('shots').where('id', '=', id);
    }

    private deleteShotById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('shots').where('id', '=', id);
    }

    private deleteShotsByRound(roundId: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('shots').where('round_id', '=', roundId);
    }

    // --- Methods ---

    async listByCourse(courseId: string): Promise<Round[]> {
        const rows = await this.roundsByCourse(courseId).execute();
        return rows.map(toRound);
    }

    async get(id: string): Promise<RoundWithShots> {
        const row = await this.roundById(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Round ${id} not found`);
        const shotRows = await this.shotsByRoundOrdered(id).execute();
        return { ...toRound(row), shots: shotRows.map(toShot) };
    }

    async start(courseId: string, userId?: string, startedAt?: string): Promise<Round> {
        const id = crypto.randomUUID();
        const values = {
            id,
            course_id: courseId,
            user_id: userId ?? null,
            started_at: startedAt ?? new Date().toISOString(),
            ended_at: null,
            notes: null,
        };
        await this.insertRound(values).execute();
        const row = await this.roundById(id).executeTakeFirstOrThrow();
        return toRound(row);
    }

    async end(id: string, version: number, endedAt: string, notes?: string): Promise<Round> {
        const row = await this.roundById(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Round ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('rounds', id);

        const dbInput: Record<string, unknown> = { ended_at: endedAt };
        if (notes !== undefined) dbInput.notes = notes;

        await this.updateRoundById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.roundById(id).executeTakeFirstOrThrow();
        return toRound(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.roundById(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Round ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('rounds', id);

        await this.db.transaction().execute(async (trx) => {
            await this.deleteShotsByRound(id, trx).execute();
            await this.deleteRoundById(id, trx).execute();
        });
    }

    async addShot(roundId: string, input: {
        holeNumber: number;
        lat: number;
        lon: number;
        clubId?: string;
        lie?: string;
        recordedAt?: string;
    }): Promise<Shot> {
        const round = await this.roundById(roundId).executeTakeFirst();
        if (!round) throw new NotFoundError(`Round ${roundId} not found`);

        const maxRow = await this.maxSortOrderForHole(roundId, input.holeNumber).executeTakeFirst();
        const nextSortOrder = maxRow?.maxSortOrder != null ? Number(maxRow.maxSortOrder) + 1 : 0;

        const id = crypto.randomUUID();
        const values = {
            id,
            round_id: roundId,
            hole_number: input.holeNumber,
            sort_order: nextSortOrder,
            lat: input.lat,
            lon: input.lon,
            club_id: input.clubId ?? null,
            lie: input.lie ?? null,
            recorded_at: input.recordedAt ?? new Date().toISOString(),
        };
        await this.insertShot(values).execute();
        const row = await this.shotById(id).executeTakeFirstOrThrow();
        return toShot(row);
    }

    async updateShot(id: string, version: number, patch: {
        holeNumber?: number;
        lat?: number;
        lon?: number;
        clubId?: string;
        lie?: string;
        recordedAt?: string;
    }): Promise<Shot> {
        const row = await this.shotById(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Shot ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('shots', id);

        const dbInput: Record<string, unknown> = {};
        if (patch.holeNumber !== undefined) dbInput.hole_number = patch.holeNumber;
        if (patch.lat !== undefined) dbInput.lat = patch.lat;
        if (patch.lon !== undefined) dbInput.lon = patch.lon;
        if (patch.clubId !== undefined) dbInput.club_id = patch.clubId;
        if (patch.lie !== undefined) dbInput.lie = patch.lie;
        if (patch.recordedAt !== undefined) dbInput.recorded_at = patch.recordedAt;

        await this.updateShotById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.shotById(id).executeTakeFirstOrThrow();
        return toShot(updated);
    }

    async removeShot(id: string, version: number): Promise<void> {
        const row = await this.shotById(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Shot ${id} not found`);
        if (row.version !== version) throw new VersionConflictError('shots', id);
        await this.deleteShotById(id).execute();
    }
}
