import Foundation

/// A slippy-map tile address (Web Mercator, XYZ scheme: y grows southward).
public struct TileCoordinate: Sendable, Equatable, Hashable {
    public let z: Int
    public let x: Int
    public let y: Int

    public init(z: Int, x: Int, y: Int) {
        self.z = z
        self.x = x
        self.y = y
    }
}

/// WGS84 bounding box in degrees.
public struct TileBounds: Sendable, Equatable {
    public var west: Double
    public var south: Double
    public var east: Double
    public var north: Double

    public init(west: Double, south: Double, east: Double, north: Double) {
        self.west = west
        self.south = south
        self.east = east
        self.north = north
    }
}

/// Enumerates the XYZ tiles covering a WGS84 bounding box across zoom levels.
///
/// NOTE: The Web-Mercator math here is deliberately small and private. The Geo
/// module (built in parallel) will ship a public version of the same
/// projection; a later cleanup pass should consolidate the two.
public enum TileEnumerator {
    /// All tiles covering `bounds` at every zoom in `zoomLevels`, ordered by
    /// ascending zoom, then row (y), then column (x).
    public static func tiles(in bounds: TileBounds, zoomLevels: ClosedRange<Int>) -> [TileCoordinate] {
        var result: [TileCoordinate] = []
        for z in zoomLevels {
            let range = tileRange(for: bounds, zoom: z)
            for y in range.minY...range.maxY {
                for x in range.minX...range.maxX {
                    result.append(TileCoordinate(z: z, x: x, y: y))
                }
            }
        }
        return result
    }

    /// Tile count without materializing the list.
    public static func tileCount(in bounds: TileBounds, zoomLevels: ClosedRange<Int>) -> Int {
        zoomLevels.reduce(0) { total, z in
            let range = tileRange(for: bounds, zoom: z)
            return total + (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1)
        }
    }

    // MARK: - Private Web-Mercator math

    private struct TileRange {
        let minX: Int
        let maxX: Int
        let minY: Int
        let maxY: Int
    }

    private static func tileRange(for bounds: TileBounds, zoom: Int) -> TileRange {
        TileRange(
            minX: tileX(lon: bounds.west, zoom: zoom),
            maxX: tileX(lon: bounds.east, zoom: zoom),
            minY: tileY(lat: bounds.north, zoom: zoom),
            maxY: tileY(lat: bounds.south, zoom: zoom)
        )
    }

    private static func tileX(lon: Double, zoom: Int) -> Int {
        let n = Double(1 << zoom)
        let raw = Int(((lon + 180.0) / 360.0 * n).rounded(.down))
        return clamp(raw, zoom: zoom)
    }

    private static func tileY(lat: Double, zoom: Int) -> Int {
        let n = Double(1 << zoom)
        let latRad = lat * .pi / 180.0
        let raw = Int(((1.0 - asinh(tan(latRad)) / .pi) / 2.0 * n).rounded(.down))
        return clamp(raw, zoom: zoom)
    }

    private static func clamp(_ value: Int, zoom: Int) -> Int {
        min(max(value, 0), (1 << zoom) - 1)
    }
}
