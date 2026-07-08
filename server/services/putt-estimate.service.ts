import type { Kysely, Selectable } from 'kysely';
import type { Database, PuttEstimateSamplesTable } from '../db/schema';

// ─── Putt estimate samples (feature-putting-green-reading.md §5.1 training loop) ──
//
// Storage + read side for the practice-mode training loop: before revealing the
// computed read the web planner asks the player for their own read (slope %,
// break side, aim offset, plays-like pace), scores it against the computed read
// (the pure `scoreEstimate` in web/src/planner/putt-estimate-score.ts — mirrored
// to Swift eventually), and records the raw estimate-vs-actual pair here.
//
// The accuracy trend query drives the analytics panel beside strokes-gained
// putting (T14): mean |slope error| is the headline (slope-% estimation is the
// skill that stays legal in competition), with break-side hit rate and mean
// pace (plays-like) error alongside. Two aggregate shapes: a recent-N window
// and a bucketed-over-time series, so the panel can show "how you're doing now"
// and "are you trending better".

/** Break side stored for a sample — the side the ball breaks toward. */
export type BreakSide = 'left' | 'right' | 'straight';

// --- Output types ---

export interface PuttEstimateSample {
    id: string;
    greenId: string | null;
    distanceM: number;
    stimpFt: number;
    actualSlopePct: number;
    estimatedSlopePct: number;
    actualAimOffsetM: number;
    estimatedAimOffsetM: number;
    actualPlaysLikeM: number;
    estimatedPlaysLikeM: number;
    breakSideActual: BreakSide;
    breakSideEstimated: BreakSide;
    createdAt: string;
}

export interface RecordSampleInput {
    /** Green row id, or null for a Tier-3 manual read with no surface. */
    greenId: string | null;
    distanceM: number;
    stimpFt: number;
    actualSlopePct: number;
    estimatedSlopePct: number;
    actualAimOffsetM: number;
    estimatedAimOffsetM: number;
    actualPlaysLikeM: number;
    estimatedPlaysLikeM: number;
    breakSideActual: BreakSide;
    breakSideEstimated: BreakSide;
}

/**
 * The three accuracy aggregates over a set of samples. Null means "no samples"
 * (not zero error) — mirrors the strokes-gained table's null-for-empty rule.
 */
export interface AccuracyAggregate {
    /** How many samples this aggregate covers. */
    sampleCount: number;
    /** Mean |estimated slope% − actual slope%| — the headline. Null when empty. */
    meanSlopeErrorPct: number | null;
    /** Fraction of samples whose estimated break side matched. Null when empty. */
    breakSideHitRate: number | null;
    /** Mean |estimated plays-like − actual plays-like|, meters. Null when empty. */
    meanPaceErrorM: number | null;
}

/** One time bucket in the trend series (oldest first). */
export interface AccuracyBucket extends AccuracyAggregate {
    /** Bucket key — the sample's created_at date, 'YYYY-MM-DD' (UTC). */
    date: string;
}

export interface AccuracyTrend {
    /** Aggregate over the most-recent N samples (N = the requested recentN). */
    recent: AccuracyAggregate;
    /** Aggregate over every sample in scope. */
    overall: AccuracyAggregate;
    /** Per-day buckets over the full history, oldest first. */
    buckets: AccuracyBucket[];
}

export interface AccuracyTrendQuery {
    /** Limit the trend to one green's samples; omit for all greens. */
    greenId?: string | null;
    /** How many recent samples the `recent` aggregate covers (default 20). */
    recentN?: number;
}

export const DEFAULT_RECENT_N = 20;

// --- Row mapping ---

type SampleRow = Selectable<PuttEstimateSamplesTable>;

function toSample(row: SampleRow): PuttEstimateSample {
    return {
        id: row.id,
        greenId: row.green_id,
        distanceM: row.distance_m,
        stimpFt: row.stimp_ft,
        actualSlopePct: row.actual_slope_pct,
        estimatedSlopePct: row.estimated_slope_pct,
        actualAimOffsetM: row.actual_aim_offset_m,
        estimatedAimOffsetM: row.estimated_aim_offset_m,
        actualPlaysLikeM: row.actual_plays_like_m,
        estimatedPlaysLikeM: row.estimated_plays_like_m,
        breakSideActual: row.break_side_actual as BreakSide,
        breakSideEstimated: row.break_side_estimated as BreakSide,
        createdAt: row.created_at,
    };
}

/** Aggregate a set of already-mapped samples (pure — shared by every window). */
function aggregate(samples: readonly PuttEstimateSample[]): AccuracyAggregate {
    const n = samples.length;
    if (n === 0) {
        return { sampleCount: 0, meanSlopeErrorPct: null, breakSideHitRate: null, meanPaceErrorM: null };
    }
    let slopeErr = 0;
    let paceErr = 0;
    let hits = 0;
    for (const s of samples) {
        slopeErr += Math.abs(s.estimatedSlopePct - s.actualSlopePct);
        paceErr += Math.abs(s.estimatedPlaysLikeM - s.actualPlaysLikeM);
        if (s.breakSideEstimated === s.breakSideActual) hits += 1;
    }
    return {
        sampleCount: n,
        meanSlopeErrorPct: slopeErr / n,
        breakSideHitRate: hits / n,
        meanPaceErrorM: paceErr / n,
    };
}

export class PuttEstimateService {
    constructor(private db: Kysely<Database>) {}

    /** Record one estimate-vs-actual training sample. Returns the stored row. */
    async recordSample(input: RecordSampleInput): Promise<PuttEstimateSample> {
        const id = crypto.randomUUID();
        await this.db
            .insertInto('putt_estimate_samples')
            .values({
                id,
                green_id: input.greenId,
                distance_m: input.distanceM,
                stimp_ft: input.stimpFt,
                actual_slope_pct: input.actualSlopePct,
                estimated_slope_pct: input.estimatedSlopePct,
                actual_aim_offset_m: input.actualAimOffsetM,
                estimated_aim_offset_m: input.estimatedAimOffsetM,
                actual_plays_like_m: input.actualPlaysLikeM,
                estimated_plays_like_m: input.estimatedPlaysLikeM,
                break_side_actual: input.breakSideActual,
                break_side_estimated: input.breakSideEstimated,
            })
            .execute();

        const row = await this.db
            .selectFrom('putt_estimate_samples')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();
        return toSample(row);
    }

    /**
     * Estimation-accuracy trend for the analytics panel: a recent-N window, an
     * overall aggregate, and per-day buckets (oldest first). Optionally scoped
     * to one green. Ordering is by created_at then id so ties are deterministic.
     */
    async accuracyTrend(query: AccuracyTrendQuery = {}): Promise<AccuracyTrend> {
        const recentN = query.recentN ?? DEFAULT_RECENT_N;

        let q = this.db.selectFrom('putt_estimate_samples').selectAll();
        if (query.greenId !== undefined && query.greenId !== null) {
            q = q.where('green_id', '=', query.greenId);
        }
        const rows = await q
            .orderBy('created_at', 'asc')
            .orderBy('id', 'asc')
            .execute();
        const samples = rows.map(toSample);

        const overall = aggregate(samples);
        const recent = aggregate(samples.slice(Math.max(0, samples.length - recentN)));

        // Per-day buckets keyed on the UTC date portion of created_at.
        const byDate = new Map<string, PuttEstimateSample[]>();
        for (const s of samples) {
            const date = s.createdAt.slice(0, 10);
            const list = byDate.get(date);
            if (list) list.push(s);
            else byDate.set(date, [s]);
        }
        const buckets: AccuracyBucket[] = [...byDate.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([date, group]) => ({ date, ...aggregate(group) }));

        return { recent, overall, buckets };
    }
}
