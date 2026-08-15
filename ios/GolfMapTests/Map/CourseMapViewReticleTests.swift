import MapLibre
import XCTest
@testable import GolfMap

/// Verifies the reticle plumbing (reticle browse RB2): the `isReticleEnabled`
/// flag through build/update, the fixed anchor (0.5 w, 0.30 h), and the
/// `onReticleMove` reporting driven through the real delegate callbacks on the
/// `MLNMapView` built by `CourseMapView`. Follows the
/// `CourseMapViewGestureTests` pattern: property + wiring assertions via
/// `buildMapView`/`applyUpdate` with a hand-made coordinator.
@MainActor
final class CourseMapViewReticleTests: XCTestCase {

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

    // MARK: - Anchor

    func testReticleAnchorIsCenteredAndThirtyPercentDown() {
        let anchor = CourseMapView.Coordinator.reticleAnchor(
            in: CGRect(x: 0, y: 0, width: 390, height: 700)
        )
        XCTAssertEqual(anchor.x, 195, accuracy: 0.001)
        XCTAssertEqual(anchor.y, 210, accuracy: 0.001, "30% down from the top")
    }

    // MARK: - Flag plumbing

    func testReticleDisabledByDefault() {
        let (config, features) = makeInputs()
        let view = CourseMapView(configuration: config, featuresGeoJSON: features)
        let coordinator = view.makeCoordinator()
        _ = view.buildMapView(coordinator: coordinator)
        XCTAssertFalse(coordinator.isReticleEnabled, "reticle off outside browse mode")
        XCTAssertNil(coordinator.onReticleMove)
    }

    func testReticleFlagFlippableViaApplyUpdate() {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features)
            .makeCoordinator()
        let onView = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            isReticleEnabled: true,
            onReticleMove: { _, _, _ in }
        )
        let mapView = onView.buildMapView(coordinator: coordinator)
        XCTAssertTrue(coordinator.isReticleEnabled)
        XCTAssertNotNil(coordinator.onReticleMove)

        // updateUIView core must flip the flag on the SAME coordinator.
        let offView = CourseMapView(configuration: config, featuresGeoJSON: features)
        offView.applyUpdate(to: mapView, coordinator: coordinator)
        XCTAssertFalse(coordinator.isReticleEnabled, "applyUpdate disables the reticle")
    }

    // MARK: - Reporting

    func testRegionIsChangingReportsAnchorPointAsPanning() throws {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features)
            .makeCoordinator()
        var received: [(point: LatLon, metersPerPoint: Double, state: ReticlePanState)] = []
        let view = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            isReticleEnabled: true,
            onReticleMove: { received.append(($0, $1, $2)) }
        )
        let mapView = view.buildMapView(coordinator: coordinator)
        mapView.setCenter(
            CLLocationCoordinate2D(latitude: 58.36, longitude: 15.71),
            zoomLevel: 15, animated: false
        )

        // setCenter itself fires the real delegate (regionDidChange), so
        // assert on the LAST event our explicit call produced, not a count.
        coordinator.mapViewRegionIsChanging(mapView)

        let last = try XCTUnwrap(received.last)
        XCTAssertEqual(last.state, .panning)
        // Reported point must be the unprojection of the fixed anchor.
        let anchor = CourseMapView.Coordinator.reticleAnchor(in: mapView.bounds)
        let expected = mapView.convert(anchor, toCoordinateFrom: mapView)
        XCTAssertEqual(last.point.lat, expected.latitude, accuracy: 1e-9)
        XCTAssertEqual(last.point.lon, expected.longitude, accuracy: 1e-9)
        // Scale rides along for the snap threshold's pt→m conversion.
        XCTAssertEqual(
            last.metersPerPoint,
            mapView.metersPerPoint(atLatitude: last.point.lat),
            accuracy: 1e-9
        )
        XCTAssertGreaterThan(last.metersPerPoint, 0)
        // Anchor is above the vertical center → its geo point is north of it.
        XCTAssertGreaterThan(last.point.lat, 58.36)
    }

    func testIdleEmittedExactlyOncePerSettle() {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features)
            .makeCoordinator()
        var states: [ReticlePanState] = []
        let view = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            isReticleEnabled: true,
            onReticleMove: { states.append($2) }
        )
        let mapView = view.buildMapView(coordinator: coordinator)

        coordinator.mapViewRegionIsChanging(mapView)
        coordinator.mapView(mapView, regionDidChangeAnimated: false)
        coordinator.mapViewDidBecomeIdle(mapView)
        coordinator.mapViewDidBecomeIdle(mapView) // repeat idle is dropped

        XCTAssertEqual(states, [.panning, .panning, .idle])

        // A new pan re-arms the idle emission.
        coordinator.mapViewRegionIsChanging(mapView)
        coordinator.mapViewDidBecomeIdle(mapView)
        XCTAssertEqual(states, [.panning, .panning, .idle, .panning, .idle])
    }

    func testNoReportsWhileDisabled() {
        let (config, features) = makeInputs()
        let coordinator = CourseMapView(configuration: config, featuresGeoJSON: features)
            .makeCoordinator()
        var count = 0
        let view = CourseMapView(
            configuration: config,
            featuresGeoJSON: features,
            isReticleEnabled: false,
            onReticleMove: { _, _, _ in count += 1 }
        )
        let mapView = view.buildMapView(coordinator: coordinator)

        coordinator.mapViewRegionIsChanging(mapView)
        coordinator.mapView(mapView, regionDidChangeAnimated: false)
        coordinator.mapViewDidBecomeIdle(mapView)

        XCTAssertEqual(count, 0, "disabled reticle never reports")
    }
}
