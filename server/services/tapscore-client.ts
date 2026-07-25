// --- Tapscore HTTP client (T60) ---
//
// A thin, hand-written client against Tapscore's *friendly-rounds by-token*
// endpoints. The share token is the only credential — no session, no auth
// coupling — so every call carries the token and nothing else about identity.
//
// Tapscore is a Bun + Hono + Kysely sibling that mounts its API under `/api`
// (see tapscore `server/main.ts`). `baseUrl` is the origin only
// (e.g. `http://localhost:3001`); this client appends `/api/...`.
//
// Deliberately NOT using `@basics/core/client/fetch` (apiFetch): that helper is
// wired for same-origin, cookie-session calls to golf-map's own API. Tapscore is
// a foreign origin reached with a bearer-like token in the body/query, so we use
// plain `fetch` and map non-2xx into a typed error the bridge can swallow.

/** One itinerary occurrence in a Tapscore round (from `round.playHoles`). */
export interface TapscorePlayHole {
    playHoleId: string;
    courseHoleNumber: number;
    /** Canonical itinerary ordinal (1..N); disambiguates repeated holes. */
    ordinal: number;
}

/** One ball (scorecard column) under a Tapscore round. */
export interface TapscoreBall {
    id: string;
    label: string | null;
    /** True iff the ball is an unclaimed placeholder seat. */
    pending: boolean;
}

/** Payload for a trust-based score write (`POST /friendly-rounds/score`). */
export interface TapscoreScoreInput {
    token: string;
    ballId: string;
    playHoleId: string;
    strokes: number | null;
    /** Tapscore `EventType`; the bridge always writes `'score_entered'`. */
    eventType: string;
    /** Idempotency key. Re-posts with the same id are no-ops server-side. */
    clientEventId: string;
}

export interface TapscoreClient {
    /**
     * The token round's full itinerary (every play hole, scored or not).
     * Source of truth for course-hole-number → play-hole-id mapping.
     */
    playHolesByToken(token: string): Promise<TapscorePlayHole[]>;
    /** Every ball under the token's round. */
    ballsByToken(token: string): Promise<TapscoreBall[]>;
    /** Append a score event. Idempotent on `clientEventId`, last-write-wins. */
    postScore(input: TapscoreScoreInput): Promise<void>;
}

/** Thrown for any non-2xx response or transport failure. */
export class TapscoreClientError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'TapscoreClientError';
    }
}

// Minimal structural shapes of the Tapscore responses we read. We pick only
// the fields the bridge needs; the wire carries more.
interface ByTokenResponse {
    round?: {
        playHoles?: Array<{ id: string; courseHoleNumber: number; ordinal: number }>;
    };
}

/** Default per-request timeout (ms). A black-holed Tapscore must not hang. */
const DEFAULT_TIMEOUT_MS = 4000;

export class HttpTapscoreClient implements TapscoreClient {
    private readonly base: string;
    private readonly timeoutMs: number;

    constructor(baseUrl: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
        // Trim a trailing slash so `${base}/api/...` never doubles up.
        this.base = baseUrl.replace(/\/+$/, '');
        this.timeoutMs = timeoutMs;
    }

    private url(path: string, query?: Record<string, string>): string {
        if (!this.base) {
            throw new TapscoreClientError('TAPSCORE_BASE_URL is not configured');
        }
        const u = new URL(`${this.base}/api${path}`);
        for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
        return u.toString();
    }

    private async getJson<T>(path: string, query: Record<string, string>): Promise<T> {
        let res: Response;
        try {
            res = await fetch(this.url(path, query), {
                method: 'GET',
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            throw new TapscoreClientError(`GET ${path} failed: ${(err as Error).message}`);
        }
        if (!res.ok) {
            throw new TapscoreClientError(`GET ${path} → ${res.status}`, res.status);
        }
        return (await res.json()) as T;
    }

    async playHolesByToken(token: string): Promise<TapscorePlayHole[]> {
        const body = await this.getJson<ByTokenResponse>('/friendly-rounds/by-token', { token });
        const holes = body.round?.playHoles ?? [];
        return holes.map((p) => ({
            playHoleId: p.id,
            courseHoleNumber: p.courseHoleNumber,
            ordinal: p.ordinal,
        }));
    }

    async ballsByToken(token: string): Promise<TapscoreBall[]> {
        const balls = await this.getJson<TapscoreBall[]>('/friendly-rounds/balls', { token });
        return balls.map((b) => ({ id: b.id, label: b.label ?? null, pending: !!b.pending }));
    }

    async postScore(input: TapscoreScoreInput): Promise<void> {
        let res: Response;
        try {
            res = await fetch(this.url('/friendly-rounds/score'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            throw new TapscoreClientError(`POST /friendly-rounds/score failed: ${(err as Error).message}`);
        }
        if (!res.ok) {
            throw new TapscoreClientError(`POST /friendly-rounds/score → ${res.status}`, res.status);
        }
    }
}
