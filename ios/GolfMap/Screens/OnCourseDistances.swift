import Foundation

/// One labeled aim point on a hole (already ordered by `sortOrder` upstream).
///
/// Aim points are the placed hazard-carry / layup markers in this data model —
/// there is no separate generic "hazard" entity, so the on-course screen's
/// hazard distances are exactly these.
struct AimTarget: Equatable, Sendable {
    var label: String
    var position: LatLon
    var elevation: Double?

    init(label: String, position: LatLon, elevation: Double? = nil) {
        self.label = label
        self.position = position
        self.elevation = elevation
    }
}

/// The static target set of one hole, adapted from the Store records by
/// `OnCourseModel`. Pure values so the distance math stays unit-testable.
struct HoleTargets: Equatable, Sendable {
    var greenFront: LatLon?
    var greenCenter: LatLon?
    var greenBack: LatLon?
    /// Green elevation in meters (record value or terrain-sampled); nil
    /// degrades plays-like to nil.
    var greenElevation: Double?
    var activePin: LatLon?
    var activePinName: String?
    var aimPoints: [AimTarget]

    init(
        greenFront: LatLon? = nil,
        greenCenter: LatLon? = nil,
        greenBack: LatLon? = nil,
        greenElevation: Double? = nil,
        activePin: LatLon? = nil,
        activePinName: String? = nil,
        aimPoints: [AimTarget] = []
    ) {
        self.greenFront = greenFront
        self.greenCenter = greenCenter
        self.greenBack = greenBack
        self.greenElevation = greenElevation
        self.activePin = activePin
        self.activePinName = activePinName
        self.aimPoints = aimPoints
    }
}

/// A labeled aim point with its whole-meter distance from the origin.
struct AimDistance: Equatable, Sendable {
    var label: String
    var meters: Int
}

/// Pure distance snapshot for one origin (user GPS fix or the active tee)
/// against one hole's targets. All horizontal distances are planar EPSG:3006
/// meters (`Distance.planarMeters`), rounded to whole meters — the same
/// convention as the web measurement tools.
///
/// Plays-like uses the preliminary caddie rule from `PlaysLike.segmentStats`
/// (horizontal + elevationΔ); it is nil whenever either elevation is unknown.
struct OnCourseDistances: Equatable, Sendable {
    var front: Int?
    var center: Int?
    var back: Int?
    var pin: Int?
    /// Plays-like to green center (origin → greenElevation), whole meters.
    var playsLikeCenter: Int?
    /// Plays-like to the active pin (same green elevation), whole meters.
    var playsLikePin: Int?
    /// Aim-point distances in hole order.
    var aims: [AimDistance]

    /// - Parameter competitionMode: when true, the slope-adjusted plays-like
    ///   figures are OMITTED (left nil) — the DMD local rule allows distance
    ///   only. Straight distances are unaffected. Gating here (rather than at
    ///   the view) keeps one source of truth: NO consumer of `distances` can
    ///   surface a plays-like number in competition, and the rule is unit-
    ///   testable without a view. Default false (friendly rounds).
    static func compute(
        from origin: LatLon,
        originElevation: Double?,
        targets: HoleTargets,
        competitionMode: Bool = false
    ) -> OnCourseDistances {
        func meters(to target: LatLon?) -> Int? {
            guard let target else { return nil }
            return Int(Distance.planarMeters(origin, target).rounded())
        }

        func playsLike(to target: LatLon?) -> Int? {
            // Competition mode: slope-adjusted advice is not allowed — omit it
            // entirely (not computed) so it can never be displayed.
            guard !competitionMode else { return nil }
            guard
                let target,
                let originElevation,
                let greenElevation = targets.greenElevation
            else { return nil }
            let a = Sweref99TM.fromWGS84(origin)
            let b = Sweref99TM.fromWGS84(target)
            let stats = PlaysLike.segmentStats(
                PlaysLike.Point(e: a.x, n: a.y, elevation: originElevation),
                PlaysLike.Point(e: b.x, n: b.y, elevation: greenElevation)
            )
            return stats.playsLikeSimple.map { Int($0.rounded()) }
        }

        return OnCourseDistances(
            front: meters(to: targets.greenFront),
            center: meters(to: targets.greenCenter),
            back: meters(to: targets.greenBack),
            pin: meters(to: targets.activePin),
            playsLikeCenter: playsLike(to: targets.greenCenter),
            playsLikePin: playsLike(to: targets.activePin),
            aims: targets.aimPoints.map { aim in
                AimDistance(
                    label: aim.label,
                    meters: Int(Distance.planarMeters(origin, aim.position).rounded())
                )
            }
        )
    }
}
