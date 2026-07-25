import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../db/schema';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';
import { log } from '@basics/core/server/logger';
import { TapscoreClientError, type TapscoreClient, type TapscorePlayHole } from './tapscore-client';

// --- Tapscore scoring bridge (T60, V1) ---
//
// Tapscore stays the scoring system of record; golf-map is the capture device.
// When a round is linked to a Tapscore *friendly round* (by its share token),
// this service publishes per-hole gross strokes into that round after every
// iOS shot-sync write.
//
// ## Idempotency — why a per-cell version
//
// Tapscore's `ScoreEventService.append` dedupes on `(round_id, client_event_id)`
// and mutates the scorecard cell ONLY on a fresh insert (score-event.service.ts
// + the migration-025 rebuild trigger). A *fixed* `client_event_id` per hole
// would therefore freeze the cell at its FIRST value — later shots, penalties,
// corrections and clears would be dropped. So the bridge keeps a monotonic
// per-cell `version` (`tapscore_published_scores`) and embeds it in the id:
//
//     golfmap:{roundId}:{holeNumber}:{version}
//
// The version bumps whenever the hole's value changes (so the change inserts and
// the cell updates), and is *reused* for an unconfirmed re-post of the SAME
// value (so a retry is a genuine idempotent replay). A→B→A yields three distinct
// versions, so the final A lands — unlike a value-hash, which would collapse it.
//
// ## Off the write path
//
// Publishing is fire-and-forget: `syncHoles` coalesces the changed holes per
// round and drains them on a later microtask, so a healthy Tapscore adds ZERO
// latency to a shot write and a sick one adds none either. The HTTP client also
// carries a per-request timeout. The never-throw contract holds: a failed
// publish is logged and left queued for the next sync (same deterministic ids).

export interface TapscoreLinkStatus {
    roundId: string;
    linked: boolean;
    token: string | null;
    ballId: string | null;
}

export interface HoleStrokes {
    holeNumber: number;
    /** Gross strokes = shots played on the hole + Σ penalty strokes. */
    strokes: number;
}

interface ShotScoreRow {
    holeNumber: number;
    penaltyStrokes: number;
}

/**
 * Per-hole gross strokes from a round's shots. Each shot row is one stroke
 * played; penalties add on top. Pure — unit-testable without a DB.
 *
 * When `holeNumbers` is given, the result has exactly one entry per requested
 * hole (0 for a hole with no shots, so cleared holes propagate). When omitted,
 * only holes that have at least one shot are returned. Always sorted by hole.
 */
export function computeHoleStrokes(
    shots: readonly ShotScoreRow[],
    holeNumbers?: readonly number[],
): HoleStrokes[] {
    const byHole = new Map<number, number>();
    for (const s of shots) {
        const prev = byHole.get(s.holeNumber) ?? 0;
        byHole.set(s.holeNumber, prev + 1 + (s.penaltyStrokes ?? 0));
    }
    const holes = holeNumbers
        ? Array.from(new Set(holeNumbers))
        : Array.from(byHole.keys());
    return holes
        .sort((a, b) => a - b)
        .map((holeNumber) => ({ holeNumber, strokes: byHole.get(holeNumber) ?? 0 }));
}

/**
 * course-hole-number → play-hole-id, taking the FIRST occurrence (lowest
 * ordinal) when a physical hole is played more than once. Shotgun starts are
 * handled naturally: every course hole still appears once, just rotated.
 * Repeated-hole rounds (e.g. a 9 played twice) collapse to the first visit —
 * a documented V1 limitation (see docs/feature-tapscore-bridge.md).
 */
function holeIdMap(playHoles: readonly TapscorePlayHole[]): Map<number, string> {
    const byHole = new Map<number, TapscorePlayHole>();
    for (const p of playHoles) {
        const existing = byHole.get(p.courseHoleNumber);
        if (!existing || p.ordinal < existing.ordinal) byHole.set(p.courseHoleNumber, p);
    }
    return new Map(Array.from(byHole.entries()).map(([n, p]) => [n, p.playHoleId]));
}

interface CellValue {
    strokes: number | null;
    eventType: string;
}

export class TapscoreBridgeService {
    // Coalescing queue: holes awaiting publish per round, plus the tail of the
    // per-round drain chain (so `settle` can await outstanding work in tests).
    private pending = new Map<string, Set<number>>();
    private tails = new Map<string, Promise<void>>();
    // Itinerary (play-hole map) cached per linked round; invalidated on (un)link.
    private itineraryCache = new Map<string, TapscorePlayHole[]>();

    constructor(
        private db: Kysely<Database>,
        private client: TapscoreClient,
    ) {}

    // --- Link management (deliberate client actions; may throw) ---

    async status(roundId: string): Promise<TapscoreLinkStatus> {
        const row = await this.linkRow(roundId);
        if (!row) throw new NotFoundError(`Round ${roundId} not found`);
        return toStatus(roundId, row.token, row.ballId);
    }

    /**
     * Link a round to a Tapscore friendly round by share token. Validates the
     * token against Tapscore (must resolve to balls) and resolves which ball
     * the scores land on: an explicit `ballId` must exist and be claimed; when
     * omitted, the round's single CLAIMED ball is auto-picked and an ambiguous
     * (>1) or all-pending round is rejected. On success, current scores are
     * pushed immediately (best effort — the push never fails the link).
     */
    async link(roundId: string, token: string, ballId?: string): Promise<TapscoreLinkStatus> {
        const exists = await this.linkRow(roundId);
        if (!exists) throw new NotFoundError(`Round ${roundId} not found`);

        const balls = await this.fetchBallsOrThrow(token);
        const resolvedBallId = resolveBallId(balls, ballId);

        await this.db
            .updateTable('rounds')
            .set({
                tapscore_round_token: token,
                ball_id: resolvedBallId,
                updated_at: sql`(datetime('now'))`,
            })
            .where('id', '=', roundId)
            .execute();

        // Force every already-published cell to re-post under a fresh id (the
        // ball, and thus the target cell, may have changed): '' never matches a
        // real event type, so the next publish bumps the version. Keeps the
        // counter monotonic, so ids never collide across links.
        await this.db
            .updateTable('tapscore_published_scores')
            .set({ event_type: '', synced: 0 })
            .where('round_id', '=', roundId)
            .execute();

        this.itineraryCache.delete(roundId);

        // Push whatever is already recorded so an in-progress round shows up in
        // Tapscore straight away. syncAll never throws.
        await this.syncAll(roundId);
        return toStatus(roundId, token, resolvedBallId);
    }

    async unlink(roundId: string): Promise<TapscoreLinkStatus> {
        const exists = await this.linkRow(roundId);
        if (!exists) throw new NotFoundError(`Round ${roundId} not found`);
        await this.db
            .updateTable('rounds')
            .set({
                tapscore_round_token: null,
                ball_id: null,
                updated_at: sql`(datetime('now'))`,
            })
            .where('id', '=', roundId)
            .execute();
        this.itineraryCache.delete(roundId);
        return toStatus(roundId, null, null);
    }

    // --- Publish (called from the rounds write hook) ---

    /**
     * Queue the given holes for publish and return immediately — the HTTP work
     * happens off the write path on a later microtask, coalesced per round.
     * Fire-and-forget by design; failures are logged, never thrown, and the
     * holes stay queued for the next drain.
     */
    syncHoles(roundId: string, holeNumbers: readonly number[]): void {
        const set = this.pending.get(roundId) ?? new Set<number>();
        for (const h of holeNumbers) set.add(h);
        if (set.size === 0) return;
        this.pending.set(roundId, set);

        const prev = this.tails.get(roundId) ?? Promise.resolve();
        const next = prev.then(() => this.flushPending(roundId)).catch((err) => {
            log.error({
                msg: 'tapscore bridge: flush failed',
                roundId,
                error: err instanceof Error ? err.message : String(err),
            });
        });
        this.tails.set(roundId, next);
    }

    /**
     * Await all queued publishes for a round (or every round when omitted).
     * Test seam — production callers fire-and-forget.
     */
    async settle(roundId?: string): Promise<void> {
        if (roundId !== undefined) {
            await (this.tails.get(roundId) ?? Promise.resolve());
            return;
        }
        await Promise.all(Array.from(this.tails.values()));
    }

    /** Publish every hole that currently has shots. No-op if unlinked. Never throws. */
    async syncAll(roundId: string): Promise<void> {
        try {
            const link = await this.linkRow(roundId);
            if (!link?.token || !link.ballId) return;
            const holes = await this.holesWithShots(roundId);
            if (holes.length === 0) return;
            await this.publish(roundId, link.token, link.ballId, holes);
        } catch (err) {
            log.error({
                msg: 'tapscore bridge: syncAll failed',
                roundId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // --- Internals ---

    private async flushPending(roundId: string): Promise<void> {
        const set = this.pending.get(roundId);
        if (!set || set.size === 0) return;
        const holes = Array.from(set).sort((a, b) => a - b);
        try {
            const link = await this.linkRow(roundId);
            if (!link?.token || !link.ballId) {
                this.pending.delete(roundId); // unlinked → drop, nothing to publish
                return;
            }
            await this.publish(roundId, link.token, link.ballId, holes);
            // Success: remove exactly the holes we handled; holes queued while we
            // were publishing stay for the next drain.
            for (const h of holes) set.delete(h);
            if (set.size === 0) this.pending.delete(roundId);
        } catch (err) {
            // Leave the holes in `pending` so the next syncHoles retries them;
            // per-hole state (synced=0) makes the replay idempotent.
            log.error({
                msg: 'tapscore bridge: publish failed (holes stay queued for retry)',
                roundId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async publish(
        roundId: string,
        token: string,
        ballId: string,
        holeNumbers: readonly number[],
    ): Promise<void> {
        const playHoles = await this.itinerary(roundId, token);
        const map = holeIdMap(playHoles);
        const shots = await this.shotsForHoles(roundId, holeNumbers);
        const perHole = computeHoleStrokes(shots, holeNumbers);

        for (const { holeNumber, strokes } of perHole) {
            const playHoleId = map.get(holeNumber);
            if (!playHoleId) {
                log.warn({
                    msg: 'tapscore bridge: no play hole for course hole',
                    roundId,
                    holeNumber,
                });
                continue;
            }
            await this.publishCell(roundId, token, ballId, holeNumber, playHoleId, strokes);
        }
    }

    /**
     * Publish one hole's value with the versioned-id protocol (see the class
     * doc). Persists the attempt (synced=0) BEFORE the POST so a lost ack still
     * advances the counter, and confirms (synced=1) only after Tapscore accepts.
     */
    private async publishCell(
        roundId: string,
        token: string,
        ballId: string,
        holeNumber: number,
        playHoleId: string,
        strokes: number,
    ): Promise<void> {
        const cleared = strokes <= 0;
        const value: CellValue = {
            strokes: cleared ? null : strokes,
            eventType: cleared ? 'score_cleared' : 'score_entered',
        };

        const row = await this.publishedRow(roundId, holeNumber);
        const sameValue = row !== undefined
            && row.strokes === value.strokes
            && row.event_type === value.eventType;

        // Already confirmed live with this exact value → nothing to do.
        if (row && row.synced === 1 && sameValue) return;

        // Reuse the id for an unconfirmed re-post of the SAME value (idempotent
        // retry); bump the version for any value change (or first publish).
        const version = row ? (sameValue ? row.version : row.version + 1) : 0;
        const clientEventId = `golfmap:${roundId}:${holeNumber}:${version}`;

        await this.upsertPublished(roundId, holeNumber, version, value, false);
        await this.client.postScore({
            token,
            ballId,
            playHoleId,
            strokes: value.strokes,
            eventType: value.eventType,
            clientEventId,
        });
        await this.markSynced(roundId, holeNumber);
    }

    private async itinerary(roundId: string, token: string): Promise<TapscorePlayHole[]> {
        const cached = this.itineraryCache.get(roundId);
        if (cached) return cached;
        const holes = await this.client.playHolesByToken(token);
        this.itineraryCache.set(roundId, holes);
        return holes;
    }

    private async linkRow(
        roundId: string,
    ): Promise<{ token: string | null; ballId: string | null } | null> {
        const row = await this.db
            .selectFrom('rounds')
            .select(['tapscore_round_token', 'ball_id'])
            .where('id', '=', roundId)
            .executeTakeFirst();
        if (!row) return null;
        return { token: row.tapscore_round_token, ballId: row.ball_id };
    }

    private async publishedRow(roundId: string, holeNumber: number) {
        return this.db
            .selectFrom('tapscore_published_scores')
            .select(['version', 'strokes', 'event_type', 'synced'])
            .where('round_id', '=', roundId)
            .where('hole_number', '=', holeNumber)
            .executeTakeFirst();
    }

    private async upsertPublished(
        roundId: string,
        holeNumber: number,
        version: number,
        value: CellValue,
        synced: boolean,
    ): Promise<void> {
        await this.db
            .insertInto('tapscore_published_scores')
            .values({
                round_id: roundId,
                hole_number: holeNumber,
                version,
                strokes: value.strokes,
                event_type: value.eventType,
                synced: synced ? 1 : 0,
            })
            .onConflict((oc) =>
                oc.columns(['round_id', 'hole_number']).doUpdateSet({
                    version,
                    strokes: value.strokes,
                    event_type: value.eventType,
                    synced: synced ? 1 : 0,
                }),
            )
            .execute();
    }

    private async markSynced(roundId: string, holeNumber: number): Promise<void> {
        await this.db
            .updateTable('tapscore_published_scores')
            .set({ synced: 1 })
            .where('round_id', '=', roundId)
            .where('hole_number', '=', holeNumber)
            .execute();
    }

    private async shotsForHoles(
        roundId: string,
        holeNumbers: readonly number[],
    ): Promise<ShotScoreRow[]> {
        const rows = await this.db
            .selectFrom('shots')
            .select(['hole_number', 'penalty_strokes'])
            .where('round_id', '=', roundId)
            .where('hole_number', 'in', holeNumbers as number[])
            .execute();
        return rows.map((r) => ({ holeNumber: r.hole_number, penaltyStrokes: r.penalty_strokes }));
    }

    private async holesWithShots(roundId: string): Promise<number[]> {
        const rows = await this.db
            .selectFrom('shots')
            .select('hole_number')
            .distinct()
            .where('round_id', '=', roundId)
            .execute();
        return rows.map((r) => r.hole_number);
    }

    private async fetchBallsOrThrow(token: string) {
        let balls;
        try {
            balls = await this.client.ballsByToken(token);
        } catch (err) {
            // A 404 means the token doesn't resolve to a round → surface as a
            // clean NotFoundError (404). Any other transport/HTTP failure
            // (Tapscore down, 5xx) propagates unchanged.
            if (err instanceof TapscoreClientError && err.status === 404) {
                throw new NotFoundError(`Tapscore round not found for token`);
            }
            throw err;
        }
        if (balls.length === 0) {
            throw new NotFoundError(`Tapscore round not found for token`);
        }
        return balls;
    }
}

function resolveBallId(
    balls: readonly { id: string; label: string | null; pending: boolean }[],
    requested?: string,
): string {
    if (requested !== undefined) {
        const ball = balls.find((b) => b.id === requested);
        if (!ball) {
            throw new ConflictError(`Ball ${requested} is not part of the Tapscore round`);
        }
        // Tapscore refuses to score an unclaimed placeholder seat
        // (append → ConflictError 'seat_unclaimed'), so linking to one would
        // silently never sync. Reject it up front.
        if (ball.pending) {
            throw new ConflictError(
                `Ball ${requested} is an unclaimed seat in Tapscore; claim it there before linking`,
            );
        }
        return requested;
    }
    const claimable = balls.filter((b) => !b.pending);
    if (claimable.length === 1) return claimable[0].id;
    if (claimable.length === 0) {
        throw new ConflictError(
            `Every ball in the Tapscore round is an unclaimed seat; claim one before linking`,
        );
    }
    throw new ConflictError(
        `Tapscore round has ${claimable.length} claimed balls; specify which ballId to link`,
    );
}

function toStatus(roundId: string, token: string | null, ballId: string | null): TapscoreLinkStatus {
    return { roundId, linked: token !== null, token, ballId };
}
