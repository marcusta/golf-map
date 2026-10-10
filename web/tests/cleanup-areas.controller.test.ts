import { test, expect } from 'bun:test';
import { cleanupAreasTestApp } from '../../server/testing/cleanup-areas';
import { createTestDb } from '../../server/testing/db';
import { seedCourse, TEST_COURSE_ID } from '../../server/db/seeds/course';
import { createCleanupAreasClient } from '../../shared/api/cleanup-areas.gen';
import { CleanupAreasController } from '../src/clean/cleanup-areas.controller';
import { MapService } from '../src/map/map.service';

test('draw, protect, rename, redraw, delete, undo and reload through the real API and database', async () => {
    const { db, cleanupAreasService } = await createTestDb(seedCourse);
    const app = cleanupAreasTestApp(cleanupAreasService);
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    const client = createCleanupAreasClient(`http://localhost:${server.port}/api`);
    const areas = new CleanupAreasController(client);
    const disposers: Array<() => void> = [];
    const ctx = { map: new MapService(), courseId: TEST_COURSE_ID, track: (f: () => void) => disposers.push(f) };
    try {
        await db.insertInto('sites').values({ id: 'area-test', name: 'Test map', version: 1, notes: null }).execute();
        await db.updateTable('courses').set({ site_id: 'area-test' }).where('id', '=', TEST_COURSE_ID).execute();
        areas.activate(ctx);
        await areas.reload();
        expect(areas.canExport()).toBe(false);
        areas.begin('include');
        areas.addPoint({ lng: 15, lat: 58 });
        areas.addPoint({ lng: 16, lat: 58 });
        areas.addPoint({ lng: 16, lat: 59 });
        areas.addPoint({ lng: 15, lat: 59 });
        await areas.finish();
        expect(areas.document.peek()?.areas).toHaveLength(1);
        expect(areas.kind.peek()).toBeNull();
        expect(areas.canExport()).toBe(true);
        areas.name.set('Fairways and between-hole ground');
        await areas.rename();
        expect((await client.cleanupAreas({ courseId: TEST_COURSE_ID })).areas[0].name).toBe('Fairways and between-hole ground');
        areas.begin('exclude');
        for (const [lng, lat] of [[15.2,58.2], [15.4,58.2], [15.4,58.4], [15.2,58.4]]) areas.addPoint({ lng, lat });
        await areas.finish();
        expect((await client.exportCleanupArea({ courseId: TEST_COURSE_ID })).features[0].geometry.coordinates[0]).toHaveLength(2);
        areas.begin('include', true);
        areas.addPoint({ lng: 15.2, lat: 58.2 });
        areas.back();
        expect(areas.draft.peek()).toHaveLength(0);
        areas.cancel();
        expect(areas.document.peek()?.areas).toHaveLength(2);
        await areas.remove();
        expect(areas.document.peek()?.areas).toHaveLength(1);
        await areas.undo();
        expect(areas.document.peek()?.areas).toHaveLength(2);
        areas.deactivate();
        areas.activate(ctx);
        await areas.reload();
        expect(areas.document.peek()?.areas).toHaveLength(2);
        // A click tolerates hand jitter; a traced loop saves without a duplicate closing vertex.
        const pointer = (x: number, y: number) => ({ point: { x, y }, lngLat: { lng: 15 + x / 1000, lat: 58 + y / 1000 } });
        areas.begin('include');
        expect(areas.pointerDown(pointer(0, 0))).toBe(true);
        areas.pointerMove(pointer(1, 1));
        areas.pointerUp(pointer(1, 1));
        expect(areas.draft.peek()).toEqual([[15,58]]);
        areas.cancel();
        areas.begin('include');
        areas.pointerDown(pointer(0, 0));
        areas.pointerMove(pointer(100, 0));
        areas.pointerMove(pointer(100, 100));
        areas.pointerMove(pointer(0, 100));
        areas.pointerUp(pointer(0, 0));
        await areas.finish();
        expect(areas.document.peek()?.areas.at(-1)?.ring).toEqual([[15,58], [15.1,58], [15.1,58.1], [15,58.1], [15,58]]);
        await areas.undo();
        areas.begin('exclude');
        areas.pointerDown(pointer(0, 0));
        areas.pointerMove(pointer(100, 0));
        areas.cancel();
        expect(areas.pointerUp(pointer(100, 100))).toBe(false);
        expect(areas.draft.peek()).toEqual([]);
        // Another editor wins: stale saves keep the draft so nothing is silently lost.
        await client.saveCleanupAreas({ courseId: TEST_COURSE_ID, version: areas.document.peek()!.version, areas: [] });
        areas.begin('include');
        for (const [lng, lat] of [[15,58], [16,58], [16,59]]) areas.addPoint({ lng, lat });
        await areas.finish();
        expect(areas.message.peek()).toMatch(/Could not save/);
        expect(areas.draft.peek()).toHaveLength(3);
        expect(areas.kind.peek()).toBe('include');
    } finally {
        disposers.forEach(f => f());
        areas.deactivate();
        server.stop(true);
        await db.destroy();
    }
});

test('a "Clean everything" area saves as its own kind and is exported apart from the eligible area', async () => {
    const { db, cleanupAreasService } = await createTestDb(seedCourse);
    const server = Bun.serve({ port: 0, fetch: cleanupAreasTestApp(cleanupAreasService).fetch });
    const client = createCleanupAreasClient(`http://localhost:${server.port}/api`);
    const areas = new CleanupAreasController(client);
    const disposers: Array<() => void> = [];
    try {
        await db.insertInto('sites').values({ id: 'area-test', name: 'Test map', version: 1, notes: null }).execute();
        await db.updateTable('courses').set({ site_id: 'area-test' }).where('id', '=', TEST_COURSE_ID).execute();
        areas.activate({ map: new MapService(), courseId: TEST_COURSE_ID, track: (f: () => void) => disposers.push(f) });
        await areas.reload();
        areas.begin('force');
        expect(areas.name.peek()).toBe('Clean everything');
        for (const [lng, lat] of [[15,58], [16,58], [16,59], [15,59]]) areas.addPoint({ lng, lat });
        await areas.finish();
        expect(areas.canExport()).toBe(true);
        const saved = await client.cleanupAreas({ courseId: TEST_COURSE_ID });
        expect(saved.areas.map(a => a.kind)).toEqual(['force']);
        const exported = await client.exportCleanupArea({ courseId: TEST_COURSE_ID });
        expect(exported.features.map(f => f.properties.type)).toEqual(['cleanup', 'cleanup-force']);
        // Keep unchanged wins over a forced area too.
        areas.begin('exclude');
        for (const [lng, lat] of [[14,57], [17,57], [17,60], [14,60]]) areas.addPoint({ lng, lat });
        await areas.finish();
        expect((await client.exportCleanupArea({ courseId: TEST_COURSE_ID })).features).toEqual([]);
    } finally {
        disposers.forEach(f => f());
        areas.deactivate();
        server.stop(true);
        await db.destroy();
    }
});
