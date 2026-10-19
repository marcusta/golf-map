import { test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile, readdir, utimes } from 'node:fs/promises';
import * as path from 'node:path';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { TEST_COURSE_ID } from '../db/seeds/course';
import { SITE_ID, argValue } from '../testing/cleaned-photo';
import { AREAS, REGION, setup } from '../testing/photo-cleanup';
import { InvalidPhotoCleanupError, KEEP_JOBS } from './photo-cleanup.service';

// Hole-by-hole photo cleanup against the real services and a migrated DB;
// golfpipe is the cleaned-photo fixture's stand-in, so each test reads which
// commands ran with what, and what happened to the photo (kept as text).

const holeCalls = (calls: Array<{ args: string[] }>) => calls.filter(c => c.args[2] === 'cleanup-hole');

test('a run cleans each hole in order on a copy of the photo, and the photo itself is untouched', async () => {
    const t = await setup();
    try {
        const started = await t.cleanup.start(TEST_COURSE_ID);
        expect(started.status).toBe('running');
        expect(started.holes.map(h => [h.hole, h.status])).toEqual([[1, 'pending'], [2, 'pending']]);
        await t.cleanup.whenIdle(TEST_COURSE_ID);

        const job = await t.cleanup.job(TEST_COURSE_ID, started.id);
        expect(job.status).toBe('succeeded');
        expect(job.holes.map(h => [h.hole, h.status, h.changedPx, h.scopePx])).toEqual([[1, 'done', 100, 1000], [2, 'done', 200, 2000]]);
        expect(job.step).toBe('2 of 2 holes cleaned; 2 changed');

        const runs = holeCalls(t.calls);
        expect(runs.map(c => argValue(c.args, '--hole'))).toEqual(['1', '2']);
        const dir = path.join(t.jobsDir, started.id);
        // Both holes worked on the same copy, which is gone once the run is over.
        expect(runs.map(c => argValue(c.args, '--work'))).toEqual([path.join(dir, 'work.tif'), path.join(dir, 'work.tif')]);
        expect(existsSync(path.join(dir, 'work.tif'))).toBe(false);
        // Hole 1 has a saved view; hole 2 is placed by its own features.
        expect(JSON.parse(argValue(runs[0].args, '--region')!)).toEqual(REGION);
        expect(argValue(runs[1].args, '--region')).toBeUndefined();
        expect(argValue(runs[0].args, '--out')).toBe(path.join(dir, 'h1'));

        // The features carry their type and hole; the areas go as stored.
        const features = JSON.parse(await readFile(argValue(runs[0].args, '--features')!, 'utf8'));
        expect(features.features.map((f: any) => f.properties)).toEqual(expect.arrayContaining([{ type: 'fairway', hole: 1 }, { type: 'rough' }]));
        expect(features.features.every((f: any) => f.geometry.type === 'Polygon')).toBe(true);
        expect(JSON.parse(await readFile(argValue(runs[0].args, '--areas')!, 'utf8'))).toEqual(AREAS);

        // Only the copy was cleaned: the photo is as it was made.
        expect(await t.photo()).toBe('photo of ortho-orto-l2-2025.tif');
        expect(t.snapshots()).toEqual([]);
    } finally {
        await t.removeAll();
    }
});

test('the accepted holes go into the photo as one undo step, once', async () => {
    const t = await setup({ holeChanges: hole => (hole === 2 ? 0 : 500) });
    try {
        const { id } = await t.cleanup.start(TEST_COURSE_ID, [2, 1]);
        await t.cleanup.whenIdle(TEST_COURSE_ID);

        const applied = await t.cleanup.apply(TEST_COURSE_ID, id, [1, 2]);
        // Hole 2 changed nothing, so only hole 1 is composed; the overlay is imported.
        const compose = t.calls.find(c => c.args[2] === 'cleanup-compose')!;
        expect(argValue(compose.args, '--holes')).toBe('1');
        expect(argValue(compose.args, '--size')).toBe('8192');
        expect(await t.photo()).toMatch(/^image \.png of \d+ bytes$/);
        expect(t.snapshots()).toEqual(['1.tif']);
        expect(applied.import.changed).toBe(true);
        expect(applied.import.undoDepth).toBe(1);
        expect(applied.job.applied).toMatchObject({ holes: [1, 2], undoDepth: 1 });
        expect(t.workLeft()).toEqual([]);

        // Applying it again would paint the same pixels twice over the undo history.
        await expect(t.cleanup.apply(TEST_COURSE_ID, id, [1])).rejects.toThrow(ConflictError);
    } finally {
        await t.removeAll();
    }
});

test('a failing hole is reported and the others still finish; it cannot be applied', async () => {
    const t = await setup({ failHole: hole => hole === 1 });
    try {
        const { id } = await t.cleanup.start(TEST_COURSE_ID);
        await t.cleanup.whenIdle(TEST_COURSE_ID);
        const job = await t.cleanup.job(TEST_COURSE_ID, id);
        expect(job.status).toBe('succeeded');
        expect(job.holes[0]).toMatchObject({ hole: 1, status: 'failed' });
        expect(job.holes[0].error).toMatch(/hole 1 lies outside the photo/);
        expect(job.holes[1]).toMatchObject({ hole: 2, status: 'done' });
        await expect(t.cleanup.apply(TEST_COURSE_ID, id, [1, 2])).rejects.toThrow(/Hole 1 was not cleaned/);
    } finally {
        await t.removeAll();
    }
});

test('a photo changed since the run is not painted over from the older copy', async () => {
    const t = await setup();
    try {
        const { id } = await t.cleanup.start(TEST_COURSE_ID);
        await t.cleanup.whenIdle(TEST_COURSE_ID);
        const later = new Date(Date.now() + 60_000);
        await utimes(t.cleanedPath, later, later);
        await expect(t.cleanup.apply(TEST_COURSE_ID, id, [1])).rejects.toThrow(/changed after this cleanup ran/);
        expect(t.snapshots()).toEqual([]);
    } finally {
        await t.removeAll();
    }
});

test('what cannot be run is refused before anything is copied', async () => {
    const t = await setup({ areas: null });
    try {
        await expect(t.cleanup.start(TEST_COURSE_ID)).rejects.toThrow(InvalidPhotoCleanupError);
        await expect(t.cleanup.start(TEST_COURSE_ID)).rejects.toThrow(/Draw cleanup areas first/);
        await t.ctx.db.insertInto('cleanup_areas').values({ site_id: SITE_ID, version: 1, areas_json: JSON.stringify([AREAS[1]]) }).execute();
        await expect(t.cleanup.start(TEST_COURSE_ID)).rejects.toThrow(/Draw cleanup areas first/);
        await t.ctx.db.updateTable('cleanup_areas').set({ areas_json: JSON.stringify(AREAS) }).execute();
        await expect(t.cleanup.start(TEST_COURSE_ID, [1, 7])).rejects.toThrow('The course has no hole 7');
        await expect(t.cleanup.start('no-such-course')).rejects.toThrow(NotFoundError);
        expect(existsSync(t.jobsDir)).toBe(false);

        // One run per course at a time.
        await t.cleanup.start(TEST_COURSE_ID);
        await expect(t.cleanup.start(TEST_COURSE_ID)).rejects.toThrow(ConflictError);
        await t.cleanup.whenIdle(TEST_COURSE_ID);
    } finally {
        await t.removeAll();
    }
});

test('a finished run is read back from disk by another process, with its review images', async () => {
    const t = await setup();
    try {
        expect(await t.cleanup.current(TEST_COURSE_ID)).toBeNull();
        const { id } = await t.cleanup.start(TEST_COURSE_ID, [1]);
        await t.cleanup.whenIdle(TEST_COURSE_ID);

        const other = t.make();
        const current = await other.current(TEST_COURSE_ID);
        expect(current).toMatchObject({ id, status: 'succeeded', applied: null });
        expect(current).not.toHaveProperty('siteId');
        expect(await other.image(TEST_COURSE_ID, id, 1, 'review')).toBe(path.join(t.jobsDir, id, 'h1', 'review.png'));
        await expect(other.image(TEST_COURSE_ID, id, 2, 'review')).rejects.toThrow(NotFoundError);
        await expect(other.job(TEST_COURSE_ID, '../../x')).rejects.toThrow(NotFoundError);
        // The CLI accepts in a later run.
        expect((await other.apply(TEST_COURSE_ID, id, [1])).import.changed).toBe(true);
    } finally {
        await t.removeAll();
    }
});

test(`only the newest ${KEEP_JOBS} runs of a site are kept`, async () => {
    const t = await setup();
    try {
        const ids: string[] = [];
        for (let i = 0; i < KEEP_JOBS + 2; i++) {
            ids.push((await t.cleanup.start(TEST_COURSE_ID, [1])).id);
            await t.cleanup.whenIdle(TEST_COURSE_ID);
            await Bun.sleep(5);
        }
        expect((await readdir(t.jobsDir)).sort()).toEqual(ids.slice(-KEEP_JOBS).sort());
    } finally {
        await t.removeAll();
    }
});
