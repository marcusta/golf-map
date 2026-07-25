import { Signal } from '@basics/core/client/core';

/** A remembered manual hole choice, scoped to the course it was made on. */
export interface HoleOverride {
    courseId: string;
    /**
     * The GPS nearest-hole value at the moment the user picked a hole by hand
     * (null when no fix had arrived yet). This — not the hole they picked — is
     * what the suppression keys on: the choice overrules *that* suggestion, and
     * only that one.
     */
    nearestAtChoice: number | null;
}

export interface SuggestionInput {
    courseId: string;
    currentHole: number;
    /** Hole whose green is closest to the current GPS fix, or null. */
    nearestHole: number | null;
    override: HoleOverride | null;
}

/**
 * Precedence rule for the nearest-hole auto-advance banner.
 *
 * A manual hole choice always wins, but only over the suggestion it dismissed:
 * suppression is keyed on the nearest-hole value that was live when the choice
 * was made. Once the player walks on and GPS reports a DIFFERENT nearest hole,
 * suggesting again is legitimate (they finished the hole they jumped to).
 *
 * Returns the hole to suggest, or null for "show nothing".
 */
export function suggestedHole(input: SuggestionInput): number | null {
    const { courseId, currentHole, nearestHole, override } = input;
    if (nearestHole === null) return null;
    // Already looking at it — nothing to advance to.
    if (nearestHole === currentHole) return null;
    // A manual choice on THIS course silences the suggestion it overruled.
    if (override && override.courseId === courseId && override.nearestAtChoice === nearestHole) {
        return null;
    }
    return nearestHole;
}

/**
 * Holds the manual hole choice ACROSS navigations. The hole screen is
 * destroyed and rebuilt by `$swap` on every route change, so component-local
 * state cannot survive the very navigation it is meant to remember — this DI
 * singleton can. Deliberately tiny and mobile-scoped; the desktop app has no
 * equivalent notion.
 */
export class HoleOverrideService {
    readonly override = new Signal<HoleOverride | null>(null);

    /** Record a manual hole pick against the nearest-hole reading it overruled. */
    note(courseId: string, nearestAtChoice: number | null): void {
        this.override.set({ courseId, nearestAtChoice });
    }

    /** Forget the override (e.g. leaving the course). */
    clear(): void {
        this.override.set(null);
    }
}
