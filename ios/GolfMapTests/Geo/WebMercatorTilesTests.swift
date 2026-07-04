import XCTest
@testable import GolfMap

final class WebMercatorTilesTests: XCTestCase {

    func testTileForKnownLanderydLocation() {
        // Landeryd test course, roughly. At z16 it should land in a sane tile.
        let t = WebMercatorTiles.tile(lon: 15.5658, lat: 58.4015, zoom: 16)
        XCTAssertEqual(t.z, 16)
        // x = ((lon+180)/360)*2^16
        let n = pow(2.0, Double(16))
        let expX = Int(floor((15.5658 + 180) / 360 * n))
        XCTAssertEqual(t.x, expX)
    }

    func testTilePixelDecomposition() {
        let zoom = 16
        let lon = 15.5658
        let lat = 58.4015
        let tp = WebMercatorTiles.tilePixel(lon: lon, lat: lat, zoom: zoom)
        let f = WebMercatorTiles.fractionalTile(lon: lon, lat: lat, zoom: zoom)
        XCTAssertEqual(tp.tileX, Int(floor(f.x)))
        XCTAssertEqual(tp.tileY, Int(floor(f.y)))
        XCTAssertEqual(tp.px, (f.x - floor(f.x)) * 256, accuracy: 1e-9)
        XCTAssertEqual(tp.py, (f.y - floor(f.y)) * 256, accuracy: 1e-9)
        XCTAssertTrue((0..<256).contains(Int(tp.px)))
        XCTAssertTrue((0..<256).contains(Int(tp.py)))
    }

    func testBoundingBoxContainsTileCenter() {
        // A point that lands in a tile must fall inside that tile's bbox.
        let zoom = 14
        let lon = 15.5658
        let lat = 58.4015
        let t = WebMercatorTiles.tile(lon: lon, lat: lat, zoom: zoom)
        let bb = WebMercatorTiles.boundingBox(t)
        XCTAssertLessThanOrEqual(bb.west, lon)
        XCTAssertGreaterThanOrEqual(bb.east, lon)
        XCTAssertLessThanOrEqual(bb.south, lat)
        XCTAssertGreaterThanOrEqual(bb.north, lat)
        XCTAssertLessThan(bb.west, bb.east)
        XCTAssertLessThan(bb.south, bb.north)
    }

    func testBoundingBoxAdjacentTilesTile() {
        // The east edge of tile x equals the west edge of tile x+1 (same for y).
        let a = WebMercatorTiles.boundingBox(z: 14, x: 8907, y: 4903)
        let eastNeighbor = WebMercatorTiles.boundingBox(z: 14, x: 8908, y: 4903)
        let southNeighbor = WebMercatorTiles.boundingBox(z: 14, x: 8907, y: 4904)
        XCTAssertEqual(a.east, eastNeighbor.west, accuracy: 1e-9)
        XCTAssertEqual(a.south, southNeighbor.north, accuracy: 1e-9)
    }

    func testWorldCornerTileZero() {
        // z0 is a single tile covering the whole Web-Mercator world.
        let bb = WebMercatorTiles.boundingBox(z: 0, x: 0, y: 0)
        XCTAssertEqual(bb.west, -180, accuracy: 1e-9)
        XCTAssertEqual(bb.east, 180, accuracy: 1e-9)
        XCTAssertEqual(bb.north, 85.0511, accuracy: 1e-3)
        XCTAssertEqual(bb.south, -85.0511, accuracy: 1e-3)
    }
}
