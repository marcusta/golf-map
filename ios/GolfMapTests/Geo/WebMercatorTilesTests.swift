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

    func testTilePixelOutOfDomainCoordinatesDegradeInsteadOfTrapping() {
        // Regression (live crash opening Landeryd Masters/Classic): with the
        // GPS origin far off-course, layup landing points interpolated
        // through the SWEREF99TM round-trip came back as garbage like
        // (lat 553.88, lon -600.51). The mercator Y of such a latitude is
        // NaN and `Int(floor(NaN))` trapped in `tilePixel`. Every
        // out-of-domain input must resolve to a harmless address with finite
        // pixel offsets — reaching the assertions at all is the point.
        let cases: [(lon: Double, lat: Double)] = [
            (-600.508342142558, 553.8846391427445), // the live crash landing point
            (15.7, .nan),
            (.nan, 58.4),
            (15.7, .infinity),
            (-.infinity, 58.4),
            (500_110, 6_470_190),                   // SWEREF planar meters as degrees
        ]
        for c in cases {
            let tp = WebMercatorTiles.tilePixel(lon: c.lon, lat: c.lat, zoom: 17)
            _ = WebMercatorTiles.tile(lon: c.lon, lat: c.lat, zoom: 17)
            XCTAssertTrue(tp.px.isFinite, "px must stay finite for \(c)")
            XCTAssertTrue(tp.py.isFinite, "py must stay finite for \(c)")
        }
    }

    func testTilePixelNonFiniteAxisMapsOffPyramid() {
        // A NaN latitude must not alias onto a real tile: the Y axis resolves
        // to -1, an address that exists on no pyramid, so lookups degrade to
        // a missing-tile nil exactly like an off-coverage query.
        let tp = WebMercatorTiles.tilePixel(lon: 15.7, lat: .nan, zoom: 17)
        XCTAssertEqual(tp.tileY, -1)
        XCTAssertEqual(tp.py, 0)
        let t = WebMercatorTiles.tile(lon: .nan, lat: 58.4, zoom: 17)
        XCTAssertEqual(t.x, -1)
    }

    func testTilePixelValidInputUnchangedByGuard() {
        // The degrade path must not disturb in-domain math: same
        // decomposition as the raw fractional-tile floor.
        let f = WebMercatorTiles.fractionalTile(lon: 15.5658, lat: 58.4015, zoom: 17)
        let tp = WebMercatorTiles.tilePixel(lon: 15.5658, lat: 58.4015, zoom: 17)
        XCTAssertEqual(tp.tileX, Int(floor(f.x)))
        XCTAssertEqual(tp.tileY, Int(floor(f.y)))
        XCTAssertEqual(tp.px, (f.x - floor(f.x)) * 256, accuracy: 1e-9)
        XCTAssertEqual(tp.py, (f.y - floor(f.y)) * 256, accuracy: 1e-9)
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
