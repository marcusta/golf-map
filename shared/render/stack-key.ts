// D28 global composition order (amends D24 — see
// docs/decisions-feature-stack-2026-07-08.md): the Roughs group at the
// BOTTOM, then hole groups by ascending hole number, then the course-level
// group, then the roads on TOP; each group internally by `sort_order`.
//
// The ONE definition of that order for every TypeScript producer: the
// server's `geojsonByCourse`, the web's live-edit GeoJSON and the planner's
// lie map. pipeline/gspro.py reads the DB directly and mirrors it in SQL.

/** `course_features.layer` value for the Roughs group (null = hole / course-level). */
export const ROUGHS_LAYER = 'roughs';

export type FeatureLayer = typeof ROUGHS_LAYER | null;

/** The only feature types the Roughs group accepts. */
export const ROUGHS_LAYER_TYPES: readonly string[] = ['outside', 'deep_rough', 'rough', 'semi_rough'];

export function isRoughsLayerType(type: string): boolean {
    return ROUGHS_LAYER_TYPES.includes(type);
}

/**
 * Feature types that always paint on top of everything, whatever their hole
 * or sort order — the roads (and cart paths): the opposite end from the
 * Roughs group. A road runs across roughs, fairways and water alike, and
 * nothing is ever drawn over it.
 */
export const ROADS_TYPES: readonly string[] = ['path'];

/** Per-group span of the global key: a group holds at most this many features. */
export const STACK_GROUP_SPAN = 4096;

/**
 * Course-level group rank: above every hole number. Kept well under 4096 so
 * the largest key stays an exact float32 (MapLibre sort keys).
 */
export const COURSE_GROUP_RANK = 1023;

/** The roads' rank: above the course-level group. */
export const ROADS_GROUP_RANK = COURSE_GROUP_RANK + 1;

/** Rank of a feature's group: Roughs 0, a hole its number, course-level above the holes, roads on top. */
export function stackGroupRank(layer: string | null | undefined, holeNumber: number | null | undefined, type: string): number {
    if (ROADS_TYPES.includes(type)) return ROADS_GROUP_RANK;
    if (layer === ROUGHS_LAYER) return 0;
    return holeNumber ?? COURSE_GROUP_RANK;
}

/** Global paint/hit/lie key: higher = on top. */
export function stackKey(layer: string | null | undefined, holeNumber: number | null | undefined, sortOrder: number, type: string): number {
    return stackGroupRank(layer, holeNumber, type) * STACK_GROUP_SPAN + sortOrder;
}
