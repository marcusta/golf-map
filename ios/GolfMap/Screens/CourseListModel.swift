import Foundation
import Observation

/// One row in the course list: the merged view of a course's server metadata
/// and its local bundle state.
struct CourseRow: Identifiable, Equatable {
    let id: String
    /// Identity of the shared offline map payload (ortho + terrain tiles).
    /// Courses without a site use their course id for backwards compatibility.
    let mapKey: String
    let name: String
    let siteName: String?
    let holeCount: Int
    let parTotal: Int
    let lengthM: Double
    let mappedHoleCount: Int
    let updatedAt: String
    let routing: [RoutingHole]
    /// Latest revision known (from the server when online, else the local row).
    let revision: Int
    /// Revision currently on disk, nil if never downloaded.
    let downloadedRevision: Int?
    let bundleState: BundleState
    /// True when this row came only from the local store (server not consulted).
    let isLocalOnly: Bool
    /// A different downloaded course may already provide this row's map. The
    /// row still needs its own furniture + raw features before it can open.
    let hasSharedMap: Bool

    /// The badge/action the row should present.
    enum Availability: Equatable {
        /// Not on device; can be downloaded.
        case downloadable
        /// Tiles are already present through another course at the same site;
        /// installing this course is a lightweight furniture/features fetch.
        case sharedMapAvailable
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
            return hasSharedMap ? .sharedMapAvailable : .downloadable
        }
    }
}

enum CourseListSort: String, CaseIterable, Identifiable {
    case name
    case updated
    case progress

    var id: Self { self }
    var title: String {
        switch self {
        case .name: "Name"
        case .updated: "Updated"
        case .progress: "Mapping progress"
        }
    }
}

enum CourseListGrouping: String, CaseIterable, Identifiable {
    case none
    case site
    case availability

    var id: Self { self }
    var title: String {
        switch self {
        case .none: "None"
        case .site: "Site"
        case .availability: "Download status"
        }
    }
}

struct CourseListGroup: Identifiable, Equatable {
    let label: String?
    let rows: [CourseRow]

    var id: String { label ?? "all" }

    /// UIKit-backed SwiftUI lists require an item moving between sections to
    /// have a different identity in the destination section. Otherwise a
    /// download-state transition can be reconciled as both a move and a count
    /// change, triggering UICollectionView's invalid-update assertion.
    var renderRows: [CourseListRenderRow] {
        rows.map { CourseListRenderRow(groupID: id, row: $0) }
    }
}

struct CourseListRenderRow: Identifiable, Equatable {
    let groupID: String
    let row: CourseRow

    var id: String { "\(groupID)\u{1F}\(row.id)" }
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
    private static let sortDefaultsKey = "courseList.sort"
    private static let groupingDefaultsKey = "courseList.grouping"
    /// Site display names are server-owned but tiny, so retain them outside the
    /// heavyweight bundle. This avoids a schema migration and lets site search /
    /// grouping keep working when the catalogue request is offline.
    private static let siteNamesDefaultsKey = "courseList.siteNames"
    private let env: AppEnvironment

    /// The merged, name-sorted rows shown in the list.
    private(set) var rows: [CourseRow] = []
    /// True while the initial load is running.
    private(set) var isLoading = false
    /// Set when the last load fell back to local-only (server unreachable).
    private(set) var isOfflineList = false
    /// A non-fatal load error to surface (e.g. transient fetch failure).
    private(set) var loadError: String?
    /// Search is intentionally session-scoped; sort/group choices persist.
    var query = ""
    private(set) var sort: CourseListSort
    private(set) var grouping: CourseListGrouping

    /// Live progress per shared map key (present only while downloading). Rows
    /// at the same site intentionally observe the same archive transfer.
    private(set) var progressByMapKey: [String: DownloadProgress] = [:]

    /// In-flight download handles, so a row can cancel.
    private var handlesByMapKey: [String: BundleDownloadHandle] = [:]
    /// Owns the metadata/furniture fetch that precedes the downloader handle,
    /// so Cancel works during that lightweight phase too.
    private var operationsByMapKey: [String: Task<Void, Never>] = [:]
    /// Covers the metadata-fetch window before SyncService returns a handle.
    private var startingMapKeys: Set<String> = []

    init(env: AppEnvironment) {
        self.env = env
        sort = CourseListSort(rawValue: UserDefaults.standard.string(forKey: Self.sortDefaultsKey) ?? "") ?? .name
        grouping = CourseListGrouping(
            rawValue: UserDefaults.standard.string(forKey: Self.groupingDefaultsKey) ?? ""
        ) ?? .none
    }

    var groups: [CourseListGroup] {
        Self.filterSortGroup(rows: rows, query: query, sort: sort, grouping: grouping)
    }

    var visibleRowCount: Int { groups.reduce(0) { $0 + $1.rows.count } }

    func setSort(_ value: CourseListSort) {
        sort = value
        UserDefaults.standard.set(value.rawValue, forKey: Self.sortDefaultsKey)
    }

    func setGrouping(_ value: CourseListGrouping) {
        grouping = value
        UserDefaults.standard.set(value.rawValue, forKey: Self.groupingDefaultsKey)
    }

    nonisolated static func filterSortGroup(
        rows: [CourseRow],
        query: String,
        sort: CourseListSort,
        grouping: CourseListGrouping
    ) -> [CourseListGroup] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let filtered = needle.isEmpty ? rows : rows.filter {
            $0.name.localizedCaseInsensitiveContains(needle)
                || ($0.siteName?.localizedCaseInsensitiveContains(needle) ?? false)
        }
        let sorted = filtered.sorted { lhs, rhs in
            switch sort {
            case .name:
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            case .updated:
                let comparison = Self.updatedDate(lhs.updatedAt).compare(Self.updatedDate(rhs.updatedAt))
                if comparison != .orderedSame { return comparison == .orderedDescending }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            case .progress:
                let l = lhs.holeCount > 0 ? Double(lhs.mappedHoleCount) / Double(lhs.holeCount) : 0
                let r = rhs.holeCount > 0 ? Double(rhs.mappedHoleCount) / Double(rhs.holeCount) : 0
                if l != r { return l > r }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
        }

        guard grouping != .none else { return [CourseListGroup(label: nil, rows: sorted)] }
        let buckets = Dictionary(grouping: sorted) { row -> String in
            switch grouping {
            case .none:
                return ""
            case .site:
                return row.siteName ?? "Unassigned"
            case .availability:
                switch row.availability {
                case .downloaded: return "Downloaded"
                case .updateAvailable: return "Update available"
                case .sharedMapAvailable: return "Map on device"
                case .downloadable: return "Available to download"
                }
            }
        }
        let availabilityOrder = ["Downloaded", "Update available", "Map on device", "Available to download"]
        return buckets.keys.sorted { lhs, rhs in
            if grouping == .availability {
                return (availabilityOrder.firstIndex(of: lhs) ?? .max)
                    < (availabilityOrder.firstIndex(of: rhs) ?? .max)
            }
            if lhs == "Unassigned" { return false }
            if rhs == "Unassigned" { return true }
            return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }.map { CourseListGroup(label: $0, rows: buckets[$0] ?? []) }
    }

    private nonisolated static func updatedDate(_ value: String) -> Date {
        let iso = ISO8601DateFormatter()
        if let date = iso.date(from: value) { return date }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.date(from: value) ?? .distantPast
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
        do {
            // Server caps `limit` at 100; the course catalogue is well under that.
            let published = try await env.client.publishedCourses(limit: 100)
            isOfflineList = false
            rows = Self.merge(published: published, local: local)
            cacheSiteNames(from: published)
        } catch {
            // Server unreachable (or auth failed): show whatever is on disk.
            isOfflineList = true
            if case APIError.unauthorized = error {
                loadError = "Session expired — pull to refresh after reconnecting."
            }
            let available = local.filter { $0.bundleState == .complete || $0.bundleState == .stale }
            var furnitureByCourseId: [String: CourseFurniture] = [:]
            for course in available {
                if let furniture = try? await env.database.courseFurniture(courseId: course.id) {
                    furnitureByCourseId[course.id] = furniture
                }
            }
            rows = Self.offlineRows(
                local: available,
                furnitureByCourseId: furnitureByCourseId,
                siteNamesByCourseId: cachedSiteNames()
            )
        }
    }

    // MARK: - Downloads

    /// Pure server/local merge used by the screen and focused model tests.
    /// A complete/stale local course makes the shared map available to every
    /// remote course with the same map key, but does not lend out its per-course
    /// bundle state or downloaded revision.
    nonisolated static func merge(published: [CourseSummary], local: [CourseRecord]) -> [CourseRow] {
        let localById = Dictionary(uniqueKeysWithValues: local.map { ($0.id, $0) })
        let availableMapKeys = Set(local.compactMap { row -> String? in
            row.bundleState == .complete || row.bundleState == .stale ? row.mapKey : nil
        })

        return published.map { summary in
            let localRow = localById[summary.id]
            let mapKey = summary.siteId ?? summary.id
            let hasOwnBundle = localRow?.bundleState == .complete || localRow?.bundleState == .stale
            return CourseRow(
                id: summary.id,
                mapKey: mapKey,
                name: summary.name,
                siteName: summary.siteName,
                holeCount: summary.holeCount,
                parTotal: summary.parTotal,
                lengthM: summary.lengthM,
                mappedHoleCount: summary.mappedHoleCount,
                updatedAt: summary.updatedAt,
                routing: summary.routing,
                revision: summary.revision,
                downloadedRevision: localRow?.downloadedRevision,
                bundleState: localRow?.bundleState ?? .none,
                isLocalOnly: false,
                hasSharedMap: !hasOwnBundle && availableMapKeys.contains(mapKey)
            )
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    /// Builds offline list rows from the cheap furniture retained with a
    /// download. A routable hole has both a primary tee and green; that count is
    /// the best furniture-only proxy for the server's feature mapping progress.
    nonisolated static func offlineRows(
        local: [CourseRecord],
        furnitureByCourseId: [String: CourseFurniture],
        siteNamesByCourseId: [String: String] = [:]
    ) -> [CourseRow] {
        local.map { course in
            let presentation = furnitureByCourseId[course.id].map(derivePresentation)
            return CourseRow(
                id: course.id,
                mapKey: course.mapKey,
                name: course.name,
                siteName: siteNamesByCourseId[course.id],
                holeCount: presentation?.holeCount ?? 0,
                parTotal: presentation?.parTotal ?? 0,
                lengthM: presentation?.lengthM ?? 0,
                mappedHoleCount: presentation?.mappedHoleCount ?? 0,
                updatedAt: course.updatedAt,
                routing: presentation?.routing ?? [],
                revision: course.downloadedRevision ?? course.revision,
                downloadedRevision: course.downloadedRevision,
                bundleState: course.bundleState,
                isLocalOnly: true,
                hasSharedMap: false
            )
        }
        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    struct FurniturePresentation: Equatable {
        let holeCount: Int
        let parTotal: Int
        let lengthM: Double
        let mappedHoleCount: Int
        let routing: [RoutingHole]
    }

    nonisolated static func derivePresentation(_ furniture: CourseFurniture) -> FurniturePresentation {
        let teesByHole = Dictionary(grouping: furniture.tees, by: \.holeId)
        let greensByHole = Dictionary(grouping: furniture.greens, by: \.holeId)
        var routing: [RoutingHole] = []
        var lengthM = 0.0

        for hole in furniture.holes.sorted(by: { $0.number < $1.number }) {
            guard
                let tee = teesByHole[hole.id]?.min(by: {
                    $0.sortOrder == $1.sortOrder ? $0.id < $1.id : $0.sortOrder < $1.sortOrder
                }),
                let green = greensByHole[hole.id]?.min(by: { $0.id < $1.id })
            else { continue }
            routing.append(RoutingHole(
                hole: hole.number,
                tee: [tee.lat, tee.lon],
                green: [green.centerLat, green.centerLon]
            ))
            lengthM += haversineMeters(
                fromLat: tee.lat, fromLon: tee.lon,
                toLat: green.centerLat, toLon: green.centerLon
            )
        }

        return FurniturePresentation(
            holeCount: furniture.holes.count,
            parTotal: furniture.holes.reduce(0) { $0 + $1.par },
            lengthM: lengthM,
            mappedHoleCount: routing.count,
            routing: routing
        )
    }

    private nonisolated static func haversineMeters(
        fromLat: Double, fromLon: Double, toLat: Double, toLon: Double
    ) -> Double {
        let radians = Double.pi / 180
        let lat1 = fromLat * radians
        let lat2 = toLat * radians
        let deltaLat = (toLat - fromLat) * radians
        let deltaLon = (toLon - fromLon) * radians
        let a = sin(deltaLat / 2) * sin(deltaLat / 2)
            + cos(lat1) * cos(lat2) * sin(deltaLon / 2) * sin(deltaLon / 2)
        return 6_371_000 * 2 * atan2(sqrt(a), sqrt(1 - a))
    }

    private func cachedSiteNames() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: Self.siteNamesDefaultsKey) as? [String: String] ?? [:]
    }

    private func cacheSiteNames(from published: [CourseSummary]) {
        var names = cachedSiteNames()
        for course in published {
            if let siteName = course.siteName { names[course.id] = siteName }
        }
        UserDefaults.standard.set(names, forKey: Self.siteNamesDefaultsKey)
    }

    /// Operation failures are more actionable than a secondary catalogue
    /// refresh failure, so they remain visible after rows have been refreshed.
    nonisolated static func visibleError(
        operationError: String?, refreshError: String?
    ) -> String? {
        operationError ?? refreshError
    }

    private func refresh(preservingOperationError operationError: String) async {
        await load()
        loadError = Self.visibleError(operationError: operationError, refreshError: loadError)
    }

    var isDownloading: (String) -> Bool {
        { [weak self] courseId in
            guard let self, let mapKey = self.rows.first(where: { $0.id == courseId })?.mapKey else {
                return false
            }
            return self.startingMapKeys.contains(mapKey) || self.handlesByMapKey[mapKey] != nil
        }
    }

    func progress(courseId: String) -> DownloadProgress? {
        guard let mapKey = rows.first(where: { $0.id == courseId })?.mapKey else { return nil }
        return progressByMapKey[mapKey]
    }

    /// Starts (or restarts) a bundle download for a course, wiring its progress
    /// stream into `progressByMapKey` and refreshing the row on completion.
    func download(courseId: String) {
        guard let mapKey = rows.first(where: { $0.id == courseId })?.mapKey,
              handlesByMapKey[mapKey] == nil,
              !startingMapKeys.contains(mapKey)
        else { return }
        startingMapKeys.insert(mapKey)
        progressByMapKey[mapKey] = DownloadProgress(completedBytes: 0, totalBytes: 0)

        operationsByMapKey[mapKey] = Task {
            do {
                let handle = try await env.syncService.startBundleDownload(courseId: courseId)
                startingMapKeys.remove(mapKey)
                handlesByMapKey[mapKey] = handle

                // Drain progress on a detached consumer; hop back to main to publish.
                let stream = handle.progress
                Task { @MainActor in
                    for await p in stream {
                        progressByMapKey[mapKey] = DownloadProgress(
                            completedBytes: p.completedBytes, totalBytes: p.totalBytes
                        )
                    }
                }

                _ = try await handle.result
                handlesByMapKey[mapKey] = nil
                operationsByMapKey[mapKey] = nil
                progressByMapKey[mapKey] = nil
                await load()
            } catch is CancellationError {
                startingMapKeys.remove(mapKey)
                handlesByMapKey[mapKey] = nil
                operationsByMapKey[mapKey] = nil
                progressByMapKey[mapKey] = nil
                await load()
            } catch {
                startingMapKeys.remove(mapKey)
                handlesByMapKey[mapKey] = nil
                operationsByMapKey[mapKey] = nil
                progressByMapKey[mapKey] = nil
                let operationError = "Download failed: \(error.localizedDescription)"
                await refresh(preservingOperationError: operationError)
            }
        }
    }

    /// Cancels an in-flight download.
    func cancelDownload(courseId: String) {
        guard let mapKey = rows.first(where: { $0.id == courseId })?.mapKey else { return }
        operationsByMapKey[mapKey]?.cancel()
        handlesByMapKey[mapKey]?.cancel()
    }

    /// Releases expensive downloaded map data and refreshes the row back to
    /// its downloadable state. Cheap cached and user-authored data remains.
    func removeDownload(courseId: String) {
        guard !isDownloading(courseId) else { return }
        Task {
            var operationError: String?
            do {
                try await env.syncService.deleteBundle(courseId: courseId)
            } catch {
                operationError = "Remove failed: \(error.localizedDescription)"
            }
            if let operationError {
                await refresh(preservingOperationError: operationError)
            } else {
                await load()
            }
        }
    }
}
