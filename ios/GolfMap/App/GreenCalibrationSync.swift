import Foundation

/// Fetch + cache wiring for the per-green calibration the putt read consumes —
/// the READ side of the green-scan round-trip (docs/feature-putting-green-
/// reading.md §4.2). The phone already uploads scans (spot-level + corridor);
/// this pulls the server's fitted per-green confidence + bias back down and
/// mirrors it into GRDB so offline rounds benefit.
///
/// Same design as `GamePlanSync`: pure static adapters (API DTO → Store record
/// / domain value) so they're unit-testable from fixtures without I/O, plus a
/// thin async `refresh`/`load`. Fetch failures are the CALLER's to swallow —
/// on course open a failed refresh degrades silently to the last cache (or,
/// with nothing cached, to the plain uncalibrated terrain-tile read).
enum GreenCalibrationSync {

    // MARK: - Fetch + store

    /// Fetches the course's per-green confidence and replaces the local cache.
    /// Only greens actually calibrated from scans (`source == "scans"`) are
    /// stored: a `"prior"` green carries the server's DEM confidence (0.6),
    /// which is tuned for the web's full-precision DEM, NOT the iOS terrain
    /// tiles — so iOS keeps its own conservative default for those (doc §4.2).
    /// Throws on any network/decode/DB error; the caller keeps the prior cache.
    static func refresh(client: GolfAPIClient, database: AppDatabase, courseId: String) async throws {
        let confidences = try await client.courseConfidence(courseId: courseId)
        let records = confidences.compactMap { record(courseId: courseId, $0) }
        try await database.saveGreenCalibrations(courseId: courseId, records)
    }

    /// Reads the cached calibration for a course as a greenId → calibration
    /// lookup the putt read applies when a green view is entered.
    static func load(database: AppDatabase, courseId: String) async throws -> [String: GreenCalibration] {
        let rows = try await database.greenCalibrations(courseId: courseId)
        return Dictionary(
            rows.map { ($0.greenId, calibration(from: $0)) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    // MARK: - Pure adapters (API DTO ↔ store record ↔ domain value)

    /// API confidence DTO → store record, or nil for an uncalibrated
    /// (`"prior"`) green — no row is cached and the read stays on the
    /// terrain-tile default. Pure; no I/O.
    static func record(courseId: String, _ dto: GreenConfidenceDTO) -> GreenCalibrationCacheRecord? {
        guard dto.source == "scans" else { return nil }
        return GreenCalibrationCacheRecord(
            greenId: dto.greenId,
            courseId: courseId,
            confidence: dto.confidence,
            sampleCount: dto.sampleCount,
            biasTiltE: dto.bias?.tiltE,
            biasTiltN: dto.bias?.tiltN
        )
    }

    /// Store record → domain calibration consumed by `PuttReadModel`. A row
    /// with only one tilt component (shouldn't happen — they're written as a
    /// pair) drops the bias defensively.
    static func calibration(from record: GreenCalibrationCacheRecord) -> GreenCalibration {
        let bias: GreenBias?
        if let e = record.biasTiltE, let n = record.biasTiltN {
            bias = GreenBias(tiltE: e, tiltN: n)
        } else {
            bias = nil
        }
        return GreenCalibration(
            greenId: record.greenId,
            confidence: record.confidence,
            sampleCount: record.sampleCount,
            bias: bias
        )
    }
}
