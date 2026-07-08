import Foundation

/// Stable source/layer identifiers of the generated course map style.
/// Public so screens/tests can address layers (visibility toggles, hit tests).
public enum MapStyleIDs {
    public static let backgroundLayer = "map-background"

    public static let orthoSource = "course-ortho"
    public static let orthoLayer = "course-ortho"

    public static let featuresSource = "course-features"
    public static let featuresFillLayer = "features-fill"
    public static let featuresOutlineLayer = "features-outline"

    // Dynamic overlay sources start out as empty FeatureCollections in the
    // style; CourseMapView updates them at runtime via MLNShapeSource.shape.
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
    ]
    static let adjustHandleFallbackColor = "#ffffff"
    static let adjustHandleFillOpacity = 0.28
    static let adjustHandleStrokeWidth = 3.0

    /// file:// XYZ template for the bundle's ortho tiles, with literal
    /// {z}/{x}/{y} placeholders (string concatenation — URL APIs would
    /// percent-encode the braces). Layout matches `BundlePaths`.
    public static func orthoTileURLTemplate(bundleDirectory: URL) -> String {
        var base = bundleDirectory.absoluteString
        if !base.hasSuffix("/") { base += "/" }
        return base + "tiles/ortho/{z}/{x}/{y}.jpg"
    }

    /// Full style as a JSON object. `featuresGeoJSON` is embedded inline as
    /// the feature source's data. Throws if the GeoJSON is not parseable.
    public static func styleDictionary(
        configuration: CourseMapConfiguration,
        featuresGeoJSON: Data
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
        var orthoSource: [String: Any] = [
            "type": "raster",
            "tiles": [orthoTileURLTemplate(bundleDirectory: configuration.bundleDirectory)],
            "tileSize": 256,
            "minzoom": configuration.orthoMinZoom,
            "maxzoom": configuration.orthoMaxZoom,
            "bounds": boundsArray,
        ]
        if let attribution = configuration.attribution {
            orthoSource["attribution"] = attribution
        }

        let emptyCollection: [String: Any] = ["type": "FeatureCollection", "features": [Any]()]
        let sources: [String: Any] = [
            MapStyleIDs.orthoSource: orthoSource,
            MapStyleIDs.featuresSource: ["type": "geojson", "data": features],
            MapStyleIDs.distanceLineSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.targetsSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.routeLegLabelsSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.userLocationSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.measureLineSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.measurePointsSource: ["type": "geojson", "data": emptyCollection],
            MapStyleIDs.adjustHandlesSource: ["type": "geojson", "data": emptyCollection],
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
                "id": MapStyleIDs.featuresOutlineLayer,
                "type": "line",
                "source": MapStyleIDs.featuresSource,
                "layout": ["line-sort-key": FeaturePalette.stackSortKeyExpression()],
                "paint": [
                    "line-color": FeaturePalette.typeColorExpression(outline: true),
                    "line-width": FeaturePalette.outlineWidth,
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
        featuresGeoJSON: Data
    ) throws -> Data {
        let dictionary = try styleDictionary(
            configuration: configuration,
            featuresGeoJSON: featuresGeoJSON
        )
        return try JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys])
    }
}
