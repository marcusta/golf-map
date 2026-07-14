import XCTest
@testable import GolfMap

/// Unit tests for the pure distance-ladder merge (`LadderBuilder`): the
/// near→far sort across kinds, hazard front/carry edges, positions threaded
/// through for tap-to-focus, and the layup policy (only out-of-range greens,
/// deduped by approach club, capped).
final class OnCourseLadderTests: XCTestCase {

    private func club(_ name: String, _ carry: Double) -> ClubRecord {
        ClubRecord(id: name, name: name, carryM: carry, dispersionM: 20, sortOrder: 0)
    }

    private func at(_ lat: Double, _ lon: Double) -> LatLon { LatLon(lat: lat, lon: lon) }

    // MARK: - Merge + sort

    func testMergeSortsNearToFarAcrossKinds() {
        let rows = LadderBuilder.build(
            planShots: [LadderBuilder.PlanShot(index: 1, clubName: "3H", meters: 210, position: at(1, 1))],
            hazards: [LadderBuilder.HazardItem(id: "b1", label: "Bunker", frontM: 230, carryM: 245, position: at(2, 2))],
            aims: [LadderBuilder.AimItem(label: "Aim", meters: 250, position: at(3, 3))],
            layups: [LadderBuilder.LayupItem(clubName: "Driver", carryM: 235, remainingM: 65, approachClub: "7i", position: at(4, 4))],
            green: LadderBuilder.Green(front: 289, center: 301, back: 311, pin: 305, pinName: "Middle",
                                       centerPosition: at(5, 5), pinPosition: at(6, 6))
        )
        // plan 210 · hazard 230 · layup 235 · aim 250 · green 301 · pin 305
        XCTAssertEqual(rows.map(\.kind), [.plan, .hazard, .layup, .aim, .green, .pin])
        XCTAssertEqual(rows.map(\.meters), [210, 230, 235, 250, 301, 305])
    }

    func testRowsCarryTheirFeaturePosition() {
        let rows = LadderBuilder.build(
            planShots: [LadderBuilder.PlanShot(index: 1, clubName: nil, meters: 200, position: at(10, 20))],
            hazards: [], aims: [],
            layups: [LadderBuilder.LayupItem(clubName: "Driver", carryM: 235, remainingM: 65, approachClub: "7i", position: nil)],
            green: LadderBuilder.Green(front: nil, center: 300, back: nil, pin: nil, pinName: nil,
                                       centerPosition: at(11, 21), pinPosition: nil)
        )
        XCTAssertEqual(rows.first { $0.kind == .plan }?.position, at(10, 20))
        XCTAssertEqual(rows.first { $0.kind == .green }?.position, at(11, 21))
        XCTAssertNil(rows.first { $0.kind == .layup }?.position) // unlocatable → nil (not tappable)
    }

    func testLayupRowCarriesStructuredRemainingAndApproach() {
        // The layup row keeps carry as its sort/primary distance, exposes the
        // distance left to the green and the approach club as structured fields
        // (so the rail needn't parse `detail`), and still fills `detail` for the
        // advice banner. Non-layup rows leave both structured fields nil.
        let rows = LadderBuilder.build(
            planShots: [LadderBuilder.PlanShot(index: 1, clubName: "3H", meters: 210, position: at(1, 1))],
            hazards: [LadderBuilder.HazardItem(id: "b1", label: "Bunker", frontM: 240, carryM: 255, position: at(2, 2))],
            aims: [],
            layups: [LadderBuilder.LayupItem(clubName: "Driver", carryM: 235, remainingM: 65, approachClub: "7i", position: at(4, 4))],
            green: LadderBuilder.Green(front: nil, center: 300, back: nil, pin: nil, pinName: nil,
                                       centerPosition: at(5, 5), pinPosition: nil)
        )
        let layup = rows.first { $0.kind == .layup }
        XCTAssertEqual(layup?.meters, 235)           // carry stays the sort key
        XCTAssertEqual(layup?.remainingM, 65)        // structured distance to green
        XCTAssertEqual(layup?.approachClub, "7i")    // structured approach club
        XCTAssertEqual(layup?.detail, "65 m in · 7i") // banner string still populated
        // Every other kind leaves the layup-only fields nil.
        for row in rows where row.kind != .layup {
            XCTAssertNil(row.remainingM, "\(row.kind) should not carry remainingM")
            XCTAssertNil(row.approachClub, "\(row.kind) should not carry approachClub")
        }
    }

    func testLayupRowWithoutApproachClubOmitsIt() {
        // A layup the bag can't name an approach club for keeps a nil
        // approachClub and a `detail` without the "· club" suffix.
        let rows = LadderBuilder.build(
            planShots: [], hazards: [], aims: [],
            layups: [LadderBuilder.LayupItem(clubName: "Driver", carryM: 235, remainingM: 65, approachClub: nil, position: at(4, 4))],
            green: LadderBuilder.Green(front: nil, center: 300, back: nil, pin: nil, pinName: nil,
                                       centerPosition: at(5, 5), pinPosition: nil)
        )
        let layup = rows.first { $0.kind == .layup }
        XCTAssertEqual(layup?.remainingM, 65)
        XCTAssertNil(layup?.approachClub)
        XCTAssertEqual(layup?.detail, "65 m in")
    }

    func testHazardRowCarriesBothEdges() {
        let rows = LadderBuilder.build(
            planShots: [],
            hazards: [LadderBuilder.HazardItem(id: "w1", label: "Water", frontM: 180, carryM: 200, position: at(1, 1))],
            aims: [], layups: [],
            green: LadderBuilder.Green(front: nil, center: nil, back: nil, pin: nil, pinName: nil, centerPosition: nil, pinPosition: nil)
        )
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].kind, .hazard)
        XCTAssertEqual(rows[0].meters, 180) // front is the sort key
        XCTAssertEqual(rows[0].carryM, 200) // far edge preserved
        XCTAssertEqual(rows[0].detail, "front / carry")
    }

    func testGreenRowShowsFrontBackRangeAndPinIsSeparate() {
        let rows = LadderBuilder.build(
            planShots: [], hazards: [], aims: [], layups: [],
            green: LadderBuilder.Green(front: 289, center: 301, back: 311, pin: 305, pinName: "Back",
                                       centerPosition: at(1, 1), pinPosition: at(2, 2))
        )
        let green = rows.first { $0.kind == .green }
        XCTAssertEqual(green?.meters, 301)
        XCTAssertEqual(green?.detail, "289 – 311")
        let pin = rows.first { $0.kind == .pin }
        XCTAssertEqual(pin?.label, "Pin · Back")
        XCTAssertEqual(pin?.meters, 305)
    }

    // MARK: - Layup policy

    func testLadderLayupsEmptyWhenGreenReachable() {
        let bag = [club("Driver", 235), club("7i", 155)]
        // Longest club (235) reaches a 150 m routed target → no layups.
        XCTAssertTrue(LadderBuilder.ladderLayups(clubs: bag, routedTargetM: 150).isEmpty)
    }

    func testLadderLayupsOutOfRangeOneRowPerApproachCapped() {
        let bag = [club("Driver", 235), club("5i", 175), club("7i", 155), club("PW", 115), club("SW", 90)]
        let layups = LadderBuilder.ladderLayups(clubs: bag, routedTargetM: 300, cap: 3)
        // 5 distinct approach clubs → capped to the 3 longest carries.
        XCTAssertEqual(layups.count, 3)
        XCTAssertEqual(layups.map(\.club.name), ["Driver", "5i", "7i"])
    }

    func testLadderLayupsDedupesByApproachKeepingLongestCarry() {
        // Two clubs (210, 200) both leave the 100 m club as the approach → the
        // longer carry wins that approach slot; the short club owns a different one.
        let bag = [club("long", 210), club("mid", 200), club("app", 100)]
        let layups = LadderBuilder.ladderLayups(clubs: bag, routedTargetM: 300, cap: 5)
        let byApproach = Dictionary(uniqueKeysWithValues: layups.map { ($0.approachClub!.name, $0.club.name) })
        XCTAssertEqual(byApproach["app"], "long") // 210 kept over 200 for the "app" approach
        XCTAssertEqual(layups.count, 2) // "app"→long and "mid"→app
    }

    func testLadderLayupsLieFilterDropsOptionBeforeCapFreeingASlot() {
        // The lie filter runs BEFORE the dedupe-and-cap: reject the 5i landing
        // (carry 175) as an unplayable lie and its slot is freed for PW, which
        // the cap-3 would otherwise have excluded (full order is Driver, 5i, 7i,
        // PW, SW). So the dropped rung genuinely lets a farther option surface.
        let bag = [club("Driver", 235), club("5i", 175), club("7i", 155), club("PW", 115), club("SW", 90)]
        let layups = LadderBuilder.ladderLayups(
            clubs: bag, routedTargetM: 300,
            landingAcceptable: { carry in carry != 175 }, cap: 3
        )
        XCTAssertEqual(layups.map(\.club.name), ["Driver", "7i", "PW"])
    }
}
