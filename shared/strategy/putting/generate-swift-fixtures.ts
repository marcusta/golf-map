// Golden-fixture generator for the Swift mirror of shared/strategy/putting/
// (T17 pattern, putting slice — see ios/GolfMap/Strategy/Putting/).
//
// Run manually from this directory whenever the putting core changes:
//
//     bun generate-swift-fixtures.ts
//
// Writes ios/GolfMapTests/Strategy/Fixtures/putting-goldens.json, consumed
// by PuttingGoldenParityTests.swift. Deterministic: running twice yields
// identical bytes (no clocks, no randomness, stable key order, JSON
// shortest-round-trip number formatting — Swift's JSONDecoder parses those
// back to bit-identical Doubles).
//
// This is a SCRIPT, not a test — it is not picked up by `bun test`.
//
// Encoding notes:
//  - breakMultiplier can be +Infinity (§3.3 divergence); JSON has no
//    Infinity, so it is encoded as the string "Infinity".
//  - DEM grid nodata heights are JSON null (the TS DemGrid convention);
//    the Swift side maps null → NaN (the iOS SampleGrid convention).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Vec2 } from '../ellipse';
import { demSurface, type DemGrid, DEM_DEFAULT_CONFIDENCE } from './dem-surface';
import { planeSurface, type GreenSurface } from './green-surface';
import {
    captureRadiusM,
    HOLE_RADIUS_M,
    LIP_OUT_SPEED_MPS,
    readPutt,
    type PuttRead,
    type PuttReadOptions,
} from './putt';
import {
    breakMultiplier,
    FEET_TO_METERS,
    formatTourRead,
    FRICTION_CONSTANT,
    GRAVITY_MPS2,
    INCHES_TO_METERS,
    inchesToMeters,
    metersToPaces,
    PACE_METERS,
    playsLikeLength,
    STIMP_BREAK_SCALE_PER_FT,
    STIMP_RELEASE_V0_MPS,
    stimpBreakScale,
    stimpToFriction,
    TOUR_READ_REFERENCE_STIMP_FT,
    tourRead,
    tourReadAimInches,
    tourReadAimInchesAtReference,
} from './tour-read';

const OUT_PATH = join(
    import.meta.dir,
    '../../../ios/GolfMapTests/Strategy/Fixtures/putting-goldens.json',
);

/** JSON-safe number: +Infinity → "Infinity" (Swift decodes it back). */
function num(v: number): number | string {
    return Number.isFinite(v) ? v : v > 0 ? 'Infinity' : '-Infinity';
}

// ---------------------------------------------------------------------------
// Closed-form scalars — constants + every exported tour-read/putt function
// ---------------------------------------------------------------------------

const constants = {
    STIMP_RELEASE_V0_MPS,
    GRAVITY_MPS2,
    FEET_TO_METERS,
    FRICTION_CONSTANT,
    PACE_METERS,
    INCHES_TO_METERS,
    TOUR_READ_REFERENCE_STIMP_FT,
    STIMP_BREAK_SCALE_PER_FT,
    HOLE_RADIUS_M,
    LIP_OUT_SPEED_MPS,
    DEM_DEFAULT_CONFIDENCE,
};

const scalars = {
    stimpToFriction: [1, 8, 9, 10, 11, 12, 13].map((s) => ({ arg: s, out: stimpToFriction(s) })),
    metersToPaces: [1, 3.6576, 10, 12.5].map((m) => ({ arg: m, out: metersToPaces(m) })),
    inchesToMeters: [1, 14, 16.5].map((i) => ({ arg: i, out: inchesToMeters(i) })),
    stimpBreakScale: [0, 8, 9, 10, 11, 12, 13].map((s) => ({ arg: s, out: stimpBreakScale(s) })),
    tourReadAimInchesAtReference: [
        [4, 2],
        [6, 1.5],
        [0.25, 3],
        [0.5, 3],
        [12, 0.8],
    ].map(([paces, slopePct]) => ({
        paces,
        slopePct,
        out: tourReadAimInchesAtReference(paces, slopePct),
    })),
    tourReadAimInches: [
        [4, 2, 11],
        [4, 2, 9],
        [6, 1.5, 12],
        [10, 3, 8],
    ].map(([paces, slopePct, stimpFt]) => ({
        paces,
        slopePct,
        stimpFt,
        out: tourReadAimInches(paces, slopePct, stimpFt),
    })),
    breakMultiplier: [
        [stimpToFriction(10), -0.02],
        [stimpToFriction(10), 0.02],
        [stimpToFriction(10), 0],
        [stimpToFriction(10), -stimpToFriction(10)],
        [stimpToFriction(10), -0.1],
        [stimpToFriction(12), 0.035],
    ].map(([mu, grade]) => ({ mu, gradeFraction: grade, out: num(breakMultiplier(mu, grade)) })),
    playsLikeLength: [
        [10, 0.3, stimpToFriction(10)],
        [10, -0.2, stimpToFriction(10)],
        [10, -1, stimpToFriction(10)],
        [7.5, 0.12, stimpToFriction(11)],
    ].map(([d, dh, mu]) => {
        const r = playsLikeLength(d, dh, mu);
        return { distanceM: d, gradeDeltaM: dh, mu, playsLikeMeters: r.playsLikeMeters, canStop: r.canStop };
    }),
    captureRadiusM: [0, 0.25, 0.5, 1, 1.3, 1.31, 1.5].map((v) => ({
        arg: v,
        out: captureRadiusM(v),
    })),
};

// ---------------------------------------------------------------------------
// Assembled tourRead cases (incl. degenerates) + verbal formatter goldens
// ---------------------------------------------------------------------------

interface TourReadCaseInput {
    distanceM: number;
    gradeDeltaM: number;
    slopePct: number;
    stimpFt: number;
    breakToRight: boolean;
}

function tourReadCase(name: string, input: TourReadCaseInput) {
    const r = tourRead(
        input.distanceM,
        input.gradeDeltaM,
        input.slopePct,
        input.stimpFt,
        input.breakToRight,
    );
    return {
        name,
        input,
        read: {
            aimOffsetMeters: r.aimOffsetMeters,
            aimInches: r.aimInches,
            aimSide: r.aimSide,
            playsLikeMeters: r.playsLikeMeters,
            breakMultiplier: num(r.breakMultiplier),
            canStop: r.canStop,
        },
        verbal: {
            metric: formatTourRead(r, 'metric'),
            imperial: formatTourRead(r, 'imperial'),
        },
    };
}

const tourReadCases = [
    tourReadCase('break-right aims left', {
        distanceM: 10, gradeDeltaM: 0, slopePct: 2, stimpFt: 10, breakToRight: true,
    }),
    tourReadCase('break-left aims right', {
        distanceM: 10, gradeDeltaM: 0, slopePct: 2, stimpFt: 10, breakToRight: false,
    }),
    tourReadCase('flat cross-slope is straight', {
        distanceM: 10, gradeDeltaM: 0, slopePct: 0, stimpFt: 10, breakToRight: true,
    }),
    tourReadCase('doc example: 4 paces 2% at reference', {
        distanceM: 4 * PACE_METERS, gradeDeltaM: 0, slopePct: 2, stimpFt: 10, breakToRight: false,
    }),
    tourReadCase('uphill pace: plays like 15.4 m', {
        distanceM: 10, gradeDeltaM: 0.3, slopePct: 2, stimpFt: 10, breakToRight: true,
    }),
    tourReadCase("can't-stop downhill caps the aim", {
        distanceM: 10, gradeDeltaM: -1, slopePct: 2, stimpFt: 10, breakToRight: true,
    }),
    tourReadCase('sub-1-pace clamp → straight', {
        distanceM: 0.5 * PACE_METERS, gradeDeltaM: 0, slopePct: 3, stimpFt: 10, breakToRight: true,
    }),
    tourReadCase('fast green scales break up', {
        distanceM: 4 * PACE_METERS, gradeDeltaM: 0.1, slopePct: 2, stimpFt: 11, breakToRight: true,
    }),
    tourReadCase('slow green scales break down', {
        distanceM: 4 * PACE_METERS, gradeDeltaM: 0, slopePct: 2, stimpFt: 9, breakToRight: false,
    }),
    tourReadCase('gentle downhill keeps a finite multiplier', {
        distanceM: 12, gradeDeltaM: -0.15, slopePct: 1.5, stimpFt: 12, breakToRight: false,
    }),
    tourReadCase('imperial pace line rounding (10 m flat = 33 ft)', {
        distanceM: 10, gradeDeltaM: 0, slopePct: 0, stimpFt: 10, breakToRight: true,
    }),
];

// ---------------------------------------------------------------------------
// readPutt on planeSurface — golden integrator runs
// ---------------------------------------------------------------------------

function serializeRead(r: PuttRead) {
    return {
        availability: r.availability,
        aimBearingDeg: r.aimBearingDeg,
        aimOffsetM: r.aimOffsetM,
        initialSpeedMps: r.initialSpeedMps,
        playsLikeM: r.playsLikeM,
        holedProb: r.holedProb,
        canStop: r.canStop,
        holed: r.holed,
        pathLength: r.path.length,
        path: r.path,
        stopPoint: r.stopPoint,
        restBeyondHoleM: r.restBeyondHoleM,
        minConfidence: r.minConfidence,
    };
}

interface PlaneSpec {
    slopePct: number;
    fallLineBearingDeg: number;
    originHeight?: number;
    confidence?: number;
}

function planeCase(
    name: string,
    surface: PlaneSpec,
    ball: Vec2,
    hole: Vec2,
    stimpFt: number,
    options?: PuttReadOptions,
) {
    const read = readPutt(planeSurface(surface), ball, hole, stimpFt, options);
    return { name, surface, ball, hole, stimpFt, options: options ?? null, read: serializeRead(read) };
}

const BALL: Vec2 = { x: 0, y: 0 };
const HOLE_10M: Vec2 = { x: 0, y: 10 };

const puttPlaneCases = [
    planeCase('flat 10 m', { slopePct: 0, fallLineBearingDeg: 0 }, BALL, HOLE_10M, 10),
    planeCase('cross-slope 2% east, stimp 8',
        { slopePct: 2, fallLineBearingDeg: 90 }, BALL, HOLE_10M, 8),
    planeCase('cross-slope 2% east, stimp 10',
        { slopePct: 2, fallLineBearingDeg: 90 }, BALL, HOLE_10M, 10),
    planeCase('cross-slope 2% east, stimp 12',
        { slopePct: 2, fallLineBearingDeg: 90 }, BALL, HOLE_10M, 12),
    planeCase('uphill 2%', { slopePct: 2, fallLineBearingDeg: 180 }, BALL, HOLE_10M, 10),
    planeCase('downhill 2%', { slopePct: 2, fallLineBearingDeg: 0 }, BALL, HOLE_10M, 10),
    planeCase("can't-stop 6% downhill at stimp 12",
        { slopePct: 6, fallLineBearingDeg: 0 }, BALL, HOLE_10M, 12),
    planeCase('diagonal fall line, offset ball/hole',
        { slopePct: 2.5, fallLineBearingDeg: 70 }, { x: 3, y: -2 }, { x: -1, y: 9 }, 11),
    planeCase('soft confidence propagates',
        { slopePct: 1, fallLineBearingDeg: 90, confidence: 0.7 }, BALL, HOLE_10M, 10),
    planeCase('explicit options plumb through',
        { slopePct: 2, fallLineBearingDeg: 90 }, BALL, HOLE_10M, 10,
        { sweepDeg: 10, bearingCandidates: 9, speedCandidates: 7, refinePasses: 1 }),
    planeCase('zero-length putt is unavailable',
        { slopePct: 1, fallLineBearingDeg: 90 }, { x: 5, y: 5 }, { x: 5, y: 5 }, 10),
];

// ---------------------------------------------------------------------------
// readPutt + demSurface on a small synthetic tilted grid
// ---------------------------------------------------------------------------

const GRID_ORIGIN = { e: 500_000, n: 6_400_000 };
const GRID_RES = 0.5;
const GRID_W = 40;
const GRID_H = 40;

function buildDemGrid(): DemGrid {
    const heights: (number | null)[] = [];
    const insideMask: number[] = [];
    for (let row = 0; row < GRID_H; row++) {
        for (let col = 0; col < GRID_W; col++) {
            const e = GRID_ORIGIN.e + (col + 0.5) * GRID_RES;
            const n = GRID_ORIGIN.n - (row + 0.5) * GRID_RES;
            const de = e - GRID_ORIGIN.e;
            const dn = n - GRID_ORIGIN.n;
            // Tilted plane + a gentle ripple so gradients vary per cell.
            const h = 12 - 0.02 * de + 0.012 * dn + 0.015 * Math.sin(de * 0.7) * Math.cos(dn * 0.5);
            // Nodata patch (rows 18–21 × cols 4–8) for the degraded case.
            const nodata = row >= 18 && row <= 21 && col >= 4 && col <= 8;
            // Outer 1-cell ring is outside the analysed polygon.
            const outside =
                row === 0 || col === 0 || row === GRID_H - 1 || col === GRID_W - 1;
            heights.push(nodata ? null : h);
            insideMask.push(outside ? 0 : 1);
        }
    }
    return {
        heights,
        insideMask,
        origin: GRID_ORIGIN,
        resolution: GRID_RES,
        width: GRID_W,
        height: GRID_H,
    };
}

const demGrid = buildDemGrid();
const demSurf = demSurface(demGrid);

const demSamplePoints: { name: string; p: Vec2 }[] = [
    { name: 'interior, off cell centers', p: { x: GRID_ORIGIN.e + 7.1, y: GRID_ORIGIN.n - 6.9 } },
    { name: 'exactly on a cell center', p: { x: GRID_ORIGIN.e + 4.25, y: GRID_ORIGIN.n - 5.25 } },
    { name: 'near the nodata patch but clear of it', p: { x: GRID_ORIGIN.e + 6.3, y: GRID_ORIGIN.n - 9.1 } },
    { name: 'inside the nodata patch → null', p: { x: GRID_ORIGIN.e + 3.1, y: GRID_ORIGIN.n - 9.6 } },
    { name: 'in the outside ring → null', p: { x: GRID_ORIGIN.e + 0.4, y: GRID_ORIGIN.n - 10 } },
    { name: 'west of the grid → null', p: { x: GRID_ORIGIN.e - 5, y: GRID_ORIGIN.n - 5 } },
    { name: 'south of the grid → null', p: { x: GRID_ORIGIN.e + 5, y: GRID_ORIGIN.n - 30 } },
];

const demSamples = demSamplePoints.map(({ name, p }) => {
    const s = demSurf.sampleAt(p);
    return { name, p, sample: s === null ? null : s };
});

function demCase(name: string, ball: Vec2, hole: Vec2, stimpFt: number) {
    const read = readPutt(demSurf, ball, hole, stimpFt);
    return { name, ball, hole, stimpFt, read: serializeRead(read) };
}

const demReads = [
    demCase(
        'diagonal putt on covered ground',
        { x: GRID_ORIGIN.e + 6, y: GRID_ORIGIN.n - 14 },
        { x: GRID_ORIGIN.e + 12, y: GRID_ORIGIN.n - 6 },
        10,
    ),
    demCase(
        'short putt across the ripple',
        { x: GRID_ORIGIN.e + 14, y: GRID_ORIGIN.n - 15 },
        { x: GRID_ORIGIN.e + 11, y: GRID_ORIGIN.n - 11 },
        11,
    ),
    demCase(
        'corridor crosses the nodata patch → degraded',
        { x: GRID_ORIGIN.e + 3, y: GRID_ORIGIN.n - 17 },
        { x: GRID_ORIGIN.e + 3, y: GRID_ORIGIN.n - 3 },
        10,
    ),
    demCase(
        'ball off the grid → unavailable',
        { x: GRID_ORIGIN.e - 5, y: GRID_ORIGIN.n - 5 },
        { x: GRID_ORIGIN.e + 5, y: GRID_ORIGIN.n - 5 },
        10,
    ),
];

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const fixture = {
    meta: {
        generator: 'shared/strategy/putting/generate-swift-fixtures.ts',
        note: 'TS-computed goldens for the Swift putting mirror. Regenerate with: bun generate-swift-fixtures.ts',
    },
    constants,
    scalars,
    tourReadCases,
    puttPlaneCases,
    dem: {
        grid: {
            originE: GRID_ORIGIN.e,
            originN: GRID_ORIGIN.n,
            resolution: GRID_RES,
            width: GRID_W,
            height: GRID_H,
            heights: demGrid.heights,
            insideMask: demGrid.insideMask,
        },
        samples: demSamples,
        reads: demReads,
    },
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(fixture, null, 4)}\n`);
console.log(
    `wrote ${OUT_PATH}: ${tourReadCases.length} tourRead cases, ` +
    `${puttPlaneCases.length} plane putt reads, ${demReads.length} DEM putt reads, ` +
    `${demSamples.length} DEM samples`,
);
