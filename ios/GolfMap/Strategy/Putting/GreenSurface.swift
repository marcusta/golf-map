import Foundation

/// Green surface abstraction for the putting core — faithful Swift port of
/// `shared/strategy/putting/green-surface.ts` (plus the `Vec2` /
/// `bearingToUnitVector` slice of `shared/strategy/ellipse.ts` it depends
/// on). The two MUST stay numerically identical (T17 discipline): same
/// formulas, same sign conventions, ported tests + TS-generated golden
/// fixtures pin the parity.
///
/// One physics core, three data tiers: the integrator (Putt.swift) and the
/// closed form (TourRead.swift) are written against this protocol only, so
/// a phone LiDAR corridor scan, the Lantmäteriet DEM slope grid, and a
/// manual slope estimate are interchangeable inputs. Adapters:
///  - `PlaneSurface` (below)   — Tier 3 manual estimate; also the analytic
///    fixture for golden-putt tests.
///  - DemSurface.swift         — Tier 2, bilinear patch over a SampleGrid.
///  - LiDAR scan adapter       — Tier 1, iOS Phase E (not built yet).
///
/// Units & conventions (match shared/strategy):
///  - Coordinates: projected meters, {x east, y north} (EPSG:3006 in
///    practice). Bearings compass degrees, 0 = north, clockwise.
///  - Heights: meters in any consistent datum (RH2000 in practice) — the
///    physics only uses differences and gradients.
///  - Gradients are dimensionless rise/run: gradX = dh/dx, gradY = dh/dy.
///    Slope fraction = |∇h|; slope percent = fraction × 100. Downhill unit
///    vector = −∇h / |∇h| (matches computeSlopeGrid's dirE/dirN).
///  - confidence: 0..1 — how confident the data tier is that the local
///    slope is within the read precision budget (~0.2–0.5% slope, doc §4).
///    Consumers gate/soften reads on it; they must never sharpen it.

/// Planar point/vector, {x east, y north} meters — mirror of
/// `shared/strategy/ellipse.ts` `Vec2`.
public struct Vec2: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// Unit vector pointing along a compass bearing (0° = +y/north, 90° =
/// +x/east): (sin b, cos b). Mirror of `ellipse.ts` `bearingToUnitVector`.
public func bearingToUnitVector(_ bearingDeg: Double) -> Vec2 {
    let rad = bearingDeg * Double.pi / 180
    return Vec2(x: sin(rad), y: cos(rad))
}

public struct SurfaceSample: Equatable, Sendable {
    /// Surface height at the sampled point, meters.
    public var height: Double
    /// dh/dx (east), rise/run fraction.
    public var gradX: Double
    /// dh/dy (north), rise/run fraction.
    public var gradY: Double
    /// 0..1 confidence in the local slope (see header).
    public var confidence: Double

    public init(height: Double, gradX: Double, gradY: Double, confidence: Double) {
        self.height = height
        self.gradX = gradX
        self.gradY = gradY
        self.confidence = confidence
    }
}

public protocol GreenSurface: Sendable {
    /// Sample the surface at a projected point. Returns nil outside the
    /// data's coverage (off the scanned corridor / grid / green) — callers
    /// must treat nil as "no read here", not as flat.
    func sampleAt(_ p: Vec2) -> SurfaceSample?
}

/// Tier-3 adapter: an infinite tilted plane from a human slope estimate
/// ("2% down-slope toward 240°"). Also the analytic ground truth for
/// golden-putt tests — every first-order formula in doc §3 is exact on it.
/// Mirror of `green-surface.ts` `planeSurface`.
///
/// `fallLineBearingDeg` is the DOWNHILL direction (where a ball released at
/// rest would roll), compass degrees.
public struct PlaneSurface: GreenSurface {
    private let gradX: Double
    private let gradY: Double
    private let h0: Double
    private let confidence: Double

    /// - Parameters:
    ///   - slopePct: slope magnitude, percent (rise/run × 100).
    ///   - fallLineBearingDeg: DOWNHILL compass bearing.
    ///   - originHeight: height at the origin, meters. Default 0.
    ///   - confidence: default 1 (tests). Real manual estimates should pass
    ///     their own.
    public init(
        slopePct: Double,
        fallLineBearingDeg: Double,
        originHeight: Double = 0,
        confidence: Double = 1
    ) {
        let fraction = slopePct / 100
        let downhill = bearingToUnitVector(fallLineBearingDeg)
        // ∇h points uphill: opposite the downhill unit vector, scaled by slope.
        self.gradX = -downhill.x * fraction
        self.gradY = -downhill.y * fraction
        self.h0 = originHeight
        self.confidence = confidence
    }

    public func sampleAt(_ p: Vec2) -> SurfaceSample? {
        SurfaceSample(
            height: h0 + gradX * p.x + gradY * p.y,
            gradX: gradX,
            gradY: gradY,
            confidence: confidence
        )
    }
}
