import XCTest
@testable import GolfMap

/// Upload state machine against the server contract
/// (server/api/photos.routes.ts): create → PUT original → PUT preview.
final class PhotoSyncTests: XCTestCase {
    private let create = "POST /api/photos/create"
    private let original = "PUT /api/photos/file/p1?kind=original"
    private let preview = "PUT /api/photos/file/p1?kind=preview"
    private let stored = #"{"status":"stored"}"#

    private var database: AppDatabase!
    private var files: PhotoFiles!
    private var clock: TestClock!
    private var sync: PhotoSyncService!

    override func setUp() async throws {
        PhotoStubProtocol.state.reset()
        database = try AppDatabase.inMemory()
        files = try PhotoFixtures.temporaryFiles()
        clock = TestClock(Date(timeIntervalSince1970: 1_790_000_000))
        let clock = clock!
        sync = PhotoSyncService(
            client: PhotoStubProtocol.makeClient(),
            database: database,
            files: files,
            now: { clock.now }
        )
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(atPath: files.rootDirectory.path(percentEncoded: false))
    }

    private func row(_ id: String = "p1") async throws -> ReferencePhotoRecord {
        let found = try await database.referencePhoto(id: id)
        return try XCTUnwrap(found)
    }

    // MARK: - Happy path

    func testCreateThenOriginalThenPreviewMarksSynced() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(200, "{}"))
        PhotoStubProtocol.state.script(original, .status(200, stored))
        PhotoStubProtocol.state.script(preview, .status(200, #"{"status":"unchanged"}"#))

        await sync.flush()

        let requests = PhotoStubProtocol.state.requests
        XCTAssertEqual(requests.map(\.key), [create, original, preview])

        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: requests[0].body) as? [String: Any])
        XCTAssertEqual(body["id"] as? String, "p1")
        XCTAssertEqual(requests[0].headers["Content-Type"], "application/json")

        XCTAssertEqual(requests[1].headers["Content-Type"], "image/heic")
        XCTAssertEqual(requests[1].headers["X-Content-SHA256"], PhotoFiles.sha256Hex(PhotoFixtures.originalBytes("p1")))
        XCTAssertEqual(requests[1].body, PhotoFixtures.originalBytes("p1"))

        XCTAssertEqual(requests[2].headers["Content-Type"], "image/jpeg")
        XCTAssertEqual(requests[2].headers["X-Content-SHA256"], PhotoFiles.sha256Hex(PhotoFixtures.previewBytes("p1")))
        XCTAssertEqual(requests[2].body, PhotoFixtures.previewBytes("p1"))

        let r = try await row()
        XCTAssertEqual(r.syncState, .synced)
        XCTAssertNotNil(r.createdOnServerAt)
        XCTAssertNotNil(r.originalUploadedAt)
        XCTAssertNotNil(r.previewUploadedAt)
        XCTAssertNotNil(r.syncedAt)
        XCTAssertNil(r.lastError)

        // Synced rows are not sent again.
        await sync.flush()
        XCTAssertEqual(PhotoStubProtocol.state.requests.count, 3)
    }

    func testShaHeaderIsLowercaseHex() {
        let hex = PhotoFiles.sha256Hex(Data("abc".utf8))
        XCTAssertEqual(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testResumeSkipsStepsAlreadyDone() async throws {
        var record = PhotoFixtures.record()
        record.createdOnServerAt = "2026-10-02T09:15:00Z"
        record.originalUploadedAt = "2026-10-02T09:15:01Z"
        try await PhotoFixtures.store(record, database: database, files: files)
        PhotoStubProtocol.state.script(preview, .status(200, stored))

        await sync.flush()

        XCTAssertEqual(PhotoStubProtocol.state.keys, [preview])
        let synced = try await row().syncState
        XCTAssertEqual(synced, .synced)
    }

    // MARK: - Hard errors

    func testConflictOnFileIsHardFailure() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(200, "{}"))
        PhotoStubProtocol.state.script(original, .status(409, #"{"error":"hash differs"}"#))

        await sync.flush()

        XCTAssertEqual(PhotoStubProtocol.state.keys, [create, original])
        let r = try await row()
        XCTAssertEqual(r.syncState, .failed)
        XCTAssertNotNil(r.createdOnServerAt)
        XCTAssertNil(r.originalUploadedAt)
        XCTAssertTrue(r.lastError?.hasPrefix("409") == true, r.lastError ?? "")

        // Failed rows are out of the queue until a retry.
        clock.advance(7200)
        await sync.flush()
        XCTAssertEqual(PhotoStubProtocol.state.requests.count, 2)

        await sync.retry(id: "p1")
        let retried = try await row()
        XCTAssertEqual(retried.syncState, .pending)
        XCTAssertNil(retried.lastError)
        PhotoStubProtocol.state.script(original, .status(200, stored))
        PhotoStubProtocol.state.script(preview, .status(200, stored))
        await sync.flush()
        XCTAssertEqual(PhotoStubProtocol.state.keys, [create, original, original, preview])
        let state = try await row().syncState
        XCTAssertEqual(state, .synced)
    }

    func testUnknownSiteOnCreateIsHardFailure() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(404, #"{"error":"unknown site"}"#))

        await sync.flush()

        XCTAssertEqual(PhotoStubProtocol.state.keys, [create])
        let r = try await row()
        XCTAssertEqual(r.syncState, .failed)
        XCTAssertTrue(r.lastError?.contains("404 create") == true, r.lastError ?? "")
    }

    func testTooLargeIsHardFailure() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(200, "{}"))
        PhotoStubProtocol.state.script(original, .status(413, #"{"error":"too large"}"#))

        await sync.flush()

        let state = try await row().syncState
        XCTAssertEqual(state, .failed)
    }

    func testMissingLocalFileIsHardFailure() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        files.remove("p1.heic")
        PhotoStubProtocol.state.script(create, .status(200, "{}"))

        await sync.flush()

        XCTAssertEqual(PhotoStubProtocol.state.keys, [create])
        let r = try await row()
        XCTAssertEqual(r.syncState, .failed)
        XCTAssertTrue(r.lastError?.contains("p1.heic") == true)
    }

    // MARK: - 404 on a file PUT

    func testUnknownIdOnPutRedoesCreateOnce() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(200, "{}"))
        PhotoStubProtocol.state.script(original, .status(404, #"{"error":"unknown photo"}"#), .status(200, stored))
        PhotoStubProtocol.state.script(preview, .status(200, stored))

        await sync.flush()

        XCTAssertEqual(PhotoStubProtocol.state.keys, [create, original, create, original, preview])
        let state = try await row().syncState
        XCTAssertEqual(state, .synced)
    }

    func testRepeated404OnPutBacksOff() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(200, "{}"))
        PhotoStubProtocol.state.script(original, .status(404, "{}"))

        await sync.flush()

        XCTAssertEqual(PhotoStubProtocol.state.keys, [create, original, create, original])
        let r = try await row()
        XCTAssertEqual(r.syncState, .pending)
        XCTAssertEqual(r.attemptCount, 1)
        XCTAssertTrue(r.lastError?.hasPrefix("404 upload") == true, r.lastError ?? "")
    }

    // MARK: - Retryable errors and backoff

    func testServerErrorBacksOffAndGatesTheNextFlush() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(500, #"{"error":"boom"}"#))
        let t0 = clock.now.timeIntervalSince1970

        await sync.flush()
        var r = try await row()
        XCTAssertEqual(r.syncState, .pending)
        XCTAssertEqual(r.attemptCount, 1)
        XCTAssertEqual(r.nextAttemptAt, t0 + 30)
        XCTAssertEqual(r.lastError, "HTTP 500: boom.")

        // Inside the backoff window nothing is sent.
        clock.advance(29)
        await sync.flush()
        XCTAssertEqual(PhotoStubProtocol.state.requests.count, 1)

        // A user-triggered flush ignores it.
        await sync.flush(ignoringBackoff: true)
        XCTAssertEqual(PhotoStubProtocol.state.requests.count, 2)
        r = try await row()
        XCTAssertEqual(r.attemptCount, 2)
        XCTAssertEqual(r.nextAttemptAt, t0 + 29 + 60)

        clock.advance(61)
        PhotoStubProtocol.state.script(create, .status(200, "{}"))
        PhotoStubProtocol.state.script(original, .status(200, stored))
        PhotoStubProtocol.state.script(preview, .status(200, stored))
        await sync.flush()
        r = try await row()
        XCTAssertEqual(r.syncState, .synced)
        XCTAssertEqual(r.attemptCount, 0)
        XCTAssertNil(r.nextAttemptAt)
    }

    func testBackoffDoublesUpToTheCap() {
        XCTAssertEqual(PhotoSyncService.backoffDelay(attempt: 1), 30)
        XCTAssertEqual(PhotoSyncService.backoffDelay(attempt: 2), 60)
        XCTAssertEqual(PhotoSyncService.backoffDelay(attempt: 5), 480)
        XCTAssertEqual(PhotoSyncService.backoffDelay(attempt: 20), 3600)
    }

    func testSchemaErrorOnCreateIsHard() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(400, #"{"error":"yawDeg"}"#))

        await sync.flush()

        let r = try await row()
        XCTAssertEqual(r.syncState, .failed)
        XCTAssertNil(r.nextAttemptAt)
        XCTAssertTrue(r.lastError?.hasPrefix("400 create:") == true, r.lastError ?? "nil")
    }

    func testUnauthorizedBacksOff() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(), database: database, files: files)
        PhotoStubProtocol.state.script(create, .status(401, "{}"))

        await sync.flush()

        let r = try await row()
        XCTAssertEqual(r.syncState, .pending)
        XCTAssertEqual(r.attemptCount, 1)
    }

    func testTransportErrorEndsThePass() async throws {
        try await PhotoFixtures.store(PhotoFixtures.record(id: "p1", capturedAt: "2026-10-02T09:00:00Z"), database: database, files: files)
        try await PhotoFixtures.store(PhotoFixtures.record(id: "p2", capturedAt: "2026-10-02T09:01:00Z"), database: database, files: files)
        PhotoStubProtocol.state.script(create, .networkDown)

        await sync.flush()

        // Oldest first; the second row is not tried on a dead network.
        XCTAssertEqual(PhotoStubProtocol.state.requests.count, 1)
        let first = try await row("p1")
        let second = try await row("p2")
        XCTAssertEqual(first.attemptCount, 1)
        XCTAssertTrue(first.lastError?.hasPrefix("Network") == true)
        XCTAssertEqual(second.attemptCount, 0)
        XCTAssertEqual(second.syncState, .pending)
    }

    // MARK: - Retention

    func testOriginalIsDeletedSevenDaysAfterSync() async throws {
        var old = PhotoFixtures.record(id: "old")
        old.syncState = .synced
        old.syncedAt = DeviceInfo.iso8601(clock.now.addingTimeInterval(-8 * 24 * 3600))
        var recent = PhotoFixtures.record(id: "recent")
        recent.syncState = .synced
        recent.syncedAt = DeviceInfo.iso8601(clock.now.addingTimeInterval(-6 * 24 * 3600))
        try await PhotoFixtures.store(old, database: database, files: files)
        try await PhotoFixtures.store(recent, database: database, files: files)

        await sync.flush()

        XCTAssertFalse(files.exists("old.heic"))
        XCTAssertTrue(files.exists("old.jpg"))
        XCTAssertTrue(files.exists("old-thumb.jpg"))
        let oldDeleted = try await row("old").originalDeletedAt
        XCTAssertNotNil(oldDeleted)

        XCTAssertTrue(files.exists("recent.heic"))
        let recentDeleted = try await row("recent").originalDeletedAt
        XCTAssertNil(recentDeleted)
        XCTAssertTrue(PhotoStubProtocol.state.requests.isEmpty)
    }
}
