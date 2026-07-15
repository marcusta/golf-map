import Foundation

/// Elevation sampling over a downloaded terrain-RGB tile pyramid, with a small
/// in-memory LRU of decoded tiles.
///
/// Wraps the pure Geo sampling (`TerrainTile` + `WebMercatorTiles`) with the
/// app-layer concerns the Geo module deliberately leaves out: reading tile
/// PNGs from the bundle directory (`tiles/terrain/{z}/{x}/{y}.png`) and
/// caching decoded tiles so a stream of GPS fixes doesn't re-decode the same
/// tile on every update. Known-missing tiles (outside coverage) are cached as
/// misses too, so repeated queries off the pyramid stay cheap.
actor TerrainElevationService {
    /// One decoded cache entry; `nil` tile = known missing/undecodable.
    private struct Entry {
        var tile: TerrainTile?
    }

    private let zoom: Int
    private let capacity: Int
    private let tileData: TerrainTileProvider

    private var cache: [WebMercatorTiles.Tile: Entry] = [:]
    /// Keys in least-recently-used → most-recently-used order.
    private var recency: [WebMercatorTiles.Tile] = []

    /// - Parameters:
    ///   - zoom: fixed query zoom (use the manifest's `terrainMaxZoom` for
    ///     full-resolution sampling).
    ///   - capacity: max decoded tiles kept in memory (~256 KB each at 256px).
    ///   - tileData: PNG bytes for a tile address, nil when missing. Injected
    ///     so tests can count fetches / serve fixtures.
    init(zoom: Int, capacity: Int = 20, tileData: @escaping TerrainTileProvider) {
        precondition(capacity > 0)
        self.zoom = zoom
        self.capacity = capacity
        self.tileData = tileData
    }

    /// Reads terrain tiles from a course bundle directory laid out as
    /// `BundlePaths` writes it: `<bundleDirectory>/tiles/terrain/{z}/{x}/{y}.png`.
    init(bundleDirectory: URL, zoom: Int, capacity: Int = 20) {
        self.init(zoom: zoom, capacity: capacity, tileData: { z, x, y in
            let url = bundleDirectory
                .appending(path: "tiles", directoryHint: .isDirectory)
                .appending(path: TileLayer.terrain.rawValue, directoryHint: .isDirectory)
                .appending(path: String(z), directoryHint: .isDirectory)
                .appending(path: String(x), directoryHint: .isDirectory)
                .appending(path: "\(y).\(TileLayer.terrain.fileExtension)")
            return try? Data(contentsOf: url)
        })
    }

    /// The Web Mercator latitude limit: beyond ±85.05° the projection blows
    /// up (and past ±90° the mercator Y is NaN, which would TRAP in
    /// `tilePixel`'s Int conversion). Any such coordinate is off the pyramid
    /// by definition, so it degrades to a nil sample like a missing tile.
    private static let mercatorLatLimit = 85.06

    /// Bilinearly sampled elevation (meters) at a WGS84 coordinate, or nil
    /// when the coordinate is invalid (non-finite / outside Web Mercator
    /// range) or the containing tile is missing or fails to decode. Sampling
    /// must DEGRADE, never crash: elevation is optional everywhere downstream
    /// (plays-like just goes nil), so a garbage coordinate — whatever produced
    /// it — must not take the app down (seen live: an out-of-range latitude
    /// trapped `Int(floor(NaN))` in `WebMercatorTiles.tilePixel`).
    func elevation(at coordinate: LatLon) async -> Double? {
        guard coordinate.lat.isFinite, coordinate.lon.isFinite,
              abs(coordinate.lat) <= Self.mercatorLatLimit,
              abs(coordinate.lon) <= 180
        else { return nil }
        let tp = WebMercatorTiles.tilePixel(lon: coordinate.lon, lat: coordinate.lat, zoom: zoom)
        let key = WebMercatorTiles.Tile(z: zoom, x: tp.tileX, y: tp.tileY)
        guard let tile = await cachedTile(key) else { return nil }
        return tile.elevation(atPx: tp.px, py: tp.py)
    }

    // MARK: - LRU cache

    private func cachedTile(_ key: WebMercatorTiles.Tile) async -> TerrainTile? {
        if let entry = cache[key] {
            touch(key)
            return entry.tile
        }
        let data = await tileData(key.z, key.x, key.y)
        let tile = data.flatMap { TerrainTile(pngData: $0) }
        // Re-check: a concurrent query may have inserted while we awaited.
        if cache[key] == nil {
            insert(key, Entry(tile: tile))
        }
        return tile
    }

    private func touch(_ key: WebMercatorTiles.Tile) {
        if let i = recency.firstIndex(of: key) {
            recency.remove(at: i)
            recency.append(key)
        }
    }

    private func insert(_ key: WebMercatorTiles.Tile, _ entry: Entry) {
        cache[key] = entry
        recency.append(key)
        while cache.count > capacity, let oldest = recency.first {
            recency.removeFirst()
            cache.removeValue(forKey: oldest)
        }
    }
}
