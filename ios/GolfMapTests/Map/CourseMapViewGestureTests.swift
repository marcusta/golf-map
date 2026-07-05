import MapLibre
import XCTest
@testable import GolfMap

/// Verifies the freeform-gesture flags (feature 1 pan/zoom fix) and the
/// browse-mode long-press → move-tee plumbing (feature 4) on the real
/// `MLNMapView` built by `CourseMapView`. Interactive pinch/drag can't be
/// scripted here — these are property + wiring assertions; the pixel/
/// interaction check is covered by the on-simulator live-verify pass. Drives
/// `buildMapView`/`applyUpdate` directly (SwiftUI's `Context` has no public
/// initializer).
@MainActor
final class CourseMapViewGestureTests: XCTestCase {

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

    func testFreeformGesturesAreEnabled() {
        let (config, features) = makeInputs()
        let view = CourseMapView(configuration: config, featuresGeoJSON: features)
        let mapView = view.buildMapView(coordinator: view.makeCoordinator())

        XCTAssertTrue(mapView.isZoomEnabled, "pinch-zoom must be enabled")
        XCTAssertTrue(mapView.isScrollEnabled, "pan must be enabled")
        XCTAssertTrue(mapView.isRotateEnabled, "rotate must be enabled")
        XCTAssertFalse(mapView.isPitchEnabled, "pitch intentionally off for top-down course view")
    }

    func testLongPressDisabledOutsideBrowseMode() {
        let (config, features) = makeInputs()
        let view = CourseMapView(configuration: config, featuresGeoJSON: features)
        let coordinator = view.makeCoordinator()
        let mapView = view.buildMapView(coordinator: coordinator)
        // The move-tee recognizer is the one the coordinator holds (MapLibre
        // installs its own long-press recognizers too, which we don't touch).
        let recognizer = try? XCTUnwrap(coordinator.longPressRecognizer)
        XCTAssertEqual(recognizer?.isEnabled, false, "long-press disabled outside browse mode")
        XCTAssertTrue(
            mapView.gestureRecognizers?.contains { $0 === coordinator.longPressRecognizer } ?? false,
            "our recognizer is attached to the map view"
        )
    }

    func testLongPressEnabledInBrowseModeAndFlippable() {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features).makeCoordinator()

        let onView = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            longPressEnabled: true,
            onLongPress: { _ in }
        )
        let mapView = onView.buildMapView(coordinator: coordinator)
        XCTAssertEqual(coordinator.longPressRecognizer?.isEnabled, true, "long-press enabled in browse mode")

        // updateUIView core must flip the flag on the SAME coordinator without
        // rebuilding the view.
        let offView = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            longPressEnabled: false
        )
        offView.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertEqual(coordinator.longPressRecognizer?.isEnabled, false, "applyUpdate disables the recognizer")
    }

    // MARK: - Zoom command (Feature B: +/- buttons)

    func testApplyZoomBumpsZoomLevelRelativeToCurrent() {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features).makeCoordinator()
        let mapView = CourseMapView(configuration: config, featuresGeoJSON: features)
            .buildMapView(coordinator: coordinator)
        mapView.setCenter(CLLocationCoordinate2D(latitude: 58.36, longitude: 15.71), zoomLevel: 14, animated: false)

        CourseMapView.Coordinator.applyZoom(MapZoomCommand(delta: 1, animated: false), to: mapView)
        XCTAssertEqual(mapView.zoomLevel, 15, accuracy: 0.01, "zoom in by ~1 level")

        CourseMapView.Coordinator.applyZoom(MapZoomCommand(delta: -2, animated: false), to: mapView)
        XCTAssertEqual(mapView.zoomLevel, 13, accuracy: 0.01, "zoom out by 2 levels")
    }

    func testApplyZoomClampsToMapLimits() {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features).makeCoordinator()
        let mapView = CourseMapView(configuration: config, featuresGeoJSON: features)
            .buildMapView(coordinator: coordinator)
        mapView.setCenter(CLLocationCoordinate2D(latitude: 58.36, longitude: 15.71), zoomLevel: 14, animated: false)

        CourseMapView.Coordinator.applyZoom(MapZoomCommand(delta: 999, animated: false), to: mapView)
        XCTAssertLessThanOrEqual(mapView.zoomLevel, mapView.maximumZoomLevel + 0.01, "clamped to max")
    }

    /// A zoom command applies on a token change but a *repeated* updateUIView
    /// with the same command (e.g. a per-GPS-fix pass) does not re-fire — proven
    /// by the coordinator's lastZoomCommand baseline.
    func testZoomCommandOnlyAppliesOnTokenChange() {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features).makeCoordinator()

        // Build with no zoom → baseline nil.
        let mapView = CourseMapView(configuration: config, featuresGeoJSON: features)
            .buildMapView(coordinator: coordinator)
        mapView.setCenter(CLLocationCoordinate2D(latitude: 58.36, longitude: 15.71), zoomLevel: 14, animated: false)
        XCTAssertNil(coordinator.lastZoomCommand)

        let zoom = MapZoomCommand(delta: 1, animated: false, token: 1)
        let view = CourseMapView(configuration: config, featuresGeoJSON: features, zoom: zoom)
        view.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertEqual(coordinator.lastZoomCommand, zoom, "first token-change applies")
        let afterFirst = mapView.zoomLevel
        XCTAssertEqual(afterFirst, 15, accuracy: 0.01)

        // Same command again (simulating a per-GPS-fix updateUIView) → no change.
        view.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertEqual(mapView.zoomLevel, afterFirst, accuracy: 0.01, "identical command does not re-fire")
    }
}
