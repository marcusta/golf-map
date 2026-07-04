import XCTest
@testable import GolfMap

@MainActor
final class OnCourseModelTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "OnCourseModelTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    /// 3-hole synthetic course. Hole 1 has two tees (default + Blue), a full
    /// green (F/C/B + elevation), an active pin and two aim points (one
    /// unlabeled). Holes 2–3 have a single default tee and center-only greens.
    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-1", name: "Testville GC", status: "published",
            revision: 2, downloadedRevision: 2, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 4, strokeIndex: 7),
            HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 3, strokeIndex: 15),
            HoleRecord(id: "h3", courseId: "course-1", number: 3, par: 5, strokeIndex: 1),
        ]
        let tees = [
            // Deliberately out of sortOrder to exercise sorting.
            TeeRecord(id: "t1b", holeId: "h1", name: "Blue", lat: 58.3590, lon: 15.7100, elevation: 12, sortOrder: 1),
            TeeRecord(id: "t1d", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0),
            TeeRecord(id: "t2d", holeId: "h2", name: "default", lat: 58.3660, lon: 15.7060, sortOrder: 0),
            TeeRecord(id: "t3d", holeId: "h3", name: "default", lat: 58.3680, lon: 15.7080, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(
                id: "g1", holeId: "h1",
                centerLat: 58.3640, centerLon: 15.7080,
                frontLat: 58.3638, frontLon: 15.7080,
                backLat: 58.3642, backLon: 15.7080,
                elevation: 25
            ),
            GreenRecord(id: "g2", holeId: "h2", centerLat: 58.3670, centerLon: 15.7050),
            GreenRecord(id: "g3", holeId: "h3", centerLat: 58.3700, centerLon: 15.7090),
        ]
        let pins = [
            PinRecord(id: "p1", greenId: "g1", name: "Front-left", lat: 58.3639, lon: 15.7079, active: true),
            PinRecord(id: "p2", greenId: "g1", name: "Back-right", lat: 58.3641, lon: 15.7081, active: false),
        ]
        let aims = [
            AimPointRecord(id: "a2", holeId: "h1", sortOrder: 1, lat: 58.3625, lon: 15.7088, label: "Layup"),
            AimPointRecord(id: "a1", holeId: "h1", sortOrder: 0, lat: 58.3615, lon: 15.7092, label: nil),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: pins, aimPoints: aims, manifest: manifest
        )
    }

    private func makeModel() -> OnCourseModel {
        OnCourseModel(furniture: makeFurniture(), defaults: defaults)
    }

    // MARK: - Hole navigation

    func testStartsOnHoleOneWithJoinedFurniture() {
        let model = makeModel()
        XCTAssertEqual(model.holes.count, 3)
        XCTAssertEqual(model.currentHoleNumber, 1)
        let hole = try! XCTUnwrap(model.currentHole)
        XCTAssertEqual(hole.hole.par, 4)
        XCTAssertEqual(hole.tees.map(\.name), ["default", "Blue"], "tees sorted by sortOrder")
        XCTAssertEqual(hole.green?.id, "g1")
        XCTAssertEqual(hole.pins.count, 2)
        XCTAssertEqual(hole.aimPoints.map(\.id), ["a1", "a2"], "aims sorted by sortOrder")
    }

    func testNextPreviousClampAtEnds() {
        let model = makeModel()
        XCTAssertFalse(model.canGoPrevious)
        model.previousHole()
        XCTAssertEqual(model.currentHoleNumber, 1)

        model.nextHole()
        XCTAssertEqual(model.currentHoleNumber, 2)
        model.nextHole()
        XCTAssertEqual(model.currentHoleNumber, 3)
        XCTAssertFalse(model.canGoNext)
        model.nextHole()
        XCTAssertEqual(model.currentHoleNumber, 3)

        model.previousHole()
        XCTAssertEqual(model.currentHoleNumber, 2)
    }

    func testGoToHoleByNumber() {
        let model = makeModel()
        model.goToHole(number: 3)
        XCTAssertEqual(model.currentHoleNumber, 3)
        model.goToHole(number: 99) // unknown → no change
        XCTAssertEqual(model.currentHoleNumber, 3)
    }

    func testHoleChangeAndRecenterBumpCameraToken() {
        let model = makeModel()
        let initial = model.cameraToken
        model.nextHole()
        XCTAssertGreaterThan(model.cameraToken, initial)
        let afterHole = model.cameraToken
        model.recenter()
        XCTAssertGreaterThan(model.cameraToken, afterHole)
    }

    // MARK: - Tee selection + persistence

    func testDefaultTeeIsLowestSortOrder() {
        let model = makeModel()
        XCTAssertNil(model.activeTeeName)
        XCTAssertEqual(model.resolvedTeeName, "default")
    }

    func testAvailableTeeNamesOrderedBySortOrder() {
        let model = makeModel()
        XCTAssertEqual(model.availableTeeNames, ["default", "Blue"])
    }

    func testSelectedTeePersistsAcrossModels() {
        let model = makeModel()
        model.selectTee(named: "Blue")
        XCTAssertEqual(model.resolvedTeeName, "Blue")

        let reloaded = makeModel()
        XCTAssertEqual(reloaded.activeTeeName, "Blue")
        XCTAssertEqual(reloaded.resolvedTeeName, "Blue")
    }

    func testTeeFallsBackWhenHoleLacksSelectedName() {
        let model = makeModel()
        model.selectTee(named: "Blue")
        model.goToHole(number: 2) // hole 2 has only "default"
        XCTAssertEqual(model.resolvedTeeName, "default")
    }

    // MARK: - Origin fallback (tee ↔ GPS)

    func testWithoutGPSDistancesMeasureFromActiveTee() {
        let model = makeModel()
        XCTAssertFalse(model.isUsingGPS)
        let tee = LatLon(lat: 58.3600, lon: 15.7100)
        XCTAssertEqual(model.origin, tee)

        let expectedCenter = Int(Distance.planarMeters(tee, LatLon(lat: 58.3640, lon: 15.7080)).rounded())
        XCTAssertEqual(model.distances?.center, expectedCenter)
        // Tee elevation 10 vs green 25 → plays-like = center + 15.
        XCTAssertEqual(model.distances?.playsLikeCenter, expectedCenter + 15)

        // Distance line runs tee → green center; no user dot.
        XCTAssertEqual(model.overlays.distanceLine.first, tee)
        XCTAssertNil(model.overlays.userLocation)
    }

    func testWithGPSDistancesMeasureFromUser() {
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)
        XCTAssertTrue(model.isUsingGPS)
        XCTAssertEqual(model.origin, fix)

        let expectedCenter = Int(Distance.planarMeters(fix, LatLon(lat: 58.3640, lon: 15.7080)).rounded())
        XCTAssertEqual(model.distances?.center, expectedCenter)
        // No elevation sampler → no user elevation → no plays-like from GPS.
        XCTAssertNil(model.distances?.playsLikeCenter)

        XCTAssertEqual(model.overlays.distanceLine.first, fix)
        XCTAssertEqual(model.overlays.userLocation?.position, fix)

        model.updateUserLocation(nil)
        XCTAssertFalse(model.isUsingGPS)
        XCTAssertEqual(model.origin, LatLon(lat: 58.3600, lon: 15.7100), "falls back to tee")
    }

    func testUserElevationComesFromSampler() async {
        let model = makeModel()
        model.elevationSampler = { _ in 42.5 }
        model.updateUserLocation(LatLon(lat: 58.3630, lon: 15.7085))
        // The sampler runs on a spawned task; poll briefly.
        for _ in 0..<100 where model.userElevation == nil {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(model.userElevation, 42.5)
        // Plays-like now available: user 42.5 vs green 25 → center − 17.5 → rounded.
        let center = Distance.planarMeters(
            LatLon(lat: 58.3630, lon: 15.7085), LatLon(lat: 58.3640, lon: 15.7080)
        )
        XCTAssertEqual(model.distances?.playsLikeCenter, Int((center - 17.5).rounded()))
    }

    // MARK: - Targets

    func testTargetsIncludeActivePinAndLabeledAims() {
        let model = makeModel()
        let targets = model.targets
        XCTAssertEqual(targets.greenCenter, LatLon(lat: 58.3640, lon: 15.7080))
        XCTAssertEqual(targets.greenFront, LatLon(lat: 58.3638, lon: 15.7080))
        XCTAssertEqual(targets.greenBack, LatLon(lat: 58.3642, lon: 15.7080))
        XCTAssertEqual(targets.greenElevation, 25)
        XCTAssertEqual(targets.activePin, LatLon(lat: 58.3639, lon: 15.7079), "only the active pin")
        XCTAssertEqual(targets.activePinName, "Front-left")
        XCTAssertEqual(targets.aimPoints.map(\.label), ["Aim 1", "Layup"], "nil label gets ordinal fallback")
    }

    func testCenterOnlyGreenHasNoFrontBack() {
        let model = makeModel()
        model.goToHole(number: 2)
        let targets = model.targets
        XCTAssertNil(targets.greenFront)
        XCTAssertNil(targets.greenBack)
        XCTAssertNotNil(targets.greenCenter)
        let d = try! XCTUnwrap(model.distances)
        XCTAssertNil(d.front)
        XCTAssertNil(d.back)
        XCTAssertNotNil(d.center)
    }

    // MARK: - Playing length + camera

    func testPlayingLengthMatchesHoleLengthForActiveTee() {
        let model = makeModel()
        let expected = HoleLength.playingLength(
            tee: LatLon(lat: 58.3600, lon: 15.7100),
            aims: [LatLon(lat: 58.3615, lon: 15.7092), LatLon(lat: 58.3625, lon: 15.7088)],
            greenCenter: LatLon(lat: 58.3640, lon: 15.7080)
        )
        XCTAssertEqual(model.playingLength, expected)

        model.selectTee(named: "Blue")
        let blue = HoleLength.playingLength(
            tee: LatLon(lat: 58.3590, lon: 15.7100),
            aims: [LatLon(lat: 58.3615, lon: 15.7092), LatLon(lat: 58.3625, lon: 15.7088)],
            greenCenter: LatLon(lat: 58.3640, lon: 15.7080)
        )
        XCTAssertEqual(model.playingLength, blue)
    }

    func testHoleBoundsCoverTeeGreenAimsAndPin() {
        let model = makeModel()
        let bounds = try! XCTUnwrap(model.holeBounds)
        // South edge = tee lat, north edge = green back lat.
        XCTAssertEqual(bounds.south, 58.3600, accuracy: 1e-9)
        XCTAssertEqual(bounds.north, 58.3642, accuracy: 1e-9)
        // West edge = pin lon (15.7079), east edge = tee lon (15.7100).
        XCTAssertEqual(bounds.west, 15.7079, accuracy: 1e-9)
        XCTAssertEqual(bounds.east, 15.7100, accuracy: 1e-9)
    }

    func testHoleBearingIsTeeToGreenCenter() {
        let model = makeModel()
        let expected = Distance.bearingDegrees(
            LatLon(lat: 58.3600, lon: 15.7100),
            LatLon(lat: 58.3640, lon: 15.7080)
        )
        XCTAssertEqual(model.holeBearing, expected, accuracy: 1e-9)
        XCTAssertEqual(model.cameraCommand?.bearing ?? -1, expected, accuracy: 1e-9)
    }
}
