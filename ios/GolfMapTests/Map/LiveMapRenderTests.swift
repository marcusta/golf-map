import MapLibre
import XCTest
@testable import GolfMap

/// Live rendering verification against a real (Landeryd) tile bundle on the
/// host filesystem. Skipped unless the environment provides a bundle:
///
///     xcodebuild test ... \
///       TEST_RUNNER_GOLFMAP_LIVE_BUNDLE_DIR=/path/to/<courseId-bundle-dir> \
///       TEST_RUNNER_GOLFMAP_LIVE_OUT_DIR=/path/to/output
///
/// The bundle dir must have the `BundlePaths` layout (features.geojson +
/// tiles/ortho/{z}/{x}/{y}.jpg). Screenshots land in OUT_DIR (and as
/// XCTAttachments) for human inspection.
@MainActor
final class LiveMapRenderTests: XCTestCase {

    // Landeryd Masters manifest values (data/tiles/<id>/manifest.json); the
    // fixture pyramid is expected to hold ortho z14–16.
    private let bounds = MapCoordinateBounds(
        west: 15.695402171504204,
        south: 58.343071979895555,
        east: 15.748940150757141,
        north: 58.37121131892607
    )
    private let fixtureOrthoMinZoom = 14
    private let fixtureOrthoMaxZoom = 16

    private var sampleOverlays: MapOverlayState {
        MapOverlayState(
            distanceLine: [LatLon(lat: 58.3550, lon: 15.7180), LatLon(lat: 58.3590, lon: 15.7245)],
            targets: [
                TargetMarker(kind: .front, position: LatLon(lat: 58.3586, lon: 15.7238)),
                TargetMarker(kind: .center, position: LatLon(lat: 58.3589, lon: 15.7242)),
                TargetMarker(kind: .back, position: LatLon(lat: 58.3592, lon: 15.7246)),
                TargetMarker(kind: .pin, position: LatLon(lat: 58.3589, lon: 15.7244)),
            ],
            userLocation: UserLocationMarker(position: LatLon(lat: 58.3550, lon: 15.7180))
        )
    }

    private func liveEnvironment() throws -> (bundleDir: URL, outDir: URL) {
        let env = ProcessInfo.processInfo.environment
        guard let bundlePath = env["GOLFMAP_LIVE_BUNDLE_DIR"] else {
            throw XCTSkip("Set TEST_RUNNER_GOLFMAP_LIVE_BUNDLE_DIR to run live map render tests")
        }
        let bundleDir = URL(fileURLWithPath: bundlePath, isDirectory: true)
        guard FileManager.default.fileExists(atPath: bundleDir.appending(path: "features.geojson").path) else {
            throw XCTSkip("No features.geojson in \(bundlePath)")
        }
        let outDir = env["GOLFMAP_LIVE_OUT_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.temporaryDirectory
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        return (bundleDir, outDir)
    }

    private func configuration(bundleDir: URL) -> CourseMapConfiguration {
        CourseMapConfiguration(
            bundleDirectory: bundleDir,
            orthoMinZoom: fixtureOrthoMinZoom,
            orthoMaxZoom: fixtureOrthoMaxZoom,
            bounds: bounds,
            attribution: "© Lantmäteriet, CC BY 4.0"
        )
    }

    /// Style with the sample overlay data baked into the overlay sources, so
    /// a snapshot shows distance line + targets + user dot without runtime
    /// source mutation.
    private func writeStyleWithOverlayData(bundleDir: URL) throws -> URL {
        let features = try Data(contentsOf: bundleDir.appending(path: "features.geojson"))
        var style = try MapStyleBuilder.styleDictionary(
            configuration: configuration(bundleDir: bundleDir),
            featuresGeoJSON: features
        )
        var sources = try XCTUnwrap(style["sources"] as? [String: Any])

        let overlays = sampleOverlays
        let lineCoords = overlays.distanceLine.map { [$0.lon, $0.lat] }
        sources[MapStyleIDs.distanceLineSource] = geoJSONSource([
            feature(geometry: ["type": "LineString", "coordinates": lineCoords], properties: [:]),
        ])
        sources[MapStyleIDs.targetsSource] = geoJSONSource(overlays.targets.map {
            feature(
                geometry: ["type": "Point", "coordinates": [$0.position.lon, $0.position.lat]],
                properties: ["kind": $0.kind.rawValue]
            )
        })
        let user = try XCTUnwrap(overlays.userLocation)
        sources[MapStyleIDs.userLocationSource] = geoJSONSource([
            feature(
                geometry: ["type": "Point", "coordinates": [user.position.lon, user.position.lat]],
                properties: [:]
            ),
        ])
        style["sources"] = sources

        let url = FileManager.default.temporaryDirectory
            .appending(path: "live-style-\(UUID().uuidString).json")
        try JSONSerialization.data(withJSONObject: style).write(to: url)
        return url
    }

    private func geoJSONSource(_ features: [[String: Any]]) -> [String: Any] {
        ["type": "geojson", "data": ["type": "FeatureCollection", "features": features]]
    }

    private func feature(geometry: [String: Any], properties: [String: Any]) -> [String: Any] {
        ["type": "Feature", "geometry": geometry, "properties": properties]
    }

    // MARK: - Tests

    /// Headless render via MLNMapSnapshotter (same style + tile loading core
    /// as the map view, no Metal-in-window involved).
    func testSnapshotterRendersOrthoFeaturesAndOverlays() throws {
        let (bundleDir, outDir) = try liveEnvironment()
        let styleURL = try writeStyleWithOverlayData(bundleDir: bundleDir)

        let camera = MLNMapCamera()
        camera.centerCoordinate = CLLocationCoordinate2D(latitude: 58.357, longitude: 15.722)
        camera.heading = 0

        let options = MLNMapSnapshotOptions(
            styleURL: styleURL,
            camera: camera,
            size: CGSize(width: 390, height: 700)
        )
        options.zoomLevel = 15.5

        let snapshotter = MLNMapSnapshotter(options: options)
        let done = expectation(description: "snapshot")
        nonisolated(unsafe) var image: UIImage?
        nonisolated(unsafe) var snapshotError: Error?
        snapshotter.start { snapshot, error in
            image = snapshot?.image
            snapshotError = error
            done.fulfill()
        }
        wait(for: [done], timeout: 90)

        XCTAssertNil(snapshotError, "snapshotter failed: \(String(describing: snapshotError))")
        let rendered = try XCTUnwrap(image, "no snapshot image")

        let path = try save(rendered, name: "live-snapshotter.png", outDir: outDir)
        let colors = distinctSampleColors(in: rendered)
        print("LIVE-VERIFY snapshotter image: \(path) distinctSampleColors=\(colors)")
        XCTAssertGreaterThan(colors, 12, "snapshot looks uniform — tiles/features likely not rendered")
    }

    /// Real MLNMapView in a UIWindow: style load, runtime overlay updates via
    /// MapOverlayRenderer, camera fit with bearing, then a best-effort
    /// drawHierarchy capture (Metal content may not composite into
    /// drawHierarchy on simulator — the snapshotter test is the authoritative
    /// pixel check).
    func testMapViewLoadsStyleAndAppliesOverlaysInWindow() throws {
        let (bundleDir, outDir) = try liveEnvironment()
        let features = try Data(contentsOf: bundleDir.appending(path: "features.geojson"))
        let styleData = try MapStyleBuilder.styleJSONData(
            configuration: configuration(bundleDir: bundleDir),
            featuresGeoJSON: features
        )
        let styleURL = FileManager.default.temporaryDirectory
            .appending(path: "live-mapview-style-\(UUID().uuidString).json")
        try styleData.write(to: styleURL)

        // Attach to the host app's scene — a sceneless UIWindow gets no
        // display link, so MapLibre never renders a frame.
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
            "no window scene in test host app"
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
        let mapView = MLNMapView(frame: window.bounds, styleURL: styleURL)
        let delegate = CaptureDelegate()
        mapView.delegate = delegate
        window.addSubview(mapView)
        window.makeKeyAndVisible()

        wait(for: [delegate.styleLoaded], timeout: 60)
        let style = try XCTUnwrap(mapView.style)

        // Overlay sources from the generated style must be reachable +
        // updatable at runtime (the coordinator's update path).
        for id in [
            MapStyleIDs.distanceLineSource,
            MapStyleIDs.targetsSource,
            MapStyleIDs.userLocationSource,
        ] {
            XCTAssertTrue(
                style.source(withIdentifier: id) is MLNShapeSource,
                "missing shape source \(id)"
            )
        }
        MapOverlayRenderer.apply(sampleOverlays, to: style)

        // Camera fit with hole-direction-up bearing (exercises applyCamera).
        let holeBounds = MapCoordinateBounds(west: 15.716, south: 58.354, east: 15.726, north: 58.360)
        CourseMapView.Coordinator.applyCamera(
            .fitHole(holeBounds, bearing: 35, animated: false),
            to: mapView
        )
        XCTAssertEqual(mapView.direction, 35, accuracy: 0.5)
        XCTAssertEqual(mapView.centerCoordinate.latitude, 58.357, accuracy: 0.01)
        XCTAssertEqual(mapView.centerCoordinate.longitude, 15.721, accuracy: 0.02)

        wait(for: [delegate.fullyRendered], timeout: 60)
        // A couple of extra runloop seconds so overlay shapes make it into a
        // rendered frame before capture.
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 2))

        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let capture = renderer.image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let path = try save(capture, name: "live-mapview.png", outDir: outDir)
        let colors = distinctSampleColors(in: capture)
        print("LIVE-VERIFY mapview capture: \(path) distinctSampleColors=\(colors)")
        if colors <= 12 {
            print("LIVE-VERIFY WARNING: drawHierarchy capture looks uniform — Metal layer likely not composited; rely on snapshotter image")
        }
    }

    // MARK: - Helpers

    private func save(_ image: UIImage, name: String, outDir: URL) throws -> String {
        let data = try XCTUnwrap(image.pngData())
        let url = outDir.appending(path: name)
        try data.write(to: url)
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        return url.path
    }

    /// Distinct quantized RGB values over a coarse sample grid — a cheap
    /// "did anything actually render" signal (a blank/background-only frame
    /// yields 1–3).
    private func distinctSampleColors(in image: UIImage) -> Int {
        guard let cgImage = image.cgImage else { return 0 }
        let width = 40
        let height = 40
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return 0 }
        context.interpolationQuality = .none
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var seen = Set<UInt32>()
        for i in stride(from: 0, to: pixels.count, by: 4) {
            // Quantize to 4 bits/channel so JPEG noise doesn't inflate the count.
            let key = UInt32(pixels[i] >> 4) << 8
                | UInt32(pixels[i + 1] >> 4) << 4
                | UInt32(pixels[i + 2] >> 4)
            seen.insert(key)
        }
        return seen.count
    }

    @MainActor
    private final class CaptureDelegate: NSObject, @preconcurrency MLNMapViewDelegate {
        let styleLoaded = XCTestExpectation(description: "style loaded")
        let fullyRendered = XCTestExpectation(description: "fully rendered")

        override init() {
            super.init()
            styleLoaded.assertForOverFulfill = false
            fullyRendered.assertForOverFulfill = false
        }

        func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
            styleLoaded.fulfill()
        }

        func mapViewDidFinishRenderingMap(_ mapView: MLNMapView, fullyRendered: Bool) {
            if fullyRendered {
                self.fullyRendered.fulfill()
            }
        }
    }
}
