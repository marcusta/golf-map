import GRDB
import ImageIO
import XCTest
@testable import GolfMap

/// `POST /api/photos/create` body, the v12 table, capture-time files and the
/// nearest-hole pick.
final class PhotoStoreTests: XCTestCase {

    // MARK: - Create body

    /// The exact bytes sent for the fixture (JSONEncoder, sorted keys here
    /// only to make the comparison stable).
    func testCreateBodyExactJSON() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = String(decoding: try encoder.encode(CreatePhotoBody(PhotoFixtures.record())), as: UTF8.self)
        XCTAssertEqual(json, """
        {"attitudeQuat":{"w":0.5,"x":0.5,"y":-0.5,"z":-0.5},"capturedAt":"2026-10-02T09:14:31Z",\
        "courseId":"course-1","deviceModel":"iPhone17,1","eyeHeightM":1.5,"gpsAltM":42.5,"hAccM":3.5,\
        "headingAccDeg":8,"height":4032,"hfovDeg":50,"hole":7,"id":"p1","lat":59.25,"lens":"wide",\
        "lon":18.5,"magCalibration":2,"note":"left of the oak","pitchDeg":0,"rollDeg":0,\
        "siteId":"site-1","tags":["look","trees"],"vAccM":4,"vfovDeg":65.5,"width":3024,"yawDeg":0}
        """)
    }

    func testCreateBodySendsExplicitNulls() throws {
        var record = PhotoFixtures.record()
        record.courseId = nil
        record.hole = nil
        record.gpsAltM = nil
        record.vAccM = nil
        record.headingAccDeg = nil
        record.magCalibration = nil
        record.deviceModel = nil
        record.note = nil
        let object = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(CreatePhotoBody(record))) as? [String: Any]
        )
        XCTAssertEqual(object.count, 25)
        for key in ["courseId", "hole", "gpsAltM", "vAccM", "headingAccDeg", "magCalibration", "deviceModel", "note"] {
            XCTAssertTrue(object[key] is NSNull, "\(key) should be null")
        }
        // Local-only columns never leave the phone.
        for key in ["northReference", "declinationDeg", "imageUp", "isStationary", "syncState", "originalFile", "quatW"] {
            XCTAssertNil(object[key], key)
        }
    }

    func testCreateBodyWrapsAnglesIntoTheServerRanges() {
        XCTAssertEqual(CreatePhotoBody.wrapYaw(360), 0)
        XCTAssertEqual(CreatePhotoBody.wrapYaw(720.5), 0.5, accuracy: 1e-9)
        XCTAssertEqual(CreatePhotoBody.wrapYaw(-0.5), 359.5, accuracy: 1e-9)
        XCTAssertEqual(CreatePhotoBody.wrapYaw(-1e-15), 0)
        XCTAssertEqual(CreatePhotoBody.wrapYaw(359.9), 359.9, accuracy: 1e-9)
        XCTAssertEqual(CreatePhotoBody.wrapRoll(-180), 180)
        XCTAssertEqual(CreatePhotoBody.wrapRoll(180), 180)
        XCTAssertEqual(CreatePhotoBody.wrapRoll(190), -170, accuracy: 1e-9)
        XCTAssertEqual(CreatePhotoBody.wrapRoll(-190), 170, accuracy: 1e-9)
        XCTAssertEqual(CreatePhotoBody.wrapRoll(-179.5), -179.5, accuracy: 1e-9)

        var record = PhotoFixtures.record()
        record.yawDeg = 360
        record.rollDeg = -180
        record.pitchDeg = 90.0000001
        let body = CreatePhotoBody(record)
        XCTAssertEqual(body.yawDeg, 0)
        XCTAssertEqual(body.rollDeg, 180)
        XCTAssertEqual(body.pitchDeg, 90)
    }

    // MARK: - Table

    func testMigrationCreatesReferencePhotosTable() throws {
        let database = try AppDatabase.inMemory()
        let columns = try database.dbQueue.read { db in
            try db.columns(in: "reference_photos").map(\.name)
        }
        for name in ["id", "siteId", "hfovDeg", "tags", "syncState", "nextAttemptAt", "originalDeletedAt"] {
            XCTAssertTrue(columns.contains(name), "missing column \(name)")
        }
    }

    func testRecordRoundTripsAndListsNewestFirst() async throws {
        let database = try AppDatabase.inMemory()
        var a = PhotoFixtures.record(id: "a", capturedAt: "2026-10-02T09:00:00Z")
        a.northReference = .magnetic
        a.declinationDeg = 6.25
        let b = PhotoFixtures.record(id: "b", capturedAt: "2026-10-02T10:00:00Z")
        var other = PhotoFixtures.record(id: "c")
        other.siteId = "site-2"
        try await database.saveReferencePhoto(a)
        try await database.saveReferencePhoto(b)
        try await database.saveReferencePhoto(other)

        let loaded = try await database.referencePhoto(id: "a")
        XCTAssertEqual(loaded, a)
        let ids = try await database.referencePhotos(siteId: "site-1").map(\.id)
        XCTAssertEqual(ids, ["b", "a"])
    }

    // MARK: - Files

    func testWriteMakesPreviewAndThumbnailWithOrientationApplied() throws {
        let files = try PhotoFixtures.temporaryFiles()
        defer { try? FileManager.default.removeItem(atPath: files.rootDirectory.path(percentEncoded: false)) }
        // A landscape sensor frame tagged EXIF 6 (portrait hold).
        let original = PhotoFixtures.jpeg(width: 3000, height: 2250, orientation: 6)

        let written = try files.write(id: "x1", original: original)

        XCTAssertEqual(written.exifOrientation, 6)
        XCTAssertEqual(written.width, 2250)
        XCTAssertEqual(written.height, 3000)
        XCTAssertEqual(written.originalFile, "x1.heic")
        XCTAssertEqual(written.originalBytes, original.count)
        XCTAssertEqual(written.originalSha256, PhotoFiles.sha256Hex(original))
        XCTAssertEqual(try files.read("x1.heic"), original)

        let preview = try files.read(written.previewFile)
        XCTAssertEqual(written.previewSha256, PhotoFiles.sha256Hex(preview))
        XCTAssertEqual(written.previewBytes, preview.count)
        XCTAssertEqual(try Self.size(preview), CGSize(width: 1536, height: 2048))
        XCTAssertEqual(try Self.size(files.read(written.thumbnailFile)), CGSize(width: 384, height: 512))
    }

    func testWriteRejectsNonImageData() throws {
        let files = try PhotoFixtures.temporaryFiles()
        defer { try? FileManager.default.removeItem(atPath: files.rootDirectory.path(percentEncoded: false)) }
        XCTAssertThrowsError(try files.write(id: "bad", original: Data("nope".utf8))) { error in
            XCTAssertEqual(error as? PhotoFiles.WriteError, .unreadableImage)
        }
    }

    /// Pixel size of an encoded JPEG after its own orientation tag (none).
    private static func size(_ data: Data) throws -> CGSize {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let props = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        XCTAssertEqual((props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1, 1)
        return CGSize(
            width: try XCTUnwrap(props[kCGImagePropertyPixelWidth] as? Int),
            height: try XCTUnwrap(props[kCGImagePropertyPixelHeight] as? Int)
        )
    }

    // MARK: - Nearest hole

    func testNearestHolePicksTheClosestPlayLine() {
        // Two parallel north-running holes about 110 m apart at 59.3° N.
        let lines = [
            NearestHole.Line(number: 1, points: [LatLon(lat: 59.300, lon: 18.000), LatLon(lat: 59.303, lon: 18.000)]),
            NearestHole.Line(number: 2, points: [LatLon(lat: 59.300, lon: 18.002), LatLon(lat: 59.303, lon: 18.002)]),
            NearestHole.Line(number: 3, points: []),
        ]
        XCTAssertEqual(NearestHole.number(at: LatLon(lat: 59.3015, lon: 18.0004), lines: lines), 1)
        XCTAssertEqual(NearestHole.number(at: LatLon(lat: 59.3015, lon: 18.0016), lines: lines), 2)
        XCTAssertNil(NearestHole.number(at: LatLon(lat: 59.3, lon: 18), lines: [lines[2]]))

        // Point-to-segment, not point-to-vertex: mid-hole is ~23 m off line 1.
        let d = NearestHole.distance(from: LatLon(lat: 59.3015, lon: 18.0004), to: lines[0].points)
        XCTAssertEqual(d, 22.8, accuracy: 1.0)
    }
}
