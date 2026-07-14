import { describe, expect, test } from 'bun:test';
import { type ClubSpec } from './club';
import { type FlatRing } from './corridor';
import { featureDistances, type DistanceTarget, type FeatureDistancesInput } from './feature-distances';

// Golden hole: origin (0,0) elev 100, shot due north (bearing 0 = +y).
// Green front/center/back sit on the bearing-0 line at 140/150/160 m with
// elevations 104/105/106 (a gentle rise), so elevΔ/playsLike are exact.
// A bunker straddles 60–75 m on the same line: front=60, carry=75.

const origin = { x: 0, y: 0, elevation: 100 };

const bunker: FlatRing = {
    kind: 'bunker',
    points: [
        { x: -10, y: 60 },
        { x: 10, y: 60 },
        { x: 10, y: 75 },
        { x: -10, y: 75 },
    ],
};

const targets: DistanceTarget[] = [
    { kind: 'point', label: 'green front', role: 'green_front', at: { x: 0, y: 140, elevation: 104 } },
    { kind: 'point', label: 'green center', role: 'green_center', at: { x: 0, y: 150, elevation: 105 } },
    { kind: 'point', label: 'green back', role: 'green_back', at: { x: 0, y: 160, elevation: 106 } },
    { kind: 'hazard', label: 'fairway bunker', ring: bunker },
];

const clubs: readonly ClubSpec[] = [
    { name: '7i', carryM: 155, dispersionM: 32 },
    { name: '9i', carryM: 127, dispersionM: 30 },
    { name: 'PW', carryM: 115, dispersionM: 27 },
];

describe('featureDistances — golden hole', () => {
    test('exact ordered list, no wind', () => {
        const input: FeatureDistancesInput = { origin, targets, bearingDeg: 0, clubs };
        const rows = featureDistances(input);

        // Ascending by lineM: bunker front(60), bunker carry(75),
        // green front(140), green center(150), green back(160).
        expect(rows.map((r) => r.kind)).toEqual([
            'hazard_front',
            'hazard_carry',
            'green_front',
            'green_center',
            'green_back',
        ]);
        expect(rows.map((r) => r.lineM)).toEqual([60, 75, 140, 150, 160]);

        // Hazard rows: origin/hazard-edge have no shared elevation sample
        // (hazard ring points carry no elevation) → null propagation.
        expect(rows[0].elevationDeltaM).toBeNull();
        expect(rows[0].playsLikeM).toBeNull();
        expect(rows[1].elevationDeltaM).toBeNull();
        expect(rows[1].playsLikeM).toBeNull();

        // Green rows: both endpoints have elevation → exact deltas.
        const front = rows[2];
        expect(front.elevationDeltaM).toBeCloseTo(4, 9);
        expect(front.playsLikeM).toBeCloseTo(144, 9);
        expect(front.bearingDeg).toBeCloseTo(0, 9);

        const center = rows[3];
        expect(center.elevationDeltaM).toBeCloseTo(5, 9);
        expect(center.playsLikeM).toBeCloseTo(155, 9);

        const back = rows[4];
        expect(back.elevationDeltaM).toBeCloseTo(6, 9);
        expect(back.playsLikeM).toBeCloseTo(166, 9);

        // No wind supplied → every windDeltaM is null, but the list is
        // otherwise fully populated.
        for (const row of rows) expect(row.windDeltaM).toBeNull();

        // Club advice resolved for at least the green rows (playsLike known).
        expect(center.club?.name).toBe('7i'); // exact carry match: playsLike 155 == 7i carryM
    });

    test('wind present → windDeltaM populated on rows with a resolved playsLikeM', () => {
        const wind = { speedMps: 5, directionDeg: 0 }; // dead headwind on bearing 0
        const input: FeatureDistancesInput = { origin, targets, bearingDeg: 0, wind, clubs };
        const rows = featureDistances(input);

        const front = rows.find((r) => r.kind === 'green_front')!;
        const center = rows.find((r) => r.kind === 'green_center')!;
        const back = rows.find((r) => r.kind === 'green_back')!;

        // Plays-as keyed on each row's own plays-like distance via the
        // calibration grid (5 m/s ≈ 11.2 mph head; ~144–166 m ≈ 158–182 yd).
        expect(front.windDeltaM).toBeCloseTo(14.295103779596786, 6);
        expect(center.windDeltaM).toBeCloseTo(15.04437753108553, 6);
        expect(back.windDeltaM).toBeCloseTo(15.480726544160433, 6);

        // Hazard rows still have no playsLikeM (missing elevation), so wind
        // cannot be projected onto them either — stays null even with wind.
        const hazardFront = rows.find((r) => r.kind === 'hazard_front')!;
        const hazardCarry = rows.find((r) => r.kind === 'hazard_carry')!;
        expect(hazardFront.playsLikeM).toBeNull();
        expect(hazardFront.windDeltaM).toBeNull();
        expect(hazardCarry.playsLikeM).toBeNull();
        expect(hazardCarry.windDeltaM).toBeNull();
    });

    test('wind absent → windDeltaM null throughout, list still valid and sorted', () => {
        const input: FeatureDistancesInput = { origin, targets, bearingDeg: 0 };
        const rows = featureDistances(input);

        expect(rows).toHaveLength(5);
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i].lineM).toBeGreaterThanOrEqual(rows[i - 1].lineM);
        }
        for (const row of rows) {
            expect(row.windDeltaM).toBeNull();
            expect(row.club).toBeUndefined(); // no clubs supplied
        }
    });

    test('missing elevation on origin → playsLikeM null but lineM unaffected', () => {
        const flatOrigin = { x: 0, y: 0 }; // no elevation field at all
        const pointTargets: DistanceTarget[] = [
            { kind: 'point', label: 'green center', role: 'green_center', at: { x: 0, y: 150, elevation: 105 } },
        ];
        const input: FeatureDistancesInput = { origin: flatOrigin, targets: pointTargets, bearingDeg: 0 };
        const rows = featureDistances(input);

        expect(rows).toHaveLength(1);
        expect(rows[0].lineM).toBeCloseTo(150, 9);
        expect(rows[0].elevationDeltaM).toBeNull();
        expect(rows[0].playsLikeM).toBeNull();
        expect(rows[0].windDeltaM).toBeNull();
    });

    test('missing elevation on target (elevation: null) → same null propagation', () => {
        const pointTargets: DistanceTarget[] = [
            { kind: 'point', label: 'aim point', role: 'aim', at: { x: 0, y: 100, elevation: null } },
        ];
        const input: FeatureDistancesInput = { origin, targets: pointTargets, bearingDeg: 0 };
        const rows = featureDistances(input);

        expect(rows[0].lineM).toBeCloseTo(100, 9);
        expect(rows[0].elevationDeltaM).toBeNull();
        expect(rows[0].playsLikeM).toBeNull();
    });

    test('a hazard target the line crosses expands into two ordered rows (front then carry)', () => {
        const input: FeatureDistancesInput = {
            origin,
            targets: [{ kind: 'hazard', label: 'creek', ring: bunker }],
            bearingDeg: 0,
        };
        const rows = featureDistances(input);

        expect(rows).toHaveLength(2);
        expect(rows[0].kind).toBe('hazard_front');
        expect(rows[0].label).toBe('creek front');
        expect(rows[0].lineM).toBeCloseTo(60, 9);
        expect(rows[1].kind).toBe('hazard_carry');
        expect(rows[1].label).toBe('creek carry');
        expect(rows[1].lineM).toBeCloseTo(75, 9);
        expect(rows[0].lineM).toBeLessThan(rows[1].lineM);
    });

    test('a hazard the line misses contributes no rows', () => {
        const missedBunker: FlatRing = {
            kind: 'water',
            points: [
                { x: 30, y: 60 },
                { x: 45, y: 60 },
                { x: 45, y: 75 },
                { x: 30, y: 75 },
            ],
        };
        const input: FeatureDistancesInput = {
            origin,
            targets: [{ kind: 'hazard', label: 'pond', ring: missedBunker }],
            bearingDeg: 0,
        };
        expect(featureDistances(input)).toEqual([]);
    });

    test('empty targets → empty list', () => {
        expect(featureDistances({ origin, targets: [], bearingDeg: 0 })).toEqual([]);
    });
});
