// Height-aware tree clearance: does a planned shot fly over the trees it
// crosses, or into them?
//
// Pure planar geometry + a 1-D flight-height profile. Points are projected
// meters ({x, y}, EPSG:3006-style), heights are meters. Zero-dep,
// Swift-mirrorable: no DOM, no MapLibre, plain functions.
//
// Input contract: tree features are course features of type 'trees'. The
// canonical CourseFeature type lives in server/ (db/schema.ts) and web/, not
// in shared/, so this module takes a minimal STRUCTURAL input
// (TreeFeatureInput): the flattened outer ring plus the optional
// `attributes` object the server derives from canopy-height rasters
// ({ heightMaxM, heightP90M, heightMeanM, areaM2 }). Hand-drawn trees carry
// no attributes and evaluate as 'unknown'.
//
// Crossing geometry reuses carry.ts hazardsAlongLine (ray/ring intersection,
// origin-inside handling); this module adds the height dimension only.

import { hazardsAlongLine } from './carry';
import { type FlatRing } from './corridor';
import { bearingToUnitVector, type Vec2 } from './ellipse';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/** Canopy-height statistics the server attaches to raster-derived tree features, meters. */
export interface TreeHeights {
    heightMaxM?: number | null;
    heightP90M?: number | null;
    heightMeanM?: number | null;
    areaM2?: number | null;
}

/**
 * Minimal structural view of a course feature for this module. Callers
 * (web adapter, later Swift) flatten the feature's outer ring to planar
 * meters and pass `attributes` straight through.
 */
export interface TreeFeatureInput {
    /** Course-feature type; only 'trees' is considered. */
    type: string;
    /** Flattened outer ring, planar meters, implicitly closed. */
    points: readonly Vec2[];
    /** Server-derived attributes; absent/null on hand-drawn features. */
    attributes?: Record<string, number | string | boolean> | null;
}

/**
 * Representative tree height for clearance, meters: heightP90M (robust to a
 * single outlier crown), else heightMaxM, else null (no height data).
 * Non-finite or non-positive values count as missing.
 */
export function treeHeightM(feature: TreeFeatureInput): number | null {
    const attrs = feature.attributes;
    if (!attrs) return null;
    const p90 = numberOrNull(attrs.heightP90M);
    if (p90 !== null) return p90;
    return numberOrNull(attrs.heightMaxM);
}

function numberOrNull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Crossings
// ---------------------------------------------------------------------------

export interface TreeCrossing<F extends TreeFeatureInput = TreeFeatureInput> {
    feature: F;
    /** Distance along the line where the shot enters the ring, meters (0 when the origin is inside). */
    entryM: number;
    /** Distance along the line where the shot leaves the ring, meters. */
    exitM: number;
    /** treeHeightM(feature); null for hand-drawn trees. */
    treeHeightM: number | null;
}

/** Compass bearing (deg, 0 = north, cw) from `a` to `b` in planar meters. */
function bearingDeg(a: Vec2, b: Vec2): number {
    const deg = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;
    return (deg + 360) % 360;
}

// ---------------------------------------------------------------------------
// Tree index (bbox prefilter)
// ---------------------------------------------------------------------------

/** One indexed tree ring: the FlatRing carry.ts sweeps plus its axis-aligned bbox. */
interface TreeIndexEntry<F extends TreeFeatureInput> {
    feature: F;
    ring: FlatRing;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * Prebuilt per-ring bounding boxes for a feature array. Build once per
 * course-features change with `buildTreeIndex` and pass it wherever a
 * `features` array is accepted; the sweep then skips every ring whose bbox
 * the shot ray cannot touch. Results are identical to sweeping the array.
 *
 * Swift parity note: the iOS port sweeps the plain feature array (the
 * reference algorithm). This index is a web-side performance layer only;
 * Landeryd's 2200 lidar tree rings (~91k vertices) made the per-frame sweep
 * dominate drag latency.
 */
export interface TreeIndex<F extends TreeFeatureInput = TreeFeatureInput> {
    readonly kind: 'tree-index';
    readonly features: readonly F[];
    readonly entries: readonly TreeIndexEntry<F>[];
}

export function buildTreeIndex<F extends TreeFeatureInput>(features: readonly F[]): TreeIndex<F> {
    const entries: TreeIndexEntry<F>[] = [];
    for (const f of features) {
        if (f.type !== 'trees' || f.points.length < 3) continue;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const p of f.points) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        entries.push({ feature: f, ring: { kind: 'trees', points: f.points.slice() }, minX, minY, maxX, maxY });
    }
    return { kind: 'tree-index', features, entries };
}

/** Either a plain feature array or a prebuilt index over one. */
export type TreeFeatureSource<F extends TreeFeatureInput> = readonly F[] | TreeIndex<F>;

function isTreeIndex<F extends TreeFeatureInput>(src: TreeFeatureSource<F>): src is TreeIndex<F> {
    return !Array.isArray(src) && (src as TreeIndex<F>).kind === 'tree-index';
}

/** Index cache keyed by feature-array identity, so a plain-array caller pays the build once per array. */
const indexCache = new WeakMap<readonly TreeFeatureInput[], TreeIndex<TreeFeatureInput>>();

function resolveTreeIndex<F extends TreeFeatureInput>(src: TreeFeatureSource<F>): TreeIndex<F> {
    if (isTreeIndex(src)) return src;
    let idx = indexCache.get(src) as TreeIndex<F> | undefined;
    if (!idx) {
        idx = buildTreeIndex(src);
        indexCache.set(src, idx as TreeIndex<TreeFeatureInput>);
    }
    return idx;
}

/**
 * Prefilter slack around each bbox, meters. The ray/bbox slab test below is
 * exact for the ray; the pad only guards against rounding at a ring that
 * exactly grazes the line.
 */
const BBOX_PAD_M = 1;

/**
 * Does the ray origin + t·dir (t >= 0) pass through the bbox padded by
 * BBOX_PAD_M? Slab test. The ray is unbounded past the target because
 * `treeCrossingsAlongLine` reports rings beyond the target too (rollout
 * hazards), so a segment-bbox test would drop those.
 */
function rayHitsBbox(origin: Vec2, dir: Vec2, e: TreeIndexEntry<TreeFeatureInput>): boolean {
    const minX = e.minX - BBOX_PAD_M;
    const maxX = e.maxX + BBOX_PAD_M;
    const minY = e.minY - BBOX_PAD_M;
    const maxY = e.maxY + BBOX_PAD_M;
    let tmin = 0;
    let tmax = Infinity;

    if (Math.abs(dir.x) < 1e-12) {
        if (origin.x < minX || origin.x > maxX) return false;
    } else {
        const inv = 1 / dir.x;
        let t0 = (minX - origin.x) * inv;
        let t1 = (maxX - origin.x) * inv;
        if (t0 > t1) [t0, t1] = [t1, t0];
        if (t0 > tmin) tmin = t0;
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) return false;
    }

    if (Math.abs(dir.y) < 1e-12) {
        if (origin.y < minY || origin.y > maxY) return false;
    } else {
        const inv = 1 / dir.y;
        let t0 = (minY - origin.y) * inv;
        let t1 = (maxY - origin.y) * inv;
        if (t0 > t1) [t0, t1] = [t1, t0];
        if (t0 > tmin) tmin = t0;
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) return false;
    }
    return true;
}

/**
 * Every 'trees' feature the ray origin→target crosses (the ray is not
 * truncated at the target: trees past the target still register so the
 * caller can flag rollout hazards). Sorted by entry distance. A line that
 * starts inside a ring reports entryM = 0.
 *
 * `features` may be a plain array (indexed once per array identity via a
 * WeakMap) or a prebuilt `TreeIndex`.
 */
export function treeCrossingsAlongLine<F extends TreeFeatureInput>(
    origin: Vec2,
    target: Vec2,
    features: TreeFeatureSource<F>,
): TreeCrossing<F>[] {
    if (Math.hypot(target.x - origin.x, target.y - origin.y) <= 0) return [];
    const bearing = bearingDeg(origin, target);
    const dir = bearingToUnitVector(bearing);
    const index = resolveTreeIndex(features);

    const rings: FlatRing[] = [];
    const byRing = new Map<FlatRing, F>();
    for (const e of index.entries) {
        if (!rayHitsBbox(origin, dir, e)) continue;
        rings.push(e.ring);
        byRing.set(e.ring, e.feature);
    }

    const out: TreeCrossing<F>[] = [];
    for (const hit of hazardsAlongLine(origin, bearing, rings)) {
        const feature = byRing.get(hit.ring)!;
        out.push({ feature, entryM: hit.frontM, exitM: hit.carryM, treeHeightM: treeHeightM(feature) });
    }
    out.sort((a, b) => a.entryM - b.entryM);
    return out;
}

// ---------------------------------------------------------------------------
// Flight-height profile
// ---------------------------------------------------------------------------

/**
 * Fraction of carry at which the apex sits. Real ball flight is skewed:
 * drag and the lift-driven "climb then drop" put the apex past the midpoint,
 * with the descent steeper than the launch. Launch-monitor summaries
 * (TrackMan tour averages) place the apex at roughly 60-65% of carry for
 * driver through irons; 0.62 is the middle of that band.
 */
export const APEX_CARRY_FRACTION = 0.62;

/** One sampled point of a real trajectory: distance along the line and ball height, meters. */
export interface TrajectorySample {
    d: number;
    h: number;
}

/**
 * Ball height above the origin's ground at `distanceM` along the shot.
 *
 * Without `samples`: two half-parabolas joined at the apex
 * (APEX_CARRY_FRACTION · carry, apexM), 0 at d = 0 and d = carry, rising
 * monotonically to the apex and falling monotonically after it. Outside
 * [0, carry] → 0.
 *
 * With `samples` (>= 2 points, ascending `d`): linear interpolation between
 * samples; outside the sampled range → 0. Callers with a physics sampler
 * pass its output here and `carryM`/`apexM` are ignored.
 */
export function trajectoryHeightAt(
    distanceM: number,
    carryM: number,
    apexM: number,
    samples?: readonly TrajectorySample[],
): number {
    if (samples && samples.length >= 2) return interpolateSamples(distanceM, samples);

    if (!(carryM > 0) || !(apexM > 0)) return 0;
    if (distanceM <= 0 || distanceM >= carryM) return 0;

    const apexD = APEX_CARRY_FRACTION * carryM;
    if (distanceM <= apexD) {
        const u = (apexD - distanceM) / apexD;
        return apexM * (1 - u * u);
    }
    const u = (distanceM - apexD) / (carryM - apexD);
    return apexM * (1 - u * u);
}

function interpolateSamples(d: number, samples: readonly TrajectorySample[]): number {
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (d < first.d || d > last.d) return 0;
    // Binary search for the bracketing pair.
    let lo = 0;
    let hi = samples.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].d <= d) lo = mid;
        else hi = mid;
    }
    const a = samples[lo];
    const b = samples[hi];
    const span = b.d - a.d;
    if (span <= 0) return Math.max(a.h, b.h);
    const t = (d - a.d) / span;
    return a.h + (b.h - a.h) * t;
}

// ---------------------------------------------------------------------------
// Clearance
// ---------------------------------------------------------------------------

export type TreeClearanceStatus = 'clears' | 'blocked' | 'marginal' | 'unknown';

export interface TreeClearanceShot {
    /** Planned carry, meters. */
    carryM: number;
    /** Apex height above the origin's ground, meters. Ignored when `samples` is given. */
    apexM: number;
    /** Optional real trajectory samples (see trajectoryHeightAt). */
    samples?: readonly TrajectorySample[];
}

export interface TreeClearanceOptions {
    /** Clearance below which a crossing is 'marginal', meters. Default 2. */
    marginM?: number;
    /** Ground elevation at the origin, meters. Default groundAt(0) if given, else 0. */
    originGroundM?: number;
    /** Ground elevation at distance d along the line, meters. Omit for flat ground. */
    groundAt?: (distanceM: number) => number;
}

export interface TreeClearanceCrossing<F extends TreeFeatureInput = TreeFeatureInput> extends TreeCrossing<F> {
    /** Worst (lowest) ball-minus-treetop height over the crossing, meters. Null without height data. */
    minClearanceM: number | null;
    /** Distance along the line where minClearanceM occurs, meters. Null without height data. */
    worstAtM: number | null;
    status: TreeClearanceStatus;
    /** The carry point lies inside this ring (the existing recovery-lie case). */
    landsIn: boolean;
}

export interface TreeClearanceResult<F extends TreeFeatureInput = TreeFeatureInput> {
    /** Crossings the ball is airborne over (entry < carry), sorted by entry. */
    crossings: TreeClearanceCrossing<F>[];
    /** Tree rings wholly past the carry point (entry >= carry): rollout hazards, not flight obstacles. */
    beyondCarry: TreeCrossing<F>[];
    summary: {
        /** Precedence: blocked > marginal > unknown > clears. 'clears' when there are no crossings. */
        status: TreeClearanceStatus;
        /** The crossing with the lowest minClearanceM; null when none has height data. */
        worst: TreeClearanceCrossing<F> | null;
    };
}

export const DEFAULT_TREE_MARGIN_M = 2;

/** Evaluation step along the line, meters. */
const STEP_M = 1;

const STATUS_RANK: Record<TreeClearanceStatus, number> = {
    clears: 0,
    unknown: 1,
    marginal: 2,
    blocked: 3,
};

/**
 * Height-aware clearance of every tree ring on the line origin→target for a
 * shot with the given carry and apex. Per crossing the worst point of
 * (ball height − tree top) over [entry, min(exit, carry)] is sampled every
 * 1 m plus both interval ends. With `groundAt`, tree top = ground(d) +
 * treeHeight and ball = originGround + trajectoryHeight; otherwise flat.
 */
export function treeClearance<F extends TreeFeatureInput>(
    origin: Vec2,
    target: Vec2,
    features: TreeFeatureSource<F>,
    shot: TreeClearanceShot,
    opts: TreeClearanceOptions = {},
): TreeClearanceResult<F> {
    const marginM = opts.marginM ?? DEFAULT_TREE_MARGIN_M;
    const groundAt = opts.groundAt;
    const originGroundM = opts.originGroundM ?? (groundAt ? groundAt(0) : 0);
    const ground = (d: number): number => (groundAt ? groundAt(d) : originGroundM);
    const carryM = shot.carryM;

    const crossings: TreeClearanceCrossing<F>[] = [];
    const beyondCarry: TreeCrossing<F>[] = [];

    for (const crossing of treeCrossingsAlongLine(origin, target, features)) {
        if (crossing.entryM >= carryM) {
            beyondCarry.push(crossing);
            continue;
        }

        const landsIn = carryM >= crossing.entryM && carryM <= crossing.exitM;
        const height = crossing.treeHeightM;

        if (height === null) {
            crossings.push({ ...crossing, minClearanceM: null, worstAtM: null, status: 'unknown', landsIn });
            continue;
        }

        const endM = Math.min(crossing.exitM, carryM);
        let minClearanceM = Infinity;
        let worstAtM = crossing.entryM;
        const evaluate = (d: number): void => {
            const ball = originGroundM + trajectoryHeightAt(d, carryM, shot.apexM, shot.samples);
            const top = ground(d) + height;
            const c = ball - top;
            if (c < minClearanceM) {
                minClearanceM = c;
                worstAtM = d;
            }
        };
        for (let d = crossing.entryM; d < endM; d += STEP_M) evaluate(d);
        evaluate(endM);

        const status: TreeClearanceStatus =
            minClearanceM < 0 ? 'blocked' : minClearanceM < marginM ? 'marginal' : 'clears';
        crossings.push({ ...crossing, minClearanceM, worstAtM, status, landsIn });
    }

    let worst: TreeClearanceCrossing<F> | null = null;
    let status: TreeClearanceStatus = 'clears';
    for (const c of crossings) {
        if (STATUS_RANK[c.status] > STATUS_RANK[status]) status = c.status;
        if (c.minClearanceM !== null && (worst === null || c.minClearanceM < worst.minClearanceM!)) worst = c;
    }

    return { crossings, beyondCarry, summary: { status, worst } };
}
