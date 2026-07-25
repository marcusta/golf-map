/**
 * obs.sqlite rotation against a real obs database — the framework's own obs
 * migrations, a real file on disk, real VACUUM. The point of the file cap is a
 * number `df` agrees with, so nothing here is simulated.
 */
import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtempSync, statSync } from 'node:fs';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { ObsDatabase } from '@basics/core/server/obs/schema';
import { rotateObs, parseArgs, DEFAULT_TTL_DAYS, OBS_TABLES } from './obs-rotate';

const OBS_MIGRATIONS = path.join(
    import.meta.dir,
    '../node_modules/@basics/core/server/obs/migrations',
);

const NOW = new Date('2026-07-25T12:00:00.000Z');
const DAY_MS = 86_400_000;

function daysAgo(days: number): string {
    return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

async function obsDb(): Promise<{ db: ReturnType<typeof createDb<ObsDatabase>>; dbPath: string }> {
    const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'golf-obs-')), 'obs.sqlite');
    const db = createDb<ObsDatabase>(dbPath);
    await runMigrations(db, OBS_MIGRATIONS);
    return { db, dbPath };
}

/** `count` traces at `ageDays`, with a padded path so the rows have real bulk. */
async function seedTraces(db: any, count: number, ageDays: number, tag = 't'): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
        trace_id: `${tag}-${ageDays}-${i}`,
        method: 'GET',
        path: `/api/courses/${'x'.repeat(200)}/${i}`,
        status: 200,
        duration_ms: 12.5,
        user_id: null,
        timestamp: daysAgo(ageDays),
    }));
    for (let i = 0; i < rows.length; i += 500) {
        await db.insertInto('traces').values(rows.slice(i, i + 500)).execute();
    }
}

async function seedRollups(db: any, count: number, ageDays: number): Promise<void> {
    const rows = Array.from({ length: count }, (_, i) => ({
        period: 'minute',
        bucket: `/api/courses/${i}`,
        requests: 3,
        errors: 0,
        p50_ms: 4,
        p95_ms: 9,
        timestamp: daysAgo(ageDays),
    }));
    await db.insertInto('metrics_rollups').values(rows).execute();
}

describe('obs.sqlite rotation (W6)', () => {
    test('age-prunes every obs table and shrinks the file', async () => {
        const { db, dbPath } = await obsDb();
        await seedTraces(db, 2_000, 10, 'old');
        await seedTraces(db, 200, 1, 'new');
        await seedRollups(db, 2_000, 90);
        await seedRollups(db, 50, 2);
        await db.insertInto('analytics_events').values([
            { event: 'old', user_id: null, metadata: null, timestamp: daysAgo(90) },
            { event: 'fresh', user_id: null, metadata: null, timestamp: daysAgo(1) },
        ]).execute();
        await db.insertInto('error_reports').values([
            { code: 'E', message: 'old', url: '/x', trace_id: null, user_id: null, context: null, timestamp: daysAgo(90) },
            { code: 'E', message: 'fresh', url: '/x', trace_id: null, user_id: null, context: null, timestamp: daysAgo(1) },
        ]).execute();

        const report = await rotateObs(db, dbPath, { ttlDays: DEFAULT_TTL_DAYS, now: NOW });

        expect(report.deleted.traces).toBe(2_000);
        expect(report.deleted.metrics_rollups).toBe(2_000);
        expect(report.deleted.analytics_events).toBe(1);
        expect(report.deleted.error_reports).toBe(1);
        // Recent rows are untouched — rotation is not a truncate.
        expect(report.remaining.traces).toBe(200);
        expect(report.remaining.metrics_rollups).toBe(50);
        expect(report.remaining.analytics_events).toBe(1);
        expect(report.remaining.error_reports).toBe(1);
        expect(report.cappedBySize).toBe(false);

        // VACUUM + checkpoint ran: the freed pages left the filesystem rather
        // than sitting on a freelist or in the WAL. `df` would agree — after
        // the truncating checkpoint the main file IS the database.
        expect(report.bytesAfter).toBeLessThan(report.bytesBefore / 2);
        expect(statSync(dbPath).size).toBe(report.bytesAfter);

        await db.destroy();
    });

    test('the size cap bounds a burst the TTLs would have kept', async () => {
        const { db, dbPath } = await obsDb();
        // Everything is one hour old: no TTL can touch it. Only the cap can.
        await seedTraces(db, 6_000, 1 / 24);
        await seedRollups(db, 6_000, 1 / 24);

        const cap = 256 * 1024;
        const report = await rotateObs(db, dbPath, {
            ttlDays: DEFAULT_TTL_DAYS,
            maxBytes: cap,
            now: NOW,
        });

        expect(report.cappedBySize).toBe(true);
        expect(report.bytesAfter).toBeLessThanOrEqual(cap * 1.1);
        // It trims, it does not empty: the newest rows survive.
        const kept = OBS_TABLES.reduce((n, t) => n + report.remaining[t], 0);
        expect(kept).toBeGreaterThan(0);
        expect(kept).toBeLessThan(12_000);

        await db.destroy();
    });

    test('an already-tidy database is a no-op that still reports', async () => {
        const { db, dbPath } = await obsDb();
        await seedTraces(db, 100, 1);

        const report = await rotateObs(db, dbPath, { ttlDays: DEFAULT_TTL_DAYS, now: NOW });

        expect(report.deleted.traces).toBe(0);
        expect(report.remaining.traces).toBe(100);
        expect(report.cappedBySize).toBe(false);

        await db.destroy();
    });

    test('CLI args override the defaults; env supplies the db path', () => {
        const fromEnv = parseArgs([]);
        expect(fromEnv.dbPath).toBe(process.env.OBS_DB_PATH ?? './data/obs.sqlite');
        expect(fromEnv.opts.ttlDays).toEqual(DEFAULT_TTL_DAYS);
        expect(fromEnv.opts.maxBytes).toBeUndefined();

        const explicit = parseArgs(['--db', '/srv/obs.sqlite', '--trace-days', '1', '--rollup-days', '7', '--max-mb', '64']);
        expect(explicit.dbPath).toBe('/srv/obs.sqlite');
        expect(explicit.opts.ttlDays.traces).toBe(1);
        expect(explicit.opts.ttlDays.metrics_rollups).toBe(7);
        expect(explicit.opts.ttlDays.analytics_events).toBe(DEFAULT_TTL_DAYS.analytics_events);
        expect(explicit.opts.maxBytes).toBe(64 * 1024 * 1024);
    });
});
