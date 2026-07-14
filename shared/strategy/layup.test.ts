import { describe, expect, test } from 'bun:test';
import { layupOptions, longestLayup } from './layup';
import { V1_CLUBS } from './fixtures/v1-clubs';

describe('layupOptions — per-club outcome toward a target', () => {
    test('one option per club, in bag order', () => {
        const opts = layupOptions(V1_CLUBS, 301);
        expect(opts.length).toBe(V1_CLUBS.length);
        expect(opts.map((o) => o.club.name)).toEqual(V1_CLUBS.map((c) => c.name));
    });

    test('green out of range: every club is a layup, remaining = target − carry', () => {
        const opts = layupOptions(V1_CLUBS, 301);
        const driver = opts.find((o) => o.club.name === 'Driver')!;
        expect(driver.reaches).toBe(false);
        expect(driver.carryM).toBe(243);
        expect(driver.remainingM).toBeCloseTo(58, 12); // 301 − 243
        // 58 m left → closest club to 58 is LW (carry 75, |75−58|=17 is smallest).
        expect(driver.approachClub?.name).toBe('LW');
    });

    test('reaching club: reaches=true, no approach club, negative remaining', () => {
        const opts = layupOptions(V1_CLUBS, 150);
        const driver = opts.find((o) => o.club.name === 'Driver')!; // 243 ≥ 150
        expect(driver.reaches).toBe(true);
        expect(driver.approachClub).toBeUndefined();
        expect(driver.remainingM).toBeCloseTo(-93, 12);
    });

    test('exact carry counts as reaching (remaining 0, no approach)', () => {
        const opts = layupOptions(V1_CLUBS, 243);
        const driver = opts.find((o) => o.club.name === 'Driver')!;
        expect(driver.reaches).toBe(true);
        expect(driver.remainingM).toBe(0);
        expect(driver.approachClub).toBeUndefined();
    });

    test('empty bag → no options', () => {
        expect(layupOptions([], 200)).toEqual([]);
    });
});

describe('longestLayup — the max-advance layup', () => {
    test('out-of-range green picks the longest club and what it leaves', () => {
        const l = longestLayup(V1_CLUBS, 301)!;
        expect(l.club.name).toBe('Driver');
        expect(l.remainingM).toBeCloseTo(58, 12);
        expect(l.approachClub?.name).toBe('LW');
    });

    test('undefined when every club reaches the target', () => {
        // Target shorter than the shortest carry (LW carry 10) → all reach.
        expect(longestLayup(V1_CLUBS, 5)).toBeUndefined();
    });

    test('mid target: longest club that stays short wins', () => {
        // 160 m: Driver(243)/3w reach; longest NON-reaching club is 7i (155).
        const l = longestLayup(V1_CLUBS, 160)!;
        expect(l.club.name).toBe('7i');
        expect(l.remainingM).toBeCloseTo(5, 12);
    });

    test('empty bag → undefined', () => {
        expect(longestLayup([], 200)).toBeUndefined();
    });
});
