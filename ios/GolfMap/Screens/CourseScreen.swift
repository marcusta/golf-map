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
    @State private var puttRead: PuttReadModel?
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
            if let model, let greenAnalysis, let puttRead, let measure, let profile,
               let mapInputs {
                OnCourseContentView(
                    model: model,
                    greenAnalysis: greenAnalysis,
                    puttRead: puttRead,
                    measure: measure,
                    profile: profile,
                    configuration: mapInputs.configuration,
                    featuresGeoJSON: mapInputs.featuresGeoJSON,
                    client: env.client,
                    currentLocation: currentLocation
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
        // Keep the on-course gating live if the toggle is flipped in Settings
        // and the user returns to the map without a reload.
        .onChange(of: env.settings.competitionMode) { _, on in
            model?.competitionMode = on
            puttRead?.competitionMode = on
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

    /// Latest fix as a (position, horizontal accuracy) pair for the spot-level
    /// payload; nil until GPS locks.
    private var currentLocation: (latLon: LatLon, horizontalAccuracyM: Double)? {
        guard let fix = locationProvider.location,
              let accuracy = locationProvider.horizontalAccuracy
        else { return nil }
        return (fix, accuracy)
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
            newModel.competitionMode = env.settings.competitionMode
            newModel.updateUserLocation(locationProvider.location)

            // Green view shares the bundle terrain pyramid with plays-like
            // sampling; green outlines come from features.geojson (greens'
            // boundaryJson is NULL in real bundles).
            let newGreenAnalysis = GreenAnalysisModel(
                featuresGeoJSON: featuresGeoJSON,
                sampler: { await terrain.elevation(at: $0) }
            )

            // Putt read (Tier 2 over the analysis grid + Tier 3 manual) —
            // competition-gated like plays-like.
            let newPuttRead = PuttReadModel()
            newPuttRead.competitionMode = env.settings.competitionMode

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
            puttRead = newPuttRead
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
    let puttRead: PuttReadModel
    let measure: MeasureModel
    let profile: ElevationProfileModel
    let configuration: CourseMapConfiguration
    let featuresGeoJSON: Data
    let client: GolfAPIClient
    let currentLocation: (latLon: LatLon, horizontalAccuracyM: Double)?

    /// Immersive mode: a short single-tap on the map hides the top hole bar and
    /// the bottom distances card, leaving the full-bleed hole, a small compact
    /// chip, and the right-side controls. Tap again to restore. Suspended
    /// while any tool is active (Green view chrome must stay put; in measure
    /// mode a tap PLACES a point; in adjust mode the handles own the touch).
    @State private var immersive = false
    /// Elevation-profile sheet. NOT a map tool — non-modal, openable over any
    /// mode; reads the measure path while measuring, else the hole route.
    @State private var showProfile = false
    /// Spot-level (IMU "phone as level") capture sheet.
    @State private var showLevel = false
    /// LiDAR corridor-scan flow (task E1) — only reachable on LiDAR devices.
    @State private var showScan = false

    private var isGreenView: Bool { model.toolMode == .greenView }
    private var isMeasure: Bool { model.toolMode == .measure }
    private var isAdjust: Bool { model.toolMode == .adjust }

    /// The putt read's Surface tier is live: green view up, surface installed,
    /// not competition-gated. Gates the tap-to-place and marker-drag inputs.
    private var isPuttSurfaceActive: Bool {
        isGreenView && !puttRead.competitionMode
            && puttRead.mode == .surface && puttRead.hasSurface
    }

    /// WGS84 → EPSG:3006 planar point for the putt model.
    private func puttPoint(_ position: LatLon) -> Vec2 {
        let p = Sweref99TM.fromWGS84(position)
        return Vec2(x: p.x, y: p.y)
    }

    /// Model overlays + the measure path while measuring + the draggable
    /// handles while adjusting. Route-leg distance labels are shown ONLY in
    /// immersive mode (chrome hidden) — with the chrome up the card's
    /// capsules already carry the legs — AND in Adjust mode, where the panel
    /// replaces the card (no duplication) and the on-map labels let you watch a
    /// leg distance change as you drag a tee / aim / green handle.
    private var overlays: MapOverlayState {
        var overlays = model.overlays(
            showRouteLabels: (immersive && model.toolMode == .none)
                || model.toolMode == .adjust
        )
        if isMeasure {
            overlays.measure = measure.overlay
        }
        if isAdjust {
            overlays.adjustHandles = model.adjustHandles
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
                putt: isGreenView ? puttRead.overlay : nil,
                onCameraChange: { model.noteMapCamera(center: $0, zoom: $1, bearing: $2) },
                // The browse-mode long-press "move tee" is RETIRED — it fired
                // simultaneously with MapLibre's quick-zoom (moving the tee
                // also zoomed the map). Adjust mode owns moves now.
                // The single-tap recognizer is shared: measure places a point;
                // the green view's putt read places the ball (or hole,
                // per the panel's tap target).
                measureTapEnabled: isMeasure || isPuttSurfaceActive,
                onMeasureTap: { position in
                    if isMeasure {
                        measure.place(position)
                    } else {
                        puttRead.handleTap(puttPoint(position))
                    }
                },
                // The handle-drag recognizer is shared too: Adjust drags the
                // tee/aim/green handles; the green view drags the putt
                // ball/hole markers (ids routed below). Only Adjust locks the
                // map's gesture zoom for the whole mode.
                adjustEnabled: isAdjust || isPuttSurfaceActive,
                adjustLocksGestures: isAdjust,
                onHandleGrab: { id in
                    guard !id.hasPrefix("putt-") else { return }
                    model.beginHandleDrag(id: id)
                },
                onHandleMove: { id, position in
                    switch id {
                    case PuttReadGeometry.PuttOverlay.ballHandleID:
                        puttRead.dragBall(puttPoint(position))
                    case PuttReadGeometry.PuttOverlay.holeHandleID:
                        puttRead.dragHole(puttPoint(position))
                    default:
                        model.moveHandle(id: id, to: position)
                    }
                },
                onHandleDrop: { id in
                    if id.hasPrefix("putt-") {
                        puttRead.commitDrag()
                    } else {
                        model.endHandleDrag()
                    }
                }
            )
            .ignoresSafeArea()
            // Short tap toggles chrome. High minimumDistance drag-less tap so it
            // doesn't swallow the map's own pan. Inert while a tool is active:
            // in Green view a stray tap must not hide the analysis panel, in
            // measure mode the tap places a point, and in adjust mode the map
            // surface belongs to the handles (UIKit recognizers in
            // CourseMapView).
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
                    GreenViewPanel(
                        model: greenAnalysis,
                        putt: puttRead,
                        onLevel: { showLevel = true },
                        // Scan is only OFFERED where the hardware can deliver
                        // it (sceneDepth/LiDAR) — nil hides the affordance.
                        onScan: CorridorScanService.isSupported ? { showScan = true } : nil,
                        onClose: { exitGreenView() }
                    )
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
                } else if isAdjust {
                    AdjustPanel(model: model, onClose: { exitAdjust() })
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
                puttRead.deactivate()
            }
            measure.clear()
            refreshProfileIfShown()
        }
        // Hand the analysis grid to the putt read when the terrain sampling
        // settles (also on buffer-change re-samples). A failed/absent grid
        // auto-offers the Manual tier.
        .onChange(of: greenAnalysis.isLoading) { _, loading in
            guard !loading, isGreenView else { return }
            puttRead.installGrid(greenAnalysis.result?.grid)
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
        .sheet(isPresented: $showLevel) {
            if let greenId = model.currentHole?.green?.id {
                SpotLevelCaptureSheet(
                    greenId: greenId,
                    location: currentLocation,
                    client: client,
                    onClose: { showLevel = false }
                )
            }
        }
        // The corridor-scan flow (task E1). Requires both putt markers — the
        // scan surface anchors to them (the Scan button is disabled until
        // they exist, so the guards only protect against races).
        .sheet(isPresented: $showScan) {
            if let greenId = model.currentHole?.green?.id,
               let ball = puttRead.ball, let hole = puttRead.hole {
                CorridorScanSheet(
                    greenId: greenId,
                    ballWorld: ball,
                    holeWorld: hole,
                    location: currentLocation,
                    client: client,
                    onUse: { puttRead.installScannedSurface($0) },
                    onClose: { showScan = false }
                )
                .interactiveDismissDisabled()
            }
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
                    // `-puttBall "lat,lon"` places the putt-read ball after the
                    // terrain grid settles and dumps a PUTT-DEBUG summary, so
                    // the read numbers can be live-verified headlessly (taps
                    // aren't scriptable via simctl).
                    if let raw = UserDefaults.standard.string(forKey: "puttBall") {
                        let nums = raw.split(separator: ",")
                        if nums.count == 2, let lat = Double(nums[0]), let lon = Double(nums[1]) {
                            // Give the async grid sampling time to land.
                            try? await Task.sleep(nanoseconds: 4_000_000_000)
                            puttRead.handleTap(puttPoint(LatLon(lat: lat, lon: lon)))
                            puttRead.computeSurfaceReadNow()
                            Self.writePuttDebugSummary(puttRead)
                        }
                    }
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
            // `-adjust 1` enters Adjust mode after the style-load hole fit;
            // `-adjustMove "tee:lat,lon;aim0:lat,lon;green:lat,lon"` injects
            // overrides through the SAME setHandleOverride accessor/
            // persistence path a drag commit takes (real finger drags aren't
            // scriptable via simctl); `-adjustReset 1` resets the hole
            // afterwards. Each dumps an ADJUST-DEBUG summary for live-verify.
            if UserDefaults.standard.string(forKey: "adjust") == "1" {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    enterAdjust()
                    if let raw = UserDefaults.standard.string(forKey: "adjustMove") {
                        for part in raw.split(separator: ";") {
                            let pair = part.split(separator: ":")
                            guard pair.count == 2,
                                  let id = Self.debugHandleID(String(pair[0]), model: model)
                            else { continue }
                            let nums = pair[1].split(separator: ",")
                            guard nums.count == 2,
                                  let lat = Double(nums[0]), let lon = Double(nums[1])
                            else { continue }
                            model.setHandleOverride(id: id, to: LatLon(lat: lat, lon: lon))
                        }
                    }
                    if UserDefaults.standard.string(forKey: "adjustReset") == "1" {
                        model.resetCurrentHoleAdjustments()
                    }
                    // Give the async green terrain re-sample time to land.
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    Self.writeAdjustDebugSummary(model)
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
    /// `-adjustMove` token → model handle id: "tee", "green", or "aimN"
    /// (index into the current hole's aim points, tee→green order).
    private static func debugHandleID(_ token: String, model: OnCourseModel) -> String? {
        switch token {
        case "tee": return OnCourseModel.teeHandleID
        case "green": return OnCourseModel.greenHandleID
        default:
            guard token.hasPrefix("aim"),
                  let index = Int(token.dropFirst(3)),
                  let hole = model.currentHole,
                  hole.aimPoints.indices.contains(index)
            else { return nil }
            return OnCourseModel.aimHandleID(hole.aimPoints[index].id)
        }
    }

    /// Live-verify hook: dumps the adjust state (handles, overridden ids,
    /// route legs, distances) so a headless run can check the moved
    /// route/distances against an independent recompute.
    private static func writeAdjustDebugSummary(_ model: OnCourseModel) {
        let distances = model.distances
        let summary: [String: Any] = [
            "handles": model.adjustHandles.map {
                ["id": $0.id, "label": $0.label, "lat": $0.position.lat, "lon": $0.position.lon]
            },
            "overridden": model.overriddenHandleIDs.sorted(),
            "routeLegs": model.routeLegs,
            "playingLengthMeters": model.playingLength?.meters ?? NSNull() as Any,
            "distances": [
                "front": distances?.front ?? NSNull() as Any,
                "center": distances?.center ?? NSNull() as Any,
                "back": distances?.back ?? NSNull() as Any,
                "playsLikeCenter": distances?.playsLikeCenter ?? NSNull() as Any,
                "aims": (distances?.aims ?? []).map { ["label": $0.label, "meters": $0.meters] },
            ],
        ]
        let url = FileManager.default.temporaryDirectory
            .appending(path: "adjust-debug.json")
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) {
            try? data.write(to: url)
            print("ADJUST-DEBUG \(String(data: data, encoding: .utf8) ?? "")")
        }
    }

    /// Live-verify hook: dumps the putt-read display (status, read numbers,
    /// tour verbal) so a headless `-puttBall` run can check them against an
    /// independent readPutt over the same grid.
    private static func writePuttDebugSummary(_ puttRead: PuttReadModel) {
        let display = puttRead.display
        let summary: [String: Any] = [
            "status": String(describing: display.status),
            "mode": display.mode.rawValue,
            "stimpFt": puttRead.stimpFt,
            "message": display.message ?? NSNull() as Any,
            "read": display.read.map { [
                "availability": $0.availability.rawValue,
                "aimOffsetM": $0.aimOffsetM,
                "playsLikeM": $0.playsLikeM,
                "holedProb": $0.holedProb,
                "canStop": $0.canStop,
                "minConfidence": $0.minConfidence,
                "pathCount": $0.path.count,
            ] } ?? NSNull() as Any,
            "verbal": display.verbal?.combined ?? NSNull() as Any,
        ]
        let url = FileManager.default.temporaryDirectory
            .appending(path: "putt-debug.json")
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) {
            try? data.write(to: url)
            print("PUTT-DEBUG \(String(data: data, encoding: .utf8) ?? "")")
        }
    }

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

    // Stacked bottom-right controls: green view / measure / adjust / profile /
    // zoom in / zoom out / recenter.
    private var controlStack: some View {
        VStack(spacing: 10) {
            greenViewButton
            levelButton
            measureButton
            adjustButton
            profileButton
            circleButton(systemImage: "plus", label: "Zoom in") { model.zoomIn() }
            circleButton(systemImage: "minus", label: "Zoom out") { model.zoomOut() }
            circleButton(systemImage: "scope", label: "Recenter on hole", size: 18) {
                model.recenter()
            }
        }
    }

    /// Opens the spot-level capture sheet ("phone as level" — one IMU
    /// calibration reading on the green). Disabled when the current hole has no
    /// green (no `greenId` to attach the scan to). Available in competition
    /// mode: capturing a level is measurement, not advice.
    private var levelButton: some View {
        Button {
            showLevel = true
        } label: {
            Image(systemName: "level")
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .mapControl()
        }
        .buttonStyle(.plain)
        .disabled(model.currentHole?.green == nil)
        .opacity(model.currentHole?.green == nil ? 0.35 : 1)
        .accessibilityLabel("Level the green")
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
                .mapControl()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isMeasure ? "Exit measure" : "Measure")
    }

    /// Toggles Adjust mode (drag tee / aim / green-center handles). Tinted
    /// with the adjust cyan while active; a dot badge marks a hole with
    /// moved elements.
    private var adjustButton: some View {
        Button {
            if isAdjust {
                exitAdjust()
            } else {
                enterAdjust()
            }
        } label: {
            Image(systemName: "arrow.up.and.down.and.arrow.left.and.right")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(isAdjust ? AdjustPanel.cyan : Color.primary)
                .frame(width: 44, height: 44)
                .mapControl()
                .overlay(alignment: .topTrailing) {
                    if model.currentHoleHasAdjustments {
                        Circle()
                            .fill(AdjustPanel.cyan)
                            .frame(width: 8, height: 8)
                            .offset(x: -3, y: 3)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isAdjust ? "Exit adjust" : "Adjust positions")
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
                .mapControl()
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
                .mapControl()
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
        // Arm the putt read: hole marker defaults to the active pin, else the
        // green center. The terrain grid follows when the sampling settles
        // (see the greenAnalysis.isLoading onChange).
        let activePin = hole.pins.first(where: \.active)
            .map { LatLon(lat: $0.lat, lon: $0.lon) }
        puttRead.activate(defaultHole: (activePin ?? center).map(puttPoint))
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            model.enterTool(.greenView, focusBounds: bounds)
        }
    }

    private func exitGreenView() {
        greenAnalysis.deactivate()
        puttRead.deactivate()
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
            puttRead.deactivate()
        }
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            // Keep the user's current view — entering Measure must not zoom.
            model.enterTool(.measure, refitCamera: false)
        }
    }

    private func exitMeasure() {
        measure.clear()
        withAnimation(.easeInOut(duration: 0.28)) {
            model.exitTool()
        }
    }

    // MARK: - Adjust enter/exit

    /// Adjust keeps the current hole framing (enterTool without focus bounds
    /// re-issues the standard hole fit). Mutually exclusive with the other
    /// tools, like measure.
    private func enterAdjust() {
        if greenAnalysis.isActive {
            greenAnalysis.deactivate()
            puttRead.deactivate()
        }
        measure.clear()
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            // Keep the user's current zoom/pan — entering Adjust must not yank
            // the view out to hole framing (the "zooms out when I tap Adjust"
            // report). Handles are reachable by pan / the +/- buttons.
            model.enterTool(.adjust, refitCamera: false)
        }
    }

    private func exitAdjust() {
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
                .mapControl()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: - Adjust panel

/// Bottom card while ADJUST mode is active (replaces the distance card):
/// a one-line instruction plus a per-hole Reset button, enabled only when
/// something on the hole is moved. The actual moving happens on the map —
/// drag the labeled handles (T / A1… / G).
private struct AdjustPanel: View {
    let model: OnCourseModel
    /// Exit adjust mode.
    let onClose: () -> Void

    /// Adjust cyan — distinct from measure amber and green-view green.
    static let cyan = Color(red: 0.35, green: 0.78, blue: 0.98)

    var body: some View {
        VStack(spacing: 8) {
            header
            Text("Drag a handle to move the tee, an aim point or the green center. Moves are saved on this device only.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
        .padding(.bottom, Space.s3)
        .glassPanel()
    }

    private var header: some View {
        HStack(spacing: 10) {
            Label("Adjust", systemImage: "arrow.up.and.down.and.arrow.left.and.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.cyan)
            Spacer()
            Button {
                model.resetCurrentHoleAdjustments()
            } label: {
                Label("Reset hole", systemImage: "arrow.uturn.backward")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(.white.opacity(0.08), in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!model.currentHoleHasAdjustments)
            .opacity(model.currentHoleHasAdjustments ? 1 : 0.35)
            .accessibilityLabel("Reset moved positions on this hole")
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Exit adjust")
        }
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
                .font(AppFont.mono(13, .semibold))
            Divider().frame(height: 14)
            if let routed = model.routedAimDistance {
                Image(systemName: "arrow.up.forward")
                    .font(.caption2)
                    .foregroundStyle(Overlay.textMuted)
                MetricText("\(routed.meters)", unit: "m", size: 13,
                           color: Overlay.text, unitColor: Overlay.textMuted)
            } else if let center = model.distances?.center {
                MetricText("\(center)", unit: "m", size: 13,
                           color: Overlay.text, unitColor: Overlay.textMuted)
            } else {
                MetricText("–", size: 13, color: Overlay.text)
            }
        }
        .mapLabelScrim()
        .accessibilityElement(children: .combine)
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
                    .font(AppFont.mono(11, .regular))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            stepButton(systemImage: "chevron.right", enabled: model.canGoNext) {
                model.nextHole()
            }
        }
        .padding(.horizontal, Space.s2)
        .padding(.vertical, Space.s1)
        .glassPanel(cornerRadius: 14)
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
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
        .padding(.bottom, Space.s2)
        .glassPanel()
        .holeSwipeGesture(model: model)
    }

    // Big F / C / B numbers; plays-like under center.
    private var frontCenterBack: some View {
        let distances = model.distances
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            sideValue(label: "Front", value: distances?.front, color: Self.frontColor)
                .frame(maxWidth: .infinity)
            VStack(spacing: 0) {
                MetricText(Self.format(distances?.center), size: 48)
                    .minimumScaleFactor(0.7)
                OverlineLabel(centerCaption, color: .secondary, size: 10)
            }
            .frame(maxWidth: .infinity)
            sideValue(label: "Back", value: distances?.back, color: Self.backColor)
                .frame(maxWidth: .infinity)
        }
    }

    private var centerCaption: String {
        if let playsLike = model.distances?.playsLikeCenter {
            return "Center · PL \(playsLike)"
        }
        return "Center"
    }

    private func sideValue(label: String, value: Int?, color: Color) -> some View {
        VStack(spacing: 2) {
            MetricText(Self.format(value), size: 28)
                .minimumScaleFactor(0.7)
            OverlineLabel(label, color: color, size: 10)
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
                MetricText("PL \(playsLike)", size: 12, weight: .regular, color: .secondary)
            }
            MetricText(Self.format(distances.pin), unit: "m", size: 15)
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
                        MetricText("\(aim.meters)", size: 12)
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
            OverlineLabel("To \(aim.label)", color: .secondary)
            Spacer()
            MetricText("\(aim.meters)", unit: "m", size: 16)
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
                            MetricText("\(meters)", size: 12)
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(.white.opacity(0.08), in: Capsule())
                    }
                }
            }
            if let length = model.playingLength, let total = length.meters {
                MetricText("Route \(length.approximate ? "~" : "")\(total)", unit: "m",
                           size: 11, weight: .regular, color: .secondary)
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
            Text("Move this tee with the Adjust tool")
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
