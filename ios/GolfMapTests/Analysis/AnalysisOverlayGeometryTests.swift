import XCTest
@testable import GolfMap

/// The pure map-geometry layer: heat-image corner quad and fall-line arrow
/// strokes (port of the web `gridCornerCoordinates` / `arrowsToGeojson`).
final class AnalysisOverlayGeometryTests: XCTestCase {

    func testGridCornerCoordinatesRoundTripTheSpecCorners() {
        let spec = AnalysisGridSpec(
            originE: 540_000, originN: 6_470_000, resolution: 0.5, width: 80, height: 60
        )
        let corners = AnalysisOverlayGeometry.gridCornerCoordinates(spec)
        XCTAssertEqual(corners.count, 4)

        // TL, TR, BR, BL — project back and compare with the metric corners.
        let expected = [
            (540_000.0, 6_470_000.0),
            (540_040.0, 6_470_000.0), // +80 × 0.5 m east
            (540_040.0, 6_469_970.0), // −60 × 0.5 m south
            (540_000.0, 6_469_970.0),
        ]
        for (corner, (e, n)) in zip(corners, expected) {
            let p = Sweref99TM.fromWGS84(corner)
            XCTAssertEqual(p.x, e, accuracy: 0.01)
            XCTAssertEqual(p.y, n, accuracy: 0.01)
        }
        // Orientation sanity: TL is north of BL and west of TR.
        XCTAssertGreaterThan(corners[0].lat, corners[3].lat)
        XCTAssertLessThan(corners[0].lon, corners[1].lon)
    }

    func testArrowLengthTracksSpacingWithClamps() {
        // 20×20 m grid → spacing 2.5 → length 1.5 (clamped up from 1.25).
        let small = AnalysisGridSpec(originE: 0, originN: 0, resolution: 0.5, width: 40, height: 40)
        XCTAssertEqual(AnalysisOverlayGeometry.arrowLengthM(small), 1.5)
        // 80×80 m grid → spacing 10 → length 4 (clamped down from 5).
        let large = AnalysisGridSpec(originE: 0, originN: 0, resolution: 0.5, width: 160, height: 160)
        XCTAssertEqual(AnalysisOverlayGeometry.arrowLengthM(large), 4)
    }

    func testArrowStrokesShaftAndHeadGeometry() {
        // One arrow pointing due east (downhill +e), anchored at a real
        // SWEREF99TM location; length 4 m.
        let arrow = FallLineArrow(
            e: 540_000, n: 6_470_000, dirE: 1, dirN: 0, slopePct: 3.2, labeled: true
        )
        let strokes = AnalysisOverlayGeometry.arrowStrokes([arrow], lengthM: 4)
        XCTAssertEqual(strokes.count, 1)
        let a = strokes[0]
        XCTAssertEqual(a.strokes.count, 3) // shaft + 2 head strokes
        XCTAssertEqual(a.slopePct, 3.2)
        XCTAssertTrue(a.labeled)

        func metric(_ ll: LatLon) -> Sweref99TM.Point { Sweref99TM.fromWGS84(ll) }

        // Shaft: tail 2 m west of anchor → tip 2 m east.
        let tail = metric(a.strokes[0][0])
        let tip = metric(a.strokes[0][1])
        XCTAssertEqual(tail.x, 540_000 - 2, accuracy: 0.01)
        XCTAssertEqual(tip.x, 540_000 + 2, accuracy: 0.01)
        XCTAssertEqual(tail.y, 6_470_000, accuracy: 0.01)
        XCTAssertEqual(tip.y, 6_470_000, accuracy: 0.01)

        // Head strokes: from the tip, ±150° off downhill, 35% of length.
        for (index, sign) in [1.0, -1.0].enumerated() {
            let stroke = a.strokes[index + 1]
            let start = metric(stroke[0])
            let end = metric(stroke[1])
            XCTAssertEqual(start.x, tip.x, accuracy: 0.01)
            XCTAssertEqual(start.y, tip.y, accuracy: 0.01)
            let angle = sign * 150 * Double.pi / 180
            XCTAssertEqual(end.x, tip.x + cos(angle) * 1.4, accuracy: 0.01)
            XCTAssertEqual(end.y, tip.y + sin(angle) * 1.4, accuracy: 0.01)
        }

        // Label anchor: one arrow-length downhill of the anchor.
        let label = metric(a.labelPosition)
        XCTAssertEqual(label.x, 540_000 + 4, accuracy: 0.01)
        XCTAssertEqual(label.y, 6_470_000, accuracy: 0.01)
    }

    func testGreenAnalysisResultComputesBoundsAndDerivedFields() {
        // 5% plane grid, 10×10 m all-inside.
        let spec = AnalysisGridSpec(
            originE: 540_000, originN: 6_470_000, resolution: 0.5, width: 20, height: 20
        )
        var heights: [Double] = []
        for row in 0..<spec.height {
            for col in 0..<spec.width {
                let e = spec.originE + (Double(col) + 0.5) * spec.resolution
                let n = spec.originN - (Double(row) + 0.5) * spec.resolution
                heights.append(50 + 0.03 * (e - spec.originE) + 0.04 * (n - (spec.originN - 10)))
            }
        }
        let grid = SampleGrid(
            spec: spec,
            heights: heights,
            insideMask: [Bool](repeating: true, count: 400)
        )
        let ring = [
            LatLon(lat: 58.358, lon: 15.719),
            LatLon(lat: 58.358, lon: 15.721),
            LatLon(lat: 58.359, lon: 15.721),
            LatLon(lat: 58.359, lon: 15.719),
        ]
        let result = GreenAnalysisResult(grid: grid, boundaryRings: [ring])
        XCTAssertEqual(result.stats.green.maxSlopePct, 5, accuracy: 1e-6)
        XCTAssertFalse(result.arrows.isEmpty)
        let bounds = try! XCTUnwrap(result.boundaryBounds)
        XCTAssertEqual(bounds.west, 15.719)
        XCTAssertEqual(bounds.east, 15.721)
        XCTAssertEqual(bounds.south, 58.358)
        XCTAssertEqual(bounds.north, 58.359)

        // Map-state equality is identity + mode (cheap change detection).
        let state = GreenAnalysisMapState(result: result, mode: .slope)
        XCTAssertEqual(state, GreenAnalysisMapState(result: result, mode: .slope))
        XCTAssertNotEqual(state, GreenAnalysisMapState(result: result, mode: .height))
        let other = GreenAnalysisResult(grid: grid, boundaryRings: [ring])
        XCTAssertNotEqual(state, GreenAnalysisMapState(result: other, mode: .slope))
    }
}
