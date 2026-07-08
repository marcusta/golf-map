import Foundation

/// Tier-1 green-surface adapter (task E1): the accepted corridor-scan poly2
/// fit as a `GreenSurface`, anchored to the user-placed ball/hole markers in
/// EPSG:3006. This is what `PuttReadModel.installScannedSurface` receives —
/// downstream (integrator, Tour Read cross-check, gating, overlay) is
/// tier-agnostic.
///
/// **Frame anchoring.** The scan frame's +x is the horizontal ball→hole
/// direction *at scan time*; this adapter rebuilds the same frame from the
/// user-placed markers: x̂ = (holeWorld − ballWorld)/|…|, ŷ = left of the
/// line = (−x̂.y, x̂.x) (both frames are right-handed, z-up, so they agree by
/// construction). ASSUMPTION made explicit: the markers are placed where the
/// scan's physical ball and hole were. If the user places them elsewhere the
/// patch translates/rotates with the markers — the fit is then evaluated at
/// the wrong physical spot, and samples increasingly fall outside the scanned
/// bounds (→ nil → the read degrades/withholds rather than lying, per the
/// GreenSurface nil contract). There is no scaling: a marker distance
/// different from the scanned line length leaves the surface anchored at the
/// ball and pointed at the hole, with the hole-end sampling wherever
/// |hole − ball| lands inside (or outside) the patch.
///
/// **Coverage.** `sampleAt` returns nil outside the scanned corridor bounds
/// (the actual x/y extent of the retained points, NOT the nominal corridor
/// rectangle). The doc's "prompt to widen" case surfaces through the read's
/// `degraded` availability when the simulated ball path exits the patch.
///
/// **Confidence** maps from the scan QC verdict (`confidence(for:)`): green
/// → 0.9 (comfortably above `PuttReadModel.minReadConfidence`, full-strength
/// read), yellow → 0.6 (shown but SOFTENED downstream). Red never becomes a
/// surface — the capture UI refuses the read outright (doc §4.1).
///
/// Heights are in the scan's local datum (z = 0 at the green surface by the
/// ball) — fine per the `GreenSurface` contract, which only consumes height
/// differences and gradients. A `ScannedSurface` must therefore never be
/// mixed into the same integration as a DEM surface; `PuttReadModel` swaps
/// whole surfaces, never blends.
public struct ScannedSurface: GreenSurface, Equatable {

    /// Confidence for a green-verdict scan (doc §4 Tier-1 quality: fresh,
    /// dense, ~0.1–0.2% slope — well inside the read precision budget).
    public static let greenConfidence = 0.9
    /// Confidence for a yellow-verdict scan — deliberately BELOW the DEM
    /// default is wrong here; 0.6 sits above `minReadConfidence` (0.5) so the
    /// read shows, but low enough that consumers keep softening headroom.
    public static let yellowConfidence = 0.6

    /// Verdict → per-sample confidence. Red returns nil: a red scan must
    /// never become a read surface.
    public static func confidence(for verdict: GreenScanVerdict) -> Double? {
        switch verdict {
        case .green: return greenConfidence
        case .yellow: return yellowConfidence
        case .red: return nil
        }
    }

    // Poly2 coefficients (contract order).
    private let c00: Double, c10: Double, c01: Double
    private let c20: Double, c11: Double, c02: Double
    // Scanned-patch bounds, scan frame meters.
    private let xMin: Double, xMax: Double, yMin: Double, yMax: Double
    // Ball marker (EPSG:3006) and the unit line direction x̂ = (ax, ay).
    private let originX: Double, originY: Double
    private let ax: Double, ay: Double
    private let sampleConfidence: Double

    /// - Parameters:
    ///   - coefficients: [c00, c10, c01, c20, c11, c02] of the combined fit.
    ///   - xMin/xMax/yMin/yMax: retained-point bounds, scan frame.
    ///   - ballWorld/holeWorld: the user-placed markers, EPSG:3006 meters.
    ///   - confidence: from `confidence(for:)`.
    /// Fails (nil) on a malformed coefficient array, coincident markers, or
    /// an empty bounds rectangle.
    public init?(
        coefficients: [Double],
        xMin: Double, xMax: Double, yMin: Double, yMax: Double,
        ballWorld: Vec2, holeWorld: Vec2,
        confidence: Double
    ) {
        guard coefficients.count == 6 else { return nil }
        let dx = holeWorld.x - ballWorld.x
        let dy = holeWorld.y - ballWorld.y
        let length = (dx * dx + dy * dy).squareRoot()
        guard length > 1e-9, xMax > xMin, yMax > yMin else { return nil }
        c00 = coefficients[0]
        c10 = coefficients[1]
        c01 = coefficients[2]
        c20 = coefficients[3]
        c11 = coefficients[4]
        c02 = coefficients[5]
        self.xMin = xMin
        self.xMax = xMax
        self.yMin = yMin
        self.yMax = yMax
        originX = ballWorld.x
        originY = ballWorld.y
        ax = dx / length
        ay = dy / length
        sampleConfidence = confidence
    }

    public func sampleAt(_ p: Vec2) -> SurfaceSample? {
        let dx = p.x - originX
        let dy = p.y - originY
        // World → scan frame: x̂ = (ax, ay), ŷ = left = (−ay, ax).
        let lx = dx * ax + dy * ay
        let ly = -dx * ay + dy * ax
        guard lx >= xMin, lx <= xMax, ly >= yMin, ly <= yMax else { return nil }

        let height = c00 + c10 * lx + c01 * ly + c20 * lx * lx + c11 * lx * ly + c02 * ly * ly
        // Local gradient, rotated back to world (x̂/ŷ are orthonormal):
        // ∇world = gx·x̂ + gy·ŷ.
        let gx = c10 + 2 * c20 * lx + c11 * ly
        let gy = c01 + c11 * lx + 2 * c02 * ly
        return SurfaceSample(
            height: height,
            gradX: gx * ax - gy * ay,
            gradY: gx * ay + gy * ax,
            confidence: sampleConfidence
        )
    }
}
