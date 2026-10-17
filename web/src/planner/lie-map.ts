// Lie classification for the planner's strategy engine (DECADE plan Phase C).
// Reads the course-feature store, flattens every feature's OUTER ring ONCE
// per hole into shared/strategy's FlatRing shape, and exposes a
// `classifyLie` closure + the hazard subset for corridor-gate generation.
//
// Mirrors analysis-tool.service.ts's hitGreen() and the draw tool's
// hitFeature(): topmost-in-STACK point-in-feature testing (decision D23,
// which amends D17) via geo/bezier.ts (flattenRing / pointInGeometry),
// except here EVERY feature type is classified (not just green) because
// optimizeAim needs the full lie taxonomy. Nesting is resolved by the D28
// GLOBAL stack key (shared/render/stack-key.ts, topmost wins),
// the SAME order the map renders and the editor hits — no longer smallest-
// area. Features are pre-sorted topmost-first here, so `surfaces()` hands
// aim.ts an array whose order already IS priority order (D23 contract).
//
// Purity boundary (DECADE doc §4.3): shared/strategy stays dependency-free,
// so it never touches the feature store. This module is the ADAPTER: it
// converts CourseFeature geometry (EPSG:3006 bezier rings) into the plain
// { x, y } FlatRing[] that corridor.ts / aim.ts already accept, using the
// SAME flatten tolerance as the persistent features overlay
// (FLATTEN_TOLERANCE_M in draw/features.service.ts) so hit-testing here
// agrees with what's drawn on the map.
//
// Only holes (rings[1..]) that make a feature a proper donut are dropped —
// aim.ts / corridor.ts's FlatRing has no hole concept (same limitation
// corridor.ts already ships with); outer-ring-only is an acceptable v1
// simplification since course features are simple polygons in practice.

import type { CourseFeature } from '../../../shared/api/course-features.gen';
import {
    DEFAULT_HAZARD_TYPES,
    lieFromFeatureType,
    pointInRing,
    type FlatRing,
    type Lie,
    type Vec2,
} from '../../../shared/strategy';
import { stackKey } from '../../../shared/render/stack-key';
import { TREE_AREA_TYPE } from '../../../shared/features/tree-areas';
import { POWER_LINE_TYPE } from '../../../shared/features/power-line';
import { flattenRing } from '../geo/bezier';

/** Corridor-obstacle feature types (shared/strategy corridor.ts), as a Set for O(1) lookup. */
const HAZARD_TYPES = new Set(DEFAULT_HAZARD_TYPES);

/** Matches features.service.ts's flatten tolerance (what's actually drawn). */
export const LIE_MAP_TOLERANCE_M = 0.25;


interface ClassifiedFeatureRing {
    ring: FlatRing;
    stackKey: number;
    holeId: string | null;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

/** A hole's pre-flattened lie map: classify any point, or list hazard rings. */
export interface LieMap {
    /**
     * Lie at `p` (EPSG:3006 meters): the topmost-in-stack containing feature
     * wins nesting (D23/D24 global stack key); no containing feature →
     * 'rough'.
     */
    classifyLie(p: Vec2): Lie;
    /** All rings (any feature type) as shared/strategy FlatRing[], for aim.ts's `surfaces`. */
    surfaces(): readonly FlatRing[];
    /** The subset of rings whose feature type is a corridor obstacle (DEFAULT_HAZARD_TYPES). */
    hazardRings(): readonly FlatRing[];
    /**
     * Same subset with each ring's source-feature `holeId` — lets a ladder
     * widen the corridor for the current hole's own hazards vs other holes'
     * (mirroring iOS's own/foreign split). Null = course-level feature.
     */
    hazardRingsOwned(): readonly { ring: FlatRing; holeId: string | null }[];
    /**
     * Topmost containing ring at `p` whose feature type is in `kinds`, or
     * null — the tap-a-shape hit test (same D23/D24 stack order as
     * `classifyLie`, but returns the ring itself).
     */
    ringAt(p: Vec2, kinds: ReadonlySet<string>): FlatRing | null;
}

function bbox(ring: FlatRing): { minX: number; maxX: number; minY: number; maxY: number } {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of ring.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
}

/**
 * Build a hole's lie map from the raw feature list (typically
 * `ctx.features.store.items.peek()`). Every feature is flattened exactly
 * once here; `classifyLie` is then a cheap bbox-reject + point-in-ring scan
 * with no further curve evaluation, so it is safe to call per dispersion
 * sample (~100s of calls) once built.
 *
 * `features` is NOT pre-filtered by hole here — course features are
 * frequently unassigned (`holeId: null`, e.g. a shared water hazard) or
 * legitimately span into a neighboring hole's corridor, and geographic
 * point-containment already disambiguates correctly (same reasoning as
 * hitGreen(), which scans the whole course). Callers who DO want a
 * per-hole subset (perf on huge courses) can pre-filter by `holeId` before
 * calling; this module doesn't assume one way or the other.
 *
 * `holeNumberById` maps each hole's id to its number for the D28 group rank
 * (Roughs layer at the bottom, holes by number, course-level on top —
 * shared/render/stack-key.ts). Omit it and every feature ranks 0, i.e. the
 * stack collapses to `sortOrder` order across all groups — correct for a
 * single group, but a caller spanning multiple groups MUST pass it so
 * cross-group precedence resolves the way the map renders.
 */
export function buildLieMap(
    features: readonly CourseFeature[],
    holeNumberById?: ReadonlyMap<string, number>,
): LieMap {
    const classified: ClassifiedFeatureRing[] = [];
    for (const feature of features) {
        // A tree species area only tells the Unity planter what grows there
        // (shared/features/tree-areas.ts): no lie, and it often reaches over a
        // fairway edge it must not turn into rough.
        if (feature.type === TREE_AREA_TYPE) continue;
        // A power line hangs over the ground (shared/features/power-line.ts): no lie.
        if (feature.type === POWER_LINE_TYPE) continue;
        if (feature.geometry.rings.length === 0) continue;
        const flat = flattenRing(feature.geometry.rings[0], LIE_MAP_TOLERANCE_M, feature.geometry.curveType);
        if (flat.length < 3) continue;
        const points = flat.map(([x, y]) => ({ x, y }));
        const ring: FlatRing = { points, kind: feature.type };
        const holeNumber = feature.holeId === null ? null : holeNumberById?.get(feature.holeId) ?? 0;
        const key = holeNumberById ? stackKey(feature.layer, holeNumber, feature.sortOrder, feature.type, feature.attributes) : feature.sortOrder;
        classified.push({ ring, stackKey: key, holeId: feature.holeId, ...bbox(ring) });
    }
    // Topmost-first (highest stack key) so the FIRST containing ring wins
    // nesting (D23/D24) — the same order the map renders and the editor hits.
    classified.sort((a, b) => b.stackKey - a.stackKey);

    const surfaces = classified.map(c => c.ring);
    const hazardEntries = classified
        .filter(c => HAZARD_TYPES.has(c.ring.kind))
        .map(c => ({ ring: c.ring, holeId: c.holeId }));
    const hazards = hazardEntries.map(c => c.ring);

    return {
        classifyLie(p: Vec2): Lie {
            for (const r of classified) {
                if (p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY) continue;
                if (pointInRing(p, r.ring.points)) return lieFromFeatureType(r.ring.kind);
            }
            return 'rough';
        },
        surfaces: () => surfaces,
        hazardRings: () => hazards,
        hazardRingsOwned: () => hazardEntries,
        ringAt(p: Vec2, kinds: ReadonlySet<string>): FlatRing | null {
            for (const r of classified) {
                if (!kinds.has(r.ring.kind)) continue;
                if (p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY) continue;
                if (pointInRing(p, r.ring.points)) return r.ring;
            }
            return null;
        },
    };
}
