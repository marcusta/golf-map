import Foundation

/// A pin position expressed in the green-local frame (docs/
/// feature-laser-pin-and-calibration.md §3): depth in metres from the green's
/// front edge along the line of play, lateral as a fraction of the green's
/// width at that depth (0 = left edge, 1 = right edge, from the player's view).
struct PinSpec: Equatable, Sendable {
    enum Source: String, Sendable {
        case sheet, laser, visual
    }

    var depthFromFrontM: Double
    var lateralFraction: Double
    var source: Source
}

/// Discrete position-word → fraction constants (spec §3.1). ALL word-derived
/// fractions come from here — the voice parser and any UI presets both map
/// through these so tuning happens in exactly one place.
enum PinWordFractions {
    /// "front" / "left"
    static let near = 0.15
    /// "middle" / "center"
    static let middle = 0.5
    /// "back" / "right"
    static let far = 0.85
    /// "close to front" / "far left" — modifier pushes toward the edge.
    static let nearEdge = 0.05
    /// "close to back" / "far right"
    static let farEdge = 0.95
}

/// One parsed voice utterance (best-effort, deterministic grammar — see
/// PinPhraseParser). The parser returns *candidates*; the confirm UI resolves
/// ambiguity. Fractions here already went through `PinWordFractions`.
enum PinPhrase: Equatable, Sendable {
    /// "pin 4 from front, 5 from left" — both axes in metres.
    case sheet(depthFromFrontM: Double, lateralFromLeftM: Double)
    /// "one forty three, right" — laser distance + optional side word
    /// (nil = no side spoken; treat as middle in the confirm UI).
    case laser(distanceM: Double, lateralFraction: Double?)
    /// "close to back, far left" — both axes as discrete-word fractions.
    case visual(depthFraction: Double, lateralFraction: Double)
    /// "6 from front, middle right" — exact depth, word lateral.
    case hybrid(depthFromFrontM: Double, lateralFraction: Double)
}

/// Turns a parsed phrase into a `PinSpec` against a concrete green frame.
/// Pure function — the model supplies the frame and (for laser mode) the
/// planar origin the distance was measured from.
enum PinPlacementSolver {
    /// Result of resolving a phrase; `clamped` surfaces the laser-mismatch
    /// case (spec §3.2) so the confirm UI can warn ("laser says 143 but green
    /// spans 138–151 — check origin?").
    struct Resolution: Equatable, Sendable {
        var spec: PinSpec
        var clamped: Bool
    }

    /// `originPlanar` is required only for `.laser`; a laser phrase with no
    /// origin returns nil (cannot solve depth without knowing where the
    /// distance was measured from).
    static func resolve(
        phrase: PinPhrase,
        frame: GreenFrame,
        originPlanar: Vec2?
    ) -> Resolution? {
        switch phrase {
        case let .sheet(depth, lateralM):
            // Lateral metres-from-left → fraction of the cross-section width
            // at that depth. A sheet's lateral beyond the width clamps to the
            // edge (sheets measure to the collar; our polygon is the surface).
            let clampedDepth = min(max(depth, 0), frame.depthM)
            let width = frame.width(atDepth: clampedDepth)
            let fraction = width > 0 ? min(max(lateralM / width, 0), 1) : PinWordFractions.middle
            return Resolution(
                spec: PinSpec(
                    depthFromFrontM: clampedDepth,
                    lateralFraction: fraction,
                    source: .sheet
                ),
                clamped: clampedDepth != depth || (width > 0 && (lateralM < 0 || lateralM > width))
            )

        case let .laser(distanceM, lateralFraction):
            guard let originPlanar else { return nil }
            let fraction = lateralFraction ?? PinWordFractions.middle
            let solved = frame.laserDepth(
                originPlanar: originPlanar,
                distanceM: distanceM,
                lateralFraction: fraction
            )
            return Resolution(
                spec: PinSpec(
                    depthFromFrontM: solved.depthM,
                    lateralFraction: fraction,
                    source: .laser
                ),
                clamped: solved.clamped
            )

        case let .visual(depthFraction, lateralFraction):
            return Resolution(
                spec: PinSpec(
                    depthFromFrontM: min(max(depthFraction, 0), 1) * frame.depthM,
                    lateralFraction: min(max(lateralFraction, 0), 1),
                    source: .visual
                ),
                clamped: false
            )

        case let .hybrid(depth, lateralFraction):
            let clampedDepth = min(max(depth, 0), frame.depthM)
            return Resolution(
                spec: PinSpec(
                    depthFromFrontM: clampedDepth,
                    lateralFraction: min(max(lateralFraction, 0), 1),
                    source: .sheet
                ),
                clamped: clampedDepth != depth
            )
        }
    }

    /// The placed pin in WGS84 — what becomes the hole's `activePin` override.
    static func pinWGS84(spec: PinSpec, frame: GreenFrame) -> LatLon {
        let p = frame.point(depthM: spec.depthFromFrontM, lateralFraction: spec.lateralFraction)
        return Sweref99TM.toWGS84(x: p.x, y: p.y)
    }
}
