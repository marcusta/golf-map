import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Pre-renders the watch's mini green map on the phone: the same slope ramp
/// as the phone/web Green view, sampled at 0.25 m and clipped to the green
/// polygon, encoded as PNG (lossless — JPEG's block noise would halo exactly
/// the contour edges the reader squints at). The watch never computes slope;
/// it just draws this bitmap and composites the player dot.
enum WatchGreenImageRenderer {

    /// Sampling resolution — 0.25 m/px keeps band edges crisp at watch zoom.
    static let resolutionM = 0.25
    /// Small margin so the polygon edge never clips the outermost band.
    static let bufferM = 2.0

    static func render(
        rings: [[Sweref99TM.Point]],
        sampler: GridElevationSampler
    ) async -> WatchGreenImage? {
        guard let grid = await GreenSampleGridBuilder.build(
            rings: rings, bufferM: bufferM, resolutionM: resolutionM, sampler: sampler
        ) else { return nil }
        let slope = computeSlopeGrid(grid)

        // Inside the green: opaque slope-ramp color; outside: transparent —
        // the watch draws its own boundary from the synced polygon.
        var rgba = [UInt8](repeating: 0, count: grid.heights.count * 4)
        var hasContent = false
        for i in 0..<grid.heights.count {
            guard grid.insideMask[i], !grid.heights[i].isNaN else { continue }
            let rgb = slopeColor(slope.slopePct[i])
            let o = i * 4
            rgba[o] = UInt8(min(max(rgb.r, 0), 255))
            rgba[o + 1] = UInt8(min(max(rgb.g, 0), 255))
            rgba[o + 2] = UInt8(min(max(rgb.b, 0), 255))
            rgba[o + 3] = 255
            hasContent = true
        }
        guard hasContent else { return nil }
        guard let png = pngData(rgba: rgba, width: grid.spec.width, height: grid.spec.height)
        else { return nil }

        return WatchGreenImage(
            png: png,
            originE: grid.spec.originE,
            originN: grid.spec.originN,
            metersPerPixel: grid.spec.resolution,
            widthPx: grid.spec.width,
            heightPx: grid.spec.height
        )
    }

    /// RGBA (straight alpha, row 0 = north) → PNG via ImageIO. Pure
    /// CoreGraphics so it runs off the main actor.
    static func pngData(rgba: [UInt8], width: Int, height: Int) -> Data? {
        guard width > 0, height > 0, rgba.count >= width * height * 4 else { return nil }
        let data = Data(rgba)
        guard
            let provider = CGDataProvider(data: data as CFData),
            let cgImage = CGImage(
                width: width,
                height: height,
                bitsPerComponent: 8,
                bitsPerPixel: 32,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
                provider: provider,
                decode: nil,
                shouldInterpolate: false,
                intent: .defaultIntent
            )
        else { return nil }

        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            out, UTType.png.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, cgImage, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return out as Data
    }
}
