/**
 * Replace a course's generated features straight in the local app.sqlite —
 * no HTTP, no auth. Same code path as
 * `PUT /api/courses/:courseId/features/generated` (CourseFeaturesService
 * .replaceGenerated): deletes every feature of the course with the given
 * `source`, inserts the FeatureCollection's polygons, one transaction.
 *
 * Usage (cwd = server/):
 *   bun scripts/import-generated-features.ts <courseId> <geojson-path>
 *       [--source lidar-canopy] [--db ../data/app.sqlite]
 *
 * The GeoJSON must follow the property contract in server/AGENTS.md
 * (EPSG:3006 Polygons; properties.type / source / source_ref / license,
 * remaining scalars become attributes). Do not run it against a DB the
 * server has open for writing at the same moment; WAL readers are fine.
 */
import * as path from 'node:path';
import { createDb } from '@basics/core/server/db';
import { runMigrations } from '@basics/core/server/migrate';
import type { Database } from '../db/schema';
import { CourseFeaturesService, InvalidFeatureError } from '../services/course-features.service';

export interface ImportArgs {
    courseId: string;
    geojsonPath: string;
    source: string;
    dbPath: string;
}

export function parseArgs(argv: string[]): ImportArgs {
    const positional: string[] = [];
    let source = 'lidar-canopy';
    let dbPath = process.env.DB_PATH ?? '../data/app.sqlite';
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--source') source = argv[++i] ?? '';
        else if (a === '--db') dbPath = argv[++i] ?? '';
        else if (a.startsWith('--')) throw new Error(`Unknown flag ${a}`);
        else positional.push(a);
    }
    const [courseId, geojsonPath] = positional;
    if (!courseId || !geojsonPath) {
        throw new Error(
            'Usage: bun scripts/import-generated-features.ts <courseId> <geojson-path> [--source lidar-canopy] [--db ../data/app.sqlite]',
        );
    }
    return { courseId, geojsonPath, source, dbPath };
}

export async function importGeneratedFeatures(args: ImportArgs): Promise<{ deleted: number; inserted: number }> {
    const collection = await Bun.file(args.geojsonPath).json();
    const db = createDb<Database>(args.dbPath);
    try {
        await runMigrations(db, path.join(import.meta.dir, '../db/migrations'));
        return await new CourseFeaturesService(db).replaceGenerated(args.courseId, args.source, collection);
    } finally {
        await db.destroy();
    }
}

if (import.meta.main) {
    try {
        const args = parseArgs(Bun.argv.slice(2));
        const { deleted, inserted } = await importGeneratedFeatures(args);
        console.log(`course ${args.courseId} source ${args.source}: deleted ${deleted}, inserted ${inserted}`);
    } catch (err) {
        if (err instanceof InvalidFeatureError) console.error(`Invalid input: ${err.message}`);
        else console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}
