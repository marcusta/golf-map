// Feature-type catalogue + golf palette for course-feature rendering.
// FEATURE_TYPES mirrors the server's list (server/services/course-features
// .service.ts) — the server rejects anything else.

export const FEATURE_TYPES = [
    'tee',
    'fairway',
    'green',
    'bunker',
    'semi_rough',
    'rough',
    'deep_rough',
    'water',
    'water_creek',
    'path',
    'outside',
] as const;

export type FeatureType = (typeof FEATURE_TYPES)[number];

export interface FeatureStyle {
    /** Human label for pickers. */
    label: string;
    /** Fill color (semi-transparent fill is applied via fill-opacity). */
    fill: string;
    /** Outline color (full strength). */
    outline: string;
}

/** Golf palette: greens light, fairway mid, roughs darkening, sand, blues. */
export const FEATURE_STYLES: Record<FeatureType, FeatureStyle> = {
    green: { label: 'Green', fill: '#8fe0a0', outline: '#4fa863' },
    tee: { label: 'Tee', fill: '#63b578', outline: '#3c8a52' },
    fairway: { label: 'Fairway', fill: '#4d9e58', outline: '#2f7d43' },
    semi_rough: { label: 'Semi rough', fill: '#79a860', outline: '#557f41' },
    rough: { label: 'Rough', fill: '#55803f', outline: '#3b5f2b' },
    deep_rough: { label: 'Deep rough', fill: '#3c5c2e', outline: '#294420' },
    bunker: { label: 'Bunker', fill: '#e9d8a0', outline: '#c4a95e' },
    water: { label: 'Water', fill: '#4f8fd0', outline: '#2f6aa8' },
    water_creek: { label: 'Creek', fill: '#6fb1e0', outline: '#4585b8' },
    path: { label: 'Path', fill: '#b6a68d', outline: '#8f7f66' },
    outside: { label: 'Outside', fill: '#9097a0', outline: '#6a7178' },
};

/** Selected-feature highlight color (outline + handles). */
export const SELECTION_COLOR = '#ffd43b';

/**
 * MapLibre `match` expression on the feature's `type` property → color.
 * `key` picks fill or outline colors; unknown types fall back to gray.
 */
export function typeColorExpression(key: 'fill' | 'outline'): unknown[] {
    const expr: unknown[] = ['match', ['get', 'type']];
    for (const type of FEATURE_TYPES) {
        expr.push(type, FEATURE_STYLES[type][key]);
    }
    expr.push('#888888'); // fallback
    return expr;
}
