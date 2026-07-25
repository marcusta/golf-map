import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import * as os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createTestDb as createRawDb } from '@basics/core/server/testing';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { buildBundle } from './publish';
import { preflight } from './publish';
import { CONTENT_HASH_FILES, CONTENT_TABLES, contentHash } from '../services/bundle';

const migrationFolder = path.join(import.meta.dir, '../db/migrations');
const SITE_ID = 'site-1';

function tmp(prefix: string): string {
    return mkdtempSync(path.join(os.tmpdir(), `golf-${prefix}-`));
}

async function seedBuilder(dataDir: string): Promise<Kysely<Database>> {
    const db = await createRawDb<Database>(migrationFolder);
    await db.insertInto('sites').values({ id: SITE_ID, name: 'Linkan', version: 1 }).execute();
    await seedCourse({ db } as never);
    await db.updateTable('courses').set({ site_id: SITE_ID }).where('id', '=', TEST_COURSE_ID).execute();

    const tilesRoot = path.join(dataDir, 'tiles', SITE_ID);
    const writeTile = (rel: string) => {
        const p = path.join(tilesRoot, rel);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, 'x');
    };
    for (const z of [14, 17, 19, 20, 21]) writeTile(`ortho/${z}/1/1.jpg`);
    writeTile('ortho/vintage-2023/19/1/1.jpg'); // collection subdir — must be skipped
    writeTile('terrain/14/1/1.png');
    writeTile('hillshade/14/1/1.png');
    writeFileSync(
        path.join(tilesRoot, 'manifest.json'),
        JSON.stringify({ layers: { ortho: { minzoom: 14, maxzoom: 21 }, terrain: { minzoom: 14, maxzoom: 14 } } }),
    );
    return db;
}

describe('publish buildBundle (W2)', () => {
    test('caps ortho at z19 by default, excludes higher zooms and collection subdirs', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const outDir = tmp('stage');

        const { stagingDir, meta } = await buildBundle({ db, dataDir }, { siteId: SITE_ID, outDir });

        const orthoDir = path.join(stagingDir, 'tiles', 'ortho');
        expect(existsSync(path.join(orthoDir, '14/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(orthoDir, '17/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(orthoDir, '19/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(orthoDir, '20/1/1.jpg'))).toBe(false);
        expect(existsSync(path.join(orthoDir, '21/1/1.jpg'))).toBe(false);
        expect(existsSync(path.join(orthoDir, 'vintage-2023'))).toBe(false);

        // Other layers travel uncapped.
        expect(existsSync(path.join(stagingDir, 'tiles', 'terrain', '14/1/1.png'))).toBe(true);
        expect(existsSync(path.join(stagingDir, 'tiles', 'hillshade', '14/1/1.png'))).toBe(true);

        // Manifest ortho maxzoom rewritten to the cap.
        const manifest = JSON.parse(await Bun.file(path.join(stagingDir, 'tiles', 'manifest.json')).text());
        expect(manifest.layers.ortho.maxzoom).toBe(19);

        expect(meta.orthoMaxzoom).toBe(19);
        expect(meta.layerZoomRanges.ortho).toEqual({ minzoom: 14, maxzoom: 19 });
        expect(meta.courseIds).toEqual([TEST_COURSE_ID]);
    });

    test('a custom ortho cap is honored', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const { stagingDir, meta } = await buildBundle({ db, dataDir }, { siteId: SITE_ID, outDir: tmp('stage'), orthoMaxzoom: 17 });
        expect(meta.orthoMaxzoom).toBe(17);
        expect(existsSync(path.join(stagingDir, 'tiles', 'ortho', '17/1/1.jpg'))).toBe(true);
        expect(existsSync(path.join(stagingDir, 'tiles', 'ortho', '19/1/1.jpg'))).toBe(false);
        const manifest = JSON.parse(await Bun.file(path.join(stagingDir, 'tiles', 'manifest.json')).text());
        expect(manifest.layers.ortho.maxzoom).toBe(17);
    });

    test('writes a content jsonl for every table and a matching content hash', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        const { stagingDir, meta } = await buildBundle({ db, dataDir }, { siteId: SITE_ID, outDir: tmp('stage') });

        for (const table of CONTENT_TABLES) {
            expect(existsSync(path.join(stagingDir, 'content', `${table}.jsonl`))).toBe(true);
        }
        const courses = (await Bun.file(path.join(stagingDir, 'content', 'courses.jsonl')).text()).trim().split('\n');
        expect(courses.length).toBe(1);
        expect(JSON.parse(courses[0]).id).toBe(TEST_COURSE_ID);

        // Recompute the hash over the fixed file set — must match meta.
        const parts: Buffer[] = [];
        for (const rel of CONTENT_HASH_FILES) {
            const f = Bun.file(path.join(stagingDir, rel));
            parts.push((await f.exists()) ? Buffer.from(await f.arrayBuffer()) : Buffer.alloc(0));
        }
        expect(contentHash(parts)).toBe(meta.contentHash);
    });

    test('preflight rejects a running map build', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await db
            .insertInto('map_build_jobs')
            .values({ id: 'job-1', course_id: TEST_COURSE_ID, site_id: SITE_ID, status: 'running', step: null, bbox_json: '{}', log: '', error: null })
            .execute();
        await expect(preflight({ db, dataDir }, SITE_ID)).rejects.toThrow(/map build is in progress/);
    });

    test('preflight rejects an unknown site', async () => {
        const dataDir = tmp('builder');
        const db = await seedBuilder(dataDir);
        await expect(preflight({ db, dataDir }, 'nope')).rejects.toThrow(/not found/);
    });
});
