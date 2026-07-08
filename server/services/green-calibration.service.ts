import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type { Database, GreenScansTable, GreenCalibrationTable } from '../db/schema';
import { NotFoundError } from '@basics/core/server/auth';
import { wgs84ToSweref99tm, type FeatureGeometry } from './geo';
import { InvalidAnalysisRequestError, type AnalysisService } from './analysis.service';
import { demSurface } from '../../shared/strategy/putting/dem-surface';
import type { GreenSurface } from '../../shared/strategy/putting/green-surface';
import { bearingToUnitVector } from '../../shared/strategy/ellipse';

// ─── Green scan → DEM calibration (feature-putting-green-reading.md §4.2) ──
//
// Stores per-green LiDAR corridor scans and IMU spot-level samples (wire
// format: docs/reference/green-scan-payload.md — payloads stored verbatim),
// and keeps a per-green calibration aggregate derived from them:
//
//  1. QC gating — only scans whose quality_json verdict is 'green' (weight
//     1.0) or 'yellow' (weight 0.5) count toward calibration. 'red',
//     missing, or unparseable verdicts — and payloads the server does not
//     understand (unknown version, unknown kind, unknown fit type) — are
//     stored but never counted ("store, don't count", contract rule).
//     sample_count = the weighted accepted count (sums of 1.0/0.5 are exact
//     in binary floating point, so it is stored unrounded).
//
//  2. Per-scan DEM comparison — each accepted scan yields one or more
//     gradient-difference vectors d = scan ∇h − DEM ∇h (rise/run fractions
//     on EPSG:3006 east/north axes, green-surface.ts conventions). Scan
//     locations are projected WGS84 → EPSG:3006 with the server's own
//     wgs84ToSweref99tm; the DEM gradient comes from the SAME surface the
//     Tier-2 consumers read — analysisService.sampleGrid over the green's
//     polygon feature (blurred grid), wrapped in the shared demSurface
//     bilinear adapter — so the fitted bias is expressed exactly in the
//     frame it will be applied in (corrected ∇h = DEM ∇h + tilt).
//
//  3. Bias fit — the weighted mean of the difference vectors, persisted as
//     bias_json v1 { version, tiltE, tiltN, fittedAt, sampleCount }. v1 is
//     a constant per-green tilt, deliberately NOT spatially varying: with a
//     handful of corridor patches per green the only robustly identifiable
//     disagreement is the low-frequency component (doc §4.2 — "low-
//     frequency tilt/offset fit"); a spatial field would overfit whichever
//     corridors happen to exist. fittedAt = the newest accepted scan's
//     captured_at, so recompute is fully deterministic for a given scan set.
//
//  4. Confidence — calibrationConfidence(weightedCount, spreadPct), a pure
//     exported function of the weighted accepted count and the agreement
//     spread of the difference vectors (see its doc comment for the exact
//     formula). Greens with no accepted scans get NO calibration row and
//     fall back to the DEM prior (source 'prior') in confidenceForCourse.
//
// OPEN QUESTION Q3 (docs §9.3): the DEM-prior confidence below is a single
// flat constant. It should eventually be set per green from Lantmäteriet
// DEM vintage and point density (older / sparser scans → lower prior).

/**
 * Confidence assigned to a green that has no calibration row (no accepted
 * scans): the trust we place in the bare Lantmäteriet DEM slope grid
 * (Tier 2). Middle-of-the-road prior — good macro slope, weak micro
 * (§4 tier table). Q3: should become per-green from DEM vintage/density.
 */
export const DEM_PRIOR_CONFIDENCE = 0.6;

/** QC verdict weights (contract: green full, yellow half, red never). */
export const QC_WEIGHT_GREEN = 1.0;
export const QC_WEIGHT_YELLOW = 0.5;

/**
 * Read precision budget, slope percent (doc §4: 0.2–0.5% — the midpoint).
 * Used twice: as the agreement scale σ0 in calibrationConfidence, and as
 * the trusted-error scale when shrinking a spot level's compass-limited
 * bearing component.
 */
export const AGREEMENT_BUDGET_PCT = 0.35;

/**
 * Agreement term used when no DEM comparison was possible (no DEM asset,
 * no green polygon, or every sample off-coverage): we can count accepted
 * scans but cannot measure agreement, so stay deliberately non-committal.
 */
export const NEUTRAL_AGREEMENT = 0.5;

/**
 * Position-accuracy scale for corridor down-weighting, meters. GPS error
 * moves the whole corridor on the DEM, smearing the comparison; at
 * horizontalAccuracyM = POSITION_REF_M the corridor's fit weight halves
 * (w = ref² / (ref² + acc²)). 3 m ≈ typical phone GPS on open ground and
 * ≈ the scale over which a green's DEM gradient changes materially.
 */
export const POSITION_REF_M = 3;

/**
 * Stations along the corridor line where the poly2 fit's gradient is
 * compared to the DEM's. Placed at t = (i + 0.5) / k of the line length —
 * interior stations only, avoiding the endpoints where the fit runs on the
 * edge of its data.
 */
export const CORRIDOR_STATIONS = 5;

/**
 * headingAccuracyDeg fallback when the payload omits it or it is not a
 * finite number: treat the compass as unknown (90° ⇒ the bearing component
 * is shrunk essentially to zero — conservative, never confident).
 */
export const UNKNOWN_HEADING_ACCURACY_DEG = 90;

/** Scan kinds accepted at ingest. */
export type ScanKind = 'corridor' | 'spot_level';
const SCAN_KINDS: readonly ScanKind[] = ['corridor', 'spot_level'];

// ─── Pure calibration math (exported for unit tests / later tuning) ───────

/** One gradient-difference observation feeding the bias fit. */
export interface BiasSample {
    /** scan dh/de − DEM dh/de, rise/run fraction (EPSG:3006 east). */
    diffE: number;
    /** scan dh/dn − DEM dh/dn, rise/run fraction (EPSG:3006 north). */
    diffN: number;
    /** Fit weight (QC weight × accuracy down-weights ÷ per-scan stations). */
    weight: number;
}

export interface BiasFit {
    /** Weighted mean difference, east component (rise/run fraction). */
    tiltE: number;
    /** Weighted mean difference, north component (rise/run fraction). */
    tiltN: number;
    /**
     * Agreement spread: weighted RMS radial deviation of the difference
     * vectors around (tiltE, tiltN), in slope PERCENT.
     */
    spreadPct: number;
}

/**
 * Weighted low-frequency bias fit: the weighted mean gradient-difference
 * vector over all accepted samples, plus the weighted RMS spread around it.
 * Returns null when there are no (positively weighted) samples.
 */
export function fitBias(samples: readonly BiasSample[]): BiasFit | null {
    let w = 0;
    let sumE = 0;
    let sumN = 0;
    for (const s of samples) {
        if (s.weight <= 0) continue;
        w += s.weight;
        sumE += s.weight * s.diffE;
        sumN += s.weight * s.diffN;
    }
    if (w <= 0) return null;
    const tiltE = sumE / w;
    const tiltN = sumN / w;

    let sq = 0;
    for (const s of samples) {
        if (s.weight <= 0) continue;
        const de = s.diffE - tiltE;
        const dn = s.diffN - tiltN;
        sq += s.weight * (de * de + dn * dn);
    }
    return { tiltE, tiltN, spreadPct: Math.sqrt(sq / w) * 100 };
}

/**
 * Calibration confidence — pure, tuned later. Exact formula:
 *
 *     countTerm(n)     = n / (n + 1)
 *     agreementTerm(σ) = σ0² / (σ0² + σ²)        σ0 = AGREEMENT_BUDGET_PCT
 *     confidence       = countTerm(n) × agreementTerm(σ)
 *
 * where n is the weighted accepted-scan count and σ the agreement spread
 * (BiasFit.spreadPct — weighted RMS deviation of the gradient-difference
 * vectors around the fitted bias, slope percent). σ = null means no DEM
 * comparison was possible; agreementTerm is then NEUTRAL_AGREEMENT.
 *
 * Properties: 0 at n = 0; strictly < 1 for all inputs (countTerm < 1,
 * agreementTerm ≤ 1); monotone increasing in n; monotone decreasing in σ;
 * agreement halves exactly when the spread equals the precision budget.
 * One perfect scan → 0.5; two perfectly agreeing scans → ⅔ (just above the
 * 0.6 DEM prior — a single scan is never enough to beat the prior).
 */
export function calibrationConfidence(weightedCount: number, spreadPct: number | null): number {
    if (weightedCount <= 0) return 0;
    const countTerm = weightedCount / (weightedCount + 1);
    const s0 = AGREEMENT_BUDGET_PCT;
    const agreementTerm =
        spreadPct === null ? NEUTRAL_AGREEMENT : (s0 * s0) / (s0 * s0 + spreadPct * spreadPct);
    return countTerm * agreementTerm;
}

// ─── Payload parsing (contract: docs/reference/green-scan-payload.md) ─────

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * QC gate: verdict 'green' → 1.0, 'yellow' → 0.5, anything else (red,
 * missing quality_json, unparseable JSON, absent verdict) → null (stored
 * but never counted).
 */
function qcWeight(qualityJson: string | null): number | null {
    if (qualityJson === null) return null;
    let quality: unknown;
    try {
        quality = JSON.parse(qualityJson);
    } catch {
        return null;
    }
    if (!quality || typeof quality !== 'object') return null;
    const verdict = (quality as { verdict?: unknown }).verdict;
    if (verdict === 'green') return QC_WEIGHT_GREEN;
    if (verdict === 'yellow') return QC_WEIGHT_YELLOW;
    return null;
}

interface ParsedSpotLevel {
    kind: 'spot_level';
    /** Scan location, EPSG:3006. */
    e: number;
    n: number;
    slopePct: number;
    fallLineBearingDeg: number;
    headingAccuracyDeg: number;
}

interface ParsedCorridor {
    kind: 'corridor';
    /** Ball anchor (local-frame origin), EPSG:3006. */
    ballE: number;
    ballN: number;
    /** Compass bearing of the local +x axis (ball → hole at scan start). */
    lineBearingDeg: number;
    lineLengthM: number;
    /** poly2: h = c00 + c10·x + c01·y + c20·x² + c11·xy + c02·y². */
    coefficients: readonly number[];
    /** Worst endpoint GPS accuracy; POSITION_REF_M when unreported. */
    horizontalAccuracyM: number;
}

type ParsedPayload = ParsedSpotLevel | ParsedCorridor;

/**
 * Parse a stored payload into the fields the calibration needs. Returns
 * null for anything the v1 consumer does not understand — unknown version,
 * unknown kind, unknown fit type, malformed/missing required fields — per
 * the contract's "ignore kinds or versions you don't understand, never
 * guess" rule. Null ⇒ the scan stays stored but is excluded.
 */
function parsePayload(payloadJson: string): ParsedPayload | null {
    let raw: unknown;
    try {
        raw = JSON.parse(payloadJson);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    // Untrusted wire shape — every field below is checked before use.
    const p = raw as Record<string, unknown>;
    if (p.version !== 1) return null;
    const obj = (v: unknown): Record<string, unknown> | null =>
        v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

    if (p.kind === 'spot_level') {
        const loc = obj(p.location);
        if (!loc || !isNum(loc.lat) || !isNum(loc.lon)) return null;
        if (!isNum(p.slopePct) || p.slopePct < 0 || !isNum(p.fallLineBearingDeg)) return null;
        const { x: e, y: n } = wgs84ToSweref99tm(loc.lat, loc.lon);
        return {
            kind: 'spot_level',
            e,
            n,
            slopePct: p.slopePct,
            fallLineBearingDeg: p.fallLineBearingDeg,
            headingAccuracyDeg: isNum(p.headingAccuracyDeg)
                ? Math.abs(p.headingAccuracyDeg)
                : UNKNOWN_HEADING_ACCURACY_DEG,
        };
    }

    if (p.kind === 'corridor') {
        const ball = obj(p.ball);
        const frame = obj(p.frame);
        const fit = obj(p.fit);
        if (!ball || !isNum(ball.lat) || !isNum(ball.lon)) return null;
        if (!frame || !isNum(frame.originalLineBearingDeg)) return null;
        if (!isNum(frame.lineLengthM) || frame.lineLengthM <= 0) return null;
        const coefficients = fit?.coefficients;
        if (
            !fit ||
            fit.type !== 'poly2' ||
            !Array.isArray(coefficients) ||
            coefficients.length !== 6 ||
            !coefficients.every(isNum)
        ) {
            return null;
        }
        const { x: ballE, y: ballN } = wgs84ToSweref99tm(ball.lat, ball.lon);
        // Position accuracy: the worst reported endpoint. Unreported →
        // POSITION_REF_M (unknown accuracy is treated as mediocre, not good).
        const accuracies = [ball.horizontalAccuracyM, obj(p.hole)?.horizontalAccuracyM].filter(isNum);
        const horizontalAccuracyM = accuracies.length > 0 ? Math.max(...accuracies) : POSITION_REF_M;
        return {
            kind: 'corridor',
            ballE,
            ballN,
            lineBearingDeg: frame.originalLineBearingDeg,
            lineLengthM: frame.lineLengthM,
            coefficients,
            horizontalAccuracyM,
        };
    }

    return null;
}

// ─── Per-scan DEM comparison ───────────────────────────────────────────────

/**
 * Spot level → at most one difference vector. The scan's slope vector is
 * ∇h = −downhill(fallLineBearingDeg) × slopePct/100 (green-surface.ts
 * convention: gradient points uphill). The difference against the DEM is
 * then decomposed relative to the scan's own gradient direction:
 *
 *   - the PARALLEL (magnitude) component is fully trusted — gravity-
 *     anchored tilt is ~0.1° truth (doc §4.2);
 *   - the PERPENDICULAR (bearing) component is compass-limited: a heading
 *     error δθ swings the scan gradient sideways by ≈ slope × sin(δθ), so
 *     that component is shrunk by w⊥ = σ0² / (σ0² + (s·sin δθ)²) with
 *     σ0 = AGREEMENT_BUDGET_PCT as a slope fraction. Shrinking (rather
 *     than reweighting the whole sample) keeps the trustworthy magnitude
 *     information at full weight while pulling the untrustworthy bearing
 *     disagreement toward zero — a conservative "apply less correction
 *     where the data is weak" rule.
 *
 * Returns [] when the DEM has no reading at the point (off green/no data).
 */
function spotLevelSamples(p: ParsedSpotLevel, weight: number, surface: GreenSurface): BiasSample[] {
    const dem = surface.sampleAt({ x: p.e, y: p.n });
    if (!dem) return [];

    const s = p.slopePct / 100;
    const downhill = bearingToUnitVector(p.fallLineBearingDeg);
    const scanGX = -downhill.x * s;
    const scanGY = -downhill.y * s;

    let diffE = scanGX - dem.gradX;
    let diffN = scanGY - dem.gradY;

    if (s > 0) {
        // Unit vectors along / perpendicular to the scan gradient.
        const ex = scanGX / s;
        const ey = scanGY / s;
        const px = -ey;
        const py = ex;
        const dPar = diffE * ex + diffN * ey;
        const dPerp = diffE * px + diffN * py;
        const rad = (Math.min(p.headingAccuracyDeg, 90) * Math.PI) / 180;
        const sigmaHeading = s * Math.sin(rad);
        const s0 = AGREEMENT_BUDGET_PCT / 100;
        const wPerp = (s0 * s0) / (s0 * s0 + sigmaHeading * sigmaHeading);
        diffE = dPar * ex + wPerp * dPerp * px;
        diffN = dPar * ey + wPerp * dPerp * py;
    }

    return [{ diffE, diffN, weight }];
}

/**
 * Corridor → up to CORRIDOR_STATIONS difference vectors along the line.
 *
 * Stations sit on the local x-axis (the corridor line, y = 0) at
 * x = (i + 0.5)/k × lineLengthM. The poly2 gradient there is
 * (c10 + 2·c20·x, c01 + c11·x) in the local gravity frame, rotated into
 * EPSG:3006 via êx = bearingToUnitVector(originalLineBearingDeg) and
 * êy = êx rotated 90° CCW (local +y = left of the line, contract §frame).
 * World-frame station positions are ball + êx·x — same projection as the
 * gradient rotation, so fit and DEM are compared at identical points.
 *
 * Weighting: the k stations SHARE the scan's QC weight (weight/k each) so
 * one corridor counts like one scan in the fit, matching sample_count
 * semantics. The whole scan is further down-weighted for GPS position
 * uncertainty by w = ref² / (ref² + acc²) (ref = POSITION_REF_M): position
 * error slides the corridor across the DEM, so the comparison blurs with
 * acc — this is a fit weight only and does not touch sample_count. The
 * corridor's own bearing needs no compass shrinkage: roll/pitch (and thus
 * the fitted gradient) is gravity-anchored, and position accuracy is the
 * designated weak link here (doc §4.1). Stations with no DEM reading are
 * skipped (their weight is dropped, not redistributed).
 */
function corridorSamples(p: ParsedCorridor, weight: number, surface: GreenSurface): BiasSample[] {
    const ex = bearingToUnitVector(p.lineBearingDeg);
    const ey = { x: -ex.y, y: ex.x }; // êx rotated 90° CCW — left of the line
    const [, c10, c01, c20, c11] = p.coefficients;

    const ref = POSITION_REF_M;
    const acc = p.horizontalAccuracyM;
    const wPos = (ref * ref) / (ref * ref + acc * acc);
    const stationWeight = (weight * wPos) / CORRIDOR_STATIONS;

    const samples: BiasSample[] = [];
    for (let i = 0; i < CORRIDOR_STATIONS; i++) {
        const x = ((i + 0.5) / CORRIDOR_STATIONS) * p.lineLengthM;
        const dem = surface.sampleAt({ x: p.ballE + ex.x * x, y: p.ballN + ex.y * x });
        if (!dem) continue;
        // poly2 gradient at (x, 0) in the local frame.
        const gxLocal = c10 + 2 * c20 * x;
        const gyLocal = c01 + c11 * x;
        // Rotate into EPSG:3006 east/north.
        const gradE = gxLocal * ex.x + gyLocal * ey.x;
        const gradN = gxLocal * ex.y + gyLocal * ey.y;
        samples.push({ diffE: gradE - dem.gradX, diffN: gradN - dem.gradY, weight: stationWeight });
    }
    return samples;
}

// --- Output types ---

export interface GreenScan {
    id: string;
    greenId: string;
    kind: string;
    capturedAt: string;
    payloadJson: string;
    qualityJson: string | null;
    createdAt: string;
}

export interface GreenCalibration {
    greenId: string;
    biasJson: string | null;
    confidence: number;
    sampleCount: number;
    updatedAt: string;
}

/** Fitted bias exposed to consumers (rise/run fractions, EPSG:3006). */
export interface GreenBias {
    tiltE: number;
    tiltN: number;
}

/** One green's confidence for the per-course confidence query. */
export interface GreenConfidence {
    greenId: string;
    confidence: number;
    /** Weighted accepted-scan count (green 1.0, yellow 0.5). */
    sampleCount: number;
    /** 'scans' = derived from stored calibration; 'prior' = DEM fallback. */
    source: 'scans' | 'prior';
    /** Present only when a bias has been fitted for this green. */
    bias?: GreenBias;
}

export interface IngestScanInput {
    greenId: string;
    kind: ScanKind;
    capturedAt: string;
    /** Raw scan/sample data — stored verbatim (contract: green-scan-payload.md). */
    payload: unknown;
    /** QC verdict + agreement stats (contract quality_json). */
    quality?: unknown;
}

export class InvalidScanError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidScanError';
    }
}

// --- Row mapping ---

type ScanRow = Selectable<GreenScansTable>;
type CalibrationRow = Selectable<GreenCalibrationTable>;

function toScan(row: ScanRow): GreenScan {
    return {
        id: row.id,
        greenId: row.green_id,
        kind: row.kind,
        capturedAt: row.captured_at,
        payloadJson: row.payload_json,
        qualityJson: row.quality_json,
        createdAt: row.created_at,
    };
}

function toCalibration(row: CalibrationRow): GreenCalibration {
    return {
        greenId: row.green_id,
        biasJson: row.bias_json,
        confidence: row.confidence,
        sampleCount: row.sample_count,
        updatedAt: row.updated_at,
    };
}

function parseBias(biasJson: string | null): GreenBias | undefined {
    if (!biasJson) return undefined;
    try {
        const b = JSON.parse(biasJson) as { version?: unknown; tiltE?: unknown; tiltN?: unknown };
        if (b && b.version === 1 && isNum(b.tiltE) && isNum(b.tiltN)) {
            return { tiltE: b.tiltE, tiltN: b.tiltN };
        }
    } catch {
        // fall through — a bias we can't parse is treated as absent
    }
    return undefined;
}

/** Round a tilt for storage: 1e-6 rise/run is far below any read budget. */
const roundTilt = (v: number): number => Math.round(v * 1e6) / 1e6;

export class GreenCalibrationService {
    constructor(
        private db: Kysely<Database>,
        private analysis: AnalysisService,
    ) {}

    /**
     * Ingest one scan: insert a `green_scans` row, then recompute the
     * green's calibration aggregate (QC gating → DEM comparison → bias fit
     * → confidence; see module header). Returns the inserted scan and the
     * recomputed calibration — null when the green has no accepted scans
     * (e.g. this scan was 'red': stored, not counted).
     */
    async ingestScan(
        input: IngestScanInput,
    ): Promise<{ scan: GreenScan; calibration: GreenCalibration | null }> {
        if (!SCAN_KINDS.includes(input.kind)) {
            throw new InvalidScanError(`Unknown scan kind: ${input.kind}`);
        }
        const green = await this.db
            .selectFrom('greens')
            .select('id')
            .where('id', '=', input.greenId)
            .executeTakeFirst();
        if (!green) throw new NotFoundError(`Green not found: ${input.greenId}`);

        const id = crypto.randomUUID();
        await this.db
            .insertInto('green_scans')
            .values({
                id,
                green_id: input.greenId,
                kind: input.kind,
                captured_at: input.capturedAt,
                payload_json: JSON.stringify(input.payload ?? null),
                quality_json: input.quality === undefined ? null : JSON.stringify(input.quality),
            })
            .execute();

        const scanRow = await this.db
            .selectFrom('green_scans')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirstOrThrow();

        const calibration = await this.recompute(input.greenId);
        return { scan: toScan(scanRow), calibration };
    }

    /**
     * Recompute the calibration aggregate for one green from its stored
     * scans. Deterministic: scans are processed in (created_at, id) order,
     * and every input (scan payloads, DEM raster, green polygon) is stable
     * between calls. With no accepted scans the calibration row is DELETED
     * so the green returns to the DEM-prior path; otherwise the row is
     * upserted with the weighted count, fitted bias (when a DEM comparison
     * was possible) and confidence.
     */
    async recompute(greenId: string): Promise<GreenCalibration | null> {
        const rows = await this.db
            .selectFrom('green_scans')
            .selectAll()
            .where('green_id', '=', greenId)
            .orderBy('created_at')
            .orderBy('id')
            .execute();

        // QC gate + payload parse: everything else is stored, not counted.
        const accepted: Array<{ weight: number; payload: ParsedPayload; capturedAt: string }> = [];
        for (const row of rows) {
            const weight = qcWeight(row.quality_json);
            if (weight === null) continue;
            const payload = parsePayload(row.payload_json);
            if (payload === null) continue;
            accepted.push({ weight, payload, capturedAt: row.captured_at });
        }

        if (accepted.length === 0) {
            await this.db.deleteFrom('green_calibration').where('green_id', '=', greenId).execute();
            return null;
        }

        const weightedCount = accepted.reduce((sum, a) => sum + a.weight, 0);

        let fit: BiasFit | null = null;
        const surface = await this.greenSurface(greenId);
        if (surface) {
            const samples: BiasSample[] = [];
            for (const a of accepted) {
                if (a.payload.kind === 'spot_level') {
                    samples.push(...spotLevelSamples(a.payload, a.weight, surface));
                } else {
                    samples.push(...corridorSamples(a.payload, a.weight, surface));
                }
            }
            fit = fitBias(samples);
        }

        const confidence = calibrationConfidence(weightedCount, fit ? fit.spreadPct : null);
        // fittedAt = newest accepted capture (ISO strings order lexically) —
        // time-independent, so recompute is deterministic.
        const fittedAt = accepted.reduce(
            (max, a) => (a.capturedAt > max ? a.capturedAt : max),
            accepted[0].capturedAt,
        );
        const biasJson = fit
            ? JSON.stringify({
                  version: 1,
                  tiltE: roundTilt(fit.tiltE),
                  tiltN: roundTilt(fit.tiltN),
                  fittedAt,
                  sampleCount: weightedCount,
              })
            : null;

        await this.db
            .insertInto('green_calibration')
            .values({
                green_id: greenId,
                bias_json: biasJson,
                confidence,
                sample_count: weightedCount,
                updated_at: sql`(datetime('now'))`,
            })
            .onConflict((oc) =>
                oc.column('green_id').doUpdateSet({
                    bias_json: biasJson,
                    confidence,
                    sample_count: weightedCount,
                    updated_at: sql`(datetime('now'))`,
                }),
            )
            .execute();

        const row = await this.db
            .selectFrom('green_calibration')
            .selectAll()
            .where('green_id', '=', greenId)
            .executeTakeFirstOrThrow();
        return toCalibration(row);
    }

    async getCalibration(greenId: string): Promise<GreenCalibration | null> {
        const row = await this.db
            .selectFrom('green_calibration')
            .selectAll()
            .where('green_id', '=', greenId)
            .executeTakeFirst();
        return row ? toCalibration(row) : null;
    }

    /**
     * Per-green confidence for every green on a course. Greens with a
     * calibration row report their stored confidence (source: 'scans') and,
     * when fitted, the bias tilt; greens with none fall back to the DEM
     * prior (source: 'prior'). Ordered by green id for stable output.
     */
    async confidenceForCourse(courseId: string): Promise<GreenConfidence[]> {
        const rows = await this.db
            .selectFrom('greens')
            .innerJoin('holes', 'holes.id', 'greens.hole_id')
            .leftJoin('green_calibration', 'green_calibration.green_id', 'greens.id')
            .where('holes.course_id', '=', courseId)
            .select([
                'greens.id as green_id',
                'green_calibration.confidence as confidence',
                'green_calibration.sample_count as sample_count',
                'green_calibration.bias_json as bias_json',
            ])
            .orderBy('greens.id')
            .execute();

        return rows.map((row) => {
            if (row.confidence === null || row.sample_count === null) {
                return {
                    greenId: row.green_id,
                    confidence: DEM_PRIOR_CONFIDENCE,
                    sampleCount: 0,
                    source: 'prior' as const,
                };
            }
            const bias = parseBias(row.bias_json);
            return {
                greenId: row.green_id,
                confidence: row.confidence,
                sampleCount: row.sample_count,
                source: 'scans' as const,
                ...(bias ? { bias } : {}),
            };
        });
    }

    // --- DEM surface over the green ---

    /**
     * The Tier-2 surface for a green: its polygon feature (course_features
     * type 'green' on the green's hole) sampled through the analysis
     * service's blurred grid, wrapped in the shared bilinear demSurface —
     * the exact surface the web/iOS Tier-2 read consumes, so the fitted
     * bias lives in the same frame it will be applied in. Returns null when
     * no comparison is possible (no polygon, no DEM asset, off-coverage) —
     * calibration then degrades to count-only confidence.
     */
    private async greenSurface(greenId: string): Promise<GreenSurface | null> {
        const green = await this.db
            .selectFrom('greens')
            .innerJoin('holes', 'holes.id', 'greens.hole_id')
            .select(['greens.hole_id as hole_id', 'holes.course_id as course_id'])
            .where('greens.id', '=', greenId)
            .executeTakeFirst();
        if (!green) return null;

        const feature = await this.db
            .selectFrom('course_features')
            .select('geometry_json')
            .where('hole_id', '=', green.hole_id)
            .where('type', '=', 'green')
            .orderBy('id')
            .executeTakeFirst();
        if (!feature) return null;

        let geometry: FeatureGeometry;
        try {
            geometry = JSON.parse(feature.geometry_json) as FeatureGeometry;
        } catch {
            return null;
        }

        try {
            const grid = await this.analysis.sampleGrid(green.course_id, geometry);
            return demSurface(grid);
        } catch (err) {
            if (err instanceof NotFoundError || err instanceof InvalidAnalysisRequestError) {
                return null;
            }
            throw err;
        }
    }
}
