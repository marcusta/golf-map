// A vegetation zone's bush height (docs/feature-vegetation-zones.md D-VZ17):
// `heightMin` / `heightMax`, metres, the height the zone's bushes are scaled
// to. Both or neither; absent = the palette's own sizes. Shared by the server
// (validation), the web selection panel and the zones CLI; pipeline/gspro.py
// mirrors the names and the limit (ZONE_HEIGHT_MAX_M).

export const ZONE_HEIGHT_MIN_ATTRIBUTE = 'heightMin';
export const ZONE_HEIGHT_MAX_ATTRIBUTE = 'heightMax';
/** The tallest height a zone can ask for: the height mask's 8 bits hold 12.8 m in 5 cm steps. */
export const ZONE_HEIGHT_LIMIT_M = 12;

export interface ZoneHeight {
    min: number;
    max: number;
}

function isHeight(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= ZONE_HEIGHT_LIMIT_M;
}

/** What is wrong with a zone's height attributes, or null when they are a range or absent. */
export function zoneHeightProblem(attributes: object | null | undefined): string | null {
    const raw = attributes as Record<string, unknown> | null | undefined;
    const min = raw?.[ZONE_HEIGHT_MIN_ATTRIBUTE];
    const max = raw?.[ZONE_HEIGHT_MAX_ATTRIBUTE];
    if (min === undefined && max === undefined) return null;
    if (!isHeight(min) || !isHeight(max) || min > max) {
        return `attributes.${ZONE_HEIGHT_MIN_ATTRIBUTE} and attributes.${ZONE_HEIGHT_MAX_ATTRIBUTE} must both be set, `
            + `metres with 0 < min <= max <= ${ZONE_HEIGHT_LIMIT_M}`;
    }
    return null;
}

/** A zone's bush height from its attributes (null when absent or not a range). */
export function zoneHeightOf(attributes: object | null | undefined): ZoneHeight | null {
    const raw = attributes as Record<string, unknown> | null | undefined;
    const min = raw?.[ZONE_HEIGHT_MIN_ATTRIBUTE];
    const max = raw?.[ZONE_HEIGHT_MAX_ATTRIBUTE];
    return isHeight(min) && isHeight(max) && min <= max ? { min, max } : null;
}

/**
 * The height after one of its two fields was edited: an empty or unusable
 * field clears the height, the first field typed sets both ends, and an end
 * moved past the other takes the other along. Values are clamped to
 * (0, ZONE_HEIGHT_LIMIT_M] and rounded to centimetres.
 */
export function editZoneHeight(current: ZoneHeight | null, end: 'min' | 'max', raw: string): ZoneHeight | null {
    const typed = Number(raw.trim().replace(',', '.'));
    if (raw.trim() === '' || !Number.isFinite(typed) || typed <= 0) return null;
    const value = Math.min(ZONE_HEIGHT_LIMIT_M, Math.round(typed * 100) / 100);
    if (!current) return { min: value, max: value };
    return end === 'min'
        ? { min: value, max: Math.max(current.max, value) }
        : { min: Math.min(current.min, value), max: value };
}

/** `2-3`, `2.5` (one height) or `none` from the CLI: the range, null for none, or an error. */
export function parseZoneHeight(raw: string): { height: ZoneHeight | null } | { error: string } {
    const text = raw.trim();
    if (text === 'none' || text === '') return { height: null };
    const m = /^([0-9]*\.?[0-9]+)(?:\s*-\s*([0-9]*\.?[0-9]+))?$/.exec(text);
    const min = m ? Number(m[1]) : NaN;
    const max = m?.[2] === undefined ? min : Number(m[2]);
    if (!isHeight(min) || !isHeight(max) || min > max) {
        return { error: `"${raw}" is not <min>-<max> metres (0 < min <= max <= ${ZONE_HEIGHT_LIMIT_M}), one height, or none` };
    }
    return { height: { min, max } };
}
