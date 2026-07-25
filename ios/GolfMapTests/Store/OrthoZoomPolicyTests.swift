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

    // MARK: - Containing the leniency

    /// Leniency covers ABSENT/NULL only — a present but non-numeric bound is
    /// still a broken manifest and must fail loudly rather than become z0.
    func testAPresentButNonNumericBoundStillFailsTheDecode() {
        let json = Data("""
        {
          "bounds": {"west": 15.6, "south": 58.3, "east": 15.8, "north": 58.4},
          "layers": {"ortho": {"minzoom": 14, "maxzoom": "twenty"}, "terrain": {"minzoom": 12, "maxzoom": 17}},
          "elevation": {"min": 40.0, "max": 90.0},
          "generatedAt": "2026-07-04T08:28:59Z",
          "attribution": "© Lantmäteriet, CC BY 4.0"
        }
        """.utf8)
        XCTAssertThrowsError(try JSONDecoder().decode(TileManifest.self, from: json))
    }

    /// Only the ortho MAXzoom has a policy fallback; every other bound feeds a
    /// consumer raw (terrain sampler query zoom, style minzoom), so an
    /// undeclared one must resolve to the historical default, never to z0.
    func testUndeclaredBoundsResolveToTheHistoricalDefaults() throws {
        let json = Data("""
        {
          "bounds": {"west": 15.6, "south": 58.3, "east": 15.8, "north": 58.4},
          "layers": {"ortho": {"maxzoom": 18}, "terrain": {"minzoom": 12, "maxzoom": null}},
          "elevation": {"min": 40.0, "max": 90.0},
          "generatedAt": "2026-07-04T08:28:59Z",
          "attribution": "© Lantmäteriet, CC BY 4.0"
        }
        """.utf8)
        let manifest = try JSONDecoder().decode(TileManifest.self, from: json)

        XCTAssertEqual(manifest.layers.ortho.minzoom, TileManifest.ZoomRange.undeclared)
        XCTAssertEqual(
            manifest.layers.ortho.minzoom(or: TileManifest.ZoomDefaults.orthoMinZoom), 14
        )
        XCTAssertEqual(
            manifest.layers.terrain.maxzoom(or: TileManifest.ZoomDefaults.terrainMaxZoom), 17
        )
        // A declared bound is never overridden.
        XCTAssertEqual(manifest.layers.ortho.maxzoom(or: 20), 18)
    }

    /// The same guards on the stored record, for rows written before/around a
    /// manifest that never declared the bounds.
    func testStoredRecordGuardsUndeclaredBounds() {
        let record = TileManifestRecord(
            courseId: "c1", west: 15.6, south: 58.3, east: 15.8, north: 58.4,
            orthoMinZoom: TileManifest.ZoomRange.undeclared, orthoMaxZoom: 18,
            terrainMinZoom: 12, terrainMaxZoom: TileManifest.ZoomRange.undeclared,
            elevMin: 40, elevMax: 90,
            generatedAt: "2026-07-04T08:28:59Z", versionParam: "20260704T082859Z"
        )
        XCTAssertEqual(record.orthoStyleMinZoom, 14)
        XCTAssertEqual(record.terrainQueryZoom, 17)

        let configuration = CourseMapConfiguration(
            bundleDirectory: URL(fileURLWithPath: "/tmp/bundle"), manifest: record
        )
        XCTAssertEqual(configuration.orthoMinZoom, 14, "the style never declares z0")
        XCTAssertEqual(configuration.orthoMaxZoom, 18, "the published cap reaches the policy raw")
    }
}
