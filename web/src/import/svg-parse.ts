// SVG parsing + georeferencing for course-feature import (roadmap 2.4 /
// Phase 3: "SVG import with georeferencing").
//
// Pure functions, no app state. The pipeline is:
//
//   1. `parseSvgDocument(svgText)` — DOMParser walk. Every `<path>` is
//      binned into a BUCKET keyed by (top-level layer, fill-or-class), with
//      accumulated affine transforms. Buckets carry a `suggestedType` from
//      the golf-map-2 fill-color convention (see GOLF_MAP_2_FILLS), CSS
//      class names, or group/layer labels — the import UI lets the user
//      confirm/override/skip each bucket.
//   2. `parsePathToSubpaths(d)` — path data (M/L/H/V/C/S/Q/T/Z, absolute +
//      relative) → closed subpaths of AnchorPoints with ABSOLUTE cubic
//      handles (the FeatureGeometry model, geo/bezier.ts). Quadratics are
//      degree-elevated to cubics; S/T reflections resolved.
//   3. `makeGeoreference(viewBox, bounds)` — affine SVG-user-units →
//      EPSG:3006 meters. SVG is y-DOWN: viewBox top edge (y = minY) maps to
//      the NORTH bound (maxY northing).
//   4. `subpathsToGeometries(rings)` — subpaths whose first anchor lies
//      inside an earlier subpath become hole rings; others become separate
//      features.

import type { AnchorPoint, PathRing, Point, FeatureGeometry } from '../geo/bezier';
import { flattenRing, pointInRing } from '../geo/bezier';
import { FEATURE_TYPES, type FeatureType } from '../draw/feature-palette';

// ─── Affine transforms ─────────────────────────────────────────────────────

/** SVG affine matrix [a, b, c, d, e, f]: x' = ax + cy + e, y' = bx + dy + f. */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** m1 ∘ m2 — apply m2 first, then m1 (matches SVG nesting order). */
export function composeAffine(m1: Affine, m2: Affine): Affine {
    const [a1, b1, c1, d1, e1, f1] = m1;
    const [a2, b2, c2, d2, e2, f2] = m2;
    return [
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    ];
}

export function applyAffine(m: Affine, p: Point): Point {
    return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/**
 * Parse an SVG `transform` attribute (translate / scale / matrix / rotate,
 * possibly several space-separated ops). Unknown ops are ignored.
 */
export function parseTransform(attr: string | null | undefined): Affine {
    if (!attr) return IDENTITY;
    let result = IDENTITY;
    const opRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = opRe.exec(attr)) !== null) {
        const args = (m[2].match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).map(Number);
        let op: Affine | null = null;
        switch (m[1]) {
            case 'translate':
                op = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
                break;
            case 'scale':
                op = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0];
                break;
            case 'matrix':
                if (args.length === 6) op = args as Affine;
                break;
            case 'rotate': {
                const rad = ((args[0] ?? 0) * Math.PI) / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                op = [cos, sin, -sin, cos, 0, 0];
                if (args.length === 3) {
                    const [, cx, cy] = args;
                    op = composeAffine(composeAffine([1, 0, 0, 1, cx, cy], op), [1, 0, 0, 1, -cx, -cy]);
                }
                break;
            }
        }
        if (op) result = composeAffine(result, op);
    }
    return result;
}

// ─── Path-data parsing ─────────────────────────────────────────────────────

export interface ParsedSubpath {
    points: AnchorPoint[];
    /** True when the subpath ended with Z/z. */
    closed: boolean;
}

/** Anchors closer than this (SVG user units) are merged on ring closure. */
const CLOSE_EPS = 1e-3;

const NUM_RE = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;

/**
 * Parse SVG path data into subpaths of bezier anchors. Supports
 * M/L/H/V/C/S/Q/T/Z in both absolute and relative form, with implicit
 * command repetition. Arcs (A) are not supported (golf-map-2 traces never
 * use them) — an `A` throws.
 *
 * Handles are ABSOLUTE points (FeatureGeometry convention). A trailing
 * anchor coincident with the subpath start (< 1e-3 units) is merged into
 * the start anchor, transferring its incoming handle — Inkscape closed
 * bezier paths end exactly on their first point.
 */
export function parsePathToSubpaths(d: string): ParsedSubpath[] {
    const subpaths: ParsedSubpath[] = [];
    let current: AnchorPoint[] = [];
    let closed = false;
    let cx = 0; // current point
    let cy = 0;
    let sx = 0; // subpath start
    let sy = 0;
    let prevC2: Point | null = null; // last cubic control 2 (for S)
    let prevQ: Point | null = null; // last quadratic control (for T)

    const flush = () => {
        if (current.length > 0) {
            subpaths.push({ points: mergeClosure(current), closed });
        }
        current = [];
        closed = false;
    };

    const last = (): AnchorPoint | null => current[current.length - 1] ?? null;

    const cmdRe = /([MmLlHhVvCcSsQqTtZzAa])([^MmLlHhVvCcSsQqTtZzAa]*)/g;
    let match: RegExpExecArray | null;
    while ((match = cmdRe.exec(d)) !== null) {
        const cmd = match[1];
        if (cmd === 'A' || cmd === 'a') throw new Error('SVG arc commands (A) are not supported');
        const nums = (match[2].match(NUM_RE) ?? []).map(Number);
        const rel = cmd === cmd.toLowerCase();
        let i = 0;
        const takes: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, z: 0 };
        const need = takes[cmd.toLowerCase()];
        let first = true;

        do {
            switch (cmd.toLowerCase()) {
                case 'm': {
                    const x = nums[i] + (rel ? cx : 0);
                    const y = nums[i + 1] + (rel ? cy : 0);
                    if (first) {
                        flush();
                        sx = x;
                        sy = y;
                        current.push({ x, y });
                    } else {
                        current.push({ x, y }); // implicit lineto
                    }
                    cx = x;
                    cy = y;
                    prevC2 = prevQ = null;
                    break;
                }
                case 'l': {
                    const x = nums[i] + (rel ? cx : 0);
                    const y = nums[i + 1] + (rel ? cy : 0);
                    current.push({ x, y });
                    cx = x;
                    cy = y;
                    prevC2 = prevQ = null;
                    break;
                }
                case 'h': {
                    const x = nums[i] + (rel ? cx : 0);
                    current.push({ x, y: cy });
                    cx = x;
                    prevC2 = prevQ = null;
                    break;
                }
                case 'v': {
                    const y = nums[i] + (rel ? cy : 0);
                    current.push({ x: cx, y });
                    cy = y;
                    prevC2 = prevQ = null;
                    break;
                }
                case 'c': {
                    const x1 = nums[i] + (rel ? cx : 0);
                    const y1 = nums[i + 1] + (rel ? cy : 0);
                    const x2 = nums[i + 2] + (rel ? cx : 0);
                    const y2 = nums[i + 3] + (rel ? cy : 0);
                    const x = nums[i + 4] + (rel ? cx : 0);
                    const y = nums[i + 5] + (rel ? cy : 0);
                    pushCubic(current, last(), { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y });
                    prevC2 = { x: x2, y: y2 };
                    prevQ = null;
                    cx = x;
                    cy = y;
                    break;
                }
                case 's': {
                    const x1 = prevC2 ? 2 * cx - prevC2.x : cx;
                    const y1 = prevC2 ? 2 * cy - prevC2.y : cy;
                    const x2 = nums[i] + (rel ? cx : 0);
                    const y2 = nums[i + 1] + (rel ? cy : 0);
                    const x = nums[i + 2] + (rel ? cx : 0);
                    const y = nums[i + 3] + (rel ? cy : 0);
                    pushCubic(current, last(), { x: x1, y: y1 }, { x: x2, y: y2 }, { x, y });
                    prevC2 = { x: x2, y: y2 };
                    prevQ = null;
                    cx = x;
                    cy = y;
                    break;
                }
                case 'q':
                case 't': {
                    let qx: number;
                    let qy: number;
                    let x: number;
                    let y: number;
                    if (cmd.toLowerCase() === 'q') {
                        qx = nums[i] + (rel ? cx : 0);
                        qy = nums[i + 1] + (rel ? cy : 0);
                        x = nums[i + 2] + (rel ? cx : 0);
                        y = nums[i + 3] + (rel ? cy : 0);
                    } else {
                        qx = prevQ ? 2 * cx - prevQ.x : cx;
                        qy = prevQ ? 2 * cy - prevQ.y : cy;
                        x = nums[i] + (rel ? cx : 0);
                        y = nums[i + 1] + (rel ? cy : 0);
                    }
                    // Degree elevation: quadratic (p0, q, p3) → cubic with
                    // c1 = p0 + 2/3 (q − p0), c2 = p3 + 2/3 (q − p3).
                    const c1 = { x: cx + (2 / 3) * (qx - cx), y: cy + (2 / 3) * (qy - cy) };
                    const c2 = { x: x + (2 / 3) * (qx - x), y: y + (2 / 3) * (qy - y) };
                    pushCubic(current, last(), c1, c2, { x, y });
                    prevQ = { x: qx, y: qy };
                    prevC2 = null;
                    cx = x;
                    cy = y;
                    break;
                }
                case 'z': {
                    closed = true;
                    cx = sx;
                    cy = sy;
                    prevC2 = prevQ = null;
                    flush();
                    break;
                }
            }
            i += need;
            first = false;
        } while (need > 0 && i + need <= nums.length);
    }
    flush();
    return subpaths;
}

function pushCubic(current: AnchorPoint[], from: AnchorPoint | null, c1: Point, c2: Point, to: Point): void {
    if (from) from.hOut = c1;
    current.push({ x: to.x, y: to.y, hIn: c2 });
}

/** Merge a trailing anchor coincident with the start (transfer its hIn). */
function mergeClosure(points: AnchorPoint[]): AnchorPoint[] {
    if (points.length < 2) return points;
    const firstPt = points[0];
    const lastPt = points[points.length - 1];
    if (Math.hypot(lastPt.x - firstPt.x, lastPt.y - firstPt.y) < CLOSE_EPS) {
        const merged = points.slice(0, -1);
        if (lastPt.hIn) merged[0] = { ...firstPt, hIn: lastPt.hIn };
        return merged;
    }
    return points;
}

// ─── Feature-type suggestion ───────────────────────────────────────────────

/** golf-map-2 trace convention: SVG fill hex → feature type. */
export const GOLF_MAP_2_FILLS: Record<string, FeatureType> = {
    '#a0e5b8': 'tee',
    '#43e561': 'fairway',
    '#bce5a4': 'green',
    '#e5e5aa': 'bunker',
    '#164b20': 'deep_rough',
    '#278438': 'rough',
    '#36b74d': 'semi_rough',
    '#0000c0': 'water',
    '#00ffff': 'water_creek',
};

/** Name/label token → feature type (group ids, classes, layer labels). */
const NAME_TOKENS: Record<string, FeatureType> = {
    tee: 'tee', tees: 'tee',
    fairway: 'fairway', fairways: 'fairway',
    green: 'green', greens: 'green',
    bunker: 'bunker', bunkers: 'bunker', sand: 'bunker',
    semi_rough: 'semi_rough', semirough: 'semi_rough',
    rough: 'rough', roughs: 'rough',
    deep_rough: 'deep_rough', deeprough: 'deep_rough', deep: 'deep_rough', deeps: 'deep_rough',
    water: 'water', waters: 'water', lake: 'water', pond: 'water',
    water_creek: 'water_creek', creek: 'water_creek', creeks: 'water_creek',
    path: 'path', paths: 'path', road: 'path', roads: 'path', cartpath: 'path',
    outside: 'outside',
};

function typeFromName(name: string | null): FeatureType | null {
    if (!name) return null;
    // whole-name match first so compound names (semi_rough, deep_rough)
    // beat their fragments
    const whole = name.toLowerCase().trim();
    if (NAME_TOKENS[whole]) return NAME_TOKENS[whole];
    for (const token of whole.split(/[\s,_-]+/)) {
        if (NAME_TOKENS[token]) return NAME_TOKENS[token];
    }
    return null;
}

/**
 * Suggested feature type for a path, in precedence order: fill hex
 * (golf-map-2 convention) → CSS class token → group/layer label token.
 */
export function suggestType(fill: string | null, className: string | null, layer: string | null): FeatureType | null {
    if (fill && GOLF_MAP_2_FILLS[fill]) return GOLF_MAP_2_FILLS[fill];
    return typeFromName(className) ?? typeFromName(layer);
}

// ─── SVG document scan ─────────────────────────────────────────────────────

export interface SvgViewBox {
    minX: number;
    minY: number;
    width: number;
    height: number;
}

export interface SvgPathInfo {
    d: string;
    /** Accumulated affine (root → path), applied before georeferencing. */
    transform: Affine;
}

/** One import-mapping row: all paths sharing (layer, fill-or-class). */
export interface SvgBucket {
    /** Stable key for assignment maps: `layer∷fillOrClass`. */
    key: string;
    /** Top-level layer/group label (inkscape:label or id), '' at root. */
    layer: string;
    /** Fill color (lowercased hex) from style/fill attr, or null. */
    fill: string | null;
    /** First CSS class, or null. */
    className: string | null;
    suggestedType: FeatureType | null;
    paths: SvgPathInfo[];
}

export interface ParsedSvg {
    viewBox: SvgViewBox;
    buckets: SvgBucket[];
    totalPaths: number;
}

function extractFill(el: Element): string | null {
    const style = el.getAttribute('style');
    const styleMatch = style?.match(/fill:\s*(#[0-9a-fA-F]{6})/);
    if (styleMatch) return styleMatch[1].toLowerCase();
    const fill = el.getAttribute('fill');
    if (fill && /^#[0-9a-fA-F]{6}$/.test(fill)) return fill.toLowerCase();
    return null;
}

/**
 * Parse an SVG document into type-mapping buckets. Throws when the text is
 * not an SVG or has no usable viewBox/width/height.
 */
export function parseSvgDocument(svgText: string): ParsedSvg {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') {
        throw new Error('Not an SVG document');
    }

    const vbAttr = root.getAttribute('viewBox');
    let viewBox: SvgViewBox;
    if (vbAttr) {
        const nums = (vbAttr.match(NUM_RE) ?? []).map(Number);
        if (nums.length !== 4 || nums[2] <= 0 || nums[3] <= 0) throw new Error(`Invalid viewBox: ${vbAttr}`);
        viewBox = { minX: nums[0], minY: nums[1], width: nums[2], height: nums[3] };
    } else {
        const width = parseFloat(root.getAttribute('width') ?? '');
        const height = parseFloat(root.getAttribute('height') ?? '');
        if (!(width > 0) || !(height > 0)) throw new Error('SVG has no viewBox and no width/height');
        viewBox = { minX: 0, minY: 0, width, height };
    }

    const buckets = new Map<string, SvgBucket>();
    let totalPaths = 0;

    const walk = (el: Element, layer: string, transform: Affine): void => {
        const style = el.getAttribute('style') ?? '';
        if (/display\s*:\s*none/.test(style)) return; // hidden layer/group

        const combined = composeAffine(transform, parseTransform(el.getAttribute('transform')));

        if (el.tagName.toLowerCase() === 'path') {
            const d = el.getAttribute('d');
            if (!d) return;
            totalPaths++;
            const fill = extractFill(el);
            const className = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)[0] ?? null;
            const key = `${layer}∷${fill ?? className ?? 'none'}`;
            let bucket = buckets.get(key);
            if (!bucket) {
                bucket = {
                    key,
                    layer,
                    fill,
                    className,
                    suggestedType: suggestType(fill, className, layer),
                    paths: [],
                };
                buckets.set(key, bucket);
            }
            bucket.paths.push({ d, transform: combined });
            return;
        }

        for (const child of Array.from(el.children)) {
            let childLayer = layer;
            if (layer === '' && child.tagName.toLowerCase() === 'g') {
                childLayer =
                    child.getAttribute('inkscape:label') ??
                    child.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label') ??
                    child.getAttribute('id') ??
                    '';
            }
            walk(child as Element, childLayer, combined);
        }
    };

    for (const child of Array.from(root.children)) {
        const isGroup = child.tagName.toLowerCase() === 'g';
        const layer = isGroup
            ? child.getAttribute('inkscape:label') ??
              child.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label') ??
              child.getAttribute('id') ??
              ''
            : '';
        walk(child as Element, layer, IDENTITY);
    }

    return { viewBox, buckets: Array.from(buckets.values()), totalPaths };
}

// ─── Georeferencing ────────────────────────────────────────────────────────

/** Target EPSG:3006 bounds for the SVG viewBox (meters). */
export interface GeoBounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/**
 * Affine SVG-user-units → EPSG:3006. SVG y grows DOWN, northing grows UP:
 * the viewBox top edge (y = minY) maps to `bounds.maxY` (north edge).
 */
export function makeGeoreference(viewBox: SvgViewBox, bounds: GeoBounds): (p: Point) => Point {
    const sx = (bounds.maxX - bounds.minX) / viewBox.width;
    const sy = (bounds.maxY - bounds.minY) / viewBox.height;
    return p => ({
        x: bounds.minX + (p.x - viewBox.minX) * sx,
        y: bounds.maxY - (p.y - viewBox.minY) * sy,
    });
}

/** Map every anchor + handle of a subpath through `fn`. */
export function mapSubpath(sub: ParsedSubpath, fn: (p: Point) => Point): PathRing {
    return {
        points: sub.points.map(a => {
            const out: AnchorPoint = { ...fn(a) };
            if (a.hIn) out.hIn = fn(a.hIn);
            if (a.hOut) out.hOut = fn(a.hOut);
            return out;
        }),
    };
}

// ─── Ring grouping ─────────────────────────────────────────────────────────

/** Flatten tolerance for containment tests, meters. */
const CONTAIN_TOLERANCE_M = 1;

/**
 * Group a path's subpath rings into feature geometries: a ring whose first
 * anchor lies inside an earlier ring's outline becomes a HOLE of that
 * feature; otherwise it starts a new feature. (Matches the draw model:
 * rings[0] = outer, rings[1..] = holes.)
 */
export function subpathsToGeometries(rings: PathRing[], crs = 'EPSG:3006'): FeatureGeometry[] {
    const geometries: FeatureGeometry[] = [];
    const outers: Array<Array<[number, number]>> = [];
    for (const ring of rings) {
        const p = ring.points[0];
        const containerIdx = outers.findIndex(outline => pointInRing(p, outline));
        if (containerIdx >= 0) {
            geometries[containerIdx].rings.push(ring);
        } else {
            geometries.push({ crs, rings: [ring] });
            outers.push(flattenRing(ring, CONTAIN_TOLERANCE_M));
        }
    }
    return geometries;
}
