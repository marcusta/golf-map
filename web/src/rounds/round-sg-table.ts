// Pure row-shaping for the distance-band strokes-gained table — the
// headline analytics view per shot-capture doc §5 ("the distance-band
// table is the headline view"). No DOM here; the component
// (round-sg-panel.component.ts) just renders these rows.

import type { DistanceBand, RoundSgSummary, SgCategory } from '../../../shared/strategy';

/** Display order for distance-band rows (shortest to longest). */
export const DISTANCE_BAND_ORDER: readonly DistanceBand[] = [
    '0-30m', '30-100m', '100-150m', '150-200m', '200m+',
];

/** Display order for category rows. */
export const CATEGORY_ORDER: readonly SgCategory[] = ['off-tee', 'approach', 'short', 'putting'];

const BAND_LABELS: Record<DistanceBand, string> = {
    '0-30m': '0 – 30 m',
    '30-100m': '30 – 100 m',
    '100-150m': '100 – 150 m',
    '150-200m': '150 – 200 m',
    '200m+': '200 m+',
};

const CATEGORY_LABELS: Record<SgCategory, string> = {
    'off-tee': 'Off the tee',
    approach: 'Approach',
    short: 'Short game',
    putting: 'Putting',
};

/** One rendered row: a label, shot count, and mean/total SG (null when count is 0 — no data, not zero). */
export interface SgTableRow {
    label: string;
    count: number;
    meanStrokesGained: number | null;
    totalStrokesGained: number | null;
}

function toRow(label: string, count: number, mean: number, total: number): SgTableRow {
    return {
        label,
        count,
        meanStrokesGained: count > 0 ? mean : null,
        totalStrokesGained: count > 0 ? total : null,
    };
}

/** Distance-band rows in display order, empty bands included (count 0, null means). */
export function distanceBandRows(summary: RoundSgSummary): SgTableRow[] {
    return DISTANCE_BAND_ORDER.map((band) => {
        const bucket = summary.byDistanceBand[band];
        return toRow(BAND_LABELS[band], bucket.count, bucket.meanStrokesGained, bucket.totalStrokesGained);
    });
}

/** Category rows in display order, empty categories included. */
export function categoryRows(summary: RoundSgSummary): SgTableRow[] {
    return CATEGORY_ORDER.map((cat) => {
        const bucket = summary.byCategory[cat];
        return toRow(CATEGORY_LABELS[cat], bucket.count, bucket.meanStrokesGained, bucket.totalStrokesGained);
    });
}

/** The round-total row (label fixed, always shown even with 0 shots). */
export function totalRow(summary: RoundSgSummary): SgTableRow {
    const { count, meanStrokesGained, totalStrokesGained } = summary.total;
    return toRow('Total', count, meanStrokesGained, totalStrokesGained);
}

/** Format a strokes-gained number to +/-0.00 (null → an em dash placeholder). */
export function formatSg(value: number | null): string {
    if (value === null) return '—';
    const sign = value > 0 ? '+' : value < 0 ? '' : '±';
    return `${sign}${value.toFixed(2)}`;
}
