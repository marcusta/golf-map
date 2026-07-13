import Foundation

/// Expected strokes to hole out ("shots to hole out") — faithful Swift port of
/// `shared/strategy/expected-strokes.ts`. The two MUST stay numerically
/// identical: ported tests + TS-generated golden fixtures
/// (`strategy-goldens.json`) pin the parity.
///
/// Pure lookup + linear interpolation over the published Broadie PGA-Tour
/// baseline (Mark Broadie, *Every Shot Counts*), converted to meters. Anchor
/// tables are written in SOURCE units (yards for full shots, feet for putting)
/// and converted once at init — do NOT hand-copy converted numbers.
///
/// Table quirks are real and preserved (decision D18). Boundary rules
/// (decision D20): d < 0.05 m → 0 (holed); below the first anchor → clamp to
/// the first anchor; above the last → linear extrapolation. Penalty (decision
/// D4): penalty = 1 + rough at the same distance.

private let YD = 0.9144 // meters per yard
private let FT = 0.3048 // meters per foot

/// [distance, expectedStrokes] anchor, distance in SOURCE units.
private typealias Anchor = (d: Double, s: Double)

// --- Broadie PGA-Tour baseline, source units -------------------------------

// Off the tee (yards). Includes the real 120→140 dip (short par-3s).
private let TEE_YD: [Anchor] = [
    (100, 2.92), (120, 2.99), (140, 2.97), (160, 2.99), (180, 3.05),
    (200, 3.12), (220, 3.17), (240, 3.25), (260, 3.45), (280, 3.65),
    (300, 3.71), (320, 3.79), (340, 3.86), (360, 3.92), (380, 3.96),
    (400, 3.99), (420, 4.02), (440, 4.08), (460, 4.17), (480, 4.28),
    (500, 4.41), (520, 4.54), (540, 4.65), (560, 4.74), (580, 4.79),
    (600, 4.82),
]

// Fairway (yards).
private let FAIRWAY_YD: [Anchor] = [
    (20, 2.40), (40, 2.60), (60, 2.70), (80, 2.75), (100, 2.80),
    (120, 2.85), (140, 2.91), (160, 2.98), (180, 3.08), (200, 3.19),
    (220, 3.32), (240, 3.45), (260, 3.58), (280, 3.69), (300, 3.78),
    (320, 3.84), (340, 3.88), (360, 3.95), (380, 4.03), (400, 4.11),
    (420, 4.19), (440, 4.27), (460, 4.34), (480, 4.42), (500, 4.50),
    (520, 4.58), (540, 4.66), (560, 4.74), (580, 4.82), (600, 4.89),
]

// Rough (yards).
private let ROUGH_YD: [Anchor] = [
    (20, 2.59), (40, 2.78), (60, 2.91), (80, 2.96), (100, 3.02),
    (120, 3.08), (140, 3.15), (160, 3.23), (180, 3.31), (200, 3.42),
    (220, 3.53), (240, 3.64), (260, 3.74), (280, 3.83), (300, 3.90),
    (320, 3.95), (340, 4.02), (360, 4.11), (380, 4.21), (400, 4.30),
    (420, 4.40), (440, 4.49), (460, 4.58), (480, 4.68), (500, 4.77),
    (520, 4.87), (540, 4.96), (560, 5.06), (580, 5.15), (600, 5.25),
]

// Sand (yards). Greenside sand (20 yd) is EASIER than greenside rough;
// the 60–140 yd hump is the awkward-distance zone. Both are real.
private let SAND_YD: [Anchor] = [
    (20, 2.53), (40, 2.82), (60, 3.15), (80, 3.24), (100, 3.23),
    (120, 3.21), (140, 3.22), (160, 3.28), (180, 3.40), (200, 3.55),
    (220, 3.70), (240, 3.84), (260, 3.93), (280, 4.00), (300, 4.04),
    (320, 4.12), (340, 4.26), (360, 4.41), (380, 4.55), (400, 4.69),
    (420, 4.83), (440, 4.97), (460, 5.11), (480, 5.25), (500, 5.40),
    (520, 5.54), (540, 5.68), (560, 5.82), (580, 5.96), (600, 6.10),
]

// Recovery (yards) — trees / forced punch-out. Flat-ish below 140 yd.
private let RECOVERY_YD: [Anchor] = [
    (100, 3.80), (120, 3.78), (140, 3.80), (160, 3.81), (180, 3.82),
    (200, 3.87), (220, 3.92), (240, 3.97), (260, 4.03), (280, 4.10),
    (300, 4.20), (320, 4.31), (340, 4.44), (360, 4.56), (380, 4.66),
    (400, 4.75), (420, 4.84), (440, 4.94), (460, 5.03), (480, 5.13),
    (500, 5.22), (520, 5.32), (540, 5.41), (560, 5.51), (580, 5.60),
    (600, 5.70),
]

// Putting (FEET). The 1 ft anchor is synthetic (decision D20).
private let GREEN_FT: [Anchor] = [
    (1, 1.00), (3, 1.05), (4, 1.14), (5, 1.24), (6, 1.34), (7, 1.43),
    (8, 1.50), (9, 1.56), (10, 1.61), (15, 1.78), (20, 1.87), (30, 1.98),
    (40, 2.06), (50, 2.14), (60, 2.21), (90, 2.36),
]

// --- Converted-to-meters anchors -------------------------------------------

private func toMeters(_ anchors: [Anchor], _ unit: Double) -> [Anchor] {
    anchors.map { (d: $0.d * unit, s: $0.s) }
}

/// Baseline anchors in METERS per lie row. `penalty` has no row — it is
/// derived (1 + rough, decision D4). Mirror of `expected-strokes.ts`
/// `EXPECTED_STROKES_ANCHORS_M`.
private let EXPECTED_STROKES_ANCHORS_M: [Lie: [Anchor]] = [
    .tee: toMeters(TEE_YD, YD),
    .fairway: toMeters(FAIRWAY_YD, YD),
    .rough: toMeters(ROUGH_YD, YD),
    .sand: toMeters(SAND_YD, YD),
    .recovery: toMeters(RECOVERY_YD, YD),
    .green: toMeters(GREEN_FT, FT),
]

/// Distance below which the ball counts as holed (decision D20), meters.
public let HOLED_DISTANCE_M: Double = 0.05

/// Expected strokes to hole out from `distanceM` on `lie` (Broadie PGA-Tour
/// baseline). Mirror of `expected-strokes.ts` `shotsToHoleOut`.
public func shotsToHoleOut(_ distanceM: Double, _ lie: Lie) -> Double {
    if distanceM < HOLED_DISTANCE_M { return 0 }
    if lie == .penalty { return 1 + shotsToHoleOut(distanceM, .rough) }

    let anchors = EXPECTED_STROKES_ANCHORS_M[lie]!
    let first = anchors[0]
    if distanceM <= first.d { return first.s }

    for i in 1..<anchors.count {
        let (d1, s1) = anchors[i]
        if distanceM <= d1 {
            let (d0, s0) = anchors[i - 1]
            return s0 + ((distanceM - d0) / (d1 - d0)) * (s1 - s0)
        }
    }

    // Beyond the last anchor: extrapolate along the final segment.
    let (dA, sA) = anchors[anchors.count - 2]
    let (dB, sB) = anchors[anchors.count - 1]
    return sB + ((distanceM - dB) / (dB - dA)) * (sB - sA)
}

/// Strokes gained by ONE shot that moved the ball from (fromM, fromLie) to
/// (toM, toLie). Mirror of `expected-strokes.ts` `strokesGained`.
public func strokesGained(_ fromM: Double, _ fromLie: Lie, _ toM: Double, _ toLie: Lie) -> Double {
    shotsToHoleOut(fromM, fromLie) - shotsToHoleOut(toM, toLie) - 1
}
