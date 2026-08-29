import XCTest
@testable import GolfMapWatch

/// WatchLadder row building over a synthetic straight hole heading north:
/// tee at the origin, green center 300 m north (front 290, back 310), a
/// bunker crossing at 100–115 m, an aim point at 200 m.
final class WatchLadderTests: XCTestCase {

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

    private var hole: WatchHole {
        WatchHole(
            number: 1, par: 4,
            tee: pair(northM: 0),
            greenCenter: pair(northM: 300),
            greenFront: pair(northM: 290),
            greenBack: pair(northM: 310),
            targets: [
                WatchTarget(
                    label: "Bunker", kind: "hazard",
                    point: pair(northM: 100), farPoint: pair(northM: 115)
                ),
                WatchTarget(label: "A1", kind: "aim", point: pair(northM: 200)),
            ]
        )
    }

    func testRowsFromTeeAreSortedNearToFarWithCarryAndGreenFigures() {
        let rows = WatchLadder.rows(fix: point(northM: 0), hole: hole)
        XCTAssertEqual(rows.map(\.label), ["Bunker", "A1", "Green"])

        let bunker = rows[0]
        XCTAssertTrue(bunker.isHazard)
        XCTAssertEqual(bunker.metersM, 100)
        XCTAssertEqual(bunker.carryM, 115)

        let aim = rows[1]
        XCTAssertFalse(aim.isHazard)
        XCTAssertEqual(aim.metersM, 200)
        XCTAssertNil(aim.carryM)

        // ±1: the test's degrees-per-meter constant is an approximation.
        let green = rows[2]
        XCTAssertTrue(green.isGreen)
        XCTAssertEqual(Double(green.metersM), 300, accuracy: 1)
        XCTAssertEqual(Double(green.frontM ?? 0), 290, accuracy: 1)
        XCTAssertEqual(Double(green.backM ?? 0), 310, accuracy: 1)
    }

    func testPassedTargetsAreDropped() {
        // Standing at 150 m: the bunker (ends 115 m from the tee) is behind —
        // farther from the green center than the player — so only the aim and
        // the green remain.
        let rows = WatchLadder.rows(fix: point(northM: 150), hole: hole)
        XCTAssertEqual(rows.map(\.label), ["A1", "Green"])
        XCTAssertEqual(rows[0].metersM, 50)
        XCTAssertEqual(rows[1].metersM, 150)
    }

    func testAbeamTargetSurvivesTheAheadMargin() {
        // Standing exactly at the aim point: same distance to the green as
        // the target — the margin keeps it visible.
        let rows = WatchLadder.rows(fix: point(northM: 200), hole: hole)
        XCTAssertTrue(rows.map(\.label).contains("A1"))
    }

    func testHoleWithoutTargetsStillYieldsTheGreenRow() {
        let bare = WatchHole(
            number: 2, par: 3,
            tee: pair(northM: 0), greenCenter: pair(northM: 150)
        )
        let rows = WatchLadder.rows(fix: point(northM: 0), hole: bare)
        XCTAssertEqual(rows.map(\.label), ["Green"])
        XCTAssertNil(rows[0].frontM)
    }

    func testTargetsRoundTripThroughBundleJSON() throws {
        let bundle = WatchCourseBundle(
            courseId: "c1", name: "Landeryd",
            holes: [hole], builtAt: Date(timeIntervalSince1970: 1_755_000_000)
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(
            WatchCourseBundle.self, from: try encoder.encode(bundle)
        )
        XCTAssertEqual(decoded, bundle)
        XCTAssertEqual(decoded.holes[0].targets?.count, 2)
    }
}
