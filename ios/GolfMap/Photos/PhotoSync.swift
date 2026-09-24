import Foundation
import UIKit

/// Uploads captured reference photos (docs/feature-reference-photos.md §4.3,
/// server contract §5.2). The `reference_photos` row is the queue: each row
/// walks create → original → preview, and each step's success is stored on the
/// row, so a retry resumes where the last attempt stopped.
///
/// Status handling:
/// - 2xx: step done. A repeated create or PUT with the same hash returns 200.
/// - 401: `GolfAPIClient` re-logs in once and retries; if that fails the row
///   backs off like any other retryable error.
/// - 400 on create: the server rejects the fields; the same body fails again.
///   Hard error.
/// - 404 on create: the server has no such site. Hard error.
/// - 404 on a file PUT: the server lost or never stored the row. The create
///   step is redone once in the same pass.
/// - 409 on a file PUT: the server holds a different file for that kind.
///   Hard error. 413 (over 20 MB) is hard too; retrying sends the same bytes.
/// - Anything else, including transport errors: back off
///   `min(base · 2^(n-1), cap)` and retry on a later flush. A transport error
///   also ends the pass, since the next row would hit the same network.
///
/// Hard errors set `syncState = failed` and `lastError`; the photo list shows
/// them and offers a retry.
///
/// Transport: the existing `GolfAPIClient` in the foreground, not a background
/// `URLSession`. The client owns cookie-session relogin, which a background
/// session delegate would have to duplicate, and URLProtocol stubs do not run
/// in background sessions, so the state machine could not be tested. A photo
/// is about 3 MB and a flush runs on capture, on app foreground and from the
/// list screen; `beginBackgroundTask` gives a running flush time to finish
/// after the app leaves the foreground.
actor PhotoSyncService {
    private let client: GolfAPIClient
    private let database: AppDatabase
    private let files: PhotoFiles
    private let now: @Sendable () -> Date
    private var isFlushing = false

    static let backoffBaseS = 30.0
    static let backoffCapS = 3600.0
    /// The HEIC stays on the phone this long after both files are confirmed.
    static let originalRetentionS = 7 * 24 * 3600.0

    init(
        client: GolfAPIClient,
        database: AppDatabase,
        files: PhotoFiles,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.database = database
        self.files = files
        self.now = now
    }

    static func backoffDelay(attempt: Int) -> Double {
        min(backoffBaseS * pow(2, Double(max(attempt, 1) - 1)), backoffCapS)
    }

    /// Pushes every pending photo, then deletes expired originals.
    /// `ignoringBackoff` is for a user-triggered retry.
    func flush(ignoringBackoff: Bool = false) async {
        guard !isFlushing else { return }
        isFlushing = true
        defer { isFlushing = false }

        if let photos = try? await database.referencePhotosNeedingSync(now: now(), ignoringBackoff: ignoringBackoff) {
            for photo in photos {
                if await sync(photo) == .stopPass { break }
            }
        }
        await purgeExpiredOriginals()
    }

    /// Marks a failed photo pending again and clears its backoff.
    func retry(id: String) async {
        _ = try? await database.updateReferencePhoto(id: id) { row in
            guard row.syncState == .failed else { return }
            row.syncState = .pending
            row.attemptCount = 0
            row.nextAttemptAt = nil
            row.lastError = nil
        }
    }

    // MARK: - Per photo

    private enum Outcome { case done, retryLater, hardFailure, stopPass }

    private func sync(_ photo: ReferencePhotoRecord) async -> Outcome {
        var photo = photo
        var redidCreate = false

        while true {
            if photo.createdOnServerAt == nil {
                do {
                    try await client.createPhoto(CreatePhotoBody(photo))
                } catch {
                    return await record(error: error, photo: photo, step: "create")
                }
                guard let fresh = await mark(photo.id, { [stamp = DeviceInfo.iso8601(now())] in $0.createdOnServerAt = stamp })
                else { return .retryLater }
                photo = fresh
            }

            do {
                if photo.originalUploadedAt == nil {
                    try await upload(photo, kind: "original")
                    guard let fresh = await mark(photo.id, { [stamp = DeviceInfo.iso8601(now())] in $0.originalUploadedAt = stamp })
                    else { return .retryLater }
                    photo = fresh
                }
                if photo.previewUploadedAt == nil {
                    try await upload(photo, kind: "preview")
                    guard let fresh = await mark(photo.id, { [stamp = DeviceInfo.iso8601(now())] in $0.previewUploadedAt = stamp })
                    else { return .retryLater }
                    photo = fresh
                }
            } catch APIError.http(status: 404, _) where !redidCreate {
                redidCreate = true
                guard let fresh = await mark(photo.id, { $0.createdOnServerAt = nil }) else { return .retryLater }
                photo = fresh
                continue
            } catch {
                return await record(error: error, photo: photo, step: "upload")
            }

            let stamp = DeviceInfo.iso8601(now())
            _ = await mark(photo.id) { row in
                row.syncState = .synced
                row.syncedAt = stamp
                row.attemptCount = 0
                row.nextAttemptAt = nil
                row.lastError = nil
            }
            return .done
        }
    }

    private func upload(_ photo: ReferencePhotoRecord, kind: String) async throws {
        let isOriginal = kind == "original"
        let file = isOriginal ? photo.originalFile : photo.previewFile
        let data: Data
        do {
            data = try files.read(file)
        } catch {
            throw MissingFile(file: file)
        }
        try await client.uploadPhotoFile(
            id: photo.id,
            kind: kind,
            data: data,
            contentType: isOriginal ? "image/heic" : "image/jpeg",
            sha256Hex: isOriginal ? photo.originalSha256 : photo.previewSha256
        )
    }

    private struct MissingFile: Error { let file: String }

    private func record(error: Error, photo: ReferencePhotoRecord, step: String) async -> Outcome {
        let message: String
        let outcome: Outcome
        switch error {
        case APIError.http(status: 409, let msg):
            message = "409 \(step): \(msg ?? "a different file is already stored")"
            outcome = .hardFailure
        case APIError.http(status: 400, let msg) where step == "create":
            message = "400 create: \(msg ?? "rejected fields")"
            outcome = .hardFailure
        case APIError.http(status: 404, let msg) where step == "create":
            message = "404 create: \(msg ?? "unknown site")"
            outcome = .hardFailure
        case APIError.http(status: 404, let msg):
            message = "404 \(step): \(msg ?? "unknown photo")"
            outcome = .retryLater
        case APIError.http(status: 413, let msg):
            message = "413 \(step): \(msg ?? "file too large")"
            outcome = .hardFailure
        case let missing as MissingFile:
            message = "Missing local file \(missing.file)"
            outcome = .hardFailure
        case APIError.transport(let detail):
            message = "Network: \(detail)"
            outcome = .stopPass
        case let api as APIError:
            message = api.errorDescription ?? "\(api)"
            outcome = .retryLater
        default:
            message = "\(error)"
            outcome = .retryLater
        }

        let t = now().timeIntervalSince1970
        _ = await mark(photo.id) { row in
            row.lastError = message
            if outcome == .hardFailure {
                row.syncState = .failed
                row.nextAttemptAt = nil
            } else {
                row.attemptCount += 1
                row.nextAttemptAt = t + Self.backoffDelay(attempt: row.attemptCount)
            }
        }
        return outcome
    }

    private func mark(
        _ id: String,
        _ change: @Sendable @escaping (inout ReferencePhotoRecord) -> Void
    ) async -> ReferencePhotoRecord? {
        try? await database.updateReferencePhoto(id: id, change)
    }

    // MARK: - Retention

    /// Deletes the HEIC of photos confirmed more than 7 days ago. The preview
    /// and thumbnail stay for the list.
    func purgeExpiredOriginals() async {
        let cutoff = DeviceInfo.iso8601(now().addingTimeInterval(-Self.originalRetentionS))
        guard let expired = try? await database.referencePhotosWithExpiredOriginal(syncedBefore: cutoff) else { return }
        let stamp = DeviceInfo.iso8601(now())
        for photo in expired {
            files.remove(photo.originalFile)
            _ = await mark(photo.id) { $0.originalDeletedAt = stamp }
        }
    }
}

/// Starts a photo flush wrapped in a UIKit background task, so an upload in
/// progress when the app leaves the foreground gets the extra time iOS allows
/// (about 30 s) instead of being cut off at suspension.
@MainActor
enum PhotoUploadTrigger {
    private final class TaskBox { var id: UIBackgroundTaskIdentifier = .invalid }

    static func flush(_ sync: PhotoSyncService, ignoringBackoff: Bool = false) {
        let app = UIApplication.shared
        let box = TaskBox()
        box.id = app.beginBackgroundTask(withName: "reference-photo-upload") {
            app.endBackgroundTask(box.id)
            box.id = .invalid
        }
        Task { @MainActor in
            await sync.flush(ignoringBackoff: ignoringBackoff)
            if box.id != .invalid {
                app.endBackgroundTask(box.id)
                box.id = .invalid
            }
        }
    }
}
