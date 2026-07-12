import Foundation
import GRDB

// MARK: - Green calibration store record (schema v4)
//
// The read side of the green-scan round-trip: per-green calibration fetched on
// course open (cache-then-refresh, like the game plan) and consumed offline by
// the putt read (docs/feature-putting-green-reading.md §4.2). Only greens the
// server calibrated from real scans (`source == "scans"`) are cached — an
// uncalibrated green has no row, and the read falls back to the conservative
// terrain-tile default. Read-only viewer cache: no server version column (the
// device never edits these rows). Named `…CacheRecord` to avoid colliding with
// the API `GreenCalibrationRecord` (the scan-ingest response shape).

public struct GreenCalibrationCacheRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "greenCalibration"

    /// Server green ROW id (matches `GreenRecord.id`) — the calibration key.
    public var greenId: String
    /// FK to `course` so deleting a bundle wipes its calibration cache.
    public var courseId: String
    /// Agreement confidence (0..1) — replaces the terrain-tile default.
    public var confidence: Double
    /// Weighted accepted-scan count (green 1.0, yellow 0.5).
    public var sampleCount: Double
    /// Low-frequency DEM tilt correction, rise/run (EPSG:3006 east); nil when
    /// the server fitted no bias (e.g. no DEM at fit time).
    public var biasTiltE: Double?
    /// North component of the tilt correction; nil paired with `biasTiltE`.
    public var biasTiltN: Double?

    public init(
        greenId: String,
        courseId: String,
        confidence: Double,
        sampleCount: Double,
        biasTiltE: Double? = nil,
        biasTiltN: Double? = nil
    ) {
        self.greenId = greenId
        self.courseId = courseId
        self.confidence = confidence
        self.sampleCount = sampleCount
        self.biasTiltE = biasTiltE
        self.biasTiltN = biasTiltN
    }
}
