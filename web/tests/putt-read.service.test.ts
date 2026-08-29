import { test, expect, afterEach } from 'bun:test';
import { _reset } from '@basics/core/client/error-report';
import type { SampleGrid } from '../../shared/api/analysis.gen';
import type { GreenConfidence } from '../../shared/api/green-calibration.gen';
import {
    PuttReadService,
    DEFAULT_STIMP_FT,
    MIN_READ_CONFIDENCE,
    deriveTourRead,
    type PuttContext,
} from '../src/planner/putt-read.service';
import { demSurface } from '../../shared/strategy';

// PuttReadService state flow against a stubbed global fetch — the real
// service, the real generated clients and apiFetch layers, only the network
// substituted (house rule: hand-stubbed fetch router, no mocking library).

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
    _reset();
});

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

/** Stub fetch by URL substring; records calls. Unknown URLs get a 200 {}. */
function stubFetch(routes: Record<string, (body: unknown) => Response>): {
    calls: Array<{ url: string; body: unknown }>;
} {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, body });
        for (const [fragment, respond] of Object.entries(routes)) {
            if (url.includes(fragment)) return respond(body);
        }
        return json(200, {});
    }) as typeof fetch;
    return { calls };
}

// ── Synthetic green ─────────────────────────────────────────────────────────

const ORIGIN = { e: 500000, n: 6468000 };

/**
 * A planar green tilted DOWNHILL TO THE EAST by `slopePct`, 40×40 cells at
 * 0.5 m (20×20 m), with a 2-cell OFF-GREEN border (insideMask 0) so placements
 * near the grid edge are off coverage. Interior spans ~1.25–18.75 m.
 */
function tiltedGrid(slopePct = 2): SampleGrid {
    const slope = slopePct / 100;
    const width = 40;
    const height = 40;
    const resolution = 0.5;
    const heights: number[] = [];
    const insideMask: number[] = [];
    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const e = (col + 0.5) * resolution;
            heights.push(50 - slope * e); // falls to the EAST
            const border = row < 2 || col < 2 || row >= height - 2 || col >= width - 2;
            insideMask.push(border ? 0 : 1);
        }
    }
    return { heights, insideMask, origin: ORIGIN, resolution, width, height };
}

/** A point `de` m east / `dn` m north of the grid's NW outer corner. */
const at = (de: number, dn: number) => ({ x: ORIGIN.e + de, y: ORIGIN.n - dn });

const CONFIDENT_SCANS: GreenConfidence = {
    greenId: 'green-row-1', confidence: 0.85, sampleCount: 12, source: 'scans',
};

function ctx(): PuttContext {
    return {
        courseId: 'course-1',
        greenFeatureId: 'feat-green-1',
        greenId: 'green-row-1',
        geometry: {
            crs: 'EPSG:3006',
            rings: [{ points: [at(2, 2), at(18, 2), at(18, 18), at(2, 18)] }],
        },
        // Default hole: mid-green, 6 m from the north edge.
        defaultHole: at(8, 6),
    };
}

function routes(grid: SampleGrid, confidence: GreenConfidence = CONFIDENT_SCANS) {
    return stubFetch({
        '/api/analysis/sample-grid': () => json(200, grid),
        '/api/green-calibration/confidence': () => json(200, { greens: [confidence] }),
    });
}

/** Flush the coalescing read microtask (and any trailing signal writes). */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

// ── Activation ──────────────────────────────────────────────────────────────

test('activate fetches the green grid + course confidence; no markers placed yet', async () => {
    const { calls } = routes(tiltedGrid());
    const svc = new PuttReadService();

    await svc.activate(ctx());

    const gridCall = calls.find(c => c.url.includes('/analysis/sample-grid'));
    expect(gridCall?.body).toMatchObject({ courseId: 'course-1', featureId: 'feat-green-1' });
    expect(calls.some(c => c.url.includes('/green-calibration/confidence?courseId=course-1'))).toBe(true);

    expect(svc.grid.get()).not.toBeNull();
    // Both points are user-placed now (the old auto-hole read as "random").
    expect(svc.ball.get()).toBeNull();
    expect(svc.hole.get()).toBeNull();
    expect(svc.placing.get()).toBe('ball'); // first tap places the ball
    expect(svc.stimpFt.get()).toBe(DEFAULT_STIMP_FT);
    expect(svc.greenConfidence.get()).toEqual(CONFIDENT_SCANS);

    // Nothing placed yet → placement guidance, no read, confidence still surfaced.
    const d = svc.display.get();
    expect(d.status).toBe('place');
    expect(d.message).toContain('ball');
    expect(d.read).toBeNull();
    expect(d.confidence?.source).toBe('scans');
});

test('placeNext is one-shot: ball → hole → disarmed (two taps)', async () => {
    routes(tiltedGrid(2));
    const svc = new PuttReadService();
    await svc.activate(ctx());

    // Tap 1 → ball; selector auto-advances to the hole (still unplaced).
    expect(svc.placeNext(at(8, 14))).toBe(true);
    expect(svc.ball.get()).toEqual(at(8, 14));
    expect(svc.hole.get()).toBeNull();
    expect(svc.placing.get()).toBe('hole');
    expect(svc.display.get().message).toContain('hole');

    // Tap 2 → hole; placement disarms; a settled read appears.
    expect(svc.placeNext(at(8, 6))).toBe(true);
    expect(svc.hole.get()).toEqual(at(8, 6));
    expect(svc.placing.get()).toBe('none');
    await settle();
    expect(svc.display.get().status).toBe('ok');

    // Disarmed taps place nothing (callers probe slope instead).
    expect(svc.placeNext(at(9, 9))).toBe(false);
    expect(svc.ball.get()).toEqual(at(8, 14));
    expect(svc.hole.get()).toEqual(at(8, 6));

    // Re-arming the ball is one-shot too — both markers down, so the
    // placement disarms instead of auto-advancing.
    svc.setPlacing('ball');
    expect(svc.placeNext(at(7, 14))).toBe(true);
    expect(svc.ball.get()).toEqual(at(7, 14));
    expect(svc.placing.get()).toBe('none');

    // "At pin" convenience snaps the hole to the context default.
    svc.placeHoleAtPin();
    expect(svc.hole.get()).toEqual(ctx().defaultHole);
});

test('re-activating the same green keeps the grid and markers (idempotent)', async () => {
    const { calls } = routes(tiltedGrid());
    const svc = new PuttReadService();
    await svc.activate(ctx());
    const grid = svc.grid.get();
    svc.placeBall(at(8, 14));
    svc.placeHole(at(8, 6));
    await settle();

    svc.deactivate();
    expect(svc.display.get().status).toBe('inactive');

    const fetches = calls.length;
    await svc.activate(ctx()); // hole churn / data reload re-arms the same green
    expect(calls.length).toBe(fetches); // no refetch
    expect(svc.grid.get()).toBe(grid);
    expect(svc.ball.get()).toEqual(at(8, 14)); // user's markers survived
    expect(svc.hole.get()).toEqual(at(8, 6));
    await settle();
    expect(svc.display.get().status).toBe('ok');
});

// ── Reads ───────────────────────────────────────────────────────────────────

test('placing ball and hole yields a settled read with the tour-read cross-check', async () => {
    routes(tiltedGrid(2));
    const svc = new PuttReadService();
    await svc.activate(ctx());
    svc.placeBall(at(8, 14)); // 8 m putt due NORTH, 2% cross-slope falling EAST
    svc.placeHole(at(8, 6));
    await settle();

    const result = svc.read.get();
    expect(result).not.toBeNull();
    const { read, tour, verbal } = result!;
    expect(read.availability).toBe('ok');
    expect(read.canStop).toBe(true);
    expect(read.playsLikeM).toBeGreaterThan(0);
    expect(read.path.length).toBeGreaterThan(2);
    // Ground falls to the RIGHT of the line → ball breaks right → aim LEFT:
    // negative signed offset in BOTH the integrator and the closed form.
    expect(read.aimOffsetM).toBeLessThan(0);
    expect(tour).not.toBeNull();
    expect(tour!.aimOffsetMeters).toBeLessThan(0);
    expect(tour!.playsLikeMeters).toBeCloseTo(8, 1); // level along the line
    expect(verbal!.combined).toContain('plays like');

    const d = svc.display.get();
    expect(d.status).toBe('ok');
    expect(d.read).toBe(read);
    expect(d.verbal).toBe(verbal);
});

test('a stimp change recomputes the read — faster green, more break', async () => {
    routes(tiltedGrid(2));
    const svc = new PuttReadService();
    await svc.activate(ctx());
    svc.placeBall(at(8, 14));
    svc.placeHole(at(8, 6));
    await settle();
    const slow = svc.read.get()!;

    svc.setStimp(13);
    // The old read no longer matches the live inputs — hidden immediately.
    expect(svc.read.get()).toBeNull();
    await settle();

    const fast = svc.read.get()!;
    expect(fast).not.toBe(slow);
    expect(Math.abs(fast.read.aimOffsetM)).toBeGreaterThan(Math.abs(slow.read.aimOffsetM));
});

test('off-green placement withholds the read (availability unavailable)', async () => {
    routes(tiltedGrid());
    const svc = new PuttReadService();
    await svc.activate(ctx());
    svc.placeHole(at(8, 6)); // hole on the green
    svc.placeBall(at(0.3, 10)); // in the masked border — off the green
    await settle();

    expect(svc.read.get()!.read.availability).toBe('unavailable');
    const d = svc.display.get();
    expect(d.status).toBe('unavailable');
    expect(d.read).toBeNull(); // withheld — never numbers from bad data
    expect(d.verbal).toBeNull();
    expect(d.message).toContain('off the green');
});

test('drag frames move the marker without recomputing; release commits once', async () => {
    routes(tiltedGrid());
    const svc = new PuttReadService();
    await svc.activate(ctx());
    svc.placeBall(at(8, 14));
    svc.placeHole(at(8, 6));
    await settle();
    expect(svc.read.get()).not.toBeNull();

    // Per-frame drag: LIVE marker moves, the settled read falls away (no
    // stale numbers), and nothing recomputes even across a macrotask.
    svc.dragBall(at(9, 13));
    svc.dragBall(at(10, 12));
    expect(svc.ball.get()).toEqual(at(10, 12));
    expect(svc.read.get()).toBeNull();
    expect(svc.display.get().status).toBe('pending');
    await settle();
    expect(svc.read.get()).toBeNull(); // still no read: drags don't schedule

    svc.commit(); // release
    await settle();
    const result = svc.read.get();
    expect(result).not.toBeNull();
    expect(result!.read.availability).toBe('ok');
});

// ── Softening / honesty (doc §4 precision budget, §5.1) ─────────────────────

test('a steep downhill putt surfaces the can\'t-stop message', async () => {
    routes(tiltedGrid(6)); // 6% > μ(stimp 10) ≈ 0.056 — the §3.4 degenerate case
    const svc = new PuttReadService();
    await svc.activate({ ...ctx(), defaultHole: at(14, 10) });
    svc.placeHole(at(14, 10));
    svc.placeBall(at(6, 10)); // 8 m putt straight DOWNHILL to the east
    await settle();

    const d = svc.display.get();
    expect(d.read).not.toBeNull();
    expect(d.read!.canStop).toBe(false);
    expect(d.message).toContain('lag to the low side');
    expect(d.verbal!.pace).toContain('lag to the low side');
});

test('low calibration confidence softens the read (prior, below the gate)', async () => {
    const lowPrior: GreenConfidence = {
        greenId: 'green-row-1', confidence: 0.3, sampleCount: 0, source: 'prior',
    };
    expect(lowPrior.confidence).toBeLessThan(MIN_READ_CONFIDENCE);
    routes(tiltedGrid(), lowPrior);
    const svc = new PuttReadService();
    await svc.activate(ctx());
    svc.placeBall(at(8, 14));
    svc.placeHole(at(8, 6));
    await settle();

    const d = svc.display.get();
    expect(d.status).toBe('soft');
    expect(d.message).toContain('Low-confidence');
    expect(d.read).not.toBeNull(); // softened, not withheld
    expect(d.read!.minConfidence).toBeCloseTo(0.3, 5);
    expect(d.confidence?.source).toBe('prior');
});

test('a failed confidence fetch falls back to the DEM default (read still runs)', async () => {
    stubFetch({
        '/api/analysis/sample-grid': () => json(200, tiltedGrid()),
        '/api/green-calibration/confidence': () => json(500, { error: 'boom' }),
    });
    const svc = new PuttReadService();
    await svc.activate(ctx());
    svc.placeBall(at(8, 14));
    svc.placeHole(at(8, 6));
    await settle();

    const d = svc.display.get();
    expect(d.confidence).toBeNull();
    expect(d.status).toBe('ok'); // DEM default 0.6 clears the soft gate
    expect(d.read!.minConfidence).toBeCloseTo(0.6, 5);
});

// ── Closed-form derivation (unit — the slope% comes from the same surface) ──

test('deriveTourRead reads distance, grade and cross-slope off the surface', () => {
    const surface = demSurface(tiltedGrid(2));
    // Putt due north: line grade 0, cross-slope = full 2% falling right.
    const north = deriveTourRead(surface, at(8, 14), at(8, 6), 10)!;
    expect(north.playsLikeMeters).toBeCloseTo(8, 2);
    expect(north.breakSide).toBe('right'); // breaks toward the right (east)
    expect(north.aimOffsetMeters).toBeLessThan(0); // → aim LEFT of the hole

    // Putt due east (straight downhill): no cross-slope, downhill grade.
    const east = deriveTourRead(surface, at(4, 10), at(12, 10), 10)!;
    expect(east.breakSide).toBe('straight');
    // §3.4 calibrated: plays-like = D + Δh/μ_play = 8 − 0.16/0.088 ≈ 6.2 m.
    expect(east.playsLikeMeters).toBeCloseTo(8 - 0.16 / (0.88 / 10), 0);

    // Off coverage → no honest inputs → null.
    expect(deriveTourRead(surface, at(0.3, 10), at(8, 6), 10)).toBeNull();
});
