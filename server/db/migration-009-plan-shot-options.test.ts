// Kept outside db/migrations/: FileMigrationProvider imports every .ts file
// in that directory, so colocated bun:test declarations would run during
// unrelated test database bootstraps.
import { expect, test } from 'bun:test';
import {
    computePlanShotBackfill,
    type PlanShotBackfillRow,
    type PlanShotBackfillValue,
} from './migrations/009_plan_shot_options';

function extractPrimaryLine(
    rows: readonly PlanShotBackfillRow[],
    backfill: ReadonlyMap<string, PlanShotBackfillValue>,
    holeId: string,
): string[] {
    const shots = rows.filter((row) => row.game_plan_hole_id === holeId);
    const children = new Map<string | null, string[]>();
    for (const shot of shots) {
        const parentId = backfill.get(shot.id)?.parentShotId ?? null;
        const siblings = children.get(parentId) ?? [];
        siblings.push(shot.id);
        children.set(parentId, siblings);
    }

    const line: string[] = [];
    let parentId: string | null = null;
    while (true) {
        const primary: string | undefined = children
            .get(parentId)
            ?.find((id) => backfill.get(id)?.sortOrder === 0);
        if (!primary) return line;
        line.push(primary);
        parentId = primary;
    }
}

test('O1 backfill round-trip: extracting the primary line reproduces every old flat list', () => {
    const rows: PlanShotBackfillRow[] = [];
    const expectedByHole = new Map<string, string[]>();

    for (let holeIndex = 0; holeIndex < 18; holeIndex++) {
        const holeId = `hole-${holeIndex}`;
        const count = holeIndex % 7;
        const expected: string[] = [];
        for (let sortOrder = 0; sortOrder < count; sortOrder++) {
            const id = `${holeId}-shot-${sortOrder}`;
            expected.push(id);
            // Reverse insertion order proves the helper uses old sort_order,
            // not the database's row-return order.
            rows.unshift({ id, game_plan_hole_id: holeId, sort_order: sortOrder });
        }
        expectedByHole.set(holeId, expected);
    }

    const backfill = computePlanShotBackfill(rows);

    for (const [holeId, expected] of expectedByHole) {
        expect(extractPrimaryLine(rows, backfill, holeId)).toEqual(expected);
    }
    for (const value of backfill.values()) expect(value.sortOrder).toBe(0);
});
