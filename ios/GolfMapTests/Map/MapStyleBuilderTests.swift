import XCTest
@testable import GolfMap

final class MapStyleBuilderTests: XCTestCase {

    private let bundleDirectory = URL(fileURLWithPath: "/tmp/bundles/COURSE-1", isDirectory: true)

    private var configuration: CourseMapConfiguration {
        CourseMapConfiguration(
            bundleDirectory: bundleDirectory,
            orthoMinZoom: 14,
            orthoMaxZoom: 20,
            bounds: MapCoordinateBounds(west: 15.695, south: 58.343, east: 15.749, north: 58.371),
            attribution: "© Lantmäteriet, CC BY 4.0"
        )
    }

    private let tinyGeoJSON = Data("""
    {"type":"FeatureCollection","features":[
      {"type":"Feature","properties":{"type":"fairway"},
       "geometry":{"type":"Polygon","coordinates":[[[15.7,58.35],[15.71,58.35],[15.71,58.36],[15.7,58.35]]]}}
    ]}
    """.utf8)

    private func buildStyle() throws -> [String: Any] {
        try MapStyleBuilder.styleDictionary(configuration: configuration, featuresGeoJSON: tinyGeoJSON)
    }

    func testOrthoTileURLTemplateKeepsPlaceholdersLiteral() {
        let template = MapStyleBuilder.orthoTileURLTemplate(bundleDirectory: bundleDirectory)
        XCTAssertEqual(template, "file:///tmp/bundles/COURSE-1/tiles/ortho/{z}/{x}/{y}.jpg")
    }

    func testStyleTopLevelStructure() throws {
        let style = try buildStyle()
        XCTAssertEqual(style["version"] as? Int, 8)
        XCTAssertNotNil(style["sources"] as? [String: Any])
        XCTAssertNotNil(style["layers"] as? [[String: Any]])
    }

    func testOrthoSourceUsesManifestValues() throws {
        let style = try buildStyle()
        let sources = try XCTUnwrap(style["sources"] as? [String: Any])
        let ortho = try XCTUnwrap(sources[MapStyleIDs.orthoSource] as? [String: Any])

        XCTAssertEqual(ortho["type"] as? String, "raster")
        XCTAssertEqual(
            ortho["tiles"] as? [String],
            ["file:///tmp/bundles/COURSE-1/tiles/ortho/{z}/{x}/{y}.jpg"]
        )
        XCTAssertEqual(ortho["tileSize"] as? Int, 256)
        XCTAssertEqual(ortho["minzoom"] as? Int, 14)
        XCTAssertEqual(ortho["maxzoom"] as? Int, 20)
        XCTAssertEqual(ortho["bounds"] as? [Double], [15.695, 58.343, 15.749, 58.371])
        XCTAssertEqual(ortho["attribution"] as? String, "© Lantmäteriet, CC BY 4.0")
    }

    func testAttributionOmittedWhenNil() throws {
        var config = configuration
        config.attribution = nil
        let style = try MapStyleBuilder.styleDictionary(configuration: config, featuresGeoJSON: tinyGeoJSON)
        let sources = try XCTUnwrap(style["sources"] as? [String: Any])
        let ortho = try XCTUnwrap(sources[MapStyleIDs.orthoSource] as? [String: Any])
        XCTAssertNil(ortho["attribution"])
    }

    func testFeaturesEmbeddedInlineAndOverlaySourcesEmpty() throws {
        let style = try buildStyle()
        let sources = try XCTUnwrap(style["sources"] as? [String: Any])

        let features = try XCTUnwrap(sources[MapStyleIDs.featuresSource] as? [String: Any])
        XCTAssertEqual(features["type"] as? String, "geojson")
        let data = try XCTUnwrap(features["data"] as? [String: Any])
        XCTAssertEqual(data["type"] as? String, "FeatureCollection")
        XCTAssertEqual((data["features"] as? [Any])?.count, 1)

        for id in [
            MapStyleIDs.distanceLineSource,
            MapStyleIDs.targetsSource,
            MapStyleIDs.userLocationSource,
            MapStyleIDs.measureLineSource,
            MapStyleIDs.measurePointsSource,
        ] {
            let source = try XCTUnwrap(sources[id] as? [String: Any], id)
            XCTAssertEqual(source["type"] as? String, "geojson", id)
            let empty = try XCTUnwrap(source["data"] as? [String: Any], id)
            XCTAssertEqual((empty["features"] as? [Any])?.count, 0, id)
        }
    }

    func testLayerOrderBottomToTop() throws {
        let style = try buildStyle()
        let layers = try XCTUnwrap(style["layers"] as? [[String: Any]])
        XCTAssertEqual(
            layers.compactMap { $0["id"] as? String },
            [
                MapStyleIDs.backgroundLayer,
                MapStyleIDs.orthoLayer,
                MapStyleIDs.featuresFillLayer,
                MapStyleIDs.featuresOutlineLayer,
                MapStyleIDs.distanceLineCasingLayer,
                MapStyleIDs.distanceLineLayer,
                MapStyleIDs.targetsLayer,
                MapStyleIDs.measureLineCasingLayer,
                MapStyleIDs.measureLineLayer,
                MapStyleIDs.measurePointsLayer,
                MapStyleIDs.userLocationHaloLayer,
                MapStyleIDs.userLocationDotLayer,
            ]
        )
    }

    func testMeasureLayersUseWebMeasurePalette() throws {
        let style = try buildStyle()
        let line = try layer(MapStyleIDs.measureLineLayer, in: style)
        let linePaint = try XCTUnwrap(line["paint"] as? [String: Any])
        XCTAssertEqual(linePaint["line-color"] as? String, "#fbbf24", "amber measure line")

        let points = try layer(MapStyleIDs.measurePointsLayer, in: style)
        XCTAssertEqual(points["type"] as? String, "circle")
        let pointsPaint = try XCTUnwrap(points["paint"] as? [String: Any])
        let colorExpr = try XCTUnwrap(pointsPaint["circle-color"] as? [Any])
        XCTAssertEqual(colorExpr.first as? String, "match")
        let strings = colorExpr.compactMap { $0 as? String }
        XCTAssertTrue(strings.contains("first"), "first-point color branch")
        XCTAssertTrue(strings.contains("last"), "last-point color branch")
        XCTAssertTrue(strings.contains("#22c55e"), "point A green")
        XCTAssertTrue(strings.contains("#ef4444"), "last point red")
    }

    private func layer(_ id: String, in style: [String: Any]) throws -> [String: Any] {
        let layers = try XCTUnwrap(style["layers"] as? [[String: Any]])
        return try XCTUnwrap(layers.first { $0["id"] as? String == id }, "layer \(id)")
    }

    func testBackgroundMatchesWebEditor() throws {
        let layer = try layer(MapStyleIDs.backgroundLayer, in: buildStyle())
        XCTAssertEqual(layer["type"] as? String, "background")
        let paint = try XCTUnwrap(layer["paint"] as? [String: Any])
        XCTAssertEqual(paint["background-color"] as? String, "#0b0e11")
    }

    func testFeatureFillLayerIsSemiTransparentWithSortKey() throws {
        let fill = try layer(MapStyleIDs.featuresFillLayer, in: buildStyle())
        XCTAssertEqual(fill["type"] as? String, "fill")
        XCTAssertEqual(fill["source"] as? String, MapStyleIDs.featuresSource)

        let paint = try XCTUnwrap(fill["paint"] as? [String: Any])
        XCTAssertEqual(paint["fill-opacity"] as? Double, 0.4)
        let colorExpr = try XCTUnwrap(paint["fill-color"] as? [Any])
        XCTAssertEqual(colorExpr.first as? String, "match")
        XCTAssertTrue(colorExpr.contains { $0 as? String == "#4d9e58" }, "fairway fill present")

        let layout = try XCTUnwrap(fill["layout"] as? [String: Any])
        XCTAssertNotNil(layout["fill-sort-key"] as? [Any])
    }

    func testFeatureOutlineLayerUsesOutlinePalette() throws {
        let line = try layer(MapStyleIDs.featuresOutlineLayer, in: buildStyle())
        XCTAssertEqual(line["type"] as? String, "line")
        let paint = try XCTUnwrap(line["paint"] as? [String: Any])
        XCTAssertEqual(paint["line-width"] as? Double, 1.5)
        let colorExpr = try XCTUnwrap(paint["line-color"] as? [Any])
        XCTAssertTrue(colorExpr.contains { $0 as? String == "#2f7d43" }, "fairway outline present")
    }

    func testTargetLayerHasPerKindColorsAndPinEmphasis() throws {
        let targets = try layer(MapStyleIDs.targetsLayer, in: buildStyle())
        XCTAssertEqual(targets["type"] as? String, "circle")
        let paint = try XCTUnwrap(targets["paint"] as? [String: Any])

        let colorExpr = try XCTUnwrap(paint["circle-color"] as? [Any])
        XCTAssertEqual(colorExpr.first as? String, "match")
        XCTAssertEqual(colorExpr[1] as? [String], ["get", "kind"])
        let strings = colorExpr.compactMap { $0 as? String }
        for kind in TargetMarker.Kind.allCases {
            XCTAssertTrue(strings.contains(kind.rawValue), "color for \(kind)")
        }

        let radiusExpr = try XCTUnwrap(paint["circle-radius"] as? [Any])
        XCTAssertTrue(radiusExpr.contains { $0 as? String == "pin" }, "pin gets its own radius")
    }

    func testUserLocationLayersDrawHaloUnderDot() throws {
        let style = try buildStyle()
        let halo = try layer(MapStyleIDs.userLocationHaloLayer, in: style)
        let dot = try layer(MapStyleIDs.userLocationDotLayer, in: style)
        let haloPaint = try XCTUnwrap(halo["paint"] as? [String: Any])
        let dotPaint = try XCTUnwrap(dot["paint"] as? [String: Any])
        let haloRadius = try XCTUnwrap(haloPaint["circle-radius"] as? Double)
        let dotRadius = try XCTUnwrap(dotPaint["circle-radius"] as? Double)
        XCTAssertGreaterThan(haloRadius, dotRadius)
    }

    func testInvalidGeoJSONThrows() {
        XCTAssertThrowsError(
            try MapStyleBuilder.styleDictionary(
                configuration: configuration,
                featuresGeoJSON: Data("not json".utf8)
            )
        ) { error in
            XCTAssertEqual(error as? MapStyleError, .invalidFeaturesGeoJSON)
        }
    }

    func testStyleJSONDataRoundTrips() throws {
        let data = try MapStyleBuilder.styleJSONData(
            configuration: configuration,
            featuresGeoJSON: tinyGeoJSON
        )
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(decoded["version"] as? Int, 8)
        XCTAssertEqual((decoded["layers"] as? [Any])?.count, 12)
    }
}
