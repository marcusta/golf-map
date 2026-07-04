import XCTest
@testable import GolfMap

final class TerrainElevationServiceTests: XCTestCase {

    /// Real terrain-RGB fixture from GolfMapTests/Geo/Fixtures (z16 tile over
    /// Landeryd; center pixel ground truth ≈ 71.8 m).
    private static let fixtureZ = 16
    private static let fixtureX = 35630
    private static let fixtureY = 19615

    private static func fixturePNG(file: StaticString = #filePath) throws -> Data {
        let url = URL(fileURLWithPath: "\(file)")
            .deletingLastPathComponent() // Screens/
            .deletingLastPathComponent() // GolfMapTests/
            .appendingPathComponent("Geo/Fixtures/tile-terrain-16-35630-19615.png")
        return try Data(contentsOf: url)
    }

    /// A coordinate at the center of the fixture tile's bbox.
    private static var fixtureCenter: LatLon {
        let bb = WebMercatorTiles.boundingBox(z: fixtureZ, x: fixtureX, y: fixtureY)
        return LatLon(lat: (bb.north + bb.south) / 2, lon: (bb.west + bb.east) / 2)
    }

    /// Counts provider calls across concurrent/async access.
    private actor CallCounter {
        private(set) var count = 0
        private(set) var requested: [WebMercatorTiles.Tile] = []
        func record(_ z: Int, _ x: Int, _ y: Int) {
            count += 1
            requested.append(WebMercatorTiles.Tile(z: z, x: x, y: y))
        }
    }

    // MARK: Bundle-directory tile-path resolution

    func testResolvesTilePathInsideBundleDirectory() async throws {
        // Lay the fixture out exactly as BundlePaths writes a bundle:
        // <dir>/tiles/terrain/{z}/{x}/{y}.png
        let bundleDir = FileManager.default.temporaryDirectory
            .appending(path: "terrain-service-\(UUID().uuidString)", directoryHint: .isDirectory)
        let tileDir = bundleDir
            .appending(path: "tiles/terrain/\(Self.fixtureZ)/\(Self.fixtureX)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: tileDir, withIntermediateDirectories: true)
        try Self.fixturePNG().write(to: tileDir.appending(path: "\(Self.fixtureY).png"))
        defer { try? FileManager.default.removeItem(at: bundleDir) }

        let service = TerrainElevationService(bundleDirectory: bundleDir, zoom: Self.fixtureZ)

        // Same expectation as TerrainTests: center pixel ground truth 71.8 m.
        let elevation = await service.elevation(at: Self.fixtureCenter)
        XCTAssertNotNil(elevation)
        XCTAssertEqual(elevation!, 71.8, accuracy: 2.0)

        // Outside the pyramid → nil.
        let miss = await service.elevation(at: LatLon(lat: 0, lon: 0))
        XCTAssertNil(miss)
    }

    // MARK: LRU behavior

    func testLRUCachesDecodedTilesAndEvictsOldest() async throws {
        let png = try Self.fixturePNG()
        let counter = CallCounter()
        // Serve the fixture PNG for every address; addressing correctness is
        // covered above, here we only watch fetch counts.
        let service = TerrainElevationService(zoom: Self.fixtureZ, capacity: 2) { z, x, y in
            await counter.record(z, x, y)
            return png
        }

        // Three coords in three adjacent tiles (same y, x, x+1, x+2).
        func center(ofTileX x: Int) -> LatLon {
            let bb = WebMercatorTiles.boundingBox(z: Self.fixtureZ, x: x, y: Self.fixtureY)
            return LatLon(lat: (bb.north + bb.south) / 2, lon: (bb.west + bb.east) / 2)
        }
        let a = center(ofTileX: Self.fixtureX)
        let b = center(ofTileX: Self.fixtureX + 1)
        let c = center(ofTileX: Self.fixtureX + 2)

        _ = await service.elevation(at: a) // fetch A            → 1
        _ = await service.elevation(at: a) // cached             → 1
        var count = await counter.count
        XCTAssertEqual(count, 1, "second query of the same tile must not refetch")

        _ = await service.elevation(at: b) // fetch B            → 2
        _ = await service.elevation(at: a) // cached (A touched) → 2
        count = await counter.count
        XCTAssertEqual(count, 2)

        _ = await service.elevation(at: c) // fetch C, evicts B (LRU) → 3
        _ = await service.elevation(at: a) // still cached            → 3
        count = await counter.count
        XCTAssertEqual(count, 3, "A was most recently used — must survive eviction")

        _ = await service.elevation(at: b) // B was evicted → refetch → 4
        count = await counter.count
        XCTAssertEqual(count, 4)
    }

    func testMissingTilesAreCachedAsMisses() async {
        let counter = CallCounter()
        let service = TerrainElevationService(zoom: Self.fixtureZ, capacity: 2) { z, x, y in
            await counter.record(z, x, y)
            return nil
        }
        let coord = Self.fixtureCenter
        let first = await service.elevation(at: coord)
        let second = await service.elevation(at: coord)
        XCTAssertNil(first)
        XCTAssertNil(second)
        let count = await counter.count
        XCTAssertEqual(count, 1, "known-missing tiles must not be re-read on every GPS fix")
    }

    func testRequestsUseConfiguredZoom() async {
        let counter = CallCounter()
        let service = TerrainElevationService(zoom: 17, capacity: 2) { z, x, y in
            await counter.record(z, x, y)
            return nil
        }
        _ = await service.elevation(at: Self.fixtureCenter)
        let requested = await counter.requested
        XCTAssertEqual(requested.count, 1)
        XCTAssertEqual(requested[0].z, 17)
        let expected = WebMercatorTiles.tile(
            lon: Self.fixtureCenter.lon, lat: Self.fixtureCenter.lat, zoom: 17
        )
        XCTAssertEqual(requested[0], expected)
    }
}
