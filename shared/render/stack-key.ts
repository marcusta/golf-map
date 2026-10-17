// D28 global composition order (amends D24 — see
// docs/decisions-feature-stack-2026-07-08.md): the Roughs group at the
// BOTTOM, then playable holes with named groups inserted between them (D30), then the course-level
// group, then the roads on TOP, ranked by surface (D33); each group
// internally by `sort_order`.
//
// The ONE definition of that order for every TypeScript producer: the
// server's `geojsonByCourse`, the web's live-edit GeoJSON and the planner's
// lie map. pipeline/gspro.py reads the DB directly and mirrors it in SQL
// (except the roads' surface rank: the export merges the roads into one shape
// and the Blender step applies the rank, shape_surfaces.py RANK).

import { PATH_SURFACE_ATTRIBUTE, pathSurfaceOf, type PathSurface } from '../features/path-surface';

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

/**
 * D33: among the roads the surface decides, not the drawing order — the same
 * rank the export's Blender step cuts a mixed road mesh by
 * (blender/tools/shape_surfaces.py RANK, keep the two equal), so a gravel road
 * drawn into an asphalt one stops at the asphalt kerb on the map as in GSPro.
 * Highest first; a gravel track is gravel; grass tracks and roads of unknown
 * surface go under every known one. `sort_order` orders roads of one surface.
 */
export const ROAD_SURFACE_RANK: readonly PathSurface[] = ['asphalt', 'concrete', 'paving', 'wood', 'gravel', 'dirt', 'grass'];

/** A road's tier above ROADS_GROUP_RANK: unknown 0, the top surface highest. */
export function roadSurfaceTier(attributes: object | null | undefined): number {
    const raw = (attributes as Record<string, unknown> | null | undefined)?.[PATH_SURFACE_ATTRIBUTE];
    const surface = raw === 'gravel-track' ? 'gravel' : pathSurfaceOf(attributes);
    const index = surface ? ROAD_SURFACE_RANK.indexOf(surface) : -1;
    return index === -1 ? 0 : ROAD_SURFACE_RANK.length - index;
}

export interface DrawScopeOrder {
    id: string;
    number: number;
    drawingGroupName?: string | null;
    drawingGroupAfter?: number | null;
    drawingGroupOrder?: number | null;
    drawingStackOrder?: number | null;
}

/** Insert named groups between holes without changing hole/mesh numbers.
 * Each scope has an integer rank, leaving its full 4096 feature slots free.
 * Mirrored by pipeline/gspro.py's _group_rank_sql. */
export function drawScopeRanks(scopes: readonly DrawScopeOrder[]): Map<string, number> {
    const groups = scopes.filter(h => h.drawingGroupName)
        .sort((a, b) => (a.drawingGroupAfter ?? 98) - (b.drawingGroupAfter ?? 98)
            || (a.drawingGroupOrder ?? a.number) - (b.drawingGroupOrder ?? b.number) || a.number - b.number);
    const ranks = new Map<string, number>();
    for (const hole of scopes) {
        if (!hole.drawingGroupName) ranks.set(hole.id, hole.number + groups.filter(g => (g.drawingGroupAfter ?? 98) < hole.number).length);
    }
    groups.forEach((group, i) => ranks.set(group.id, (group.drawingGroupAfter ?? 98) + i + 1));
    for (const scope of scopes) if (scope.drawingStackOrder != null) ranks.set(scope.id, scope.drawingStackOrder);
    return ranks;
}

/** Rank of a feature's group: Roughs 0, a hole/group's drawScopeRanks value,
 * course-level above every scope, roads on top (by surface, D33). Without
 * drawing groups a playable hole's rank is its number, preserving the
 * original keys. */
export function stackGroupRank(layer: string | null | undefined, scopeRank: number | null | undefined, type: string, attributes?: object | null): number {
    if (ROADS_TYPES.includes(type)) return ROADS_GROUP_RANK + roadSurfaceTier(attributes);
    if (layer === ROUGHS_LAYER) return 0;
    return scopeRank ?? COURSE_GROUP_RANK;
}

/** Global paint/hit/lie key: higher = on top. `attributes` carries a road's surface. */
export function stackKey(layer: string | null | undefined, scopeRank: number | null | undefined, sortOrder: number, type: string, attributes?: object | null): number {
    return stackGroupRank(layer, scopeRank, type, attributes) * STACK_GROUP_SPAN + sortOrder;
}
