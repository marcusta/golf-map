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
    /// Owned above the List so presenting the confirmation never changes a
    /// row's structure while UICollectionView is reconciling swipe actions.
    @State private var pendingRemoval: CourseDestination?

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
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("Sort", selection: Binding(
                            get: { model?.sort ?? .name },
                            set: { model?.setSort($0) }
                        )) {
                            ForEach(CourseListSort.allCases) { value in
                                Text(value.title).tag(value)
                            }
                        }
                        Picker("Group", selection: Binding(
                            get: { model?.grouping ?? .none },
                            set: { model?.setGrouping($0) }
                        )) {
                            ForEach(CourseListGrouping.allCases) { value in
                                Text(value.title).tag(value)
                            }
                        }
                    } label: {
                        Label("Organize courses", systemImage: "arrow.up.arrow.down.circle")
                    }
                }
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
        .confirmationDialog(
            "Remove downloaded course data?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingRemoval
        ) { course in
            Button("Remove Download", role: .destructive) {
                model?.removeDownload(courseId: course.courseId)
                pendingRemoval = nil
            }
            Button("Cancel", role: .cancel) {
                pendingRemoval = nil
            }
        } message: { _ in
            Text("Downloaded map tiles and elevation data will be removed unless another downloaded course shares them. Scores, shots, and plans stay on this iPhone.")
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
            // Presents the real screen-level removal confirmation without a
            // synthetic tap. Used to regression-test the UIKit list crash that
            // occurred when the dialog was owned by an individual row.
            if let courseId = UserDefaults.standard.string(forKey: "autoConfirmRemoval"),
               let row = model?.rows.first(where: { $0.id == courseId }) {
                pendingRemoval = CourseDestination(courseId: row.id, name: row.name)
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
            if model.rows.isEmpty && !model.isLoading {
                ContentUnavailableView(
                    model.isOfflineList ? "No downloaded courses" : "No published courses",
                    systemImage: "flag.slash",
                    description: Text(model.isOfflineList
                        ? "Reconnect to download courses for offline use."
                        : "Publish a course on the server to see it here.")
                )
            } else if model.visibleRowCount == 0 && !model.query.isEmpty {
                ContentUnavailableView(
                    "No courses match",
                    systemImage: "magnifyingglass",
                    description: Text("Try another course or site name.")
                )
            } else {
                ForEach(model.groups) { group in
                    Section {
                        ForEach(group.renderRows) { item in
                            let row = item.row
                            CourseRowView(
                                row: row,
                                progress: model.progress(courseId: row.id),
                                isDownloading: model.isDownloading(row.id),
                                onDownload: { model.download(courseId: row.id) },
                                onCancel: { model.cancelDownload(courseId: row.id) },
                                onRemove: {
                                    pendingRemoval = CourseDestination(courseId: row.id, name: row.name)
                                }
                            )
                        }
                    } header: {
                        HStack {
                            Text(group.label ?? "All courses")
                            Spacer()
                            Text(group.rows.count.formatted())
                                .monospacedDigit()
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(
            text: Binding(get: { model.query }, set: { model.query = $0 }),
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search courses or sites"
        )
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
        VStack(alignment: .leading, spacing: Space.s3) {
            HStack(alignment: .center, spacing: Space.s3) {
                if isReady {
                    NavigationLink(value: CourseDestination(courseId: row.id, name: row.name)) {
                        rowIdentity
                    }
                    .buttonStyle(.plain)
                } else {
                    rowIdentity
                }
            }
            metrics
            mappingProgress
            HStack(spacing: Space.s2) {
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
        .padding(.vertical, Space.s1)
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
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if isReady, !isDownloading {
                Button(role: .destructive) {
                    onRemove()
                } label: {
                    Label("Remove", systemImage: "trash")
                }
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if isReady, !isDownloading {
                Button(action: onDownload) {
                    Label("Re-download", systemImage: "arrow.clockwise")
                }
                .tint(Color.accentPrimary)
            }
        }
    }

    private var rowIdentity: some View {
        HStack(spacing: Space.s3) {
            CourseRoutingThumbnail(routing: row.routing, holeCount: row.holeCount)
                .frame(width: 82, height: 58)
                .clipShape(RoundedRectangle(cornerRadius: Radius.sm, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(row.name)
                    .font(AppFont.sans(17, .bold))
                    .foregroundStyle(Color.textPrimary)
                    .lineLimit(2)
                HStack(spacing: 5) {
                    if let siteName = row.siteName, siteName != row.name {
                        Text(siteName)
                        Text("·")
                    }
                    Text(Self.updatedLabel(row.updatedAt))
                        .font(AppFont.mono(11, .regular))
                }
                .font(AppFont.bodyS)
                .foregroundStyle(Color.textTertiary)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }

    private var metrics: some View {
        HStack(spacing: 0) {
            metric("Holes", value: row.holeCount > 0 ? row.holeCount.formatted() : "—")
            Divider().frame(height: 28)
            metric("Par", value: row.parTotal > 0 ? row.parTotal.formatted() : "—")
            Divider().frame(height: 28)
            metric("Length", value: row.lengthM > 0 ? Int(row.lengthM.rounded()).formatted() : "—", unit: row.lengthM > 0 ? "m" : nil)
        }
    }

    private func metric(_ label: String, value: String, unit: String? = nil) -> some View {
        VStack(spacing: 2) {
            OverlineLabel(label, size: 9)
            MetricText(value, unit: unit, size: 13, color: .textPrimary)
        }
        .frame(maxWidth: .infinity)
    }

    private var mappingProgress: some View {
        let total = row.holeCount
        let mapped = min(row.mappedHoleCount, total)
        let fraction = total > 0 ? Double(mapped) / Double(total) : 0
        return VStack(spacing: 4) {
            HStack {
                Text(total > 0 ? "\(mapped) of \(total) holes mapped" : "Mapping not started")
                Spacer()
                Text(total > 0 ? fraction.formatted(.percent.precision(.fractionLength(0))) : "—")
                    .monospacedDigit()
            }
            .font(AppFont.sans(11))
            .foregroundStyle(Color.textTertiary)
            ProgressView(value: fraction)
                .tint(Color.statusPositive)
        }
    }

    @ViewBuilder
    private var badge: some View {
        switch row.availability {
        case .downloadable:
            badgeLabel("Not downloaded", system: "arrow.down.circle", tint: .secondary)
        case .sharedMapAvailable:
            badgeLabel("Map already on device", system: "map.fill", tint: .blue)
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

    private static func updatedLabel(_ value: String) -> String {
        let iso = ISO8601DateFormatter()
        var date = iso.date(from: value)
        if date == nil {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
            date = formatter.date(from: value)
        }
        guard let date else { return "Updated recently" }
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .abbreviated
        return "Updated \(relative.localizedString(for: date, relativeTo: Date()))"
    }

    @ViewBuilder
    private var actionControl: some View {
        if isDownloading {
            compactAction(
                "Cancel download",
                systemImage: "xmark",
                tint: .statusNegative,
                action: onCancel
            )
        } else {
            switch row.availability {
            case .downloadable:
                compactAction(
                    "Download course",
                    systemImage: "arrow.down",
                    tint: .accentPrimary,
                    action: onDownload
                )
            case .sharedMapAvailable:
                compactAction(
                    "Add course",
                    systemImage: "plus",
                    tint: .accentPrimary,
                    action: onDownload
                )
            case .updateAvailable:
                compactAction(
                    "Update course",
                    systemImage: "arrow.clockwise",
                    tint: .statusCaution,
                    action: onDownload
                )
            case .downloaded:
                EmptyView()
            }
        }
    }

    private func compactAction(
        _ accessibilityLabel: String,
        systemImage: String,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 36, height: 36)
                .background(tint.opacity(0.11), in: Circle())
                .overlay(Circle().strokeBorder(tint.opacity(0.24), lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
    }
}

/// A compact, non-interactive version of the desktop schematic course thumb.
private struct CourseRoutingThumbnail: View {
    let routing: [RoutingHole]
    let holeCount: Int

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(MapFeature.rough.fill))
            let points = routing.flatMap { hole -> [(Double, Double)] in
                guard hole.tee.count >= 2, hole.green.count >= 2 else { return [] }
                return [(hole.tee[1], hole.tee[0]), (hole.green[1], hole.green[0])]
            }
            guard let minX = points.map(\.0).min(), let maxX = points.map(\.0).max(),
                  let minY = points.map(\.1).min(), let maxY = points.map(\.1).max(),
                  !points.isEmpty
            else {
                context.draw(
                    Text(holeCount > 0 ? holeCount.formatted() : "—")
                        .font(AppFont.mono(17, .semibold))
                        .foregroundStyle(Color.white.opacity(0.55)),
                    at: CGPoint(x: size.width / 2, y: size.height / 2)
                )
                return
            }
            let inset: CGFloat = 7
            let dx = max(maxX - minX, 0.000_001)
            let dy = max(maxY - minY, 0.000_001)
            func point(_ coordinate: [Double]) -> CGPoint {
                let x = inset + CGFloat((coordinate[1] - minX) / dx) * (size.width - inset * 2)
                let y = inset + CGFloat((maxY - coordinate[0]) / dy) * (size.height - inset * 2)
                return CGPoint(x: x, y: y)
            }
            for hole in routing where hole.tee.count >= 2 && hole.green.count >= 2 {
                var path = Path()
                path.move(to: point(hole.tee))
                path.addLine(to: point(hole.green))
                context.stroke(path, with: .color(Color.white.opacity(0.62)), lineWidth: 1.4)
                let green = point(hole.green)
                context.fill(
                    Path(ellipseIn: CGRect(x: green.x - 2.2, y: green.y - 2.2, width: 4.4, height: 4.4)),
                    with: .color(MapFeature.green.draw)
                )
            }
        }
        .background(MapFeature.rough.fill)
        .accessibilityHidden(true)
    }
}
