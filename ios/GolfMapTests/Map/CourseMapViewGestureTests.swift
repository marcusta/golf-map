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
}
