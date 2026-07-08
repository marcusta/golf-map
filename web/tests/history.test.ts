import { test, expect, describe, afterEach } from 'bun:test';
import { ApiError } from '@basics/core/client/api-error';
import { _reset } from '@basics/core/client/error-report';
import { EditHistory, MAX_HISTORY, snapshotOf, type HistoryEntry } from '../src/draw/history';
import { buildMoveEntry } from '../src/draw/draw-tool.service';
import { FeaturesService } from '../src/draw/features.service';
import type { CourseFeature, CourseFeaturesApi } from '../../shared/api/course-features.gen';
import type { FeatureGeometry } from '../src/geo/bezier';

afterEach(() => _reset());

function squareGeometry(half = 10, cx = 0, cy = 0): FeatureGeometry {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: cx - half, y: cy - half },
                { x: cx + half, y: cy - half },
                { x: cx + half, y: cy + half },
                { x: cx - half, y: cy + half },
            ],
        }],
    };
}

/** In-memory fake of the courseFeatures API (optimistic locking included). */
function fakeApi(initial: CourseFeature[] = []) {
    const rows = new Map(initial.map(f => [f.id, structuredClone(f)]));
    let idSeq = 0;
    const api: CourseFeaturesApi = {
        async listByCourse({ courseId }) {
            return [...rows.values()].filter(f => f.courseId === courseId).map(f => structuredClone(f));
        },
        listByHole: () => Promise.reject(new Error('not under test')),
        geojsonByCourse: () => Promise.reject(new Error('not under test')),
        async create(input) {
            const feature: CourseFeature = {
                id: `new${++idSeq}`,
                courseId: input.courseId,
                holeId: input.holeId ?? null,
                type: input.type,
                geometry: structuredClone(input.geometry),
                geojson: null,
                sortOrder: 0,
                version: 1,
            };
            rows.set(feature.id, feature);
            return structuredClone(feature);
        },
        async update(input) {
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            if (input.type !== undefined) row.type = input.type;
            if (input.holeId !== undefined) row.holeId = input.holeId;
            if (input.geometry !== undefined) row.geometry = structuredClone(input.geometry);
            row.version = input.version + 1;
            return structuredClone(row);
        },
        async remove(input) {
            const row = rows.get(input.id);
            if (!row || row.version !== input.version) throw new ApiError(409, 'Version conflict');
            rows.delete(input.id);
            return { ok: true };
        },
        async reorder(input) {
            input.orderedIds.forEach((id, i) => { const row = rows.get(id); if (row) row.sortOrder = i; });
            return { ok: true };
        },
    };
    return { api, rows };
}

function feature(id: string, type = 'bunker', version = 1, geometry = squareGeometry()): CourseFeature {
    return { id, courseId: 'c1', holeId: null, type, geometry, geojson: null, sortOrder: 0, version };
}

async function makeService(initial: CourseFeature[]) {
    const { api, rows } = fakeApi(initial);
    const svc = new FeaturesService(api);
    await svc.load('c1');
    return { svc, rows };
}

/** Diff for an update op applied through the service (before → after). */
function updateDiff(f: CourseFeature, after: Partial<{ geometry: FeatureGeometry; type: string; holeId: string | null }>): HistoryEntry[number] {
    return {
        featureId: f.id,
        before: snapshotOf(f),
        after: { ...snapshotOf(f), ...after },
        beforeVersion: f.version,
    };
}

describe('push / canUndo / canRedo', () => {
    test('push enables undo and clears the redo stack', async () => {
        const { svc } = await makeService([feature('a')]);
        const history = new EditHistory();
        expect(history.canUndo.get()).toBe(false);

        const f = svc.store.items.peek()[0];
        history.push([updateDiff(f, { type: 'green' })]);
        await svc.update('a', { type: 'green' });
        expect(history.canUndo.get()).toBe(true);
        expect(history.canRedo.get()).toBe(false);

        await history.undo(svc);
        expect(history.canRedo.get()).toBe(true);

        // A fresh edit forks the timeline: redo is gone.
        history.push([updateDiff(svc.store.items.peek()[0], { type: 'water' })]);
        expect(history.canRedo.get()).toBe(false);
    });

    test('empty entries are ignored', () => {
        const history = new EditHistory();
        history.push([]);
        expect(history.canUndo.get()).toBe(false);
    });
});

describe('undo / redo of updates', () => {
    test('undo restores the before-state on the server; redo re-applies', async () => {
        const { svc, rows } = await makeService([feature('a', 'bunker')]);
        const history = new EditHistory();

        const before = svc.store.items.peek()[0];
        const newGeometry = squareGeometry(25);
        history.push([updateDiff(before, { geometry: newGeometry, type: 'green' })]);
        await svc.update('a', { geometry: newGeometry, type: 'green' });
        expect(rows.get('a')!.type).toBe('green');

        expect(await history.undo(svc)).toBe(true);
        expect(rows.get('a')!.type).toBe('bunker');
        expect(rows.get('a')!.geometry.rings[0].points[0]).toEqual({ x: -10, y: -10 });
        // Optimistic locking survives the undo round-trip (version bumped).
        expect(svc.store.items.peek()[0].version).toBe(3);

        expect(await history.redo(svc)).toBe(true);
        expect(rows.get('a')!.type).toBe('green');
        expect(rows.get('a')!.geometry.rings[0].points[0]).toEqual({ x: -25, y: -25 });
    });

    test('bulk entry (multi-feature move) undoes atomically in one step', async () => {
        const { svc, rows } = await makeService([feature('a'), feature('b')]);
        const history = new EditHistory();

        const [a, b] = svc.store.items.peek();
        const movedA = squareGeometry(10, 5, 5);
        const movedB = squareGeometry(10, 7, 7);
        history.push([
            updateDiff(a, { geometry: movedA }),
            updateDiff(b, { geometry: movedB }),
        ]);
        await svc.update('a', { geometry: movedA });
        await svc.update('b', { geometry: movedB });

        expect(await history.undo(svc)).toBe(true);
        expect(rows.get('a')!.geometry.rings[0].points[0]).toEqual({ x: -10, y: -10 });
        expect(rows.get('b')!.geometry.rings[0].points[0]).toEqual({ x: -10, y: -10 });
        expect(history.canUndo.get()).toBe(false); // ONE entry consumed

        expect(await history.redo(svc)).toBe(true);
        expect(rows.get('a')!.geometry.rings[0].points[0]).toEqual({ x: -5, y: -5 });
        expect(rows.get('b')!.geometry.rings[0].points[0]).toEqual({ x: -3, y: -3 });
    });
});

describe('undo / redo of create and delete', () => {
    test('undo of a create deletes the feature; redo recreates it (new id, remapped)', async () => {
        const { svc, rows } = await makeService([]);
        const history = new EditHistory();

        const created = (await svc.create({ type: 'bunker', holeId: null, geometry: squareGeometry() }))!;
        history.push([{ featureId: created.id, before: null, after: snapshotOf(created), beforeVersion: null }]);

        expect(await history.undo(svc)).toBe(true);
        expect(rows.size).toBe(0);
        expect(svc.store.items.peek()).toHaveLength(0);

        expect(await history.redo(svc)).toBe(true);
        expect(rows.size).toBe(1);
        const recreated = svc.store.items.peek()[0];
        expect(recreated.type).toBe('bunker');

        // The remapped id keeps the entry usable: undo works again.
        expect(await history.undo(svc)).toBe(true);
        expect(rows.size).toBe(0);
    });

    test('undo of a delete recreates the feature; redo deletes the recreation', async () => {
        const { svc, rows } = await makeService([feature('a', 'green')]);
        const history = new EditHistory();

        const before = svc.store.items.peek()[0];
        history.push([{ featureId: 'a', before: snapshotOf(before), after: null, beforeVersion: before.version }]);
        await svc.removeFeature('a');
        expect(rows.size).toBe(0);

        expect(await history.undo(svc)).toBe(true);
        expect(rows.size).toBe(1);
        const recreated = svc.store.items.peek()[0];
        expect(recreated.id).not.toBe('a'); // server assigned a fresh id
        expect(recreated.type).toBe('green');
        expect(recreated.geometry.rings[0].points).toHaveLength(4);

        expect(await history.redo(svc)).toBe(true);
        expect(rows.size).toBe(0);
        expect(svc.store.items.peek()).toHaveLength(0);
    });

    test('bulk delete entry restores every feature on one undo', async () => {
        const { svc, rows } = await makeService([feature('a'), feature('b', 'water')]);
        const history = new EditHistory();

        const items = svc.store.items.peek();
        history.push(items.map(f => ({
            featureId: f.id,
            before: snapshotOf(f),
            after: null,
            beforeVersion: f.version,
        })));
        for (const f of items) await svc.removeFeature(f.id);
        expect(rows.size).toBe(0);

        expect(await history.undo(svc)).toBe(true);
        expect(rows.size).toBe(2);
        expect(svc.store.items.peek().map(f => f.type).sort()).toEqual(['bunker', 'water']);
    });
});

describe('cap', () => {
    test(`keeps at most ${MAX_HISTORY} entries (oldest dropped)`, async () => {
        const { svc } = await makeService([feature('a')]);
        const history = new EditHistory();
        const f = svc.store.items.peek()[0];
        for (let i = 0; i < MAX_HISTORY + 5; i++) {
            history.push([updateDiff(f, { type: i % 2 === 0 ? 'green' : 'bunker' })]);
        }
        let undone = 0;
        while (await history.undo(svc)) undone++;
        expect(undone).toBe(MAX_HISTORY);
    });
});

describe('conflict handling', () => {
    test('failed undo (external version bump) drops both stacks and sets a notice', async () => {
        const { svc, rows } = await makeService([feature('a')]);
        const history = new EditHistory();

        const f = svc.store.items.peek()[0];
        history.push([updateDiff(f, { type: 'green' })]);
        await svc.update('a', { type: 'green' });
        history.push([updateDiff(svc.store.items.peek()[0], { type: 'water' })]);
        await svc.update('a', { type: 'water' });
        await history.undo(svc); // one entry parked on the redo stack

        // An external writer bumps the version behind our back.
        rows.get('a')!.version = 99;

        expect(await history.undo(svc)).toBe(false);
        expect(history.canUndo.get()).toBe(false);
        expect(history.canRedo.get()).toBe(false);
        expect(history.notice.get()).toContain('version conflict');
    });

    test('clear() empties both stacks', async () => {
        const { svc } = await makeService([feature('a')]);
        const history = new EditHistory();
        const f = svc.store.items.peek()[0];
        history.push([updateDiff(f, { type: 'green' })]);
        await svc.update('a', { type: 'green' });
        await history.undo(svc);
        history.clear();
        expect(history.canUndo.get()).toBe(false);
        expect(history.canRedo.get()).toBe(false);
    });
});

describe('whole-selection move commit (buildMoveEntry)', () => {
    test('diff translates geometry (anchors + handles) and keeps before intact', () => {
        const geometry = squareGeometry();
        geometry.rings[0].points[0].hOut = { x: 5, y: -12 };
        geometry.rings[0].points[1].hIn = { x: 7, y: -12 };
        const snapshot = structuredClone(geometry);

        const entry = buildMoveEntry(
            [{ id: 'a', geometry, type: 'bunker', holeId: 'h1', version: 4 }],
            30,
            -20,
        );

        expect(entry).toHaveLength(1);
        const diff = entry[0];
        expect(diff.featureId).toBe('a');
        expect(diff.beforeVersion).toBe(4);
        expect(diff.before!.geometry).toEqual(snapshot); // untouched original
        expect(diff.before!.type).toBe('bunker');
        expect(diff.before!.holeId).toBe('h1');

        const after = diff.after!.geometry;
        expect(after.rings[0].points[0]).toMatchObject({ x: -10 + 30, y: -10 - 20 });
        expect(after.rings[0].points[0].hOut).toEqual({ x: 5 + 30, y: -12 - 20 });
        expect(after.rings[0].points[1].hIn).toEqual({ x: 7 + 30, y: -12 - 20 });
    });

    test('committed move undoes to a byte-exact restore and redoes back', async () => {
        const { svc, rows } = await makeService([
            feature('a'),
            feature('b', 'green', 1, squareGeometry(10, 100, 100)),
        ]);
        const history = new EditHistory();
        const moved = svc.store.items.peek().map(f => ({
            id: f.id, geometry: f.geometry, type: f.type, holeId: f.holeId, version: f.version,
        }));
        const beforeJson = JSON.stringify(svc.store.items.peek().map(f => f.geometry));

        // Commit exactly as DrawToolService.onMouseUp does.
        const entry = buildMoveEntry(moved, 15, 25);
        for (const diff of entry) {
            svc.patchLocal(diff.featureId, diff.after!.geometry);
            await svc.update(diff.featureId, { geometry: diff.after!.geometry });
        }
        history.push(entry);

        // Store AND server hold the translated geometry.
        expect(svc.store.items.peek()[0].geometry.rings[0].points[0]).toMatchObject({ x: -10 + 15, y: -10 + 25 });
        expect(rows.get('a')!.geometry.rings[0].points[0]).toMatchObject({ x: -10 + 15, y: -10 + 25 });
        expect(rows.get('b')!.geometry.rings[0].points[0]).toMatchObject({ x: 90 + 15, y: 90 + 25 });

        // ONE undo step restores both features byte-exactly.
        expect(await history.undo(svc)).toBe(true);
        expect(JSON.stringify(svc.store.items.peek().map(f => f.geometry))).toBe(beforeJson);
        expect(JSON.stringify([rows.get('a')!.geometry, rows.get('b')!.geometry])).toBe(beforeJson);

        expect(await history.redo(svc)).toBe(true);
        expect(rows.get('a')!.geometry.rings[0].points[0]).toMatchObject({ x: 5, y: 15 });
    });
});
