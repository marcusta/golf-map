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
// The publish is idempotent by construction: each hole's score event carries a
// deterministic `client_event_id` = `golfmap:{roundId}:{holeNumber}`, and
// Tapscore is last-write-wins per cell. Re-posts, out-of-order retries and
// full re-syncs are therefore all safe — no new sync protocol is needed.
//
// Resilience is the load-bearing invariant: `syncHoles` NEVER throws. A
// Tapscore that is down, slow, or returning errors must never break golf-map's
// own round/shot writes — a failed publish is logged and retried on the next
// shot-sync write (which re-posts the same deterministic ids).

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

export class TapscoreBridgeService {
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
     * the scores land on: an explicit `ballId` must exist; when omitted, the
     * round's single ball is auto-picked and an ambiguous (>1) or empty round
     * is rejected. On success, current scores are pushed immediately (best
     * effort — the push never fails the link).
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
        return toStatus(roundId, null, null);
    }

    // --- Publish (called from the rounds write hook; NEVER throws) ---

    /** Recompute + publish the given holes for a round. No-op if unlinked. */
    async syncHoles(roundId: string, holeNumbers: readonly number[]): Promise<void> {
        try {
            const holes = Array.from(new Set(holeNumbers));
            if (holes.length === 0) return;
            const link = await this.linkRow(roundId);
            if (!link?.token || !link.ballId) return; // unlinked → nothing to do
            await this.publish(roundId, link.token, link.ballId, holes);
        } catch (err) {
            // Resilience contract: a publish failure must never surface to the
            // caller (which is in the middle of a round/shot write).
            log.error({
                msg: 'tapscore bridge: syncHoles failed',
                roundId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /** Publish every hole that currently has shots. No-op if unlinked. */
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

    private async publish(
        roundId: string,
        token: string,
        ballId: string,
        holeNumbers: readonly number[],
    ): Promise<void> {
        const playHoles = await this.client.playHolesByToken(token);
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
            const cleared = strokes <= 0;
            await this.client.postScore({
                token,
                ballId,
                playHoleId,
                strokes: cleared ? null : strokes,
                eventType: cleared ? 'score_cleared' : 'score_entered',
                clientEventId: `golfmap:${roundId}:${holeNumber}`,
            });
        }
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
    balls: readonly { id: string; label: string | null }[],
    requested?: string,
): string {
    if (requested !== undefined) {
        if (!balls.some((b) => b.id === requested)) {
            throw new ConflictError(`Ball ${requested} is not part of the Tapscore round`);
        }
        return requested;
    }
    if (balls.length === 1) return balls[0].id;
    throw new ConflictError(
        `Tapscore round has ${balls.length} balls; specify which ballId to link`,
    );
}

function toStatus(roundId: string, token: string | null, ballId: string | null): TapscoreLinkStatus {
    return { roundId, linked: token !== null, token, ballId };
}
