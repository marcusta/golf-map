/**
 * Safely consolidates a duplicate 1:1 course site into a canonical shared site.
 *
 * Dry-run (the default):
 *   bun scripts/consolidate-shared-site.ts \
 *     --db ../data/app.sqlite --data-dir ../data \
 *     --canonical-course 26D37361-D79C-41AA-AA49-92F2C2277222 \
 *     --duplicate-course 7CE5653E-5900-446A-8324-E527B95CB10F \
 *     --canonical-site 26D37361-D79C-41AA-AA49-92F2C2277222 \
 *     --duplicate-site 7CE5653E-5900-446A-8324-E527B95CB10F
 *
 * Add --apply only after reviewing the dry-run. The script never recursively
 * removes a path: the only filesystem mutation is unlinking a verified symlink.
 */
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ConsolidateOptions {
    dbPath: string;
    dataDir: string;
    canonicalCourseId: string;
    duplicateCourseId: string;
    canonicalSiteId: string;
    duplicateSiteId: string;
    apply: boolean;
}

interface CourseRow {
    id: string;
    name: string;
    site_id: string | null;
    version: number;
    updated_at: string;
}

interface SiteRow {
    id: string;
    name: string;
}

interface AssetRow {
    id: string;
    kind: string;
    meta_json: string | null;
}

export interface ConsolidationPlan {
    canonicalCourse: CourseRow;
    duplicateCourse: CourseRow;
    canonicalSite: SiteRow;
    duplicateSite: SiteRow;
    canonicalTilePath: string;
    duplicateTilePath: string;
    canonicalAssetCount: number;
    duplicateAssetCount: number;
}

export interface ConsolidationResult {
    applied: boolean;
    plan: ConsolidationPlan;
    postconditions: string[];
}

function invariant(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`Preflight failed: ${message}`);
}

function one<T>(db: Database, sql: string, value: string, label: string): T {
    const row = db.query(sql).get(value) as T | null;
    invariant(row, `${label} does not exist: ${value}`);
    return row;
}

function normalizeJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizeJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, child]) => [key, normalizeJson(child)]),
        );
    }
    return value;
}

function normalizedMeta(meta: string | null): string {
    if (meta === null) return '<null>';
    try {
        return JSON.stringify(normalizeJson(JSON.parse(meta)));
    } catch {
        return `raw:${meta}`;
    }
}

function assetSignature(rows: AssetRow[]): string[] {
    return rows.map((row) => `${row.kind}\u0000${normalizedMeta(row.meta_json)}`).sort();
}

function sameStrings(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertTileLayout(canonicalTilePath: string, duplicateTilePath: string): void {
    invariant(path.resolve(canonicalTilePath) !== path.resolve(duplicateTilePath), 'site IDs resolve to the same tile path');

    let canonicalStat: fs.Stats;
    try {
        canonicalStat = fs.lstatSync(canonicalTilePath);
    } catch {
        throw new Error(`Preflight failed: canonical tile tree does not exist: ${canonicalTilePath}`);
    }
    invariant(canonicalStat.isDirectory() && !canonicalStat.isSymbolicLink(),
        `canonical tile tree must be a real directory: ${canonicalTilePath}`);

    let duplicateStat: fs.Stats;
    try {
        duplicateStat = fs.lstatSync(duplicateTilePath);
    } catch {
        throw new Error(`Preflight failed: duplicate tile path does not exist: ${duplicateTilePath}`);
    }
    invariant(duplicateStat.isSymbolicLink(),
        `duplicate tile path must be a symlink (real directories are never deleted): ${duplicateTilePath}`);

    const canonicalRealPath = fs.realpathSync(canonicalTilePath);
    const duplicateRealPath = fs.realpathSync(duplicateTilePath);
    invariant(duplicateRealPath === canonicalRealPath,
        `duplicate tile symlink resolves to ${duplicateRealPath}, not canonical ${canonicalRealPath}`);
}

export function preflight(db: Database, options: ConsolidateOptions): ConsolidationPlan {
    invariant(options.canonicalCourseId !== options.duplicateCourseId, 'course IDs must differ');
    invariant(options.canonicalSiteId !== options.duplicateSiteId, 'site IDs must differ');

    const canonicalCourse = one<CourseRow>(db,
        'SELECT id, name, site_id, version, updated_at FROM courses WHERE id = ?',
        options.canonicalCourseId, 'canonical course');
    const duplicateCourse = one<CourseRow>(db,
        'SELECT id, name, site_id, version, updated_at FROM courses WHERE id = ?',
        options.duplicateCourseId, 'duplicate course');
    const canonicalSite = one<SiteRow>(db, 'SELECT id, name FROM sites WHERE id = ?',
        options.canonicalSiteId, 'canonical site');
    const duplicateSite = one<SiteRow>(db, 'SELECT id, name FROM sites WHERE id = ?',
        options.duplicateSiteId, 'duplicate site');

    invariant(canonicalCourse.site_id === options.canonicalSiteId,
        `canonical course points at site ${canonicalCourse.site_id ?? '<null>'}, expected ${options.canonicalSiteId}`);
    invariant(duplicateCourse.site_id === options.duplicateSiteId,
        `duplicate course points at site ${duplicateCourse.site_id ?? '<null>'}, expected ${options.duplicateSiteId}`);

    const duplicateSiteCourses = db.query('SELECT id FROM courses WHERE site_id = ? ORDER BY id')
        .all(options.duplicateSiteId) as Array<{ id: string }>;
    invariant(duplicateSiteCourses.length === 1 && duplicateSiteCourses[0].id === options.duplicateCourseId,
        `duplicate site is referenced by courses other than ${options.duplicateCourseId}`);

    const buildJobCount = (db.query('SELECT COUNT(*) AS count FROM map_build_jobs WHERE site_id = ?')
        .get(options.duplicateSiteId) as { count: number }).count;
    invariant(buildJobCount === 0,
        `duplicate site is still referenced by ${buildJobCount} map build job(s)`);

    const canonicalAssets = db.query(
        'SELECT id, kind, meta_json FROM course_assets WHERE site_id = ? ORDER BY id',
    ).all(options.canonicalSiteId) as AssetRow[];
    const duplicateAssets = db.query(
        'SELECT id, kind, meta_json FROM course_assets WHERE site_id = ? ORDER BY id',
    ).all(options.duplicateSiteId) as AssetRow[];
    invariant(canonicalAssets.length > 0, 'canonical site has no asset rows');
    invariant(duplicateAssets.length > 0, 'duplicate site has no asset rows');
    invariant(sameStrings(assetSignature(canonicalAssets), assetSignature(duplicateAssets)),
        'duplicate asset rows do not match canonical rows by kind and meta_json');

    const canonicalTilePath = path.resolve(options.dataDir, 'tiles', options.canonicalSiteId);
    const duplicateTilePath = path.resolve(options.dataDir, 'tiles', options.duplicateSiteId);
    assertTileLayout(canonicalTilePath, duplicateTilePath);

    return {
        canonicalCourse,
        duplicateCourse,
        canonicalSite,
        duplicateSite,
        canonicalTilePath,
        duplicateTilePath,
        canonicalAssetCount: canonicalAssets.length,
        duplicateAssetCount: duplicateAssets.length,
    };
}

function plannedPostconditions(plan: ConsolidationPlan, options: ConsolidateOptions): string[] {
    return [
        `${plan.duplicateCourse.name} points to canonical site ${options.canonicalSiteId}`,
        `course version increments ${plan.duplicateCourse.version} -> ${plan.duplicateCourse.version + 1}`,
        `${plan.duplicateAssetCount} duplicate asset row(s) are removed`,
        `duplicate site ${options.duplicateSiteId} is removed`,
        `duplicate tile symlink ${plan.duplicateTilePath} is removed`,
        `canonical tile directory remains at ${plan.canonicalTilePath}`,
    ];
}

export function consolidateSharedSite(options: ConsolidateOptions): ConsolidationResult {
    const dbPath = path.resolve(options.dbPath);
    invariant(fs.existsSync(dbPath), `database does not exist: ${dbPath}`);
    const db = new Database(dbPath, options.apply ? undefined : { readonly: true });

    try {
        const plan = preflight(db, { ...options, dbPath });
        if (!options.apply) {
            return { applied: false, plan, postconditions: plannedPostconditions(plan, options) };
        }

        const applyTransaction = db.transaction(() => {
            // Repeat every check after BEGIN IMMEDIATE, so the mutation uses the
            // exact database and filesystem state that passed preflight.
            const lockedPlan = preflight(db, { ...options, dbPath });
            db.query(`
                UPDATE courses
                SET site_id = ?, version = version + 1, updated_at = datetime('now')
                WHERE id = ? AND site_id = ?
            `).run(options.canonicalSiteId, options.duplicateCourseId, options.duplicateSiteId);
            db.query('DELETE FROM course_assets WHERE site_id = ?').run(options.duplicateSiteId);
            db.query('DELETE FROM sites WHERE id = ?').run(options.duplicateSiteId);

            const updated = db.query('SELECT site_id, version FROM courses WHERE id = ?')
                .get(options.duplicateCourseId) as { site_id: string | null; version: number };
            invariant(updated.site_id === options.canonicalSiteId,
                'duplicate course was not repointed to the canonical site');
            invariant(updated.version === lockedPlan.duplicateCourse.version + 1,
                'duplicate course version was not incremented exactly once');
            invariant((db.query('SELECT COUNT(*) AS count FROM course_assets WHERE site_id = ?')
                .get(options.duplicateSiteId) as { count: number }).count === 0,
                'duplicate asset rows remain');
            invariant((db.query('SELECT COUNT(*) AS count FROM sites WHERE id = ?')
                .get(options.duplicateSiteId) as { count: number }).count === 0,
                'duplicate site remains');

        });
        applyTransaction.immediate();

        // Filesystem changes cannot participate in SQLite rollback. Only unlink
        // after the database commit succeeds: an unlink failure then leaves a
        // harmless duplicate link instead of a rolled-back DB with its link gone.
        // Revalidation closes the gap between preflight and cleanup. unlinkSync
        // removes the link itself and cannot recursively delete a directory.
        try {
            assertTileLayout(plan.canonicalTilePath, plan.duplicateTilePath);
            fs.unlinkSync(plan.duplicateTilePath);
        } catch (error) {
            throw new Error(
                'Database consolidation committed, but duplicate tile symlink cleanup failed. ' +
                `Inspect ${plan.duplicateTilePath}. Cause: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        const postconditions = plannedPostconditions(plan, options);
        const updated = db.query('SELECT site_id, version, updated_at FROM courses WHERE id = ?')
            .get(options.duplicateCourseId) as { site_id: string | null; version: number; updated_at: string };
        invariant(updated.site_id === options.canonicalSiteId, 'postcondition: course site_id is incorrect');
        invariant(updated.version === plan.duplicateCourse.version + 1, 'postcondition: course version is incorrect');
        invariant(!fs.existsSync(plan.duplicateTilePath), 'postcondition: duplicate tile path still exists');
        invariant(fs.statSync(plan.canonicalTilePath).isDirectory(), 'postcondition: canonical tile tree is missing');
        return { applied: true, plan, postconditions };
    } finally {
        db.close();
    }
}

function usage(): string {
    return `Usage:
  bun scripts/consolidate-shared-site.ts \\
    --db PATH --data-dir PATH \\
    --canonical-course ID --duplicate-course ID \\
    --canonical-site ID --duplicate-site ID [--apply]

Dry-run is the default. All paths and IDs are required; --apply performs the transaction.`;
}

function parseArgs(args: string[]): ConsolidateOptions {
    const values = new Map<string, string>();
    let apply = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--apply') {
            apply = true;
            continue;
        }
        invariant(arg.startsWith('--'), `unexpected argument: ${arg}`);
        const value = args[++index];
        invariant(value && !value.startsWith('--'), `missing value for ${arg}`);
        values.set(arg, value);
    }
    const required = (flag: string): string => {
        const value = values.get(flag);
        invariant(value, `required flag is missing: ${flag}`);
        return value;
    };
    return {
        dbPath: required('--db'),
        dataDir: required('--data-dir'),
        canonicalCourseId: required('--canonical-course'),
        duplicateCourseId: required('--duplicate-course'),
        canonicalSiteId: required('--canonical-site'),
        duplicateSiteId: required('--duplicate-site'),
        apply,
    };
}

function main(): void {
    try {
        if (Bun.argv.includes('--help') || Bun.argv.includes('-h')) {
            console.log(usage());
            return;
        }
        const options = parseArgs(Bun.argv.slice(2));
        const result = consolidateSharedSite(options);
        console.log(result.applied ? 'APPLIED shared-site consolidation.' : 'DRY RUN only; no changes made.');
        console.log(`database: ${path.resolve(options.dbPath)}`);
        console.log(`canonical: ${result.plan.canonicalCourse.name} -> ${result.plan.canonicalSite.name}`);
        console.log(`duplicate: ${result.plan.duplicateCourse.name} -> ${result.plan.duplicateSite.name}`);
        console.log(`asset rows: canonical=${result.plan.canonicalAssetCount}, duplicate=${result.plan.duplicateAssetCount}`);
        console.log(result.applied ? 'Postconditions:' : 'Planned postconditions:');
        for (const postcondition of result.postconditions) console.log(`  - ${postcondition}`);
        if (!result.applied) console.log('Re-run with the same flags plus --apply to execute.');
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(usage());
        process.exitCode = 1;
    }
}

if (import.meta.main) main();
