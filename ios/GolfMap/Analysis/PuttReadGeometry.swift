import Foundation

/// Pure putt-read helpers shared by the on-course read view-model and the map
/// overlay renderer — no SwiftUI / MapLibre imports so it is headless-testable
/// (GolfMapTests conventions). Two jobs:
///
///  1. Derive the closed-form Tour Read's inputs from the SAME GreenSurface the
///     integrator reads (doc §5.1 — the verbal read is a sanity cross-check, so
///     it must see the same ground truth, not an independent estimate). Faithful
///     port of `web/src/planner/putt-read.service.ts` `deriveTourReadGroundTruth`
///     / `deriveTourRead`.
///  2. Project a PuttRead (ball, hole, path, aim point) from EPSG:3006 meters
///     into WGS84 strokes the map layer renders, plus the straight ball→hole
///     reference line.
///
/// ── Tier honesty (doc §4, §4.2) ─────────────────────────────────────────────
/// The iOS Tier-2 surface is the offline Terrain-RGB tile pyramid, quantized to
/// 0.1 m and Gaussian-blurred (AnalysisGrid.swift) — materially worse than the
/// web's server-sampled full-precision LiDAR DEM that `DEM_DEFAULT_CONFIDENCE`
/// (0.6) was tuned for. So the iOS read passes a deliberately LOWER confidence,
/// `TERRAIN_TILE_DEM_CONFIDENCE`, into DemSurface. Consumers gate/soften on it
/// exactly like the web (PuttRead.minConfidence vs MIN_READ_CONFIDENCE) — never
/// a confident read from weak data.
///
/// FOLLOW-UP (not built here): the server exposes a per-green calibration
/// confidence + bias correction (`GET /green-calibration/confidence`, doc §4.2).
/// The web read already consumes it (`PuttReadService.surfaceConfidence`). The
/// iOS read should sync it and, when known for the active green, pass THAT
/// (ordinal — display/soften only, never sharpen) instead of the flat terrain
/// default, and apply the bias correction to the sampled heights. Deferred: it
/// needs the on-device calibration store + a sync path that don't exist yet.
public enum PuttReadGeometry {

    /// Conservative per-sample confidence for the iOS Terrain-RGB tile DEM.
    /// Below the web `MIN_READ_CONFIDENCE` (0.5, mirrored in PuttReadModel) so
    /// an uncalibrated terrain-tile read is SOFTENED by default, never shown as
    /// confident — the tiles' 0.1 m quantization + blur can flip a subtle read
    /// (doc §4 precision budget: 0.2–0.5% slope). Named + documented per D4; the
    /// real per-green calibration confidence replaces it later (see header).
    public static let TERRAIN_TILE_DEM_CONFIDENCE = 0.45

    /// Interior sample count along the ball→hole line for the closed-form
    /// cross-slope %. Mirrors `TOUR_READ_CROSS_SAMPLES` (web).
    public static let tourReadCrossSamples = 9

    /// The raw surface-derived inputs behind the closed-form Tour Read: putt
    /// length, signed grade Δh, cross-slope %, and break side. Faithful port of
    /// `deriveTourReadGroundTruth`. Returns nil when ball/hole are off coverage
    /// (no honest inputs exist); off-coverage MID-LINE samples are skipped, so
    /// the closed form degrades to the samples it has (a human paces past a
    /// fringe corner). Pure — the same numbers the web derives.
    public struct TourReadInputs: Equatable, Sendable {
        public var distanceM: Double
        /// Signed elevation change along the line, meters (+ = uphill).
        public var gradeDeltaM: Double
        /// Cross-slope magnitude along the line, % (unsigned).
        public var slopePct: Double
        /// True if the ball breaks left→right (downhill falls to the right).
        public var breakToRight: Bool
    }

    public static func deriveTourReadInputs(
        surface: some GreenSurface,
        ball: Vec2,
        hole: Vec2
    ) -> TourReadInputs? {
        let dx = hole.x - ball.x
        let dy = hole.y - ball.y
        let distanceM = hypot(dx, dy)
        guard distanceM >= 1e-9 else { return nil }
        guard
            let ballSample = surface.sampleAt(ball),
            let holeSample = surface.sampleAt(hole)
        else { return nil }

        let alongX = dx / distanceM
        let alongY = dy / distanceM
        // Right-hand unit vector looking from ball to hole (x east, y north).
        let rightX = alongY
        let rightY = -alongX

        var sum = 0.0
        var count = 0
        for i in 0..<tourReadCrossSamples {
            let t = (Double(i) + 0.5) / Double(tourReadCrossSamples)
            guard let s = surface.sampleAt(Vec2(x: ball.x + dx * t, y: ball.y + dy * t)) else {
                continue
            }
            // Downhill (−∇h) projected on the right unit vector: + = falls right.
            sum += -(s.gradX * rightX + s.gradY * rightY)
            count += 1
        }
        let meanCross = count > 0 ? sum / Double(count) : 0
        return TourReadInputs(
            distanceM: distanceM,
            gradeDeltaM: holeSample.height - ballSample.height,
            slopePct: abs(meanCross) * 100,
            breakToRight: meanCross > 0
        )
    }

    /// Closed-form Tour Read from the surface — the verbal cross-check shown
    /// alongside the exact integrator (doc §5.1). Nil when off coverage.
    public static func deriveTourRead(
        surface: some GreenSurface,
        ball: Vec2,
        hole: Vec2,
        stimpFt: Double
    ) -> TourRead? {
        guard let gt = deriveTourReadInputs(surface: surface, ball: ball, hole: hole) else {
            return nil
        }
        return tourRead(
            distanceM: gt.distanceM,
            gradeDeltaM: gt.gradeDeltaM,
            slopePct: gt.slopePct,
            stimpFt: stimpFt,
            breakToRight: gt.breakToRight
        )
    }

    // MARK: - Distance, elevation & local slope stations

    /// A local slope read anchored to the simulated putt path. `downhillE/N`
    /// is the unit fall-line vector; a flat station uses (0, 0).
    public struct SlopeStation: Equatable, Sendable {
        public var position: Vec2
        public var slopePct: Double
        public var downhillE: Double
        public var downhillN: Double
    }

    /// Human-facing context shared by the panel and map overlay.
    public struct PuttProfile: Equatable, Sendable {
        /// Straight marker-to-marker plan distance, meters.
        public var distanceM: Double
        /// Hole height minus ball height, meters (+ uphill, - downhill).
        public var elevationDeltaM: Double
        /// Evenly spaced local fall-line reads along the simulated path.
        public var stations: [SlopeStation]
    }

    /// Build the displayed putt context from the SAME effective surface used
    /// by the integrator (calibrated DEM or fresh scan). Stations follow the
    /// simulated path up to its closest approach to the hole; if no usable
    /// path exists, the straight reference line is used.
    public static func deriveProfile(
        surface: some GreenSurface,
        ball: Vec2,
        hole: Vec2,
        path: [Vec2]
    ) -> PuttProfile? {
        let distanceM = hypot(hole.x - ball.x, hole.y - ball.y)
        guard distanceM >= 1e-9,
              let ballSample = surface.sampleAt(ball),
              let holeSample = surface.sampleAt(hole)
        else { return nil }

        let line = pathToClosestApproach(path, ball: ball, hole: hole)
        let stations = stationFractions(distanceM: distanceM).compactMap { fraction -> SlopeStation? in
            let position = point(along: line, fraction: fraction)
            guard let sample = surface.sampleAt(position) else { return nil }
            let slope = hypot(sample.gradX, sample.gradY)
            let downhillE = slope > 1e-12 ? -sample.gradX / slope : 0
            let downhillN = slope > 1e-12 ? -sample.gradY / slope : 0
            return SlopeStation(
                position: position,
                slopePct: slope * 100,
                downhillE: downhillE,
                downhillN: downhillN
            )
        }
        return PuttProfile(
            distanceM: distanceM,
            elevationDeltaM: holeSample.height - ballSample.height,
            stations: stations
        )
    }

    /// One midpoint through 5 m. Longer putts are split into equal sections
    /// no longer than 3 m; only interior boundaries become stations. Thus a
    /// 9 m putt yields 1/3 and 2/3 (3 m and 6 m).
    static func stationFractions(distanceM: Double) -> [Double] {
        guard distanceM > 0 else { return [] }
        let segments = distanceM <= 5 ? 2 : max(2, Int(ceil(distanceM / 3)))
        return (1..<segments).map { Double($0) / Double(segments) }
    }

    private static func pathToClosestApproach(
        _ path: [Vec2],
        ball: Vec2,
        hole: Vec2
    ) -> [Vec2] {
        guard path.count >= 2 else { return [ball, hole] }
        var closest = 0
        var closestDistance = Double.infinity
        for (index, p) in path.enumerated() {
            let d = hypot(p.x - hole.x, p.y - hole.y)
            if d < closestDistance {
                closest = index
                closestDistance = d
            }
        }
        guard closest >= 1 else { return [ball, hole] }
        return Array(path[...closest])
    }

    private static func point(along line: [Vec2], fraction: Double) -> Vec2 {
        guard let first = line.first else { return Vec2(x: 0, y: 0) }
        guard line.count >= 2 else { return first }
        var lengths = [Double](repeating: 0, count: line.count)
        for i in 1..<line.count {
            lengths[i] = lengths[i - 1] + hypot(
                line[i].x - line[i - 1].x,
                line[i].y - line[i - 1].y
            )
        }
        let total = lengths.last ?? 0
        guard total > 1e-12 else { return first }
        let target = min(max(fraction, 0), 1) * total
        for i in 1..<line.count where lengths[i] >= target {
            let segment = lengths[i] - lengths[i - 1]
            let t = segment > 0 ? (target - lengths[i - 1]) / segment : 0
            return Vec2(
                x: line[i - 1].x + (line[i].x - line[i - 1].x) * t,
                y: line[i - 1].y + (line[i].y - line[i - 1].y) * t
            )
        }
        return line.last ?? first
    }

    // MARK: - Map overlay projection

    /// The putt read projected into WGS84 for the map overlay: the simulated
    /// break path, the straight ball→hole reference line, the ball/hole
    /// markers (each may exist alone — the hole defaults before the ball is
    /// placed), and the aim point. EPSG:3006 in, WGS84 out; the renderer
    /// (`PuttOverlayRenderer`) converts these to MLN shapes. Mirrors the web
    /// `putt-overlay.ts` `buildPuttGeojson` roles (ref/path/aim/hole/ball),
    /// extended on iOS with sparse local slope stations. The dense background
    /// fall-line field still comes from the green-analysis overlay.
    public struct PuttOverlay: Equatable, Sendable {
        /// Handle ids for the drag hit-test (CourseMapView routes these to the
        /// putt model instead of the Adjust model).
        public static let ballHandleID = "putt-ball"
        public static let holeHandleID = "putt-hole"

        /// Simulated break path (≥2 points when a read is settled; empty
        /// otherwise — mid-drag the path drops out, markers stay live).
        public var path: [LatLon]
        /// Straight ball→hole reference line (2 points; empty until both are
        /// placed).
        public var reference: [LatLon]
        public var ball: LatLon?
        public var hole: LatLon?
        /// Where the player starts the ball (web: the aim bearing carried out
        /// to the hole's range). Nil when no settled read.
        public var aim: LatLon?
        /// Local slope stations: a downhill fall-line arrow and slope label.
        public var stations: [Station]
        /// Softened (degraded path / low confidence) — the renderer restyles
        /// the path amber instead of blue, like the web.
        public var soft: Bool

        public struct Station: Equatable, Sendable {
            public var arrowStrokes: [[LatLon]]
            public var labelPosition: LatLon
            public var slopePct: Double
        }

        public init(
            path: [LatLon],
            reference: [LatLon],
            ball: LatLon?,
            hole: LatLon?,
            aim: LatLon?,
            stations: [Station],
            soft: Bool
        ) {
            self.path = path
            self.reference = reference
            self.ball = ball
            self.hole = hole
            self.aim = aim
            self.stations = stations
            self.soft = soft
        }
    }

    /// Project the live markers + settled read for rendering. `read` may be
    /// nil (not settled / withheld) — then only the markers + reference line
    /// are returned so tap-to-place feedback never waits on the integrator.
    public static func overlay(
        ball: Vec2?,
        hole: Vec2?,
        read: PuttRead?,
        profile: PuttProfile? = nil,
        soft: Bool
    ) -> PuttOverlay {
        var path: [LatLon] = []
        var aim: LatLon?
        var stations: [PuttOverlay.Station] = []
        if let ball, let hole, let read, read.availability != .unavailable {
            if read.path.count >= 2 {
                path = read.path.map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) }
            }
            aim = aimPoint(ball: ball, hole: hole, read: read)
                .map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) }
            stations = profile?.stations.map(projectStation) ?? []
        }
        let reference: [LatLon]
        if let ball, let hole {
            reference = [
                Sweref99TM.toWGS84(x: ball.x, y: ball.y),
                Sweref99TM.toWGS84(x: hole.x, y: hole.y),
            ]
        } else {
            reference = []
        }
        return PuttOverlay(
            path: path,
            reference: reference,
            ball: ball.map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) },
            hole: hole.map { Sweref99TM.toWGS84(x: $0.x, y: $0.y) },
            aim: aim,
            stations: stations,
            soft: soft
        )
    }

    /// Fixed-size station arrow: starts at the station and points one meter
    /// downhill; the label sits slightly uphill so the two remain legible.
    private static func projectStation(_ station: SlopeStation) -> PuttOverlay.Station {
        let lengthM = 1.0
        let headLengthM = 0.35
        let e = station.position.x
        let n = station.position.y
        let tipE = e + station.downhillE * lengthM
        let tipN = n + station.downhillN * lengthM
        var strokes: [[LatLon]] = []
        if station.downhillE != 0 || station.downhillN != 0 {
            strokes.append([
                Sweref99TM.toWGS84(x: e, y: n),
                Sweref99TM.toWGS84(x: tipE, y: tipN),
            ])
            for sign in [1.0, -1.0] {
                let angle = sign * 150 * Double.pi / 180
                let cosA = cos(angle)
                let sinA = sin(angle)
                let headE = station.downhillE * cosA - station.downhillN * sinA
                let headN = station.downhillE * sinA + station.downhillN * cosA
                strokes.append([
                    Sweref99TM.toWGS84(x: tipE, y: tipN),
                    Sweref99TM.toWGS84(
                        x: tipE + headE * headLengthM,
                        y: tipN + headN * headLengthM
                    ),
                ])
            }
        }
        return PuttOverlay.Station(
            arrowStrokes: strokes,
            labelPosition: Sweref99TM.toWGS84(
                x: e - station.downhillE * 0.45,
                y: n - station.downhillN * 0.45
            ),
            slopePct: station.slopePct
        )
    }

    /// The aim target in EPSG:3006: the chosen start bearing carried out to
    /// the hole's range — where the player should aim, offset from the hole by
    /// aimOffsetM. Exact mirror of the web `buildPuttGeojson` aim point. Nil
    /// for a degenerate zero-length putt.
    static func aimPoint(ball: Vec2, hole: Vec2, read: PuttRead) -> Vec2? {
        let rangeM = hypot(hole.x - ball.x, hole.y - ball.y)
        guard rangeM >= 1e-9 else { return nil }
        let dir = bearingToUnitVector(read.aimBearingDeg)
        return Vec2(x: ball.x + dir.x * rangeM, y: ball.y + dir.y * rangeM)
    }
}
