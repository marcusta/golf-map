// Pure row-shaping for the putting estimation-accuracy panel (feature-putting-
// green-reading.md §5.1 training loop). Sits beside the strokes-gained putting
// view (T14) — same "label / count / value" row model as round-sg-table.ts, no
// DOM here. Slope error leads: it's the skill that stays legal in competition.

import type { AccuracyAggregate, AccuracyTrend } from '../../../shared/api/putt-estimate.gen';

/** One rendered metric row: a label, sample count, and formatted value. */
export interface AccuracyRow {
    label: string;
    count: number;
    /** Preformatted value string (units baked in), or '—' when no samples. */
    value: string;
}

/** Format a mean absolute error to one decimal + unit, or '—' when null. */
export function formatError(value: number | null, unit: string): string {
    if (value === null) return '—';
    return `${value.toFixed(1)}${unit}`;
}

/** Format a 0..1 hit rate as a percentage, or '—' when null. */
export function formatHitRate(value: number | null): string {
    if (value === null) return '—';
    return `${Math.round(value * 100)}%`;
}

/** The three accuracy rows for one aggregate window (slope error leads). */
export function accuracyRows(agg: AccuracyAggregate): AccuracyRow[] {
    return [
        { label: 'Slope error', count: agg.sampleCount, value: formatError(agg.meanSlopeErrorPct, '%') },
        { label: 'Break side hit rate', count: agg.sampleCount, value: formatHitRate(agg.breakSideHitRate) },
        { label: 'Pace error', count: agg.sampleCount, value: formatError(agg.meanPaceErrorM, ' m') },
    ];
}

/** One trend-bucket row: the date plus its mean slope error (the headline metric). */
export interface BucketRow {
    date: string;
    count: number;
    slopeError: string;
}

/** Per-day slope-error trend rows (oldest first), for the sparkline-free list. */
export function bucketRows(trend: AccuracyTrend): BucketRow[] {
    return trend.buckets.map((b) => ({
        date: b.date,
        count: b.sampleCount,
        slopeError: formatError(b.meanSlopeErrorPct, '%'),
    }));
}
