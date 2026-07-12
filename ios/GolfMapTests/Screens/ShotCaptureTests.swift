import XCTest
@testable import GolfMap

/// The capture flow's zero-tap defaults (docs/feature-shot-capture.md §3/§4):
/// putt/full auto-classification against the green polygon, club pre-select
/// via `closestClub` on the plays-like remaining, and the target pre-fill
/// chain (pin ?? plan landing ?? green center) — plus the `CaptureModel`
/// override behavior around them.
@MainActor
final class ShotCaptureTests: XCTestCase {

    // A ~40×40 m square green centered on this point.
    private let greenCenter = LatLon(lat: 58.353, lon: 15.723)

    /// Square outer ring (±`halfM` meters) around a WGS84 center, in
    /// EPSG:3006 — the ring space `classify` tests against.
    private func squareRing(around center: LatLon, halfM: Double) -> [Sweref99TM.Point] {
        let c = Sweref99TM.fromWGS84(center)
        return [
            Sweref99TM.Point(x: c.x - halfM, y: c.y - halfM),
            Sweref99TM.Point(x: c.x + halfM, y: c.y - halfM),
            Sweref99TM.Point(x: c.x + halfM, y: c.y + halfM),
            Sweref99TM.Point(x: c.x - halfM, y: c.y + halfM),
            Sweref99TM.Point(x: c.x - halfM, y: c.y - halfM),
        ]
    }

    /// A point `east`/`north` meters from a WGS84 origin, back in WGS84.
    private func offset(_ origin: LatLon, east: Double, north: Double) -> LatLon {
        let p = Sweref99TM.fromWGS84(origin)
        return Sweref99TM.toWGS84(x: p.x + east, y: p.y + north)
    }

    // MARK: - Shot-type auto-classification

    func testPositionOnGreenClassifiesAsPutt() {
        let rings = [squareRing(around: greenCenter, halfM: 20)]
        XCTAssertEqual(
            ShotCaptureDefaults.classify(position: greenCenter, greenRings: rings),
            .putt
        )
        // Just inside the edge still counts.
        let nearEdge = offset(greenCenter, east: 18, north: 0)
        XCTAssertEqual(
            ShotCaptureDefaults.classify(position: nearEdge, greenRings: rings),
            .putt
        )
    }

    func testPositionOffGreenClassifiesAsFull() {
        let rings = [squareRing(around: greenCenter, halfM: 20)]
        let fairway = offset(greenCenter, east: 0, north: -150)
        XCTAssertEqual(
            ShotCaptureDefaults.classify(position: fairway, greenRings: rings),
            .full
        )
        // Just outside the edge.
        let justOff = offset(greenCenter, east: 25, north: 0)
        XCTAssertEqual(
            ShotCaptureDefaults.classify(position: justOff, greenRings: rings),
            .full
        )
    }

    func testPositionInsidePolygonHoleClassifiesAsFull() {
        // Outer ring with a cut-out hole ring around the center.
        let rings = [
            squareRing(around: greenCenter, halfM: 20),
            squareRing(around: greenCenter, halfM: 5),
        ]
        XCTAssertEqual(
            ShotCaptureDefaults.classify(position: greenCenter, greenRings: rings),
            .full,
            "a point inside a hole ring is not on the green"
        )
        let onGreenOutsideHole = offset(greenCenter, east: 12, north: 0)
        XCTAssertEqual(
            ShotCaptureDefaults.classify(position: onGreenOutsideHole, greenRings: rings),
            .putt
        )
    }

    func testNoGreenPolygonClassifiesAsFull() {
        XCTAssertEqual(
            ShotCaptureDefaults.classify(position: greenCenter, greenRings: []),
            .full
        )
    }

    // MARK: - Target pre-fill (pin ?? plan landing ahead ?? green center)

    func testActivePinWinsTheTargetDefault() {
        let pin = offset(greenCenter, east: 5, north: 5)
        let target = ShotCaptureDefaults.defaultTarget(
            position: offset(greenCenter, east: 0, north: -200),
            activePin: pin,
            planLandings: [offset(greenCenter, east: 0, north: -100)],
            greenCenter: greenCenter
        )
        XCTAssertEqual(target, pin)
    }

    func testNextPlanLandingAheadBeatsGreenCenter() {
        let position = offset(greenCenter, east: 0, north: -300)
        let landingAhead = offset(greenCenter, east: 0, north: -120)
        let target = ShotCaptureDefaults.defaultTarget(
            position: position,
            activePin: nil,
            planLandings: [landingAhead],
            greenCenter: greenCenter
        )
        XCTAssertEqual(target, landingAhead)
    }

    func testPassedPlanLandingFallsBackToGreenCenter() {
        // The player is already past the only planned landing.
        let position = offset(greenCenter, east: 0, north: -80)
        let landingBehind = offset(greenCenter, east: 0, north: -180)
        let target = ShotCaptureDefaults.defaultTarget(
            position: position,
            activePin: nil,
            planLandings: [landingBehind],
            greenCenter: greenCenter
        )
        XCTAssertEqual(target, greenCenter)
    }

    func testNoPinNoPlanUsesGreenCenter() {
        let target = ShotCaptureDefaults.defaultTarget(
            position: offset(greenCenter, east: 0, north: -200),
            activePin: nil,
            planLandings: [],
            greenCenter: greenCenter
        )
        XCTAssertEqual(target, greenCenter)
    }

    // MARK: - Club pre-select

    private let bag = [
        ClubRecord(id: "dr", name: "Driver", carryM: 230, dispersionM: 55, sortOrder: 0),
        ClubRecord(id: "5i", name: "5i", carryM: 180, dispersionM: 38, sortOrder: 1),
        ClubRecord(id: "7i", name: "7i", carryM: 150, dispersionM: 30, sortOrder: 2),
        ClubRecord(id: "pw", name: "PW", carryM: 110, dispersionM: 25, sortOrder: 3),
    ]

    func testPreselectPicksClosestCarryToRemaining() {
        XCTAssertEqual(
            ShotCaptureDefaults.preselectClub(clubs: bag, remainingMeters: 155, shotType: .full)?.id,
            "7i"
        )
        XCTAssertEqual(
            ShotCaptureDefaults.preselectClub(clubs: bag, remainingMeters: 220, shotType: .full)?.id,
            "dr"
        )
    }

    func testPreselectSkipsClubForPutts() {
        XCTAssertNil(
            ShotCaptureDefaults.preselectClub(clubs: bag, remainingMeters: 8, shotType: .putt)
        )
    }

    func testRemainingUsesPlaysLikeWhenElevationsKnown() {
        let position = offset(greenCenter, east: 0, north: -150)
        // Flat: planar distance.
        let flat = ShotCaptureDefaults.remainingMeters(
            from: position, to: greenCenter,
            positionElevation: 40, targetElevation: 40
        )
        XCTAssertEqual(flat, 150, accuracy: 0.5)
        // 12 m uphill plays ~12 m longer (caddie rule: horizontal + Δ).
        let uphill = ShotCaptureDefaults.remainingMeters(
            from: position, to: greenCenter,
            positionElevation: 40, targetElevation: 52
        )
        XCTAssertEqual(uphill, 162, accuracy: 0.5)
        // Unknown elevations degrade to the planar line.
        let unknown = ShotCaptureDefaults.remainingMeters(from: position, to: greenCenter)
        XCTAssertEqual(unknown, 150, accuracy: 0.5)
    }

    func testRemainingAppliesWindPlaysAs() {
        let position = offset(greenCenter, east: 0, north: -150)
        // Shot bearing is due north; wind FROM the north = dead headwind →
        // plays longer than the calm figure.
        let calm = ShotCaptureDefaults.remainingMeters(from: position, to: greenCenter)
        let intoWind = ShotCaptureDefaults.remainingMeters(
            from: position, to: greenCenter,
            wind: (speedMps: 6, directionDeg: 0)
        )
        XCTAssertGreaterThan(intoWind, calm)
    }

    // MARK: - CaptureModel override behavior

    private func makeArmedModel(at position: LatLon) -> CaptureModel {
        let model = CaptureModel()
        model.begin(
            position: position,
            target: greenCenter,
            clubs: bag,
            wind: nil,
            greenRings: [squareRing(around: greenCenter, halfM: 20)],
            positionElevation: nil,
            targetElevation: nil
        )
        return model
    }

    func testBeginPreselectsClubAndAutoType() {
        let model = makeArmedModel(at: offset(greenCenter, east: 0, north: -150))
        XCTAssertEqual(model.shotType, .full)
        XCTAssertEqual(model.clubId, "7i")
        XCTAssertFalse(model.clubIsOverridden)
        XCTAssertFalse(model.shotTypeIsOverridden)
    }

    func testDraggingOntoGreenAutoSwitchesToPuttAndDropsClub() {
        let model = makeArmedModel(at: offset(greenCenter, east: 0, north: -150))
        model.movePosition(offset(greenCenter, east: 3, north: -3))
        XCTAssertEqual(model.shotType, .putt)
        XCTAssertNil(model.clubId, "auto putts carry no club")
    }

    func testClubOverrideSurvivesDrags() {
        let model = makeArmedModel(at: offset(greenCenter, east: 0, north: -150))
        model.overrideClub(id: "dr")
        model.movePosition(offset(greenCenter, east: 0, north: -100))
        XCTAssertEqual(model.clubId, "dr")
        XCTAssertTrue(model.clubIsOverridden)
        // Back to auto re-derives from the new remaining (~100 m → PW).
        model.overrideClub(id: nil)
        XCTAssertEqual(model.clubId, "pw")
    }

    func testShotTypeOverrideSurvivesDragsAndClearsBackToAuto() {
        let model = makeArmedModel(at: offset(greenCenter, east: 0, north: -150))
        model.overrideShotType(.recovery)
        model.movePosition(offset(greenCenter, east: 2, north: 2)) // on the green
        XCTAssertEqual(model.shotType, .recovery, "override beats the auto putt")
        model.overrideShotType(nil)
        XCTAssertEqual(model.shotType, .putt, "auto resumes from the current position")
    }

    func testRearmResetsOverridesAndPhase() {
        let model = makeArmedModel(at: offset(greenCenter, east: 0, north: -150))
        model.overrideClub(id: "dr")
        model.noteConfirmed(ShotRecord(
            roundId: "r1", holeNumber: 1, sortOrder: 0,
            lat: 0, lon: 0, recordedAt: "2026-07-12T10:00:00Z"
        ))
        XCTAssertEqual(model.phase, .confirmed)
        model.rearm(
            position: offset(greenCenter, east: 0, north: -100),
            target: greenCenter,
            positionElevation: nil,
            targetElevation: nil
        )
        XCTAssertEqual(model.phase, .aiming)
        XCTAssertFalse(model.clubIsOverridden)
        XCTAssertEqual(model.clubId, "pw", "pre-select recomputes for the new remaining")
        XCTAssertNil(model.lastConfirmed)
    }
}
