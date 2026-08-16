import XCTest
@testable import GolfMapWatch

/// WatchElevationGrid encode/decode + bilinear sampling. Grids here are laid
/// on a synthetic east-sloping plane (h = 0.1 m per meter east), so any
/// correctly interpolated sample must land back on the plane within the
/// 1 cm quantization of the wire format.
final class WatchElevationTests: XCTestCase {

    private static let originE = 500_000.0
    private static let originN = 6_400_000.0

    /// 10×10 grid, 1 m cells, heights = 100 + 0.1 × (east offset of the cell
    /// center).
    private func planeGrid(cellSize: Double = 1) -> WatchElevationGrid {
        let cols = 10, rows = 10
        var heights = [Double]()
        for _ in 0..<rows {
            for col in 0..<cols {
                heights.append(100 + 0.1 * (Double(col) + 0.5) * cellSize)
            }
        }
        return WatchElevationGrid(
            originE: Self.originE, originN: Self.originN,
            cellSize: cellSize, cols: cols, rows: rows, heightsM: heights
        )!
    }

    func testEncodeDecodeRoundTripsCellHeights() {
        let grid = planeGrid()
        XCTAssertEqual(grid.baseElevation, 100.05, accuracy: 1e-9)
        for col in 0..<10 {
            let expected = 100 + 0.1 * (Double(col) + 0.5)
            XCTAssertEqual(grid.height(col: col, row: 3)!, expected, accuracy: 0.011)
        }
    }

    func testBilinearSampleLandsOnThePlane() {
        let grid = planeGrid()
        // Arbitrary interior point, off every cell center.
        let e = Self.originE + 4.3
        let n = Self.originN - 6.8
        let sampled = grid.elevation(atE: e, n: n)
        XCTAssertNotNil(sampled)
        XCTAssertEqual(sampled!, 100 + 0.1 * 4.3, accuracy: 0.02)
    }

    func testEdgeStripClampsToEdgeCells() {
        let grid = planeGrid()
        // Outer half-cell strip: clamped to the first column of centers.
        let sampled = grid.elevation(atE: Self.originE + 0.1, n: Self.originN - 5)
        XCTAssertEqual(sampled!, 100.05, accuracy: 0.02)
    }

    func testOutsideGridIsNil() {
        let grid = planeGrid()
        XCTAssertNil(grid.elevation(atE: Self.originE - 1, n: Self.originN - 5))
        XCTAssertNil(grid.elevation(atE: Self.originE + 11, n: Self.originN - 5))
        XCTAssertNil(grid.elevation(atE: Self.originE + 5, n: Self.originN + 1))
        XCTAssertNil(grid.elevation(atE: Self.originE + 5, n: Self.originN - 11))
    }

    func testNodataCellDegradesToNilAtItsCenter() {
        var heights = [Double](repeating: 100, count: 100)
        heights[5 * 10 + 5] = .nan
        let grid = WatchElevationGrid(
            originE: Self.originE, originN: Self.originN,
            cellSize: 1, cols: 10, rows: 10, heightsM: heights
        )!
        // Exactly on the nodata cell's center: no valid contributor.
        XCTAssertNil(grid.elevation(atE: Self.originE + 5.5, n: Self.originN - 5.5))
        // Between it and a valid neighbor: renormalizes over the valid one.
        XCTAssertEqual(
            grid.elevation(atE: Self.originE + 5.5 + 0.4, n: Self.originN - 5.5)!,
            100, accuracy: 0.02
        )
    }

    func testAllNodataEncodesToNothing() {
        XCTAssertNil(WatchElevationGrid(
            originE: 0, originN: 0, cellSize: 1, cols: 3, rows: 3,
            heightsM: [Double](repeating: .nan, count: 9)
        ))
    }

    func testHoleElevationPrefersGreenGridOverCorridor() {
        let green = WatchElevationGrid(
            originE: Self.originE, originN: Self.originN,
            cellSize: 1, cols: 10, rows: 10,
            heightsM: [Double](repeating: 50, count: 100)
        )!
        let corridor = WatchElevationGrid(
            originE: Self.originE - 100, originN: Self.originN + 100,
            cellSize: 12, cols: 20, rows: 20,
            heightsM: [Double](repeating: 40, count: 400)
        )!
        let hole = WatchHole(
            number: 1, par: 4, tee: [59, 18], greenCenter: [59, 18],
            greenGrid: green, corridorGrid: corridor
        )
        // Inside both: the fine tier wins.
        XCTAssertEqual(
            hole.elevation(atE: Self.originE + 5, n: Self.originN - 5)!,
            50, accuracy: 0.02
        )
        // Off the green grid, on the corridor: coarse tier answers.
        XCTAssertEqual(
            hole.elevation(atE: Self.originE - 50, n: Self.originN - 5)!,
            40, accuracy: 0.02
        )
        // Off both: nil.
        XCTAssertNil(hole.elevation(atE: Self.originE - 500, n: Self.originN - 5))
    }

    func testBundleWithGridsAndImageRoundTripsThroughJSON() throws {
        let hole = WatchHole(
            number: 1, par: 4, tee: [59.3293, 18.0686], greenCenter: [59.3320, 18.0686],
            greenGrid: planeGrid(),
            corridorGrid: planeGrid(cellSize: 12),
            greenImage: WatchGreenImage(
                png: Data([0x89, 0x50, 0x4E, 0x47]),
                originE: Self.originE, originN: Self.originN,
                metersPerPixel: 0.25, widthPx: 4, heightPx: 4,
                arrows: [WatchFallArrow(
                    e: Self.originE + 2, n: Self.originN - 2,
                    dirE: -1, dirN: 0, slopePct: 2.5
                )],
                arrowLengthM: 1.53
            )
        )
        let bundle = WatchCourseBundle(
            courseId: "c1", name: "Landeryd", holes: [hole],
            builtAt: Date(timeIntervalSince1970: 1_755_000_000)
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(
            WatchCourseBundle.self, from: try encoder.encode(bundle)
        )
        XCTAssertEqual(decoded, bundle)
        XCTAssertEqual(
            decoded.holes[0].greenGrid?.elevation(atE: Self.originE + 4.3, n: Self.originN - 6.8),
            bundle.holes[0].greenGrid?.elevation(atE: Self.originE + 4.3, n: Self.originN - 6.8)
        )
    }
}
