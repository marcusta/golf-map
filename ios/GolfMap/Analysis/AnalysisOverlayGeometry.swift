import Foundation

/// Pure geometry for rendering an analysis view on the map: the heat image's
/// WGS84 corner quad and the fall-line arrow strokes (shaft + two 150° head
/// strokes), ported from `web/src/analysis/analysis-overlay.ts`
/// (`gridCornerCoordinates` / `arrowsToGeojson`). No MapLibre import — the
/// Map layer converts these to MLN shapes.
public enum AnalysisOverlayGeometry {

    /// The grid's four WGS84 corners in image-source order:
    /// top-left, top-right, bottom-right, bottom-left.
    public static func gridCornerCoordinates(_ spec: AnalysisGridSpec) -> [LatLon] {
        let east = spec.originE + Double(spec.width) * spec.resolution
        let south = spec.originN - Double(spec.height) * spec.resolution
        return [
            Sweref99TM.toWGS84(x: spec.originE, y: spec.originN),
            Sweref99TM.toWGS84(x: east, y: spec.originN),
            Sweref99TM.toWGS84(x: east, y: south),
            Sweref99TM.toWGS84(x: spec.originE, y: south),
        ]
    }

    /// One rendered arrow: three WGS84 line strokes (shaft, two head strokes)
    /// plus the label anchor for slope% text (offset past the tip).
    public struct ArrowStrokes: Sendable {
        public var strokes: [[LatLon]]
        public var slopePct: Double
        public var labeled: Bool
        /// Label anchor (one arrow-length downhill of the anchor point).
        public var labelPosition: LatLon
    }

    /// Arrow length used by the web renderer: half the sampling spacing,
    /// clamped to 1.5–4 m.
    public static func arrowLengthM(_ spec: AnalysisGridSpec) -> Double {
        let widthM = Double(spec.width) * spec.resolution
        let heightM = Double(spec.height) * spec.resolution
        let spacing = max(2, min(widthM, heightM) / 8)
        return min(4, max(1.5, spacing * 0.5))
    }

    /// Fall-line arrows as WGS84 strokes: a shaft centered on the anchor plus
    /// two head strokes rotated ±150° from the downhill direction, backed off
    /// the tip by 35% of the arrow length. Mirrors `arrowsToGeojson`.
    public static func arrowStrokes(_ arrows: [FallLineArrow], lengthM: Double) -> [ArrowStrokes] {
        let headLen = lengthM * 0.35

        return arrows.map { a in
            let tipE = a.e + a.dirE * lengthM * 0.5
            let tipN = a.n + a.dirN * lengthM * 0.5
            let tailE = a.e - a.dirE * lengthM * 0.5
            let tailN = a.n - a.dirN * lengthM * 0.5

            var strokes: [[LatLon]] = [[
                Sweref99TM.toWGS84(x: tailE, y: tailN),
                Sweref99TM.toWGS84(x: tipE, y: tipN),
            ]]
            for sign in [1.0, -1.0] {
                let angle = sign * 150 * Double.pi / 180
                let cosA = cos(angle)
                let sinA = sin(angle)
                let hx = a.dirE * cosA - a.dirN * sinA
                let hy = a.dirE * sinA + a.dirN * cosA
                strokes.append([
                    Sweref99TM.toWGS84(x: tipE, y: tipN),
                    Sweref99TM.toWGS84(x: tipE + hx * headLen, y: tipN + hy * headLen),
                ])
            }
            return ArrowStrokes(
                strokes: strokes,
                slopePct: a.slopePct,
                labeled: a.labeled,
                labelPosition: Sweref99TM.toWGS84(
                    x: a.e + a.dirE * lengthM,
                    y: a.n + a.dirN * lengthM
                )
            )
        }
    }
}

// MARK: - Complete analysis result

/// Everything computed for one green analysis: the sampled grid, slope field,
/// stats, fall-line arrows, and the green outline. Built off the main actor
/// by `GreenAnalysisModel`; `identity` supports cheap change detection in the
/// map layer (the arrays are large — value equality would be wasteful).
public struct GreenAnalysisResult: Sendable {
    /// Unique per computation — a new sample (hole/buffer change) gets a new id.
    public let identity: UUID
    public var grid: SampleGrid
    public var slope: SlopeGrid
    public var stats: AnalysisStats
    public var arrows: [FallLineArrow]
    /// Green outline in WGS84 (every ring), for the bold boundary line.
    public var boundaryRings: [[LatLon]]

    public init(
        grid: SampleGrid,
        slope: SlopeGrid,
        stats: AnalysisStats,
        arrows: [FallLineArrow],
        boundaryRings: [[LatLon]]
    ) {
        self.identity = UUID()
        self.grid = grid
        self.slope = slope
        self.stats = stats
        self.arrows = arrows
        self.boundaryRings = boundaryRings
    }

    /// Compute slope/stats/arrows for an already-sampled grid.
    public init(grid: SampleGrid, boundaryRings: [[LatLon]]) {
        let slope = computeSlopeGrid(grid)
        self.init(
            grid: grid,
            slope: slope,
            stats: computeStats(grid, slope: slope),
            arrows: sampleFallLines(grid, slope: slope),
            boundaryRings: boundaryRings
        )
    }

    /// WGS84 bounding box of the green outline (for the enter-mode camera fit).
    public var boundaryBounds: MapCoordinateBounds? {
        let points = boundaryRings.flatMap { $0 }
        guard let first = points.first else { return nil }
        var bounds = MapCoordinateBounds(
            west: first.lon, south: first.lat, east: first.lon, north: first.lat
        )
        for p in points.dropFirst() {
            bounds.west = min(bounds.west, p.lon)
            bounds.east = max(bounds.east, p.lon)
            bounds.south = min(bounds.south, p.lat)
            bounds.north = max(bounds.north, p.lat)
        }
        return bounds
    }
}

/// What the map should currently render for the Green view: a result + the
/// selected overlay mode. Equatable by (result identity, mode) so
/// `CourseMapView` updates cheaply.
public struct GreenAnalysisMapState: Equatable, Sendable {
    public var result: GreenAnalysisResult
    public var mode: AnalysisMode

    public init(result: GreenAnalysisResult, mode: AnalysisMode) {
        self.result = result
        self.mode = mode
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.result.identity == rhs.result.identity && lhs.mode == rhs.mode
    }
}
