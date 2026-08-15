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
        // Manifest orthoMaxZoom is 20, but the offline ortho ceiling caps the
        // raster source's maxzoom at 19 so MapLibre overzooms z19 past it.
        XCTAssertEqual(ortho["maxzoom"] as? Int, 19)
        XCTAssertEqual(ortho["bounds"] as? [Double], [15.695, 58.343, 15.749, 58.371])
        XCTAssertEqual(ortho["attribution"] as? String, "© Lantmäteriet, CC BY 4.0")
    }

    func testOrthoSourceMaxZoomStaysBelowCeilingWhenManifestIsLower() throws {
        var config = configuration
        config.orthoMaxZoom = 17
        let style = try MapStyleBuilder.styleDictionary(configuration: config, featuresGeoJSON: tinyGeoJSON)
        let sources = try XCTUnwrap(style["sources"] as? [String: Any])
        let ortho = try XCTUnwrap(sources[MapStyleIDs.orthoSource] as? [String: Any])
        XCTAssertEqual(ortho["maxzoom"] as? Int, 17, "cap does not raise a lower manifest maxzoom")
    }

    /// A manifest that declares no ortho maxzoom (0 = "not declared" after the
    /// lenient decode) must NOT collapse the raster source to z0 — it falls
    /// back to the device ceiling, i.e. the pre-cap behavior.
    func testOrthoSourceFallsBackToCeilingWhenManifestDeclaresNoMaxZoom() throws {
        var config = configuration
        config.orthoMaxZoom = 0
        let style = try MapStyleBuilder.styleDictionary(configuration: config, featuresGeoJSON: tinyGeoJSON)
        let sources = try XCTUnwrap(style["sources"] as? [String: Any])
        let ortho = try XCTUnwrap(sources[MapStyleIDs.orthoSource] as? [String: Any])
        XCTAssertEqual(ortho["maxzoom"] as? Int, OrthoZoomPolicy.deviceMaxZoom)
    }

    func testOrthoSourceUsesInjectedExtension() throws {
        let style = try MapStyleBuilder.styleDictionary(
            configuration: configuration,
            featuresGeoJSON: tinyGeoJSON,
            orthoTileExtension: "webp"
        )
        let sources = try XCTUnwrap(style["sources"] as? [String: Any])
        let ortho = try XCTUnwrap(sources[MapStyleIDs.orthoSource] as? [String: Any])
        XCTAssertEqual(
            ortho["tiles"] as? [String],
            ["file:///tmp/bundles/COURSE-1/tiles/ortho/{z}/{x}/{y}.webp"]
        )
    }

    // MARK: - Ortho extension probing

    func testDetectOrthoExtensionFindsWebp() throws {
        let dir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let tile = dir.appending(path: "tiles/ortho/19/12/34.webp")
        try FileManager.default.createDirectory(at: tile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: tile)

        XCTAssertEqual(MapStyleBuilder.detectOrthoExtension(bundleDirectory: dir), "webp")
    }

    func testDetectOrthoExtensionFindsJpg() throws {
        let dir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let tile = dir.appending(path: "tiles/ortho/19/12/34.jpg")
        try FileManager.default.createDirectory(at: tile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: tile)

        XCTAssertEqual(MapStyleBuilder.detectOrthoExtension(bundleDirectory: dir), "jpg")
    }

    func testDetectOrthoExtensionDefaultsToJpgWhenMissing() throws {
        let dir = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: dir) }
        XCTAssertEqual(MapStyleBuilder.detectOrthoExtension(bundleDirectory: dir), "jpg")
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
            MapStyleIDs.planLineSource,
            MapStyleIDs.planGatesSource,
            MapStyleIDs.planNodesSource,
            MapStyleIDs.planEllipsesSource,
            MapStyleIDs.planLegTintsSource,
            MapStyleIDs.planGhostSource,
            MapStyleIDs.distanceLineSource,
            MapStyleIDs.courseRouteSource,
            MapStyleIDs.courseRouteNodesSource,
            MapStyleIDs.targetsSource,
            MapStyleIDs.routeLegLabelsSource,
            MapStyleIDs.ellipseLabelsSource,
            MapStyleIDs.userLocationSource,
            MapStyleIDs.measureLineSource,
            MapStyleIDs.measurePointsSource,
            MapStyleIDs.adjustHandlesSource,
            MapStyleIDs.highlightSource,
            MapStyleIDs.inspectedFeatureSource,
            MapStyleIDs.browseFromSource,
            MapStyleIDs.selectedEllipseSource,
            MapStyleIDs.selectedWindHoldSource,
            MapStyleIDs.reticleLinesSource,
            MapStyleIDs.reticleEllipseSource,
            MapStyleIDs.reticleNeighborsSource,
            MapStyleIDs.reticleWindHoldSource,
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
                // Course route (tee → aims → green) below the whole overlay
                // stack — course definition, context for everything above it.
                MapStyleIDs.courseRouteLayer,
                MapStyleIDs.courseRouteNodesLayer,
                // Shot-viz dispersion ellipses sit at the bottom of the plan
                // stack so the leg line / nodes / gates all read over them.
                MapStyleIDs.planEllipsesFillLayer,
                MapStyleIDs.planEllipsesOutlineLayer,
                MapStyleIDs.selectedEllipseFillLayer,
                MapStyleIDs.selectedEllipseOutlineLayer,
                MapStyleIDs.selectedWindHoldLineLayer,
                MapStyleIDs.selectedWindHoldAimLayer,
                // Reticle settled advice (ellipse, neighbor arcs, wind hold)
                // low in the stack — the aim/extension/pan-arc lines above
                // the distance line read over them.
                MapStyleIDs.reticleEllipseFillLayer,
                MapStyleIDs.reticleEllipseOutlineLayer,
                MapStyleIDs.reticleNeighborsLayer,
                MapStyleIDs.reticleWindHoldLineLayer,
                MapStyleIDs.reticleWindHoldAimLayer,
                // Plan overlay UNDER the distance line: the strategy is
                // context; the white "where I am" line stays on top.
                MapStyleIDs.planLineCasingLayer,
                MapStyleIDs.planLineLayer,
                MapStyleIDs.planLegTintsLayer,
                MapStyleIDs.planGatesLayer,
                MapStyleIDs.planGhostEllipseLayer,
                MapStyleIDs.planGhostDriftLayer,
                MapStyleIDs.planGhostCenterLayer,
                MapStyleIDs.planGhostAimLayer,
                MapStyleIDs.planNodesLayer,
                // Tapped-shape wash + outline under the distance line (the
                // measuring line reads over the highlighted ring); its edge
                // markers above the line, pinning the two measured points.
                MapStyleIDs.inspectedFeatureFillLayer,
                MapStyleIDs.inspectedFeatureOutlineLayer,
                MapStyleIDs.distanceLineCasingLayer,
                MapStyleIDs.distanceLineLayer,
                MapStyleIDs.reticleAimCasingLayer,
                MapStyleIDs.reticleAimLayer,
                MapStyleIDs.reticleExtensionLayer,
                MapStyleIDs.reticlePanArcLayer,
                MapStyleIDs.inspectedFeatureEdgeLayer,
                MapStyleIDs.routeLegLabelsLayer,
                MapStyleIDs.ellipseLabelsLayer,
                MapStyleIDs.targetsLayer,
                MapStyleIDs.measureLineCasingLayer,
                MapStyleIDs.measureLineLayer,
                MapStyleIDs.measurePointsLayer,
                MapStyleIDs.userLocationHaloLayer,
                MapStyleIDs.userLocationDotLayer,
                MapStyleIDs.browseFromDotLayer,
                MapStyleIDs.highlightHaloLayer,
                MapStyleIDs.highlightRingLayer,
                MapStyleIDs.highlightDotLayer,
                MapStyleIDs.adjustHandlesCircleLayer,
                MapStyleIDs.adjustHandlesLabelLayer,
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

    /// The route-leg label layer: a symbol layer whose icon is data-driven by
    /// the per-feature `labelImage` id (pre-rendered numbers — no glyphs in
    /// the offline style), always drawn, nudged sideways off the line.
    func testRouteLegLabelLayerIsDataDrivenIconSymbol() throws {
        let labels = try layer(MapStyleIDs.routeLegLabelsLayer, in: buildStyle())
        XCTAssertEqual(labels["type"] as? String, "symbol")
        XCTAssertEqual(labels["source"] as? String, MapStyleIDs.routeLegLabelsSource)
        let layout = try XCTUnwrap(labels["layout"] as? [String: Any])
        XCTAssertEqual(layout["icon-image"] as? [String], ["get", "labelImage"])
        XCTAssertEqual(layout["icon-allow-overlap"] as? Bool, true)
        XCTAssertEqual(layout["icon-ignore-placement"] as? Bool, true)
        let offset = try XCTUnwrap(layout["icon-offset"] as? [Double])
        XCTAssertNotEqual(offset, [0, 0], "label sits beside the line, not on it")
    }

    /// The plan overlay reads as "the strategy": violet DASHED leg line
    /// (clearly distinct from the solid white distance line), solid gate
    /// cross-bars and filled landing nodes in the same violet.
    func testPlanLayersAreDashedVioletAndDistinctFromDistanceLine() throws {
        let style = try buildStyle()

        let planLine = try layer(MapStyleIDs.planLineLayer, in: style)
        XCTAssertEqual(planLine["type"] as? String, "line")
        let planPaint = try XCTUnwrap(planLine["paint"] as? [String: Any])
        XCTAssertEqual(planPaint["line-color"] as? String, "#a78bfa")
        XCTAssertNotNil(planPaint["line-dasharray"], "planned (dashed), not live")

        let distanceLine = try layer(MapStyleIDs.distanceLineLayer, in: style)
        let distancePaint = try XCTUnwrap(distanceLine["paint"] as? [String: Any])
        XCTAssertNotEqual(
            planPaint["line-color"] as? String,
            distancePaint["line-color"] as? String,
            "plan line must not look like the distance line"
        )
        XCTAssertNil(distancePaint["line-dasharray"], "distance line stays solid")

        let gates = try layer(MapStyleIDs.planGatesLayer, in: style)
        XCTAssertEqual(gates["type"] as? String, "line")
        let gatesPaint = try XCTUnwrap(gates["paint"] as? [String: Any])
        XCTAssertEqual(gatesPaint["line-color"] as? String, "#a78bfa")
        XCTAssertNil(gatesPaint["line-dasharray"], "gate bars are solid")

        let nodes = try layer(MapStyleIDs.planNodesLayer, in: style)
        XCTAssertEqual(nodes["type"] as? String, "circle")
        let nodesPaint = try XCTUnwrap(nodes["paint"] as? [String: Any])
        XCTAssertEqual(nodesPaint["circle-color"] as? String, "#a78bfa")
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
        XCTAssertTrue(
            colorExpr.contains { $0 as? String == CourseFeatureType.fairway.fillHex },
            "fairway fill present (palette is pinned to the web by FeaturePaletteTests)"
        )

        let layout = try XCTUnwrap(fill["layout"] as? [String: Any])
        let sortKey = try XCTUnwrap(layout["fill-sort-key"] as? [Any])
        XCTAssertEqual(sortKey.first as? String, "coalesce", "reads stackKey, falls back to type order")
        XCTAssertEqual(sortKey[1] as? [String], ["get", "stackKey"])
    }

    /// Nice-mode parity with the web: feature surfaces render as fills only.
    /// Web nice mode hides its outline layers (line-opacity 0,
    /// features.service.ts) — a boundary-stroke layer here would draw the
    /// resolved geometry's clip edges as lines crossing every surface.
    func testNoFeatureOutlineLayer() throws {
        let style = try buildStyle()
        let layers = try XCTUnwrap(style["layers"] as? [[String: Any]])
        XCTAssertFalse(
            layers.contains { ($0["id"] as? String) == "features-outline" },
            "feature boundaries must not be stroked (web nice-mode parity)"
        )
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
        XCTAssertEqual((decoded["layers"] as? [Any])?.count, 48)
    }

    // MARK: - Shot-visualisation overlay (T2)

    /// Dispersion ellipses: a translucent violet fill under a brighter outline,
    /// both off the shared ellipse source, drawn below the plan line.
    func testEllipseLayersAreTranslucentFillPlusOutline() throws {
        let style = try buildStyle()

        let fill = try layer(MapStyleIDs.planEllipsesFillLayer, in: style)
        XCTAssertEqual(fill["type"] as? String, "fill")
        XCTAssertEqual(fill["source"] as? String, MapStyleIDs.planEllipsesSource)
        let fillPaint = try XCTUnwrap(fill["paint"] as? [String: Any])
        let opacity = try XCTUnwrap(fillPaint["fill-opacity"] as? Double)
        XCTAssertGreaterThan(opacity, 0)
        XCTAssertLessThan(opacity, 1, "ellipse fill is translucent so the ortho shows through")

        let outline = try layer(MapStyleIDs.planEllipsesOutlineLayer, in: style)
        XCTAssertEqual(outline["type"] as? String, "line")
        XCTAssertEqual(outline["source"] as? String, MapStyleIDs.planEllipsesSource)
    }

    /// Approach-leg confidence tint: a data-driven `match` on the `light`
    /// attribute mapping green/yellow/red to the good/risk/bad ramp.
    func testLegTintLayerMapsConfidenceLightToRamp() throws {
        let tint = try layer(MapStyleIDs.planLegTintsLayer, in: buildStyle())
        XCTAssertEqual(tint["type"] as? String, "line")
        XCTAssertEqual(tint["source"] as? String, MapStyleIDs.planLegTintsSource)
        let paint = try XCTUnwrap(tint["paint"] as? [String: Any])
        let colorExpr = try XCTUnwrap(paint["line-color"] as? [Any])
        XCTAssertEqual(colorExpr.first as? String, "match")
        let strings = colorExpr.compactMap { $0 as? String }
        for branch in ["green", "yellow", "red", "#4E7A46", "#C68A2E", "#B24A32"] {
            XCTAssertTrue(strings.contains(branch), "tint branch \(branch)")
        }
    }

    /// The ghost group: four role-filtered layers (dashed pattern outline,
    /// drift connector, finish dot, hollow aim ring) off one source, in a
    /// distinct rose that is neither the plan violet nor a distance color.
    func testGhostLayersAreRoleFilteredAndDistinctColor() throws {
        let style = try buildStyle()
        let expected: [(String, String, String)] = [
            (MapStyleIDs.planGhostEllipseLayer, "line", "ghost-ellipse"),
            (MapStyleIDs.planGhostDriftLayer, "line", "ghost-drift"),
            (MapStyleIDs.planGhostCenterLayer, "circle", "ghost-center"),
            (MapStyleIDs.planGhostAimLayer, "circle", "ghost-aim"),
        ]
        for (id, type, role) in expected {
            let l = try layer(id, in: style)
            XCTAssertEqual(l["type"] as? String, type, id)
            XCTAssertEqual(l["source"] as? String, MapStyleIDs.planGhostSource, id)
            let filter = try XCTUnwrap(l["filter"] as? [Any], id)
            XCTAssertTrue(filter.description.contains(role), "\(id) filters on role \(role)")
        }
        // Ghost color is distinct from the plan violet and the white line.
        let aimPaint = try XCTUnwrap(try layer(MapStyleIDs.planGhostAimLayer, in: style)["paint"] as? [String: Any])
        let ghostColor = aimPaint["circle-stroke-color"] as? String
        XCTAssertEqual(ghostColor, "#f472b6")
        XCTAssertNotEqual(ghostColor, "#a78bfa", "ghost must not read as the plan line")
    }
}
