import XCTest
@testable import GolfMap

/// Pure distance-logic tests over a synthetic hole built with exact planar
/// offsets: targets are placed by projecting a base point to SWEREF 99 TM,
/// offsetting by exact meters, and unprojecting — so the expected planar
/// distances are known by construction (the same projection defines
/// `Distance.planarMeters`).
final class OnCourseDistancesTests: XCTestCase {

    /// A base point on the course (Landeryd area, well inside SWEREF 99 TM).
    private let base = LatLon(lat: 58.36, lon: 15.71)

    /// Offset a WGS84 point by exact EPSG:3006 meters.
    private func offset(_ point: LatLon, east: Double, north: Double) -> LatLon {
        let p = Sweref99TM.fromWGS84(point)
        return Sweref99TM.toWGS84(x: p.x + east, y: p.y + north)
    }

    // MARK: Front / center / back

    func testFrontCenterBackExactPlanarDistances() {
        let targets = HoleTargets(
            greenFront: offset(base, east: 0, north: 150),
            greenCenter: offset(base, east: 0, north: 160),
            greenBack: offset(base, east: 0, north: 172)
        )
        let d = OnCourseDistances.compute(from: base, originElevation: nil, targets: targets)
        XCTAssertEqual(d.front, 150)
        XCTAssertEqual(d.center, 160)
        XCTAssertEqual(d.back, 172)
        XCTAssertNil(d.pin)
        XCTAssertNil(d.playsLikeCenter, "no elevations → no plays-like")
        XCTAssertEqual(d.aims, [])
    }

    func testDiagonalDistanceIsHypotenuse() {
        // 3-4-5 triangle scaled ×30: east 90, north 120 → 150 m.
        let targets = HoleTargets(greenCenter: offset(base, east: 90, north: 120))
        let d = OnCourseDistances.compute(from: base, originElevation: nil, targets: targets)
        XCTAssertEqual(d.center, 150)
    }

    func testRoundingToWholeMeters() {
        // 100.4 m rounds down, 100.5 rounds up.
        let down = HoleTargets(greenCenter: offset(base, east: 0, north: 100.4))
        let up = HoleTargets(greenCenter: offset(base, east: 0, north: 100.6))
        XCTAssertEqual(OnCourseDistances.compute(from: base, originElevation: nil, targets: down).center, 100)
        XCTAssertEqual(OnCourseDistances.compute(from: base, originElevation: nil, targets: up).center, 101)
    }

    func testMissingTargetsAreNil() {
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: HoleTargets())
        XCTAssertNil(d.front)
        XCTAssertNil(d.center)
        XCTAssertNil(d.back)
        XCTAssertNil(d.pin)
        XCTAssertNil(d.playsLikeCenter)
        XCTAssertNil(d.playsLikePin)
    }

    // MARK: Plays-like (horizontal + elevationΔ)

    func testPlaysLikeUphillAddsElevationDelta() {
        let targets = HoleTargets(
            greenCenter: offset(base, east: 0, north: 160),
            greenElevation: 22
        )
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets)
        XCTAssertEqual(d.center, 160)
        XCTAssertEqual(d.playsLikeCenter, 172) // 160 + (22 − 10)
    }

    func testPlaysLikeDownhillSubtracts() {
        let targets = HoleTargets(
            greenCenter: offset(base, east: 0, north: 160),
            greenElevation: 0
        )
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets)
        XCTAssertEqual(d.playsLikeCenter, 150) // 160 − 10
    }

    func testPlaysLikeNilWithoutOriginElevation() {
        let targets = HoleTargets(
            greenCenter: offset(base, east: 0, north: 160),
            greenElevation: 22
        )
        let d = OnCourseDistances.compute(from: base, originElevation: nil, targets: targets)
        XCTAssertNil(d.playsLikeCenter)
    }

    func testPlaysLikeNilWithoutGreenElevation() {
        let targets = HoleTargets(greenCenter: offset(base, east: 0, north: 160))
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets)
        XCTAssertNil(d.playsLikeCenter)
    }

    // MARK: Active pin

    func testPinDistanceAndPlaysLike() {
        let targets = HoleTargets(
            greenCenter: offset(base, east: 0, north: 160),
            greenElevation: 15,
            activePin: offset(base, east: 0, north: 155),
            activePinName: "Front-left"
        )
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets)
        XCTAssertEqual(d.pin, 155)
        XCTAssertEqual(d.playsLikePin, 160) // 155 + (15 − 10)
    }

    // MARK: Aim points

    func testAimDistancesKeepOrderAndLabels() {
        let targets = HoleTargets(
            aimPoints: [
                AimTarget(label: "Carry", position: offset(base, east: 0, north: 180)),
                AimTarget(label: "Layup", position: offset(base, east: 0, north: 210)),
            ]
        )
        let d = OnCourseDistances.compute(from: base, originElevation: nil, targets: targets)
        XCTAssertEqual(d.aims, [
            AimDistance(label: "Carry", meters: 180),
            AimDistance(label: "Layup", meters: 210),
        ])
    }
}
