import Foundation
import ImageIO
import CoreGraphics

/// Terrain-RGB decoding + elevation sampling — Swift port of the pure helpers
/// in `web/src/map/elevation.service.ts`.
///
/// The web service decodes Terrain-RGB tiles itself (rather than relying on the
/// renderer) so heights are deterministic, full-resolution and independent of
/// terrain exaggeration. Sampling uses **bilinear** interpolation of the four
/// surrounding pixel centers (see `TerrainTile.elevation(atPx:py:)`), matching
/// the web `bilinearElevation`. Pixel values are treated as samples at pixel
/// centers and coordinates are clamped to the tile edge.
public enum Terrain {

    /// Mapbox/MapLibre Terrain-RGB decode: height in meters from one pixel.
    /// `height = -10000 + (R*65536 + G*256 + B) * 0.1`.
    public static func decodeRGB(r: Int, g: Int, b: Int) -> Double {
        -10000 + Double(r * 65536 + g * 256 + b) * 0.1
    }
}

/// Decoded RGBA pixel data for one terrain tile, with elevation sampling.
///
/// Wraps the raw pixels from a Terrain-RGB PNG. Use `init?(pngData:)` to decode
/// a PNG via ImageIO/CoreGraphics (no third-party deps).
public struct TerrainTile: Sendable {
    public let width: Int
    public let height: Int
    /// RGBA, row-major, 4 bytes/pixel (matches the web `ImageData` layout).
    public let data: [UInt8]

    /// Build directly from RGBA bytes (row-major, 4 bytes/pixel). Useful for
    /// synthetic test pixels. Returns nil if `data` is too small for the size.
    public init?(width: Int, height: Int, rgba data: [UInt8]) {
        guard width > 0, height > 0, data.count >= width * height * 4 else { return nil }
        self.width = width
        self.height = height
        self.data = data
    }

    /// Decode a PNG (as raw `Data`) into RGBA pixels. Returns nil if the image
    /// cannot be decoded. Forces a straight RGBA8, premultiplied-last, no color
    /// management path so terrain byte values survive intact.
    public init?(pngData: Data) {
        guard
            let source = CGImageSourceCreateWithData(pngData as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }

        let width = image.width
        let height = image.height
        let bytesPerRow = width * 4
        var buffer = [UInt8](repeating: 0, count: height * bytesPerRow)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        // premultipliedLast: terrain tiles are fully opaque (alpha 255), so RGB
        // is unchanged by premultiplication — this reproduces the browser's
        // getImageData bytes exactly.
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

        let success: Bool = buffer.withUnsafeMutableBytes { ptr -> Bool in
            guard
                let ctx = CGContext(
                    data: ptr.baseAddress,
                    width: width,
                    height: height,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: bitmapInfo
                )
            else { return false }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard success else { return nil }

        self.width = width
        self.height = height
        self.data = buffer
    }

    /// Raw decoded elevation at an integer pixel (nearest pixel, no
    /// interpolation). Coordinates are clamped to the tile bounds.
    public func elevation(atPixelX xi: Int, pixelY yi: Int) -> Double {
        let x = min(max(xi, 0), width - 1)
        let y = min(max(yi, 0), height - 1)
        let i = (y * width + x) * 4
        return Terrain.decodeRGB(r: Int(data[i]), g: Int(data[i + 1]), b: Int(data[i + 2]))
    }

    /// Bilinearly interpolated height at fractional pixel `(px, py)`. Pixel
    /// values are treated as samples at pixel centers; coordinates are clamped
    /// to the tile edge (samples within half a pixel of a border skip
    /// cross-tile interpolation). Mirrors the web `bilinearElevation`.
    public func elevation(atPx px: Double, py: Double) -> Double {
        let x = min(max(px - 0.5, 0), Double(width - 1))
        let y = min(max(py - 0.5, 0), Double(height - 1))
        let x0 = Int(floor(x))
        let y0 = Int(floor(y))
        let x1 = min(x0 + 1, width - 1)
        let y1 = min(y0 + 1, height - 1)
        let fx = x - Double(x0)
        let fy = y - Double(y0)

        func at(_ xi: Int, _ yi: Int) -> Double {
            let i = (yi * width + xi) * 4
            return Terrain.decodeRGB(r: Int(data[i]), g: Int(data[i + 1]), b: Int(data[i + 2]))
        }

        let top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx
        let bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx
        return top * (1 - fy) + bottom * fy
    }
}

/// A source of terrain tile PNG bytes, addressed by `(z, x, y)`. Returns nil
/// for missing tiles (404 / outside coverage). Mirrors the web service's
/// `TileFetcher` seam so sampling can be unit-tested with local fixtures.
public typealias TerrainTileProvider = @Sendable (_ z: Int, _ x: Int, _ y: Int) async -> Data?

/// Elevation-at-coordinate over a `TerrainTileProvider`, mirroring the web
/// `ElevationService.elevationAt`: find the containing tile at the fixed query
/// `zoom`, decode it, and bilinearly sample. Returns nil when the tile is
/// missing (outside coverage) or fails to decode.
///
/// Note: this is a stateless helper. Tile caching (the web `LruCache`) belongs
/// in a higher app layer wired to the network; the Geo module stays pure.
public func elevationAt(
    _ coord: LatLon,
    zoom: Int,
    tileSize: Int = 256,
    provider: TerrainTileProvider
) async -> Double? {
    let tp = WebMercatorTiles.tilePixel(lon: coord.lon, lat: coord.lat, zoom: zoom, tileSize: tileSize)
    guard
        let pngData = await provider(zoom, tp.tileX, tp.tileY),
        let tile = TerrainTile(pngData: pngData)
    else { return nil }
    return tile.elevation(atPx: tp.px, py: tp.py)
}
