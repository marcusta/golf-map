// Mobile-local copy of the draw feature palette, kept here because the mobile
// bundle must NOT import from draw/ (the import-boundary test enforces this,
// and draw/feature-palette.ts is frozen by an iOS golden). These values are
// COPIED from web/src/draw/feature-palette.ts (FEATURE_STYLES + TYPE_Z_ORDER)
// for READ-ONLY rendering of the resolved course-feature GeoJSON. Change them
// together with the source palette, by feature type.

/** Fill + outline hex per feature type (fill/outline from FEATURE_STYLES). */
const FEATURE_FILL: Record<string, string> = {
    green: '#7fc489',
    tee: '#5fa76e',
    fairway: '#4c9256',
    semi_rough: '#7e9e56',
    rough: '#566e3a',
    deep_rough: '#3c5730',
    trees: '#24402b',
    bunker: '#e1cc93',
    water: '#4c8fbe',
    water_creek: '#77aed2',
    penalty_yellow: '#e8cb56',
    penalty_red: '#de6152',
    oob: '#efeae0',
    path: '#c2a879',
    outside: '#8a8e90',
};

const FEATURE_OUTLINE: Record<string, string> = {
    green: '#3f7a55',
    tee: '#34734a',
    fairway: '#2c6b3b',
    semi_rough: '#4c6e37',
    rough: '#384e23',
    deep_rough: '#26381c',
    trees: '#142619',
    bunker: '#b0894a',
    water: '#2e6389',
    water_creek: '#3f7ba0',
    penalty_yellow: '#c39a2e',
    penalty_red: '#b0402e',
    oob: '#3a4148',
    path: '#866b47',
    outside: '#565c61',
};

/** Bottom → top draw order (copied from draw TYPE_Z_ORDER). */
const TYPE_Z_ORDER: readonly string[] = [
    'outside', 'deep_rough', 'rough', 'semi_rough', 'fairway', 'tee', 'green',
    'trees', 'bunker', 'water', 'water_creek', 'penalty_yellow', 'penalty_red',
    'oob', 'path',
];

/** MapLibre `match` on the feature `type` property → fill color. */
export function fillColorExpression(): unknown[] {
    const expr: unknown[] = ['match', ['get', 'type']];
    for (const [type, color] of Object.entries(FEATURE_FILL)) expr.push(type, color);
    expr.push('#888888');
    return expr;
}

/** MapLibre `match` on the feature `type` property → outline color. */
export function outlineColorExpression(): unknown[] {
    const expr: unknown[] = ['match', ['get', 'type']];
    for (const [type, color] of Object.entries(FEATURE_OUTLINE)) expr.push(type, color);
    expr.push('#555555');
    return expr;
}

/**
 * Draw-order sort key from the feature `type` — falls back to the server's
 * `stackKey` for intra-type ordering (hole grouping) via a compound never
 * needed at paint time; here type-rank alone matches the desktop layering
 * closely enough for a read-only view. Unknown types sink below everything.
 */
export function typeSortKeyExpression(): unknown[] {
    const expr: unknown[] = ['match', ['get', 'type']];
    TYPE_Z_ORDER.forEach((type, i) => expr.push(type, i));
    expr.push(-1);
    return expr;
}
