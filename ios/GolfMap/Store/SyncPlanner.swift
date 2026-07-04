import Foundation

/// The minimal remote course info the sync planner needs. The wiring layer
/// maps the API client's course-list response into these.
public struct RemoteCourseSummary: Sendable, Equatable {
    public var id: String
    public var revision: Int
    /// Server status string; only `"published"` courses are eligible offline.
    public var status: String

    public init(id: String, revision: Int, status: String) {
        self.id = id
        self.revision = revision
        self.status = status
    }
}

/// The minimal local per-course state the planner needs
/// (see `AppDatabase.localCourseSummaries()`).
public struct LocalCourseSummary: Sendable, Equatable {
    public var id: String
    public var downloadedRevision: Int?
    public var bundleState: BundleState

    public init(id: String, downloadedRevision: Int?, bundleState: BundleState) {
        self.id = id
        self.downloadedRevision = downloadedRevision
        self.bundleState = bundleState
    }
}

public enum SyncAction: Sendable, Equatable, Hashable {
    /// Course has never been fully downloaded on this device.
    case download(courseId: String)
    /// A complete bundle exists but is outdated (or was interrupted mid-update).
    case redownload(courseId: String)
    /// Course is gone from the server list or no longer published.
    case delete(courseId: String)
    /// Bundle is complete and current.
    case keep(courseId: String)
}

/// Pure revision-sync logic: local rows + remote summaries in, actions out.
/// No I/O — trivially unit-testable; the wiring layer executes the actions
/// via `BundleDownloader` / `AppDatabase`.
public enum SyncPlanner {
    public static let publishedStatus = "published"

    /// Actions are returned sorted by courseId for determinism. Remote
    /// courses that are not published and have no local row produce no action.
    public static func plan(
        local: [LocalCourseSummary],
        remote: [RemoteCourseSummary]
    ) -> [SyncAction] {
        let localById = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        let remoteById = Dictionary(uniqueKeysWithValues: remote.map { ($0.id, $0) })

        var actions: [(id: String, action: SyncAction)] = []

        for remoteCourse in remote {
            let id = remoteCourse.id
            guard remoteCourse.status == publishedStatus else {
                // Unpublished remotely: purge any local copy, otherwise ignore.
                if localById[id] != nil {
                    actions.append((id, .delete(courseId: id)))
                }
                continue
            }

            guard let localCourse = localById[id] else {
                actions.append((id, .download(courseId: id)))
                continue
            }

            if localCourse.bundleState == .complete,
               localCourse.downloadedRevision == remoteCourse.revision {
                actions.append((id, .keep(courseId: id)))
            } else if localCourse.downloadedRevision == nil {
                // Row exists (e.g. interrupted first download) but nothing usable.
                actions.append((id, .download(courseId: id)))
            } else {
                actions.append((id, .redownload(courseId: id)))
            }
        }

        // Local courses the server no longer lists at all.
        for localCourse in local where remoteById[localCourse.id] == nil {
            actions.append((localCourse.id, .delete(courseId: localCourse.id)))
        }

        return actions.sorted { $0.id < $1.id }.map(\.action)
    }
}
