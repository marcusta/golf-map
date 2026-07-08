import Foundation

/// Pure corridor-scan math for the LiDAR line-walk (task E1, doc
/// feature-putting-green-reading §4.1) — NO ARKit types. Everything the scan
/// pipeline does below the sensor boundary lives here so it is exhaustively
/// unit-testable with synthetic point clouds; `CorridorScanService` is a thin
/// adapter that feeds it ARKit depth points.
///
/// Two frames appear in this file — read the parameter docs carefully:
///
///  - **ARKit gravity world** (inputs from the sensor layer): right-handed,
///    **+y up** along gravity, x/z horizontal with arbitrary heading
///    (`ARWorldTrackingConfiguration.worldAlignment == .gravity`). Yaw and
///    position drift are unbounded; the vertical axis is gravity-anchored —
///    which is exactly why slope survives the walk (doc §2 insight 2).
///  - **Scan frame** (the payload contract frame, green-scan-payload.md):
///    origin at the BALL anchor on the green surface, **+z up** along gravity,
///    +x = horizontal projection of the ball→hole direction, +y left of the
///    line (right-handed). `prepareCorridor` converts world → scan frame.
///
/// The poly2 fit h(x, y) = c00 + c10·x + c01·y + c20·x² + c11·xy + c02·y²
/// (contract `fit.type == "poly2"`, coefficient order pinned by
/// `CorridorFit.coefficients`) is a weighted least-squares solve of the 6×6
/// normal equations. The QUALITY numbers (doc §4.1: never show a confident
/// read from a bad scan):
///
///  - `passMismatchSlopePct` — mean |∇h_out − ∇h_back| (Euclidean norm of the
///    gradient-vector difference, ×100) at stations along the line. THE
///    quality number: the out and back passes are independent measurements of
///    the same surface, so their disagreement is a direct error estimate.
///  - `coverageFrac` — fraction of line stations with at least
///    `minStationPoints` points in their slab. A fit extrapolating over gaps
///    is not a read.
///  - `rmseM` — fit residual. Grass-noise on a real green is a few mm; a big
///    residual means the poly2 is not describing the patch (double-tier
///    surface, junk points, tracking glitch).
///  - `endpointLevelDeltaPct` — |slope%| disagreement between the fit at the
///    two line endpoints and the two static IMU spot levels bracketing the
///    walk (the free drift check, doc §4.1). Magnitude-only on purpose: the
///    level's slope magnitude is gravity-anchored (~0.1° truth) while its
///    fall-line BEARING is compass-limited, so the magnitude is the
///    trustworthy comparison (mirrors the payload contract's "down-weight the
///    bearing, not the magnitude").
public enum CorridorFitMath {

    /// A 3-D point. The frame is documented per function — either ARKit
    /// gravity world (+y up) or the scan frame (+z up).
    public struct P3: Sendable, Equatable {
        public var x: Double
        public var y: Double
        public var z: Double

        public init(x: Double, y: Double, z: Double) {
            self.x = x
            self.y = y
            self.z = z
        }
    }

    // MARK: - QC thresholds (doc §4.1 precision budget: 0.2–0.5% slope)

    /// Pass mismatch at/under which the scan is a confident (green) read —
    /// the LOW end of the doc's 0.2–0.5% slope precision budget.
    public static let greenMaxMismatchPct = 0.2
    /// Pass mismatch at/under which the scan is marginal (yellow, re-scan
    /// suggested) — the HIGH end of the precision budget. Above = red.
    public static let yellowMaxMismatchPct = 0.5
    /// Combined-fit RMSE above which the scan is red regardless of mismatch:
    /// 1.5 cm is several times the expected grass/LiDAR noise (~3–6 mm at
    /// 1–3 m range), so a residual this large means the poly2 is not the
    /// surface (undulation beyond quadratic, junk points, tracking glitch).
    public static let maxRmseM = 0.015
    /// Coverage below which the scan is red: with more than 40% of the line
    /// unsampled the fit is extrapolation, not measurement.
    public static let minCoverageFrac = 0.6

    // MARK: - Geometry constants

    /// Half-width of the corridor band kept around the ball→hole line (doc
    /// §4.1: "~2 m corridor" — 2.5 m symmetric here because the capture can't
    /// know the high side; the UI instructs the walk to be on the high side,
    /// which biases the DENSITY that way).
    public static let corridorHalfWidthM = 1.25
    /// Points slightly beyond the line ends are kept (ball/hole anchors are
    /// camera positions, a step short of the true endpoints).
    public static let corridorXMarginM = 0.5
    /// Vertical band (scan frame, after ground anchoring) outside which a
    /// point is not the green surface (bodies, bags, flagstick).
    public static let corridorZBandM = 1.2
    /// Radius around the ball anchor whose point median sets the ground
    /// height (z = 0) of the scan frame.
    public static let groundAnchorRadiusM = 1.2
    /// Minimum points inside that radius for a trustworthy ground anchor.
    public static let minGroundAnchorPoints = 30

    /// Station spacing along the line for coverage / mismatch evaluation.
    public static let stationSpacingM = 0.5
    /// Minimum points within a station's slab (|x − station| ≤ spacing/2)
    /// for the station to count as covered.
    public static let minStationPoints = 20

    /// Payload point budget (contract: ≤ 5000 points).
    public static let maxPayloadPoints = 5000

    // MARK: - Poly2 fit

    /// A fitted poly2 surface patch (scan frame, meters).
    public struct Poly2Fit: Sendable, Equatable {
        /// [c00, c10, c01, c20, c11, c02] — the contract's coefficient order.
        public var coefficients: [Double]
        /// Weighted RMS residual, meters.
        public var rmseM: Double
        /// Points that fed the (final) solve.
        public var pointCount: Int

        public func height(x: Double, y: Double) -> Double {
            let c = coefficients
            return c[0] + c[1] * x + c[2] * y + c[3] * x * x + c[4] * x * y + c[5] * y * y
        }

        /// Analytic gradient (∂h/∂x, ∂h/∂y), rise/run fractions.
        public func gradient(x: Double, y: Double) -> (gx: Double, gy: Double) {
            let c = coefficients
            return (
                gx: c[1] + 2 * c[3] * x + c[4] * y,
                gy: c[2] + c[4] * x + 2 * c[5] * y
            )
        }

        /// Slope magnitude at a point, percent (rise/run × 100).
        public func slopePct(x: Double, y: Double) -> Double {
            let g = gradient(x: x, y: y)
            return (g.gx * g.gx + g.gy * g.gy).squareRoot() * 100
        }
    }

    /// Weighted least-squares poly2 fit over scan-frame points. `weights`
    /// (optional, default all-1) must parallel `points`; non-positive weights
    /// drop the point. Returns nil for < 6 points or a singular/degenerate
    /// system (e.g. all points collinear — a quadratic in y is then
    /// unconstrained).
    public static func fitPoly2(_ points: [P3], weights: [Double]? = nil) -> Poly2Fit? {
        guard points.count >= 6 else { return nil }
        if let weights, weights.count != points.count { return nil }

        // Normal equations: (Φᵀ W Φ) c = Φᵀ W h with φ = [1, x, y, x², xy, y²].
        var m = [Double](repeating: 0, count: 36)
        var b = [Double](repeating: 0, count: 6)
        for (i, p) in points.enumerated() {
            let w = weights?[i] ?? 1
            guard w > 0 else { continue }
            let phi = [1, p.x, p.y, p.x * p.x, p.x * p.y, p.y * p.y]
            for r in 0..<6 {
                b[r] += w * phi[r] * p.z
                for c in r..<6 {
                    m[r * 6 + c] += w * phi[r] * phi[c]
                }
            }
        }
        // Mirror the accumulated upper triangle.
        for r in 0..<6 {
            for c in 0..<r {
                m[r * 6 + c] = m[c * 6 + r]
            }
        }
        guard let coefficients = solve6(m, b) else { return nil }

        var squaredErrorSum = 0.0
        var weightSum = 0.0
        var used = 0
        let fit = Poly2Fit(coefficients: coefficients, rmseM: 0, pointCount: 0)
        for (i, p) in points.enumerated() {
            let w = weights?[i] ?? 1
            guard w > 0 else { continue }
            let r = p.z - fit.height(x: p.x, y: p.y)
            squaredErrorSum += w * r * r
            weightSum += w
            used += 1
        }
        let rmse = weightSum > 0 ? (squaredErrorSum / weightSum).squareRoot() : 0
        return Poly2Fit(coefficients: coefficients, rmseM: rmse, pointCount: used)
    }

    /// Fit, trim residual outliers beyond `sigmaCut`·RMSE, refit once. One
    /// pass of 3σ trimming handles the stray non-surface points (flagstick,
    /// shoe, depth speckle) that survive the corridor band without turning
    /// into an iterative estimator.
    public static func fitPoly2Robust(
        _ points: [P3],
        weights: [Double]? = nil,
        sigmaCut: Double = 3
    ) -> Poly2Fit? {
        guard let first = fitPoly2(points, weights: weights) else { return nil }
        guard first.rmseM > 1e-9 else { return first }
        let cut = sigmaCut * first.rmseM
        var kept: [P3] = []
        var keptWeights: [Double]? = weights == nil ? nil : []
        kept.reserveCapacity(points.count)
        for (i, p) in points.enumerated() {
            guard abs(p.z - first.height(x: p.x, y: p.y)) <= cut else { continue }
            kept.append(p)
            if weights != nil { keptWeights?.append(weights![i]) }
        }
        guard kept.count < points.count else { return first }
        return fitPoly2(kept, weights: keptWeights) ?? first
    }

    // MARK: - Stations, coverage, mismatch, endpoint check

    /// Evenly spaced stations 0…L inclusive at ~`stationSpacingM`.
    public static func stations(lineLengthM: Double) -> [Double] {
        guard lineLengthM > 0 else { return [0] }
        let count = max(2, Int((lineLengthM / stationSpacingM).rounded(.up)) + 1)
        return (0..<count).map { Double($0) * lineLengthM / Double(count - 1) }
    }

    /// Fraction of line stations with ≥ `minStationPoints` points within
    /// half a station spacing along x — the "did the walk actually sample
    /// the whole line" number.
    public static func coverageFrac(_ points: [P3], lineLengthM: Double) -> Double {
        let st = stations(lineLengthM: lineLengthM)
        let half = (st.count > 1 ? st[1] - st[0] : stationSpacingM) / 2
        var covered = 0
        for s in st {
            var n = 0
            for p in points where abs(p.x - s) <= half {
                n += 1
                if n >= minStationPoints { break }
            }
            if n >= minStationPoints { covered += 1 }
        }
        return Double(covered) / Double(st.count)
    }

    /// THE quality number (doc §4.1): mean Euclidean norm of the gradient
    /// difference between the out and back fits, evaluated on the line
    /// (y = 0) at the coverage stations, as slope percent.
    public static func passMismatchSlopePct(
        out: Poly2Fit,
        back: Poly2Fit,
        lineLengthM: Double
    ) -> Double {
        let st = stations(lineLengthM: lineLengthM)
        var sum = 0.0
        for s in st {
            let g0 = out.gradient(x: s, y: 0)
            let g1 = back.gradient(x: s, y: 0)
            let dx = g0.gx - g1.gx
            let dy = g0.gy - g1.gy
            sum += (dx * dx + dy * dy).squareRoot()
        }
        return sum / Double(st.count) * 100
    }

    /// Endpoint drift check: mean |slope% difference| between the fit at the
    /// ball (0, 0) / hole (L, 0) and the two static IMU levels. Magnitude
    /// only — the level's bearing is compass-limited (see header).
    public static func endpointLevelDeltaPct(
        fit: Poly2Fit,
        lineLengthM: Double,
        ballLevelSlopePct: Double,
        holeLevelSlopePct: Double
    ) -> Double {
        let atBall = abs(fit.slopePct(x: 0, y: 0) - ballLevelSlopePct)
        let atHole = abs(fit.slopePct(x: lineLengthM, y: 0) - holeLevelSlopePct)
        return (atBall + atHole) / 2
    }

    /// QC verdict (gates the UI: green = show read, yellow = suggest
    /// re-scan, red = refuse — doc §4.1 "never show a confident read from a
    /// bad scan"). Red floors on rmse/coverage apply regardless of mismatch.
    public static func verdict(
        passMismatchSlopePct: Double,
        rmseM: Double,
        coverageFrac: Double
    ) -> GreenScanVerdict {
        if rmseM > maxRmseM || coverageFrac < minCoverageFrac { return .red }
        if passMismatchSlopePct <= greenMaxMismatchPct { return .green }
        if passMismatchSlopePct <= yellowMaxMismatchPct { return .yellow }
        return .red
    }

    // MARK: - Decimation (payload budget)

    /// Deterministic grid-bucket downsampling to ≤ `maxCount` points: the
    /// smallest cell from a fixed √2 ladder whose occupied-bucket count fits
    /// the budget, one centroid per bucket, output sorted by cell index.
    /// Same input → same output (the decimation must be reproducible so a
    /// re-encode of the same scan uploads identical bytes).
    public static func decimate(_ points: [P3], maxCount: Int = maxPayloadPoints) -> [P3] {
        guard points.count > maxCount, maxCount > 0 else { return points }

        struct Key: Hashable, Comparable {
            var ix: Int
            var iy: Int
            static func < (a: Key, b: Key) -> Bool {
                a.ix != b.ix ? a.ix < b.ix : a.iy < b.iy
            }
        }

        var cell = 0.05
        while true {
            var buckets: [Key: (n: Double, sx: Double, sy: Double, sz: Double)] = [:]
            for p in points {
                let key = Key(
                    ix: Int((p.x / cell).rounded(.down)),
                    iy: Int((p.y / cell).rounded(.down))
                )
                var acc = buckets[key] ?? (0, 0, 0, 0)
                acc.n += 1
                acc.sx += p.x
                acc.sy += p.y
                acc.sz += p.z
                buckets[key] = acc
            }
            if buckets.count <= maxCount {
                return buckets
                    .sorted { $0.key < $1.key }
                    .map { _, a in P3(x: a.sx / a.n, y: a.sy / a.n, z: a.sz / a.n) }
            }
            cell *= 2.0.squareRoot()
        }
    }

    // MARK: - World → scan frame

    /// The prepared, scan-frame corridor clouds: filtered to the corridor
    /// band, ground-anchored (z = 0 at the green surface by the ball).
    public struct CorridorClouds: Sendable {
        /// Out-pass points, scan frame.
        public var out: [P3]
        /// Back-pass points, scan frame.
        public var back: [P3]
        /// Horizontal ball→hole distance, meters.
        public var lineLengthM: Double
        /// Bounds of the retained (out + back) points — the scanned patch
        /// `ScannedSurface` samples inside.
        public var xMin: Double
        public var xMax: Double
        public var yMin: Double
        public var yMax: Double
    }

    /// Convert raw ARKit-gravity-world clouds (+y up) into the contract scan
    /// frame and filter to the corridor:
    ///  1. Frame: origin at the ball anchor (horizontal), +x toward the hole
    ///     anchor, +y left of the line, +z up. Anchors are camera positions
    ///     at the anchor taps (≈ over the ball/hole).
    ///  2. Corridor filter: x ∈ [−margin, L+margin], |y| ≤ half-width.
    ///  3. Ground anchor: z = 0 is set to the median z of points within
    ///     `groundAnchorRadiusM` of the ball (the anchors themselves are
    ///     ~1 m above the green — camera in hand).
    ///  4. Vertical band: |z| ≤ `corridorZBandM` drops non-surface returns.
    ///
    /// Returns nil for a degenerate line (< 0.5 m horizontal) or when the
    /// ground can't be anchored (< `minGroundAnchorPoints` near the ball).
    public static func prepareCorridor(
        outWorld: [P3],
        backWorld: [P3],
        ballAnchorWorld: P3,
        holeAnchorWorld: P3
    ) -> CorridorClouds? {
        let dx = holeAnchorWorld.x - ballAnchorWorld.x
        let dz = holeAnchorWorld.z - ballAnchorWorld.z
        let length = (dx * dx + dz * dz).squareRoot()
        guard length > 0.5 else { return nil }
        // x̂ (horizontal, world x/z components); ŷ = up × x̂ = (az, −ax) —
        // LEFT of the line (right-handed, +y world up).
        let ax = dx / length
        let az = dz / length

        func toLocal(_ p: P3) -> P3 {
            let wx = p.x - ballAnchorWorld.x
            let wy = p.y - ballAnchorWorld.y
            let wz = p.z - ballAnchorWorld.z
            return P3(
                x: wx * ax + wz * az,
                y: wx * az - wz * ax,
                z: wy
            )
        }

        func corridorFiltered(_ world: [P3]) -> [P3] {
            world.map(toLocal).filter { p in
                p.x >= -corridorXMarginM && p.x <= length + corridorXMarginM
                    && abs(p.y) <= corridorHalfWidthM
            }
        }

        var out = corridorFiltered(outWorld)
        var back = corridorFiltered(backWorld)

        // Ground anchor from the combined points near the ball (the out pass
        // starts there and the back pass ends there).
        var nearBallZ: [Double] = []
        for p in out where (p.x * p.x + p.y * p.y).squareRoot() <= groundAnchorRadiusM {
            nearBallZ.append(p.z)
        }
        for p in back where (p.x * p.x + p.y * p.y).squareRoot() <= groundAnchorRadiusM {
            nearBallZ.append(p.z)
        }
        guard nearBallZ.count >= minGroundAnchorPoints else { return nil }
        let z0 = median(nearBallZ)

        func groundBanded(_ points: [P3]) -> [P3] {
            points.compactMap { p in
                let z = p.z - z0
                guard abs(z) <= corridorZBandM else { return nil }
                return P3(x: p.x, y: p.y, z: z)
            }
        }
        out = groundBanded(out)
        back = groundBanded(back)
        guard !out.isEmpty, !back.isEmpty else { return nil }

        var xMin = Double.infinity, xMax = -Double.infinity
        var yMin = Double.infinity, yMax = -Double.infinity
        for p in out + back {
            xMin = min(xMin, p.x)
            xMax = max(xMax, p.x)
            yMin = min(yMin, p.y)
            yMax = max(yMax, p.y)
        }

        return CorridorClouds(
            out: out, back: back, lineLengthM: length,
            xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax
        )
    }

    // MARK: - Sensor-boundary primitives (pure, ARKit conventions)

    /// Pinhole unprojection of a depth-map pixel into ARKit CAMERA space
    /// (x right, y up, z backward — the camera looks along −z). Image pixel
    /// coordinates have origin top-left with y DOWN, hence the y sign flip.
    /// Intrinsics must already be scaled to the depth map's resolution.
    public static func unprojectDepthPixel(
        u: Double, v: Double, depthM: Double,
        fx: Double, fy: Double, cx: Double, cy: Double
    ) -> P3 {
        P3(
            x: (u - cx) / fx * depthM,
            y: -(v - cy) / fy * depthM,
            z: -depthM
        )
    }

    /// Compass bearing of a horizontal ARKit-world direction (x/z
    /// components, +y up), given a reference horizontal direction whose
    /// compass bearing is known (the device look direction + CoreMotion
    /// heading at the same instant). Bearings increase clockwise viewed from
    /// above; with +y up, counterclockwise is positive around +y, hence the
    /// negation.
    public static func bearingDeg(
        ofX tx: Double, z tz: Double,
        referenceX rx: Double, referenceZ rz: Double,
        referenceBearingDeg: Double
    ) -> Double {
        let crossY = rz * tx - rx * tz
        let dot = rx * tx + rz * tz
        let clockwiseDeg = -atan2(crossY, dot) * 180 / .pi
        return SpotLevelMath.wrap360(referenceBearingDeg + clockwiseDeg)
    }

    // MARK: - Helpers

    /// Median of a non-empty array (mean of the middle pair for even counts).
    public static func median(_ values: [Double]) -> Double {
        precondition(!values.isEmpty)
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count % 2 == 1 { return sorted[mid] }
        return (sorted[mid - 1] + sorted[mid]) / 2
    }

    /// Gaussian elimination with partial pivoting for the 6×6 normal
    /// equations. Returns nil when the system is singular (degenerate point
    /// geometry).
    private static func solve6(_ matrix: [Double], _ rhs: [Double]) -> [Double]? {
        var a = matrix
        var b = rhs
        let n = 6
        for col in 0..<n {
            // Pivot.
            var pivotRow = col
            var pivotMag = abs(a[col * n + col])
            for r in (col + 1)..<n {
                let mag = abs(a[r * n + col])
                if mag > pivotMag {
                    pivotMag = mag
                    pivotRow = r
                }
            }
            guard pivotMag > 1e-12 else { return nil }
            if pivotRow != col {
                for c in 0..<n {
                    a.swapAt(col * n + c, pivotRow * n + c)
                }
                b.swapAt(col, pivotRow)
            }
            // Eliminate below.
            let pivot = a[col * n + col]
            for r in (col + 1)..<n {
                let factor = a[r * n + col] / pivot
                guard factor != 0 else { continue }
                for c in col..<n {
                    a[r * n + c] -= factor * a[col * n + c]
                }
                b[r] -= factor * b[col]
            }
        }
        // Back-substitute.
        var x = [Double](repeating: 0, count: n)
        for row in stride(from: n - 1, through: 0, by: -1) {
            var sum = b[row]
            for c in (row + 1)..<n {
                sum -= a[row * n + c] * x[c]
            }
            x[row] = sum / a[row * n + row]
        }
        return x
    }
}
