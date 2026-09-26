import Foundation
import GRDB

/// Upload lifecycle of a reference photo (docs/feature-reference-photos.md §4.3).
public enum PhotoSyncState: String, Codable, Sendable {
    /// The server still lacks the row or at least one file.
    case pending
    /// Row, original and preview confirmed by the server.
    case synced
    /// The server answered 409: a file with a different hash already exists
    /// for this id. Retrying cannot fix it, so the list shows it as an error.
    case failed
}

/// Where yaw 0 points in the stored attitude. `magnetic` means CoreMotion ran
/// in `.xMagneticNorthZVertical`; the capture then rotates the quaternion into
/// true north with the `CLHeading` declination when one is available
/// (`declinationDeg` set) and leaves it magnetic otherwise.
public enum PhotoNorthReference: String, Codable, Sendable {
    case trueNorth = "true"
    case magnetic
}

/// One reference photo, schema v12. The device is the writer; the server
/// (`site_photos`) is the sink. The column names match the §4.2 contract
/// except `attitudeQuat`, which is split into four columns, and the local-only
/// capture and sync fields at the end.
public struct ReferencePhotoRecord: Codable, Sendable, Equatable, FetchableRecord, PersistableRecord {
    public static let databaseTableName = "reference_photos"

    public var id: String
    public var siteId: String
    public var courseId: String?
    public var hole: Int?
    /// ISO-8601 UTC, e.g. `2026-10-02T09:14:31Z`.
    public var capturedAt: String
    public var lat: Double
    public var lon: Double
    public var hAccM: Double
    public var gpsAltM: Double?
    public var vAccM: Double?
    public var quatW: Double
    public var quatX: Double
    public var quatY: Double
    public var quatZ: Double
    public var yawDeg: Double
    public var pitchDeg: Double
    public var rollDeg: Double
    public var headingAccDeg: Double?
    /// `CMMagneticFieldCalibrationAccuracy` raw value: -1 uncalibrated,
    /// 0 low, 1 medium, 2 high.
    public var magCalibration: Int?
    public var hfovDeg: Double
    public var vfovDeg: Double
    public var width: Int
    public var height: Int
    public var eyeHeightM: Double
    public var deviceModel: String?
    public var lens: String
    public var tags: [String]
    public var note: String?

    // Local capture facts.
    public var northReference: PhotoNorthReference
    public var declinationDeg: Double?
    /// `CameraPoseMath.ImageUp` raw value read back from the file's EXIF.
    public var imageUp: String
    public var isStationary: Bool
    public var maxRotationRateRadS: Double

    // Files, relative to `PhotoFiles.rootDirectory`.
    public var originalFile: String
    public var previewFile: String
    public var thumbnailFile: String
    public var originalSha256: String
    public var originalBytes: Int
    public var previewSha256: String
    public var previewBytes: Int

    // Sync.
    public var syncState: PhotoSyncState
    public var createdOnServerAt: String?
    public var originalUploadedAt: String?
    public var previewUploadedAt: String?
    /// When both files were confirmed. The HEIC is deleted 7 days later.
    public var syncedAt: String?
    public var originalDeletedAt: String?
    public var attemptCount: Int
    /// Seconds since 1970. Flush skips the row until then.
    public var nextAttemptAt: Double?
    public var lastError: String?

    var attitudeQuat: CameraPoseMath.Quat {
        CameraPoseMath.Quat(w: quatW, x: quatX, y: quatY, z: quatZ)
    }
}

// MARK: - Upload contract

/// The `POST /api/photos/create` body: exactly the §4.2 field names.
/// Optional fields go out as explicit JSON null.
struct CreatePhotoBody: Encodable, Equatable {
    struct AttitudeQuat: Encodable, Equatable {
        var w: Double
        var x: Double
        var y: Double
        var z: Double
    }

    var id: String
    var siteId: String
    var courseId: String?
    var hole: Int?
    var capturedAt: String
    var lat: Double
    var lon: Double
    var hAccM: Double
    var gpsAltM: Double?
    var vAccM: Double?
    var attitudeQuat: AttitudeQuat
    var yawDeg: Double
    var pitchDeg: Double
    var rollDeg: Double
    var headingAccDeg: Double?
    var magCalibration: Int?
    var hfovDeg: Double
    var vfovDeg: Double
    var width: Int
    var height: Int
    var eyeHeightM: Double
    var deviceModel: String?
    var lens: String
    var tags: [String]
    var note: String?

    init(_ r: ReferencePhotoRecord) {
        id = r.id
        siteId = r.siteId
        courseId = r.courseId
        hole = r.hole
        capturedAt = r.capturedAt
        lat = r.lat
        lon = r.lon
        hAccM = r.hAccM
        gpsAltM = r.gpsAltM
        vAccM = r.vAccM
        attitudeQuat = AttitudeQuat(w: r.quatW, x: r.quatX, y: r.quatY, z: r.quatZ)
        yawDeg = Self.wrapYaw(r.yawDeg)
        pitchDeg = min(90, max(-90, r.pitchDeg))
        rollDeg = Self.wrapRoll(r.rollDeg)
        headingAccDeg = r.headingAccDeg
        magCalibration = r.magCalibration
        hfovDeg = r.hfovDeg
        vfovDeg = r.vfovDeg
        width = r.width
        height = r.height
        eyeHeightM = r.eyeHeightM
        deviceModel = r.deviceModel
        lens = r.lens
        tags = r.tags
        note = r.note
    }

    /// [0, 360): the server rejects 360.
    static func wrapYaw(_ deg: Double) -> Double {
        var y = fmod(deg, 360)
        if y < 0 { y += 360 }
        return y >= 360 ? 0 : y
    }

    /// (-180, 180]: the server rejects -180.
    static func wrapRoll(_ deg: Double) -> Double {
        var r = fmod(deg, 360)
        if r > 180 { r -= 360 }
        if r <= -180 { r += 360 }
        return r
    }

    private enum CodingKeys: String, CodingKey {
        case id, siteId, courseId, hole, capturedAt, lat, lon, hAccM, gpsAltM, vAccM
        case attitudeQuat, yawDeg, pitchDeg, rollDeg, headingAccDeg, magCalibration
        case hfovDeg, vfovDeg, width, height, eyeHeightM, deviceModel, lens, tags, note
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(siteId, forKey: .siteId)
        try c.encode(courseId, forKey: .courseId)
        try c.encode(hole, forKey: .hole)
        try c.encode(capturedAt, forKey: .capturedAt)
        try c.encode(lat, forKey: .lat)
        try c.encode(lon, forKey: .lon)
        try c.encode(hAccM, forKey: .hAccM)
        try c.encode(gpsAltM, forKey: .gpsAltM)
        try c.encode(vAccM, forKey: .vAccM)
        try c.encode(attitudeQuat, forKey: .attitudeQuat)
        try c.encode(yawDeg, forKey: .yawDeg)
        try c.encode(pitchDeg, forKey: .pitchDeg)
        try c.encode(rollDeg, forKey: .rollDeg)
        try c.encode(headingAccDeg, forKey: .headingAccDeg)
        try c.encode(magCalibration, forKey: .magCalibration)
        try c.encode(hfovDeg, forKey: .hfovDeg)
        try c.encode(vfovDeg, forKey: .vfovDeg)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(eyeHeightM, forKey: .eyeHeightM)
        try c.encode(deviceModel, forKey: .deviceModel)
        try c.encode(lens, forKey: .lens)
        try c.encode(tags, forKey: .tags)
        try c.encode(note, forKey: .note)
    }
}

// MARK: - Store

extension AppDatabase {
    public func saveReferencePhoto(_ photo: ReferencePhotoRecord) async throws {
        try await dbQueue.write { db in try photo.save(db) }
    }

    public func referencePhoto(id: String) async throws -> ReferencePhotoRecord? {
        try await dbQueue.read { db in try ReferencePhotoRecord.fetchOne(db, key: id) }
    }

    /// A site's photos, newest first.
    public func referencePhotos(siteId: String) async throws -> [ReferencePhotoRecord] {
        try await dbQueue.read { db in
            try ReferencePhotoRecord
                .filter(Column("siteId") == siteId)
                .order(Column("capturedAt").desc)
                .fetchAll(db)
        }
    }

    /// Pending photos, oldest first. Rows in backoff until after `now` are
    /// skipped unless `ignoringBackoff`.
    public func referencePhotosNeedingSync(now: Date, ignoringBackoff: Bool = false) async throws -> [ReferencePhotoRecord] {
        let t = now.timeIntervalSince1970
        return try await dbQueue.read { db in
            var request = ReferencePhotoRecord
                .filter(Column("syncState") == PhotoSyncState.pending.rawValue)
            if !ignoringBackoff {
                request = request.filter(Column("nextAttemptAt") == nil || Column("nextAttemptAt") <= t)
            }
            return try request.order(Column("capturedAt")).fetchAll(db)
        }
    }

    /// Synced photos whose HEIC is still on disk and was confirmed before `cutoff`.
    public func referencePhotosWithExpiredOriginal(syncedBefore cutoff: String) async throws -> [ReferencePhotoRecord] {
        try await dbQueue.read { db in
            try ReferencePhotoRecord
                .filter(Column("syncState") == PhotoSyncState.synced.rawValue)
                .filter(Column("originalDeletedAt") == nil)
                .filter(Column("syncedAt") != nil && Column("syncedAt") < cutoff)
                .fetchAll(db)
        }
    }

    /// Applies `change` to the fresh row inside one write, so a user edit to
    /// tags or hole made while an upload was in flight is not reverted.
    @discardableResult
    public func updateReferencePhoto(
        id: String,
        _ change: @Sendable @escaping (inout ReferencePhotoRecord) -> Void
    ) async throws -> ReferencePhotoRecord? {
        try await dbQueue.write { db in
            guard var row = try ReferencePhotoRecord.fetchOne(db, key: id) else { return nil }
            change(&row)
            try row.update(db)
            return row
        }
    }

    public func deleteReferencePhoto(id: String) async throws {
        _ = try await dbQueue.write { db in try ReferencePhotoRecord.deleteOne(db, key: id) }
    }
}
