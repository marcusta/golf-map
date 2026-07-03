import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, AimPointsTable } from '../db/schema';
import { VersionConflictError } from '@basics/core/server/version-conflict';
import { NotFoundError } from '@basics/core/server/auth';

// --- Output types ---

export interface AimPoint {
    id: string;
    holeId: string;
    sortOrder: number;
    lat: number;
    lon: number;
    elevation: number | null;
    label: string | null;
    version: number;
}

// --- Row mapping ---

type AimPointRow = Selectable<AimPointsTable>;

function toAimPoint(row: AimPointRow): AimPoint {
    return {
        id: row.id,
        holeId: row.hole_id,
        sortOrder: row.sort_order,
        lat: row.lat,
        lon: row.lon,
        elevation: row.elevation,
        label: row.label,
        version: row.version,
    };
}

export class AimPointsService {
    constructor(private db: Kysely<Database>) {}

    // --- Queries (read) ---

    private aimPoints() {
        return this.db.selectFrom('aim_points').selectAll();
    }

    private byId(id: string) {
        return this.aimPoints().where('id', '=', id);
    }

    private byHole(holeId: string) {
        return this.aimPoints().where('hole_id', '=', holeId);
    }

    // --- Queries (write) ---

    private insertAimPoint(values: {
        id: string; hole_id: string; sort_order: number; lat: number; lon: number;
        elevation: number | null; label: string | null; version?: number;
    }, trx: Kysely<Database> = this.db) {
        return trx.insertInto('aim_points').values({ ...values, version: values.version ?? 1 });
    }

    private updateById(id: string, trx: Kysely<Database> = this.db) {
        return trx.updateTable('aim_points').where('id', '=', id);
    }

    private deleteById(id: string, trx: Kysely<Database> = this.db) {
        return trx.deleteFrom('aim_points').where('id', '=', id);
    }

    // --- Methods ---

    async listByHole(holeId: string): Promise<AimPoint[]> {
        const rows = await this.byHole(holeId).orderBy('sort_order').execute();
        return rows.map(toAimPoint);
    }

    async create(input: {
        holeId: string; lat: number; lon: number; elevation?: number; label?: string;
    }): Promise<AimPoint> {
        const id = crypto.randomUUID();
        const maxRow = await this.db
            .selectFrom('aim_points')
            .select((eb) => eb.fn.max('sort_order').as('max_order'))
            .where('hole_id', '=', input.holeId)
            .executeTakeFirst();
        const sortOrder = maxRow?.max_order != null ? Number(maxRow.max_order) + 1 : 0;

        await this.insertAimPoint({
            id,
            hole_id: input.holeId,
            sort_order: sortOrder,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            label: input.label ?? null,
        }).execute();

        return {
            id,
            holeId: input.holeId,
            sortOrder,
            lat: input.lat,
            lon: input.lon,
            elevation: input.elevation ?? null,
            label: input.label ?? null,
            version: 1,
        };
    }

    async update(id: string, version: number, input: {
        lat?: number; lon?: number; elevation?: number; label?: string;
    }): Promise<AimPoint> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Aim point not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('aim_points', id);

        const dbInput: Record<string, unknown> = {};
        if (input.lat !== undefined) dbInput.lat = input.lat;
        if (input.lon !== undefined) dbInput.lon = input.lon;
        if (input.elevation !== undefined) dbInput.elevation = input.elevation;
        if (input.label !== undefined) dbInput.label = input.label;

        await this.updateById(id).set({
            ...dbInput,
            version: version + 1,
            updated_at: sql`(datetime('now'))`,
        }).execute();

        const updated = await this.byId(id).executeTakeFirstOrThrow();
        return toAimPoint(updated);
    }

    async remove(id: string, version: number): Promise<void> {
        const row = await this.byId(id).executeTakeFirst();
        if (!row) throw new NotFoundError(`Aim point not found: ${id}`);
        if (row.version !== version) throw new VersionConflictError('aim_points', id);
        await this.deleteById(id).execute();
    }

    async reorder(holeId: string, orderedIds: string[]): Promise<void> {
        await this.db.transaction().execute(async (trx) => {
            for (let i = 0; i < orderedIds.length; i++) {
                await this.updateById(orderedIds[i], trx)
                    .set({ sort_order: i, updated_at: sql`(datetime('now'))` })
                    .where('hole_id', '=', holeId)
                    .execute();
            }
        });
    }
}
