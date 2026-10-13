// A course's tee sets and the eight slots GreenKeeper/GSPro have for them.
// The app's sets are free-form (a set is whatever the course calls it); a
// GKD holds Black, White, Green, Blue, Yellow, Red, Junior and Par3, each
// with one `<course rating>/<slope>`. `gkdTeeType` is the same name-then-
// colour match `gspro.py` places the tee boxes by (GKD_TEE_ALIASES there —
// keep the two in step).

export const GKD_TEE_TYPES = ['Black', 'White', 'Green', 'Blue', 'Yellow', 'Red', 'Junior', 'Par3'] as const;
export type GkdTeeType = typeof GKD_TEE_TYPES[number];

const GKD_TEE_ALIASES: Record<string, GkdTeeType> = {
    black: 'Black', championship: 'Black', tiger: 'Black',
    white: 'White', men: 'White', mens: 'White',
    green: 'Green',
    blue: 'Blue',
    yellow: 'Yellow',
    red: 'Red', ladies: 'Red', women: 'Red',
    junior: 'Junior', juniors: 'Junior', kids: 'Junior',
    par3: 'Par3', 'par 3': 'Par3',
};

/** The GKD tee set for one of the app's, by its name first and then its colour; null when neither is one of the eight. */
export function gkdTeeType(name: string | null, color: string | null): GkdTeeType | null {
    for (const raw of [name, color]) {
        const hit = GKD_TEE_ALIASES[(raw ?? '').trim().toLowerCase()];
        if (hit) return hit;
    }
    return null;
}

/** Which of a set's two ratings GSPro shows (a GKD holds one per set). */
export type TeeSetGender = 'men' | 'women';

/** `73.4/139`, as a GKD's `<set>SR` spells a rating; null when either half is missing. */
export function gkdRating(rating: number | null, slope: number | null): string | null {
    return rating === null || slope === null ? null : `${rating.toFixed(1)}/${Math.round(slope)}`;
}

/** A GKD `<set>SR` back as numbers; null for `0.0/0` (not rated) or anything else. */
export function parseGkdRating(text: unknown): { rating: number; slope: number } | null {
    const m = typeof text === 'string' ? /^(\d{1,3}(?:\.\d+)?)\/(\d{1,3})$/.exec(text.trim()) : null;
    if (!m) return null;
    const rating = Number(m[1]), slope = Number(m[2]);
    return rating > 0 && slope > 0 ? { rating, slope } : null;
}

/** The GKD key of a tee set's rating: `WhiteSR`, and `PAR3SR` for Par3. */
export function gkdRatingKey(type: GkdTeeType): string {
    return `${type === 'Par3' ? 'PAR3' : type}SR`;
}
