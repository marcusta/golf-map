import XCTest
@testable import GolfMap

/// The ortho ceiling shared by the archive request and the map style
/// (deploy split §9 — a capped VPS publishes a lower manifest maxzoom).
final class OrthoZoomPolicyTests: XCTestCase {

    func testTakesTheLowerOfDeviceCeilingAndPublishedCap() {
        // Uncapped builder publishes z20 → the device ceiling wins.
        XCTAssertEqual(OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: 20), 19)
        // A capped VPS wins when it is lower.
        XCTAssertEqual(OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: 18), 18)
        XCTAssertEqual(OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: 16), 16)
        // Exactly at the ceiling.
        XCTAssertEqual(OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: 19), 19)
    }

    func testUndeclaredCapFallsBackToTheDeviceCeiling() {
        XCTAssertEqual(OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: nil), 19)
        XCTAssertEqual(OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: 0), 19)
        XCTAssertEqual(OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: -3), 19)
    }

    /// A published manifest missing `maxzoom` must still decode — otherwise the
    /// course reports "no tile manifest" and cannot be downloaded at all. The
    /// missing bound decodes to the 0 sentinel the policy reads as "undeclared".
    func testManifestZoomRangeDecodesLeniently() throws {
        let json = Data("""
        {
          "bounds": {"west": 15.6, "south": 58.3, "east": 15.8, "north": 58.4},
          "layers": {"ortho": {"minzoom": 14}, "terrain": {"minzoom": 12, "maxzoom": 17}},
          "elevation": {"min": 40.0, "max": 90.0},
          "generatedAt": "2026-07-04T08:28:59Z",
          "attribution": "© Lantmäteriet, CC BY 4.0"
        }
        """.utf8)

        let manifest = try JSONDecoder().decode(TileManifest.self, from: json)
        XCTAssertEqual(manifest.layers.ortho.minzoom, 14)
        XCTAssertEqual(manifest.layers.ortho.maxzoom, 0, "missing maxzoom is the undeclared sentinel")
        XCTAssertEqual(manifest.layers.terrain.maxzoom, 17)
        XCTAssertEqual(
            OrthoZoomPolicy.effectiveMaxZoom(publishedMaxZoom: manifest.layers.ortho.maxzoom),
            OrthoZoomPolicy.deviceMaxZoom
        )
    }

    /// `BundleDownloader.orthoBundleMaxZoom` is the published alias other call
    /// sites already use; it must stay the policy's device ceiling.
    func testBundleDownloaderCeilingMatchesThePolicy() {
        XCTAssertEqual(BundleDownloader.orthoBundleMaxZoom, OrthoZoomPolicy.deviceMaxZoom)
    }
}
