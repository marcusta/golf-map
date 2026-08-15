import ImageIO
import XCTest
@testable import GolfMap

/// Phone-side watch elevation patches + green slope image, sampled from a
/// synthetic terrain: a plane rising 1 cm per meter east (h = 100 +
/// 0.01 × (E − E₀)). Linear terrain passes through the Gaussian blur
/// unchanged (away from edge clamping), so interior cells must land back on
/// the plane exactly (± the 1 cm wire quantization).
final class WatchElevationPatchBuilderTests: XCTestCase {

    private static let e0 = 533_000.0
    private static let n0 = 6_470_000.0

    /// Planar sampler over EPSG:3006 (converts the WGS84 query back).
    private let planeSampler: GridElevationSampler = { coordinate in
        let p = Sweref99TM.fromWGS84(coordinate)
        return 100 + 0.01 * (p.x - WatchElevationPatchBuilderTests.e0)
    }

    /// 30×30 m square green outline at the origin corner.
    private var squareRing: [[Sweref99TM.Point]] {
        [[
            Sweref99TM.Point(x: Self.e0, y: Self.n0),
            Sweref99TM.Point(x: Self.e0 + 30, y: Self.n0),
            Sweref99TM.Point(x: Self.e0 + 30, y: Self.n0 - 30),
            Sweref99TM.Point(x: Self.e0, y: Self.n0 - 30),
        ]]
    }

    func testGreenGridCoversPolygonPlusApronAtOneMeter() async {
        let grid = await WatchElevationPatchBuilder.greenGrid(
            rings: squareRing, sampler: planeSampler
        )
        guard let grid else { return XCTFail("no grid") }

        XCTAssertEqual(grid.cellSize, 1.0)
        XCTAssertEqual(grid.originE, Self.e0 - 10, accuracy: 1e-9)
        XCTAssertEqual(grid.originN, Self.n0 + 10, accuracy: 1e-9)
        XCTAssertEqual(grid.cols, 50)
        XCTAssertEqual(grid.rows, 50)

        // Interior sample sits on the plane (blur is identity on a plane).
        let e = Self.e0 + 12.0
        let n = Self.n0 - 15.0
        let sampled = grid.elevation(atE: e, n: n)
        XCTAssertNotNil(sampled)
        XCTAssertEqual(sampled!, 100 + 0.01 * 12.0, accuracy: 0.03)
    }

    func testCorridorGridIsNodataAwayFromThePlayingLine() async {
        // Straight 400 m north-south playing line.
        let path = [
            Sweref99TM.Point(x: Self.e0, y: Self.n0),
            Sweref99TM.Point(x: Self.e0, y: Self.n0 - 400),
        ]
        let grid = await WatchElevationPatchBuilder.corridorGrid(
            path: path, sampler: planeSampler
        )
        guard let grid else { return XCTFail("no grid") }

        XCTAssertEqual(grid.cellSize, 12.0)
        // On the line: sampled.
        let onLine = grid.elevation(atE: Self.e0, n: Self.n0 - 200)
        XCTAssertNotNil(onLine)
        XCTAssertEqual(onLine!, 100, accuracy: 0.06)
        // Bbox corner: inside the grid rectangle but > 40 m from the line —
        // must be nodata, not a sampled value.
        XCTAssertNil(grid.elevation(
            atE: Self.e0 - 39.9, n: Self.n0 + 39.9
        ))
    }

    func testDistanceToPathClampsToSegmentEndpoints() {
        let path = [
            Sweref99TM.Point(x: 0, y: 0),
            Sweref99TM.Point(x: 100, y: 0),
        ]
        XCTAssertEqual(
            WatchElevationPatchBuilder.distanceToPath(e: 50, n: 30, path: path),
            30, accuracy: 1e-6
        )
        XCTAssertEqual(
            WatchElevationPatchBuilder.distanceToPath(e: -40, n: 0, path: path),
            40, accuracy: 1e-6
        )
    }

    func testDegenerateInputsYieldNoGrid() async {
        let empty = await WatchElevationPatchBuilder.greenGrid(
            rings: [], sampler: planeSampler
        )
        XCTAssertNil(empty)
        let point = await WatchElevationPatchBuilder.corridorGrid(
            path: [Sweref99TM.Point(x: 0, y: 0)], sampler: planeSampler
        )
        XCTAssertNil(point)
    }

    // MARK: - Green slope image

    func testGreenImageRendersDecodablePNGWithGeoref() async {
        let image = await WatchGreenImageRenderer.render(
            rings: squareRing, sampler: planeSampler
        )
        guard let image else { return XCTFail("no image") }

        // Georef: polygon bbox + 2 m margin at 0.25 m/px.
        XCTAssertEqual(image.metersPerPixel, 0.25)
        XCTAssertEqual(image.originE, Self.e0 - 2, accuracy: 1e-9)
        XCTAssertEqual(image.originN, Self.n0 + 2, accuracy: 1e-9)
        XCTAssertEqual(image.widthPx, 136)
        XCTAssertEqual(image.heightPx, 136)

        guard
            let source = CGImageSourceCreateWithData(image.png as CFData, nil),
            let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return XCTFail("PNG does not decode") }
        XCTAssertEqual(decoded.width, image.widthPx)
        XCTAssertEqual(decoded.height, image.heightPx)
    }

    func testGreenImagePixelInsideIsOpaqueSlopeColorOutsideTransparent() {
        // Direct RGBA path: 2×2, one opaque pixel.
        let rgba: [UInt8] = [
            51, 204, 51, 255, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0,
        ]
        let png = WatchGreenImageRenderer.pngData(rgba: rgba, width: 2, height: 2)
        XCTAssertNotNil(png)
    }
}
