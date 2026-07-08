import Foundation

/// Tier-2 green-surface adapter: a bilinear patch over a sampled DEM grid.
/// Faithful Swift port of `shared/strategy/putting/dem-surface.ts` — same
/// bilinear patch, same null/coverage policy, same DEM_DEFAULT_CONFIDENCE;
/// TS-generated goldens (`putting-goldens.json`) pin the parity.
///
/// Boundary mapping (TS `DemGrid` → iOS `SampleGrid`, AnalysisGrid.swift):
///  - TS `heights: (number | null)[]` (null = nodata)  →  `SampleGrid.heights:
///    [Double]` with NaN = nodata (`GreenSampleGridBuilder`'s convention).
///    The TS "is null" nodata test becomes `isNaN` — same cells rejected.
///  - TS `insideMask: number[]` (1 = inside)  →  `SampleGrid.insideMask:
///    [Bool]` (true = inside). TS tests `insideMask[i] === 1`; here `== true`.
///  - TS `origin {e, n}` + `resolution`/`width`/`height` (flat fields)  →
///    `SampleGrid.spec` (`AnalysisGridSpec.originE/originN/resolution/
///    width/height`). Identical semantics: origin is the EPSG:3006 top-left
///    OUTER corner; row-major from NW; row 0 northernmost; square cells.
///
/// Grid layout (must match web/src/analysis/analysis-math.ts):
///  - heights are row-major from the NW corner: index = row·width + col.
///  - Cell (row, col) CENTER is at
///        e = originE + (col + 0.5)·resolution   (east grows with col)
///        n = originN − (row + 0.5)·resolution   (row 0 is NORTHERNMOST)
///
/// Sampling: bilinear interpolation over the four cell CENTERS surrounding
/// the query point. Height is C0-continuous; the gradient is the analytic
/// derivative of that bilinear patch, so it is PIECEWISE per cell (constant
/// along each axis within a cell, discontinuous across cell-center lines).
/// This matches computeSlopeGrid's convention: downhill = −∇h.
///
/// Coverage / nil policy: sampleAt returns nil when the point is outside the
/// grid OR any of the four surrounding cell centers is nodata (NaN height)
/// or outside the polygon (insideMask false). Off-green / no-data means
/// "no read", never flat (GreenSurface contract).
///
/// Confidence: a single per-sample constant (default DEM_DEFAULT_CONFIDENCE
/// — deliberately conservative for an uncalibrated national DEM, doc §4).
/// The real per-green confidence map replaces this constant later (§4.2).
/// Consumers gate/soften on it and must never sharpen it.

/// Conservative default confidence for an uncalibrated DEM (doc §4.2).
public let DEM_DEFAULT_CONFIDENCE = 0.6

/// Tier-2 adapter: sample a DEM `SampleGrid` as a bilinear surface.
/// `confidence` (default DEM_DEFAULT_CONFIDENCE) is emitted on every sample.
public struct DemSurface: GreenSurface {
    private let grid: SampleGrid
    private let confidence: Double

    public init(grid: SampleGrid, confidence: Double = DEM_DEFAULT_CONFIDENCE) {
        self.grid = grid
        self.confidence = confidence
    }

    /// A cell center is usable only if it has a height and is inside.
    private func usable(_ row: Int, _ col: Int) -> Bool {
        let i = row * grid.spec.width + col
        return !grid.heights[i].isNaN && grid.insideMask[i]
    }

    private func h(_ row: Int, _ col: Int) -> Double {
        grid.heights[row * grid.spec.width + col]
    }

    public func sampleAt(_ p: Vec2) -> SurfaceSample? {
        let spec = grid.spec
        let resolution = spec.resolution
        // Fractional cell-center coordinates. Cell centers live at integer
        // (row, col); col grows east with p.x, row grows south as p.y
        // (north) decreases.
        let fc = (p.x - spec.originE) / resolution - 0.5
        let fr = (spec.originN - p.y) / resolution - 0.5

        // Surrounding centers: (r0..r0+1, c0..c0+1).
        let c0f = floor(fc)
        let r0f = floor(fr)
        // Need the full 2×2 block of centers in range. Bounds-check on the
        // Double values before Int conversion (mirrors the TS comparisons
        // and avoids Int-conversion traps on far-out queries).
        if c0f < 0 || r0f < 0 || c0f + 1 >= Double(spec.width) || r0f + 1 >= Double(spec.height) {
            return nil
        }
        let c0 = Int(c0f)
        let r0 = Int(r0f)
        if !usable(r0, c0)
            || !usable(r0, c0 + 1)
            || !usable(r0 + 1, c0)
            || !usable(r0 + 1, c0 + 1) {
            return nil
        }

        let tx = fc - Double(c0) // 0..1 east weight
        let ty = fr - Double(r0) // 0..1 south weight

        let h00 = h(r0, c0) // NW
        let h01 = h(r0, c0 + 1) // NE
        let h10 = h(r0 + 1, c0) // SW
        let h11 = h(r0 + 1, c0 + 1) // SE

        // Bilinear height.
        let top = h00 + (h01 - h00) * tx
        let bot = h10 + (h11 - h10) * tx
        let surfaceHeight = top + (bot - top) * ty

        // Analytic derivative of the bilinear patch.
        // dh/de (east): difference across columns per meter.
        let dhde = ((h01 - h00) * (1 - ty) + (h11 - h10) * ty) / resolution
        // dh/drow (southward): difference across rows per meter.
        let dhdrow = ((h10 - h00) * (1 - tx) + (h11 - h01) * tx) / resolution
        // p.y = north grows as row shrinks, so dh/dn = −dh/drow.
        let dhdn = -dhdrow

        // Vec2 {x east, y north} → gradX = dh/dx = dh/de, gradY = dh/dn.
        return SurfaceSample(
            height: surfaceHeight,
            gradX: dhde,
            gradY: dhdn,
            confidence: confidence
        )
    }
}
