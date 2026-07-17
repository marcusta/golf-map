import { type Kysely } from 'kysely';

// --- O1: plan-shot options form a parent-linked tree ---
//
// Existing per-hole flat shot lists become the rank-0 primary chain: shots
// are ordered by their old sort_order, each points to its predecessor, and
// every sort_order becomes 0. New sort_order values are sibling-local option
// ranks, where rank 0 is the primary choice at a decision point.

export interface PlanShotBackfillRow {
    id: string;
    game_plan_hole_id: string;
    sort_order: number;
}

export interface PlanShotBackfillValue {
    parentShotId: string | null;
    sortOrder: 0;
}

export function computePlanShotBackfill(
    rows: readonly PlanShotBackfillRow[],
): Map<string, PlanShotBackfillValue> {
    const byHole = new Map<string, PlanShotBackfillRow[]>();
    for (const row of rows) {
        const shots = byHole.get(row.game_plan_hole_id) ?? [];
        shots.push(row);
        byHole.set(row.game_plan_hole_id, shots);
    }

    const result = new Map<string, PlanShotBackfillValue>();
    for (const shots of byHole.values()) {
        shots.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
        shots.forEach((shot, index) => {
            result.set(shot.id, {
                parentShotId: index === 0 ? null : shots[index - 1].id,
                sortOrder: 0,
            });
        });
    }
    return result;
}

export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('plan_shots')
        .addColumn('parent_shot_id', 'text', (col) =>
            col.references('plan_shots.id').onDelete('cascade'))
        .execute();

    const rows = (await db
        .selectFrom('plan_shots')
        .select(['id', 'game_plan_hole_id', 'sort_order'])
        .execute()) as PlanShotBackfillRow[];

    const backfill = computePlanShotBackfill(rows);
    for (const [id, value] of backfill) {
        await db
            .updateTable('plan_shots')
            .set({ parent_shot_id: value.parentShotId, sort_order: value.sortOrder })
            .where('id', '=', id)
            .execute();
    }
}
