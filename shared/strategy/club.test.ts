import { describe, expect, test } from 'bun:test';
import {
    clubAdvice,
    closestClub,
    lengthDispersionM,
    maxCarryM,
    maxDispersionM,
    minCarryM,
    minDispersionM,
    suggestClubForHole,
} from './club';
import { V1_CLUBS, v1Club } from './fixtures/v1-clubs';

describe('lengthDispersionM — v1 tier rules', () => {
    test('tier edges: 150 inclusive → 6%, 100 inclusive → 6%', () => {
        expect(lengthDispersionM(150)).toBeCloseTo(150 * 0.06, 12); // 9
        expect(lengthDispersionM(100)).toBeCloseTo(100 * 0.06, 12); // 6
        expect(lengthDispersionM(99.999)).toBeCloseTo(99.999 * 0.05, 12);
        expect(lengthDispersionM(150.001)).toBeCloseTo(150.001 * 0.08, 12);
    });

    test('matches every derived value in the v1 clubs table', () => {
        const expected: Record<string, number> = {
            Driver: 19.44,
            '3w': 17.6,
            '3h': 16.0,
            '4i': 14.96,
            '5i': 14.16,
            '6i': 13.44,
            '7i': 12.4,
            // NOTE: the recon spec's table says 11.36 for 8i (142 m), but that is
            // 142 × 8% — a table typo. 142 is inside the 100…150 inclusive tier
            // per the spec's own v1 code snippet (GolfClub.swift:9–18) → 6%.
            '8i': 8.52,
            '9i': 7.62,
            PW: 6.9,
            '50': 6.0,
            '54': 4.5,
            LW: 3.75,
        };
        for (const club of V1_CLUBS) {
            expect(lengthDispersionM(club.carryM)).toBeCloseTo(expected[club.name], 9);
        }
    });
});

describe('min/max carry and dispersion — band first, wind on banded value', () => {
    test('fixture A: Driver, effect −0.10', () => {
        expect(maxCarryM(243, -0.1)).toBeCloseTo(229.635, 9);
        expect(minCarryM(243, -0.1)).toBeCloseTo(207.765, 9);
    });

    test('no wind: pure ±5% / ±4% bands', () => {
        expect(minCarryM(200, 0)).toBeCloseTo(190, 12);
        expect(maxCarryM(200, 0)).toBeCloseTo(210, 12);
        expect(minDispersionM(50, 0)).toBeCloseTo(48, 12);
        expect(maxDispersionM(50, 0)).toBeCloseTo(52, 12);
    });

    test('dispersion bands scale with wind effect', () => {
        expect(minDispersionM(50, 0.1)).toBeCloseTo(50 * 0.96 * 1.1, 12);
        expect(maxDispersionM(50, -0.1)).toBeCloseTo(50 * 1.04 * 0.9, 12);
    });
});

describe('club selection helpers', () => {
    test('closestClub: min |carry − d|', () => {
        expect(closestClub(V1_CLUBS, 150)?.name).toBe('7i'); // |155−150|=5 beats |142−150|=8
        expect(closestClub(V1_CLUBS, 240)?.name).toBe('Driver');
        expect(closestClub(V1_CLUBS, 10)?.name).toBe('LW');
        expect(closestClub([], 100)).toBeUndefined();
    });

    test('closestClub tie keeps the earlier club (v1 min(by:) semantics)', () => {
        const clubs = [
            { name: 'A', carryM: 90, dispersionM: 10 },
            { name: 'B', carryM: 110, dispersionM: 10 },
        ];
        expect(closestClub(clubs, 100)?.name).toBe('A');
    });

    test('fixture D advice at plays-as 163.0434783 m: front 6i, center 6i, back 7i', () => {
        const advice = clubAdvice(V1_CLUBS, 150 / 0.92);
        expect(advice.front?.name).toBe('6i');
        expect(advice.center?.name).toBe('6i');
        expect(advice.back?.name).toBe('7i');
    });

    test('advice extremes: nothing reaches / nothing stays short', () => {
        const beyond = clubAdvice(V1_CLUBS, 300);
        expect(beyond.front).toBeUndefined();
        expect(beyond.back?.name).toBe('Driver');
        expect(beyond.center?.name).toBe('Driver');

        const tiny = clubAdvice(V1_CLUBS, 10);
        expect(tiny.front?.name).toBe('LW');
        expect(tiny.back).toBeUndefined();
        expect(tiny.center?.name).toBe('LW');
    });

    test('advice with exact carry: club appears as front AND back', () => {
        const advice = clubAdvice(V1_CLUBS, 155);
        expect(advice.front?.name).toBe('7i');
        expect(advice.center?.name).toBe('7i');
        expect(advice.back?.name).toBe('7i');
    });

    test('suggestClubForHole: longest when out of reach, else closest', () => {
        expect(suggestClubForHole(V1_CLUBS, 400)?.name).toBe('Driver');
        expect(suggestClubForHole(V1_CLUBS, 243)?.name).toBe('Driver'); // not > longest → closest
        expect(suggestClubForHole(V1_CLUBS, 160)?.name).toBe('7i');
        expect(suggestClubForHole([], 160)).toBeUndefined();
    });
});

describe('v1 clubs fixture', () => {
    test('has the 13 v1 clubs', () => {
        expect(V1_CLUBS.length).toBe(13);
        expect(v1Club('Driver')).toEqual({ name: 'Driver', carryM: 243, dispersionM: 65 });
        expect(() => v1Club('2i')).toThrow();
    });
});
