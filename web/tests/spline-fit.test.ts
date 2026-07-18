import { describe, expect, test } from 'bun:test';
import { fitClosedBspline } from '../src/geo/spline-fit';
import { flattenRing, signedArea, type Point } from '../src/geo/bezier';

// T40 — least-squares closed-cubic-b-spline fitter. Fit quality is verified
// against an INDEPENDENTLY recomputed deviation: the fitted control ring is
// re-flattened here (finer tolerance than the fitter uses) and each stroke
// sample's point-to-segment distance to that polyline is taken fresh.

const TOL = 0.75;

// Realistic EPSG:3006 magnitudes (~5.4e5 E, ~6.4e6 N) so the tests also
// exercise the solver's conditioning/centering, not just the math.
const CX = 538_000;
const CY = 6_398_000;

/** Synthetic stroke from a polar radius function (open sequence, no closing dup). */
function polarStroke(
    r: (theta: number) => number,
    n: number,
    sweepDeg = 360,
    cx = CX,
    cy = CY,
): Point[] {
    const pts: Point[] = [];
    const sweep = (sweepDeg * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
        const t = (i / n) * sweep;
        pts.push({ x: cx + r(t) * Math.cos(t), y: cy + r(t) * Math.sin(t) });
    }
    return pts;
}

function circleStroke(radius: number, n: number): Point[] {
    return polarStroke(() => radius, n);
}

function ellipseStroke(a: number, b: number, n: number): Point[] {
    const pts: Point[] = [];
    for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI;
        pts.push({ x: CX + a * Math.cos(t), y: CY + b * Math.sin(t) });
    }
    return pts;
}

/** Kidney: a smooth dented blob, r(θ) = 12 + 4·cosθ − 3·cos2θ (min r = 5). */
function kidneyStroke(n: number): Point[] {
    return polarStroke(t => 12 + 4 * Math.cos(t) - 3 * Math.cos(2 * t), n);
}

/** Independent deviation recompute: fine flatten + point-to-segment scan. */
function recomputeMaxDeviation(stroke: Point[], controls: Point[]): number {
    const flat = flattenRing({ points: controls.map(p => ({ ...p })) }, 0.01, 'bspline');
    let worst = 0;
    for (const p of stroke) {
        let best = Infinity;
        for (let i = 0; i < flat.length; i++) {
            const [ax, ay] = flat[i];
            const [bx, by] = flat[(i + 1) % flat.length];
            const dx = bx - ax;
            const dy = by - ay;
            const len2 = dx * dx + dy * dy;
            let t = len2 === 0 ? 0 : ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy));
            if (d < best) best = d;
        }
        if (best > worst) worst = best;
    }
    return worst;
}

/** |Shoelace| area of a plain point ring. */
function strokeArea(stroke: Point[]): number {
    return Math.abs(signedArea(stroke.map(p => [p.x, p.y] as [number, number])));
}

/** |Area| of the fitted spline's flattened outline. */
function fittedArea(controls: Point[]): number {
    return Math.abs(signedArea(flattenRing({ points: controls.map(p => ({ ...p })) }, 0.05, 'bspline')));
}

function expectQualityFit(stroke: Point[], tolerance = TOL): ReturnType<typeof fitClosedBspline> {
    const fit = fitClosedBspline(stroke, tolerance);
    // Fit meets tolerance, per the fitter's own metric...
    expect(fit.maxDeviation).toBeLessThanOrEqual(tolerance);
    // ...AND per an independent recompute (fine flatten, fresh distance scan).
    const independent = recomputeMaxDeviation(stroke, fit.controls);
    expect(independent).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(independent - fit.maxDeviation)).toBeLessThanOrEqual(0.05);
    // Control-count contract.
    expect(fit.controls.length).toBeGreaterThanOrEqual(8);
    expect(fit.controls.length).toBeLessThanOrEqual(20);
    return fit;
}

describe('fitClosedBspline fit quality', () => {
    test('circle stroke fits within tolerance', () => {
        const stroke = circleStroke(15, 240);
        const fit = expectQualityFit(stroke);
        // A circle is easy: the adaptive ladder should not need to step up.
        expect(fit.controls.length).toBe(8);
        // Area sanity: fitted outline ≈ stroke outline (within 2%).
        const area = strokeArea(stroke);
        expect(Math.abs(fittedArea(fit.controls) - area) / area).toBeLessThan(0.02);
    });

    test('ellipse stroke (25 × 10 m) fits within tolerance', () => {
        expectQualityFit(ellipseStroke(25, 10, 300));
    });

    test('kidney stroke fits within tolerance', () => {
        expectQualityFit(kidneyStroke(300));
    });

    test('jittered circle stroke still fits (fit smooths hand shake)', () => {
        // Deterministic pseudo-noise, ±0.15 m radial.
        const stroke = polarStroke(
            t => 12 + 0.15 * Math.sin(t * 997.13 + 0.7), 200,
        );
        expectQualityFit(stroke);
    });

    test('a wavy shape steps the control count up past 8', () => {
        // Five 2.5 m lobes on a 14 m blob: 8 controls cannot track five
        // bumps, so the adaptive ladder must climb.
        const stroke = polarStroke(t => 14 + 2.5 * Math.cos(5 * t), 400);
        const fit = fitClosedBspline(stroke, TOL);
        expect(fit.controls.length).toBeGreaterThan(8);
        expect(fit.controls.length).toBeLessThanOrEqual(20);
        expect(fit.maxDeviation).toBeLessThanOrEqual(TOL);
        expect(recomputeMaxDeviation(stroke, fit.controls)).toBeLessThanOrEqual(TOL);
    });
});

describe('fitClosedBspline closed-ring correctness', () => {
    test('controls form a closed ring with no duplicate endpoint', () => {
        const fit = fitClosedBspline(circleStroke(10, 200), TOL);
        const first = fit.controls[0];
        const last = fit.controls[fit.controls.length - 1];
        expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(1);
    });

    test('flattened area matches the stroke area (kidney, within 3%)', () => {
        const stroke = kidneyStroke(300);
        const fit = fitClosedBspline(stroke, TOL);
        const area = strokeArea(stroke);
        expect(Math.abs(fittedArea(fit.controls) - area) / area).toBeLessThan(0.03);
    });

    test('an explicitly closed stroke (duplicate endpoint) fits identically', () => {
        const open = circleStroke(10, 120);
        const closed = [...open, { ...open[0] }];
        const a = fitClosedBspline(open, TOL);
        const b = fitClosedBspline(closed, TOL);
        expect(b.controls).toEqual(a.controls);
    });

    test('a partial trace (300° arc) closes itself and fits its samples', () => {
        const stroke = polarStroke(() => 12, 200, 300);
        const fit = fitClosedBspline(stroke, TOL);
        expect(fit.controls.length).toBeGreaterThanOrEqual(8);
        expect(fit.controls.length).toBeLessThanOrEqual(20);
        // Deviation is measured against the SAMPLES — the free closure
        // across the gap must not drag the fitted curve off them.
        expect(fit.maxDeviation).toBeLessThanOrEqual(TOL);
        expect(recomputeMaxDeviation(stroke, fit.controls)).toBeLessThanOrEqual(TOL);
    });
});

// T52 — optional maxControls cap: the default preserves T40's 8→12→16→20
// ladder exactly; import callers raise it with ring perimeter.
describe('fitClosedBspline maxControls cap (T52)', () => {
    test('omitted cap behaves byte-identically to an explicit 20', () => {
        for (const stroke of [kidneyStroke(300), polarStroke(t => 14 + 2.5 * Math.cos(5 * t), 400)]) {
            const implicit = fitClosedBspline(stroke, TOL);
            const explicit = fitClosedBspline(stroke, TOL, 20);
            expect(explicit.controls).toEqual(implicit.controls);
            expect(explicit.maxDeviation).toBe(implicit.maxDeviation);
        }
    });

    test('a raised cap converges where 20 controls cannot', () => {
        // Twelve 4 m lobes on a 30 m blob: under two controls per lobe.
        const stroke = polarStroke(t => 30 + 4 * Math.cos(12 * t), 720);
        const capped = fitClosedBspline(stroke, TOL);
        expect(capped.controls.length).toBeLessThanOrEqual(20);
        expect(capped.maxDeviation).toBeGreaterThan(TOL);
        const raised = fitClosedBspline(stroke, TOL, 64);
        expect(raised.controls.length).toBeGreaterThan(20);
        expect(raised.controls.length).toBeLessThanOrEqual(64);
        expect(raised.maxDeviation).toBeLessThanOrEqual(TOL);
        expect(recomputeMaxDeviation(stroke, raised.controls)).toBeLessThanOrEqual(TOL);
    });

    test('control count never exceeds the cap (even below 20)', () => {
        const stroke = polarStroke(t => 30 + 4 * Math.cos(12 * t), 720);
        expect(fitClosedBspline(stroke, TOL, 12).controls.length).toBeLessThanOrEqual(12);
    });
});

describe('fitClosedBspline degenerate strokes', () => {
    test('under 3 distinct points returns them as-is (caller discards)', () => {
        const fit = fitClosedBspline([{ x: CX, y: CY }, { x: CX + 1, y: CY }], TOL);
        expect(fit.controls.length).toBeLessThan(3);
        expect(fit.maxDeviation).toBe(0);
    });

    test('consecutive duplicates collapse before the distinct-point check', () => {
        const p = { x: CX, y: CY };
        const fit = fitClosedBspline([p, { ...p }, { ...p }, { x: CX + 2, y: CY }], TOL);
        expect(fit.controls.length).toBeLessThan(3);
    });

    test('empty stroke is safe', () => {
        const fit = fitClosedBspline([], TOL);
        expect(fit.controls).toEqual([]);
        expect(fit.maxDeviation).toBe(0);
    });
});
