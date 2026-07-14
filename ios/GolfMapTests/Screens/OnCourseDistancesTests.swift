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

    // MARK: Club advice + wind (Part B)

    private func bag() -> [ClubRecord] {
        [
            ClubRecord(id: "dr", name: "Driver", carryM: 235, dispersionM: 60, sortOrder: 0),
            ClubRecord(id: "5i", name: "5i", carryM: 175, dispersionM: 38, sortOrder: 1),
            ClubRecord(id: "7i", name: "7i", carryM: 155, dispersionM: 32, sortOrder: 2),
        ]
    }

    func testClubAdviceOnPlaysLikeCenterNoWind() {
        // Center 160 m + (22−10) uphill = plays-like 172. clubAdvice(172):
        // front = shortest reaching = 5i (175); center = nearest = 5i;
        // back = longest ≤ 172 = 7i (155).
        let targets = HoleTargets(greenCenter: offset(base, east: 0, north: 160), greenElevation: 22)
        let d = OnCourseDistances.compute(
            from: base, originElevation: 10, targets: targets, clubs: bag()
        )
        XCTAssertEqual(d.centerClubs?.front, "5i")
        XCTAssertEqual(d.centerClubs?.center, "5i")
        XCTAssertEqual(d.centerClubs?.back, "7i")
        XCTAssertNil(d.windPlaysLikeCenter, "no wind → no wind-adjusted number")
    }

    func testLayupLineWhenGreenBeyondLongestClub() {
        // Green center 300 m out; the longest club (Driver 235) can't reach, so
        // the F/C/B chips would collapse onto "Driver" and misread as reachable.
        // Instead we surface the honest layup: Driver 235 · 65 m in · 7i.
        let targets = HoleTargets(greenCenter: offset(base, east: 0, north: 300), greenElevation: 10)
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets, clubs: bag())
        XCTAssertNil(d.centerClubs, "out-of-range green shows the layup, not F/C/B chips")
        XCTAssertEqual(d.layup?.club, "Driver")
        XCTAssertEqual(d.layup?.carryM, 235)
        XCTAssertEqual(d.layup?.remainingM, 65) // 300 − 235
        XCTAssertEqual(d.layup?.approachClub, "7i") // closest carry to 65
    }

    func testInRangeGreenKeepsChipsNotLayup() {
        // Reachable green keeps the F/C/B chips and emits no layup line.
        let targets = HoleTargets(greenCenter: offset(base, east: 0, north: 160), greenElevation: 22)
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets, clubs: bag())
        XCTAssertNotNil(d.centerClubs)
        XCTAssertNil(d.layup)
    }

    func testWindHeadwindLengthensPlaysLikeAndShiftsClub() {
        // Dead headwind on a due-north shot (wind FROM 0°, bearing 0°) makes
        // the target play LONGER (playsAsM divides by 1+e, e<0).
        let targets = HoleTargets(greenCenter: offset(base, east: 0, north: 160), greenElevation: 22)
        let calm = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets, clubs: bag())
        let windy = OnCourseDistances.compute(
            from: base, originElevation: 10, targets: targets,
            wind: (speedMps: 8, directionDeg: 0), clubs: bag()
        )
        XCTAssertNotNil(windy.windPlaysLikeCenter)
        XCTAssertGreaterThan(windy.windPlaysLikeCenter!, calm.playsLikeCenter!)
        // Longer effective distance selects a longer club (Driver reaches now).
        XCTAssertEqual(windy.centerClubs?.center, "Driver")
    }

    func testPinClubIsClosestClub() {
        let targets = HoleTargets(
            greenCenter: offset(base, east: 0, north: 160),
            greenElevation: 10,
            activePin: offset(base, east: 0, north: 155),
            activePinName: "Middle"
        )
        // Pin plays-like 155 (flat) → closest club is 7i (155).
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets, clubs: bag())
        XCTAssertEqual(d.pinClub, "7i")
    }

    func testCompetitionModeHidesClubAndWindAdvice() {
        let targets = HoleTargets(
            greenCenter: offset(base, east: 0, north: 160),
            greenElevation: 22,
            activePin: offset(base, east: 0, north: 155),
            activePinName: "Middle"
        )
        let d = OnCourseDistances.compute(
            from: base, originElevation: 10, targets: targets,
            competitionMode: true, wind: (speedMps: 8, directionDeg: 0), clubs: bag()
        )
        XCTAssertNil(d.centerClubs)
        XCTAssertNil(d.pinClub)
        XCTAssertNil(d.windPlaysLikeCenter)
        XCTAssertNil(d.windPlaysLikePin)
        XCTAssertNil(d.playsLikeCenter, "plays-like itself still gated in competition")
    }

    func testNoClubsMeansNoClubAdvice() {
        let targets = HoleTargets(greenCenter: offset(base, east: 0, north: 160), greenElevation: 22)
        let d = OnCourseDistances.compute(from: base, originElevation: 10, targets: targets)
        XCTAssertNil(d.centerClubs)
        XCTAssertNil(d.pinClub)
    }

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
