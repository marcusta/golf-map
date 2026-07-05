import XCTest
@testable import GolfMap

/// Port of the pure grid math tests in `server/services/analysis.service.test.ts`
/// (computeGridSpec / pointInRing / buildInsideMask / gaussian blur) plus
/// coverage of the iOS-only `GreenSampleGridBuilder` terrain-sampling path.
final class AnalysisGridTests: XCTestCase {

    private let bbox = AnalysisBbox(minX: 100, minY: 200, maxX: 130, maxY: 220) // 30 × 20 m

    private func squareRing(minE: Double, minN: Double, size: Double) -> [Sweref99TM.Point] {
        [
            Sweref99TM.Point(x: minE, y: minN),
            Sweref99TM.Point(x: minE + size, y: minN),
            Sweref99TM.Point(x: minE + size, y: minN + size),
            Sweref99TM.Point(x: minE, y: minN + size),
        ]
    }

    // MARK: - gaussianBlur

    func testGaussianBlurLeavesConstantGridUnchanged() {
        let w = 12, h = 10
        let grid = [Double](repeating: 7.5, count: w * h)
        let out = AnalysisGridMath.gaussianBlur(grid, width: w, height: h, radius: 3)
        for v in out {
            XCTAssertEqual(v, 7.5, accuracy: 1e-10)
        }
    }

    func testGaussianBlurSpreadsAnImpulseSymmetrically() {
        let w = 11, h = 11
        var grid = [Double](repeating: 0, count: w * h)
        grid[5 * w + 5] = 1
        let out = AnalysisGridMath.gaussianBlur(grid, width: w, height: h, radius: 3)
        XCTAssertGreaterThan(out[5 * w + 5], out[5 * w + 6])
        XCTAssertEqual(out[5 * w + 4], out[5 * w + 6], accuracy: 1e-12)
        XCTAssertEqual(out[4 * w + 5], out[6 * w + 5], accuracy: 1e-12)
        XCTAssertEqual(out[4 * w + 4], out[6 * w + 6], accuracy: 1e-12)
        for v in out {
            XCTAssertGreaterThanOrEqual(v, 0)
            XCTAssertLessThanOrEqual(v, 1)
        }
    }

    func testGaussianBlurPreservesLinearRampAwayFromEdges() {
        let w = 20, h = 20
        var grid = [Double](repeating: 0, count: w * h)
        for y in 0..<h {
            for x in 0..<w {
                grid[y * w + x] = 2 * Double(x) + 3 * Double(y)
            }
        }
        let out = AnalysisGridMath.gaussianBlur(grid, width: w, height: h, radius: 3)
        for y in 3..<(h - 3) {
            for x in 3..<(w - 3) {
                XCTAssertEqual(out[y * w + x], 2 * Double(x) + 3 * Double(y), accuracy: 1e-8)
            }
        }
    }

    func testGaussianBlurKeepsNaNCellsNaNAndDoesNotBleed() {
        let w = 9, h = 9
        var grid = [Double](repeating: 4, count: w * h)
        grid[4 * w + 4] = .nan
        let out = AnalysisGridMath.gaussianBlur(grid, width: w, height: h, radius: 3)
        XCTAssertTrue(out[4 * w + 4].isNaN)
        // Neighbors of the hole: kernel renormalized over valid cells → still 4.
        XCTAssertEqual(out[4 * w + 3], 4, accuracy: 1e-10)
        XCTAssertEqual(out[3 * w + 4], 4, accuracy: 1e-10)
        XCTAssertEqual(out[0], 4, accuracy: 1e-10)
    }

    func testGaussianBlurWithRadiusZeroIsIdentity() {
        let out = AnalysisGridMath.gaussianBlur([1, 2, 3, 4], width: 2, height: 2, radius: 0)
        XCTAssertEqual(out, [1, 2, 3, 4])
    }

    // MARK: - computeGridSpec

    func testComputeGridSpecPlacesOriginAtBufferedNWCorner() {
        let spec = AnalysisGridMath.computeGridSpec(bbox: bbox, bufferM: 10, resolutionM: 0.5)
        XCTAssertEqual(spec.originE, 90)
        XCTAssertEqual(spec.originN, 230)
        XCTAssertEqual(spec.resolution, 0.5)
        XCTAssertEqual(spec.width, 100) // (30 + 20) / 0.5
        XCTAssertEqual(spec.height, 80) // (20 + 20) / 0.5
    }

    func testComputeGridSpecClampsTheBuffer() {
        let over = AnalysisGridMath.computeGridSpec(bbox: bbox, bufferM: 500, resolutionM: 0.5)
        XCTAssertEqual(over.originE, bbox.minX - AnalysisGridMath.bufferMaxM)
        let negative = AnalysisGridMath.computeGridSpec(bbox: bbox, bufferM: -10, resolutionM: 0.5)
        XCTAssertEqual(negative.originE, bbox.minX)
    }

    func testComputeGridSpecClampsTooFineResolutionsUp() {
        let spec = AnalysisGridMath.computeGridSpec(bbox: bbox, bufferM: 10, resolutionM: 0.01)
        XCTAssertEqual(spec.resolution, AnalysisGridMath.resolutionMinM)
    }

    func testComputeGridSpecCoarsensResolutionToRespectCellCap() {
        let bigBbox = AnalysisBbox(minX: 0, minY: 0, maxX: 380, maxY: 380)
        let spec = AnalysisGridMath.computeGridSpec(bbox: bigBbox, bufferM: 10, resolutionM: 0.5)
        XCTAssertLessThanOrEqual(spec.width, AnalysisGridMath.maxCellsPerAxis)
        XCTAssertLessThanOrEqual(spec.height, AnalysisGridMath.maxCellsPerAxis)
        XCTAssertEqual(spec.resolution, 1.0, accuracy: 1e-10)
    }

    func testComputeGridSpecFallsBackToDefaultsForNonFiniteInputs() {
        let spec = AnalysisGridMath.computeGridSpec(bbox: bbox, bufferM: .nan, resolutionM: .nan)
        XCTAssertEqual(spec.originE, bbox.minX - AnalysisGridMath.defaultBufferM)
        XCTAssertEqual(spec.resolution, AnalysisGridMath.defaultResolutionM)
    }

    // MARK: - ringsBbox

    func testRingsBboxCoversAllRingsAndRejectsDegenerate() {
        let bbox = AnalysisGridMath.ringsBbox([squareRing(minE: 100, minN: 200, size: 30)])
        XCTAssertEqual(bbox, AnalysisBbox(minX: 100, minY: 200, maxX: 130, maxY: 230))
        let degenerate = [[Sweref99TM.Point](repeating: .init(x: 1, y: 1), count: 3)]
        XCTAssertNil(AnalysisGridMath.ringsBbox(degenerate))
        XCTAssertNil(AnalysisGridMath.ringsBbox([]))
    }

    // MARK: - pointInRing / buildInsideMask

    func testPointInRingBasicContainment() {
        let square = squareRing(minE: 0, minN: 0, size: 10)
        XCTAssertTrue(AnalysisGridMath.pointInRing(x: 5, y: 5, ring: square))
        XCTAssertFalse(AnalysisGridMath.pointInRing(x: -1, y: 5, ring: square))
        XCTAssertFalse(AnalysisGridMath.pointInRing(x: 5, y: 11, ring: square))
    }

    func testBuildInsideMaskMarksGreenCellsTrueAndBufferCellsFalse() {
        let rings = [squareRing(minE: 100, minN: 200, size: 20)]
        let bbox = AnalysisGridMath.ringsBbox(rings)!
        let spec = AnalysisGridMath.computeGridSpec(bbox: bbox, bufferM: 10, resolutionM: 0.5)
        let mask = AnalysisGridMath.buildInsideMask(spec: spec, rings: rings)
        XCTAssertEqual(mask.count, spec.width * spec.height)

        func at(_ e: Double, _ n: Double) -> Bool {
            let col = Int(floor((e - spec.originE) / spec.resolution))
            let row = Int(floor((spec.originN - n) / spec.resolution))
            return mask[row * spec.width + col]
        }
        XCTAssertTrue(at(110, 210)) // green center
        XCTAssertTrue(at(101, 201)) // just inside the corner
        XCTAssertFalse(at(95, 210)) // west buffer
        XCTAssertFalse(at(110, 225)) // north buffer
        // Exactly (20 / 0.5)^2 = 1600 cell centers land inside the square.
        XCTAssertEqual(mask.filter { $0 }.count, 1600)
    }

    func testBuildInsideMaskExcludesHoleRings() {
        let rings = [
            squareRing(minE: 100, minN: 200, size: 20),
            squareRing(minE: 108, minN: 208, size: 4),
        ]
        let bbox = AnalysisGridMath.ringsBbox(rings)!
        let spec = AnalysisGridMath.computeGridSpec(bbox: bbox, bufferM: 10, resolutionM: 0.5)
        let mask = AnalysisGridMath.buildInsideMask(spec: spec, rings: rings)
        let col = Int(floor((110 - spec.originE) / spec.resolution))
        let row = Int(floor((spec.originN - 210) / spec.resolution))
        XCTAssertFalse(mask[row * spec.width + col]) // inside the hole ring
    }

    // MARK: - GreenSampleGridBuilder (terrain-sampling adaptation)

    /// A synthetic terrain: a plane in EPSG:3006 space, sampled through the
    /// builder's WGS84 round-trip. The blur must leave the plane intact away
    /// from grid edges, so the slope math sees the analytic gradient.
    func testBuilderSamplesPlaneThroughWgs84RoundTripAndBlursHarmlessly() async throws {
        // A 20 m square "green" near Landeryd (real projected coordinates so
        // the SWEREF↔WGS84 round-trip is exercised in its valid domain).
        let minE = 540_000.0
        let minN = 6_470_000.0
        let rings = [squareRing(minE: minE, minN: minN, size: 20)]

        let built = await GreenSampleGridBuilder.build(
            rings: rings,
            bufferM: 10,
            resolutionM: 0.5,
            sampler: { coordinate in
                // Plane z = 50 + 0.03·Δe + 0.04·Δn (in projected meters).
                let p = Sweref99TM.fromWGS84(coordinate)
                return 50 + 0.03 * (p.x - minE) + 0.04 * (p.y - minN)
            }
        )
        let grid = try XCTUnwrap(built)

        XCTAssertEqual(grid.spec.width, 80) // (20 + 2·10) / 0.5
        XCTAssertEqual(grid.spec.height, 80)
        XCTAssertEqual(grid.spec.originE, minE - 10)
        XCTAssertEqual(grid.spec.originN, minN + 20 + 10)

        // Interior heights match the analytic plane (blur preserves planes;
        // WGS84 round-trip error is far below 1 mm here).
        for row in 4..<(grid.spec.height - 4) {
            for col in 4..<(grid.spec.width - 4) {
                let e = grid.spec.originE + (Double(col) + 0.5) * grid.spec.resolution
                let n = grid.spec.originN - (Double(row) + 0.5) * grid.spec.resolution
                let expected = 50 + 0.03 * (e - minE) + 0.04 * (n - minN)
                XCTAssertEqual(grid.heights[row * grid.spec.width + col], expected, accuracy: 0.002)
            }
        }

        // The slope field over the sampled grid reads the analytic 5%.
        let slope = computeSlopeGrid(grid)
        let center = (grid.spec.height / 2) * grid.spec.width + grid.spec.width / 2
        XCTAssertEqual(slope.slopePct[center], 5, accuracy: 0.05)
        XCTAssertEqual(slope.dirE[center], -0.6, accuracy: 0.01)
        XCTAssertEqual(slope.dirN[center], -0.8, accuracy: 0.01)

        // Inside mask: exactly the 40×40 cells of the square are inside.
        XCTAssertEqual(grid.insideMask.filter { $0 }.count, 1600)
    }

    func testBuilderMapsMissingTilesToNaNAndReturnsNilForDegenerateRings() async {
        let grid = await GreenSampleGridBuilder.build(
            rings: [squareRing(minE: 540_000, minN: 6_470_000, size: 10)],
            bufferM: 0,
            resolutionM: 1,
            sampler: { _ in nil } // outside terrain coverage everywhere
        )
        XCTAssertNotNil(grid)
        XCTAssertTrue(grid!.heights.allSatisfy(\.isNaN))

        let degenerate = await GreenSampleGridBuilder.build(
            rings: [],
            sampler: { _ in 1 }
        )
        XCTAssertNil(degenerate)
    }
}
