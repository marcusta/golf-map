import { test, expect, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { createTestDbWith, type TestContext } from '../testing/db';
import { seedUsers, TEST_USER_ID } from '../db/seeds/users';
import { seedCourse, TEST_COURSE_ID } from '../db/seeds/course';
import { seedClubs } from '../db/seeds/clubs';
import { computeHoleStrokes } from './tapscore-bridge.service';
import { ConflictError, NotFoundError } from '@basics/core/server/auth';

// --- Fake Tapscore server (a real in-process Hono app, not a mock) ----------
//
// Implements exactly the three friendly-rounds-by-token endpoints the bridge
// touches, with Tapscore's REAL score-event semantics:
//   * `append` dedupes on `client_event_id` — a repeated id is dropped and
//     mutates NOTHING (mirrors ScoreEventService returning {inserted:false});
//   * the scorecard cell — keyed by (ballId, playHoleId) — is (re)written ONLY
//     on a fresh insert (mirrors the on-INSERT rebuild trigger).
// So a fixed id would freeze a cell after its first value; the bridge's
// per-cell versioned id is what actually lets a hole's score change.

interface FakeEvent {
    ballId: string;
    playHoleId: string;
    strokes: number | null;
    eventType: string;
    clientEventId: string;
}

interface FakeRound {
    playHoles: { id: string; courseHoleNumber: number; ordinal: number }[];
    balls: { id: string; label: string | null; pending: boolean }[];
}

function cellKey(ballId: string, playHoleId: string): string {
    return `${ballId}|${playHoleId}`;
}

class FakeTapscore {
    private server?: ReturnType<typeof Bun.serve>;
    baseUrl = '';
    private rounds = new Map<string, FakeRound>();
    /** clientEventIds already applied (Tapscore's idempotency ledger). */
    private applied = new Set<string>();
    /** Every POST body received, including deduped re-posts. */
    posts: FakeEvent[] = [];
    /** Current scorecard cell per (ballId, playHoleId) — mutated only on insert. */
    private cellMap = new Map<string, FakeEvent>();

    // Test seam: hold the FIRST /score response open until `release()` so a test
    // can deterministically interleave work while one drain is mid-POST.
    private gate?: Promise<void>;
    private releaseGate?: () => void;
    private firstPostSeen = false;
    /** Resolves once the server has received the first (gated) /score POST. */
    firstPostReceived!: Promise<void>;
    private signalFirstPost!: () => void;

    /** Arm the gate: the next /score POST blocks until `release()`. */
    blockFirstPost(): void {
        this.firstPostSeen = false;
        this.gate = new Promise((res) => {
            this.releaseGate = res;
        });
        this.firstPostReceived = new Promise((res) => {
            this.signalFirstPost = res;
        });
    }

    /** Let the held /score POST complete. */
    release(): void {
        this.releaseGate?.();
    }

    addRound(token: string, round: FakeRound): void {
        this.rounds.set(token, round);
    }

    /** The current cell for a (ball, play hole), or undefined if never scored. */
    cell(ballId: string, playHoleId: string): FakeEvent | undefined {
        return this.cellMap.get(cellKey(ballId, playHoleId));
    }

    /** Number of cells that hold a live (non-cleared) score. */
    get liveCellCount(): number {
        let n = 0;
        for (const ev of this.cellMap.values()) if (ev.strokes !== null) n++;
        return n;
    }

    start(): this {
        const app = new Hono();
        app.get('/api/friendly-rounds/by-token', (c) => {
            const round = this.rounds.get(c.req.query('token') ?? '');
            if (!round) return c.json({ error: 'not found' }, 404);
            return c.json({ round: { playHoles: round.playHoles } });
        });
        app.get('/api/friendly-rounds/balls', (c) => {
            const round = this.rounds.get(c.req.query('token') ?? '');
            if (!round) return c.json({ error: 'not found' }, 404);
            return c.json(round.balls);
        });
        app.post('/api/friendly-rounds/score', async (c) => {
            const body = (await c.req.json()) as FakeEvent & { token: string };
            if (!this.rounds.has(body.token)) return c.json({ error: 'not found' }, 404);
            // Hold the first POST open (if armed) so a test can interleave.
            if (this.gate && !this.firstPostSeen) {
                this.firstPostSeen = true;
                this.signalFirstPost();
                await this.gate;
            }
            const ev: FakeEvent = {
                ballId: body.ballId,
                playHoleId: body.playHoleId,
                strokes: body.strokes,
                eventType: body.eventType,
                clientEventId: body.clientEventId,
            };
            this.posts.push(ev);
            // Idempotency: a repeated client_event_id is accepted but changes
            // nothing (inserted:false). The cell moves only on a fresh insert.
            if (!this.applied.has(ev.clientEventId)) {
                this.applied.add(ev.clientEventId);
                this.cellMap.set(cellKey(ev.ballId, ev.playHoleId), ev);
            }
            return c.json({ ok: true });
        });
        this.server = Bun.serve({ port: 0, fetch: app.fetch });
        this.baseUrl = `http://127.0.0.1:${this.server.port}`;
        return this;
    }

    stop(): void {
        this.server?.stop(true);
        this.server = undefined;
    }
}

const TOKEN = 'share-token-abc';

/** A round with two play holes and a single ball, the common V1 shape. */
function singleBallRound(): FakeRound {
    return {
        playHoles: [
            { id: 'ph-1', courseHoleNumber: 1, ordinal: 1 },
            { id: 'ph-2', courseHoleNumber: 2, ordinal: 2 },
        ],
        balls: [{ id: 'ball-1', label: 'Marcus', pending: false }],
    };
}

const fakes: FakeTapscore[] = [];

function startFake(configure: (f: FakeTapscore) => void): FakeTapscore {
    const f = new FakeTapscore();
    configure(f);
    f.start();
    fakes.push(f);
    return f;
}

async function setup(baseUrl: string): Promise<TestContext> {
    return createTestDbWith({ tapscoreBaseUrl: baseUrl }, seedUsers, seedCourse, seedClubs);
}

afterEach(() => {
    for (const f of fakes.splice(0)) f.stop();
});

// --- Pure helper (hard-ish algorithm) --------------------------------------

test('computeHoleStrokes = shots played + Σ penalties, grouped per hole', () => {
    const result = computeHoleStrokes([
        { holeNumber: 1, penaltyStrokes: 0 },
        { holeNumber: 1, penaltyStrokes: 1 }, // a stroke + a penalty
        { holeNumber: 1, penaltyStrokes: 0 },
        { holeNumber: 2, penaltyStrokes: 0 },
    ]);
    // hole 1: 3 shots + 1 penalty = 4; hole 2: 1 shot = 1
    expect(result).toEqual([
        { holeNumber: 1, strokes: 4 },
        { holeNumber: 2, strokes: 1 },
    ]);
});

test('computeHoleStrokes zero-fills requested holes with no shots (cleared cells)', () => {
    const result = computeHoleStrokes(
        [{ holeNumber: 1, penaltyStrokes: 0 }],
        [1, 2, 3],
    );
    expect(result).toEqual([
        { holeNumber: 1, strokes: 1 },
        { holeNumber: 2, strokes: 0 },
        { holeNumber: 3, strokes: 0 },
    ]);
});

// --- Link management --------------------------------------------------------

test('link auto-picks the single ball and persists token + ballId on the round', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);

    const status = await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);
    expect(status).toEqual({ roundId: round.id, linked: true, token: TOKEN, ballId: 'ball-1' });

    const stored = await ctx.tapscoreBridgeService.status(round.id, TEST_USER_ID);
    expect(stored).toEqual(status);
});

test('link rejects an unknown token with NotFoundError (404)', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await expect(ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, 'no-such-token')).rejects.toBeInstanceOf(
        NotFoundError,
    );
});

test('link rejects an ambiguous multi-ball round without an explicit ballId', async () => {
    const fake = startFake((f) =>
        f.addRound(TOKEN, {
            playHoles: singleBallRound().playHoles,
            balls: [
                { id: 'ball-1', label: 'Marcus', pending: false },
                { id: 'ball-2', label: 'Alex', pending: false },
            ],
        }),
    );
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await expect(ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN)).rejects.toBeInstanceOf(
        ConflictError,
    );
    // …but an explicit, valid ballId links.
    const status = await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN, 'ball-2');
    expect(status.ballId).toBe('ball-2');
});

test('link rejects a ballId that is not part of the Tapscore round', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await expect(ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN, 'ghost')).rejects.toBeInstanceOf(
        ConflictError,
    );
});

test('link auto-pick ignores unclaimed (pending) seats and picks the one claimed ball', async () => {
    const fake = startFake((f) =>
        f.addRound(TOKEN, {
            playHoles: singleBallRound().playHoles,
            balls: [
                { id: 'ball-1', label: 'Marcus', pending: false },
                { id: 'ball-2', label: null, pending: true }, // unclaimed seat
            ],
        }),
    );
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    const status = await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);
    expect(status.ballId).toBe('ball-1');
});

test('link rejects a pending seat — explicit and when it is the only ball', async () => {
    const fake = startFake((f) =>
        f.addRound(TOKEN, {
            playHoles: singleBallRound().playHoles,
            balls: [{ id: 'ball-1', label: null, pending: true }],
        }),
    );
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    // Only ball is an unclaimed seat → nothing claimable to link.
    await expect(ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN)).rejects.toBeInstanceOf(
        ConflictError,
    );
    // Explicitly naming the pending seat is also refused.
    await expect(ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN, 'ball-1')).rejects.toBeInstanceOf(
        ConflictError,
    );
});

// --- Ownership: link management is scoped to the round's owner --------------

const OTHER_USER_ID = 'user-2';

async function seedOtherUser(ctx: TestContext): Promise<void> {
    await ctx.db
        .insertInto('users')
        .values({
            id: OTHER_USER_ID,
            username: 'intruder',
            password_hash: await Bun.password.hash('other-password-456'),
        })
        .execute();
}

test("status/link/unlink reject another user's round with 404 (no existence leak)", async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    await seedOtherUser(ctx);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    // Every user-facing entry point 404s for the non-owner…
    await expect(ctx.tapscoreBridgeService.status(round.id, OTHER_USER_ID)).rejects.toBeInstanceOf(
        NotFoundError,
    );
    await expect(
        ctx.tapscoreBridgeService.link(round.id, OTHER_USER_ID, TOKEN),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(ctx.tapscoreBridgeService.unlink(round.id, OTHER_USER_ID)).rejects.toBeInstanceOf(
        NotFoundError,
    );

    // …and the owner's link is untouched by the failed unlink attempt.
    const stored = await ctx.tapscoreBridgeService.status(round.id, TEST_USER_ID);
    expect(stored).toEqual({ roundId: round.id, linked: true, token: TOKEN, ballId: 'ball-1' });
});

test('owner can unlink their own round', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    const status = await ctx.tapscoreBridgeService.unlink(round.id, TEST_USER_ID);
    expect(status).toEqual({ roundId: round.id, linked: false, token: null, ballId: null });
});

test('a single-user-era round (user_id null) stays accessible to any user', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    await seedOtherUser(ctx);
    // No userId → user_id null, the pre-multi-user shape.
    const round = await ctx.roundsService.start(TEST_COURSE_ID);

    const status = await ctx.tapscoreBridgeService.link(round.id, OTHER_USER_ID, TOKEN);
    expect(status.linked).toBe(true);
});

// --- Ball roster (the picker behind the ambiguous-ball 409) ------------------

test('balls returns the full roster verbatim — id, label and pending flag', async () => {
    const fake = startFake((f) =>
        f.addRound(TOKEN, {
            playHoles: singleBallRound().playHoles,
            balls: [
                { id: 'ball-1', label: 'Marcus', pending: false },
                { id: 'ball-2', label: 'Alex', pending: false },
                { id: 'ball-3', label: null, pending: true }, // unclaimed seat
            ],
        }),
    );
    const ctx = await setup(fake.baseUrl);

    const balls = await ctx.tapscoreBridgeService.balls(TOKEN);
    expect(balls).toEqual([
        { id: 'ball-1', label: 'Marcus', pending: false },
        { id: 'ball-2', label: 'Alex', pending: false },
        { id: 'ball-3', label: null, pending: true },
    ]);
});

test('balls rejects an unknown token with NotFoundError (404)', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    await expect(ctx.tapscoreBridgeService.balls('no-such-token')).rejects.toBeInstanceOf(
        NotFoundError,
    );
});

test('balls needs no linked (or any) round — it serves the pre-link picker', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    // No round started, nothing linked — the roster still resolves by token.
    const balls = await ctx.tapscoreBridgeService.balls(TOKEN);
    expect(balls.map((b) => b.id)).toEqual(['ball-1']);
});

// --- Publish through the shot-write hook ------------------------------------

test('adding shots publishes the hole score with a versioned client_event_id', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.roundsService.addShot(round.id, {
        holeNumber: 1,
        lat: 58.4,
        lon: 15.5,
        penaltyStrokes: 1,
    });
    await ctx.tapscoreBridgeService.settle(round.id);

    const cell = fake.cell('ball-1', 'ph-1');
    expect(cell?.strokes).toBe(4); // 3 shots + 1 penalty
    expect(cell?.eventType).toBe('score_entered');
    expect(cell?.playHoleId).toBe('ph-1');
    // The id carries the per-cell version so the value could advance.
    expect(cell?.clientEventId).toMatch(new RegExp(`^golfmap:${round.id}:1:\\d+$`));
});

test('incremental play advances the cell through monotonic versioned ids', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    // Shot by shot, settling between each — every value change must land.
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.tapscoreBridgeService.settle(round.id);
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(1);
    const idV0 = fake.cell('ball-1', 'ph-1')!.clientEventId;

    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.tapscoreBridgeService.settle(round.id);
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(2);
    const idV1 = fake.cell('ball-1', 'ph-1')!.clientEventId;

    await ctx.roundsService.addShot(round.id, {
        holeNumber: 1,
        lat: 58.4,
        lon: 15.5,
        penaltyStrokes: 1,
    });
    await ctx.tapscoreBridgeService.settle(round.id);
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(4); // 3 shots + 1 penalty
    const idV2 = fake.cell('ball-1', 'ph-1')!.clientEventId;

    // A fixed id would have frozen the cell at 1; the versions must be distinct.
    expect(new Set([idV0, idV1, idV2]).size).toBe(3);

    // Re-syncing the SAME value is a true no-op: no new POST at all.
    const before = fake.posts.length;
    await ctx.tapscoreBridgeService.syncAll(round.id);
    expect(fake.posts.length).toBe(before);
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(4);
});

test('a hole re-queued DURING an in-flight drain still lands its newer value', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    // Arm the fake to hold the first /score POST open.
    fake.blockFirstPost();

    // Shot 1 → drain A starts and blocks mid-POST (having read strokes = 1).
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await fake.firstPostReceived;

    // While drain A is stuck in its POST, a second shot lands on the SAME hole
    // and re-queues it. This is the reentrancy window: the claimed hole must NOT
    // be deleted out from under this fresh entry.
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });

    // Let drain A finish (posts strokes = 1); drain B then reads strokes = 2.
    fake.release();
    await ctx.tapscoreBridgeService.settle(round.id);

    // The newer value must win — a lost update would leave the cell at 1.
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(2);
});

test('moving a shot to another hole updates BOTH holes', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    const s1 = await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.tapscoreBridgeService.settle(round.id);
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(2);

    // Move shot s1 from hole 1 to hole 2.
    await ctx.roundsService.updateShot(s1.id, s1.version, { holeNumber: 2 });
    await ctx.tapscoreBridgeService.settle(round.id);

    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(1);
    const holeTwo = fake.cell('ball-1', 'ph-2');
    expect(holeTwo?.strokes).toBe(1);
    expect(holeTwo?.playHoleId).toBe('ph-2');
});

test('removing the last shot on a hole clears the Tapscore cell', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    const shot = await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.tapscoreBridgeService.settle(round.id);
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(1);

    await ctx.roundsService.removeShot(shot.id, shot.version);
    await ctx.tapscoreBridgeService.settle(round.id);
    const cleared = fake.cell('ball-1', 'ph-1');
    expect(cleared?.strokes).toBe(null);
    expect(cleared?.eventType).toBe('score_cleared');
});

test('publishing is off the write path — shot write does not wait on the POST', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    // The write returns before the coalesced publish runs…
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    expect(fake.cell('ball-1', 'ph-1')).toBeUndefined();
    // …and lands once we let the queue drain.
    await ctx.tapscoreBridgeService.settle(round.id);
    expect(fake.cell('ball-1', 'ph-1')?.strokes).toBe(1);
});

test('an unlinked round never calls Tapscore', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    // No link.
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.tapscoreBridgeService.settle(round.id);
    expect(fake.posts).toHaveLength(0);
});

test('Tapscore being unreachable never breaks the round/shot write', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TEST_USER_ID, TOKEN);

    // Bring Tapscore down; the base URL now refuses connections.
    fake.stop();

    // The write must still succeed and persist.
    const shot = await ctx.roundsService.addShot(round.id, { holeNumber: 2, lat: 58.4, lon: 15.5 });
    const stored = await ctx.roundsService.get(round.id);
    expect(stored.shots.map((s) => s.id)).toContain(shot.id);
    // Draining the queue with Tapscore down must not throw either.
    await ctx.tapscoreBridgeService.settle(round.id);
});
