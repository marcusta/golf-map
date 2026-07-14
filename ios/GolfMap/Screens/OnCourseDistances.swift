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

/// Front/center/back club advice for a single target distance (clubAdvice's
/// three slots), as display names. Each slot may be nil at the extremes.
struct ClubAdviceLabels: Equatable, Sendable {
    var front: String?
    var center: String?
    var back: String?

    var hasAny: Bool { front != nil || center != nil || back != nil }
}

/// The honest "max-advance layup" line shown IN PLACE of the F/C/B club advice
/// when the green center is beyond the longest club. In that regime the bag's
/// longest carry can't reach, so the F/C/B advice degenerates (center + back
/// both collapse onto the longest club, front nil) and reads as "Driver
/// reaches the green" — misleading. This says the honest thing instead:
/// "Driver 243 · 58 m in (LW)". RAW distances (no plays-like / wind) so
/// `carryM + remainingM` reconciles with the card's big center figure.
struct LayupLine: Equatable, Sendable {
    /// The longest club that still falls short of the center.
    var club: String
    /// Its nominal carry, whole meters.
    var carryM: Int
    /// Straight distance still to the center after it lands, whole meters.
    var remainingM: Int
    /// Club to play for the remaining distance (closest carry); nil only if the
    /// bag is empty (in which case there is no layup line at all).
    var approachClub: String?
}

/// Stored ClubRecord is structurally a strategy ClubSpec — pass the cached
/// bag straight into the club-selection math. Its stored `name` witnesses the
/// optional `clubName` requirement so the caddy rules can speak club names.
extension ClubRecord: ClubSpec {
    public var clubName: String? { name }
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
    /// Wind "plays as" distance to center: the elevation-adjusted plays-like
    /// put through `playsAsM` for the effective wind (whole meters). Nil when
    /// wind is calm/unknown, or when plays-like is nil.
    ///
    /// SHOWN in competition mode, unlike the slope figures — but computed over
    /// the STRAIGHT distance there, so it carries wind only and no elevation.
    var windPlaysLikeCenter: Int?
    /// Wind "plays as" distance to the active pin, whole meters.
    var windPlaysLikePin: Int?
    /// Front/center/back club advice for the (wind-adjusted) plays-like
    /// distance to the green center. Nil in competition mode or without clubs.
    var centerClubs: ClubAdviceLabels?
    /// Shown INSTEAD of `centerClubs` when the green center is beyond the
    /// longest club (which is left nil in that case). Nil in competition mode,
    /// without clubs, or when the green is reachable.
    var layup: LayupLine?
    /// Closest club to the (wind-adjusted) plays-like distance to the pin.
    /// Nil in competition mode or without clubs.
    var pinClub: String?
    /// Aim-point distances in hole order.
    var aims: [AimDistance]

    /// - Parameters:
    ///   - competitionMode: when true, the slope-adjusted plays-like figures AND
    ///     all club advice are OMITTED (left nil) — the DMD local rule allows
    ///     distance only. Straight distances are unaffected, and so is the WIND
    ///     "plays as" figure (a weather-report correction, not a device reading
    ///     of the course) — but in competition that figure rides on the straight
    ///     distance, so no slope leaks in through it.
    ///     Gating here (rather than at the view) keeps one source of truth:
    ///     NO consumer of `distances` can surface club/slope advice in
    ///     competition, and the rule is unit-testable without a view.
    ///     Default false.
    ///   - wind: the effective wind for the active hole (plan hole wind ??
    ///     plan wind), or nil for calm/unknown. Applied to the plays-like
    ///     figures via `playsAsM(playsLike, windEffect(...))`, matching the
    ///     web planner's `autoClubForShot` composition order (plays-like
    ///     first, then wind "plays as").
    ///   - clubs: the player's cached bag, for the front/center/back club
    ///     advice + the pin's closest club. Omit to skip club advice.
    static func compute(
        from origin: LatLon,
        originElevation: Double?,
        targets: HoleTargets,
        competitionMode: Bool = false,
        wind: (speedMps: Double, directionDeg: Double)? = nil,
        clubs: [ClubRecord] = []
    ) -> OnCourseDistances {
        func meters(to target: LatLon?) -> Int? {
            guard let target else { return nil }
            return Int(Distance.planarMeters(origin, target).rounded())
        }

        // Slope-adjusted plays-like in meters (unrounded). Competition mode:
        // slope-adjusted advice is not allowed — omit it entirely.
        func playsLikeMeters(to target: LatLon?) -> Double? {
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
            return stats.playsLikeSimple
        }

        func playsLike(to target: LatLon?) -> Int? {
            playsLikeMeters(to: target).map { Int($0.rounded()) }
        }

        // Planar (EPSG:3006) bearing origin→target, compass degrees — the same
        // convention windEffect expects, matching the web's planarBearingDeg.
        func bearing(to target: LatLon) -> Double {
            let a = Sweref99TM.fromWGS84(origin)
            let b = Sweref99TM.fromWGS84(target)
            let deg = atan2(b.x - a.x, b.y - a.y) * 180 / .pi
            return deg < 0 ? deg + 360 : deg
        }

        // Web composition order: apply wind as `playsAsM(dist, windEffect(...))`
        // over the (already elevation-adjusted) plays-like distance.
        func windAdjusted(_ distanceM: Double, to target: LatLon) -> Double {
            guard let wind else { return distanceM }
            let effect = windEffect(wind.speedMps, wind.directionDeg, bearing(to: target), distanceM)
            return playsAsM(distanceM, effect)
        }

        // The distance clubs are chosen against: plays-like when known, else
        // the straight line (web `playsLikeSimpleM ?? horizontalM`), then wind.
        func clubTarget(to target: LatLon) -> Double {
            let base = playsLikeMeters(to: target) ?? Distance.planarMeters(origin, target)
            return windAdjusted(base, to: target)
        }

        // Club + wind advice are gated off in competition mode (advice only).
        var centerClubs: ClubAdviceLabels?
        var layup: LayupLine?
        var pinClub: String?
        var windPlaysLikeCenter: Int?
        var windPlaysLikePin: Int?

        if !competitionMode {
            if !clubs.isEmpty, let center = targets.greenCenter {
                // RAW center distance (matches the card's big center figure).
                let rawCenterM = Distance.planarMeters(origin, center)
                let longestCarry = clubs.map(\.carryM).max() ?? 0
                if longestCarry < rawCenterM {
                    // Green out of range: the F/C/B advice would collapse onto
                    // the longest club and misread as reachable. Replace it with
                    // the honest max-advance layup (RAW distances).
                    if let l = longestLayup(clubs, rawCenterM) {
                        layup = LayupLine(
                            club: l.club.name,
                            carryM: Int(l.carryM.rounded()),
                            remainingM: Int(l.remainingM.rounded()),
                            approachClub: l.approachClub?.name
                        )
                    }
                } else {
                    let advice = clubAdvice(clubs, clubTarget(to: center))
                    let labels = ClubAdviceLabels(
                        front: advice.front?.name,
                        center: advice.center?.name,
                        back: advice.back?.name
                    )
                    centerClubs = labels.hasAny ? labels : nil
                }
            }
            if !clubs.isEmpty, let pin = targets.activePin {
                pinClub = closestClub(clubs, clubTarget(to: pin))?.name
            }
        }

        // The wind "plays as" figures are NOT competition-gated: the wind comes
        // off a weather report, not a device reading of the course, so the
        // correction is allowed where the slope one is not.
        //
        // What it rides on differs by mode. Normally it is the elevation-
        // adjusted plays-like (and with no elevation there is no figure at all —
        // wind alone is never shown over a straight distance). In competition
        // slope is off limits, so the wind rides on the STRAIGHT distance
        // instead: wind-only, never slope, and no elevation term can leak back
        // in through the wind figure.
        func windBaseMeters(to target: LatLon) -> Double? {
            competitionMode
                ? Distance.planarMeters(origin, target)
                : playsLikeMeters(to: target)
        }
        if wind != nil {
            if let center = targets.greenCenter, let base = windBaseMeters(to: center) {
                windPlaysLikeCenter = Int(windAdjusted(base, to: center).rounded())
            }
            if let pin = targets.activePin, let base = windBaseMeters(to: pin) {
                windPlaysLikePin = Int(windAdjusted(base, to: pin).rounded())
            }
        }

        return OnCourseDistances(
            front: meters(to: targets.greenFront),
            center: meters(to: targets.greenCenter),
            back: meters(to: targets.greenBack),
            pin: meters(to: targets.activePin),
            playsLikeCenter: playsLike(to: targets.greenCenter),
            playsLikePin: playsLike(to: targets.activePin),
            windPlaysLikeCenter: windPlaysLikeCenter,
            windPlaysLikePin: windPlaysLikePin,
            centerClubs: centerClubs,
            layup: layup,
            pinClub: pinClub,
            aims: targets.aimPoints.map { aim in
                AimDistance(
                    label: aim.label,
                    meters: Int(Distance.planarMeters(origin, aim.position).rounded())
                )
            }
        )
    }
}
