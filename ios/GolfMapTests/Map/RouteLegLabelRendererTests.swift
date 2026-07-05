import MapLibre
import XCTest
@testable import GolfMap

/// The route-leg label renderer's pure builders (feature shape, image ids,
/// number images). Style application (setImage + shape reassignment against a
/// live MLNStyle) is covered by the on-device live verification — MLNStyle
/// cannot be constructed headlessly (same limitation as GreenAnalysisRenderer).
@MainActor
final class RouteLegLabelRendererTests: XCTestCase {

    func testShapeBuildsOnePointPerLegWithValueKeyedImageIds() throws {
        let labels = [
            RouteLegLabel(midpoint: LatLon(lat: 58.3607, lon: 15.7096), meters: 231),
            RouteLegLabel(midpoint: LatLon(lat: 58.3620, lon: 15.7090), meters: 157),
            RouteLegLabel(midpoint: LatLon(lat: 58.3632, lon: 15.7084), meters: 95),
        ]
        let shape = try XCTUnwrap(RouteLegLabelRenderer.shape(labels) as? MLNShapeCollectionFeature)
        let points = try XCTUnwrap(shape.shapes as? [MLNPointFeature])
        XCTAssertEqual(points.count, 3, "one feature per leg")

        for (label, point) in zip(labels, points) {
            XCTAssertEqual(point.coordinate.latitude, label.midpoint.lat, accuracy: 1e-9)
            XCTAssertEqual(point.coordinate.longitude, label.midpoint.lon, accuracy: 1e-9)
            XCTAssertEqual(
                point.attributes["labelImage"] as? String,
                RouteLegLabelRenderer.imageName(meters: label.meters)
            )
        }
        XCTAssertEqual(points[0].attributes["labelImage"] as? String, "route-leg-label-231")
    }

    func testEmptyLabelsBuildEmptyShape() throws {
        let shape = try XCTUnwrap(RouteLegLabelRenderer.shape([]) as? MLNShapeCollectionFeature)
        XCTAssertEqual(shape.shapes.count, 0)
    }

    func testImageNameIsValueKeyedSoEqualLegsShareOneImage() {
        XCTAssertEqual(RouteLegLabelRenderer.imageName(meters: 95), "route-leg-label-95")
        // Two legs of the same length resolve the same registered image.
        let labels = [
            RouteLegLabel(midpoint: LatLon(lat: 58.36, lon: 15.71), meters: 140),
            RouteLegLabel(midpoint: LatLon(lat: 58.37, lon: 15.72), meters: 140),
        ]
        let names = Set(labels.map { RouteLegLabelRenderer.imageName(meters: $0.meters) })
        XCTAssertEqual(names.count, 1)
    }

    func testLabelImageRendersNonEmptyNumber() {
        let image = RouteLegLabelRenderer.labelImage(meters: 231)
        XCTAssertGreaterThan(image.size.width, 15, "three digits + stroke/shadow inset")
        XCTAssertGreaterThan(image.size.height, 15)
        // Wider numbers render wider images (no fixed-size clipping).
        let short = RouteLegLabelRenderer.labelImage(meters: 9)
        XCTAssertLessThan(short.size.width, image.size.width)
    }
}
