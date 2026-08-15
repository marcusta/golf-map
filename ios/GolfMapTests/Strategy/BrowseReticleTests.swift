import XCTest
@testable import GolfMap

/// Reticle-browse math (RB1): pan-club pick at gaps/ends, neighbor clubs at
/// bag ends, lateral half-width scaling, and arc polyline geometry. Pure
/// planar math over a small fixture bag — no UI, no map.
final class BrowseReticleTests: XCTestCase {

    private struct FxClub: ClubSpec, Equatable {
        var name: String
        var carryM: Double
        var dispersionM: Double
        var clubName: String? { name }
    }

    /// Five-club fixture bag, deliberately unsorted (order must not matter).
    private let bag = [
        FxClub(name: "7i", carryM: 150, dispersionM: 20),
        FxClub(name: "PW", carryM: 110, dispersionM: 14),
        FxClub(name: "Dr", carryM: 230, dispersionM: 40),
        FxClub(name: "5i", carryM: 180, dispersionM: 26),
        FxClub(name: "3w", carryM: 210, dispersionM: 34),
    ]

    private func club(_ name: String) -> FxClub {
        bag.first { $0.name == name }!
    }

    // MARK: panClub

    func testPanClubPicksFirstCarryThatReaches() {
        // 160 sits in the 150…180 gap → the 180 club reaches first.
        XCTAssertEqual(BrowseReticle.panClub(clubs: bag, distanceM: 160), club("5i"))
    }

    func testPanClubExactCarryPicksThatClub() {
        XCTAssertEqual(BrowseReticle.panClub(clubs: bag, distanceM: 150), club("7i"))
    }

    func testPanClubShortOfBagPicksShortestClub() {
        XCTAssertEqual(BrowseReticle.panClub(clubs: bag, distanceM: 40), club("PW"))
    }

    func testPanClubBeyondBagFallsBackToLongest() {
        XCTAssertEqual(BrowseReticle.panClub(clubs: bag, distanceM: 260), club("Dr"))
    }

    func testPanClubEmptyBagIsNil() {
        XCTAssertNil(BrowseReticle.panClub(clubs: [FxClub](), distanceM: 150))
    }

    // MARK: neighborClubs

    func testNeighborsInTheMiddleOfTheBag() {
        let n = BrowseReticle.neighborClubs(clubs: bag, around: club("5i"))
        XCTAssertEqual(n.shorter, club("7i"))
        XCTAssertEqual(n.longer, club("3w"))
    }

    func testNeighborsAtShortEndHaveNoShorter() {
        let n = BrowseReticle.neighborClubs(clubs: bag, around: club("PW"))
        XCTAssertNil(n.shorter)
        XCTAssertEqual(n.longer, club("7i"))
    }

    func testNeighborsAtLongEndHaveNoLonger() {
        let n = BrowseReticle.neighborClubs(clubs: bag, around: club("Dr"))
        XCTAssertEqual(n.shorter, club("3w"))
        XCTAssertNil(n.longer)
    }

    // MARK: lateralHalfWidthM

    func testHalfWidthAtNominalCarryIsEllipseSemiLateral() {
        // Matches dispersionEllipse's minor semi-axis: full extent / 2.
        let c = club("5i") // carry 180, dispersion 26
        XCTAssertEqual(BrowseReticle.lateralHalfWidthM(club: c, atDistanceM: 180), 13, accuracy: 1e-12)
    }

    func testHalfWidthScalesLinearlyWithDistance() {
        let c = club("5i")
        XCTAssertEqual(BrowseReticle.lateralHalfWidthM(club: c, atDistanceM: 90), 6.5, accuracy: 1e-12)
        XCTAssertEqual(BrowseReticle.lateralHalfWidthM(club: c, atDistanceM: 0), 0, accuracy: 1e-12)
    }

    // MARK: arcPolyline

    func testArcPointsSitAtRadius() {
        let origin = Vec2(x: 12, y: -7)
        let arc = BrowseReticle.arcPolyline(
            origin: origin, bearingDeg: 37, radiusM: 160, halfWidthM: 13
        )
        XCTAssertEqual(arc.count, 33) // 32 segments → 33 points
        for p in arc {
            XCTAssertEqual(hypot(p.x - origin.x, p.y - origin.y), 160, accuracy: 1e-9)
        }
    }

    func testArcEndsSpanPlusMinusHalfWidthLaterally() {
        // Due north from the origin: lateral offset is just x.
        let arc = BrowseReticle.arcPolyline(
            origin: Vec2(x: 0, y: 0), bearingDeg: 0, radiusM: 160, halfWidthM: 13
        )
        XCTAssertEqual(arc.first!.x, -13, accuracy: 1e-9)
        XCTAssertEqual(arc.last!.x, 13, accuracy: 1e-9)
        // Midpoint sits on the bearing line at the radius.
        let mid = arc[arc.count / 2]
        XCTAssertEqual(mid.x, 0, accuracy: 1e-9)
        XCTAssertEqual(mid.y, 160, accuracy: 1e-9)
    }

    func testArcEndsSpanHalfWidthOnRotatedBearing() {
        // Cross-line offset = dot(p − origin, right) where right = bearing+90°.
        let bearing = 73.0
        let along = bearingToUnitVector(bearing)
        let right = Vec2(x: along.y, y: -along.x)
        let arc = BrowseReticle.arcPolyline(
            origin: Vec2(x: 5, y: 9), bearingDeg: bearing, radiusM: 140, halfWidthM: 20
        )
        let lateral = { (p: Vec2) in (p.x - 5) * right.x + (p.y - 9) * right.y }
        XCTAssertEqual(lateral(arc.first!), -20, accuracy: 1e-9)
        XCTAssertEqual(lateral(arc.last!), 20, accuracy: 1e-9)
    }

    // MARK: rightmostPoint (advised-club ellipse label anchor)

    func testRightmostPointPicksTheRightEdgeRelativeToTheBearing() throws {
        // Ring around (0, 200): the east point is rightmost looking north, the
        // north point is rightmost looking east (bearing 90).
        let ring = [
            Vec2(x: 0, y: 220), Vec2(x: 15, y: 200), Vec2(x: 0, y: 180), Vec2(x: -15, y: 200),
        ]
        let north = try XCTUnwrap(BrowseReticle.rightmostPoint(ring: ring, bearingDeg: 0))
        XCTAssertEqual(north, Vec2(x: 15, y: 200))
        let east = try XCTUnwrap(BrowseReticle.rightmostPoint(ring: ring, bearingDeg: 90))
        XCTAssertEqual(east, Vec2(x: 0, y: 180))
    }

    func testRightmostPointAgreesWithTheArcEndSide() throws {
        // Same side convention as `arcPolyline`'s last point, so the ellipse
        // label and the neighbor-arc labels land on one side of the line.
        let bearing = 73.0
        let arc = BrowseReticle.arcPolyline(
            origin: .init(x: 0, y: 0), bearingDeg: bearing, radiusM: 140, halfWidthM: 20
        )
        let rightmost = try XCTUnwrap(BrowseReticle.rightmostPoint(ring: arc, bearingDeg: bearing))
        XCTAssertEqual(rightmost, try XCTUnwrap(arc.last))
    }

    func testRightmostPointNilForEmptyRing() {
        XCTAssertNil(BrowseReticle.rightmostPoint(ring: [], bearingDeg: 0))
    }

    func testArcHalfAngleClampsToSemicircle() {
        // halfWidth > radius → asin clamps at 90°: ends at bearing ± 90°.
        let arc = BrowseReticle.arcPolyline(
            origin: Vec2(x: 0, y: 0), bearingDeg: 0, radiusM: 50, halfWidthM: 80
        )
        XCTAssertEqual(arc.first!.x, -50, accuracy: 1e-9)
        XCTAssertEqual(arc.first!.y, 0, accuracy: 1e-9)
        XCTAssertEqual(arc.last!.x, 50, accuracy: 1e-9)
        XCTAssertEqual(arc.last!.y, 0, accuracy: 1e-9)
    }
}
