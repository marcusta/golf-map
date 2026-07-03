import * as path from 'node:path';
import { createTestDb as _createTestDb } from '@basics/core/server/testing';
import { createServices } from '../services/index';
import type { Database } from '../db/schema';

export type TestContext = ReturnType<typeof createServices>;
export type SeedFn = (ctx: TestContext) => Promise<void>;

const migrationFolder = path.join(import.meta.dir, '../db/migrations');

export async function createTestDb(...seeds: SeedFn[]): Promise<TestContext> {
    const db = await _createTestDb<Database>(migrationFolder);
    const ctx = createServices(db, { dataDir: '/tmp/golf-map-test-data' });
    for (const seed of seeds) await seed(ctx);
    return ctx;
}
