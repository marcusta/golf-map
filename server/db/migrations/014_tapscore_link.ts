import { type Kysely } from 'kysely';

/**
 * T60 — Tapscore scoring bridge (V1). A round can optionally be linked to a
 * Tapscore *friendly round* via its share token. When linked, the bridge
 * (`tapscore-bridge.service.ts`) publishes per-hole strokes into that Tapscore
 * round after every shot-sync write.
 *
 * - `tapscore_round_token`: the friendly-round share token — the whole
 *   credential in Tapscore's no-login model. Null = round is not linked.
 * - `ball_id`: which Tapscore *ball* (the golfer's scorecard column) the
 *   published scores land on. Resolved at link time from the token's balls
 *   (auto-picked when the round has exactly one). Null when unlinked.
 *
 * Both nullable; every pre-existing round and every round the player never
 * links stays null and is a bridge no-op.
 */
export async function up(db: Kysely<any>): Promise<void> {
    await db.schema
        .alterTable('rounds')
        .addColumn('tapscore_round_token', 'text')
        .execute();
    await db.schema
        .alterTable('rounds')
        .addColumn('ball_id', 'text')
        .execute();
}
