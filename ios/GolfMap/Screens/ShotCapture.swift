import Foundation
import Observation

// MARK: - Capture defaults (pure, unit-tested)

/// The zero-tap defaults of the capture flow (docs/feature-shot-capture.md
/// §4): shot-type auto-classification, target pre-fill and club pre-select.
/// Pure functions over plain values so every rule is unit-testable without a
/// map, GPS or database.
enum ShotCaptureDefaults {

    /// Auto shot type: `putt` when the address position lies on the green
    /// polygon (outer ring minus hole rings, planar EPSG:3006 point-in-ring —
    /// the same classification the analysis grid uses), `full` otherwise.
    /// One picker tap only for the exceptions ('partial'/'recovery').
    static func classify(position: LatLon, greenRings: [[Sweref99TM.Point]]) -> ShotType {
        guard let outer = greenRings.first, outer.count >= 3 else { return .full }
        let p = Sweref99TM.fromWGS84(position)
        guard AnalysisGridMath.pointInRing(x: p.x, y: p.y, ring: outer) else { return .full }
        let inHole = greenRings.dropFirst().contains {
            AnalysisGridMath.pointInRing(x: p.x, y: p.y, ring: $0)
        }
        return inHole ? .full : .putt
    }

    /// Target pre-fill: active pin ?? the next plan landing ahead of the
    /// position (first planned landing still closer to the green than the
    /// player — same rule as `OnCourseModel.nextPlannedLanding`) ?? green
    /// center. Nil only on a hole with no green and no plan.
    static func defaultTarget(
        position: LatLon,
        activePin: LatLon?,
        planLandings: [LatLon],
        greenCenter: LatLon?
    ) -> LatLon? {
        if let activePin { return activePin }
        if let greenCenter {
            let remaining = Distance.planarMeters(position, greenCenter)
            if let ahead = planLandings.first(where: {
                Distance.planarMeters($0, greenCenter) < remaining
            }) {
                return ahead
            }
            return greenCenter
        }
        return planLandings.first
    }

    /// The distance the club pre-select measures against: plays-like when
    /// both elevations are known (same caddie rule as the distance card),
    /// else the straight planar line; then the wind "plays as" adjustment —
    /// the exact composition `OnCourseDistances.clubTarget` uses.
    static func remainingMeters(
        from position: LatLon,
        to target: LatLon,
        positionElevation: Double? = nil,
        targetElevation: Double? = nil,
        wind: (speedMps: Double, directionDeg: Double)? = nil
    ) -> Double {
        let a = Sweref99TM.fromWGS84(position)
        let b = Sweref99TM.fromWGS84(target)
        var base = Distance.planarMeters(position, target)
        if let pe = positionElevation, let te = targetElevation {
            let stats = PlaysLike.segmentStats(
                PlaysLike.Point(e: a.x, n: a.y, elevation: pe),
                PlaysLike.Point(e: b.x, n: b.y, elevation: te)
            )
            if let playsLike = stats.playsLikeSimple { base = playsLike }
        }
        if let wind {
            let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
            let bearing = deg < 0 ? deg + 360 : deg
            base = playsAsM(base, windEffect(wind.speedMps, wind.directionDeg, bearing, base))
        }
        return base
    }

    /// Club pre-select: `closestClub` on the plays-like remaining, but no
    /// club for auto-putts (the bag has no putter entity; a putt row without
    /// a club is the §3 convention). Available in competition mode too — the
    /// pre-selection reflects the player's own bag knowledge, not advice.
    static func preselectClub(
        clubs: [ClubRecord],
        remainingMeters: Double,
        shotType: ShotType
    ) -> ClubRecord? {
        guard shotType != .putt else { return nil }
        return closestClub(clubs, remainingMeters)
    }
}

// MARK: - Capture state machine

/// The in-flight stroke while the capture tool is up: crosshair position,
/// intended target, pre-selected club and auto shot type, plus the user's
/// overrides. Owned by the on-course screen; recomputes its defaults on every
/// drag until the user overrides them.
@MainActor
@Observable
final class CaptureModel {

    /// Map-handle ids (routed by `CourseScreen` next to the putt/adjust ids).
    static let positionHandleID = "capture-position"
    static let targetHandleID = "capture-target"

    enum Phase: Equatable {
        /// No capture in flight (tool closed or just entered without a fix).
        case idle
        /// Crosshair down, waiting for confirm.
        case aiming
        /// A stroke was just written — penalty stepper targets it.
        case confirmed
    }

    private(set) var phase: Phase = .idle
    private(set) var position: LatLon?
    private(set) var target: LatLon?
    /// The optional secondary drag: the target handle only appears once the
    /// player asks for it — zero-tap in the common case.
    private(set) var targetHandleVisible = false
    private(set) var clubId: String?
    private(set) var clubIsOverridden = false
    private(set) var shotType: ShotType = .full
    private(set) var shotTypeIsOverridden = false
    /// The just-confirmed stroke (penalty stepper + summary row).
    private(set) var lastConfirmed: ShotRecord?

    // Context captured at `begin` (not observable — display derives from the
    // properties above).
    @ObservationIgnored private var clubs: [ClubRecord] = []
    @ObservationIgnored private var wind: (speedMps: Double, directionDeg: Double)?
    @ObservationIgnored private var greenRings: [[Sweref99TM.Point]] = []
    @ObservationIgnored private var positionElevation: Double?
    @ObservationIgnored private var targetElevation: Double?

    /// Arms the crosshair. `position` starts at the GPS fix (browse mode: map
    /// center); `target` at pin ?? plan ?? green center. Elevations are
    /// best-known values for the plays-like pre-select and degrade to nil
    /// after a drag (the samples belong to the original points).
    func begin(
        position: LatLon,
        target: LatLon?,
        clubs: [ClubRecord],
        wind: (speedMps: Double, directionDeg: Double)?,
        greenRings: [[Sweref99TM.Point]],
        positionElevation: Double?,
        targetElevation: Double?
    ) {
        self.position = position
        self.target = target
        self.clubs = clubs
        self.wind = wind
        self.greenRings = greenRings
        self.positionElevation = positionElevation
        self.targetElevation = targetElevation
        self.targetHandleVisible = false
        self.clubIsOverridden = false
        self.shotTypeIsOverridden = false
        self.lastConfirmed = nil
        self.phase = .aiming
        recomputeDefaults()
    }

    /// Tears the capture down (tool exit / hole navigation).
    func end() {
        phase = .idle
        position = nil
        target = nil
        targetHandleVisible = false
        clubId = nil
        clubIsOverridden = false
        shotType = .full
        shotTypeIsOverridden = false
        lastConfirmed = nil
    }

    // MARK: Drags

    /// Crosshair drag: the moved point has no sampled elevation, so the
    /// pre-select degrades to the straight/wind distance.
    func movePosition(_ p: LatLon) {
        guard phase == .aiming else { return }
        position = p
        positionElevation = nil
        recomputeDefaults()
    }

    /// Optional secondary drag on the target handle.
    func moveTarget(_ p: LatLon) {
        guard phase == .aiming else { return }
        target = p
        targetElevation = nil
        recomputeDefaults()
    }

    /// Shows/hides the target handle (the "adjust target" affordance).
    func toggleTargetHandle() {
        targetHandleVisible.toggle()
    }

    // MARK: Overrides

    /// Compact-picker club override. Passing nil returns to auto pre-select.
    func overrideClub(id: String?) {
        if let id {
            clubId = id
            clubIsOverridden = true
        } else {
            clubIsOverridden = false
            recomputeDefaults()
        }
    }

    /// Shot-type override ('partial'/'recovery' are always overrides).
    /// Passing nil returns to the auto classification.
    func overrideShotType(_ type: ShotType?) {
        if let type {
            shotType = type
            shotTypeIsOverridden = true
        } else {
            shotTypeIsOverridden = false
        }
        recomputeDefaults()
    }

    // MARK: Confirm bookkeeping

    /// The screen wrote the stroke — remember it for the penalty stepper.
    func noteConfirmed(_ shot: ShotRecord) {
        lastConfirmed = shot
        phase = .confirmed
    }

    /// The penalty stepper updated the stroke — keep the summary in sync.
    func noteUpdated(_ shot: ShotRecord) {
        guard lastConfirmed?.id == shot.id else { return }
        lastConfirmed = shot
    }

    /// Re-arm for the next stroke at a fresh position (walk to the ball, tap
    /// again). Reuses the entry context; the caller passes the new origin +
    /// target defaults.
    func rearm(position: LatLon, target: LatLon?, positionElevation: Double?, targetElevation: Double?) {
        self.position = position
        self.target = target
        self.positionElevation = positionElevation
        self.targetElevation = targetElevation
        self.targetHandleVisible = false
        self.clubIsOverridden = false
        self.shotTypeIsOverridden = false
        self.lastConfirmed = nil
        self.phase = .aiming
        recomputeDefaults()
    }

    // MARK: Derived

    /// Whole-meter remaining to the target (panel readout), nil without both
    /// endpoints.
    var remainingMeters: Int? {
        guard let position, let target else { return nil }
        return Int(Distance.planarMeters(position, target).rounded())
    }

    /// The pre-selected/overridden club's display name.
    var clubName: String? {
        guard let clubId else { return nil }
        return clubs.first(where: { $0.id == clubId })?.name
    }

    var availableClubs: [ClubRecord] { clubs }

    // MARK: Recompute

    private func recomputeDefaults() {
        guard let position else { return }
        if !shotTypeIsOverridden {
            shotType = ShotCaptureDefaults.classify(position: position, greenRings: greenRings)
        }
        if !clubIsOverridden {
            if let target {
                let remaining = ShotCaptureDefaults.remainingMeters(
                    from: position,
                    to: target,
                    positionElevation: positionElevation,
                    targetElevation: targetElevation,
                    wind: wind
                )
                clubId = ShotCaptureDefaults.preselectClub(
                    clubs: clubs, remainingMeters: remaining, shotType: shotType
                )?.id
            } else {
                clubId = nil
            }
        }
        // An overridden club is respected even for an auto-putt — only the
        // AUTO pre-select yields to the putt classification.
    }
}
