import XCTest
@testable import GolfMapWatch

/// HoleSelector behavior over a synthetic two-hole course laid out on a
/// north-south line near Stockholm: hole 1 tee at the origin, green 300 m
/// north; hole 2 tee 320 m north (20 m past hole 1's green), green 620 m
/// north. ~0.000009° lat ≈ 1 m.
final class HoleSelectorTests: XCTestCase {

    private static let baseLat = 59.3293
    private static let baseLon = 18.0686
    private static let latPerMeter = 0.000008993

    private func point(northM: Double, eastM: Double = 0) -> LatLon {
        LatLon(
            lat: Self.baseLat + northM * Self.latPerMeter,
            lon: Self.baseLon + eastM * Self.latPerMeter / cos(Self.baseLat * .pi / 180)
        )
    }

    private func pair(northM: Double, eastM: Double = 0) -> [Double] {
        let p = point(northM: northM, eastM: eastM)
        return [p.lat, p.lon]
    }

    private var holes: [WatchHole] {
        [
            WatchHole(number: 1, par: 4, tee: pair(northM: 0), greenCenter: pair(northM: 300)),
            WatchHole(number: 2, par: 4, tee: pair(northM: 320), greenCenter: pair(northM: 620)),
        ]
    }

    func testStartsOnFirstHoleAndStaysMidFairway() {
        var selector = HoleSelector()
        XCTAssertFalse(selector.update(fix: point(northM: 150), holes: holes))
        XCTAssertEqual(selector.currentIndex, 0)
        XCTAssertFalse(selector.isManual)
    }

    func testTeeSnapSwitchesToNextHole() {
        var selector = HoleSelector()
        selector.update(fix: point(northM: 250), holes: holes)
        XCTAssertEqual(selector.currentIndex, 0)
        // Standing on hole 2's tee (within teeSnapM).
        XCTAssertTrue(selector.update(fix: point(northM: 325), holes: holes))
        XCTAssertEqual(selector.currentIndex, 1)
    }

    func testHysteresisPreventsFlappingBetweenParallelHoles() {
        // 30 m east of hole 1's corridor, 40 m west of a parallel hole —
        // closer to hole 1, and the 10 m edge must NOT flip with hysteresis.
        let parallel = [
            WatchHole(number: 1, par: 4, tee: pair(northM: 0), greenCenter: pair(northM: 300)),
            WatchHole(number: 2, par: 4, tee: pair(northM: 300, eastM: 70),
                      greenCenter: pair(northM: 0, eastM: 70)),
        ]
        var selector = HoleSelector()
        // Nearer hole 2's corridor, but not by > hysteresis: stays.
        XCTAssertFalse(selector.update(fix: point(northM: 150, eastM: 40), holes: parallel))
        XCTAssertEqual(selector.currentIndex, 0)
        // Clearly on hole 2's line (65 m east: 65 vs 5 m): switches.
        XCTAssertTrue(selector.update(fix: point(northM: 150, eastM: 65), holes: parallel))
        XCTAssertEqual(selector.currentIndex, 1)
    }

    func testManualOverrideSticksUntilTeeSnap() {
        var selector = HoleSelector()
        selector.select(index: 1, holeCount: holes.count)
        XCTAssertTrue(selector.isManual)
        // Mid hole-1 fairway: auto would pick hole 1, manual holds hole 2.
        XCTAssertFalse(selector.update(fix: point(northM: 150), holes: holes))
        XCTAssertEqual(selector.currentIndex, 1)
        // Walking onto hole 1's tee releases the override.
        XCTAssertTrue(selector.update(fix: point(northM: 5), holes: holes))
        XCTAssertEqual(selector.currentIndex, 0)
        XCTAssertFalse(selector.isManual)
    }

    func testMalformedHoleIsNeverSelected() {
        let withBroken = [
            WatchHole(number: 1, par: 4, tee: pair(northM: 0), greenCenter: pair(northM: 300)),
            WatchHole(number: 2, par: 4, tee: [], greenCenter: []),
        ]
        var selector = HoleSelector()
        XCTAssertFalse(selector.update(fix: point(northM: 150), holes: withBroken))
        XCTAssertEqual(selector.currentIndex, 0)
    }

    func testDistanceToSegmentClampsToEndpoints() {
        let a = Sweref99TM.Point(x: 0, y: 0)
        let b = Sweref99TM.Point(x: 100, y: 0)
        XCTAssertEqual(HoleSelector.distanceToSegment(.init(x: 50, y: 30), a: a, b: b), 30, accuracy: 0.001)
        XCTAssertEqual(HoleSelector.distanceToSegment(.init(x: -40, y: 0), a: a, b: b), 40, accuracy: 0.001)
        XCTAssertEqual(HoleSelector.distanceToSegment(.init(x: 140, y: 0), a: a, b: b), 40, accuracy: 0.001)
    }

    func testBundleRoundTripsThroughJSON() throws {
        let bundle = WatchCourseBundle(
            courseId: "c1", name: "Landeryd",
            holes: holes, builtAt: Date(timeIntervalSince1970: 1_755_000_000)
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(
            WatchCourseBundle.self, from: try encoder.encode(bundle)
        )
        XCTAssertEqual(decoded, bundle)
    }
}
