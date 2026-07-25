/**
 * obs.sqlite rotation (T63, §10 / W6).
 *
 * The framework already prunes raw `traces` on a TTL (TRACE_TTL_DAYS, hourly,
 * see @basics/core/server/app.ts). Nothing prunes the other three tables:
 * `metrics_rollups` grows one row per path per minute forever, and
 * `analytics_events` / `error_reports` grow with traffic. That is why the local
 * obs.sqlite is tens of megabytes — on a small VPS it is the one file that
 * grows without an owner.
 *
 * This is that owner: an age prune per table, an optional hard size cap for the
 * case where a burst outruns the TTLs, then VACUUM to actually return the pages
 * to the filesystem. Run it from a systemd timer — see
 * docs/reference/vps-serve-runbook.md.
 *
 * Usage (cwd = server/):
 *   bun run scripts/obs-rotate.ts [--trace-days 3] [--event-days 30]
 *                                 [--rollup-days 30] [--error-days 30]
 *                                 [--max-mb 64] [--db <path>]
 *
 * Env: OBS_DB_PATH (default ./data/obs.sqlite), OBS_MAX_MB.
 *
 * Safe to run against a live server: every statement is a bounded DELETE, and
 * WAL mode means readers keep working through it. VACUUM takes a write lock for
 * its duration — on a file this size that is well under a second.
 */
import { statSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { createDb } from '@basics/core/server/db';
import type { ObsDatabase } from '@basics/core/server/obs/schema';

/** The obs tables this rotates, each keyed by its ISO `timestamp` column. */
export const OBS_TABLES = ['traces', 'analytics_events', 'metrics_rollups', 'error_reports'] as const;
export type ObsTable = (typeof OBS_TABLES)[number];

export interface ObsRotateOptions {
    /** Per-table age cap in days. A table omitted here is not age-pruned. */
    ttlDays: Partial<Record<ObsTable, number>>;
    /**
     * Optional hard cap on the database's live size. When the age prune leaves
     * it above this, the oldest rows are dropped (largest table first) until it
     * fits. A TTL keeps normal operation tidy; this keeps a bad day bounded.
     */
    maxBytes?: number;
    /** Clock injection point for tests. */
    now?: Date;
}

export interface ObsRotateReport {
    deleted: Record<ObsTable, number>;
    remaining: Record<ObsTable, number>;
    /** File size on disk before/after (post-VACUUM). */
    bytesBefore: number;
    bytesAfter: number;
    /** True when the size cap had to drop rows the TTLs would have kept. */
    cappedBySize: boolean;
}

export const DEFAULT_TTL_DAYS: Record<ObsTable, number> = {
    // Matches TRACE_TTL_DAYS' default; the framework's hourly prune normally
    // gets here first, this is the backstop when the process has been down.
    traces: 3,
    analytics_events: 30,
    metrics_rollups: 30,
    error_reports: 30,
};

const DAY_MS = 86_400_000;
/** Rows dropped per pass when trimming to the size cap. */
const TRIM_BATCH = 5_000;

/**
 * Bytes this database occupies on disk: the main file plus its WAL. In WAL mode
 * the main file does not shrink until a checkpoint, and a freshly VACUUMed
 * database parks the whole rewrite in the WAL — measuring only the main file
 * would report a shrink that has not happened, or miss one that has.
 */
function dbBytes(dbPath: string): number {
    let total = statSync(dbPath).size;
    try {
        total += statSync(`${dbPath}-wal`).size;
    } catch {
        // absent — not in WAL mode, or already checkpointed away
    }
    return total; // -shm is a fixed-size scratch mapping, not stored data
}

/** Live size in bytes: allocated pages minus the freelist (post-DELETE, pre-VACUUM). */
async function liveBytes(db: Kysely<ObsDatabase>): Promise<number> {
    const page = await sql<{ page_size: number }>`PRAGMA page_size`.execute(db);
    const count = await sql<{ page_count: number }>`PRAGMA page_count`.execute(db);
    const free = await sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(db);
    const pageSize = page.rows[0]?.page_size ?? 4096;
    const pages = (count.rows[0]?.page_count ?? 0) - (free.rows[0]?.freelist_count ?? 0);
    return pages * pageSize;
}

async function countRows(db: Kysely<ObsDatabase>, table: ObsTable): Promise<number> {
    const row = await db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirst();
    return Number(row?.n ?? 0);
}

/**
 * Delete the oldest `limit` rows of `table`. Uses rowid rather than the primary
 * key because `traces` is keyed by trace_id, not an ordered id.
 *
 * Row counts are always taken by counting, never from the driver's affected-row
 * report: kysely-bun-sqlite returns 0/undefined for DELETE, so trusting it
 * would make this loop spin on a database it is emptying correctly.
 */
async function deleteOldest(db: Kysely<ObsDatabase>, table: ObsTable, limit: number): Promise<void> {
    await sql`
        delete from ${sql.table(table)}
        where rowid in (select rowid from ${sql.table(table)} order by timestamp limit ${limit})
    `.execute(db);
}

/**
 * Age-prune, optionally size-cap, then VACUUM. Exported for the integration
 * test — the CLI below is just argument parsing around it.
 */
export async function rotateObs(
    db: Kysely<ObsDatabase>,
    dbPath: string,
    opts: ObsRotateOptions,
): Promise<ObsRotateReport> {
    const now = opts.now ?? new Date();
    const bytesBefore = dbBytes(dbPath);

    const before: Record<ObsTable, number> = {
        traces: 0, analytics_events: 0, metrics_rollups: 0, error_reports: 0,
    };
    for (const table of OBS_TABLES) before[table] = await countRows(db, table);

    for (const table of OBS_TABLES) {
        const days = opts.ttlDays[table];
        if (days === undefined) continue;
        const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
        await db.deleteFrom(table).where('timestamp', '<', cutoff).execute();
    }

    // Size cap: trim the biggest table repeatedly rather than one table to
    // zero, so a flood in one dimension can't evict everything else.
    let cappedBySize = false;
    if (opts.maxBytes !== undefined) {
        while (await liveBytes(db) > opts.maxBytes) {
            const counts = await Promise.all(OBS_TABLES.map(async (t) => [t, await countRows(db, t)] as const));
            const [biggest, rows] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
            if (rows === 0) break; // nothing left to drop — the floor is the schema itself
            await deleteOldest(db, biggest, Math.min(TRIM_BATCH, rows));
            cappedBySize = true;
        }
    }

    // Return the freed pages to the filesystem. Without the checkpoints this is
    // invisible to `df`: VACUUM's rewrite lands in the WAL, and the main file
    // keeps its high-water mark until the WAL is folded back in and truncated.
    await sql`VACUUM`.execute(db);
    await sql`PRAGMA wal_checkpoint(TRUNCATE)`.execute(db);

    const remaining: Record<ObsTable, number> = {
        traces: 0, analytics_events: 0, metrics_rollups: 0, error_reports: 0,
    };
    const deleted: Record<ObsTable, number> = {
        traces: 0, analytics_events: 0, metrics_rollups: 0, error_reports: 0,
    };
    for (const table of OBS_TABLES) {
        remaining[table] = await countRows(db, table);
        deleted[table] = before[table] - remaining[table];
    }

    return { deleted, remaining, bytesBefore, bytesAfter: dbBytes(dbPath), cappedBySize };
}

function numberArg(args: string[], flag: string): number | undefined {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const value = Number(args[i + 1]);
    if (!Number.isFinite(value)) throw new Error(`${flag} needs a number`);
    return value;
}

export function parseArgs(args: string[]): { dbPath: string; opts: ObsRotateOptions } {
    const dbIndex = args.indexOf('--db');
    const dbPath = dbIndex === -1
        ? process.env.OBS_DB_PATH ?? './data/obs.sqlite'
        : args[dbIndex + 1]!;
    const maxMb = numberArg(args, '--max-mb')
        ?? (process.env.OBS_MAX_MB ? Number(process.env.OBS_MAX_MB) : undefined);
    return {
        dbPath,
        opts: {
            ttlDays: {
                traces: numberArg(args, '--trace-days') ?? DEFAULT_TTL_DAYS.traces,
                analytics_events: numberArg(args, '--event-days') ?? DEFAULT_TTL_DAYS.analytics_events,
                metrics_rollups: numberArg(args, '--rollup-days') ?? DEFAULT_TTL_DAYS.metrics_rollups,
                error_reports: numberArg(args, '--error-days') ?? DEFAULT_TTL_DAYS.error_reports,
            },
            ...(maxMb !== undefined ? { maxBytes: maxMb * 1024 * 1024 } : {}),
        },
    };
}

function mb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

if (import.meta.main) {
    const { dbPath, opts } = parseArgs(process.argv.slice(2));
    const db = createDb<ObsDatabase>(dbPath);
    try {
        const report = await rotateObs(db, dbPath, opts);
        for (const table of OBS_TABLES) {
            console.log(`  ${table.padEnd(17)} -${report.deleted[table]} → ${report.remaining[table]} rows`);
        }
        console.log(`obs.sqlite ${mb(report.bytesBefore)} → ${mb(report.bytesAfter)}`
            + (report.cappedBySize ? ' (size cap hit — consider lowering the TTLs)' : ''));
    } finally {
        await db.destroy();
    }
}
