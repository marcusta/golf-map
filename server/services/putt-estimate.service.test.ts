import { test, expect } from 'bun:test';
import { createTestDb } from '../testing/db';
import { seedCourse, TEST_GREEN_1_ID, TEST_GREEN_2_ID } from '../db/seeds/course';
import {
    PuttEstimateService,
    DEFAULT_RECENT_N,
    type RecordSampleInput,
} from './putt-estimate.service';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';

// Real migrated DB, real service graph (createTestDb seam — house rule: no
// mocks). The training loop stores estimate-vs-actual pairs and the analytics
// panel reads accuracy aggregates back out.

function sample(over: Partial<RecordSampleInput> = {}): RecordSampleInput {
    return {
        greenId: TEST_GREEN_1_ID,
        distanceM: 8,
        stimpFt: 10,
        actualSlopePct: 2,
        estimatedSlopePct: 2,
        actualAimOffsetM: -0.3,
        estimatedAimOffsetM: -0.3,
        actualPlaysLikeM: 8,
        estimatedPlaysLikeM: 8,
        breakSideActual: 'left',
        breakSideEstimated: 'left',
        ...over,
    };
}

/** Insert a sample with an explicit created_at (bucket / recency ordering). */
async function insertAt(
    db: Kysely<Database>,
    createdAt: string,
    over: Partial<RecordSampleInput> = {},
): Promise<void> {
    const s = sample(over);
    await db
        .insertInto('putt_estimate_samples')
        .values({
            id: crypto.randomUUID(),
            green_id: s.greenId,
            distance_m: s.distanceM,
            stimp_ft: s.stimpFt,
            actual_slope_pct: s.actualSlopePct,
            estimated_slope_pct: s.estimatedSlopePct,
            actual_aim_offset_m: s.actualAimOffsetM,
            estimated_aim_offset_m: s.estimatedAimOffsetM,
            actual_plays_like_m: s.actualPlaysLikeM,
            estimated_plays_like_m: s.estimatedPlaysLikeM,
            break_side_actual: s.breakSideActual,
            break_side_estimated: s.breakSideEstimated,
            created_at: createdAt,
        })
        .execute();
}

test('recordSample stores the estimate-vs-actual pair and returns it mapped', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PuttEstimateService(db);

    const stored = await svc.recordSample(
        sample({
            estimatedSlopePct: 3,
            estimatedPlaysLikeM: 9.2,
            breakSideEstimated: 'right',
        }),
    );

    expect(stored.id).toBeTruthy();
    expect(stored.greenId).toBe(TEST_GREEN_1_ID);
    expect(stored.distanceM).toBe(8);
    expect(stored.actualSlopePct).toBe(2);
    expect(stored.estimatedSlopePct).toBe(3);
    expect(stored.breakSideActual).toBe('left');
    expect(stored.breakSideEstimated).toBe('right');
    expect(stored.createdAt).toBeTruthy();
});

test('recordSample accepts a null green (Tier-3 manual read, no surface)', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PuttEstimateService(db);

    const stored = await svc.recordSample(sample({ greenId: null }));
    expect(stored.greenId).toBeNull();
});

test('accuracyTrend aggregates slope error, break-side hit rate, and pace error', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PuttEstimateService(db);

    // Two samples: one perfect, one off by 1% slope / wrong side / 0.4 m pace.
    await svc.recordSample(sample());
    await svc.recordSample(
        sample({
            estimatedSlopePct: 3, // |3 - 2| = 1
            breakSideEstimated: 'right', // actual 'left' → miss
            estimatedPlaysLikeM: 8.4, // |8.4 - 8| = 0.4
        }),
    );

    const trend = await svc.accuracyTrend();

    expect(trend.overall.sampleCount).toBe(2);
    // mean |slope error| = (0 + 1) / 2 = 0.5
    expect(trend.overall.meanSlopeErrorPct).toBeCloseTo(0.5, 10);
    // break-side hit rate = 1 of 2 correct
    expect(trend.overall.breakSideHitRate).toBeCloseTo(0.5, 10);
    // mean |pace error| = (0 + 0.4) / 2 = 0.2
    expect(trend.overall.meanPaceErrorM).toBeCloseTo(0.2, 10);
});

test('accuracyTrend on an empty history returns null aggregates, not zeros', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PuttEstimateService(db);

    const trend = await svc.accuracyTrend();
    expect(trend.overall.sampleCount).toBe(0);
    expect(trend.overall.meanSlopeErrorPct).toBeNull();
    expect(trend.overall.breakSideHitRate).toBeNull();
    expect(trend.overall.meanPaceErrorM).toBeNull();
    expect(trend.recent.sampleCount).toBe(0);
    expect(trend.buckets).toEqual([]);
});

test('accuracyTrend recent window covers only the most-recent N samples', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PuttEstimateService(db);

    // N+1 samples: N older perfect ones, one newest with a big slope error. The
    // recent-N window drops the very oldest, so it still holds the newest error.
    const n = DEFAULT_RECENT_N;
    for (let i = 0; i < n; i++) {
        await insertAt(db, `2026-07-01T10:00:${String(i).padStart(2, '0')}Z`);
    }
    await insertAt(db, '2026-07-02T10:00:00Z', { estimatedSlopePct: 12 }); // |12-2| = 10

    const trend = await svc.accuracyTrend({ recentN: n });

    expect(trend.overall.sampleCount).toBe(n + 1);
    expect(trend.recent.sampleCount).toBe(n);
    // recent = last N: (n-1 perfect) + one 10-error → 10 / n
    expect(trend.recent.meanSlopeErrorPct).toBeCloseTo(10 / n, 10);
});

test('accuracyTrend buckets samples per UTC day, oldest first', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PuttEstimateService(db);

    await insertAt(db, '2026-07-01T09:00:00Z', { estimatedSlopePct: 4 }); // err 2
    await insertAt(db, '2026-07-01T18:00:00Z', { estimatedSlopePct: 2 }); // err 0
    await insertAt(db, '2026-07-03T09:00:00Z', { estimatedSlopePct: 3 }); // err 1

    const trend = await svc.accuracyTrend();

    expect(trend.buckets.map((b) => b.date)).toEqual(['2026-07-01', '2026-07-03']);
    expect(trend.buckets[0].sampleCount).toBe(2);
    expect(trend.buckets[0].meanSlopeErrorPct).toBeCloseTo(1, 10); // (2 + 0) / 2
    expect(trend.buckets[1].sampleCount).toBe(1);
    expect(trend.buckets[1].meanSlopeErrorPct).toBeCloseTo(1, 10);
});

test('accuracyTrend scopes to one green when greenId is given', async () => {
    const { db } = await createTestDb(seedCourse);
    const svc = new PuttEstimateService(db);

    await svc.recordSample(sample({ greenId: TEST_GREEN_1_ID, estimatedSlopePct: 4 })); // err 2
    await svc.recordSample(sample({ greenId: TEST_GREEN_2_ID, estimatedSlopePct: 2 })); // err 0

    const green1 = await svc.accuracyTrend({ greenId: TEST_GREEN_1_ID });
    expect(green1.overall.sampleCount).toBe(1);
    expect(green1.overall.meanSlopeErrorPct).toBeCloseTo(2, 10);

    const all = await svc.accuracyTrend();
    expect(all.overall.sampleCount).toBe(2);
});
