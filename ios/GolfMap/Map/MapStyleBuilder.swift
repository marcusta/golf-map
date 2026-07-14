import Foundation

/// Stable source/layer identifiers of the generated course map style.
/// Public so screens/tests can address layers (visibility toggles, hit tests).
public enum MapStyleIDs {
    public static let backgroundLayer = "map-background"

    public static let orthoSource = "course-ortho"
    public static let orthoLayer = "course-ortho"

    public static let featuresSource = "course-features"
    public static let featuresFillLayer = "features-fill"

    // Dynamic overlay sources start out as empty FeatureCollections in the
    // style; CourseMapView updates them at runtime via MLNShapeSource.shape.

    // Game-plan strategy overlay (read-only viewer): dashed leg polyline,
    // landing-point nodes, and gate cross-lines. Drawn UNDER the distance
    // line — the plan is "the strategy", the white line is "where I am".
    public static let planLineSource = "overlay-plan-line"
    public static let planLineCasingLayer = "overlay-plan-line-casing"
    public static let planLineLayer = "overlay-plan-line"
    public static let planGatesSource = "overlay-plan-gates"
    public static let planGatesLayer = "overlay-plan-gates"
    public static let planNodesSource = "overlay-plan-nodes"
    public static let planNodesLayer = "overlay-plan-nodes"

    // Shot-visualisation overlay (read-only viewer, port of the web planner's
    // plan-overlay): per-leg dispersion ellipses (fill + outline), approach-leg
    // confidence tints, and the recommended-aim "ghost" group. Competition mode
    // clears their sources (the model emits empty geometry).
    public static let planEllipsesSource = "overlay-plan-ellipses"
    public static let planEllipsesFillLayer = "overlay-plan-ellipses-fill"
    public static let planEllipsesOutlineLayer = "overlay-plan-ellipses-outline"
    public static let planLegTintsSource = "overlay-plan-leg-tints"
    public static let planLegTintsLayer = "overlay-plan-leg-tints"
    public static let planGhostSource = "overlay-plan-ghost"
    public static let planGhostEllipseLayer = "overlay-plan-ghost-ellipse"
    public static let planGhostDriftLayer = "overlay-plan-ghost-drift"
    public static let planGhostCenterLayer = "overlay-plan-ghost-center"
    public static let planGhostAimLayer = "overlay-plan-ghost-aim"

    public static let distanceLineSource = "overlay-distance-line"
    public static let distanceLineCasingLayer = "overlay-distance-line-casing"
    public static let distanceLineLayer = "overlay-distance-line"

    public static let targetsSource = "overlay-targets"
    public static let targetsLayer = "overlay-targets"

    // On-map route-leg distance labels (immersive mode). A symbol layer whose
    // icons are pre-rendered number images registered at runtime by
    // RouteLegLabelRenderer — the offline style has no glyph PBFs, so symbol
    // text-field cannot render (same wall/workaround as the Green-view slope
    // chips).
    public static let routeLegLabelsSource = "overlay-route-leg-labels"
    public static let routeLegLabelsLayer = "overlay-route-leg-labels"

    public static let userLocationSource = "overlay-user-location"
    public static let userLocationHaloLayer = "overlay-user-location-halo"
    public static let userLocationDotLayer = "overlay-user-location-dot"

    // Distance-ladder tap highlight: a cyan halo + hollow ring marking the
    // feature a tapped ladder row focused (distinct from every other marker
    // color). One point source; cleared when the focus clears.
    public static let highlightSource = "overlay-highlight"
    public static let highlightHaloLayer = "overlay-highlight-halo"
    public static let highlightRingLayer = "overlay-highlight-ring"

    // Selected-target dispersion ellipse: the recommended club's shot pattern
    // at the tapped target (cyan, matching the highlight). One polygon source.
    public static let selectedEllipseSource = "overlay-selected-ellipse"
    public static let selectedEllipseFillLayer = "overlay-selected-ellipse-fill"
    public static let selectedEllipseOutlineLayer = "overlay-selected-ellipse-outline"

    // Measure tool path (dedicated sources — the distance-line source is
    // rewritten every GPS fix and must never fight the measure overlay).
    public static let measureLineSource = "overlay-measure-line"
    public static let measureLineCasingLayer = "overlay-measure-line-casing"
    public static let measureLineLayer = "overlay-measure-line"
    public static let measurePointsSource = "overlay-measure-points"
    public static let measurePointsLayer = "overlay-measure-points"

    // Adjust-mode draggable handles (tee / aim points / green center): a
    // kind-colored ring circle layer plus a symbol layer whose icons are
    // pre-rendered label images ("T", "A1", "G") registered at runtime by
    // AdjustHandleRenderer (no glyph PBFs in the offline style). Topmost —
    // handles must stay grabbable over every other overlay.
    public static let adjustHandlesSource = "overlay-adjust-handles"
    public static let adjustHandlesCircleLayer = "overlay-adjust-handles-circle"
    public static let adjustHandlesLabelLayer = "overlay-adjust-handles-label"
}

public enum MapStyleError: Error, Equatable {
    /// The features GeoJSON data was not a JSON object.
    case invalidFeaturesGeoJSON
}

/// Assembles the complete MapLibre style JSON for one offline course bundle:
/// dark background (the ortho IS the basemap), file:// ortho raster source,
/// course feature fill/outline layers with the web palette, and empty geojson
/// sources for the dynamic overlays (distance line, target markers, user dot).
///
/// Pure JSON assembly — no MapLibre import — so structure is unit-testable.
/// `CourseMapView` writes the JSON to a temp file and points
/// `MLNMapView.styleURL` at it.
public enum MapStyleBuilder {
    /// Hard zoom ceiling; ortho overzooms past its native maxzoom up to here
    /// (matches the web editor's EDITOR_MAX_ZOOM).
    public static let mapMaxZoom = 22.0
    /// Background outside tile coverage — same as the web editor.
    public static let backgroundColor = "#0b0e11"

    // Distance line styling: white line over a dark casing so it reads on
    // both fairway green tones and pale bunkers.
    static let distanceLineColor = "#ffffff"
    static let distanceLineWidth = 2.5
    static let distanceLineCasingColor = "#14281c"
    static let distanceLineCasingWidth = 5.0

    // Game-plan overlay: violet strategy palette, clearly distinct from the
    // white "where I am" distance line and the amber measure path. The leg
    // line is DASHED (planned, not live); gates are solid cross-bars; nodes
    // are small filled circles under the F/C/B markers.
    static let planColor = "#a78bfa"
    static let planLineWidth = 3.0
    static let planLineDashArray = [2.0, 2.0]
    static let planLineCasingColor = "#1e1433"
    static let planLineCasingWidth = 5.5
    static let planGateWidth = 3.5
    static let planNodeRadius = 5.0
    static let planNodeStrokeColor = "#ffffff"

    // Shot-viz overlay palette. Dispersion ellipses keep the violet plan
    // identity (translucent fill, brighter outline); the recommended-aim ghost
    // is a distinct rose so "where you'd aim" never reads as the plan line
    // itself; approach-leg tints use the app's data-viz good/risk/bad ramp
    // (matches the web LIGHT_* colors exactly).
    static let planEllipseFillColor = "#a78bfa"
    static let planEllipseFillOpacity = 0.16
    static let planEllipseOutlineColor = "#c4b5fd"
    static let planEllipseOutlineWidth = 1.2
    static let planGhostColor = "#f472b6"
    static let planGhostDashArray = [2.0, 2.0]
    static let planGhostDriftDashArray = [1.0, 1.5]
    static let planGhostCenterRadius = 3.5
    static let planGhostAimRadius = 6.0
    static let planLegTintWidth = 4.5
    static let planLightColors: [(light: String, hex: String)] = [
        ("green", "#4E7A46"),  // --data-good
        ("yellow", "#C68A2E"), // --data-risk
        ("red", "#B24A32"),    // --data-bad
    ]
    static let planLightFallbackColor = "#a78bfa"

    // Target marker colors by `kind` attribute (front/center/back follow the
    // red/white/blue flag-position convention; pin uses the web selection
    // yellow). Dark stroke ties them to the distance line casing.
    static let targetColors: [(kind: String, hex: String)] = [
        ("front", "#e03131"),
        ("center", "#ffffff"),
        ("back", "#4f8fd0"),
        ("pin", "#ffd43b"),
    ]
    static let targetFallbackColor = "#ffffff"
    static let targetStrokeColor = "#14281c"

    // User GPS dot: blue dot on a white halo (fed from outside, not
    // MLNMapView's own user-location tracking).
    static let userDotColor = "#3a7bd5"
    static let userHaloColor = "#ffffff"

    // Selected-target dispersion ellipse: cyan (highlight family), translucent
    // fill under a brighter outline — "your shot pattern at this target".
    static let selectedEllipseFillColor = "#22d3ee"
    static let selectedEllipseFillOpacity = 0.14
    static let selectedEllipseOutlineColor = "#67e8f9"
    static let selectedEllipseOutlineWidth = 1.4

    // Ladder tap highlight: bright cyan, unused by any other marker, so the
    // "you tapped this" ring is unmistakable over ortho + every overlay.
    static let highlightColor = "#22d3ee"
    static let highlightHaloRadius = 16.0
    static let highlightHaloOpacity = 0.22
    static let highlightRingRadius = 12.5
    static let highlightRingStrokeWidth = 3.0

    // Route-leg label icons: nudged sideways (screen px) so the number sits
    // beside the route line rather than on it — the hole camera draws the
    // route roughly vertically (hole bearing up), so a horizontal offset is
    // perpendicular to the line in the common framing.
    static let routeLegLabelOffsetX = 18.0

    // Measure overlay: web measure-tool palette (measure-tool.service.ts) —
    // amber path, point A green, last point red, mid points amber. No text
    // labels on the map: the offline style has no glyph PBFs (symbol
    // text-field needs a `glyphs` source), so point identity is encoded in
    // color/order and the readout card's A→B segment strip.
    static let measureLineColor = "#fbbf24"
    static let measureLineWidth = 3.0
    static let measureLineCasingColor = "#14281c"
    static let measureLineCasingWidth = 5.5
    static let measurePointColors: [(kind: String, hex: String)] = [
        ("first", "#22c55e"),
        ("last", "#ef4444"),
        ("mid", "#fbbf24"),
    ]
    static let measurePointStrokeColor = "#ffffff"

    // Adjust handles: large rings, clearly distinct from the small F/C/B
    // target dots — translucent kind-colored fill with a solid kind-colored
    // stroke, label image centered on top. Radius ≥ the drag hit slop's
    // visual anchor so the affordance reads as grabbable.
    public static let adjustHandleRadius = 14.0
    static let adjustHandleColors: [(kind: String, hex: String)] = [
        ("tee", "#22c55e"),
        ("aim", "#fbbf24"),
        ("green", "#c084fc"),
        // Shot-capture handles share the ring layer: rose crosshair (the
        // stroke's FROM position) + pin-yellow intended target.
        ("shot", "#fb7185"),
        ("target", "#ffd43b"),
        // Planner-tool planned landing points — the plan violet (matches the
        // plan overlay's dashed-violet line + nodes).
        ("planShot", "#a78bfa"),
    ]
    static let adjustHandleFallbackColor = "#ffffff"
    static let adjustHandleFillOpacity = 0.28
    static let adjustHandleStrokeWidth = 3.0

    /// file:// XYZ template for the bundle's ortho tiles, with literal
    /// {z}/{x}/{y} placeholders (string concatenation — URL APIs would
    /// percent-encode the braces). Layout matches `BundlePaths`. The extension
    /// must match the tiles actually on disk (ortho moved from .jpg to .webp);
    /// resolve it with `detectOrthoExtension`.
    public static func orthoTileURLTemplate(
        bundleDirectory: URL,
        fileExtension: String = "jpg"
    ) -> String {
        var base = bundleDirectory.absoluteString
        if !base.hasSuffix("/") { base += "/" }
        return base + "tiles/ortho/{z}/{x}/{y}.\(fileExtension)"
    }

    /// Probes a bundle's `tiles/ortho` directory for the extension its tiles
    /// were downloaded with. Returns `"webp"` if the layer is WebP, else
    /// `"jpg"`. A layer is homogeneous (one extension for the whole pyramid),
    /// so the first tile file found decides — cheap and deterministic. The
    /// `FileManager` is injectable for tests.
    public static func detectOrthoExtension(
        bundleDirectory: URL,
        fileManager: FileManager = .default
    ) -> String {
        let orthoDir = bundleDirectory
            .appending(path: "tiles", directoryHint: .isDirectory)
            .appending(path: "ortho", directoryHint: .isDirectory)
        guard let enumerator = fileManager.enumerator(
            at: orthoDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return "jpg"
        }
        for case let url as URL in enumerator {
            switch url.pathExtension.lowercased() {
            case "webp": return "webp"
            case "jpg", "jpeg": return "jpg"
            default: continue // directories and stray files
            }
        }
        return "jpg"
    }

    /// Full style as a JSON object. `featuresGeoJSON` is embedded inline as
    /// the feature source's data. `orthoTileExtension` must match the tiles on
    /// disk (see `detectOrthoExtension`). Throws if the GeoJSON is not
    /// parseable.
    public static func styleDictionary(
        configuration: CourseMapConfiguration,
        featuresGeoJSON: Data,
        orthoTileExtension: String = "jpg"
    ) throws -> [String: Any] {
        guard
            let parsed = try? JSONSerialization.jsonObject(with: featuresGeoJSON),
            let features = parsed as? [String: Any]
        else {
            throw MapStyleError.invalidFeaturesGeoJSON
        }

        let boundsArray = [
            configuration.bounds.west,
            configuration.bounds.south,
            configuration.bounds.east,
            configuration.bounds.north,
        ]
        // Cap the raster source's maxzoom at the offline ortho ceiling so
        // MapLibre overzooms z19 tiles at deeper view zooms (source maxzoom is
        // the highest level with real tiles). Bundles built before the cap
        // still declare a higher manifest maxzoom — clamp it here too.
        let orthoSourceMaxZoom = min(configuration.orthoMaxZoom, BundleDownloader.orthoBundleMaxZoom)
        var orthoSource: [String: Any] = [
            "type": "raster",
            "tiles": [orthoTileURLTemplate(
                bundleDirectory: configuration.bundleDirectory,
                fileExtension: orthoTileExtension
            )],
            "tileSize": 256,
            "minzoom": configuration.orthoMinZoom,
            "maxzoom": orthoSourceMaxZoom,
            "bounds": boundsArray,
        ]
        if let attribution = configuration.attribution {
            orthoSource["attribution"] = attribution
        }

        let emptyCollection: [String: Any] = ["type": "FeatureCollection", "features": [Any]()]
        let sources: [String: Any] = [
            MapStyleIDs.orthoSource: orthoSource,
            MapStyleIDs.featuresSource: ["type": "geojson", "data": features],
            MapStyleIDs.planLineSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.planGatesSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.planNodesSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.planEllipsesSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.planLegTintsSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.planGhostSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.distanceLineSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.targetsSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.routeLegLabelsSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.userLocationSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.measureLineSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.measurePointsSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.adjustHandlesSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.highlightSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.selectedEllipseSource: ["type": "geojson", "data": emptyCollection],
        ]

        var adjustHandleColorExpr: [Any] = ["match", ["get", "kind"]]
        for (kind, hex) in adjustHandleColors {
            adjustHandleColorExpr.append(kind)
            adjustHandleColorExpr.append(hex)
        }
        adjustHandleColorExpr.append(adjustHandleFallbackColor)

        var measurePointColorExpr: [Any] = ["match", ["get", "kind"]]
        for (kind, hex) in measurePointColors {
            measurePointColorExpr.append(kind)
            measurePointColorExpr.append(hex)
        }
        measurePointColorExpr.append(measureLineColor)

        var targetColorExpr: [Any] = ["match", ["get", "kind"]]
        for (kind, hex) in targetColors {
            targetColorExpr.append(kind)
            targetColorExpr.append(hex)
        }
        targetColorExpr.append(targetFallbackColor)
        let targetRadiusExpr: [Any] = ["match", ["get", "kind"], "pin", 7, 5]

        // Approach-leg confidence tint: feature `light` (green/yellow/red) →
        // the good/risk/bad ramp, falling back to the plan violet.
        var planLightColorExpr: [Any] = ["match", ["get", "light"]]
        for (light, hex) in planLightColors {
            planLightColorExpr.append(light)
            planLightColorExpr.append(hex)
        }
        planLightColorExpr.append(planLightFallbackColor)

        let layers: [[String: Any]] = [
            [
                "id": MapStyleIDs.backgroundLayer,
                "type": "background",
                "paint": ["background-color": backgroundColor],
            ],
            [
                "id": MapStyleIDs.orthoLayer,
                "type": "raster",
                "source": MapStyleIDs.orthoSource,
            ],
            [
                // Nice-mode parity with the web (features.service.ts): fills
                // only, NO per-feature boundary strokes — web nice mode
                // renders its outline layers at line-opacity 0. With resolved
                // geometry the clip edges would otherwise stroke as lines
                // crossing every abutting surface.
                "id": MapStyleIDs.featuresFillLayer,
                "type": "fill",
                "source": MapStyleIDs.featuresSource,
                "layout": ["fill-sort-key": FeaturePalette.stackSortKeyExpression()],
                "paint": [
                    "fill-color": FeaturePalette.typeColorExpression(outline: false),
                    "fill-opacity": FeaturePalette.fillOpacity,
                ],
            ],
            [
                // Dispersion ellipses at the very bottom of the plan stack so
                // the leg line, nodes and gates all read over them.
                "id": MapStyleIDs.planEllipsesFillLayer,
                "type": "fill",
                "source": MapStyleIDs.planEllipsesSource,
                "paint": [
                    "fill-color": planEllipseFillColor,
                    "fill-opacity": planEllipseFillOpacity,
                ],
            ],
            [
                "id": MapStyleIDs.planEllipsesOutlineLayer,
                "type": "line",
                "source": MapStyleIDs.planEllipsesSource,
                "paint": [
                    "line-color": planEllipseOutlineColor,
                    "line-width": planEllipseOutlineWidth,
                    "line-opacity": 0.9,
                ],
            ],
            [
                // Selected-target shot-pattern ellipse — a translucent cyan
                // area low in the stack (over surfaces, under the plan/line/
                // markers) so it never hides the numbers on top of it.
                "id": MapStyleIDs.selectedEllipseFillLayer,
                "type": "fill",
                "source": MapStyleIDs.selectedEllipseSource,
                "paint": [
                    "fill-color": selectedEllipseFillColor,
                    "fill-opacity": selectedEllipseFillOpacity,
                ],
            ],
            [
                "id": MapStyleIDs.selectedEllipseOutlineLayer,
                "type": "line",
                "source": MapStyleIDs.selectedEllipseSource,
                "paint": [
                    "line-color": selectedEllipseOutlineColor,
                    "line-width": selectedEllipseOutlineWidth,
                    "line-opacity": 0.9,
                ],
            ],
            [
                // Plan overlay under the live distance line: the strategy is
                // context, the white line is the current shot.
                "id": MapStyleIDs.planLineCasingLayer,
                "type": "line",
                "source": MapStyleIDs.planLineSource,
                "layout": ["line-cap": "round", "line-join": "round"],
                "paint": [
                    "line-color": planLineCasingColor,
                    "line-width": planLineCasingWidth,
                    "line-opacity": 0.8,
                ],
            ],
            [
                "id": MapStyleIDs.planLineLayer,
                "type": "line",
                // Butt caps so the dash gaps stay visible.
                "source": MapStyleIDs.planLineSource,
                "layout": ["line-join": "round"],
                "paint": [
                    "line-color": planColor,
                    "line-width": planLineWidth,
                    "line-dasharray": planLineDashArray,
                ],
            ],
            [
                // Approach-leg confidence tint over the dashed plan line — a
                // solid good/risk/bad bar on the leg landing on the green.
                "id": MapStyleIDs.planLegTintsLayer,
                "type": "line",
                "source": MapStyleIDs.planLegTintsSource,
                "layout": ["line-cap": "round", "line-join": "round"],
                "paint": [
                    "line-color": planLightColorExpr,
                    "line-width": planLegTintWidth,
                    "line-opacity": 0.9,
                ],
            ],
            [
                "id": MapStyleIDs.planGatesLayer,
                "type": "line",
                "source": MapStyleIDs.planGatesSource,
                "layout": ["line-cap": "round"],
                "paint": [
                    "line-color": planColor,
                    "line-width": planGateWidth,
                ],
            ],
            [
                // Recommended-aim ghost group (role-filtered off one source):
                // dashed pattern outline, drift connector, finish dot, hollow
                // aim ring. Under the plan nodes so tee/shot/green stay legible.
                "id": MapStyleIDs.planGhostEllipseLayer,
                "type": "line",
                "source": MapStyleIDs.planGhostSource,
                "filter": ["==", ["get", "role"], "ghost-ellipse"],
                "paint": [
                    "line-color": planGhostColor,
                    "line-width": 1.5,
                    "line-opacity": 0.8,
                    "line-dasharray": planGhostDashArray,
                ],
            ],
            [
                "id": MapStyleIDs.planGhostDriftLayer,
                "type": "line",
                "source": MapStyleIDs.planGhostSource,
                "filter": ["==", ["get", "role"], "ghost-drift"],
                "paint": [
                    "line-color": planGhostColor,
                    "line-width": 1.5,
                    "line-opacity": 0.9,
                    "line-dasharray": planGhostDriftDashArray,
                ],
            ],
            [
                "id": MapStyleIDs.planGhostCenterLayer,
                "type": "circle",
                "source": MapStyleIDs.planGhostSource,
                "filter": ["==", ["get", "role"], "ghost-center"],
                "paint": [
                    "circle-radius": planGhostCenterRadius,
                    "circle-color": planGhostColor,
                    "circle-stroke-color": planNodeStrokeColor,
                    "circle-stroke-width": 1.0,
                ],
            ],
            [
                "id": MapStyleIDs.planGhostAimLayer,
                "type": "circle",
                "source": MapStyleIDs.planGhostSource,
                "filter": ["==", ["get", "role"], "ghost-aim"],
                "paint": [
                    "circle-radius": planGhostAimRadius,
                    "circle-color": "rgba(0,0,0,0)",
                    "circle-stroke-color": planGhostColor,
                    "circle-stroke-width": 2.0,
                    "circle-stroke-opacity": 0.9,
                ],
            ],
            [
                "id": MapStyleIDs.planNodesLayer,
                "type": "circle",
                "source": MapStyleIDs.planNodesSource,
                "paint": [
                    "circle-color": planColor,
                    "circle-radius": planNodeRadius,
                    "circle-stroke-color": planNodeStrokeColor,
                    "circle-stroke-width": 1.5,
                ],
            ],
            [
                "id": MapStyleIDs.distanceLineCasingLayer,
                "type": "line",
                "source": MapStyleIDs.distanceLineSource,
                "layout": ["line-cap": "round", "line-join": "round"],
                "paint": [
                    "line-color": distanceLineCasingColor,
                    "line-width": distanceLineCasingWidth,
                    "line-opacity": 0.85,
                ],
            ],
            [
                "id": MapStyleIDs.distanceLineLayer,
                "type": "line",
                "source": MapStyleIDs.distanceLineSource,
                "layout": ["line-cap": "round", "line-join": "round"],
                "paint": [
                    "line-color": distanceLineColor,
                    "line-width": distanceLineWidth,
                ],
            ],
            [
                // Above the route line, below the F/C/B/pin markers so the
                // markers stay legible when a label lands near the green.
                "id": MapStyleIDs.routeLegLabelsLayer,
                "type": "symbol",
                "source": MapStyleIDs.routeLegLabelsSource,
                "layout": [
                    "icon-image": ["get", "labelImage"],
                    "icon-allow-overlap": true,
                    "icon-ignore-placement": true,
                    "icon-offset": [routeLegLabelOffsetX, 0.0],
                ],
            ],
            [
                "id": MapStyleIDs.targetsLayer,
                "type": "circle",
                "source": MapStyleIDs.targetsSource,
                "paint": [
                    "circle-color": targetColorExpr,
                    "circle-radius": targetRadiusExpr,
                    "circle-stroke-color": targetStrokeColor,
                    "circle-stroke-width": 1.5,
                ],
            ],
            [
                "id": MapStyleIDs.measureLineCasingLayer,
                "type": "line",
                "source": MapStyleIDs.measureLineSource,
                "layout": ["line-cap": "round", "line-join": "round"],
                "paint": [
                    "line-color": measureLineCasingColor,
                    "line-width": measureLineCasingWidth,
                    "line-opacity": 0.85,
                ],
            ],
            [
                "id": MapStyleIDs.measureLineLayer,
                "type": "line",
                "source": MapStyleIDs.measureLineSource,
                "layout": ["line-cap": "round", "line-join": "round"],
                "paint": [
                    "line-color": measureLineColor,
                    "line-width": measureLineWidth,
                ],
            ],
            [
                "id": MapStyleIDs.measurePointsLayer,
                "type": "circle",
                "source": MapStyleIDs.measurePointsSource,
                "paint": [
                    "circle-color": measurePointColorExpr,
                    "circle-radius": 7.0,
                    "circle-stroke-color": measurePointStrokeColor,
                    "circle-stroke-width": 2.0,
                ],
            ],
            [
                "id": MapStyleIDs.userLocationHaloLayer,
                "type": "circle",
                "source": MapStyleIDs.userLocationSource,
                "paint": [
                    "circle-color": userHaloColor,
                    "circle-radius": 10.0,
                    "circle-opacity": 0.9,
                ],
            ],
            [
                "id": MapStyleIDs.userLocationDotLayer,
                "type": "circle",
                "source": MapStyleIDs.userLocationSource,
                "paint": [
                    "circle-color": userDotColor,
                    "circle-radius": 6.5,
                ],
            ],
            [
                // Ladder tap highlight, above the markers/user dot so the
                // selected feature's ring reads clearly; below the adjust
                // handles so a drag affordance is never obscured.
                "id": MapStyleIDs.highlightHaloLayer,
                "type": "circle",
                "source": MapStyleIDs.highlightSource,
                "paint": [
                    "circle-color": highlightColor,
                    "circle-radius": highlightHaloRadius,
                    "circle-opacity": highlightHaloOpacity,
                ],
            ],
            [
                "id": MapStyleIDs.highlightRingLayer,
                "type": "circle",
                "source": MapStyleIDs.highlightSource,
                "paint": [
                    "circle-color": "rgba(0,0,0,0)",
                    "circle-radius": highlightRingRadius,
                    "circle-stroke-color": highlightColor,
                    "circle-stroke-width": highlightRingStrokeWidth,
                    "circle-stroke-opacity": 0.95,
                ],
            ],
            [
                // Adjust handles above everything: the drag affordance must
                // never hide under markers, labels or the user dot.
                "id": MapStyleIDs.adjustHandlesCircleLayer,
                "type": "circle",
                "source": MapStyleIDs.adjustHandlesSource,
                "paint": [
                    "circle-color": adjustHandleColorExpr,
                    "circle-opacity": adjustHandleFillOpacity,
                    "circle-radius": adjustHandleRadius,
                    "circle-stroke-color": adjustHandleColorExpr,
                    "circle-stroke-width": adjustHandleStrokeWidth,
                ],
            ],
            [
                "id": MapStyleIDs.adjustHandlesLabelLayer,
                "type": "symbol",
                "source": MapStyleIDs.adjustHandlesSource,
                "layout": [
                    "icon-image": ["get", "labelImage"],
                    "icon-allow-overlap": true,
                    "icon-ignore-placement": true,
                ],
            ],
        ]

        return [
            "version": 8,
            "name": "golfmap-course",
            "sources": sources,
            "layers": layers,
        ]
    }

    /// Style serialized to JSON bytes, ready to write to a file for
    /// `MLNMapView.styleURL`.
    public static func styleJSONData(
        configuration: CourseMapConfiguration,
        featuresGeoJSON: Data,
        orthoTileExtension: String = "jpg"
    ) throws -> Data {
        let dictionary = try styleDictionary(
            configuration: configuration,
            featuresGeoJSON: featuresGeoJSON,
            orthoTileExtension: orthoTileExtension
        )
        return try JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys])
    }
}
