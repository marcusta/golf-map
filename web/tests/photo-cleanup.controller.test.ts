import { test, expect } from 'bun:test';
import { TEST_COURSE_ID } from '../../server/db/seeds/course';
import { photoCleanupTestApp, setup } from '../../server/testing/photo-cleanup';
import { createPhotoCleanupClient } from '../../shared/api/photo-cleanup.gen';
import { PhotoCleanupController, parseHoles } from '../src/clean/photo-cleanup.controller';

// The Clean panel's hole cleanup through the real API, services and database;
// golfpipe is the server fixture's stand-in.

async function until(check: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!check()) {
        if (Date.now() - t0 > ms) throw new Error('timed out');
        await Bun.sleep(10);
    }
}

test('run, look, untick a hole, apply the rest once; the photo is reloaded', async () => {
    const t = await setup({ holeChanges: () => 300 });
    const server = Bun.serve({ port: 0, fetch: photoCleanupTestApp(t.cleanup).fetch });
    let reloads = 0;
    const holes = new PhotoCleanupController(async () => { reloads++; }, createPhotoCleanupClient(`http://localhost:${server.port}/api`), 5);
    try {
        holes.activate({ courseId: TEST_COURSE_ID });
        await Bun.sleep(20);
        expect(holes.job.peek()).toBeNull();

        holes.holes.set('x-2');
        await holes.start();
        expect(holes.message.peek()?.kind).toBe('error');

        holes.holes.set('');
        await holes.start();
        expect(holes.job.peek()?.holes.map(h => h.hole)).toEqual([1, 2]);
        await until(() => holes.job.peek()?.status === 'succeeded');
        expect(holes.accepted()).toEqual([1, 2]);
        expect(holes.canApply()).toBe(true);

        // Each hole's before | after image is served.
        const url = holes.imageUrl(1)!;
        expect(url).toContain(`/photo-cleanup/${TEST_COURSE_ID}/${holes.job.peek()!.id}/1/review.png`);
        const res = await fetch(`http://localhost:${server.port}${url.slice(url.indexOf('/api'))}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');

        holes.toggle(2, false);
        expect(holes.accepted()).toEqual([1]);
        await holes.apply();
        expect(holes.job.peek()?.applied?.holes).toEqual([1]);
        expect(holes.canApply()).toBe(false);
        expect(reloads).toBe(1);
        expect(t.snapshots()).toEqual(['1.tif']);

        // Opening the tool again shows the newest run, applied.
        holes.deactivate();
        holes.activate({ courseId: TEST_COURSE_ID });
        await until(() => !!holes.job.peek());
        expect(holes.job.peek()?.applied?.holes).toEqual([1]);
    } finally {
        holes.deactivate();
        server.stop(true);
        await t.removeAll();
    }
});

test('a run refused by the server says why', async () => {
    const t = await setup({ areas: null });
    const server = Bun.serve({ port: 0, fetch: photoCleanupTestApp(t.cleanup).fetch });
    const holes = new PhotoCleanupController(async () => {}, createPhotoCleanupClient(`http://localhost:${server.port}/api`), 5);
    try {
        holes.activate({ courseId: TEST_COURSE_ID });
        await holes.start();
        expect(holes.message.peek()).toEqual({ kind: 'error', text: expect.stringMatching(/Draw cleanup areas first/) });
        expect(holes.job.peek()).toBeNull();
    } finally {
        holes.deactivate();
        server.stop(true);
        await t.removeAll();
    }
});

test('hole lists', () => {
    expect(parseHoles('')).toEqual([]);
    expect(parseHoles('1-3, 7 9')).toEqual([1, 2, 3, 7, 9]);
    expect(parseHoles('5-3')).toBeNull();
    expect(parseHoles('a')).toBeNull();
});
