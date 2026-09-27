// Bank vegetation on a creek (or a `water` polygon: a dug pond or channel):
// tall, uneven grass from the water's edge up the banks to the top of the bank,
// and in clumps out into the water. A creek or water is planted when its
// `bankVeg` attribute names a palette; the generator
// (pipeline/creek_bank_zones.py, run by `bun run grass:zones`) writes
// `vegetation_zone` features of zone type `creek_bank` for every such feature,
// with the palette as the zone's variant. Shared by the server (validation) and
// the web selection panel (picker); the pipeline mirrors the names.

/** The feature types that take bank vegetation (the pipeline's `PLANTABLE_TYPES`). */
export const BANK_VEG_FEATURE_TYPES: readonly string[] = ['water_creek', 'water'];

export function takesBankVeg(type: string): boolean {
    return BANK_VEG_FEATURE_TYPES.includes(type);
}

/** The zone type the creek-bank zones get; its Default mix and variants are the palettes. */
export const CREEK_BANK_ZONE_TYPE = 'creek_bank';

/**
 * The palette: `default` = the `creek_bank` type's Default mix, any other
 * value a variant key of that type. Absent (or '') = the creek is not planted.
 */
export const BANK_VEG_ATTRIBUTE = 'bankVeg';
export const BANK_VEG_DEFAULT = 'default';

/** Share of the water surface the grass covers, 0..1 (the rest stays open water). */
export const BANK_VEG_COVER_ATTRIBUTE = 'bankVegCover';
export const DEFAULT_BANK_VEG_COVER = 0.5;

/** Cap on how far up the bank the grass reaches, metres from the water (the top of the bank is detected; this bounds it). */
export const BANK_VEG_MAX_ATTRIBUTE = 'bankVegMaxM';
export const DEFAULT_BANK_VEG_MAX_M = 4.5;

/**
 * How far up the bank a palette's `_wet` mix (reeds, cattails) reaches, metres
 * from the water; the bank above gets the palette's own mix. Small = the water
 * plants stay in the water and right at its edge.
 */
export const BANK_VEG_WET_ATTRIBUTE = 'bankVegWetM';
export const DEFAULT_BANK_VEG_WET_M = 1;

/**
 * A `creek_bank` variant `<palette>_wet` is that palette's mix for the water and
 * the lower bank (cattails, reeds); the generator splits a creek between the two
 * when it exists. It is not a palette of its own, so pickers leave it out.
 */
export const BANK_VEG_WET_SUFFIX = '_wet';

export function isWetBankVariant(key: string): boolean {
    return key.endsWith(BANK_VEG_WET_SUFFIX);
}

export const BANK_VEG_ATTRIBUTES = [BANK_VEG_ATTRIBUTE, BANK_VEG_COVER_ATTRIBUTE, BANK_VEG_MAX_ATTRIBUTE, BANK_VEG_WET_ATTRIBUTE] as const;

const PALETTE_PATTERN = /^[a-z0-9_]+$/;

/** The creek's palette key when it is planted, else null. */
export function bankVegOf(attributes: object | null | undefined): string | null {
    const value = (attributes as Record<string, unknown> | null | undefined)?.[BANK_VEG_ATTRIBUTE];
    return typeof value === 'string' && PALETTE_PATTERN.test(value) ? value : null;
}

/** The creek's water cover, the default when unset. */
export function bankVegCoverOf(attributes: object | null | undefined): number {
    const value = (attributes as Record<string, unknown> | null | undefined)?.[BANK_VEG_COVER_ATTRIBUTE];
    return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_BANK_VEG_COVER;
}

/** A numeric bank vegetation attribute, `fallback` when unset. */
export function bankVegNumberOf(attributes: object | null | undefined, key: string, fallback: number): number {
    const value = (attributes as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Why the bank vegetation attributes are invalid, or null when they are fine (absent keys are fine). */
export function bankVegProblem(attributes: object | null | undefined): string | null {
    const a = (attributes ?? {}) as Record<string, unknown>;
    const palette = a[BANK_VEG_ATTRIBUTE];
    if (palette !== undefined && palette !== '' && (typeof palette !== 'string' || !PALETTE_PATTERN.test(palette))) {
        return `attributes.${BANK_VEG_ATTRIBUTE} must be '${BANK_VEG_DEFAULT}' or a ${CREEK_BANK_ZONE_TYPE} variant key (lowercase letters, digits, _)`;
    }
    const cover = a[BANK_VEG_COVER_ATTRIBUTE];
    if (cover !== undefined && (typeof cover !== 'number' || !Number.isFinite(cover) || cover < 0 || cover > 1)) {
        return `attributes.${BANK_VEG_COVER_ATTRIBUTE} must be a number between 0 and 1`;
    }
    const max = a[BANK_VEG_MAX_ATTRIBUTE];
    if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max) || max < 0.5 || max > 30)) {
        return `attributes.${BANK_VEG_MAX_ATTRIBUTE} must be a number between 0.5 and 30 (metres)`;
    }
    const wet = a[BANK_VEG_WET_ATTRIBUTE];
    if (wet !== undefined && (typeof wet !== 'number' || !Number.isFinite(wet) || wet < 0 || wet > 10)) {
        return `attributes.${BANK_VEG_WET_ATTRIBUTE} must be a number between 0 and 10 (metres)`;
    }
    return null;
}
