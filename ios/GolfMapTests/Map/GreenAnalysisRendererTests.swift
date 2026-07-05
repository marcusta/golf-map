import XCTest
@testable import GolfMap

/// The renderer's pure image helpers (heat RGBA → UIImage, label chips).
/// Layer/source lifecycle against a live style is covered by the on-device
/// live verification (MLNStyle cannot be constructed headlessly).
@MainActor
final class GreenAnalysisRendererTests: XCTestCase {

    func testHeatImagePreservesPixelColorsAndAlpha() throws {
        // 2×1: an opaque-ish red inside pixel and a transparent nodata pixel.
        let rgba: [UInt8] = [
            255, 0, 0, INSIDE_ALPHA,
            0, 0, 0, 0,
        ]
        let image = try XCTUnwrap(GreenAnalysisRenderer.image(fromRGBA: rgba, width: 2, height: 1))
        XCTAssertEqual(image.size.width, 2)
        XCTAssertEqual(image.size.height, 1)

        // Read the pixels back (non-premultiplied source drawn into a
        // premultiplied context — un-premultiply to compare).
        let cgImage = try XCTUnwrap(image.cgImage)
        var pixels = [UInt8](repeating: 0, count: 2 * 4)
        let context = try XCTUnwrap(CGContext(
            data: &pixels,
            width: 2,
            height: 1,
            bitsPerComponent: 8,
            bytesPerRow: 8,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.interpolationQuality = .none
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 2, height: 1))

        XCTAssertEqual(pixels[3], INSIDE_ALPHA) // alpha survives
        // Premultiplied red ≈ 255 × (217/255).
        XCTAssertLessThanOrEqual(abs(Int(pixels[0]) - 217), 2)
        XCTAssertEqual(pixels[7], 0) // nodata pixel fully transparent
    }

    func testHeatImageRejectsShortBuffers() {
        XCTAssertNil(GreenAnalysisRenderer.image(fromRGBA: [1, 2, 3], width: 2, height: 1))
        XCTAssertNil(GreenAnalysisRenderer.image(fromRGBA: [], width: 0, height: 0))
    }

    func testLabelImageRendersNonEmptyChip() {
        let image = GreenAnalysisRenderer.labelImage(text: "3.2")
        XCTAssertGreaterThan(image.size.width, 10)
        XCTAssertGreaterThan(image.size.height, 10)
    }
}
