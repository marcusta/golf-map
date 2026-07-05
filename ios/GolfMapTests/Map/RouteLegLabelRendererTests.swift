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

    // MARK: - Viewport clip (pull the label into view)

    private var clipRect: CGRect { CGRect(x: 0, y: 0, width: 100, height: 100) }

    func testClipFullyInsideKeepsWholeSegment() throws {
        let clip = try XCTUnwrap(
            RouteLegLabelRenderer.clipSegment(CGPoint(x: 10, y: 10), CGPoint(x: 90, y: 90), to: clipRect)
        )
        XCTAssertEqual(clip.0, 0, accuracy: 1e-9)
        XCTAssertEqual(clip.1, 1, accuracy: 1e-9)
    }

    func testClipCrossingPullsMidpointToVisibleCenter() throws {
        // Horizontal leg with both ends off-screen but the middle crossing the
        // rect: the clipped-portion midpoint is the on-screen center (x = 50).
        let p0 = CGPoint(x: -50, y: 50)
        let p1 = CGPoint(x: 150, y: 50)
        let clip = try XCTUnwrap(RouteLegLabelRenderer.clipSegment(p0, p1, to: clipRect))
        XCTAssertEqual(clip.0, 0.25, accuracy: 1e-9)
        XCTAssertEqual(clip.1, 0.75, accuracy: 1e-9)
        let t = (clip.0 + clip.1) / 2
        XCTAssertEqual(p0.x + (p1.x - p0.x) * t, 50, accuracy: 1e-9)
    }

    func testClipFullyOutsideReturnsNil() {
        XCTAssertNil(
            RouteLegLabelRenderer.clipSegment(CGPoint(x: -50, y: -50), CGPoint(x: -10, y: -10), to: clipRect)
        )
    }
}
