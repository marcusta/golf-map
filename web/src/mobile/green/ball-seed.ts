// Seeding the BALL from the GPS fix (S3.3). Split out of the component so the
// "which marker does the fix move" rule is testable without a map.

import type { Vec2 } from '../../../../shared/strategy';

/**
 * The slice of PuttReadService this needs — `PuttReadService` satisfies it
 * structurally; tests pass a two-signal fake.
 */
export interface BallSeedPort {
    ball: { peek(): Vec2 | null };
    hole: { peek(): Vec2 | null };
    placing: { peek(): 'ball' | 'hole' | 'none' };
    placeBall(p: Vec2): void;
    setPlacing(which: 'ball' | 'hole' | 'none'): void;
}

/**
 * Put the player's position under the BALL — never the hole. Deliberately not
 * `placeNext`: that places whichever marker the segmented control selects, so a
 * player who tapped "Hole", dropped the cup and had not yet placed a ball would
 * get the hole yanked to their feet by the first in-green fix.
 *
 * Mirrors `placeNext`'s one-shot hand-off: seeding the ball consumes an armed
 * 'ball' target, advancing to 'hole' only while the cup is genuinely unplaced
 * and disarming otherwise. No-ops once a ball exists — the fix must never
 * overwrite a placed marker.
 *
 * Returns true when it seeded (callers latch on that: one seed per mount).
 */
export function seedBallFromFix(putt: BallSeedPort, p: Vec2): boolean {
    if (putt.ball.peek() !== null) return false;
    putt.placeBall(p);
    if (putt.placing.peek() === 'ball') {
        putt.setPlacing(putt.hole.peek() === null ? 'hole' : 'none');
    }
    return true;
}
