import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createTestDb } from '@basics/core/server/testing';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { PublishService } from './publish.service';

const migrationFolder = path.join(import.meta.dir, '../db/migrations');
const dataDir = '/tmp/golf-map-publish-service-test';

const SITE_ID = 'site-1';
const COURSE_ID = 'course-1';

async function seed(db: Kysely<Database>): Promise<void> {
    await db.insertInto('sites').values({ id: SITE_ID, name: 'Test site', version: 1 }).execute();
    await db
        .insertInto('courses')
        .values({ id: COURSE_ID, name: 'Test course', status: 'draft', revision: 1, crs: 'EPSG:3006', georeference_json: null, home_lat: null, home_lon: null, notes: null, site_id: SITE_ID, version: 1 })
        .execute();
}

/** Runner whose steps resolve/reject on command; writes the bundle file `pack` promises. */
function fakeRunner(overrides: Partial<Record<'preflight' | 'bundle' | 'upload', () => Promise<never>>> = {}) {
    const calls: string[] = [];
    return {
        calls,
        runner: {
            preflight: async () => {
                calls.push('preflight');
                if (overrides.preflight) await overrides.preflight();
                return ['warn-a'];
            },
            buildBundle: async () => {
                calls.push('bundle');
                if (overrides.bundle) await overrides.bundle();
                return { stagingDir: path.join(dataDir, 'staging'), meta: {} as never, warnings: ['warn-b'], analysisDem: 'none' as const };
            },
            packBundle: async (_staging: string, outPath: string) => {
                calls.push('pack');
                writeFileSync(outPath, 'x'.repeat(42));
            },
            uploadBundle: async () => {
                calls.push('upload');
                if (overrides.upload) await overrides.upload();
                return {};
            },
        },
    };
}

async function settled(svc: PublishService): Promise<ReturnType<PublishService['status']>> {
    for (let i = 0; i < 100 && svc.status().status === 'running'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return svc.status();
}

describe('PublishService', () => {
    let db: Kysely<Database>;

    beforeEach(async () => {
        db = await createTestDb<Database>(migrationFolder);
        await seed(db);
        mkdirSync(path.join(dataDir, 'publish'), { recursive: true });
        process.env.PUBLISH_URL = 'https://vps.example';
        process.env.PUBLISH_TOKEN = 'secret';
    });

    afterEach(async () => {
        delete process.env.PUBLISH_URL;
        delete process.env.PUBLISH_TOKEN;
        rmSync(dataDir, { recursive: true, force: true });
        await db.destroy();
    });

    test('status reports unconfigured without env, never the token', () => {
        delete process.env.PUBLISH_TOKEN;
        const svc = new PublishService({ db, dataDir });
        const s = svc.status();
        expect(s.configured).toBe(false);
        expect(JSON.stringify(s)).not.toContain('secret');
    });

    test('happy path: runs all steps in order, collects warnings + bundle size', async () => {
        const { runner, calls } = fakeRunner();
        const svc = new PublishService({ db, dataDir }, runner);

        const accepted = await svc.start(COURSE_ID);
        expect(accepted.status).toBe('running');
        expect(accepted.siteId).toBe(SITE_ID);

        const s = await settled(svc);
        expect(s.status).toBe('succeeded');
        expect(calls).toEqual(['preflight', 'bundle', 'pack', 'upload']);
        expect(s.warnings).toEqual(['warn-a', 'warn-b']);
        expect(s.bundleBytes).toBe(42);
        expect(s.error).toBeNull();
    });

    test('failed step lands in failed state with the message, step preserved', async () => {
        const { runner } = fakeRunner({ upload: async () => { throw new Error('Ingest failed (HTTP 401)'); } });
        const svc = new PublishService({ db, dataDir }, runner);
        await svc.start(COURSE_ID);
        const s = await settled(svc);
        expect(s.status).toBe('failed');
        expect(s.step).toBe('upload');
        expect(s.error).toContain('HTTP 401');
    });

    test('rejects a second start while running; allows one after failure', async () => {
        let release!: () => void;
        const gate = new Promise<never>((_, reject) => {
            release = () => reject(new Error('boom'));
        });
        const { runner } = fakeRunner({ bundle: () => gate });
        const svc = new PublishService({ db, dataDir }, runner);

        await svc.start(COURSE_ID);
        expect(svc.start(COURSE_ID)).rejects.toThrow('already running');

        release();
        const failed = await settled(svc);
        expect(failed.status).toBe('failed');

        const again = await svc.start(COURSE_ID);
        expect(again.status).toBe('running');
    });

    test('rejects unknown course and missing env before mutating state', async () => {
        const { runner } = fakeRunner();
        const svc = new PublishService({ db, dataDir }, runner);
        expect(svc.start('nope')).rejects.toThrow('not found');

        delete process.env.PUBLISH_URL;
        expect(svc.start(COURSE_ID)).rejects.toThrow('PUBLISH_URL');
        expect(svc.status().status).toBe('idle');
    });
});
