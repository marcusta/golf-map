import XCTest
@testable import GolfMap

final class TileEnumeratorTests: XCTestCase {
    // MARK: - Hand-computed exact expectations

    func testSinglePointResolvesToKnownTile() {
        // lon -74, lat 40 at z10 -> tile (301, 387):
        //   x = floor((-74+180)/360 * 1024) = floor(301.51) = 301
        //   y = floor((1 - asinh(tan(40 deg))/pi)/2 * 1024) = floor(387.66) = 387
        let point = TileBounds(west: -74, south: 40, east: -74, north: 40)
        XCTAssertEqual(
            TileEnumerator.tiles(in: point, zoomLevels: 10...10),
            [TileCoordinate(z: 10, x: 301, y: 387)]
        )
    }

    func testSmallBoundsAcrossTwoZooms() {
        // Bounds (-10,-10)..(10,10), straddling the origin.
        // z1: x 0..1, y 0..1 (all four tiles); z2: x 1..2, y 1..2.
        let bounds = TileBounds(west: -10, south: -10, east: 10, north: 10)
        let expected = [
            TileCoordinate(z: 1, x: 0, y: 0), TileCoordinate(z: 1, x: 1, y: 0),
            TileCoordinate(z: 1, x: 0, y: 1), TileCoordinate(z: 1, x: 1, y: 1),
            TileCoordinate(z: 2, x: 1, y: 1), TileCoordinate(z: 2, x: 2, y: 1),
            TileCoordinate(z: 2, x: 1, y: 2), TileCoordinate(z: 2, x: 2, y: 2),
        ]
        XCTAssertEqual(TileEnumerator.tiles(in: bounds, zoomLevels: 1...2), expected)
        XCTAssertEqual(TileEnumerator.tileCount(in: bounds, zoomLevels: 1...2), 8)
    }

    func testWorldBoundsAreClampedToValidTileRange() {
        let world = TileBounds(west: -180, south: -89.9, east: 180, north: 89.9)
        let tiles = TileEnumerator.tiles(in: world, zoomLevels: 1...1)
        // lon +180 maps to raw x = 2, clamped to 1.
        XCTAssertEqual(Set(tiles), Set([
            TileCoordinate(z: 1, x: 0, y: 0), TileCoordinate(z: 1, x: 1, y: 0),
            TileCoordinate(z: 1, x: 0, y: 1), TileCoordinate(z: 1, x: 1, y: 1),
        ]))
    }

    func testCountMatchesEnumeration() {
        let bounds = TileBounds(west: 15.6954, south: 58.3431, east: 15.7489, north: 58.3712)
        for zooms in [12...14, 14...17] {
            XCTAssertEqual(
                TileEnumerator.tileCount(in: bounds, zoomLevels: zooms),
                TileEnumerator.tiles(in: bounds, zoomLevels: zooms).count
            )
        }
    }

    // MARK: - Landeryd sanity

    func testLanderydBundleTileCounts() {
        let bounds = TileBounds(west: 15.6954, south: 58.3431, east: 15.7489, north: 58.3712)
        let ortho = TileEnumerator.tileCount(in: bounds, zoomLevels: 14...20)
        let terrain = TileEnumerator.tileCount(in: bounds, zoomLevels: 12...17)
        let total = ortho + terrain

        // Cross-checked against an independent Python implementation:
        // ortho z14-20 = 32,772 (z20 alone: 24,492); terrain z12-17 = 566.
        XCTAssertEqual(ortho, 32772)
        XCTAssertEqual(terrain, 566)
        XCTAssertEqual(total, 33338)

        print("Landeryd bundle tiles: ortho=\(ortho) terrain=\(terrain) total=\(total)")
    }
}
