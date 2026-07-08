import { test, expect, afterEach } from 'bun:test';
import { PuttEstimateService } from '../src/planner/putt-estimate.service';
import type { PuttEstimate, PuttGroundTruth } from '../src/planner/putt-estimate-score';

// PuttEstimateService against a stubbed global fetch — the real service and the
// real generated client, only the network substituted (house rule: hand-stubbed
// fetch router, no mocking library — see putt-read.service.test.ts).

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stubFetch(routes: Record<string, (body: unknown) => Response>): {
    calls: Array<{ url: string; method: string; body: unknown }>;
} {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method: init?.method ?? 'GET', body });
        for (const [fragment, respond] of Object.entries(routes)) {
            if (url.includes(fragment)) return respond(body);
        }
        return json(200, {});
    }) as typeof fetch;
    return { calls };
}

const EMPTY_TREND = {
    recent: { sampleCount: 0, meanSlopeErrorPct: null, breakSideHitRate: null, meanPaceErrorM: null },
    overall: { sampleCount: 0, meanSlopeErrorPct: null, breakSideHitRate: null, meanPaceErrorM: null },
    buckets: [],
};

const estimate: PuttEstimate = { slopePct: 3, breakSide: 'right', aimOffsetM: 0.2, playsLikeM: 9 };
const truth: PuttGroundTruth = { slopePct: 2, breakSide: 'left', aimOffsetM: -0.3, playsLikeM: 8 };

test('record posts the estimate-vs-actual pair and refreshes the trend', async () => {
    const { calls } = stubFetch({
        '/putt-estimates/samples': () => json(200, { id: 'sample-1' }),
        '/putt-estimates/accuracy': () => json(200, {
            ...EMPTY_TREND,
            overall: { sampleCount: 1, meanSlopeErrorPct: 1, breakSideHitRate: 0, meanPaceErrorM: 1 },
        }),
    });
    const svc = new PuttEstimateService();

    const ok = await svc.record({
        greenId: 'green-1', distanceM: 8, stimpFt: 11, estimate, truth,
    });

    expect(ok).toBe(true);
    const post = calls.find(c => c.url.includes('/putt-estimates/samples'));
    expect(post?.method).toBe('POST');
    // Estimate and actual arrive side by side, from the two sources.
    expect(post?.body).toMatchObject({
        greenId: 'green-1',
        distanceM: 8,
        stimpFt: 11,
        estimatedSlopePct: 3,
        actualSlopePct: 2,
        estimatedAimOffsetM: 0.2,
        actualAimOffsetM: -0.3,
        breakSideEstimated: 'right',
        breakSideActual: 'left',
    });
    // Trend refreshed on success.
    expect(calls.some(c => c.url.includes('/putt-estimates/accuracy'))).toBe(true);
    expect(svc.trend.get()?.overall.sampleCount).toBe(1);
});

test('record accepts a null green (Tier-3 manual read)', async () => {
    const { calls } = stubFetch({
        '/putt-estimates/samples': () => json(200, { id: 's' }),
        '/putt-estimates/accuracy': () => json(200, EMPTY_TREND),
    });
    const svc = new PuttEstimateService();

    await svc.record({ greenId: null, distanceM: 5, stimpFt: 10, estimate, truth });
    const post = calls.find(c => c.url.includes('/putt-estimates/samples'));
    expect(post?.body).toMatchObject({ greenId: null });
});

test('record soft-fails (returns false, keeps old trend) when the POST errors', async () => {
    stubFetch({
        '/putt-estimates/samples': () => json(500, { error: 'boom' }),
    });
    const svc = new PuttEstimateService();

    const ok = await svc.record({ greenId: 'green-1', distanceM: 8, stimpFt: 10, estimate, truth });
    expect(ok).toBe(false);
    expect(svc.trend.get()).toBeNull(); // never populated
});

test('loadTrend populates the trend signal', async () => {
    stubFetch({
        '/putt-estimates/accuracy': () => json(200, {
            ...EMPTY_TREND,
            overall: { sampleCount: 3, meanSlopeErrorPct: 0.7, breakSideHitRate: 0.66, meanPaceErrorM: 0.5 },
        }),
    });
    const svc = new PuttEstimateService();

    await svc.loadTrend();
    expect(svc.trend.get()?.overall.sampleCount).toBe(3);
    expect(svc.trend.get()?.overall.meanSlopeErrorPct).toBe(0.7);
});
