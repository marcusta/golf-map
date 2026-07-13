import Foundation

/// Dispersion ellipse + distance rings, in projected planar meters — faithful
/// Swift port of `shared/strategy/ellipse.ts`. The two MUST stay numerically
/// identical: ported tests + TS-generated golden fixtures
/// (`strategy-goldens.json`) pin the parity.
///
/// Pure planar math in projected meters (EPSG:3006-style {x, y}; +x = east,
/// +y = north). Bearings compass degrees (0 = north, clockwise); wind speed
/// m/s, direction = where the wind comes FROM (see Wind.swift).
///
/// `Vec2` and `bearingToUnitVector` live in Putting/GreenSurface.swift and are
/// reused here (same mirror of the TS `ellipse.ts` slice).
///
/// Club dispersion values are FULL extents (v1 gotcha #1), so semi-axes are
/// half of them.

/// Options for `dispersionEllipse`. Mirror of `ellipse.ts`
/// `DispersionEllipseOptions`.
public struct DispersionEllipseOptions<C: ClubSpec> {
    /// Shot origin (tee / aim point / plan shot), planar meters.
    public var origin: Vec2
    /// Shot bearing, compass degrees.
    public var bearingDeg: Double
    public var club: C
    /// Wind speed in m/s. Omit both wind fields for a no-wind ellipse.
    public var windSpeedMps: Double?
    /// Direction the wind comes FROM, compass degrees.
    public var windDirectionDeg: Double?
    /// Ground slope along the shot line (elevationΔ / horizontal run). See the
    /// TS `groundSlope` docs. Omit / 0 for flat ground.
    public var groundSlope: Double?
    /// Polygon sample count (points on the ellipse). Default 48.
    public var samples: Int?

    public init(
        origin: Vec2,
        bearingDeg: Double,
        club: C,
        windSpeedMps: Double? = nil,
        windDirectionDeg: Double? = nil,
        groundSlope: Double? = nil,
        samples: Int? = nil
    ) {
        self.origin = origin
        self.bearingDeg = bearingDeg
        self.club = club
        self.windSpeedMps = windSpeedMps
        self.windDirectionDeg = windDirectionDeg
        self.groundSlope = groundSlope
        self.samples = samples
    }
}

/// The dispersion ellipse for one shot. Mirror of `ellipse.ts`
/// `DispersionEllipse`.
public struct DispersionEllipse: Equatable, Sendable {
    /// Expected landing point: origin + adjusted carry + crosswind drift.
    public var center: Vec2
    /// Crosswind drift of the center, meters, positive = shot-right (0 calm).
    public var driftM: Double
    /// Semi-axis along the shot line (length dispersion / 2), meters.
    public var semiLengthM: Double
    /// Semi-axis across the shot line (lateral dispersion / 2), meters.
    public var semiLateralM: Double
    /// The shot bearing the ellipse is rotated by, degrees.
    public var bearingDeg: Double
    /// CLOSED ring: `samples` points plus the first repeated last
    /// (length = samples + 1).
    public var polygon: [Vec2]
}

/// The dispersion ellipse for one shot. Mirror of `ellipse.ts`
/// `dispersionEllipse`.
public func dispersionEllipse<C: ClubSpec>(_ options: DispersionEllipseOptions<C>) -> DispersionEllipse {
    let origin = options.origin
    let bearingDeg = options.bearingDeg
    let club = options.club
    let samples = options.samples ?? 48

    let hasWind = options.windSpeedMps != nil && options.windDirectionDeg != nil
    let effect = hasWind
        ? windEffect(options.windSpeedMps!, options.windDirectionDeg!, bearingDeg)
        : 0
    let driftM = hasWind
        ? crosswindDriftM(
            club.carryM,
            windComponents(options.windSpeedMps!, options.windDirectionDeg!, bearingDeg).crosswindMph
        )
        : 0

    let along = bearingToUnitVector(bearingDeg)
    // Perpendicular pointing shot-RIGHT (bearing + 90°) = (cos b, −sin b).
    let right = Vec2(x: along.y, y: -along.x)

    let airCarry = adjustedCarryM(club.carryM, effect)
    // Project the air carry onto the ground along the leg's slope. Guard the
    // degenerate 1 + slope ≤ 0.
    let slope = options.groundSlope ?? 0
    let carry = 1 + slope > 0 ? airCarry / (1 + slope) : airCarry
    let center = Vec2(
        x: origin.x + carry * along.x + driftM * right.x,
        y: origin.y + carry * along.y + driftM * right.y
    )

    // v1 dispersion values are FULL extents → semi-axes are halves.
    let semiLengthM = lengthDispersionM(club.carryM) / 2
    let semiLateralM = club.dispersionM / 2

    var polygon: [Vec2] = []
    polygon.reserveCapacity(samples + 1)
    for i in 0..<samples {
        let t = (Double(i) / Double(samples)) * 2 * Double.pi
        let u = semiLengthM * cos(t) // along the shot line
        let v = semiLateralM * sin(t) // across, toward shot-right
        polygon.append(Vec2(
            x: center.x + u * along.x + v * right.x,
            y: center.y + u * along.y + v * right.y
        ))
    }
    polygon.append(polygon[0]) // explicit closure

    return DispersionEllipse(
        center: center,
        driftM: driftM,
        semiLengthM: semiLengthM,
        semiLateralM: semiLateralM,
        bearingDeg: bearingDeg,
        polygon: polygon
    )
}

// ---------------------------------------------------------------------------
// Distance rings (mirror of ellipse.ts distance-ring block)
// ---------------------------------------------------------------------------

/// Green-centered ring radii, meters (75 blue / 100 red / 150 yellow in v1).
public let GREEN_RING_RADII_M: [Double] = [75, 100, 150]

/// Extra green-centered radius added on par 5s (v1: exactly 2 aim points).
public let GREEN_RING_PAR5_EXTRA_M: Double = 200

/// Tee-centered full-circle radii, meters.
public let TEE_RING_RADII_M: [Double] = [200, 250]

/// Green-centered radii for a hole: [75, 100, 150], plus 200 on a par 5.
public func greenRingRadiiM(_ par: Int) -> [Double] {
    par == 5 ? GREEN_RING_RADII_M + [GREEN_RING_PAR5_EXTRA_M] : GREEN_RING_RADII_M
}

/// Planar circle as a CLOSED ring (first point repeated last, length
/// samples + 1), starting due north, clockwise (compass order). Mirror of
/// `ellipse.ts` `ringPolygon`.
public func ringPolygon(_ center: Vec2, _ radiusM: Double, samples: Int = 64) -> [Vec2] {
    var out: [Vec2] = []
    out.reserveCapacity(samples + 1)
    for i in 0..<samples {
        let bearing = (Double(i) / Double(samples)) * 360
        let dir = bearingToUnitVector(bearing)
        out.append(Vec2(x: center.x + radiusM * dir.x, y: center.y + radiusM * dir.y))
    }
    out.append(out[0])
    return out
}
