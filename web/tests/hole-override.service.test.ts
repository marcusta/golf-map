import { describe, test, expect } from 'bun:test';
import {
    HoleOverrideService,
    suggestedHole,
    type HoleOverride,
} from '../src/mobile/course/hole-override.service';

const COURSE = 'course-1';

function suggest(
    currentHole: number,
    nearestHole: number | null,
    override: HoleOverride | null = null,
    courseId = COURSE,
): number | null {
    return suggestedHole({ courseId, currentHole, nearestHole, override });
}

describe('suggestedHole — nearest-hole banner precedence', () => {
    test('suggests the nearest hole when it differs from the one on screen', () => {
        expect(suggest(3, 7)).toBe(7);
    });

    test('stays silent without a GPS fix, or when already on the nearest hole', () => {
        expect(suggest(3, null)).toBeNull();
        expect(suggest(7, 7)).toBeNull();
    });

    test('a manual choice suppresses the suggestion it overruled', () => {
        // Player is near hole 3's green but jumps to hole 5 by hand.
        const override: HoleOverride = { courseId: COURSE, nearestAtChoice: 3 };
        expect(suggest(5, 3, override)).toBeNull();
    });

    test('the suppression survives repeated GPS ticks at the same nearest hole', () => {
        const override: HoleOverride = { courseId: COURSE, nearestAtChoice: 3 };
        for (let tick = 0; tick < 5; tick++) expect(suggest(5, 3, override)).toBeNull();
    });

    test('a NEW nearest hole re-enables the suggestion (manual choice is spent)', () => {
        const override: HoleOverride = { courseId: COURSE, nearestAtChoice: 3 };
        // The player walked on: GPS now reads hole 4 as nearest.
        expect(suggest(5, 4, override)).toBe(4);
    });

    test('an override from another course does not suppress this one', () => {
        const override: HoleOverride = { courseId: 'other-course', nearestAtChoice: 3 };
        expect(suggest(5, 3, override)).toBe(3);
    });

    test('a choice made before any fix is spent by the first real nearest hole', () => {
        const override: HoleOverride = { courseId: COURSE, nearestAtChoice: null };
        expect(suggest(5, 3, override)).toBe(3);
    });

    test('manual choice still wins when the nearest hole equals the current one', () => {
        // Accepting the suggestion lands us ON the nearest hole — nothing left.
        const override: HoleOverride = { courseId: COURSE, nearestAtChoice: 7 };
        expect(suggest(7, 7, override)).toBeNull();
    });
});

describe('HoleOverrideService — survives the component it was set from', () => {
    test('note() records the nearest-hole reading the choice overruled', () => {
        const svc = new HoleOverrideService();
        expect(svc.override.get()).toBeNull();

        svc.note(COURSE, 3);

        expect(svc.override.get()).toEqual({ courseId: COURSE, nearestAtChoice: 3 });
    });

    test('the recorded override drives suggestedHole across a navigation', () => {
        const svc = new HoleOverrideService();
        // Hole screen instance A: nearest is 3, user taps hole 5 in the strip.
        svc.note(COURSE, 3);
        // $swap destroys A and builds instance B on /m/course/course-1/hole/5.
        // B reads the SAME singleton, so the banner stays suppressed — the bug
        // this service exists to fix (a component-local flag reset to false).
        expect(suggestedHole({
            courseId: COURSE,
            currentHole: 5,
            nearestHole: 3,
            override: svc.override.get(),
        })).toBeNull();
    });

    test('the latest choice replaces the previous one', () => {
        const svc = new HoleOverrideService();
        svc.note(COURSE, 3);
        svc.note(COURSE, 4);

        expect(svc.override.get()?.nearestAtChoice).toBe(4);
        // The older suppression is gone: nearest 3 suggests again.
        expect(suggest(5, 3, svc.override.get())).toBe(3);
    });

    test('clear() forgets the override', () => {
        const svc = new HoleOverrideService();
        svc.note(COURSE, 3);
        svc.clear();

        expect(svc.override.get()).toBeNull();
        expect(suggest(5, 3, svc.override.get())).toBe(3);
    });
});
