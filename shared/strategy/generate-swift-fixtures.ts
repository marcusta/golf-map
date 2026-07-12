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
import { type Vec2 } from './ellipse';
import { type DistanceTarget, featureDistances } from './feature-distances';
import { type StrategyPoint } from './plays-like';
import { MPS_TO_MPH } from './units';
import { V1_CLUBS } from './fixtures/v1-clubs';
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
    wind,
    carry,
    featureDistances: featureDistancesFx,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, `${JSON.stringify(fixture, null, 4)}\n`);
console.log(
    `wrote ${OUT_PATH}: club ${club.clubAdvice.length} advice cases, ` +
        `wind ${wind.windEffect.length} cases, carry ${carry.cases.length} cases, ` +
        `featureDistances ${featureDistancesFx.cases.length} cases`,
);
