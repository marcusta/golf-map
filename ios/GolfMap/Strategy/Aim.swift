import Foundation

/// Aim optimiser — faithful Swift port of `shared/strategy/aim.ts`. The two
/// MUST stay numerically identical: ported tests + TS-generated golden
/// fixtures (`strategy-goldens.json`) pin the parity.
///
/// Pure planar math in projected meters (EPSG:3006-style {x, y}); bearings
/// compass degrees (0 = north, clockwise); wind per Wind.swift (m/s, FROM).
/// The caller pre-flattens all classified surface rings and passes them in
/// TOPMOST-FIRST — array order IS priority order: the FIRST containing ring
/// wins (decision D23).
///
/// Model decisions (see docs/decisions-strategy-*.md): D13 σ semantics
/// (semi-axes = sigmaScale·σ, default 2), D14 deterministic sampling
/// (Halton(2,3) → Box–Muller), D15 sweep default clamped 4°–15° + straightest
/// tie-break, D16 risk (mean + riskAversion·(CVaR₈₀ − mean)).

/// Options for `optimizeAim`. Mirror of `aim.ts` `AimOptions`.
public struct AimOptions<C: ClubSpec> {
    /// Shot origin, planar meters.
    public var origin: Vec2
    public var club: C
    /// Bearing of the naive target line (e.g. straight at the pin).
    public var targetBearingDeg: Double
    /// ALL classified surface rings, pre-flattened and TOPMOST-FIRST (D23).
    public var surfaces: [FlatRing]
    /// Remaining distance for each outcome is measured to this point.
    public var greenCenter: Vec2
    /// Wind speed in m/s. Omit both wind fields for a no-wind shot.
    public var windSpeedMps: Double?
    /// Direction the wind comes FROM, compass degrees.
    public var windDirectionDeg: Double?
    /// Ground slope along the shot line (see Ellipse.swift groundSlope).
    public var groundSlope: Double?
    /// Half-sweep around the target bearing, degrees. Default per D15.
    public var sweepDeg: Double?
    /// Number of candidate bearings across the sweep. Default 13.
    public var candidates: Int?
    /// Dispersion samples per candidate. Default 128.
    public var samples: Int?
    /// How many σ the ellipse SEMI-axes represent. Default 2 (D13).
    public var sigmaScale: Double?
    /// 0..1 weight on the tail term (D16). Default 0 = pure expected value.
    public var riskAversion: Double?
    /// Lie for sample points contained by no surface ring. Default .rough.
    public var fallbackLie: Lie?

    public init(
        origin: Vec2,
        club: C,
        targetBearingDeg: Double,
        surfaces: [FlatRing],
        greenCenter: Vec2,
        windSpeedMps: Double? = nil,
        windDirectionDeg: Double? = nil,
        groundSlope: Double? = nil,
        sweepDeg: Double? = nil,
        candidates: Int? = nil,
        samples: Int? = nil,
        sigmaScale: Double? = nil,
        riskAversion: Double? = nil,
        fallbackLie: Lie? = nil
    ) {
        self.origin = origin
        self.club = club
        self.targetBearingDeg = targetBearingDeg
        self.surfaces = surfaces
        self.greenCenter = greenCenter
        self.windSpeedMps = windSpeedMps
        self.windDirectionDeg = windDirectionDeg
        self.groundSlope = groundSlope
        self.sweepDeg = sweepDeg
        self.candidates = candidates
        self.samples = samples
        self.sigmaScale = sigmaScale
        self.riskAversion = riskAversion
        self.fallbackLie = fallbackLie
    }
}

/// One candidate aim's priced outcome. Mirror of `aim.ts` `AimCandidate`.
public struct AimCandidate: Equatable, Sendable {
    public var bearingDeg: Double
    /// Mean strokes-to-hole-out over the dispersion samples.
    public var expectedStrokes: Double
    /// CVaR₈₀ — mean of the worst 20% of samples (D16). ≥ expectedStrokes.
    public var tailStrokes: Double
    /// expectedStrokes + riskAversion · (tailStrokes − expectedStrokes).
    public var score: Double
    /// Fraction of samples per lie (sums to 1).
    public var breakdown: [Lie: Double]
}

/// Result of `optimizeAim`. Mirror of `aim.ts` `AimResult`.
public struct AimResult: Equatable, Sendable {
    /// Bearing of the winning candidate (lowest score, ties → straightest).
    public var bestBearingDeg: Double
    public var best: AimCandidate
    /// Every candidate, ordered left-to-right across the sweep.
    public var perCandidate: [AimCandidate]
    /// The winning candidate's lie breakdown (convenience alias).
    public var breakdown: [Lie: Double]
}

/// Default half-sweep per D15: ~1.5 lateral semi-axes, clamped 4°–15°. Mirror
/// of `aim.ts` `defaultSweepDeg`.
public func defaultSweepDeg<C: ClubSpec>(_ club: C) -> Double {
    let deg = atan2(0.75 * club.dispersionM, club.carryM) * 180 / Double.pi
    return min(15, max(4, deg))
}

/// Sweep candidate aims and pick the one whose dispersion pattern prices
/// lowest against the expected-strokes baseline. Deterministic (D14). Mirror
/// of `aim.ts` `optimizeAim`.
public func optimizeAim<C: ClubSpec>(_ options: AimOptions<C>) -> AimResult {
    let origin = options.origin
    let club = options.club
    let targetBearingDeg = options.targetBearingDeg
    let greenCenter = options.greenCenter

    let candidateCount = max(1, options.candidates ?? 13)
    let sampleCount = max(1, options.samples ?? 128)
    let sigmaScale = options.sigmaScale ?? 2
    let riskAversion = options.riskAversion ?? 0
    let fallbackLie = options.fallbackLie ?? .rough
    let sweepDeg = options.sweepDeg ?? defaultSweepDeg(club)

    // Caller passes `surfaces` topmost-first (D23): keep that order, the first
    // containing ring wins. NO area re-sort.
    let classified = options.surfaces
        .filter { $0.points.count >= 3 }
        .map { classifiable($0) }

    let normals = standardNormalPairs(sampleCount)
    let tailCount = max(1, Int((Double(sampleCount) * 0.2).rounded(.up)))

    var perCandidate: [AimCandidate] = []
    perCandidate.reserveCapacity(candidateCount)
    var best: AimCandidate?
    var bestOffset = Double.infinity

    for c in 0..<candidateCount {
        let offsetDeg = candidateCount == 1
            ? 0
            : -sweepDeg + (2 * sweepDeg * Double(c)) / Double(candidateCount - 1)
        let bearingDeg = targetBearingDeg + offsetDeg

        let ellipse = dispersionEllipse(DispersionEllipseOptions(
            origin: origin,
            bearingDeg: bearingDeg,
            club: club,
            windSpeedMps: options.windSpeedMps,
            windDirectionDeg: options.windDirectionDeg,
            groundSlope: options.groundSlope,
            samples: 4 // polygon unused here; keep its construction trivial
        ))
        let along = bearingToUnitVector(bearingDeg)
        let right = Vec2(x: along.y, y: -along.x)
        let sigmaLengthM = ellipse.semiLengthM / sigmaScale
        let sigmaLateralM = ellipse.semiLateralM / sigmaScale

        var strokes = [Double](repeating: 0, count: sampleCount)
        var lieCounts: [Lie: Int] = [:]
        var sum = 0.0

        for s in 0..<sampleCount {
            let (zAlong, zAcross) = normals[s]
            let u = zAlong * sigmaLengthM
            let v = zAcross * sigmaLateralM
            let pt = Vec2(
                x: ellipse.center.x + u * along.x + v * right.x,
                y: ellipse.center.y + u * along.y + v * right.y
            )
            let lie = classifyLie(pt, classified, fallbackLie)
            let remainingM = hypot(greenCenter.x - pt.x, greenCenter.y - pt.y)
            let value = shotsToHoleOut(remainingM, lie)
            strokes[s] = value
            sum += value
            lieCounts[lie, default: 0] += 1
        }

        let expectedStrokes = sum / Double(sampleCount)
        strokes.sort(by: >)
        var tailSum = 0.0
        for i in 0..<tailCount { tailSum += strokes[i] }
        let tailStrokes = tailSum / Double(tailCount)
        let score = expectedStrokes + riskAversion * (tailStrokes - expectedStrokes)

        var breakdown: [Lie: Double] = [:]
        for (key, count) in lieCounts {
            breakdown[key] = Double(count) / Double(sampleCount)
        }

        let candidate = AimCandidate(
            bearingDeg: bearingDeg,
            expectedStrokes: expectedStrokes,
            tailStrokes: tailStrokes,
            score: score,
            breakdown: breakdown
        )
        perCandidate.append(candidate)

        // Ties prefer the straighter aim (D15).
        let offsetAbs = abs(offsetDeg)
        if best == nil || candidate.score < best!.score - 1e-12 ||
            (abs(candidate.score - best!.score) <= 1e-12 && offsetAbs < bestOffset) {
            best = candidate
            bestOffset = offsetAbs
        }
    }

    return AimResult(
        bestBearingDeg: best!.bearingDeg,
        best: best!,
        perCandidate: perCandidate,
        breakdown: best!.breakdown
    )
}

// ---------------------------------------------------------------------------
// Lie classification (D23): bbox pre-reject, then FIRST containing ring.
// ---------------------------------------------------------------------------

private struct ClassifiedRing {
    let ring: FlatRing
    let lie: Lie
    let minX: Double
    let maxX: Double
    let minY: Double
    let maxY: Double
}

private func classifiable(_ ring: FlatRing) -> ClassifiedRing {
    var minX = Double.infinity, maxX = -Double.infinity
    var minY = Double.infinity, maxY = -Double.infinity
    for p in ring.points {
        if p.x < minX { minX = p.x }
        if p.x > maxX { maxX = p.x }
        if p.y < minY { minY = p.y }
        if p.y > maxY { maxY = p.y }
    }
    return ClassifiedRing(
        ring: ring,
        lie: lieFromFeatureType(ring.kind),
        minX: minX, maxX: maxX, minY: minY, maxY: maxY
    )
}

private func classifyLie(_ p: Vec2, _ rings: [ClassifiedRing], _ fallback: Lie) -> Lie {
    for r in rings {
        if p.x < r.minX || p.x > r.maxX || p.y < r.minY || p.y > r.maxY { continue }
        if pointInRing(p, r.ring.points) { return r.lie }
    }
    return fallback
}

// ---------------------------------------------------------------------------
// Deterministic standard-normal pairs (D14): Halton(2,3) → Box–Muller.
// ---------------------------------------------------------------------------

private func halton(_ index: Int, _ base: Int) -> Double {
    var f = 1.0
    var r = 0.0
    var i = index
    while i > 0 {
        f /= Double(base)
        r += f * Double(i % base)
        i /= base
    }
    return r
}

/// `count` deterministic standard-normal (z1, z2) pairs. Halton indices start
/// at 1 so u1 is never 0 (log-safe). Mirror of `aim.ts` `standardNormalPairs`.
public func standardNormalPairs(_ count: Int) -> [(Double, Double)] {
    var out: [(Double, Double)] = []
    out.reserveCapacity(count)
    for i in 0..<count {
        let u1 = halton(i + 1, 2)
        let u2 = halton(i + 1, 3)
        let r = (-2 * log(u1)).squareRoot()
        out.append((r * cos(2 * Double.pi * u2), r * sin(2 * Double.pi * u2)))
    }
    return out
}
