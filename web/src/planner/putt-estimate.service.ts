import { Signal } from '@basics/core/client/core';
import {
    createPuttEstimateClient,
    type PuttEstimateApi,
    type AccuracyTrend,
} from '../../../shared/api/putt-estimate.gen';
import type { PuttEstimate, PuttGroundTruth } from './putt-estimate-score';
import type { BreakSide } from '../../../shared/strategy';

/**
 * Web-side persistence for the putting training loop (feature-putting-green-
 * reading.md §5.1). Records estimate-vs-actual samples to the server (the
 * source of truth — house style) and holds the accuracy trend for the analytics
 * panel beside strokes-gained putting (T14).
 *
 * Follows PuttReadService's shape: it constructs its own generated client, DI-
 * overridable so tests can stub `globalThis.fetch` (no mocks). Scoring stays in
 * the pure `putt-estimate-score.ts`; this layer only moves rows.
 */
export class PuttEstimateService {
    /** Latest accuracy trend, or null before the first load. */
    readonly trend = new Signal<AccuracyTrend | null>(null);
    readonly loading = new Signal(false);

    constructor(
        private api: PuttEstimateApi = createPuttEstimateClient('/api'),
    ) {}

    /**
     * Record one scored estimate. `distanceM`/`stimpFt` are the putt context;
     * `greenId` is null for a Tier-3 manual read. Refreshes the trend on success
     * so the panel updates. Soft-fails (returns false) — a lost training sample
     * must never break the reveal.
     */
    async record(input: {
        greenId: string | null;
        distanceM: number;
        stimpFt: number;
        estimate: PuttEstimate;
        truth: PuttGroundTruth;
    }): Promise<boolean> {
        try {
            await this.api.recordSample({
                greenId: input.greenId,
                distanceM: input.distanceM,
                stimpFt: input.stimpFt,
                actualSlopePct: input.truth.slopePct,
                estimatedSlopePct: input.estimate.slopePct,
                actualAimOffsetM: input.truth.aimOffsetM,
                estimatedAimOffsetM: input.estimate.aimOffsetM,
                actualPlaysLikeM: input.truth.playsLikeM,
                estimatedPlaysLikeM: input.estimate.playsLikeM,
                breakSideActual: input.truth.breakSide as BreakSide,
                breakSideEstimated: input.estimate.breakSide as BreakSide,
            });
            await this.loadTrend();
            return true;
        } catch {
            return false;
        }
    }

    /** Refresh the accuracy trend (all greens). Soft-fails to leave the old trend. */
    async loadTrend(greenId?: string): Promise<void> {
        this.loading.set(true);
        try {
            const trend = await this.api.accuracyTrend(greenId ? { greenId } : {});
            this.trend.set(trend);
        } catch {
            // Keep whatever we last had — the trend is informational.
        } finally {
            this.loading.set(false);
        }
    }
}
