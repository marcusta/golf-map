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
    green: { label: 'Green', fill: '#72dc8e', draw: '#62ef85', outline: '#389657' },
    tee: { label: 'Tee', fill: '#48ad66', draw: '#31d35a', outline: '#287a45' },
    fairway: { label: 'Fairway', fill: '#269343', draw: '#0ba83b', outline: '#1d6c33' },
    semi_rough: { label: 'Semi rough', fill: '#79a550', draw: '#91b849', outline: '#4d7433' },
    rough: { label: 'Rough', fill: '#48732e', draw: '#4d7f24', outline: '#2f5420' },
    deep_rough: { label: 'Deep rough', fill: '#294f23', draw: '#244b1d', outline: '#193b17' },
    trees: { label: 'Trees', fill: '#173d27', draw: '#103c23', outline: '#0e2b19' },
    bunker: { label: 'Bunker', fill: '#ead18b', draw: '#f0cf70', outline: '#b68f39' },
    water: { label: 'Water', fill: '#367fcc', draw: '#2088e8', outline: '#235d9e' },
    water_creek: { label: 'Creek', fill: '#65abe0', draw: '#62baf4', outline: '#367ba9' },
    penalty_yellow: { label: 'Yellow penalty', fill: '#f6d94c', draw: '#f6d94c', outline: '#d8a800' },
    penalty_red: { label: 'Red penalty', fill: '#ef5b5b', draw: '#ef5b5b', outline: '#bf2727' },
    oob: { label: 'OOB', fill: '#f5f5f0', draw: '#f5f5f0', outline: '#1f2933' },
    path: { label: 'Path', fill: '#b49a70', draw: '#c1a06b', outline: '#796044' },
    outside: { label: 'Outside', fill: '#7f8994', draw: '#6f7c89', outline: '#525d68' },
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
