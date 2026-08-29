import XCTest
@testable import GolfMap

/// WatchTargetBuilder crossing math over synthetic planar geometry. The path
/// runs due north from a fixed SWEREF99 TM origin; rings are squares placed
/// on or off the line.
final class WatchTargetBuilderTests: XCTestCase {

    /// Roughly central Sweden — keeps the WGS84 round-trip well-conditioned.
    private let origin = Sweref99TM.Point(x: 500_000, y: 6_580_000)

    private func p(northM: Double, eastM: Double = 0) -> Sweref99TM.Point {
        Sweref99TM.Point(x: origin.x + eastM, y: origin.y + northM)
    }

    private func square(northM: ClosedRange<Double>, eastM: ClosedRange<Double>, kind: String) -> FlatRing {
        FlatRing(points: [
            Vec2(x: origin.x + eastM.lowerBound, y: origin.y + northM.lowerBound),
            Vec2(x: origin.x + eastM.upperBound, y: origin.y + northM.lowerBound),
            Vec2(x: origin.x + eastM.upperBound, y: origin.y + northM.upperBound),
            Vec2(x: origin.x + eastM.lowerBound, y: origin.y + northM.upperBound),
        ], kind: kind)
    }

    private func aim(_ sortOrder: Int, northM: Double, label: String? = nil) -> AimPointRecord {
        let ll = Sweref99TM.toWGS84(p(northM: northM))
        return AimPointRecord(
            id: "aim-\(sortOrder)", holeId: "h1", sortOrder: sortOrder,
            lat: ll.lat, lon: ll.lon, label: label
        )
    }

    private func distanceM(_ pair: [Double], to point: Sweref99TM.Point) -> Double {
        let q = Sweref99TM.fromWGS84(LatLon(lat: pair[0], lon: pair[1]))
        return ((q.x - point.x) * (q.x - point.x) + (q.y - point.y) * (q.y - point.y)).squareRoot()
    }

    func testCrossedHazardYieldsNearAndFarEdgePoints() {
        let targets = WatchTargetBuilder.targets(
            path: [p(northM: 0), p(northM: 300)],
            aims: [],
            surfaces: [square(northM: 100...115, eastM: -20...20, kind: "bunker")]
        )
        XCTAssertEqual(targets.count, 1)
        let bunker = targets[0]
        XCTAssertEqual(bunker.label, "Bunker")
        XCTAssertEqual(bunker.kind, "hazard")
        XCTAssertEqual(distanceM(bunker.point, to: p(northM: 100)), 0, accuracy: 0.5)
        XCTAssertEqual(distanceM(bunker.farPoint ?? [], to: p(northM: 115)), 0, accuracy: 0.5)
    }

    func testOffLineAndNonHazardRingsAreIgnored() {
        let targets = WatchTargetBuilder.targets(
            path: [p(northM: 0), p(northM: 300)],
            aims: [],
            surfaces: [
                square(northM: 100...115, eastM: 40...80, kind: "water"),   // beside the line
                square(northM: 150...170, eastM: -20...20, kind: "fairway"), // crossed, not a hazard
                square(northM: 400...420, eastM: -20...20, kind: "bunker"),  // past the green
            ]
        )
        XCTAssertTrue(targets.isEmpty)
    }

    func testDoglegCrossingIsFoundOnTheSecondLeg() {
        // Path bends east at 200 m; the creek crosses the second leg only.
        let targets = WatchTargetBuilder.targets(
            path: [p(northM: 0), p(northM: 200), p(northM: 200, eastM: 250)],
            aims: [],
            surfaces: [square(northM: 180...220, eastM: 100...120, kind: "water_creek")]
        )
        XCTAssertEqual(targets.count, 1)
        XCTAssertEqual(targets[0].label, "Creek")
        XCTAssertEqual(distanceM(targets[0].point, to: p(northM: 200, eastM: 100)), 0, accuracy: 0.5)
    }

    func testAimPointsGetAuthoredLabelOrFallbackIndex() {
        let targets = WatchTargetBuilder.targets(
            path: [p(northM: 0), p(northM: 300)],
            aims: [aim(0, northM: 150, label: "Layup"), aim(1, northM: 220)],
            surfaces: []
        )
        XCTAssertEqual(targets.map(\.label), ["Layup", "A2"])
        XCTAssertEqual(targets.map(\.kind), ["aim", "aim"])
        XCTAssertNil(targets[0].farPoint)
        XCTAssertEqual(distanceM(targets[1].point, to: p(northM: 220)), 0, accuracy: 0.5)
    }

    func testJointStraddlingRingIsNotDuplicated() {
        // The bunker straddles the 200 m path joint; both legs hit it but it
        // must ship once.
        let targets = WatchTargetBuilder.targets(
            path: [p(northM: 0), p(northM: 200), p(northM: 300)],
            aims: [],
            surfaces: [square(northM: 190...210, eastM: -20...20, kind: "bunker")]
        )
        XCTAssertEqual(targets.filter { $0.kind == "hazard" }.count, 1)
    }
}
