import XCTest
@testable import GolfMap

/// `PlanStrategy` — the pure shot-viz overlay builder (dispersion ellipses,
/// ghost recommended aim, approach confidence tints). Mirrors the web
/// planner's `plan-overlay.ts` render slice; math parity itself is pinned by
/// `StrategyShotVizParityTests`, so this covers the ASSEMBLY: which legs get an
/// ellipse, the light thresholds, and the empty/no-bag guards.
final class PlanStrategyTests: XCTestCase {

    private let club = ClubRecord(id: "c", name: "7i", carryM: 145, dispersionM: 22, sortOrder: 0)

    private func ll(_ lat: Double, _ lon: Double) -> LatLon { LatLon(lat: lat, lon: lon) }

    // MARK: - legLight thresholds (mirror plan-overlay.ts legLight)

    func testLegLightOnlyForApproachLegs() {
        XCTAssertNil(PlanStrategy.legLight(breakdown: [.green: 1], isApproach: false))
    }

    func testLegLightRedOnPenaltyOrTrouble() {
        XCTAssertEqual(PlanStrategy.legLight(breakdown: [.green: 0.9, .penalty: 0.01], isApproach: true), .red)
        XCTAssertEqual(PlanStrategy.legLight(breakdown: [.green: 0.7, .sand: 0.3], isApproach: true), .red)
    }

    func testLegLightYellowOnTroubleShareOrGreenRarelyHeld() {
        XCTAssertEqual(PlanStrategy.legLight(breakdown: [.green: 0.85, .sand: 0.15], isApproach: true), .yellow)
        XCTAssertEqual(PlanStrategy.legLight(breakdown: [.green: 0.5, .rough: 0.5], isApproach: true), .yellow)
    }

    func testLegLightGreenWhenHeldAndClean() {
        XCTAssertEqual(PlanStrategy.legLight(breakdown: [.green: 0.8, .rough: 0.2], isApproach: true), .green)
    }

    // MARK: - compute

    private func teeGreenNodes() -> [PlanStrategy.Node] {
        // ~145 m due north, so a 145 m club reaches the green center.
        [
            PlanStrategy.Node(latLon: ll(58.3500, 15.7000), elevation: 0, kind: .tee),
            PlanStrategy.Node(latLon: ll(58.35130, 15.7000), elevation: 0, kind: .green),
        ]
    }

    func testOneClubbedLegYieldsOneEllipseAndGhost() {
        let g = PlanStrategy.compute(nodes: teeGreenNodes(), clubs: [club], surfaces: [], wind: nil)
        XCTAssertEqual(g.ellipses.count, 1, "one ellipse per clubbed leg")
        XCTAssertEqual(g.ghosts.count, 1, "one ghost recommended-aim per clubbed leg")
        XCTAssertGreaterThanOrEqual(g.ellipses[0].polygon.count, 4, "closed dispersion ring")
        XCTAssertFalse(g.ghosts[0].ellipse.isEmpty)
    }

    func testApproachLegYellowWhenGreenRarelyHeld() {
        // No surfaces → every sample classifies rough → green share 0 < 0.6.
        let g = PlanStrategy.compute(nodes: teeGreenNodes(), clubs: [club], surfaces: [], wind: nil)
        XCTAssertEqual(g.legTints.count, 1)
        XCTAssertEqual(g.legTints[0].light, .yellow)
    }

    func testApproachLegGreenWhenGreenSurfaceHoldsThePattern() {
        // A generous green box centred on the target holds most of the pattern.
        let center = Sweref99TM.fromWGS84(ll(58.35130, 15.7000))
        let r = 90.0
        let greenRing = FlatRing(
            points: [
                Vec2(x: center.x - r, y: center.y - r),
                Vec2(x: center.x + r, y: center.y - r),
                Vec2(x: center.x + r, y: center.y + r),
                Vec2(x: center.x - r, y: center.y + r),
            ],
            kind: "green"
        )
        let g = PlanStrategy.compute(nodes: teeGreenNodes(), clubs: [club], surfaces: [greenRing], wind: nil)
        XCTAssertEqual(g.legTints.first?.light, .green, "green held → attack")
    }

    func testEmptyBagDrawsNothing() {
        let g = PlanStrategy.compute(nodes: teeGreenNodes(), clubs: [], surfaces: [], wind: nil)
        XCTAssertTrue(g.isEmpty)
    }

    func testNonApproachLegsGetEllipseButNoTint() {
        // tee → layup (shot) → green: leg 1 is not an approach, leg 2 is.
        let nodes = [
            PlanStrategy.Node(latLon: ll(58.3500, 15.7000), elevation: 0, kind: .tee),
            PlanStrategy.Node(latLon: ll(58.3520, 15.7000), elevation: 0, kind: .shot, clubId: "c"),
            PlanStrategy.Node(latLon: ll(58.3535, 15.7000), elevation: 0, kind: .green),
        ]
        let g = PlanStrategy.compute(nodes: nodes, clubs: [club], surfaces: [], wind: nil)
        XCTAssertEqual(g.ellipses.count, 2, "both legs are clubbed")
        XCTAssertEqual(g.legTints.count, 1, "only the approach leg is tinted")
    }
}
