import Foundation
import GRDB

// MARK: - Store record types
//
// GRDB Codable records for the on-device course bundle store. These structs
// double as the Store module's input DTOs: the wiring layer adapts API models
// into these types, so Store stays importable/compilable without the API code.
// All coordinates are WGS84 lat/lon degrees (REAL columns).

/// Lifecycle of a course's offline bundle on this device.
public enum BundleState: String, Codable, Sendable, CaseIterable {
    /// No bundle downloaded (course known from the server list only).
    case none
    /// A download is in flight.
    case downloading
    /// Bundle files + furniture rows are fully on disk at `downloadedRevision`.
    case complete
    /// A complete bundle exists but the server has a newer revision.
    case stale
}

public struct CourseRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "course"

    public var id: String
    /// Courses on the same physical site share one offline map bundle.
    public var siteId: String?
    public var mapKey: String { siteId ?? id }
    public var name: String
    /// Server status string, e.g. "published".
    public var status: String
    /// Latest revision known from the server.
    public var revision: Int
    /// Revision of the bundle currently on disk (nil if never downloaded).
    public var downloadedRevision: Int?
    public var homeLat: Double?
    public var homeLon: Double?
    /// ISO-8601 timestamp string from the server.
    public var updatedAt: String
    public var bundleState: BundleState

    public init(
        id: String,
        siteId: String? = nil,
        name: String,
        status: String,
        revision: Int,
        downloadedRevision: Int? = nil,
        homeLat: Double? = nil,
        homeLon: Double? = nil,
        updatedAt: String,
        bundleState: BundleState = .none
    ) {
        self.id = id
        self.siteId = siteId
        self.name = name
        self.status = status
        self.revision = revision
        self.downloadedRevision = downloadedRevision
        self.homeLat = homeLat
        self.homeLon = homeLon
        self.updatedAt = updatedAt
        self.bundleState = bundleState
    }
}

/// Lifecycle metadata for tile files shared by downloaded courses at a site.
/// Rows only exist for fully promoted map directories.
public struct MapBundleRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "mapBundle"

    public var mapKey: String
    public var versionParam: String
    public var generatedAt: String

    public init(mapKey: String, versionParam: String, generatedAt: String) {
        self.mapKey = mapKey
        self.versionParam = versionParam
        self.generatedAt = generatedAt
    }
}

/// Two-phase removal plan: expensive files are removed first, then download
/// state is committed so filesystem errors remain recoverable from the UI.
public struct DownloadedCourseDataRemovalPlan: Sendable, Equatable {
    public var courseId: String
    public var mapKey: String
    public var removesMapBundle: Bool

    public init(courseId: String, mapKey: String, removesMapBundle: Bool) {
        self.courseId = courseId
        self.mapKey = mapKey
        self.removesMapBundle = removesMapBundle
    }
}

public struct HoleRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "hole"

    public var id: String
    public var courseId: String
    public var number: Int
    public var par: Int
    /// Stroke index / handicap 1–18 (nullable).
    public var strokeIndex: Int?

    public init(id: String, courseId: String, number: Int, par: Int, strokeIndex: Int? = nil) {
        self.id = id
        self.courseId = courseId
        self.number = number
        self.par = par
        self.strokeIndex = strokeIndex
    }
}

public struct TeeRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "tee"

    public var id: String
    public var holeId: String
    public var name: String
    public var color: String?
    public var lat: Double
    public var lon: Double
    public var elevation: Double?
    public var sortOrder: Int

    public init(
        id: String,
        holeId: String,
        name: String,
        color: String? = nil,
        lat: Double,
        lon: Double,
        elevation: Double? = nil,
        sortOrder: Int
    ) {
        self.id = id
        self.holeId = holeId
        self.name = name
        self.color = color
        self.lat = lat
        self.lon = lon
        self.elevation = elevation
        self.sortOrder = sortOrder
    }
}

public struct GreenRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "green"

    public var id: String
    /// One green per hole (UNIQUE).
    public var holeId: String
    public var centerLat: Double
    public var centerLon: Double
    public var frontLat: Double?
    public var frontLon: Double?
    public var backLat: Double?
    public var backLon: Double?
    public var elevation: Double?

    public init(
        id: String,
        holeId: String,
        centerLat: Double,
        centerLon: Double,
        frontLat: Double? = nil,
        frontLon: Double? = nil,
        backLat: Double? = nil,
        backLon: Double? = nil,
        elevation: Double? = nil
    ) {
        self.id = id
        self.holeId = holeId
        self.centerLat = centerLat
        self.centerLon = centerLon
        self.frontLat = frontLat
        self.frontLon = frontLon
        self.backLat = backLat
        self.backLon = backLon
        self.elevation = elevation
    }
}

public struct PinRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "pin"

    public var id: String
    public var greenId: String
    public var name: String
    public var lat: Double
    public var lon: Double
    public var difficulty: String?
    /// Stored as INTEGER 0/1.
    public var active: Bool

    public init(
        id: String,
        greenId: String,
        name: String,
        lat: Double,
        lon: Double,
        difficulty: String? = nil,
        active: Bool
    ) {
        self.id = id
        self.greenId = greenId
        self.name = name
        self.lat = lat
        self.lon = lon
        self.difficulty = difficulty
        self.active = active
    }
}

public struct AimPointRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "aimPoint"

    public var id: String
    public var holeId: String
    public var sortOrder: Int
    public var lat: Double
    public var lon: Double
    public var elevation: Double?
    public var label: String?

    public init(
        id: String,
        holeId: String,
        sortOrder: Int,
        lat: Double,
        lon: Double,
        elevation: Double? = nil,
        label: String? = nil
    ) {
        self.id = id
        self.holeId = holeId
        self.sortOrder = sortOrder
        self.lat = lat
        self.lon = lon
        self.elevation = elevation
        self.label = label
    }
}

/// Per-course tile manifest: WGS84 bounds, zoom ranges per layer, elevation
/// range for terrain-RGB decoding, and the cache-busting version parameter.
public struct TileManifestRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "tileManifest"

    /// Primary key — one manifest per course.
    public var courseId: String
    public var west: Double
    public var south: Double
    public var east: Double
    public var north: Double
    public var orthoMinZoom: Int
    public var orthoMaxZoom: Int
    public var terrainMinZoom: Int
    public var terrainMaxZoom: Int
    public var elevMin: Double
    public var elevMax: Double
    public var generatedAt: String
    public var versionParam: String
    /// Optional lidar layers (v11). Nil = the manifest did not list the layer,
    /// so the bundle has no tiles for it. Both bounds are set together.
    public var canopyMinZoom: Int?
    public var canopyMaxZoom: Int?
    public var canopyColorMinZoom: Int?
    public var canopyColorMaxZoom: Int?
    public var surfaceMinZoom: Int?
    public var surfaceMaxZoom: Int?

    public init(
        courseId: String,
        west: Double,
        south: Double,
        east: Double,
        north: Double,
        orthoMinZoom: Int,
        orthoMaxZoom: Int,
        terrainMinZoom: Int,
        terrainMaxZoom: Int,
        elevMin: Double,
        elevMax: Double,
        generatedAt: String,
        versionParam: String,
        canopyMinZoom: Int? = nil,
        canopyMaxZoom: Int? = nil,
        canopyColorMinZoom: Int? = nil,
        canopyColorMaxZoom: Int? = nil,
        surfaceMinZoom: Int? = nil,
        surfaceMaxZoom: Int? = nil
    ) {
        self.courseId = courseId
        self.west = west
        self.south = south
        self.east = east
        self.north = north
        self.orthoMinZoom = orthoMinZoom
        self.orthoMaxZoom = orthoMaxZoom
        self.terrainMinZoom = terrainMinZoom
        self.terrainMaxZoom = terrainMaxZoom
        self.elevMin = elevMin
        self.elevMax = elevMax
        self.generatedAt = generatedAt
        self.versionParam = versionParam
        self.canopyMinZoom = canopyMinZoom
        self.canopyMaxZoom = canopyMaxZoom
        self.canopyColorMinZoom = canopyColorMinZoom
        self.canopyColorMaxZoom = canopyColorMaxZoom
        self.surfaceMinZoom = surfaceMinZoom
        self.surfaceMaxZoom = surfaceMaxZoom
    }

    /// Native zoom range of an optional layer, nil when the manifest did not
    /// list it. The required layers (ortho, terrain) always return a range.
    public func zoomRange(for layer: TileLayer) -> ClosedRange<Int>? {
        func range(_ lo: Int?, _ hi: Int?) -> ClosedRange<Int>? {
            guard let lo, let hi, lo <= hi else { return nil }
            return lo...hi
        }
        switch layer {
        case .ortho: return orthoStyleMinZoom...max(orthoStyleMinZoom, orthoMaxZoom)
        case .terrain: return terrainMinZoom...max(terrainMinZoom, terrainQueryZoom)
        case .canopy: return range(canopyMinZoom, canopyMaxZoom)
        case .canopyColor: return range(canopyColorMinZoom, canopyColorMaxZoom)
        case .surface: return range(surfaceMinZoom, surfaceMaxZoom)
        }
    }

    /// Whether the manifest lists `layer` (required layers: always true).
    public func hasLayer(_ layer: TileLayer) -> Bool {
        zoomRange(for: layer) != nil
    }

    /// Fixed zoom the terrain sampler queries tiles at. Guards against a row
    /// written from a manifest that never declared the bound (0 would sample
    /// the world tile — see `TileManifest.ZoomRange.undeclared`).
    public var terrainQueryZoom: Int {
        terrainMaxZoom > TileManifest.ZoomRange.undeclared
            ? terrainMaxZoom
            : TileManifest.ZoomDefaults.terrainMaxZoom
    }

    /// Shallowest ortho level the style declares, guarded the same way.
    public var orthoStyleMinZoom: Int {
        orthoMinZoom > TileManifest.ZoomRange.undeclared
            ? orthoMinZoom
            : TileManifest.ZoomDefaults.orthoMinZoom
    }
}

/// Everything that goes into GRDB for one course bundle ("furniture" — the
/// structured rows, as opposed to the file payload of tiles + GeoJSON).
public struct CourseFurniture: Sendable, Equatable {
    public var course: CourseRecord
    public var holes: [HoleRecord]
    public var tees: [TeeRecord]
    public var greens: [GreenRecord]
    public var pins: [PinRecord]
    public var aimPoints: [AimPointRecord]
    public var manifest: TileManifestRecord

    public init(
        course: CourseRecord,
        holes: [HoleRecord],
        tees: [TeeRecord],
        greens: [GreenRecord],
        pins: [PinRecord],
        aimPoints: [AimPointRecord],
        manifest: TileManifestRecord
    ) {
        self.course = course
        self.holes = holes
        self.tees = tees
        self.greens = greens
        self.pins = pins
        self.aimPoints = aimPoints
        self.manifest = manifest
    }
}
