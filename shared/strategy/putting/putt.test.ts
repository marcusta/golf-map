// Golden-putt suite for the exact-tier integrator (doc §7 Phase A):
// flat, single-plane cross-slope at 3 stimps, uphill/downhill pace and
// break ordering, double-breaker, can't-stop downhill, determinism, and
// off-coverage degradation. The tunable constants in putt.ts are NOT yet
// empirically calibrated (doc §9 Q2), so these tests assert structure,
// ordering and generous tolerances — never exact real-world break values.

import { describe, expect, test } from 'bun:test';
import { type Vec2 } from '../ellipse';
import { type GreenSurface, planeSurface } from './green-surface';
import { readPutt } from './putt';
import { stimpToFriction, stimpToPlaysLikeFriction } from './tour-read';

const BALL: Vec2 = { x: 0, y: 0 };
const HOLE_10M: Vec2 = { x: 0, y: 10 }; // straight putt due north

/** Smooth analytic double-breaker: h = a·x·(y − midY). Cross-slope along
 *  the x=0 line is a·(y − midY) — one way before midY, the other after. */
const doubleBreaker = (a: number, midY: number): GreenSurface => ({
    sampleAt(p: Vec2) {
        return {
            height: a * p.x * (p.y - midY),
            gradX: a * (p.y - midY),
            gradY: a * p.x,
            confidence: 1,
        };
    },
});

/** Coverage mask: inner surface, but null where the predicate says so. */
const masked = (inner: GreenSurface, covered: (p: Vec2) => boolean): GreenSurface => ({
    sampleAt(p: Vec2) {
        return covered(p) ? inner.sampleAt(p) : null;
    },
});

describe('flat putt', () => {
    const flat = planeSurface({ slopePct: 0, fallLineBearingDeg: 0 });
    const read = readPutt(flat, BALL, HOLE_10M, 10);

    test('is available, holed, and can stop', () => {
        expect(read.availability).toBe('ok');
        expect(read.holed).toBe(true);
        expect(read.canStop).toBe(true);
        expect(read.minConfidence).toBe(1);
        expect(read.holedProb).toBeGreaterThan(0);
    });

    test('zero break: straight aim, straight path', () => {
        expect(Math.abs(read.aimOffsetM)).toBeLessThan(0.02);
        for (const p of read.path) {
            expect(Math.abs(p.x)).toBeLessThan(0.02);
        }
    });

    test('plays like ≈ D plus the finish window', () => {
        // Rollout = 10 m to the hole + preferred 0.30–0.45 m past (§3.5).
        expect(read.playsLikeM).toBeGreaterThan(10.05);
        expect(read.playsLikeM).toBeLessThan(11.0);
        expect(read.restBeyondHoleM!).toBeGreaterThan(0.2);
        expect(read.restBeyondHoleM!).toBeLessThan(0.6);
    });

    test('plays-like is the flat-equivalent of the chosen speed, surcharge calibrated', () => {
        const mu = stimpToFriction(10);
        const flatEquivalent = (read.initialSpeedMps * read.initialSpeedMps) / (2 * 9.81 * mu);
        const expected = 10 + (flatEquivalent - 10) * (mu / stimpToPlaysLikeFriction(10));
        expect(read.playsLikeM).toBeCloseTo(expected, 9);
    });

    test('path ends at the hole when holed', () => {
        const last = read.path[read.path.length - 1];
        expect(Math.hypot(last.x - HOLE_10M.x, last.y - HOLE_10M.y)).toBeLessThan(0.01);
    });
});

describe('single-plane cross-slope (2% downhill east, putt north)', () => {
    // Ball drifts east (+x), so the aim must be WEST of the hole: negative
    // aimOffsetM (positive = right = east for a northbound putt).
    const surface = planeSurface({ slopePct: 2, fallLineBearingDeg: 90 });
    const offsets = [8, 10, 12].map(
        (stimp) => readPutt(surface, BALL, HOLE_10M, stimp).aimOffsetM,
    );
    const [off8, off10, off12] = offsets;

    test('break direction is the uphill side at every stimp', () => {
        for (const off of offsets) {
            expect(off).toBeLessThan(-0.05);
        }
    });

    test('break magnitude increases with stimp', () => {
        expect(Math.abs(off10)).toBeGreaterThan(Math.abs(off8));
        expect(Math.abs(off12)).toBeGreaterThan(Math.abs(off10));
    });

    test('stimp scaling is roughly linear (§3.2 shape, loose bounds)', () => {
        // First order aim ∝ stimp: 12/8 = 1.5. Integrator + capture model
        // bend it; accept a generous band around linear.
        const ratio = Math.abs(off12) / Math.abs(off8);
        expect(ratio).toBeGreaterThan(1.1);
        expect(ratio).toBeLessThan(2.5);
    });

    test('path bows to the aim side and returns to the hole', () => {
        const read = readPutt(surface, BALL, HOLE_10M, 10);
        expect(read.availability).toBe('ok');
        const minX = Math.min(...read.path.map((p) => p.x));
        expect(minX).toBeLessThan(-0.05); // swings west of the ball–hole line
        const last = read.path[read.path.length - 1];
        expect(Math.abs(last.x)).toBeLessThan(0.25); // finishes near the line
    });
});

describe('uphill / downhill along the line (§3.3, §3.4)', () => {
    const D = 10;
    const stimp = 10;
    const muPlay = 0.88 / stimp;

    test('uphill plays-like matches D + Δh/μ_play within tolerance', () => {
        // 2% up along the whole line: Δh = +0.2 m → +2.27 m calibrated (§3.4).
        const up = planeSurface({ slopePct: 2, fallLineBearingDeg: 180 });
        const read = readPutt(up, BALL, HOLE_10M, stimp);
        const expected = D + (0.02 * D) / muPlay; // 12.27
        expect(read.canStop).toBe(true);
        expect(read.playsLikeM).toBeGreaterThan(expected - 0.2);
        expect(read.playsLikeM).toBeLessThan(expected + 1.2); // + finish window
    });

    test('downhill plays-like matches D − Δh/μ_play within tolerance', () => {
        const down = planeSurface({ slopePct: 2, fallLineBearingDeg: 0 });
        const read = readPutt(down, BALL, HOLE_10M, stimp);
        const expected = D - (0.02 * D) / muPlay; // 7.73
        expect(read.canStop).toBe(true);
        expect(read.playsLikeM).toBeGreaterThan(expected - 0.2);
        expect(read.playsLikeM).toBeLessThan(expected + 1.2);
    });

    test('same cross-slope breaks MORE downhill than uphill (§3.3 ordering)', () => {
        // Fall line 45° = downhill putt, 135° = uphill putt; both leave the
        // same eastward cross-slope component on a northbound line.
        const downhill = planeSurface({ slopePct: 2, fallLineBearingDeg: 45 });
        const uphill = planeSurface({ slopePct: 2, fallLineBearingDeg: 135 });
        const offDown = readPutt(downhill, BALL, HOLE_10M, stimp).aimOffsetM;
        const offUp = readPutt(uphill, BALL, HOLE_10M, stimp).aimOffsetM;
        expect(offDown).toBeLessThan(0); // both aim west (uphill side)
        expect(offUp).toBeLessThan(0);
        expect(Math.abs(offDown)).toBeGreaterThan(Math.abs(offUp) * 1.2);
    });
});

describe('double-breaker', () => {
    // 2% cross-slope east at the ball flipping to 2% west at the hole.
    const D = 10;
    const surface = doubleBreaker(0.004, D / 2);
    const read = readPutt(surface, BALL, { x: 0, y: D }, 10);

    test('path curves one way then the other', () => {
        expect(read.availability).toBe('ok');
        const path = read.path;
        expect(path.length).toBeGreaterThan(8);
        // Signed turning (cross product of consecutive segments): eastward
        // push = clockwise = negative in the first half, positive after.
        let firstHalf = 0;
        let secondHalf = 0;
        for (let i = 0; i + 2 < path.length; i++) {
            const ax = path[i + 1].x - path[i].x;
            const ay = path[i + 1].y - path[i].y;
            const bx = path[i + 2].x - path[i + 1].x;
            const by = path[i + 2].y - path[i + 1].y;
            const cross = ax * by - ay * bx;
            if (path[i + 1].y < D / 2) firstHalf += cross;
            else secondHalf += cross;
        }
        expect(firstHalf).toBeLessThan(0);
        expect(secondHalf).toBeGreaterThan(0);
    });

    test('still finishes at the hole', () => {
        const last = read.path[read.path.length - 1];
        expect(Math.hypot(last.x, last.y - D)).toBeLessThan(0.5);
    });
});

describe("can't-stop downhill (§3.4 degenerate case)", () => {
    test('slope steeper than μ downhill → canStop false, no rest point', () => {
        // 6% downhill at stimp 12 (μ ≈ 0.047): Δh/μ < −D and the ball
        // cannot rest anywhere on the plane.
        const chute = planeSurface({ slopePct: 6, fallLineBearingDeg: 0 });
        const read = readPutt(chute, BALL, HOLE_10M, 12);
        expect(read.availability).toBe('ok');
        expect(read.canStop).toBe(false);
        expect(read.stopPoint).toBeNull();
        expect(read.restBeyondHoleM).toBeNull();
    });

    test('gentle downhill is still stoppable', () => {
        const down = planeSurface({ slopePct: 2, fallLineBearingDeg: 0 });
        expect(readPutt(down, BALL, HOLE_10M, 10).canStop).toBe(true);
    });
});

describe('determinism', () => {
    test('same inputs twice → identical read', () => {
        const surface = planeSurface({ slopePct: 2.5, fallLineBearingDeg: 70 });
        const a = readPutt(surface, { x: 3, y: -2 }, { x: -1, y: 9 }, 11);
        const b = readPutt(surface, { x: 3, y: -2 }, { x: -1, y: 9 }, 11);
        expect(b).toEqual(a);
    });
});

describe('coverage degradation', () => {
    const flat = planeSurface({ slopePct: 0, fallLineBearingDeg: 0 });

    test('hole off coverage → unavailable, empty path', () => {
        const nearBallOnly = masked(flat, (p) => Math.hypot(p.x, p.y) < 3);
        const read = readPutt(nearBallOnly, BALL, HOLE_10M, 10);
        expect(read.availability).toBe('unavailable');
        expect(read.path).toEqual([]);
        expect(read.holedProb).toBe(0);
        expect(read.minConfidence).toBe(0);
    });

    test('coverage gap mid-line → degraded, confidence 0', () => {
        // Ball and hole covered, but a scanned-corridor gap at 4 < y < 6:
        // every trajectory exits coverage before the hole.
        const gapped = masked(flat, (p) => p.y <= 4 || p.y >= 6);
        const read = readPutt(gapped, BALL, HOLE_10M, 10);
        expect(read.availability).toBe('degraded');
        expect(read.minConfidence).toBe(0);
        expect(read.holed).toBe(false);
        // Path stops at the gap edge instead of pretending flat beyond it.
        const last = read.path[read.path.length - 1];
        expect(last.y).toBeLessThan(6);
    });

    test('surface confidence propagates to minConfidence', () => {
        const soft = planeSurface({ slopePct: 1, fallLineBearingDeg: 90, confidence: 0.7 });
        expect(readPutt(soft, BALL, HOLE_10M, 10).minConfidence).toBeCloseTo(0.7, 9);
    });
});
