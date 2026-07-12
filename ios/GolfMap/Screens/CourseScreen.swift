import SwiftUI
import UIKit

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
    @State private var caddy: CaddyAdviceModel?
    @State private var puttRead: PuttReadModel?
    @State private var puttQuiz: PuttQuizModel?
    @State private var measure: MeasureModel?
    @State private var profile: ElevationProfileModel?
    @State private var roundModel: RoundModel?
    @State private var capture: CaptureModel?
    @State private var greenPolygons: GreenPolygonStore?
    @State private var mapInputs: MapInputs?
    @State private var locationProvider = LocationProvider()
    @State private var loadError: String?
    /// Per-green calibration for this course (greenId → calibration), synced +
    /// offline-cached on course open. Applied to the putt read when a green
    /// view is entered. Empty when the course has no calibrated greens.
    @State private var greenCalibrations: [String: GreenCalibration] = [:]

    private struct MapInputs {
        var configuration: CourseMapConfiguration
        var featuresGeoJSON: Data
    }

    var body: some View {
        Group {
            if let model, let greenAnalysis, let caddy, let puttRead, let puttQuiz, let measure,
               let profile, let roundModel, let capture, let mapInputs {
                OnCourseContentView(
                    model: model,
                    greenAnalysis: greenAnalysis,
                    caddy: caddy,
                    puttRead: puttRead,
                    puttQuiz: puttQuiz,
                    measure: measure,
                    profile: profile,
                    roundModel: roundModel,
                    capture: capture,
                    greenPolygons: greenPolygons,
                    greenCalibrations: greenCalibrations,
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
            // Caddy advice is advice → withheld in competition; the content
            // view recomputes it on the next Green-view activation / grid
            // settle, so clearing here is enough to hide it immediately.
            if on { caddy?.clear() }
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
            // Course hazard rings (bunker/water/penalty) for the distance card's
            // carry rows (Part A) + the caddy context. Parsed once from the same
            // features.geojson the map and green outlines use.
            if let hazardStore = try? HazardFeatureStore(featuresGeoJSON: featuresGeoJSON) {
                newModel.setHazards(hazardStore.rings)
            }
            newModel.updateUserLocation(locationProvider.location)

            // Game plan (read-only viewer): show whatever was cached last
            // right away, then refresh from the server in the background.
            // Online, the fresh plan (or its removal) replaces the cache;
            // offline / any failure degrades silently to the cached plan.
            if let cached = try? await GamePlanSync.loadCoursePlan(
                database: env.database, courseId: courseId
            ) {
                newModel.setPlan(cached)
            }
            // Club bag (user-level) drives the distance card's club advice +
            // the plan legs' suggested-club fallback; cached now, refreshed
            // below alongside the plan.
            if let cachedClubs = try? await env.database.allClubs() {
                newModel.setClubs(cachedClubs)
            }
            let planClient = env.client
            let planDatabase = env.database
            let planCourseId = courseId
            Task {
                do {
                    try await GamePlanSync.refresh(
                        client: planClient, database: planDatabase, courseId: planCourseId
                    )
                    let refreshed = try await GamePlanSync.loadCoursePlan(
                        database: planDatabase, courseId: planCourseId
                    )
                    newModel.setPlan(refreshed)
                    newModel.setClubs(try await planDatabase.allClubs())
                } catch {
                    // No network / server error: keep the cached plan. Log only.
                    print("Game plan refresh skipped: \(error)")
                }
            }

            // Per-green calibration (the read side of the green-scan round-trip,
            // doc §4.2): show whatever was cached last right away — so offline
            // rounds get their calibrated reads — then refresh from the server
            // in the background. Applied to the putt read on green-view entry;
            // any failure degrades silently to the cache (or the plain read).
            if let cached = try? await GreenCalibrationSync.load(
                database: env.database, courseId: courseId
            ) {
                greenCalibrations = cached
            }
            let calCourseId = courseId
            Task {
                do {
                    try await GreenCalibrationSync.refresh(
                        client: planClient, database: planDatabase, courseId: calCourseId
                    )
                    greenCalibrations = try await GreenCalibrationSync.load(
                        database: planDatabase, courseId: calCourseId
                    )
                } catch {
                    // Offline / server error: keep the cached calibration. Log only.
                    print("Green calibration refresh skipped: \(error)")
                }
            }

            // Green view shares the bundle terrain pyramid with plays-like
            // sampling; green outlines come from features.geojson (greens'
            // boundaryJson is NULL in real bundles).
            let newGreenAnalysis = GreenAnalysisModel(
                featuresGeoJSON: featuresGeoJSON,
                sampler: { await terrain.elevation(at: $0) }
            )

            // Putt read (Tier 2 over the analysis grid + Tier 3 manual) —
            // competition-gated like plays-like.
            let newPuttRead = PuttReadModel(defaultStimpFt: env.settings.defaultStimpFt)
            newPuttRead.competitionMode = env.settings.competitionMode
            let newPuttQuiz = PuttQuizModel()

            // Measure + elevation profile share the same bundle terrain
            // pyramid (one LRU of decoded tiles for the whole screen).
            let newMeasure = MeasureModel()
            newMeasure.elevationSampler = { await terrain.elevation(at: $0) }
            let newProfile = ElevationProfileModel()
            newProfile.elevationSampler = { await terrain.elevation(at: $0) }

            // Shot capture + scorecard: the round store is offline-first —
            // resuming the active round (endedAt == nil) works with no
            // network at all. Green outlines feed the putt/full auto
            // classification.
            let newRoundModel = RoundModel(
                courseId: courseId,
                holes: furniture.holes,
                database: env.database,
                sync: env.roundSync
            )
            await newRoundModel.loadActiveRound()
            greenPolygons = try? GreenPolygonStore(featuresGeoJSON: featuresGeoJSON)

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
            // `-planDemo 1` installs a synthetic one-shot-per-hole game plan
            // derived from the bundle furniture (no server round-trip), so
            // the plan overlay + card rows can be live-verified headlessly.
            if UserDefaults.standard.string(forKey: "planDemo") == "1" {
                newModel.setPlan(Self.demoPlan(furniture: furniture))
                newModel.setClubs(Self.demoClubs)
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
            caddy = CaddyAdviceModel()
            puttRead = newPuttRead
            puttQuiz = newPuttQuiz
            measure = newMeasure
            profile = newProfile
            roundModel = newRoundModel
            capture = CaptureModel()
        } catch {
            loadError = "Failed to load the course bundle: \(error.localizedDescription)"
        }
    }

    #if DEBUG
    /// `-planDemo` support: builds a synthetic plan from the downloaded
    /// furniture — on every hole with a tee and a green, one landing point at
    /// the tee→green midpoint (club "Demo 7i") and one gate at 60% of the
    /// hole, 15 m left / 20 m right of the line. Exercises the exact
    /// `CoursePlan.make` pipeline the real cache path uses.
    private static func demoPlan(furniture: CourseFurniture) -> CoursePlan {
        let teesByHole = Dictionary(grouping: furniture.tees, by: \.holeId)
        let greensByHole = Dictionary(
            furniture.greens.map { ($0.holeId, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        var holes: [GamePlanHoleRecord] = []
        var shots: [PlanShotRecord] = []
        var gates: [PlanGateRecord] = []
        for hole in furniture.holes {
            guard
                let tee = teesByHole[hole.id]?.min(by: { $0.sortOrder < $1.sortOrder }),
                let green = greensByHole[hole.id]
            else { continue }
            let holeRowId = "demo-plan-hole-\(hole.number)"
            holes.append(GamePlanHoleRecord(
                id: holeRowId, gamePlanId: "demo-plan",
                holeNumber: hole.number, teeId: tee.id
            ))
            let teePos = LatLon(lat: tee.lat, lon: tee.lon)
            let greenPos = LatLon(lat: green.centerLat, lon: green.centerLon)
            shots.append(PlanShotRecord(
                id: "\(holeRowId)-s1", gamePlanHoleId: holeRowId, sortOrder: 0,
                lat: (teePos.lat + greenPos.lat) / 2,
                lon: (teePos.lon + greenPos.lon) / 2,
                clubId: "demo-club"
            ))
            gates.append(PlanGateRecord(
                id: "\(holeRowId)-g1", gamePlanHoleId: holeRowId, sortOrder: 0,
                lat: teePos.lat + (greenPos.lat - teePos.lat) * 0.6,
                lon: teePos.lon + (greenPos.lon - teePos.lon) * 0.6,
                directionDeg: Distance.bearingDegrees(teePos, greenPos),
                halfWidthLeftM: 15, halfWidthRightM: 20, source: "manual"
            ))
        }
        return CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(
                    id: "demo-plan", courseId: furniture.course.id,
                    windSpeedMps: 5, windDirectionDeg: 45
                ),
                holes: holes, shots: shots, gates: gates
            ),
            clubs: [ClubRecord(id: "demo-club", name: "Demo 7i", carryM: 150, dispersionM: 12, sortOrder: 0)]
        )
    }

    /// A representative demo bag (`-planDemo`) so the card's club advice + the
    /// plan legs' suggested-club fallback render in headless live-verify.
    private static let demoClubs: [ClubRecord] = [
        ClubRecord(id: "d-dr", name: "Driver", carryM: 235, dispersionM: 60, sortOrder: 0),
        ClubRecord(id: "d-5i", name: "5i", carryM: 175, dispersionM: 38, sortOrder: 1),
        ClubRecord(id: "d-7i", name: "7i", carryM: 155, dispersionM: 32, sortOrder: 2),
        ClubRecord(id: "d-9i", name: "9i", carryM: 127, dispersionM: 30, sortOrder: 3),
        ClubRecord(id: "d-pw", name: "PW", carryM: 115, dispersionM: 27, sortOrder: 4),
    ]
    #endif
}

// MARK: - Content

/// Map + chrome once the bundle is loaded. Split out so `model` is non-optional.
private struct OnCourseContentView: View {
    let model: OnCourseModel
    let greenAnalysis: GreenAnalysisModel
    let caddy: CaddyAdviceModel
    let puttRead: PuttReadModel
    let puttQuiz: PuttQuizModel
    let measure: MeasureModel
    let profile: ElevationProfileModel
    let roundModel: RoundModel
    let capture: CaptureModel
    let greenPolygons: GreenPolygonStore?
    /// Per-green calibration (greenId → calibration) for the putt read, synced
    /// + offline-cached by the parent. Applied on green-view entry.
    let greenCalibrations: [String: GreenCalibration]
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
    /// Scorecard sheet — non-modal like the elevation profile, openable over
    /// any mode.
    @State private var showScorecard = false

    private var isGreenView: Bool { model.toolMode == .greenView }
    private var isMeasure: Bool { model.toolMode == .measure }
    private var isAdjust: Bool { model.toolMode == .adjust }
    private var isCapture: Bool { model.toolMode == .capture }

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
        if isCapture {
            overlays.adjustHandles = captureHandles
        }
        return overlays
    }

    /// The shot-capture crosshair (+ optional target) rendered/dragged
    /// through the shared adjust-handle plumbing. Capture and Adjust are
    /// mutually exclusive tool modes, so the source never carries both sets.
    private var captureHandles: [AdjustHandle] {
        var handles: [AdjustHandle] = []
        if capture.targetHandleVisible, let target = capture.target {
            handles.append(AdjustHandle(
                id: CaptureModel.targetHandleID, kind: .target, label: "◎", position: target
            ))
        }
        if capture.phase == .aiming, let position = capture.position {
            handles.append(AdjustHandle(
                id: CaptureModel.positionHandleID, kind: .shot, label: "✚", position: position
            ))
        }
        return handles
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
                // ball/hole markers; shot capture drags the crosshair/target
                // (ids routed below). Only Adjust locks the map's gesture
                // zoom for the whole mode.
                adjustEnabled: isAdjust || isPuttSurfaceActive || isCapture,
                adjustLocksGestures: isAdjust,
                onHandleGrab: { id in
                    guard !id.hasPrefix("putt-"), !id.hasPrefix("capture-") else { return }
                    model.beginHandleDrag(id: id)
                },
                onHandleMove: { id, position in
                    switch id {
                    case PuttReadGeometry.PuttOverlay.ballHandleID:
                        puttRead.dragBall(puttPoint(position))
                    case PuttReadGeometry.PuttOverlay.holeHandleID:
                        puttRead.dragHole(puttPoint(position))
                    case CaptureModel.positionHandleID:
                        capture.movePosition(position)
                    case CaptureModel.targetHandleID:
                        capture.moveTarget(position)
                    default:
                        model.moveHandle(id: id, to: position)
                    }
                },
                onHandleDrop: { id in
                    if id.hasPrefix("putt-") {
                        puttRead.commitDrag()
                    } else if !id.hasPrefix("capture-") {
                        // Capture positions commit on Confirm, not on drop.
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
                    HoleHeaderView(
                        model: model,
                        strokesOnHole: roundModel.hasActiveRound
                            ? roundModel.strokeCount(holeNumber: model.currentHoleNumber)
                            : nil
                    )
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
                        quiz: puttQuiz,
                        client: client,
                        greenId: model.currentHole?.green?.id,
                        caddy: caddy,
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
                } else if isCapture {
                    CapturePanel(
                        capture: capture,
                        holeNumber: model.currentHoleNumber,
                        strokesSoFar: roundModel.strokeCount(holeNumber: model.currentHoleNumber),
                        onConfirm: { confirmStroke(holeOut: false) },
                        onHoleOut: { confirmStroke(holeOut: true) },
                        onPenalty: { addPenaltyToLastStroke() },
                        onNextStroke: { rearmCapture() },
                        onClose: { exitCapture() }
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
                puttRead.deactivate()
            }
            caddy.clear()
            measure.clear()
            capture.end()
            refreshProfileIfShown()
        }
        // Hand the analysis grid to the putt read when the terrain sampling
        // settles (also on buffer-change re-samples). A failed/absent grid
        // auto-offers the Manual tier. The caddy advice recomputes off the same
        // settled grid (green-view only — the grid is not cheap to get on the
        // hole-view card).
        .onChange(of: greenAnalysis.isLoading) { _, loading in
            guard !loading, isGreenView else { return }
            puttRead.installGrid(greenAnalysis.result?.grid)
            recomputeCaddy()
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
        .sheet(isPresented: $showScorecard) {
            ScorecardSheet(
                roundModel: roundModel,
                clubs: model.clubs,
                onClose: { showScorecard = false }
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
            // `-captureDemo 1` (same family as `-planDemo`): starts a round
            // and records a scripted hole through the REAL capture write
            // path — tee full shot, midpoint full shot (+1 penalty), green
            // putt, hole-out — then dumps a CAPTURE-DEBUG summary (scorecard
            // + sync states) so the whole offline pipeline can be verified
            // headlessly. `-captureScorecard 1` also opens the sheet.
            if UserDefaults.standard.string(forKey: "captureDemo") == "1" {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    await roundModel.startRound(
                        gamePlanId: model.plan?.id, wind: planWindSnapshot
                    )
                    if let hole = model.currentHole,
                       let tee = model.teePosition(for: hole),
                       let green = model.greenCenterPosition(for: hole) {
                        let holeNumber = model.currentHoleNumber
                        let mid = LatLon(
                            lat: (tee.lat + green.lat) / 2,
                            lon: (tee.lon + green.lon) / 2
                        )
                        let club = model.clubs.first?.id
                        _ = await roundModel.recordStroke(
                            holeNumber: holeNumber, position: tee, clubId: club,
                            shotType: .full, target: mid
                        )
                        let approach = await roundModel.recordStroke(
                            holeNumber: holeNumber, position: mid, clubId: club,
                            shotType: .full, target: green
                        )
                        if let approach {
                            _ = await roundModel.addPenalty(shotId: approach.id)
                        }
                        _ = await roundModel.recordStroke(
                            holeNumber: holeNumber, position: green, clubId: nil,
                            shotType: .putt, target: green
                        )
                    }
                    Self.writeCaptureDebugSummary(roundModel)
                    if UserDefaults.standard.string(forKey: "captureScorecard") == "1" {
                        showScorecard = true
                    }
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

    /// Live-verify hook (`-captureDemo`): dumps the recorded round —
    /// scorecard lines + per-shot sync states — so a headless run can check
    /// the capture/aggregation/queue pipeline end to end.
    private static func writeCaptureDebugSummary(_ roundModel: RoundModel) {
        let card = roundModel.scorecard
        let summary: [String: Any] = [
            "round": roundModel.round.map {
                [
                    "id": $0.id,
                    "gamePlanId": $0.gamePlanId ?? NSNull() as Any,
                    "windSpeedMps": $0.windSpeedMps ?? NSNull() as Any,
                    "syncState": $0.syncState.rawValue,
                ]
            } ?? NSNull() as Any,
            "shots": roundModel.shots.map {
                [
                    "hole": $0.holeNumber,
                    "sortOrder": $0.sortOrder,
                    "shotType": $0.shotType.rawValue,
                    "clubId": $0.clubId ?? NSNull() as Any,
                    "penaltyStrokes": $0.penaltyStrokes,
                    "syncState": $0.syncState.rawValue,
                ]
            },
            "scorecard": card.lines.filter(\.played).map {
                [
                    "hole": $0.holeNumber,
                    "par": $0.par,
                    "score": $0.score,
                    "putts": $0.putts,
                    "penalties": $0.penalties,
                    "vsPar": $0.vsPar ?? NSNull() as Any,
                ]
            },
            "totalScore": card.total.score,
            "totalVsPar": card.total.vsPar ?? NSNull() as Any,
        ]
        let url = FileManager.default.temporaryDirectory
            .appending(path: "capture-debug.json")
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) {
            try? data.write(to: url)
            print("CAPTURE-DEBUG \(String(data: data, encoding: .utf8) ?? "")")
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

    // Stacked bottom-right controls: capture / scorecard / green view /
    // level / measure / adjust / plan (only when the course has one) /
    // profile / zoom in / zoom out / recenter.
    private var controlStack: some View {
        VStack(spacing: 10) {
            captureButton
            scorecardButton
            greenViewButton
            levelButton
            measureButton
            adjustButton
            if model.courseHasPlan {
                planButton
            }
            profileButton
            circleButton(systemImage: "plus", label: "Zoom in") { model.zoomIn() }
            circleButton(systemImage: "minus", label: "Zoom out") { model.zoomOut() }
            circleButton(systemImage: "scope", label: "Recenter on hole", size: 18) {
                model.recenter()
            }
        }
    }

    /// Toggles shot capture (records a stroke at the crosshair — available
    /// in competition mode: it is measurement, not advice). Entering with no
    /// active round starts one, snapshotting the plan link + wind.
    private var captureButton: some View {
        Button {
            if isCapture {
                exitCapture()
            } else {
                enterCapture()
            }
        } label: {
            Image(systemName: "plus.viewfinder")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(isCapture ? CapturePanel.rose : Color.primary)
                .frame(width: 44, height: 44)
                .mapControl()
                .overlay(alignment: .topTrailing) {
                    if roundModel.hasActiveRound {
                        Circle()
                            .fill(CapturePanel.rose)
                            .frame(width: 8, height: 8)
                            .offset(x: -3, y: 3)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCapture ? "Exit shot capture" : "Capture shot")
    }

    /// Opens the scorecard sheet (per-hole strokes/putts/penalties/vs-par).
    private var scorecardButton: some View {
        Button {
            showScorecard.toggle()
        } label: {
            Image(systemName: "list.number")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(showScorecard ? CapturePanel.rose : Color.primary)
                .frame(width: 44, height: 44)
                .mapControl()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scorecard")
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

    /// Shows/hides the game-plan overlay (read-only strategy from the web
    /// planner). Present only when the course has a plan; the visibility is
    /// persisted per course. NOT a map tool — it coexists with every mode.
    private var planButton: some View {
        Button {
            model.togglePlanVisible()
        } label: {
            Image(systemName: model.planVisible ? "signpost.right.fill" : "signpost.right")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(model.planVisible ? PlanStyle.violet : Color.primary)
                .frame(width: 44, height: 44)
                .mapControl()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.planVisible ? "Hide game plan" : "Show game plan")
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
        // Apply the synced per-green calibration (confidence lift + bias
        // correction) before the terrain grid settles, so the surface is built
        // right the first time. Uncalibrated greens pass nil → no-op.
        puttRead.applyCalibration(hole.green.flatMap { greenCalibrations[$0.id] })
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            model.enterTool(.greenView, focusBounds: bounds)
        }
    }

    private func exitGreenView() {
        greenAnalysis.deactivate()
        puttRead.deactivate()
        caddy.clear()
        withAnimation(.easeInOut(duration: 0.28)) {
            model.exitTool()
        }
    }

    /// Recompute the caddy advice from the Green view's settled grid + the
    /// hole's origin / green markers / hazards. Cheap pure math over already-
    /// sampled data — never per frame (called on activation / grid settle /
    /// competition toggle).
    private func recomputeCaddy() {
        guard let hole = model.currentHole else { caddy.clear(); return }
        caddy.recompute(
            grid: greenAnalysis.result?.grid,
            origin: model.origin,
            targets: model.targets,
            hazards: model.courseHazardRings,
            par: hole.hole.par,
            strokeIndex: hole.hole.strokeIndex,
            competition: model.competitionMode
        )
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

    // MARK: - Shot capture enter/exit + stroke writes

    /// The plan-level wind pair for the round snapshot (per-hole overrides
    /// stay per-hole — the round stores the round-level conditions, §3).
    private var planWindSnapshot: (speedMps: Double, directionDeg: Double)? {
        guard
            let plan = model.plan,
            let speed = plan.windSpeedMps,
            let direction = plan.windDirectionDeg
        else { return nil }
        return (speed, direction)
    }

    /// The current hole's green outline rings (EPSG:3006) for the putt/full
    /// auto classification; empty when the hole has no green polygon.
    private var captureGreenRings: [[Sweref99TM.Point]] {
        guard
            let hole = model.currentHole,
            let store = greenPolygons,
            let polygon = store.green(
                forHoleId: hole.hole.id,
                greenCenter: model.greenCenterPosition(for: hole)
            )
        else { return [] }
        return polygon.rings
    }

    /// Mutually exclusive with the other tools, like measure/adjust. Starts
    /// a round when none is active (offline: the row is local-first), then
    /// drops the crosshair at the GPS fix (browse mode: the map center).
    private func enterCapture() {
        if greenAnalysis.isActive {
            greenAnalysis.deactivate()
            puttRead.deactivate()
        }
        measure.clear()
        Task { @MainActor in
            if !roundModel.hasActiveRound {
                await roundModel.startRound(
                    gamePlanId: model.plan?.id,
                    wind: planWindSnapshot
                )
            }
            guard let position = model.captureStartPosition else { return }
            armCapture(at: position)
            withAnimation(.easeInOut(duration: 0.28)) {
                immersive = false
                // Keep the user's current view — capture must not yank the map.
                model.enterTool(.capture, refitCamera: false)
            }
            // The one place a placement haptic fires (with rearmCapture).
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    private func exitCapture() {
        capture.end()
        withAnimation(.easeInOut(duration: 0.28)) {
            model.exitTool()
        }
    }

    /// Arms the capture draft: crosshair at `position`, target pre-filled
    /// pin ?? next plan landing ?? green center, club pre-selected on the
    /// plays-like remaining, shot type auto (putt on the green).
    private func armCapture(at position: LatLon) {
        let targets = model.targets
        let planLandings = model.currentHolePlan?.shots.map(\.position) ?? []
        let target = ShotCaptureDefaults.defaultTarget(
            position: position,
            activePin: targets.activePin,
            planLandings: planLandings,
            greenCenter: targets.greenCenter
        )
        capture.begin(
            position: position,
            target: target,
            clubs: model.clubs,
            wind: model.effectiveWind,
            greenRings: captureGreenRings,
            // The user's sampled elevation only applies while the crosshair
            // IS the GPS fix; a drag degrades it (handled by the model).
            positionElevation: position == model.userLocation ? model.userElevation : nil,
            targetElevation: targets.greenElevation
        )
    }

    /// Confirm = one tap → writes the stroke AT the crosshair (played FROM,
    /// §2). Hole-out forces the final putt (its landing is the cup — no
    /// extra row needed).
    private func confirmStroke(holeOut: Bool) {
        guard let position = capture.position else { return }
        let shotType = holeOut ? ShotType.putt : capture.shotType
        let clubId = holeOut ? nil : capture.clubId
        let holeNumber = model.currentHoleNumber
        let target = capture.target
        Task { @MainActor in
            guard let shot = await roundModel.recordStroke(
                holeNumber: holeNumber,
                position: position,
                clubId: clubId,
                shotType: shotType,
                target: target
            ) else { return }
            capture.noteConfirmed(shot)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
    }

    /// The "+1 penalty" stepper on the just-confirmed stroke.
    private func addPenaltyToLastStroke() {
        guard let shotId = capture.lastConfirmed?.id else { return }
        Task { @MainActor in
            if let updated = await roundModel.addPenalty(shotId: shotId) {
                capture.noteUpdated(updated)
            }
        }
    }

    /// Re-arms the crosshair for the next stroke at the fresh GPS fix / map
    /// center (walk to the ball, tap, confirm).
    private func rearmCapture() {
        guard let position = model.captureStartPosition else { return }
        let targets = model.targets
        let planLandings = model.currentHolePlan?.shots.map(\.position) ?? []
        capture.rearm(
            position: position,
            target: ShotCaptureDefaults.defaultTarget(
                position: position,
                activePin: targets.activePin,
                planLandings: planLandings,
                greenCenter: targets.greenCenter
            ),
            positionElevation: position == model.userLocation ? model.userElevation : nil,
            targetElevation: targets.greenElevation
        )
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
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

// MARK: - Plan styling

/// The game-plan violet, shared by the toggle button and the card rows.
/// Matches the map overlay's `#a78bfa`.
private enum PlanStyle {
    static let violet = Color(red: 0.655, green: 0.545, blue: 0.98)
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
    @Environment(AppEnvironment.self) private var env

    private var unit: DistanceUnit { env.settings.distanceUnit }

    var body: some View {
        HStack(spacing: 8) {
            Text("H\(model.currentHoleNumber)")
                .font(AppFont.mono(13, .semibold))
            Divider().frame(height: 14)
            if let routed = model.routedAimDistance {
                Image(systemName: "arrow.up.forward")
                    .font(.caption2)
                    .foregroundStyle(Overlay.textMuted)
                MetricText(DistanceFormat.string(routed.meters, unit: unit), unit: unit.abbreviation, size: 13,
                           color: Overlay.text, unitColor: Overlay.textMuted)
            } else if let center = model.distances?.center {
                MetricText(DistanceFormat.string(center, unit: unit), unit: unit.abbreviation, size: 13,
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
    /// Strokes recorded on this hole so far; nil hides the badge (no active
    /// round).
    var strokesOnHole: Int?
    @Environment(AppEnvironment.self) private var env

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
            let unit = env.settings.distanceUnit
            parts.append("\(tee)\(length.approximate ? "~" : "")\(DistanceFormat.stringWithUnit(meters, unit: unit))")
        }
        // Per-hole stroke count while a round is being recorded.
        if let strokes = strokesOnHole {
            parts.append("\(strokes) str")
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
    @Environment(AppEnvironment.self) private var env

    // Match the map marker convention: front red / center white / back blue.
    private static let frontColor = Color(red: 0.88, green: 0.19, blue: 0.19)
    private static let backColor = Color(red: 0.31, green: 0.56, blue: 0.82)
    private static let pinColor = Color(red: 1.0, green: 0.83, blue: 0.23)

    private var unit: DistanceUnit { env.settings.distanceUnit }

    var body: some View {
        VStack(spacing: 8) {
            frontCenterBack
            if let clubs = model.distances?.centerClubs, clubs.hasAny {
                clubAdviceRow(clubs)
            }
            if let wind = model.effectiveWind {
                windRow(wind)
            }
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
            let hazards = model.hazardCarries
            if !hazards.isEmpty {
                hazardRow(hazards)
            }
            if let planTarget = model.planTargetDistance {
                toPlanRow(planTarget)
            }
            if !model.planLegs.isEmpty {
                planRow(model.planLegs)
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
                MetricText(DistanceFormat.string(distances?.center, unit: unit), size: 48)
                    .minimumScaleFactor(0.7)
                OverlineLabel(centerCaption, color: .secondary, size: 10)
            }
            .frame(maxWidth: .infinity)
            sideValue(label: "Back", value: distances?.back, color: Self.backColor)
                .frame(maxWidth: .infinity)
        }
    }

    private var centerCaption: String {
        guard let playsLike = model.distances?.playsLikeCenter else { return "Center" }
        let plText = DistanceFormat.string(playsLike, unit: unit)
        if let wind = model.distances?.windPlaysLikeCenter {
            return "Center · PL \(plText) → \(DistanceFormat.string(wind, unit: unit))"
        }
        return "Center · PL \(plText)"
    }

    // Front/center/back club advice for the (wind-adjusted) plays-like to the
    // green — clubAdvice's three slots. Slots absent at the extremes are
    // dropped. Hidden in competition mode (advice is computed nil there).
    private func clubAdviceRow(_ clubs: ClubAdviceLabels) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "bag.fill")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let front = clubs.front { clubChip("F", front, Self.frontColor) }
            if let center = clubs.center { clubChip("C", center, .primary) }
            if let back = clubs.back { clubChip("B", back, Self.backColor) }
            Spacer()
        }
    }

    private func clubChip(_ tag: String, _ name: String, _ color: Color) -> some View {
        HStack(spacing: 3) {
            if !tag.isEmpty {
                Text(tag)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(color)
            }
            Text(name)
                .font(.caption.weight(.medium))
                .foregroundStyle(tag.isEmpty ? color : .primary)
        }
    }

    // Small wind indicator: speed (m/s) + an arrow pointing the way the wind
    // blows (north-up). Only shown when the plan supplies a non-calm wind and
    // competition mode is off (`model.effectiveWind` is nil in both cases).
    private func windRow(_ wind: (speedMps: Double, directionDeg: Double)) -> some View {
        let speed = Int(wind.speedMps.rounded())
        return HStack(spacing: 6) {
            Image(systemName: "location.north.fill")
                .font(.caption2)
                // directionDeg is where the wind comes FROM; +180 points the
                // arrow the way the wind (and ball push) travels.
                .rotationEffect(.degrees(wind.directionDeg + 180))
                .foregroundStyle(.secondary)
            Text("Wind \(speed) m/s")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .accessibilityElement()
        .accessibilityLabel("Wind \(speed) meters per second from \(Int(wind.directionDeg.rounded())) degrees")
    }

    private func sideValue(label: String, value: Int?, color: Color) -> some View {
        VStack(spacing: 2) {
            MetricText(DistanceFormat.string(value, unit: unit), size: 28)
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
            if let club = distances.pinClub {
                clubChip("", club, Self.pinColor)
            }
            Spacer()
            if let playsLike = distances.playsLikePin {
                if let wind = distances.windPlaysLikePin {
                    MetricText("PL \(DistanceFormat.string(playsLike, unit: unit)) → \(DistanceFormat.string(wind, unit: unit))", size: 12, weight: .regular, color: .secondary)
                } else {
                    MetricText("PL \(DistanceFormat.string(playsLike, unit: unit))", size: 12, weight: .regular, color: .secondary)
                }
            }
            MetricText(DistanceFormat.string(distances.pin, unit: unit), unit: unit.abbreviation, size: 15)
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
                        MetricText(DistanceFormat.string(aim.meters, unit: unit), size: 12)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.08), in: Capsule())
                }
            }
        }
    }

    // Carry hazards on the primary line (origin → routed aim / green center):
    // "Bunker 182 / carry 195" capsules, nearest first. RAW line distances —
    // shown in competition mode too (measurement, not advice).
    private func hazardRow(_ hazards: [HazardCarry]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(Self.pinColor)
                ForEach(hazards) { hazard in
                    HStack(spacing: 4) {
                        Text(hazard.label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        MetricText(DistanceFormat.string(hazard.frontM, unit: unit), size: 12)
                        Text("/ carry")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        MetricText(DistanceFormat.string(hazard.carryM, unit: unit), size: 12)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.white.opacity(0.08), in: Capsule())
                }
            }
        }
    }

    // GPS mode with a plan: distance from the origin to the NEXT planned
    // landing point (the first plan shot not yet passed along the hole).
    private func toPlanRow(_ target: OnCourseModel.PlanTargetDistance) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "signpost.right.fill")
                .font(.caption)
                .foregroundStyle(PlanStyle.violet)
            OverlineLabel(
                "To plan" + (target.clubName.map { " · \($0)" } ?? ""),
                color: .secondary
            )
            Spacer()
            MetricText(DistanceFormat.string(target.meters, unit: unit), unit: unit.abbreviation, size: 16)
        }
    }

    // The hole's planned legs: "1 · Driver · 214 m" capsules in stroke order;
    // the last leg runs into the green. Follows the plan itself (not the
    // overlay toggle) — the numbers stay useful with the map layer hidden.
    private func planRow(_ legs: [OnCourseModel.PlanLeg]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Image(systemName: "signpost.right")
                    .font(.caption2)
                    .foregroundStyle(PlanStyle.violet)
                ForEach(legs) { leg in
                    HStack(spacing: 4) {
                        Text("\(leg.index) · \(planLegTitle(leg))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        MetricText(DistanceFormat.string(leg.meters, unit: unit), size: 12)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(PlanStyle.violet.opacity(0.16), in: Capsule())
                }
            }
        }
    }

    /// "Driver", "Driver · Layup left", "Green" (final leg), or "Shot". A leg
    /// with no planned club falls back to the suggested club, marked "~7i".
    private func planLegTitle(_ leg: OnCourseModel.PlanLeg) -> String {
        let club = leg.clubName ?? leg.suggestedClubName.map { "~\($0)" }
        if leg.toGreen {
            return club.map { "Green · \($0)" } ?? "Green"
        }
        let parts = [club, leg.label].compactMap { $0 }
        return parts.isEmpty ? "Shot" : parts.joined(separator: " · ")
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
            MetricText(DistanceFormat.string(aim.meters, unit: unit), unit: unit.abbreviation, size: 16)
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
                            MetricText(DistanceFormat.string(meters, unit: unit), size: 12)
                        }
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(.white.opacity(0.08), in: Capsule())
                    }
                }
            }
            if let length = model.playingLength, let total = length.meters {
                MetricText("Route \(length.approximate ? "~" : "")\(DistanceFormat.string(total, unit: unit))", unit: unit.abbreviation,
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
        return "\(entry.name) — \(length.approximate ? "~" : "")\(DistanceFormat.stringWithUnit(meters, unit: unit))"
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
