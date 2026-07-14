// Golden-fixture generator for the Swift mirror of the four pure strategy
// modules ported to ios/GolfMap/Strategy/ (Club, Wind, Carry, FeatureDistances).
// Same T17 pattern as shared/strategy/putting/generate-swift-fixtures.ts.
//
// Run manually from this directory whenever any of the four modules change:
//
//     bun generate-swift-fixtures.ts
//
// Writes ios/GolfMapTests/Strategy/Fixtures/strategy-goldens.json, consumed by
// StrategyGoldenParityTests.swift. Deterministic: running twice yields
// identical bytes (no clocks, no randomness, stable key order).
//
// This is a SCRIPT, not a test — it is not picked up by `bun test`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type CaddyAdvice, type CaddyContext, type CaddyRule } from './caddy/rule';
import { runCaddy } from './caddy/run';
import { greenSlopeHalfRule } from './caddy/rules/green-slope-half';
import { par5AttackRule } from './caddy/rules/par5-attack';
import { noDoublesRule } from './caddy/rules/no-doubles';
import { shortSideGuardRule } from './caddy/rules/short-side-guard';
import { specificTargetRule } from './caddy/rules/specific-target';
import { takeYourMedicineRule } from './caddy/rules/take-your-medicine';
import {
    type AimCandidate,
    type AimOptions,
    type AimResult,
    defaultSweepDeg,
    optimizeAim,
    standardNormalPairs,
} from './aim';
import { hazardsAlongLine } from './carry';
import {
    type ClubSpec,
    clubAdvice,
    closestClub,
    lengthDispersionM,
    maxCarryM,
    maxDispersionM,
    minCarryM,
    minDispersionM,
    suggestClubForHole,
} from './club';
import { type FlatRing } from './corridor';
import { layupOptions, longestLayup } from './layup';
import {
    GREEN_RING_PAR5_EXTRA_M,
    GREEN_RING_RADII_M,
    TEE_RING_RADII_M,
    type Vec2,
    dispersionEllipse,
    greenRingRadiiM,
    ringPolygon,
} from './ellipse';
import { HOLED_DISTANCE_M, shotsToHoleOut, strokesGained } from './expected-strokes';
import { type DistanceTarget, featureDistances } from './feature-distances';
import { type Lie, lieFromFeatureType } from './lie';
import { type StrategyPoint } from './plays-like';
import { MPS_TO_MPH, mphToMps } from './units';
import { V1_CLUBS, v1Club } from './fixtures/v1-clubs';
import {
    adjustedCarryM,
    crosswindDriftM,
    playsAsM,
    windComponents,
    windEffect,
} from './wind';

const OUT_PATH = join(
    import.meta.dir,
    '../../ios/GolfMapTests/Strategy/Fixtures/strategy-goldens.json',
);

const clubName = (c: ClubSpec | undefined): string | null => c?.name ?? null;

// ---------------------------------------------------------------------------
// Club module
// ---------------------------------------------------------------------------

const CLUBS = V1_CLUBS.map((c) => ({ name: c.name, carryM: c.carryM, dispersionM: c.dispersionM }));

const club = {
    lengthDispersionM: [10, 75, 90, 99.999, 100, 142, 150, 150.001, 168, 243].map((c) => ({
        arg: c,
        out: lengthDispersionM(c),
    })),
    minCarryM: [
        [243, 0],
        [243, -0.1],
        [200, 0.05],
        [155, -0.247],
    ].map(([carry, effect]) => ({ carryM: carry, effect, out: minCarryM(carry, effect) })),
    maxCarryM: [
        [243, 0],
        [243, -0.1],
        [200, 0.05],
        [155, 0.068],
    ].map(([carry, effect]) => ({ carryM: carry, effect, out: maxCarryM(carry, effect) })),
    minDispersionM: [
        [50, 0],
        [50, 0.1],
        [32, -0.1],
    ].map(([disp, effect]) => ({ dispersionM: disp, effect, out: minDispersionM(disp, effect) })),
    maxDispersionM: [
        [50, 0],
        [50, -0.1],
        [32, 0.1],
    ].map(([disp, effect]) => ({ dispersionM: disp, effect, out: maxDispersionM(disp, effect) })),
    closestClub: [10, 100, 150, 155, 240, 300].map((d) => ({
        distanceM: d,
        name: clubName(closestClub(V1_CLUBS, d)),
    })),
    closestClubEmpty: { distanceM: 100, name: clubName(closestClub([], 100)) },
    clubAdvice: [10, 155, 163.0434782608696, 200, 300].map((d) => {
        const a = clubAdvice(V1_CLUBS, d);
        return { distanceM: d, front: clubName(a.front), center: clubName(a.center), back: clubName(a.back) };
    }),
    suggestClubForHole: [160, 243, 400].map((d) => ({
        distanceM: d,
        name: clubName(suggestClubForHole(V1_CLUBS, d)),
    })),
    suggestClubForHoleEmpty: { distanceM: 160, name: clubName(suggestClubForHole([], 160)) },
};

// ---------------------------------------------------------------------------
// Layup module — per-club outcome toward a target + the max-advance layup
// ---------------------------------------------------------------------------

const layup = {
    // Targets exercise: all-reach (5), mid with some reaching (160), boundary
    // exactly on the longest carry (243), out-of-range green (301), far (500).
    cases: [5, 160, 243, 301, 500].map((targetM) => {
        const opts = layupOptions(V1_CLUBS, targetM);
        const longest = longestLayup(V1_CLUBS, targetM);
        return {
            targetM,
            options: opts.map((o) => ({
                club: o.club.name,
                carryM: o.carryM,
                remainingM: o.remainingM,
                approachClub: clubName(o.approachClub),
                reaches: o.reaches,
            })),
            longest: longest
                ? {
                    club: longest.club.name,
                    remainingM: longest.remainingM,
                    approachClub: clubName(longest.approachClub),
                }
                : null,
        };
    }),
    emptyOptions: layupOptions([], 150).length,
    emptyLongest: longestLayup([], 150) === undefined ? null : 'unexpected',
};

// ---------------------------------------------------------------------------
// Wind module. Speeds given in m/s directly (the API unit).
// ---------------------------------------------------------------------------

const mps = (mph: number) => mph / MPS_TO_MPH;

interface WindTriple {
    speedMps: number;
    directionDeg: number;
    shotBearingDeg: number;
}

const windCases: WindTriple[] = [
    { speedMps: mps(10), directionDeg: 0, shotBearingDeg: 0 }, // full head
    { speedMps: mps(20), directionDeg: 180, shotBearingDeg: 0 }, // full tail, >18
    { speedMps: mps(10), directionDeg: 270, shotBearingDeg: 0 }, // full cross from left
    { speedMps: mps(10), directionDeg: 90, shotBearingDeg: 0 }, // full cross from right
    { speedMps: mps(15), directionDeg: 45, shotBearingDeg: 0 }, // quartering head
    { speedMps: mps(18), directionDeg: 0, shotBearingDeg: 0 }, // exactly 18 (not > 18)
    { speedMps: mps(19), directionDeg: 0, shotBearingDeg: 0 }, // discontinuity
    { speedMps: mps(18), directionDeg: 180, shotBearingDeg: 0 },
    { speedMps: mps(19), directionDeg: 180, shotBearingDeg: 0 },
    { speedMps: mps(20), directionDeg: 45, shotBearingDeg: 0 }, // total > 18, component < 18
    { speedMps: mps(8), directionDeg: 0, shotBearingDeg: 0 },
    { speedMps: mps(10), directionDeg: 10, shotBearingDeg: 350 }, // normalization
    { speedMps: 0, directionDeg: 123, shotBearingDeg: 45 }, // calm
];

const wind = {
    windComponents: windCases.map((c) => {
        const w = windComponents(c.speedMps, c.directionDeg, c.shotBearingDeg);
        return { ...c, headTailMph: w.headTailMph, crosswindMph: w.crosswindMph };
    }),
    windEffect: windCases.map((c) => ({
        ...c,
        out: windEffect(c.speedMps, c.directionDeg, c.shotBearingDeg),
    })),
    adjustedCarryM: [
        [243, windEffect(mps(10), 0, 0)],
        [155, windEffect(mps(20), 180, 0)],
        [243, windEffect(mps(15), 45, 0)],
    ].map(([carry, effect]) => ({ carryM: carry, effect, out: adjustedCarryM(carry, effect) })),
    playsAsM: [
        [150, windEffect(mps(8), 0, 0)],
        [150, -0.08],
        [200, 0.05],
    ].map(([d, effect]) => ({ distanceM: d, effect, out: playsAsM(d, effect) })),
    crosswindDriftM: [
        [243, 10],
        [243, -10],
        [243, 0],
    ].map(([carry, cross]) => ({ carryM: carry, crosswindMph: cross, out: crosswindDriftM(carry, cross) })),
};

// ---------------------------------------------------------------------------
// Carry module — hazardsAlongLine
// ---------------------------------------------------------------------------

const box = (minX: number, maxX: number, minY: number, maxY: number, kind = 'bunker'): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});

interface CarryCase {
    name: string;
    origin: Vec2;
    bearingDeg: number;
    rings: FlatRing[];
}

const carryCases: CarryCase[] = [
    { name: 'ray through a box', origin: { x: 0, y: 0 }, bearingDeg: 90, rings: [box(10, 20, -5, 5)] },
    {
        name: 'tangent and miss omitted',
        origin: { x: 0, y: 0 },
        bearingDeg: 90,
        rings: [box(10, 20, -10, 0), box(10, 20, 10, 20, 'water')],
    },
    {
        name: 'origin inside a ring',
        origin: { x: 15, y: 0 },
        bearingDeg: 90,
        rings: [box(10, 20, -5, 5, 'water')],
    },
    {
        name: 'two rings, one crossed one missed',
        origin: { x: 0, y: 0 },
        bearingDeg: 0,
        rings: [box(-10, 10, 60, 75, 'bunker'), box(30, 45, 60, 75, 'water')],
    },
    {
        name: 'diagonal ray through an offset box',
        origin: { x: 0, y: 0 },
        bearingDeg: 45,
        rings: [box(20, 40, 20, 40, 'bunker')],
    },
];

const carry = {
    cases: carryCases.map((c) => ({
        name: c.name,
        origin: c.origin,
        bearingDeg: c.bearingDeg,
        rings: c.rings,
        hazards: hazardsAlongLine(c.origin, c.bearingDeg, c.rings).map((h) => ({
            kind: h.ring.kind,
            frontM: h.frontM,
            carryM: h.carryM,
        })),
    })),
};

// ---------------------------------------------------------------------------
// FeatureDistances module — the golden hole + wind/no-elevation variants
// ---------------------------------------------------------------------------

const fdOrigin: StrategyPoint = { x: 0, y: 0, elevation: 100 };
const fdBunker: FlatRing = {
    kind: 'bunker',
    points: [
        { x: -10, y: 60 },
        { x: 10, y: 60 },
        { x: 10, y: 75 },
        { x: -10, y: 75 },
    ],
};
const fdTargets: DistanceTarget[] = [
    { kind: 'point', label: 'green front', role: 'green_front', at: { x: 0, y: 140, elevation: 104 } },
    { kind: 'point', label: 'green center', role: 'green_center', at: { x: 0, y: 150, elevation: 105 } },
    { kind: 'point', label: 'green back', role: 'green_back', at: { x: 0, y: 160, elevation: 106 } },
    { kind: 'hazard', label: 'fairway bunker', ring: fdBunker },
];
const FD_CLUBS: ClubSpec[] = [
    { name: '7i', carryM: 155, dispersionM: 32 },
    { name: '9i', carryM: 127, dispersionM: 30 },
    { name: 'PW', carryM: 115, dispersionM: 27 },
];

interface FeatureCase {
    name: string;
    origin: StrategyPoint;
    targets: DistanceTarget[];
    bearingDeg: number;
    wind?: { speedMps: number; directionDeg: number };
    clubs?: ClubSpec[];
}

const featureCases: FeatureCase[] = [
    { name: 'golden hole, no wind, clubs', origin: fdOrigin, targets: fdTargets, bearingDeg: 0, clubs: FD_CLUBS },
    {
        name: 'golden hole, headwind 5 m/s, clubs',
        origin: fdOrigin,
        targets: fdTargets,
        bearingDeg: 0,
        wind: { speedMps: 5, directionDeg: 0 },
        clubs: FD_CLUBS,
    },
    { name: 'golden hole, no wind, no clubs', origin: fdOrigin, targets: fdTargets, bearingDeg: 0 },
    {
        name: 'missing origin elevation',
        origin: { x: 0, y: 0 },
        targets: [{ kind: 'point', label: 'green center', role: 'green_center', at: { x: 0, y: 150, elevation: 105 } }],
        bearingDeg: 0,
    },
    {
        name: 'missing target elevation (null)',
        origin: fdOrigin,
        targets: [{ kind: 'point', label: 'aim point', role: 'aim', at: { x: 0, y: 100, elevation: null } }],
        bearingDeg: 0,
    },
    {
        name: 'hazard missed contributes nothing',
        origin: fdOrigin,
        targets: [
            {
                kind: 'hazard',
                label: 'pond',
                ring: {
                    kind: 'water',
                    points: [
                        { x: 30, y: 60 },
                        { x: 45, y: 60 },
                        { x: 45, y: 75 },
                        { x: 30, y: 75 },
                    ],
                },
            },
        ],
        bearingDeg: 0,
    },
    { name: 'empty targets', origin: fdOrigin, targets: [], bearingDeg: 0 },
];

const featureDistancesFx = {
    clubs: FD_CLUBS.map((c) => ({ name: c.name, carryM: c.carryM, dispersionM: c.dispersionM })),
    cases: featureCases.map((c) => {
        const rows = featureDistances({
            origin: c.origin,
            targets: c.targets,
            bearingDeg: c.bearingDeg,
            wind: c.wind,
            clubs: c.clubs,
        });
        return {
            name: c.name,
            origin: c.origin,
            targets: c.targets,
            bearingDeg: c.bearingDeg,
            wind: c.wind ?? null,
            hasClubs: c.clubs !== undefined,
            rows: rows.map((r) => ({
                kind: r.kind,
                label: r.label,
                bearingDeg: r.bearingDeg,
                lineM: r.lineM,
                elevationDeltaM: r.elevationDeltaM,
                playsLikeM: r.playsLikeM,
                windDeltaM: r.windDeltaM,
                clubName: clubName(r.club),
            })),
        };
    }),
};

// ---------------------------------------------------------------------------
// Caddy module — runCaddy evaluator + green-slope-half rule
// ---------------------------------------------------------------------------

// A CaddyContext the evaluator/rule can read. The run-cases only touch
// `hole`/`risk`; the green-slope cases fill origin/target/greenSlope/hazards.
function caddyCtx(over: Partial<CaddyContext> = {}): CaddyContext {
    return {
        leg: 'approach',
        origin: { x: 0, y: 0 },
        target: {
            greenPoly: { kind: 'green', points: [] },
            center: { x: 0, y: 100 },
            front: { x: 0, y: 95 },
            back: { x: 0, y: 105 },
        },
        distances: [],
        hazards: [],
        clubs: [],
        hole: { par: 4, index: 1 },
        risk: { riskAversion: 0 },
        ...over,
    };
}

// A synthetic rule that emits exactly the advice it is handed (mirrors the
// run.test.ts `ruleEmitting` helper). Serialized as {id, advice[]} so Swift
// rebuilds the identical rule set.
function ruleEmitting(id: string, ...advice: CaddyAdvice[]): CaddyRule {
    return { id, appliesTo: () => true, evaluate: () => advice };
}

interface AdviceInput {
    ruleId: string;
    kind?: CaddyAdvice['kind'];
    priority?: number;
    confidence?: number;
    headline?: string;
    detail?: string;
    vetoes?: string[];
    riskWeighted?: boolean;
}

function mkAdvice(a: AdviceInput): CaddyAdvice {
    return {
        ruleId: a.ruleId,
        kind: a.kind ?? 'warning',
        priority: a.priority ?? 1,
        confidence: a.confidence ?? 1,
        headline: a.headline ?? `advice-${a.ruleId}`,
        ...(a.detail !== undefined ? { detail: a.detail } : {}),
        ...(a.vetoes !== undefined ? { vetoes: a.vetoes } : {}),
        ...(a.riskWeighted !== undefined ? { riskWeighted: a.riskWeighted } : {}),
    };
}

interface RunRuleInput {
    id: string;
    advice: AdviceInput[];
}
interface RunCase {
    name: string;
    riskAversion: number;
    rules: RunRuleInput[];
}

// Mirrors shared/strategy/caddy/run.test.ts, as data.
const runCases: RunCase[] = [
    {
        name: 'orders by priority × confidence',
        riskAversion: 0,
        rules: [
            { id: 'low', advice: [{ ruleId: 'low', priority: 2, confidence: 0.4, headline: 'low' }] },
            { id: 'high', advice: [{ ruleId: 'high', priority: 4, confidence: 1, headline: 'high' }] },
            { id: 'mid', advice: [{ ruleId: 'mid', priority: 3, confidence: 0.5, headline: 'mid' }] },
        ],
    },
    {
        name: 'higher priority outranked by higher confidence',
        riskAversion: 0,
        rules: [
            { id: 'a', advice: [{ ruleId: 'a', priority: 5, confidence: 0.3, headline: 'a' }] },
            { id: 'b', advice: [{ ruleId: 'b', priority: 2, confidence: 1, headline: 'b' }] },
        ],
    },
    {
        name: 'veto demotes targeted advice below all non-vetoed',
        riskAversion: 0,
        rules: [
            { id: 'attack', advice: [{ ruleId: 'attack', priority: 4, confidence: 1, headline: 'attack' }] },
            { id: 'safety', advice: [{ ruleId: 'safety', priority: 1, confidence: 1, headline: 'lay up', vetoes: ['attack'] }] },
            { id: 'neutral', advice: [{ ruleId: 'neutral', priority: 2, confidence: 1, headline: 'neutral' }] },
        ],
    },
    {
        name: 'veto against absent rule is a no-op',
        riskAversion: 0,
        rules: [{ id: 'safety', advice: [{ ruleId: 'safety', headline: 'safe', vetoes: ['ghost-rule'] }] }],
    },
    { name: 'no rules → no advice', riskAversion: 0, rules: [] },
    {
        name: 'dedupe identical recommendations',
        riskAversion: 0,
        rules: [{ id: 'dup', advice: [
            { ruleId: 'dup', kind: 'club', priority: 2, confidence: 1, headline: 'same' },
            { ruleId: 'dup', kind: 'club', priority: 2, confidence: 1, headline: 'same' },
        ] }],
    },
    {
        name: 'distinct headlines same rule kept',
        riskAversion: 0,
        rules: [{ id: 'r', advice: [
            { ruleId: 'r', kind: 'club', headline: 'club up' },
            { ruleId: 'r', kind: 'club', headline: 'club down' },
        ] }],
    },
    {
        name: 'risk-weighted floats up (calm, riskAversion 0)',
        riskAversion: 0,
        rules: [
            { id: 'safety', advice: [{ ruleId: 'safety', priority: 2, confidence: 1, headline: 'safe', riskWeighted: true }] },
            { id: 'bold', advice: [{ ruleId: 'bold', priority: 1.4, confidence: 1, headline: 'bold' }] },
        ],
    },
    {
        name: 'risk-weighted floats up (scared, riskAversion 1)',
        riskAversion: 1,
        rules: [
            { id: 'safety', advice: [{ ruleId: 'safety', priority: 2, confidence: 1, headline: 'safe', riskWeighted: true }] },
            { id: 'bold', advice: [{ ruleId: 'bold', priority: 1.4, confidence: 1, headline: 'bold' }] },
        ],
    },
    {
        name: 'equal ranks deterministic by ruleId',
        riskAversion: 0,
        rules: [
            { id: 'zulu', advice: [{ ruleId: 'zulu', priority: 2, confidence: 1, headline: 'z' }] },
            { id: 'alpha', advice: [{ ruleId: 'alpha', priority: 2, confidence: 1, headline: 'a' }] },
        ],
    },
];

const caddyRun = {
    cases: runCases.map((c) => {
        const rules = c.rules.map((r) => ruleEmitting(r.id, ...r.advice.map(mkAdvice)));
        const out = runCaddy(caddyCtx({ risk: { riskAversion: c.riskAversion } }), rules);
        return {
            name: c.name,
            riskAversion: c.riskAversion,
            rules: c.rules,
            expected: out.map((a) => a.ruleId),
        };
    }),
};

// green-slope-half — mirrors shared/strategy/caddy/rules/green-slope-half.test.ts.
const gsBox = (minX: number, minY: number, maxX: number, maxY: number, kind = 'bunker') => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});
const gsSummary = (over: Partial<CaddyContext['greenSlope'] & object> = {}) => ({
    fallLineBearingDeg: 180,
    fallLinePct: 4,
    frontHalfPct: 4,
    backHalfPct: 4,
    ...over,
});

interface GsCase {
    name: string;
    leg?: CaddyContext['leg'];
    greenSlope?: ReturnType<typeof gsSummary> | null;
    hazards?: ReturnType<typeof gsBox>[];
}

const gsCases: GsCase[] = [
    { name: 'aligned + steep + front-clean fires', greenSlope: gsSummary() },
    { name: 'diagonal inside cone (140) fires', greenSlope: gsSummary({ fallLineBearingDeg: 140 }) },
    { name: 'shallowish (3.2%) fires, low confidence', greenSlope: gsSummary({ fallLinePct: 3.2 }) },
    { name: 'steep (6%) fires, higher confidence', greenSlope: gsSummary({ fallLinePct: 6 }) },
    { name: 'hazard in front window suppresses', greenSlope: gsSummary(), hazards: [gsBox(-5, 70, 5, 80)] },
    { name: 'hazard beyond window does not suppress', greenSlope: gsSummary(), hazards: [gsBox(-5, 40, 5, 50)] },
    { name: 'shallow (2.5%) no advice', greenSlope: gsSummary({ fallLinePct: 2.5 }) },
    { name: 'cross-slope (90) no advice', greenSlope: gsSummary({ fallLineBearingDeg: 90 }) },
    { name: 'front-to-back (0) no advice', greenSlope: gsSummary({ fallLineBearingDeg: 0 }) },
    { name: 'non-approach leg no advice', leg: 'tee', greenSlope: gsSummary() },
    { name: 'missing greenSlope no advice', greenSlope: null },
];

const caddyGreenSlope = {
    constants: {
        MIN_FALL_LINE_PCT: 3,
        FALL_LINE_ALIGN_TOLERANCE_DEG: 45,
        FRONT_CLEAN_WINDOW_M: 30,
    },
    cases: gsCases.map((c) => {
        const ctx = caddyCtx({
            leg: c.leg ?? 'approach',
            greenSlope: c.greenSlope === null ? undefined : c.greenSlope,
            hazards: (c.hazards ?? []) as CaddyContext['hazards'],
        });
        const out = runCaddy(ctx, [greenSlopeHalfRule]);
        return {
            name: c.name,
            leg: ctx.leg,
            origin: ctx.origin,
            front: ctx.target.front,
            center: ctx.target.center,
            back: ctx.target.back,
            greenSlope: c.greenSlope,
            hazards: c.hazards ?? [],
            out: out.map((a) => ({
                ruleId: a.ruleId,
                kind: a.kind,
                priority: a.priority,
                confidence: a.confidence,
                headline: a.headline,
                detail: a.detail ?? null,
                anchor: a.anchor ?? null,
            })),
        };
    }),
};

// --- Rules that turn AimResult / geometry into ranked advice ----------------
//
// Unified per-rule case shape: each case serializes the full CaddyContext the
// rule reads plus the ranked advice runCaddy produces for [rule]. Swift rebuilds
// the context and reruns the same single-rule evaluation. The aim-reading rules
// (no-doubles, short-side-guard, specific-target) are fed a SYNTHETIC AimResult
// so their thresholds pin exactly and stay decoupled from optimizeAim's sampling;
// par5-attack runs the real optimizeAim internally (its numeric parity is already
// proven at 1e-9 by the aim goldens).

function synthAim(over: {
    bestBearingDeg?: number;
    expectedStrokes?: number;
    tailStrokes?: number;
    breakdown?: Partial<Record<Lie, number>>;
}): AimResult {
    const bestBearingDeg = over.bestBearingDeg ?? 0;
    const expectedStrokes = over.expectedStrokes ?? 3;
    const tailStrokes = over.tailStrokes ?? expectedStrokes;
    const breakdown = over.breakdown ?? {};
    const best: AimCandidate = {
        bearingDeg: bestBearingDeg,
        expectedStrokes,
        tailStrokes,
        score: expectedStrokes,
        breakdown,
    };
    return { bestBearingDeg, best, perCandidate: [best], breakdown };
}

function serializeCtx(ctx: CaddyContext) {
    return {
        leg: ctx.leg,
        origin: { x: ctx.origin.x, y: ctx.origin.y },
        target: {
            greenPoly: ctx.target.greenPoly,
            center: ctx.target.center,
            front: ctx.target.front,
            back: ctx.target.back,
        },
        clubs: ctx.clubs.map((c) => ({
            name: c.name ?? null,
            carryM: c.carryM,
            dispersionM: c.dispersionM,
        })),
        wind: ctx.wind ? { speedMps: ctx.wind.speedMps, directionDeg: ctx.wind.directionDeg } : null,
        hole: { par: ctx.hole.par, index: ctx.hole.index },
        risk: { riskAversion: ctx.risk.riskAversion },
        aim: ctx.aim
            ? {
                bestBearingDeg: ctx.aim.bestBearingDeg,
                best: {
                    expectedStrokes: ctx.aim.best.expectedStrokes,
                    tailStrokes: ctx.aim.best.tailStrokes,
                },
                breakdown: ctx.aim.breakdown,
            }
            : null,
        hazards: ctx.hazards,
    };
}

function serializeAdvice(a: CaddyAdvice) {
    return {
        ruleId: a.ruleId,
        kind: a.kind,
        priority: a.priority,
        confidence: a.confidence,
        headline: a.headline,
        detail: a.detail ?? null,
        anchor: a.anchor ?? null,
    };
}

interface RuleCase {
    name: string;
    over: Partial<CaddyContext>;
}

function ruleFixture(rule: CaddyRule, cases: RuleCase[]) {
    return {
        cases: cases.map((c) => {
            const ctx = caddyCtx(c.over);
            const out = runCaddy(ctx, [rule]);
            return { name: c.name, ctx: serializeCtx(ctx), out: out.map(serializeAdvice) };
        }),
    };
}

const fxClub = (name: string, carryM: number, dispersionM = 18): ClubSpec => ({ name, carryM, dispersionM });
const fxBox = (kind: string, minX: number, minY: number, maxX: number, maxY: number): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});
const stTarget = (y: number) => ({
    greenPoly: { kind: 'green', points: [] as Vec2[] },
    center: { x: 0, y },
    front: { x: 0, y: y - 5 },
    back: { x: 0, y: y + 5 },
});
const par5Target = (y: number) => ({
    greenPoly: fxBox('green', -18, y - 10, 18, y + 10),
    center: { x: 0, y },
    front: { x: 0, y: y - 10 },
    back: { x: 0, y: y + 10 },
});

// take-your-medicine — recovery-leg punch-out (mirrors take-your-medicine.test.ts).
const medicineClubs = [fxClub('wedge', 90, 12), fxClub('9 iron', 120, 14)];
const medicineTarget = {
    greenPoly: { kind: 'green', points: [] as Vec2[] },
    center: { x: 0, y: 180 },
    front: { x: 0, y: 175 },
    back: { x: 0, y: 185 },
};
const caddyMedicine = ruleFixture(takeYourMedicineRule, [
    { name: 'punch-out beats forcing it', over: { leg: 'recovery', clubs: medicineClubs, target: medicineTarget } },
    {
        name: 'headwind shortens the escape',
        over: { leg: 'recovery', clubs: medicineClubs, target: medicineTarget, wind: { speedMps: 6, directionDeg: 180 } },
    },
    {
        name: 'already at the green emits nothing',
        over: {
            leg: 'recovery',
            clubs: medicineClubs,
            target: { greenPoly: { kind: 'green', points: [] as Vec2[] }, center: { x: 0, y: 0 }, front: { x: 0, y: 0 }, back: { x: 0, y: 0 } },
        },
    },
    { name: 'non-recovery leg no advice', over: { leg: 'approach', clubs: medicineClubs, target: medicineTarget } },
    { name: 'no clubs no advice', over: { leg: 'recovery', clubs: [], target: medicineTarget } },
]);

// no-doubles — reads the recommended aim's tail gap (mirrors no-doubles.test.ts).
const caddyNoDoubles = ruleFixture(noDoublesRule, [
    { name: 'big tail warns', over: { aim: synthAim({ expectedStrokes: 3.0, tailStrokes: 3.8 }) } },
    { name: 'severe tail full strength', over: { aim: synthAim({ expectedStrokes: 3.0, tailStrokes: 4.5 }) } },
    { name: 'shift invariance same gap', over: { aim: synthAim({ expectedStrokes: 4.0, tailStrokes: 4.8 }) } },
    { name: 'tight tail quiet', over: { aim: synthAim({ expectedStrokes: 3.0, tailStrokes: 3.3 }) } },
    { name: 'recovery leg no advice', over: { leg: 'recovery', aim: synthAim({ expectedStrokes: 3.0, tailStrokes: 4.5 }) } },
    { name: 'no aim no advice', over: { aim: undefined } },
]);

// short-side-guard — reads the aim's trouble share (mirrors short-side-guard.test.ts).
const ssHazards = [fxBox('bunker', 5, 140, 12, 150)];
const caddyShortSide = ruleFixture(shortSideGuardRule, [
    { name: 'trouble over threshold fires', over: { aim: synthAim({ breakdown: { green: 0.7, sand: 0.3 } }), hazards: ssHazards } },
    {
        name: 'sand+water+recovery combine',
        over: { aim: synthAim({ breakdown: { green: 0.85, sand: 0.05, penalty: 0.05, recovery: 0.05 } }), hazards: ssHazards },
    },
    { name: 'below threshold quiet', over: { aim: synthAim({ breakdown: { green: 0.97, sand: 0.03 } }), hazards: ssHazards } },
    { name: 'no hazards no advice', over: { aim: synthAim({ breakdown: { green: 0.6, sand: 0.4 } }), hazards: [] } },
    { name: 'non-approach no advice', over: { leg: 'tee', aim: synthAim({ breakdown: { green: 0.6, sand: 0.4 } }), hazards: ssHazards } },
    { name: 'no aim no advice', over: { aim: undefined, hazards: ssHazards } },
]);

// specific-target — names the club for the recommended aim (mirrors specific-target.test.ts).
const stClubs = [fxClub('7 iron', 150, 16), fxClub('6 iron', 165, 18), fxClub('8 iron', 138, 15)];
const caddySpecificTarget = ruleFixture(specificTargetRule, [
    { name: 'names the centre club, north anchor', over: { aim: synthAim({ bestBearingDeg: 0, breakdown: { green: 0.9, rough: 0.1 } }), clubs: stClubs, target: stTarget(150) } },
    { name: 'brackets front/back when bag straddles', over: { aim: synthAim({ bestBearingDeg: 0, breakdown: { green: 0.9, rough: 0.1 } }), clubs: stClubs, target: stTarget(156) } },
    { name: 'offset recommended bearing anchor', over: { aim: synthAim({ bestBearingDeg: 8, breakdown: { green: 0.8, rough: 0.2 } }), clubs: stClubs, target: stTarget(150) } },
    { name: 'no clubs generic headline', over: { aim: synthAim({ bestBearingDeg: 0, breakdown: { green: 0.75 } }), clubs: [], target: stTarget(150) } },
    { name: 'non-approach no advice', over: { leg: 'tee', aim: synthAim({ bestBearingDeg: 0, breakdown: { green: 0.9 } }), clubs: stClubs, target: stTarget(150) } },
    { name: 'no aim no advice', over: { aim: undefined, clubs: stClubs, target: stTarget(150) } },
]);

// par5-attack — real two-shot EV chain via optimizeAim (mirrors par5-attack.test.ts).
const caddyPar5 = ruleFixture(par5AttackRule, [
    {
        name: 'awkward leftover loses to full wedge lay-up',
        over: {
            leg: 'layup',
            hole: { par: 5, index: 1 },
            target: {
                greenPoly: fxBox('green', -15, 225, 15, 245),
                center: { x: 0, y: 235 },
                front: { x: 0, y: 225 },
                back: { x: 0, y: 245 },
            },
            clubs: [fxClub('full wedge lay-up club', 135, 16), fxClub('pinch club', 193, 60)],
            hazards: [fxBox('water', -4, 203, 4, 212), fxBox('water', 7, 170, 80, 220), fxBox('water', -80, 170, -7, 220)],
        },
    },
    {
        name: 'go-in-2 fires when carry reaches and clears',
        over: {
            leg: 'layup',
            hole: { par: 5, index: 1 },
            target: par5Target(190),
            clubs: [fxClub('3 wood', 185, 24), fxClub('lay-up wedge', 90, 12)],
        },
    },
    {
        name: 'go-in-2 dropped when max carry short',
        over: {
            leg: 'layup',
            hole: { par: 5, index: 1 },
            target: par5Target(190),
            clubs: [fxClub('short wood', 170, 24), fxClub('lay-up wedge', 90, 12)],
        },
    },
    {
        name: 'non-par-5 no advice',
        over: {
            leg: 'layup',
            hole: { par: 4, index: 1 },
            target: par5Target(190),
            clubs: [fxClub('3 wood', 185, 24), fxClub('lay-up wedge', 90, 12)],
        },
    },
]);

const caddy = {
    run: caddyRun,
    greenSlope: caddyGreenSlope,
    medicine: caddyMedicine,
    noDoubles: caddyNoDoubles,
    shortSide: caddyShortSide,
    specificTarget: caddySpecificTarget,
    par5: caddyPar5,
};

// ---------------------------------------------------------------------------
// Ellipse module — dispersionEllipse + distance rings
// ---------------------------------------------------------------------------

interface EllipseCase {
    name: string;
    origin: Vec2;
    bearingDeg: number;
    club: Required<ClubSpec>;
    windSpeedMps?: number;
    windDirectionDeg?: number;
    groundSlope?: number;
    samples?: number;
}

const ellipseCases: EllipseCase[] = [
    { name: '7i @45, no wind', origin: { x: 0, y: 0 }, bearingDeg: 45, club: v1Club('7i') },
    { name: 'PW @30, no wind', origin: { x: 10, y: -5 }, bearingDeg: 30, club: v1Club('PW') },
    {
        name: 'Driver @0, 10mph headwind',
        origin: { x: 0, y: 0 }, bearingDeg: 0, club: v1Club('Driver'),
        windSpeedMps: mphToMps(10), windDirectionDeg: 0,
    },
    {
        name: 'Driver @0, 20mph tailwind (>18)',
        origin: { x: 0, y: 0 }, bearingDeg: 0, club: v1Club('Driver'),
        windSpeedMps: mphToMps(20), windDirectionDeg: 180,
    },
    {
        name: 'Driver @0, 10mph crosswind from left',
        origin: { x: 0, y: 0 }, bearingDeg: 0, club: v1Club('Driver'),
        windSpeedMps: mphToMps(10), windDirectionDeg: 270,
    },
    {
        name: 'Driver @0, 15mph quartering head',
        origin: { x: 5, y: 5 }, bearingDeg: 0, club: v1Club('Driver'),
        windSpeedMps: mphToMps(15), windDirectionDeg: 45,
    },
    {
        name: '3w @120, 25mph quartering tail (>18 total, custom samples)',
        origin: { x: -3, y: 8 }, bearingDeg: 120, club: v1Club('3w'),
        windSpeedMps: mphToMps(25), windDirectionDeg: 300, samples: 16,
    },
    {
        name: '7i @0, downhill slope -0.06',
        origin: { x: 0, y: 0 }, bearingDeg: 0, club: v1Club('7i'), groundSlope: -0.06,
    },
    {
        name: '7i @0, uphill slope +0.06',
        origin: { x: 0, y: 0 }, bearingDeg: 0, club: v1Club('7i'), groundSlope: 0.06,
    },
    {
        name: '7i @210, wind + slope + custom samples',
        origin: { x: 100, y: 200 }, bearingDeg: 210, club: v1Club('7i'),
        windSpeedMps: mphToMps(12), windDirectionDeg: 30, groundSlope: 0.03, samples: 8,
    },
];

const ellipseFx = {
    cases: ellipseCases.map((c) => {
        const e = dispersionEllipse({
            origin: c.origin, bearingDeg: c.bearingDeg,
            club: { carryM: c.club.carryM, dispersionM: c.club.dispersionM },
            windSpeedMps: c.windSpeedMps, windDirectionDeg: c.windDirectionDeg,
            groundSlope: c.groundSlope, samples: c.samples,
        });
        return {
            name: c.name,
            origin: c.origin,
            bearingDeg: c.bearingDeg,
            club: { name: c.club.name, carryM: c.club.carryM, dispersionM: c.club.dispersionM },
            windSpeedMps: c.windSpeedMps ?? null,
            windDirectionDeg: c.windDirectionDeg ?? null,
            groundSlope: c.groundSlope ?? null,
            samples: c.samples ?? null,
            center: e.center,
            driftM: e.driftM,
            semiLengthM: e.semiLengthM,
            semiLateralM: e.semiLateralM,
            resultBearingDeg: e.bearingDeg,
            polygon: e.polygon,
        };
    }),
};

interface RingCase {
    name: string;
    center: Vec2;
    radiusM: number;
    samples?: number;
}

const ringCases: RingCase[] = [
    { name: 'default samples', center: { x: 500, y: 1000 }, radiusM: 150 },
    { name: 'custom 32 samples', center: { x: 500, y: 1000 }, radiusM: 150, samples: 32 },
    { name: 'small radius offset center', center: { x: -20, y: 7.5 }, radiusM: 12, samples: 20 },
];

const rings = {
    greenRingRadiiM: [3, 4, 5].map((par) => ({ par, radii: greenRingRadiiM(par) })),
    constants: {
        GREEN_RING_RADII_M: [...GREEN_RING_RADII_M],
        GREEN_RING_PAR5_EXTRA_M,
        TEE_RING_RADII_M: [...TEE_RING_RADII_M],
    },
    ringPolygon: ringCases.map((c) => ({
        name: c.name,
        center: c.center,
        radiusM: c.radiusM,
        samples: c.samples ?? null,
        polygon: c.samples === undefined
            ? ringPolygon(c.center, c.radiusM)
            : ringPolygon(c.center, c.radiusM, c.samples),
    })),
};

// ---------------------------------------------------------------------------
// Lie module — lieFromFeatureType
// ---------------------------------------------------------------------------

const lieFeatureTypes = [
    'tee', 'fairway', 'green', 'semi_rough', 'rough', 'deep_rough', 'trees',
    'bunker', 'water', 'water_creek', 'penalty_yellow', 'penalty_red', 'oob',
    'outside', 'path', 'unknown', 'totally_made_up', '',
];

const lie = {
    lieFromFeatureType: lieFeatureTypes.map((featureType) => ({
        featureType,
        lie: lieFromFeatureType(featureType),
    })),
};

// ---------------------------------------------------------------------------
// ExpectedStrokes module — shotsToHoleOut + strokesGained
// ---------------------------------------------------------------------------

const ALL_LIES: Lie[] = ['tee', 'fairway', 'rough', 'sand', 'recovery', 'green', 'penalty'];

// Distances (m) that exercise: holed, below-first-anchor clamp, interior
// interpolation, exact anchors, and above-last extrapolation.
const shotsDistances = [0, 0.049, 0.05, 1, 5, 10, 18.288, 50, 91.44, 100, 137.16, 200, 500, 548.64, 600, 700];

const expectedStrokes = {
    HOLED_DISTANCE_M,
    shotsToHoleOut: ALL_LIES.flatMap((l) =>
        shotsDistances.map((d) => ({ distanceM: d, lie: l, out: shotsToHoleOut(d, l) })),
    ),
    strokesGained: [
        { fromM: 150, fromLie: 'tee' as Lie, toM: 20, toLie: 'fairway' as Lie },
        { fromM: 137.16, fromLie: 'fairway' as Lie, toM: 3, toLie: 'green' as Lie },
        { fromM: 100, fromLie: 'rough' as Lie, toM: 0.04, toLie: 'green' as Lie }, // holed
        { fromM: 200, fromLie: 'sand' as Lie, toM: 50, toLie: 'penalty' as Lie },
        { fromM: 300, fromLie: 'recovery' as Lie, toM: 700, toLie: 'rough' as Lie }, // extrapolation
    ].map((c) => ({ ...c, out: strokesGained(c.fromM, c.fromLie, c.toM, c.toLie) })),
};

// ---------------------------------------------------------------------------
// Aim module — optimizeAim + standardNormalPairs + defaultSweepDeg
// ---------------------------------------------------------------------------

const aimRect = (minX: number, maxX: number, minY: number, maxY: number, kind: string): FlatRing => ({
    kind,
    points: [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
    ],
});

interface AimCase {
    name: string;
    options: AimOptions;
}

const aimClub = { name: '7i', carryM: 150, dispersionM: 20 };
const aimGreen = { x: 0, y: 150 };
const aimBase = { origin: { x: 0, y: 0 }, club: aimClub, targetBearingDeg: 0, greenCenter: aimGreen };

const aimCases: AimCase[] = [
    {
        name: 'water left, default sweep, 13 candidates',
        options: { ...aimBase, surfaces: [aimRect(-25, -3, 135, 165, 'water')] },
    },
    {
        name: 'no hazards, all rough',
        options: { ...aimBase, surfaces: [] },
    },
    {
        name: 'nested bunker topmost-first, single candidate',
        options: {
            ...aimBase, candidates: 1,
            surfaces: [aimRect(-16, 16, 139, 161, 'bunker'), aimRect(-50, 50, 100, 200, 'fairway')],
        },
    },
    {
        name: 'wind + risk aversion, 5 candidates',
        options: {
            ...aimBase,
            surfaces: [aimRect(3, 25, 135, 165, 'water'), aimRect(-50, 50, 100, 200, 'fairway')],
            windSpeedMps: mphToMps(12), windDirectionDeg: 90,
            candidates: 5, samples: 64, riskAversion: 1,
        },
    },
];

const aim = {
    defaultSweepDeg: [
        { name: 'mid iron', club: aimClub },
        { name: 'clamp low', club: { name: 'D', carryM: 250, dispersionM: 5 } },
        { name: 'clamp high', club: { name: 'W', carryM: 60, dispersionM: 60 } },
    ].map((c) => ({ name: c.name, club: c.club, out: defaultSweepDeg(c.club) })),
    standardNormalPairs: [1, 5, 13, 128].map((count) => ({
        count,
        pairs: standardNormalPairs(count).map(([z1, z2]) => [z1, z2]),
    })),
    cases: aimCases.map((c) => {
        const r = optimizeAim(c.options);
        const o = c.options;
        return {
            name: c.name,
            origin: o.origin,
            club: { name: o.club.name, carryM: o.club.carryM, dispersionM: o.club.dispersionM },
            targetBearingDeg: o.targetBearingDeg,
            greenCenter: o.greenCenter,
            surfaces: o.surfaces,
            windSpeedMps: o.windSpeedMps ?? null,
            windDirectionDeg: o.windDirectionDeg ?? null,
            groundSlope: o.groundSlope ?? null,
            sweepDeg: o.sweepDeg ?? null,
            candidates: o.candidates ?? null,
            samples: o.samples ?? null,
            sigmaScale: o.sigmaScale ?? null,
            riskAversion: o.riskAversion ?? null,
            fallbackLie: o.fallbackLie ?? null,
            bestBearingDeg: r.bestBearingDeg,
            breakdown: r.breakdown,
            perCandidate: r.perCandidate.map((cand) => ({
                bearingDeg: cand.bearingDeg,
                expectedStrokes: cand.expectedStrokes,
                tailStrokes: cand.tailStrokes,
                score: cand.score,
                breakdown: cand.breakdown,
            })),
        };
    }),
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

const fixture = {
    meta: {
        generator: 'shared/strategy/generate-swift-fixtures.ts',
        note: 'TS-computed goldens for the Swift strategy mirror (Club/Wind/Carry/FeatureDistances). Regenerate with: bun generate-swift-fixtures.ts',
    },
    constants: { MPS_TO_MPH },
    clubs: CLUBS,
    club,
    layup,
    wind,
    carry,
    featureDistances: featureDistancesFx,
    caddy,
    ellipse: ellipseFx,
    rings,
    lie,
    expectedStrokes,
    aim,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(fixture, null, 4)}\n`);
console.log(
    `wrote ${OUT_PATH}: club ${club.clubAdvice.length} advice cases, ` +
        `layup ${layup.cases.length} cases, ` +
        `wind ${wind.windEffect.length} cases, carry ${carry.cases.length} cases, ` +
        `featureDistances ${featureDistancesFx.cases.length} cases, ` +
        `caddy ${caddy.run.cases.length} run + ${caddy.greenSlope.cases.length} green-slope cases, ` +
        `ellipse ${ellipseFx.cases.length} cases + ${rings.ringPolygon.length} ring cases, ` +
        `lie ${lie.lieFromFeatureType.length} cases, ` +
        `expectedStrokes ${expectedStrokes.shotsToHoleOut.length} shots + ${expectedStrokes.strokesGained.length} SG cases, ` +
        `aim ${aim.cases.length} cases + ${aim.standardNormalPairs.length} normal-pair cases`,
);
