import { test, expect } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { writeArrayBuffer } from 'geotiff';
import { createTestDb } from '../testing/db';
import {
    seedCourse,
    TEST_COURSE_ID,
    TEST_GREEN_1_ID,
    TEST_GREEN_2_ID,
} from '../db/seeds/course';
import {
    GreenCalibrationService,
    InvalidScanError,
    calibrationConfidence,
    fitBias,
    AGREEMENT_BUDGET_PCT,
    NEUTRAL_AGREEMENT,
    DEM_PRIOR_CONFIDENCE,
    QC_WEIGHT_YELLOW,
} from './green-calibration.service';
import { AnalysisService } from './analysis.service';
import { sweref99tmToWgs84 } from './geo';
import { NotFoundError } from '@basics/core/server/auth';

// ─── Synthetic DEM fixture ────────────────────────────────────────────────
//
// Same pattern as analysis.service.test.ts: an in-test GeoTIFF plane
//   z(e, n) = BASE + GRAD_E·(e − E0) + GRAD_S·(N0 − n)
// so the DEM gradient is exactly (GRAD_E, −GRAD_S) everywhere. The
// constants are chosen so every sampled cell-center height is an exact
// multiple of 1 mm — sampleGrid's mm rounding then introduces zero error
// and the DEM gradient the service sees is exact, letting the bias-fit
// assertions be tight.

const E0 = 540000;
const N0 = 6470000;
const PX = 0.5;
const DEM_W = 200;
const DEM_H = 200;
const BASE = 50;
const GRAD_E = 0.02; // dh/de
const GRAD_S = 0.02; // dh per meter SOUTH → dh/dn = −GRAD_S
const DEM_GRAD = { e: GRAD_E, n: -GRAD_S };

function buildDemPixels(): Float32Array {
    const vals = new Float32Array(DEM_W * DEM_H);
    for (let row = 0; row < DEM_H; row++) {
        const n = N0 - (row + 0.5) * PX;
        for (let col = 0; col < DEM_W; col++) {
            const e = E0 + (col + 0.5) * PX;
            vals[row * DEM_W + col] = BASE + GRAD_E * (e - E0) + GRAD_S * (N0 - n);
        }
    }
    return vals;
}

let fixtureCounter = 0;

async function writeDemFixture(): Promise<{ dataDir: string }> {
    const dataDir = path.join('/tmp', `golf-map-green-cal-test-${process.pid}-${fixtureCounter++}`);
    fs.mkdirSync(path.join(dataDir, 'dem'), { recursive: true });
    const metadata = {
        height: DEM_H,
        width: DEM_W,
        ModelPixelScale: [PX, PX, 0],
        ModelTiepoint: [0, 0, 0, E0, N0, 0],
        ProjectedCSTypeGeoKey: 3006,
        GDAL_NODATA: '-9999 ',
        SampleFormat: [3],
        BitsPerSample: [32],
    };
    const buffer = writeArrayBuffer(buildDemPixels() as never, metadata as never);
    await Bun.write(path.join(dataDir, 'dem', 'test-dem.tif'), buffer as ArrayBuffer);
    return { dataDir };
}

/** 40 m green square, comfortably inside the 100 m fixture. */
const GREEN_MIN_E = E0 + 30;
const GREEN_MIN_N = N0 - 70;
const GREEN_SIZE = 40;

function greenGeometry() {
    return {
        crs: 'EPSG:3006',
        rings: [{
            points: [
                { x: GREEN_MIN_E, y: GREEN_MIN_N },
                { x: GREEN_MIN_E + GREEN_SIZE, y: GREEN_MIN_N },
                { x: GREEN_MIN_E + GREEN_SIZE, y: GREEN_MIN_N + GREEN_SIZE },
                { x: GREEN_MIN_E, y: GREEN_MIN_N + GREEN_SIZE },
            ],
        }],
    };
}

/**
 * Seed the course, write the DEM fixture, register it, and point hole 1's
 * green polygon feature at the fixture area — green 1 becomes DEM-
 * comparable, green 2 stays polygon-less.
 */
async function setupWithDem() {
    const ctx = await createTestDb(seedCourse);
    const { dataDir } = await writeDemFixture();
    // Site-scoped DEM: 1:1 site (id == course id) so analysis resolves via course → site.
    await ctx.db.insertInto('sites').values({ id: TEST_COURSE_ID, name: 'Test Site', version: 1 }).execute();
    await ctx.db.updateTable('courses').where('id', '=', TEST_COURSE_ID).set({ site_id: TEST_COURSE_ID }).execute();
    await ctx.assetsService.register({
        siteId: TEST_COURSE_ID,
        courseId: TEST_COURSE_ID,
        kind: 'dem_cog',
        filename: 'dem/test-dem.tif',
    });
    await ctx.db
        .updateTable('course_features')
        .set({ geometry_json: JSON.stringify(greenGeometry()) })
        .where('id', '=', `${TEST_COURSE_ID}-feature-green-1`)
        .execute();
    const svc = new GreenCalibrationService(ctx.db, new AnalysisService(ctx.db, dataDir));
    return { ctx, svc };
}

// ─── Payload fabrication (contract: docs/reference/green-scan-payload.md) ──

const QUALITY_GREEN = { verdict: 'green', passMismatchSlopePct: 0.1, rmseM: 0.004, coverageFrac: 0.95 };
const QUALITY_YELLOW = { verdict: 'yellow', passMismatchSlopePct: 0.4, rmseM: 0.008, coverageFrac: 0.8 };
const QUALITY_RED = { verdict: 'red', passMismatchSlopePct: 1.5, rmseM: 0.02, coverageFrac: 0.4 };

/** Compass bearing (deg) of the downhill direction for gradient (gx, gy). */
function downhillBearingDeg(gx: number, gy: number): number {
    return (Math.atan2(-gx, -gy) * 180 / Math.PI + 360) % 360;
}

interface SpotOptions {
    headingAccuracyDeg?: number;
    capturedAt?: string;
    /** Override the scan gradient entirely (defaults to DEM + tilt). */
    grad?: { e: number; n: number };
}

/** v1 spot_level whose slope vector equals DEM ∇h + tilt at (e, n). */
function spotPayload(pt: { e: number; n: number }, tilt: { e: number; n: number }, opts: SpotOptions = {}) {
    const gx = opts.grad ? opts.grad.e : DEM_GRAD.e + tilt.e;
    const gy = opts.grad ? opts.grad.n : DEM_GRAD.n + tilt.n;
    const s = Math.hypot(gx, gy);
    const ll = sweref99tmToWgs84(pt.e, pt.n);
    return {
        version: 1,
        kind: 'spot_level',
        capturedAt: opts.capturedAt ?? '2026-07-07T12:00:00Z',
        device: 'iPhone17,2',
        appVersion: '0.1.0',
        location: { lat: ll.lat, lon: ll.lon, horizontalAccuracyM: 2 },
        slopePct: s * 100,
        fallLineBearingDeg: downhillBearingDeg(gx, gy),
        sampleDurationS: 1.2,
        sampleCount: 120,
        tiltStdDeg: 0.03,
        headingAccuracyDeg: opts.headingAccuracyDeg ?? 0,
    };
}

/** v1 corridor whose poly2 gradient equals DEM ∇h + tilt along the line. */
function corridorPayload(
    ball: { e: number; n: number },
    bearingDeg: number,
    lengthM: number,
    tilt: { e: number; n: number },
    opts: { hAcc?: number; fitType?: string; capturedAt?: string } = {},
) {
    const gx = DEM_GRAD.e + tilt.e;
    const gy = DEM_GRAD.n + tilt.n;
    const rad = (bearingDeg * Math.PI) / 180;
    const ex = { x: Math.sin(rad), y: Math.cos(rad) };
    const ey = { x: -ex.y, y: ex.x };
    const c10 = gx * ex.x + gy * ex.y;
    const c01 = gx * ey.x + gy * ey.y;
    const ballLl = sweref99tmToWgs84(ball.e, ball.n);
    const holeLl = sweref99tmToWgs84(ball.e + ex.x * lengthM, ball.n + ex.y * lengthM);
    const hAcc = opts.hAcc ?? 0;
    return {
        version: 1,
        kind: 'corridor',
        capturedAt: opts.capturedAt ?? '2026-07-07T12:00:00Z',
        device: 'iPhone17,2',
        appVersion: '0.1.0',
        ball: { lat: ballLl.lat, lon: ballLl.lon, horizontalAccuracyM: hAcc },
        hole: { lat: holeLl.lat, lon: holeLl.lon, horizontalAccuracyM: hAcc },
        endpointLevels: [],
        frame: { originalLineBearingDeg: bearingDeg, lineLengthM: lengthM },
        points: [],
        fit: {
            type: opts.fitType ?? 'poly2',
            coefficients: [0, c10, c01, 0, 0, 0],
            rmseM: 0.003,
            corridorWidthM: 2.1,
            coverageFrac: 0.93,
        },
        passes: [],
        passMismatchSlopePct: 0.1,
    };
}

const P1 = { e: GREEN_MIN_E + 10, n: GREEN_MIN_N + 20 };
const P2 = { e: GREEN_MIN_E + 25, n: GREEN_MIN_N + 15 };

// ─── Pure functions ────────────────────────────────────────────────────────

test('calibrationConfidence is 0 at zero count, in (0,1), and monotone in count', () => {
    expect(calibrationConfidence(0, 0)).toBe(0);
    expect(calibrationConfidence(1, 0)).toBeCloseTo(0.5, 10);
    expect(calibrationConfidence(2, 0)).toBeGreaterThan(calibrationConfidence(1, 0));
    expect(calibrationConfidence(10, 0)).toBeGreaterThan(calibrationConfidence(2, 0));
    expect(calibrationConfidence(1_000_000, 0)).toBeLessThan(1);
    expect(calibrationConfidence(0.5, 0)).toBeGreaterThan(0);
});

test('calibrationConfidence falls with agreement spread and halves at the budget', () => {
    const atZero = calibrationConfidence(5, 0);
    const atHalfBudget = calibrationConfidence(5, AGREEMENT_BUDGET_PCT / 2);
    const atBudget = calibrationConfidence(5, AGREEMENT_BUDGET_PCT);
    const atTwiceBudget = calibrationConfidence(5, 2 * AGREEMENT_BUDGET_PCT);
    expect(atHalfBudget).toBeLessThan(atZero);
    expect(atBudget).toBeLessThan(atHalfBudget);
    expect(atTwiceBudget).toBeLessThan(atBudget);
    // Spread = budget ⇒ agreement term exactly halves.
    expect(atBudget).toBeCloseTo(atZero / 2, 10);
    expect(atTwiceBudget).toBeGreaterThan(0);
});

test('calibrationConfidence with null spread uses the neutral agreement term', () => {
    expect(calibrationConfidence(1, null)).toBeCloseTo(0.5 * NEUTRAL_AGREEMENT, 10);
    expect(calibrationConfidence(3, null)).toBeCloseTo(0.75 * NEUTRAL_AGREEMENT, 10);
});

test('fitBias computes the weighted mean difference and RMS spread', () => {
    const fit = fitBias([
        { diffE: 0.01, diffN: 0.02, weight: 1 },
        { diffE: 0.03, diffN: -0.02, weight: 1 },
    ]);
    expect(fit).not.toBeNull();
    expect(fit!.tiltE).toBeCloseTo(0.02, 12);
    expect(fit!.tiltN).toBeCloseTo(0, 12);
    // Each sample deviates by (∓0.01, ±0.02) → radial deviation √(0.0005).
    expect(fit!.spreadPct).toBeCloseTo(Math.sqrt(0.0005) * 100, 10);

    // Weights shift the mean.
    const weighted = fitBias([
        { diffE: 0.01, diffN: 0, weight: 3 },
        { diffE: 0.05, diffN: 0, weight: 1 },
    ]);
    expect(weighted!.tiltE).toBeCloseTo(0.02, 12);

    expect(fitBias([])).toBeNull();
    expect(fitBias([{ diffE: 1, diffN: 1, weight: 0 }])).toBeNull();
});

// ─── Spot-level bias fit against the synthetic DEM ─────────────────────────

test('spot-level scans recover a known synthetic tilt and fill bias_json v1', async () => {
    const { svc } = await setupWithDem();
    const tilt = { e: 0.004, n: -0.002 };

    await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, tilt, { capturedAt: '2026-07-07T10:00:00Z' }),
        quality: QUALITY_GREEN,
    });
    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:05:00Z',
        payload: spotPayload(P2, tilt, { capturedAt: '2026-07-07T10:05:00Z' }),
        quality: QUALITY_GREEN,
    });

    expect(calibration).not.toBeNull();
    expect(calibration!.sampleCount).toBe(2);
    const bias = JSON.parse(calibration!.biasJson!);
    expect(bias.version).toBe(1);
    expect(bias.tiltE).toBeCloseTo(tilt.e, 6);
    expect(bias.tiltN).toBeCloseTo(tilt.n, 6);
    expect(bias.sampleCount).toBe(2);
    expect(bias.fittedAt).toBe('2026-07-07T10:05:00Z');
    // Two perfectly agreeing scans: spread ≈ 0 → confidence ≈ 2/3.
    expect(calibration!.confidence).toBeCloseTo(2 / 3, 5);
});

test('corridor scans recover a known synthetic tilt via the poly2 fit', async () => {
    const { svc } = await setupWithDem();
    const tilt = { e: -0.003, n: 0.005 };

    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'corridor',
        capturedAt: '2026-07-07T11:00:00Z',
        payload: corridorPayload({ e: GREEN_MIN_E + 10, n: GREEN_MIN_N + 10 }, 45, 10, tilt),
        quality: QUALITY_GREEN,
    });

    expect(calibration).not.toBeNull();
    expect(calibration!.sampleCount).toBe(1);
    const bias = JSON.parse(calibration!.biasJson!);
    expect(bias.tiltE).toBeCloseTo(tilt.e, 6);
    expect(bias.tiltN).toBeCloseTo(tilt.n, 6);
    // Single scan on a perfect plane: spread ≈ 0 → confidence ≈ 1/2.
    expect(calibration!.confidence).toBeCloseTo(0.5, 5);
});

test('mixed spot + corridor scans with the same tilt agree on the bias', async () => {
    const { svc } = await setupWithDem();
    const tilt = { e: 0.006, n: 0.004 };

    await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, tilt),
        quality: QUALITY_GREEN,
    });
    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'corridor',
        capturedAt: '2026-07-07T10:10:00Z',
        payload: corridorPayload({ e: GREEN_MIN_E + 12, n: GREEN_MIN_N + 25 }, 100, 12, tilt),
        quality: QUALITY_GREEN,
    });

    const bias = JSON.parse(calibration!.biasJson!);
    expect(bias.tiltE).toBeCloseTo(tilt.e, 6);
    expect(bias.tiltN).toBeCloseTo(tilt.n, 6);
    expect(calibration!.sampleCount).toBe(2);
});

// ─── QC gating ─────────────────────────────────────────────────────────────

test('red scans are stored but never counted; red-only greens keep the prior path', async () => {
    const { ctx, svc } = await setupWithDem();

    const { scan, calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, { e: 0.01, n: 0 }),
        quality: QUALITY_RED,
    });

    // Stored…
    expect(scan.id).toBeTruthy();
    const stored = await ctx.db.selectFrom('green_scans').selectAll().execute();
    expect(stored).toHaveLength(1);
    // …but not counted: no calibration row, prior fallback intact.
    expect(calibration).toBeNull();
    expect(await svc.getCalibration(TEST_GREEN_1_ID)).toBeNull();
    const confidences = await svc.confidenceForCourse(TEST_COURSE_ID);
    const green1 = confidences.find((c) => c.greenId === TEST_GREEN_1_ID)!;
    expect(green1.source).toBe('prior');
    expect(green1.confidence).toBe(DEM_PRIOR_CONFIDENCE);
});

test('a red scan added after accepted scans changes nothing', async () => {
    const { svc } = await setupWithDem();
    const tilt = { e: 0.004, n: -0.002 };

    const first = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, tilt),
        quality: QUALITY_GREEN,
    });
    const second = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:05:00Z',
        payload: spotPayload(P2, { e: 0.05, n: 0.05 }),
        quality: QUALITY_RED,
    });

    expect(second.calibration!.sampleCount).toBe(1);
    expect(second.calibration!.biasJson).toBe(first.calibration!.biasJson);
    expect(second.calibration!.confidence).toBe(first.calibration!.confidence);
});

test('yellow scans count at half weight', async () => {
    const { svc } = await setupWithDem();
    const tilt = { e: 0.004, n: -0.002 };

    await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, tilt),
        quality: QUALITY_GREEN,
    });
    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:05:00Z',
        payload: spotPayload(P2, tilt),
        quality: QUALITY_YELLOW,
    });

    expect(calibration!.sampleCount).toBe(1 + QC_WEIGHT_YELLOW);
    // countTerm(1.5) = 0.6; perfect agreement keeps the agreement term ≈ 1.
    expect(calibration!.confidence).toBeCloseTo(0.6, 5);
});

test('missing or unparseable quality excludes a scan without crashing', async () => {
    const { svc } = await setupWithDem();

    const noQuality = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, { e: 0, n: 0 }),
    });
    expect(noQuality.calibration).toBeNull();

    const junkVerdict = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:01:00Z',
        payload: spotPayload(P1, { e: 0, n: 0 }),
        quality: { verdict: 'purple' },
    });
    expect(junkVerdict.calibration).toBeNull();
});

// ─── Contract: ignore what we don't understand (store, don't count) ────────

test('unknown payload version is stored but excluded from calibration', async () => {
    const { svc } = await setupWithDem();
    const payload = { ...spotPayload(P1, { e: 0.004, n: 0 }), version: 2 };

    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload,
        quality: QUALITY_GREEN,
    });
    expect(calibration).toBeNull();
});

test('unknown corridor fit type (e.g. tps) is stored but excluded', async () => {
    const { svc } = await setupWithDem();
    const payload = corridorPayload(
        { e: GREEN_MIN_E + 10, n: GREEN_MIN_N + 10 }, 45, 10, { e: 0, n: 0 }, { fitType: 'tps' },
    );

    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'corridor',
        capturedAt: '2026-07-07T10:00:00Z',
        payload,
        quality: QUALITY_GREEN,
    });
    expect(calibration).toBeNull();
});

test('a malformed (non-object) payload is stored but excluded', async () => {
    const { svc } = await setupWithDem();
    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: 'not-an-object',
        quality: QUALITY_GREEN,
    });
    expect(calibration).toBeNull();
});

// ─── Agreement-weighted confidence ─────────────────────────────────────────

test('disagreeing scans lower confidence relative to agreeing ones', async () => {
    const agree = await setupWithDem();
    const tiltA = { e: 0.02, n: 0 };
    for (const [pt, at] of [[P1, '10:00'], [P2, '10:05']] as const) {
        await agree.svc.ingestScan({
            greenId: TEST_GREEN_1_ID,
            kind: 'spot_level',
            capturedAt: `2026-07-07T${at}:00Z`,
            payload: spotPayload(pt, tiltA),
            quality: QUALITY_GREEN,
        });
    }
    const agreeing = (await agree.svc.getCalibration(TEST_GREEN_1_ID))!;

    const conflict = await setupWithDem();
    for (const [pt, tilt, at] of [
        [P1, { e: 0.02, n: 0 }, '10:00'],
        [P2, { e: -0.02, n: 0 }, '10:05'],
    ] as const) {
        await conflict.svc.ingestScan({
            greenId: TEST_GREEN_1_ID,
            kind: 'spot_level',
            capturedAt: `2026-07-07T${at}:00Z`,
            payload: spotPayload(pt, tilt),
            quality: QUALITY_GREEN,
        });
    }
    const conflicting = (await conflict.svc.getCalibration(TEST_GREEN_1_ID))!;

    // Same weighted count, wildly different agreement.
    expect(conflicting.sampleCount).toBe(agreeing.sampleCount);
    expect(agreeing.confidence).toBeCloseTo(2 / 3, 4);
    expect(conflicting.confidence).toBeLessThan(agreeing.confidence / 5);
    // Opposing tilts cancel in the weighted mean.
    const bias = JSON.parse(conflicting.biasJson!);
    expect(Math.abs(bias.tiltE)).toBeLessThan(1e-4);
    expect(Math.abs(bias.tiltN)).toBeLessThan(1e-4);
});

test('poor heading accuracy shrinks the bearing component of a spot-level diff', async () => {
    // Scan gradient = DEM gradient rotated 20° — a pure BEARING disagreement.
    const rot = (20 * Math.PI) / 180;
    const rotated = {
        e: DEM_GRAD.e * Math.cos(rot) - DEM_GRAD.n * Math.sin(rot),
        n: DEM_GRAD.e * Math.sin(rot) + DEM_GRAD.n * Math.cos(rot),
    };

    const trusted = await setupWithDem();
    await trusted.svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, { e: 0, n: 0 }, { grad: rotated, headingAccuracyDeg: 0 }),
        quality: QUALITY_GREEN,
    });
    const full = JSON.parse((await trusted.svc.getCalibration(TEST_GREEN_1_ID))!.biasJson!);

    const untrusted = await setupWithDem();
    await untrusted.svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, { e: 0, n: 0 }, { grad: rotated, headingAccuracyDeg: 90 }),
        quality: QUALITY_GREEN,
    });
    const shrunk = JSON.parse((await untrusted.svc.getCalibration(TEST_GREEN_1_ID))!.biasJson!);

    const mag = (b: { tiltE: number; tiltN: number }) => Math.hypot(b.tiltE, b.tiltN);
    expect(mag(full)).toBeGreaterThan(0.005); // the rotation is a real disagreement…
    expect(mag(shrunk)).toBeLessThan(0.4 * mag(full)); // …mostly discounted at 90° accuracy
});

// ─── Degraded paths ────────────────────────────────────────────────────────

test('without a DEM asset accepted scans still count but bias stays null', async () => {
    // Base seed only: green 1 has a polygon feature but no dem_cog asset.
    const ctx = await createTestDb(seedCourse);
    const svc = ctx.greenCalibrationService;

    const { calibration } = await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, { e: 0.004, n: 0 }),
        quality: QUALITY_GREEN,
    });

    expect(calibration).not.toBeNull();
    expect(calibration!.sampleCount).toBe(1);
    expect(calibration!.biasJson).toBeNull();
    // No agreement measurable → neutral agreement term: 0.5 × 0.5.
    expect(calibration!.confidence).toBeCloseTo(calibrationConfidence(1, null), 10);
});

test('recompute is deterministic', async () => {
    const { svc } = await setupWithDem();
    await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, { e: 0.004, n: -0.002 }),
        quality: QUALITY_GREEN,
    });
    await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'corridor',
        capturedAt: '2026-07-07T10:10:00Z',
        payload: corridorPayload({ e: GREEN_MIN_E + 12, n: GREEN_MIN_N + 25 }, 200, 8, { e: 0.001, n: 0.001 }),
        quality: QUALITY_YELLOW,
    });

    const first = await svc.recompute(TEST_GREEN_1_ID);
    const second = await svc.recompute(TEST_GREEN_1_ID);
    expect(second!.biasJson).toBe(first!.biasJson);
    expect(second!.confidence).toBe(first!.confidence);
    expect(second!.sampleCount).toBe(first!.sampleCount);
});

// ─── Ingest validation ─────────────────────────────────────────────────────

test('ingestScan rejects an unknown kind', async () => {
    const ctx = await createTestDb(seedCourse);
    await expect(
        ctx.greenCalibrationService.ingestScan({
            greenId: TEST_GREEN_1_ID,
            // deliberately invalid at the service boundary
            kind: 'whole_green' as unknown as 'corridor',
            capturedAt: '2026-07-07T10:00:00Z',
            payload: {},
        }),
    ).rejects.toBeInstanceOf(InvalidScanError);
});

test('ingestScan throws NotFoundError for an unknown green', async () => {
    const ctx = await createTestDb(seedCourse);
    await expect(
        ctx.greenCalibrationService.ingestScan({
            greenId: 'no-such-green',
            kind: 'corridor',
            capturedAt: '2026-07-07T10:00:00Z',
            payload: {},
        }),
    ).rejects.toBeInstanceOf(NotFoundError);
});

// ─── Course confidence endpoint shape ──────────────────────────────────────

test('confidenceForCourse reports scanned greens with bias and unscanned as prior', async () => {
    const { svc } = await setupWithDem();
    const tilt = { e: 0.004, n: -0.002 };
    await svc.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, tilt),
        quality: QUALITY_GREEN,
    });

    const confidences = await svc.confidenceForCourse(TEST_COURSE_ID);
    expect(confidences).toHaveLength(2);
    const byId = Object.fromEntries(confidences.map((c) => [c.greenId, c]));

    const green1 = byId[TEST_GREEN_1_ID];
    expect(green1.source).toBe('scans');
    expect(green1.sampleCount).toBe(1);
    expect(green1.bias).toBeDefined();
    expect(green1.bias!.tiltE).toBeCloseTo(tilt.e, 6);
    expect(green1.bias!.tiltN).toBeCloseTo(tilt.n, 6);

    expect(byId[TEST_GREEN_2_ID]).toEqual({
        greenId: TEST_GREEN_2_ID,
        confidence: DEM_PRIOR_CONFIDENCE,
        sampleCount: 0,
        source: 'prior',
    });
});

test('confidenceForCourse omits bias when none is fitted (no DEM)', async () => {
    const ctx = await createTestDb(seedCourse);
    await ctx.greenCalibrationService.ingestScan({
        greenId: TEST_GREEN_1_ID,
        kind: 'spot_level',
        capturedAt: '2026-07-07T10:00:00Z',
        payload: spotPayload(P1, { e: 0, n: 0 }),
        quality: QUALITY_GREEN,
    });
    const confidences = await ctx.greenCalibrationService.confidenceForCourse(TEST_COURSE_ID);
    const green1 = confidences.find((c) => c.greenId === TEST_GREEN_1_ID)!;
    expect(green1.source).toBe('scans');
    expect(green1.bias).toBeUndefined();
});

test('confidenceForCourse returns an empty list for a course with no greens', async () => {
    const ctx = await createTestDb(seedCourse);
    expect(await ctx.greenCalibrationService.confidenceForCourse('no-such-course')).toEqual([]);
});
