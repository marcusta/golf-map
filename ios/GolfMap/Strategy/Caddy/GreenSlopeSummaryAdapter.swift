import Foundation

/// GreenSlopeSummary adapter — the iOS SEAM between the analysis slope engine
/// and the pure green-slope caddy rule (decision D10). Faithful mirror of
/// `web/src/planner/green-slope.ts` `summarizeGreenSlope`: `computeSlopeGrid`
/// produces a per-cell slope% + downhill vector; the pure rule wants only a
/// compact summary (dominant fall-line bearing + magnitude, plus a front/back
/// split). The rule NEVER touches the analysis math — the platform runs this
/// adapter and passes the summary in via `CaddyContext.greenSlope`.
///
/// Coordinates are EPSG:3006 {e, n}; the resulting bearing is compass degrees
/// (0 = north, clockwise), matching the strategy convention the rule assumes.
public enum GreenSlopeAdapter {

    /// A green reference point, EPSG:3006 easting/northing.
    public struct RefPoint: Equatable, Sendable {
        public var e: Double
        public var n: Double
        public init(e: Double, n: Double) {
            self.e = e
            self.n = n
        }
    }

    /// Derive the D10 `GreenSlopeSummary` from a sampled green grid and the
    /// green's front/back reference points.
    ///
    /// Dominant fall line: the slope-magnitude-weighted sum of every
    /// inside-green cell's downhill unit vector. `fallLinePct` is the magnitude
    /// of that mean vector. Front/back split: cells are projected onto the
    /// front→back axis and split at the midpoint; each half reports its mean
    /// slope%.
    ///
    /// Returns nil when the green has no usable slope cells (all nodata / dead
    /// flat) — the caller then omits `greenSlope` and the rule won't fire.
    public static func summarize(
        grid: SampleGrid,
        front: RefPoint,
        back: RefPoint,
        slope: SlopeGrid? = nil
    ) -> GreenSlopeSummary? {
        let slope = slope ?? computeSlopeGrid(grid)
        let width = grid.spec.width
        let height = grid.spec.height
        let resolution = grid.spec.resolution
        let originE = grid.spec.originE
        let originN = grid.spec.originN
        let insideMask = grid.insideMask

        // Front→back axis, for the half split. Unit vector; degenerate if front
        // and back coincide (then everything lands in one half — harmless).
        let axE = back.e - front.e
        let axN = back.n - front.n
        let axLen = { () -> Double in
            let l = hypot(axE, axN)
            return l == 0 ? 1 : l
        }()
        let uAxE = axE / axLen
        let uAxN = axN / axLen
        let frontProj = front.e * uAxE + front.n * uAxN
        let midProj = frontProj + axLen / 2

        var sumE = 0.0 // slope-weighted downhill vector
        var sumN = 0.0
        var frontSum = 0.0, frontCount = 0
        var backSum = 0.0, backCount = 0
        var anyInside = false

        for row in 0..<height {
            for col in 0..<width {
                let i = row * width + col
                if !insideMask[i] { continue }
                let pct = slope.slopePct[i]
                if pct.isNaN { continue }
                anyInside = true

                // Cell centre, EPSG:3006 (row 0 = north).
                let e = originE + (Double(col) + 0.5) * resolution
                let n = originN - (Double(row) + 0.5) * resolution

                sumE += slope.dirE[i] * pct
                sumN += slope.dirN[i] * pct

                let proj = e * uAxE + n * uAxN
                if proj <= midProj {
                    frontSum += pct
                    frontCount += 1
                } else {
                    backSum += pct
                    backCount += 1
                }
            }
        }

        guard anyInside else { return nil }

        let insideCount = Double(frontCount + backCount)
        let fallLinePct = hypot(sumE, sumN) / insideCount
        var fallLineBearingDeg = atan2(sumE, sumN) * 180 / .pi
        fallLineBearingDeg = (fallLineBearingDeg + 360).truncatingRemainder(dividingBy: 360)

        return GreenSlopeSummary(
            fallLineBearingDeg: fallLineBearingDeg,
            fallLinePct: fallLinePct,
            frontHalfPct: frontCount > 0 ? frontSum / Double(frontCount) : 0,
            backHalfPct: backCount > 0 ? backSum / Double(backCount) : 0
        )
    }
}
