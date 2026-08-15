import Foundation

/// Builds the watch bundle's per-hole elevation grids from the phone's
/// terrain-RGB pyramid: a fine grid over the green + apron and a coarse grid
/// over the playing corridor. Everything else stays empty on purpose — the
/// watch degrades to straight distances off-corridor, and the payload stays
/// tens of KB per course.
enum WatchElevationPatchBuilder {

    /// Green-tier cell size — matches the lidar DEM's ~1 m ground truth, so
    /// the green grid IS full resolution.
    static let greenCellM = 1.0
    /// Apron around the green polygon bbox (greenside lies still measure).
    static let greenBufferM = 10.0
    /// Corridor-tier cell size — plays-like needs the player's elevation to
    /// ~±0.5 m; 12 m cells on fairway-scale relief deliver that.
    static let corridorCellM = 12.0
    /// Half-width of the sampled corridor around the tee→aims→green line.
    static let corridorBufferM = 40.0
    /// Safety cap per axis — a malformed polygon/path yields no grid rather
    /// than a megabyte of samples.
    static let maxCellsPerAxis = 240

    /// Fine grid over the green polygon bbox + apron, Gaussian-smoothed like
    /// the phone's own green analysis (tames the terrain tiles' 0.1 m
    /// quantization so watch-side deltas read relief, not encoding steps).
    static func greenGrid(
        rings: [[Sweref99TM.Point]],
        sampler: GridElevationSampler
    ) async -> WatchElevationGrid? {
        guard let bbox = AnalysisGridMath.ringsBbox(rings) else { return nil }
        guard let layout = layout(
            minX: bbox.minX - greenBufferM, maxX: bbox.maxX + greenBufferM,
            minY: bbox.minY - greenBufferM, maxY: bbox.maxY + greenBufferM,
            cellSize: greenCellM
        ) else { return nil }

        var heights = await sample(layout: layout, sampler: sampler) { _, _ in true }
        heights = AnalysisGridMath.gaussianBlur(
            heights, width: layout.cols, height: layout.rows, radius: 2
        )
        return WatchElevationGrid(
            originE: layout.originE, originN: layout.originN,
            cellSize: layout.cellSize, cols: layout.cols, rows: layout.rows,
            heightsM: heights
        )
    }

    /// Coarse grid over the hole's playing line (tee → aim points → green
    /// center). Cells farther than `corridorBufferM` from the line stay
    /// nodata — sampled extent and payload follow the hole's shape, not its
    /// bounding box.
    static func corridorGrid(
        path: [Sweref99TM.Point],
        sampler: GridElevationSampler
    ) async -> WatchElevationGrid? {
        guard path.count >= 2 else { return nil }
        var minX = Double.infinity, minY = Double.infinity
        var maxX = -Double.infinity, maxY = -Double.infinity
        for p in path {
            minX = min(minX, p.x)
            minY = min(minY, p.y)
            maxX = max(maxX, p.x)
            maxY = max(maxY, p.y)
        }
        guard minX.isFinite else { return nil }
        guard let layout = layout(
            minX: minX - corridorBufferM, maxX: maxX + corridorBufferM,
            minY: minY - corridorBufferM, maxY: maxY + corridorBufferM,
            cellSize: corridorCellM
        ) else { return nil }

        let heights = await sample(layout: layout, sampler: sampler) { e, n in
            distanceToPath(e: e, n: n, path: path) <= corridorBufferM
        }
        return WatchElevationGrid(
            originE: layout.originE, originN: layout.originN,
            cellSize: layout.cellSize, cols: layout.cols, rows: layout.rows,
            heightsM: heights
        )
    }

    // MARK: - Layout / sampling

    struct Layout {
        var originE: Double
        var originN: Double
        var cellSize: Double
        var cols: Int
        var rows: Int
    }

    private static func layout(
        minX: Double, maxX: Double, minY: Double, maxY: Double, cellSize: Double
    ) -> Layout? {
        guard maxX > minX, maxY > minY else { return nil }
        let cols = Int(ceil((maxX - minX) / cellSize))
        let rows = Int(ceil((maxY - minY) / cellSize))
        guard cols > 0, rows > 0, cols <= maxCellsPerAxis, rows <= maxCellsPerAxis
        else { return nil }
        return Layout(originE: minX, originN: maxY, cellSize: cellSize, cols: cols, rows: rows)
    }

    /// Samples every cell center passing `include`; excluded/missing cells
    /// are NaN (→ nodata in the encoded grid).
    private static func sample(
        layout: Layout,
        sampler: GridElevationSampler,
        include: (Double, Double) -> Bool
    ) async -> [Double] {
        var heights = [Double](repeating: .nan, count: layout.cols * layout.rows)
        for row in 0..<layout.rows {
            let n = layout.originN - (Double(row) + 0.5) * layout.cellSize
            for col in 0..<layout.cols {
                let e = layout.originE + (Double(col) + 0.5) * layout.cellSize
                guard include(e, n) else { continue }
                let coordinate = Sweref99TM.toWGS84(x: e, y: n)
                heights[row * layout.cols + col] = await sampler(coordinate) ?? .nan
            }
        }
        return heights
    }

    /// Minimum distance from a point to a polyline (meters).
    static func distanceToPath(e: Double, n: Double, path: [Sweref99TM.Point]) -> Double {
        var best = Double.infinity
        for i in 1..<path.count {
            let a = path[i - 1]
            let b = path[i]
            let abx = b.x - a.x
            let aby = b.y - a.y
            let lengthSq = abx * abx + aby * aby
            let t = lengthSq > 0
                ? min(max(((e - a.x) * abx + (n - a.y) * aby) / lengthSq, 0), 1)
                : 0
            let dx = e - (a.x + t * abx)
            let dy = n - (a.y + t * aby)
            best = min(best, (dx * dx + dy * dy).squareRoot())
        }
        return best
    }
}
