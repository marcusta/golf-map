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
    /// Tapscore scoring-bridge link for the active round (T65). Built with the
    /// round model; nil until the course finishes loading.
    @State private var tapscore: TapscoreLinkModel?
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
                    tapscore: tapscore,
                    capture: capture,
                    greenPolygons: greenPolygons,
                    greenCalibrations: greenCalibrations,
                    configuration: mapInputs.configuration,
                    featuresGeoJSON: mapInputs.featuresGeoJSON,
                    client: env.client,
                    currentLocation: currentLocation,
                    liveLocation: { [locationProvider] in
                        guard let fix = locationProvider.location,
                              let accuracy = locationProvider.horizontalAccuracy
                        else { return nil }
                        return (fix, accuracy)
                    }
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
        // Once the map is up, the hole header carries its own back button —
        // the system bar would stack on top of it over the map. Loading and
        // error states keep the bar (it is their only way back).
        .toolbar(model == nil ? .visible : .hidden, for: .navigationBar)
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
            let mapKey = furniture.course.mapKey
            let bundleDirectory = env.bundlePaths.mapBundleDirectory(mapKey: mapKey)
            let featuresGeoJSON = try Data(
                contentsOf: env.bundlePaths.courseFeaturesURL(courseId: courseId)
            )
            // The map renders the resolved variant (surface stack clipped
            // server-side so translucent fills don't compound at overlaps);
            // analysis consumers (hazards, green outlines) keep the raw
            // geometry. Older bundles have no resolved file — fall back.
            let renderFeaturesGeoJSON =
                (try? Data(
                    contentsOf: env.bundlePaths.courseResolvedFeaturesURL(courseId: courseId)
                ))
                ?? featuresGeoJSON

            let newModel = OnCourseModel(furniture: furniture)
            let terrain = TerrainElevationService(
                bundleDirectory: bundleDirectory,
                zoom: furniture.manifest.terrainQueryZoom
            )
            newModel.elevationSampler = { await terrain.elevation(at: $0) }
            newModel.isLocationDenied = locationProvider.isDenied
            newModel.competitionMode = env.settings.competitionMode
            // Course hazard rings (bunker/water/penalty) for the distance card's
            // carry rows (Part A) + the caddy context. Parsed once from the same
            // features.geojson the map and green outlines use.
            if let hazardStore = try? HazardFeatureStore(featuresGeoJSON: featuresGeoJSON) {
                newModel.setHazards(hazardStore.rings, holeIds: hazardStore.holeIds)
            }
            // The full surface stack (topmost-first) for the shot-viz aim
            // optimiser's lie classification — parsed from the SAME raw
            // features.geojson (the aim sweep classifies unclipped rings).
            if let surfaceStore = try? SurfaceFeatureStore(featuresGeoJSON: featuresGeoJSON) {
                newModel.setSurfaces(surfaceStore.surfaces)
            }
            newModel.updateUserLocation(locationProvider.location)

            // Planner tool write path (task T3): edits persist as GRDB dirty
            // rows and push through PlanSyncService, offline-first.
            newModel.planWriter = PlanEditStore(
                database: env.database, planSync: env.planSync, courseId: courseId
            ).writer()

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
            // Tapscore scoring bridge (T65): manages the round's link only —
            // once linked, the SERVER publishes each hole's score on every shot
            // write. Seeded from the local mirror so it reads correctly offline.
            let newTapscore = TapscoreLinkModel(roundModel: newRoundModel, api: env.client)
            // Seed the playing state (round loop R1) from the resumed round;
            // OnCourseContentView keeps it in sync on every capture / edit.
            newModel.setActiveRound(strokes: roundLoopStrokes(of: newRoundModel))
            // R6: a resumed round's stimp seeds the read (replacing the app
            // default). The `.onChange(round?.id)` handler keeps it in sync from
            // here on; this one covers the initial resume that predates it.
            if let stimp = newRoundModel.round?.stimpFt {
                newPuttRead.setStimp(stimp)
            }
            greenPolygons = try? GreenPolygonStore(featuresGeoJSON: featuresGeoJSON)

            #if DEBUG
            // Headless live-verify hook (same family as `-openCourse` in
            // CourseListScreen): `-openHole <n>` jumps straight to a hole so
            // navigation/camera refit can be verified without UI tapping.
            // DEBUG-only and inert without the flag.
            if let holeNumber = UserDefaults.standard.string(forKey: "openHole").flatMap(Int.init) {
                newModel.goToHole(number: holeNumber)
            }
            // `-placePinPhrase "<utterance>"` drives the pin-entry wiring
            // headlessly (voice + drag-confirm aren't scriptable via simctl):
            // parse the phrase with the default voice locale (`-pinLocale sv`
            // forces Swedish, else English), take the first candidate, resolve
            // it against the current hole's green frame + origin, and commit it
            // as today's pin. Prints PIN-DEBUG so a live-verify run can check
            // the placed lat/lon. DEBUG-only and inert without the flag.
            if let utterance = UserDefaults.standard.string(forKey: "placePinPhrase") {
                let locale: PinVoiceLocale =
                    UserDefaults.standard.string(forKey: "pinLocale") == "sv" ? .swedish : .english
                // The outcome is ALSO persisted under `pinDebug.lastResult` so a
                // headless run can read it from the container plist — simctl
                // console capture is unreliable, and each guard below can fail.
                let outcome: String
                if let phrase = PinPhraseParser.parse(utterance, locale: locale).first {
                    if let frame = newModel.currentGreenFrame {
                        if let resolution = newModel.resolvePinPhrase(phrase) {
                            newModel.commitPin(resolution)
                            let pin = PinPlacementSolver.pinWGS84(spec: resolution.spec, frame: frame)
                            outcome = "committed source=\(resolution.spec.source.rawValue) "
                                + "depth=\(resolution.spec.depthFromFrontM) frac=\(resolution.spec.lateralFraction) "
                                + "clamped=\(resolution.clamped) lat=\(pin.lat) lon=\(pin.lon)"
                        } else {
                            outcome = "no-resolution (origin missing?)"
                        }
                    } else {
                        outcome = "no-green-frame"
                    }
                } else {
                    outcome = "parse-failed utterance=\(utterance)"
                }
                print("PIN-DEBUG \(outcome)")
                UserDefaults.standard.set(outcome, forKey: "pinDebug.lastResult")
            }
            // `-applyCalibration "<biasE>,<biasN>"` installs a synthetic anchor
            // calibration (solvedNear = the raw fix, else the active tee; base
            // confidence 1; method .anchor; solvedAt now) so a headless run can
            // verify corrected distances without driving the capture UI. The
            // outcome — including the origin's planar shift before → after —
            // is ALSO persisted under `calibDebug.lastResult` (the pinDebug
            // pattern: simctl console capture is unreliable). Note the
            // correction only moves `origin` when GPS is on and a live fix
            // exists (browse/tee origins are map-anchored, spec §6.1), so a
            // fixless run reports shift 0 with the calibration still installed
            // and `calibrationStatus` active. DEBUG-only and inert without the
            // flag.
            if let raw = UserDefaults.standard.string(forKey: "applyCalibration") {
                let outcome: String
                let parts = raw.split(separator: ",")
                if parts.count == 2,
                   let biasE = Double(parts[0].trimmingCharacters(in: .whitespaces)),
                   let biasN = Double(parts[1].trimmingCharacters(in: .whitespaces)) {
                    let solvedNear = newModel.userLocation
                        ?? newModel.currentHole.flatMap { newModel.teePosition(for: $0) }
                    if let solvedNear {
                        let originBefore = newModel.origin
                        newModel.applyCalibration(OriginCalibration(
                            biasE: biasE,
                            biasN: biasN,
                            solvedAt: Date(),
                            solvedNear: solvedNear,
                            method: .anchor,
                            baseConfidence: 1
                        ))
                        let originAfter = newModel.origin
                        let shiftM: Double
                        if let originBefore, let originAfter {
                            shiftM = Distance.planarMeters(originBefore, originAfter)
                        } else {
                            shiftM = 0
                        }
                        outcome = "applied biasE=\(biasE) biasN=\(biasN) "
                            + "originShiftM=\(shiftM) "
                            + "status=\(String(describing: newModel.calibrationStatus))"
                    } else {
                        outcome = "no-anchor (no fix and no tee)"
                    }
                } else {
                    outcome = "parse-failed raw=\(raw)"
                }
                print("CALIB-DEBUG \(outcome)")
                UserDefaults.standard.set(outcome, forKey: "calibDebug.lastResult")
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
            // `-planDemo 1` installs a synthetic one-shot-per-hole game plan.
            // `-planOptions 1` installs the same fixture as a driver-vs-safe
            // tree with continuations for T32's headless option verification;
            // `-planOptions 2` installs the tree WITHOUT the T32 driver so a
            // `-roundState` decide scenario can run against authored options
            // without competing round writes (T37).
            let planOptionsFlag = UserDefaults.standard.string(forKey: "planOptions")
            let optionDemo = planOptionsFlag == "1" || planOptionsFlag == "2"
            if UserDefaults.standard.string(forKey: "planDemo") == "1" || optionDemo {
                newModel.setPlan(Self.demoPlan(furniture: furniture, withOptions: optionDemo))
                newModel.setClubs(Self.demoClubs)
            }
            #endif

            mapInputs = MapInputs(
                configuration: CourseMapConfiguration(
                    bundleDirectory: bundleDirectory,
                    manifest: furniture.manifest,
                    attribution: "© Lantmäteriet, CC BY 4.0"
                ),
                featuresGeoJSON: renderFeaturesGeoJSON
            )
            model = newModel
            greenAnalysis = newGreenAnalysis
            caddy = CaddyAdviceModel()
            puttRead = newPuttRead
            puttQuiz = newPuttQuiz
            measure = newMeasure
            profile = newProfile
            roundModel = newRoundModel
            tapscore = newTapscore
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
    private static func demoPlan(
        furniture: CourseFurniture,
        withOptions: Bool = false
    ) -> CoursePlan {
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
            let primaryId = "\(holeRowId)-s1"
            shots.append(PlanShotRecord(
                id: primaryId, gamePlanHoleId: holeRowId, sortOrder: 0,
                lat: (teePos.lat + greenPos.lat) / 2,
                lon: (teePos.lon + greenPos.lon) / 2,
                clubId: withOptions ? "d-dr" : "demo-club",
                label: withOptions ? "Attack" : nil
            ))
            if withOptions {
                shots.append(PlanShotRecord(
                    id: "\(holeRowId)-s1-next", gamePlanHoleId: holeRowId,
                    sortOrder: 0, parentShotId: primaryId,
                    lat: teePos.lat + (greenPos.lat - teePos.lat) * 0.78,
                    lon: teePos.lon + (greenPos.lon - teePos.lon) * 0.78,
                    clubId: "d-9i", label: "Wedge in"
                ))
                let safeId = "\(holeRowId)-safe"
                shots.append(PlanShotRecord(
                    id: safeId, gamePlanHoleId: holeRowId, sortOrder: 1,
                    lat: teePos.lat + (greenPos.lat - teePos.lat) * 0.34,
                    lon: teePos.lon + (greenPos.lon - teePos.lon) * 0.34,
                    clubId: "d-5i", label: "Safe line"
                ))
                shots.append(PlanShotRecord(
                    id: "\(holeRowId)-safe-next", gamePlanHoleId: holeRowId,
                    sortOrder: 0, parentShotId: safeId,
                    lat: teePos.lat + (greenPos.lat - teePos.lat) * 0.68,
                    lon: teePos.lon + (greenPos.lon - teePos.lon) * 0.68,
                    clubId: "d-7i", label: "Full approach"
                ))
            }
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
            clubs: [ClubRecord(
                id: "demo-club", name: "Demo 7i", carryM: 150,
                dispersionM: 12, sortOrder: 0
            )] + demoClubs
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

/// The active round's shots as playing-state stroke snapshots (round loop
/// R1), nil when no round is active. Shared by the initial seed in `load()`
/// and the content view's ongoing sync.
@MainActor
private func roundLoopStrokes(of roundModel: RoundModel) -> [OnCourseModel.RoundStroke]? {
    guard roundModel.hasActiveRound else { return nil }
    return roundModel.shots.map {
        OnCourseModel.RoundStroke(
            holeNumber: $0.holeNumber,
            position: LatLon(lat: $0.lat, lon: $0.lon),
            // Penalties ride on the stroke (§2) and feed the decide card's
            // probable-score baseline (R4) + the geofence "has no hole-out"
            // read — keep them on the snapshot the playing state derives from.
            penaltyStrokes: $0.penaltyStrokes
        )
    }
}

/// Map + chrome once the bundle is loaded. Split out so `model` is non-optional.
private extension View {
    /// Reports this view's frame in global (window) coordinates whenever it
    /// changes. Used to work out which parts of the full-bleed map are covered
    /// by chrome. iOS 17 has no `onGeometryChange`, hence the background reader.
    func trackFrame(_ update: @escaping (CGRect) -> Void) -> some View {
        background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { update(geo.frame(in: .global)) }
                    .onChange(of: geo.frame(in: .global)) { _, frame in update(frame) }
            }
        )
    }
}

private struct OnCourseContentView: View {
    let model: OnCourseModel
    let greenAnalysis: GreenAnalysisModel
    let caddy: CaddyAdviceModel
    let puttRead: PuttReadModel
    let puttQuiz: PuttQuizModel
    let measure: MeasureModel
    let profile: ElevationProfileModel
    let roundModel: RoundModel
    /// Tapscore link for the active round — the scorecard's "Scoring" section.
    let tapscore: TapscoreLinkModel?
    let capture: CaptureModel
    let greenPolygons: GreenPolygonStore?
    /// Per-green calibration (greenId → calibration) for the putt read, synced
    /// + offline-cached by the parent. Applied on green-view entry.
    let greenCalibrations: [String: GreenCalibration]
    let configuration: CourseMapConfiguration
    let featuresGeoJSON: Data
    let client: GolfAPIClient
    let currentLocation: (latLon: LatLon, horizontalAccuracyM: Double)?
    /// LIVE location accessor for the calibration sheet's fix pump — unlike
    /// the `currentLocation` snapshot above (re-made per render), a closure
    /// over `LocationProvider` stays fresh inside a long-running Task.
    /// MainActor-typed: it reads the provider's isolated properties.
    let liveLocation: @MainActor () -> (latLon: LatLon, horizontalAccuracyM: Double)?
    /// App environment — the round-start stimp seed reads `settings.defaultStimpFt`
    /// (round loop R6). Already in the view tree (DistanceCardView reads it too).
    @Environment(AppEnvironment.self) private var env

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
    /// Wind editor sheet (the wind chip in the control rail opens it).
    @State private var showWind = false
    /// Pin-entry sheet (the pin button on the distance card opens it).
    @State private var showPinEntry = false
    /// One contextual laser entry (R7): pin / trilateration / residual refresh.
    @State private var showLaserEntry = false
    /// Trilateration shots survive closing the one-shot laser sheet so the
    /// player can browse-pick the next feature between observations.
    @State private var laserSession = CalibrationSession()
    /// GPS calibration sheet (the calibrate button / status chip open it).
    @State private var showCalibration = false

    // MARK: Chrome geometry (green-view camera fit)

    /// The map's own frame (it ignores the safe area, so this is the full
    /// window) and the frame of the chrome stack laid out inside the safe area.
    /// Together with the measured header/panel heights they give the map's
    /// covered edges — see `greenViewCameraInsets`.
    @State private var mapFrame: CGRect = .zero
    @State private var chromeFrame: CGRect = .zero
    @State private var headerHeight: CGFloat = 0
    /// Last measured Green-view panel height. Seeded with a plausible value so
    /// the fit on the FIRST entry (before the panel has ever been laid out) is
    /// already close; the post-layout `refitTool` corrects it.
    @State private var greenPanelHeight: CGFloat = 240

    /// Padding the Green-view camera fit must add on each edge so the green
    /// lands centered between the hole header and the panel rather than in the
    /// middle of the (partly covered) viewport.
    private var greenViewCameraInsets: MapEdgeInsets {
        guard mapFrame.height > 0, chromeFrame.height > 0 else { return .zero }
        let safeTop = max(0, chromeFrame.minY - mapFrame.minY)
        let safeBottom = max(0, mapFrame.maxY - chromeFrame.maxY)
        return MapEdgeInsets(
            top: Double(safeTop + headerHeight + 8),
            left: 8,
            bottom: Double(safeBottom + greenPanelHeight + 16),
            right: 8
        )
    }

    /// Pops back to the course list — the system navigation bar is hidden on
    /// this screen (it collided with the hole header), so the header row
    /// carries its own back button.
    @Environment(\.dismiss) private var dismiss

    private var isGreenView: Bool { model.toolMode == .greenView }
    private var isMeasure: Bool { model.toolMode == .measure }
    private var isAdjust: Bool { model.toolMode == .adjust }
    private var isCapture: Bool { model.toolMode == .capture }
    private var isPlan: Bool { model.toolMode == .plan }
    /// The planner tool is armed to place a shot on the next map tap.
    private var isPlacingPlanShot: Bool { isPlan && model.isAddingPlanShot }

    /// The default distance mode (no tool panel active). The ladder rail + the
    /// distance card belong to this mode only.
    private var isDistanceMode: Bool {
        !isGreenView && !isMeasure && !isAdjust && !isCapture && !isPlan
    }
    /// Show the left distance rail: distance mode, chrome up (not immersive).
    private var showsLadderRail: Bool { isDistanceMode && !immersive }

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
        if isPlan {
            overlays.adjustHandles = model.planEditHandles
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

    /// Everything laid over the map, inside the safe area: the hole header (or
    /// the immersive compact chip), the ladder rail + control stack, and the
    /// active tool's bottom panel. Its frame tells the Green-view camera fit
    /// which map edges are covered (`greenViewCameraInsets`).
    private var chrome: some View {
        VStack(spacing: 0) {
            if !immersive || isGreenView {
                HStack(spacing: 8) {
                    backButton
                    HoleHeaderView(
                        model: model,
                        strokesOnHole: roundModel.hasActiveRound
                            ? roundModel.strokeCount(holeNumber: model.currentHoleNumber)
                            : nil
                    )
                }
                .padding(.horizontal, 12)
                .trackFrame { headerHeight = $0.height }
                .transition(.move(edge: .top).combined(with: .opacity))
            } else {
                CompactChipView(model: model)
                    .padding(.top, 4)
                    .transition(.opacity)
            }

            HStack(spacing: 0) {
                if showsLadderRail {
                    LadderRailView(model: model)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .padding(.leading, 10)
                        .padding(.top, 4)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                Spacer(minLength: 0)
                controlStack
                    .padding(.trailing, 16)
                    .padding(.bottom, immersive && !isGreenView ? 24 : 10)
                    .frame(maxHeight: .infinity, alignment: .bottom)
            }
            .frame(maxHeight: .infinity)

            bottomPanel
        }
        .trackFrame { chromeFrame = $0 }
    }

    /// The active tool's panel (or the distance card when no tool is up).
    @ViewBuilder
    private var bottomPanel: some View {
        if isGreenView {
            GreenViewPanel(
                model: greenAnalysis,
                putt: puttRead,
                quiz: puttQuiz,
                client: client,
                greenId: model.currentHole?.green?.id,
                caddy: caddy,
                onLevel: { showLevel = true },
                // Scan is only OFFERED where the hardware can deliver it
                // (sceneDepth/LiDAR) — nil hides the affordance.
                onScan: CorridorScanService.isSupported ? { showScan = true } : nil,
                onClose: { exitGreenView() }
            )
            .trackFrame { greenPanelHeight = $0.height }
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
        } else if isPlan {
            PlanPanel(model: model, onClose: { exitPlan() })
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if !immersive {
            DistanceCardView(
                model: model,
                onProfile: { showProfile.toggle() },
                onPinEntry: { showPinEntry = true },
                onLaserEntry: { showLaserEntry = true },
                onReadPutt: { readPuttFromGreenCard() }
            )
                .padding(.horizontal, 12)
                .padding(.bottom, -2)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
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
                // The single-tap recognizer is shared: normal Browse inspects a
                // target from the current origin; measure/plan/putt own it while
                // their tool is active.
                measureTapEnabled: (model.isBrowseMode && isDistanceMode)
                    || isMeasure || isPuttSurfaceActive || isPlacingPlanShot,
                onMeasureTap: { position in
                    if isMeasure {
                        measure.place(position)
                    } else if isPlacingPlanShot {
                        model.placePlanShot(at: position)
                    } else if model.isBrowseMode && isDistanceMode {
                        model.inspectBrowsePoint(position)
                    } else {
                        puttRead.handleTap(puttPoint(position))
                    }
                },
                // The handle-drag recognizer is shared too: Adjust drags the
                // tee/aim/green handles; the green view drags the putt
                // ball/hole markers; shot capture drags the crosshair/target
                // (ids routed below). Only Adjust locks the map's gesture
                // zoom for the whole mode.
                adjustEnabled: isAdjust || isPuttSurfaceActive || isCapture || isPlan,
                adjustLocksGestures: isAdjust,
                onHandleGrab: { id in
                    if id.hasPrefix("plan-shot.") {
                        model.beginPlanShotDrag(handleID: id)
                        return
                    }
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
                        if id.hasPrefix("plan-shot.") {
                            model.movePlanShot(handleID: id, to: position)
                        } else {
                            model.moveHandle(id: id, to: position)
                        }
                    }
                },
                onHandleDrop: { id in
                    if id.hasPrefix("plan-shot.") {
                        model.endPlanShotDrag(handleID: id)
                    } else if id.hasPrefix("putt-") {
                        puttRead.commitDrag()
                    } else if !id.hasPrefix("capture-") {
                        // Capture positions commit on Confirm, not on drop.
                        model.endHandleDrag()
                    }
                }
            )
            // Tracked BEFORE `ignoresSafeArea` so the reader is expanded with the
            // map and reports the full-bleed frame — read after, SwiftUI hands
            // back the safe-area frame and the chrome insets lose the status-bar
            // and home-indicator strips.
            .trackFrame { mapFrame = $0 }
            .ignoresSafeArea()
            // Short tap toggles chrome. High minimumDistance drag-less tap so it
            // doesn't swallow the map's own pan. Inert while a tool is active:
            // in Green view a stray tap must not hide the analysis panel, in
            // measure mode the tap places a point, and in adjust mode the map
            // surface belongs to the handles (UIKit recognizers in
            // CourseMapView).
            .simultaneousGesture(
                TapGesture().onEnded {
                    // In Browse, a short map tap inspects a distance target and
                    // must not also hide/show the chrome.
                    guard model.toolMode == .none, !model.isBrowseMode else { return }
                    withAnimation(.easeInOut(duration: 0.28)) { immersive.toggle() }
                }
            )

            chrome
        }
        // The Green view fits the camera to the green on entry, but the panel's
        // real height is only known once SwiftUI has laid it out — and it keeps
        // changing while the panel settles (the "Sampling terrain…" row goes,
        // the caddy advice arrives). Re-fit on each of those, and STOP once the
        // ball is down: from then on the panel grows with the read, and moving
        // the map under the player's fingers would be worse than a slightly
        // off-center green.
        .onChange(of: greenPanelHeight) { _, _ in
            guard isGreenView, puttRead.ball == nil else { return }
            withAnimation(.easeInOut(duration: 0.28)) {
                model.refitTool(insets: greenViewCameraInsets)
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
            laserSession.reset()
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
        // Capture is the drivetrain (round loop R1/R5): every stroke write —
        // capture, penalty, scorecard edit, delete — and every round
        // start/finish re-installs the playing-state stroke snapshot, which
        // advances the card's context machine. Push-based like
        // `setPlan`/`setClubs`; the model itself never reaches into RoundModel.
        .onChange(of: roundModel.round?.id) { _, _ in
            model.setActiveRound(strokes: roundLoopStrokes(of: roundModel))
            // R6: a resumed/started round carries the per-round stimp — feed it
            // to the read so its figures match the round's green speed.
            applyRoundStimp()
        }
        .onChange(of: roundModel.shots) { _, _ in
            model.setActiveRound(strokes: roundLoopStrokes(of: roundModel))
        }
        // R6: the green view's stimp control writes through to the round record
        // (the one per-round stimp field), so it persists and becomes the next
        // round's default. `setStimp` no-ops an unchanged value, breaking the
        // loop with `applyRoundStimp`.
        .onChange(of: puttRead.stimpFt) { _, value in
            guard roundModel.hasActiveRound else { return }
            Task { await roundModel.setStimp(value) }
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
                tapscore: tapscore,
                onClose: { showScorecard = false }
            )
        }
        // The on-course wind editor: writes the plan wind (or this hole's
        // override) straight into the plan the viewer already reads, offline-
        // first through the same dirty-row → PlanSyncService path as shot edits.
        .sheet(isPresented: $showWind) {
            WindEditorSheet(model: model, onClose: { showWind = false })
        }
        // GPS origin calibration (spec §6.2 / §6.3): anchor "I am here" or
        // laser trilateration; a solved bias installs via
        // `model.applyCalibration` and every distance downstream inherits it.
        .sheet(isPresented: $showCalibration) {
            CalibrationSheet(
                model: model,
                liveLocation: liveLocation,
                onClose: { showCalibration = false }
            )
        }
        // Today's-pin entry (spec §4.1 / §5). Only openable when the hole has a
        // green frame; the guard also protects against a hole change racing the
        // presentation.
        .sheet(isPresented: $showPinEntry) {
            if let frame = model.currentGreenFrame {
                PinEntrySheet(
                    model: model,
                    frame: frame,
                    onClose: { showPinEntry = false }
                )
            }
        }
        .sheet(isPresented: $showLaserEntry) {
            LaserEntrySheet(
                model: model,
                session: laserSession,
                onClose: { showLaserEntry = false }
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
        // Round loop R5: the live fix walked onto the next tee without a
        // hole-out — PROMPT to advance, never a silent move. The model owns
        // the geofence detection + nag guard; this only presents the choice.
        .alert(
            "Start hole \(model.teeGeofencePrompt ?? 0)?",
            isPresented: Binding(
                get: { model.teeGeofencePrompt != nil },
                set: { if !$0 { model.dismissTeeGeofencePrompt() } }
            ),
            presenting: model.teeGeofencePrompt
        ) { holeNumber in
            Button("Start hole \(holeNumber)") { model.confirmTeeGeofenceAdvance() }
            Button("Not yet", role: .cancel) { model.dismissTeeGeofencePrompt() }
        } message: { _ in
            Text("Hole \(model.currentHoleNumber) has no hole-out.")
        }
        // The chrome floats over a dark ortho map — force dark materials.
        //
        // `preferredColorScheme`, NOT `.environment(\.colorScheme, .dark)`: the
        // environment value only reaches SwiftUI's own semantic colors, while
        // every `Color.dynamic` token (Tokens.swift) resolves off the UIKit
        // trait collection, as do nav bars, segmented controls, `.roundedBorder`
        // fields and the keyboard. With the environment override the two
        // disagreed inside presented sheets — light card, near-white text — and
        // the calibration sheet was unreadable. This sets the trait too.
        .preferredColorScheme(.dark)
        #if DEBUG
        .onAppear { applyDebugLaunchHooks() }
        #endif
    }

    #if DEBUG
    /// Headless live-verify hooks (same family as `-openHole`): `-immersive 1`
    /// starts in immersive mode so the hidden-chrome layout can be
    /// screenshotted; `-zoomTaps N` fires N zoom-in taps (negative = out)
    /// after appear so the imperative zoom path can be verified without a real
    /// button tap. DEBUG-only and inert without the flags. Lives outside `body`
    /// — inlined, it pushed the view's type-check past the compiler's budget.
    private func applyDebugLaunchHooks() {
        do {
            if UserDefaults.standard.string(forKey: "immersive") == "1" {
                immersive = true
            }
            // `-greenView 1` enters Green view after the style-load hole fit
            // settles; `-greenMode slope|height|relative` and `-greenBuffer N`
            // preset the overlay controls so all three modes + buffer changes
            // can be screenshotted headlessly.
            // `-spotLevel 1` opens the spot-level capture sheet after the hole
            // fit settles so its rendering can be screenshotted headlessly.
            // One-shot: launch args persist for the process lifetime, and the
            // sheet must not reopen on every subsequent course entry.
            if UserDefaults.standard.string(forKey: "spotLevel") == "1", !Self.spotLevelHookFired {
                Self.spotLevelHookFired = true
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    showLevel = true
                }
            }
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
            // `-roundLoop 1` (round loop R5): drives a 3-hole round entirely
            // through the capture drivetrain — Confirm / Hole-out taps — proving
            // the loop closes with no manual navigation. Hole 1 plays out and
            // holes out (auto-advance); hole 2 plays two shots then WALKS onto
            // hole 3's tee without a hole-out (the geofence prompts, we accept);
            // hole 3 holes out. Dumps the scorecard totals + an advance trace to
            // `roundDebug.lastResult` (and a CAPTURE-DEBUG summary) so the closed
            // loop + penalty totals + sync queue can be verified headlessly.
            // DEBUG-only and inert without the flag.
            if UserDefaults.standard.string(forKey: "roundLoop") == "1" {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    model.setGPSEnabled(true)
                    model.goToHole(number: 1)
                    if !roundModel.hasActiveRound {
                        await roundModel.startRound(
                            gamePlanId: model.plan?.id, wind: planWindSnapshot
                        )
                    }
                    var trace: [String] = []

                    // One "tap": fix at the ball, drop the crosshair, then hit
                    // Confirm / Hole-out — the exact core the buttons call.
                    let tap: (LatLon, Bool) async -> ShotRecord? = { position, holeOut in
                        model.updateUserLocation(position)
                        armCapture(at: position)
                        let shot = await recordStrokeAndAdvance(holeOut: holeOut)
                        // Mirror the `.onChange(shots)` playing-state sync that a
                        // headless Task doesn't get a SwiftUI update cycle for.
                        model.setActiveRound(strokes: roundLoopStrokes(of: roundModel))
                        return shot
                    }
                    let geometry: () -> (tee: LatLon, mid: LatLon, green: LatLon)? = {
                        guard let hole = model.currentHole,
                              let tee = model.teePosition(for: hole),
                              let green = model.greenCenterPosition(for: hole)
                        else { return nil }
                        return (
                            tee,
                            LatLon(lat: (tee.lat + green.lat) / 2, lon: (tee.lon + green.lon) / 2),
                            green
                        )
                    }

                    // Hole 1 — full hole; hole-out auto-advances to hole 2. The
                    // approach takes a penalty (e.g. OB re-tee) to prove totals.
                    if let g = geometry() {
                        _ = await tap(g.tee, false)
                        if let approach = await tap(g.mid, false) {
                            _ = await roundModel.addPenalty(shotId: approach.id)
                            model.setActiveRound(strokes: roundLoopStrokes(of: roundModel))
                        }
                        _ = await tap(g.green, true)
                        trace.append("h1holeOut->h\(model.currentHoleNumber)")
                    }

                    // Hole 2 — two shots, then walk onto hole 3's tee with no
                    // hole-out: the geofence prompts, we accept, the card moves.
                    if model.currentHoleNumber == 2, let g = geometry() {
                        _ = await tap(g.tee, false)
                        _ = await tap(g.mid, false)
                        model.goToHole(number: 3)
                        let tee3 = model.currentHole.flatMap { model.teePosition(for: $0) }
                        model.goToHole(number: 2)
                        if let tee3 {
                            model.updateUserLocation(tee3)
                            trace.append(
                                "h2geofence=\(model.teeGeofencePrompt.map(String.init) ?? "nil")"
                            )
                            model.confirmTeeGeofenceAdvance()
                            trace.append("h2accept->h\(model.currentHoleNumber)")
                        }
                    }

                    // Hole 3 — tee shot then hole-out (advances again).
                    if model.currentHoleNumber == 3, let g = geometry() {
                        _ = await tap(g.tee, false)
                        _ = await tap(g.green, true)
                        trace.append("h3holeOut->h\(model.currentHoleNumber)")
                    }

                    let card = roundModel.scorecard
                    let pending = roundModel.shots.count { $0.syncState != .synced }
                    let outcome = "final=h\(model.currentHoleNumber) "
                        + "shots=\(roundModel.shots.count) "
                        + "total=\(card.total.score) "
                        + "vsPar=\(Scorecard.formatVsPar(card.total.vsPar)) "
                        + "penalties=\(card.total.penalties) "
                        + "holesPlayed=\(card.total.holesPlayed) "
                        + "syncPending=\(pending) "
                        + "trace=\(trace.joined(separator: ">"))"
                    print("ROUND-LOOP-DEBUG \(outcome)")
                    UserDefaults.standard.set(outcome, forKey: "roundDebug.lastResult")
                    Self.writeCaptureDebugSummary(roundModel)
                }
            }
            // `-roundState "lat,lon;lat,lon;…"` installs a synthetic ACTIVE
            // round whose strokes were captured at those positions on the
            // CURRENT hole (combine with `-openHole` + `-planDemo`), stepping
            // stroke by stroke and recording the card mode after each — so R1
            // leg matching + R2 mode switching can be live-verified headlessly
            // with no GRDB writes. An empty value = a round with no strokes
            // (tee preview). The outcome — per-step modes + the final playing
            // state — is persisted under `roundDebug.lastResult` (the pinDebug
            // pattern: simctl console capture is unreliable). DEBUG-only and
            // inert without the flag.
            if let raw = UserDefaults.standard.string(forKey: "roundState") {
                Task { @MainActor in
                    // Wait out the style-load hole fit + `-openHole`/`-planDemo`.
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    var strokes: [OnCourseModel.RoundStroke] = []
                    model.setActiveRound(strokes: strokes)
                    var steps = [Self.roundModeDescription(model.roundCardMode)]
                    for part in raw.split(separator: ";") {
                        // "green" resolves to the hole's real green centre (so a
                        // live green-mode run needs no hardcoded coordinate);
                        // otherwise "lat,lon".
                        let position: LatLon
                        if part.lowercased() == "green", let g = model.targets.greenCenter {
                            position = g
                        } else {
                            let nums = part.split(separator: ",")
                            guard nums.count == 2,
                                  let lat = Double(nums[0]), let lon = Double(nums[1])
                            else { continue }
                            position = LatLon(lat: lat, lon: lon)
                        }
                        strokes.append(OnCourseModel.RoundStroke(
                            holeNumber: model.currentHoleNumber,
                            position: position
                        ))
                        model.setActiveRound(strokes: strokes)
                        steps.append(Self.roundModeDescription(model.roundCardMode))
                    }
                    var outcome: String
                    if let state = model.playingState {
                        outcome = "steps=\(steps.joined(separator: ">")) "
                            + "hole=\(state.holeNumber) strokeIndex=\(state.strokeIndex) "
                            + "lie=\(state.lie.rawValue) "
                            + "currentLeg=\(state.currentLeg.map(String.init) ?? "nil") "
                            + "mode=\(Self.roundModeDescription(model.roundCardMode))"
                    } else {
                        outcome = "no-playing-state"
                    }
                    // T33: in decide mode also dump the ranked choices (kind,
                    // club, distance, R4 triple), and with `-decidePick 1`
                    // tap the top choice so the working-target wiring (banner
                    // + distance line + capture prefill) can be verified.
                    // `-decidePick option` (T37) taps the first AUTHORED
                    // option choice instead, proving the merged branch is
                    // pickable and its own landing becomes the working target.
                    if model.roundCardMode == .decide {
                        let choices = model.decideContent?.choices ?? []
                        outcome += " choices=["
                            + choices.map {
                                "\($0.kind.rawValue):\($0.clubName ?? "-")@\($0.distanceM)"
                                    + "|\($0.triple)"
                            }.joined(separator: ";")
                            + "]"
                        let pick = UserDefaults.standard.string(forKey: "decidePick")
                        if let pick, pick == "1" || pick == "option",
                           let first = pick == "option"
                               ? choices.first(where: { $0.kind == .option })
                               : choices.first {
                            model.selectDecideChoice(first)
                            if let wt = model.workingTarget {
                                let prefill = ShotCaptureDefaults.defaultTarget(
                                    workingTarget: wt.position,
                                    position: wt.position,
                                    activePin: model.targets.activePin,
                                    planLandings: [],
                                    greenCenter: model.targets.greenCenter
                                )
                                outcome += " working=\(wt.clubName ?? "-")"
                                    + "@\(wt.position.lat),\(wt.position.lon)"
                                    + " line=\(model.overlays.distanceLine.count)pts"
                                    + " prefillHitsWorking=\(prefill == wt.position)"
                            }
                        }
                    }
                    // T35 (R6): in green mode dump the green card (distance to
                    // hole + the resolved hole/ball). With `-greenPutt 1`, drive
                    // the read handoff — pre-place the markers and prove (a) the
                    // read's hole == the resolved active pin (override-first,
                    // closing laser-doc Q3) and (b) a stimp change moves the
                    // pace/break figure the read produces.
                    if model.roundCardMode == .green, let card = model.greenCard {
                        outcome += " green=[dist:\(card.distanceM.map(String.init) ?? "nil")"
                            + ",hole:\(card.holePosition.map { "\($0.lat),\($0.lon)" } ?? "nil")"
                            + ",ball:\(card.ballPosition.lat),\(card.ballPosition.lon)]"
                        if UserDefaults.standard.string(forKey: "greenPutt") == "1" {
                            puttRead.activate(defaultHole: card.holePosition.map(puttPoint))
                            puttRead.placeBall(puttPoint(card.ballPosition))
                            let readHole = puttRead.hole
                            let holeMatches = card.holePosition
                                .map { puttPoint($0) == readHole } ?? (readHole == nil)
                            puttRead.setStimp(8)
                            let low = puttRead.display.tour?.aimInches
                            puttRead.setStimp(12)
                            let high = puttRead.display.tour?.aimInches
                            outcome += " readHoleMatchesPin=\(holeMatches)"
                                + " stimp=\(puttRead.stimpFt)"
                                + " aimAt8=\(low.map { String(format: "%.3f", $0) } ?? "nil")"
                                + " aimAt12=\(high.map { String(format: "%.3f", $0) } ?? "nil")"
                        }
                    }
                    print("ROUND-DEBUG \(outcome)")
                    UserDefaults.standard.set(outcome, forKey: "roundDebug.lastResult")
                }
            }
            // `-planOptions 1` installs the option-tree demo in `load()` and
            // drives T32's full consumption seam without UI automation:
            // roots visible on the tee, selecting the safe root changes the
            // round-scoped line, and a ball at that landing stays on-plan only
            // for the selected line. Finish back on the tee so a screenshot
            // captures the selected option chips above MapLibre's black frame.
            if UserDefaults.standard.string(forKey: "planOptions") == "1" {
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    model.setActiveRound(strokes: [])
                    let initial = model.planOptionChips
                    guard let holePlan = model.currentHolePlan,
                          let alternative = initial.last,
                          let alternativeRoot = holePlan.children(of: nil).last,
                          let tee = model.planRoute.first
                    else {
                        let outcome = "fixture-missing chips=\(initial.count)"
                        print("OPTIONS-DEBUG \(outcome)")
                        UserDefaults.standard.set(outcome, forKey: "optionsDebug.lastResult")
                        return
                    }

                    model.selectPlanOption(shotId: alternative.id)
                    let selectedLine = model.playingState?.activeLine.map(\.id) ?? []
                    let selected = model.planOptionChips.first { $0.id == alternative.id }?.isSelected == true
                    // T37 finding 2: with the alternative selected (and no
                    // pin/working target in play), capture's target prefill
                    // must read the SELECTED branch's landing, not the
                    // primary line's.
                    let prefill = ShotCaptureDefaults.defaultTarget(
                        position: tee,
                        activePin: nil,
                        planLandings: model.capturePlanLandings,
                        greenCenter: model.targets.greenCenter
                    )
                    let prefillToken = prefill == alternativeRoot.position
                        ? "branch"
                        : (prefill == holePlan.shots.first?.position ? "primary" : "other")
                    let atAlternative = [
                        OnCourseModel.RoundStroke(holeNumber: model.currentHoleNumber, position: tee),
                        OnCourseModel.RoundStroke(
                            holeNumber: model.currentHoleNumber,
                            position: alternativeRoot.position
                        ),
                    ]
                    model.setActiveRound(strokes: atAlternative)
                    let selectedMode = Self.roundModeDescription(model.roundCardMode)

                    // Clear round state (R8 reset), then show the same ball
                    // against the primary line for the divergence comparison.
                    model.setActiveRound(strokes: nil)
                    model.setActiveRound(strokes: atAlternative)
                    let primaryMode = Self.roundModeDescription(model.roundCardMode)

                    // Leave the app screenshot-ready on the tee with the
                    // alternative selected and both label+club chips visible.
                    model.setActiveRound(strokes: nil)
                    let roundReset = model.activeOptionShotIdByHole.isEmpty
                    model.setActiveRound(strokes: [])
                    model.selectPlanOption(shotId: alternative.id)
                    let outcome = "chips=\(initial.map { "\($0.label)|\($0.clubName)" }.joined(separator: ";")) "
                        + "selected=\(selected) line=\(selectedLine.joined(separator: ">")) "
                        + "prefill=\(prefillToken) "
                        + "selectedMode=\(selectedMode) primaryMode=\(primaryMode) "
                        + "roundReset=\(roundReset)"
                    print("OPTIONS-DEBUG \(outcome)")
                    UserDefaults.standard.set(outcome, forKey: "optionsDebug.lastResult")
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
    }
    #endif

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

    /// `-roundState` outcome vocabulary: one token per card mode, so a
    /// live-verify run can assert the whole switching sequence from one string.
    private static func roundModeDescription(_ mode: OnCourseModel.RoundCardMode?) -> String {
        switch mode {
        case .teePreview: return "teePreview"
        case .plan(let legIndex): return "plan(leg:\(legIndex))"
        case .decide: return "decide"
        case .green: return "green"
        case nil: return "none"
        }
    }

    /// Guards the `-spotLevel 1` hook so it fires at most once per process.
    private static var spotLevelHookFired = false

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

    /// Header-row back button; replaces the hidden system navigation bar.
    private var backButton: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "chevron.backward")
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 44, height: 44)
                .mapControl()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to courses")
    }

    // Stacked bottom-right controls: capture / scorecard / green view /
    // measure / adjust / recenter. While a tool is active the rail collapses
    // to recenter alone — the tool's panel owns enter/exit, and the spare
    // buttons only crowded the mode's own chrome. No zoom buttons (pinch /
    // double-tap); level lives in the green panel, the elevation profile in
    // the measure panel + distance card, the plan toggle on the distance card.
    private var controlStack: some View {
        VStack(spacing: 10) {
            if model.toolMode == .none {
                // Wind indicator + the way into the wind editor. Shows a calm
                // state when no wind is set rather than hiding — it is the only
                // entry point, so it must not disappear when there is nothing
                // set yet. Live in competition mode too (weather-report wind).
                WindIndicatorChip(
                    wind: model.effectiveWind,
                    holeBearing: model.holeBearing,
                    action: { showWind = true }
                )
                // Calibration state badge (hidden while `.none`) + the way
                // into the calibration sheet. The chip is a second tap target
                // for the same sheet — a stale badge invites the fix directly.
                CalibrationStatusChip(status: model.calibrationStatus) {
                    showCalibration = true
                }
                calibrateButton
                captureButton
                scorecardButton
                greenViewButton
                measureButton
                adjustButton
                planButton
            }
            circleButton(systemImage: "scope", label: "Recenter on hole", size: 18) {
                model.recenter()
            }
        }
    }

    /// Opens the GPS calibration sheet (anchor / laser trilateration, spec
    /// §6.2 / §6.3). Always available in distance mode — calibrating is
    /// measurement, not advice, so competition mode does not gate it.
    private var calibrateButton: some View {
        Button {
            showCalibration = true
        } label: {
            Image(systemName: "location.viewfinder")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(showCalibration ? Color.statusPositive : Color.primary)
                .frame(width: 44, height: 44)
                .mapControl()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Calibrate GPS")
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

    /// Toggles the planner tool (edit the course's game plan: drag/add/remove
    /// landing points). Plan-violet while active; a dot badge marks a hole that
    /// already has plan content.
    private var planButton: some View {
        Button {
            if isPlan {
                exitPlan()
            } else {
                enterPlan()
            }
        } label: {
            Image(systemName: isPlan ? "signpost.right.fill" : "signpost.right")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(isPlan ? PlanPanel.violet : Color.primary)
                .frame(width: 44, height: 44)
                .mapControl()
                .overlay(alignment: .topTrailing) {
                    if !model.planEditShots.isEmpty {
                        Circle()
                            .fill(PlanPanel.violet)
                            .frame(width: 8, height: 8)
                            .offset(x: -3, y: 3)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isPlan ? "Exit plan editing" : "Edit game plan")
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

    /// R6 green handoff: open the green view from the green card with the ball
    /// pre-placed at the last captured position and the hole at the resolved
    /// active pin — the putt read one tap away, exactly at the round's markers.
    private func readPuttFromGreenCard() {
        enterGreenView(preplaceBall: model.greenCard?.ballPosition)
    }

    private func enterGreenView(preplaceBall: LatLon? = nil) {
        guard let hole = model.currentHole else { return }
        let center = hole.green.map { LatLon(lat: $0.centerLat, lon: $0.centerLon) }
        guard let bounds = greenAnalysis.activate(holeId: hole.hole.id, greenCenter: center)
        else { return }
        // Arm the putt read: hole marker defaults to the active pin, else the
        // green center. `targets.activePin` resolves a placed today's-pin
        // override first (spec §3.3), falling back to the furniture active pin —
        // so a placed pin flows into the green view; identical when none exists.
        // The terrain grid follows when the sampling settles (see the
        // greenAnalysis.isLoading onChange).
        let activePin = model.targets.activePin
        puttRead.activate(defaultHole: (activePin ?? center).map(puttPoint))
        // R6: the green card hands off the captured ball position, so the read
        // opens pre-placed (no tap needed). Hole stays the resolved active pin.
        if let ball = preplaceBall {
            puttRead.placeBall(puttPoint(ball))
        }
        // Apply the synced per-green calibration (confidence lift + bias
        // correction) before the terrain grid settles, so the surface is built
        // right the first time. Uncalibrated greens pass nil → no-op.
        puttRead.applyCalibration(hole.green.flatMap { greenCalibrations[$0.id] })
        // Fit the green plus a margin of surrounds into the map left visible
        // between the hole header and the panel. The panel isn't laid out yet,
        // so this uses the last known height; the greenPanelHeight onChange
        // re-fits as the real panel settles.
        // Frame the green's own outline (+ margin) rather than its bbox — with
        // the map turned to the hole bearing a bbox fit pulls in far more
        // surrounds than asked for. Falls back to the bbox if the outline is
        // somehow unusable.
        let outline = greenAnalysis.greenOutline(expandedByMeters: Self.greenFitMarginM)
        let focus: MapCameraCommand.Target = outline.count >= 3
            ? .shape(outline)
            : .bounds(bounds.expanded(byMeters: Self.greenFitMarginM))
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            model.enterTool(.greenView, focus: focus, insets: greenViewCameraInsets)
        }
    }

    /// Surrounds kept visible around the green when the Green view frames it.
    private static let greenFitMarginM: Double = 5

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

    // MARK: - Plan editing enter/exit

    /// Mutually exclusive with the other tools. Keeps the current framing (like
    /// Adjust) so entering never yanks the view — handles are reachable by pan.
    private func enterPlan() {
        if greenAnalysis.isActive {
            greenAnalysis.deactivate()
            puttRead.deactivate()
        }
        measure.clear()
        capture.end()
        withAnimation(.easeInOut(duration: 0.28)) {
            immersive = false
            model.enterTool(.plan, refitCamera: false)
        }
    }

    private func exitPlan() {
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
                    wind: planWindSnapshot,
                    stimpFt: env.settings.defaultStimpFt
                )
                applyRoundStimp()
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

    /// Round-loop R6: feed the active round's per-round stimp into the putt
    /// read, so tour/plays-like figures use the round's green speed rather than
    /// the app default. No round, or a round with no recorded stimp, leaves the
    /// read's persisted value untouched. `setStimp` self-guards a no-op change,
    /// so calling this and the `puttRead.stimpFt` write-back don't loop.
    private func applyRoundStimp() {
        guard let stimp = roundModel.round?.stimpFt else { return }
        puttRead.setStimp(stimp)
    }

    /// Arms the capture draft: crosshair at `position`, target pre-filled
    /// pin ?? next plan landing ?? green center, club pre-selected on the
    /// plays-like remaining, shot type auto (putt on the green).
    private func armCapture(at position: LatLon) {
        let targets = model.targets
        // Active line first (a picked option's branch), primary otherwise
        // (T37 finding 2).
        let planLandings = model.capturePlanLandings
        let target = ShotCaptureDefaults.defaultTarget(
            workingTarget: model.workingTarget?.position,
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
        Task { @MainActor in
            guard await recordStrokeAndAdvance(holeOut: holeOut) != nil else { return }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        }
    }

    /// The stroke-write + auto-advance core shared by the Confirm / Hole-out
    /// taps and the `-roundLoop` headless hook (round loop R5). Records the
    /// stroke AT the crosshair (§2), notes it for the penalty stepper, and on
    /// hole-out auto-advances to the next hole — the loop's drivetrain: one tap
    /// both reports the stroke and moves the card on. `holeDidChange` dismisses
    /// the capture tool (toolMode → .none) and the `.onChange` on the hole
    /// number ends the panel, so the card returns to the new hole's tee
    /// preview. The last hole doesn't advance (the round is finished from the
    /// scorecard). Returns the written record, or nil if nothing was in flight.
    @discardableResult
    private func recordStrokeAndAdvance(holeOut: Bool) async -> ShotRecord? {
        guard let position = capture.position else { return nil }
        let shotType = holeOut ? ShotType.putt : capture.shotType
        let clubId = holeOut ? nil : capture.clubId
        let holeNumber = model.currentHoleNumber
        let target = capture.target
        guard let shot = await roundModel.recordStroke(
            holeNumber: holeNumber,
            position: position,
            clubId: clubId,
            shotType: shotType,
            target: target
        ) else { return nil }
        capture.noteConfirmed(shot)
        if holeOut, model.canGoNext {
            model.nextHole()
        }
        return shot
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
        // Same active-line preference as `armCapture` (T37 finding 2).
        let planLandings = model.capturePlanLandings
        capture.rearm(
            position: position,
            target: ShotCaptureDefaults.defaultTarget(
                workingTarget: model.workingTarget?.position,
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
    /// Opens the elevation-profile sheet (owned by the content view — the
    /// sheet is shared with the measure panel).
    let onProfile: () -> Void
    /// Opens the pin-entry sheet (owned by the content view — needs the current
    /// green frame, which the button only offers when one exists).
    let onPinEntry: () -> Void
    /// Opens the one R7 rangefinder entry. It routes the number by picked-map
    /// context, so this is the card's only laser affordance.
    let onLaserEntry: () -> Void
    /// Opens the green view / putt read pre-placed from the green card (R6 —
    /// ball = last captured position, hole = resolved active pin).
    let onReadPutt: () -> Void
    @Environment(AppEnvironment.self) private var env

    /// Compact by default: the numbers that matter over the ball (F/C/B,
    /// clubs, routed aim, hazard carries). Everything else — wind, pin,
    /// route/aim legs, plan — sits behind the expand chevron.
    @State private var expanded = false
    /// Tapping the big distance toggles it between actual and plays-as.
    /// Plays-as leads by default — it's the number you club from; the tap on
    /// the big figure swaps actual up when you want the raw line.
    @State private var showPlaysAs = true

    // Match the map marker convention: front red / center white / back blue.
    private static let frontColor = Color(red: 0.88, green: 0.19, blue: 0.19)
    private static let backColor = Color(red: 0.31, green: 0.56, blue: 0.82)
    private static let pinColor = Color(red: 1.0, green: 0.83, blue: 0.23)
    /// Matches the selected-target rose hold marker on the map (#f472b6).
    private static let windHoldColor = Color(red: 0.957, green: 0.447, blue: 0.714)

    private var unit: DistanceUnit { env.settings.distanceUnit }

    var body: some View {
        VStack(spacing: 10) {
            // Round loop (R2): with a round active and a planned line on the
            // hole, the context strip LEADS — tee preview / plan leg / decide.
            // Everything below it (banner, pin, strip — the trust anchor) is
            // exactly today's card, competition gating untouched.
            if let mode = model.roundCardMode {
                roundContext(mode)
            }
            if let advice = model.selectedTargetAdvice {
                selectedTargetBanner(advice)
            }
            toolsRow
            bottomStrip
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s3)
        .padding(.bottom, Space.s2)
        .glassPanel()
        .holeSwipeGesture(model: model)
    }

    // MARK: Round context (playing-state card modes — round loop R2)

    // The context strip that leads the card while a round is active and the
    // hole has a planned line. Plan violet = "this is the plan talking"; the
    // decide placeholder borrows the hazard gold (attention, not advice).
    @ViewBuilder
    private func roundContext(_ mode: OnCourseModel.RoundCardMode) -> some View {
        switch mode {
        case .teePreview:
            if let strip = model.teePreviewStrip {
                roundTeePreview(strip)
            }
        case .plan(let legIndex):
            if let card = model.roundLegCard(legIndex: legIndex) {
                roundLegCard(card)
            }
        case .decide:
            if let content = model.decideContent, !content.choices.isEmpty {
                roundDecideCard(content)
            } else {
                // No choices to rank (competition mode, no bag, no green) —
                // name the situation and defer to the distances below.
                roundDecidePlaceholder
            }
        case .green:
            if let card = model.greenCard {
                roundGreenCard(card)
            }
        }
    }

    // Green mode (R6): the ball is on the green — distance to the hole leads,
    // the putt read is one tap away, pre-placed at ball = last capture and
    // hole = resolved active pin (green tint = "you're putting now").
    private func roundGreenCard(_ card: OnCourseModel.GreenCard) -> some View {
        Button(action: onReadPutt) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Image(systemName: "flag.circle.fill")
                        .font(.caption)
                        .foregroundStyle(Color.green)
                    OverlineLabel("On the green · Read putt", color: .secondary)
                    Spacer()
                    if let distance = card.distanceM {
                        MetricText(
                            DistanceFormat.string(distance, unit: unit),
                            unit: unit.abbreviation, size: 16
                        )
                    }
                }
                HStack(spacing: 10) {
                    Text("→ \(card.holeName ?? "Hole")")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                    Spacer()
                    HStack(spacing: 3) {
                        Text("Read")
                            .font(.caption2.weight(.semibold))
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .foregroundStyle(Color.green)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(
            "On the green"
                + (card.distanceM.map { ", \($0) meters to the hole" } ?? "")
                + ". Read putt."
        )
    }

    // Tee preview (R2): the hole's plan in one strip — tee club, first aim,
    // the one hazard that matters, hole notes. Option chips land with T32.
    private func roundTeePreview(_ strip: OnCourseModel.TeePreviewStrip) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "signpost.right.fill")
                    .font(.caption)
                    .foregroundStyle(PlanStyle.violet)
                OverlineLabel("Tee · Hole plan", color: .secondary)
                Spacer()
                if let meters = strip.firstLegMeters {
                    MetricText(
                        DistanceFormat.string(meters, unit: unit),
                        unit: unit.abbreviation, size: 16
                    )
                }
            }
            HStack(spacing: 10) {
                if let club = strip.teeClubName {
                    clubChip("", club, PlanStyle.violet)
                } else if let suggested = strip.suggestedClubName {
                    clubChip("", "~\(suggested)", PlanStyle.violet)
                }
                if let aim = strip.aimLabel {
                    Text("→ \(aim)")
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                }
                if let hazard = strip.hazardLabel, let carry = strip.hazardCarryM {
                    Text("\(hazard) · carry \(DistanceFormat.string(carry, unit: unit))")
                        .font(.caption2)
                        .foregroundStyle(Self.pinColor)
                        .lineLimit(1)
                }
                Spacer()
            }
            planOptionChips
            if let notes = strip.notes {
                Text(notes)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
    }

    // Plan mode (R2): the leg the plan wants next — planned club, aim label,
    // gate width, distance + plays-as to the planned landing, hole notes.
    private func roundLegCard(_ card: OnCourseModel.RoundLegCard) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "signpost.right.fill")
                    .font(.caption)
                    .foregroundStyle(PlanStyle.violet)
                OverlineLabel("Shot \(card.legIndex) of \(card.legCount) · Plan", color: .secondary)
                Spacer()
                if let distance = card.distanceM {
                    MetricText(
                        DistanceFormat.string(distance, unit: unit),
                        unit: unit.abbreviation, size: 16
                    )
                }
            }
            HStack(spacing: 10) {
                if let club = card.clubName {
                    clubChip("", club, PlanStyle.violet)
                } else if let suggested = card.suggestedClubName {
                    clubChip("", "~\(suggested)", PlanStyle.violet)
                }
                Text(card.toGreen ? "→ Green" : "→ \(card.aimLabel ?? "Landing")")
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                if let gate = card.gateWidthM {
                    Text("Gate \(DistanceFormat.string(gate, unit: unit)) \(unit.abbreviation)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let playsAs = card.playsAsM, playsAs != card.distanceM {
                    Text("plays \(DistanceFormat.string(playsAs, unit: unit))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
            }
            planOptionChips
            if let notes = card.notes {
                Text(notes)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// Authored siblings at the current decision point. The chip deliberately
    /// carries only label + club: plan sync has no cached EV and O4 defers the
    /// Swift chain scorer, so inventing a score here would be misleading.
    @ViewBuilder
    private var planOptionChips: some View {
        let chips = model.planOptionChips
        if !chips.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(chips) { chip in
                        Button {
                            model.selectPlanOption(shotId: chip.id)
                        } label: {
                            HStack(spacing: 5) {
                                Text(chip.label)
                                    .font(.caption2.weight(.semibold))
                                Text(chip.clubName)
                                    .font(.caption2)
                                    .foregroundStyle(chip.isSelected ? Color.white.opacity(0.85) : .secondary)
                            }
                            .lineLimit(1)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .foregroundStyle(chip.isSelected ? Color.white : PlanStyle.violet)
                            .background(
                                Capsule().fill(chip.isSelected ? PlanStyle.violet : Color.clear)
                            )
                            .overlay(
                                Capsule().stroke(PlanStyle.violet.opacity(chip.isSelected ? 0 : 0.55))
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(chip.label), \(chip.clubName)")
                        .accessibilityAddTraits(chip.isSelected ? [.isSelected] : [])
                    }
                }
            }
        }
    }

    // Decide card (R4): ≤3 ranked choices from the actual ball — engine
    // candidates ranked/vetoed by the caddy rules — each carrying the
    // probable-score / penalty% / tail triple (ScoreRiskFormat, the ONE
    // formatter option chips will reuse). Tap a choice → working target.
    private func roundDecideCard(_ content: OnCourseModel.DecideContent) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.caption)
                    .foregroundStyle(Self.pinColor)
                OverlineLabel("Off plan · Pick your shot", color: Self.pinColor)
                Spacer()
            }
            ForEach(content.choices) { choice in
                decideChoiceRow(choice)
            }
            if let why = content.caddyHeadline {
                Text(why)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func decideChoiceRow(_ choice: OnCourseModel.DecideChoice) -> some View {
        let isWorking = model.workingTarget?.choiceId == choice.id
        return Button {
            model.selectDecideChoice(choice)
        } label: {
            HStack(spacing: 10) {
                if let club = choice.clubName {
                    clubChip("", club, isWorking ? Self.pinColor : PlanStyle.violet)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(choice.headline)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Text(choice.triple)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                MetricText(
                    DistanceFormat.string(choice.distanceM, unit: unit),
                    unit: unit.abbreviation, size: 14
                )
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isWorking ? Self.pinColor.opacity(0.14) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(choice.headline), \(choice.triple)")
        .accessibilityAddTraits(isWorking ? [.isSelected] : [])
    }

    // Decide placeholder (R2/R3): shown while decide mode has no rankable
    // choices (competition mode gates the advice; no bag / no green degrades)
    // — the strip names the situation and defers to the distances below.
    private var roundDecidePlaceholder: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrow.triangle.branch")
                .font(.caption)
                .foregroundStyle(Self.pinColor)
            VStack(alignment: .leading, spacing: 2) {
                OverlineLabel("Off plan", color: Self.pinColor)
                Text("Ball is off the planned line — pick your shot from the distances below.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .accessibilityElement(children: .combine)
    }

    // The inspected map/ladder target's "what do I do" line: its plays-as
    // distance and club, with the big distance on the right. Default is green.
    private func selectedTargetBanner(_ advice: OnCourseModel.TargetAdvice) -> some View {
        let isHazard = advice.kind == .hazard
        let canToggle = !isHazard && advice.playsAsM != nil
        let showingPlaysAs = canToggle && showPlaysAs
        let accent = LadderRailView.color(advice.kind)

        // Big number: carry for a hazard, else actual/plays-as per the toggle
        // (the caption + tap convey which; no redundant second figure on the left).
        let big = isHazard ? (advice.carryM ?? advice.distanceM)
            : (showingPlaysAs ? advice.playsAsM! : advice.distanceM)

        // Top-aligned two-column row: everything informational stacks tightly
        // on the left (title, club, aim/notes, promote button); the figure
        // column is big number over its companion. Neither side carries
        // layoutPriority — under width pressure the big number scales down
        // (minimumScaleFactor) before any text truncates.
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                // The accent tint IS the kind marker (matches the ladder
                // rail colors) — the old 9 pt dot cost a 21 pt indent.
                Text(advice.title.uppercased())
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(accent)
                    .lineLimit(1)
                if let club = advice.club {
                    HStack(spacing: 3) {
                        Image(systemName: "figure.golf")
                            .font(.system(size: 12))
                            .foregroundStyle(.green)
                        // Club + its adjusted carry — the SAME figure the
                        // advice ellipse (and its on-map label) is drawn
                        // with. Carry is implied; no verb needed.
                        Text(advice.clubCarryM.map { "\(club) · \($0) m" } ?? club)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                    }
                }
                HStack(spacing: 10) {
                    // Always shown (a flat "0 m" included) — a hidden chip
                    // reads as missing data, not as flat ground.
                    if let delta = advice.elevationDeltaM {
                        HStack(spacing: 2) {
                            Image(systemName: delta > 0 ? "arrow.up.right"
                                  : delta < 0 ? "arrow.down.right" : "minus")
                                .font(.system(size: 10, weight: .semibold))
                            Text("\(abs(delta)) m")
                                .font(.footnote)
                        }
                        .foregroundStyle(.secondary)
                        .fixedSize()
                    }
                    if let hold = advice.windHoldM, let side = advice.windHoldSide {
                        // Aim correction (hold into the wind), not the wind's
                        // own direction — "aim" keeps the arrow unambiguous.
                        Text("aim \(side == .left ? "←" : "→") \(DistanceFormat.string(hold, unit: unit)) \(unit.abbreviation)")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Self.windHoldColor)
                            .lineLimit(1)
                            .accessibilityLabel(
                                "Aim \(DistanceFormat.stringWithUnit(hold, unit: unit)) \(side.rawValue) of the target"
                            )
                    }
                }
                // Outcome line, separate from the adjustments above — four
                // chips on one ~200 pt line crushed into "aim… 8 sh… ⚑ 2…".
                if advice.note != nil || advice.toGreenM != nil {
                    HStack(spacing: 10) {
                        if let note = advice.note {
                            HStack(spacing: 3) {
                                if let icon = advice.noteSystemImage {
                                    Image(systemName: icon)
                                        .font(.system(size: 10, weight: .semibold))
                                        .foregroundStyle(Self.frontColor)
                                }
                                Text(note)
                                    .font(.footnote.weight(.medium))
                                    .foregroundStyle(note == "Lay up short" ? Self.pinColor : .primary)
                                    .lineLimit(1)
                            }
                        }
                        if let toGreen = advice.toGreenM {
                            // From the tapped point ON to the green: remaining
                            // + approach club, the layup chip's flag form.
                            HStack(spacing: 3) {
                                Image(systemName: "flag.fill")
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(Self.frontColor)
                                Text("\(toGreen) m" + (advice.toGreenClub.map { " · \($0)" } ?? ""))
                                    .font(.footnote.weight(.medium))
                                    .lineLimit(1)
                            }
                            .accessibilityLabel(
                                "\(toGreen) meters to the green"
                                + (advice.toGreenClub.map { ", \($0)" } ?? "")
                            )
                        }
                    }
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 0) {
                MetricText(DistanceFormat.string(big, unit: unit), unit: unit.abbreviation, size: 44)
                    .minimumScaleFactor(0.7)
                HStack(spacing: 3) {
                    if canToggle {
                        Image(systemName: "arrow.up.arrow.down")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    // The companion figure, so actual AND plays-as read at
                    // a glance; the tap swaps which one is big.
                    Text(isHazard
                         ? "carry · front \(DistanceFormat.string(advice.distanceM, unit: unit))"
                         : (showingPlaysAs
                            ? "actual \(DistanceFormat.string(advice.distanceM, unit: unit))"
                            : advice.playsAsM.map {
                                "plays \(DistanceFormat.string($0, unit: unit))"
                            } ?? "actual"))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if canToggle { showPlaysAs.toggle() } }
        }
    }

    // Today's-pin controls: a compact button into the pin-entry sheet, plus —
    // when an override is placed — a source-tag chip ("Laser"/"Sheet"/"Visual")
    // with an inline clear. Inline content for `toolsRow` (no line of its own).
    private var pinControls: some View {
        HStack(spacing: 8) {
            Button(action: onPinEntry) {
                HStack(spacing: 5) {
                    Image(systemName: "mappin.and.ellipse")
                        .font(.caption)
                    Text("Pin")
                        .font(.caption)
                }
                .foregroundStyle(pinOverride != nil ? Self.pinColor : Color.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(.white.opacity(0.08), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Place today's pin")

            if let override = pinOverride {
                HStack(spacing: 5) {
                    Text(OnCourseModel.pinSourceTag(override.source))
                        .font(.caption2.weight(.semibold))
                    Button {
                        if let id = model.currentHole?.id {
                            model.clearPinOverride(forHole: id)
                        }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear placed pin")
                }
                .foregroundStyle(Self.pinColor)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Self.pinColor.opacity(0.15), in: Capsule())
            }
        }
    }

    /// Laser + today's-pin controls on ONE row (they cost a line each before),
    /// with the laser carry-check readout below when one exists. The old
    /// "Mapped target picked" hint is gone — the laser sheet itself says what
    /// a shot will be checked against.
    private var toolsRow: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button(action: onLaserEntry) {
                    HStack(spacing: 5) {
                        Image(systemName: "scope")
                            .font(.caption)
                        Text("Laser")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(Color.accentPrimary)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.accentPrimary.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Enter laser distance")
                .accessibilityHint("Routes to pin placement, GPS calibration, or calibration verification")

                // Today's-pin entry — only where the hole has a green frame to
                // place a pin against (spec §5); a placed override adds a chip.
                if model.currentGreenFrame != nil {
                    pinControls
                }
                // Promote the inspected target to the browse origin — lives
                // here as a pill so the banner keeps its lines for data.
                if model.canPromoteInspectedBrowseTarget {
                    Button {
                        model.promoteInspectedBrowseTarget()
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "arrow.turn.down.right")
                                .font(.caption)
                            Text("From here")
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                                .fixedSize()
                        }
                        .foregroundStyle(Color.cyan)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.cyan.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Browse from here")
                    .accessibilityHint("Makes this target the new distance origin")
                }
                Spacer()
            }

            if let check = model.lastLaserCarryCheck {
                Text(
                    "Carry · laser \(DistanceFormat.string(check.laserDistanceM, unit: unit)) "
                    + "· map \(DistanceFormat.string(check.mappedDistanceM, unit: unit)) "
                    + "· Δ \(signedDistance(check.deltaM))"
                )
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .accessibilityLabel(
                    "Carry check, laser \(DistanceFormat.stringWithUnit(check.laserDistanceM, unit: unit)), "
                    + "map \(DistanceFormat.stringWithUnit(check.mappedDistanceM, unit: unit))"
                )
            }
        }
    }

    private func signedDistance(_ meters: Double) -> String {
        let value = DistanceFormat.string(abs(meters), unit: unit)
        return "\(meters >= 0 ? "+" : "−")\(value) \(unit.abbreviation)"
    }

    /// Today's-pin override for the current hole, keyed the way the model keys
    /// `pinOverrides` (by `currentHole.id`).
    private var pinOverride: OnCourseModel.PinOverride? {
        guard let id = model.currentHole?.id else { return nil }
        return model.pinOverrides[id]
    }

    private var bottomStrip: some View {
        HStack {
            teeMenu
            Spacer()
            profileChip
            if model.isBrowseMode && model.browseOrigin != nil {
                // Icon-only, like the elevation chip — "From tee" hyphenated
                // when the strip ran out of width.
                Button {
                    model.resetBrowseOrigin()
                } label: {
                    Image(systemName: "arrow.uturn.backward")
                        .font(.footnote)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(.white.opacity(0.08), in: Capsule())
                .accessibilityLabel("From tee")
                .accessibilityHint("Restores the selected tee as the distance origin")
            }
            locationToggle
        }
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
        let playsLike = model.distances?.playsLikeCenter
        let wind = model.distances?.windPlaysLikeCenter
        switch (playsLike, wind) {
        case let (playsLike?, wind?):
            let plText = DistanceFormat.string(playsLike, unit: unit)
            return "Center · PL \(plText) → \(DistanceFormat.string(wind, unit: unit))"
        case let (playsLike?, nil):
            return "Center · PL \(DistanceFormat.string(playsLike, unit: unit))"
        case let (nil, wind?):
            // Competition mode: no slope figure to chain off, but the wind
            // number stands on its own (straight distance + wind).
            return "Center · wind \(DistanceFormat.string(wind, unit: unit))"
        case (nil, nil):
            return "Center"
        }
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

    // Shown in place of the F/C/B chips when the green center is beyond the
    // longest club: the honest max-advance layup ("Driver 243 · 58 m in · LW")
    // instead of a misleading "Driver reaches the green".
    private func layupRow(_ layup: LayupLine) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "figure.golf")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(layup.club)
                .font(.caption.weight(.semibold))
            MetricText(DistanceFormat.string(layup.carryM, unit: unit), unit: unit.abbreviation, size: 13)
            Text("·")
                .font(.caption2)
                .foregroundStyle(.secondary)
            MetricText(DistanceFormat.string(layup.remainingM, unit: unit), unit: unit.abbreviation, size: 13)
            Text(layup.approachClub.map { "in · \($0)" } ?? "in")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .accessibilityElement()
        .accessibilityLabel(
            "\(layup.club) leaves \(layup.remainingM) meters"
                + (layup.approachClub.map { ", \($0) in" } ?? "")
        )
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
    // blows (north-up). Shown whenever the plan supplies a non-calm wind —
    // including in competition mode (`model.effectiveWind` is nil only when
    // the wind is calm / unset).
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
                        Text(hazard.displayLabel)
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

    private var bottomRow: some View {
        HStack {
            teeMenu
            Spacer()
            expandToggle
            Spacer()
            locationToggle
        }
    }

    private var expandToggle: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
        } label: {
            Image(systemName: expanded ? "chevron.down" : "chevron.up")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(expanded ? "Show fewer distances" : "Show all distances")
    }

    // Secondary toggles that used to live on the map's control rail — rare
    // enough to sit behind the expand chevron.
    private var extrasRow: some View {
        HStack {
            if model.courseHasPlan {
                planChip
            }
            Spacer()
            profileChip
        }
    }

    /// Shows/hides the game-plan overlay (read-only strategy from the web
    /// planner). Present only when the course has a plan; the visibility is
    /// persisted per course.
    private var planChip: some View {
        Button {
            model.togglePlanVisible()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: model.planVisible ? "signpost.right.fill" : "signpost.right")
                    .font(.caption)
                Text("Plan")
                    .font(.caption)
            }
            .foregroundStyle(model.planVisible ? PlanStyle.violet : Color.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.white.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.planVisible ? "Hide game plan" : "Show game plan")
    }

    /// Opens the elevation-profile sheet for the hole route (non-modal; the
    /// map stays live).
    // Icon-only: four labeled pills don't fit the strip's width and SwiftUI
    // hyphenates inside them ("Eleva-tion"); the accessibility label names it.
    private var profileChip: some View {
        Button(action: onProfile) {
            Image(systemName: "chart.xyaxis.line")
                .font(.footnote)
                .foregroundStyle(Color.secondary)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(.white.opacity(0.08), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Elevation profile")
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
                    .lineLimit(1)
                    .fixedSize()
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
                    .lineLimit(1)
                    .fixedSize()
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
        if model.isFarFromCourse { return "Far from course · from tee" }
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
