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

    func testFocusMapCentersCameraAndRecenterClearsIt() {
        let model = makeModel()
        let point = LatLon(lat: 58.3641, lon: 15.7081)
        model.focusMap(on: point)
        // The command now centers on the tapped feature instead of fitting the hole.
        guard case let .center(center, _)? = model.cameraCommand?.target else {
            return XCTFail("focus should produce a .center camera command")
        }
        XCTAssertEqual(center.lat, point.lat, accuracy: 1e-9)
        XCTAssertEqual(center.lon, point.lon, accuracy: 1e-9)
        // Recenter drops the focus back to the hole fit (.bounds).
        model.recenter()
        if case .center = model.cameraCommand?.target {
            XCTFail("recenter should clear the focus and restore the hole fit")
        }
    }

    func testHoleChangeClearsMapFocus() {
        let model = makeModel()
        model.focusMap(on: LatLon(lat: 58.3641, lon: 15.7081))
        model.nextHole()
        if case .center = model.cameraCommand?.target {
            XCTFail("changing holes should clear the ladder focus")
        }
    }

    func testHazardCarriesScopesToCurrentHoleByNearestLine() {
        let model = makeModel() // on hole 1
        func box(around ll: LatLon, _ kind: String) -> FlatRing {
            let c = Sweref99TM.fromWGS84(ll)
            return FlatRing(points: [
                Vec2(x: c.x - 5, y: c.y - 5), Vec2(x: c.x + 5, y: c.y - 5),
                Vec2(x: c.x + 5, y: c.y + 5), Vec2(x: c.x - 5, y: c.y + 5),
            ], kind: kind)
        }
        // A bunker on hole 1's tee→green line, and water on hole 2's line.
        let onHole1 = box(around: LatLon(lat: 58.3620, lon: 15.7090), "bunker")
        let onHole2 = box(around: LatLon(lat: 58.3665, lon: 15.7055), "water")
        model.setHazards([onHole1, onHole2])

        let kinds = model.hazardCarries.map(\.kind)
        XCTAssertTrue(kinds.contains("bunker"), "this hole's bunker is included")
        XCTAssertFalse(kinds.contains("water"), "the adjacent hole's hazard is excluded")
    }

    private func hazardBox(_ lat: Double, _ lon: Double) -> FlatRing {
        let c = Sweref99TM.fromWGS84(LatLon(lat: lat, lon: lon))
        return FlatRing(points: [
            Vec2(x: c.x - 5, y: c.y - 5), Vec2(x: c.x + 5, y: c.y - 5),
            Vec2(x: c.x + 5, y: c.y + 5), Vec2(x: c.x - 5, y: c.y + 5),
        ], kind: "bunker")
    }

    func testOwnHazardShownEvenWellOffLine() {
        let model = makeModel() // hole 1 = "h1"
        // ~175 m off hole 1's line, but tagged to hole 1 → always shown.
        model.setHazards([hazardBox(58.3620, 15.7120)], holeIds: ["h1"])
        XCTAssertEqual(model.hazardCarries.count, 1)
    }

    func testForeignHazardOffLineExcluded() {
        let model = makeModel()
        // Same spot, but tagged to hole 2 and well off hole 1's line → not in play.
        model.setHazards([hazardBox(58.3620, 15.7120)], holeIds: ["h2"])
        XCTAssertTrue(model.hazardCarries.isEmpty)
    }

    func testForeignHazardInPlayIsShown() {
        let model = makeModel()
        // Belongs to hole 2, but sits on hole 1's line → in play, so shown.
        model.setHazards([hazardBox(58.3620, 15.7090)], holeIds: ["h2"])
        XCTAssertEqual(model.hazardCarries.count, 1)
    }

    func testLadderPopulatesFromTeeOriginWhenBrowsing() {
        // No GPS fix → origin falls back to the active tee (browse mode). The
        // ladder must still populate — it measures from any valid origin, not
        // only a live fix. (Regression: the expanded card used to hide the
        // ladder in browse mode entirely.)
        let model = makeModel()
        XCTAssertFalse(model.isUsingGPS, "fixture has no GPS fix → browse/tee origin")
        let rows = model.ladderRows
        XCTAssertFalse(rows.isEmpty, "ladder should populate from the tee origin")
        XCTAssertTrue(rows.contains { $0.kind == .green }, "green row present")
        XCTAssertTrue(rows.contains { $0.kind == .pin }, "pin row present")
    }

    func testBrowseMapTapInspectsBeforeExplicitPromotion() throws {
        let model = makeModel()
        model.setGPSEnabled(false)
        let teeOrigin = try XCTUnwrap(model.origin)
        let point = LatLon(lat: 58.3626, lon: 15.7087)

        model.inspectBrowsePoint(point)

        XCTAssertEqual(model.origin, teeOrigin, "inspection must leave the browse origin at the tee")
        XCTAssertEqual(model.overlays.distanceLine.first, teeOrigin)
        XCTAssertEqual(model.overlays.highlight, point)
        XCTAssertEqual(model.browseTarget, point)
        XCTAssertEqual(model.selectedTargetAdvice?.title, "Selected point")
        XCTAssertTrue(model.canPromoteInspectedBrowseTarget)

        model.promoteInspectedBrowseTarget()

        let origin = try XCTUnwrap(model.origin)
        let lineOrigin = try XCTUnwrap(model.overlays.distanceLine.first)
        let highlight = try XCTUnwrap(model.overlays.highlight)
        XCTAssertEqual(origin.lat, point.lat, accuracy: 1e-9)
        XCTAssertEqual(origin.lon, point.lon, accuracy: 1e-9)
        XCTAssertEqual(lineOrigin.lat, point.lat, accuracy: 1e-9)
        XCTAssertEqual(lineOrigin.lon, point.lon, accuracy: 1e-9)
        XCTAssertEqual(highlight.lat, point.lat, accuracy: 1e-9)
    }

    func testBrowseLadderTapInspectsBeforeExplicitPromotion() throws {
        let model = makeModel()
        model.setGPSEnabled(false)
        let teeOrigin = try XCTUnwrap(model.origin)
        let row = try XCTUnwrap(model.ladderRows.first { $0.kind == .aim && $0.position != nil })
        let point = try XCTUnwrap(row.position)

        model.inspectBrowseLadder(row)

        XCTAssertEqual(model.origin, teeOrigin, "ladder inspection must not rebuild from the rung")
        XCTAssertEqual(model.overlays.distanceLine.first, teeOrigin)
        XCTAssertEqual(model.focusedLadderId, row.id)
        XCTAssertEqual(model.selectedTargetAdvice?.title, row.label)
        XCTAssertTrue(model.canPromoteInspectedBrowseTarget)

        model.promoteInspectedBrowseTarget()

        let origin = try XCTUnwrap(model.origin)
        XCTAssertEqual(origin.lat, point.lat, accuracy: 1e-9)
        XCTAssertEqual(origin.lon, point.lon, accuracy: 1e-9)
        XCTAssertNil(model.focusedLadderId, "the old rung id must not select a rebuilt ladder")
    }

    func testBrowseResetRestoresTeeOrigin() throws {
        let model = makeModel()
        model.setGPSEnabled(false)
        let teeOrigin = try XCTUnwrap(model.origin)
        model.setBrowseOrigin(LatLon(lat: 58.3626, lon: 15.7087))

        model.resetBrowseOrigin()

        XCTAssertNil(model.browseOrigin)
        XCTAssertEqual(model.origin, teeOrigin)
        XCTAssertFalse(model.canPromoteInspectedBrowseTarget)
    }

    func testBrowseOriginResetsOnHoleChange() throws {
        let model = makeModel()
        model.setGPSEnabled(false)
        model.setBrowseOrigin(LatLon(lat: 58.3626, lon: 15.7087))

        model.nextHole()

        XCTAssertNil(model.browseOrigin)
        let expectedTee = try XCTUnwrap(model.currentHole.flatMap { model.teePosition(for: $0) })
        let origin = try XCTUnwrap(model.origin)
        XCTAssertEqual(origin.lat, expectedTee.lat, accuracy: 1e-9)
        XCTAssertEqual(origin.lon, expectedTee.lon, accuracy: 1e-9)
    }

    func testFocusMapAddsHighlightMarkerClearedByRecenter() throws {
        let model = makeModel()
        XCTAssertNil(model.overlays.highlight)
        let point = LatLon(lat: 58.3641, lon: 15.7081)
        model.focusMap(on: point)
        let highlight = try XCTUnwrap(model.overlays.highlight)
        XCTAssertEqual(highlight.lat, point.lat, accuracy: 1e-9)
        XCTAssertEqual(highlight.lon, point.lon, accuracy: 1e-9)
        model.recenter()
        XCTAssertNil(model.overlays.highlight, "recenter clears the highlight with the focus")
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

    // MARK: - Feature 1: camera stability across GPS fixes

    func testCameraCommandStaysEqualAcrossGPSFixes() {
        let model = makeModel()
        let initial = try! XCTUnwrap(model.cameraCommand)
        // Successive fixes within the same hole must not re-issue the camera
        // (holeBounds/bearing are GPS-independent), so it never fights gestures.
        model.updateUserLocation(LatLon(lat: 58.3631, lon: 15.7085))
        XCTAssertEqual(model.cameraCommand, initial)
        model.updateUserLocation(LatLon(lat: 58.3632, lon: 15.7086))
        XCTAssertEqual(model.cameraCommand, initial)
        model.updateUserLocation(nil)
        XCTAssertEqual(model.cameraCommand, initial)
        // Only an explicit recenter (token bump) changes it.
        model.recenter()
        XCTAssertNotEqual(model.cameraCommand, initial)
    }

    // MARK: - Feature 2: GPS toggle + browse mode

    func testGPSToggleIgnoresFixAndPersists() {
        let model = makeModel()
        let fix = LatLon(lat: 58.3630, lon: 15.7085)
        model.updateUserLocation(fix)
        XCTAssertTrue(model.isUsingGPS)

        model.setGPSEnabled(false)
        XCTAssertTrue(model.isBrowseMode)
        XCTAssertFalse(model.isUsingGPS)
        // Origin ignores the fix, falls to the active tee.
        XCTAssertEqual(model.origin, LatLon(lat: 58.3600, lon: 15.7100))
        XCTAssertNil(model.overlays.userLocation, "no user dot in browse mode")

        // Persisted per course.
        let reloaded = makeModel()
        XCTAssertTrue(reloaded.isBrowseMode)
    }

    func testBrowseModeRouteIsTeeAimsGreenInOrder() {
        let model = makeModel()
        model.setGPSEnabled(false)
        let route = model.holeRoute
        XCTAssertEqual(route, [
            LatLon(lat: 58.3600, lon: 15.7100), // tee
            LatLon(lat: 58.3615, lon: 15.7092), // aim 1 (sortOrder 0)
            LatLon(lat: 58.3625, lon: 15.7088), // aim 2 (sortOrder 1)
            LatLon(lat: 58.3640, lon: 15.7080), // green center
        ])
        XCTAssertEqual(model.overlays.distanceLine, route, "browse line follows the full route")
        // Legs: three segments for four vertices.
        XCTAssertEqual(model.routeLegs.count, 3)
    }

    func testBrowseModeRouteForNoAimHoleIsTeeToGreen() {
        let model = makeModel()
        model.goToHole(number: 2) // center-only green, no aims
        model.setGPSEnabled(false)
        XCTAssertEqual(model.holeRoute, [
            LatLon(lat: 58.3660, lon: 15.7060), // tee
            LatLon(lat: 58.3670, lon: 15.7050), // green center
        ])
        XCTAssertEqual(model.routeLegs.count, 1)
    }

    // MARK: - Feature 3: aim routing

    func testAimRoutingPicksNextAimWhenFarFromGreen() {
        let model = makeModel()
        // Place the user just behind the tee, well past 230 m from the green.
        let farUser = LatLon(lat: 58.3595, lon: 15.7100)
        model.updateUserLocation(farUser)
        let green = LatLon(lat: 58.3640, lon: 15.7080)
        XCTAssertGreaterThan(Distance.planarMeters(farUser, green), 230)

        let aim = try! XCTUnwrap(model.nextAimAhead)
        // First aim ahead in tee→green order is "Aim 1" (closer to green than user).
        XCTAssertEqual(aim.label, "Aim 1")
        // The line runs user → routed aim → remaining forward aims → green
        // (extended past the routed aim so the immersive leg labels have a
        // line to sit on); the emphasized first leg still points at "Aim 1".
        XCTAssertEqual(model.overlays.distanceLine, [
            farUser,
            aim.position,
            LatLon(lat: 58.3625, lon: 15.7088), // aim 2 ("Layup")
            green,
        ])
        XCTAssertEqual(model.routedAimDistance?.label, "Aim 1")
    }

    func testAimRoutingFallsToGreenWhenClose() {
        let model = makeModel()
        // User right at the green front: < 230 m to center.
        let nearUser = LatLon(lat: 58.3638, lon: 15.7080)
        model.updateUserLocation(nearUser)
        let green = LatLon(lat: 58.3640, lon: 15.7080)
        XCTAssertLessThan(Distance.planarMeters(nearUser, green), 230)
        XCTAssertNil(model.nextAimAhead)
        XCTAssertEqual(model.overlays.distanceLine, [nearUser, green])
        XCTAssertNil(model.routedAimDistance)
    }

    func testAimRoutingThresholdIsConfigurableAndPersists() {
        let model = makeModel()
        let user = LatLon(lat: 58.3595, lon: 15.7100)
        model.updateUserLocation(user)
        XCTAssertNotNil(model.nextAimAhead, "default 230 → routes to aim")
        // Raise the threshold above the user→green distance → back to green.
        let big = Distance.planarMeters(user, LatLon(lat: 58.3640, lon: 15.7080)) + 100
        model.setAimRoutingThresholdMeters(big)
        XCTAssertNil(model.nextAimAhead)

        let reloaded = makeModel()
        XCTAssertEqual(reloaded.aimRoutingThresholdMeters, big, accuracy: 1e-6)
    }

    func testAimRoutingDisabledInBrowseMode() {
        let model = makeModel()
        model.updateUserLocation(LatLon(lat: 58.3595, lon: 15.7100))
        model.setGPSEnabled(false)
        XCTAssertNil(model.nextAimAhead, "no aim routing without a live GPS origin")
    }

    // MARK: - Feature 4: tee override honored across ALL reads

    func testTeeOverrideHonoredAcrossReadsAndPersistsAndResets() {
        let model = makeModel()
        model.setGPSEnabled(false)
        let moved = LatLon(lat: 58.3585, lon: 15.7110)
        model.moveActiveTee(to: moved)
        XCTAssertTrue(model.currentTeeHasOverride)

        // origin / route
        XCTAssertEqual(model.origin, moved)
        XCTAssertEqual(model.holeRoute.first, moved)
        // bounds — south/east edge now driven by the moved tee.
        let bounds = try! XCTUnwrap(model.holeBounds)
        XCTAssertEqual(bounds.south, moved.lat, accuracy: 1e-9)
        XCTAssertEqual(bounds.east, moved.lon, accuracy: 1e-9)
        // bearing — recomputed from the moved tee.
        let expectedBearing = Distance.bearingDegrees(moved, LatLon(lat: 58.3640, lon: 15.7080))
        XCTAssertEqual(model.holeBearing, expectedBearing, accuracy: 1e-9)
        // playing length — from the moved tee.
        let expectedLength = HoleLength.playingLength(
            tee: moved,
            aims: [LatLon(lat: 58.3615, lon: 15.7092), LatLon(lat: 58.3625, lon: 15.7088)],
            greenCenter: LatLon(lat: 58.3640, lon: 15.7080)
        )
        XCTAssertEqual(model.playingLength, expectedLength)
        // distances — center measured from the moved tee.
        let expectedCenter = Int(Distance.planarMeters(moved, LatLon(lat: 58.3640, lon: 15.7080)).rounded())
        XCTAssertEqual(model.distances?.center, expectedCenter)

        // persistence
        let reloaded = makeModel()
        XCTAssertTrue(reloaded.currentTeeHasOverride)
        XCTAssertEqual(reloaded.holeRoute.first, moved)

        // reset
        reloaded.resetActiveTee()
        XCTAssertFalse(reloaded.currentTeeHasOverride)
        XCTAssertEqual(reloaded.holeRoute.first, LatLon(lat: 58.3600, lon: 15.7100))
        let afterReset = makeModel()
        XCTAssertFalse(afterReset.currentTeeHasOverride, "reset persists")
    }

    func testTeeOverrideIsPerTeeName() {
        let model = makeModel()
        model.setGPSEnabled(false)
        let moved = LatLon(lat: 58.3585, lon: 15.7110)
        model.moveActiveTee(to: moved) // default tee
        XCTAssertTrue(model.currentTeeHasOverride)
        // Switching to Blue tee → no override there.
        model.selectTee(named: "Blue")
        XCTAssertFalse(model.currentTeeHasOverride)
        XCTAssertEqual(model.origin, LatLon(lat: 58.3590, lon: 15.7100), "Blue's stored position")
    }

    // MARK: - Tee menu (Feature A: longest-first + per-tee length)

    /// One-hole course whose single hole carries four tees at increasing
    /// distance from the green (so length order ≠ sortOrder) plus a course-level
    /// tee name ("Red") that only exists on a *second* hole — i.e. absent from
    /// the first hole. Shared aim + green so lengths differ only by tee position.
    private func makeMultiTeeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-mt", name: "Multi-tee GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "mh1", courseId: "course-mt", number: 1, par: 4, strokeIndex: 3),
            HoleRecord(id: "mh2", courseId: "course-mt", number: 2, par: 4, strokeIndex: 5),
        ]
        // Hole 1 tees, all due south of the green on the same meridian so the
        // farther-south (lower lat) tee is the longer hole. sortOrder is
        // deliberately unrelated to length.
        let tees = [
            TeeRecord(id: "yellow", holeId: "mh1", name: "Yellow", lat: 58.3610, lon: 15.7080, sortOrder: 0),
            TeeRecord(id: "white",  holeId: "mh1", name: "White",  lat: 58.3605, lon: 15.7080, sortOrder: 1),
            TeeRecord(id: "black",  holeId: "mh1", name: "Black",  lat: 58.3595, lon: 15.7080, sortOrder: 2),
            TeeRecord(id: "blue",   holeId: "mh1", name: "Blue",   lat: 58.3600, lon: 15.7080, sortOrder: 3),
            // "Red" exists only on hole 2 → a course-level name absent on hole 1.
            TeeRecord(id: "red2",   holeId: "mh2", name: "Red",    lat: 58.3660, lon: 15.7080, sortOrder: 0),
        ]
        let greens = [
            GreenRecord(id: "mg1", holeId: "mh1", centerLat: 58.3640, centerLon: 15.7080),
            GreenRecord(id: "mg2", holeId: "mh2", centerLat: 58.3700, centerLon: 15.7080),
        ]
        let aims = [
            AimPointRecord(id: "ma1", holeId: "mh1", sortOrder: 0, lat: 58.3625, lon: 15.7080, label: nil),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-mt", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: aims, manifest: manifest
        )
    }

    func testTeeMenuOrdersLongestFirstWithPerTeeLength() {
        let model = OnCourseModel(furniture: makeMultiTeeFurniture(), defaults: defaults)
        let entries = model.teeMenuEntries

        // Present tees (Black/Blue/White/Yellow), longest-first, then absent Red.
        XCTAssertEqual(entries.map(\.name), ["Black", "Blue", "White", "Yellow", "Red"])

        // Present tees carry a length; the absent one does not.
        XCTAssertNil(entries.last?.length, "Red is absent on this hole → no length")
        for entry in entries.dropLast() {
            XCTAssertNotNil(entry.length?.meters, "\(entry.name) should have a length")
        }

        // Lengths are strictly descending across the present tees.
        let presentMeters = entries.dropLast().compactMap { $0.length?.meters }
        XCTAssertEqual(presentMeters, presentMeters.sorted(by: >), "descending by length")

        // Each present tee's figure equals HoleLength for that tee → aim → green.
        let aim = LatLon(lat: 58.3625, lon: 15.7080)
        let green = LatLon(lat: 58.3640, lon: 15.7080)
        let teeCoords: [String: LatLon] = [
            "Yellow": LatLon(lat: 58.3610, lon: 15.7080),
            "White":  LatLon(lat: 58.3605, lon: 15.7080),
            "Black":  LatLon(lat: 58.3595, lon: 15.7080),
            "Blue":   LatLon(lat: 58.3600, lon: 15.7080),
        ]
        for entry in entries.dropLast() {
            let expected = HoleLength.playingLength(
                tee: teeCoords[entry.name], aims: [aim], greenCenter: green
            )
            XCTAssertEqual(entry.length, expected, "\(entry.name) length matches HoleLength")
        }
    }

    func testTeeMenuActiveTeeLengthMatchesHeaderPlayingLength() {
        let model = OnCourseModel(furniture: makeMultiTeeFurniture(), defaults: defaults)
        model.selectTee(named: "Black")
        let active = try! XCTUnwrap(model.teeMenuEntries.first { $0.name == "Black" })
        // The menu's length for the active tee == the header's playingLength.
        XCTAssertEqual(active.length, model.playingLength)
    }

    func testTeeMenuLengthHonorsMovedTeeOverride() {
        let model = OnCourseModel(furniture: makeMultiTeeFurniture(), defaults: defaults)
        model.setGPSEnabled(false)
        model.selectTee(named: "Yellow")
        // Move Yellow far south → it becomes the longest, so it climbs to top.
        model.moveActiveTee(to: LatLon(lat: 58.3580, lon: 15.7080))
        let entries = model.teeMenuEntries
        XCTAssertEqual(entries.first?.name, "Yellow", "moved-far Yellow is now longest")
        XCTAssertEqual(entries.first?.length, model.playingLength, "override honored in menu length")
    }

    // MARK: - Zoom buttons (Feature B)

    func testZoomButtonsEmitTokenedCommandsWithoutTouchingCamera() {
        let model = makeModel()
        XCTAssertNil(model.zoomCommand, "no zoom command before any tap")
        let camBefore = model.cameraCommand

        model.zoomIn()
        let inCmd = try! XCTUnwrap(model.zoomCommand)
        XCTAssertGreaterThan(inCmd.delta, 0, "zoom in is a positive delta")
        XCTAssertEqual(inCmd.token, 1)
        XCTAssertEqual(model.cameraCommand, camBefore, "zoom must not bump the hole-fit camera")

        model.zoomOut()
        let outCmd = try! XCTUnwrap(model.zoomCommand)
        XCTAssertLessThan(outCmd.delta, 0, "zoom out is a negative delta")
        XCTAssertEqual(outCmd.token, 2, "token bumps each tap so identical deltas re-apply")
        XCTAssertEqual(model.cameraCommand, camBefore, "still no re-fit")
    }

    // MARK: - Feature: terrain plays-as for aim + layup ladder rungs

    /// A bag whose longest carry (220 m) falls well short of hole 1's ~445 m
    /// green, so the ladder surfaces layup rungs.
    private func layupClubs() -> [ClubRecord] {
        [
            ClubRecord(id: "dr", name: "Driver", carryM: 220, dispersionM: 25, sortOrder: 0),
            ClubRecord(id: "3w", name: "3 Wood", carryM: 200, dispersionM: 22, sortOrder: 1),
            ClubRecord(id: "5i", name: "5 Iron", carryM: 170, dispersionM: 18, sortOrder: 2),
            ClubRecord(id: "7i", name: "7 Iron", carryM: 150, dispersionM: 16, sortOrder: 3),
            ClubRecord(id: "pw", name: "PW",     carryM: 120, dispersionM: 14, sortOrder: 4),
        ]
    }

    /// Focus the first ladder rung of `kind` and return its banner advice.
    private func advice(
        _ model: OnCourseModel, kind: OnCourseModel.LadderRow.Kind
    ) -> OnCourseModel.TargetAdvice? {
        guard let row = model.ladderRows.first(where: { $0.kind == kind }),
              let pos = row.position else { return nil }
        model.focusMap(on: pos, ladderId: row.id)
        return model.selectedTargetAdvice
    }

    func testAimRungGetsPlaysAsFromTerrainSampleWhenElevationUnstored() async throws {
        // The fixture's aims carry no stored elevation. With a terrain sampler
        // injected, the sweep fills the offline-DEM elevation at the aim so its
        // rung shows plays-as, not just the actual distance.
        let model = makeModel()
        model.elevationSampler = { _ in 40 } // 30 m above the default tee (elev 10)

        // Before any sweep there is no cached sample → the rung stays actual.
        XCTAssertNil(try XCTUnwrap(advice(model, kind: .aim)).playsAsM,
                     "aim has no plays-as until the terrain sweep fills its elevation")

        await model.refreshLadderElevationsAwaiting()
        let after = try XCTUnwrap(advice(model, kind: .aim))
        XCTAssertNotNil(after.playsAsM, "aim rung plays-as after the terrain sample")
        XCTAssertEqual(after.elevationDeltaM, 30, "uphill: 40 − 10 m tee")
    }

    func testLayupRungGetsPlaysAsFromTerrainSample() async throws {
        // Layups are projected points on the shot line with no stored elevation;
        // the sweep samples the offline DEM at each landing point so they, too,
        // get plays-as.
        let model = makeModel()
        model.setClubs(layupClubs())
        model.elevationSampler = { _ in 40 }
        XCTAssertNotNil(model.ladderRows.first { $0.kind == .layup },
                        "green out of range → layup rungs present")

        await model.refreshLadderElevationsAwaiting()
        let layup = try XCTUnwrap(advice(model, kind: .layup))
        XCTAssertNotNil(layup.playsAsM, "layup rung plays-as after the terrain sample")
        XCTAssertEqual(layup.elevationDeltaM, 30, "uphill: 40 − 10 m tee")
    }

    func testSelectedLayupShowsCrosswindHoldOppositeTheDrift() throws {
        let model = makeModel()
        model.setGPSEnabled(false)
        model.setClubs(layupClubs())
        // Hole 1 plays approximately north. Wind FROM the west pushes the ball
        // shot-right/east, so the player must hold left of the proposed layup.
        model.setPlanWind(speedMps: 8, directionDeg: 270)

        let row = try XCTUnwrap(model.ladderRows.first { $0.kind == .layup })
        let target = try XCTUnwrap(row.position)
        model.focusMap(on: target, ladderId: row.id)
        let layup = try XCTUnwrap(model.selectedTargetAdvice)
        XCTAssertEqual(layup.windHoldSide, .left)
        XCTAssertGreaterThan(layup.windHoldM ?? 0, 3)

        let hold = try XCTUnwrap(model.selectedTargetWindHold)
        XCTAssertEqual(hold.side, .left)
        XCTAssertEqual(hold.meters, layup.windHoldM)
        XCTAssertEqual(hold.target, target)

        let origin = try XCTUnwrap(model.origin)
        let o = Sweref99TM.fromWGS84(origin)
        let a = Sweref99TM.fromWGS84(hold.aim)
        let t = Sweref99TM.fromWGS84(hold.target)
        let shotX = t.x - o.x, shotY = t.y - o.y
        let aimX = a.x - t.x, aimY = a.y - t.y
        // Positive 2-D cross product here is shot-left for compass geometry.
        XCTAssertGreaterThan(shotX * aimY - shotY * aimX, 0,
                             "the rose aim marker sits left of the target")
    }

    func testSelectedTargetHidesHoldWhenWindIsCalm() throws {
        let model = makeModel()
        model.setGPSEnabled(false)
        model.setClubs(layupClubs())

        let layup = try XCTUnwrap(advice(model, kind: .layup))
        XCTAssertNil(layup.windHoldM)
        XCTAssertNil(layup.windHoldSide)
        XCTAssertNil(model.selectedTargetWindHold)
    }

    func testCompetitionModeKeepsLadderRungsActualOnly() async throws {
        // DMD competition rule: distance only. Even with a terrain sample the
        // plays-as / elevation figures are gated off.
        let model = makeModel()
        model.competitionMode = true
        model.elevationSampler = { _ in 40 }
        await model.refreshLadderElevationsAwaiting()
        let aim = try XCTUnwrap(advice(model, kind: .aim))
        XCTAssertNil(aim.playsAsM, "competition mode: no plays-as")
        XCTAssertNil(aim.elevationDeltaM, "competition mode: no elevation delta")
    }

    func testHazardRungStaysActualOnlyEvenWithTerrainSampler() async throws {
        // Hazards are deliberately actual-only: their front/carry figures are
        // shot-line projections while `position` is the centroid (off-line for
        // side hazards), so a centroid plays-as would mismatch the rung.
        let model = makeModel()
        model.elevationSampler = { _ in 40 }
        model.setHazards([hazardBox(58.3620, 15.7090)]) // on hole 1's tee→green line
        XCTAssertNotNil(model.ladderRows.first { $0.kind == .hazard }, "hazard rung present")

        await model.refreshLadderElevationsAwaiting()
        let hazard = try XCTUnwrap(advice(model, kind: .hazard))
        XCTAssertNil(hazard.playsAsM, "hazard rung stays actual-only")
        XCTAssertNil(hazard.elevationDeltaM, "hazard rung stays actual-only")
    }

    // MARK: - Feature: sweep triggers + self-healing gate (bag loads late)

    func testBagLoadingAfterFirstFixPrimesLayupPlaysAs() async throws {
        // Reproduces the production ordering (CourseScreen): inject the sampler,
        // take the FIRST GPS fix while the bag is still empty (no layup rungs to
        // sample), THEN the cached bag lands. The late `setClubs` must force a
        // sweep so the freshly-created layup rungs get their terrain sample —
        // before the fix nothing re-swept when the bag loaded and a stationary
        // user's next fix was blocked by the move gate, so layups stayed
        // actual-only forever.
        let model = makeModel()
        model.elevationSampler = { _ in 40 }          // injected AFTER init (didSet primes)
        let fix = LatLon(lat: 58.3600, lon: 15.7100)  // ~ default tee, elev 10
        model.updateUserLocation(fix)                 // first fix, bag still empty

        XCTAssertNil(model.ladderRows.first { $0.kind == .layup },
                     "no layup rungs before the bag loads")

        model.setClubs(layupClubs())                  // bag lands late (real trigger)
        XCTAssertNotNil(model.ladderRows.first { $0.kind == .layup },
                        "bag loaded → layup rungs present")

        // Drain the fire-and-forget sweep setClubs kicked (same poll pattern as
        // testUserElevationComesFromSampler); no explicit awaiting-seam call, so
        // this only passes because setClubs itself triggered the sweep.
        var layup: OnCourseModel.TargetAdvice?
        for _ in 0..<100 {
            layup = advice(model, kind: .layup)
            if layup?.playsAsM != nil { break }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertNotNil(try XCTUnwrap(layup).playsAsM,
                        "late-loaded bag's layup rung gets plays-as from the sweep setClubs triggered")
    }

    func testSelfHealingGateResamplesMissingCellsAtUnchangedOrigin() async throws {
        // Clubs present, cache primed, then dropped with the origin UNCHANGED. A
        // plain (non-forced) refresh — the same gate a stationary user's next
        // GPS fix takes via updateUserLocation — must still refill the missing
        // cells instead of short-circuiting on the >5 m move gate.
        //
        // Browse mode so the origin is the default tee (stored elevation 10):
        // that isolates the layup-CELL self-healing from the orthogonal,
        // separately-sampled user-position elevation.
        let model = makeModel()
        model.setGPSEnabled(false) // origin = default tee (stationary, stored elev)
        model.setClubs(layupClubs())
        model.elevationSampler = { _ in 40 }
        await model.refreshLadderElevationsAwaiting()  // force-fill deterministically
        XCTAssertNotNil(try XCTUnwrap(advice(model, kind: .layup)).playsAsM,
                        "layup plays-as after the initial sweep")

        // Drop every cached sample; the sweep origin stays put.
        model.debugClearLadderElevationCache()
        XCTAssertNil(advice(model, kind: .layup)?.playsAsM,
                     "cache cleared → layup rung back to actual-only")

        // The non-forced refresh (force: false) is the exact gate the
        // updateUserLocation path uses for the SAME fix. It must self-heal:
        // missing cells re-arm the sweep even though the origin has not moved.
        let proceeded = await model.refreshLadderElevationsAwaiting(force: false)
        XCTAssertTrue(proceeded,
                      "missing cells re-arm the non-forced sweep at an unchanged origin")
        XCTAssertNotNil(try XCTUnwrap(advice(model, kind: .layup)).playsAsM,
                        "self-healing gate refilled the layup sample")
    }

    // MARK: - Feature: layups routed along the hole's play-line

    /// A synthetic dogleg hole built from exact SWEREF 99 TM coordinates: the
    /// tee→corner leg runs 200 m due north, the corner→green leg 200 m due east.
    /// The ROUTED length is 400 m; the STRAIGHT tee→green line is only ~283 m, so
    /// a layup placed along the route lands on a materially different point than
    /// the old straight-line placement would.
    private func doglegPlanar() -> (tee: Sweref99TM.Point, corner: Sweref99TM.Point, green: Sweref99TM.Point) {
        (Sweref99TM.Point(x: 500_000, y: 6_470_000),
         Sweref99TM.Point(x: 500_000, y: 6_470_200),
         Sweref99TM.Point(x: 500_200, y: 6_470_200))
    }

    private func makeDoglegModel() -> OnCourseModel {
        let p = doglegPlanar()
        let tee = Sweref99TM.toWGS84(p.tee)
        let corner = Sweref99TM.toWGS84(p.corner)
        let green = Sweref99TM.toWGS84(p.green)
        let course = CourseRecord(
            id: "dl", name: "Dogleg GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "d1", courseId: "dl", number: 1, par: 5, strokeIndex: 1)]
        let tees = [TeeRecord(id: "dt", holeId: "d1", name: "default", lat: tee.lat, lon: tee.lon, sortOrder: 0)]
        let greens = [GreenRecord(id: "dg", holeId: "d1", centerLat: green.lat, centerLon: green.lon)]
        let aims = [AimPointRecord(id: "da", holeId: "d1", sortOrder: 0, lat: corner.lat, lon: corner.lon, label: "Corner")]
        let manifest = TileManifestRecord(
            courseId: "dl", west: green.lon - 0.05, south: tee.lat - 0.05,
            east: green.lon + 0.05, north: green.lat + 0.05,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let furniture = CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: aims, manifest: manifest
        )
        let model = OnCourseModel(furniture: furniture, defaults: defaults)
        model.setGPSEnabled(false) // browse mode: origin is the tee, no GPS fix
        return model
    }

    /// Carries chosen so each leaves a DISTINCT approach club (100/150/250/300),
    /// and the longest (300 m) is short of the 400 m routed target so the green
    /// is out of range and the ladder surfaces layups.
    private func doglegBag() -> [ClubRecord] {
        [
            ClubRecord(id: "c300", name: "300", carryM: 300, dispersionM: 20, sortOrder: 0),
            ClubRecord(id: "c250", name: "250", carryM: 250, dispersionM: 20, sortOrder: 1),
            ClubRecord(id: "c150", name: "150", carryM: 150, dispersionM: 20, sortOrder: 2),
            ClubRecord(id: "c100", name: "100", carryM: 100, dispersionM: 20, sortOrder: 3),
        ]
    }

    func testLayupOnDoglegSitsOnSecondLegWithRoutedRemaining() throws {
        let model = makeDoglegModel()
        model.setClubs(doglegBag())

        let layups = model.ladderRows.filter { $0.kind == .layup }
        XCTAssertFalse(layups.isEmpty, "green out of routed range → layups present in browse mode")

        // A layup row's `meters` is its carry, so the 300 m club's rung is found
        // by carry. Its carry (300) exceeds leg 1 (200 m), so it lands 100 m up
        // the SECOND leg — 100 m east of the corner, still at the corner's full
        // 200 m northing. On the straight tee→green line 300 m would overshoot
        // the ~283 m green entirely; the routed placement proves the fix.
        let long = try XCTUnwrap(layups.first { $0.meters == 300 })
        let planar = Sweref99TM.fromWGS84(try XCTUnwrap(long.position))
        XCTAssertEqual(planar.x, 500_100, accuracy: 0.1, "100 m east along leg 2")
        XCTAssertEqual(planar.y, 6_470_200, accuracy: 0.1, "at the corner's northing (on leg 2)")
        // remainingM is genuine path-distance left: routed 400 − carry 300 = 100.
        XCTAssertEqual(long.remainingM, 100)
    }

    func testLayupLandingInWaterIsDroppedFreeingACapSlot() {
        let model = makeDoglegModel()
        model.setClubs(doglegBag())

        // Baseline (no surfaces → every landing lies as rough, all accepted):
        // four distinct approaches, cap 3 → the three longest carries.
        XCTAssertEqual(
            model.ladderRows.filter { $0.kind == .layup }.map(\.meters).sorted(by: >),
            [300, 250, 150]
        )

        // Drop a water box precisely over the 300-club landing (100 m east of the
        // corner, at 6 470 200 N). Only that rung's landing sits inside it.
        let c = Sweref99TM.Point(x: 500_100, y: 6_470_200)
        model.setSurfaces([FlatRing(points: [
            Vec2(x: c.x - 15, y: c.y - 15), Vec2(x: c.x + 15, y: c.y - 15),
            Vec2(x: c.x + 15, y: c.y + 15), Vec2(x: c.x - 15, y: c.y + 15),
        ], kind: "water")])

        // The 300 rung is dropped (penalty lie); filtering happens before the
        // cap, so the freed slot surfaces the 100-carry rung the cap had excluded,
        // and the cap is still respected (3 rungs).
        XCTAssertEqual(
            model.ladderRows.filter { $0.kind == .layup }.map(\.meters).sorted(by: >),
            [250, 150, 100]
        )
    }

    // MARK: - Feature: forward-route chainage filter (shared with TS)

    func testBrowsePastCornerCollapsesRouteToOriginGreen() throws {
        let model = makeDoglegModel()
        // 90 m short of the green along leg 2, nudged 10 m south off the leg:
        // laterally past the corner, < 100 m out. The corner's chainage (200 m)
        // is far behind the origin's projection (~310 m) — the route must not
        // double back through the elbow. (The drawn-line gate agrees at 90 m;
        // the layup-rung assertion below pins the UNGATED spine to the same
        // straight answer, which only the chainage filter provides.)
        let origin = Sweref99TM.toWGS84(Sweref99TM.Point(x: 500_110, y: 6_470_190))
        let green = Sweref99TM.toWGS84(doglegPlanar().green)
        model.setBrowseOrigin(origin)
        XCTAssertLessThan(Distance.planarMeters(origin, green), 100)
        XCTAssertEqual(model.overlays.distanceLine, [origin, green], "no corner detour")
        XCTAssertEqual(model.routeLegLabels.count, 1, "single leg: origin → green")

        // The layup spine follows the same collapsed route, so a rung's
        // remaining distance is measured straight at the green.
        model.setClubs([
            ClubRecord(id: "c60", name: "60", carryM: 60, dispersionM: 10, sortOrder: 0),
            ClubRecord(id: "c40", name: "40", carryM: 40, dispersionM: 10, sortOrder: 1),
        ])
        let straight = Distance.planarMeters(origin, green)
        let rung = try XCTUnwrap(model.ladderRows.first { $0.kind == .layup && $0.meters == 60 })
        XCTAssertEqual(rung.remainingM, Int((straight - 60).rounded()),
                       "routed target equals the straight distance once the corner is dropped")
    }

    func testBrowseMidFirstLegOffsetIntoRoughKeepsCorner() {
        let model = makeDoglegModel()
        // Early on leg 1, 40 m into the right rough, ~241 m from the green
        // (beyond the aim-routing threshold, so the drawn-line gate does not
        // apply): the projection lands on leg 1 at chainage ~20 m, the corner
        // (200 m) is still ahead → the routed line keeps the elbow.
        let origin = Sweref99TM.toWGS84(Sweref99TM.Point(x: 500_040, y: 6_470_020))
        let corner = Sweref99TM.toWGS84(doglegPlanar().corner)
        let green = Sweref99TM.toWGS84(doglegPlanar().green)
        model.setBrowseOrigin(origin)
        XCTAssertEqual(model.overlays.distanceLine, [origin, corner, green],
                       "off-line but not past: the corner stays on the route")
        XCTAssertEqual(model.routeLegLabels.count, 2)
    }

    func testBrowseOriginExactlyAtCornerDropsIt() {
        let model = makeDoglegModel()
        // Standing exactly on the corner aim: its chainage equals the
        // projection, which is not ahead by the 5 m margin → dropped. (The
        // drawn-line threshold gate — 200 m out — agrees; both mechanisms
        // yield the straight line.)
        let corner = Sweref99TM.toWGS84(doglegPlanar().corner)
        let green = Sweref99TM.toWGS84(doglegPlanar().green)
        model.setBrowseOrigin(corner)
        XCTAssertEqual(model.overlays.distanceLine, [corner, green])
        XCTAssertEqual(model.routeLegLabels.count, 1)
    }

    func testGPSNextAimAheadNilPastCornerEvenWhenRadiallyCloser() {
        let model = makeDoglegModel()
        model.setGPSEnabled(true)
        model.setAimRoutingThresholdMeters(100)
        // Past the elbow, pushed 100 m long into the trees: RADIALLY the user is
        // farther from the green (~215 m) than the corner (200 m), so the v1
        // radial rule kept the corner and doubled the line back through it. By
        // chainage (~205 m on leg 2) the corner is passed.
        let user = Sweref99TM.toWGS84(Sweref99TM.Point(x: 500_010, y: 6_470_300))
        let corner = Sweref99TM.toWGS84(doglegPlanar().corner)
        let green = Sweref99TM.toWGS84(doglegPlanar().green)
        model.updateUserLocation(user)
        XCTAssertGreaterThan(Distance.planarMeters(user, green), Distance.planarMeters(corner, green),
                             "precondition: the corner IS radially closer to the green")
        XCTAssertGreaterThan(Distance.planarMeters(user, green), model.aimRoutingThresholdMeters,
                             "precondition: beyond the routing threshold, so the gate is not what nils it")
        XCTAssertNil(model.nextAimAhead, "chainage filter: the corner is passed → route to the green")
        XCTAssertEqual(model.overlays.distanceLine, [user, green])
    }

    // MARK: - Feature: browse drawn-line gate (aim-routing threshold)

    /// The residual-kink geometry from the on-device report (and the goldens'
    /// `gatedCases`): tee at the planar origin, a near-collinear aim 21 m
    /// ahead of the 90-m-out browse point, green 90 m away. The aim is
    /// genuinely AHEAD by chainage — only the threshold gate straightens the
    /// line.
    private func gatedPlanar() -> (tee: Sweref99TM.Point, aim: Sweref99TM.Point, green: Sweref99TM.Point) {
        (Sweref99TM.Point(x: 500_000, y: 6_470_000),
         Sweref99TM.Point(x: 500_112, y: 6_470_191),
         Sweref99TM.Point(x: 500_150, y: 6_470_250))
    }

    private func makeGatedModel() -> OnCourseModel {
        let p = gatedPlanar()
        let tee = Sweref99TM.toWGS84(p.tee)
        let aim = Sweref99TM.toWGS84(p.aim)
        let green = Sweref99TM.toWGS84(p.green)
        let course = CourseRecord(
            id: "gt", name: "Gate GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [HoleRecord(id: "g1", courseId: "gt", number: 1, par: 4, strokeIndex: 1)]
        let tees = [TeeRecord(id: "gt1", holeId: "g1", name: "default", lat: tee.lat, lon: tee.lon, sortOrder: 0)]
        let greens = [GreenRecord(id: "gg", holeId: "g1", centerLat: green.lat, centerLon: green.lon)]
        let aims = [AimPointRecord(id: "ga", holeId: "g1", sortOrder: 0, lat: aim.lat, lon: aim.lon, label: "Kink")]
        let manifest = TileManifestRecord(
            courseId: "gt", west: green.lon - 0.05, south: tee.lat - 0.05,
            east: green.lon + 0.05, north: green.lat + 0.05,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        let furniture = CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: aims, manifest: manifest
        )
        let model = OnCourseModel(furniture: furniture, defaults: defaults)
        model.setGPSEnabled(false)
        return model
    }

    func testBrowseLineGatedStraightNearGreenWhileLadderKeepsAimRow() {
        let model = makeGatedModel()
        // 90 m from the green with the aim 21 m ahead (kept by chainage): the
        // next shot targets the GREEN, so the drawn line must not kink.
        let origin = Sweref99TM.toWGS84(Sweref99TM.Point(x: 500_096, y: 6_470_178))
        let green = Sweref99TM.toWGS84(gatedPlanar().green)
        model.setBrowseOrigin(origin)
        XCTAssertEqual(Distance.planarMeters(origin, green), 90, accuracy: 0.01)
        XCTAssertEqual(model.overlays.distanceLine, [origin, green], "within threshold → straight line")
        XCTAssertEqual(model.routeLegLabels.count, 1, "one leg: origin → green")
        // The gate is a LINE policy only — the ladder still lists the aim row.
        XCTAssertTrue(model.ladderRows.contains { $0.kind == .aim },
                      "the aim row survives the drawn-line gate")
    }

    func testBrowseLineRoutedThroughAimBeyondThreshold() {
        let model = makeGatedModel()
        // Default browse origin = the tee, ~292 m out (beyond the 230 m
        // threshold) → the chainage-filtered route applies, aim included.
        let p = gatedPlanar()
        let tee = Sweref99TM.toWGS84(p.tee)
        let aim = Sweref99TM.toWGS84(p.aim)
        let green = Sweref99TM.toWGS84(p.green)
        XCTAssertGreaterThan(Distance.planarMeters(tee, green), model.aimRoutingThresholdMeters)
        XCTAssertEqual(model.overlays.distanceLine, [tee, aim, green])
        XCTAssertEqual(model.routeLegLabels.count, 2)
    }

    func testBrowseLineRespectsLoweredThresholdOverride() {
        let model = makeGatedModel()
        // The user-persisted threshold, not the shared constant, gates the
        // browse line: lowered to 50 m, the 90-m-out origin routes through
        // the aim again.
        model.setAimRoutingThresholdMeters(50)
        let origin = Sweref99TM.toWGS84(Sweref99TM.Point(x: 500_096, y: 6_470_178))
        let aim = Sweref99TM.toWGS84(gatedPlanar().aim)
        let green = Sweref99TM.toWGS84(gatedPlanar().green)
        model.setBrowseOrigin(origin)
        XCTAssertEqual(model.overlays.distanceLine, [origin, aim, green],
                       "90 m out > lowered 50 m threshold → routed through the aim")
        XCTAssertEqual(model.routeLegLabels.count, 2)
    }

    func testLayupSpineStaysRoutedInsideTheGate() throws {
        let model = makeGatedModel()
        // 90 m out (drawn line gated straight) with a 40 m club: the green is
        // out of reach, so the layup spine must still follow the ROUTED line
        // (origin → aim → green ≈ 90.79 m), not the gated straight 90 m —
        // remaining = 90.79 − 40 → 51, where the straight line would give 50.
        let origin = Sweref99TM.toWGS84(Sweref99TM.Point(x: 500_096, y: 6_470_178))
        let green = Sweref99TM.toWGS84(gatedPlanar().green)
        model.setBrowseOrigin(origin)
        model.setClubs([ClubRecord(id: "c40", name: "40", carryM: 40, dispersionM: 10, sortOrder: 0)])
        XCTAssertEqual(model.overlays.distanceLine, [origin, green], "the LINE is gated straight")
        let rung = try XCTUnwrap(model.ladderRows.first { $0.kind == .layup && $0.meters == 40 })
        XCTAssertEqual(rung.remainingM, 51, "the SPINE stays routed through the aim (90.79 − 40)")
    }

    // MARK: - Feature: reactive-path memoisation (fingerprint-keyed)

    func testLadderRowsMemoHitAvoidsRebuild() {
        // Two consecutive reads with unchanged inputs return equal rows and the
        // second one does not recompute (the build counter stays flat).
        let model = makeModel()
        model.setClubs(layupClubs())
        let first = model.ladderRows
        let builds = model.ladderRowsBuildCount
        XCTAssertGreaterThan(builds, 0, "first read builds the ladder")
        let second = model.ladderRows
        let third = model.ladderRows
        XCTAssertEqual(model.ladderRowsBuildCount, builds, "unchanged inputs → cache hit, no rebuild")
        XCTAssertEqual(first, second)
        XCTAssertEqual(second, third)
    }

    func testHazardCarriesMemoHitAvoidsRebuild() {
        let model = makeModel()
        model.setHazards([hazardBox(58.3620, 15.7090)])
        let first = model.hazardCarries
        let builds = model.hazardCarriesBuildCount
        XCTAssertGreaterThan(builds, 0, "first read builds the carries")
        _ = model.hazardCarries
        _ = model.hazardCarries
        XCTAssertEqual(model.hazardCarriesBuildCount, builds, "unchanged inputs → cache hit, no rebuild")
        XCTAssertEqual(model.hazardCarries, first)
    }

    func testLadderMemoInvalidatesOnTeeChange() {
        let model = makeModel() // browse mode: origin = active tee
        let before = model.ladderRows.first { $0.kind == .green }?.meters
        let builds = model.ladderRowsBuildCount
        model.selectTee(named: "Blue") // farther tee → longer green distance
        let after = model.ladderRows.first { $0.kind == .green }?.meters
        XCTAssertGreaterThan(model.ladderRowsBuildCount, builds, "tee change invalidates the memo")
        XCTAssertNotNil(before); XCTAssertNotNil(after)
        XCTAssertNotEqual(before, after, "the ladder reflects the new tee origin")
    }

    func testLadderMemoInvalidatesOnClubsChange() {
        let model = makeModel()
        XCTAssertTrue(model.ladderRows.filter { $0.kind == .layup }.isEmpty, "no clubs → no layups")
        model.setClubs(layupClubs())
        XCTAssertFalse(model.ladderRows.filter { $0.kind == .layup }.isEmpty,
                       "loading the bag invalidates the memo → layup rungs appear")
    }

    func testLadderMemoInvalidatesOnPlanShotAdd() {
        let model = makeModel()
        XCTAssertTrue(model.ladderRows.filter { $0.kind == .plan }.isEmpty, "no plan → no plan rungs")
        model.enterTool(.plan)
        model.setAddingPlanShot(true)
        model.placePlanShot(at: LatLon(lat: 58.3618, lon: 15.7090))
        XCTAssertFalse(model.ladderRows.filter { $0.kind == .plan }.isEmpty,
                       "adding a plan shot invalidates the memo → a plan rung appears")
    }

    func testLadderMemoInvalidatesOnBrowseOriginSetAndReset() {
        let model = makeModel()
        model.setGPSEnabled(false)
        let teeGreen = model.ladderRows.first { $0.kind == .green }?.meters
        model.setBrowseOrigin(LatLon(lat: 58.3630, lon: 15.7085)) // partway up the hole
        let movedGreen = model.ladderRows.first { $0.kind == .green }?.meters
        XCTAssertNotEqual(teeGreen, movedGreen, "moving the browse origin invalidates the memo")
        model.resetBrowseOrigin()
        XCTAssertEqual(model.ladderRows.first { $0.kind == .green }?.meters, teeGreen,
                       "reset restores the tee-origin distances (memo re-invalidated)")
    }

    func testLadderMemoInvalidatesOnHoleChange() {
        let model = makeModel()
        let h1 = model.ladderRows.first { $0.kind == .green }?.meters
        model.nextHole()
        let h2 = model.ladderRows.first { $0.kind == .green }?.meters
        XCTAssertNotEqual(h1, h2, "changing holes invalidates the ladder memo")
    }

    func testLadderAndHazardMemoInvalidateOnHazardReinstall() {
        let model = makeModel()
        model.setHazards([hazardBox(58.3620, 15.7090)]) // on hole 1's line
        XCTAssertEqual(model.hazardCarries.count, 1)
        XCTAssertEqual(model.ladderRows.filter { $0.kind == .hazard }.count, 1)
        model.setHazards([]) // re-install (version bump) invalidates both memos
        XCTAssertEqual(model.hazardCarries.count, 0)
        XCTAssertTrue(model.ladderRows.filter { $0.kind == .hazard }.isEmpty,
                      "the ladder memo picks up the hazard re-install")
    }

    func testWindChangeReflectedInSelectedVisualization() {
        // Wind does not change the ladder rows (their distances are actual), but
        // the selected-target visualization keys on wind, so a wind edit must
        // surface a crosswind hold that was absent when calm.
        let model = makeModel()
        model.setGPSEnabled(false)
        model.setClubs(layupClubs())
        let row = model.ladderRows.first { $0.kind == .layup }!
        model.focusMap(on: row.position!, ladderId: row.id)
        XCTAssertNil(model.selectedTargetAdvice?.windHoldM, "calm → no hold")
        XCTAssertNil(model.selectedTargetWindHold)
        model.setPlanWind(speedMps: 8, directionDeg: 270) // from the west
        XCTAssertNotNil(model.selectedTargetAdvice?.windHoldM,
                        "wind change invalidates the visualization memo → a hold appears")
        XCTAssertNotNil(model.selectedTargetWindHold)
    }

    // MARK: - Feature: selectedLadderRow browse-target path skips the ladder

    func testBrowseTargetAdviceDoesNotBuildTheLadder() {
        // A browse-mode inspect must not build the (course-wide) ladder: the
        // advice comes straight from the tapped point. `selectedLadderRow`'s
        // browse branch now precedes `let rows = ladderRows`.
        let model = makeModel()
        model.setGPSEnabled(false)
        model.inspectBrowsePoint(LatLon(lat: 58.3626, lon: 15.7087))
        let builds = model.ladderRowsBuildCount // 0 — nothing has read the ladder
        let advice = model.selectedTargetAdvice
        XCTAssertEqual(advice?.title, "Selected point")
        XCTAssertEqual(model.ladderRowsBuildCount, builds,
                       "inspecting a tapped point must not build the ladder")
    }

    // MARK: - Feature: spatial pruning (bbox prefilter)

    func testFarHazardIsPrunedAndDoesNotAlterNearResult() {
        // A hazard far beyond every corridor must be pruned by the bbox
        // prefilter — proven by the near-hazard result being identical with and
        // without it present.
        let model = makeModel()
        let near = hazardBox(58.3620, 15.7090) // on hole 1's line
        model.setHazards([near])
        let onlyNear = model.hazardCarries
        XCTAssertEqual(onlyNear.count, 1)

        let far = hazardBox(58.9000, 16.5000) // tens of km away
        model.setHazards([near, far])
        XCTAssertEqual(model.hazardCarries, onlyNear,
                       "the far hazard is pruned; the near carry is unchanged")
    }

    func testOwnHazardWellOffLineSurvivesPrefilter() {
        // ~175 m off hole 1's line but tagged to it → inside the 400 m own
        // corridor, so the prefilter (pad = 400 + 40 + 50) must keep it.
        let model = makeModel()
        model.setHazards([hazardBox(58.3620, 15.7120)], holeIds: ["h1"])
        XCTAssertEqual(model.hazardCarries.count, 1, "an in-corridor own hazard is not pruned")
    }

    func testLieAtTopmostFirstPreservedUnderBBoxPruning() {
        // Both rings' bboxes contain the 300-club landing; topmost-first must
        // still decide (D23), and the bbox precheck must not reorder them.
        let model = makeDoglegModel()
        model.setClubs(doglegBag())
        let c = Sweref99TM.Point(x: 500_100, y: 6_470_200) // the 300-club landing
        func box(_ kind: String, half: Double) -> FlatRing {
            FlatRing(points: [
                Vec2(x: c.x - half, y: c.y - half), Vec2(x: c.x + half, y: c.y - half),
                Vec2(x: c.x + half, y: c.y + half), Vec2(x: c.x - half, y: c.y + half),
            ], kind: kind)
        }
        // Fairway (playable) TOPMOST over water beneath → fairway wins, rung kept.
        model.setSurfaces([box("fairway", half: 20), box("water", half: 30)])
        XCTAssertTrue(model.ladderRows.contains { $0.kind == .layup && $0.meters == 300 },
                      "topmost fairway wins over the water beneath → 300 rung kept")
        // Water TOPMOST over fairway → penalty lie wins → rung dropped.
        model.setSurfaces([box("water", half: 30), box("fairway", half: 20)])
        XCTAssertFalse(model.ladderRows.contains { $0.kind == .layup && $0.meters == 300 },
                       "water topmost → penalty lie → 300 rung dropped")
    }
}
