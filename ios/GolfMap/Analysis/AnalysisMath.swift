import Foundation

/// Pure math for the green + surrounds analysis ("Green view"): slope/aspect
/// from central differences, the exact color ramps from the web
/// implementation, per-green height normalization, the height-relative-to-
/// green diverging ramp (hollows view), grid → RGBA mapping with
/// inside/outside alpha, stats, and fall-line arrow sampling.
///
/// Faithful Swift port of `web/src/analysis/analysis-math.ts` — the two MUST
/// stay numerically identical (same ramps, same thresholds, same alphas), so
/// a green reads the same on the web editor and on the phone.

public enum AnalysisMode: String, CaseIterable, Sendable {
    case slope
    case height
    case relative
}

/// An 8-bit RGB color (ramp output).
public struct AnalysisRGB: Equatable, Sendable {
    public var r: Int
    public var g: Int
    public var b: Int

    public init(_ r: Int, _ g: Int, _ b: Int) {
        self.r = r
        self.g = g
        self.b = b
    }
}

// MARK: - Slope / aspect (central differences)

/// Per-cell slope% + downhill unit vector (EPSG:3006 east/north components).
/// NaN where heights are missing.
public struct SlopeGrid: Sendable {
    public var slopePct: [Double]
    public var dirE: [Double]
    public var dirN: [Double]
}

/// Per-cell slope% + downhill direction via central differences (one-sided at
/// grid borders and next to nodata cells). Row 0 is the northernmost row, so
/// dz/dnorth uses row−1 minus row+1.
public func computeSlopeGrid(_ grid: SampleGrid) -> SlopeGrid {
    let width = grid.spec.width
    let height = grid.spec.height
    let resolution = grid.spec.resolution
    let heights = grid.heights
    var slopePct = [Double](repeating: .nan, count: width * height)
    var dirE = [Double](repeating: .nan, count: width * height)
    var dirN = [Double](repeating: .nan, count: width * height)

    func h(_ row: Int, _ col: Int) -> Double { heights[row * width + col] }

    for row in 0..<height {
        for col in 0..<width {
            if h(row, col).isNaN { continue }

            // East axis: prefer central, fall back to one-sided around nodata.
            let cl = col > 0 && !h(row, col - 1).isNaN ? col - 1 : col
            let cr = col < width - 1 && !h(row, col + 1).isNaN ? col + 1 : col
            // North axis (row index grows southward).
            let rn = row > 0 && !h(row - 1, col).isNaN ? row - 1 : row
            let rs = row < height - 1 && !h(row + 1, col).isNaN ? row + 1 : row
            if cl == cr || rn == rs { continue }

            let dzde = (h(row, cr) - h(row, cl)) / (Double(cr - cl) * resolution)
            let dzdn = (h(rn, col) - h(rs, col)) / (Double(rs - rn) * resolution)
            let mag = (dzde * dzde + dzdn * dzdn).squareRoot()

            let i = row * width + col
            slopePct[i] = mag * 100
            if mag > 0 {
                dirE[i] = -dzde / mag // downhill = negative gradient
                dirN[i] = -dzdn / mag
            } else {
                dirE[i] = 0
                dirN[i] = 0
            }
        }
    }
    return SlopeGrid(slopePct: slopePct, dirE: dirE, dirN: dirN)
}

// MARK: - Color ramps (exact stops from the web implementation)

private func mix(_ a: AnalysisRGB, _ b: AnalysisRGB, _ t: Double) -> AnalysisRGB {
    AnalysisRGB(
        Int((Double(a.r) + Double(b.r - a.r) * t).rounded()),
        Int((Double(a.g) + Double(b.g - a.g) * t).rounded()),
        Int((Double(a.b) + Double(b.b - a.b) * t).rounded())
    )
}

private func clamp01(_ t: Double) -> Double { min(max(t, 0), 1) }

// Slope ramp: 0–7%+ professional green-reading scale.
public let SLOPE_BLUE = AnalysisRGB(51, 128, 255)
public let SLOPE_GREEN = AnalysisRGB(51, 204, 51)
public let SLOPE_ORANGE = AnalysisRGB(255, 128, 26)
public let SLOPE_MAGENTA = AnalysisRGB(255, 51, 153)

/// Slope ramp: <1% blue, 1–3% blue→green, 3–5% green→orange, 5–7%
/// orange→magenta, ≥7% magenta.
public func slopeColor(_ slopePct: Double) -> AnalysisRGB {
    if slopePct.isNaN || slopePct < 1 { return SLOPE_BLUE }
    if slopePct < 3 { return mix(SLOPE_BLUE, SLOPE_GREEN, (slopePct - 1) / 2) }
    if slopePct < 5 { return mix(SLOPE_GREEN, SLOPE_ORANGE, (slopePct - 3) / 2) }
    if slopePct < 7 { return mix(SLOPE_ORANGE, SLOPE_MAGENTA, (slopePct - 5) / 2) }
    return SLOPE_MAGENTA
}

/// Height ramp: 5-stop, normalized to the green's own local min/max.
public let HEIGHT_STOPS: [AnalysisRGB] = [
    AnalysisRGB(0, 102, 255), // blue
    AnalysisRGB(0, 204, 51), // green
    AnalysisRGB(255, 255, 0), // yellow
    AnalysisRGB(255, 136, 0), // orange
    AnalysisRGB(255, 0, 0), // red
]

/// Height ramp over t ∈ [0,1] (per-green normalized elevation), 4 bands of 0.25.
public func heightColor(_ t: Double) -> AnalysisRGB {
    let u = clamp01(t.isNaN ? 0 : t)
    let band = min(3, Int(floor(u / 0.25)))
    return mix(HEIGHT_STOPS[band], HEIGHT_STOPS[band + 1], (u - Double(band) * 0.25) / 0.25)
}

// Relative-to-green diverging ramp — the hollows ("grop") view.
public let REL_NEUTRAL = AnalysisRGB(240, 245, 235)
public let REL_BELOW_STOPS: [AnalysisRGB] = [
    REL_NEUTRAL,
    AnalysisRGB(102, 179, 255), // light blue
    AnalysisRGB(34, 85, 221), // deep blue
    AnalysisRGB(85, 34, 170), // purple — deepest hollow
]
public let REL_ABOVE_STOPS: [AnalysisRGB] = [
    REL_NEUTRAL,
    AnalysisRGB(255, 221, 102), // light warm
    AnalysisRGB(255, 136, 0), // orange
    AnalysisRGB(204, 34, 0), // red — highest mound
]

/// Diverging ramp for height relative to the green's mean inside-elevation.
/// `deltaM` = cell height − green mean; `scaleM` = normalization scale.
public func relativeColor(deltaM: Double, scaleM: Double) -> AnalysisRGB {
    let u = deltaM.isNaN ? 0 : min(max(deltaM / scaleM, -1), 1)
    let stops = u < 0 ? REL_BELOW_STOPS : REL_ABOVE_STOPS
    let m = abs(u) * 3
    let band = min(2, Int(floor(m)))
    return mix(stops[band], stops[band + 1], m - Double(band))
}

/// Minimum relative-mode scale — avoids amplifying pure noise on flat sites.
public let REL_SCALE_MIN_M = 0.3
/// Maximum relative-mode scale — golf-relevant hollows/mounds are ≤ ~2 m from
/// green level; beyond the cap the ramp saturates.
public let REL_SCALE_MAX_M = 2.0

// MARK: - Stats

public struct AnalysisStats: Equatable, Sendable {
    public struct Green: Equatable, Sendable {
        public var minHeight: Double
        public var maxHeight: Double
        public var deltaHeight: Double
        public var maxSlopePct: Double
        public var avgSlopePct: Double
        /// Mean inside-green elevation — the zero level of the relative ramp.
        public var meanHeight: Double
    }

    public struct Surrounds: Equatable, Sendable {
        public var maxSlopePct: Double
        /// Deepest point below the green mean, meters (≥ 0; 0 = no hollow).
        public var deepestHollowM: Double
    }

    public var green: Green
    public var surrounds: Surrounds
    /// Relative-mode normalization scale (max |height − greenMean|, floored/capped).
    public var relScaleM: Double
}

/// Scan the grid once for the panel stats + relative-ramp normalization.
public func computeStats(_ grid: SampleGrid, slope: SlopeGrid) -> AnalysisStats {
    let heights = grid.heights
    let insideMask = grid.insideMask
    var inMin = Double.infinity, inMax = -Double.infinity, inSum = 0.0
    var inCount = 0
    var outMin = Double.infinity
    var inMaxSlope = 0.0, inSlopeSum = 0.0
    var inSlopeCount = 0
    var outMaxSlope = 0.0

    for i in 0..<heights.count {
        let h = heights[i]
        if h.isNaN { continue }
        let s = slope.slopePct[i]
        if insideMask[i] {
            inCount += 1
            inSum += h
            inMin = min(inMin, h)
            inMax = max(inMax, h)
            if !s.isNaN {
                inSlopeSum += s
                inSlopeCount += 1
                inMaxSlope = max(inMaxSlope, s)
            }
        } else {
            outMin = min(outMin, h)
            if !s.isNaN {
                outMaxSlope = max(outMaxSlope, s)
            }
        }
    }

    let mean = inCount > 0 ? inSum / Double(inCount) : 0
    if inCount == 0 {
        inMin = 0
        inMax = 0
    }

    var maxAbsDelta = 0.0
    for h in heights where !h.isNaN {
        maxAbsDelta = max(maxAbsDelta, abs(h - mean))
    }

    return AnalysisStats(
        green: AnalysisStats.Green(
            minHeight: inMin,
            maxHeight: inMax,
            deltaHeight: inMax - inMin,
            maxSlopePct: inMaxSlope,
            avgSlopePct: inSlopeCount > 0 ? inSlopeSum / Double(inSlopeCount) : 0,
            meanHeight: mean
        ),
        surrounds: AnalysisStats.Surrounds(
            maxSlopePct: outMaxSlope,
            deepestHollowM: outMin.isFinite ? max(0, mean - outMin) : 0
        ),
        relScaleM: min(max(REL_SCALE_MIN_M, maxAbsDelta), REL_SCALE_MAX_M)
    )
}

// MARK: - Grid → RGBA image

/// Full-strength overlay alpha for cells inside the green (0.85 × 255).
public let INSIDE_ALPHA: UInt8 = 217
/// Reduced alpha for the surrounds (0.55 × 255).
public let OUTSIDE_ALPHA: UInt8 = 140

/// RGBA pixel buffer (one pixel per grid cell, row 0 = north, non-
/// premultiplied) for an overlay mode. Inside-green cells render at full
/// strength, surrounds reduced, nodata transparent.
public func buildOverlayRgba(
    _ grid: SampleGrid,
    mode: AnalysisMode,
    slope: SlopeGrid,
    stats: AnalysisStats
) -> [UInt8] {
    let heights = grid.heights
    var out = [UInt8](repeating: 0, count: heights.count * 4)
    let minHeight = stats.green.minHeight
    let meanHeight = stats.green.meanHeight
    let heightRange = max(stats.green.maxHeight - minHeight, 1e-9)

    for i in 0..<heights.count {
        let h = heights[i]
        if h.isNaN { continue } // alpha stays 0

        let rgb: AnalysisRGB
        switch mode {
        case .slope: rgb = slopeColor(slope.slopePct[i])
        case .height: rgb = heightColor((h - minHeight) / heightRange)
        case .relative: rgb = relativeColor(deltaM: h - meanHeight, scaleM: stats.relScaleM)
        }

        let o = i * 4
        out[o] = UInt8(min(max(rgb.r, 0), 255))
        out[o + 1] = UInt8(min(max(rgb.g, 0), 255))
        out[o + 2] = UInt8(min(max(rgb.b, 0), 255))
        out[o + 3] = grid.insideMask[i] ? INSIDE_ALPHA : OUTSIDE_ALPHA
    }
    return out
}

// MARK: - Fall-line arrows

public struct FallLineArrow: Equatable, Sendable {
    /// Arrow anchor, EPSG:3006.
    public var e: Double
    public var n: Double
    /// Downhill unit vector.
    public var dirE: Double
    public var dirN: Double
    public var slopePct: Double
    /// Every 3rd arrow carries a slope% text label (ARROW_LABEL_EVERY).
    public var labeled: Bool
}

/// Arrows below this slope are noise, not signal.
public let ARROW_MIN_SLOPE_PCT = 0.5

/// Every Nth emitted arrow carries a slope% label.
public let ARROW_LABEL_EVERY = 3

/// Sample fall-line arrows on a coarse grid over the analysis area:
/// spacing = max(1.5 m, min(width, height) / 10) — roughly 10×10, never
/// denser than 1.5 m (the reference's 8×8 / 2 m heuristic, densified ~50%
/// for readability on real greens). Skips nodata and near-flat cells; every
/// 3rd emitted arrow is labeled.
public func sampleFallLines(_ grid: SampleGrid, slope: SlopeGrid) -> [FallLineArrow] {
    let spec = grid.spec
    let widthM = Double(spec.width) * spec.resolution
    let heightM = Double(spec.height) * spec.resolution
    let spacing = max(1.5, min(widthM, heightM) / 10)

    var arrows: [FallLineArrow] = []
    var emitted = 0
    var n = spec.originN - spacing / 2
    while n > spec.originN - heightM {
        var e = spec.originE + spacing / 2
        while e < spec.originE + widthM {
            defer { e += spacing }
            let col = Int(floor((e - spec.originE) / spec.resolution))
            let row = Int(floor((spec.originN - n) / spec.resolution))
            guard col >= 0, col < spec.width, row >= 0, row < spec.height else { continue }
            let i = row * spec.width + col
            let pct = slope.slopePct[i]
            if pct.isNaN || pct <= ARROW_MIN_SLOPE_PCT { continue }
            arrows.append(FallLineArrow(
                e: e,
                n: n,
                dirE: slope.dirE[i],
                dirN: slope.dirN[i],
                slopePct: pct,
                labeled: emitted % ARROW_LABEL_EVERY == 0
            ))
            emitted += 1
        }
        n -= spacing
    }
    return arrows
}

// MARK: - 1 m reference grid

/// A straight line segment, EPSG:3006 endpoints.
public struct Seg3006: Equatable, Sendable {
    public var e0: Double
    public var n0: Double
    public var e1: Double
    public var n1: Double

    public init(_ e0: Double, _ n0: Double, _ e1: Double, _ n1: Double) {
        self.e0 = e0
        self.n0 = n0
        self.e1 = e1
        self.n1 = n1
    }
}

/// 1×1 m reference grid over the sampled area, aligned to whole EPSG:3006
/// meters (a true world grid, stable across re-samples and buffer changes —
/// not anchored to the sample origin). One segment per line, spanning the
/// full sampled rectangle. Mirrors the web `buildMeterGridLines`.
public func buildMeterGridLines(_ spec: AnalysisGridSpec) -> [Seg3006] {
    let east = spec.originE + Double(spec.width) * spec.resolution
    let south = spec.originN - Double(spec.height) * spec.resolution
    var lines: [Seg3006] = []
    var e = spec.originE.rounded(.up)
    while e <= east {
        lines.append(Seg3006(e, spec.originN, e, south))
        e += 1
    }
    var n = south.rounded(.up)
    while n <= spec.originN {
        lines.append(Seg3006(spec.originE, n, east, n))
        n += 1
    }
    return lines
}

// MARK: - Elevation contours (marching squares)

/// Contour interval — one line every 2 cm of elevation.
public let CONTOUR_INTERVAL_M = 0.02
/// Every 5th level (10 cm multiples) is an index contour, drawn heavier.
public let CONTOUR_INDEX_EVERY = 5

public struct ContourLevel: Equatable, Sendable {
    /// Absolute elevation of this contour, meters.
    public var level: Double
    /// Index contour (10 cm multiple) — style heavier.
    public var index: Bool
    /// Unordered segments tracing the isoline, EPSG:3006.
    public var segments: [Seg3006]
}

/// Marching-squares elevation contours over the sample grid at `intervalM`
/// spacing. Levels are absolute-elevation multiples of the interval (stable
/// across re-samples). Grid nodes are cell centers; 2×2 blocks with any
/// nodata corner are skipped, so contours stop cleanly at the data edge.
/// Saddle blocks are disambiguated by the block's center average. Segments
/// are emitted unjoined — the renderer draws them as one shape per level, so
/// joining buys nothing. Mirrors the web `computeContours`.
public func computeContours(
    _ grid: SampleGrid,
    intervalM: Double = CONTOUR_INTERVAL_M
) -> [ContourLevel] {
    let spec = grid.spec
    let width = spec.width
    let height = spec.height
    let heights = grid.heights
    var byLevel: [Int: [Seg3006]] = [:]

    // Node (row, col) → cell-center coordinate.
    func nodeE(_ col: Int) -> Double { spec.originE + (Double(col) + 0.5) * spec.resolution }
    func nodeN(_ row: Int) -> Double { spec.originN - (Double(row) + 0.5) * spec.resolution }

    for row in 0..<(height - 1) {
        for col in 0..<(width - 1) {
            let tl = heights[row * width + col]
            let tr = heights[row * width + col + 1]
            let bl = heights[(row + 1) * width + col]
            let br = heights[(row + 1) * width + col + 1]
            if tl.isNaN || tr.isNaN || bl.isNaN || br.isNaN { continue }

            let lo = min(tl, tr, bl, br)
            let hi = max(tl, tr, bl, br)
            let first = Int((lo / intervalM).rounded(.up))
            let last = Int((hi / intervalM).rounded(.down))
            if first > last { continue }

            let e0 = nodeE(col), e1 = nodeE(col + 1)
            let n0 = nodeN(row), n1 = nodeN(row + 1)
            let res = spec.resolution

            for k in first...last {
                let level = Double(k) * intervalM
                // Edge crossings, linearly interpolated. Only evaluated on
                // edges the case table selects, where the sign differs and
                // the denominator is non-zero.
                func top() -> (Double, Double) { (e0 + ((level - tl) / (tr - tl)) * res, n0) }
                func bottom() -> (Double, Double) { (e0 + ((level - bl) / (br - bl)) * res, n1) }
                func left() -> (Double, Double) { (e0, n0 - ((level - tl) / (bl - tl)) * res) }
                func right() -> (Double, Double) { (e1, n0 - ((level - tr) / (br - tr)) * res) }
                func seg(_ a: (Double, Double), _ b: (Double, Double)) -> Seg3006 {
                    Seg3006(a.0, a.1, b.0, b.1)
                }

                let idx = (tl >= level ? 1 : 0) | (tr >= level ? 2 : 0)
                    | (br >= level ? 4 : 0) | (bl >= level ? 8 : 0)
                if idx == 0 || idx == 15 { continue }

                var segs: [Seg3006] = []
                switch idx {
                case 1, 14: segs.append(seg(top(), left()))
                case 2, 13: segs.append(seg(top(), right()))
                case 3, 12: segs.append(seg(left(), right()))
                case 4, 11: segs.append(seg(right(), bottom()))
                case 6, 9: segs.append(seg(top(), bottom()))
                case 7, 8: segs.append(seg(left(), bottom()))
                case 5: // tl+br high — saddle
                    if (tl + tr + bl + br) / 4 >= level {
                        segs.append(seg(top(), right()))
                        segs.append(seg(bottom(), left()))
                    } else {
                        segs.append(seg(top(), left()))
                        segs.append(seg(right(), bottom()))
                    }
                case 10: // tr+bl high — saddle
                    if (tl + tr + bl + br) / 4 >= level {
                        segs.append(seg(top(), left()))
                        segs.append(seg(right(), bottom()))
                    } else {
                        segs.append(seg(top(), right()))
                        segs.append(seg(bottom(), left()))
                    }
                default: break
                }
                byLevel[k, default: []].append(contentsOf: segs)
            }
        }
    }

    return byLevel.keys.sorted().map { k in
        ContourLevel(
            level: Double(k) * intervalM,
            index: k % CONTOUR_INDEX_EVERY == 0,
            segments: byLevel[k] ?? []
        )
    }
}
