// Feature-type catalogue + golf palette for course-feature rendering.
// FEATURE_TYPES mirrors the server's list (server/services/course-features
// .service.ts) — the server rejects anything else.

import { PATH_SURFACES, PATH_SURFACE_COLORS } from '../../../shared/features/path-surface';

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
    // Lower-vegetation zone (docs/feature-vegetation-zones.md): an authoring
    // overlay for the VSPro masks, not a playing surface. Appended rather
    // than slotted next to `trees` so the digit shortcuts below (the first
    // ten types) keep their bindings; its draw order is TYPE_Z_ORDER's.
    'vegetation_zone',
    // Tree species area (shared/features/tree-areas.ts): which species the
    // Unity tree planter uses for the survey stems inside it. Vegetation mode.
    'tree_area',
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

/**
 * The rules lines — penalty areas and out of bounds. They are stakes and
 * lines, not surfaces, and live with the furniture: drawn and edited in
 * Furniture mode (the draw engine in its `rules` scope), kept out of Draw
 * mode's map, type picker and stack.
 */
export const RULES_TYPES: readonly FeatureType[] = ['penalty_yellow', 'penalty_red', 'oob'];

export function isRulesType(type: string): boolean {
    return (RULES_TYPES as readonly string[]).includes(type);
}

/**
 * The vegetation zones and tree species areas — Unity planting input, not
 * playing surfaces. Drawn and edited in Vegetation mode (the draw engine in its
 * `vegetation` scope) and hidden everywhere else: off the map, out of hit tests,
 * the type picker and the stack. The first is what Vegetation mode draws until
 * the zone-type picker's "Tree species area" is chosen.
 */
export const VEGETATION_TYPES: readonly FeatureType[] = ['vegetation_zone', 'tree_area'];

export function isVegetationType(type: string): boolean {
    return (VEGETATION_TYPES as readonly string[]).includes(type);
}

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
    // Rendered as its boundary line ONLY (see OUTLINE_ONLY_TYPES): all three
    // colours are the same bone white so the palette swatch, the drag ghost
    // and the map line agree on what OOB looks like.
    oob: { label: 'OOB', fill: '#efeae0', draw: '#efeae0', outline: '#efeae0' },
    path: { label: 'Path', fill: '#c2a879', draw: '#cbae75', outline: '#866b47' },
    outside: { label: 'Outside', fill: '#8a8e90', draw: '#7c8286', outline: '#565c61' },
    // Muted olive: a zone is a legend colour at heart (the course's zone-type
    // table owns the real one, see `featureFillColorExpression`), so the
    // palette entry is only the fallback for a zone whose type is gone.
    vegetation_zone: { label: 'Vegetation zone', fill: '#7c8f3a', draw: '#7c8f3a', outline: '#4c5a20' },
    // Autumn oak-brown: reads apart from the olive zones and the dark trees fill.
    tree_area: { label: 'Tree species area', fill: '#a0662e', draw: '#b0703a', outline: '#6b3f16' },
};

/**
 * Feature types authored as a ring but painted as their BOUNDARY ONLY — no
 * fill at all.
 *
 * `oob` is the course boundary: on a real course it is a run of white stakes
 * or a painted white line, and the ring is drawn around the whole property,
 * so filling it would blanket the course in bone white. Its line is also the
 * one outline that survives nice mode — a rules boundary is exactly what you
 * still want to see while planning a shot.
 */
export const OUTLINE_ONLY_TYPES: ReadonlySet<FeatureType> = new Set<FeatureType>(['oob']);

/** Casing/line widths (px) for the {@link OUTLINE_ONLY_TYPES} boundary. */
export const OUTLINE_ONLY_LINE_WIDTH = 2;
/** Dark casing under the white line so it reads over sand and concrete too. */
export const OUTLINE_ONLY_CASING_WIDTH = 4;
export const OUTLINE_ONLY_CASING_COLOR = '#3a4148';

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
    'vegetation_zone',
    'tree_area',
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
    vegetation_zone: null, // an overlay over whatever surface is there
    tree_area: null, // an overlay over whatever surface is there
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

/**
 * Fill colour for the feature overlay: the palette colour by type, except for
 * a `path` with a known surface (PATH_SURFACE_COLORS) and a `vegetation_zone`,
 * which paints in its own zone type's colour from the
 * course's zone-type table (`properties.zoneColor`, written by
 * FeaturesService.toGeojsonFeature). A zone whose type has been deleted has no
 * zoneColor and falls back to the palette's olive.
 */
export function featureFillColorExpression(key: 'fill' | 'draw'): unknown[] {
    const surfaceColors: unknown[] = ['match', ['get', 'surface']];
    for (const surface of PATH_SURFACES) surfaceColors.push(surface, PATH_SURFACE_COLORS[surface]);
    surfaceColors.push(FEATURE_STYLES.path[key]);
    return [
        'case',
        ['all', ['==', ['get', 'type'], 'vegetation_zone'], ['has', 'zoneColor']],
        ['get', 'zoneColor'],
        // A path paints in its surface's colour (properties.surface, from
        // attributes.surface) so asphalt and gravel read apart on the ortho.
        ['all', ['==', ['get', 'type'], 'path'], ['has', 'surface']],
        surfaceColors,
        typeColorExpression(key),
    ];
}
