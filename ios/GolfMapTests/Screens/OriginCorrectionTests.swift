import XCTest
@testable import GolfMap

/// Origin-seam GPS-bias correction (spec §6.1/§6.4/§6.6): the calibration is
/// applied ONLY to the live fix, everything downstream inherits it through
/// `origin`, and it drops (never scales) when decayed / invalidated.
@MainActor
final class OriginCorrectionTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    /// Fixed wall clock; solve ages are expressed relative to it.
    private let clock = Date(timeIntervalSince1970: 1_700_000_000)

    override func setUp() {
        super.setUp()
        suiteName = "OriginCorrectionTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture (synthetic furniture, one hole + tee)

    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-1", name: "Calib GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4, strokeIndex: 1)]
        let tees = [
            TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: 58.3640, centerLon: 15.7080,
                frontLat: 58.3638, frontLon: 15.7080,
                backLat: 58.3642, backLon: 15.7080,
                elevation: 25
            ),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: [], manifest: manifest
        )
    }

    private func makeModel() -> OnCourseModel {
        OnCourseModel(furniture: makeFurniture(), defaults: defaults, now: { [clock] in clock })
    }

    /// A calibration solved `ageMinutes` ago, anchored at `solvedNear`, with
    /// bias (biasE, biasN) and base confidence 1 (so only age/distance decay).
    private func calibration(
        biasE: Double, biasN: Double, solvedNear: LatLon,
        ageMinutes: Double = 0, baseConfidence: Double = 1
    ) -> OriginCalibration {
        OriginCalibration(
            biasE: biasE, biasN: biasN,
            solvedAt: clock.addingTimeInterval(-ageMinutes * 60),
            solvedNear: solvedNear,
            method: .anchor,
            baseConfidence: baseConfidence
        )
    }

    // MARK: - Fresh calibration shifts the live-GPS origin

    func testFreshCalibrationShiftsOriginByExactPlanarBias() {
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)

        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix))

        let corrected = try! XCTUnwrap(model.origin)
        // Planar offset from the raw fix is exactly (biasE, biasN), within cm.
        let raw = Sweref99TM.fromWGS84(fix)
        let got = Sweref99TM.fromWGS84(corrected)
        XCTAssertEqual(got.x - raw.x, 3, accuracy: 0.01)
        XCTAssertEqual(got.y - raw.y, -2, accuracy: 0.01)

        // Round-trip cross-check against the expected WGS84 point.
        let expected = Sweref99TM.toWGS84(x: raw.x + 3, y: raw.y - 2)
        XCTAssertLessThan(Distance.planarMeters(corrected, expected), 0.01)

        if case .active(let confidence) = model.calibrationStatus {
            XCTAssertEqual(confidence, 1, accuracy: 1e-9)
        } else {
            XCTFail("expected .active status, got \(model.calibrationStatus)")
        }
    }

    // MARK: - Browse origin / tee are map-anchored, never corrected

    func testBrowseOriginIsNotShifted() {
        let model = makeModel()
        // A live fix exists but GPS is off → browse mode.
        model.updateUserLocation(LatLon(lat: 58.3630, lon: 15.7085))
        model.setGPSEnabled(false)
        let browse = LatLon(lat: 58.3620, lon: 15.7090)
        model.setBrowseOrigin(browse)

        model.applyCalibration(calibration(biasE: 5, biasN: 5, solvedNear: browse))

        XCTAssertEqual(model.origin, browse, "browse origin is map-anchored, not GPS — never corrected")
    }

    // MARK: - Decay drops the correction (raw fix, stale status)

    func testDecayedCalibrationUsesRawFix() {
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)

        // 16 min old → past ageZeroTrust (15) → confidence 0 → bias dropped.
        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix, ageMinutes: 16))

        XCTAssertEqual(model.origin, fix, "decayed correction is dropped, raw fix used")
        XCTAssertEqual(model.calibrationStatus, .stale)
    }

    // MARK: - GPS discontinuity invalidates the calibration

    func testLargeGPSJumpMarksCalibrationStale() {
        let model = makeModel()
        let fix1 = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix1)
        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix1))
        XCTAssertNotEqual(model.origin, fix1, "sanity: correction is applied before the jump")

        // ~66 m north — a canopy-exit discontinuity, well past the 50 m gate.
        let fix2 = LatLon(lat: 58.3636, lon: 15.7085)
        XCTAssertGreaterThan(Distance.planarMeters(fix1, fix2), 50)
        model.updateUserLocation(fix2)

        XCTAssertEqual(model.originCalibration?.stale, true)
        XCTAssertEqual(model.origin, fix2, "stale calibration → raw fix")
        XCTAssertEqual(model.calibrationStatus, .stale)
    }

    func testSmallWalkDoesNotInvalidate() {
        let model = makeModel()
        let fix1 = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix1)
        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix1))

        // ~11 m — a normal stride between fixes.
        let fix2 = LatLon(lat: 58.3631, lon: 15.7085)
        XCTAssertLessThan(Distance.planarMeters(fix1, fix2), 50)
        model.updateUserLocation(fix2)

        XCTAssertEqual(model.originCalibration?.stale, false)
        XCTAssertNotEqual(model.origin, fix2, "correction still applied after a small move")
    }

    // MARK: - Residual gate: confirm refreshes, reject invalidates

    func testResidualConfirmRefreshesConfidence() {
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)
        // 10 min old, base 0.8 → age factor 0.5 → confidence ~0.4 (still applied).
        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix, ageMinutes: 10, baseConfidence: 0.8))
        guard case .active(let before) = model.calibrationStatus else {
            return XCTFail("expected decaying-but-active status")
        }
        XCTAssertEqual(before, 0.4, accuracy: 1e-6)

        let outcome = model.registerLaserResidual(1.0) // ≤ 2 m → confirm
        XCTAssertEqual(outcome, .confirmed)

        // solvedAt reset to now → age 0 → confidence recovers toward base.
        guard case .active(let after) = model.calibrationStatus else {
            return XCTFail("expected active status after confirm")
        }
        XCTAssertEqual(after, 0.8, accuracy: 1e-6)
        XCTAssertGreaterThan(after, before)
    }

    func testResidualRejectMarksStale() {
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)
        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix))

        let outcome = model.registerLaserResidual(5.0) // ≥ 4 m → reject
        XCTAssertEqual(outcome, .rejected)
        XCTAssertEqual(model.originCalibration?.stale, true)
        XCTAssertEqual(model.calibrationStatus, .stale)
        XCTAssertEqual(model.origin, fix, "rejected calibration → raw fix")
    }

    func testRegisterResidualWithoutCalibrationIsInconclusive() {
        let model = makeModel()
        model.updateUserLocation(LatLon(lat: 58.3630, lon: 15.7085))
        XCTAssertEqual(model.registerLaserResidual(1.0), .inconclusive)
        XCTAssertNil(model.originCalibration)
    }

    // MARK: - clear

    func testClearCalibrationRevertsToRawFix() {
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)
        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix))
        XCTAssertNotEqual(model.origin, fix)

        model.clearCalibration()
        XCTAssertNil(model.originCalibration)
        XCTAssertEqual(model.calibrationStatus, .none)
        XCTAssertEqual(model.origin, fix)
    }

    // MARK: - Map marker follows the corrected fix

    func testUserMarkerSitsAtCorrectedPosition() {
        // The blue dot must sit where distances measure from: with an active
        // calibration a raw-fix dot would float metres off the measuring
        // origin on the ortho and read as a bug.
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)
        model.applyCalibration(calibration(biasE: 3, biasN: -2, solvedNear: fix))

        let marker = try! XCTUnwrap(model.overlays(showRouteLabels: false).userLocation)
        XCTAssertEqual(marker.position, model.origin)
        XCTAssertGreaterThan(Distance.planarMeters(marker.position, fix), 3)
    }
}
