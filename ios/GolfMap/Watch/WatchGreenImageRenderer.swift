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

    /// Output pixel size — 0.25 m/px keeps the polygon edge crisp at watch zoom.
    static let resolutionM = 0.25
    /// Small margin so the polygon edge never clips the outermost band.
    static let bufferM = 2.0

    static func render(
        rings: [[Sweref99TM.Point]],
        sampler: GridElevationSampler
    ) async -> WatchGreenImage? {
        // Sample at the SAME resolution as the phone/web Green view (0.5 m).
        // The Gaussian blur radius is in cells, so sampling finer both halves
        // the smoothing window and doubles the derivative's sensitivity to the
        // terrain-RGB 0.1 m quantization — rendered at 0.25 m that comes out
        // as rainbow contour-ring noise instead of gradients.
        guard let grid = await GreenSampleGridBuilder.build(
            rings: rings,
            bufferM: bufferM,
            resolutionM: AnalysisGridMath.defaultResolutionM,
            sampler: sampler
        ) else { return nil }
        let slope = computeSlopeGrid(grid)

        // Output raster: same extent, finer pixels. Each pixel bilinearly
        // interpolates the slope field (sampleSlopeAt — the phone gets the
        // equivalent smoothing for free from the GPU's texture filtering),
        // so ramp colors grade smoothly instead of banding per sample cell.
        guard let bbox = AnalysisGridMath.ringsBbox(rings) else { return nil }
        let outSpec = AnalysisGridSpec(
            originE: bbox.minX - bufferM,
            originN: bbox.maxY + bufferM,
            resolution: resolutionM,
            width: max(1, Int(ceil((bbox.maxX - bbox.minX + 2 * bufferM) / resolutionM))),
            height: max(1, Int(ceil((bbox.maxY - bbox.minY + 2 * bufferM) / resolutionM)))
        )
        let insideMask = AnalysisGridMath.buildInsideMask(spec: outSpec, rings: rings)

        // Inside the green: opaque slope-ramp color; outside: transparent —
        // the watch draws its own boundary from the synced polygon.
        var rgba = [UInt8](repeating: 0, count: outSpec.width * outSpec.height * 4)
        var hasContent = false
        for row in 0..<outSpec.height {
            let n = outSpec.originN - (Double(row) + 0.5) * outSpec.resolution
            for col in 0..<outSpec.width {
                let i = row * outSpec.width + col
                guard insideMask[i] else { continue }
                let e = outSpec.originE + (Double(col) + 0.5) * outSpec.resolution
                guard let probe = sampleSlopeAt(grid, slope: slope, e: e, n: n)
                else { continue }
                let rgb = slopeColor(probe.slopePct)
                let o = i * 4
                rgba[o] = UInt8(min(max(rgb.r, 0), 255))
                rgba[o + 1] = UInt8(min(max(rgb.g, 0), 255))
                rgba[o + 2] = UInt8(min(max(rgb.b, 0), 255))
                rgba[o + 3] = 255
                hasContent = true
            }
        }
        guard hasContent else { return nil }
        guard let png = pngData(rgba: rgba, width: outSpec.width, height: outSpec.height)
        else { return nil }

        // Fall-line arrows: the phone's own sampler, kept to anchors inside
        // the green (the image is clipped to the polygon). Sent as vectors —
        // the watch draws them crisp at canvas scale.
        let outer = rings.first ?? []
        let arrows = sampleFallLines(grid, slope: slope)
            .filter { AnalysisGridMath.pointInRing(x: $0.e, y: $0.n, ring: outer) }
            .map { WatchFallArrow(e: $0.e, n: $0.n, dirE: $0.dirE, dirN: $0.dirN, slopePct: $0.slopePct) }

        return WatchGreenImage(
            png: png,
            originE: outSpec.originE,
            originN: outSpec.originN,
            metersPerPixel: outSpec.resolution,
            widthPx: outSpec.width,
            heightPx: outSpec.height,
            arrows: arrows,
            arrowLengthM: AnalysisOverlayGeometry.arrowLengthM(grid.spec)
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
