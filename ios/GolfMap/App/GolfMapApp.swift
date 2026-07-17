import SwiftUI

@main
struct GolfMapApp: App {
    @State private var appEnvironment = AppEnvironment.live()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appEnvironment)
                // Retry the offline capture queue whenever the app becomes
                // active (covers cold start AND return from background —
                // connectivity often changed while away). Best-effort; a
                // failed flush just waits for the next trigger.
                .onChange(of: scenePhase, initial: true) { _, phase in
                    guard phase == .active else { return }
                    #if DEBUG
                    if UserDefaults.standard.string(forKey: "verifyPlanOptions") == "1" {
                        T32OptionsDebug.run()
                    }
                    if UserDefaults.standard.string(forKey: "verifyLaserRound") == "1" {
                        T36LaserRoundDebug.run()
                    }
                    #endif
                    let roundSync = appEnvironment.roundSync
                    let planSync = appEnvironment.planSync
                    let clubSync = appEnvironment.clubSync
                    Task { await roundSync.flush() }
                    Task { await planSync.flush() }
                    Task { await clubSync.flush() }
                }
        }
    }
}

#if DEBUG
/// Data-independent launch-argument verification for T32. Unlike the visual
/// CourseScreen hook, this survives a clean simulator install with no cached
/// course bundle: `-verifyPlanOptions 1` drives the real OnCourseModel and
/// persists a compact result under `optionsDebug.lastResult`.
@MainActor
private enum T32OptionsDebug {
    static func run() {
        let tee = LatLon(lat: 58.3600, lon: 15.7100)
        let attack = LatLon(lat: 58.3620, lon: 15.7090)
        let green = LatLon(lat: 58.3640, lon: 15.7080)
        let attackPlanar = Sweref99TM.fromWGS84(attack)
        let safe = Sweref99TM.toWGS84(x: attackPlanar.x + 100, y: attackPlanar.y)
        let safeNext = Sweref99TM.toWGS84(x: attackPlanar.x + 100, y: attackPlanar.y + 100)

        let furniture = CourseFurniture(
            course: CourseRecord(
                id: "t32-course", name: "T32 fixture", status: "published",
                revision: 1, downloadedRevision: 1, updatedAt: "2026-07-17T00:00:00Z",
                bundleState: .complete
            ),
            holes: [HoleRecord(
                id: "t32-hole", courseId: "t32-course", number: 1,
                par: 4, strokeIndex: 1
            )],
            tees: [TeeRecord(
                id: "t32-tee", holeId: "t32-hole", name: "default",
                lat: tee.lat, lon: tee.lon, sortOrder: 0
            )],
            greens: [GreenRecord(
                id: "t32-green", holeId: "t32-hole",
                centerLat: green.lat, centerLon: green.lon
            )],
            pins: [],
            aimPoints: [],
            manifest: TileManifestRecord(
                courseId: "t32-course", west: 15.70, south: 58.35,
                east: 15.72, north: 58.37,
                orthoMinZoom: 14, orthoMaxZoom: 20,
                terrainMinZoom: 12, terrainMaxZoom: 17,
                elevMin: 0, elevMax: 100,
                generatedAt: "2026-07-17T00:00:00Z", versionParam: "t32"
            )
        )
        let clubs = [
            ClubRecord(id: "t32-driver", name: "Driver", carryM: 230, dispersionM: 40, sortOrder: 0),
            ClubRecord(id: "t32-5i", name: "5 iron", carryM: 175, dispersionM: 24, sortOrder: 1),
            ClubRecord(id: "t32-7i", name: "7 iron", carryM: 145, dispersionM: 20, sortOrder: 2),
        ]
        let plan = CoursePlan.make(
            stored: StoredGamePlan(
                plan: GamePlanRecord(id: "t32-plan", courseId: "t32-course"),
                holes: [GamePlanHoleRecord(
                    id: "t32-plan-hole", gamePlanId: "t32-plan", holeNumber: 1
                )],
                shots: [
                    PlanShotRecord(
                        id: "attack", gamePlanHoleId: "t32-plan-hole", sortOrder: 0,
                        lat: attack.lat, lon: attack.lon,
                        clubId: "t32-driver", label: "Attack"
                    ),
                    PlanShotRecord(
                        id: "safe", gamePlanHoleId: "t32-plan-hole", sortOrder: 1,
                        lat: safe.lat, lon: safe.lon,
                        clubId: "t32-5i", label: "Safe line"
                    ),
                    PlanShotRecord(
                        id: "attack-next", gamePlanHoleId: "t32-plan-hole", sortOrder: 0,
                        parentShotId: "attack", lat: green.lat, lon: green.lon,
                        clubId: "t32-7i", label: "Attack next"
                    ),
                    PlanShotRecord(
                        id: "safe-next", gamePlanHoleId: "t32-plan-hole", sortOrder: 0,
                        parentShotId: "safe", lat: safeNext.lat, lon: safeNext.lon,
                        clubId: "t32-7i", label: "Safe next"
                    ),
                ],
                gates: []
            ),
            clubs: clubs
        )
        let suite = UserDefaults(suiteName: "T32OptionsDebug-\(UUID().uuidString)")!
        let model = OnCourseModel(furniture: furniture, defaults: suite)
        model.setClubs(clubs)
        model.setPlan(plan)
        model.setActiveRound(strokes: [])

        let initial = model.planOptionChips
        model.selectPlanOption(shotId: "safe")
        let selected = model.planOptionChips.first { $0.id == "safe" }?.isSelected == true
        let selectedLine = model.playingState?.activeLine.map(\.id) ?? []
        let atSafe = [
            OnCourseModel.RoundStroke(holeNumber: 1, position: tee),
            OnCourseModel.RoundStroke(holeNumber: 1, position: safe),
        ]
        model.setActiveRound(strokes: atSafe)
        let selectedMode = modeDescription(model.roundCardMode)
        model.setActiveRound(strokes: nil)
        model.setActiveRound(strokes: atSafe)
        let primaryMode = modeDescription(model.roundCardMode)
        model.setActiveRound(strokes: nil)
        let roundReset = model.activeOptionShotIdByHole.isEmpty

        let outcome = "chips=\(initial.map { "\($0.label)|\($0.clubName)" }.joined(separator: ";")) "
            + "selected=\(selected) line=\(selectedLine.joined(separator: ">")) "
            + "selectedMode=\(selectedMode) primaryMode=\(primaryMode) "
            + "roundReset=\(roundReset)"
        print("OPTIONS-DEBUG \(outcome)")
        UserDefaults.standard.set(outcome, forKey: "optionsDebug.lastResult")
    }

    private static func modeDescription(_ mode: OnCourseModel.RoundCardMode?) -> String {
        switch mode {
        case .teePreview: "teePreview"
        case .plan(let legIndex): "plan(leg:\(legIndex))"
        case .decide: "decide"
        case .green: "green"
        case nil: "nil"
        }
    }
}

/// Data-independent headless verification for T36. Eighteen fixed-feature
/// shots, one every four minutes over a 72-minute round, all travel through
/// OriginCalibration's production residual gate. Without refresh the initial
/// solve would hit zero trust after 15 minutes; with the periodic observations
/// it remains applied through the final hole.
private enum T36LaserRoundDebug {
    static func run() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        var calibration = OriginCalibration(
            biasE: 2.5,
            biasN: -1.5,
            solvedAt: start,
            solvedNear: LatLon(lat: 58.36, lon: 15.71),
            method: .trilateration,
            baseConfidence: 0.85
        )
        var confirmed = 0
        var allApplied = true

        for hole in 1...18 {
            let shotAt = start.addingTimeInterval(Double(hole * 4 * 60))
            let residual = hole.isMultiple(of: 2) ? -1.0 : 1.0
            let (updated, outcome) = calibration.registeringResidual(residual, now: shotAt)
            calibration = updated
            if outcome == .confirmed { confirmed += 1 }
            allApplied = allApplied
                && calibration.appliedBias(now: shotAt, distanceFromSolveM: 0) != nil
        }

        let finish = start.addingTimeInterval(72 * 60)
        let confidence = calibration.confidence(now: finish, distanceFromSolveM: 0)
        let fresh = allApplied
            && confirmed == 18
            && calibration.method == .residualRefresh
            && calibration.solvedAt == finish
            && !calibration.stale
        let outcome = "holes=18 confirmed=\(confirmed) fresh=\(fresh) "
            + "method=\(calibration.method.rawValue) confidence=\(confidence)"
        print("LASER-DEBUG \(outcome)")
        UserDefaults.standard.set(outcome, forKey: "laserDebug.lastResult")
    }
}
#endif
