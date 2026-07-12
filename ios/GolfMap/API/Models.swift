import Foundation

// MARK: - Codable API models
//
// Transcribed from the server's shared/api/*.gen.ts response shapes.
// The server emits camelCase JSON, so no CodingKeys are required.
//
// Integer-semantic fields (version, revision, par, strokeIndex, sortOrder,
// total, offset, limit, holeCount, minzoom, maxzoom) are `Int`.
// Coordinates and elevations are `Double`. Dates arrive as strings and are
// kept as `String` — the app does not consume them.
//
// All models are `Sendable` value types so they can cross the actor boundary
// of `GolfAPIClient` under Swift 6 strict concurrency.

// MARK: Auth

/// `POST /api/auth/login` and `GET /api/auth/me` response.
public struct AuthUser: Codable, Sendable, Equatable {
    public let id: String
    public let username: String
}

/// `POST /api/auth/logout` response, and the generic `{ ok: true }` envelope.
public struct OKResponse: Codable, Sendable, Equatable {
    public let ok: Bool
}

// MARK: Meta

/// `GET /api/meta` — unauthenticated.
public struct Meta: Codable, Sendable, Equatable {
    public let name: String
    public let version: String
}

// MARK: Courses

/// A page of course summaries: `GET /api/courses`.
public struct CoursePage: Codable, Sendable, Equatable {
    public let items: [CourseSummary]
    public let total: Int
}

/// A row in the course list.
public struct CourseSummary: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let status: String
    public let revision: Int
    public let homeLat: Double?
    public let homeLon: Double?
    public let holeCount: Int
    public let updatedAt: String
}

/// Full course record: `GET /api/courses/get`.
public struct Course: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let status: String
    public let revision: Int
    public let crs: String
    public let georeferenceJson: String?
    public let homeLat: Double?
    public let homeLon: Double?
    public let notes: String?
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
}

// MARK: Holes

/// A hole: `GET /api/holes`.
public struct Hole: Codable, Sendable, Equatable {
    public let id: String
    public let courseId: String
    public let number: Int
    public let par: Int
    public let strokeIndex: Int?
    public let notes: String?
    public let savedRegionJson: String?
    public let version: Int
    public let createdAt: String
    public let updatedAt: String
}

// MARK: Tees

/// A tee marker: `GET /api/tees/by-course`.
public struct Tee: Codable, Sendable, Equatable {
    public let id: String
    public let holeId: String
    public let name: String
    public let color: String?
    public let lat: Double
    public let lon: Double
    public let elevation: Double?
    public let sortOrder: Int
    public let version: Int
}

// MARK: Greens

/// A green: `GET /api/greens` (returns a single object or JSON `null`).
public struct Green: Codable, Sendable, Equatable {
    public let id: String
    public let holeId: String
    public let boundaryJson: String?
    public let centerLat: Double
    public let centerLon: Double
    public let frontLat: Double?
    public let frontLon: Double?
    public let backLat: Double?
    public let backLon: Double?
    public let elevation: Double?
    public let version: Int
}

// MARK: Pins

/// A pin position: `GET /api/pins` and `GET /api/pins/by-course`.
public struct Pin: Codable, Sendable, Equatable {
    public let id: String
    public let greenId: String
    public let name: String
    public let lat: Double
    public let lon: Double
    public let difficulty: String?
    public let active: Bool
    public let version: Int
}

// MARK: Aim points

/// An aim point: `GET /api/aim-points`.
public struct AimPoint: Codable, Sendable, Equatable {
    public let id: String
    public let holeId: String
    public let sortOrder: Int
    public let lat: Double
    public let lon: Double
    public let elevation: Double?
    public let label: String?
    public let version: Int
}

// MARK: Assets

/// Kind of a course asset. Unknown kinds decode to `.unknown` rather than
/// throwing, so a new server-side kind never breaks the whole asset list.
public enum CourseAssetKind: String, Codable, Sendable, Equatable {
    case orthoCog = "ortho_cog"
    case demCog = "dem_cog"
    case svgSource = "svg_source"
    case tileManifest = "tile_manifest"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CourseAssetKind(rawValue: raw) ?? .unknown
    }
}

/// A course asset: `GET /api/assets/by-course`.
public struct CourseAsset: Codable, Sendable, Equatable {
    public let id: String
    public let courseId: String
    public let kind: CourseAssetKind
    public let filename: String
    public let metaJson: String?
    public let version: Int
    public let createdAt: String
    public let updatedAt: String

    /// Parses the embedded `tile_manifest` `metaJson` string, if present and valid.
    /// Returns nil for non-manifest assets or malformed JSON.
    public func tileManifest() -> TileManifest? {
        guard let metaJson, let data = metaJson.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(TileManifest.self, from: data)
    }
}

// MARK: Tile manifest

/// The parsed contents of a `tile_manifest` asset's `metaJson`.
public struct TileManifest: Codable, Sendable, Equatable {
    public struct Bounds: Codable, Sendable, Equatable {
        public let west: Double
        public let south: Double
        public let east: Double
        public let north: Double
    }

    public struct ZoomRange: Codable, Sendable, Equatable {
        public let minzoom: Int
        public let maxzoom: Int
    }

    public struct Layers: Codable, Sendable, Equatable {
        public let ortho: ZoomRange
        public let terrain: ZoomRange
    }

    public struct ElevationRange: Codable, Sendable, Equatable {
        public let min: Double
        public let max: Double
    }

    public let bounds: Bounds
    public let layers: Layers
    public let elevation: ElevationRange
    public let generatedAt: String
    public let attribution: String

    /// Cache-buster derived from `generatedAt` by stripping every character that
    /// is not a digit, `T`, or `Z`. e.g. `2026-07-04T08:28:59Z` → `20260704T082859Z`.
    public var versionParam: String {
        String(generatedAt.filter { $0.isNumber || $0 == "T" || $0 == "Z" })
    }
}

// MARK: - Course features (GeoJSON)
//
// `GET /api/features.geojson` returns a GeoJSON FeatureCollection of Polygon
// features. Downstream, MapLibre wants the raw bytes and the distance math
// wants plain polygon rings — so the client exposes both the raw `Data`
// (see `GolfAPIClient.featuresGeoJSONData`) and this lightweight decode.
//
// Coordinates are kept as plain `(lon, lat)` doubles; the client stays
// Foundation-only (no MapKit / CoreLocation).

/// A decoded course feature: its classification plus polygon rings.
public struct CourseFeature: Sendable, Equatable {
    /// A single (longitude, latitude) vertex — GeoJSON axis order.
    public struct Coordinate: Sendable, Equatable {
        public let lon: Double
        public let lat: Double
    }

    public let id: String
    public let courseId: String
    public let holeId: String?
    /// Feature classification, e.g. `fairway`, `green`, `bunker`, `water`.
    public let type: String
    /// Polygon rings; ring[0] is the outer ring, the rest are holes.
    public let rings: [[Coordinate]]
}

/// A GeoJSON FeatureCollection of course features. Decodes the subset the app
/// needs; ignores styling/foreign members.
public struct CourseFeatureCollection: Decodable, Sendable, Equatable {
    public let features: [CourseFeature]

    private enum CodingKeys: String, CodingKey { case features }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.features = try container.decode([Feature].self, forKey: .features).map(\.courseFeature)
    }

    /// Internal GeoJSON Feature decoder.
    private struct Feature: Decodable {
        let courseFeature: CourseFeature

        private enum CodingKeys: String, CodingKey { case id, properties, geometry }
        private struct Properties: Decodable {
            let courseId: String
            let holeId: String?
            let type: String
        }
        private struct Geometry: Decodable {
            // GeoJSON Polygon coordinates: [ring][vertex][lon, lat].
            let coordinates: [[[Double]]]
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let id = try c.decode(String.self, forKey: .id)
            let props = try c.decode(Properties.self, forKey: .properties)
            let geom = try c.decode(Geometry.self, forKey: .geometry)
            let rings: [[CourseFeature.Coordinate]] = geom.coordinates.map { ring in
                ring.compactMap { pair in
                    guard pair.count >= 2 else { return nil }
                    return CourseFeature.Coordinate(lon: pair[0], lat: pair[1])
                }
            }
            self.courseFeature = CourseFeature(
                id: id,
                courseId: props.courseId,
                holeId: props.holeId,
                type: props.type,
                rings: rings
            )
        }
    }
}

// MARK: - Green calibration (scan upload)

/// A stored green scan row, echoed back by `POST /api/green-calibration/scans`.
/// Mirrors `GreenScan` in `shared/api/green-calibration.gen.ts`.
public struct GreenScanRecord: Codable, Sendable, Equatable {
    public let id: String
    public let greenId: String
    public let kind: String
    public let capturedAt: String
    public let payloadJson: String
    public let qualityJson: String?
    public let createdAt: String
}

/// Per-green calibration summary (nil until enough scans accumulate).
/// Mirrors `GreenCalibration` in the shared gen.
public struct GreenCalibrationRecord: Codable, Sendable, Equatable {
    public let greenId: String
    public let biasJson: String?
    public let confidence: Double
    public let sampleCount: Int
    public let updatedAt: String
}

/// `POST /api/green-calibration/scans` response envelope.
public struct GreenScanIngestResponse: Codable, Sendable, Equatable {
    public let scan: GreenScanRecord
    public let calibration: GreenCalibrationRecord?
}

// MARK: - Green calibration (per-green confidence read)

/// One green's calibration confidence from `GET /api/green-calibration/confidence`
/// (`GreenConfidence` in `shared/api/green-calibration.gen.ts`) — the READ side
/// of the scan round-trip. `source` is `"scans"` (derived from accepted phone
/// scans; carries a fitted `bias` when a DEM comparison was possible) or
/// `"prior"` (the server's bare-DEM fallback). iOS consumes only `"scans"`
/// greens: the `"prior"` confidence (0.6) is tuned for the web's full-precision
/// DEM, not the iOS terrain tiles, so iOS keeps its own conservative default
/// there (doc feature-putting-green-reading §4.2 / PuttReadGeometry).
public struct GreenConfidenceDTO: Codable, Sendable, Equatable {
    public let greenId: String
    public let confidence: Double
    /// Weighted accepted-scan count (green 1.0, yellow 0.5).
    public let sampleCount: Double
    public let source: String
    /// Present only for a `"scans"` green with a fitted bias.
    public let bias: GreenBiasDTO?
}

/// Fitted low-frequency DEM tilt correction, rise/run fractions (EPSG:3006
/// east/north) — `GreenBias` in the shared gen.
public struct GreenBiasDTO: Codable, Sendable, Equatable {
    public let tiltE: Double
    public let tiltN: Double
}

/// `GET /api/green-calibration/confidence` response envelope.
public struct CourseConfidenceResponse: Codable, Sendable, Equatable {
    public let greens: [GreenConfidenceDTO]
}

// MARK: - Error envelope

/// The server's generic error body, `{ "error": string }`.
public struct APIErrorEnvelope: Codable, Sendable, Equatable {
    public let error: String
}
