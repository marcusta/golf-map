import type { TestContext } from '../../testing/db';

export const TEST_USER_ID = 'user-1';
export const TEST_USERNAME = 'marcus';
export const TEST_PASSWORD = 'test-password-123';

/**
 * Seeds a single test user. Services don't exist yet (this schema PR lands
 * before the service layer), so seeds insert directly via Kysely rather than
 * through service methods — later feature agents should migrate seeds to go
 * through UserService/etc. once those exist, per docs/server-guide.md §12.
 */
export async function seedUsers(ctx: TestContext): Promise<void> {
    await ctx.db
        .insertInto('users')
        .values({
            id: TEST_USER_ID,
            username: TEST_USERNAME,
            password_hash: await Bun.password.hash(TEST_PASSWORD),
        })
        .execute();
}
