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

    public init(
        bundleDirectory: URL,
        orthoMinZoom: Int,
        orthoMaxZoom: Int,
        bounds: MapCoordinateBounds,
        attribution: String? = nil
    ) {
        self.bundleDirectory = bundleDirectory
        self.orthoMinZoom = orthoMinZoom
        self.orthoMaxZoom = orthoMaxZoom
        self.bounds = bounds
        self.attribution = attribution
    }

    /// Adapt the Store's tile manifest record.
    public init(bundleDirectory: URL, manifest: TileManifestRecord, attribution: String? = nil) {
        self.init(
            bundleDirectory: bundleDirectory,
            orthoMinZoom: manifest.orthoMinZoom,
            orthoMaxZoom: manifest.orthoMaxZoom,
            bounds: MapCoordinateBounds(
                west: manifest.west,
                south: manifest.south,
                east: manifest.east,
                north: manifest.north
            ),
            attribution: attribution
        )
    }
}
