import Foundation
import Observation

/// Backs the on-course "Green view": selects the active hole's green polygon
/// from the bundle's features.geojson, samples the offline terrain-RGB
/// pyramid over green + surrounds (`GreenSampleGridBuilder`), and publishes
/// the analysis result + mode/buffer controls for the map overlay and the
/// stats panel.
///
/// The web app's equivalent (`AnalysisToolService`) fetches the grid from the
/// server's full-precision DEM; here everything is computed on device. The
/// heavy sampling/compute runs off the main actor; only the published state
/// hops back.
@MainActor
@Observable
final class GreenAnalysisModel {

    enum State {
        case idle
        case loading
        case ready(GreenAnalysisResult)
        case failed(String)
    }

    private(set) var state: State = .idle
    /// Overlay mode (segmented toggle). Changing it re-colors the existing
    /// grid — no re-sample.
    private(set) var mode: AnalysisMode = .slope
    /// Surrounds buffer in meters (slider, 0–50). Changing it re-samples.
    private(set) var bufferM: Double = AnalysisGridMath.defaultBufferM

    var isActive: Bool {
        if case .idle = state { return false }
        return true
    }

    var isLoading: Bool {
        if case .loading = state { return true }
        return false
    }

    var result: GreenAnalysisResult? {
        if case .ready(let result) = state { return result }
        return nil
    }

    var errorText: String? {
        if case .failed(let message) = state { return message }
        return nil
    }

    /// What the map should render right now; nil while idle/loading/failed.
    var mapState: GreenAnalysisMapState? {
        result.map { GreenAnalysisMapState(result: $0, mode: mode) }
    }

    @ObservationIgnored private let store: GreenPolygonStore?
    @ObservationIgnored private let sampler: GridElevationSampler
    @ObservationIgnored private var computeTask: Task<Void, Never>?
    /// The active green (kept for buffer-change re-sampling).
    @ObservationIgnored private var activePolygon: GreenPolygonStore.GreenPolygon?

    /// - Parameters:
    ///   - featuresGeoJSON: the bundle's features.geojson (green outlines).
    ///   - sampler: terrain elevation source (`TerrainElevationService`).
    init(featuresGeoJSON: Data, sampler: @escaping GridElevationSampler) {
        self.store = try? GreenPolygonStore(featuresGeoJSON: featuresGeoJSON)
        self.sampler = sampler
    }

    /// Activate the tool for a hole. Selects the green polygon synchronously
    /// (so the caller can aim the camera immediately) and kicks the async
    /// sample/compute. Returns the green outline's WGS84 bounds, or nil when
    /// no green polygon could be found (the tool should not be entered).
    func activate(holeId: String?, greenCenter: LatLon?) -> MapCoordinateBounds? {
        guard let polygon = store?.green(forHoleId: holeId, greenCenter: greenCenter) else {
            return nil
        }
        activePolygon = polygon
        recompute()
        return Self.bounds(of: polygon.wgs84Rings)
    }

    /// The active green's outer outline in WGS84, grown by `meters` on every
    /// side (each vertex pushed that far out along its ray from the centroid —
    /// greens are convex enough for this to be the margin you asked for).
    /// The Green view fits THIS, not the outline's bbox: with the camera turned
    /// to the hole bearing, a north-up bbox has to cover the turned shape, and
    /// that slack shows up as a lot more surrounds than intended.
    /// Empty when no green is active.
    func greenOutline(expandedByMeters meters: Double) -> [LatLon] {
        guard let ring = activePolygon?.wgs84Rings.first, ring.count >= 3 else { return [] }
        let points = ring.map(Sweref99TM.fromWGS84)
        let centroidX = points.map(\.x).reduce(0, +) / Double(points.count)
        let centroidY = points.map(\.y).reduce(0, +) / Double(points.count)
        return points.map { point in
            let dx = point.x - centroidX
            let dy = point.y - centroidY
            let length = (dx * dx + dy * dy).squareRoot()
            guard length > 0.01 else { return Sweref99TM.toWGS84(point) }
            let scale = (length + meters) / length
            return Sweref99TM.toWGS84(
                Sweref99TM.Point(x: centroidX + dx * scale, y: centroidY + dy * scale)
            )
        }
    }

    /// WGS84 bbox of the green outline (camera fit target).
    private static func bounds(of rings: [[LatLon]]) -> MapCoordinateBounds? {
        let points = rings.flatMap { $0 }
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

    /// Exit the tool: cancel any in-flight compute and drop the result.
    func deactivate() {
        computeTask?.cancel()
        computeTask = nil
        activePolygon = nil
        state = .idle
    }

    func setMode(_ newMode: AnalysisMode) {
        mode = newMode
    }

    /// Change the surrounds buffer (clamped 0–50 m) and re-sample.
    func setBuffer(_ meters: Double) {
        let clamped = AnalysisGridMath.clamp(
            meters,
            AnalysisGridMath.bufferMinM,
            AnalysisGridMath.bufferMaxM
        )
        guard clamped != bufferM else { return }
        bufferM = clamped
        if activePolygon != nil {
            recompute()
        }
    }

    // MARK: - Compute

    private func recompute() {
        guard let polygon = activePolygon else { return }
        computeTask?.cancel()
        state = .loading
        let sampler = sampler
        let bufferM = bufferM
        computeTask = Task { [weak self] in
            let result = await Self.compute(polygon: polygon, bufferM: bufferM, sampler: sampler)
            guard !Task.isCancelled else { return }
            guard let self else { return }
            if let result {
                self.state = .ready(result)
                #if DEBUG
                Self.writeDebugSummary(result)
                #endif
            } else {
                self.state = .failed("No terrain data over this green")
            }
        }
    }

    /// Off-main-actor sampling + math (nonisolated async runs on the global
    /// executor; the terrain-tile awaits hop to the tile service actor).
    private nonisolated static func compute(
        polygon: GreenPolygonStore.GreenPolygon,
        bufferM: Double,
        sampler: GridElevationSampler
    ) async -> GreenAnalysisResult? {
        guard let grid = await GreenSampleGridBuilder.build(
            rings: polygon.rings,
            bufferM: bufferM,
            sampler: sampler
        ) else { return nil }
        // Entirely-nodata grids (green outside terrain coverage) are a failure.
        guard grid.heights.contains(where: { !$0.isNaN }) else { return nil }
        return GreenAnalysisResult(grid: grid, boundaryRings: polygon.wgs84Rings)
    }

    #if DEBUG
    /// Live-verify hook: dumps the computed stats to a JSON file in tmp so a
    /// headless run can assert the numbers without driving SwiftUI controls.
    private nonisolated static func writeDebugSummary(_ result: GreenAnalysisResult) {
        let stats = result.stats
        let summary: [String: Any] = [
            "gridWidth": result.grid.spec.width,
            "gridHeight": result.grid.spec.height,
            "resolution": result.grid.spec.resolution,
            "arrowCount": result.arrows.count,
            "green": [
                "minHeight": stats.green.minHeight,
                "maxHeight": stats.green.maxHeight,
                "deltaHeight": stats.green.deltaHeight,
                "meanHeight": stats.green.meanHeight,
                "maxSlopePct": stats.green.maxSlopePct,
                "avgSlopePct": stats.green.avgSlopePct,
            ],
            "surrounds": [
                "maxSlopePct": stats.surrounds.maxSlopePct,
                "deepestHollowM": stats.surrounds.deepestHollowM,
            ],
            "relScaleM": stats.relScaleM,
        ]
        let url = FileManager.default.temporaryDirectory
            .appending(path: "green-analysis-debug.json")
        if let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]) {
            try? data.write(to: url)
            print("GREEN-ANALYSIS \(String(data: data, encoding: .utf8) ?? "")")
        }
    }
    #endif
}
