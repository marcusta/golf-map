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
    'trees',
    'water',
    'water_creek',
    'penalty_yellow',
    'penalty_red',
    'oob',
    'path',
    'outside',
] as const;

export type FeatureType = (typeof FEATURE_TYPES)[number];

/**
 * Keyboard digit → draw feature type. Digits follow panel order
 * (`FEATURE_TYPES` above): `1`–`9` arm the first nine types (tee…water) and
 * `0` arms the tenth (water_creek). The remaining rules/misc types
 * (penalty_yellow, penalty_red, oob, path, outside) stay panel-only — no
 * digit binding. Shared by the command-bar feature panel (digit badges) and
 * `DrawToolService.onKeyDown` (bare-digit arm/retype) so the two never drift.
 */
export const DIGIT_FEATURE_TYPES: Readonly<Record<string, FeatureType>> = {
    '1': 'tee',
    '2': 'fairway',
    '3': 'green',
    '4': 'bunker',
    '5': 'semi_rough',
    '6': 'rough',
    '7': 'deep_rough',
    '8': 'trees',
    '9': 'water',
    '0': 'water_creek',
};

/** Reverse of {@link DIGIT_FEATURE_TYPES}: feature type → its digit badge, if any. */
export function digitForFeatureType(type: FeatureType): string | undefined {
    for (const [digit, mapped] of Object.entries(DIGIT_FEATURE_TYPES)) {
        if (mapped === type) return digit;
    }
    return undefined;
}

export interface FeatureStyle {
    /** Human label for pickers. */
    label: string;
    /** Fill color (semi-transparent fill is applied via fill-opacity). */
    fill: string;
    /** High-contrast fill used only while actively drawing/editing. */
    draw: string;
    /** Outline color (full strength). */
    outline: string;
}

/** Golf palette: greens light, fairway mid, roughs darkening, sand, blues. */
export const FEATURE_STYLES: Record<FeatureType, FeatureStyle> = {
    green: { label: 'Green', fill: '#7fc489', draw: '#97d79b', outline: '#3f7a55' },
    tee: { label: 'Tee', fill: '#5fa76e', draw: '#6fc07e', outline: '#34734a' },
    fairway: { label: 'Fairway', fill: '#4c9256', draw: '#4fa85e', outline: '#2c6b3b' },
    semi_rough: { label: 'Semi rough', fill: '#7e9e56', draw: '#8fb157', outline: '#4c6e37' },
    rough: { label: 'Rough', fill: '#566e3a', draw: '#5f7c34', outline: '#384e23' },
    deep_rough: { label: 'Deep rough', fill: '#3c5730', draw: '#3e5a28', outline: '#26381c' },
    trees: { label: 'Trees', fill: '#24402b', draw: '#1e3c26', outline: '#142619' },
    bunker: { label: 'Bunker', fill: '#e1cc93', draw: '#ecd588', outline: '#b0894a' },
    water: { label: 'Water', fill: '#4c8fbe', draw: '#3e93d0', outline: '#2e6389' },
    water_creek: { label: 'Creek', fill: '#77aed2', draw: '#6fb6e0', outline: '#3f7ba0' },
    penalty_yellow: { label: 'Yellow penalty', fill: '#e8cb56', draw: '#e8cb56', outline: '#c39a2e' },
    penalty_red: { label: 'Red penalty', fill: '#de6152', draw: '#de6152', outline: '#b0402e' },
    oob: { label: 'OOB', fill: '#efeae0', draw: '#efeae0', outline: '#3a4148' },
    path: { label: 'Path', fill: '#c2a879', draw: '#cbae75', outline: '#866b47' },
    outside: { label: 'Outside', fill: '#8a8e90', draw: '#7c8286', outline: '#565c61' },
};

/** Selected-feature highlight color (outline + handles). */
export const SELECTION_COLOR = '#ffd43b';

/** Raw vector-fill opacity while tracing or dragging in the draw tool. */
export const DRAW_FILL_OPACITY = 0.86;

/** Photo visibility in the stroke-free planning/nice view. */
export const NICE_FILL_OPACITY = 0.4;

/**
 * Fixed golf z-ordering of feature TYPES, bottom → top: broad ground types
 * first, small features (bunkers, water, paths) on top. Per D26 this is now
 * a HEURISTIC ONLY, consulted by the server on feature `create()` to pick
 * where a new shape lands in its group's explicit `sort_order` stack — it is
 * no longer consulted at render/hit/lie time (that's D23's stack order, see
 * `CourseFeature.sortOrder`/`stackKey`). `typeSortKeyExpression()` below
 * survives only for legacy iOS rendering until T27 ports the stack-key
 * expression there.
 */
export const TYPE_Z_ORDER: readonly FeatureType[] = [
    'outside',
    'deep_rough',
    'rough',
    'semi_rough',
    'fairway',
    'tee',
    'green',
    'trees',
    'bunker',
    'water',
    'water_creek',
    'penalty_yellow',
    'penalty_red',
    'oob',
    'path',
];

/** MapLibre expression: feature `type` property → z-order sort key. */
export function typeSortKeyExpression(): unknown[] {
    const expr: unknown[] = ['match', ['get', 'type']];
    TYPE_Z_ORDER.forEach((type, i) => expr.push(type, i));
    expr.push(-1); // unknown types render below everything
    return expr;
}

/**
 * Auto-surround pairings (ported from the golf-map-2 prototype editor,
 * types.ts): source feature type → the type that should surround it and
 * how far the surround extends beyond the source outline. null = no
 * surround makes golf sense for that type.
 */
export const SURROUND_PAIRINGS: Record<FeatureType, { targetType: FeatureType; expandAmount: number } | null> = {
    tee: { targetType: 'semi_rough', expandAmount: 0.5 },
    fairway: { targetType: 'semi_rough', expandAmount: 1 },
    green: { targetType: 'fairway', expandAmount: 0.5 },
    semi_rough: { targetType: 'rough', expandAmount: 5 },
    rough: { targetType: 'deep_rough', expandAmount: 8 },
    bunker: null, // no surround for bunkers
    water: null, // no surround for water
    water_creek: null, // no surround for creeks
    trees: null, // trees overlay the underlying surface
    penalty_yellow: null, // rules overlays don't imply a surface surround
    penalty_red: null, // rules overlays don't imply a surface surround
    oob: null, // rules overlays don't imply a surface surround
    deep_rough: null, // already the outermost grass type
    path: null, // no surround for paths
    outside: null, // no surround for outside
};

/**
 * MapLibre `match` expression on the feature's `type` property → color.
 * `key` picks fill or outline colors; unknown types fall back to gray.
 */
export function typeColorExpression(key: 'fill' | 'draw' | 'outline'): unknown[] {
    const expr: unknown[] = ['match', ['get', 'type']];
    for (const type of FEATURE_TYPES) {
        expr.push(type, FEATURE_STYLES[type][key]);
    }
    expr.push('#888888'); // fallback
    return expr;
}
