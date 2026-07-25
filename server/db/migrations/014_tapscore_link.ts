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
 *
 * `tapscore_published_scores` tracks, per (round, hole), the LAST score event
 * the bridge published to Tapscore: its monotonic `version`, the value
 * (`strokes` + `event_type`), and whether that post was confirmed (`synced`).
 * Tapscore's `append` is idempotent on `(round_id, client_event_id)` and
 * mutates the scorecard cell ONLY on a fresh insert — so a fixed id would
 * freeze the cell at its first value. The bridge therefore embeds this
 * per-cell `version` in the id (`golfmap:{roundId}:{holeNumber}:{version}`)
 * and bumps it whenever the value changes, while reusing the id for an
 * unconfirmed re-post of the same value (idempotent retry).
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

    await db.schema
        .createTable('tapscore_published_scores')
        .addColumn('round_id', 'text', (col) =>
            col.notNull().references('rounds.id').onDelete('cascade'))
        .addColumn('hole_number', 'integer', (col) => col.notNull())
        .addColumn('version', 'integer', (col) => col.notNull())
        // Last published value. `strokes` null = a cleared cell; `event_type`
        // is the Tapscore event type, or '' as a "force re-post" sentinel set
        // at link time so a re-link re-publishes under a fresh id.
        .addColumn('strokes', 'integer')
        .addColumn('event_type', 'text', (col) => col.notNull())
        // 1 once Tapscore confirmed the post; 0 while a post is unconfirmed
        // (never sent, or its ack was lost) so the next sync retries it.
        .addColumn('synced', 'integer', (col) => col.notNull().defaultTo(0))
        .addPrimaryKeyConstraint('tapscore_published_scores_pk', ['round_id', 'hole_number'])
        .execute();
}
