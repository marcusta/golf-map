import XCTest
@testable import GolfMap

/// Ported from `web/tests/measure-state.test.ts` (segmentStats / pathSegmentStats
/// / pathTotals — the pure plays-like math; the reactive state machine is app
/// layer, out of scope for the Geo module).
final class PlaysLikeTests: XCTestCase {

    private func pt(_ e: Double, _ n: Double, _ elev: Double?) -> PlaysLike.Point {
        PlaysLike.Point(e: e, n: n, elevation: elev)
    }

    func testHorizontalIs345Triangle() {
        let s = PlaysLike.segmentStats(pt(0, 0, 10), pt(3, 4, 10))
        XCTAssertEqual(s.horizontal, 5, accuracy: 1e-6)
        XCTAssertEqual(s.elevationDelta!, 0, accuracy: 1e-6)
        XCTAssertEqual(s.straightLine!, 5, accuracy: 1e-6)
        XCTAssertEqual(s.slopeDeg!, 0, accuracy: 1e-6)
        XCTAssertEqual(s.slopePct!, 0, accuracy: 1e-6)
        XCTAssertEqual(s.playsLikeSimple!, 5, accuracy: 1e-6)
    }

    func testUphillSegment() {
        let s = PlaysLike.segmentStats(pt(0, 0, 50), pt(100, 0, 60))
        XCTAssertEqual(s.horizontal, 100, accuracy: 1e-6)
        XCTAssertEqual(s.elevationDelta!, 10, accuracy: 1e-6)
        XCTAssertEqual(s.straightLine!, (100 * 100 + 10 * 10).squareRoot(), accuracy: 1e-6)
        XCTAssertEqual(s.slopePct!, 10, accuracy: 1e-6)
        XCTAssertEqual(s.slopeDeg!, atan2(10, 100) * 180 / .pi, accuracy: 1e-6)
        XCTAssertEqual(s.playsLikeSimple!, 110, accuracy: 1e-6)
    }

    func testDownhillSegment() {
        let s = PlaysLike.segmentStats(pt(0, 0, 60), pt(0, 100, 50))
        XCTAssertEqual(s.elevationDelta!, -10, accuracy: 1e-6)
        XCTAssertEqual(s.slopePct!, 10, accuracy: 1e-6)
        XCTAssertEqual(s.slopeDeg!, atan2(10, 100) * 180 / .pi, accuracy: 1e-6)
        XCTAssertEqual(s.playsLikeSimple!, 90, accuracy: 1e-6)
        XCTAssertEqual(s.straightLine!, (100 * 100 + 10 * 10).squareRoot(), accuracy: 1e-6)
    }

    func testSlopeZeroNotNaNWhenRunIsZero() {
        let s = PlaysLike.segmentStats(pt(5, 5, 10), pt(5, 5, 12))
        XCTAssertEqual(s.horizontal, 0, accuracy: 1e-6)
        XCTAssertEqual(s.slopePct!, 0, accuracy: 1e-6)
        XCTAssertEqual(s.elevationDelta!, 2, accuracy: 1e-6)
    }

    func testParFourScaleSegment() {
        let s = PlaysLike.segmentStats(pt(0, 0, 55), pt(300, 120, 57))
        XCTAssertEqual(s.horizontal, (300.0 * 300 + 120 * 120).squareRoot(), accuracy: 1e-6)
        XCTAssertGreaterThan(s.horizontal, 300)
        XCTAssertLessThan(s.horizontal, 340)
        XCTAssertEqual(s.elevationDelta!, 2, accuracy: 1e-6)
        XCTAssertLessThan(s.slopePct!, 1)
    }

    func testNullElevationDegradesToHorizontalOnly() {
        let a = PlaysLike.segmentStats(pt(0, 0, nil), pt(100, 0, 60))
        XCTAssertEqual(a.horizontal, 100, accuracy: 1e-6)
        XCTAssertNil(a.elevationDelta)
        XCTAssertNil(a.straightLine)
        XCTAssertNil(a.slopeDeg)
        XCTAssertNil(a.slopePct)
        XCTAssertNil(a.playsLikeSimple)

        let b = PlaysLike.segmentStats(pt(0, 0, 50), pt(100, 0, nil))
        XCTAssertEqual(b.horizontal, 100, accuracy: 1e-6)
        XCTAssertNil(b.elevationDelta)
    }

    func testPathSegmentStatsYieldsNMinusOne() {
        let path = [pt(0, 0, 10), pt(100, 0, 12), pt(100, 100, 15)]
        let segs = PlaysLike.pathSegmentStats(path)
        XCTAssertEqual(segs.count, 2)
        XCTAssertEqual(segs[0].horizontal, 100, accuracy: 1e-6)
        XCTAssertEqual(segs[1].horizontal, 100, accuracy: 1e-6)
    }

    func testPathTotalsSumsHorizontalElevationDrapedAndPlaysLike() {
        let path = [pt(0, 0, 10), pt(100, 0, 20), pt(200, 0, 15)]
        let totals = PlaysLike.pathTotals(PlaysLike.pathSegmentStats(path))
        XCTAssertEqual(totals.horizontal, 200, accuracy: 1e-6)
        XCTAssertEqual(totals.elevationDelta!, 5, accuracy: 1e-6)
        XCTAssertEqual(
            totals.straightLine!,
            (100.0 * 100 + 100).squareRoot() + (100.0 * 100 + 25).squareRoot(),
            accuracy: 1e-6
        )
        XCTAssertEqual(totals.playsLikeSimple!, 205, accuracy: 1e-6)
        XCTAssertEqual(totals.measuredSegments, 2)
        XCTAssertEqual(totals.totalSegments, 2)
    }

    func testPathTotalsHorizontalCountsAllElevationOnlyMeasured() {
        let path = [pt(0, 0, 10), pt(100, 0, nil), pt(200, 0, 30)]
        let totals = PlaysLike.pathTotals(PlaysLike.pathSegmentStats(path))
        XCTAssertEqual(totals.horizontal, 200, accuracy: 1e-6)
        XCTAssertEqual(totals.measuredSegments, 0)
        XCTAssertNil(totals.elevationDelta)
        XCTAssertNil(totals.straightLine)
        XCTAssertNil(totals.playsLikeSimple)
    }

    func testPathTotalsAggregateSlopeUsesMeasuredRunOnly() {
        let path = [pt(0, 0, 10), pt(100, 0, 15), pt(200, 0, nil)]
        let totals = PlaysLike.pathTotals(PlaysLike.pathSegmentStats(path))
        XCTAssertEqual(totals.measuredSegments, 1)
        XCTAssertEqual(totals.elevationDelta!, 5, accuracy: 1e-6)
        XCTAssertEqual(totals.slopePct!, 5, accuracy: 1e-6) // 5/100, not 5/200
    }

    // MARK: Distance / bearing

    func testPlanarMetersMatchesProjectedHypot() {
        let a = LatLon(lat: 58.4015, lon: 15.5658)
        let b = LatLon(lat: 58.4025, lon: 15.5668)
        let pa = Sweref99TM.fromWGS84(a)
        let pb = Sweref99TM.fromWGS84(b)
        let expected = (pow(pa.x - pb.x, 2) + pow(pa.y - pb.y, 2)).squareRoot()
        XCTAssertEqual(Distance.planarMeters(a, b), expected, accuracy: 1e-9)
    }

    func testBearingCardinalDirections() {
        let origin = LatLon(lat: 58.4, lon: 15.5)
        let north = LatLon(lat: 58.5, lon: 15.5)
        let east = LatLon(lat: 58.4, lon: 15.7)
        XCTAssertEqual(Distance.bearingDegrees(origin, north), 0, accuracy: 0.5)
        XCTAssertEqual(Distance.bearingDegrees(origin, east), 90, accuracy: 0.5)
        // Bearing is always normalized into [0, 360).
        let west = LatLon(lat: 58.4, lon: 15.3)
        let bw = Distance.bearingDegrees(origin, west)
        XCTAssertGreaterThanOrEqual(bw, 0)
        XCTAssertLessThan(bw, 360)
        XCTAssertEqual(bw, 270, accuracy: 0.5)
    }
}
