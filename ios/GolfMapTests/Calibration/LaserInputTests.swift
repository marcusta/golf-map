import XCTest
@testable import GolfMap

final class LaserInputRouterTests: XCTestCase {
    private typealias R = LaserInputRouter.Route

    func testRoutingTable() {
        struct Row {
            let distance: Double
            let picked: Bool
            let live: Bool
            let pin: Bool
            let expected: R
        }
        let rows: [Row] = [
            // Bare plausible number → pin, independent of calibration state.
            Row(distance: 143, picked: false, live: false, pin: true, expected: .pinDepth),
            Row(distance: 143, picked: false, live: true, pin: true, expected: .pinDepth),
            // Picked feature context wins over the equally pin-plausible value.
            Row(distance: 143, picked: true, live: false, pin: true, expected: .calibrationShot),
            Row(distance: 143, picked: true, live: true, pin: true, expected: .residualCheck),
            // No green solve / implausible bare number cannot silently guess pin.
            Row(distance: 143, picked: false, live: false, pin: false, expected: .unavailable),
            Row(distance: 39, picked: false, live: false, pin: true, expected: .unavailable),
            // A picked feature still makes a short positive shot meaningful.
            Row(distance: 39, picked: true, live: false, pin: false, expected: .calibrationShot),
            // Rangefinder safety bound shared with calibration entry.
            Row(distance: 1201, picked: true, live: true, pin: true, expected: .unavailable),
            Row(distance: .nan, picked: true, live: true, pin: true, expected: .unavailable),
        ]

        for row in rows {
            XCTAssertEqual(
                LaserInputRouter.route(
                    distanceM: row.distance,
                    hasPickedFeature: row.picked,
                    hasLiveCalibration: row.live,
                    canSolvePin: row.pin
                ),
                row.expected
            )
        }
    }
}

final class LaserResidualGateTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)
    private let near = LatLon(lat: 58.36, lon: 15.71)

    private func calibration(baseConfidence: Double = 0.6) -> OriginCalibration {
        OriginCalibration(
            biasE: 2,
            biasN: -1,
            solvedAt: start,
            solvedNear: near,
            method: .trilateration,
            baseConfidence: baseConfidence
        )
    }

    func testResidualAtConfirmGateRefreshesSolvedAtMethodAndConfidenceFloor() {
        let shotAt = start.addingTimeInterval(9 * 60)
        let (updated, outcome) = calibration().registeringResidual(
            OriginCalibration.Tuning.confirmResidualM,
            now: shotAt
        )

        XCTAssertEqual(outcome, .confirmed)
        XCTAssertEqual(updated.solvedAt, shotAt)
        XCTAssertEqual(updated.method, .residualRefresh)
        XCTAssertEqual(updated.baseConfidence, OriginCalibration.Tuning.refreshedBaseConfidence)
        XCTAssertFalse(updated.stale)
        XCTAssertNotNil(updated.appliedBias(now: shotAt, distanceFromSolveM: 0))
    }

    func testLargeResidualMarksStaleAndDropsCorrection() {
        let shotAt = start.addingTimeInterval(60)
        let (updated, outcome) = calibration(baseConfidence: 1).registeringResidual(
            OriginCalibration.Tuning.rejectResidualM,
            now: shotAt
        )

        XCTAssertEqual(outcome, .rejected)
        XCTAssertTrue(updated.stale)
        XCTAssertNil(updated.appliedBias(now: shotAt, distanceFromSolveM: 0))
    }

    func testConfidenceBelowFloorIsNotLive() {
        let c = calibration(baseConfidence: OriginCalibration.Tuning.confidenceFloor - 0.01)
        XCTAssertNil(c.appliedBias(now: start, distanceFromSolveM: 0))
        XCTAssertEqual(
            LaserInputRouter.route(
                distanceM: 143,
                hasPickedFeature: true,
                hasLiveCalibration: c.appliedBias(now: start, distanceFromSolveM: 0) != nil,
                canSolvePin: true
            ),
            .calibrationShot
        )
    }

    func testPeriodicRoundShotsKeepCalibrationFreshPastAgeZeroWindow() {
        var c = calibration(baseConfidence: 0.85)
        for hole in 1...18 {
            let shotAt = start.addingTimeInterval(Double(hole * 4 * 60))
            let (updated, outcome) = c.registeringResidual(1, now: shotAt)
            c = updated
            XCTAssertEqual(outcome, .confirmed, "hole \(hole)")
            XCTAssertNotNil(c.appliedBias(now: shotAt, distanceFromSolveM: 0), "hole \(hole)")
        }
        XCTAssertEqual(c.solvedAt, start.addingTimeInterval(72 * 60))
        XCTAssertEqual(c.method, .residualRefresh)
        XCTAssertFalse(c.stale)
    }
}

@MainActor
final class LaserOnCourseModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!
    private var clock: Date!

    override func setUp() {
        super.setUp()
        suite = "LaserOnCourseModelTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
        clock = Date(timeIntervalSince1970: 1_700_000_000)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        defaults = nil
        super.tearDown()
    }

    private func model() -> OnCourseModel {
        OnCourseModel(
            furniture: CourseFurniture(
                course: CourseRecord(
                    id: "laser-course", name: "Laser fixture", status: "published",
                    revision: 1, downloadedRevision: 1, updatedAt: "2026-07-17T00:00:00Z",
                    bundleState: .complete
                ),
                holes: [HoleRecord(
                    id: "laser-hole", courseId: "laser-course", number: 1,
                    par: 4, strokeIndex: 1
                )],
                tees: [TeeRecord(
                    id: "laser-tee", holeId: "laser-hole", name: "default",
                    lat: 58.36, lon: 15.71, sortOrder: 0
                )],
                greens: [], pins: [], aimPoints: [],
                manifest: TileManifestRecord(
                    courseId: "laser-course", west: 15.70, south: 58.35,
                    east: 15.72, north: 58.37,
                    orthoMinZoom: 14, orthoMaxZoom: 20,
                    terrainMinZoom: 12, terrainMaxZoom: 17,
                    elevMin: 0, elevMax: 100,
                    generatedAt: "2026-07-17T00:00:00Z", versionParam: "t36"
                )
            ),
            defaults: defaults,
            now: { [unowned self] in self.clock }
        )
    }

    func testLiveFeatureShotPublishesCarryAndRefreshesCalibration() throws {
        let model = model()
        let raw = LatLon(lat: 58.36, lon: 15.71)
        model.updateUserLocation(raw)
        model.applyCalibration(OriginCalibration(
            biasE: 2, biasN: -1, solvedAt: clock, solvedNear: raw,
            method: .trilateration, baseConfidence: 0.85
        ))
        model.setGPSEnabled(false)
        let rawPlanar = Sweref99TM.fromWGS84(raw)
        let target = Sweref99TM.toWGS84(x: rawPlanar.x + 100, y: rawPlanar.y)
        model.inspectBrowsePoint(target)

        let corrected = Sweref99TM.toWGS84(x: rawPlanar.x + 2, y: rawPlanar.y - 1)
        let mapped = Distance.planarMeters(corrected, target)
        clock = clock.addingTimeInterval(4 * 60)

        XCTAssertEqual(model.laserRoute(distanceM: mapped + 1), .residualCheck)
        XCTAssertEqual(model.registerLaserShot(distanceM: mapped + 1, target: target), .confirmed)
        let check = try XCTUnwrap(model.lastLaserCarryCheck)
        XCTAssertEqual(check.laserDistanceM, mapped + 1, accuracy: 1e-6)
        XCTAssertEqual(check.mappedDistanceM, mapped, accuracy: 0.02)
        XCTAssertEqual(check.deltaM, 1, accuracy: 0.02)
        XCTAssertEqual(model.originCalibration?.method, .residualRefresh)
        XCTAssertEqual(model.originCalibration?.solvedAt, clock)
    }

    func testDecayedCalibrationRoutesPickedFeatureToNewSession() {
        let model = model()
        let raw = LatLon(lat: 58.36, lon: 15.71)
        model.updateUserLocation(raw)
        model.applyCalibration(OriginCalibration(
            biasE: 2, biasN: -1,
            solvedAt: clock.addingTimeInterval(-16 * 60), solvedNear: raw,
            method: .trilateration, baseConfidence: 1
        ))
        model.setGPSEnabled(false)
        model.inspectBrowsePoint(LatLon(lat: 58.361, lon: 15.71))

        XCTAssertEqual(model.calibrationStatus, .stale)
        XCTAssertEqual(model.laserRoute(distanceM: 100), .calibrationShot)
    }
}
