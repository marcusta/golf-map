import type { TestContext } from '../../testing/db';
import { TEST_USER_ID } from './users';

export const TEST_CLUB_DRIVER_ID = 'club-driver';
export const TEST_CLUB_7I_ID = 'club-7i';
export const TEST_CLUB_PW_ID = 'club-pw';

/**
 * Seeds 3 clubs for the test user (mirrors v1 export shape: name, carry
 * distance, lateral dispersion). Raw Kysely inserts — see note in seeds/users.ts.
 *
 * Depends on seedUsers having run first (clubs.user_id references
 * users.id) — call as createTestDb(seedUsers, seedClubs).
 */
export async function seedClubs(ctx: TestContext): Promise<void> {
    await ctx.db
        .insertInto('clubs')
        .values([
            {
                id: TEST_CLUB_DRIVER_ID,
                user_id: TEST_USER_ID,
                name: 'Driver',
                carry_m: 222.2, // 243 yd
                dispersion_m: 59.4, // 65 yd
                sort_order: 0,
                version: 1,
            },
            {
                id: TEST_CLUB_7I_ID,
                user_id: TEST_USER_ID,
                name: '7i',
                carry_m: 141.7, // 155 yd
                dispersion_m: 29.3, // 32 yd
                sort_order: 1,
                version: 1,
            },
            {
                id: TEST_CLUB_PW_ID,
                user_id: TEST_USER_ID,
                name: 'PW',
                carry_m: 105.2, // 115 yd
                dispersion_m: 24.7, // 27 yd
                sort_order: 2,
                version: 1,
            },
        ])
        .execute();
}
