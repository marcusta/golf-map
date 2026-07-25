import * as path from 'node:path';
import { createTestDb as _createTestDb } from '@basics/core/server/testing';
import { createServices, type ServicesConfig } from '../services/index';
import type { Database } from '../db/schema';

export type TestContext = ReturnType<typeof createServices>;
export type SeedFn = (ctx: TestContext) => Promise<void>;

const migrationFolder = path.join(import.meta.dir, '../db/migrations');

export async function createTestDb(...seeds: SeedFn[]): Promise<TestContext> {
    return createTestDbWith({}, ...seeds);
}

/**
 * Like `createTestDb`, but with an explicit services config — e.g. a
 * `tapscoreBaseUrl` pointed at a fake Tapscore server so the scoring bridge
 * (T60) exercises the real HTTP path. `dataDir` still defaults to the test
 * scratch dir unless overridden.
 */
export async function createTestDbWith(
    config: ServicesConfig,
    ...seeds: SeedFn[]
): Promise<TestContext> {
    const db = await _createTestDb<Database>(migrationFolder);
    const ctx = createServices(db, { dataDir: '/tmp/golf-map-test-data', ...config });
    for (const seed of seeds) await seed(ctx);
    return ctx;
}
