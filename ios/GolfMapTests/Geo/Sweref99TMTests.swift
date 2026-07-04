import XCTest
@testable import GolfMap

/// Ported from `web/tests/transform.test.ts` — same Lantmäteriet control
/// points, same tolerances (< 0.02 m forward, < 2e-5 deg inverse).
final class Sweref99TMTests: XCTestCase {

    private struct ControlPoint {
        let latDeg, latMin, lonDeg, lonMin: Double
        let n, e: Double // northing, easting
        var lat: Double { latDeg + latMin / 60 }
        var lon: Double { lonDeg + lonMin / 60 }
    }

    // Authoritative control points published by Lantmäteriet, "Kontrollpunkter
    // för SWEREF 99 TM" (2007-11-20).
    private static let controlPoints: [ControlPoint] = [
        .init(latDeg: 55, latMin: 0, lonDeg: 12, lonMin: 45, n: 6097106.672, e: 356083.438),
        .init(latDeg: 55, latMin: 0, lonDeg: 14, lonMin: 15, n: 6095048.642, e: 452024.069),
        .init(latDeg: 57, latMin: 0, lonDeg: 12, lonMin: 45, n: 6319636.937, e: 363331.554),
        .init(latDeg: 57, latMin: 0, lonDeg: 19, lonMin: 30, n: 6326392.707, e: 773251.054),
        .init(latDeg: 59, latMin: 0, lonDeg: 11, lonMin: 15, n: 6546096.724, e: 284626.066),
        .init(latDeg: 59, latMin: 0, lonDeg: 19, lonMin: 30, n: 6548757.206, e: 758410.519),
        .init(latDeg: 61, latMin: 0, lonDeg: 12, lonMin: 45, n: 6764877.311, e: 378323.44),
        .init(latDeg: 61, latMin: 0, lonDeg: 18, lonMin: 45, n: 6768593.345, e: 702745.127),
        .init(latDeg: 63, latMin: 0, lonDeg: 12, lonMin: 0, n: 6989134.048, e: 348083.148),
        .init(latDeg: 63, latMin: 0, lonDeg: 19, lonMin: 30, n: 6993565.63, e: 727798.671),
        .init(latDeg: 65, latMin: 0, lonDeg: 13, lonMin: 30, n: 7209293.753, e: 429270.201),
        .init(latDeg: 65, latMin: 0, lonDeg: 21, lonMin: 45, n: 7225449.115, e: 817833.405),
        .init(latDeg: 67, latMin: 0, lonDeg: 16, lonMin: 30, n: 7432168.174, e: 565398.458),
        .init(latDeg: 67, latMin: 0, lonDeg: 24, lonMin: 0, n: 7459745.672, e: 891298.142),
        .init(latDeg: 69, latMin: 0, lonDeg: 21, lonMin: 0, n: 7666089.698, e: 739639.195),
    ]

    func testForwardMatchesControlPoints() {
        for cp in Self.controlPoints {
            let p = Sweref99TM.fromWGS84(lat: cp.lat, lon: cp.lon)
            XCTAssertLessThan(abs(p.x - cp.e), 0.02, "easting at \(cp.latDeg)/\(cp.lonDeg)")
            XCTAssertLessThan(abs(p.y - cp.n), 0.02, "northing at \(cp.latDeg)/\(cp.lonDeg)")
        }
    }

    func testInverseMatchesControlPoints() {
        for cp in Self.controlPoints {
            let ll = Sweref99TM.toWGS84(x: cp.e, y: cp.n)
            // 2e-5 deg ~= 1.5-2 m at these latitudes.
            XCTAssertLessThan(abs(ll.lat - cp.lat), 2e-5, "lat at \(cp.latDeg)/\(cp.lonDeg)")
            XCTAssertLessThan(abs(ll.lon - cp.lon), 2e-5, "lon at \(cp.latDeg)/\(cp.lonDeg)")
        }
    }

    func testCentralMeridianMapsToFalseEasting() {
        for lat in [55.0, 58.4, 60.0, 65.0, 69.0] {
            let p = Sweref99TM.fromWGS84(lat: lat, lon: 15.0)
            XCTAssertLessThan(abs(p.x - 500_000), 1e-6)
        }
    }

    func testRoundTripsAreStable() {
        let points: [(Double, Double)] = [
            (55.5, 13.0),
            (58.4015, 15.5658), // Landeryd test course
            (59.33, 18.06),
            (63.8, 20.3),
            (67.85, 20.2),
            (69.0, 23.0),
            (55.3, 12.5),
        ]
        for (lat, lon) in points {
            let p = Sweref99TM.fromWGS84(lat: lat, lon: lon)
            let back = Sweref99TM.toWGS84(p)
            XCTAssertLessThan(abs(back.lat - lat), 1e-4)
            XCTAssertLessThan(abs(back.lon - lon), 1e-4)
        }
    }

    func testConvenienceOverloadsAgree() {
        let ll = LatLon(lat: 58.4015, lon: 15.5658)
        let a = Sweref99TM.fromWGS84(ll)
        let b = Sweref99TM.fromWGS84(lat: 58.4015, lon: 15.5658)
        XCTAssertEqual(a, b)
    }
}
