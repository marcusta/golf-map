import Foundation
import Observation

/// On-course green-read view-model (doc §4 tier ladder, §5.1 live read) — the
/// headless logic behind the putt-read panel + map overlay, deliberately kept
/// free of SwiftUI/MapLibre so it tests under XCTest like the other on-course
/// models (GreenAnalysisModel, OnCourseModel). Faithful port of the shape of
/// `web/src/planner/putt-read.service.ts`, adapted to the iOS tiers:
///
///  - **Tier 2 (Surface):** a `DemSurface` over the hole's `SampleGrid` (the
///    same terrain-tile grid GreenAnalysisModel already sampled). Confidence is
///    the conservative `PuttReadGeometry.TERRAIN_TILE_DEM_CONFIDENCE` (0.45,
///    below MIN_READ_CONFIDENCE), so an uncalibrated terrain-tile read is
///    softened by default (doc §4). readPutt is a grid search over ODE
///    integrations — NEVER run per tap/drag frame; see the compute cadence note.
///  - **Tier 3 (Manual):** closed-form `tourReadFromPaces` from a slope-%
///    estimate + grade + putt length the player enters. Works on any course,
///    no data. Offered automatically when the green has no grid.
///  - **Tier 1 (LiDAR scan):** not built here — `installScannedSurface` is the
///    documented seam task E1 plugs its corridor-scan surface into.
///
/// **Competition gating (doc §5.2, D3 seam):** when `competitionMode` is ON,
/// NO reads at all — both tiers withhold and the panel shows a one-line note.
/// (Spot-level capture stays available, per D2's reasoning — surfaced from the
/// panel, not gated here.)
///
/// **Compute cadence (threading, doc §5.1):** ball/hole/stimp are LIVE, so the
/// markers + straight reference line follow taps for free. The integrator runs
/// only via `scheduleRead()` (place, stimp change, data arrival), debounced onto
/// a detached background Task keyed by an input signature: a burst collapses
/// into ONE integration over the SETTLED inputs, and the published `read`
/// surfaces the stored result only while its signature still matches the live
/// inputs — a stale read falls away rather than showing wrong numbers. Tap→place
/// feedback is never blocked (the markers update synchronously; the read lands
/// when the Task settles).
@MainActor
@Observable
final class PuttReadModel {

    // MARK: - Tier & availability

    /// Which tier the panel is showing.
    enum ReadMode: String, Equatable, Sendable {
        case surface // Tier 2 — DEM
        case manual  // Tier 3 — closed-form Tour Read
    }

    /// The panel's status (mirrors the web `PuttReadStatus`).
    enum Status: Equatable, Sendable {
        case competition   // reads off (competition mode) — both tiers withheld
        case noSurface     // no terrain grid — Surface tier unusable, offer Manual
        case place         // grid ready, ball/hole not both placed
        case pending       // inputs changed, read not settled yet
        case unavailable   // ball or hole off the green's surface — read WITHHELD
        case soft          // read shown but SOFTENED (degraded path / low conf)
        case ok
    }

    // MARK: - Live inputs

    /// Ball / hole in EPSG:3006 meters. Nil = not placed.
    private(set) var ball: Vec2?
    private(set) var hole: Vec2?

    /// Green speed (stimp feet), persisted, clamped 4–16.
    private(set) var stimpFt: Double

    /// Segmented Surface / Manual selection.
    private(set) var mode: ReadMode = .surface

    /// App competition mode, mirrored from AppSettings by the screen.
    var competitionMode = false {
        didSet {
            guard competitionMode != oldValue else { return }
            scheduleRead()
        }
    }

    // MARK: - Manual (Tier 3) form inputs

    enum ManualLengthUnit: String, Equatable, Sendable {
        case meters
        case paces
    }

    private(set) var manualLengthUnit: ManualLengthUnit = .meters
    /// Putt length in the selected unit (meters or paces).
    private(set) var manualLength = 6.0
    /// Cross-slope estimate, % (unsigned).
    private(set) var manualSlopePct = 2.0
    /// Uphill/downhill grade estimate, % (signed: + = uphill).
    private(set) var manualGradePct = 0.0
    /// Which way the ball breaks (the side to aim on).
    private(set) var manualBreakToRight = true

    // MARK: - Surface source

    @ObservationIgnored private var grid: SampleGrid?
    /// Tier-2 surface: bilinear DemSurface over the terrain-tile grid, at the
    /// terrain-tile confidence — or, when the active green has server
    /// calibration, at the calibrated confidence and wrapped in a
    /// `CalibratedSurface` that corrects the DEM gradient by the fitted bias.
    @ObservationIgnored private var demSurface: (any GreenSurface)?
    /// Server per-green calibration for the active green (synced + cached;
    /// `applyCalibration`). Nil = uncalibrated → the read behaves exactly like
    /// the bare terrain tiles (doc §4.2).
    @ObservationIgnored private var calibration: GreenCalibration?
    /// Tier-1 surface: a fresh LiDAR corridor scan (task E1 seam, see
    /// `installScannedSurface`). Takes precedence over the DEM when present.
    @ObservationIgnored private var scannedSurface: (any GreenSurface)?

    /// The effective read surface — best available tier (doc §4 ladder).
    /// The whole pipeline (readPutt, tour cross-check, gating, overlay) is
    /// written against `GreenSurface`, so tiers are interchangeable.
    private var surface: (any GreenSurface)? { scannedSurface ?? demSurface }
    /// Bumped whenever `grid` is replaced — part of the read signature, and
    /// deliberately OBSERVABLE (unlike `grid`/`surface`): reading it from
    /// `display`/`overlay`/`hasSurface` makes SwiftUI re-evaluate when a grid
    /// installs.
    private var gridSeq = 0

    // MARK: - Settled read

    private struct Settled: Equatable {
        var sig: String
        var read: PuttRead
        var tour: TourRead?
        var profile: PuttReadGeometry.PuttProfile?
        /// Scoring ground truth for the putt quiz — nil unless the Surface
        /// read has both a settled integrator read AND a coverage-derived
        /// cross-slope (mirrors the web `PuttReadService.display`'s
        /// `groundTruth` assembly). See `runScheduledRead`.
        var groundTruth: PuttGroundTruth?
    }
    @ObservationIgnored private var result: Settled?
    /// Observation trigger: bumped when a settled read lands so `display`
    /// recomputes without exposing the private `result`.
    private var resultToken = 0

    @ObservationIgnored private var readScheduled = false
    @ObservationIgnored private var computeTask: Task<Void, Never>?

    // MARK: - Persistence

    @ObservationIgnored private let defaults: UserDefaults
    private static let stimpKey = "putt.stimpFt"

    /// Below this min-confidence the Surface read is softened (doc §4), mirror
    /// of the web `MIN_READ_CONFIDENCE`.
    static let minReadConfidence = 0.5
    static let stimpMinFt = 4.0
    static let stimpMaxFt = 16.0
    static let defaultStimpFt = 10.0

    /// - Parameter defaultStimpFt: seed used only when nothing is persisted yet
    ///   (Settings § default stimp — `AppSettings.defaultStimpFt`). Once the
    ///   player adjusts the slider it's the persisted value that wins on every
    ///   subsequent launch, regardless of the seed passed in here.
    init(defaults: UserDefaults = .standard, defaultStimpFt: Double = PuttReadModel.defaultStimpFt) {
        self.defaults = defaults
        let seed = min(Self.stimpMaxFt, max(Self.stimpMinFt, defaultStimpFt))
        let stored = defaults.object(forKey: Self.stimpKey) as? Double
        self.stimpFt = stored.map { min(Self.stimpMaxFt, max(Self.stimpMinFt, $0)) }
            ?? seed
    }

    // MARK: - Lifecycle

    /// Arm the read for a hole's green: reset the markers (hole → active pin
    /// else green center, EPSG:3006; ball unplaced — the player taps to place
    /// it). The terrain grid follows via `installGrid` when the green-analysis
    /// sampling resolves (the screen forwards it); until then the Surface tier
    /// has nothing to read and the panel shows the analysis loading state.
    func activate(defaultHole: Vec2?) {
        ball = nil
        hole = defaultHole
        placeTarget = .ball
        scannedSurface = nil // a corridor scan never outlives its hole (E1 seam)
        calibration = nil // calibration is per-green — the screen re-applies it
        installGrid(nil)
    }

    /// Convenience for tests / synchronous callers: arm + install in one step.
    func activate(grid: SampleGrid?, defaultHole: Vec2?) {
        activate(defaultHole: defaultHole)
        installGrid(grid)
    }

    /// Install (or clear) the hole's terrain SampleGrid — the Tier-2 surface
    /// source. Nil = no terrain tiles over this green: the Surface tier is
    /// unusable and the model auto-falls-back to Manual (doc §4 tier ladder).
    /// Keeps the markers (a data refresh must not lose a placed ball).
    func installGrid(_ newGrid: SampleGrid?) {
        grid = newGrid
        rebuildDemSurface()
        gridSeq += 1
        result = nil
        mode = surface == nil ? .manual : .surface
        scheduleRead()
    }

    /// Apply (or clear) the active green's server calibration — the read side
    /// of the green-scan round-trip (doc §4.2). Set by the screen right after
    /// `activate`, from the synced + offline-cached course calibration:
    ///
    ///  - **confidence:** the agreement statistic REPLACES the conservative
    ///    terrain-tile default, so a well-calibrated green can cross
    ///    `minReadConfidence` and stop being softened (ordinal — softening
    ///    only, never sharpens the geometry).
    ///  - **bias:** the fitted low-frequency tilt corrects the DEM gradient
    ///    (`CalibratedSurface`).
    ///
    /// Nil (uncalibrated green) is a no-op: the terrain-tile read is unchanged.
    /// Rebuilds the current surface so a mid-session refresh takes effect.
    func applyCalibration(_ calibration: GreenCalibration?) {
        self.calibration = calibration
        rebuildDemSurface()
        gridSeq += 1
        result = nil
        scheduleRead()
    }

    /// Rebuild the Tier-2 surface from the current grid + calibration: a
    /// `DemSurface` at the calibrated (else terrain-tile) confidence, wrapped
    /// in a `CalibratedSurface` when a bias is fitted. Nil grid → no surface.
    private func rebuildDemSurface() {
        guard let grid else {
            demSurface = nil
            return
        }
        let confidence = calibration?.confidence ?? PuttReadGeometry.TERRAIN_TILE_DEM_CONFIDENCE
        let base = DemSurface(grid: grid, confidence: confidence)
        if let bias = calibration?.bias {
            demSurface = CalibratedSurface(
                base: base,
                bias: bias,
                origin: Vec2(x: grid.spec.originE, y: grid.spec.originN)
            )
        } else {
            demSurface = base
        }
    }

    /// ── Seam for task E1 (LiDAR corridor scan — Tier 1) ─────────────────────
    /// A fresh, QC-passed corridor scan replaces the DEM as the read surface:
    /// E1 builds its gravity-framed `ScannedSurface` as a `GreenSurface`
    /// adapter (nil outside the scanned corridor; per-sample confidence from
    /// the out-and-back mismatch) and installs it here after the scan is
    /// accepted. Everything downstream — the integrator, the Tour Read
    /// cross-check, availability/confidence gating, the map overlay — is
    /// tier-agnostic, so the scan's own confidence flows through unchanged
    /// (a corridor exit mid-roll degrades the read exactly like a DEM
    /// coverage gap). Pass nil when the scan goes stale (hole change already
    /// clears it via `activate`/`deactivate`) to fall back to the terrain
    /// grid from `installGrid`.
    /// ─────────────────────────────────────────────────────────────────────────
    func installScannedSurface(_ scanned: (any GreenSurface)?) {
        scannedSurface = scanned
        gridSeq += 1
        result = nil
        if surface != nil { mode = .surface } else { mode = .manual }
        scheduleRead()
    }

    /// Disarm: cancel any in-flight compute and drop live state.
    func deactivate() {
        computeTask?.cancel()
        computeTask = nil
        ball = nil
        hole = nil
        grid = nil
        demSurface = nil
        scannedSurface = nil
        calibration = nil
        result = nil
    }

    var hasSurface: Bool {
        _ = gridSeq // observation dependency (surface itself is untracked)
        return surface != nil
    }

    /// Subtle calibration state for the panel — "Calibrated · N scans" when the
    /// active green carries server calibration from real scans, else nil. Lets
    /// a softened-vs-confident read be explained (doc §4.2). Nil in competition
    /// mode (the whole read section is off). Reads `gridSeq` so it updates when
    /// `applyCalibration` lands.
    var calibrationNote: String? {
        _ = gridSeq // observation dependency (calibration itself is untracked)
        guard !competitionMode, let calibration else { return nil }
        let n = calibration.sampleCount
        let count = n == n.rounded() ? String(Int(n)) : String(format: "%.1f", n)
        return "Calibrated · \(count) scan\(n == 1 ? "" : "s")"
    }

    // MARK: - Placement (settled edits — recompute)

    /// Which marker the next map tap moves. Ball by default; the panel offers
    /// a Hole target so both markers are re-tappable (doc §5.1). A hole
    /// placement auto-reverts to Ball (moving the hole is a one-off fix).
    enum PlaceTarget: String, Equatable, Sendable {
        case ball
        case hole
    }

    private(set) var placeTarget: PlaceTarget = .ball

    func setPlaceTarget(_ target: PlaceTarget) {
        placeTarget = target
    }

    /// A settled tap on the green view: place whichever marker is targeted.
    func handleTap(_ p: Vec2) {
        switch placeTarget {
        case .ball:
            placeBall(p)
        case .hole:
            placeHole(p)
            placeTarget = .ball
        }
    }

    /// Place / re-place the ball. A settled edit → recompute.
    func placeBall(_ p: Vec2) {
        ball = p
        scheduleRead()
    }

    /// Place / re-place the hole. A settled edit → recompute.
    func placeHole(_ p: Vec2) {
        hole = p
        scheduleRead()
    }

    // MARK: - Drag (live marker only — no integrator per frame)

    /// Per-frame drag update: the marker + reference line follow the finger;
    /// the settled read's signature diverges so its path/numbers fall away
    /// rather than going stale. No recompute until `commitDrag`.
    func dragBall(_ p: Vec2) {
        ball = p
    }

    func dragHole(_ p: Vec2) {
        hole = p
    }

    /// Drag released — positions settled, recompute once.
    func commitDrag() {
        scheduleRead()
    }

    func setMode(_ newMode: ReadMode) {
        guard newMode != mode else { return }
        // Surface tier is only selectable when a grid exists.
        if newMode == .surface, surface == nil { return }
        mode = newMode
    }

    /// Change green speed (clamped 4–16, persisted). Recomputes.
    func setStimp(_ value: Double) {
        let clamped = min(Self.stimpMaxFt, max(Self.stimpMinFt, value))
        guard clamped != stimpFt else { return }
        stimpFt = clamped
        defaults.set(clamped, forKey: Self.stimpKey)
        scheduleRead()
    }

    // MARK: - Manual form setters

    func setManualLengthUnit(_ unit: ManualLengthUnit) { manualLengthUnit = unit }
    func setManualLength(_ v: Double) { manualLength = max(0, v) }
    func setManualSlopePct(_ v: Double) { manualSlopePct = max(0, v) }
    func setManualGradePct(_ v: Double) { manualGradePct = v }
    func setManualBreakToRight(_ v: Bool) { manualBreakToRight = v }

    // MARK: - Display

    /// The panel's single view-model. Availability honoured here (never a
    /// confident read from bad data). `resultToken` is read so the computed
    /// re-runs when a settled read lands.
    struct Display {
        var status: Status
        var mode: ReadMode
        /// Guidance / withhold / softening / can't-stop message, or nil.
        var message: String?
        /// Exact integrator read (Surface tier) — nil when withheld/Manual.
        var read: PuttRead?
        /// Closed-form Tour Read (both tiers) — the verbal cross-check.
        var tour: TourRead?
        /// Metric verbal form of `tour`.
        var verbal: TourReadVerbal?
        /// True when the Manual tier is available as a fallback (no surface).
        var offerManual: Bool
        /// Putt-quiz scoring ground truth — non-nil ONLY for a live, settled
        /// Surface-tier read (ok or soft; never competition, never withheld/
        /// pending/manual). The putt quiz's "is a live read available to
        /// train against" gate is simply `display.groundTruth != nil`.
        var groundTruth: PuttGroundTruth?
        /// Straight distance, signed endpoint elevation and local slope
        /// stations along the simulated path (Surface tier only).
        var profile: PuttReadGeometry.PuttProfile? = nil
    }

    var display: Display {
        _ = resultToken // observation dependency: recompute when a read settles
        _ = gridSeq // …and when a grid installs (surface itself is untracked)

        if competitionMode {
            return Display(
                status: .competition, mode: mode,
                message: "Competition mode — reads off.",
                read: nil, tour: nil, verbal: nil, offerManual: false, groundTruth: nil
            )
        }

        if mode == .manual {
            return manualDisplay()
        }

        // Surface (Tier 2).
        guard surface != nil else {
            return Display(
                status: .noSurface, mode: mode,
                message: "No terrain data for this green — use Manual.",
                read: nil, tour: nil, verbal: nil, offerManual: true, groundTruth: nil
            )
        }
        guard ball != nil, hole != nil else {
            return Display(
                status: .place, mode: mode,
                message: "Tap the green to place the ball.",
                read: nil, tour: nil, verbal: nil, offerManual: true, groundTruth: nil
            )
        }
        guard let settled = result, settled.sig == inputsSig() else {
            return Display(
                status: .pending, mode: mode, message: nil,
                read: nil, tour: nil, verbal: nil, offerManual: true, groundTruth: nil
            )
        }

        let read = settled.read
        if read.availability == .unavailable {
            return Display(
                status: .unavailable, mode: mode,
                message: "No read — ball or hole is off the green's surface.",
                read: nil, tour: nil, verbal: nil, offerManual: true, groundTruth: nil
            )
        }

        var status: Status = .ok
        var message: String?
        if read.availability == .degraded {
            status = .soft
            message = "Ball path leaves coverage — partial, low-confidence read."
        } else if read.minConfidence < Self.minReadConfidence {
            status = .soft
            message = "Terrain-tile surface — treat as a rough read."
        }
        if !read.canStop {
            let cant = "Can't stop this one — lag to the low side."
            message = message.map { "\(cant) \($0)" } ?? cant
        }
        let verbal = settled.tour.map { formatTourRead($0, units: .metric) }
        return Display(
            status: status, mode: mode, message: message,
            read: read, tour: settled.tour, verbal: verbal, offerManual: true,
            groundTruth: settled.groundTruth, profile: settled.profile
        )
    }

    /// Tier-3 closed-form display, computed synchronously (no integrator).
    /// `groundTruth` stays nil — the Manual tier's inputs ARE the displayed
    /// read (the player's own slope/grade estimate), so there's no
    /// independent truth to quiz against.
    private func manualDisplay() -> Display {
        let tour = tourReadFromPaces(
            manualLengthUnit == .paces ? manualLength : metersToPaces(manualLength),
            gradeDeltaM: gradeDeltaMeters(),
            slopePct: manualSlopePct,
            stimpFt: stimpFt,
            breakToRight: manualBreakToRight
        )
        let verbal = formatTourRead(tour, units: .metric)
        let message = tour.canStop ? nil : "Can't stop this one — lag to the low side."
        return Display(
            status: tour.canStop ? .ok : .soft, mode: .manual, message: message,
            read: nil, tour: tour, verbal: verbal, offerManual: hasSurface ? false : true,
            groundTruth: nil
        )
    }

    /// Manual grade % + putt length → signed Δh meters along the line.
    private func gradeDeltaMeters() -> Double {
        let lengthM = manualLengthUnit == .paces ? manualLength * PACE_METERS : manualLength
        return manualGradePct / 100 * lengthM
    }

    /// The map overlay for the current Surface read (nil in Manual/competition
    /// mode or with no marker at all). Markers + reference line show as soon as
    /// they exist — the hole marker renders alone before the ball is placed,
    /// and placement feedback never waits on the integrator.
    var overlay: PuttReadGeometry.PuttOverlay? {
        _ = resultToken
        _ = gridSeq
        guard !competitionMode, mode == .surface, ball != nil || hole != nil else { return nil }
        let settled = (result?.sig == inputsSig()) ? result : nil
        let read = settled?.read
        let soft: Bool
        if let read {
            soft = read.availability != .ok || read.minConfidence < Self.minReadConfidence
        } else {
            soft = false
        }
        // Withheld reads still show the markers/reference (no path/aim —
        // PuttReadGeometry.overlay drops them for unavailable reads).
        return PuttReadGeometry.overlay(
            ball: ball, hole: hole, read: read, profile: settled?.profile, soft: soft
        )
    }

    // MARK: - Compute

    /// Signature of everything a settled Surface read depends on.
    private func inputsSig() -> String {
        let b = ball.map { "\($0.x),\($0.y)" } ?? ""
        let h = hole.map { "\($0.x),\($0.y)" } ?? ""
        return "\(gridSeq)|\(b)|\(h)|\(stimpFt)|\(competitionMode)"
    }

    /// Ball/hole/stimp only — distinct from `inputsSig()` (which also tracks
    /// `gridSeq`/`competitionMode`, used to validate the settled-read cache).
    /// Exposed for the putt quiz's reset-on-change trigger: a ball/hole
    /// reposition or stimp change must restart the in-progress estimate, but
    /// a background grid refresh or a competition-mode toggle must not (the
    /// quiz is already fully hidden by `display.groundTruth == nil` in that
    /// case, so it doesn't need its own reset for the same event).
    var puttSignature: String {
        let b = ball.map { "\($0.x),\($0.y)" } ?? ""
        let h = hole.map { "\($0.x),\($0.y)" } ?? ""
        return "\(b)|\(h)|\(stimpFt)"
    }

    /// Debounce a Surface read onto a background Task over the SETTLED inputs.
    /// Manual/competition never integrate. Coalesces a burst into one run.
    private func scheduleRead() {
        guard !readScheduled else { return }
        readScheduled = true
        Task { @MainActor [weak self] in
            self?.runScheduledRead()
        }
    }

    private func runScheduledRead() {
        readScheduled = false
        guard !competitionMode, mode == .surface,
              let surface, let ball, let hole
        else {
            result = nil
            resultToken &+= 1
            return
        }
        let sig = inputsSig()
        let stimpFt = stimpFt
        computeTask?.cancel()
        // Detached so the grid search over ODE integrations runs OFF the main
        // actor (a plain `Task {}` here would inherit MainActor and block taps).
        // Inputs are all Sendable value types (DemSurface is a Sendable struct).
        computeTask = Task.detached(priority: .userInitiated) { [weak self] in
            let read = readPutt(surface: surface, ball: ball, hole: hole, stimpFt: stimpFt)
            // Call deriveTourReadInputs directly (rather than the
            // deriveTourRead wrapper) so the cross-slope % survives for the
            // putt quiz's groundTruth — the wrapper computes exactly this and
            // discards it.
            let derivedInputs = read.availability == .unavailable
                ? nil
                : PuttReadGeometry.deriveTourReadInputs(surface: surface, ball: ball, hole: hole)
            let profile = read.availability == .unavailable
                ? nil
                : PuttReadGeometry.deriveProfile(
                    surface: surface, ball: ball, hole: hole, path: read.path
                )
            let tour = derivedInputs.map {
                tourRead(
                    distanceM: $0.distanceM, gradeDeltaM: $0.gradeDeltaM, slopePct: $0.slopePct,
                    stimpFt: stimpFt, breakToRight: $0.breakToRight
                )
            }
            var groundTruth: PuttGroundTruth?
            if let derivedInputs, let tour {
                groundTruth = PuttGroundTruth(
                    slopePct: derivedInputs.slopePct, breakSide: tour.breakSide,
                    aimOffsetM: read.aimOffsetM, playsLikeM: read.playsLikeM
                )
            }
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self, self.inputsSig() == sig else { return }
                self.result = Settled(
                    sig: sig, read: read, tour: tour, profile: profile,
                    groundTruth: groundTruth
                )
                self.resultToken &+= 1
            }
        }
    }

    #if DEBUG
    /// Test/live-verify hook: run the Surface read synchronously (no debounce),
    /// so headless tests can assert the settled numbers without awaiting a Task.
    func computeSurfaceReadNow() {
        readScheduled = false
        guard !competitionMode, mode == .surface,
              let surface, let ball, let hole
        else {
            result = nil
            resultToken &+= 1
            return
        }
        let sig = inputsSig()
        let read = readPutt(surface: surface, ball: ball, hole: hole, stimpFt: stimpFt)
        let derivedInputs = read.availability == .unavailable
            ? nil
            : PuttReadGeometry.deriveTourReadInputs(surface: surface, ball: ball, hole: hole)
        let profile = read.availability == .unavailable
            ? nil
            : PuttReadGeometry.deriveProfile(
                surface: surface, ball: ball, hole: hole, path: read.path
            )
        let tour = derivedInputs.map {
            tourRead(
                distanceM: $0.distanceM, gradeDeltaM: $0.gradeDeltaM, slopePct: $0.slopePct,
                stimpFt: stimpFt, breakToRight: $0.breakToRight
            )
        }
        var groundTruth: PuttGroundTruth?
        if let derivedInputs, let tour {
            groundTruth = PuttGroundTruth(
                slopePct: derivedInputs.slopePct, breakSide: tour.breakSide,
                aimOffsetM: read.aimOffsetM, playsLikeM: read.playsLikeM
            )
        }
        result = Settled(
            sig: sig, read: read, tour: tour, profile: profile,
            groundTruth: groundTruth
        )
        resultToken &+= 1
    }
    #endif
}
