import XCTest
@testable import GolfMap

final class TileURLBuilderTests: XCTestCase {
    private let builder = TileURLBuilder(baseURL: URL(string: "http://localhost:3000")!)

    func testOrthoTileURL() {
        let url = builder.url(courseId: "COURSE", layer: .ortho, z: 17, x: 71260, y: 39231)
        XCTAssertEqual(url.absoluteString, "http://localhost:3000/tiles/COURSE/ortho/17/71260/39231.jpg")
    }

    func testTerrainTileURL() {
        let url = builder.url(courseId: "COURSE", layer: .terrain, z: 14, x: 8907, y: 4903)
        XCTAssertEqual(url.absoluteString, "http://localhost:3000/tiles/COURSE/terrain/14/8907/4903.png")
    }

    func testVersionCacheBuster() {
        let url = builder.url(courseId: "COURSE", layer: .ortho, z: 16, x: 1, y: 2, version: "20260704T082859Z")
        XCTAssertEqual(url.absoluteString, "http://localhost:3000/tiles/COURSE/ortho/16/1/2.jpg?v=20260704T082859Z")
    }

    func testEmptyVersionOmitsQuery() {
        let url = builder.url(courseId: "COURSE", layer: .ortho, z: 16, x: 1, y: 2, version: "")
        XCTAssertEqual(url.absoluteString, "http://localhost:3000/tiles/COURSE/ortho/16/1/2.jpg")
    }

    func testLayerExtensions() {
        XCTAssertEqual(TileURLBuilder.Layer.ortho.fileExtension, "jpg")
        XCTAssertEqual(TileURLBuilder.Layer.terrain.fileExtension, "png")
    }
}
