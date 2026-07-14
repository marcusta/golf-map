import XCTest
@testable import GolfMap

/// Adjust mode on `OnCourseModel`: the aim-point + green-center override
/// storage/accessors (extending the tee-override pattern), the drag state
/// machine (live in-memory moves, persist on drop), per-hole reset across all
/// three override types, and the `.adjust` tool-mode transitions.
@MainActor
final class AdjustModeTests: XCTestCase {

    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "AdjustModeTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        super.tearDown()
    }

    // MARK: - Fixture

    /// Two holes; hole 1 has a full green (F/C/B + elevation) and two aim
    /// points, hole 2 a center-only green and one aim point (cross-hole
    /// isolation checks).
    private func makeFurniture() -> CourseFurniture {
        let course = CourseRecord(
            id: "course-1", name: "Testville GC", status: "published",
            revision: 1, downloadedRevision: 1, updatedAt: "2026-01-01T00:00:00Z",
            bundleState: .complete
        )
        let holes = [
            HoleRecord(id: "h1", courseId: "course-1", number: 1, par: 5, strokeIndex: 3),
            HoleRecord(id: "h2", courseId: "course-1", number: 2, par: 4, strokeIndex: 9),
        ]
        let tees = [
            TeeRecord(id: "t1", holeId: "h1", name: "default", lat: 58.3600, lon: 15.7100, elevation: 10, sortOrder: 0),
            TeeRecord(id: "t2", holeId: "h2", name: "default", lat: 58.3660, lon: 15.7060, sortOrder: 0),
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
        ]
        let aims = [
            AimPointRecord(id: "a1", holeId: "h1", sortOrder: 0, lat: 58.3615, lon: 15.7092, label: nil),
            AimPointRecord(id: "a2", holeId: "h1", sortOrder: 1, lat: 58.3625, lon: 15.7088, label: "Layup"),
            AimPointRecord(id: "b1", holeId: "h2", sortOrder: 0, lat: 58.3665, lon: 15.7055, label: nil),
        ]
        let manifest = TileManifestRecord(
            courseId: "course-1", west: 15.70, south: 58.35, east: 15.72, north: 58.37,
            orthoMinZoom: 14, orthoMaxZoom: 20, terrainMinZoom: 12, terrainMaxZoom: 17,
            elevMin: 0, elevMax: 100, generatedAt: "2026-01-01T00:00:00Z", versionParam: "v1"
        )
        return CourseFurniture(
            course: course, holes: holes, tees: tees, greens: greens,
            pins: [], aimPoints: aims, manifest: manifest
        )
    }

    private func makeModel() -> OnCourseModel {
        let model = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        model.setGPSEnabled(false) // browse mode: origin = tee, deterministic
        return model
    }

    private let movedAim = LatLon(lat: 58.3618, lon: 15.7070)
    private let movedGreen = LatLon(lat: 58.3645, lon: 15.7090)

    // MARK: - Override storage + accessors

    func testAimAndGreenOverridesPersistUnderExpectedKeysAndReload() throws {
        let model = makeModel()
        model.setHandleOverride(id: OnCourseModel.aimHandleID("a1"), to: movedAim)
        model.setHandleOverride(id: OnCourseModel.greenHandleID, to: movedGreen)

        // Documented key format, "lat,lon" payload — same scheme as the tee.
        XCTAssertEqual(
            defaults.string(forKey: "onCourse.aimOverride.course-1.h1.a1"),
            "\(movedAim.lat),\(movedAim.lon)"
        )
        XCTAssertEqual(
            defaults.string(forKey: "onCourse.greenOverride.course-1.h1"),
            "\(movedGreen.lat),\(movedGreen.lon)"
        )

        // Accessors on the live model.
        let hole = try XCTUnwrap(model.currentHole)
        let aim = try XCTUnwrap(hole.aimPoints.first { $0.id == "a1" })
        XCTAssertEqual(model.aimPosition(for: aim, in: hole), movedAim)
        XCTAssertEqual(model.greenCenterPosition(for: hole), movedGreen)

        // A fresh model over the same defaults loads the overrides.
        let reloaded = OnCourseModel(furniture: makeFurniture(), defaults: defaults)
        let reloadedHole = try XCTUnwrap(reloaded.currentHole)
        let reloadedAim = try XCTUnwrap(reloadedHole.aimPoints.first { $0.id == "a1" })
        XCTAssertEqual(reloaded.aimPosition(for: reloadedAim, in: reloadedHole), movedAim)
        XCTAssertEqual(reloaded.greenCenterPosition(for: reloadedHole), movedGreen)
    }

    func testOverridesFlowThroughRouteDistancesLabelsAndLength() throws {
        let model = makeModel()
        let before = model.routeLegs
        let lengthBefore = try XCTUnwrap(model.playingLength?.meters)

        model.setHandleOverride(id: OnCourseModel.aimHandleID("a2"), to: movedAim)
        model.setHandleOverride(id: OnCourseModel.greenHandleID, to: movedGreen)

        // Route vertices: tee, a1, MOVED a2, MOVED green center.
        let route = model.holeRoute
        XCTAssertEqual(route.count, 4)
        XCTAssertEqual(route[2], movedAim)
        XCTAssertEqual(route[3], movedGreen)

        // Leg distances recompute from the moved vertices (planar EPSG:3006,
        // same math the card uses).
        let legs = model.routeLegs
        XCTAssertNotEqual(legs, before)
        XCTAssertEqual(
            legs[2],
            Int(Distance.planarMeters(movedAim, movedGreen).rounded()),
            "final leg = moved a2 → moved green"
        )

        // Distance card: browse origin is the tee → center distance tracks
        // the moved green center.
        XCTAssertEqual(
            model.distances?.center,
            Int(Distance.planarMeters(LatLon(lat: 58.3600, lon: 15.7100), movedGreen).rounded())
        )

        // Immersive route-leg labels sit on the moved legs.
        let labels = model.routeLegLabels
        XCTAssertEqual(labels.count, 3)
        XCTAssertEqual(labels.map(\.meters), legs, "on-map figures match the card legs")

        // Playing length (header + tee menu) recomputes.
        XCTAssertNotEqual(model.playingLength?.meters, lengthBefore)
        XCTAssertEqual(model.teeMenuEntries.first?.length?.meters, model.playingLength?.meters)

        // Camera bounds include the moved green (north of everything stored).
        let bounds = try XCTUnwrap(model.holeBounds)
        XCTAssertEqual(bounds.north, movedGreen.lat, accuracy: 1e-9)
    }

    func testGreenOverrideMovesCenterOnlyAndDegradesElevation() throws {
        let model = makeModel()
        let targetsBefore = model.targets
        XCTAssertEqual(targetsBefore.greenElevation, 25, "stored elevation before the move")

        model.setHandleOverride(id: OnCourseModel.greenHandleID, to: movedGreen)
        let targets = model.targets

        XCTAssertEqual(targets.greenCenter, movedGreen)
        XCTAssertEqual(targets.greenFront, targetsBefore.greenFront, "front marker not moved")
        XCTAssertEqual(targets.greenBack, targetsBefore.greenBack, "back marker not moved")
        // The stored elevation belongs to the original center; with no terrain
        // sampler the moved center has no elevation → plays-like degrades.
        XCTAssertNil(targets.greenElevation)
        XCTAssertNil(model.distances?.playsLikeCenter)
        // Bearing follows the moved center.
        XCTAssertEqual(
            model.holeBearing,
            Distance.bearingDegrees(LatLon(lat: 58.3600, lon: 15.7100), movedGreen),
            accuracy: 1e-9
        )
    }

    func testMovedAimDropsItsStoredElevation() throws {
        let model = makeModel()
        model.setHandleOverride(id: OnCourseModel.aimHandleID("a1"), to: movedAim)
        let aims = model.targets.aimPoints
        XCTAssertEqual(aims[0].position, movedAim)
        XCTAssertNil(aims[0].elevation, "stored elevation belongs to the original position")
    }

    // MARK: - Handles

    func testAdjustHandlesLabelsKindsAndOverriddenPositions() throws {
        let model = makeModel()
        model.setHandleOverride(id: OnCourseModel.aimHandleID("a1"), to: movedAim)

        let handles = model.adjustHandles
        XCTAssertEqual(handles.map(\.id), ["tee", "aim.a1", "aim.a2", "green"])
        XCTAssertEqual(handles.map(\.label), ["T", "A1", "A2", "G"])
        XCTAssertEqual(handles.map(\.kind), [.tee, .aim, .aim, .green])
        XCTAssertEqual(handles[1].position, movedAim, "handle sits at the override")
        XCTAssertEqual(handles[3].position, LatLon(lat: 58.3640, lon: 15.7080))
    }

    // MARK: - Drag state machine

    func testDragMovesLiveButPersistsOnlyOnDropAndNeverTouchesCamera() throws {
        let model = makeModel()
        model.enterTool(.adjust)
        let cameraToken = model.cameraToken

        model.beginHandleDrag(id: OnCourseModel.greenHandleID)
        XCTAssertEqual(model.draggingHandleID, OnCourseModel.greenHandleID)

        model.moveHandle(id: OnCourseModel.greenHandleID, to: movedGreen)
        // Live: every derived output already sees the move…
        XCTAssertEqual(model.targets.greenCenter, movedGreen)
        XCTAssertEqual(model.holeRoute.last, movedGreen)
        // …but nothing is persisted yet.
        XCTAssertNil(defaults.string(forKey: "onCourse.greenOverride.course-1.h1"))

        model.endHandleDrag()
        XCTAssertNil(model.draggingHandleID)
        XCTAssertEqual(
            defaults.string(forKey: "onCourse.greenOverride.course-1.h1"),
            "\(movedGreen.lat),\(movedGreen.lon)"
        )
        // The whole grab→move→drop cycle must never re-fit the camera — the
        // map holds still under the finger.
        XCTAssertEqual(model.cameraToken, cameraToken)
    }

    func testBeginDragRequiresAdjustModeAndKnownHandle() {
        let model = makeModel()
        model.beginHandleDrag(id: OnCourseModel.teeHandleID) // not in adjust mode
        XCTAssertNil(model.draggingHandleID)

        model.enterTool(.adjust)
        model.beginHandleDrag(id: "aim.nonexistent")
        XCTAssertNil(model.draggingHandleID)
        model.beginHandleDrag(id: OnCourseModel.teeHandleID)
        XCTAssertEqual(model.draggingHandleID, OnCourseModel.teeHandleID)
    }

    // MARK: - Overridden reporting + per-hole reset

    func testOverriddenHandleIDsAndResetClearsAllThreeTypes() throws {
        let model = makeModel()
        XCTAssertFalse(model.currentHoleHasAdjustments)
        XCTAssertTrue(model.overriddenHandleIDs.isEmpty)

        let movedTee = LatLon(lat: 58.3598, lon: 15.7105)
        model.setHandleOverride(id: OnCourseModel.teeHandleID, to: movedTee)
        model.setHandleOverride(id: OnCourseModel.aimHandleID("a1"), to: movedAim)
        model.setHandleOverride(id: OnCourseModel.greenHandleID, to: movedGreen)

        // Also move something on hole 2 to prove reset is per-hole.
        model.nextHole()
        model.setHandleOverride(id: OnCourseModel.aimHandleID("b1"), to: LatLon(lat: 58.3664, lon: 15.7056))
        model.previousHole()

        XCTAssertEqual(model.overriddenHandleIDs, ["tee", "aim.a1", "green"])
        XCTAssertTrue(model.currentHoleHasAdjustments)

        model.resetCurrentHoleAdjustments()

        XCTAssertTrue(model.overriddenHandleIDs.isEmpty)
        XCTAssertFalse(model.currentHoleHasAdjustments)
        XCTAssertNil(defaults.string(forKey: "onCourse.teeOverride.course-1.h1.default"))
        XCTAssertNil(defaults.string(forKey: "onCourse.aimOverride.course-1.h1.a1"))
        XCTAssertNil(defaults.string(forKey: "onCourse.greenOverride.course-1.h1"))

        // Positions back to stored furniture.
        let hole = try XCTUnwrap(model.currentHole)
        XCTAssertEqual(model.teePosition(for: hole), LatLon(lat: 58.3600, lon: 15.7100))
        XCTAssertEqual(model.greenCenterPosition(for: hole), LatLon(lat: 58.3640, lon: 15.7080))
        XCTAssertEqual(model.targets.greenElevation, 25, "stored green elevation restored")

        // Hole 2's override survives (reset is per-hole)…
        model.nextHole()
        XCTAssertEqual(model.overriddenHandleIDs, ["aim.b1"])
        // …and persists.
        XCTAssertNotNil(defaults.string(forKey: "onCourse.aimOverride.course-1.h2.b1"))
    }

    // MARK: - Tool-mode transitions

    /// Entering Adjust with `refitCamera: false` (the screen's actual call)
    /// preserves the user's current zoom/pan — no camera-token bump, so
    /// `cameraCommand` is unchanged and never re-applied — and exiting doesn't
    /// snap back either. This is the fix for "tapping Adjust zooms me out".
    func testAdjustNoRefitPreservesCameraOnEnterAndExit() {
        let model = makeModel()
        let before = model.cameraCommand

        model.enterTool(.adjust, refitCamera: false)
        XCTAssertEqual(model.toolMode, .adjust)
        XCTAssertEqual(model.cameraCommand, before, "entering adjust must not move the camera")

        model.exitTool()
        XCTAssertEqual(model.cameraCommand, before, "exiting adjust must not move the camera")

        // Green view still re-frames (token bumps → command changes).
        let greenBounds = MapCoordinateBounds(west: 15.7075, south: 58.3637, east: 15.7085, north: 58.3643)
        model.enterTool(.greenView, focus: .bounds(greenBounds))
        XCTAssertNotEqual(model.cameraCommand, before, "green view still zooms to the green")
    }

    /// No button that isn't a deliberate re-frame may move the camera: the
    /// GPS/Browse toggle, a tee move, and Reset hole all change the hole bounds
    /// but must NOT bump the camera token (the map gates re-application on the
    /// token, so an unchanged token = the view stays). Recenter is the
    /// intentional exception.
    func testFurnitureEditsAndGPSToggleDoNotBumpTheCameraToken() {
        let model = makeModel()
        let token0 = model.cameraToken

        model.toggleGPS()
        XCTAssertEqual(model.cameraToken, token0, "GPS/Browse toggle must not re-frame")

        model.moveActiveTee(to: LatLon(lat: 58.3605, lon: 15.7092))
        XCTAssertEqual(model.cameraToken, token0, "moving a tee must not re-frame")

        model.resetCurrentHoleAdjustments()
        XCTAssertEqual(model.cameraToken, token0, "Reset hole must not re-frame")

        model.recenter()
        XCTAssertNotEqual(model.cameraToken, token0, "recenter is the deliberate re-frame")
    }

    /// Green view zooms to the green, then exiting returns to the exact view
    /// the user had before entering — not a hole re-fit.
    func testGreenViewRestoresPreEntryCameraOnExit() throws {
        let model = makeModel()
        let preEntry = LatLon(lat: 58.3610, lon: 15.7089)
        model.noteMapCamera(center: preEntry, zoom: 18.5, bearing: 42)

        let greenBounds = MapCoordinateBounds(west: 15.7075, south: 58.3637, east: 15.7085, north: 58.3643)
        model.enterTool(.greenView, focus: .bounds(greenBounds))
        guard case .bounds = model.cameraCommand?.target else {
            return XCTFail("green view fits the green bounds")
        }

        // The map settles on the green (a new observed camera) — must not change
        // where exit returns to.
        model.noteMapCamera(center: LatLon(lat: 58.3640, lon: 15.7080), zoom: 20, bearing: 42)

        model.exitTool()
        XCTAssertEqual(model.cameraCommand?.target, .center(preEntry, zoom: 18.5))
        XCTAssertEqual(model.cameraCommand?.bearing ?? 0, 42, accuracy: 1e-9)

        // A deliberate re-frame afterwards clears the restore.
        model.recenter()
        guard case .bounds = model.cameraCommand?.target else {
            return XCTFail("recenter re-fits the hole bounds")
        }
    }

    func testAdjustEntersAndExitsMutuallyExclusiveWithOtherTools() throws {
        let model = makeModel()
        let greenBounds = MapCoordinateBounds(west: 15.7075, south: 58.3637, east: 15.7085, north: 58.3643)

        model.enterTool(.greenView, focus: .bounds(greenBounds))
        model.enterTool(.adjust)
        XCTAssertEqual(model.toolMode, .adjust, "entering adjust exits green view")
        // No focus bounds: adjust keeps the standard hole framing.
        XCTAssertEqual(model.cameraCommand?.padding, 70)
        XCTAssertEqual(model.cameraCommand?.target, .bounds(try XCTUnwrap(model.holeBounds)))

        model.enterTool(.measure)
        XCTAssertEqual(model.toolMode, .measure, "entering measure exits adjust")

        model.enterTool(.adjust)
        model.exitTool()
        XCTAssertEqual(model.toolMode, .none)
    }

    func testHoleNavigationDismissesAdjustAndAbandonsDragUncommitted() {
        let model = makeModel()
        model.enterTool(.adjust)
        model.beginHandleDrag(id: OnCourseModel.greenHandleID)
        model.moveHandle(id: OnCourseModel.greenHandleID, to: movedGreen)

        model.nextHole()
        XCTAssertEqual(model.toolMode, .none, "hole navigation auto-dismisses adjust")
        XCTAssertNil(model.draggingHandleID)
        XCTAssertNil(
            defaults.string(forKey: "onCourse.greenOverride.course-1.h1"),
            "abandoned drag is not persisted"
        )
    }

    func testExitToolAbandonsInFlightDrag() {
        let model = makeModel()
        model.enterTool(.adjust)
        model.beginHandleDrag(id: OnCourseModel.teeHandleID)
        model.exitTool()
        XCTAssertNil(model.draggingHandleID)
    }
}
