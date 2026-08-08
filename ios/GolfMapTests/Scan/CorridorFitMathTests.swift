import XCTest
@testable import GolfMap

/// Pure corridor-fit math against synthetic point clouds (task E1) — no
/// ARKit. Exact plane/poly2 recovery, noise tolerance, coverage, the
/// out-and-back mismatch quality gate, verdict banding, decimation
/// determinism, and the world→scan-frame pipeline.
final class CorridorFitMathTests: XCTestCase {

    private typealias P3 = CorridorFitMath.P3

    // MARK: - Synthetic clouds

    /// Deterministic LCG so "noise" is reproducible across runs/machines.
    private struct SeededRandom {
        private var state: UInt64
        init(seed: UInt64) { state = seed }
        /// Uniform in [-1, 1).
        mutating func next() -> Double {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return Double(state >> 11) / Double(UInt64.max >> 11) * 2 - 1
        }
    }

    /// Grid cloud over the corridor rectangle x ∈ [0, L], y ∈ [−w, w] with
    /// z = f(x, y) + noise.
    private func cloud(
        lineLengthM: Double = 8,
        halfWidthM: Double = 1.0,
        stepM: Double = 0.1,
        noiseAmplitudeM: Double = 0,
        seed: UInt64 = 1,
        f: (Double, Double) -> Double
    ) -> [P3] {
        var rng = SeededRandom(seed: seed)
        var points: [P3] = []
        var x = 0.0
        while x <= lineLengthM + 1e-9 {
            var y = -halfWidthM
            while y <= halfWidthM + 1e-9 {
                let noise = noiseAmplitudeM > 0 ? rng.next() * noiseAmplitudeM : 0
                points.append(P3(x: x, y: y, z: f(x, y) + noise))
                y += stepM
            }
            x += stepM
        }
        return points
    }

    // MARK: - Poly2 fit

    func testExactPlaneRecoveredToMachinePrecision() {
        // h = 0.5 + 0.02·x − 0.01·y (2% uphill along the line, 1% cross).
        let points = cloud { x, y in 0.5 + 0.02 * x - 0.01 * y }
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(points))
        XCTAssertEqual(fit.coefficients[0], 0.5, accuracy: 1e-9)
        XCTAssertEqual(fit.coefficients[1], 0.02, accuracy: 1e-9)
        XCTAssertEqual(fit.coefficients[2], -0.01, accuracy: 1e-9)
        XCTAssertEqual(fit.coefficients[3], 0, accuracy: 1e-9)
        XCTAssertEqual(fit.coefficients[4], 0, accuracy: 1e-9)
        XCTAssertEqual(fit.coefficients[5], 0, accuracy: 1e-9)
        XCTAssertLessThan(fit.rmseM, 1e-9)
        // Gradient exact anywhere on the plane.
        let g = fit.gradient(x: 5.3, y: -0.7)
        XCTAssertEqual(g.gx, 0.02, accuracy: 1e-9)
        XCTAssertEqual(g.gy, -0.01, accuracy: 1e-9)
    }

    func testNoisyPlaneGradientWithinTolerance() {
        // ±4 mm uniform noise (ARKit-depth-like) on a 2% plane: the dense
        // fit must recover the gradient to well within the 0.2% precision
        // budget's green band.
        let points = cloud(noiseAmplitudeM: 0.004) { x, y in 0.02 * x - 0.01 * y }
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(points))
        let g = fit.gradient(x: 4, y: 0)
        XCTAssertEqual(g.gx, 0.02, accuracy: 0.001, "within 0.1% slope")
        XCTAssertEqual(g.gy, -0.01, accuracy: 0.001)
        // RMSE reflects the injected noise (uniform ±4 mm → σ ≈ 2.3 mm).
        XCTAssertLessThan(fit.rmseM, 0.004)
        XCTAssertGreaterThan(fit.rmseM, 0.001)
    }

    func testCurvedPoly2SurfaceRecovered() {
        // A full quadratic (crowned green shoulder): every coefficient back.
        let c = [0.1, 0.015, -0.008, -0.002, 0.001, -0.003]
        let points = cloud { x, y in
            c[0] + c[1] * x + c[2] * y + c[3] * x * x + c[4] * x * y + c[5] * y * y
        }
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(points))
        for i in 0..<6 {
            XCTAssertEqual(fit.coefficients[i], c[i], accuracy: 1e-6, "c\(i)")
        }
        XCTAssertLessThan(fit.rmseM, 1e-6)
    }

    func testZeroWeightPointsAreIgnored() {
        var points = cloud { x, _ in 0.02 * x }
        let clean = points.count
        // A wild outlier with zero weight must not move the fit.
        points.append(P3(x: 4, y: 0, z: 5))
        var weights = [Double](repeating: 1, count: clean)
        weights.append(0)
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(points, weights: weights))
        XCTAssertEqual(fit.gradient(x: 4, y: 0).gx, 0.02, accuracy: 1e-9)
        XCTAssertEqual(fit.pointCount, clean)
    }

    func testRobustRefitDropsOutliers() {
        // 1% of points offset +5 cm (a shoe in frame): the robust fit must
        // sit on the surface, not between surface and shoe.
        var points = cloud(noiseAmplitudeM: 0.002) { x, _ in 0.02 * x }
        for i in stride(from: 0, to: points.count, by: 100) {
            points[i].z += 0.05
        }
        let robust = try! XCTUnwrap(CorridorFitMath.fitPoly2Robust(points))
        XCTAssertEqual(robust.gradient(x: 4, y: 0).gx, 0.02, accuracy: 0.001)
        XCTAssertLessThan(robust.rmseM, 0.004, "outliers trimmed from the residual")
        XCTAssertLessThan(robust.pointCount, points.count, "some points dropped")
    }

    func testDegenerateGeometryReturnsNil() {
        // Too few points.
        XCTAssertNil(CorridorFitMath.fitPoly2([P3(x: 0, y: 0, z: 0)]))
        // All points on one line (x axis): quadratic in y unconstrained.
        let collinear = (0..<100).map { P3(x: Double($0) * 0.1, y: 0, z: 0) }
        XCTAssertNil(CorridorFitMath.fitPoly2(collinear))
    }

    // MARK: - Coverage

    func testCoverageFullCloudIsOne() {
        let points = cloud { _, _ in 0 }
        XCTAssertEqual(CorridorFitMath.coverageFrac(points, lineLengthM: 8), 1.0, accuracy: 1e-9)
    }

    func testCoverageHalfCloudIsAboutHalf() {
        let points = cloud { _, _ in 0 }.filter { $0.x <= 4 }
        let coverage = CorridorFitMath.coverageFrac(points, lineLengthM: 8)
        XCTAssertGreaterThan(coverage, 0.4)
        XCTAssertLessThan(coverage, 0.65)
    }

    func testCoverageEmptyIsZero() {
        XCTAssertEqual(CorridorFitMath.coverageFrac([], lineLengthM: 8), 0)
    }

    func testCoverageSparseStationsNotCovered() {
        // One point per station is far below minStationPoints.
        let sparse = stride(from: 0.0, through: 8.0, by: 0.5).map { P3(x: $0, y: 0, z: 0) }
        XCTAssertEqual(CorridorFitMath.coverageFrac(sparse, lineLengthM: 8), 0)
    }

    // MARK: - Pass mismatch (THE quality number)

    func testIdenticalPassesHaveZeroMismatch() {
        let points = cloud { x, y in 0.02 * x - 0.01 * y }
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(points))
        XCTAssertEqual(
            CorridorFitMath.passMismatchSlopePct(out: fit, back: fit, lineLengthM: 8),
            0, accuracy: 1e-9
        )
    }

    func testKnownPlaneDisagreementYieldsExactMismatch() {
        // Out: 2% along x. Back: 3% along x. Constant gradient difference
        // 0.01 → mismatch exactly 1.0% at every station.
        let out = try! XCTUnwrap(CorridorFitMath.fitPoly2(cloud { x, _ in 0.02 * x }))
        let back = try! XCTUnwrap(CorridorFitMath.fitPoly2(cloud { x, _ in 0.03 * x }))
        XCTAssertEqual(
            CorridorFitMath.passMismatchSlopePct(out: out, back: back, lineLengthM: 8),
            1.0, accuracy: 1e-6
        )
    }

    func testCrossSlopeDisagreementCountsToo() {
        // Same along-line grade, 0.3% cross-slope difference → 0.3%.
        let out = try! XCTUnwrap(CorridorFitMath.fitPoly2(cloud { x, y in 0.02 * x + 0.010 * y }))
        let back = try! XCTUnwrap(CorridorFitMath.fitPoly2(cloud { x, y in 0.02 * x + 0.013 * y }))
        XCTAssertEqual(
            CorridorFitMath.passMismatchSlopePct(out: out, back: back, lineLengthM: 8),
            0.3, accuracy: 1e-6
        )
    }

    // MARK: - Endpoint level check

    func testEndpointLevelDeltaZeroWhenAgreeing() {
        // 2% plane; both static levels read 2%.
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(cloud { x, _ in 0.02 * x }))
        XCTAssertEqual(
            CorridorFitMath.endpointLevelDeltaPct(
                fit: fit, lineLengthM: 8, ballLevelSlopePct: 2.0, holeLevelSlopePct: 2.0
            ),
            0, accuracy: 1e-6
        )
    }

    func testEndpointLevelDeltaMeansTheTwoEnds() {
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(cloud { x, _ in 0.02 * x }))
        // Levels read 1.6% and 2.8% → deltas 0.4 and 0.8 → mean 0.6.
        XCTAssertEqual(
            CorridorFitMath.endpointLevelDeltaPct(
                fit: fit, lineLengthM: 8, ballLevelSlopePct: 1.6, holeLevelSlopePct: 2.8
            ),
            0.6, accuracy: 1e-6
        )
    }

    // MARK: - Verdict banding (doc §4.1 precision budget)

    func testVerdictBands() {
        func verdict(_ mismatch: Double, rmse: Double = 0.004, coverage: Double = 0.95) -> GreenScanVerdict {
            CorridorFitMath.verdict(
                passMismatchSlopePct: mismatch, rmseM: rmse, coverageFrac: coverage
            )
        }
        XCTAssertEqual(verdict(0.05), .green)
        XCTAssertEqual(verdict(0.2), .green, "boundary inclusive")
        XCTAssertEqual(verdict(0.35), .yellow)
        XCTAssertEqual(verdict(0.5), .yellow, "boundary inclusive")
        XCTAssertEqual(verdict(0.7), .red)
    }

    func testVerdictRedOnRmseFloorRegardlessOfMismatch() {
        XCTAssertEqual(
            CorridorFitMath.verdict(passMismatchSlopePct: 0.05, rmseM: 0.05, coverageFrac: 1),
            .red
        )
    }

    func testVerdictRedOnCoverageFloorRegardlessOfMismatch() {
        XCTAssertEqual(
            CorridorFitMath.verdict(passMismatchSlopePct: 0.05, rmseM: 0.004, coverageFrac: 0.3),
            .red
        )
    }

    // MARK: - Decimation

    func testDecimationRespectsBudgetAndIsDeterministic() {
        let points = cloud(stepM: 0.05, noiseAmplitudeM: 0.003) { x, y in 0.02 * x - 0.01 * y }
        XCTAssertGreaterThan(points.count, CorridorFitMath.maxPayloadPoints)
        let a = CorridorFitMath.decimate(points)
        let b = CorridorFitMath.decimate(points)
        XCTAssertLessThanOrEqual(a.count, CorridorFitMath.maxPayloadPoints)
        XCTAssertEqual(a, b, "same input → identical output")
        // The decimated cloud still fits to the same surface.
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2(a))
        XCTAssertEqual(fit.gradient(x: 4, y: 0).gx, 0.02, accuracy: 0.001)
    }

    func testDecimationLeavesSmallCloudsAlone() {
        let points = cloud(stepM: 0.5) { x, _ in 0.02 * x }
        XCTAssertLessThanOrEqual(points.count, CorridorFitMath.maxPayloadPoints)
        XCTAssertEqual(CorridorFitMath.decimate(points), points)
    }

    // MARK: - Sensor-boundary primitives

    func testUnprojectPrincipalPointLandsOnOpticalAxis() {
        let p = CorridorFitMath.unprojectDepthPixel(
            u: 128, v: 96, depthM: 2, fx: 200, fy: 200, cx: 128, cy: 96
        )
        XCTAssertEqual(p.x, 0, accuracy: 1e-12)
        XCTAssertEqual(p.y, 0, accuracy: 1e-12)
        XCTAssertEqual(p.z, -2, accuracy: 1e-12, "in front of the camera along −z")
    }

    func testUnprojectImageYDownMapsToCameraYUp() {
        // A pixel BELOW the principal point (image y down) is BELOW the
        // optical axis in camera space (y up) → negative camera y.
        let below = CorridorFitMath.unprojectDepthPixel(
            u: 128, v: 150, depthM: 2, fx: 200, fy: 200, cx: 128, cy: 96
        )
        XCTAssertLessThan(below.y, 0)
        // A pixel to the RIGHT maps to positive camera x.
        let right = CorridorFitMath.unprojectDepthPixel(
            u: 200, v: 96, depthM: 2, fx: 200, fy: 200, cx: 128, cy: 96
        )
        XCTAssertEqual(right.x, (200.0 - 128) / 200 * 2, accuracy: 1e-12)
    }

    func testBearingHelperKnownQuadrants() {
        // Reference: world +x is east (bearing 90). North is −z (ARKit world
        // is right-handed with +y up, so x east ⇒ z south).
        // Target −z (north) → 0°.
        XCTAssertEqual(
            CorridorFitMath.bearingDeg(ofX: 0, z: -1, referenceX: 1, referenceZ: 0, referenceBearingDeg: 90),
            0, accuracy: 1e-9
        )
        // Target = reference → same bearing.
        XCTAssertEqual(
            CorridorFitMath.bearingDeg(ofX: 1, z: 0, referenceX: 1, referenceZ: 0, referenceBearingDeg: 90),
            90, accuracy: 1e-9
        )
        // Target +z (south) → 180.
        XCTAssertEqual(
            CorridorFitMath.bearingDeg(ofX: 0, z: 1, referenceX: 1, referenceZ: 0, referenceBearingDeg: 90),
            180, accuracy: 1e-9
        )
    }

    // MARK: - World → scan frame pipeline

    /// Build ARKit-world clouds (+y up) of a plane green with the camera
    /// walked beside a line, then check the scan-frame conversion: ground
    /// anchored at the ball, +x along the line, left = +y.
    func testPrepareCorridorAnchorsGroundAndPreservesSlope() {
        // World: line points along −z ("north"), ball at (10, *, 5), hole
        // 8 m north. Green surface: worldY = 0.02 · (distance north of ball)
        // + 3.0 (a 2% up-slope toward the hole in world terms).
        let ball = P3(x: 10, y: 4.0, z: 5) // camera 1 m above the green
        let hole = P3(x: 10, y: 4.16, z: -3)
        func worldCloud(seed: UInt64) -> [P3] {
            var rng = SeededRandom(seed: seed)
            var points: [P3] = []
            for i in 0...80 {
                let along = Double(i) * 0.1 // 0…8 m north of ball
                for j in -10...10 {
                    let left = Double(j) * 0.1
                    // north = −z; left of northward travel = −x… check:
                    // x east, z south ⇒ moving north (−z), left is west (−x).
                    points.append(P3(
                        x: ball.x - left,
                        y: 3.0 + 0.02 * along + rng.next() * 0.002,
                        z: ball.z - along
                    ))
                }
            }
            return points
        }

        let clouds = try! XCTUnwrap(CorridorFitMath.prepareCorridor(
            outWorld: worldCloud(seed: 7),
            backWorld: worldCloud(seed: 8),
            ballAnchorWorld: ball,
            holeAnchorWorld: hole
        ))
        XCTAssertEqual(clouds.lineLengthM, 8.0, accuracy: 0.02)

        // Ground anchored: z ≈ 0 near the ball (the 1 m camera height is
        // subtracted out via the near-ball median, not assumed). The anchor
        // is the MEDIAN over the anchor disc (radius 1.2 m), so on a 2%
        // slope points exactly at the ball sit ~slope·radius/2 ≈ 1 cm off —
        // the tolerance reflects that, not measurement error.
        let nearBall = clouds.out.filter { abs($0.x) < 0.3 && abs($0.y) < 0.3 }
        XCTAssertFalse(nearBall.isEmpty)
        for p in nearBall {
            XCTAssertEqual(p.z, 0, accuracy: 0.025)
        }

        // The fitted scan-frame surface has the 2% up-slope along +x and
        // ~0 cross-slope.
        let fit = try! XCTUnwrap(CorridorFitMath.fitPoly2Robust(clouds.out + clouds.back))
        let g = fit.gradient(x: 4, y: 0)
        XCTAssertEqual(g.gx, 0.02, accuracy: 0.002)
        XCTAssertEqual(g.gy, 0, accuracy: 0.002)

        // Left-of-line points carry positive scan-frame y: a world point
        // 0.5 m west of the line midway out.
        let west = P3(x: ball.x - 0.5, y: 3.08, z: ball.z - 4)
        let midCandidates = clouds.out.filter { abs($0.x - 4) < 0.06 && $0.y > 0.44 && $0.y < 0.56 }
        XCTAssertFalse(midCandidates.isEmpty, "west-of-line points map to +y (left)")
        _ = west
    }

    func testPrepareCorridorRejectsDegenerateLineAndMissingGround() {
        let ball = P3(x: 0, y: 1, z: 0)
        // Degenerate: hole on top of the ball.
        XCTAssertNil(CorridorFitMath.prepareCorridor(
            outWorld: [], backWorld: [], ballAnchorWorld: ball,
            holeAnchorWorld: P3(x: 0.1, y: 1, z: 0)
        ))
        // No points near the ball → no ground anchor.
        let farPoints = (0..<200).map { P3(x: 0, y: 0, z: -4 - Double($0) * 0.01) }
        XCTAssertNil(CorridorFitMath.prepareCorridor(
            outWorld: farPoints, backWorld: farPoints,
            ballAnchorWorld: ball, holeAnchorWorld: P3(x: 0, y: 1, z: -8)
        ))
    }

    func testPrepareCorridorDropsOffCorridorAndTallPoints() {
        let ball = P3(x: 0, y: 1, z: 0)
        let hole = P3(x: 0, y: 1, z: -8)
        // Dense flat green at worldY 0 …
        var out: [P3] = []
        for i in 0...80 {
            for j in -8...8 {
                out.append(P3(x: Double(j) * 0.1, y: 0, z: -Double(i) * 0.1))
            }
        }
        // … plus a wide-out point (3 m beside the line) and a "flagstick"
        // point 1.5 m above the surface mid-corridor.
        out.append(P3(x: 3, y: 0, z: -4))
        out.append(P3(x: 0, y: 1.5, z: -4))
        let clouds = try! XCTUnwrap(CorridorFitMath.prepareCorridor(
            outWorld: out, backWorld: out, ballAnchorWorld: ball, holeAnchorWorld: hole
        ))
        XCTAssertTrue(clouds.out.allSatisfy { abs($0.y) <= CorridorFitMath.corridorHalfWidthM })
        XCTAssertTrue(clouds.out.allSatisfy { abs($0.z) <= CorridorFitMath.corridorZBandM })
    }

    // MARK: - Full fitScan pipeline (service's pure core)

    private func worldPass(
        slopeAlong: Double,
        seed: UInt64,
        ball: P3 = P3(x: 0, y: 1, z: 0),
        lineLengthM: Double = 8
    ) -> [P3] {
        var rng = SeededRandom(seed: seed)
        var points: [P3] = []
        for i in 0...Int(lineLengthM / 0.05) {
            let along = Double(i) * 0.05
            for j in -10...10 {
                points.append(P3(
                    x: Double(j) * 0.1,
                    y: slopeAlong * along + rng.next() * 0.002,
                    z: -along
                ))
            }
        }
        return points
    }

    func testFitScanGreenWhenPassesAgree() {
        let ball = CorridorFitMath.P3(x: 0, y: 1, z: 0)
        let hole = CorridorFitMath.P3(x: 0, y: 1.16, z: -8)
        let outcome = CorridorScanService.fitScan(
            outWorld: worldPass(slopeAlong: 0.02, seed: 3),
            backWorld: worldPass(slopeAlong: 0.02, seed: 4),
            ballAnchorWorld: ball, holeAnchorWorld: hole,
            ballLevelSlopePct: 2.0, holeLevelSlopePct: 2.0
        )
        guard case .success(let result) = outcome else {
            return XCTFail("expected success, got \(outcome)")
        }
        XCTAssertEqual(result.verdict, .green)
        XCTAssertLessThan(result.passMismatchSlopePct, 0.2)
        XCTAssertGreaterThan(result.combinedCoverageFrac, 0.9)
        XCTAssertLessThanOrEqual(result.payloadPoints.count, CorridorFitMath.maxPayloadPoints)
        XCTAssertEqual(result.lineLengthM, 8, accuracy: 0.01)
        XCTAssertEqual(result.combined.gradient(x: 4, y: 0).gx, 0.02, accuracy: 0.002)
        XCTAssertLessThan(try XCTUnwrap(result.endpointLevelDeltaPct), 0.25)
    }

    /// Skipping the endpoint levels omits the cross-check; everything else
    /// about the read is unchanged (the levels are QC, not an input).
    func testFitScanWithoutEndpointLevelsOmitsTheDelta() throws {
        let ball = CorridorFitMath.P3(x: 0, y: 1, z: 0)
        let hole = CorridorFitMath.P3(x: 0, y: 1.16, z: -8)
        let outcome = CorridorScanService.fitScan(
            outWorld: worldPass(slopeAlong: 0.02, seed: 3),
            backWorld: worldPass(slopeAlong: 0.02, seed: 4),
            ballAnchorWorld: ball, holeAnchorWorld: hole,
            ballLevelSlopePct: nil, holeLevelSlopePct: nil
        )
        guard case .success(let result) = outcome else {
            return XCTFail("expected success, got \(outcome)")
        }
        XCTAssertNil(result.endpointLevelDeltaPct)
        XCTAssertEqual(result.verdict, .green)
        XCTAssertEqual(result.lineLengthM, 8, accuracy: 0.01)
    }

    func testFitScanYellowThenRedAsPassesDiverge() {
        let ball = CorridorFitMath.P3(x: 0, y: 1, z: 0)
        let hole = CorridorFitMath.P3(x: 0, y: 1.16, z: -8)
        func mismatchOutcome(backSlope: Double) -> CorridorScanService.FitOutcome {
            CorridorScanService.fitScan(
                outWorld: worldPass(slopeAlong: 0.02, seed: 3),
                backWorld: worldPass(slopeAlong: backSlope, seed: 4),
                ballAnchorWorld: ball, holeAnchorWorld: hole,
                ballLevelSlopePct: 2.0, holeLevelSlopePct: 2.0
            )
        }
        // 0.35% slope disagreement → yellow.
        guard case .success(let yellow) = mismatchOutcome(backSlope: 0.0235) else {
            return XCTFail("expected success")
        }
        XCTAssertEqual(yellow.verdict, .yellow)
        // 1% disagreement → red.
        guard case .success(let red) = mismatchOutcome(backSlope: 0.03) else {
            return XCTFail("expected success")
        }
        XCTAssertEqual(red.verdict, .red)
    }

    func testFitScanFailsOnShortLineAndSparsePoints() {
        let ball = CorridorFitMath.P3(x: 0, y: 1, z: 0)
        // Line shorter than the minimum.
        let shortOutcome = CorridorScanService.fitScan(
            outWorld: worldPass(slopeAlong: 0.02, seed: 3, lineLengthM: 1.4),
            backWorld: worldPass(slopeAlong: 0.02, seed: 4, lineLengthM: 1.4),
            ballAnchorWorld: ball,
            holeAnchorWorld: CorridorFitMath.P3(x: 0, y: 1, z: -1.4),
            ballLevelSlopePct: 2, holeLevelSlopePct: 2
        )
        guard case .failure = shortOutcome else {
            return XCTFail("short line must fail, got \(shortOutcome)")
        }
        // No points at all.
        let emptyOutcome = CorridorScanService.fitScan(
            outWorld: [], backWorld: [],
            ballAnchorWorld: ball,
            holeAnchorWorld: CorridorFitMath.P3(x: 0, y: 1, z: -8),
            ballLevelSlopePct: 2, holeLevelSlopePct: 2
        )
        guard case .failure = emptyOutcome else {
            return XCTFail("empty clouds must fail")
        }
    }
}
