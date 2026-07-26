import MapLibre
import XCTest
@testable import GolfMap

final class MapOverlayShapesTests: XCTestCase {

    func testDistanceLineWithTwoPointsBuildsPolyline() throws {
        let points = [LatLon(lat: 58.357, lon: 15.722), LatLon(lat: 58.358, lon: 15.724)]
        let shape = MapOverlayShapes.distanceLineShape(points)
        let polyline = try XCTUnwrap(shape as? MLNPolylineFeature)
        XCTAssertEqual(polyline.pointCount, 2)

        var coordinates = [CLLocationCoordinate2D](
            repeating: kCLLocationCoordinate2DInvalid,
            count: Int(polyline.pointCount)
        )
        polyline.getCoordinates(&coordinates, range: NSRange(location: 0, length: 2))
        XCTAssertEqual(coordinates[0].latitude, 58.357, accuracy: 1e-9)
        XCTAssertEqual(coordinates[0].longitude, 15.722, accuracy: 1e-9)
        XCTAssertEqual(coordinates[1].latitude, 58.358, accuracy: 1e-9)
        XCTAssertEqual(coordinates[1].longitude, 15.724, accuracy: 1e-9)
    }

    func testDistanceLineHiddenBelowTwoPoints() throws {
        for points in [[], [LatLon(lat: 58.357, lon: 15.722)]] {
            let shape = MapOverlayShapes.distanceLineShape(points)
            let collection = try XCTUnwrap(shape as? MLNShapeCollectionFeature)
            XCTAssertEqual(collection.shapes.count, 0)
        }
    }

    func testTargetsBecomePointFeaturesWithKindAttribute() throws {
        let targets = [
            TargetMarker(kind: .front, position: LatLon(lat: 58.1, lon: 15.1)),
            TargetMarker(kind: .pin, position: LatLon(lat: 58.2, lon: 15.2)),
        ]
        let shape = MapOverlayShapes.targetsShape(targets)
        let collection = try XCTUnwrap(shape as? MLNShapeCollectionFeature)
        let points = try XCTUnwrap(collection.shapes as? [MLNPointFeature])
        XCTAssertEqual(points.count, 2)

        XCTAssertEqual(points[0].attributes["kind"] as? String, "front")
        XCTAssertEqual(points[0].coordinate.latitude, 58.1, accuracy: 1e-9)
        XCTAssertEqual(points[1].attributes["kind"] as? String, "pin")
        XCTAssertEqual(points[1].coordinate.longitude, 15.2, accuracy: 1e-9)
    }

    func testEmptyTargetsClearSource() throws {
        let collection = try XCTUnwrap(MapOverlayShapes.targetsShape([]) as? MLNShapeCollectionFeature)
        XCTAssertEqual(collection.shapes.count, 0)
    }

    func testUserLocationShape() throws {
        let marker = UserLocationMarker(position: LatLon(lat: 58.35, lon: 15.72))
        let point = try XCTUnwrap(MapOverlayShapes.userLocationShape(marker) as? MLNPointFeature)
        XCTAssertEqual(point.coordinate.latitude, 58.35, accuracy: 1e-9)
        XCTAssertEqual(point.coordinate.longitude, 15.72, accuracy: 1e-9)

        let hidden = try XCTUnwrap(MapOverlayShapes.userLocationShape(nil) as? MLNShapeCollectionFeature)
        XCTAssertEqual(hidden.shapes.count, 0)
    }

    // MARK: - Measure overlay

    func testMeasureLineBuildsPolylineAndHidesBelowTwoPoints() throws {
        let overlay = MeasureOverlay(points: [
            LatLon(lat: 58.357, lon: 15.722),
            LatLon(lat: 58.358, lon: 15.724),
            LatLon(lat: 58.359, lon: 15.723),
        ])
        let line = try XCTUnwrap(MapOverlayShapes.measureLineShape(overlay) as? MLNPolylineFeature)
        XCTAssertEqual(line.pointCount, 3)

        let single = MeasureOverlay(points: [LatLon(lat: 58.357, lon: 15.722)])
        let hidden = try XCTUnwrap(MapOverlayShapes.measureLineShape(single) as? MLNShapeCollectionFeature)
        XCTAssertEqual(hidden.shapes.count, 0)
    }

    func testMeasurePointsCarryRoleKindsAndLabels() throws {
        let overlay = MeasureOverlay(points: [
            LatLon(lat: 58.357, lon: 15.722),
            LatLon(lat: 58.358, lon: 15.724),
            LatLon(lat: 58.359, lon: 15.723),
        ])
        let shape = try XCTUnwrap(MapOverlayShapes.measurePointsShape(overlay) as? MLNShapeCollectionFeature)
        let points = try XCTUnwrap(shape.shapes as? [MLNPointFeature])
        XCTAssertEqual(points.count, 3)
        XCTAssertEqual(points.map { $0.attributes["kind"] as? String }, ["first", "mid", "last"])
        XCTAssertEqual(points.map { $0.attributes["label"] as? String }, ["A", "B", "C"])
        XCTAssertEqual(points[0].coordinate.latitude, 58.357, accuracy: 1e-9)

        // A single placed point reads as the start point.
        let single = try XCTUnwrap(
            MapOverlayShapes.measurePointsShape(
                MeasureOverlay(points: [LatLon(lat: 58.357, lon: 15.722)])
            ) as? MLNShapeCollectionFeature
        )
        let singlePoints = try XCTUnwrap(single.shapes as? [MLNPointFeature])
        XCTAssertEqual(singlePoints.first?.attributes["kind"] as? String, "first")

        let empty = try XCTUnwrap(
            MapOverlayShapes.measurePointsShape(.empty) as? MLNShapeCollectionFeature
        )
        XCTAssertEqual(empty.shapes.count, 0)
    }

    // MARK: - Shot-viz overlay shapes (T2)

    private func ll(_ lat: Double, _ lon: Double) -> LatLon { LatLon(lat: lat, lon: lon) }

    func testPlanEllipsesBecomePolygonFeatures() throws {
        let ring = [ll(58.35, 15.70), ll(58.36, 15.70), ll(58.36, 15.71), ll(58.35, 15.70)]
        let plan = PlanOverlay(ellipses: [
            PlanStrategy.EllipseShape(polygon: ring, center: ll(58.355, 15.705)),
        ])
        let collection = try XCTUnwrap(
            MapOverlayShapes.planEllipsesShape(plan) as? MLNShapeCollectionFeature
        )
        let polygons = try XCTUnwrap(collection.shapes as? [MLNPolygonFeature])
        XCTAssertEqual(polygons.count, 1)
        // A degenerate (<3 point) ring is dropped.
        let degenerate = PlanOverlay(ellipses: [
            PlanStrategy.EllipseShape(polygon: [ll(58.35, 15.70)], center: ll(58.35, 15.70)),
        ])
        let empty = try XCTUnwrap(
            MapOverlayShapes.planEllipsesShape(degenerate) as? MLNShapeCollectionFeature
        )
        XCTAssertEqual(empty.shapes.count, 0)
    }

    func testPlanLegTintsCarryLightAttribute() throws {
        let plan = PlanOverlay(legTints: [
            PlanStrategy.LegTintShape(line: [ll(58.35, 15.70), ll(58.36, 15.71)], light: .red),
        ])
        let collection = try XCTUnwrap(
            MapOverlayShapes.planLegTintsShape(plan) as? MLNShapeCollectionFeature
        )
        let lines = try XCTUnwrap(collection.shapes as? [MLNPolylineFeature])
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0].attributes["light"] as? String, "red")
    }

    func testPlanGhostShapeTagsEachFeatureWithRole() throws {
        let ghost = PlanStrategy.GhostShape(
            aim: ll(58.361, 15.706),
            center: ll(58.3612, 15.7062),
            ellipse: [ll(58.36, 15.705), ll(58.362, 15.705), ll(58.362, 15.707), ll(58.36, 15.705)],
            driftLine: [ll(58.361, 15.706), ll(58.3612, 15.7062)]
        )
        let collection = try XCTUnwrap(
            MapOverlayShapes.planGhostShape(PlanOverlay(ghosts: [ghost])) as? MLNShapeCollectionFeature
        )
        let roles = collection.shapes.compactMap { ($0 as? MLNFeature)?.attributes["role"] as? String }
        XCTAssertEqual(Set(roles), ["ghost-ellipse", "ghost-drift", "ghost-center", "ghost-aim"])

        // No drift line when the ghost carries none.
        let noDrift = PlanStrategy.GhostShape(
            aim: ghost.aim, center: ghost.center, ellipse: ghost.ellipse, driftLine: nil
        )
        let c2 = try XCTUnwrap(
            MapOverlayShapes.planGhostShape(PlanOverlay(ghosts: [noDrift])) as? MLNShapeCollectionFeature
        )
        let roles2 = c2.shapes.compactMap { ($0 as? MLNFeature)?.attributes["role"] as? String }
        XCTAssertFalse(roles2.contains("ghost-drift"))
    }

    func testShotVizShapesEmptyWhenNoStrategy() throws {
        let plan = PlanOverlay(line: [ll(58.35, 15.70), ll(58.36, 15.71)])
        for shape in [
            MapOverlayShapes.planEllipsesShape(plan),
            MapOverlayShapes.planLegTintsShape(plan),
            MapOverlayShapes.planGhostShape(plan),
        ] {
            let collection = try XCTUnwrap(shape as? MLNShapeCollectionFeature)
            XCTAssertEqual(collection.shapes.count, 0)
        }
    }

    func testSelectedWindHoldBuildsTaggedConnectorAndAimMarker() throws {
        let hold = TargetWindHold(
            aim: ll(58.361, 15.705),
            target: ll(58.361, 15.706),
            meters: 8,
            side: .left
        )
        let collection = try XCTUnwrap(
            MapOverlayShapes.selectedWindHoldShape(hold) as? MLNShapeCollectionFeature
        )
        let roles = collection.shapes.compactMap {
            ($0 as? MLNFeature)?.attributes["role"] as? String
        }
        XCTAssertEqual(Set(roles), ["hold-line", "hold-aim"])

        let empty = try XCTUnwrap(
            MapOverlayShapes.selectedWindHoldShape(nil) as? MLNShapeCollectionFeature
        )
        XCTAssertTrue(empty.shapes.isEmpty)
    }

    /// Camera command equality drives when CourseMapView re-applies a move;
    /// the token is the escape hatch for re-issuing an identical move.
    func testCameraCommandEqualityAndToken() {
        let bounds = MapCoordinateBounds(west: 15.7, south: 58.35, east: 15.73, north: 58.36)
        let a = MapCameraCommand.fitHole(bounds, bearing: 42)
        let b = MapCameraCommand.fitHole(bounds, bearing: 42)
        XCTAssertEqual(a, b)
        XCTAssertNotEqual(a, MapCameraCommand.fitHole(bounds, bearing: 42, token: 1))
        XCTAssertNotEqual(a, MapCameraCommand.fitHole(bounds, bearing: 180))
        XCTAssertNotEqual(
            a,
            MapCameraCommand.center(bounds.center, zoom: 16, bearing: 42)
        )
        XCTAssertNotEqual(
            a,
            MapCameraCommand.fitHole(bounds, bearing: 42, insets: MapEdgeInsets(bottom: 200)),
            "chrome insets are part of the fit"
        )
    }

    /// The Green view frames the green plus a margin of surrounds — the margin
    /// is metric, so it must survive the lat/lon conversion at this latitude.
    func testBoundsExpandedByMetersGrowsEveryEdgeByThatDistance() {
        let bounds = MapCoordinateBounds(west: 15.7, south: 58.35, east: 15.701, north: 58.351)
        let grown = bounds.expanded(byMeters: 5)

        let southWest = LatLon(lat: bounds.south, lon: bounds.west)
        XCTAssertEqual(
            Distance.planarMeters(southWest, LatLon(lat: grown.south, lon: bounds.west)),
            5, accuracy: 0.1
        )
        XCTAssertEqual(
            Distance.planarMeters(southWest, LatLon(lat: bounds.south, lon: grown.west)),
            5, accuracy: 0.1
        )

        let northEast = LatLon(lat: bounds.north, lon: bounds.east)
        XCTAssertEqual(
            Distance.planarMeters(northEast, LatLon(lat: grown.north, lon: bounds.east)),
            5, accuracy: 0.1
        )
        XCTAssertEqual(
            Distance.planarMeters(northEast, LatLon(lat: bounds.north, lon: grown.east)),
            5, accuracy: 0.1
        )

        XCTAssertEqual(bounds.expanded(byMeters: 0), bounds)
    }

    func testCourseRouteShapeBuildsPolylineThroughAims() throws {
        let route = CourseRouteOverlay(
            line: [
                LatLon(lat: 58.350, lon: 15.720),
                LatLon(lat: 58.352, lon: 15.722),
                LatLon(lat: 58.354, lon: 15.724),
            ],
            aims: [LatLon(lat: 58.352, lon: 15.722)]
        )
        let polyline = try XCTUnwrap(MapOverlayShapes.courseRouteShape(route) as? MLNPolylineFeature)
        XCTAssertEqual(polyline.pointCount, 3)

        let nodes = try XCTUnwrap(
            MapOverlayShapes.courseRouteNodesShape(route) as? MLNShapeCollectionFeature
        )
        let points = try XCTUnwrap(nodes.shapes as? [MLNPointFeature])
        XCTAssertEqual(points.count, 1)
        XCTAssertEqual(points[0].coordinate.latitude, 58.352, accuracy: 1e-9)
        XCTAssertEqual(points[0].coordinate.longitude, 15.722, accuracy: 1e-9)
    }

    func testEmptyCourseRouteClearsBothSources() throws {
        let line = try XCTUnwrap(
            MapOverlayShapes.courseRouteShape(.empty) as? MLNShapeCollectionFeature
        )
        XCTAssertEqual(line.shapes.count, 0)
        let nodes = try XCTUnwrap(
            MapOverlayShapes.courseRouteNodesShape(.empty) as? MLNShapeCollectionFeature
        )
        XCTAssertEqual(nodes.shapes.count, 0)
    }
}
