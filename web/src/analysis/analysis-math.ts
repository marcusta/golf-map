// Pure math for the green + surrounds analysis tool: central-difference
// slope/aspect from the server's sampled DEM grid, the exact color ramps
// from the golf-map-2 reference (docs/reference/golf-map-2-measure-and-
// green-analysis.md §2.3), per-green height normalization, the
// height-relative-to-green diverging ramp (the "grop"/hollows view), grid →
// RGBA image mapping with inside/outside alpha, stats, and fall-line arrow
// sampling. No DOM, no map — everything here is unit-testable.

import type { SampleGrid } from '../../../shared/api/analysis.gen';

export type AnalysisMode = 'slope' | 'height' | 'relative' | 'curvature';

export type Rgb = [number, number, number];

// ─── Slope / aspect (central differences, reference §4 port note) ─────────

export interface SlopeGrid {
    /** Slope magnitude in percent per cell (NaN where heights are missing). */
    slopePct: Float64Array;
    /** Downhill unit vector, EPSG:3006 east component (NaN with slopePct). */
    dirE: Float64Array;
    /** Downhill unit vector, EPSG:3006 north component. */
    dirN: Float64Array;
}

/**
 * Per-cell slope% + downhill direction via central differences (one-sided
 * at grid borders and next to nodata cells). Row 0 is the northernmost row,
 * so dz/dnorth uses row-1 minus row+1.
 */
export function computeSlopeGrid(grid: SampleGrid): SlopeGrid {
    const { width, height, heights, resolution } = grid;
    const slopePct = new Float64Array(width * height).fill(NaN);
    const dirE = new Float64Array(width * height).fill(NaN);
    const dirN = new Float64Array(width * height).fill(NaN);

    const h = (row: number, col: number): number | null => heights[row * width + col];

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            if (h(row, col) === null) continue;

            // East axis: prefer central, fall back to one-sided around nulls.
            let cl = col > 0 && h(row, col - 1) !== null ? col - 1 : col;
            let cr = col < width - 1 && h(row, col + 1) !== null ? col + 1 : col;
            // North axis (row index grows southward).
            let rn = row > 0 && h(row - 1, col) !== null ? row - 1 : row;
            let rs = row < height - 1 && h(row + 1, col) !== null ? row + 1 : row;
            if (cl === cr || rn === rs) continue;

            const dzde = (h(row, cr)! - h(row, cl)!) / ((cr - cl) * resolution);
            const dzdn = (h(rn, col)! - h(rs, col)!) / ((rs - rn) * resolution);
            const mag = Math.hypot(dzde, dzdn);

            const i = row * width + col;
            slopePct[i] = mag * 100;
            if (mag > 0) {
                dirE[i] = -dzde / mag; // downhill = negative gradient
                dirN[i] = -dzdn / mag;
            } else {
                dirE[i] = 0;
                dirN[i] = 0;
            }
        }
    }
    return { slopePct, dirE, dirN };
}

// ─── Color ramps (exact stops from the reference doc §2.3) ────────────────

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
];

const clamp01 = (t: number): number => Math.min(Math.max(t, 0), 1);

// Slope ramp: 0-7%+ professional green-reading scale.
export const SLOPE_BLUE: Rgb = [51, 128, 255]; // (0.2, 0.5, 1.0)
export const SLOPE_GREEN: Rgb = [51, 204, 51]; // (0.2, 0.8, 0.2)
export const SLOPE_ORANGE: Rgb = [255, 128, 26]; // (1.0, 0.5, 0.1)
export const SLOPE_MAGENTA: Rgb = [255, 51, 153]; // (1.0, 0.2, 0.6)

/** Slope ramp: <1% blue, 1-3% blue→green, 3-5% green→orange, 5-7% orange→magenta, ≥7% magenta. */
export function slopeColor(slopePct: number): Rgb {
    if (Number.isNaN(slopePct) || slopePct < 1) return SLOPE_BLUE;
    if (slopePct < 3) return mix(SLOPE_BLUE, SLOPE_GREEN, (slopePct - 1) / 2);
    if (slopePct < 5) return mix(SLOPE_GREEN, SLOPE_ORANGE, (slopePct - 3) / 2);
    if (slopePct < 7) return mix(SLOPE_ORANGE, SLOPE_MAGENTA, (slopePct - 5) / 2);
    return SLOPE_MAGENTA;
}

// Height ramp: 5-stop, normalized to the green's own local min/max.
export const HEIGHT_STOPS: Rgb[] = [
    [0, 102, 255], // blue   (0.0, 0.4, 1.0)
    [0, 204, 51], // green  (0.0, 0.8, 0.2)
    [255, 255, 0], // yellow
    [255, 136, 0], // orange (1.0, 0.533, 0.0)
    [255, 0, 0], // red
];

/** Height ramp over t ∈ [0,1] (t = per-green normalized elevation), 4 bands of 0.25. */
export function heightColor(t: number): Rgb {
    const u = clamp01(Number.isNaN(t) ? 0 : t);
    const band = Math.min(3, Math.floor(u / 0.25));
    return mix(HEIGHT_STOPS[band], HEIGHT_STOPS[band + 1], (u - band * 0.25) / 0.25);
}

// Relative-to-green diverging ramp — the hollows ("grop") view. Below the
// green's mean elevation: blues deepening into purple with depth; above:
// warm yellows into red. Neutral near green level.
export const REL_NEUTRAL: Rgb = [240, 245, 235];
export const REL_BELOW_STOPS: Rgb[] = [
    REL_NEUTRAL,
    [102, 179, 255], // light blue
    [34, 85, 221], // deep blue
    [85, 34, 170], // purple — deepest hollow
];
export const REL_ABOVE_STOPS: Rgb[] = [
    REL_NEUTRAL,
    [255, 221, 102], // light warm
    [255, 136, 0], // orange
    [204, 34, 0], // red — highest mound
];

/**
 * Diverging ramp for height relative to the green's mean inside-elevation.
 * `deltaM` = cell height − green mean; `scaleM` = normalization scale (the
 * grid's max |delta|, floored — see relativeScale). Three lerp bands per side.
 */
export function relativeColor(deltaM: number, scaleM: number): Rgb {
    const u = Number.isNaN(deltaM) ? 0 : Math.min(Math.max(deltaM / scaleM, -1), 1);
    const stops = u < 0 ? REL_BELOW_STOPS : REL_ABOVE_STOPS;
    const m = Math.abs(u) * 3;
    const band = Math.min(2, Math.floor(m));
    return mix(stops[band], stops[band + 1], m - band);
}

// ─── Curvature (ridge / hollow view) ──────────────────────────────────────

/**
 * Gaussian smoothing sigma for the curvature surface, meters. Second
 * derivatives amplify lidar noise hard — smoothing at landform scale keeps
 * the broad ridges ("åsryggar") a putt cares about and drops the texture.
 */
export const CURV_SMOOTH_SIGMA_M = 2.0;
/**
 * Auto-contrast bounds for the curvature ramp, %/m. The ramp pins to the
 * 95th percentile of |convexity| inside the green, clamped to this range —
 * a broad, gentle ridge fills the ramp instead of washing out against a
 * fixed scale sized for sharp features.
 */
export const CURV_SCALE_MIN_PCT_PER_M = 0.8;
export const CURV_SCALE_MAX_PCT_PER_M = 8.0;

/**
 * Separable NaN-aware Gaussian blur of the height grid (normalized
 * convolution: weights renormalize over valid neighbors; nodata cells stay
 * NaN). Returns NaN-for-nodata regardless of the input's null convention.
 */
export function smoothHeights(grid: SampleGrid, sigmaM: number): Float64Array {
    const { width, height, heights, resolution } = grid;
    const src = new Float64Array(width * height);
    for (let i = 0; i < src.length; i++) {
        const h = heights[i];
        src[i] = h === null ? NaN : h;
    }
    const sigmaCells = sigmaM / resolution;
    if (!(sigmaCells > 0.05)) return src;

    const radius = Math.max(1, Math.ceil(3 * sigmaCells));
    const kernel = new Float64Array(2 * radius + 1);
    for (let k = -radius; k <= radius; k++) {
        kernel[k + radius] = Math.exp(-(k * k) / (2 * sigmaCells * sigmaCells));
    }

    const pass = (input: Float64Array, stepRow: number, stepCol: number): Float64Array => {
        const out = new Float64Array(input.length).fill(NaN);
        for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                const i = row * width + col;
                if (Number.isNaN(input[i])) continue;
                let sum = 0, weight = 0;
                for (let k = -radius; k <= radius; k++) {
                    const r = row + k * stepRow;
                    const c = col + k * stepCol;
                    if (r < 0 || r >= height || c < 0 || c >= width) continue;
                    const v = input[r * width + c];
                    if (Number.isNaN(v)) continue;
                    const w = kernel[k + radius];
                    sum += v * w;
                    weight += w;
                }
                out[i] = sum / weight;
            }
        }
        return out;
    };

    return pass(pass(src, 0, 1), 1, 0);
}

/**
 * Per-cell convexity of the smoothed surface: −∇²z expressed as slope-change
 * %/m. Positive = convex (ridge crest, mound top), negative = concave
 * (hollow, swale). NaN where a second difference has no valid neighbors.
 */
export function computeCurvatureGrid(
    grid: SampleGrid,
    sigmaM: number = CURV_SMOOTH_SIGMA_M,
): Float64Array {
    const { width, height, resolution } = grid;
    const r2 = resolution * resolution;
    const z = smoothHeights(grid, sigmaM);
    const out = new Float64Array(z.length).fill(NaN);

    const at = (row: number, col: number): number =>
        row < 0 || row >= height || col < 0 || col >= width ? NaN : z[row * width + col];

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const center = at(row, col);
            if (Number.isNaN(center)) continue;
            const east = at(row, col - 1), west = at(row, col + 1);
            const north = at(row - 1, col), south = at(row + 1, col);
            let laplacian = 0;
            let axes = 0;
            if (!Number.isNaN(east) && !Number.isNaN(west)) {
                laplacian += (east - 2 * center + west) / r2;
                axes++;
            }
            if (!Number.isNaN(north) && !Number.isNaN(south)) {
                laplacian += (north - 2 * center + south) / r2;
                axes++;
            }
            if (axes > 0) {
                out[row * width + col] = -laplacian * 100;
            }
        }
    }
    return out;
}

/**
 * Curvature ramp: the relative view's diverging stops re-pinned to convexity
 * — hollows blue, ridge crests red, flat neutral. `scale` comes from the
 * per-green auto-contrast in `buildOverlayRgba`.
 */
export function curvatureColor(convexityPctPerM: number, scale: number): Rgb {
    return relativeColor(convexityPctPerM, scale);
}

/**
 * p-quantile (0-1) of |values| over inside-green cells (all finite cells
 * when none are inside); null when nothing finite to rank.
 */
function absQuantile(values: Float64Array, inside: ArrayLike<number>, p: number): number | null {
    let magnitudes: number[] = [];
    for (let i = 0; i < values.length; i++) {
        if (inside[i] && !Number.isNaN(values[i])) magnitudes.push(Math.abs(values[i]));
    }
    if (magnitudes.length === 0) {
        magnitudes = Array.from(values).filter(v => !Number.isNaN(v)).map(Math.abs);
    }
    if (magnitudes.length === 0) return null;
    magnitudes.sort((a, b) => a - b);
    const index = Math.min(magnitudes.length - 1, Math.floor((magnitudes.length - 1) * p));
    return magnitudes[index];
}

/** Minimum relative-mode scale — avoids amplifying pure noise on dead-flat sites. */
export const REL_SCALE_MIN_M = 0.3;
/**
 * Maximum relative-mode scale. Golf-relevant hollows/mounds are ≤ ~2 m from
 * green level; without this cap a tall hill or deep valley inside the
 * buffer stretches the ramp and washes out exactly the run-off shapes the
 * mode exists to show. Deviations beyond the cap saturate.
 */
export const REL_SCALE_MAX_M = 2.0;

// ─── Stats ────────────────────────────────────────────────────────────────

export interface AnalysisStats {
    green: {
        minHeight: number;
        maxHeight: number;
        deltaHeight: number;
        maxSlopePct: number;
        avgSlopePct: number;
        /** Mean inside-green elevation — the zero level of the relative ramp. */
        meanHeight: number;
    };
    surrounds: {
        maxSlopePct: number;
        /** Deepest point below the green mean, in meters (≥ 0; 0 = no hollow). */
        deepestHollowM: number;
    };
    /** Relative-mode normalization scale (max |height − greenMean|, floored). */
    relScaleM: number;
}

/** Scan the grid once for the panel stats + relative-ramp normalization. */
export function computeStats(grid: SampleGrid, slope: SlopeGrid): AnalysisStats {
    const { heights, insideMask } = grid;
    let inMin = Infinity, inMax = -Infinity, inSum = 0, inCount = 0;
    let outMin = Infinity;
    let inMaxSlope = 0, inSlopeSum = 0, inSlopeCount = 0;
    let outMaxSlope = 0;

    for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (h === null) continue;
        const s = slope.slopePct[i];
        if (insideMask[i]) {
            inCount++;
            inSum += h;
            if (h < inMin) inMin = h;
            if (h > inMax) inMax = h;
            if (!Number.isNaN(s)) {
                inSlopeSum += s;
                inSlopeCount++;
                if (s > inMaxSlope) inMaxSlope = s;
            }
        } else {
            if (h < outMin) outMin = h;
            if (!Number.isNaN(s) && s > outMaxSlope) outMaxSlope = s;
        }
    }

    const mean = inCount > 0 ? inSum / inCount : 0;
    if (inCount === 0) {
        inMin = 0;
        inMax = 0;
    }

    let maxAbsDelta = 0;
    for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (h === null) continue;
        const d = Math.abs(h - mean);
        if (d > maxAbsDelta) maxAbsDelta = d;
    }

    return {
        green: {
            minHeight: inMin,
            maxHeight: inMax,
            deltaHeight: inMax - inMin,
            maxSlopePct: inMaxSlope,
            avgSlopePct: inSlopeCount > 0 ? inSlopeSum / inSlopeCount : 0,
            meanHeight: mean,
        },
        surrounds: {
            maxSlopePct: outMaxSlope,
            deepestHollowM: Number.isFinite(outMin) ? Math.max(0, mean - outMin) : 0,
        },
        relScaleM: Math.min(Math.max(REL_SCALE_MIN_M, maxAbsDelta), REL_SCALE_MAX_M),
    };
}

// ─── Grid → RGBA image ────────────────────────────────────────────────────

/** Full-strength overlay alpha for cells inside the green. */
export const INSIDE_ALPHA = Math.round(0.85 * 255);
/** Reduced alpha for the surrounds — keeps the boundary unmistakable. */
export const OUTSIDE_ALPHA = Math.round(0.55 * 255);

/**
 * RGBA pixel buffer (ImageData layout, one pixel per grid cell, row 0 =
 * north) for an overlay mode. Inside-green cells render at full strength,
 * surrounds reduced, nodata transparent.
 */
export function buildOverlayRgba(
    grid: SampleGrid,
    mode: AnalysisMode,
    slope: SlopeGrid,
    stats: AnalysisStats,
): Uint8ClampedArray<ArrayBuffer> {
    const { heights, insideMask } = grid;
    const out = new Uint8ClampedArray(heights.length * 4);
    const { minHeight, maxHeight, meanHeight } = stats.green;
    const heightRange = Math.max(maxHeight - minHeight, 1e-9);

    // Derived grid on demand: the overlay is only rebuilt on mode/grid
    // change, and the grid is small enough that the smooth+diff is trivial.
    const curvature = mode === 'curvature' ? computeCurvatureGrid(grid) : new Float64Array(0);

    // Per-green auto-contrast: pin the curvature ramp to the p95 of
    // inside-green |convexity|, clamped.
    let curvScale = CURV_SCALE_MIN_PCT_PER_M;
    if (mode === 'curvature') {
        const p95 = absQuantile(curvature, grid.insideMask, 0.95) ?? curvScale;
        curvScale = Math.min(Math.max(p95, CURV_SCALE_MIN_PCT_PER_M), CURV_SCALE_MAX_PCT_PER_M);
    }

    for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (h === null) continue; // alpha stays 0

        let rgb: Rgb;
        if (mode === 'slope') {
            rgb = slopeColor(slope.slopePct[i]);
        } else if (mode === 'height') {
            rgb = heightColor((h - minHeight) / heightRange);
        } else if (mode === 'relative') {
            rgb = relativeColor(h - meanHeight, stats.relScaleM);
        } else {
            rgb = curvatureColor(Number.isNaN(curvature[i]) ? 0 : curvature[i], curvScale);
        }

        const o = i * 4;
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
        out[o + 3] = insideMask[i] ? INSIDE_ALPHA : OUTSIDE_ALPHA;
    }
    return out;
}

// ─── 1 m reference grid ───────────────────────────────────────────────────

/** A straight line segment, EPSG:3006 [[e, n], [e, n]]. */
export type Seg3006 = [[number, number], [number, number]];

/**
 * 1×1 m reference grid over the sampled area, aligned to whole EPSG:3006
 * meters (so the grid is a true world grid, stable across re-fetches and
 * buffer changes — not anchored to the sample origin). One segment per
 * line, spanning the full sampled rectangle.
 */
export function buildMeterGridLines(grid: SampleGrid): Seg3006[] {
    const { origin, resolution, width, height } = grid;
    const east = origin.e + width * resolution;
    const south = origin.n - height * resolution;
    const lines: Seg3006[] = [];
    for (let e = Math.ceil(origin.e); e <= east; e += 1) {
        lines.push([[e, origin.n], [e, south]]);
    }
    for (let n = Math.ceil(south); n <= origin.n; n += 1) {
        lines.push([[origin.e, n], [east, n]]);
    }
    return lines;
}

// ─── Elevation contours (marching squares) ────────────────────────────────

/** Contour interval — one line every 2 cm of elevation. */
export const CONTOUR_INTERVAL_M = 0.02;
/** Every 5th level (10 cm multiples) is an index contour, drawn heavier. */
export const CONTOUR_INDEX_EVERY = 5;

export interface ContourLevel {
    /** Absolute elevation of this contour, meters. */
    level: number;
    /** Index contour (10 cm multiple) — style heavier. */
    index: boolean;
    /** Unordered segments tracing the isoline, EPSG:3006. */
    segments: Seg3006[];
}

/**
 * Marching-squares elevation contours over the sample grid at `intervalM`
 * spacing. Levels are absolute-elevation multiples of the interval (stable
 * across re-fetches). Grid nodes are cell centers; 2×2 blocks with any
 * nodata corner are skipped, so contours stop cleanly at the data edge.
 * Saddle blocks are disambiguated by the block's center average. Segments
 * are emitted unjoined — the renderer draws them as one MultiLineString per
 * level, so joining buys nothing.
 */
export function computeContours(grid: SampleGrid, intervalM: number = CONTOUR_INTERVAL_M): ContourLevel[] {
    const { width, height, heights, resolution, origin } = grid;
    const byLevel = new Map<number, Seg3006[]>();

    // Node (row, col) → cell-center coordinate.
    const nodeE = (col: number): number => origin.e + (col + 0.5) * resolution;
    const nodeN = (row: number): number => origin.n - (row + 0.5) * resolution;

    for (let row = 0; row < height - 1; row++) {
        for (let col = 0; col < width - 1; col++) {
            const tl = heights[row * width + col];
            const tr = heights[row * width + col + 1];
            const bl = heights[(row + 1) * width + col];
            const br = heights[(row + 1) * width + col + 1];
            if (tl === null || tr === null || bl === null || br === null) continue;

            const min = Math.min(tl, tr, bl, br);
            const max = Math.max(tl, tr, bl, br);
            const first = Math.ceil(min / intervalM);
            const last = Math.floor(max / intervalM);

            const e0 = nodeE(col), e1 = nodeE(col + 1);
            const n0 = nodeN(row), n1 = nodeN(row + 1);

            for (let k = first; k <= last; k++) {
                const L = k * intervalM;
                // Edge crossings, linearly interpolated. Only evaluated on
                // edges the case table selects, where the sign differs and
                // the denominator is non-zero.
                const top = (): [number, number] => [e0 + ((L - tl) / (tr - tl)) * resolution, n0];
                const bottom = (): [number, number] => [e0 + ((L - bl) / (br - bl)) * resolution, n1];
                const left = (): [number, number] => [e0, n0 - ((L - tl) / (bl - tl)) * resolution];
                const right = (): [number, number] => [e1, n0 - ((L - tr) / (br - tr)) * resolution];

                const idx = (tl >= L ? 1 : 0) | (tr >= L ? 2 : 0) | (br >= L ? 4 : 0) | (bl >= L ? 8 : 0);
                if (idx === 0 || idx === 15) continue;

                const segs: Seg3006[] = [];
                switch (idx) {
                    case 1: case 14: segs.push([top(), left()]); break;
                    case 2: case 13: segs.push([top(), right()]); break;
                    case 3: case 12: segs.push([left(), right()]); break;
                    case 4: case 11: segs.push([right(), bottom()]); break;
                    case 6: case 9: segs.push([top(), bottom()]); break;
                    case 7: case 8: segs.push([left(), bottom()]); break;
                    case 5: // tl+br high — saddle
                        if ((tl + tr + bl + br) / 4 >= L) segs.push([top(), right()], [bottom(), left()]);
                        else segs.push([top(), left()], [right(), bottom()]);
                        break;
                    case 10: // tr+bl high — saddle
                        if ((tl + tr + bl + br) / 4 >= L) segs.push([top(), left()], [right(), bottom()]);
                        else segs.push([top(), right()], [bottom(), left()]);
                        break;
                }
                let bucket = byLevel.get(k);
                if (!bucket) byLevel.set(k, bucket = []);
                bucket.push(...segs);
            }
        }
    }

    return [...byLevel.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([k, segments]) => ({
            level: k * intervalM,
            index: k % CONTOUR_INDEX_EVERY === 0,
            segments,
        }));
}

// ─── Fall-line arrows (slope mode; reference §2.5 heuristic) ──────────────

export interface FallLineArrow {
    /** Arrow anchor, EPSG:3006. */
    e: number;
    n: number;
    /** Downhill unit vector. */
    dirE: number;
    dirN: number;
    slopePct: number;
    /** Every 3rd arrow carries a slope% text label (ARROW_LABEL_EVERY). */
    labeled: boolean;
}

/** Arrows below this slope are noise, not signal (reference: skip < 0.5%). */
export const ARROW_MIN_SLOPE_PCT = 0.5;

/** Every Nth emitted arrow carries a slope% label. */
export const ARROW_LABEL_EVERY = 3;

/**
 * Sample fall-line arrows on a coarse grid over the analysis area:
 * spacing = max(1.5 m, min(width, height) / 10) — roughly 10×10, never
 * denser than 1.5 m (the reference's 8×8 / 2 m heuristic, densified ~50%
 * for readability on real greens). Skips nodata and near-flat cells; every
 * 3rd emitted arrow is labeled.
 */
export function sampleFallLines(grid: SampleGrid, slope: SlopeGrid): FallLineArrow[] {
    const widthM = grid.width * grid.resolution;
    const heightM = grid.height * grid.resolution;
    const spacing = Math.max(1.5, Math.min(widthM, heightM) / 10);

    const arrows: FallLineArrow[] = [];
    let emitted = 0;
    for (let n = grid.origin.n - spacing / 2; n > grid.origin.n - heightM; n -= spacing) {
        for (let e = grid.origin.e + spacing / 2; e < grid.origin.e + widthM; e += spacing) {
            const col = Math.floor((e - grid.origin.e) / grid.resolution);
            const row = Math.floor((grid.origin.n - n) / grid.resolution);
            if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) continue;
            const i = row * grid.width + col;
            const pct = slope.slopePct[i];
            if (Number.isNaN(pct) || pct <= ARROW_MIN_SLOPE_PCT) continue;
            arrows.push({
                e,
                n,
                dirE: slope.dirE[i],
                dirN: slope.dirN[i],
                slopePct: pct,
                labeled: emitted % ARROW_LABEL_EVERY === 0,
            });
            emitted++;
        }
    }
    return arrows;
}

// ─── Point probe (tap a point → slope there) ──────────────────────────────

/** Interpolated slope at a tapped/clicked point, EPSG:3006. */
export interface SlopeProbe {
    e: number;
    n: number;
    /** Bilinear slope magnitude, percent. */
    slopePct: number;
    /** Downhill unit vector; (0, 0) when the point is locally flat. */
    dirE: number;
    dirN: number;
}

/**
 * Slope at an arbitrary point: bilinear over the four surrounding cell
 * centers, skipping nodata cells and renormalizing the weights (so a probe
 * next to the grid edge or a nodata hole still reads from what IS there).
 * Magnitude interpolates the scalar slope%; direction interpolates the
 * downhill *vector* (so opposing faces cancel toward flat on a crest instead
 * of averaging into a fictitious direction). Null when the point is outside
 * the grid extent or has no valid neighbor cell.
 */
export function sampleSlopeAt(
    grid: SampleGrid,
    slope: SlopeGrid,
    e: number,
    n: number,
): SlopeProbe | null {
    const { origin, resolution, width, height } = grid;
    if (e < origin.e || e > origin.e + width * resolution) return null;
    if (n > origin.n || n < origin.n - height * resolution) return null;

    // Position in cell-center space (cell centers sit at +0.5 cells).
    const fx = (e - origin.e) / resolution - 0.5;
    const fy = (origin.n - n) / resolution - 0.5;
    const col0 = Math.floor(fx);
    const row0 = Math.floor(fy);
    const tx = fx - col0;
    const ty = fy - row0;

    let wSum = 0;
    let pctSum = 0;
    let vE = 0;
    let vN = 0;
    for (const [col, row, w] of [
        [col0, row0, (1 - tx) * (1 - ty)],
        [col0 + 1, row0, tx * (1 - ty)],
        [col0, row0 + 1, (1 - tx) * ty],
        [col0 + 1, row0 + 1, tx * ty],
    ]) {
        if (col < 0 || col >= width || row < 0 || row >= height) continue;
        const i = row * width + col;
        const pct = slope.slopePct[i];
        if (Number.isNaN(pct)) continue;
        wSum += w;
        pctSum += w * pct;
        vE += w * slope.dirE[i] * pct;
        vN += w * slope.dirN[i] * pct;
    }
    if (wSum < 1e-9) return null;

    const slopePct = pctSum / wSum;
    const mag = Math.hypot(vE, vN);
    return {
        e,
        n,
        slopePct,
        dirE: mag > 1e-9 ? vE / mag : 0,
        dirN: mag > 1e-9 ? vN / mag : 0,
    };
}

/** 8-way compass name for a downhill direction, e.g. "NE"; null when flat. */
export function fallDirectionLabel(dirE: number, dirN: number): string | null {
    if (dirE === 0 && dirN === 0) return null;
    const bearing = (Math.atan2(dirE, dirN) * 180) / Math.PI;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return names[Math.round(((bearing + 360) % 360) / 45) % 8];
}
