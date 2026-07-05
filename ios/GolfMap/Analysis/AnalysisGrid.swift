import Foundation

/// Green + surrounds DEM sampling grid — Swift port of the pure grid math in
/// `server/services/analysis.service.ts` (computeGridSpec / pointInRing /
/// buildInsideMask / NaN-aware Gaussian blur).
///
/// The web app asks the server to sample the full-precision LiDAR GeoTIFF;
/// the iOS app is fully offline, so `GreenSampleGridBuilder` samples the
/// bundle's Terrain-RGB tile pyramid instead (via an injected sampler
/// closure — see `Screens/TerrainElevationService`). The radius-3 Gaussian
/// blur is kept: it is what tames the terrain tiles' 0.1 m quantization so
/// central-difference gradients read slope, not encoding steps.
public enum AnalysisGridMath {

    // MARK: - Tunables / clamps (mirror the server constants)

    public static let bufferMinM = 0.0
    public static let bufferMaxM = 50.0
    public static let defaultBufferM = 20.0
    public static let resolutionMinM = 0.25
    public static let resolutionMaxM = 10.0
    public static let defaultResolutionM = 0.5
    /// Cap on grid cells per axis — oversized areas get a coarser resolution.
    public static let maxCellsPerAxis = 400
    /// Gaussian blur radius in cells (sigma = radius / 2).
    public static let blurRadiusCells = 3

    // MARK: - Grid layout

    /// Bbox over every ring vertex. Nil when degenerate (empty / zero-area).
    public static func ringsBbox(_ rings: [[Sweref99TM.Point]]) -> AnalysisBbox? {
        var minX = Double.infinity, minY = Double.infinity
        var maxX = -Double.infinity, maxY = -Double.infinity
        for ring in rings {
            for p in ring {
                minX = min(minX, p.x)
                minY = min(minY, p.y)
                maxX = max(maxX, p.x)
                maxY = max(maxY, p.y)
            }
        }
        guard minX.isFinite, maxX > minX, maxY > minY else { return nil }
        return AnalysisBbox(minX: minX, minY: minY, maxX: maxX, maxY: maxY)
    }

    /// Grid layout for a polygon bbox + buffer: clamps the buffer and
    /// resolution, then coarsens the resolution so neither axis exceeds
    /// `maxCellsPerAxis`. Mirrors the server `computeGridSpec`.
    public static func computeGridSpec(
        bbox: AnalysisBbox,
        bufferM: Double,
        resolutionM: Double
    ) -> AnalysisGridSpec {
        let buffer = clamp(bufferM.isFinite ? bufferM : defaultBufferM, bufferMinM, bufferMaxM)
        var resolution = clamp(
            resolutionM.isFinite && resolutionM > 0 ? resolutionM : defaultResolutionM,
            resolutionMinM,
            resolutionMaxM
        )

        let extentX = bbox.maxX - bbox.minX + 2 * buffer
        let extentY = bbox.maxY - bbox.minY + 2 * buffer
        resolution = max(
            resolution,
            extentX / Double(maxCellsPerAxis),
            extentY / Double(maxCellsPerAxis)
        )

        return AnalysisGridSpec(
            originE: bbox.minX - buffer,
            originN: bbox.maxY + buffer,
            resolution: resolution,
            width: max(1, Int(ceil(extentX / resolution))),
            height: max(1, Int(ceil(extentY / resolution)))
        )
    }

    // MARK: - Inside mask

    /// Ray-casting point-in-ring test (ring implicitly closed).
    public static func pointInRing(x: Double, y: Double, ring: [Sweref99TM.Point]) -> Bool {
        var inside = false
        let n = ring.count
        var j = n - 1
        for i in 0..<n {
            let pi = ring[i]
            let pj = ring[j]
            if (pi.y > y) != (pj.y > y),
               x < (pj.x - pi.x) * (y - pi.y) / (pj.y - pi.y) + pi.x {
                inside.toggle()
            }
            j = i
        }
        return inside
    }

    /// Per-cell inside-the-polygon mask (cell centers; ring 0 = outer
    /// boundary, rings 1.. = holes). Row-major, row 0 = northernmost.
    public static func buildInsideMask(
        spec: AnalysisGridSpec,
        rings: [[Sweref99TM.Point]]
    ) -> [Bool] {
        var mask = [Bool](repeating: false, count: spec.width * spec.height)
        guard let outer = rings.first, outer.count >= 3 else { return mask }
        let holes = rings.dropFirst().filter { $0.count >= 3 }

        for row in 0..<spec.height {
            let n = spec.originN - (Double(row) + 0.5) * spec.resolution
            for col in 0..<spec.width {
                let e = spec.originE + (Double(col) + 0.5) * spec.resolution
                guard pointInRing(x: e, y: n, ring: outer) else { continue }
                let inHole = holes.contains { pointInRing(x: e, y: n, ring: $0) }
                if !inHole {
                    mask[row * spec.width + col] = true
                }
            }
        }
        return mask
    }

    // MARK: - Gaussian blur

    /// Separable NaN-aware Gaussian blur (radius in cells, sigma = radius / 2).
    /// The kernel is renormalized over valid (non-NaN) neighbors so nodata
    /// doesn't bleed into valid cells; NaN cells stay NaN. Clamped-edge
    /// boundary handling. Returns a new array. Mirrors the server
    /// `gaussianBlurGrid`.
    public static func gaussianBlur(
        _ values: [Double],
        width: Int,
        height: Int,
        radius: Int = blurRadiusCells
    ) -> [Double] {
        guard radius > 0 else { return values }
        let sigma = Double(radius) / 2
        var kernel = [Double](repeating: 0, count: 2 * radius + 1)
        for i in -radius...radius {
            kernel[i + radius] = exp(-Double(i * i) / (2 * sigma * sigma))
        }

        func pass(_ src: [Double], dx: Int, dy: Int) -> [Double] {
            var out = [Double](repeating: 0, count: src.count)
            for y in 0..<height {
                for x in 0..<width {
                    let center = src[y * width + x]
                    if center.isNaN {
                        out[y * width + x] = .nan
                        continue
                    }
                    var sum = 0.0
                    var weight = 0.0
                    for k in -radius...radius {
                        let sx = min(max(x + k * dx, 0), width - 1)
                        let sy = min(max(y + k * dy, 0), height - 1)
                        let v = src[sy * width + sx]
                        if v.isNaN { continue }
                        sum += v * kernel[k + radius]
                        weight += kernel[k + radius]
                    }
                    out[y * width + x] = weight > 0 ? sum / weight : .nan
                }
            }
            return out
        }

        return pass(pass(values, dx: 1, dy: 0), dx: 0, dy: 1)
    }

    static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        min(max(v, lo), hi)
    }
}

/// EPSG:3006 bounding box (meters).
public struct AnalysisBbox: Equatable, Sendable {
    public var minX: Double
    public var minY: Double
    public var maxX: Double
    public var maxY: Double

    public init(minX: Double, minY: Double, maxX: Double, maxY: Double) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }
}

/// Grid layout: `originE/originN` is the top-left OUTER corner (not a cell
/// center); row 0 is the northernmost row; heights are sampled at cell
/// centers. Mirrors the server `GridSpec`.
public struct AnalysisGridSpec: Equatable, Sendable {
    public var originE: Double
    public var originN: Double
    /// Cell size in meters (may be coarser than requested when capped).
    public var resolution: Double
    /// Cells per row (east–west).
    public var width: Int
    /// Rows (north–south).
    public var height: Int

    public init(originE: Double, originN: Double, resolution: Double, width: Int, height: Int) {
        self.originE = originE
        self.originN = originN
        self.resolution = resolution
        self.width = width
        self.height = height
    }
}

/// A sampled green + surrounds grid: blurred heights (NaN = nodata) at cell
/// centers + inside-the-green mask, both row-major from the NW corner.
/// Mirrors the server `SampleGrid` (nodata is NaN instead of null).
public struct SampleGrid: Sendable {
    public var spec: AnalysisGridSpec
    public var heights: [Double]
    public var insideMask: [Bool]

    public init(spec: AnalysisGridSpec, heights: [Double], insideMask: [Bool]) {
        self.spec = spec
        self.heights = heights
        self.insideMask = insideMask
    }
}

/// Elevation source for grid sampling: meters at a WGS84 coordinate, nil
/// outside coverage. `TerrainElevationService.elevation(at:)` satisfies this.
public typealias GridElevationSampler = @Sendable (LatLon) async -> Double?

/// Builds a `SampleGrid` for a green polygon (EPSG:3006 rings) + surrounds
/// buffer by sampling terrain elevations at every cell center, then applying
/// the reference Gaussian blur. This replaces the web app's server round-trip
/// (`POST /analysis/sample-grid`) with offline terrain-tile sampling.
public enum GreenSampleGridBuilder {

    /// - Parameters:
    ///   - rings: green polygon rings in EPSG:3006 (ring 0 = outer, 1.. = holes).
    ///   - bufferM: surrounds buffer in meters (clamped to 0...50).
    ///   - resolutionM: requested cell size (clamped/coarsened, default 0.5).
    ///   - sampler: elevation source (bilinear terrain-tile sampling).
    /// - Returns: nil when the polygon bbox is degenerate.
    public static func build(
        rings: [[Sweref99TM.Point]],
        bufferM: Double = AnalysisGridMath.defaultBufferM,
        resolutionM: Double = AnalysisGridMath.defaultResolutionM,
        sampler: GridElevationSampler
    ) async -> SampleGrid? {
        guard let bbox = AnalysisGridMath.ringsBbox(rings) else { return nil }
        let spec = AnalysisGridMath.computeGridSpec(
            bbox: bbox,
            bufferM: bufferM,
            resolutionM: resolutionM
        )

        var raw = [Double](repeating: .nan, count: spec.width * spec.height)
        for row in 0..<spec.height {
            let n = spec.originN - (Double(row) + 0.5) * spec.resolution
            for col in 0..<spec.width {
                if Task.isCancelled { return nil }
                let e = spec.originE + (Double(col) + 0.5) * spec.resolution
                let coordinate = Sweref99TM.toWGS84(x: e, y: n)
                raw[row * spec.width + col] = await sampler(coordinate) ?? .nan
            }
        }

        let blurred = AnalysisGridMath.gaussianBlur(raw, width: spec.width, height: spec.height)
        return SampleGrid(
            spec: spec,
            heights: blurred,
            insideMask: AnalysisGridMath.buildInsideMask(spec: spec, rings: rings)
        )
    }
}
