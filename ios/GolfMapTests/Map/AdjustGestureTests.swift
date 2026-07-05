import MapLibre
import XCTest
@testable import GolfMap

/// The Adjust-mode handle drag on the real `MLNMapView` built by
/// `CourseMapView`: recognizer wiring + delegate claiming, the screen-space
/// hit-test, and the drag state machine that disables the map's own
/// pan/zoom/rotate while a handle is grabbed — the fix for the reported
/// move-tee bug where the long-press fired simultaneously with MapLibre's
/// quick-zoom and moving the tee also zoomed the map. Real finger drags are
/// not scriptable here, so the tests drive the coordinator's state machine
/// (`beginHandleDrag`/`continueHandleDrag`/`endHandleDrag`) that the gesture
/// handler delegates to, and assert the gesture flags + zoom level directly.
@MainActor
final class AdjustGestureTests: XCTestCase {

    private let handleCoordinate = LatLon(lat: 58.36, lon: 15.71)

    private func makeInputs() -> (config: CourseMapConfiguration, features: Data) {
        let bounds = MapCoordinateBounds(west: 15.70, south: 58.35, east: 15.72, north: 58.37)
        let config = CourseMapConfiguration(
            bundleDirectory: FileManager.default.temporaryDirectory,
            orthoMinZoom: 14,
            orthoMaxZoom: 16,
            bounds: bounds,
            attribution: "test"
        )
        let features = Data(#"{"type":"FeatureCollection","features":[]}"#.utf8)
        return (config, features)
    }

    private func makeOverlays() -> MapOverlayState {
        MapOverlayState(adjustHandles: [
            AdjustHandle(id: "tee", kind: .tee, label: "T", position: handleCoordinate),
            AdjustHandle(
                id: "green", kind: .green, label: "G",
                position: LatLon(lat: 58.364, lon: 15.708)
            ),
        ])
    }

    /// Map view with the handle centered on screen at a fixed zoom.
    private func makeMapView(
        coordinator: CourseMapView.Coordinator,
        adjustEnabled: Bool = true
    ) -> MLNMapView {
        let (config, features) = makeInputs()
        let view = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            overlays: makeOverlays(),
            adjustEnabled: adjustEnabled
        )
        let mapView = view.buildMapView(coordinator: coordinator)
        mapView.setCenter(handleCoordinate.clCoordinate, zoomLevel: 16, animated: false)
        return mapView
    }

    private func makeCoordinator() -> CourseMapView.Coordinator {
        let (config, features) = makeInputs()
        return CourseMapView(configuration: config, featuresGeoJSON: features).makeCoordinator()
    }

    // MARK: - Recognizer wiring

    func testAdjustRecognizerAttachedShortPressAndDelegateClaimed() throws {
        let coordinator = makeCoordinator()
        let mapView = makeMapView(coordinator: coordinator, adjustEnabled: false)

        let recognizer = try XCTUnwrap(coordinator.adjustPressRecognizer)
        XCTAssertFalse(recognizer.isEnabled, "disabled outside adjust mode")
        XCTAssertTrue(
            mapView.gestureRecognizers?.contains { $0 === recognizer } ?? false,
            "attached to the map view"
        )
        XCTAssertEqual(recognizer.minimumPressDuration, 0.18, accuracy: 0.001, "short grab press")
        XCTAssertTrue(recognizer.delegate === coordinator, "coordinator claims the gesture")
    }

    func testApplyUpdateFlipsAdjustEnabled() {
        let coordinator = makeCoordinator()
        let mapView = makeMapView(coordinator: coordinator, adjustEnabled: false)
        let (config, features) = makeInputs()

        let onView = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            overlays: makeOverlays(),
            adjustEnabled: true,
            onHandleGrab: { _ in }
        )
        onView.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertEqual(coordinator.adjustPressRecognizer?.isEnabled, true)
        XCTAssertNotNil(coordinator.onHandleGrab)

        let offView = CourseMapView(configuration: config, featuresGeoJSON: features)
        offView.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertEqual(coordinator.adjustPressRecognizer?.isEnabled, false)
    }

    /// The delegate refuses simultaneous recognition outright — MapLibre's
    /// pan/pinch/quick-zoom can never run alongside a handle drag (the old
    /// move-tee long-press had no delegate, so quick-zoom fired with it).
    func testDelegateRefusesSimultaneousRecognitionWithMapGestures() throws {
        let coordinator = makeCoordinator()
        let mapView = makeMapView(coordinator: coordinator)
        let adjust = try XCTUnwrap(coordinator.adjustPressRecognizer)

        for other in mapView.gestureRecognizers ?? [] where other !== adjust {
            XCTAssertFalse(
                coordinator.gestureRecognizer(adjust, shouldRecognizeSimultaneouslyWith: other),
                "adjust drag must never recognize together with \(type(of: other))"
            )
        }
    }

    // MARK: - Hit-test

    func testNearestHandleWithinThresholdPicksClosest() {
        let coordinator = makeCoordinator()
        let mapView = makeMapView(coordinator: coordinator)
        let teePoint = mapView.convert(handleCoordinate.clCoordinate, toPointTo: mapView)

        // Dead-on and slightly off both hit.
        XCTAssertEqual(coordinator.nearestHandle(to: teePoint, in: mapView), "tee")
        XCTAssertEqual(
            coordinator.nearestHandle(
                to: CGPoint(x: teePoint.x + 30, y: teePoint.y - 20), in: mapView
            ),
            "tee",
            "hit within the 44 pt threshold"
        )
        // Far away misses.
        XCTAssertNil(
            coordinator.nearestHandle(
                to: CGPoint(x: teePoint.x + 200, y: teePoint.y + 200), in: mapView
            ),
            "outside the threshold no handle is grabbed"
        )
    }

    // MARK: - Drag state machine (the move+zoom bug fix)

    func testDragDisablesMapGesturesMovesHandleAndRestoresWithZoomUnchanged() throws {
        let coordinator = makeCoordinator()
        let mapView = makeMapView(coordinator: coordinator)

        var grabbed: [String] = []
        var moves: [(id: String, position: LatLon)] = []
        var dropped: [String] = []
        coordinator.onHandleGrab = { grabbed.append($0) }
        coordinator.onHandleMove = { moves.append(($0, $1)) }
        coordinator.onHandleDrop = { dropped.append($0) }

        let zoomBefore = mapView.zoomLevel
        let teePoint = mapView.convert(handleCoordinate.clCoordinate, toPointTo: mapView)

        // Grab: the map is LOCKED for the duration of the drag.
        XCTAssertTrue(coordinator.beginHandleDrag(at: teePoint, in: mapView))
        XCTAssertEqual(coordinator.draggedHandleID, "tee")
        XCTAssertEqual(grabbed, ["tee"])
        XCTAssertFalse(mapView.isScrollEnabled, "pan disabled while dragging")
        XCTAssertFalse(mapView.isZoomEnabled, "zoom (incl. quick-zoom) disabled while dragging")
        XCTAssertFalse(mapView.isRotateEnabled, "rotate disabled while dragging")

        // Drag frames: the touch point unprojects to the reported position.
        let dragPoint = CGPoint(x: teePoint.x + 40, y: teePoint.y - 60)
        coordinator.continueHandleDrag(at: dragPoint, in: mapView)
        let move = try XCTUnwrap(moves.last)
        XCTAssertEqual(move.id, "tee")
        let expected = mapView.convert(dragPoint, toCoordinateFrom: mapView)
        XCTAssertEqual(move.position.lat, expected.latitude, accuracy: 1e-9)
        XCTAssertEqual(move.position.lon, expected.longitude, accuracy: 1e-9)

        // Drop: gestures restored, drop reported, and the camera never moved —
        // the reported bug was the map zooming during a tee move.
        coordinator.endHandleDrag(in: mapView)
        XCTAssertNil(coordinator.draggedHandleID)
        XCTAssertEqual(dropped, ["tee"])
        XCTAssertTrue(mapView.isScrollEnabled)
        XCTAssertTrue(mapView.isZoomEnabled)
        XCTAssertTrue(mapView.isRotateEnabled)
        XCTAssertEqual(mapView.zoomLevel, zoomBefore, accuracy: 1e-9,
                       "zoom unchanged across the whole drag")
    }

    func testMissedPressLeavesMapGesturesAlone() {
        let coordinator = makeCoordinator()
        let mapView = makeMapView(coordinator: coordinator)

        var grabbed = false
        coordinator.onHandleGrab = { _ in grabbed = true }

        let teePoint = mapView.convert(handleCoordinate.clCoordinate, toPointTo: mapView)
        let far = CGPoint(x: teePoint.x + 300, y: teePoint.y + 300)
        XCTAssertFalse(coordinator.beginHandleDrag(at: far, in: mapView))
        XCTAssertNil(coordinator.draggedHandleID)
        XCTAssertFalse(grabbed)
        XCTAssertTrue(mapView.isScrollEnabled, "a miss never locks the map")
        XCTAssertTrue(mapView.isZoomEnabled)
        XCTAssertTrue(mapView.isRotateEnabled)

        // Move/end without a grab are inert.
        coordinator.continueHandleDrag(at: far, in: mapView)
        coordinator.endHandleDrag(in: mapView)
        XCTAssertTrue(mapView.isScrollEnabled)
    }

    // MARK: - Handle rendering (pure builders)

    func testAdjustHandleShapeCarriesKindAndLabelImage() throws {
        let shape = AdjustHandleRenderer.shape(makeOverlays().adjustHandles)
        let collection = try XCTUnwrap(shape as? MLNShapeCollectionFeature)
        let features = try XCTUnwrap(collection.shapes as? [MLNPointFeature])
        XCTAssertEqual(features.count, 2)
        XCTAssertEqual(features[0].attributes["kind"] as? String, "tee")
        XCTAssertEqual(
            features[0].attributes["labelImage"] as? String,
            AdjustHandleRenderer.imageName(label: "T")
        )
        XCTAssertEqual(features[1].attributes["kind"] as? String, "green")
        XCTAssertEqual(features[0].coordinate.latitude, handleCoordinate.lat, accuracy: 1e-9)
    }

    /// Adjust mode disables gesture zoom + rotate for the WHOLE mode (not just
    /// during a grab) so a missed handle can't fall through to MapLibre's
    /// quick-zoom — the "zooms out all the time" report. Pan stays on; the +/-
    /// buttons zoom imperatively regardless of `isZoomEnabled`.
    func testAdjustModeDisablesGestureZoomForWholeMode() {
        let coordinator = makeCoordinator()
        let (config, features) = makeInputs()
        let mapView = makeMapView(coordinator: coordinator, adjustEnabled: true)

        // Not dragging: entering adjust mode disables gesture zoom + rotate.
        let adjustView = CourseMapView(
            configuration: config, featuresGeoJSON: features,
            overlays: makeOverlays(), adjustEnabled: true
        )
        adjustView.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertNil(coordinator.draggedHandleID)
        XCTAssertFalse(mapView.isZoomEnabled)
        XCTAssertFalse(mapView.isRotateEnabled)
        XCTAssertTrue(mapView.isScrollEnabled) // pan stays for repositioning

        // Leaving adjust mode restores gesture zoom + rotate.
        let normalView = CourseMapView(
            configuration: config, featuresGeoJSON: features,
            overlays: makeOverlays(), adjustEnabled: false
        )
        normalView.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertTrue(mapView.isZoomEnabled)
        XCTAssertTrue(mapView.isRotateEnabled)
        XCTAssertTrue(mapView.isScrollEnabled)
    }

    func testAdjustHandleLabelImageRenders() {
        let image = AdjustHandleRenderer.labelImage(label: "A1")
        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertGreaterThan(image.size.height, 0)
        XCTAssertEqual(AdjustHandleRenderer.imageName(label: "A1"), "adjust-handle-label-A1")
    }

    func testStyleContainsAdjustHandleLayers() throws {
        let (config, features) = makeInputs()
        let style = try MapStyleBuilder.styleDictionary(
            configuration: config,
            featuresGeoJSON: features
        )
        let layers = try XCTUnwrap(style["layers"] as? [[String: Any]])
        let ids = layers.compactMap { $0["id"] as? String }
        // Topmost: handles must stay grabbable over every other overlay.
        XCTAssertEqual(ids.suffix(2), [
            MapStyleIDs.adjustHandlesCircleLayer,
            MapStyleIDs.adjustHandlesLabelLayer,
        ])
        let circle = try XCTUnwrap(layers.first { $0["id"] as? String == MapStyleIDs.adjustHandlesCircleLayer })
        let paint = try XCTUnwrap(circle["paint"] as? [String: Any])
        XCTAssertEqual(paint["circle-radius"] as? Double, MapStyleBuilder.adjustHandleRadius)
        let colorExpr = try XCTUnwrap(paint["circle-color"] as? [Any])
        let strings = colorExpr.compactMap { $0 as? String }
        XCTAssertTrue(strings.contains("tee"))
        XCTAssertTrue(strings.contains("aim"))
        XCTAssertTrue(strings.contains("green"))
    }
}
