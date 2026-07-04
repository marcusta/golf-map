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
}
