import Foundation
import Observation

/// One row in the course list: the merged view of a course's server metadata
/// and its local bundle state.
struct CourseRow: Identifiable, Equatable {
    let id: String
    let name: String
    let holeCount: Int
    /// Latest revision known (from the server when online, else the local row).
    let revision: Int
    /// Revision currently on disk, nil if never downloaded.
    let downloadedRevision: Int?
    let bundleState: BundleState
    /// True when this row came only from the local store (server not consulted).
    let isLocalOnly: Bool

    /// The badge/action the row should present.
    enum Availability: Equatable {
        /// Not on device; can be downloaded.
        case downloadable
        /// Fully downloaded and current.
        case downloaded(revision: Int)
        /// Downloaded but the server has a newer revision.
        case updateAvailable(localRevision: Int, remoteRevision: Int)
    }

    var availability: Availability {
        switch bundleState {
        case .complete:
            if let downloadedRevision, downloadedRevision < revision {
                return .updateAvailable(localRevision: downloadedRevision, remoteRevision: revision)
            }
            return .downloaded(revision: downloadedRevision ?? revision)
        case .stale:
            if let downloadedRevision {
                return .updateAvailable(localRevision: downloadedRevision, remoteRevision: revision)
            }
            return .downloadable
        case .downloading, .none:
            return .downloadable
        }
    }
}

/// Live download progress for a single course row (bytes across both layer
/// archives).
struct DownloadProgress: Equatable {
    var completedBytes: Int64
    var totalBytes: Int64

    var fraction: Double {
        totalBytes > 0 ? Double(completedBytes) / Double(totalBytes) : 0
    }

    /// e.g. "12.3 / 48.0 MB" (or just the downloaded size before a
    /// Content-Length is known).
    var label: String {
        func mb(_ bytes: Int64) -> Double { Double(bytes) / 1_048_576 }
        if totalBytes > 0 {
            return String(format: "%.1f / %.1f MB", mb(completedBytes), mb(totalBytes))
        }
        return String(format: "%.1f MB", mb(completedBytes))
    }
}

/// Backs `CourseListScreen`: loads the merged course list (server + local),
/// and owns the in-flight download handles + progress so rows can show
/// progress bars and a cancel button.
@MainActor
@Observable
final class CourseListModel {
    private let env: AppEnvironment

    /// The merged, name-sorted rows shown in the list.
    private(set) var rows: [CourseRow] = []
    /// True while the initial load is running.
    private(set) var isLoading = false
    /// Set when the last load fell back to local-only (server unreachable).
    private(set) var isOfflineList = false
    /// A non-fatal load error to surface (e.g. transient fetch failure).
    private(set) var loadError: String?

    /// Live progress per course id (present only while downloading).
    private(set) var progressByCourse: [String: DownloadProgress] = [:]

    /// In-flight download handles, so a row can cancel.
    private var handles: [String: BundleDownloadHandle] = [:]

    init(env: AppEnvironment) {
        self.env = env
    }

    // MARK: - Loading

    /// Loads the merged list. When the server is reachable, published courses
    /// are merged with local bundle state; otherwise the local store is shown
    /// on its own (offline).
    func load() async {
        isLoading = rows.isEmpty
        defer { isLoading = false }
        loadError = nil

        let local = (try? await env.database.allCourses()) ?? []
        let localById = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })

        do {
            // Server caps `limit` at 100; the course catalogue is well under that.
            let published = try await env.client.publishedCourses(limit: 100)
            isOfflineList = false
            rows = published
                .map { summary in
                    let localRow = localById[summary.id]
                    return CourseRow(
                        id: summary.id,
                        name: summary.name,
                        holeCount: summary.holeCount,
                        revision: summary.revision,
                        downloadedRevision: localRow?.downloadedRevision,
                        bundleState: localRow?.bundleState ?? .none,
                        isLocalOnly: false
                    )
                }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {
            // Server unreachable (or auth failed): show whatever is on disk.
            isOfflineList = true
            if case APIError.unauthorized = error {
                loadError = "Session expired — pull to refresh after reconnecting."
            }
            rows = local
                .map { row in
                    CourseRow(
                        id: row.id,
                        name: row.name,
                        holeCount: 0, // hole count isn't stored on the summary row
                        revision: row.downloadedRevision ?? row.revision,
                        downloadedRevision: row.downloadedRevision,
                        bundleState: row.bundleState,
                        isLocalOnly: true
                    )
                }
                .filter { $0.bundleState == .complete || $0.bundleState == .stale }
                .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
    }

    // MARK: - Downloads

    var isDownloading: (String) -> Bool {
        { [handles] id in handles[id] != nil }
    }

    /// Starts (or restarts) a bundle download for a course, wiring its progress
    /// stream into `progressByCourse` and refreshing the row on completion.
    func download(courseId: String) {
        guard handles[courseId] == nil else { return }
        progressByCourse[courseId] = DownloadProgress(completedBytes: 0, totalBytes: 0)

        Task {
            do {
                let handle = try await env.syncService.startBundleDownload(courseId: courseId)
                handles[courseId] = handle

                // Drain progress on a detached consumer; hop back to main to publish.
                let stream = handle.progress
                Task { @MainActor in
                    for await p in stream {
                        progressByCourse[courseId] = DownloadProgress(
                            completedBytes: p.completedBytes, totalBytes: p.totalBytes
                        )
                    }
                }

                _ = try await handle.result
                handles[courseId] = nil
                progressByCourse[courseId] = nil
                await load()
            } catch is CancellationError {
                handles[courseId] = nil
                progressByCourse[courseId] = nil
                await load()
            } catch {
                handles[courseId] = nil
                progressByCourse[courseId] = nil
                loadError = "Download failed: \(error.localizedDescription)"
                await load()
            }
        }
    }

    /// Cancels an in-flight download.
    func cancelDownload(courseId: String) {
        handles[courseId]?.cancel()
    }

    /// Deletes a downloaded bundle (files + database rows) and refreshes the
    /// row back to its downloadable state.
    func removeDownload(courseId: String) {
        guard handles[courseId] == nil else { return }
        Task {
            do {
                try await env.syncService.deleteBundle(courseId: courseId)
            } catch {
                loadError = "Remove failed: \(error.localizedDescription)"
            }
            await load()
        }
    }
}
