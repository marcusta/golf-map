import Foundation

/// Per-green calibration the iOS putt read consumes — the read side of the
/// green-scan round-trip (docs/feature-putting-green-reading.md §4.2). Synced
/// from the server's `GET /green-calibration/confidence` and cached in GRDB so
/// offline rounds benefit. Two knobs, both derived from accepted phone scans:
///
///  - `confidence`: the agreement statistic. It REPLACES the conservative
///    terrain-tile default (`TERRAIN_TILE_DEM_CONFIDENCE` 0.45) so a
///    well-calibrated green can cross `MIN_READ_CONFIDENCE` (0.5) and stop
///    being softened. Ordinal — display/softening only, never sharpens the
///    geometry.
///  - `bias`: the low-frequency DEM tilt correction applied to the sampled
///    surface (below).
public struct GreenBias: Equatable, Sendable {
    /// dh/de correction, rise/run fraction (EPSG:3006 east).
    public var tiltE: Double
    /// dh/dn correction, rise/run fraction (EPSG:3006 north).
    public var tiltN: Double

    public init(tiltE: Double, tiltN: Double) {
        self.tiltE = tiltE
        self.tiltN = tiltN
    }
}

public struct GreenCalibration: Equatable, Sendable {
    /// Server green ROW id (matches `GreenRecord.id`).
    public var greenId: String
    /// Agreement confidence (0..1) — replaces the terrain-tile default.
    public var confidence: Double
    /// Weighted accepted-scan count (green 1.0, yellow 0.5).
    public var sampleCount: Double
    /// Fitted DEM tilt correction, or nil when the server fitted no bias.
    public var bias: GreenBias?

    public init(greenId: String, confidence: Double, sampleCount: Double, bias: GreenBias?) {
        self.greenId = greenId
        self.confidence = confidence
        self.sampleCount = sampleCount
        self.bias = bias
    }
}

/// Tier-2 surface decorator that applies a green's low-frequency calibration
/// bias to a base DEM surface (doc §4.2, contract green-scan-payload.md
/// `bias_json`): corrected ∇h = DEM ∇h + (tiltE, tiltN). Because slope is the
/// only thing the read uses (heights only ever enter as a ball→hole
/// difference), the bias is a rigid plane tilt: the gradient gains the tilt
/// and the height gains the matching linear ramp about a fixed origin, so the
/// height field stays the exact integral of the tilted gradient. The origin
/// choice cancels in every difference the read takes — anchoring at the grid
/// corner just keeps the ramp term small.
///
/// Confidence is NOT touched here — it is emitted by the base `DemSurface`,
/// which is built with the calibration confidence directly (see
/// `PuttReadModel.rebuildDemSurface`). A calibrated green with no fitted bias
/// therefore uses the bare `DemSurface` at the lifted confidence, no decorator.
public struct CalibratedSurface: GreenSurface {
    private let base: any GreenSurface
    private let tiltE: Double
    private let tiltN: Double
    private let originE: Double
    private let originN: Double

    public init(base: any GreenSurface, bias: GreenBias, origin: Vec2) {
        self.base = base
        self.tiltE = bias.tiltE
        self.tiltN = bias.tiltN
        self.originE = origin.x
        self.originN = origin.y
    }

    public func sampleAt(_ p: Vec2) -> SurfaceSample? {
        guard let s = base.sampleAt(p) else { return nil }
        return SurfaceSample(
            height: s.height + tiltE * (p.x - originE) + tiltN * (p.y - originN),
            gradX: s.gradX + tiltE,
            gradY: s.gradY + tiltN,
            confidence: s.confidence
        )
    }
}
