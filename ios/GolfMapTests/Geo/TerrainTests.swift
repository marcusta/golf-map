import XCTest
@testable import GolfMap

final class TerrainTests: XCTestCase {

    // MARK: Fixture loading (by #filePath-relative path — robust to bundle-resource quirks)

    private struct ExpectedSample: Decodable {
        let x, y, r, g, b: Int
        let elevation: Double
    }
    private struct ExpectedTile: Decodable {
        let size: [Int]
        let samples: [ExpectedSample]
    }

    private static func fixturesDir(file: StaticString = #filePath) -> URL {
        URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures")
    }

    private func loadExpected() throws -> [String: ExpectedTile] {
        let url = Self.fixturesDir().appendingPathComponent("terrain-decode-expected.json")
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode([String: ExpectedTile].self, from: data)
    }

    // MARK: Pure decode

    func testDecodeRGBFormula() {
        // height = -10000 + (R*65536 + G*256 + B) * 0.1
        XCTAssertEqual(Terrain.decodeRGB(r: 1, g: 137, b: 174), 78.2, accuracy: 1e-9)
        XCTAssertEqual(Terrain.decodeRGB(r: 0, g: 0, b: 0), -10000, accuracy: 1e-9)
    }

    // MARK: Decode real fixture tiles and reproduce every ground-truth sample

    func testFixtureTilesReproduceEverySample() throws {
        let expected = try loadExpected()
        XCTAssertFalse(expected.isEmpty, "no expected fixtures loaded")

        for (fileName, exp) in expected {
            let pngURL = Self.fixturesDir().appendingPathComponent(fileName)
            let pngData = try Data(contentsOf: pngURL)
            guard let tile = TerrainTile(pngData: pngData) else {
                XCTFail("failed to decode \(fileName)")
                continue
            }
            XCTAssertEqual(tile.width, exp.size[0], "\(fileName) width")
            XCTAssertEqual(tile.height, exp.size[1], "\(fileName) height")

            for s in exp.samples {
                // Raw pixel RGB must match the ground truth exactly.
                let i = (s.y * tile.width + s.x) * 4
                XCTAssertEqual(Int(tile.data[i]), s.r, "\(fileName) R@\(s.x),\(s.y)")
                XCTAssertEqual(Int(tile.data[i + 1]), s.g, "\(fileName) G@\(s.x),\(s.y)")
                XCTAssertEqual(Int(tile.data[i + 2]), s.b, "\(fileName) B@\(s.x),\(s.y)")

                // Decoded elevation at the exact pixel reproduces ground truth.
                let e = tile.elevation(atPixelX: s.x, pixelY: s.y)
                XCTAssertEqual(e, s.elevation, accuracy: 0.01, "\(fileName) elev@\(s.x),\(s.y)")
            }
        }
    }

    // MARK: Bilinear sampling behavior

    func testBilinearAtPixelCenterEqualsNearest() {
        // A flat synthetic tile: bilinear anywhere equals the constant.
        let r = 1, g = 137, b = 174 // → 78.2 m
        var rgba = [UInt8]()
        for _ in 0..<(4 * 4) { rgba.append(contentsOf: [UInt8(r), UInt8(g), UInt8(b), 255]) }
        let tile = TerrainTile(width: 4, height: 4, rgba: rgba)!
        // pixel center of (2,2) is px=2.5, py=2.5
        XCTAssertEqual(tile.elevation(atPx: 2.5, py: 2.5), 78.2, accuracy: 1e-9)
        // fractional position on a flat tile is still the constant
        XCTAssertEqual(tile.elevation(atPx: 1.3, py: 3.7), 78.2, accuracy: 1e-9)
    }

    func testBilinearInterpolatesBetweenTwoPixels() {
        // 2x1 tile: pixel 0 → elevation 0m, pixel 1 → elevation 10m.
        // decodeRGB: value v gives height -10000 + v*0.1. For 0m: v=100000.
        // For 10m: v=100100. Encode as (r,g,b): v = r*65536 + g*256 + b.
        func rgb(forMeters m: Double) -> (UInt8, UInt8, UInt8) {
            let v = Int(((m + 10000) / 0.1).rounded())
            return (UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF))
        }
        let (r0, g0, b0) = rgb(forMeters: 0)
        let (r1, g1, b1) = rgb(forMeters: 10)
        let rgba: [UInt8] = [r0, g0, b0, 255, r1, g1, b1, 255]
        let tile = TerrainTile(width: 2, height: 1, rgba: rgba)!

        // Sanity: exact pixels.
        XCTAssertEqual(tile.elevation(atPixelX: 0, pixelY: 0), 0, accuracy: 1e-6)
        XCTAssertEqual(tile.elevation(atPixelX: 1, pixelY: 0), 10, accuracy: 1e-6)

        // px=1.0 is exactly between pixel centers 0.5 and 1.5 → midpoint 5m.
        XCTAssertEqual(tile.elevation(atPx: 1.0, py: 0.5), 5, accuracy: 1e-6)
        // px=1.25 → 25% from pixel0-center to pixel1-center → 2.5m.
        XCTAssertEqual(tile.elevation(atPx: 0.75, py: 0.5), 2.5, accuracy: 1e-6)
    }

    func testBilinearNonFinitePixelClampsInsteadOfTrapping() {
        // Regression companion to the tilePixel NaN guard: a direct caller
        // passing a non-finite pixel must clamp to the tile edge (the
        // documented out-of-bounds behavior), not trap in `Int(floor(NaN))`.
        let r = 1, g = 137, b = 174 // → 78.2 m
        var rgba = [UInt8]()
        for _ in 0..<(4 * 4) { rgba.append(contentsOf: [UInt8(r), UInt8(g), UInt8(b), 255]) }
        let tile = TerrainTile(width: 4, height: 4, rgba: rgba)!
        XCTAssertEqual(tile.elevation(atPx: .nan, py: .nan), 78.2, accuracy: 1e-9)
        XCTAssertEqual(tile.elevation(atPx: .infinity, py: -.infinity), 78.2, accuracy: 1e-9)
    }

    // MARK: elevationAt over a provider closure

    func testElevationAtOverProviderMatchesFixture() async throws {
        // Provide the z16 fixture PNG for its own tile address; sampling the
        // NW corner should read a value near the (0,0) ground-truth sample.
        let z = 16, tx = 35630, ty = 19615
        let pngURL = Self.fixturesDir().appendingPathComponent("tile-terrain-16-35630-19615.png")
        let pngData = try Data(contentsOf: pngURL)

        let provider: TerrainTileProvider = { qz, qx, qy in
            (qz == z && qx == tx && qy == ty) ? pngData : nil
        }

        // A lng/lat inside that tile: use the tile's NW-corner bbox nudged in.
        let bb = WebMercatorTiles.boundingBox(z: z, x: tx, y: ty)
        let inside = LatLon(lat: (bb.north + bb.south) / 2, lon: (bb.west + bb.east) / 2)
        let e = await elevationAt(inside, zoom: z, provider: provider)
        XCTAssertNotNil(e)
        // Center pixel (128,128) ground truth is 71.8m; bilinear near center is close.
        XCTAssertEqual(e!, 71.8, accuracy: 2.0)

        // Outside coverage → nil.
        let miss = await elevationAt(LatLon(lat: 0, lon: 0), zoom: z, provider: provider)
        XCTAssertNil(miss)
    }

    func testElevationAtOutOfDomainCoordinateReturnsNil() async {
        // The pure Geo sampler (unlike TerrainElevationService, which
        // pre-filters coordinates) leans on tilePixel's degrade path: an
        // out-of-domain coordinate resolves to an off-pyramid address, the
        // provider misses, and the sample is nil — never a trap.
        let provider: TerrainTileProvider = { _, _, _ in nil }
        let garbage: [LatLon] = [
            LatLon(lat: 553.8846391427445, lon: -600.508342142558),
            LatLon(lat: .nan, lon: 15.7),
            LatLon(lat: 58.4, lon: .infinity),
        ]
        for coord in garbage {
            let sample = await elevationAt(coord, zoom: 16, provider: provider)
            XCTAssertNil(sample, "\(coord) must sample nil, not trap")
        }
    }
}
