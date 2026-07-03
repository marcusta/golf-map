import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, ClubsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';

// --- Output types ---

export interface Club {
    id: string;
    userId: string | null;
    name: string;
    carryM: number;
    dispersionM: number;
    sortOrder: number;
    version: number;
}

// --- Row mapping ---

type ClubRow = Selectable<ClubsTable>;

function toClub(row: ClubRow): Club {
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        carryM: row.carry_m,
        dispersionM: row.dispersion_m,
        sortOrder: row.sort_order,
        version: row.version,
    };
}

export class ClubsService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private clubs() {
        return this.db.selectFrom('clubs').selectAll();
    }

    private byId(id: string) {
        return this.clubs().where('id', '=', id);
    }

    private byUser(userId: string | undefined) {
        return userId === undefined
            ? this.clubs()
            : this.clubs().where('user_id', '=', userId);
    }

    private maxSortOrder(userId: string | undefined) {
        const query = this.db.selectFrom('clubs').select((eb) => eb.fn.max('sort_order').as('max_order'));
        return userId === undefined ? query : query.where('user_id', '=', userId);
    }

    // --- Queries (write) ---

    private insertClub(values: {
        id: string;
        user_id: string | null;
        name: string;
        carry_m: number;
        dispersion_m: number;
        sort_order: number;
        version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('clubs').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('clubs').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('clubs').where('id', '=', id);
    }

    // --- Methods ---

    async list(userId?: string): Promise<Club[]> {
        const rows = await this.byUser(userId).orderBy('sort_order').execute();
        return rows.map(toClub);
    }

    async findById(id: string): Promise<Club> {
        const row = await this.byId(id).executeTakeFirstOrThrow();
        return toClub(row);
    }

    async create(input: {
        userId?: string | null;
        name: string;
        carryM: number;
        dispersionM: number;
    }): Promise<Club> {
        const id = crypto.randomUUID();
        const userId = input.userId ?? null;
        const maxRow = await this.maxSortOrder(userId ?? undefined).executeTakeFirst();
        const sortOrder = (maxRow?.max_order != null ? Number(maxRow.max_order) : -1) + 1;

        await this.insertClub({
            id,
            user_id: userId,
            name: input.name,
            carry_m: input.carryM,
            dispersion_m: input.dispersionM,
            sort_order: sortOrder,
        }).execute();

        return {
            id,
            userId,
            name: input.name,
            carryM: input.carryM,
            dispersionM: input.dispersionM,
            sortOrder,
            version: 1,
        };
    }

    async update(id: string, version: number, input: {
        name?: string;
        carryM?: number;
        dispersionM?: number;
    }): Promise<Club> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('clubs', id);

        const dbInput: Record<string, unknown> = {};
        if (input.name !== undefined) dbInput.name = input.name;
        if (input.carryM !== undefined) dbInput.carry_m = input.carryM;
        if (input.dispersionM !== undefined) dbInput.dispersion_m = input.dispersionM;

        await this.updateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toClub(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row || row.version !== version) throw new VersionConflictError('clubs', id);
        await this.deleteById(id).execute();
    }

    async reorder(orderedIds: string[]): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            for (let i = 0; i < orderedIds.length; i++) {
                await this.updateById(orderedIds[i], trx).set({
                    sort_order: i,
                    updated_at: sql`(datetime('now'))`,
                }).execute();
            }
        });
    }
}
