import SwiftUI

/// The on-course screen: full-screen offline course map with live GPS
/// distances. Top bar navigates holes (chevrons or swipe) and shows par /
/// stroke index / active-tee playing length; the bottom card shows big
/// front / center / back distances, plays-like, the active pin, and aim-point
/// (hazard-carry) distances. Distances measure from the GPS fix when
/// available, else from the active tee — so the screen is useful standing on
/// the tee before GPS locks and with location denied.
struct CourseScreen: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase
    let courseId: String
    let courseName: String

    @State private var model: OnCourseModel?
    @State private var greenAnalysis: GreenAnalysisModel?
    @State private var measure: MeasureModel?
    @State private var profile: ElevationProfileModel?
    @State private var mapInputs: MapInputs?
    @State private var locationProvider = LocationProvider()
    @State private var loadError: String?

    private struct MapInputs {
        var configuration: CourseMapConfiguration
        var featuresGeoJSON: Data
    }

    var body: some View {
        Group {
            if let model, let greenAnalysis, let measure, let profile, let mapInputs {
                OnCourseContentView(
                    model: model,
                    greenAnalysis: greenAnalysis,
                    measure: measure,
                    profile: profile,
                    configuration: mapInputs.configuration,
                    featuresGeoJSON: mapInputs.featuresGeoJSON
                )
            } else if let loadError {
                ContentUnavailableView(
                    "Course unavailable",
                    systemImage: "flag.slash",
                    description: Text(loadError)
                )
            } else {
                ProgressView("Loading course…")
            }
        }
        .navigationTitle(courseName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .task { await load() }
        .onChange(of: locationProvider.location) { _, fix in
            model?.updateUserLocation(fix)
        }
        .onChange(of: locationProvider.isDenied) { _, denied in
            model?.isLocationDenied = denied
        }
        .onAppear { locationProvider.start() }
        .onDisappear { locationProvider.stop() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: locationProvider.start()
            case .background, .inactive: locationProvider.stop()
            @unknown default: break
            }
        }
    }

    private func load() async {
        guard model == nil else { return }
        do {
            guard let furniture = try await env.database.courseFurniture(courseId: courseId) else {
                loadError = "This course's bundle is not downloaded yet."
                return
            }
            let bundleDirectory = env.bundlePaths.courseDirectory(courseId: courseId)
            let featuresGeoJSON = try Data(contentsOf: env.bundlePaths.featuresURL(courseId: courseId))

            let newModel = OnCourseModel(furniture: furniture)
            let terrain = TerrainElevationService(
                bundleDirectory: bundleDirectory,
                zoom: furniture.manifest.terrainMaxZoom
            )
            newModel.elevationSampler = { await terrain.elevation(at: $0) }
            newModel.isLocationDenied = locationProvider.isDenied
            newModel.updateUserLocation(locationProvider.location)

            // Green view shares the bundle terrain pyramid with plays-like
            // sampling; green outlines come from features.geojson (greens'
            // boundaryJson is NULL in real bundles).
            let newGreenAnalysis = GreenAnalysisModel(
                featuresGeoJSON: featuresGeoJSON,
                sampler: { await terrain.elevation(at: $0) }
            )

            // Measure + elevation profile share the same bundle terrain
            // pyramid (one LRU of decoded tiles for the whole screen).
            let newMeasure = MeasureModel()
            newMeasure.elevationSampler = { await terrain.elevation(at: $0) }
            let newProfile = ElevationProfileModel()
            newProfile.elevationSampler = { await terrain.elevation(at: $0) }

            #if DEBUG
            // Headless live-verify hook (same family as `-openCourse` in
            // CourseListScreen): `-openHole <n>` jumps straight to a hole so
            // navigation/camera refit can be verified without UI tapping.
            // DEBUG-only and inert without the flag.
            if let holeNumber = UserDefaults.standard.string(forKey: "openHole").flatMap(Int.init) {
                newModel.goToHole(number: holeNumber)
            }
            // `-browseMode 1` starts in browse mode (GPS off), `-browseMode 0`
            // forces GPS on (overrides the persisted per-course setting so a
            // live-verify run is deterministic); `-moveTee <lat>,<lon>` moves
            // the current hole's active tee to that point so the moved-tee
            // route can be screenshotted without a live gesture.
            switch UserDefaults.standard.string(forKey: "browseMode") {
            case "1": newModel.setGPSEnabled(false)
            case "0": newModel.setGPSEnabled(true)
            default: break
            }
            if let raw = UserDefaults.standard.string(forKey: "moveTee") {
                let parts = raw.split(separator: ",")
                if parts.count == 2, let lat = Double(parts[0]), let lon = Double(parts[1]) {
                    newModel.setGPSEnabled(false)
                    newModel.moveActiveTee(to: LatLon(lat: lat, lon: lon))
                }
            }
            #endif

            mapInputs = MapInputs(
                configuration: CourseMapConfiguration(
                    bundleDirectory: bundleDirectory,
                    manifest: furniture.manifest,
                    attribution: "© Lantmäteriet, CC BY 4.0"
                ),
                featuresGeoJSON: featuresGeoJSON
            )
            model = newModel
            greenAnalysis = newGreenAnalysis
            measure = newMeasure
            profile = newProfile
        } catch {
            loadError = "Failed to load the course bundle: \(error.localizedDescription)"
        }
    }
}

// MARK: - Content

/// Map + chrome once the bundle is loaded. Split out so `model` is non-optional.
private struct OnCourseContentView: View {
    let model: OnCourseModel
    let greenAnalysis: GreenAnalysisModel
    let measure: MeasureModel
    let profile: ElevationProfileModel
    let configuration: CourseMapConfiguration
    let featuresGeoJSON: Data

    /// Immersive mode: a short single-tap on the map hides the top hole bar and
    /// the bottom distances card, leaving the full-bleed hole, a small compact
    /// chip, and the right-side controls. Tap again to restore. Separate from
    /// the browse-mode long-press (move tee); the two never fire together.
    /// Suspended while any tool is active (Green view chrome must stay put; in
    /// measure mode a tap PLACES a point instead).
    @State private var immersive = false
    /// Elevation-profile sheet. NOT a map tool — non-modal, openable over any
    /// mode; reads the measure path while measuring, else the hole route.
    @State private var showProfile = false

    private var isGreenView: Bool { model.toolMode == .greenView }
    private var isMeasure: Bool { model.toolMode == .measure }

    /// Model overlays + the measure path while measuring.
    private var overlays: MapOverlayState {
        var overlays = model.overlays
        if isMeasure {
            overlays.measure = measure.overlay
        }
        return overlays
    }

    var body: some View {
        ZStack {
            CourseMapView(
                configuration: configuration,
                featuresGeoJSON: featuresGeoJSON,
                overlays: overlays,
                camera: model.cameraCommand,
                zoom: model.zoomCommand,
                analysis: isGreenView ? greenAnalysis.mapState : nil,
                longPressEnabled: model.isBrowseMode && model.toolMode == .none,
                onLongPress: { model.moveActiveTee(to: $0) },
                measureTapEnabled: isMeasure,
                onMeasureTap: { measure.place($0) }
            )
            .ignoresSafeArea()
            // Short tap toggles chrome. High minimumDistance drag-less tap so it
            // doesn't swallow the map's own pan; long-press (move tee) is a
            // separate recognizer on the MLNMapView and is unaffected. Inert
            // while a tool is active: in Green view a stray tap must not hide
            // the analysis panel, and in measure mode the tap places a point
            // (the UIKit recognizer in CourseMapView).
            .simultaneousGesture(
                TapGesture().onEnded {
                    guard model.toolMode == .none else { return }
                    withAnimation(.easeInOut(duration: 0.28)) { immersive.toggle() }
                }
            )

            VStack(spacing: 0) {
                if !immersive || isGreenView {
                    HoleHeaderView(model: model)
                        .padding(.horizontal, 12)
                        .transition(.move(edge: .top).combined(with: .opacity))
                } else {
                    CompactChipView(model: model)
                        .padding(.top, 4)
                        .transition(.opacity)
                }

                Spacer()

                HStack(alignment: .bottom) {
                    Spacer()
                    controlStack
                        .padding(.trailing, 16)
                        .padding(.bottom, immersive && !isGreenView ? 24 : 10)
                }

                if isGreenView {
                    GreenViewPanel(model: greenAnalysis, onClose: { exitGreenView() })
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else if isMeasure {
                    MeasurePanel(
                        model: measure,
                        onProfile: { showProfile.toggle() },
                        onClose: { exitMeasure() }
                    )
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                } else if !immersive {
                    DistanceCardView(model: model)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
        // Hole navigation clears `toolMode` in the model; mirror it here by
        // dropping the tools' own state (cancels in-flight sampling, wipes the
        // measure path — tools are per-hole/transient).
        .onChange(of: model.currentHoleNumber) { _, _ in
            if greenAnalysis.isActive {
                greenAnalysis.deactivate()
            }
            measure.clear()
            refreshProfileIfShown()
        }
        // The profile follows whatever path is live: the measure path while
        // measuring (points change per tap), else the hole route (tee
        // override / tee selection changes move it).
        .onChange(of: model.holeRoute) { _, _ in refreshProfileIfShown() }
        .onChange(of: measure.points) { _, _ in refreshProfileIfShown() }
        .onChange(of: model.toolMode) { _, _ in refreshProfileIfShown() }
        .onChange(of: showProfile) { _, shown in
            if shown { refreshProfile() }
        }
        .sheet(isPresented: $showProfile) {
            ElevationProfileSheet(
                model: profile,
                title: profileTitle,
                onClose: { showProfile = false }
            )
        }
        // The chrome floats over a dark ortho map — force dark materials.
        .environment(\.colorScheme, .dark)
        #if DEBUG
        // Headless live-verify hooks (same family as `-openHole`): `-immersive 1`
        // starts in immersive mode so the hidden-chrome layout can be
        // screenshotted; `-zoomTaps N` fires N zoom-in taps (negative = out)
        // after appear so the imperative zoom path can be verified without a real
        // button tap. DEBUG-only and inert without the flags.
        .onAppear {
            if UserDefaults.standard.string(forKey: "immersive") == "1" {
                immersive = true
            }
            // `-greenView 1` enters Green view after the style-load hole fit
            // settles; `-greenMode slope|height|relative` and `-greenBuffer N`
            // preset the overlay controls so all three modes + buffer changes
            // can be screenshotted headlessly.
            if UserDefaults.standard.string(forKey: "greenView") == "1" {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    if let raw = UserDefaults.standard.string(forKey: "greenMode"),
                       let mode = AnalysisMode(rawValue: raw) {
                        greenAnalysis.setMode(mode)
                    }
                    if let raw = UserDefaults.standard.string(forKey: "greenBuffer"),
                       let buffer = Double(raw) {
                        greenAnalysis.setBuffer(buffer)
                    }
                    enterGreenView()
                }
            }
            // `-measure "lat,lon;lat,lon;…"` enters measure mode after the
            // style-load hole fit and injects the points as if tapped, so the
            // measure overlay + readout can be screenshotted headlessly (taps
            // aren't scriptable via simctl). `-profile 1` opens the elevation
            // profile sheet the same way.
            if let raw = UserDefaults.standard.string(forKey: "measure") {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    enterMeasure()
                    for part in raw.split(separator: ";") {
                        let nums = part.split(separator: ",")
                        if nums.count == 2, let lat = Double(nums[0]), let lon = Double(nums[1]) {
                            measure.place(LatLon(lat: lat, lon: lon))
                        }
                    }
                    // Give the async per-point elevation samples time to land,
                    // then dump the readout numbers for the live-verify pass.
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    Self.writeMeasureDebugSummary(measure)
                }
            }
            if UserDefaults.standard.string(forKey: "profile") == "1" {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    showProfile = true
                }
            }
            // `-zoomTaps N` fires N in-taps; `-zoomOutTaps N` fires N out-taps
            // (a separate positive-valued key because simctl swallows a negative
            // launch-arg value).
            let inTaps = UserDefaults.standard.string(forKey: "zoomTaps").flatMap(Int.init) ?? 0
            let outTaps = UserDefaults.standard.string(forKey: "zoomOutTaps").flatMap(Int.init) ?? 0
            if inTaps != 0 || outTaps != 0 {
                // Space the taps so each relative zoom applies (the imperative
                // command coalesces if fired synchronously).
                Task { @MainActor in
                    // Wait out the async style-load hole-fit before zooming, so
                    // the debug taps aren't overridden by the initial camera fit.
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    for _ in 0..<inTaps {
                        model.zoomIn()
                        try? await Task.sleep(nanoseconds: 600_000_000)
                    }
                    for _ in 0..<outTaps {
                        model.zoomOut()
                        try? await Task.sleep(nanoseconds: 600_000_000)
                    }
                }
            }
        }
        #endif
    }

    #if DEBUG
    /// Live-verify hook (same family as GreenAnalysisModel's): dumps the
    /// measure readout numbers to tmp so a headless run can check them
    /// against an independent EPSG:3006 + terrain computation.
    private static func writeMeasureDebugSummary(_ measure: MeasureModel) {
        let totals = measure.totals
        let summary: [String: Any] = [
            "points": measure.points.map {
                [
                    "lat": $0.position.lat,
                    "lon": $0.position.lon,
                    "e": $0.e,
                    "n": $0.n,
                    "elevation": $0.elevation ?? NSNull() as Any,
                ]
            },
            "segments": measure.segments.map {
                [
                    "horizontal": $0.horizontal,
                    "elevationDelta": $0.elevationDelta ?? NSNull() as Any,
                    "slopePct": $0.slopePct ?? NSNull() as Any,
                    "playsLikeSimple": $0.playsLikeSimple ?? NSNull() as Any,
                ]
            },
            "totals": [
                "horizontal": totals.horizontal,
                "elevationDelta": totals.elevationDelta ?? NSNull() as Any,
                "slopePct": totals.slopePct ?? NSNull() as Any,
                "playsLikeSimple": totals.playsLikeSimple ?? NSNull() as Any,
            ],
        ]
        let url = FileManager.default.temporaryDirectory
            .appending(path: "measure-debug.json")
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) {
            try? data.write(to: url)
            print("MEASURE-DEBUG \(String(data: data, encoding: .utf8) ?? "")")
        }
    }
    #endif

    // Stacked bottom-right controls: green view / measure / profile / zoom in /
    // zoom out / recenter.
    private var controlStack: some View {
        VStack(spacing: 10) {
            greenViewButton
            measureButton
            profileButton
            circleButton(systemImage: "plus", label: "Zoom in") { model.zoomIn() }
            circleButton(systemImage: "minus", label: "Zoom out") { model.zoomOut() }
            circleButton(systemImage: "scope", label: "Recenter on hole", size: 18) {
                model.recenter()
            }
        }
    }

    /// Toggles the measure tool (tap-to-place point-to-point measurement).
    /// Amber while active, matching the measure overlay palette.
    private var measureButton: some View {
        Button {
            if isMeasure {
                exitMeasure()
            } else {
                enterMeasure()
            }
        } label: {
            Image(systemName: "ruler")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(isMeasure ? MeasurePanel.amber : Color.primary)
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isMeasure ? "Exit measure" : "Measure")
    }

    /// Toggles the elevation-profile sheet (non-modal; the map stays live).
    private var profileButton: some View {
        Button {
            showProfile.toggle()
        } label: {
            Image(systemName: "chart.xyaxis.line")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(showProfile ? MeasurePanel.amber : Color.primary)
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(showProfile ? "Close elevation profile" : "Elevation profile")
    }

    /// Toggles the transient Green view (green slope/height analysis). Filled
    /// tinted glyph while active so the mode is unmistakable.
    private var greenViewButton: some View {
        Button {
            if isGreenView {
                exitGreenView()
            } else {
                enterGreenView()
            }
        } label: {
            Image(systemName: isGreenView ? "flag.circle.fill" : "flag.circle")
                .font(.system(size: 19, weight: .semibold))
                .foregroundStyle(isGreenView ? Color.green : Color.primary)
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(model.currentHole?.green == nil)
        .opacity(model.currentHole?.green == nil ? 0.35 : 1)
        .accessibilityLabel(isGreenView ? "Exit green view" : "Green view")
    }

    // MARK: - Green view enter/exit

    private func enterGreenView() {
        guard let hole = model.currentHole else { return }
        let center = hole.green.map { LatLon(lat: $0.centerLat, lon: $0.centerLon) }
        guard let bounds = greenAnalysis.activate(holeId: hole.hole.id, greenCenter: center)
        else { return }
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            model.enterTool(.greenView, focusBounds: bounds)
        }
    }

    private func exitGreenView() {
        greenAnalysis.deactivate()
        withAnimation(.easeInOut(duration: 0.28)) {
            model.exitTool()
        }
    }

    // MARK: - Measure enter/exit

    /// Tools are mutually exclusive: entering measure drops any Green view
    /// state (enterTool replaces the mode; the analysis model must be told).
    private func enterMeasure() {
        if greenAnalysis.isActive {
            greenAnalysis.deactivate()
        }
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            model.enterTool(.measure)
        }
    }

    private func exitMeasure() {
        measure.clear()
        withAnimation(.easeInOut(duration: 0.28)) {
            model.exitTool()
        }
    }

    // MARK: - Elevation profile plumbing

    /// The path the profile reads: the measure path while measuring (once it
    /// has two points), else the full hole route (tee → aims → green).
    private var profilePath: [LatLon] {
        if isMeasure && measure.hasPath {
            return measure.pathPositions
        }
        return model.holeRoute
    }

    /// Labels paralleling `profilePath` vertices.
    private var profileLabels: [String] {
        if isMeasure && measure.hasPath {
            return (0..<measure.points.count).map(MeasureOverlay.pointLabel)
        }
        guard let hole = model.currentHole else { return [] }
        var labels: [String] = []
        if model.teePosition(for: hole) != nil { labels.append("Tee") }
        labels.append(contentsOf: hole.aimPoints.enumerated().map { index, aim in
            aim.label.flatMap { $0.isEmpty ? nil : $0 } ?? "Aim \(index + 1)"
        })
        if hole.green != nil { labels.append("Green") }
        return labels
    }

    private var profileTitle: String {
        if isMeasure && measure.hasPath {
            return "Elevation · Measure path"
        }
        return "Elevation · Hole \(model.currentHoleNumber) Tee→Green"
    }

    private func refreshProfile() {
        profile.update(path: profilePath, labels: profileLabels)
    }

    /// Re-sample only while the sheet is up (no background sampling cost).
    private func refreshProfileIfShown() {
        if showProfile { refreshProfile() }
    }

    private func circleButton(
        systemImage: String,
        label: String,
        size: CGFloat = 17,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: - Compact chip (immersive mode)

/// The single always-visible readout in immersive mode: hole number + the
/// primary center distance (routed target label when GPS routing is active).
private struct CompactChipView: View {
    let model: OnCourseModel

    var body: some View {
        HStack(spacing: 8) {
            Text("H\(model.currentHoleNumber)")
                .font(.footnote.weight(.bold))
            Divider().frame(height: 14)
            if let routed = model.routedAimDistance {
                Image(systemName: "arrow.up.forward")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("\(routed.meters) m")
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
            } else {
                Text(centerText)
                    .font(.footnote.weight(.semibold))
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.ultraThinMaterial.opacity(0.85), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private var centerText: String {
        if let center = model.distances?.center { return "\(center) m" }
        return "–"
    }
}

// MARK: - Hole header

private struct HoleHeaderView: View {
    let model: OnCourseModel

    var body: some View {
        HStack(spacing: 8) {
            stepButton(systemImage: "chevron.left", enabled: model.canGoPrevious) {
                model.previousHole()
            }
            VStack(spacing: 1) {
                Text("Hole \(model.currentHoleNumber)")
                    .font(.headline)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .frame(maxWidth: .infinity)
            stepButton(systemImage: "chevron.right", enabled: model.canGoNext) {
                model.nextHole()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.ultraThinMaterial.opacity(0.82), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .holeSwipeGesture(model: model)
    }

    private var subtitle: String {
        guard let hole = model.currentHole?.hole else { return "" }
        var parts = ["Par \(hole.par)"]
        if let si = hole.strokeIndex { parts.append("SI \(si)") }
        if let length = model.playingLength, let meters = length.meters {
            let tee = model.resolvedTeeName.map { "\($0) " } ?? ""
            parts.append("\(tee)\(length.approximate ? "~" : "")\(meters) m")
        }
        return parts.joined(separator: " · ")
    }

    private func stepButton(systemImage: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.3)
    }
}

// MARK: - Distance card

private struct DistanceCardView: View {
    let model: OnCourseModel

    // Match the map marker convention: front red / center white / back blue.
    private static let frontColor = Color(red: 0.88, green: 0.19, blue: 0.19)
    private static let backColor = Color(red: 0.31, green: 0.56, blue: 0.82)
    private static let pinColor = Color(red: 1.0, green: 0.83, blue: 0.23)

    var body: some View {
        VStack(spacing: 8) {
            frontCenterBack
            if let routed = model.routedAimDistance {
                toAimRow(routed)
            }
            if let distances = model.distances, distances.pin != nil {
                pinRow(distances)
            }
            if model.isBrowseMode, !model.routeLegs.isEmpty {
                routeRow
            } else if let distances = model.distances, !distances.aims.isEmpty {
                aimRow(distances.aims)
            }
            bottomRow
        }
        .padding(.horizontal, 14)
        .padding(.top, 9)
        .padding(.bottom, 8)
        .background(.ultraThinMaterial.opacity(0.82), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .holeSwipeGesture(model: model)
    }

    // Big F / C / B numbers; plays-like under center.
    private var frontCenterBack: some View {
        let distances = model.distances
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            sideValue(label: "FRONT", value: distances?.front, color: Self.frontColor)
                .frame(maxWidth: .infinity)
            VStack(spacing: 0) {
                Text(Self.format(distances?.center))
                    .font(.system(size: 52, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text(centerCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .frame(maxWidth: .infinity)
            sideValue(label: "BACK", value: distances?.back, color: Self.backColor)
                .frame(maxWidth: .infinity)
        }
    }

    private var centerCaption: String {
        if let playsLike = model.distances?.playsLikeCenter {
            return "CENTER · PL \(playsLike)"
        }
        return "CENTER"
    }

    private func sideValue(label: String, value: Int?, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(Self.format(value))
                .font(.system(size: 30, weight: .semibold, design: .rounded))
                .monospacedDigit()
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
        }
    }

    private func pinRow(_ distances: OnCourseDistances) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "flag.fill")
                .font(.caption)
                .foregroundStyle(Self.pinColor)
            Text("Pin\(model.targets.activePinName.map { " · \($0)" } ?? "")")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            if let playsLike = distances.playsLikePin {
                Text("PL \(playsLike)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            Text("\(Self.format(distances.pin)) m")
                .font(.callout.weight(.semibold))
                .monospacedDigit()
        }
    }

    private func aimRow(_ aims: [AimDistance]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(aims.enumerated()), id: \.offset) { _, aim in
                    HStack(spacing: 4) {
                        Image(systemName: "smallcircle.filled.circle")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        Text(aim.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(aim.meters)")
                            .font(.caption.weight(.semibold))
                            .monospacedDigit()
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.08), in: Capsule())
                }
            }
        }
    }

    // GPS mode, user past the aim-routing threshold: emphasize distance to the
    // aim the line now points at.
    private func toAimRow(_ aim: AimDistance) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.up.forward")
                .font(.caption)
                .foregroundStyle(Self.pinColor)
            Text("TO \(aim.label.uppercased())")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(aim.meters) m")
                .font(.callout.weight(.bold))
                .monospacedDigit()
        }
    }

    // Browse mode: per-leg route distances (tee→aim1, …, →green) + total.
    private var routeRow: some View {
        let legs = model.routeLegs
        return VStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(legs.enumerated()), id: \.offset) { index, meters in
                        HStack(spacing: 4) {
                            Text(legLabel(index: index, count: legs.count))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("\(meters)")
                                .font(.caption.weight(.semibold))
                                .monospacedDigit()
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(.white.opacity(0.08), in: Capsule())
                    }
                }
            }
            if let length = model.playingLength, let total = length.meters {
                Text("Route \(length.approximate ? "~" : "")\(total) m")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    // Leg labels: first from the tee, last into the green, aims in between.
    private func legLabel(index: Int, count: Int) -> String {
        let from = index == 0 ? "Tee" : "A\(index)"
        let to = index == count - 1 ? "Green" : "A\(index + 1)"
        return "\(from)→\(to)"
    }

    private var bottomRow: some View {
        HStack {
            teeMenu
            Spacer()
            locationToggle
        }
    }

    // "Black — 512 m" for a tee on this hole; "White — —" for a course-level
    // tee not placed here (length undefined). Matches the header's figure for
    // the active tee.
    private func teeMenuLabel(_ entry: OnCourseModel.TeeMenuEntry) -> String {
        guard let length = entry.length, let meters = length.meters else {
            return "\(entry.name) — —"
        }
        return "\(entry.name) — \(length.approximate ? "~" : "")\(meters) m"
    }

    private var teeMenu: some View {
        Menu {
            // Longest-first, each row carrying THIS tee's playing length on the
            // current hole. Tees not placed on this hole trail with no length.
            Picker("Tee", selection: Binding(
                get: { model.resolvedTeeName ?? "" },
                set: { model.selectTee(named: $0) }
            )) {
                ForEach(model.teeMenuEntries) { entry in
                    Text(teeMenuLabel(entry)).tag(entry.name)
                }
            }
            if model.currentTeeHasOverride {
                Divider()
                Button(role: .destructive) {
                    model.resetActiveTee()
                } label: {
                    Label("Reset moved tee", systemImage: "arrow.uturn.backward")
                }
            }
            if model.isBrowseMode {
                Text("Long-press the map to move this tee")
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: model.currentTeeHasOverride ? "flag.circle.fill" : "flag.circle")
                Text(model.resolvedTeeName ?? "Tee")
                if model.currentTeeHasOverride {
                    Image(systemName: "mappin.and.ellipse")
                        .font(.caption2)
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
            }
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.white.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    // Tappable pill: toggles GPS ↔ Browse. In browse mode the live fix is
    // ignored and the map shows the full hole route.
    private var locationToggle: some View {
        Button {
            model.toggleGPS()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: locationIcon)
                    .font(.caption)
                Text(locationLabel)
                    .font(.caption)
            }
            .foregroundStyle(model.isUsingGPS ? Color.green : Color.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.white.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.isBrowseMode ? "Browse mode, tap for GPS" : "GPS mode, tap to browse")
    }

    private var locationIcon: String {
        if model.isBrowseMode { return "hand.draw" }
        return model.isUsingGPS ? "location.fill" : "location.slash"
    }

    private var locationLabel: String {
        if model.isBrowseMode { return "Browse" }
        if model.isUsingGPS { return "GPS" }
        return model.isLocationDenied ? "No location · from tee" : "From tee"
    }

    private static func format(_ value: Int?) -> String {
        value.map(String.init) ?? "–"
    }
}

// MARK: - Swipe navigation

private extension View {
    /// Horizontal swipe on the chrome switches holes (the map itself keeps
    /// its pan gesture).
    func holeSwipeGesture(model: OnCourseModel) -> some View {
        gesture(
            DragGesture(minimumDistance: 30)
                .onEnded { value in
                    guard abs(value.translation.width) > abs(value.translation.height) else { return }
                    if value.translation.width < -40 {
                        model.nextHole()
                    } else if value.translation.width > 40 {
                        model.previousHole()
                    }
                }
        )
    }
}
