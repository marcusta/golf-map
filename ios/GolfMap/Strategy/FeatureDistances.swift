import Foundation

/// Feature-distances engine — the yardage-list assembly layer. Faithful Swift
/// port of `shared/strategy/feature-distances.ts`: pure composition over
/// `PlaysLike.segmentStats` (the elevation line math), `hazardsAlongLine`
/// (Carry.swift), `windEffect`/`playsAsM` (Wind.swift) and `clubAdvice`
/// (Club.swift). The two MUST stay numerically identical: ported tests +
/// TS-generated golden fixtures (`strategy-goldens.json`) pin the parity.
///
/// Units & conventions: points are projected planar meters (EPSG:3006-style
/// {x, y}); bearings are compass degrees (0 = north, clockwise). Wind speed
/// m/s, direction = where the wind comes FROM.
///
/// Null-propagation contract (exact, see feature-distances.ts header):
///  - `lineM` is ALWAYS present.
///  - `elevationDeltaM` is nil when either endpoint lacks a DEM elevation.
///  - `playsLikeM` is nil whenever `elevationDeltaM` is nil.
///  - `windDeltaM` is nil when wind is absent OR playsLikeM is nil.

/// A path point in planar meters, with optional elevation. Mirror of
/// `plays-like.ts` `StrategyPoint` (the x/y/elevation shape the engine uses).
public struct StrategyPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    /// Meters; nil = no terrain sample at this point.
    public var elevation: Double?

    public init(x: Double, y: Double, elevation: Double? = nil) {
        self.x = x
        self.y = y
        self.elevation = elevation
    }
}

/// The row kind: one of the point roles, or the two rows a crossed hazard
/// ring expands into. Raw values match the TS union member strings.
public enum FeatureDistanceKind: String, Equatable, Sendable {
    case greenFront = "green_front"
    case greenCenter = "green_center"
    case greenBack = "green_back"
    case layup
    case aim
    case pin
    case hazardFront = "hazard_front"
    case hazardCarry = "hazard_carry"
}

/// A target the engine can measure to. `.point` is any single point with a
/// role tag; `.hazard` is a ring expanded into up to two rows (front, carry).
public enum DistanceTarget {
    case point(label: String, role: FeatureDistanceKind, at: StrategyPoint)
    case hazard(label: String, ring: FlatRing)
}

/// One row of the yardage list. See the module header for the
/// null-propagation contract on the three delta fields.
public struct FeatureDistance<Club: ClubSpec> {
    public var kind: FeatureDistanceKind
    public var label: String
    /// Bearing from origin to this row's point, compass degrees.
    public var bearingDeg: Double
    /// Straight-line ground distance, meters. Always present.
    public var lineM: Double
    /// Signed elevation delta, meters (uphill positive). Nil: no DEM.
    public var elevationDeltaM: Double?
    /// lineM + elevationDeltaM. Nil when elevationDeltaM is nil.
    public var playsLikeM: Double?
    /// playsAsM(playsLikeM, windEffect(...)) − playsLikeM. Nil when wind is
    /// absent or playsLikeM is nil.
    public var windDeltaM: Double?
    /// Club whose carry is nearest the wind-adjusted plays-like distance, if
    /// clubs were supplied.
    public var club: Club?
}

public struct FeatureWind: Equatable, Sendable {
    public var speedMps: Double
    public var directionDeg: Double
    public init(speedMps: Double, directionDeg: Double) {
        self.speedMps = speedMps
        self.directionDeg = directionDeg
    }
}

/// Assemble the sorted yardage list for one origin. Pure composition — see the
/// module header for the exact null-propagation rules. Rows are sorted
/// ascending by `lineM`. Mirror of `feature-distances.ts` `featureDistances`.
public func featureDistances<Club: ClubSpec>(
    origin: StrategyPoint,
    targets: [DistanceTarget],
    bearingDeg: Double,
    wind: FeatureWind? = nil,
    clubs: [Club] = []
) -> [FeatureDistance<Club>] {
    var rows: [FeatureDistance<Club>] = []

    for target in targets {
        switch target {
        case let .point(label, role, at):
            rows.append(buildRow(role, label, origin, at, wind, clubs))
        case let .hazard(label, ring):
            let hazards = hazardsAlongLine(Vec2(x: origin.x, y: origin.y), bearingDeg, [ring])
            for hazard in hazards {
                rows.append(buildHazardRow(.hazardFront, "\(label) front", origin, bearingDeg, hazard.frontM, wind, clubs))
                rows.append(buildHazardRow(.hazardCarry, "\(label) carry", origin, bearingDeg, hazard.carryM, wind, clubs))
            }
        }
    }

    // Stable sort by lineM (matches Array.prototype.sort's comparator use;
    // ties keep insertion order, as the golden hole relies on).
    return rows.enumerated()
        .sorted { $0.element.lineM != $1.element.lineM ? $0.element.lineM < $1.element.lineM : $0.offset < $1.offset }
        .map(\.element)
}

/// Bearing from `from` to `to`, compass degrees [0, 360) — inverse of
/// bearingToUnitVector. Mirror of `feature-distances.ts` `bearingBetween`.
public func planarBearingDeg(_ from: StrategyPoint, _ to: StrategyPoint) -> Double {
    let dx = to.x - from.x
    let dy = to.y - from.y
    let deg = atan2(dx, dy) * 180 / .pi
    return deg < 0 ? deg + 360 : deg
}

private func buildRow<Club: ClubSpec>(
    _ kind: FeatureDistanceKind,
    _ label: String,
    _ origin: StrategyPoint,
    _ at: StrategyPoint,
    _ wind: FeatureWind?,
    _ clubs: [Club]
) -> FeatureDistance<Club> {
    let stats = PlaysLike.segmentStats(
        PlaysLike.Point(e: origin.x, n: origin.y, elevation: origin.elevation),
        PlaysLike.Point(e: at.x, n: at.y, elevation: at.elevation)
    )
    let rowBearingDeg = planarBearingDeg(origin, at)
    return finishRow(kind, label, rowBearingDeg, stats.horizontal, stats.playsLikeSimple, wind, clubs)
}

private func buildHazardRow<Club: ClubSpec>(
    _ kind: FeatureDistanceKind,
    _ label: String,
    _ origin: StrategyPoint,
    _ bearingDeg: Double,
    _ distanceM: Double,
    _ wind: FeatureWind?,
    _ clubs: [Club]
) -> FeatureDistance<Club> {
    // Hazard rows have no elevation-sampled point of their own → the
    // projected point carries no elevation, so segmentStats degrades to
    // null-propagation, exactly like the TS engine.
    let projected = projectAlong(origin, bearingDeg, distanceM)
    let stats = PlaysLike.segmentStats(
        PlaysLike.Point(e: origin.x, n: origin.y, elevation: origin.elevation),
        PlaysLike.Point(e: projected.x, n: projected.y, elevation: projected.elevation)
    )
    return finishRow(kind, label, bearingDeg, stats.horizontal, stats.playsLikeSimple, wind, clubs)
}

private func projectAlong(_ origin: StrategyPoint, _ bearingDeg: Double, _ distanceM: Double) -> StrategyPoint {
    let rad = bearingDeg * .pi / 180
    return StrategyPoint(x: origin.x + distanceM * sin(rad), y: origin.y + distanceM * cos(rad), elevation: nil)
}

private func finishRow<Club: ClubSpec>(
    _ kind: FeatureDistanceKind,
    _ label: String,
    _ bearingDeg: Double,
    _ lineM: Double,
    _ playsLikeSimpleM: Double?,
    _ wind: FeatureWind?,
    _ clubs: [Club]
) -> FeatureDistance<Club> {
    let elevationDeltaM: Double? = playsLikeSimpleM.map { $0 - lineM }
    let playsLikeM = playsLikeSimpleM

    var windDeltaM: Double?
    if let wind, let playsLikeM {
        let effect = windEffect(wind.speedMps, wind.directionDeg, bearingDeg)
        windDeltaM = playsAsM(playsLikeM, effect) - playsLikeM
    }

    var row = FeatureDistance<Club>(
        kind: kind,
        label: label,
        bearingDeg: bearingDeg,
        lineM: lineM,
        elevationDeltaM: elevationDeltaM,
        playsLikeM: playsLikeM,
        windDeltaM: windDeltaM,
        club: nil
    )

    if !clubs.isEmpty {
        let targetForClub = (playsLikeM ?? lineM) + (windDeltaM ?? 0)
        let advice = clubAdvice(clubs, targetForClub)
        if let center = advice.center { row.club = center }
    }

    return row
}
