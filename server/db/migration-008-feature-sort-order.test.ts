// NOT colocated inside db/migrations/ on purpose: Kysely's FileMigrationProvider
// (server/testing/db.ts -> createTestDb) readdir-scans that folder and
// require()s every *.ts file in it as a migration candidate (filtered
// afterwards by an `up` export, but the import side effects already ran) --
// a colocated *.test.ts there gets imported and its top-level test()/describe()
// calls fire during every OTHER test's createTestDb(), racing bun's test
// tracker ("Cannot call describe() inside a test"). Verified empirically.
import { test, expect, describe } from 'bun:test';
import { controlPointArea, computeBackfillSortOrders, type BackfillRow } from './migrations/008_feature_sort_order';

function squareGeometry(cx: number, cy: number, half: number) {
    return {
        rings: [
            {
                points: [
                    { x: cx - half, y: cy - half },
                    { x: cx + half, y: cy - half },
                    { x: cx + half, y: cy + half },
                    { x: cx - half, y: cy + half },
                ],
            },
        ],
    };
}

describe('controlPointArea', () => {
    test('shoelace area of a square', () => {
        expect(controlPointArea(squareGeometry(0, 0, 5))).toBeCloseTo(100, 6);
    });

    test('degenerate ring (fewer than 3 points) is zero', () => {
        expect(controlPointArea({ rings: [{ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }] })).toBe(0);
    });
});

describe('computeBackfillSortOrders', () => {
    function row(over: Partial<BackfillRow> & Pick<BackfillRow, 'id'>): BackfillRow {
        return {
            course_id: 'course-1',
            hole_id: null,
            type: 'fairway',
            geometry_json: JSON.stringify(squareGeometry(0, 0, 10)),
            created_at: '2026-01-01T00:00:00Z',
            ...over,
        };
    }

    test('rough island in fairway (acceptance scenario 2 fixture): larger area sorts to the bottom', () => {
        const rows: BackfillRow[] = [
            row({ id: 'rough', hole_id: 'hole-1', type: 'rough', geometry_json: JSON.stringify(squareGeometry(0, 0, 2)) }),
            row({ id: 'fairway', hole_id: 'hole-1', type: 'fairway', geometry_json: JSON.stringify(squareGeometry(0, 0, 10)) }),
        ];
        const order = computeBackfillSortOrders(rows);
        // Larger fairway is area-DESC first => sort_order 0 (bottom); smaller rough above it.
        expect(order.get('fairway')).toBe(0);
        expect(order.get('rough')).toBe(1);
    });

    test('groups are scoped by (course_id, hole_id) independently', () => {
        const rows: BackfillRow[] = [
            row({ id: 'a-hole1', hole_id: 'hole-1', geometry_json: JSON.stringify(squareGeometry(0, 0, 5)) }),
            row({ id: 'b-hole1', hole_id: 'hole-1', geometry_json: JSON.stringify(squareGeometry(0, 0, 20)) }),
            row({ id: 'a-hole2', hole_id: 'hole-2', geometry_json: JSON.stringify(squareGeometry(0, 0, 1)) }),
        ];
        const order = computeBackfillSortOrders(rows);
        expect(order.get('b-hole1')).toBe(0);
        expect(order.get('a-hole1')).toBe(1);
        // hole-2's single row is its own group, independent of hole-1's ordering.
        expect(order.get('a-hole2')).toBe(0);
    });

    test('course-level (hole_id null) features are their own group, separate from any hole', () => {
        const rows: BackfillRow[] = [
            row({ id: 'course-level', hole_id: null, geometry_json: JSON.stringify(squareGeometry(0, 0, 5)) }),
            row({ id: 'hole-feature', hole_id: 'hole-1', geometry_json: JSON.stringify(squareGeometry(0, 0, 5)) }),
        ];
        const order = computeBackfillSortOrders(rows);
        expect(order.get('course-level')).toBe(0);
        expect(order.get('hole-feature')).toBe(0);
    });

    test('equal-area ties break by TYPE_Z_ORDER index ascending, then created_at ascending', () => {
        const rows: BackfillRow[] = [
            row({ id: 'water', type: 'water', created_at: '2026-01-01T00:00:00Z' }),
            row({ id: 'rough', type: 'rough', created_at: '2026-01-02T00:00:00Z' }),
            row({ id: 'rough-earlier', type: 'rough', created_at: '2026-01-01T00:00:00Z' }),
        ];
        const order = computeBackfillSortOrders(rows);
        // rough (rank 2) ties below water (rank 8); of the two roughs, the earlier created_at sorts first.
        expect(order.get('rough-earlier')).toBe(0);
        expect(order.get('rough')).toBe(1);
        expect(order.get('water')).toBe(2);
    });
});
