import Foundation

/// Web-Mercator (EPSG:3857) XYZ tile math — the addressing scheme used by the
/// Terrain-RGB and orthophoto tile sets. Ported from the pixel math in
/// `web/src/map/elevation.service.ts` (`lngLatToTilePixel`) and generalized so
/// tile enumeration (bounding boxes) can share it.
public enum WebMercatorTiles {

    /// An integer XYZ tile address.
    public struct Tile: Sendable, Equatable, Hashable {
        public var z: Int
        public var x: Int
        public var y: Int
        public init(z: Int, x: Int, y: Int) {
            self.z = z
            self.x = x
            self.y = y
        }
    }

    /// A WGS84 tile → pixel resolution: the containing tile plus the fractional
    /// pixel position within it. `px`/`py` are in `[0, tileSize)`.
    public struct TilePixel: Sendable, Equatable {
        public var tileX: Int
        public var tileY: Int
        public var px: Double
        public var py: Double
        public init(tileX: Int, tileY: Int, px: Double, py: Double) {
            self.tileX = tileX
            self.tileY = tileY
            self.px = px
            self.py = py
        }
    }

    /// A WGS84 bounding box (tile extent).
    public struct BoundingBox: Sendable, Equatable {
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

    /// Fractional tile coordinates (X, Y) for a lng/lat at zoom `z`. Floor these
    /// for the integer tile address; the fractional remainder gives sub-tile
    /// position.
    public static func fractionalTile(lon: Double, lat: Double, zoom: Int) -> (x: Double, y: Double) {
        let n = pow(2.0, Double(zoom))
        let x = ((lon + 180) / 360) * n
        let latRad = lat * .pi / 180
        let y = (1 - log(tan(latRad) + 1 / cos(latRad)) / .pi) / 2 * n
        return (x, y)
    }

    /// `floor` → `Int` that cannot trap. An out-of-projection-domain WGS84
    /// input (|lat| ≥ 90 makes the mercator Y non-finite; live crash: a layup
    /// landing point interpolated from a far-off GPS origin came back as
    /// lat 553.9) must degrade to an address no pyramid contains — a missing
    /// tile — never `Int(floor(NaN))`. The clamp also covers finite values
    /// beyond Int's range; it cannot engage for any on-globe coordinate at
    /// any real zoom.
    private static func flooredTileIndex(_ v: Double) -> Int {
        guard v.isFinite else { return -1 }
        return Int(min(max(v.rounded(.down), -1e15), 1e15))
    }

    /// Integer XYZ tile containing a WGS84 position at zoom `z`. Positions
    /// outside the Web-Mercator domain resolve to an off-pyramid address
    /// (see `flooredTileIndex`) rather than trapping.
    public static func tile(lon: Double, lat: Double, zoom: Int) -> Tile {
        let f = fractionalTile(lon: lon, lat: lat, zoom: zoom)
        return Tile(z: zoom, x: flooredTileIndex(f.x), y: flooredTileIndex(f.y))
    }

    /// WGS84 → containing tile + fractional pixel position (Web Mercator).
    /// `px`/`py` are fractional pixel coordinates within the tile
    /// (`[0, tileSize)`). Positions outside the Web-Mercator domain resolve
    /// to an off-pyramid tile with a zero pixel offset (see
    /// `flooredTileIndex`) rather than trapping.
    public static func tilePixel(
        lon: Double,
        lat: Double,
        zoom: Int,
        tileSize: Int = 256
    ) -> TilePixel {
        let f = fractionalTile(lon: lon, lat: lat, zoom: zoom)
        let tileX = flooredTileIndex(f.x)
        let tileY = flooredTileIndex(f.y)
        return TilePixel(
            tileX: tileX,
            tileY: tileY,
            px: f.x.isFinite ? (f.x - Double(tileX)) * Double(tileSize) : 0,
            py: f.y.isFinite ? (f.y - Double(tileY)) * Double(tileSize) : 0
        )
    }

    /// WGS84 bounding box of a tile address (its NW and SE corners in lng/lat).
    public static func boundingBox(z: Int, x: Int, y: Int) -> BoundingBox {
        let n = pow(2.0, Double(z))
        func lon(_ xt: Double) -> Double { xt / n * 360 - 180 }
        func lat(_ yt: Double) -> Double {
            let r = Double.pi * (1 - 2 * yt / n)
            return atan(sinh(r)) * 180 / .pi
        }
        let west = lon(Double(x))
        let east = lon(Double(x + 1))
        let north = lat(Double(y))
        let south = lat(Double(y + 1))
        return BoundingBox(west: west, south: south, east: east, north: north)
    }

    /// Convenience overload taking a `Tile`.
    public static func boundingBox(_ tile: Tile) -> BoundingBox {
        boundingBox(z: tile.z, x: tile.x, y: tile.y)
    }
}
