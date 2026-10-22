// GSPro's "no as it lies" (the GKD hazard's `noAIL`: a ball inside the line must be dropped), kept per line on the
// features the course file's hazard lines come from (`gspro.py gkd` / `gkd-lines`): `noAsItLies: true` on a
// penalty_red / penalty_yellow sets it on that drawn line, on a water / water_creek on the automatic line staked
// round it (any of the waters that line holds). Absent or false = played as it lies, the default. Shared by
// Furniture › Rules lines and `bun run gkd:lines`.

export const NO_AS_IT_LIES_ATTRIBUTE = 'noAsItLies';

/** The feature types the attribute means something on. */
export const NO_AS_IT_LIES_TYPES: readonly string[] = ['penalty_red', 'penalty_yellow', 'water', 'water_creek'];

type Attributes = Record<string, number | string | boolean>;

/** Whether the feature's attributes ask for "no as it lies" (only a literal `true` does). */
export function noAsItLiesOf(attributes: unknown): boolean {
    return !!attributes && typeof attributes === 'object' && (attributes as Record<string, unknown>)[NO_AS_IT_LIES_ATTRIBUTE] === true;
}

/**
 * The attributes with "no as it lies" on (`true`) or off (the key dropped, so a line back at the default stores
 * nothing); null when nothing else is left. The other keys are kept as they are.
 */
export function withNoAsItLies(attributes: unknown, on: boolean): Attributes | null {
    const next: Attributes = { ...((attributes ?? {}) as Attributes) };
    if (on) next[NO_AS_IT_LIES_ATTRIBUTE] = true;
    else delete next[NO_AS_IT_LIES_ATTRIBUTE];
    return Object.keys(next).length ? next : null;
}

/** The hole a drawn line round these waters goes on: theirs when they all share one, else course level (null). */
export function holeOfWaters(waters: ReadonlyArray<{ holeId: string | null }>): string | null {
    const holes = new Set(waters.map(w => w.holeId));
    return holes.size === 1 ? [...holes][0]! : null;
}
