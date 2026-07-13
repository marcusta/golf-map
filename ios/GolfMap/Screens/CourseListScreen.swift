import SwiftUI

/// The main screen after login: the list of published courses, merged with
/// local bundle state. Each row shows a state badge and a download / update /
/// cancel affordance with live progress. Tapping a downloaded course navigates
/// to the (placeholder) on-course screen.
struct CourseListScreen: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model: CourseListModel?
    @State private var path: [CourseDestination] = []
    @State private var showSettings = false
    @State private var showClubs = false

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let model {
                    content(model)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Courses")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Clubs", systemImage: "bag") {
                            showClubs = true
                        }
                        Button("Settings", systemImage: "gearshape") {
                            showSettings = true
                        }
                        Button("Log out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            Task { await env.logout() }
                        }
                    } label: {
                        Image(systemName: "person.circle")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsScreen()
            }
            .sheet(isPresented: $showClubs) {
                ClubsScreen()
            }
        }
        .task {
            if model == nil { model = CourseListModel(env: env) }
            await model?.load()
            #if DEBUG
            // Headless live-verify hook: `-autoDownload <courseId>` kicks off a
            // real bundle download once the list has loaded (UI tapping needs
            // macOS accessibility automation, unavailable in headless CI).
            // DEBUG-only and inert without the flag.
            if let courseId = UserDefaults.standard.string(forKey: "autoDownload") {
                model?.download(courseId: courseId)
            }
            // `-openCourse <courseId>` deep-links to the on-course screen so the
            // navigation + bundle-summary can be verified headlessly.
            if let courseId = UserDefaults.standard.string(forKey: "openCourse"),
               let row = model?.rows.first(where: { $0.id == courseId }) {
                path = [CourseDestination(courseId: row.id, name: row.name)]
            }
            #endif
        }
    }

    @ViewBuilder
    private func content(_ model: CourseListModel) -> some View {
        List {
            if model.isOfflineList {
                Section {
                    Label("Offline — showing downloaded courses only.", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let loadError = model.loadError {
                Section {
                    Text(loadError).font(.footnote).foregroundStyle(.orange)
                }
            }
            Section {
                if model.rows.isEmpty && !model.isLoading {
                    ContentUnavailableView(
                        model.isOfflineList ? "No downloaded courses" : "No published courses",
                        systemImage: "flag.slash",
                        description: Text(model.isOfflineList
                            ? "Reconnect to download courses for offline use."
                            : "Publish a course on the server to see it here.")
                    )
                }
                ForEach(model.rows) { row in
                    CourseRowView(
                        row: row,
                        progress: model.progressByCourse[row.id],
                        isDownloading: model.progressByCourse[row.id] != nil,
                        onDownload: { model.download(courseId: row.id) },
                        onCancel: { model.cancelDownload(courseId: row.id) },
                        onRemove: { model.removeDownload(courseId: row.id) }
                    )
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await model.load() }
        .overlay {
            if model.isLoading && model.rows.isEmpty {
                ProgressView("Loading courses…")
            }
        }
        .navigationDestination(for: CourseDestination.self) { dest in
            CourseScreen(courseId: dest.courseId, courseName: dest.name)
        }
    }
}

/// Value pushed onto the navigation path to open a course's on-course screen.
struct CourseDestination: Hashable {
    let courseId: String
    let name: String
}

/// A single course row: name + hole count, a state badge, and the
/// download/update/cancel control (with progress while downloading). The whole
/// row is a navigation link to the course screen once a bundle is on disk.
private struct CourseRowView: View {
    let row: CourseRow
    let progress: DownloadProgress?
    let isDownloading: Bool
    let onDownload: () -> Void
    let onCancel: () -> Void
    let onRemove: () -> Void

    private var isReady: Bool {
        if case .downloaded = row.availability { return true }
        if case .updateAvailable = row.availability { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                if isReady {
                    NavigationLink(value: CourseDestination(courseId: row.id, name: row.name)) {
                        rowHeader
                    }
                } else {
                    rowHeader
                }
            }
            HStack {
                badge
                Spacer()
                actionControl
            }
            if isDownloading, let progress {
                VStack(alignment: .leading, spacing: 2) {
                    ProgressView(value: progress.fraction)
                    Text(progress.label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
        }
        .padding(.vertical, 4)
        // A current bundle shows no inline action — the context menu is the
        // repair path (re-fetch after a broken download, free disk space).
        .contextMenu {
            if isReady, !isDownloading {
                Button {
                    onDownload()
                } label: {
                    Label("Re-download", systemImage: "arrow.clockwise")
                }
                Button(role: .destructive) {
                    onRemove()
                } label: {
                    Label("Remove download", systemImage: "trash")
                }
            }
        }
    }

    private var rowHeader: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.name).font(.headline)
            if row.holeCount > 0 {
                Text("\(row.holeCount) holes")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var badge: some View {
        switch row.availability {
        case .downloadable:
            badgeLabel("Not downloaded", system: "arrow.down.circle", tint: .secondary)
        case let .downloaded(revision):
            badgeLabel("Downloaded · rev \(revision)", system: "checkmark.circle.fill", tint: .green)
        case let .updateAvailable(local, remote):
            badgeLabel("Update · rev \(local)→\(remote)", system: "arrow.triangle.2.circlepath", tint: .orange)
        }
    }

    private func badgeLabel(_ text: String, system: String, tint: Color) -> some View {
        Label(text, systemImage: system)
            .font(.caption)
            .foregroundStyle(tint)
    }

    @ViewBuilder
    private var actionControl: some View {
        if isDownloading {
            Button(role: .destructive, action: onCancel) {
                Label("Cancel", systemImage: "xmark.circle")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        } else {
            switch row.availability {
            case .downloadable:
                Button(action: onDownload) {
                    Label("Download", systemImage: "arrow.down.circle")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            case .updateAvailable:
                Button(action: onDownload) {
                    Label("Update", systemImage: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            case .downloaded:
                EmptyView()
            }
        }
    }
}
