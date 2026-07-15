import { Signal, Computed } from '@basics/core/client/core';
import { request, type RequestError } from '@basics/core/client/request';
import {
    createAnalysisClient,
    type AnalysisApi,
    type SampleGrid,
} from '../../../shared/api/analysis.gen';
import {
    createGreenCalibrationClient,
    type GreenCalibrationApi,
    type GreenConfidence,
} from '../../../shared/api/green-calibration.gen';
import {
    DEM_DEFAULT_CONFIDENCE,
    demSurface,
    formatTourRead,
    readPutt,
    tourRead,
    type GreenSurface,
    type PuttRead,
    type TourRead,
    type TourReadVerbal,
    type Vec2,
} from '../../../shared/strategy';
import type { PuttGroundTruth } from './putt-estimate-score';
import type { FeatureGeometry } from '../geo/bezier';

/** Which analysis overlay the putt green view shows under the read. Reuses
 *  the Green-analysis Slope/Height maps (not a bespoke one); 'none' = clean. */
export type PuttOverlayMode = 'none' | 'slope' | 'height';
const OVERLAY_MODE_KEY = 'golf-map.putt.overlayMode';
function loadOverlayMode(): PuttOverlayMode {
    try {
        const v = localStorage.getItem(OVERLAY_MODE_KEY);
        return v === 'none' || v === 'slope' || v === 'height' ? v : 'slope';
    } catch {
        return 'slope';
    }
}

/** How many cross-slope readings to sample along the ball→hole line. */
const PATH_SLOPE_SAMPLES = 3;

/** Default stimp when nothing is entered (doc §9 Q1 — manual, like wind). */
export const DEFAULT_STIMP_FT = 10;
/** Input clamp for the stimp field — outside this is a typo, not a green. */
export const STIMP_MIN_FT = 4;
export const STIMP_MAX_FT = 16;

/** Requested putt sample-grid cell size — the DEM's native 0.5 m. */
export const PUTT_RESOLUTION_M = 0.5;
/**
 * Surrounds buffer for the putt grid fetch, meters. Only cells INSIDE the
 * green polygon are usable surface (demSurface honours insideMask), so the
 * buffer just gives the grid a margin; kept at the analysis minimum.
 */
export const PUTT_GRID_BUFFER_M = 10;

/**
 * Below this min-confidence the exact read is SOFTENED (shown with an explicit
 * low-confidence warning), per the doc's precision budget (§4): Tier-2 clears
 * the 0.2–0.5% slope budget "only where confidence says so", and the app must
 * never show a confident read from bad data. The value is ordinal — server
 * calibration confidence is an agreement statistic, not a probability.
 */
export const MIN_READ_CONFIDENCE = 0.5;

/** Interior sample count along the ball→hole line for the closed-form slope%. */
export const TOUR_READ_CROSS_SAMPLES = 9;

/** What the planner needs to hand over when the putt tool arms on a hole. */
export interface PuttContext {
    courseId: string;
    /** The green COURSE FEATURE id — keys the DEM sample-grid fetch. */
    greenFeatureId: string;
    /** The green feature geometry (EPSG:3006 bezier rings) — drives the reused
     *  Green-analysis overlay's boundary outline. */
    geometry: FeatureGeometry;
    /** The furniture green ROW id — keys calibration confidence. Null = none. */
    greenId: string | null;
    /** Default hole position: the active pin if any, else green centre (EPSG:3006). */
    defaultHole: Vec2;
}

/** One settled read: the exact integrator + the closed-form cross-check. */
export interface PuttReadResult {
    read: PuttRead;
    /** Closed-form Tour Read from the SAME surface (doc §5.1), or null when
     *  the surface can't provide its inputs (off coverage). */
    tour: TourRead | null;
    /** Metric verbal form of `tour` ("aim 35 cm …", plays-like). */
    verbal: TourReadVerbal | null;
    /** Ground truth for the training quiz (null when off coverage). */
    groundTruth: PuttGroundTruth | null;
}

export type PuttReadStatus =
    | 'inactive'     // putt mode not armed
    | 'loading'      // grid fetch in flight
    | 'no-surface'   // fetch failed / no grid — nothing to read from
    | 'place'        // surface ready, ball and/or hole not placed yet
    | 'pending'      // inputs changed (drag in progress) — read not settled
    | 'unavailable'  // ball or hole off the green's surface — read WITHHELD
    | 'soft'         // read shown but SOFTENED (degraded path / low confidence)
    | 'ok';

/** The panel's single view-model — B2's estimate-before-reveal gate wraps THIS. */
export interface PuttReadDisplay {
    status: PuttReadStatus;
    /** Human warning/guidance line, or null (withhold reason, softening, can't-stop). */
    message: string | null;
    /** Exact read — null whenever the status withholds it. */
    read: PuttRead | null;
    tour: TourRead | null;
    verbal: TourReadVerbal | null;
    /** Ground truth for the training quiz — non-null exactly when `read` is. */
    groundTruth: PuttGroundTruth | null;
    /** The green's calibration confidence row, or null (uncalibrated). */
    confidence: GreenConfidence | null;
}

const MSG_PLACE_BALL = 'Tap the green to place the ball (the origin).';
const MSG_PLACE_HOLE = 'Now tap to place the hole (the target) — or use “At pin”.';
const MSG_UNAVAILABLE = "No read — ball or hole is off the green's surface data.";
const MSG_DEGRADED = 'Ball path leaves surface coverage — partial, low-confidence read.';
const MSG_LOW_CONFIDENCE = 'Low-confidence surface for this green — treat as a rough read.';
const MSG_CANT_STOP = "Can't stop this one — lag to the low side.";
const MSG_NO_SURFACE = 'No surface data for this green.';

/**
 * Closed-form Tour Read inputs derived from the SAME GreenSurface the
 * integrator reads (doc §5.1 — the verbal read is a sanity cross-check, so it
 * must see the same ground truth, not an independent estimate):
 *
 *  - distance D: planar ball→hole length from the marker geometry;
 *  - Δh (grade): surface height at hole minus height at ball (signed,
 *    positive = uphill);
 *  - cross-slope %: the surface gradient sampled at TOUR_READ_CROSS_SAMPLES
 *    evenly-spaced interior points of the straight ball→hole segment. At each
 *    point the DOWNHILL vector (−∇h) is projected onto the line's right unit
 *    vector (alongY, −alongX); the signed projections are averaged. slopePct
 *    is |mean| × 100 and the sign gives the break direction (downhill to the
 *    right ⇒ the ball breaks right). Averaging the signed projection lets
 *    opposing tilts on a double-breaker cancel toward "straight" — exactly the
 *    single-plane assumption the closed form encodes, so a large disagreement
 *    with the integrator flags a non-planar green (doc §5.1).
 *
 * Returns null when ball/hole are off coverage (no honest inputs exist).
 * Off-coverage MID-LINE samples are skipped: the closed form degrades to the
 * samples it has, mirroring how a human read paces past a fringe corner.
 */
export function deriveTourRead(
    surface: GreenSurface,
    ball: Vec2,
    hole: Vec2,
    stimpFt: number,
): TourRead | null {
    const gt = deriveTourReadGroundTruth(surface, ball, hole);
    if (gt === null) return null;
    return tourRead(gt.distanceM, gt.gradeDeltaM, gt.slopePct, stimpFt, gt.breakToRight);
}

/**
 * The raw surface-derived inputs behind {@link deriveTourRead} — B2's training
 * quiz scores the player's estimate against THESE (the same ground truth the
 * read used), so it needs the slope% and break side that `tourRead` swallows
 * as inputs. `deriveTourRead` is now a thin wrapper over this. Returns null on
 * the same off-coverage condition. Pure; Swift-mirrorable with the read math.
 */
export function deriveTourReadGroundTruth(
    surface: GreenSurface,
    ball: Vec2,
    hole: Vec2,
): { distanceM: number; gradeDeltaM: number; slopePct: number; breakToRight: boolean } | null {
    const dx = hole.x - ball.x;
    const dy = hole.y - ball.y;
    const distanceM = Math.hypot(dx, dy);
    if (distanceM < 1e-9) return null;
    const ballSample = surface.sampleAt(ball);
    const holeSample = surface.sampleAt(hole);
    if (ballSample === null || holeSample === null) return null;

    const alongX = dx / distanceM;
    const alongY = dy / distanceM;
    // Right-hand unit vector looking from ball to hole (x east, y north).
    const rightX = alongY;
    const rightY = -alongX;

    let sum = 0;
    let count = 0;
    for (let i = 0; i < TOUR_READ_CROSS_SAMPLES; i++) {
        const t = (i + 0.5) / TOUR_READ_CROSS_SAMPLES;
        const s = surface.sampleAt({ x: ball.x + dx * t, y: ball.y + dy * t });
        if (s === null) continue;
        // Downhill (−∇h) projected on the right unit vector: + = falls right.
        sum += -(s.gradX * rightX + s.gradY * rightY);
        count++;
    }
    const meanCross = count > 0 ? sum / count : 0;
    const slopePct = Math.abs(meanCross) * 100;
    const breakToRight = meanCross > 0;
    const gradeDeltaM = holeSample.height - ballSample.height;

    return { distanceM, gradeDeltaM, slopePct, breakToRight };
}

/**
 * Putt-read state for the planner's green view (feature-putting-green-reading
 * §5.1, Phase B) — pure state + fetch, NO map/maplibre imports so it tests
 * under bun like the other planner services. PlannerToolService drives it
 * (mode arming, marker placement/drags); PlannerPanelComponent renders
 * `display`. DI singleton.
 *
 * Compute cadence (the readPutt integrator sweeps hundreds of trajectories —
 * NEVER per pointermove):
 *  - `ball`/`hole` are LIVE signals — drag frames write them so the markers
 *    and the straight reference line follow the cursor for free;
 *  - the read itself recomputes only via `scheduleRead()` (place, release,
 *    stimp change, data arrival), coalesced onto a microtask exactly like
 *    the planner's `refreshStrategy`, so an eager @basics/core signal burst
 *    collapses into ONE integration over the SETTLED inputs;
 *  - `read` surfaces the stored result only while its input signature still
 *    matches the live signals — mid-drag the signature diverges and the read
 *    (path, aim, numbers) falls away rather than going stale, the same guard
 *    as `overlayPlan`.
 *
 * B2 seam (training quiz): everything the panel renders flows through the
 * single `display` computed. The quiz inserts an "estimate before reveal"
 * gate by holding its own state and swapping what the panel section shows —
 * no changes needed here beyond reading the same `display`.
 */
export class PuttReadService {
    /** Active putt context (null = putt mode not armed). */
    readonly context = new Signal<PuttContext | null>(null);

    /** LIVE ball/hole positions, EPSG:3006 meters. Null = not placed. */
    readonly ball = new Signal<Vec2 | null>(null);
    readonly hole = new Signal<Vec2 | null>(null);

    /**
     * Which point the next tap on the green places. Starts at 'ball' and
     * auto-advances to 'hole' after the ball is placed, so a fresh read is
     * set origin-then-target with two taps. The panel exposes it as a
     * "Tap places: Ball | Hole" selector so either point can be re-placed by
     * tapping (dragging a marker still works too).
     */
    readonly placing = new Signal<'ball' | 'hole'>('ball');

    /** Green speed input (panel field; follows the wind-input pattern). */
    readonly stimpFt = new Signal(DEFAULT_STIMP_FT);

    /** Which analysis overlay the green view shows (reused Slope/Height map). */
    readonly overlayMode = new Signal<PuttOverlayMode>(loadOverlayMode());

    /** The green's DEM sample grid (drives the surface + fall-line arrows). */
    readonly grid = new Signal<SampleGrid | null>(null);
    readonly loading = new Signal(false);
    readonly error = new Signal<RequestError | null>(null);

    /** All calibration-confidence rows for the loaded course. */
    private readonly calibrations = new Signal<GreenConfidence[]>([]);
    private confidenceCourseId: string | null = null;

    private loadedFeatureId: string | null = null;
    private fetchSeq = 0;
    /** Bumped whenever `grid` is replaced — the read signature's grid key. */
    private readonly gridSeq = new Signal(0);
    private surfaceCache: { grid: SampleGrid; confidence: number; surface: GreenSurface } | null = null;
    private readScheduled = false;

    /** The last SETTLED read, tagged with the input signature it came from. */
    private readonly result = new Signal<{ sig: string; value: PuttReadResult } | null>(null);

    constructor(
        private analysisApi: AnalysisApi = createAnalysisClient('/api'),
        private calibrationApi: GreenCalibrationApi = createGreenCalibrationClient('/api'),
    ) {}

    /** Calibration confidence for the active green, or null (uncalibrated). */
    readonly greenConfidence = new Computed<GreenConfidence | null>(() => {
        const ctx = this.context.get();
        if (!ctx || ctx.greenId === null) return null;
        return this.calibrations.get().find(c => c.greenId === ctx.greenId) ?? null;
    });

    /**
     * Per-sample confidence fed into the DEM surface: the green's calibration
     * confidence when known (ordinal — display/soften only, never sharpen),
     * else the conservative DEM default.
     */
    readonly surfaceConfidence = new Computed<number>(() =>
        this.greenConfidence.get()?.confidence ?? DEM_DEFAULT_CONFIDENCE);

    /** Signature of everything a settled read depends on (see class header). */
    private readonly inputsSig = new Computed<string>(() => {
        const b = this.ball.get();
        const h = this.hole.get();
        return `${this.gridSeq.get()}|${b ? `${b.x},${b.y}` : ''}|${h ? `${h.x},${h.y}` : ''}`
            + `|${this.stimpFt.get()}|${this.surfaceConfidence.get()}`;
    });

    /**
     * A handful of cross-slope readings along the ball→hole line — the "side
     * slope" that makes the ball break. Signed % (+ = ground falls to the
     * RIGHT of the line). Live (tracks the markers), cheap (a few samples).
     */
    readonly pathSlopeSamples = new Computed<{ point: Vec2; crossSlopePct: number }[]>(() => {
        const grid = this.grid.get();
        const ball = this.ball.get();
        const hole = this.hole.get();
        if (!grid || !ball || !hole) return [];
        const surface = this.surfaceFor(grid, this.surfaceConfidence.get());
        const dx = hole.x - ball.x;
        const dy = hole.y - ball.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return [];
        // Right-hand unit vector, looking ball → hole (x east, y north).
        const rx = dy / len;
        const ry = -dx / len;
        const out: { point: Vec2; crossSlopePct: number }[] = [];
        for (let i = 1; i <= PATH_SLOPE_SAMPLES; i++) {
            const t = i / (PATH_SLOPE_SAMPLES + 1); // interior stations
            const point = { x: ball.x + dx * t, y: ball.y + dy * t };
            const s = surface.sampleAt(point);
            if (s === null) continue;
            // Downhill = −∇h; its component toward the line's right side.
            const cross = -(s.gradX * rx + s.gradY * ry);
            out.push({ point, crossSlopePct: cross * 100 });
        }
        return out;
    });

    /** The settled read, or null while inputs have moved past it (mid-drag). */
    readonly read = new Computed<PuttReadResult | null>(() => {
        const r = this.result.get();
        return r && r.sig === this.inputsSig.get() ? r.value : null;
    });

    /** The panel's view-model — availability honoured here (never show a
     *  confident read from bad data). */
    readonly display = new Computed<PuttReadDisplay>(() => {
        const confidence = this.greenConfidence.get();
        const empty = { read: null, tour: null, verbal: null, groundTruth: null, confidence };
        if (this.context.get() === null) {
            return { status: 'inactive', message: null, ...empty };
        }
        if (this.loading.get()) return { status: 'loading', message: null, ...empty };
        if (this.error.get() !== null || this.grid.get() === null) {
            return { status: 'no-surface', message: MSG_NO_SURFACE, ...empty };
        }
        if (this.ball.get() === null || this.hole.get() === null) {
            const message = this.ball.get() === null ? MSG_PLACE_BALL : MSG_PLACE_HOLE;
            return { status: 'place', message, ...empty };
        }
        const settled = this.read.get();
        if (settled === null) return { status: 'pending', message: null, ...empty };

        const { read, tour, verbal, groundTruth } = settled;
        if (read.availability === 'unavailable') {
            // WITHHELD — off-green markers get no numbers at all.
            return { status: 'unavailable', message: MSG_UNAVAILABLE, ...empty };
        }
        let status: PuttReadStatus = 'ok';
        let message: string | null = null;
        if (read.availability === 'degraded') {
            status = 'soft';
            message = MSG_DEGRADED;
        } else if (read.minConfidence < MIN_READ_CONFIDENCE) {
            status = 'soft';
            message = MSG_LOW_CONFIDENCE;
        }
        if (!read.canStop) message = message ? `${MSG_CANT_STOP} ${message}` : MSG_CANT_STOP;
        return { status, message, read, tour, verbal, groundTruth, confidence };
    });

    // ── Lifecycle (driven by PlannerToolService) ──────────────────────────

    /**
     * Arm the read for a green. Idempotent per green feature: re-activating
     * the same green (data reloads, pin churn) keeps the cached grid and the
     * user's markers; a NEW green resets the markers (hole → default) and
     * fetches its grid + the course calibration confidence.
     */
    async activate(ctx: PuttContext): Promise<void> {
        this.context.set(ctx);
        if (this.loadedFeatureId === ctx.greenFeatureId) {
            // Same green re-armed (data reload / pin churn): keep the user's
            // markers and placement progress exactly as they left them.
            return;
        }
        this.loadedFeatureId = ctx.greenFeatureId;
        // Both points are user-placed (tap the ball, then the hole). We no
        // longer auto-drop the hole at the pin — that read as a "random"
        // second point. "At pin" is offered as an explicit convenience.
        this.ball.set(null);
        this.hole.set(null);
        this.placing.set('ball');
        this.grid.set(null);
        this.gridSeq.set(this.gridSeq.peek() + 1);

        const seq = ++this.fetchSeq;
        const [grid] = await Promise.all([
            request(this.loading, this.error, () =>
                this.analysisApi.sampleGrid({
                    courseId: ctx.courseId,
                    featureId: ctx.greenFeatureId,
                    bufferM: PUTT_GRID_BUFFER_M,
                    resolutionM: PUTT_RESOLUTION_M,
                })),
            this.loadConfidence(ctx.courseId),
        ]);
        if (seq !== this.fetchSeq) return; // superseded / deactivated-and-rearmed
        if (grid) {
            this.grid.set(grid);
            this.gridSeq.set(this.gridSeq.peek() + 1);
            this.scheduleRead();
        }
    }

    /** Disarm (leaving putt mode). Grid/markers stay cached for a re-arm. */
    deactivate(): void {
        if (this.context.peek() !== null) this.context.set(null);
    }

    // ── Marker placement / drag (compute cadence — see class header) ──────

    /**
     * A tap on the green — places whichever point `placing` selects, then
     * auto-advances ball → hole on the first pass (so two taps set origin
     * then target). A settled edit; recomputes the read.
     */
    placeNext(p: Vec2): void {
        if (this.placing.peek() === 'ball') {
            this.ball.set(p);
            // Advance to the hole only on the first pass — once both are down,
            // the selector stays where the user put it.
            if (this.hole.peek() === null) this.placing.set('hole');
        } else {
            this.hole.set(p);
        }
        this.scheduleRead();
    }

    /** Panel selector — choose which point the next tap places. */
    setPlacing(which: 'ball' | 'hole'): void {
        this.placing.set(which);
    }

    /** Snap the hole to the active pin / green centre (explicit convenience). */
    placeHoleAtPin(): void {
        const ctx = this.context.peek();
        if (ctx === null) return;
        this.hole.set(ctx.defaultHole);
        if (this.placing.peek() === 'hole' && this.ball.peek() === null) {
            this.placing.set('ball');
        }
        this.scheduleRead();
    }

    /** Place (or re-place) the ball — a settled edit, recomputes the read. */
    placeBall(p: Vec2): void {
        this.ball.set(p);
        this.scheduleRead();
    }

    /** Place the hole — a settled edit, recomputes the read. */
    placeHole(p: Vec2): void {
        this.hole.set(p);
        this.scheduleRead();
    }

    /** Per-frame drag update — LIVE marker only, NO read recompute. */
    dragBall(p: Vec2): void {
        this.ball.set(p);
    }

    /** Per-frame drag update — LIVE marker only, NO read recompute. */
    dragHole(p: Vec2): void {
        this.hole.set(p);
    }

    /** Drag released — positions settled, recompute the read once. */
    commit(): void {
        this.scheduleRead();
    }

    /** Overlay-mode toggle (panel) — persisted. Pure display; no read change. */
    setOverlayMode(mode: PuttOverlayMode): void {
        if (this.overlayMode.peek() === mode) return;
        this.overlayMode.set(mode);
        try {
            localStorage.setItem(OVERLAY_MODE_KEY, mode);
        } catch {
            // Non-persistent (private mode) — the in-memory signal still drives it.
        }
    }

    /** Stimp changed (panel input). Clamped; recomputes the read. */
    setStimp(stimpFt: number): void {
        const clamped = Math.min(STIMP_MAX_FT, Math.max(STIMP_MIN_FT, stimpFt));
        if (this.stimpFt.peek() === clamped) return;
        this.stimpFt.set(clamped);
        this.scheduleRead();
    }

    // ── Internals ─────────────────────────────────────────────────────────

    private async loadConfidence(courseId: string): Promise<void> {
        if (this.confidenceCourseId === courseId) return;
        this.confidenceCourseId = courseId;
        try {
            const res = await this.calibrationApi.courseConfidence({ courseId });
            this.calibrations.set(res.greens);
        } catch {
            // Soft-fail: confidence is display/softening data — the read still
            // runs on the conservative DEM default.
            this.confidenceCourseId = null;
        }
    }

    private surfaceFor(grid: SampleGrid, confidence: number): GreenSurface {
        if (
            !this.surfaceCache ||
            this.surfaceCache.grid !== grid ||
            this.surfaceCache.confidence !== confidence
        ) {
            this.surfaceCache = { grid, confidence, surface: demSurface(grid, { confidence }) };
        }
        return this.surfaceCache.surface;
    }

    /**
     * Recompute the read over the SETTLED inputs, coalesced onto a microtask
     * (the planner's `refreshStrategy` pattern) — a burst of eager signal
     * updates collapses into one integrator run, and the per-frame drag path
     * never gets here at all.
     */
    private scheduleRead(): void {
        if (this.readScheduled) return;
        this.readScheduled = true;
        queueMicrotask(() => {
            this.readScheduled = false;
            const grid = this.grid.peek();
            const ball = this.ball.peek();
            const hole = this.hole.peek();
            if (!grid || !ball || !hole || this.context.peek() === null) {
                this.result.set(null);
                return;
            }
            const stimpFt = this.stimpFt.peek();
            const surface = this.surfaceFor(grid, this.surfaceConfidence.peek());
            const read = readPutt(surface, ball, hole, stimpFt);
            const unavailable = read.availability === 'unavailable';
            const derived = unavailable ? null : deriveTourReadGroundTruth(surface, ball, hole);
            const tour = derived
                ? tourRead(derived.distanceM, derived.gradeDeltaM, derived.slopePct, stimpFt, derived.breakToRight)
                : null;
            const verbal = tour ? formatTourRead(tour, 'metric') : null;
            // Ground truth for the quiz: slope% + side from the derivation, aim +
            // pace from the integrator (the numbers the app would show).
            const groundTruth: PuttGroundTruth | null = derived === null ? null : {
                slopePct: derived.slopePct,
                breakSide: tour!.breakSide,
                aimOffsetM: read.aimOffsetM,
                playsLikeM: read.playsLikeM,
            };
            this.result.set({ sig: this.inputsSig.peek(), value: { read, tour, verbal, groundTruth } });
        });
    }
}
