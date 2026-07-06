// Lie classification for the planner's strategy engine (DECADE plan Phase C).
// Reads the course-feature store, flattens every feature's OUTER ring ONCE
// per hole into shared/strategy's FlatRing shape, and exposes a
// `classifyLie` closure + the hazard subset for corridor-gate generation.
//
// Mirrors analysis-tool.service.ts's hitGreen(): topmost-smallest
// point-in-feature testing via geo/bezier.ts (flattenRing / pointInGeometry /
// outerRingArea), except here EVERY feature type is classified (not just
// green) because optimizeAim needs the full lie taxonomy, and nesting is
// resolved by the SAME smallest-area rule per decision D17 (so this module's
// notion of "topmost" agrees with aim.ts's own nesting resolution — we just
// pre-flatten once here rather than re-flattening per sample).
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
import { flattenRing, outerRingArea } from '../geo/bezier';

/** Corridor-obstacle feature types (shared/strategy corridor.ts), as a Set for O(1) lookup. */
const HAZARD_TYPES = new Set(DEFAULT_HAZARD_TYPES);

/** Matches features.service.ts's flatten tolerance (what's actually drawn). */
export const LIE_MAP_TOLERANCE_M = 0.25;

interface ClassifiedFeatureRing {
    ring: FlatRing;
    areaM2: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

/** A hole's pre-flattened lie map: classify any point, or list hazard rings. */
export interface LieMap {
    /**
     * Lie at `p` (EPSG:3006 meters): smallest-area containing feature wins
     * nesting (D17); no containing feature → 'rough'.
     */
    classifyLie(p: Vec2): Lie;
    /** All rings (any feature type) as shared/strategy FlatRing[], for aim.ts's `surfaces`. */
    surfaces(): readonly FlatRing[];
    /** The subset of rings whose feature type is a corridor obstacle (DEFAULT_HAZARD_TYPES). */
    hazardRings(): readonly FlatRing[];
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
 */
export function buildLieMap(features: readonly CourseFeature[]): LieMap {
    const classified: ClassifiedFeatureRing[] = [];
    for (const feature of features) {
        if (feature.geometry.rings.length === 0) continue;
        const flat = flattenRing(feature.geometry.rings[0], LIE_MAP_TOLERANCE_M, feature.geometry.curveType);
        if (flat.length < 3) continue;
        const points = flat.map(([x, y]) => ({ x, y }));
        const ring: FlatRing = { points, kind: feature.type };
        classified.push({ ring, areaM2: outerRingArea(feature.geometry, LIE_MAP_TOLERANCE_M), ...bbox(ring) });
    }
    // Smallest-area-first so the FIRST containing ring wins nesting (D17) —
    // same convention as aim.ts's internal `classifiable`/`classifyLie`.
    classified.sort((a, b) => a.areaM2 - b.areaM2);

    const surfaces = classified.map(c => c.ring);
    const hazards = classified
        .filter(c => HAZARD_TYPES.has(c.ring.kind))
        .map(c => c.ring);

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
    };
}
