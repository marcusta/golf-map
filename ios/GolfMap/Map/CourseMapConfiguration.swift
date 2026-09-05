import Foundation

/// A WGS84 bounding box for map camera + tile source bounds.
public struct MapCoordinateBounds: Equatable, Sendable {
    public var west: Double
    public var south: Double
    public var east: Double
    public var north: Double

    public init(west: Double, south: Double, east: Double, north: Double) {
        self.west = west
        self.south = south
        self.east = east
        self.north = north
    }

    public var center: LatLon {
        LatLon(lat: (south + north) / 2, lon: (west + east) / 2)
    }

    /// The bbox grown by `meters` on every side (spherical approximation — the
    /// distances here are tens of meters, so the flat-earth conversion is exact
    /// to well under a meter). Used to leave a margin of surrounds around a
    /// green when fitting the camera to it.
    public func expanded(byMeters meters: Double) -> MapCoordinateBounds {
        guard meters > 0 else { return self }
        let metersPerDegreeLat = 111_320.0
        let dLat = meters / metersPerDegreeLat
        let cosLat = max(cos((south + north) / 2 * .pi / 180), 0.01)
        let dLon = meters / (metersPerDegreeLat * cosLat)
        return MapCoordinateBounds(
            west: west - dLon,
            south: south - dLat,
            east: east + dLon,
            north: north + dLat
        )
    }
}

/// Everything `CourseMapView` needs to render one downloaded course bundle.
/// Deliberately plain values (no store/database dependency) so the map can be
/// driven from previews and tests; a convenience init adapts the Store's
/// `TileManifestRecord`.
public struct CourseMapConfiguration: Equatable, Sendable {
    /// The course's bundle directory (contains `features.geojson` and
    /// `tiles/ortho/{z}/{x}/{y}.jpg`), e.g. `BundlePaths.courseDirectory(courseId:)`.
    public var bundleDirectory: URL
    /// Native zoom range of the ortho tile pyramid (manifest values). The map
    /// overzooms past `orthoMaxZoom` up to `MapStyleBuilder.mapMaxZoom`.
    public var orthoMinZoom: Int
    public var orthoMaxZoom: Int
    /// WGS84 coverage bounds of the tile pyramid (manifest values).
    public var bounds: MapCoordinateBounds
    /// Imagery attribution shown in the MapLibre attribution sheet
    /// (e.g. "© Lantmäteriet, CC BY 4.0").
    public var attribution: String?
    /// Native zoom range of the optional `canopy-color` raster layer
    /// (`tiles/canopy-color/{z}/{x}/{y}.png`). Nil = the bundle has no canopy
    /// layer, so the style declares no canopy source and the "Trees" toggle
    /// is hidden.
    public var canopyColorZoomRange: ClosedRange<Int>?

    public var hasCanopyColor: Bool { canopyColorZoomRange != nil }

    public init(
        bundleDirectory: URL,
        orthoMinZoom: Int,
        orthoMaxZoom: Int,
        bounds: MapCoordinateBounds,
        attribution: String? = nil,
        canopyColorZoomRange: ClosedRange<Int>? = nil
    ) {
        self.bundleDirectory = bundleDirectory
        self.orthoMinZoom = orthoMinZoom
        self.orthoMaxZoom = orthoMaxZoom
        self.bounds = bounds
        self.attribution = attribution
        self.canopyColorZoomRange = canopyColorZoomRange
    }

    /// Adapt the Store's tile manifest record. The canopy layer is declared
    /// only when the manifest lists it AND its tiles landed in the bundle (the
    /// downloader skips an optional layer the server had no tiles for).
    public init(bundleDirectory: URL, manifest: TileManifestRecord, attribution: String? = nil) {
        self.init(
            bundleDirectory: bundleDirectory,
            // Guarded (an undeclared min would render as z0); the MAXzoom stays
            // raw because `OrthoZoomPolicy` applies its own fallback.
            orthoMinZoom: manifest.orthoStyleMinZoom,
            orthoMaxZoom: manifest.orthoMaxZoom,
            bounds: MapCoordinateBounds(
                west: manifest.west,
                south: manifest.south,
                east: manifest.east,
                north: manifest.north
            ),
            attribution: attribution,
            canopyColorZoomRange: Self.installedZoomRange(
                for: .canopyColor, bundleDirectory: bundleDirectory, manifest: manifest
            )
        )
    }

    /// The manifest's zoom range for an optional layer when its tile directory
    /// exists in the bundle; nil when either the manifest omits the layer or
    /// nothing was downloaded for it.
    static func installedZoomRange(
        for layer: TileLayer,
        bundleDirectory: URL,
        manifest: TileManifestRecord
    ) -> ClosedRange<Int>? {
        guard let range = manifest.zoomRange(for: layer) else { return nil }
        let directory = bundleDirectory
            .appending(path: "tiles", directoryHint: .isDirectory)
            .appending(path: layer.rawValue, directoryHint: .isDirectory)
        guard FileManager.default.fileExists(atPath: directory.path(percentEncoded: false)) else {
            return nil
        }
        return range
    }
}
