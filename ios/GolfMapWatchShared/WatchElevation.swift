import Foundation

/// A compact axis-aligned elevation grid in SWEREF 99 TM (EPSG:3006) meters —
/// the watch's offline terrain. Two tiers per hole: a fine grid over the
/// green + apron and a coarse grid over the playing corridor; everything
/// between holes is simply absent (elevation degrades to nil, distances stay).
///
/// Samples are row-major from the NW corner (row 0 = northernmost), taken at
/// CELL CENTERS, encoded as little-endian Int16 CENTIMETERS relative to
/// `baseElevation` (`Int16.min` = nodata). JSON carries `samples` as base64
/// via Codable's Data encoding. Wire format — additive changes only.
public struct WatchElevationGrid: Codable, Sendable, Equatable {
    /// NW outer corner, EPSG:3006 easting (meters).
    public var originE: Double
    /// NW outer corner, EPSG:3006 northing (meters).
    public var originN: Double
    /// Cell size in meters.
    public var cellSize: Double
    /// Cells per row (east–west).
    public var cols: Int
    /// Rows (north–south).
    public var rows: Int
    /// Meters (RH2000); sample values are cm offsets from this.
    public var baseElevation: Double
    /// `cols * rows` little-endian Int16 values, cm; `Int16.min` = nodata.
    public var samples: Data

    public static let nodata = Int16.min

    public init(
        originE: Double,
        originN: Double,
        cellSize: Double,
        cols: Int,
        rows: Int,
        baseElevation: Double,
        samples: Data
    ) {
        self.originE = originE
        self.originN = originN
        self.cellSize = cellSize
        self.cols = cols
        self.rows = rows
        self.baseElevation = baseElevation
        self.samples = samples
    }

    /// Encodes a grid from meter heights (NaN = nodata). `baseElevation` is
    /// the minimum valid height, so offsets are non-negative and a hole's
    /// full relief fits Int16 cm with two orders of magnitude to spare.
    /// Nil when the layout is degenerate or no cell has data.
    public init?(
        originE: Double,
        originN: Double,
        cellSize: Double,
        cols: Int,
        rows: Int,
        heightsM: [Double]
    ) {
        guard cols > 0, rows > 0, cellSize > 0, heightsM.count == cols * rows else { return nil }
        let valid = heightsM.filter { !$0.isNaN }
        guard let base = valid.min() else { return nil }

        var data = Data(capacity: heightsM.count * 2)
        for h in heightsM {
            let value: Int16
            if h.isNaN {
                value = Self.nodata
            } else {
                let cm = ((h - base) * 100).rounded()
                value = Int16(min(max(cm, 0), Double(Int16.max)))
            }
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        self.init(
            originE: originE, originN: originN, cellSize: cellSize,
            cols: cols, rows: rows, baseElevation: base, samples: data
        )
    }

    /// Decoded height (meters) of one cell, nil for nodata / out of range.
    public func height(col: Int, row: Int) -> Double? {
        guard col >= 0, col < cols, row >= 0, row < rows,
              samples.count == cols * rows * 2
        else { return nil }
        let offset = samples.startIndex + (row * cols + col) * 2
        let raw = Int16(littleEndian: Int16(
            bitPattern: UInt16(samples[offset]) | (UInt16(samples[offset + 1]) << 8)
        ))
        guard raw != Self.nodata else { return nil }
        return baseElevation + Double(raw) / 100
    }

    /// Bilinear elevation (meters) at an EPSG:3006 point. Nil outside the
    /// grid's outer rectangle or where every contributing cell is nodata;
    /// near a nodata edge the weights renormalize over the valid neighbors,
    /// so coverage degrades cell by cell instead of a whole 2×2 patch.
    public func elevation(atE e: Double, n: Double) -> Double? {
        guard cellSize > 0, samples.count == cols * rows * 2 else { return nil }
        let widthM = Double(cols) * cellSize
        let heightM = Double(rows) * cellSize
        guard e >= originE, e <= originE + widthM,
              n <= originN, n >= originN - heightM
        else { return nil }

        // Fractional position in cell-center coordinates, clamped so border
        // strips (outer half-cell) sample the edge cells.
        let fx = min(max((e - originE) / cellSize - 0.5, 0), Double(cols - 1))
        let fy = min(max((originN - n) / cellSize - 0.5, 0), Double(rows - 1))
        let col0 = Int(fx)
        let row0 = Int(fy)
        let col1 = min(col0 + 1, cols - 1)
        let row1 = min(row0 + 1, rows - 1)
        let tx = fx - Double(col0)
        let ty = fy - Double(row0)

        var sum = 0.0
        var weight = 0.0
        for (col, row, w) in [
            (col0, row0, (1 - tx) * (1 - ty)),
            (col1, row0, tx * (1 - ty)),
            (col0, row1, (1 - tx) * ty),
            (col1, row1, tx * ty),
        ] {
            guard w > 0 || (col == col0 && row == row0) else { continue }
            if let h = height(col: col, row: row) {
                sum += h * w
                weight += w
            }
        }
        guard weight > 1e-9 else { return nil }
        return sum / weight
    }
}

/// A slope-shaded picture of one green, pre-rendered on the phone (the same
/// ramp as the phone/web Green view) — the watch just draws the bitmap and
/// composites the player dot on top. North-up, EPSG:3006 axis-aligned.
/// One fall-line arrow on the green: anchor + downhill unit vector,
/// EPSG:3006. The watch draws these as vectors so they stay crisp at any
/// canvas scale (baking them into the PNG would alias at 1–2 px widths).
public struct WatchFallArrow: Codable, Sendable, Equatable {
    public var e: Double
    public var n: Double
    public var dirE: Double
    public var dirN: Double
    public var slopePct: Double

    public init(e: Double, n: Double, dirE: Double, dirN: Double, slopePct: Double) {
        self.e = e
        self.n = n
        self.dirE = dirE
        self.dirN = dirN
        self.slopePct = slopePct
    }
}

public struct WatchGreenImage: Codable, Sendable, Equatable {
    /// PNG bytes (base64 in JSON). PNG, never JPEG: flat-shaded slope bands
    /// with sharp contour edges are JPEG's worst case.
    public var png: Data
    /// NW corner of the top-left pixel, EPSG:3006.
    public var originE: Double
    public var originN: Double
    public var metersPerPixel: Double
    public var widthPx: Int
    public var heightPx: Int
    /// Fall-line arrows inside the green (optional — older bundles lack them).
    public var arrows: [WatchFallArrow]?
    /// Arrow shaft length in meters, sized by the phone to the green's extent.
    public var arrowLengthM: Double?

    public init(
        png: Data,
        originE: Double,
        originN: Double,
        metersPerPixel: Double,
        widthPx: Int,
        heightPx: Int,
        arrows: [WatchFallArrow]? = nil,
        arrowLengthM: Double? = nil
    ) {
        self.png = png
        self.originE = originE
        self.originN = originN
        self.metersPerPixel = metersPerPixel
        self.widthPx = widthPx
        self.heightPx = heightPx
        self.arrows = arrows
        self.arrowLengthM = arrowLengthM
    }
}

extension WatchHole {
    /// Elevation (meters) at an EPSG:3006 point from this hole's grids —
    /// finest tier first. Nil off both grids (e.g. between holes).
    public func elevation(atE e: Double, n: Double) -> Double? {
        greenGrid?.elevation(atE: e, n: n) ?? corridorGrid?.elevation(atE: e, n: n)
    }
}
