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
// touches, with Tapscore's real idempotency + last-write-wins-per-cell
// semantics so re-posts and out-of-order retries are observable.

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

class FakeTapscore {
    private server?: ReturnType<typeof Bun.serve>;
    baseUrl = '';
    private rounds = new Map<string, FakeRound>();
    /** Every POST body received (counts re-posts). */
    posts: FakeEvent[] = [];
    /** Latest event per clientEventId — Tapscore's cell is last-write-wins. */
    cells = new Map<string, FakeEvent>();

    addRound(token: string, round: FakeRound): void {
        this.rounds.set(token, round);
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
            const ev: FakeEvent = {
                ballId: body.ballId,
                playHoleId: body.playHoleId,
                strokes: body.strokes,
                eventType: body.eventType,
                clientEventId: body.clientEventId,
            };
            this.posts.push(ev);
            this.cells.set(body.clientEventId, ev); // last-write-wins
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

    const status = await ctx.tapscoreBridgeService.link(round.id, TOKEN);
    expect(status).toEqual({ roundId: round.id, linked: true, token: TOKEN, ballId: 'ball-1' });

    const stored = await ctx.tapscoreBridgeService.status(round.id);
    expect(stored).toEqual(status);
});

test('link rejects an unknown token with NotFoundError (404)', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await expect(ctx.tapscoreBridgeService.link(round.id, 'no-such-token')).rejects.toBeInstanceOf(
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
    await expect(ctx.tapscoreBridgeService.link(round.id, TOKEN)).rejects.toBeInstanceOf(
        ConflictError,
    );
    // …but an explicit, valid ballId links.
    const status = await ctx.tapscoreBridgeService.link(round.id, TOKEN, 'ball-2');
    expect(status.ballId).toBe('ball-2');
});

test('link rejects a ballId that is not part of the Tapscore round', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await expect(ctx.tapscoreBridgeService.link(round.id, TOKEN, 'ghost')).rejects.toBeInstanceOf(
        ConflictError,
    );
});

// --- Publish through the shot-write hook ------------------------------------

test('adding shots publishes per-hole scores with deterministic client_event_ids', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TOKEN);

    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.roundsService.addShot(round.id, {
        holeNumber: 1,
        lat: 58.4,
        lon: 15.5,
        penaltyStrokes: 1,
    });

    const cell = fake.cells.get(`golfmap:${round.id}:1`);
    expect(cell).toEqual({
        ballId: 'ball-1',
        playHoleId: 'ph-1',
        strokes: 4, // 3 shots + 1 penalty
        eventType: 'score_entered',
        clientEventId: `golfmap:${round.id}:1`,
    });
});

test('re-syncing a hole re-posts the SAME client_event_id (idempotent cell)', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TOKEN);

    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });

    // Two shots → two publishes, both to the SAME cell id, last one wins at 2.
    expect(fake.posts.filter((p) => p.clientEventId === `golfmap:${round.id}:1`)).toHaveLength(2);
    expect(fake.cells.size).toBe(1);
    expect(fake.cells.get(`golfmap:${round.id}:1`)?.strokes).toBe(2);

    // A manual full re-sync is safe and does not create new cells.
    await ctx.tapscoreBridgeService.syncAll(round.id);
    expect(fake.cells.size).toBe(1);
    expect(fake.cells.get(`golfmap:${round.id}:1`)?.strokes).toBe(2);
});

test('moving a shot to another hole updates BOTH holes', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TOKEN);

    const s1 = await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    expect(fake.cells.get(`golfmap:${round.id}:1`)?.strokes).toBe(2);

    // Move shot s1 from hole 1 to hole 2.
    await ctx.roundsService.updateShot(s1.id, s1.version, { holeNumber: 2 });

    expect(fake.cells.get(`golfmap:${round.id}:1`)?.strokes).toBe(1);
    const holdTwo = fake.cells.get(`golfmap:${round.id}:2`);
    expect(holdTwo?.strokes).toBe(1);
    expect(holdTwo?.playHoleId).toBe('ph-2');
});

test('removing the last shot on a hole clears the Tapscore cell', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TOKEN);

    const shot = await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    expect(fake.cells.get(`golfmap:${round.id}:1`)?.strokes).toBe(1);

    await ctx.roundsService.removeShot(shot.id, shot.version);
    expect(fake.cells.get(`golfmap:${round.id}:1`)).toEqual({
        ballId: 'ball-1',
        playHoleId: 'ph-1',
        strokes: null,
        eventType: 'score_cleared',
        clientEventId: `golfmap:${round.id}:1`,
    });
});

test('an unlinked round never calls Tapscore', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    // No link.
    await ctx.roundsService.addShot(round.id, { holeNumber: 1, lat: 58.4, lon: 15.5 });
    expect(fake.posts).toHaveLength(0);
});

test('Tapscore being unreachable never breaks the round/shot write', async () => {
    const fake = startFake((f) => f.addRound(TOKEN, singleBallRound()));
    const ctx = await setup(fake.baseUrl);
    const round = await ctx.roundsService.start(TEST_COURSE_ID, TEST_USER_ID);
    await ctx.tapscoreBridgeService.link(round.id, TOKEN);

    // Bring Tapscore down; the base URL now refuses connections.
    fake.stop();

    // The write must still succeed and persist.
    const shot = await ctx.roundsService.addShot(round.id, { holeNumber: 2, lat: 58.4, lon: 15.5 });
    const stored = await ctx.roundsService.get(round.id);
    expect(stored.shots.map((s) => s.id)).toContain(shot.id);
});
