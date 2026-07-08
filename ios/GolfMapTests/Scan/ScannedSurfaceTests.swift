import XCTest
@testable import GolfMap

/// The Tier-1 `ScannedSurface` adapter (task E1): scan-frame poly2 fit
/// anchored to the user-placed ball/hole markers in EPSG:3006 — on-corridor
/// samples match the fit (with the gradient rotated into world axes),
/// off-corridor samples are nil, confidence maps from the QC verdict, and
/// the surface installs through the `PuttReadModel.installScannedSurface`
/// seam.
final class ScannedSurfaceTests: XCTestCase {

    /// A 2%-along / 1%-cross plane fit over an 8 m corridor.
    private let planeCoefficients = [0.0, 0.02, 0.01, 0.0, 0.0, 0.0]

    private func surface(
        ball: Vec2 = Vec2(x: 100, y: 200),
        hole: Vec2 = Vec2(x: 108, y: 200),
        coefficients: [Double]? = nil,
        confidence: Double = ScannedSurface.greenConfidence
    ) -> ScannedSurface? {
        ScannedSurface(
            coefficients: coefficients ?? planeCoefficients,
            xMin: -0.5, xMax: 8.5, yMin: -1.25, yMax: 1.25,
            ballWorld: ball, holeWorld: hole,
            confidence: confidence
        )
    }

    // MARK: - Sampling

    func testOnCorridorSampleMatchesFitLineEast() {
        // Line due EAST: scan x̂ = world x̂, scan ŷ (left) = world +y (north).
        let s = try! XCTUnwrap(surface())
        let sample = try! XCTUnwrap(s.sampleAt(Vec2(x: 104, y: 200.5))) // 4 m out, 0.5 m left
        XCTAssertEqual(sample.height, 0.02 * 4 + 0.01 * 0.5, accuracy: 1e-12)
        XCTAssertEqual(sample.gradX, 0.02, accuracy: 1e-12)
        XCTAssertEqual(sample.gradY, 0.01, accuracy: 1e-12)
        XCTAssertEqual(sample.confidence, ScannedSurface.greenConfidence)
    }

    func testRotatedFrameGradientRotatesToWorld() {
        // Line due NORTH: scan x̂ = world +y, scan ŷ (left) = world −x (west).
        // The 2% along-line grade becomes world gradY; the 1% left-positive
        // cross grade becomes world −gradX.
        let s = try! XCTUnwrap(surface(
            ball: Vec2(x: 0, y: 0), hole: Vec2(x: 0, y: 8)
        ))
        let sample = try! XCTUnwrap(s.sampleAt(Vec2(x: 0, y: 4)))
        XCTAssertEqual(sample.gradX, -0.01, accuracy: 1e-12)
        XCTAssertEqual(sample.gradY, 0.02, accuracy: 1e-12)
        // 1 m LEFT of the northward line is 1 m WEST.
        let left = try! XCTUnwrap(s.sampleAt(Vec2(x: -1, y: 4)))
        XCTAssertEqual(left.height, 0.02 * 4 + 0.01 * 1, accuracy: 1e-12)
    }

    func testCurvedFitSampledExactly() {
        // Full quadratic, line east: local == world offsets from the ball.
        let c = [0.05, 0.015, -0.008, -0.002, 0.001, -0.003]
        let s = try! XCTUnwrap(surface(coefficients: c))
        let lx = 3.0, ly = -0.8
        let sample = try! XCTUnwrap(s.sampleAt(Vec2(x: 100 + lx, y: 200 + ly)))
        XCTAssertEqual(
            sample.height,
            c[0] + c[1] * lx + c[2] * ly + c[3] * lx * lx + c[4] * lx * ly + c[5] * ly * ly,
            accuracy: 1e-12
        )
        XCTAssertEqual(sample.gradX, c[1] + 2 * c[3] * lx + c[4] * ly, accuracy: 1e-12)
        XCTAssertEqual(sample.gradY, c[2] + c[4] * lx + 2 * c[5] * ly, accuracy: 1e-12)
    }

    func testOffCorridorSamplesAreNil() {
        let s = try! XCTUnwrap(surface())
        // Beyond the hole end (x > xMax).
        XCTAssertNil(s.sampleAt(Vec2(x: 109, y: 200)))
        // Behind the ball (x < xMin).
        XCTAssertNil(s.sampleAt(Vec2(x: 99, y: 200)))
        // Beside the corridor (|y| > 1.25).
        XCTAssertNil(s.sampleAt(Vec2(x: 104, y: 201.5)))
        XCTAssertNil(s.sampleAt(Vec2(x: 104, y: 198.5)))
        // Well inside is not nil.
        XCTAssertNotNil(s.sampleAt(Vec2(x: 104, y: 200)))
    }

    // MARK: - Confidence mapping (doc §4.1: never confident from a bad scan)

    @MainActor
    func testConfidenceMapsFromVerdict() {
        XCTAssertEqual(ScannedSurface.confidence(for: .green), ScannedSurface.greenConfidence)
        XCTAssertEqual(ScannedSurface.confidence(for: .yellow), ScannedSurface.yellowConfidence)
        XCTAssertNil(ScannedSurface.confidence(for: .red), "red never becomes a surface")
        // Green clears the read gate, yellow sits above it with softening
        // headroom below the DEM default.
        XCTAssertGreaterThan(ScannedSurface.greenConfidence, PuttReadModel.minReadConfidence)
        XCTAssertGreaterThan(ScannedSurface.yellowConfidence, PuttReadModel.minReadConfidence)
    }

    func testYellowConfidenceFlowsThroughSamples() {
        let s = try! XCTUnwrap(surface(confidence: ScannedSurface.yellowConfidence))
        XCTAssertEqual(
            try! XCTUnwrap(s.sampleAt(Vec2(x: 104, y: 200))).confidence,
            ScannedSurface.yellowConfidence
        )
    }

    // MARK: - Degenerate init

    func testDegenerateInitFails() {
        // Coincident markers: no line direction.
        XCTAssertNil(surface(ball: Vec2(x: 100, y: 200), hole: Vec2(x: 100, y: 200)))
        // Malformed coefficients.
        XCTAssertNil(surface(coefficients: [0, 0.02]))
        // Empty bounds.
        XCTAssertNil(ScannedSurface(
            coefficients: planeCoefficients,
            xMin: 2, xMax: 2, yMin: -1, yMax: 1,
            ballWorld: Vec2(x: 0, y: 0), holeWorld: Vec2(x: 8, y: 0),
            confidence: 0.9
        ))
    }

    // MARK: - The E1 seam (PuttReadModel.installScannedSurface)

    @MainActor
    func testInstallScannedSurfaceProducesTier1Read() {
        let suite = "ScannedSurfaceTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        let model = PuttReadModel(defaults: defaults)
        // No terrain grid at all — without a scan this green is Manual-only.
        model.activate(grid: nil, defaultHole: Vec2(x: 106, y: 200))
        XCTAssertEqual(model.mode, .manual)
        XCTAssertFalse(model.hasSurface)

        // A QC-passed (green) corridor scan installs through the seam…
        let s = try! XCTUnwrap(surface())
        model.installScannedSurface(s)
        XCTAssertTrue(model.hasSurface)
        XCTAssertEqual(model.mode, .surface, "scan flips the model to the Surface tier")

        // …and the tier-agnostic pipeline reads from it.
        model.placeBall(Vec2(x: 100, y: 200))
        model.placeHole(Vec2(x: 106, y: 200))
        model.computeSurfaceReadNow()
        let display = model.display
        let read = try! XCTUnwrap(display.read, "read produced from the scanned surface")
        XCTAssertEqual(read.minConfidence, ScannedSurface.greenConfidence, accuracy: 1e-9)
        XCTAssertEqual(display.status, .ok, "green-verdict scan is a full-strength read")

        // Clearing the scan falls back to no surface (no grid installed).
        model.installScannedSurface(nil)
        XCTAssertFalse(model.hasSurface)
        XCTAssertEqual(model.mode, .manual)
    }
}
