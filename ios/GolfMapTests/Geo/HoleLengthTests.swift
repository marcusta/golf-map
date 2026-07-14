import XCTest
@testable import GolfMap

/// Ported from the `playingLength` / `pathMeters` cases at the top of
/// `web/tests/hole-info-panel.test.ts`.
final class HoleLengthTests: XCTestCase {

    private let lat = 58.4015
    private let lon = 15.5658

    func testTeeSingleAimGreenCenterSumsProjectedLegsRounded() {
        let tee = LatLon(lat: lat, lon: lon)
        let aim = LatLon(lat: lat + 0.001, lon: lon + 0.0005)
        let green = LatLon(lat: lat + 0.002, lon: lon + 0.001)

        let pt = Sweref99TM.fromWGS84(tee)
        let pa = Sweref99TM.fromWGS84(aim)
        let pg = Sweref99TM.fromWGS84(green)
        let expected = Int((
            (pow(pa.x - pt.x, 2) + pow(pa.y - pt.y, 2)).squareRoot()
                + (pow(pg.x - pa.x, 2) + pow(pg.y - pa.y, 2)).squareRoot()
        ).rounded())

        let res = HoleLength.playingLength(tee: tee, aims: [aim], greenCenter: green)
        XCTAssertEqual(res.meters, expected)
        XCTAssertFalse(res.approximate)
    }

    func testMultiAimPathAddsEveryLegInOrder() {
        let tee = LatLon(lat: lat, lon: lon)
        let a1 = LatLon(lat: lat + 0.0008, lon: lon)
        let a2 = LatLon(lat: lat + 0.0016, lon: lon + 0.0006)
        let green = LatLon(lat: lat + 0.0024, lon: lon)

        let direct = HoleLength.pathMeters([tee, a1, a2, green])
        XCTAssertEqual(
            HoleLength.playingLength(tee: tee, aims: [a1, a2], greenCenter: green).meters,
            Int(direct.rounded())
        )
    }

    func testNoGreenCenterMeasuresTeeToAimsFlaggedApproximate() {
        let tee = LatLon(lat: lat, lon: lon)
        let aim = LatLon(lat: lat + 0.001, lon: lon)
        let res = HoleLength.playingLength(tee: tee, aims: [aim], greenCenter: nil)
        XCTAssertTrue(res.approximate)
        let direct = Int(HoleLength.pathMeters([tee, aim]).rounded())
        XCTAssertEqual(res.meters, direct)
    }

    func testTeeNoAimsNoGreenIsNull() {
        let res = HoleLength.playingLength(tee: LatLon(lat: lat, lon: lon), aims: [], greenCenter: nil)
        XCTAssertNil(res.meters)
        XCTAssertTrue(res.approximate)
    }

    func testTeeOnlyWithGreenMeasuresDirectLeg() {
        let tee = LatLon(lat: lat, lon: lon)
        let green = LatLon(lat: lat + 0.001, lon: lon)
        let res = HoleLength.playingLength(tee: tee, aims: [], greenCenter: green)
        XCTAssertFalse(res.approximate)
        XCTAssertNotNil(res.meters)
        XCTAssertGreaterThan(res.meters!, 0)
    }

    func testNullTeeIsNullLength() {
        let res = HoleLength.playingLength(
            tee: nil,
            aims: [LatLon(lat: lat, lon: lon)],
            greenCenter: LatLon(lat: lat, lon: lon)
        )
        XCTAssertNil(res.meters)
        XCTAssertFalse(res.approximate)
    }

    func testPathMetersZeroForFewerThanTwoPoints() {
        XCTAssertEqual(HoleLength.pathMeters([]), 0)
        XCTAssertEqual(HoleLength.pathMeters([LatLon(lat: lat, lon: lon)]), 0)
    }

    // MARK: - pointAlong (routed layup placement)

    /// Build a WGS84 point from exact SWEREF 99 TM easting/northing so the leg
    /// geometry below is planar-exact (round-tripping through the projection is
    /// sub-millimeter, so the assertions use a tight tolerance).
    private func ll(_ x: Double, _ y: Double) -> LatLon { Sweref99TM.toWGS84(x: x, y: y) }
    private func assertPlanar(_ p: LatLon?, _ x: Double, _ y: Double,
                              _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) {
        let q = Sweref99TM.fromWGS84(try! XCTUnwrap(p, file: file, line: line))
        XCTAssertEqual(q.x, x, accuracy: 0.01, msg, file: file, line: line)
        XCTAssertEqual(q.y, y, accuracy: 0.01, msg, file: file, line: line)
    }

    /// An L-shaped dogleg: leg 1 runs 100 m east, leg 2 runs 100 m north.
    private var dogleg: [LatLon] {
        [ll(500_000, 6_470_000), ll(500_100, 6_470_000), ll(500_100, 6_470_100)]
    }

    func testPointAlongEmptyPathIsNil() {
        XCTAssertNil(HoleLength.pointAlong([], meters: 10))
    }

    func testPointAlongZeroAndNegativeReturnFirstPointExactly() {
        let path = dogleg
        XCTAssertEqual(HoleLength.pointAlong(path, meters: 0), path.first)
        XCTAssertEqual(HoleLength.pointAlong(path, meters: -25), path.first)
    }

    func testPointAlongMidLegInterpolates() {
        // 50 m along leg 1 (east) → halfway between vertex 0 and vertex 1.
        assertPlanar(HoleLength.pointAlong(dogleg, meters: 50), 500_050, 6_470_000)
    }

    func testPointAlongOnVertexLandsOnTheVertex() {
        // Exactly leg-1 length → the dogleg corner (vertex 1).
        assertPlanar(HoleLength.pointAlong(dogleg, meters: 100), 500_100, 6_470_000)
    }

    func testPointAlongDoglegCrossesOntoSecondLeg() {
        // 150 m total → 100 m of leg 1 + 50 m up leg 2 (north).
        assertPlanar(HoleLength.pointAlong(dogleg, meters: 150), 500_100, 6_470_050)
    }

    func testPointAlongBeyondEndClampsToLastPoint() {
        // Past the 200 m total → clamps to the final vertex.
        assertPlanar(HoleLength.pointAlong(dogleg, meters: 500), 500_100, 6_470_100)
    }

    func testPointAlongSinglePointReturnsThatPoint() {
        let only = ll(500_000, 6_470_000)
        XCTAssertEqual(HoleLength.pointAlong([only], meters: 42), only)
    }
}
