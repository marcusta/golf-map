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
    }
}
